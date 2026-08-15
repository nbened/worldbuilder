#!/usr/bin/env python3
"""Local editor for Wonderjar worlds (jars).

Jars → videos → scenes. Data lives in jars/*.json and videos/*.json.

    /              landing
    /jars          jar (world) list
    /jar?j=id      videos in a jar
    /video?v=id    arrange scenes
    /scene?v=id&s=0  edit one scene

    ./serve.py
    ./serve.py --port 9000
"""

from __future__ import annotations

import argparse
import base64
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
import time
import urllib.error
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
UI = ROOT / "ui"
VIDEOS = ROOT / "videos"
JARS = ROOT / "jars"
CACHE = ROOT / ".cache" / "thumbs"
AUDIO_CACHE = ROOT / ".cache" / "audio"
LEDGER_DIR = ROOT / ".cache" / "ledger"
VENV_PYTHON = ROOT / ".venv" / "bin" / "python"
_ledger_lock = threading.Lock()

# USD per 1M tokens (input, output) — published / guesstimate list prices
CLAUDE_TOKEN_RATES_USD = {
    "claude-opus-5": (5.0, 25.0),
    "claude-sonnet-4-5": (3.0, 15.0),
    "claude-sonnet-4-20250514": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
}

# Flat USD guesstimates for GPT Image when the API does not return a dollar amount
IMAGE_FLAT_COST_USD = {
    ("gpt-image-1.5", "high", "1024x1024"): 0.04,
    ("gpt-image-1.5", "high", "1536x1024"): 0.08,
    ("gpt-image-1.5", "high", "1024x1536"): 0.08,
    ("gpt-image-1", "high", "1024x1024"): 0.04,
    ("gpt-image-1", "high", "1536x1024"): 0.08,
    ("gpt-image-1", "high", "1024x1536"): 0.08,
    ("gpt-image-2", "high", "1024x1024"): 0.05,
    ("gpt-image-2", "high", "1536x1024"): 0.10,
    ("gpt-image-2", "high", "1024x1536"): 0.10,
    ("gpt-image-2", "high", "3840x2160"): 0.40,
    ("gpt-image-2", "high", "2160x3840"): 0.40,
}

# Flat USD guesstimates for Veo (no dollar amount in API response)
VEO_FLAT_COST_USD = {
    "veo-3.1-generate-preview": 1.2,
    "veo-3.1-fast-generate-preview": 0.6,
    "veo-3.0-generate-001": 1.0,
}


def load_dotenv(path: Path | None = None) -> None:
    """Load KEY=VALUE pairs from .env into os.environ (does not override)."""
    env_path = path or (ROOT / ".env")
    if not env_path.is_file():
        return
    try:
        text = env_path.read_text(encoding="utf-8")
    except OSError:
        return
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


load_dotenv()


def estimate_claude_cost(model: str, usage: dict | None) -> tuple[float, bool]:
    """Return (usd, estimated). Uses token usage when present."""
    usage = usage or {}
    inp = int(usage.get("input_tokens") or 0)
    out = int(usage.get("output_tokens") or 0)
    rates = CLAUDE_TOKEN_RATES_USD.get(model)
    if not rates:
        # Prefer longest matching prefix
        for key, value in CLAUDE_TOKEN_RATES_USD.items():
            if model.startswith(key) or key.startswith(model.split("-20")[0]):
                rates = value
                break
    if not rates:
        rates = (5.0, 25.0)
    if inp or out:
        cost = (inp * rates[0] + out * rates[1]) / 1_000_000
        return cost, True
    # Fallback when usage missing — rough mid call
    return 0.02, True


def openai_image_model() -> str:
    return (os.environ.get("OPENAI_IMAGE_MODEL") or "gpt-image-2").strip() or "gpt-image-2"


def openai_image_quality() -> str:
    quality = (os.environ.get("OPENAI_IMAGE_QUALITY") or "high").strip().lower() or "high"
    return quality if quality in {"low", "medium", "high", "auto"} else "high"


def openai_image_size(requested: str | None = None, *, portrait: bool = False) -> str:
    """Pick a valid size. gpt-image-2 defaults to 4K landscape/portrait."""
    model = openai_image_model()
    classic = {"1024x1024", "1536x1024", "1024x1536"}
    four_k = {"3840x2160", "2160x3840", "2160x2160"}
    size = (requested or os.environ.get("OPENAI_IMAGE_SIZE") or "").strip()
    default_4k = "2160x3840" if portrait else "3840x2160"
    default_hd = "1024x1536" if portrait else "1536x1024"

    if model.startswith("gpt-image-2"):
        if size in classic | four_k:
            return size
        if "x" in size.lower():
            try:
                width_s, height_s = size.lower().split("x", 1)
                width, height = int(width_s), int(height_s)
                if (
                    width > 0
                    and height > 0
                    and width % 16 == 0
                    and height % 16 == 0
                    and max(width, height) <= 3840
                    and min(width, height) >= 16
                ):
                    return f"{width}x{height}"
            except ValueError:
                pass
        return default_4k

    if size in classic:
        return size
    return default_hd


def estimate_image_cost(model: str, size: str = "3840x2160", quality: str = "high") -> tuple[float, bool]:
    key = (model, quality, size)
    if key in IMAGE_FLAT_COST_USD:
        return IMAGE_FLAT_COST_USD[key], True
    for (mod, qual, sz), price in IMAGE_FLAT_COST_USD.items():
        if model.startswith(mod) and qual == quality and sz == size:
            return price, True
    # Default landscape high (4K-ish for image-2)
    if "3840" in size or "2160" in size:
        return 0.40, True
    return 0.08, True


def estimate_veo_cost(model: str, duration_seconds: int = 4) -> tuple[float, bool]:
    base = VEO_FLAT_COST_USD.get(model)
    if not base:
        for key, price in VEO_FLAT_COST_USD.items():
            if model.startswith(key) or key.startswith(model.split("-generate")[0]):
                base = price
                break
    if not base:
        base = 1.2
    # Scale roughly with duration around a 4s baseline
    cost = base * (max(1, int(duration_seconds)) / 4.0)
    return round(cost, 4), True


def append_ledger(
    video_id: str | None,
    *,
    provider: str,
    model: str,
    note: str,
    cost: float,
    estimated: bool = True,
    meta: dict | None = None,
) -> None:
    if not video_id or not VIDEO_ID.match(video_id):
        return
    LEDGER_DIR.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "provider": provider,
        "model": model,
        "note": note,
        "cost": round(float(cost), 6),
        "estimated": bool(estimated),
        "meta": meta or {},
    }
    path = LEDGER_DIR / f"{video_id}.jsonl"
    line = json.dumps(entry, ensure_ascii=False) + "\n"
    with _ledger_lock:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line)


def read_ledger(video_id: str) -> dict:
    path = LEDGER_DIR / f"{video_id}.jsonl"
    entries: list[dict] = []
    if path.is_file():
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    total = sum(float(item.get("cost") or 0) for item in entries)
    return {
        "video": video_id,
        "entries": entries,
        "total": round(total, 4),
        "currency": "USD",
        "estimated": True,
    }


