#!/usr/bin/env python3
"""Local editor for Cozy Journeys videos.

Videos live in videos/*.json. The app is a small SPA:

    /              list of videos
    /              landing
    /videos        video list
    /video?v=id    arrange scenes
    /scene?v=id&s=0  edit one scene

    ./serve.py
    ./serve.py --port 9000
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import mimetypes
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
UI = ROOT / "ui"
VIDEOS = ROOT / "videos"
CACHE = ROOT / ".cache" / "thumbs"
AUDIO_CACHE = ROOT / ".cache" / "audio"
VENV_PYTHON = ROOT / ".venv" / "bin" / "python"


def python_bin() -> str:
    """Prefer the project venv so Pillow (overlay burn-in) is available."""
    return str(VENV_PYTHON) if VENV_PYTHON.exists() else sys.executable
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
AUDIO_SUFFIXES = {".mp3", ".m4a", ".wav", ".flac", ".aac", ".ogg"}
VIDEO_SUFFIXES = {".mp4", ".mov", ".webm", ".mkv"}
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]+$")

_durations: dict[tuple[str, int, int], float] = {}


def probe_duration(path: Path) -> float | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    key = (str(path), stat.st_mtime_ns, stat.st_size)
    if key not in _durations:
        proc = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=nw=1:nk=1",
                str(path),
            ],
            capture_output=True,
            text=True,
        )
        try:
            _durations[key] = float(proc.stdout.strip())
        except ValueError:
            _durations[key] = 0.0
    return _durations[key]


def scan(folder: Path, suffixes: set[str]) -> list[dict]:
    if not folder.is_dir():
        return []
    found = []
    for path in sorted(folder.rglob("*")):
        if path.is_file() and path.suffix.lower() in suffixes:
            entry = {"path": path.relative_to(ROOT).as_posix(), "name": path.stem}
            if path.suffix.lower() in AUDIO_SUFFIXES | VIDEO_SUFFIXES:
                entry["duration"] = probe_duration(path) or 0.0
            found.append(entry)
    return found


def output_path(script: dict, scene: int | None = None) -> Path:
    path = ROOT / script.get("output", {}).get("file", "out/journey.mp4")
    if scene is not None:
        return path.with_name(f"{path.stem}-scene{scene}{path.suffix}")
    return path


def output_status(path: Path, script_mtime: float | None = None) -> dict:
    """Describe a render file under out/. ready means present and not older than the script."""
    if not path.exists():
        return {"ready": False, "name": path.name, "stale": False, "exists": False}
    stale = bool(script_mtime is not None and path.stat().st_mtime < script_mtime)
    return {
        "ready": not stale,
        "name": path.name,
        "stale": stale,
        "exists": True,
    }


def video_file(video_id: str) -> Path | None:
    if not VIDEO_ID.fullmatch(video_id or ""):
        return None
    path = (VIDEOS / f"{video_id}.json").resolve()
    try:
        path.relative_to(VIDEOS.resolve())
    except ValueError:
        return None
    return path


def load_script(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def script_duration(script: dict) -> float:
    music = {item["path"]: item["duration"] for item in scan(ROOT / "assets" / "music", AUDIO_SUFFIXES)}
    crossfade = float(script.get("defaults", {}).get("track_crossfade", 2))
    total = 0.0
    for scene in script.get("scenes", []):
        tracks = scene.get("tracks") or []
        lengths = []
        for entry in tracks:
            path = entry if isinstance(entry, str) else entry.get("file", "")
            lengths.append(music.get(path, 0.0))
        if not lengths:
            continue
        total += sum(lengths) - crossfade * (len(lengths) - 1)
    return max(0.0, total)


def list_videos() -> list[dict]:
    VIDEOS.mkdir(parents=True, exist_ok=True)
    items = []
    for path in sorted(VIDEOS.glob("*.json")):
        script = load_script(path)
        scenes = script.get("scenes", [])
        thumb = next((scene.get("image") for scene in scenes if scene.get("image")), "")
        script_mtime = path.stat().st_mtime
        video_out = output_status(output_path(script), script_mtime)
        scene_outs = {
            str(index): output_status(output_path(script, scene=index), script_mtime)
            for index in range(1, len(scenes) + 1)
        }
        items.append(
            {
                "id": path.stem,
                "title": script.get("project") or path.stem,
                "scenes": len(scenes),
                "duration": script_duration(script),
                "thumb": thumb,
                "outputs": {
                    "video": video_out,
                    "scenes": scene_outs,
                },
            }
        )
    return items


def collect_state(script_path: Path, video_id: str) -> dict:
    script = load_script(script_path)
    script_mtime = script_path.stat().st_mtime if script_path.exists() else None
    video_out = output_status(output_path(script), script_mtime)
    scene_outs = {
        str(index): output_status(output_path(script, scene=index), script_mtime)
        for index in range(1, len(script.get("scenes", [])) + 1)
    }
    return {
        "id": video_id,
        "file": script_path.name,
        "script": script,
        "assets": {
            "images": scan(ROOT / "assets" / "images", IMAGE_SUFFIXES)
            + scan(ROOT / "assets" / "maps", IMAGE_SUFFIXES),
            "music": scan(ROOT / "assets" / "music", AUDIO_SUFFIXES),
            "sounds": scan(ROOT / "assets" / "sounds", AUDIO_SUFFIXES),
            "effects": scan(ROOT / "assets" / "effects", VIDEO_SUFFIXES),
            "animations": scan(ROOT / "assets" / "animations", VIDEO_SUFFIXES),
        },
        "outputs": {
            "video": video_out,
            "scenes": scene_outs,
        },
        "render": render.snapshot(),
    }


class Render:
    """Tracks one background render so the editor can show progress."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.status = "idle"
        self.done = 0.0
        self.total = 0.0
        self.message = ""
        self.log: list[str] = []
        self.scene: int | None = None
        self.video_id: str | None = None
        self.path: Path | None = None
        self.process: subprocess.Popen | None = None
        self.stopped = False

    def snapshot(self) -> dict:
        with self.lock:
            path = self.path
            percent = round(100 * self.done / self.total) if self.total else 0
            # Keep the UI under 100% until ffmpeg actually exits — the last
            # stretch is often muxing after out_time has already hit the total.
            if self.status == "running":
                percent = min(max(percent, 0), 99)
            elif self.status == "done":
                percent = 100
            state = {
                "status": self.status,
                "percent": percent,
                "message": self.message,
                "scene": self.scene,
                "video": self.video_id,
                "kind": "scene" if self.scene is not None else "video",
            }
        state["ready"] = bool(path and path.exists())
        state["name"] = path.name if path else ""
        if path and path.exists():
            state["size"] = path.stat().st_size
        return state

    def start(self, script_path: Path, video_id: str, scene: int | None = None) -> bool:
        script = load_script(script_path)
        target = output_path(script, scene=scene)
        with self.lock:
            if self.status == "running":
                return False
            self.status = "running"
            self.done = self.total = 0.0
            self.message = "Starting…"
            self.log = []
            self.scene = scene
            self.video_id = video_id
            self.path = target
            self.process = None
            self.stopped = False
        threading.Thread(
            target=self._run, args=(script_path, scene, target), daemon=True
        ).start()
        return True

    def stop(self) -> bool:
        with self.lock:
            process = self.process
            if self.status != "running" or process is None:
                return False
            self.stopped = True
            self.message = "Stopping…"
            pid = process.pid
        try:
            os.killpg(pid, signal.SIGTERM)
        except OSError:
            try:
                process.terminate()
            except OSError:
                pass
        try:
            process.wait(timeout=2)
        except (subprocess.TimeoutExpired, OSError):
            try:
                os.killpg(pid, signal.SIGKILL)
            except OSError:
                try:
                    process.kill()
                except OSError:
                    pass
        return True

    def _run(self, script_path: Path, scene: int | None, target: Path) -> None:
        command = [python_bin(), str(ROOT / "build.py"), str(script_path), "--progress"]
        if scene is not None:
            command += ["--scene", str(scene)]
        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                cwd=ROOT,
                start_new_session=True,
            )
        except OSError as exc:
            with self.lock:
                self.status, self.message = "error", str(exc)
            return

        with self.lock:
            self.process = process

        for line in process.stdout:
            line = line.strip()
            with self.lock:
                if line.startswith("total "):
                    self.total = float(line.split(maxsplit=1)[1])
                elif line.startswith("progress "):
                    self.done = float(line.split(maxsplit=1)[1])
                    self.message = "Rendering"
                elif line:
                    self.log.append(line)
                    del self.log[:-40]

        code = process.wait()
        with self.lock:
            stopped = self.stopped
            self.process = None
            if stopped or code < 0:
                self.status = "idle"
                self.message = "Stopped"
            elif code == 0 and target.exists():
                self.status, self.done, self.message = "done", self.total, "Finished"
            else:
                self.status = "error"
                self.message = next(
                    (entry for entry in reversed(self.log) if entry.lower().startswith("error")),
                    "The render failed",
                )


