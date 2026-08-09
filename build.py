#!/usr/bin/env python3
"""Stitch a cozy journey video from a JSON script of maps, images and songs.

Each scene plays its songs back to back. While the music runs, the video shows
the scene's map for a while (so the viewer knows where we are) and then the
scene artwork for the rest of the music. Everything cross-fades.

    ./build.py journey.json --check      validate assets, print the timeline
    ./build.py journey.json              render out/<name>.mp4
    ./build.py journey.json --preview    fast, small, watchable draft
    ./build.py journey.json --scene 2    render one scene only
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

ANIM_LOOP_FADE = 3.0
ANIM_LOOP_CACHE = Path(__file__).resolve().parent / ".cache" / "anim-loops"
OVERLAY_CACHE = Path(__file__).resolve().parent / ".cache" / "overlays"
FUSED_MAP_CACHE = Path(__file__).resolve().parent / ".cache" / "fused-maps"
OVERLAY_FADE = 0.6

EASE = "({p})*({p})*(3-2*({p}))"  # smoothstep, so pans start and end gently

PAN_DIRECTIONS = {
    "none": None,
    "right": ("0", "1", "0.5", "0.5"),
    "left": ("1", "0", "0.5", "0.5"),
    "down": ("0.5", "0.5", "0", "1"),
    "up": ("0.5", "0.5", "1", "0"),
    "in": None,  # handled by zoom alone
}


class BuildError(Exception):
    pass


XFADE_STYLES = {"fade"}  # ffmpeg xfade names between stills
TRANSITION_STYLES = {"fade", "fade_zoom"}  # bridge overlay enter/exit styles


@dataclass
class Segment:
    """One still image occupying a stretch of the timeline."""

    image: Path
    hold: float
    label: str
    pan: str = "none"
    zoom: float = 1.0
    start: float = 0.0
    fade_in: float | None = None  # overrides the default cross-fade entering this still
    enter_style: str = "fade"  # ffmpeg xfade name when transitioning into this still
    effects: list[dict] = field(default_factory=list)
    animations: list[dict] = field(default_factory=list)
    edits: list[dict] = field(default_factory=list)


@dataclass
class Track:
    """One song (or borrowed slice) in a scene mix."""

    path: Path
    duration: float  # how long it plays in the mix
    name: str
    offset: float = 0.0  # start time inside the source file


@dataclass
class Scene:
    index: int
    title: str
    location: str
    segments: list[Segment] = field(default_factory=list)
    tracks: list[Track] = field(default_factory=list)
    sounds: list[tuple[Path, float]] = field(default_factory=list)  # (path, volume 0–1)
    effects: list[dict] = field(default_factory=list)
    animations: list[dict] = field(default_factory=list)
    edits: list[dict] = field(default_factory=list)
    audio_duration: float = 0.0
    start: float = 0.0
    track_crossfade: float = 0.0
    is_transition: bool = False
    transition_in: str = "fade"
    transition_out: str = "fade"
    # Silent map overlays on top of this scene's picture (times relative to scene start).
    # {image: Path, start: float, duration: float, fade_in: float, fade_out: float}
    bridge_overlays: list[dict] = field(default_factory=list)

    def track_starts(self) -> list[tuple[float, float, str]]:
        cursor = self.start
        marks = []
        for track in self.tracks:
            marks.append((cursor, track.duration, track.name))
            cursor += track.duration - self.track_crossfade
        return marks


def run(cmd: list[str]) -> str:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise BuildError(f"{cmd[0]} failed:\n{proc.stderr.strip()}")
    return proc.stdout.strip()


def probe_duration(path: Path) -> float:
    out = run([
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1",
        str(path),
    ])
    try:
        return float(out)
    except ValueError as exc:
        raise BuildError(f"could not read a duration from {path}") from exc


def optional_float(value) -> float | None:
    return None if value is None else float(value)


def resolve(root: Path, value: str, kind: str) -> Path:
    path = (root / value).expanduser()
    if not path.exists():
        raise BuildError(f"missing {kind}: {path}")
    return path


def timecode(seconds: float) -> str:
    total = int(round(seconds))
    return f"{total // 3600:d}:{(total % 3600) // 60:02d}:{total % 60:02d}"


def project_root(manifest_path: Path) -> Path:
    """Asset paths are always relative to the repo root, even for videos/*.json."""
    if manifest_path.parent.name == "videos":
        return manifest_path.parent.parent
    return manifest_path.parent


def _parse_scene_tracks(root: Path, raw: dict) -> list[Track]:
    tracks: list[Track] = []
    for entry in raw.get("tracks", []) or []:
        source = entry["file"] if isinstance(entry, dict) else entry
        path = resolve(root, source, "song")
        name = entry.get("title", path.stem) if isinstance(entry, dict) else path.stem
        tracks.append(Track(path=path, duration=probe_duration(path), name=name, offset=0.0))
    return tracks


@dataclass
class MapBridge:
    """Visual map overlay that straddles two scenes — no owned audio or runtime."""

    map_image: Path
    seconds: float  # total overlay budget
    style_in: str
    style_out: str
    title: str
    # Optional zoom targets: open zooms out from start; close zooms in to end.
    zoom_start: dict | None = None
    zoom_end: dict | None = None
    map_hold: float = 0.0
    zoom_out_span: float = 0.0  # start zoom-out duration
    zoom_in_span: float = 0.0  # end zoom-in duration
    fade_seconds: float = 3.0  # alpha fade in/out at overlay edges
    # mid = between two scenes; open = before first; close = after last
    mode: str = "mid"
    # Map-locked animation patches (composited before Ken Burns zoom).
    animations: list[dict] = field(default_factory=list)

    @property
    def out_hold(self) -> float:
        if self.mode == "open":
            return 0.0
        if self.mode == "close":
            return self.seconds
        return self.map_hold / 2.0 + self.zoom_out_span

    @property
    def in_hold(self) -> float:
        if self.mode == "close":
            return 0.0
        if self.mode == "open":
            return self.seconds
        return self.map_hold / 2.0 + self.zoom_in_span


def _pair_crossfade(left: Track, right: Track, track_crossfade: float) -> float:
    if track_crossfade <= 0:
        return 0.0
    fade = min(track_crossfade, left.duration * 0.45, right.duration * 0.45)
    return max(fade, 0.05)


def _scene_audio_duration(tracks: list[Track], track_crossfade: float) -> float:
    if not tracks:
        return 0.0
    total = sum(track.duration for track in tracks)
    for index in range(1, len(tracks)):
        total -= _pair_crossfade(tracks[index - 1], tracks[index], track_crossfade)
    return max(total, 0.0)


DEFAULT_SILENT_SCENE_SECONDS = 8.0


def _silent_scene_hold(raw: dict, defaults: dict) -> float:
    """Picture length for a normal scene with no songs."""
    for key in ("hold", "seconds", "duration"):
        try:
            value = float(raw.get(key))
        except (TypeError, ValueError):
            continue
        if value > 0:
            return value
    for key in ("scene_seconds", "hold_seconds"):
        try:
            value = float(defaults.get(key))
        except (TypeError, ValueError):
            continue
        if value > 0:
            return value
    return DEFAULT_SILENT_SCENE_SECONDS


def load_script(manifest_path: Path) -> tuple[dict, list[Scene], float]:
    with manifest_path.open() as handle:
        script = json.load(handle)

    root = project_root(manifest_path)
    defaults = script.get("defaults", {})
    map_seconds = float(defaults.get("map_seconds", 30))
    track_crossfade = float(defaults.get("track_crossfade", 2))
    default_zoom = float(defaults.get("zoom", 1.12))
    fade_seconds = float(defaults.get("fade_seconds", 3))
    shared_map = script.get("map")
    raw_scenes = script.get("scenes", []) or []

    def xfade_style(value: str | None) -> str:
        name = (value or "fade").strip().lower()
        return name if name in XFADE_STYLES else "fade"

    def bridge_style(value: str | None) -> str:
        name = (value or "fade_zoom").strip().lower().replace("-", "_").replace(" ", "_")
        if name in ("fadezoom", "zoom_fade"):
            name = "fade_zoom"
        return name if name in TRANSITION_STYLES else "fade_zoom"

    def clamp_zoom_rect(block: dict | None, fallback: dict) -> dict:
        """Zoom targets: fixed 1/4 picture width, 16:9 in the 3:2 frame."""
        want = (16 / 9) * (2 / 3)
        w = 0.25
        h = w / want
        src = block if isinstance(block, dict) else {}
        try:
            x = min(1.0 - w, max(0.0, float(src.get("x", fallback["x"]))))
            y = min(1.0 - h, max(0.0, float(src.get("y", fallback["y"]))))
        except (TypeError, ValueError):
            return {"x": fallback.get("x", 0.15), "y": fallback.get("y", 0.2), "w": w, "h": h}
        return {"x": x, "y": y, "w": w, "h": h}

    def parse_fade_zoom(
        raw: dict,
    ) -> tuple[dict | None, dict | None, float, float]:
        """Return (start_rect|None, end_rect|None, zoom_out_span, zoom_in_span)."""
        block = raw.get("fade_zoom")
        if not isinstance(block, dict):
            return None, None, 0.0, 0.0
        # Fixed ¼-wide 16:9 in a 3:2 frame → h = 0.25 * 27/32
        _zw, _zh = 0.25, 0.25 * 27 / 32
        default_start = {"x": 0.15, "y": 0.2, "w": _zw, "h": _zh}
        default_end = {"x": 0.5, "y": 0.25, "w": _zw, "h": _zh}
        try:
            zoom_hold = max(0.0, float(block.get("seconds", 3)))
        except (TypeError, ValueError):
            zoom_hold = 3.0

        include_start = block.get("include_start")
        include_end = block.get("include_end")
        if include_start is None:
            include_start = True
        if include_end is None:
            # Legacy no-reverse-exit meant no end zoom.
            include_end = raw.get("fade_zoom_reverse_out") is not False
        include_start = bool(include_start)
        include_end = bool(include_end)

        start_src = block.get("start")
        end_src = block.get("end")
        if not isinstance(start_src, dict) and ("x" in block or "w" in block):
            start_src = block
        start = clamp_zoom_rect(start_src, default_start)
        if not isinstance(end_src, dict):
            end = dict(start)
            if abs(end["x"] - start["x"]) < 0.02 and abs(end["y"] - start["y"]) < 0.02:
                end = clamp_zoom_rect(
                    {
                        "x": min(0.55, start["x"] + 0.3),
                        "y": start["y"],
                        "w": start["w"],
                        "h": start["h"],
                    },
                    default_end,
                )
        else:
            end = clamp_zoom_rect(end_src, default_end)

        if include_start and include_end:
            out_span = zoom_hold / 2.0
            in_span = zoom_hold / 2.0
        elif include_start:
            out_span, in_span = zoom_hold, 0.0
        elif include_end:
            out_span, in_span = 0.0, zoom_hold
        else:
            out_span, in_span = 0.0, 0.0

        return (
            start if include_start else None,
            end if include_end else None,
            out_span,
            in_span,
        )

    def resolve_transition(raw: dict) -> dict:
        """Follow transition_of to the shared template config."""
        ref = raw.get("transition_of")
        if not ref:
            return raw
        for scene in raw_scenes:
            if (
                isinstance(scene, dict)
                and scene.get("is_transition")
                and not scene.get("transition_of")
                and scene.get("id") == ref
            ):
                return scene
        return raw

    def transition_zoom_source(raw: dict, cfg: dict) -> dict:
        """Shared map/timing from template; per-variant zoom rects/includes."""
        template_fz = cfg.get("fade_zoom") if isinstance(cfg.get("fade_zoom"), dict) else {}
        variant_fz = raw.get("fade_zoom") if isinstance(raw.get("fade_zoom"), dict) else {}
        if not raw.get("transition_of"):
            return cfg
        merged_fz = {
            # Duration stays on the shared template.
            "seconds": template_fz.get("seconds", variant_fz.get("seconds", 3)),
            "include_start": variant_fz.get(
                "include_start", template_fz.get("include_start", True)
            ),
            "include_end": variant_fz.get(
                "include_end", template_fz.get("include_end", True)
            ),
            "start": variant_fz.get("start", template_fz.get("start")),
            "end": variant_fz.get("end", template_fz.get("end")),
        }
        return {**cfg, "fade_zoom": merged_fz}

    # Pass 1: tracks for normal scenes; map bridges for transitions (no owned runtime).
    flags = [bool(raw.get("is_transition")) for raw in raw_scenes]
    owned_tracks: list[list[Track] | None] = []
    bridges_after: dict[int, MapBridge] = {}  # keyed by previous scene 0-based index
    bridges_before: dict[int, MapBridge] = {}  # keyed by next scene 0-based (opening)

    for index, raw in enumerate(raw_scenes, start=1):
        is_transition = flags[index - 1]
        if not is_transition:
            owned_tracks.append(_parse_scene_tracks(root, raw))
            continue

        owned_tracks.append(None)
        cfg = resolve_transition(raw)
        zoom_cfg = transition_zoom_source(raw, cfg)
        title = cfg.get("title", f"Scene {index}")
        pos = index - 1  # 0-based

        prev_i = next(
            (j for j in range(pos - 1, -1, -1) if not flags[j]),
            None,
        )
        next_i = next(
            (j for j in range(pos + 1, len(flags)) if not flags[j]),
            None,
        )

        if prev_i is not None and next_i is not None:
            mode = "mid"
        elif prev_i is None and next_i is not None:
            mode = "open"
        elif prev_i is not None and next_i is None:
            # Template parked after the last scene is config-only — not a close.
            if not raw.get("transition_of"):
                continue
            mode = "close"
        else:
            continue

        map_config = cfg.get("map", {})
        if isinstance(map_config, str):
            map_config = {"image": map_config}
        if map_config is None:
            map_config = {"seconds": 0}
        map_hold = float(map_config.get("seconds", map_seconds))
        map_source = map_config.get("image") or shared_map or cfg.get("image")
        style_in = bridge_style(cfg.get("transition_in"))
        style_out = bridge_style(cfg.get("transition_out") or cfg.get("transition_in"))
        zoom_start, zoom_end, zoom_out_span, zoom_in_span = None, None, 0.0, 0.0
        if style_in == "fade_zoom" or style_out == "fade_zoom":
            zoom_start, zoom_end, zoom_out_span, zoom_in_span = parse_fade_zoom(zoom_cfg)
            if not isinstance(zoom_cfg.get("fade_zoom"), dict):
                # Style set but no block yet — default both sides.
                _zw, _zh = 0.25, 0.25 * 27 / 32
                zoom_start = {"x": 0.15, "y": 0.2, "w": _zw, "h": _zh}
                zoom_end = {"x": 0.5, "y": 0.25, "w": _zw, "h": _zh}
                zoom_out_span = 1.5
                zoom_in_span = 1.5
        total_hold = map_hold + zoom_out_span + zoom_in_span
        try:
            edge_fade = float(cfg.get("fade_seconds", fade_seconds))
        except (TypeError, ValueError):
            edge_fade = fade_seconds
        edge_fade = max(0.0, edge_fade)
        if total_hold > 0 and not map_source:
            raise BuildError(
                f"scene {index} ({title}) is a transition and needs a map image"
            )
        if total_hold <= 0:
            continue

        map_image = resolve(root, map_source, "map image")
        map_edits = parse_still_edits(root, cfg.get("edits"))
        if map_edits:
            map_image = fuse_still_edits(map_image, map_edits)
        map_anims = parse_animations(root, cfg.get("animations"))

        bridge = MapBridge(
            map_image=map_image,
            seconds=total_hold,
            style_in=style_in,
            style_out=style_out,
            title=title,
            zoom_start=zoom_start,
            zoom_end=zoom_end,
            map_hold=map_hold,
            zoom_out_span=zoom_out_span,
            zoom_in_span=zoom_in_span,
            fade_seconds=edge_fade,
            mode=mode,
            animations=map_anims,
        )
        if mode == "open" and next_i is not None:
            bridges_before[next_i] = bridge
        elif prev_i is not None:
            bridges_after[prev_i] = bridge

    scenes: list[Scene] = []
    clock = 0.0

    for index, raw in enumerate(raw_scenes, start=1):
        is_transition = flags[index - 1]
        cfg = resolve_transition(raw) if is_transition else raw
        title = cfg.get("title", f"Scene {index}")
        style_in = xfade_style(cfg.get("transition_in"))
        style_out = xfade_style(cfg.get("transition_out"))

        if is_transition:
            # Marker only — runtime lives on the neighboring scenes as a map overlay.
            scenes.append(
                Scene(
                    index=index,
                    title=title,
                    location=cfg.get("location", ""),
                    segments=[],
                    tracks=[],
                    sounds=[],
                    effects=[],
                    animations=[],
                    audio_duration=0.0,
                    start=clock,
                    track_crossfade=track_crossfade,
                    is_transition=True,
                    transition_in=style_in,
                    transition_out=style_out,
                )
            )
            continue

        tracks = owned_tracks[index - 1] or []
        audio_duration = _scene_audio_duration(tracks, track_crossfade)
        if audio_duration <= 0:
            # No songs — still render the picture for a quiet hold (silence under it).
            audio_duration = _silent_scene_hold(raw, defaults)

        sounds: list[tuple[Path, float]] = []
        for entry in raw.get("sounds", []) or []:
            source = entry["file"] if isinstance(entry, dict) else entry
            path = resolve(root, source, "sound")
            raw_volume = 55 if not isinstance(entry, dict) else entry.get("volume", 55)
            try:
                volume = max(0.0, min(float(raw_volume) / 100.0 * 2.2, 2.5))
            except (TypeError, ValueError):
                volume = 1.2
            sounds.append((path, volume))

        map_config = raw.get("map", {})
        if isinstance(map_config, str):
            map_config = {"image": map_config}
        if map_config is None:
            map_config = {"seconds": 0}
        own_map_hold = float(map_config.get("seconds", map_seconds))

        images = raw.get("images") or ([raw["image"]] if raw.get("image") else [])
        if not images:
            raise BuildError(f"scene {index} ({title}) has no image")

        effects: list[dict] = []
        for entry in raw.get("effects") or []:
            if isinstance(entry, str):
                entry = {"file": entry}
            source = entry.get("file")
            if not source:
                continue
            speed = float(entry.get("speed", 100))
            speed = max(10.0, min(speed, 400.0))
            effects.append({"path": resolve(root, source, "effect"), "speed": speed})

        animations: list[dict] = []
        for entry in raw.get("animations") or []:
            if isinstance(entry, str):
                entry = {"file": entry}
            source = entry.get("file")
            if not source:
                continue
            brightness = float(entry.get("brightness", 100))
            brightness = max(20.0, min(brightness, 200.0))
            saturation = float(entry.get("saturation", 100))
            saturation = max(0.0, min(saturation, 200.0))
            speed = float(entry.get("speed", 100))
            speed = max(25.0, min(speed, 200.0))
            aspect = entry.get("aspect", "native")
            if aspect not in ("native", "landscape", "portrait"):
                aspect = "native"
            loop_in = entry.get("loop_in")
            loop_out = entry.get("loop_out")
            in_at = None if loop_in is None else float(loop_in)
            out_at = None if loop_out is None else float(loop_out)
            if in_at is not None and in_at <= 0:
                in_at = None
            if out_at is not None and out_at <= 0:
                out_at = None
            animations.append(
                {
                    "path": resolve(root, source, "animation"),
                    "x": float(entry.get("x", 0.36)),
                    "y": float(entry.get("y", 0.28)),
                    "w": float(entry.get("w", 0.28)),
                    "brightness": brightness,
                    "saturation": saturation,
                    "speed": speed,
                    "aspect": aspect,
                    "soft_edges": bool(entry.get("soft_edges", False)),
                    "loop_in": in_at,
                    "loop_out": out_at,
                }
            )

        edits: list[dict] = []
        for entry in raw.get("edits") or []:
            if isinstance(entry, str):
                entry = {"file": entry}
            source = entry.get("file")
            if not source:
                continue
            aspect = entry.get("aspect", "landscape")
            if aspect not in ("landscape", "portrait", "native"):
                aspect = "landscape"
            height = entry.get("h")
            h_val = None if height is None else float(height)
            if h_val is not None and h_val <= 0:
                h_val = None
            edits.append(
                {
                    "path": resolve(root, source, "edit still"),
                    "x": float(entry.get("x", 0.36)),
                    "y": float(entry.get("y", 0.28)),
                    "w": float(entry.get("w", 0.28)),
                    "h": h_val,
                    "aspect": aspect,
                    "soft_edges": bool(entry.get("soft_edges", False)),
                }
            )

        # bridges_after: transition after this scene. bridges_before: opening into this scene.
        outgoing = bridges_after.get(index - 1)
        incoming = bridges_before.get(index - 1)
        if incoming is None and index >= 2 and flags[index - 2]:
            # Mid-gap transition immediately before this scene.
            incoming = bridges_after.get(index - 3) if index >= 3 else None
        own_map_hold = min(max(0.0, own_map_hold), audio_duration * 0.5)

        in_hold = (
            min(max(0.0, incoming.in_hold), audio_duration * 0.45) if incoming else 0.0
        )
        out_hold = (
            min(max(0.0, outgoing.out_hold), audio_duration * 0.45) if outgoing else 0.0
        )
        # Map overlays sit on top — they do not steal picture time or audio.
        if in_hold + out_hold > audio_duration and (in_hold + out_hold) > 0:
            scale = audio_duration / (in_hold + out_hold)
            in_hold *= scale
            out_hold *= scale

        remaining = max(audio_duration - own_map_hold, 0.0)
        picture_hold = (remaining / len(images)) if images and remaining > 0.001 else 0.0

        segments: list[Segment] = []
        if own_map_hold > 0.001:
            map_source = map_config.get("image", shared_map)
            if not map_source and images:
                first = images[0]
                map_source = first["file"] if isinstance(first, dict) else first
            if not map_source:
                raise BuildError(
                    f"scene {index} ({title}) has no map image and no top-level \"map\" is set"
                )
            segments.append(
                Segment(
                    image=resolve(root, map_source, "map image"),
                    hold=own_map_hold,
                    label=f"{title} (map)",
                    pan=map_config.get("pan", "none"),
                    zoom=float(map_config.get("zoom", 1.0)),
                    fade_in=optional_float(map_config.get("fade_in")),
                    enter_style="fade",
                    effects=effects,
                    animations=animations,
                    edits=[],
                )
            )

        if picture_hold > 0.001:
            for position, entry in enumerate(images):
                source = entry["file"] if isinstance(entry, dict) else entry
                options = entry if isinstance(entry, dict) else {}
                segments.append(
                    Segment(
                        image=resolve(root, source, "scene image"),
                        hold=picture_hold,
                        label=title if len(images) == 1 else f"{title} ({position + 1})",
                        pan=options.get("pan", raw.get("pan", "right" if index % 2 else "left")),
                        zoom=float(options.get("zoom", raw.get("zoom", default_zoom))),
                        fade_in=optional_float(options.get("fade_in")),
                        enter_style="fade",
                        effects=effects,
                        animations=animations,
                        edits=edits,
                    )
                )

        if not segments:
            raise BuildError(f"scene {index} ({title}) has no video segments")

        bridge_overlays: list[dict] = []
        if in_hold > 0.001 and incoming:
            # Start of this scene: map overlay, with zoom depending on mode / includes.
            has_start = bool(incoming.zoom_start) and incoming.zoom_out_span > 0.001
            has_end = bool(incoming.zoom_end) and incoming.zoom_in_span > 0.001
            if incoming.mode == "open" and has_start and has_end:
                zoom_dir = "inout"
                zoom = incoming.zoom_end
                zoom_start = incoming.zoom_start
                style = "fade_zoom"
                zoom_span = incoming.zoom_in_span
                zoom_out_span = incoming.zoom_out_span
            elif incoming.mode == "open" and has_start:
                zoom_dir = "out"
                zoom = incoming.zoom_start
                zoom_start = None
                style = "fade_zoom"
                zoom_span = incoming.zoom_out_span
                zoom_out_span = 0.0
            elif has_end:
                zoom_dir = "in"
                zoom = incoming.zoom_end
                zoom_start = None
                style = "fade_zoom"
                zoom_span = incoming.zoom_in_span
                zoom_out_span = 0.0
            else:
                zoom_dir = "in"
                zoom = None
                zoom_start = None
                style = "fade"
                zoom_span = 0.0
                zoom_out_span = 0.0
            bridge_overlays.append(
                {
                    "image": incoming.map_image,
                    "start": 0.0,
                    "duration": in_hold,
                    "fade_in": 0.0,
                    "fade_out": incoming.fade_seconds,
                    "label": incoming.title,
                    "style": style,
                    "zoom": zoom,
                    "zoom_start": zoom_start,
                    "zoom_dir": zoom_dir,
                    "zoom_span": zoom_span,
                    "zoom_out_span": zoom_out_span,
                    "animations": list(incoming.animations or []),
                }
            )
        if out_hold > 0.001 and outgoing:
            # End of this scene: optionally open on Start and pull out, then hold full map.
            has_start = bool(outgoing.zoom_start) and outgoing.zoom_out_span > 0.001
            has_end = bool(outgoing.zoom_end) and outgoing.zoom_in_span > 0.001
            if outgoing.mode == "close" and has_start and has_end:
                zoom_dir = "inout"
                zoom = outgoing.zoom_end
                zoom_start = outgoing.zoom_start
                style = "fade_zoom"
                zoom_span = outgoing.zoom_in_span
                zoom_out_span = outgoing.zoom_out_span
            elif has_start:
                zoom_dir = "out"
                zoom = outgoing.zoom_start
                zoom_start = None
                style = "fade_zoom"
                zoom_span = outgoing.zoom_out_span
                zoom_out_span = 0.0
            elif outgoing.mode == "close" and has_end:
                zoom_dir = "in"
                zoom = outgoing.zoom_end
                zoom_start = None
                style = "fade_zoom"
                zoom_span = outgoing.zoom_in_span
                zoom_out_span = 0.0
            else:
                zoom_dir = "out"
                zoom = None
                zoom_start = None
                style = "fade"
                zoom_span = 0.0
                zoom_out_span = 0.0
            bridge_overlays.append(
                {
                    "image": outgoing.map_image,
                    "start": max(0.0, audio_duration - out_hold),
                    "duration": out_hold,
                    "fade_in": outgoing.fade_seconds,
                    "fade_out": 0.0,
                    "label": outgoing.title,
                    "style": style,
                    "zoom": zoom,
                    "zoom_start": zoom_start,
                    "zoom_dir": zoom_dir,
                    "zoom_span": zoom_span,
                    "zoom_out_span": zoom_out_span,
                    "animations": list(outgoing.animations or []),
                }
            )

        scene = Scene(
            index=index,
            title=title,
            location=raw.get("location", ""),
            segments=segments,
            tracks=tracks,
            sounds=sounds,
            effects=effects,
            animations=animations,
            edits=edits,
            audio_duration=audio_duration,
            start=clock,
            track_crossfade=track_crossfade,
            is_transition=False,
            transition_in=style_in,
            transition_out=style_out,
            bridge_overlays=bridge_overlays,
        )
        cursor = clock
        for segment in scene.segments:
            segment.start = cursor
            cursor += segment.hold
        scenes.append(scene)
        clock += audio_duration

    if not scenes:
        raise BuildError("the script has no scenes")

    return script, scenes, clock


def pan_filter(segment: Segment, width: int, height: int) -> str:
    """Scale the still to cover the frame, then drift a window across it."""
    zoom = max(1.0, segment.zoom)
    canvas_w = int(round(width * zoom / 2)) * 2
    canvas_h = int(round(height * zoom / 2)) * 2
    chain = [
        f"scale={canvas_w}:{canvas_h}:force_original_aspect_ratio=increase:flags=lanczos"
    ]

    # A still wider or taller than the frame has room to travel even at zoom
    # 1.0, so the pan is driven by the leftover pixels rather than the zoom.
    direction = PAN_DIRECTIONS.get(segment.pan, PAN_DIRECTIONS["none"])
    if direction is None:
        chain.append(f"crop={width}:{height}")
    else:
        x0, x1, y0, y1 = direction
        progress = EASE.format(p=f"min(t/{segment.hold:.3f},1)")
        x_expr = f"(in_w-out_w)*({x0}+({x1}-{x0})*{progress})"
        y_expr = f"(in_h-out_h)*({y0}+({y1}-{y0})*{progress})"
        chain.append(f"crop={width}:{height}:x='{x_expr}':y='{y_expr}'")

    chain += ["setsar=1", "format=yuv420p"]
    return ",".join(chain)


def effect_key_filter(path: Path) -> str:
    """Chroma-key filter for green-screen effect clips."""
    name = path.name.lower()
    if "snow" in name:
        # Snow uses a darker green — leave alone for now.
        return "colorkey=0x109E0E:0.3:0.1"
    # Autumn leaves are near-pure #00FF00 / #00FF01.
    return "chromakey=0x00FF00:0.15:0.1"


def seamless_loop_clip(
    path: Path,
    fps: int,
    fade: float = ANIM_LOOP_FADE,
    start: float | None = None,
    end: float | None = None,
) -> Path:
    """Cache a muted clip whose end cross-fades into its start, safe to stream-loop.

    Optional start/end trim the source before looping. The last `fade` seconds
    dissolve into the first `fade` seconds; the cached file is then
    `clip_len - fade` long so hard cuts disappear when it loops.
    Used for both animations and full-frame effects.
    """
    duration = probe_duration(path)
    t0 = 0.0 if start is None else max(0.0, min(float(start), duration))
    t1 = duration if end is None else max(t0 + 0.25, min(float(end), duration))
    clip_len = t1 - t0
    fade = min(fade, max(0.25, clip_len * 0.45))
    if clip_len <= fade + 0.05:
        if t0 <= 0.001 and t1 >= duration - 0.001:
            return path
        # Too short to crossfade — just emit the trimmed slice.
        stat = path.stat()
        token = hashlib.sha1(
            f"{path}|{stat.st_mtime_ns}|{stat.st_size}|trim|{t0:.3f}|{t1:.3f}|{fps}".encode()
        ).hexdigest()[:16]
        target = ANIM_LOOP_CACHE / f"{token}.mp4"
        if target.exists():
            return target
        ANIM_LOOP_CACHE.mkdir(parents=True, exist_ok=True)
        run(
            [
                "ffmpeg", "-y", "-hide_banner", "-v", "error",
                "-ss", f"{t0:.3f}", "-to", f"{t1:.3f}",
                "-i", str(path),
                "-an",
                "-c:v", "libx264",
                "-preset", "veryfast",
                "-crf", "18",
                "-pix_fmt", "yuv420p",
                "-movflags", "+faststart",
                str(target),
            ]
        )
        return target

    stat = path.stat()
    token = hashlib.sha1(
        f"{path}|{stat.st_mtime_ns}|{stat.st_size}|{fade:.3f}|{fps}|{t0:.3f}|{t1:.3f}".encode()
    ).hexdigest()[:16]
    target = ANIM_LOOP_CACHE / f"{token}.mp4"
    if target.exists():
        return target

    ANIM_LOOP_CACHE.mkdir(parents=True, exist_ok=True)
    # Trim to the loop window, crossfade into itself, then keep the middle
    # slice whose end already matches its start (so stream-looping is seamless).
    offset = max(clip_len - fade, 0.0)
    loop_len = offset
    graph = (
        f"[0:v]trim=start={t0:.3f}:end={t1:.3f},setpts=PTS-STARTPTS,"
        f"fps={fps},format=yuv420p[a];"
        f"[1:v]trim=start={t0:.3f}:end={t1:.3f},setpts=PTS-STARTPTS,"
        f"fps={fps},format=yuv420p[b];"
        f"[a][b]xfade=transition=fade:duration={fade:.3f}:offset={offset:.3f}[xf];"
        f"[xf]trim=start={fade:.3f}:duration={loop_len:.3f},setpts=PTS-STARTPTS[v]"
    )
    run(
        [
            "ffmpeg", "-y", "-hide_banner", "-v", "error",
            "-i", str(path),
            "-i", str(path),
            "-filter_complex", graph,
            "-map", "[v]",
            "-an",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "18",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            str(target),
        ]
    )
    return target


# Back-compat alias
seamless_anim_loop = seamless_loop_clip


def _pil():
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError as exc:
        raise BuildError(
            "Pillow is required for lower-third overlays. "
            "Run: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
        ) from exc
    return Image, ImageDraw, ImageFont


def parse_still_edits(root: Path, raw_edits) -> list[dict]:
    """Normalize filled still-edit slots from a scene / transition template."""
    edits: list[dict] = []
    for entry in raw_edits or []:
        if isinstance(entry, str):
            entry = {"file": entry}
        source = entry.get("file")
        if not source:
            continue
        aspect = entry.get("aspect", "landscape")
        if aspect not in ("landscape", "portrait", "native"):
            aspect = "landscape"
        height = entry.get("h")
        h_val = None if height is None else float(height)
        if h_val is not None and h_val <= 0:
            h_val = None
        edits.append(
            {
                "path": resolve(root, source, "edit still"),
                "x": float(entry.get("x", 0.36)),
                "y": float(entry.get("y", 0.28)),
                "w": float(entry.get("w", 0.28)),
                "h": h_val,
                "aspect": aspect,
                "soft_edges": bool(entry.get("soft_edges", False)),
            }
        )
    return edits


def parse_animations(root: Path, raw_anims) -> list[dict]:
    """Normalize filled animation slots from a scene / transition template."""
    animations: list[dict] = []
    for entry in raw_anims or []:
        if isinstance(entry, str):
            entry = {"file": entry}
        source = entry.get("file")
        if not source:
            continue
        brightness = float(entry.get("brightness", 100))
        brightness = max(20.0, min(brightness, 200.0))
        saturation = float(entry.get("saturation", 100))
        saturation = max(0.0, min(saturation, 200.0))
        speed = float(entry.get("speed", 100))
        speed = max(25.0, min(speed, 200.0))
        aspect = entry.get("aspect", "native")
        if aspect not in ("native", "landscape", "portrait"):
            aspect = "native"
        loop_in = entry.get("loop_in")
        loop_out = entry.get("loop_out")
        in_at = None if loop_in is None else float(loop_in)
        out_at = None if loop_out is None else float(loop_out)
        if in_at is not None and in_at <= 0:
            in_at = None
        if out_at is not None and out_at <= 0:
            out_at = None
        height = entry.get("h")
        h_val = None if height is None else float(height)
        if h_val is not None and h_val <= 0:
            h_val = None
        animations.append(
            {
                "path": resolve(root, source, "animation"),
                "x": float(entry.get("x", 0.36)),
                "y": float(entry.get("y", 0.28)),
                "w": float(entry.get("w", 0.28)),
                "h": h_val,
                "brightness": brightness,
                "saturation": saturation,
                "speed": speed,
                "aspect": aspect,
                "soft_edges": bool(entry.get("soft_edges", False)),
                "loop_in": in_at,
                "loop_out": out_at,
            }
        )
    return animations


def image_size(path: Path) -> tuple[int, int]:
    Image, _, _ = _pil()
    with Image.open(path) as im:
        w, h = im.size
    return max(2, (w // 2) * 2), max(2, (h // 2) * 2)


def _edit_box_norm(edit: dict) -> tuple[float, float, float, float]:
    """Normalized crop box on a 3:2 picture frame (matches ui regionCropNorm)."""
    x = min(1.0, max(0.0, float(edit["x"])))
    y = min(1.0, max(0.0, float(edit["y"])))
    w = min(1.0 - x, max(0.01, float(edit["w"])))
    h = edit.get("h")
    if h is not None and float(h) > 0:
        height = float(h)
    else:
        ratio = 16 / 9 if edit.get("aspect") == "landscape" else 9 / 16
        if edit.get("aspect") == "native":
            ratio = 16 / 9
        height = (w * 1.5) / ratio
    height = min(1.0 - y, max(0.01, height))
    return x, y, w, height


def _cover_crop(im, tw: int, th: int):
    Image, _, _ = _pil()
    sw, sh = im.size
    if sw <= 0 or sh <= 0 or tw <= 0 or th <= 0:
        return im.resize((max(1, tw), max(1, th)), Image.Resampling.LANCZOS)
    scale = max(tw / sw, th / sh)
    nw = max(1, int(round(sw * scale)))
    nh = max(1, int(round(sh * scale)))
    resized = im.resize((nw, nh), Image.Resampling.LANCZOS)
    left = max(0, (nw - tw) // 2)
    top = max(0, (nh - th) // 2)
    return resized.crop((left, top, left + tw, top + th))


def _feather_rgba(im, edge_frac: float = 0.12):
    Image, _, _ = _pil()
    rgba = im.convert("RGBA")
    w, h = rgba.size
    edge = max(2, int(round(min(w, h) * edge_frac)))
    pixels = rgba.load()
    for y in range(h):
        for x in range(w):
            dist = min(x, y, w - 1 - x, h - 1 - y)
            if dist >= edge:
                continue
            r, g, b, a = pixels[x, y]
            pixels[x, y] = (r, g, b, int(round(a * (dist / edge))))
    return rgba


def fuse_still_edits(base: Path, edits: list[dict]) -> Path:
    """Bake still edits onto a base image (cached). Used for transition maps."""
    if not edits:
        return base
    Image, _, _ = _pil()
    parts = [str(base.resolve()), str(base.stat().st_mtime_ns)]
    for edit in edits:
        path: Path = edit["path"]
        parts.append(
            f"{path.resolve()}:{path.stat().st_mtime_ns}:"
            f"{edit['x']}:{edit['y']}:{edit['w']}:{edit.get('h')}:"
            f"{edit.get('aspect')}:{int(bool(edit.get('soft_edges')))}"
        )
    key = hashlib.sha1("|".join(parts).encode()).hexdigest()[:20]
    out = FUSED_MAP_CACHE / f"fuse-{key}.png"
    if out.exists():
        return out

    canvas = Image.open(base).convert("RGBA")
    width, height = canvas.size
    for edit in edits:
        x, y, w, h = _edit_box_norm(edit)
        dx = int(round(x * width))
        dy = int(round(y * height))
        dw = max(1, int(round(w * width)))
        dh = max(1, int(round(h * height)))
        patch = _cover_crop(Image.open(edit["path"]).convert("RGBA"), dw, dh)
        if edit.get("soft_edges"):
            patch = _feather_rgba(patch)
        canvas.alpha_composite(patch, (dx, dy))

    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out, "PNG")
    return out


def pick_font(size: int):
    _, _, ImageFont = _pil()
    candidates = [
        Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
        Path("/System/Library/Fonts/Supplemental/Helvetica.ttc"),
        Path("/Library/Fonts/Arial.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    for path in candidates:
        if path.exists():
            try:
                return ImageFont.truetype(str(path), size=size)
            except OSError:
                continue
    return ImageFont.load_default()


def render_overlay_png(path: Path, lines: list[tuple[str, int, float]], *, height: int) -> Path:
    """Render a transparent PNG lower-third. lines: (text, font_px, opacity)."""
    Image, ImageDraw, _ = _pil()
    scale = max(1.0, height / 1080)
    pad_x = int(round(18 * scale))
    pad_y = int(round(12 * scale))
    gap = int(round(4 * scale))

    fonts = [pick_font(max(12, int(round(size * scale)))) for _, size, _ in lines]
    # Measure
    probe = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
    draw = ImageDraw.Draw(probe)
    widths = []
    heights = []
    for (text, _, _), font in zip(lines, fonts):
        box = draw.textbbox((0, 0), text, font=font)
        widths.append(box[2] - box[0])
        heights.append(box[3] - box[1])
    width = max(widths, default=1) + pad_x * 2
    total_h = pad_y * 2 + sum(heights) + gap * max(0, len(lines) - 1)
    image = Image.new("RGBA", (width, total_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    y = pad_y
    for (text, _, opacity), font, line_h in zip(lines, fonts, heights):
        alpha = max(0, min(255, int(round(255 * opacity))))
        # Soft shadow, then white text — readable on both light and dark dioramas.
        shadow = (0, 0, 0, int(round(alpha * 0.55)))
        fill = (255, 255, 255, alpha)
        x = pad_x
        for dx, dy in ((1, 1), (2, 2), (0, 1)):
            draw.text((x + dx, y + dy), text, font=font, fill=shadow)
        draw.text((x, y), text, font=font, fill=fill)
        y += line_h + gap
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, "PNG")
    return path


def overlay_png_for(event: dict, height: int) -> Path:
    if event["kind"] == "credit":
        key = hashlib.sha1(f"credit|{event['text']}|{height}".encode()).hexdigest()[:16]
        path = OVERLAY_CACHE / f"credit-{key}.png"
        if not path.exists():
            render_overlay_png(
                path,
                [(event["text"], 28, 0.92)],
                height=height,
            )
        return path
    key = hashlib.sha1(
        f"song|{event['title']}|{event['streaming_from']}|{height}".encode()
    ).hexdigest()[:16]
    path = OVERLAY_CACHE / f"song-{key}.png"
    if not path.exists():
        render_overlay_png(
            path,
            [
                (event["title"], 36, 1.0),
                (f"Streaming from {event['streaming_from']}", 22, 0.82),
            ],
            height=height,
        )
    return path


def collect_bridge_overlays(scenes: list[Scene]) -> list[dict]:
    """Fullscreen silent map overlays — times absolute on the video timeline."""
    events = []
    for scene in scenes:
        for overlay in scene.bridge_overlays or []:
            duration = float(overlay.get("duration") or 0)
            if duration <= 0.001:
                continue
            events.append(
                {
                    "image": overlay["image"],
                    "start": scene.start + float(overlay.get("start") or 0),
                    "duration": duration,
                    "fade_in": max(0.0, float(overlay.get("fade_in") or 0)),
                    "fade_out": max(0.0, float(overlay.get("fade_out") or 0)),
                    "label": overlay.get("label") or "map",
                    "style": overlay.get("style") or "fade",
                    "zoom": overlay.get("zoom"),
                    "zoom_start": overlay.get("zoom_start"),
                    "zoom_dir": overlay.get("zoom_dir") or "in",
                    "zoom_span": float(overlay.get("zoom_span") or 0),
                    "zoom_out_span": float(overlay.get("zoom_out_span") or 0),
                    "animations": list(overlay.get("animations") or []),
                }
            )
    return events


def _zoom_rect(zoom: dict | None) -> tuple[float, float, float, float]:
    if not isinstance(zoom, dict):
        return 0.25, 0.25, 0.5, 0.5
    try:
        zx = min(1.0, max(0.0, float(zoom.get("x", 0.25))))
        zy = min(1.0, max(0.0, float(zoom.get("y", 0.25))))
        zw = min(1.0 - zx, max(0.05, float(zoom.get("w", 0.5))))
        zh = min(1.0 - zy, max(0.05, float(zoom.get("h", 0.5))))
        return zx, zy, zw, zh
    except (TypeError, ValueError):
        return 0.25, 0.25, 0.5, 0.5


def bridge_map_filter(
    *,
    width: int,
    height: int,
    fps: int,
    duration: float,
    fade_in: float,
    fade_out: float,
    style: str,
    zoom: dict | None,
    zoom_dir: str,
    zoom_span: float = 0.0,
    zoom_start: dict | None = None,
    zoom_out_span: float = 0.0,
    include_fps: bool = True,
) -> str:
    """Filter chain for a map overlay: optional Ken Burns zoom + alpha fade."""
    frames = max(1, int(round(duration * fps)))
    fade_in = min(max(0.0, fade_in), duration)
    fade_out = min(max(0.0, fade_out), max(0.0, duration - fade_in))

    parts: list[str] = [f"fps={fps}"] if include_fps else []

    if style == "fade_zoom" and (isinstance(zoom, dict) or isinstance(zoom_start, dict)):
        zx, zy, zw, zh = _zoom_rect(zoom if isinstance(zoom, dict) else zoom_start)
        z_end = 1.0 / max(min(zw, zh), 0.05)
        cx = zx + zw / 2.0
        cy = zy + zh / 2.0
        # Use d=1 + `in` (input frame index), never d=N + `on`.
        # zoompan's d=N expands *each* input frame into N outputs, which freezes
        # map animations (and any other pre-composited motion) on the first frame.
        fr = "in"

        if zoom_dir == "inout" and isinstance(zoom_start, dict) and isinstance(zoom, dict):
            # [zoom out from start][hold map][zoom in to end]
            sx, sy, sw, sh = _zoom_rect(zoom_start)
            z_start = 1.0 / max(min(sw, sh), 0.05)
            scx = sx + sw / 2.0
            scy = sy + sh / 2.0
            out_sec = min(max(0.0, float(zoom_out_span or 0)), duration)
            in_sec = min(max(0.0, float(zoom_span or 0)), max(0.0, duration - out_sec))
            n_out = max(1, int(round(out_sec * fps))) if out_sec > 0.01 else 0
            n_in = max(1, int(round(in_sec * fps))) if in_sec > 0.01 else 0
            n_out = min(n_out, frames)
            n_in = min(n_in, max(0, frames - n_out))
            out_span = max(n_out - 1, 1) if n_out else 1
            in_start = max(0, frames - n_in)
            in_span = max(n_in - 1, 1) if n_in else 1
            # z: start→1 over first span, hold 1, then 1→end over last span
            if n_out and n_in:
                z_expr = (
                    f"if(lte({fr},{n_out - 1}),"
                    f"{z_start:.6f}+(1-{z_start:.6f})*{fr}/{out_span},"
                    f"if(lte({fr},{in_start}),1,"
                    f"1+({z_end:.6f}-1)*({fr}-{in_start})/{in_span}))"
                )
            elif n_out:
                z_expr = (
                    f"if(lte({fr},{out_span}),"
                    f"{z_start:.6f}+(1-{z_start:.6f})*{fr}/{out_span},1)"
                )
            else:
                z_expr = (
                    f"if(lte({fr},{in_start}),1,"
                    f"1+({z_end:.6f}-1)*({fr}-{in_start})/{in_span})"
                )
            # Pan center: use start center while zooming out, end center while zooming in.
            x_expr = (
                f"if(lte({fr},{max(n_out - 1, 0)}),"
                f"{scx:.6f}*iw-iw/zoom/2,"
                f"{cx:.6f}*iw-iw/zoom/2)"
            )
            y_expr = (
                f"if(lte({fr},{max(n_out - 1, 0)}),"
                f"{scy:.6f}*ih-ih/zoom/2,"
                f"{cy:.6f}*ih-ih/zoom/2)"
            )
            parts.append(
                f"zoompan=z='{z_expr}':x='{x_expr}':y='{y_expr}':"
                f"d=1:s={width}x{height}:fps={fps}"
            )
            parts.append("setsar=1")
        else:
            span_sec = min(max(0.0, float(zoom_span or 0)), duration)
            if span_sec <= 0.01:
                span_sec = duration
            n_zoom = max(1, int(round(span_sec * fps)))
            n_zoom = min(n_zoom, frames)
            anim_span = max(n_zoom - 1, 1)
            if zoom_dir == "out":
                # Zoom out over the first zoom_span, then hold full map.
                # Prefer zoom_start rect when provided.
                if isinstance(zoom_start, dict):
                    zx, zy, zw, zh = _zoom_rect(zoom_start)
                    z_end = 1.0 / max(min(zw, zh), 0.05)
                    cx = zx + zw / 2.0
                    cy = zy + zh / 2.0
                z_expr = (
                    f"if(lte({fr},{anim_span}),"
                    f"{z_end:.6f}+(1-{z_end:.6f})*{fr}/{anim_span},1)"
                )
            else:
                # Hold full map, then zoom in over the last zoom_span.
                start = max(0, frames - n_zoom)
                z_expr = (
                    f"if(lte({fr},{start}),1,"
                    f"1+({z_end:.6f}-1)*({fr}-{start})/{anim_span})"
                )
            parts.append(
                f"zoompan=z='{z_expr}':"
                f"x='{cx:.6f}*iw-iw/zoom/2':"
                f"y='{cy:.6f}*ih-ih/zoom/2':"
                f"d=1:s={width}x{height}:fps={fps}"
            )
            parts.append("setsar=1")
    else:
        parts.extend(
            [
                f"scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos",
                f"crop={width}:{height}",
                "setsar=1",
            ]
        )

    parts.append("format=rgba")
    if fade_in > 0.01:
        parts.append(f"fade=t=in:st=0:d={fade_in:.3f}:alpha=1")
    if fade_out > 0.01:
        out_at = max(0.0, duration - fade_out)
        parts.append(f"fade=t=out:st={out_at:.3f}:d={fade_out:.3f}:alpha=1")
    return ",".join(parts)


def collect_overlay_events(scenes: list[Scene], overlays: dict | None) -> list[dict]:
    overlays = overlays or {}
    events: list[dict] = []
    credit = overlays.get("credit") or {}
    if credit.get("enabled", True):
        events.append(
            {
                "kind": "credit",
                "text": str(credit.get("text") or "Built with hearthbound.com"),
                "x": float(credit.get("x", 0.035)),
                "y": float(credit.get("y", 0.9)),
                "start": 0.0,
                "duration": float(credit.get("show_seconds", 5)),
            }
        )
    now = overlays.get("now_playing") or {}
    if now.get("enabled", True):
        streaming = str(now.get("streaming_from") or "hearthbound.com")
        show = float(now.get("show_seconds", 5))
        x = float(now.get("x", 0.58))
        y = float(now.get("y", 0.86))
        for scene in scenes:
            for start, _duration, name in scene.track_starts():
                events.append(
                    {
                        "kind": "now_playing",
                        "title": name,
                        "streaming_from": streaming,
                        "x": x,
                        "y": y,
                        "start": start,
                        "duration": show,
                    }
                )
    return events


def build_command(
    scenes: list[Scene],
    total: float,
    output: Path,
    *,
    width: int,
    height: int,
    fps: int,
    fade: float,
    track_crossfade: float,
    open_close_fade: float,
    quality: dict,
    audio_only: bool = False,
    overlays: dict | None = None,
) -> list[str]:
    segments = [segment for scene in scenes for segment in scene.segments]
    graph: list[str] = []
    cmd = ["ffmpeg", "-y", "-hide_banner"]

    if audio_only:
        audio_offset = 0
    else:
        # The transition into a still can be overridden per frame; a still has to
        # outlast its own hold by however long the fade leaving it runs.
        fade_out = [
            fade if position + 1 >= len(segments) else (segments[position + 1].fade_in or fade)
            for position in range(len(segments))
        ]
        for position, segment in enumerate(segments):
            cmd += [
                "-loop", "1",
                "-framerate", str(fps),
                "-t", f"{segment.hold + fade_out[position]:.3f}",
                "-i", str(segment.image),
            ]

        # Still edits (static patches), then green-screen effects, then animations.
        edit_inputs: list[tuple[int, dict, float]] = []
        for position, segment in enumerate(segments):
            duration = segment.hold + fade_out[position]
            for edit in segment.edits:
                edit_inputs.append((position, edit, duration))
                cmd += [
                    "-loop", "1",
                    "-framerate", str(fps),
                    "-t", f"{duration:.3f}",
                    "-i", str(edit["path"]),
                ]

        effect_inputs: list[tuple[int, dict, float]] = []
        for position, segment in enumerate(segments):
            duration = segment.hold + fade_out[position]
            for effect in segment.effects:
                looped = seamless_loop_clip(effect["path"], fps)
                effect_inputs.append((position, {**effect, "looped": looped}, duration))
                # No -t here: setpts+trim below consume however much source the speed needs.
                cmd += [
                    "-stream_loop", "-1",
                    "-i", str(looped),
                ]

        anim_inputs: list[tuple[int, dict, float]] = []
        for position, segment in enumerate(segments):
            duration = segment.hold + fade_out[position]
            for anim in segment.animations:
                looped = seamless_loop_clip(
                    anim["path"],
                    fps,
                    start=anim.get("loop_in"),
                    end=anim.get("loop_out"),
                )
                anim_inputs.append((position, anim, duration))
                # No -t: setpts+trim below consume however much source the speed needs.
                cmd += [
                    "-stream_loop", "-1",
                    "-i", str(looped),
                ]
        audio_offset = len(segments) + len(edit_inputs) + len(effect_inputs) + len(anim_inputs)

    bridge_events: list[dict] = []
    bridge_base = audio_offset
    overlay_inputs: list[tuple[dict, Path]] = []
    overlay_base = audio_offset
    if not audio_only:
        bridge_events = collect_bridge_overlays(scenes)
        for event in bridge_events:
            hold = max(float(event["duration"]), 0.1)
            cmd += [
                "-loop", "1",
                "-framerate", str(fps),
                "-t", f"{hold:.3f}",
                "-i", str(event["image"]),
            ]
        bridge_base = audio_offset
        bridge_anim_base = bridge_base + len(bridge_events)
        bridge_anim_by_event: dict[int, list[tuple[int, dict]]] = {
            i: [] for i in range(len(bridge_events))
        }
        bridge_anim_count = 0
        for event_i, event in enumerate(bridge_events):
            hold = max(float(event["duration"]), 0.1)
            for anim in event.get("animations") or []:
                looped = seamless_loop_clip(
                    anim["path"],
                    fps,
                    start=anim.get("loop_in"),
                    end=anim.get("loop_out"),
                )
            bridge_anim_by_event[event_i].append((bridge_anim_base + bridge_anim_count, anim))
            bridge_anim_count += 1
            cmd += [
                "-stream_loop", "-1",
                "-t", f"{hold:.3f}",
                "-i", str(looped),
            ]
        overlay_base = bridge_anim_base + bridge_anim_count
        for event in collect_overlay_events(scenes, overlays):
            png = overlay_png_for(event, height)
            overlay_inputs.append((event, png))
            hold = max(float(event["duration"]), OVERLAY_FADE * 2 + 0.05)
            cmd += [
                "-loop", "1",
                "-framerate", str(fps),
                "-t", f"{hold:.3f}",
                "-i", str(png),
            ]
        audio_offset = overlay_base + len(overlay_inputs)

    for scene in scenes:
        for track in scene.tracks:
            cmd += ["-i", str(track.path)]
        for path, _volume in scene.sounds:
            # Loop ambient beds to cover the whole scene.
            cmd += [
                "-stream_loop", "-1",
                "-t", f"{max(scene.audio_duration, 0.1):.3f}",
                "-i", str(path),
            ]

    if not audio_only:
        edit_base = len(segments)
        effect_base = edit_base + len(edit_inputs)
        anim_base = effect_base + len(effect_inputs)
        edit_by_segment: dict[int, list[int]] = {i: [] for i in range(len(segments))}
        for edit_index, (segment_index, _, _) in enumerate(edit_inputs):
            edit_by_segment[segment_index].append(edit_base + edit_index)
        effect_by_segment: dict[int, list[int]] = {i: [] for i in range(len(segments))}
        for effect_index, (segment_index, _, _) in enumerate(effect_inputs):
            effect_by_segment[segment_index].append(effect_base + effect_index)
        anim_by_segment: dict[int, list[int]] = {i: [] for i in range(len(segments))}
        for anim_index, (segment_index, _, _) in enumerate(anim_inputs):
            anim_by_segment[segment_index].append(anim_base + anim_index)

        for position, segment in enumerate(segments):
            graph.append(
                f"[{position}:v]{pan_filter(segment, width, height)},fps={fps}[b{position}]"
            )
            current = f"b{position}"
            # Still edits sit under animations; animations sit under full-frame effects.
            for step, input_index in enumerate(edit_by_segment[position]):
                edit = edit_inputs[input_index - edit_base][1]
                hold = segment.hold + fade_out[position]
                ew = max(2, int(round(width * max(0.05, min(edit["w"], 1.0)) / 2) * 2))
                ex = int(round(width * max(0.0, min(edit["x"], 1.0))))
                ey = int(round(height * max(0.0, min(edit["y"], 1.0))))
                eh = edit.get("h")
                if eh is not None and float(eh) > 0:
                    eh = max(2, int(round(height * max(0.05, min(float(eh), 1.0)) / 2) * 2))
                else:
                    aspect = edit.get("aspect", "landscape")
                    if aspect == "portrait":
                        eh = max(2, int(round(ew * 16 / 9 / 2) * 2))
                    else:
                        eh = max(2, int(round(ew * 9 / 16 / 2) * 2))
                en = f"ed{position}x{step}"
                out = f"e{position}x{step}"
                scale = (
                    f"scale={ew}:{eh}:force_original_aspect_ratio=increase:flags=lanczos,"
                    f"crop={ew}:{eh},setsar=1"
                )
                if edit.get("soft_edges"):
                    edge = (
                        "format=rgba,"
                        "geq="
                        "r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':"
                        "a='min(min(255*min(X\\,W-1-X)/(0.12*W)\\,"
                        "255*min(Y\\,H-1-Y)/(0.12*H))\\,255)'"
                    )
                    pix = edge
                else:
                    pix = "format=yuv420p"
                graph.append(
                    f"[{input_index}:v]fps={fps},"
                    f"trim=duration={hold:.3f},setpts=PTS-STARTPTS,"
                    f"{scale},"
                    f"{pix}[{en}]"
                )
                graph.append(
                    f"[{current}][{en}]overlay="
                    f"x='min({ex}\\,main_w-overlay_w)':y='min({ey}\\,main_h-overlay_h)':"
                    f"shortest=1:format=auto[{out}]"
                )
                current = out
            for step, input_index in enumerate(anim_by_segment[position]):
                anim = anim_inputs[input_index - anim_base][1]
                hold = segment.hold + fade_out[position]
                rate = max(0.1, min(float(anim.get("speed", 100)) / 100.0, 4.0))
                aw = max(2, int(round(width * max(0.05, min(anim["w"], 1.0)) / 2) * 2))
                ax = int(round(width * max(0.0, min(anim["x"], 1.0))))
                ay = int(round(height * max(0.0, min(anim["y"], 1.0))))
                an = f"an{position}x{step}"
                out = f"a{position}x{step}"
                # CSS brightness/saturate(%) → ffmpeg eq. Saturation 1.0 is neutral.
                eq_bright = max(-1.0, min(1.0, (float(anim.get("brightness", 100)) - 100.0) / 100.0))
                eq_sat = max(0.0, min(float(anim.get("saturation", 100)) / 100.0, 3.0))
                eq_parts = []
                if abs(eq_bright) > 0.001:
                    eq_parts.append(f"brightness={eq_bright:.4f}")
                if abs(eq_sat - 1.0) > 0.001:
                    eq_parts.append(f"saturation={eq_sat:.4f}")
                bright_filter = f",eq={':'.join(eq_parts)}" if eq_parts else ""
                aspect = anim.get("aspect", "native")
                if aspect == "landscape":
                    ah = max(2, int(round(aw * 9 / 16 / 2) * 2))
                    scale = (
                        f"scale={aw}:{ah}:force_original_aspect_ratio=increase:flags=lanczos,"
                        f"crop={aw}:{ah},setsar=1"
                    )
                elif aspect == "portrait":
                    ah = max(2, int(round(aw * 16 / 9 / 2) * 2))
                    scale = (
                        f"scale={aw}:{ah}:force_original_aspect_ratio=increase:flags=lanczos,"
                        f"crop={aw}:{ah},setsar=1"
                    )
                else:
                    scale = f"scale={aw}:-2:flags=lanczos,setsar=1"
                if anim.get("soft_edges"):
                    # Feather ~12% of each edge into transparency for easier blends.
                    edge = (
                        "format=rgba,"
                        "geq="
                        "r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':"
                        "a='min(min(255*min(X\\,W-1-X)/(0.12*W)\\,"
                        "255*min(Y\\,H-1-Y)/(0.12*H))\\,255)'"
                    )
                    pix = edge
                else:
                    pix = "format=yuv420p"
                graph.append(
                    f"[{input_index}:v]fps={fps},"
                    f"setpts=PTS/{rate:.4f},"
                    f"trim=duration={hold:.3f},setpts=PTS-STARTPTS,"
                    f"{scale}{bright_filter},"
                    f"{pix}[{an}]"
                )
                graph.append(
                    f"[{current}][{an}]overlay="
                    f"x='min({ax}\\,main_w-overlay_w)':y='min({ay}\\,main_h-overlay_h)':"
                    f"shortest=1:format=auto[{out}]"
                )
                current = out
            for step, input_index in enumerate(effect_by_segment[position]):
                effect = effect_inputs[input_index - effect_base][1]
                rate = max(0.1, min(effect["speed"] / 100.0, 4.0))
                hold = segment.hold + fade_out[position]
                fx = f"fx{position}x{step}"
                out = f"b{position}x{step}"
                graph.append(
                    f"[{input_index}:v]fps={fps},"
                    f"setpts=PTS/{rate:.4f},"
                    f"trim=duration={hold:.3f},setpts=PTS-STARTPTS,"
                    f"scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos,"
                    f"crop={width}:{height},setsar=1,"
                    f"{effect_key_filter(effect['path'])},"
                    f"format=yuva420p[{fx}]"
                )
                graph.append(
                    f"[{current}][{fx}]overlay=0:0:eof_action=repeat:format=auto[{out}]"
                )
                current = out
            graph.append(f"[{current}]format=yuv420p[v{position}]")

        if len(segments) == 1:
            video_out = "[v0]"
        else:
            current = "[v0]"
            offset = 0.0
            for position in range(1, len(segments)):
                # Each transition starts on the boundary between two holds.
                offset += segments[position - 1].hold
                label = f"[x{position}]"
                style = segments[position].enter_style or "fade"
                if style not in XFADE_STYLES:
                    style = "fade"
                graph.append(
                    f"{current}[v{position}]xfade=transition={style}"
                    f":duration={fade_out[position - 1]:.3f}:offset={offset:.3f}{label}"
                )
                current = label
            video_out = current

        graph.append(
            f"{video_out}trim=duration={total:.3f},setpts=PTS-STARTPTS,"
            f"fade=t=in:st=0:d={open_close_fade:.3f},"
            f"fade=t=out:st={max(total - open_close_fade, 0):.3f}:d={open_close_fade:.3f}[vbase]"
        )

        current = "vbase"
        # Silent map bridges — visual only, scene audio continues underneath.
        # Animations are stamped onto the map *before* Ken Burns so they stay locked.
        for step, event in enumerate(bridge_events):
            input_index = bridge_base + step
            start = max(0.0, float(event["start"]))
            duration = float(event["duration"])
            fade_in = min(float(event["fade_in"]), max(0.0, duration * 0.45))
            fade_out = min(float(event["fade_out"]), max(0.0, duration * 0.45))
            if fade_in + fade_out > duration:
                fade_out = max(0.0, duration - fade_in)
            anims = bridge_anim_by_event.get(step) or []
            zoom_chain = bridge_map_filter(
                width=width,
                height=height,
                fps=fps,
                duration=duration,
                fade_in=fade_in,
                fade_out=fade_out,
                style=str(event.get("style") or "fade"),
                zoom=event.get("zoom"),
                zoom_dir=str(event.get("zoom_dir") or "in"),
                zoom_span=float(event.get("zoom_span") or 0),
                zoom_start=event.get("zoom_start"),
                zoom_out_span=float(event.get("zoom_out_span") or 0),
                include_fps=not anims,
            )
            ov = f"map{step}"
            out = f"vm{step}"
            end = start + duration
            if not anims:
                graph.append(
                    f"[{input_index}:v]{zoom_chain},"
                    f"trim=duration={duration:.3f},setpts=PTS-STARTPTS+{start:.3f}/TB[{ov}]"
                )
            else:
                mw, mh = image_size(Path(event["image"]))
                base = f"bm{step}x0"
                graph.append(
                    f"[{input_index}:v]fps={fps},"
                    f"trim=duration={duration:.3f},setpts=PTS-STARTPTS,"
                    f"scale={mw}:{mh}:force_original_aspect_ratio=increase:flags=lanczos,"
                    f"crop={mw}:{mh},setsar=1,format=rgba[{base}]"
                )
                layer = base
                for anim_step, (anim_index, anim) in enumerate(anims):
                    rate = max(0.1, min(float(anim.get("speed", 100)) / 100.0, 4.0))
                    aw = max(2, int(round(mw * max(0.05, min(anim["w"], 1.0)) / 2) * 2))
                    ax = int(round(mw * max(0.0, min(anim["x"], 1.0))))
                    ay = int(round(mh * max(0.0, min(anim["y"], 1.0))))
                    ah = anim.get("h")
                    aspect = anim.get("aspect", "native")
                    if ah is not None and float(ah) > 0:
                        ah = max(2, int(round(mh * max(0.05, min(float(ah), 1.0)) / 2) * 2))
                        scale = (
                            f"scale={aw}:{ah}:force_original_aspect_ratio=increase:flags=lanczos,"
                            f"crop={aw}:{ah},setsar=1"
                        )
                    elif aspect == "portrait":
                        ah = max(2, int(round(aw * 16 / 9 / 2) * 2))
                        scale = (
                            f"scale={aw}:{ah}:force_original_aspect_ratio=increase:flags=lanczos,"
                            f"crop={aw}:{ah},setsar=1"
                        )
                    elif aspect == "landscape":
                        ah = max(2, int(round(aw * 9 / 16 / 2) * 2))
                        scale = (
                            f"scale={aw}:{ah}:force_original_aspect_ratio=increase:flags=lanczos,"
                            f"crop={aw}:{ah},setsar=1"
                        )
                    else:
                        scale = f"scale={aw}:-2:flags=lanczos,setsar=1"
                    eq_bright = max(
                        -1.0, min(1.0, (float(anim.get("brightness", 100)) - 100.0) / 100.0)
                    )
                    eq_sat = max(0.0, min(float(anim.get("saturation", 100)) / 100.0, 3.0))
                    eq_parts = []
                    if abs(eq_bright) > 0.001:
                        eq_parts.append(f"brightness={eq_bright:.4f}")
                    if abs(eq_sat - 1.0) > 0.001:
                        eq_parts.append(f"saturation={eq_sat:.4f}")
                    bright_filter = f",eq={':'.join(eq_parts)}" if eq_parts else ""
                    if anim.get("soft_edges"):
                        pix = (
                            "format=rgba,"
                            "geq="
                            "r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':"
                            "a='min(min(255*min(X\\,W-1-X)/(0.12*W)\\,"
                            "255*min(Y\\,H-1-Y)/(0.12*H))\\,255)'"
                        )
                    else:
                        pix = "format=rgba"
                    an = f"ba{step}x{anim_step}"
                    nxt = f"bm{step}x{anim_step + 1}"
                    graph.append(
                        f"[{anim_index}:v]fps={fps},"
                        f"setpts=PTS/{rate:.4f},"
                        f"trim=duration={duration:.3f},setpts=PTS-STARTPTS,"
                        f"{scale}{bright_filter},"
                        f"{pix}[{an}]"
                    )
                    graph.append(
                        f"[{layer}][{an}]overlay="
                        f"x='min({ax}\\,main_w-overlay_w)':y='min({ay}\\,main_h-overlay_h)':"
                        f"shortest=1:format=auto[{nxt}]"
                    )
                    layer = nxt
                graph.append(
                    f"[{layer}]{zoom_chain},"
                    f"trim=duration={duration:.3f},setpts=PTS-STARTPTS+{start:.3f}/TB[{ov}]"
                )
            # repeatlast defaults to 1 and freezes the last map frame over the rest
            # of the timeline — eof_action=pass alone is not enough on recent ffmpeg.
            graph.append(
                f"[{current}][{ov}]overlay=0:0:eof_action=pass:repeatlast=0:format=auto:"
                f"enable='gte(t\\,{start:.3f})*lt(t\\,{end:.3f})'[{out}]"
            )
            current = out

        for step, (event, _png) in enumerate(overlay_inputs):
            input_index = overlay_base + step
            start = max(0.0, float(event["start"]))
            duration = float(event["duration"])
            ov_fade = min(OVERLAY_FADE, max(0.05, duration * 0.45))
            out_start = max(0.0, duration - ov_fade)
            ax = int(round(width * max(0.0, min(event["x"], 1.0))))
            ay = int(round(height * max(0.0, min(event["y"], 1.0))))
            ov = f"ov{step}"
            out = f"vo{step}"
            graph.append(
                f"[{input_index}:v]fps={fps},format=rgba,"
                f"fade=t=in:st=0:d={ov_fade:.3f}:alpha=1,"
                f"fade=t=out:st={out_start:.3f}:d={ov_fade:.3f}:alpha=1,"
                f"setpts=PTS-STARTPTS+{start:.3f}/TB[{ov}]"
            )
            graph.append(
                f"[{current}][{ov}]overlay="
                f"x='min({ax}\\,main_w-overlay_w)':y='min({ay}\\,main_h-overlay_h)':"
                f"eof_action=pass:repeatlast=0:format=auto[{out}]"
            )
            current = out
        graph.append(f"[{current}]format=yuv420p,trim=duration={total:.3f},setpts=PTS-STARTPTS[v]")

    index = audio_offset
    scene_labels: list[str] = []
    for scene in scenes:
        track_labels = []
        for track in scene.tracks:
            label = f"a{index}"
            # Trim borrowed slices (and any future offset) before the scene mix.
            trim = ""
            if track.offset > 0.001 or track.duration > 0:
                trim = f"atrim=start={track.offset:.3f}:duration={track.duration:.3f},asetpts=PTS-STARTPTS,"
            graph.append(
                f"[{index}:a]{trim}aresample=48000,"
                f"aformat=sample_fmts=fltp:channel_layouts=stereo[{label}]"
            )
            track_labels.append(label)
            index += 1

        if not track_labels:
            # Transitions (and other zero-length markers) stay out of the mix.
            if scene.audio_duration <= 0.001:
                continue
            # Songless picture scene — bed of silence (ambient sounds can still layer on).
            silence = f"s{scene.index}sil"
            graph.append(
                f"anullsrc=channel_layout=stereo:sample_rate=48000,"
                f"atrim=duration={max(scene.audio_duration, 0.1):.3f},"
                f"asetpts=PTS-STARTPTS[{silence}]"
            )
            merged = silence
        elif len(track_labels) == 1:
            merged = track_labels[0]
        elif track_crossfade > 0:
            merged = track_labels[0]
            for step, label in enumerate(track_labels[1:], start=1):
                out = f"s{scene.index}m{step}"
                fade = _pair_crossfade(scene.tracks[step - 1], scene.tracks[step], track_crossfade)
                graph.append(
                    f"[{merged}][{label}]acrossfade=d={fade:.3f}:c1=tri:c2=tri[{out}]"
                )
                merged = out
        else:
            joined = "".join(f"[{label}]" for label in track_labels)
            merged = f"s{scene.index}cat"
            graph.append(f"{joined}concat=n={len(track_labels)}:v=0:a=1[{merged}]")

        if scene.sounds:
            amb_labels = [merged]
            for step, (_path, volume) in enumerate(scene.sounds):
                label = f"amb{scene.index}x{step}"
                graph.append(
                    f"[{index}:a]aresample=48000,"
                    f"aformat=sample_fmts=fltp:channel_layouts=stereo,"
                    f"volume={volume:.4f}[{label}]"
                )
                amb_labels.append(label)
                index += 1
            joined = "".join(f"[{label}]" for label in amb_labels)
            mixed = f"s{scene.index}bed"
            graph.append(
                f"{joined}amix=inputs={len(amb_labels)}:duration=first:"
                f"dropout_transition=0:normalize=0[{mixed}]"
            )
            merged = mixed

        # Exact scene length so the next scene's songs start on the cut
        # (mid-map), not drifted from acrossfade/amix rounding.
        exact = f"s{scene.index}len"
        graph.append(
            f"[{merged}]atrim=duration={scene.audio_duration:.3f},"
            f"apad=whole_dur={scene.audio_duration:.3f},"
            f"asetpts=PTS-STARTPTS[{exact}]"
        )
        scene_labels.append(exact)

    if not scene_labels:
        raise BuildError("nothing to mix — add a scene with a picture (songs optional)")
    if len(scene_labels) == 1:
        audio_out = scene_labels[0]
    else:
        joined = "".join(f"[{label}]" for label in scene_labels)
        audio_out = "acat"
        graph.append(f"{joined}concat=n={len(scene_labels)}:v=0:a=1[{audio_out}]")

    graph.append(
        f"[{audio_out}]atrim=duration={total:.3f},asetpts=PTS-STARTPTS,"
        f"afade=t=in:st=0:d={open_close_fade:.3f},"
        f"afade=t=out:st={max(total - open_close_fade, 0):.3f}:d={open_close_fade:.3f}[a]"
    )

    if audio_only:
        cmd += [
            "-filter_complex", ";".join(graph),
            "-map", "[a]",
            "-c:a", "libmp3lame", "-b:a", "192k",
            str(output),
        ]
        return cmd

    cmd += [
        "-filter_complex", ";".join(graph),
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264",
        "-preset", quality["preset"],
        "-crf", str(quality["crf"]),
        "-tune", "stillimage",
        "-pix_fmt", "yuv420p",
        "-r", str(fps),
        "-c:a", "aac", "-b:a", quality["audio_bitrate"],
        "-movflags", "+faststart",
        str(output),
    ]
    return cmd


def build_assemble_command(
    scenes: list[Scene],
    clips: list[Path],
    total: float,
    output: Path,
    width: int,
    height: int,
    fps: int,
    open_close_fade: float,
    quality: dict,
    overlays: dict | None = None,
) -> list[str]:
    """Stitch pre-rendered scene clips and burn map transitions on top."""
    playable = [scene for scene in scenes if not scene.is_transition and scene.audio_duration > 0.001]
    if len(playable) != len(clips):
        raise BuildError("assemble clip count does not match playable scenes")
    if not clips:
        raise BuildError("nothing to assemble — process each scene first")

    cmd: list[str] = ["ffmpeg", "-y"]
    for clip in clips:
        cmd += ["-i", str(clip)]

    bridge_events = collect_bridge_overlays(scenes)
    bridge_base = len(clips)
    for event in bridge_events:
        hold = max(float(event["duration"]), 0.1)
        cmd += [
            "-loop", "1",
            "-framerate", str(fps),
            "-t", f"{hold:.3f}",
            "-i", str(event["image"]),
        ]
    bridge_anim_base = bridge_base + len(bridge_events)
    bridge_anim_by_event: dict[int, list[tuple[int, dict]]] = {
        i: [] for i in range(len(bridge_events))
    }
    bridge_anim_count = 0
    for event_i, event in enumerate(bridge_events):
        hold = max(float(event["duration"]), 0.1)
        for anim in event.get("animations") or []:
            looped = seamless_loop_clip(
                anim["path"],
                fps,
                start=anim.get("loop_in"),
                end=anim.get("loop_out"),
            )
            bridge_anim_by_event[event_i].append((bridge_anim_base + bridge_anim_count, anim))
            bridge_anim_count += 1
            cmd += ["-stream_loop", "-1", "-t", f"{hold:.3f}", "-i", str(looped)]

    overlay_base = bridge_anim_base + bridge_anim_count
    overlay_inputs: list[tuple[dict, Path]] = []
    for event in collect_overlay_events(scenes, overlays):
        png = overlay_png_for(event, height)
        overlay_inputs.append((event, png))
        hold = max(float(event["duration"]), OVERLAY_FADE * 2 + 0.05)
        cmd += [
            "-loop", "1",
            "-framerate", str(fps),
            "-t", f"{hold:.3f}",
            "-i", str(png),
        ]

    graph: list[str] = []
    v_labels: list[str] = []
    a_labels: list[str] = []
    for index, scene in enumerate(playable):
        duration = max(scene.audio_duration, 0.1)
        v_label = f"cv{index}"
        a_label = f"ca{index}"
        graph.append(
            f"[{index}:v]fps={fps},"
            f"scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos,"
            f"crop={width}:{height},setsar=1,format=yuv420p,"
            f"trim=duration={duration:.3f},setpts=PTS-STARTPTS[{v_label}]"
        )
        graph.append(
            f"[{index}:a]aresample=48000,"
            f"aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"atrim=duration={duration:.3f},apad=whole_dur={duration:.3f},"
            f"asetpts=PTS-STARTPTS[{a_label}]"
        )
        v_labels.append(v_label)
        a_labels.append(a_label)

    if len(v_labels) == 1:
        video_out = f"[{v_labels[0]}]"
        audio_out = a_labels[0]
    else:
        joined_v = "".join(f"[{label}]" for label in v_labels)
        joined_a = "".join(f"[{label}]" for label in a_labels)
        graph.append(f"{joined_v}concat=n={len(v_labels)}:v=1:a=0[vcat]")
        graph.append(f"{joined_a}concat=n={len(a_labels)}:v=0:a=1[acat]")
        video_out = "[vcat]"
        audio_out = "acat"

    graph.append(
        f"{video_out}trim=duration={total:.3f},setpts=PTS-STARTPTS,"
        f"fade=t=in:st=0:d={open_close_fade:.3f},"
        f"fade=t=out:st={max(total - open_close_fade, 0):.3f}:d={open_close_fade:.3f}[vbase]"
    )
    graph.append(
        f"[{audio_out}]atrim=duration={total:.3f},asetpts=PTS-STARTPTS,"
        f"afade=t=in:st=0:d={open_close_fade:.3f},"
        f"afade=t=out:st={max(total - open_close_fade, 0):.3f}:d={open_close_fade:.3f}[a]"
    )

    current = "vbase"
    for step, event in enumerate(bridge_events):
        input_index = bridge_base + step
        start = max(0.0, float(event["start"]))
        duration = float(event["duration"])
        fade_in = min(float(event["fade_in"]), max(0.0, duration * 0.45))
        fade_out = min(float(event["fade_out"]), max(0.0, duration * 0.45))
        if fade_in + fade_out > duration:
            fade_out = max(0.0, duration - fade_in)
        anims = bridge_anim_by_event.get(step) or []
        zoom_chain = bridge_map_filter(
            width=width,
            height=height,
            fps=fps,
            duration=duration,
            fade_in=fade_in,
            fade_out=fade_out,
            style=str(event.get("style") or "fade"),
            zoom=event.get("zoom"),
            zoom_dir=str(event.get("zoom_dir") or "in"),
            zoom_span=float(event.get("zoom_span") or 0),
            zoom_start=event.get("zoom_start"),
            zoom_out_span=float(event.get("zoom_out_span") or 0),
            include_fps=not anims,
        )
        ov = f"map{step}"
        out = f"vm{step}"
        end = start + duration
        if not anims:
            graph.append(
                f"[{input_index}:v]{zoom_chain},"
                f"trim=duration={duration:.3f},setpts=PTS-STARTPTS+{start:.3f}/TB[{ov}]"
            )
        else:
            mw, mh = image_size(Path(event["image"]))
            base = f"bm{step}x0"
            graph.append(
                f"[{input_index}:v]fps={fps},"
                f"trim=duration={duration:.3f},setpts=PTS-STARTPTS,"
                f"scale={mw}:{mh}:force_original_aspect_ratio=increase:flags=lanczos,"
                f"crop={mw}:{mh},setsar=1,format=rgba[{base}]"
            )
            layer = base
            for anim_step, (anim_index, anim) in enumerate(anims):
                rate = max(0.1, min(float(anim.get("speed", 100)) / 100.0, 4.0))
                aw = max(2, int(round(mw * max(0.05, min(anim["w"], 1.0)) / 2) * 2))
                ax = int(round(mw * max(0.0, min(anim["x"], 1.0))))
                ay = int(round(mh * max(0.0, min(anim["y"], 1.0))))
                ah = anim.get("h")
                aspect = anim.get("aspect", "native")
                if ah is not None and float(ah) > 0:
                    ah = max(2, int(round(mh * max(0.05, min(float(ah), 1.0)) / 2) * 2))
                elif aspect == "portrait":
                    ah = max(2, int(round(aw * 16 / 9 / 2) * 2))
                elif aspect == "landscape":
                    ah = max(2, int(round(aw * 9 / 16 / 2) * 2))
                else:
                    ah = -2
                if ah <= 0:
                    scale = f"scale={aw}:-2:flags=lanczos,setsar=1"
                else:
                    scale = (
                        f"scale={aw}:{ah}:force_original_aspect_ratio=decrease:flags=lanczos,"
                        f"pad={aw}:{ah}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,setsar=1"
                    )
                eq_parts = []
                eq_bri = float(anim.get("brightness", 100)) / 100.0
                eq_sat = float(anim.get("saturation", 100)) / 100.0
                if abs(eq_bri - 1.0) > 0.001:
                    eq_parts.append(f"brightness={eq_bri - 1.0:.4f}")
                if abs(eq_sat - 1.0) > 0.001:
                    eq_parts.append(f"saturation={eq_sat:.4f}")
                bright_filter = f",eq={':'.join(eq_parts)}" if eq_parts else ""
                if anim.get("soft_edges"):
                    pix = (
                        "format=rgba,"
                        "geq="
                        "r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':"
                        "a='min(min(255*min(X\\,W-1-X)/(0.12*W)\\,"
                        "255*min(Y\\,H-1-Y)/(0.12*H))\\,255)'"
                    )
                else:
                    pix = "format=rgba"
                an = f"ba{step}x{anim_step}"
                nxt = f"bm{step}x{anim_step + 1}"
                graph.append(
                    f"[{anim_index}:v]fps={fps},"
                    f"setpts=PTS/{rate:.4f},"
                    f"trim=duration={duration:.3f},setpts=PTS-STARTPTS,"
                    f"{scale}{bright_filter},"
                    f"{pix}[{an}]"
                )
                graph.append(
                    f"[{layer}][{an}]overlay="
                    f"x='min({ax}\\,main_w-overlay_w)':y='min({ay}\\,main_h-overlay_h)':"
                    f"shortest=1:format=auto[{nxt}]"
                )
                layer = nxt
            graph.append(
                f"[{layer}]{zoom_chain},"
                f"trim=duration={duration:.3f},setpts=PTS-STARTPTS+{start:.3f}/TB[{ov}]"
            )
        graph.append(
            f"[{current}][{ov}]overlay=0:0:eof_action=pass:repeatlast=0:format=auto:"
            f"enable='gte(t\\,{start:.3f})*lt(t\\,{end:.3f})'[{out}]"
        )
        current = out

    for step, (event, _png) in enumerate(overlay_inputs):
        input_index = overlay_base + step
        start = max(0.0, float(event["start"]))
        duration = float(event["duration"])
        ov_fade = min(OVERLAY_FADE, max(0.05, duration * 0.45))
        out_start = max(0.0, duration - ov_fade)
        ax = int(round(width * max(0.0, min(event["x"], 1.0))))
        ay = int(round(height * max(0.0, min(event["y"], 1.0))))
        ov = f"ov{step}"
        out = f"vo{step}"
        end = start + duration
        graph.append(
            f"[{input_index}:v]fps={fps},format=rgba,"
            f"fade=t=in:st=0:d={ov_fade:.3f}:alpha=1,"
            f"fade=t=out:st={out_start:.3f}:d={ov_fade:.3f}:alpha=1,"
            f"trim=duration={duration:.3f},setpts=PTS-STARTPTS+{start:.3f}/TB[{ov}]"
        )
        graph.append(
            f"[{current}][{ov}]overlay="
            f"x='min({ax}\\,main_w-overlay_w)':y='min({ay}\\,main_h-overlay_h)':"
            f"eof_action=pass:repeatlast=0:format=auto:"
            f"enable='gte(t\\,{start:.3f})*lt(t\\,{end:.3f})'[{out}]"
        )
        current = out

    graph.append(f"[{current}]format=yuv420p,trim=duration={total:.3f},setpts=PTS-STARTPTS[v]")

    cmd += [
        "-filter_complex", ";".join(graph),
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264",
        "-preset", quality["preset"],
        "-crf", str(quality["crf"]),
        "-pix_fmt", "yuv420p",
        "-r", str(fps),
        "-c:a", "aac", "-b:a", quality["audio_bitrate"],
        "-movflags", "+faststart",
        str(output),
    ]
    return cmd


def run_ffmpeg(command: list[str], total: float, machine_readable: bool = False) -> int:
    """Run the render, optionally reporting progress for the editor to read."""
    if not machine_readable:
        return subprocess.run(command).returncode

    command = [command[0], "-progress", "pipe:1", "-nostats", *command[1:]]
    print(f"total {total:.3f}", flush=True)
    process = subprocess.Popen(command, stdout=subprocess.PIPE, text=True)
    for line in process.stdout:
        if line.startswith("out_time_us="):
            try:
                print(f"progress {int(line.split('=', 1)[1]) / 1_000_000:.2f}", flush=True)
            except ValueError:
                pass
    return process.wait()


def print_timeline(scenes: list[Scene], total: float) -> None:
    for scene in scenes:
        where = f" — {scene.location}" if scene.location else ""
        print(f"\n{timecode(scene.start)}  Scene {scene.index}: {scene.title}{where}")
        for segment in scene.segments:
            print(
                f"    {timecode(segment.start)}  {segment.label:<34}"
                f"{segment.hold / 60:5.1f} min  pan:{segment.pan} zoom:{segment.zoom:g}"
            )
        for overlay in scene.bridge_overlays or []:
            start = scene.start + float(overlay.get("start") or 0)
            hold = float(overlay.get("duration") or 0)
            label = f"{overlay.get('label') or 'map'} (overlay)"
            print(
                f"    {timecode(start)}  {label:<34}"
                f"{hold / 60:5.1f} min  silent map on top"
            )
        for start, duration, name in scene.track_starts():
            print(f"    {timecode(start)}  ♪ {name} ({duration / 60:.1f} min)")
    print(f"\nTotal runtime: {timecode(total)} ({total / 60:.1f} min)\n")


def write_scene_render_meta(script_path: Path, scene_number: int, output: Path) -> None:
    """Persist a fingerprint of the scene object next to the clip for Ready/Outdated."""
    try:
        script = json.loads(script_path.read_text())
        entry = (script.get("scenes") or [])[scene_number - 1]
    except (OSError, json.JSONDecodeError, IndexError, TypeError):
        return
    if not isinstance(entry, dict):
        return
    payload = json.dumps(entry, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    meta = {
        "fingerprint": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
        "scene": scene_number,
        "title": entry.get("title") or "",
    }
    Path(str(output) + ".meta.json").write_text(json.dumps(meta, indent=2) + "\n")


def write_chapters(scenes: list[Scene], path: Path) -> None:
    lines = []
    for scene in scenes:
        where = f" — {scene.location}" if scene.location else ""
        lines.append(f"{timecode(scene.start)} {scene.title}{where}")
        for start, _, name in scene.track_starts():
            lines.append(f"{timecode(start)} · {name}")
    path.write_text("\n".join(lines) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("script", nargs="?", default="journey.json", type=Path)
    parser.add_argument("--check", action="store_true", help="validate and print the timeline, render nothing")
    parser.add_argument("--preview", action="store_true", help="quick low-resolution draft")
    parser.add_argument("--scene", type=int, help="render a single scene by number")
    parser.add_argument(
        "--assemble",
        action="store_true",
        help="stitch pre-rendered scene clips and burn map transitions on top",
    )
    parser.add_argument("--output", type=Path, help="override the output file")
    parser.add_argument("--print-command", action="store_true", help="show the ffmpeg command")
    parser.add_argument("--progress", action="store_true", help="print machine-readable progress")
    parser.add_argument("--audio", type=Path, help="render only the mixed audio to this file")
    args = parser.parse_args()

    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            print(f"error: {tool} is not installed (brew install ffmpeg)", file=sys.stderr)
            return 1

    if args.assemble and args.scene is not None:
        print("error: use --assemble or --scene, not both", file=sys.stderr)
        return 1
    if args.assemble and args.audio:
        print("error: --assemble cannot be combined with --audio", file=sys.stderr)
        return 1

    try:
        script, scenes, total = load_script(args.script)
    except (BuildError, KeyError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.scene is not None:
        chosen = [scene for scene in scenes if scene.index == args.scene]
        if not chosen:
            print(f"error: there is no scene {args.scene}", file=sys.stderr)
            return 1
        if chosen[0].is_transition:
            print(
                f"error: scene {args.scene} ({chosen[0].title}) is a transition — "
                "map bridges only render in the full video. Use Process Video.",
                file=sys.stderr,
            )
            return 1
        scenes = chosen
        total = scenes[0].audio_duration
        offset = scenes[0].start
        scenes[0].start = 0.0
        for segment in scenes[0].segments:
            segment.start -= offset
        # Scene-only renders are the picture + songs — map transitions belong in
        # Process Video, otherwise Download Scene opens on the map bridge.
        scenes[0].bridge_overlays = []
        if total <= 0 or not scenes[0].segments:
            print(
                f"error: scene {args.scene} ({scenes[0].title}) has nothing to render — "
                "add a picture (songs optional)",
                file=sys.stderr,
            )
            return 1

    output_config = script.get("output", {})
    defaults = script.get("defaults", {})
    root = project_root(args.script)

    width = int(output_config.get("width", 1920))
    height = int(output_config.get("height", 1080))
    fps = int(output_config.get("fps", 30))
    quality = {"preset": "medium", "crf": 18, "audio_bitrate": "320k"}

    output = args.output or root / output_config.get("file", "out/journey.mp4")
    if args.preview:
        # Keep the episode's shape; only drop the resolution.
        height = int(round(960 * height / width / 2)) * 2
        width, fps = 960, 24
        quality = {"preset": "veryfast", "crf": 30, "audio_bitrate": "128k"}
        output = output.with_name(f"{output.stem}-preview{output.suffix}")
    if args.scene is not None:
        output = output.with_name(f"{output.stem}-scene{args.scene}{output.suffix}")
    if args.audio:
        output = args.audio
    output.parent.mkdir(parents=True, exist_ok=True)

    assemble_clips: list[Path] = []
    if args.assemble:
        # Scene clips always live next to the script's normal output file
        # (out/foo-sceneN.mp4), even when --preview / --output rename the assemble target.
        clip_base = root / output_config.get("file", "out/journey.mp4")
        playable = [
            scene for scene in scenes if not scene.is_transition and scene.audio_duration > 0.001
        ]
        for scene in playable:
            clip = clip_base.with_name(f"{clip_base.stem}-scene{scene.index}{clip_base.suffix}")
            if not clip.exists():
                print(
                    f"error: missing scene clip for {scene.title!r} ({clip.name}) — "
                    "Process Scene first",
                    file=sys.stderr,
                )
                return 1
            actual = probe_duration(clip)
            if actual + 0.5 < scene.audio_duration:
                print(
                    f"error: scene clip for {scene.title!r} is incomplete "
                    f"({actual:.1f}s on disk, needs {scene.audio_duration:.1f}s) — "
                    "Process Scene again",
                    file=sys.stderr,
                )
                return 1
            assemble_clips.append(clip)

    print(f"{script.get('project', args.script.stem)} — {len(scenes)} scene(s)")
    print_timeline(scenes, total)

    # Scene downloads skip episode open/close fades so assemble can hard-cut cleanly.
    open_close = 0.0 if args.scene is not None else float(defaults.get("open_close_fade", 2))
    if args.assemble:
        try:
            command = build_assemble_command(
                scenes,
                assemble_clips,
                total,
                output,
                width=width,
                height=height,
                fps=fps,
                open_close_fade=open_close,
                quality=quality,
                overlays=script.get("overlays"),
            )
        except BuildError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
    else:
        command = build_command(
            scenes,
            total,
            output,
            width=width,
            height=height,
            fps=fps,
            fade=float(defaults.get("fade_seconds", 3)),
            track_crossfade=float(defaults.get("track_crossfade", 2)),
            open_close_fade=open_close,
            quality=quality,
            audio_only=bool(args.audio),
            overlays=script.get("overlays"),
        )

    if args.print_command:
        print(shlex.join(command), "\n")

    if args.check:
        return 0

    label = "audio" if args.audio else ("assemble" if args.assemble else f"{width}x{height}")
    print(f"Rendering {label} to {output} …")
    code = run_ffmpeg(command, total, machine_readable=args.progress)
    if code != 0:
        return code

    if args.audio:
        print(f"Done: {output}")
        return 0

    if args.scene is not None:
        write_scene_render_meta(args.script, args.scene, output)
    if args.scene is None:
        chapters = output.with_name(f"{output.stem}-chapters.txt")
        write_chapters(scenes, chapters)
        print(f"Chapters written to {chapters}")
    print(f"Done: {output}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