def python_bin() -> str:
    """Prefer the project venv so Pillow (overlay burn-in) is available."""
    return str(VENV_PYTHON) if VENV_PYTHON.exists() else sys.executable
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
AUDIO_SUFFIXES = {".mp3", ".m4a", ".wav", ".flac", ".aac", ".ogg"}
VIDEO_SUFFIXES = {".mp4", ".mov", ".webm", ".mkv"}
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]+$")
JAR_ID = VIDEO_ID

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


def short_output_path(script: dict, scene: int) -> Path:
    """9:16 vertical snip cut from a scene clip."""
    scene_clip = output_path(script, scene=scene)
    return scene_clip.with_name(f"{scene_clip.stem}-short{scene_clip.suffix}")


def probe_video_size(path: Path) -> tuple[int, int] | None:
    proc = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=p=0:s=x",
            str(path),
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return None
    try:
        width_s, height_s = proc.stdout.strip().split("x", 1)
        width, height = int(width_s), int(height_s)
    except ValueError:
        return None
    if width < 2 or height < 2:
        return None
    return width, height


SHORT_BRAND_PNG = UI / "short-brand.png"
SHORT_BRAND_VERSION = 2
SHORT_W, SHORT_H = 1080, 1920


def short_brand_overlay() -> Path:
    """Full-frame transparent PNG: Fraunces wordmark at the bottom of the 9:16 frame."""
    if SHORT_BRAND_PNG.exists():
        return SHORT_BRAND_PNG
    cache = ROOT / ".cache" / f"short-brand-v{SHORT_BRAND_VERSION}.png"
    if cache.exists():
        return cache
    raise RuntimeError("missing ui/short-brand.png")


def make_scene_short(
    source: Path,
    target: Path,
    *,
    cx: float = 0.5,
    start: float = 0.0,
    duration: float | None = None,
) -> Path:
    """Clip the processed scene MP4 to the 9:16 window, then stamp Wonderjar on top."""
    size = probe_video_size(source)
    if not size:
        raise RuntimeError("could not read scene video size")
    width, height = size
    # Tallest 9:16 window that fits in the frame.
    crop_h = height
    crop_w = int(round(crop_h * 9 / 16 / 2) * 2)
    if crop_w > width:
        crop_w = width - (width % 2)
        crop_h = int(round(crop_w * 16 / 9 / 2) * 2)
    cx = min(1.0, max(0.0, float(cx)))
    x = int(round((width - crop_w) * cx))
    y = int(round((height - crop_h) * 0.5))
    x = max(0, min(width - crop_w, x))
    y = max(0, min(height - crop_h, y))
    x -= x % 2
    y -= y % 2

    start = max(0.0, float(start or 0.0))
    dur = None if duration is None else max(0.05, float(duration))
    source_duration = probe_duration(source) or 0.0
    if source_duration > 0 and start >= source_duration:
        raise RuntimeError("start is past the end of the scene clip")
    if dur is not None and source_duration > 0:
        dur = min(dur, max(0.05, source_duration - start))

    target.parent.mkdir(parents=True, exist_ok=True)
    # Rebuild when the source scene clip or cut params change.
    if target.exists():
        try:
            if target.stat().st_mtime_ns >= source.stat().st_mtime_ns:
                meta = target.with_suffix(target.suffix + ".short.json")
                if meta.exists():
                    try:
                        saved = json.loads(meta.read_text())
                        if (
                            saved.get("source_mtime_ns") == source.stat().st_mtime_ns
                            and abs(float(saved.get("cx", 0.5)) - cx) < 1e-6
                            and abs(float(saved.get("start", 0.0)) - start) < 1e-3
                            and (
                                (saved.get("duration") is None and dur is None)
                                or (
                                    saved.get("duration") is not None
                                    and dur is not None
                                    and abs(float(saved["duration"]) - dur) < 1e-3
                                )
                            )
                            and saved.get("crop") == [crop_w, crop_h, x, y]
                            and saved.get("brand") == SHORT_BRAND_VERSION
                        ):
                            return target
                    except (OSError, json.JSONDecodeError, TypeError, ValueError):
                        pass
        except OSError:
            pass

    brand = short_brand_overlay()
    vf = (
        f"[0:v]crop={crop_w}:{crop_h}:{x}:{y},"
        f"scale={SHORT_W}:{SHORT_H}:flags=lanczos,setsar=1[v];"
        f"[v][1:v]overlay=0:0:format=auto:shortest=1,format=yuv420p[outv]"
    )
    command = ["ffmpeg", "-y", "-v", "error"]
    if start > 0.001:
        command += ["-ss", f"{start:.3f}"]
    command += ["-i", str(source), "-loop", "1", "-i", str(brand)]
    if dur is not None:
        command += ["-t", f"{dur:.3f}"]
    command += [
        "-filter_complex",
        vf,
        "-map",
        "[outv]",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        "-movflags",
        "+faststart",
        str(target),
    ]
    proc = subprocess.run(command, capture_output=True, text=True)
    if proc.returncode != 0 or not target.exists():
        detail = (proc.stderr or proc.stdout or "ffmpeg failed").strip()
        raise RuntimeError(detail.splitlines()[-1] if detail else "ffmpeg failed")
    meta = target.with_suffix(target.suffix + ".short.json")
    meta.write_text(
        json.dumps(
            {
                "source": source.name,
                "source_mtime_ns": source.stat().st_mtime_ns,
                "cx": cx,
                "start": start,
                "duration": dur,
                "crop": [crop_w, crop_h, x, y],
                "brand": SHORT_BRAND_VERSION,
            }
        )
    )
    return target


def expected_scene_duration(script: dict, scene_number: int, music: dict[str, float] | None = None) -> float | None:
    """Expected length of a Process Scene render (no map bridges)."""
    scenes = script.get("scenes") or []
    if scene_number < 1 or scene_number > len(scenes):
        return None
    entry = scenes[scene_number - 1]
    if entry.get("is_transition"):
        return None
    defaults = script.get("defaults") or {}
    crossfade = float(defaults.get("track_crossfade", 2))
    if music is None:
        music = {item["path"]: item["duration"] for item in scan(ROOT / "assets" / "music", AUDIO_SUFFIXES)}
    lengths = []
    for track in entry.get("tracks") or []:
        path = _track_file(track)
        if path in music:
            lengths.append(music[path])
    if lengths:
        return max(0.0, sum(lengths) - crossfade * (len(lengths) - 1))
    if _scene_has_picture(entry):
        return _silent_scene_hold(entry, defaults)
    return None


def scene_meta_path(path: Path) -> Path:
    return Path(str(path) + ".meta.json")