render = Render()
_audio_lock = threading.Lock()


def _track_file(entry) -> str:
    return entry if isinstance(entry, str) else entry.get("file", "")


def _scene_has_picture(scene: dict) -> bool:
    if scene.get("image"):
        return True
    images = scene.get("images") or []
    return bool(images)


def _silent_scene_hold(scene: dict, defaults: dict) -> float:
    for key in ("hold", "seconds", "duration"):
        try:
            value = float(scene.get(key))
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
    return 8.0


def _scene_can_preview_audio(scenes: list, index: int) -> bool:
    scene = scenes[index]
    # Transitions are visual overlays — they have no playlist of their own.
    if scene.get("is_transition"):
        return False
    # Songs optional — a picture scene can preview as silence (+ optional beds).
    return bool(scene.get("tracks")) or _scene_has_picture(scene)


def mixed_audio(script_path: Path, scene_index: int | None = None) -> Path | None:
    script = load_script(script_path)
    all_scenes = script.get("scenes", [])
    defaults = script.get("defaults", {})
    if scene_index is not None:
        if scene_index < 0 or scene_index >= len(all_scenes):
            return None
        if not _scene_can_preview_audio(all_scenes, scene_index):
            return None
        scene_list = [all_scenes[scene_index]]
    else:
        scene_list = [scene for scene in all_scenes if not scene.get("is_transition")]
        if not any(_scene_can_preview_audio(all_scenes, i) for i in range(len(all_scenes))):
            return None

    tracks = [
        _track_file(entry)
        for scene in scene_list
        for entry in scene.get("tracks", []) or []
        if _track_file(entry)
    ]

    sounds = []
    preview_scenes = (
        [all_scenes[scene_index]]
        if scene_index is not None
        else all_scenes
    )
    for scene in preview_scenes:
        for entry in scene.get("sounds", []) or []:
            path = entry if isinstance(entry, str) else entry.get("file", "")
            volume = 55 if isinstance(entry, str) else entry.get("volume", 55)
            # Match build.py presence curve so preview cache invalidates with gain changes.
            gain = max(0.0, min(float(volume) / 100.0 * 2.2, 2.5))
            sounds.append(f"{path}@{gain:.4f}")

    silent_holds = [
        f"{i}:{_silent_scene_hold(scene, defaults):.3f}"
        for i, scene in enumerate(scene_list)
        if not (scene.get("tracks") or [])
    ]
    parts = [
        f"scene:{scene_index if scene_index is not None else 'all'}",
        str(defaults.get("track_crossfade", 2)),
        str(defaults.get("open_close_fade", 2)),
        f"sounds:{','.join(sounds)}",
        f"silent:{','.join(silent_holds)}",
        f"transitions:{','.join('1' if s.get('is_transition') else '0' for s in all_scenes)}",
    ]
    for relative in [*tracks, *[item.split("@", 1)[0] for item in sounds]]:
        source = ROOT / relative
        if not source.exists():
            return None
        stat = source.stat()
        parts.append(f"{relative}:{stat.st_mtime_ns}:{stat.st_size}")

    token = hashlib.sha1("|".join(parts).encode()).hexdigest()[:16]
    target = AUDIO_CACHE / f"{token}.mp3"

    with _audio_lock:
        if target.exists():
            return target
        AUDIO_CACHE.mkdir(parents=True, exist_ok=True)
        command = [python_bin(), str(ROOT / "build.py"), str(script_path), "--audio", str(target)]
        if scene_index is not None:
            command += ["--scene", str(scene_index + 1)]
        result = subprocess.run(command, capture_output=True, text=True, cwd=ROOT)
    return target if result.returncode == 0 and target.exists() else None


