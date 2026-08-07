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
    effects: list[dict] = field(default_factory=list)
    animations: list[dict] = field(default_factory=list)


@dataclass
class Scene:
    index: int
    title: str
    location: str
    segments: list[Segment] = field(default_factory=list)
    tracks: list[tuple[Path, float, str]] = field(default_factory=list)
    effects: list[dict] = field(default_factory=list)
    animations: list[dict] = field(default_factory=list)
    audio_duration: float = 0.0
    start: float = 0.0
    track_crossfade: float = 0.0

    def track_starts(self) -> list[tuple[float, float, str]]:
        cursor = self.start
        marks = []
        for _, duration, name in self.tracks:
            marks.append((cursor, duration, name))
            cursor += duration - self.track_crossfade
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


def load_script(manifest_path: Path) -> tuple[dict, list[Scene], float]:
    with manifest_path.open() as handle:
        script = json.load(handle)

    root = project_root(manifest_path)
    defaults = script.get("defaults", {})
    map_seconds = float(defaults.get("map_seconds", 60))
    track_crossfade = float(defaults.get("track_crossfade", 2))
    default_zoom = float(defaults.get("zoom", 1.12))
    shared_map = script.get("map")

    scenes: list[Scene] = []
    clock = 0.0

    for index, raw in enumerate(script.get("scenes", []), start=1):
        title = raw.get("title", f"Scene {index}")

        tracks: list[tuple[Path, float, str]] = []
        for entry in raw.get("tracks", []):
            source = entry["file"] if isinstance(entry, dict) else entry
            path = resolve(root, source, "song")
            name = entry.get("title", path.stem) if isinstance(entry, dict) else path.stem
            tracks.append((path, probe_duration(path), name))
        if not tracks:
            raise BuildError(f"scene {index} ({title}) has no tracks")

        # Songs overlap slightly, so the scene is shorter than the raw sum.
        audio_duration = sum(d for _, d, _ in tracks)
        audio_duration -= track_crossfade * (len(tracks) - 1)

        map_config = raw.get("map", {})
        if isinstance(map_config, str):
            map_config = {"image": map_config}
        if map_config is None:
            map_config = {"seconds": 0}
        # A zero-second hold means this scene opens straight on its picture.
        map_hold = float(map_config.get("seconds", map_seconds))

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
            animations.append(
                {
                    "path": resolve(root, source, "animation"),
                    "x": float(entry.get("x", 0.36)),
                    "y": float(entry.get("y", 0.28)),
                    "w": float(entry.get("w", 0.28)),
                }
            )

        # The map eats into the scene's music rather than being extra time.
        map_hold = min(map_hold, audio_duration * 0.5)
        picture_hold = (audio_duration - map_hold) / len(images)

        segments = []
        if map_hold > 0:
            map_source = map_config.get("image", shared_map)
            if not map_source:
                raise BuildError(
                    f"scene {index} ({title}) has no map image and no top-level \"map\" is set"
                )
            segments.append(
                Segment(
                    image=resolve(root, map_source, "map image"),
                    hold=map_hold,
                    label=f"{title} (map)",
                    pan=map_config.get("pan", "none"),
                    zoom=float(map_config.get("zoom", 1.0)),
                    fade_in=optional_float(map_config.get("fade_in")),
                    effects=effects,
                    animations=animations,
                )
            )
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
                    effects=effects,
                    animations=animations,
                )
            )

        scene = Scene(
            index=index,
            title=title,
            location=raw.get("location", ""),
            segments=segments,
            tracks=tracks,
            effects=effects,
            animations=animations,
            audio_duration=audio_duration,
            start=clock,
            track_crossfade=track_crossfade,
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


def seamless_loop_clip(path: Path, fps: int, fade: float = ANIM_LOOP_FADE) -> Path:
    """Cache a muted clip whose end cross-fades into its start, safe to stream-loop.

    The last `fade` seconds dissolve into the first `fade` seconds; the cached
    file is then `duration - fade` long so hard cuts disappear when it loops.
    Used for both animations and full-frame effects.
    """
    duration = probe_duration(path)
    fade = min(fade, max(0.25, duration * 0.45))
    if duration <= fade + 0.05:
        return path

    stat = path.stat()
    token = hashlib.sha1(
        f"{path}|{stat.st_mtime_ns}|{stat.st_size}|{fade:.3f}|{fps}".encode()
    ).hexdigest()[:16]
    target = ANIM_LOOP_CACHE / f"{token}.mp4"
    if target.exists():
        return target

    ANIM_LOOP_CACHE.mkdir(parents=True, exist_ok=True)
    # Crossfade the clip into itself, then keep the middle slice whose end
    # already matches its start (so stream-looping is seamless).
    offset = max(duration - fade, 0.0)
    loop_len = offset
    graph = (
        f"[0:v]fps={fps},format=yuv420p,setpts=PTS-STARTPTS[a];"
        f"[1:v]fps={fps},format=yuv420p,setpts=PTS-STARTPTS[b];"
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

        # Looped green-screen effects (seamless end→start fade), then animations.
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
                looped = seamless_loop_clip(anim["path"], fps)
                anim_inputs.append((position, anim, duration))
                cmd += [
                    "-stream_loop", "-1",
                    "-t", f"{duration:.3f}",
                    "-i", str(looped),
                ]
        audio_offset = len(segments) + len(effect_inputs) + len(anim_inputs)

    for scene in scenes:
        for path, _, _ in scene.tracks:
            cmd += ["-i", str(path)]

    if not audio_only:
        effect_base = len(segments)
        anim_base = effect_base + len(effect_inputs)
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
            # Animations sit under full-frame effects.
            for step, input_index in enumerate(anim_by_segment[position]):
                anim = anim_inputs[input_index - anim_base][1]
                aw = max(2, int(round(width * max(0.05, min(anim["w"], 1.0)) / 2) * 2))
                ax = int(round(width * max(0.0, min(anim["x"], 1.0))))
                ay = int(round(height * max(0.0, min(anim["y"], 1.0))))
                an = f"an{position}x{step}"
                out = f"a{position}x{step}"
                graph.append(
                    f"[{input_index}:v]fps={fps},"
                    f"scale={aw}:-2:flags=lanczos,setsar=1,format=yuv420p[{an}]"
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
                graph.append(
                    f"{current}[v{position}]xfade=transition=fade"
                    f":duration={fade_out[position - 1]:.3f}:offset={offset:.3f}{label}"
                )
                current = label
            video_out = current

        graph.append(
            f"{video_out}trim=duration={total:.3f},setpts=PTS-STARTPTS,"
            f"fade=t=in:st=0:d={open_close_fade:.3f},"
            f"fade=t=out:st={max(total - open_close_fade, 0):.3f}:d={open_close_fade:.3f}[v]"
        )

    index = audio_offset
    scene_labels: list[str] = []
    for scene in scenes:
        track_labels = []
        for _ in scene.tracks:
            label = f"a{index}"
            graph.append(
                f"[{index}:a]aresample=48000,"
                f"aformat=sample_fmts=fltp:channel_layouts=stereo[{label}]"
            )
            track_labels.append(label)
            index += 1

        if len(track_labels) == 1:
            merged = track_labels[0]
        elif track_crossfade > 0:
            merged = track_labels[0]
            for step, label in enumerate(track_labels[1:], start=1):
                out = f"s{scene.index}m{step}"
                graph.append(
                    f"[{merged}][{label}]acrossfade=d={track_crossfade:.3f}:c1=tri:c2=tri[{out}]"
                )
                merged = out
        else:
            joined = "".join(f"[{label}]" for label in track_labels)
            merged = f"s{scene.index}cat"
            graph.append(f"{joined}concat=n={len(track_labels)}:v=0:a=1[{merged}]")
        scene_labels.append(merged)

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
        for start, duration, name in scene.track_starts():
            print(f"    {timecode(start)}  ♪ {name} ({duration / 60:.1f} min)")
    print(f"\nTotal runtime: {timecode(total)} ({total / 60:.1f} min)\n")


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
    parser.add_argument("--output", type=Path, help="override the output file")
    parser.add_argument("--print-command", action="store_true", help="show the ffmpeg command")
    parser.add_argument("--progress", action="store_true", help="print machine-readable progress")
    parser.add_argument("--audio", type=Path, help="render only the mixed audio to this file")
    args = parser.parse_args()

    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            print(f"error: {tool} is not installed (brew install ffmpeg)", file=sys.stderr)
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
        scenes = chosen
        total = scenes[0].audio_duration
        offset = scenes[0].start
        scenes[0].start = 0.0
        for segment in scenes[0].segments:
            segment.start -= offset

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

    print(f"{script.get('project', args.script.stem)} — {len(scenes)} scene(s)")
    print_timeline(scenes, total)

    command = build_command(
        scenes,
        total,
        output,
        width=width,
        height=height,
        fps=fps,
        fade=float(defaults.get("fade_seconds", 3)),
        track_crossfade=float(defaults.get("track_crossfade", 2)),
        open_close_fade=float(defaults.get("open_close_fade", 2)),
        quality=quality,
        audio_only=bool(args.audio),
    )

    if args.print_command:
        print(shlex.join(command), "\n")

    if args.check:
        return 0

    label = "audio" if args.audio else f"{width}x{height}"
    print(f"Rendering {label} to {output} …")
    code = run_ffmpeg(command, total, machine_readable=args.progress)
    if code != 0:
        return code

    if args.audio:
        print(f"Done: {output}")
        return 0

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