def scene_fingerprint(entry: dict) -> str:
    """Hash of the scene object — any edit marks a prior render outdated."""
    payload = json.dumps(entry, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def write_scene_meta(target: Path, entry: dict, scene_number: int) -> None:
    meta = {
        "fingerprint": scene_fingerprint(entry),
        "scene": scene_number,
        "title": entry.get("title") or "",
    }
    scene_meta_path(target).write_text(json.dumps(meta, indent=2) + "\n")


def read_scene_meta(target: Path) -> dict | None:
    path = scene_meta_path(target)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def output_status(
    path: Path,
    script_mtime: float | None = None,
    *,
    expected_duration: float | None = None,
    fingerprint: str | None = None,
) -> dict:
    """Describe a render under out/.

    Scene clips: ready when the file exists, is long enough, and its sidecar
    fingerprint still matches the current scene object (not script mtime).
    Full video: still uses script mtime when no fingerprint is provided.
    """
    if not path.exists():
        return {
            "ready": False,
            "name": path.name,
            "stale": False,
            "exists": False,
            "incomplete": False,
        }
    incomplete = False
    if expected_duration is not None and expected_duration > 2:
        actual = probe_duration(path)
        # Allow ~0.5s mux slack; anything shorter is a truncated render.
        if actual is None or actual + 0.5 < expected_duration:
            incomplete = True
    stale = False
    if fingerprint is not None:
        meta = read_scene_meta(path)
        stale = not meta or meta.get("fingerprint") != fingerprint
    elif script_mtime is not None:
        stale = path.stat().st_mtime < script_mtime
    return {
        "ready": not stale and not incomplete,
        "name": path.name,
        "stale": stale,
        "exists": True,
        "incomplete": incomplete,
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


def jar_file(jar_id: str) -> Path | None:
    if not JAR_ID.fullmatch(jar_id or ""):
        return None
    path = (JARS / f"{jar_id}.json").resolve()
    try:
        path.relative_to(JARS.resolve())
    except ValueError:
        return None
    return path


def load_jar(path: Path) -> dict:
    with path.open() as handle:
        return json.load(handle)


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")


def slug_id(title: str, fallback: str = "untitled") -> str:
    text = re.sub(r"[^A-Za-z0-9]+", "-", (title or "").strip()).strip("-").lower()
    text = re.sub(r"-{2,}", "-", text)[:48].strip("-")
    return text or fallback


def unique_stem(directory: Path, base: str) -> str:
    candidate = base
    n = 2
    while (directory / f"{candidate}.json").exists():
        candidate = f"{base}-{n}"
        n += 1
    return candidate


def create_jar(title: str) -> dict | None:
    title = (title or "").strip()
    if not title:
        return None
    JARS.mkdir(parents=True, exist_ok=True)
    jar_id = unique_stem(JARS, slug_id(title, "jar"))
    path = jar_file(jar_id)
    if not path:
        return None
    jar = {
        "title": title,
        "descriptor": "world",
        "summary": "",
        "rules": "",
        "prompt": "",
        "thumb": "",
        "hero": "",
        "videos": [],
    }
    write_json(path, jar)
    return {"id": jar_id, "jar": jar}


def update_jar(jar_id: str, patch: dict) -> dict | None:
    path = jar_file(jar_id)
    if not path or not path.exists():
        return None
    jar = load_jar(path)
    if "title" in patch:
        title = str(patch.get("title") or "").strip()
        if title:
            jar["title"] = title
    if "summary" in patch:
        jar["summary"] = str(patch.get("summary") or "")
    if "descriptor" in patch:
        descriptor = str(patch.get("descriptor") or "").strip()
        if descriptor:
            jar["descriptor"] = descriptor
    write_json(path, jar)
    return collect_jar(jar_id)


def attach_video_to_jar(jar_id: str, video_id: str) -> None:
    path = jar_file(jar_id)
    if not path or not path.exists():
        return
    jar = load_jar(path)
    videos = [str(v) for v in (jar.get("videos") or []) if v]
    if video_id not in videos:
        videos.append(video_id)
        jar["videos"] = videos
        write_json(path, jar)


def create_video(title: str, jar_id: str | None = None) -> dict | None:
    title = (title or "").strip()
    if not title:
        return None
    VIDEOS.mkdir(parents=True, exist_ok=True)
    video_id = unique_stem(VIDEOS, slug_id(title, "video"))
    path = video_file(video_id)
    if not path:
        return None
    script = {
        "project": title,
        "jar": jar_id or "",
        "output": {
            "file": f"out/{video_id}.mp4",
            "width": 1620,
            "height": 1080,
            "fps": 30,
        },
        "defaults": {
            "fade_seconds": 3,
            "track_crossfade": 2,
            "open_close_fade": 2,
            "map_seconds": 30,
        },
        "scenes": [
            {
                "title": "Scene 1",
                "image": "",
                "map": {"seconds": 30},
                "pan": "none",
                "zoom": 1,
                "tracks": [],
                "sounds": [],
                "effects": [],
                "animations": [],
                "is_transition": False,
                "transition_in": "fade",
                "transition_out": "fade",
                "fade_zoom": None,
                "image_prompt": "",
                "generated_prompt": "",
                "music_prompt": "",
            }
        ],
    }
    write_json(path, script)
    if jar_id:
        attach_video_to_jar(jar_id, video_id)
    return {"id": video_id, "script": script}


def delete_video(video_id: str) -> bool:
    path = video_file(video_id)
    if not path or not path.exists():
        return False
    JARS.mkdir(parents=True, exist_ok=True)
    for jar_path in JARS.glob("*.json"):
        jar = load_jar(jar_path)
        videos = [str(v) for v in (jar.get("videos") or []) if v]
        if video_id not in videos:
            continue
        jar["videos"] = [vid for vid in videos if vid != video_id]
        write_json(jar_path, jar)
    path.with_suffix(".json.bak").unlink(missing_ok=True)
    path.unlink()
    return True


def video_catalog_entry(path: Path) -> dict:
    script = load_script(path)
    scenes = script.get("scenes", [])
    thumb = next((scene.get("image") for scene in scenes if scene.get("image")), "")
    script_mtime = path.stat().st_mtime
    music = {item["path"]: item["duration"] for item in scan(ROOT / "assets" / "music", AUDIO_SUFFIXES)}
    video_out = output_status(output_path(script), script_mtime)
    scene_outs = {}
    for index, entry in enumerate(scenes, start=1):
        fingerprint = None if entry.get("is_transition") else scene_fingerprint(entry)
        scene_outs[str(index)] = output_status(
            output_path(script, scene=index),
            expected_duration=expected_scene_duration(script, index, music),
            fingerprint=fingerprint,
        )
    return {
        "id": path.stem,
        "title": script.get("project") or path.stem,
        "jar": script.get("jar") or "",
        "scenes": len(scenes),
        "duration": script_duration(script),
        "thumb": thumb,
        "outputs": {
            "video": video_out,
            "scenes": scene_outs,
        },
    }


def list_videos(jar_id: str | None = None) -> list[dict]:
    """All videos, or videos belonging to a jar (jar.videos order, then jar field)."""
    VIDEOS.mkdir(parents=True, exist_ok=True)
    if not jar_id:
        return [video_catalog_entry(path) for path in sorted(VIDEOS.glob("*.json"))]

    jar_path = jar_file(jar_id)
    if not jar_path or not jar_path.exists():
        return []
    jar = load_jar(jar_path)
    wanted = [str(v) for v in (jar.get("videos") or []) if v]
    ordered: list[dict] = []
    seen: set[str] = set()
    for vid in wanted:
        path = video_file(vid)
        if path and path.exists():
            ordered.append(video_catalog_entry(path))
            seen.add(vid)
    for path in sorted(VIDEOS.glob("*.json")):
        if path.stem in seen:
            continue
        entry = video_catalog_entry(path)
        if entry.get("jar") == jar_id:
            ordered.append(entry)
    return ordered


def list_jars() -> list[dict]:
    JARS.mkdir(parents=True, exist_ok=True)
    items = []
    for path in sorted(JARS.glob("*.json")):
        jar = load_jar(path)
        video_ids = [str(v) for v in (jar.get("videos") or []) if v]
        items.append(
            {
                "id": path.stem,
                "title": jar.get("title") or path.stem,
                "descriptor": jar.get("descriptor") or "world",
                "summary": jar.get("summary") or "",
                "thumb": jar.get("thumb") or "",
                "hero": jar.get("hero") or "",
                "videos": len(video_ids),
            }
        )
    return items


def collect_jar(jar_id: str) -> dict | None:
    path = jar_file(jar_id)
    if not path or not path.exists():
        return None
    jar = load_jar(path)
    videos = list_videos(jar_id)
    return {
        "id": jar_id,
        "file": path.name,
        "jar": jar,
        "videos": videos,
    }


def collect_state(script_path: Path, video_id: str) -> dict:
    script = load_script(script_path)
    script_mtime = script_path.stat().st_mtime if script_path.exists() else None
    music = {item["path"]: item["duration"] for item in scan(ROOT / "assets" / "music", AUDIO_SUFFIXES)}
    video_out = output_status(output_path(script), script_mtime)
    scenes = script.get("scenes") or []
    scene_outs = {}
    for index, entry in enumerate(scenes, start=1):
        fingerprint = None if entry.get("is_transition") else scene_fingerprint(entry)
        scene_outs[str(index)] = output_status(
            output_path(script, scene=index),
            expected_duration=expected_scene_duration(script, index, music),
            fingerprint=fingerprint,
        )
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
        else:
            # Full video stitches pre-rendered scene clips + map transitions.
            command += ["--assemble"]
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
                if scene is not None:
                    try:
                        script = load_script(script_path)
                        entry = (script.get("scenes") or [])[scene - 1]
                        write_scene_meta(target, entry, scene)
                    except (IndexError, TypeError, OSError) as exc:
                        self.log.append(f"error: could not write scene meta: {exc}")
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
    """Resolve a project-relative file path.

    Allows Railway volume symlinks (e.g. /app/assets → /data/assets) while
    still blocking path escape via `..`.
    """
    rel = Path(unquote(relative).lstrip("/"))
    if rel.is_absolute() or ".." in rel.parts:
        return None
    candidate = (ROOT / rel).resolve()
    return candidate if candidate.is_file() else None


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


def unique_asset_filename(kind: str, stem: str, ext: str) -> str:
    base = re.sub(r"[^A-Za-z0-9_-]+", "-", (stem or "").strip()).strip("-")[:48] or kind.rstrip("s")
    suffix = ext if ext.startswith(".") else f".{ext}"
    folder_info = ASSET_FOLDERS.get(kind)
    folder = folder_info[0] if folder_info else (ROOT / "assets" / kind)
    folder.mkdir(parents=True, exist_ok=True)
    name = f"{base}{suffix}"
    if not (folder / name).exists():
        return name
    n = 2
    while (folder / f"{base}-{n}{suffix}").exists():
        n += 1
    return f"{base}-{n}{suffix}"


def unique_image_filename(stem: str, ext: str = "png") -> str:
    return unique_asset_filename("images", stem, ext)


def _openai_image_error(exc: urllib.error.HTTPError) -> str:
    detail = exc.read().decode("utf-8", errors="replace")
    try:
        err = json.loads(detail).get("error") or {}
        return err.get("message") or detail or f"OpenAI HTTP {exc.code}"
    except json.JSONDecodeError:
        return detail or f"OpenAI HTTP {exc.code}"


def _openai_image_result(payload: dict) -> tuple[bytes, str]:
    item = (payload.get("data") or [{}])[0]
    b64 = item.get("b64_json")
    if b64:
        return base64.b64decode(b64), "png"
    url = item.get("url")
    if not url:
        raise RuntimeError("OpenAI returned no image data")
    with urllib.request.urlopen(url, timeout=120) as img:
        raw = img.read()
        ctype = (img.headers.get_content_type() or "image/png").lower()
        ext = "jpg" if "jpeg" in ctype else "png"
        return raw, ext


def openai_generate_image(
    prompt: str, size: str = "3840x2160"
) -> tuple[bytes, str, str, dict]:
    """Call OpenAI Images API. Returns (bytes, ext, model, meta)."""
    key = (os.environ.get("OPENAI_API_KEY") or "").strip()
    if not key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    model = openai_image_model()
    quality = openai_image_quality()
    size = openai_image_size(size)
    body = {
        "model": model,
        "prompt": prompt,
        "size": size,
        "quality": quality,
        "n": 1,
    }
    req = urllib.request.Request(
        "https://api.openai.com/v1/images/generations",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(_openai_image_error(exc)) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"OpenAI request failed: {exc.reason}") from exc
    raw, ext = _openai_image_result(payload)
    meta = {"size": size, "quality": quality, "usage": payload.get("usage") or {}}
    return raw, ext, model, meta


def openai_edit_image(
    prompt: str,
    image_bytes: bytes,
    media_type: str = "image/png",
    size: str = "3840x2160",
) -> tuple[bytes, str, str, dict]:
    """Edit an image with GPT Image. Returns (bytes, ext, model, meta)."""
    key = (os.environ.get("OPENAI_API_KEY") or "").strip()
    if not key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    model = openai_image_model()
    quality = openai_image_quality()
    size = openai_image_size(size)
    if media_type not in {"image/png", "image/jpeg", "image/webp"}:
        media_type = "image/png"
    ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}.get(media_type, "png")
    boundary = f"----WonderjarBoundary{os.urandom(8).hex()}"
    chunks: list[bytes] = []

    def add_field(name: str, value: str) -> None:
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        chunks.append(value.encode("utf-8"))
        chunks.append(b"\r\n")

    add_field("model", model)
    add_field("prompt", prompt)
    add_field("size", size)
    add_field("quality", quality)
    # gpt-image-2 rejects input_fidelity; gpt-image-1 / 1.5 accept it.
    if model.startswith("gpt-image") and not model.startswith("gpt-image-2"):
        add_field("input_fidelity", "high")
    chunks.append(f"--{boundary}\r\n".encode())
    chunks.append(
        (
            f'Content-Disposition: form-data; name="image"; filename="crop.{ext}"\r\n'
            f"Content-Type: {media_type}\r\n\r\n"
        ).encode()
    )
    chunks.append(image_bytes)
    chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    body = b"".join(chunks)
    req = urllib.request.Request(
        "https://api.openai.com/v1/images/edits",
        data=body,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(_openai_image_error(exc)) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"OpenAI request failed: {exc.reason}") from exc
    raw, out_ext = _openai_image_result(payload)
    meta = {"size": size, "quality": quality, "usage": payload.get("usage") or {}}
    return raw, out_ext, model, meta


def claude_vision_prompt(
    image_b64: str,
    media_type: str,
    jar_to_claude: str,
    change: str,
    *,
    system: str,
    fallback_instruction: str,
) -> tuple[str, str, dict]:
    """Ask Claude for a downstream media prompt. Returns (prompt, model, usage)."""
    key = (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    model = (os.environ.get("ANTHROPIC_MODEL") or "claude-opus-5").strip() or "claude-opus-5"
    if media_type not in {"image/png", "image/jpeg", "image/webp", "image/gif"}:
        media_type = "image/png"
    instruction = jar_to_claude.strip() or fallback_instruction
    user_text = f"{instruction}\n\n{change.strip()}"
    body = {
        "model": model,
        "max_tokens": 1200,
        "system": system,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": image_b64,
                        },
                    },
                    {"type": "text", "text": user_text},
                ],
            }
        ],
    }
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        message = detail
        try:
            err = json.loads(detail).get("error") or {}
            message = err.get("message") or detail
        except json.JSONDecodeError:
            pass
        raise RuntimeError(message or f"Anthropic HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Anthropic request failed: {exc.reason}") from exc

    parts = []
    for block in payload.get("content") or []:
        if isinstance(block, dict) and block.get("type") == "text":
            text = str(block.get("text") or "").strip()
            if text:
                parts.append(text)
    prompt = "\n\n".join(parts).strip()
    if not prompt:
        raise RuntimeError("Claude returned an empty prompt")
    usage = payload.get("usage") or {}
    return prompt, model, usage