def safe_path(relative: str) -> Path | None:
    candidate = (ROOT / unquote(relative).lstrip("/")).resolve()
    if candidate.is_file() and ROOT in candidate.parents:
        return candidate
    return None


ASSET_FOLDERS = {
    "images": (ROOT / "assets" / "images", IMAGE_SUFFIXES),
    "music": (ROOT / "assets" / "music", AUDIO_SUFFIXES),
    "sounds": (ROOT / "assets" / "sounds", AUDIO_SUFFIXES),
    "animations": (ROOT / "assets" / "animations", VIDEO_SUFFIXES),
}


def safe_asset_write(kind: str, filename: str) -> Path | None:
    folder_suffixes = ASSET_FOLDERS.get(kind)
    if not folder_suffixes:
        return None
    folder, suffixes = folder_suffixes
    name = Path(unquote(filename)).name
    if not name or name.startswith(".") or Path(name).suffix.lower() not in suffixes:
        return None
    folder.mkdir(parents=True, exist_ok=True)
    target = (folder / name).resolve()
    try:
        target.relative_to(folder.resolve())
    except ValueError:
        return None
    return target


def safe_asset_delete(relative: str) -> Path | None:
    path = safe_path(relative)
    if not path:
        return None
    allowed = [
        (ROOT / "assets" / "images").resolve(),
        (ROOT / "assets" / "music").resolve(),
        (ROOT / "assets" / "sounds").resolve(),
        (ROOT / "assets" / "animations").resolve(),
        (ROOT / "assets" / "effects").resolve(),
    ]
    return path if any(folder in path.parents or path.parent == folder for folder in allowed) else None