def claude_text_prompt(user_text: str, *, system: str) -> tuple[str, str, dict]:
    """Ask Claude for a text-only prompt. Returns (prompt, model, usage)."""
    key = (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    model = (os.environ.get("ANTHROPIC_MODEL") or "claude-opus-5").strip() or "claude-opus-5"
    body = {
        "model": model,
        "max_tokens": 1600,
        "system": system,
        "messages": [
            {
                "role": "user",
                "content": [{"type": "text", "text": user_text.strip()}],
            }
        ],
    }
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        message = detail
        try:
            err = json.loads(detail).get("error") or {}
            message = err.get("message") or detail
        except json.JSONDecodeError:
            pass
        raise RuntimeError(message or f"Anthropic HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Anthropic request failed: {exc.reason}") from exc

    parts = []
    for block in payload.get("content") or []:
        if isinstance(block, dict) and block.get("type") == "text":
            text = str(block.get("text") or "").strip()
            if text:
                parts.append(text)
    prompt = "\n\n".join(parts).strip()
    if not prompt:
        raise RuntimeError("Claude returned an empty prompt")
    usage = payload.get("usage") or {}
    return prompt, model, usage


def claude_scene_image_prompt(
    feeling: str,
    image_mind: str,
    scene_contain: str,
    title: str = "",
) -> tuple[str, str, dict]:
    chunks = []
    if feeling.strip():
        chunks.append(f"Desired feeling:\n{feeling.strip()}")
    if image_mind.strip():
        chunks.append(f"Images in mind:\n{image_mind.strip()}")
    if title.strip():
        chunks.append(f"Scene title:\n{title.strip()}")
    chunks.append(f"What this scene contains:\n{scene_contain.strip()}")
    return claude_text_prompt(
        "\n\n".join(chunks),
        system=(
            "You write prompts for ChatGPT image generation of a single still frame "
            "for a long-form ambient video. Use desired feeling and images in mind as "
            "the emotional and visual world. Use what this scene contains as the "
            "specific subject of THIS still. Write a detailed, concrete image prompt: "
            "setting, subjects, materials, light, and composition. Do NOT include "
            "technical house style (miniature look, tilt-shift, camera grade) — that "
            "is appended separately. Output ONLY the prompt — no preamble, no quotes, "
            "no markdown."
        ),
    )


def claude_still_edit_prompt(
    image_b64: str,
    media_type: str,
    jar_to_claude: str,
    change: str,
) -> tuple[str, str, dict]:
    return claude_vision_prompt(
        image_b64,
        media_type,
        jar_to_claude,
        change,
        system=(
            "You write prompts for ChatGPT image editing. "
            "Output ONLY the ChatGPT image prompt — no preamble, no quotes, no markdown."
        ),
        fallback_instruction=(
            "Give me a ChatGPT prompt that keeps all else exactly the same in this picture, "
            "except for these changes"
        ),
    )


def claude_veo_prompt(
    image_b64: str,
    media_type: str,
    jar_to_claude: str,
    change: str,
) -> tuple[str, str, dict]:
    return claude_vision_prompt(
        image_b64,
        media_type,
        jar_to_claude,
        change,
        system=(
            "You write prompts for Google Veo image-to-video animation. "
            "Output ONLY the Veo prompt — no preamble, no quotes, no markdown."
        ),
        fallback_instruction=(
            "Give me a Veo prompt that keeps a locked-off camera and freezes everything "
            "except the one motion described"
        ),
    )


def veo_generate_video(
    prompt: str,
    image_bytes: bytes,
    media_type: str = "image/png",
    aspect_ratio: str = "16:9",
    duration_seconds: int = 4,
) -> tuple[bytes, str, str, dict]:
    """Generate a short video with Veo from a still crop. Returns (bytes, ext, model, meta)."""
    key = (os.environ.get("GEMINI_API_KEY") or "").strip()
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    model = (
        os.environ.get("VEO_MODEL") or "veo-3.1-generate-preview"
    ).strip() or "veo-3.1-generate-preview"
    if media_type not in {"image/png", "image/jpeg", "image/webp"}:
        media_type = "image/png"
    if aspect_ratio not in {"16:9", "9:16"}:
        aspect_ratio = "16:9"
    duration_seconds = 4 if duration_seconds not in {4, 6, 8} else int(duration_seconds)
    image_b64 = base64.b64encode(image_bytes).decode("ascii")
    # Veo predictLongRunning expects Vertex-style image fields, not Gemini inlineData.
    body = {
        "instances": [
            {
                "prompt": prompt,
                "image": {
                    "bytesBase64Encoded": image_b64,
                    "mimeType": media_type,
                },
            }
        ],
        "parameters": {
            "aspectRatio": aspect_ratio,
            "durationSeconds": duration_seconds,
            "sampleCount": 1,
        },
    }
    start_url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:predictLongRunning"
    )
    req = urllib.request.Request(
        start_url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "x-goog-api-key": key,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            started = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        message = detail
        try:
            err = json.loads(detail).get("error") or {}
            message = err.get("message") or detail
        except json.JSONDecodeError:
            pass
        raise RuntimeError(message or f"Veo HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Veo request failed: {exc.reason}") from exc

    op_name = str(started.get("name") or "").strip()
    if not op_name:
        raise RuntimeError("Veo did not return an operation name")

    deadline = time.time() + 600
    payload: dict = {}
    while time.time() < deadline:
        poll_url = f"https://generativelanguage.googleapis.com/v1beta/{op_name}"
        poll_req = urllib.request.Request(
            poll_url,
            headers={"x-goog-api-key": key},
            method="GET",
        )
        try:
            with urllib.request.urlopen(poll_req, timeout=60) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(detail or f"Veo poll HTTP {exc.code}") from exc
        if payload.get("done"):
            break
        time.sleep(8)
    else:
        raise RuntimeError("Veo timed out waiting for the video")

    if payload.get("error"):
        err = payload.get("error") or {}
        raise RuntimeError(err.get("message") or str(err))

    response = payload.get("response") or {}
    samples = (
        (response.get("generateVideoResponse") or {}).get("generatedSamples")
        or response.get("generatedSamples")
        or []
    )
    if not samples:
        raise RuntimeError("Veo returned no video samples")
    video_info = (samples[0] or {}).get("video") or {}
    video_uri = str(video_info.get("uri") or "").strip()
    inline = video_info.get("inlineData") or video_info.get("bytesBase64Encoded")
    if video_uri:
        dl_req = urllib.request.Request(
            video_uri,
            headers={"x-goog-api-key": key},
            method="GET",
        )
        try:
            with urllib.request.urlopen(dl_req, timeout=180) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(detail or f"Veo download HTTP {exc.code}") from exc
    elif isinstance(inline, dict) and inline.get("data"):
        raw = base64.b64decode(inline["data"], validate=False)
    elif isinstance(inline, str) and inline:
        raw = base64.b64decode(inline, validate=False)
    else:
        raise RuntimeError("Veo response missing video uri")
    if not raw:
        raise RuntimeError("Veo returned an empty video")
    meta = {
        "aspect_ratio": aspect_ratio,
        "duration_seconds": duration_seconds,
        "operation": op_name,
    }
    return raw, "mp4", model, meta


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

    def require_jar(self) -> tuple[str, Path] | None:
        jar_id = (self.query().get("j") or [None])[0]
        path = jar_file(jar_id or "")
        if not path or not path.exists():
            self.send_json({"error": "unknown jar"}, status=404)
            return None
        return jar_id, path

    def do_GET(self) -> None:
        url = urlparse(self.path)
        route = url.path

        if route in ("/", "/jars", "/jar", "/videos", "/video", "/scene", "/index.html"):
            self.send_file(UI / "index.html")
            return
        if route in ("/app.js", "/styles.css", "/site.json"):
            self.send_file(UI / route.lstrip("/"))
            return
        if route == "/api/jars":
            self.send_json({"jars": list_jars()})
            return
        if route == "/api/jar":
            jar_id = (self.query().get("j") or [None])[0]
            payload = collect_jar(jar_id or "")
            if not payload:
                self.send_json({"error": "unknown jar"}, status=404)
                return
            self.send_json(payload)
            return
        if route == "/api/videos":
            jar_id = (self.query().get("j") or [None])[0]
            self.send_json({"videos": list_videos(jar_id)})
            return
        if route == "/api/config":
            self.send_json(
                {
                    "anthropic_model": (
                        os.environ.get("ANTHROPIC_MODEL") or "claude-opus-5"
                    ).strip()
                    or "claude-opus-5",
                    "openai_image_model": openai_image_model(),
                    "openai_image_size": openai_image_size(),
                    "openai_image_quality": openai_image_quality(),
                    "veo_model": (
                        os.environ.get("VEO_MODEL") or "veo-3.1-fast-generate-preview"
                    ).strip()
                    or "veo-3.1-fast-generate-preview",
                }
            )
            return
        if route == "/api/ledger":
            video_id = (self.query().get("v") or [""])[0]
            if not video_id or not VIDEO_ID.match(video_id):
                self.send_json({"error": "video required"}, status=400)
                return
            self.send_json(read_ledger(video_id))
            return
        if route == "/api/state":
            required = self.require_video()
            if not required:
                return
            video_id, path = required
            payload = collect_state(path, video_id)
            jar_id = (self.query().get("j") or [None])[0] or (payload.get("script") or {}).get("jar")
            if jar_id:
                payload["jarId"] = jar_id
                jar_payload = collect_jar(jar_id)
                if jar_payload:
                    payload["jar"] = jar_payload.get("jar")
                    payload["jarMeta"] = {
                        "id": jar_payload["id"],
                        "title": jar_payload["jar"].get("title") or jar_payload["id"],
                        "descriptor": jar_payload["jar"].get("descriptor") or "world",
                    }
            self.send_json(payload)
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
        if route == "/download-short":
            # One-click 9:16 snip of a processed scene clip.
            required = self.require_video()
            if not required:
                return
            _, path = required
            script = load_script(path)
            scene_raw = (self.query().get("scene") or [None])[0]
            if scene_raw is None or scene_raw == "":
                self.send_error(400, "scene is required")
                return
            try:
                scene = int(scene_raw)
            except ValueError:
                self.send_error(400, "scene must be an integer")
                return
            if scene < 1 or scene > len(script.get("scenes") or []):
                self.send_error(404, f"there is no scene {scene}")
                return
            source = output_path(script, scene=scene)
            if not source.exists():
                self.send_error(404, "process the scene first")
                return
            try:
                cx = float((self.query().get("cx") or ["0.5"])[0] or 0.5)
                start = float((self.query().get("start") or ["0"])[0] or 0)
            except ValueError:
                self.send_error(400, "cx and start must be numbers")
                return
            duration = None
            duration_raw = (self.query().get("duration") or [None])[0]
            if duration_raw not in (None, ""):
                try:
                    duration = float(duration_raw)
                except ValueError:
                    self.send_error(400, "duration must be a number")
                    return
            target = short_output_path(script, scene)
            try:
                make_scene_short(source, target, cx=cx, start=start, duration=duration)
            except RuntimeError as exc:
                self.send_error(500, str(exc))
                return
            self.send_media(
                target,
                download_as=f"{target.stem}-wonderjar{target.suffix}",
            )
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
        if route == "/api/generate-image":
            self.generate_image()
            return
        if route == "/api/scene-prompt":
            self.scene_prompt()
            return
        if route == "/api/edit-still":
            self.edit_still()
            return
        if route == "/api/generate-anim":
            self.generate_anim()
            return
        if route == "/api/render/stop":
            stopped = render.stop()
            self.send_json(render.snapshot(), status=200 if stopped else 409)
            return
        if route == "/api/jar":
            length = int(self.headers.get("Content-Length", 0))
            try:
                payload = json.loads(self.rfile.read(length)) if length else {}
            except json.JSONDecodeError as exc:
                self.send_json({"error": f"invalid JSON: {exc}"}, status=400)
                return
            created = create_jar(str(payload.get("title") or ""))
            if not created:
                self.send_json({"error": "name this jar"}, status=400)
                return
            self.send_json(created)
            return
        if route == "/api/video":
            length = int(self.headers.get("Content-Length", 0))
            try:
                payload = json.loads(self.rfile.read(length)) if length else {}
            except json.JSONDecodeError as exc:
                self.send_json({"error": f"invalid JSON: {exc}"}, status=400)
                return
            jar_id = str(payload.get("jar") or "").strip()
            if jar_id and not jar_file(jar_id):
                self.send_json({"error": "unknown jar"}, status=400)
                return
            if jar_id:
                path = jar_file(jar_id)
                if not path or not path.exists():
                    self.send_json({"error": "unknown jar"}, status=404)
                    return
            created = create_video(str(payload.get("title") or ""), jar_id or None)
            if not created:
                self.send_json({"error": "name this video"}, status=400)
                return
            self.send_json(created)
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

    def scene_prompt(self) -> None:
        """Claude writes a ChatGPT still prompt from video details + scene contents."""
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0 or length > 200_000:
            self.send_json({"error": "missing or oversized JSON body"}, status=400)
            return
        try:
            payload = json.loads(self.rfile.read(length))
        except json.JSONDecodeError as exc:
            self.send_json({"error": f"invalid JSON: {exc}"}, status=400)
            return

        scene_contain = str(payload.get("scene_contain") or "").strip()
        if not scene_contain:
            self.send_json({"error": "what this scene contains is required"}, status=400)
            return
        feeling = str(payload.get("feeling") or "")
        image_mind = str(payload.get("image_mind") or "")
        title = str(payload.get("title") or "")
        video_id = str(payload.get("video") or "").strip() or None
        try:
            prompt, model, usage = claude_scene_image_prompt(
                feeling, image_mind, scene_contain, title
            )
        except RuntimeError as exc:
            self.send_json({"error": str(exc)}, status=502)
            return
        cost, estimated = estimate_claude_cost(model, usage)
        append_ledger(
            video_id,
            provider="anthropic",
            model=model,
            note="Writing a scene prompt",
            cost=cost,
            estimated=estimated,
            meta={"usage": usage},
        )
        self.send_json(
            {
                "ok": True,
                "prompt": prompt,
                "model": model,
                "cost": cost,
                "estimated": estimated,
            }
        )

    def generate_image(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0 or length > 200_000:
            self.send_json({"error": "missing or oversized JSON body"}, status=400)
            return
        try:
            payload = json.loads(self.rfile.read(length))
        except json.JSONDecodeError as exc:
            self.send_json({"error": f"invalid JSON: {exc}"}, status=400)
            return

        prompt = str(payload.get("prompt") or "").strip()
        if not prompt:
            self.send_json({"error": "prompt is required"}, status=400)
            return
        if len(prompt) > 12000:
            self.send_json({"error": "prompt is too long"}, status=400)
            return

        stem = str(payload.get("name") or "").strip() or f"scene-{int(time.time())}"
        size = str(payload.get("size") or openai_image_size())
        video_id = str(payload.get("video") or "").strip() or None
        try:
            raw, ext, model, meta = openai_generate_image(prompt, size=size)
        except RuntimeError as exc:
            self.send_json({"error": str(exc)}, status=502)
            return

        cost, estimated = estimate_image_cost(
            model, size=str(meta.get("size") or size), quality=str(meta.get("quality") or "high")
        )
        append_ledger(
            video_id,
            provider="openai",
            model=model,
            note="Generating an image",
            cost=cost,
            estimated=estimated,
            meta={"size": meta.get("size") or size, "usage": meta.get("usage") or {}},
        )

        target = safe_asset_write("images", unique_image_filename(stem, ext))
        if not target:
            self.send_json({"error": "could not create image file"}, status=400)
            return

        target.write_bytes(raw)
        relative = target.relative_to(ROOT).as_posix()
        self.send_json(
            {
                "saved": True,
                "path": relative,
                "name": target.stem,
                "model": model,
                "cost": cost,
                "estimated": estimated,
            }
        )

    def edit_still(self) -> None:
        """Claude writes an edit prompt from a crop; optionally OpenAI generates the still."""
        length = int(self.headers.get("Content-Length", 0))
        # Base64 crops can be a few MB.
        if length <= 0 or length > 20 * 1024 * 1024:
            self.send_json({"error": "missing or oversized JSON body"}, status=400)
            return
        try:
            payload = json.loads(self.rfile.read(length))
        except json.JSONDecodeError as exc:
            self.send_json({"error": f"invalid JSON: {exc}"}, status=400)
            return

        step = str(payload.get("step") or "prompt").strip()
        if step not in {"prompt", "image"}:
            self.send_json({"error": "step must be prompt or image"}, status=400)
            return

        if step == "prompt":
            change = str(payload.get("change") or "").strip()
            if not change:
                self.send_json({"error": "change is required"}, status=400)
                return
            image_b64 = str(payload.get("image_b64") or "").strip()
            if not image_b64:
                self.send_json({"error": "image_b64 is required"}, status=400)
                return
            # Allow data-URL prefix.
            if "," in image_b64 and image_b64.lower().startswith("data:"):
                image_b64 = image_b64.split(",", 1)[1]
            media_type = str(payload.get("media_type") or "image/png").strip() or "image/png"
            jar_to_claude = str(payload.get("jar_to_claude") or "")
            video_id = str(payload.get("video") or "").strip() or None
            try:
                edit_prompt, model, usage = claude_still_edit_prompt(
                    image_b64, media_type, jar_to_claude, change
                )
            except RuntimeError as exc:
                self.send_json({"error": str(exc)}, status=502)
                return
            cost, estimated = estimate_claude_cost(model, usage)
            append_ledger(
                video_id,
                provider="anthropic",
                model=model,
                note="Editing a still",
                cost=cost,
                estimated=estimated,
                meta={"usage": usage, "step": "prompt"},
            )
            self.send_json(
                {
                    "ok": True,
                    "step": "prompt",
                    "edit_prompt": edit_prompt,
                    "model": model,
                    "cost": cost,
                    "estimated": estimated,
                }
            )
            return

        edit_prompt = str(payload.get("edit_prompt") or "").strip()
        if not edit_prompt:
            self.send_json({"error": "edit_prompt is required"}, status=400)
            return
        image_b64 = str(payload.get("image_b64") or "").strip()
        if not image_b64:
            self.send_json({"error": "image_b64 is required for ChatGPT edit"}, status=400)
            return
        if "," in image_b64 and image_b64.lower().startswith("data:"):
            image_b64 = image_b64.split(",", 1)[1]
        media_type = str(payload.get("media_type") or "image/png").strip() or "image/png"
        video_id = str(payload.get("video") or "").strip() or None
        try:
            image_bytes = base64.b64decode(image_b64, validate=False)
        except Exception:
            self.send_json({"error": "invalid image_b64"}, status=400)
            return
        if not image_bytes:
            self.send_json({"error": "empty image"}, status=400)
            return

        stem = str(payload.get("name") or "").strip() or f"edit-{int(time.time())}"
        size = str(payload.get("size") or openai_image_size())
        try:
            raw, ext, model, meta = openai_edit_image(
                edit_prompt, image_bytes, media_type=media_type, size=size
            )
        except RuntimeError as exc:
            self.send_json({"error": str(exc)}, status=502)
            return
        cost, estimated = estimate_image_cost(
            model, size=str(meta.get("size") or size), quality=str(meta.get("quality") or "high")
        )
        append_ledger(
            video_id,
            provider="openai",
            model=model,
            note="Editing a still",
            cost=cost,
            estimated=estimated,
            meta={"size": meta.get("size") or size, "usage": meta.get("usage") or {}, "step": "image"},
        )
        target = safe_asset_write("images", unique_image_filename(stem, ext))
        if not target:
            self.send_json({"error": "could not create image file"}, status=400)
            return
        target.write_bytes(raw)
        relative = target.relative_to(ROOT).as_posix()
        self.send_json(
            {
                "ok": True,
                "step": "image",
                "path": relative,
                "name": target.stem,
                "model": model,
                "cost": cost,
                "estimated": estimated,
            }
        )

    def generate_anim(self) -> None:
        """Claude writes a Veo prompt from a crop; optionally Veo generates the clip."""
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0 or length > 20 * 1024 * 1024:
            self.send_json({"error": "missing or oversized JSON body"}, status=400)
            return
        try:
            payload = json.loads(self.rfile.read(length))
        except json.JSONDecodeError as exc:
            self.send_json({"error": f"invalid JSON: {exc}"}, status=400)
            return

        step = str(payload.get("step") or "prompt").strip()
        if step not in {"prompt", "video"}:
            self.send_json({"error": "step must be prompt or video"}, status=400)
            return

        if step == "prompt":
            change = str(payload.get("change") or "").strip()
            if not change:
                self.send_json({"error": "change is required"}, status=400)
                return
            image_b64 = str(payload.get("image_b64") or "").strip()
            if not image_b64:
                self.send_json({"error": "image_b64 is required"}, status=400)
                return
            if "," in image_b64 and image_b64.lower().startswith("data:"):
                image_b64 = image_b64.split(",", 1)[1]
            media_type = str(payload.get("media_type") or "image/png").strip() or "image/png"
            jar_to_claude = str(payload.get("jar_to_claude") or "")
            video_id = str(payload.get("video") or "").strip() or None
            try:
                veo_prompt, model, usage = claude_veo_prompt(
                    image_b64, media_type, jar_to_claude, change
                )
            except RuntimeError as exc:
                self.send_json({"error": str(exc)}, status=502)
                return
            cost, estimated = estimate_claude_cost(model, usage)
            append_ledger(
                video_id,
                provider="anthropic",
                model=model,
                note="Animating a region",
                cost=cost,
                estimated=estimated,
                meta={"usage": usage, "step": "prompt"},
            )
            self.send_json(
                {
                    "ok": True,
                    "step": "prompt",
                    "veo_prompt": veo_prompt,
                    "model": model,
                    "cost": cost,
                    "estimated": estimated,
                }
            )
            return

        veo_prompt = str(payload.get("veo_prompt") or "").strip()
        if not veo_prompt:
            self.send_json({"error": "veo_prompt is required"}, status=400)
            return
        image_b64 = str(payload.get("image_b64") or "").strip()
        if not image_b64:
            self.send_json({"error": "image_b64 is required for Veo"}, status=400)
            return
        if "," in image_b64 and image_b64.lower().startswith("data:"):
            image_b64 = image_b64.split(",", 1)[1]
        media_type = str(payload.get("media_type") or "image/png").strip() or "image/png"
        video_id = str(payload.get("video") or "").strip() or None
        aspect_ratio = str(payload.get("aspect_ratio") or "16:9").strip() or "16:9"
        duration_seconds = int(payload.get("duration_seconds") or 4)
        try:
            image_bytes = base64.b64decode(image_b64, validate=False)
        except Exception:
            self.send_json({"error": "invalid image_b64"}, status=400)
            return
        if not image_bytes:
            self.send_json({"error": "empty image"}, status=400)
            return

        stem = str(payload.get("name") or "").strip() or f"anim-{int(time.time())}"
        try:
            raw, ext, model, meta = veo_generate_video(
                veo_prompt,
                image_bytes,
                media_type=media_type,
                aspect_ratio=aspect_ratio,
                duration_seconds=duration_seconds,
            )
        except RuntimeError as exc:
            self.send_json({"error": str(exc)}, status=502)
            return
        cost, estimated = estimate_veo_cost(
            model, duration_seconds=int(meta.get("duration_seconds") or duration_seconds)
        )
        append_ledger(
            video_id,
            provider="google",
            model=model,
            note="Generating an animation",
            cost=cost,
            estimated=estimated,
            meta={**meta, "step": "video"},
        )
        target = safe_asset_write("animations", unique_asset_filename("animations", stem, ext))
        if not target:
            self.send_json({"error": "could not create animation file"}, status=400)
            return
        target.write_bytes(raw)
        relative = target.relative_to(ROOT).as_posix()
        self.send_json(
            {
                "ok": True,
                "step": "video",
                "path": relative,
                "name": target.stem,
                "model": model,
                "cost": cost,
                "estimated": estimated,
            }
        )

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
        route = urlparse(self.path).path
        if route == "/api/video":
            required = self.require_video()
            if not required:
                return
            video_id, _ = required
            if not delete_video(video_id):
                self.send_json({"error": "unknown video"}, status=404)
                return
            self.send_json({"deleted": True, "id": video_id})
            return
        if route != "/api/asset":
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
        route = urlparse(self.path).path
        if route == "/api/jar":
            required = self.require_jar()
            if not required:
                return
            jar_id, _ = required
            length = int(self.headers.get("Content-Length", 0))
            try:
                patch = json.loads(self.rfile.read(length)) if length else {}
            except json.JSONDecodeError as exc:
                self.send_json({"error": f"invalid JSON: {exc}"}, status=400)
                return
            if not isinstance(patch, dict):
                self.send_json({"error": "invalid JSON"}, status=400)
                return
            updated = update_jar(jar_id, patch)
            if not updated:
                self.send_json({"error": "unknown jar"}, status=404)
                return
            self.send_json({"saved": True, **updated})
            return
        if route != "/api/script":
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

        # Skip rewriting when nothing changed — a no-op save must not bump mtime,
        # or every Process Scene/Video would mark earlier scene renders "stale".
        text = json.dumps(script, indent=2, ensure_ascii=False) + "\n"
        if path.exists():
            try:
                if path.read_text() == text:
                    self.send_json({"saved": True, "unchanged": True})
                    return
            except OSError:
                pass
            backup = path.with_suffix(".json.bak")
            shutil.copyfile(path, backup)
        path.write_text(text)
        self.send_json({"saved": True})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    env_port = os.environ.get("PORT")
    default_port = int(env_port) if env_port and env_port.isdigit() else 8765
    # Railway (and most PaaS) set PORT and need 0.0.0.0; local stays on loopback.
    default_host = os.environ.get("HOST") or ("0.0.0.0" if env_port else "127.0.0.1")
    parser.add_argument("--port", type=int, default=default_port)
    parser.add_argument("--host", default=default_host, help="bind address (default: 127.0.0.1 locally, 0.0.0.0 when PORT is set)")
    parser.add_argument("--no-open", action="store_true", help="don't open a browser")
    args = parser.parse_args()
    # Containers / PaaS: never try to launch a local browser.
    if env_port:
        args.no_open = True

    if not shutil.which("ffprobe"):
        print("error: ffprobe is not installed (brew install ffmpeg)", file=sys.stderr)
        return 1

    VIDEOS.mkdir(parents=True, exist_ok=True)
    address = f"http://{args.host}:{args.port}"

    try:
        server = ThreadingHTTPServer((args.host, args.port), Handler)
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
            open_url = f"http://127.0.0.1:{args.port}" if args.host in ("0.0.0.0", "::") else address
            threading.Timer(0.5, webbrowser.open, [open_url]).start()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