def rewrite_asset_path(old: str, new: str) -> int:
    """Point every videos/*.json reference from old → new. Returns files touched."""
    touched = 0
    for path in VIDEOS.glob("*.json"):
        try:
            script = json.loads(path.read_text())
        except json.JSONDecodeError:
            continue
        changed = _replace_paths(script, old, new)
        if changed:
            path.write_text(json.dumps(script, indent=2, ensure_ascii=False) + "\n")
            touched += 1
    return touched


def _replace_paths(node, old: str, new: str) -> bool:
    changed = False
    if isinstance(node, dict):
        for key, value in list(node.items()):
            if isinstance(value, str) and value == old:
                node[key] = new
                changed = True
            elif _replace_paths(value, old, new):
                changed = True
    elif isinstance(node, list):
        for index, value in enumerate(node):
            if isinstance(value, str) and value == old:
                node[index] = new
                changed = True
            elif _replace_paths(value, old, new):
                changed = True
    return changed


def thumbnail(source: Path, width: int) -> Path | None:
    stat = source.stat()
    token = hashlib.sha1(
        f"{source}|{stat.st_mtime_ns}|{stat.st_size}|{width}".encode()
    ).hexdigest()[:16]
    target = CACHE / f"{token}.jpg"
    if target.exists():
        return target
    CACHE.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [
            "ffmpeg", "-y", "-v", "error",
            "-i", str(source),
            "-vf", f"scale={width}:-2:flags=lanczos",
            "-frames:v", "1",
            str(target),
        ],
        capture_output=True,
    )
    return target if proc.returncode == 0 and target.exists() else None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_payload(self, body: bytes, content_type: str, cache: bool = False) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "max-age=86400" if cache else "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path: Path, cache: bool = False) -> None:
        kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_payload(path.read_bytes(), kind, cache=cache)

    def send_media(self, path: Path, download_as: str | None = None) -> None:
        body = path.read_bytes()
        size = len(body)
        kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        start, end = 0, size - 1
        partial = False

        header = self.headers.get("Range", "")
        if header.startswith("bytes="):
            first, _, last = header[6:].split(",")[0].partition("-")
            try:
                if first:
                    start = int(first)
                    end = min(int(last), size - 1) if last else size - 1
                elif last:
                    start = max(0, size - int(last))
                partial = 0 <= start <= end < size
            except ValueError:
                partial = False

        chunk = body[start : end + 1] if partial else body
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", kind)
        self.send_header("Accept-Ranges", "bytes")
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if download_as:
            self.send_header("Content-Disposition", f'attachment; filename="{download_as}"')
        self.send_header("Content-Length", str(len(chunk)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(chunk)

    def query(self) -> dict[str, list[str]]:
        return parse_qs(urlparse(self.path).query)

    def require_video(self) -> tuple[str, Path] | None:
        video_id = (self.query().get("v") or [None])[0]
        path = video_file(video_id or "")
        if not path or not path.exists():
            self.send_json({"error": "unknown video"}, status=404)
            return None
        return video_id, path

    def do_GET(self) -> None:
        url = urlparse(self.path)
        route = url.path

        if route in ("/", "/videos", "/video", "/scene", "/index.html"):
            self.send_file(UI / "index.html")
            return
        if route in ("/app.js", "/styles.css"):
            self.send_file(UI / route.lstrip("/"))
            return
        if route == "/api/videos":
            self.send_json({"videos": list_videos()})
            return
        if route == "/api/state":
            required = self.require_video()
            if not required:
                return
            video_id, path = required
            self.send_json(collect_state(path, video_id))
            return
        if route == "/api/render":
            self.send_json(render.snapshot())
            return
        if route == "/api/audio":
            required = self.require_video()
            if not required:
                return
            _, path = required
            scene_raw = (self.query().get("scene") or [None])[0]
            scene_index = None
            if scene_raw is not None and scene_raw != "":
                try:
                    scene_index = int(scene_raw)
                except ValueError:
                    self.send_error(400, "scene must be an integer")
                    return
            mixed = mixed_audio(path, scene_index=scene_index)
            if not mixed:
                self.send_error(404, "nothing to mix — add a picture (songs optional)")
                return
            self.send_media(mixed)
            return
        if route == "/download":
            required = self.require_video()
            if not required:
                return
            _, path = required
            script = load_script(path)
            scene_raw = (self.query().get("scene") or [None])[0]
            if scene_raw is not None and scene_raw != "":
                try:
                    target = output_path(script, scene=int(scene_raw))
                except ValueError:
                    self.send_error(400, "scene must be an integer")
                    return
            else:
                target = output_path(script)
            if not target.exists():
                self.send_error(404, "nothing rendered yet")
                return
            self.send_media(target, download_as=target.name)
            return
        if route == "/download-asset":
            source = safe_path((self.query().get("path") or [""])[0])
            if not source:
                self.send_error(404)
                return
            allowed = [
                (ROOT / "assets" / "images").resolve(),
                (ROOT / "assets" / "maps").resolve(),
            ]
            if not any(folder in source.parents or source.parent == folder for folder in allowed):
                self.send_error(403, "not an image asset")
                return
            name = Path((self.query().get("name") or [source.name])[0]).name or source.name
            self.send_media(source, download_as=name)
            return
        if route == "/thumb":
            source = safe_path((self.query().get("path") or [""])[0])
            if not source:
                self.send_error(404)
                return
            width = max(64, min(int((self.query().get("w") or ["360"])[0]), 1600))
            thumb = thumbnail(source, width)
            self.send_file(thumb or source, cache=True)
            return
        if route.startswith("/assets/"):
            source = safe_path(route)
            if not source:
                self.send_error(404)
                return
            self.send_file(source, cache=True)
            return

        self.send_error(404)

    def do_POST(self) -> None:
        route = urlparse(self.path).path
        if route == "/api/asset":
            self.upload_asset()
            return
        if route == "/api/asset/rename":
            self.rename_asset()
            return
        if route == "/api/render/stop":
            stopped = render.stop()
            self.send_json(render.snapshot(), status=200 if stopped else 409)
            return
        if route != "/api/render":
            self.send_error(404)
            return

        required = self.require_video()
        if not required:
            return
        video_id, path = required

        length = int(self.headers.get("Content-Length", 0))
        payload = {}
        if length:
            try:
                payload = json.loads(self.rfile.read(length))
            except json.JSONDecodeError as exc:
                self.send_json({"error": f"invalid JSON: {exc}"}, status=400)
                return

        scene = payload.get("scene")
        if scene is not None:
            try:
                scene = int(scene)
            except (TypeError, ValueError):
                self.send_json({"error": "scene must be an integer"}, status=400)
                return
            if scene < 1 or scene > len(load_script(path).get("scenes", [])):
                self.send_json({"error": f"there is no scene {scene}"}, status=400)
                return

        started = render.start(path, video_id=video_id, scene=scene)
        self.send_json(render.snapshot(), status=200 if started else 409)

    def upload_asset(self) -> None:
        query = self.query()
        kind = (query.get("kind") or [""])[0]
        name = (query.get("name") or [""])[0]
        target = safe_asset_write(kind, name)
        if not target:
            self.send_json({"error": "unsupported file"}, status=400)
            return
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0 or length > 200 * 1024 * 1024:
            self.send_json({"error": "missing or oversized file"}, status=400)
            return
        target.write_bytes(self.rfile.read(length))
        # Bust duration cache for replaced audio files.
        _durations.clear()
        relative = target.relative_to(ROOT).as_posix()
        self.send_json({"saved": True, "path": relative, "name": target.stem})

    def rename_asset(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(length)) if length else {}
        except json.JSONDecodeError as exc:
            self.send_json({"error": f"invalid JSON: {exc}"}, status=400)
            return

        relative = str(payload.get("path") or "")
        new_name = str(payload.get("name") or "").strip()
        source = safe_asset_delete(relative)
        if not source:
            self.send_json({"error": "unknown asset"}, status=404)
            return
        # Keep the extension; only the stem is editable from the UI.
        stem = Path(new_name).stem.strip().replace("/", "-").replace("\\", "-")
        if not stem or stem.startswith("."):
            self.send_json({"error": "invalid name"}, status=400)
            return
        target = (source.parent / f"{stem}{source.suffix}").resolve()
        try:
            target.relative_to(source.parent.resolve())
        except ValueError:
            self.send_json({"error": "invalid name"}, status=400)
            return
        if target != source and target.exists():
            self.send_json({"error": "a file with that name already exists"}, status=409)
            return
        if target != source:
            source.rename(target)
        old_rel = relative
        new_rel = target.relative_to(ROOT).as_posix()
        rewrite_asset_path(old_rel, new_rel)
        _durations.clear()
        self.send_json({"renamed": True, "path": new_rel, "name": target.stem, "from": old_rel})

    def do_DELETE(self) -> None:
        if urlparse(self.path).path != "/api/asset":
            self.send_error(404)
            return
        relative = (self.query().get("path") or [""])[0]
        target = safe_asset_delete(relative)
        if not target:
            self.send_json({"error": "unknown asset"}, status=404)
            return
        target.unlink(missing_ok=True)
        _durations.clear()
        self.send_json({"deleted": True, "path": relative})

    def do_PUT(self) -> None:
        if urlparse(self.path).path != "/api/script":
            self.send_error(404)
            return
        required = self.require_video()
        if not required:
            return
        _, path = required

        length = int(self.headers.get("Content-Length", 0))
        try:
            script = json.loads(self.rfile.read(length))
        except json.JSONDecodeError as exc:
            self.send_json({"error": f"invalid JSON: {exc}"}, status=400)
            return

        backup = path.with_suffix(".json.bak")
        if path.exists():
            shutil.copyfile(path, backup)
        path.write_text(json.dumps(script, indent=2, ensure_ascii=False) + "\n")
        self.send_json({"saved": True})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-open", action="store_true", help="don't open a browser")
    args = parser.parse_args()

    if not shutil.which("ffprobe"):
        print("error: ffprobe is not installed (brew install ffmpeg)", file=sys.stderr)
        return 1

    VIDEOS.mkdir(parents=True, exist_ok=True)
    address = f"http://127.0.0.1:{args.port}"

    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as exc:
        if exc.errno == errno.EADDRINUSE:
            print(
                f"error: port {args.port} is already in use — the editor may "
                f"be open at {address} already, or use --port",
                file=sys.stderr,
            )
            return 1
        raise

    with server:
        print(f"Cozy Journeys at {address}")
        print(f"Videos in {VIDEOS}/")
        print("Ctrl-C to stop.")
        if not args.no_open:
            threading.Timer(0.5, webbrowser.open, [address]).start()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
