# Cozy Journeys

Long-form ambient videos: one handcrafted miniature scene, held on screen while
a sequence of songs plays over it. Pick a picture, drop songs under it in the
order you want, generate the video.

## The image prompt

This is the official house style. Keep it verbatim and append the specific scene
description to the end of it.

> Museum-quality handcrafted miniature diorama, photographed as if it were a
> real physical scale model. Hyperrealistic miniature craftsmanship with
> meticulously detailed architecture, tiny handmade props, realistic wood grain,
> painted plaster, textured stone, brass, aged metals, woven fabrics, ceramic,
> glass, and miniature foliage. Every object feels tactile and hand-built rather
> than computer generated. Warm cinematic lighting with practical lamps, glowing
> windows, soft volumetric light, subtle bloom, rich golden highlights, and
> gentle shadows. Premium color grading featuring warm amber, honey, cream,
> walnut brown, muted greens, burnt orange, soft reds, and natural neutrals. No
> oversaturated colors. Tiny handcrafted human figures with realistic painted
> faces and clothing, posed naturally with subtle imperfections. Objects show
> slight wear and lived-in character instead of looking pristine. Highly
> realistic physical materials including glossy glass reflections, matte painted
> wood, textured brick, wet stone, polished brass, tiny leaves, moss, cloth
> fibers, and realistic weathering. The scene should look like an expensive
> handcrafted railway exhibition rather than a toy. Elegant composition with
> layered depth, atmospheric perspective, beautiful bokeh, soft reflections,
> believable scale cues, and premium commercial photography aesthetics. Calm,
> cozy, nostalgic, timeless, inviting, sophisticated, tactile, handcrafted,
> believable.

Videos are **3:2**, matching the stills. Render them at 2× the output frame or
larger (3240×2160 for a 1620×1080 video) — the slow pan crops into the image, so
the extra pixels are what keep it sharp.

## Requirements

`ffmpeg` and Python 3.9+. No Python packages to install.

```bash
brew install ffmpeg
```

## The app

```bash
./serve.py
```

Opens on `http://127.0.0.1:8765`.

| Path | Screen |
| --- | --- |
| `/` | List of videos |
| `/video?v=riverbend` | Arrange scenes for that video |
| `/scene?v=riverbend&s=0` | Edit one scene |

Breadcrumbs at the top: **Videos / Riverbend Coffee / Scene title**.

A **video** is a horizontal sequence of **scenes**. Each scene is one still picture
with songs over it. Pictures stay still — no pan — when they already match the
3:2 frame.

**Video screen** — play / scrub the whole soundtrack, reorder scenes, **Generate video**,
**Download video** (enabled once that file exists).

**Scene screen** — pick a picture and songs; **Generate scene** / **Generate video**;
**Download scene** / **Download video** for the selected video only.

Videos live in `videos/*.json`. Edits autosave.

## The library

`assets/` is the local library. Drop a file into the right folder and it shows
up in the app; nothing is copied or renamed behind your back.

```
assets/images/   the pictures (maps live in assets/maps and are listed too)
assets/music/    the songs
out/             finished videos and chapter files
```

## How the timing works

Song durations drive everything; nothing is hardcoded to a guessed length. The
picture is on screen for exactly as long as the music runs, so the video gets
longer by adding songs, never by typing a duration.

Songs overlap by two seconds so they blend instead of cutting, which is why the
total is a little shorter than the sum of the tracks. The picture drifts slowly
across the frame for the whole runtime, and the video fades up from and down to
black at the ends.

## Rendering from the terminal

The app shells out to the same renderer you can drive yourself:

```bash
./build.py journey.json --check      # validate and print the running order
./build.py journey.json --preview    # fast small draft
./build.py journey.json              # full render
```

`--check` probes every song for its real duration, proves the picture exists,
and prints what it's about to build without rendering anything. A full render
also writes `out/<name>-chapters.txt`, a ready-to-paste list of YouTube
timestamps.

## The script file

Each video is a JSON file in `videos/`. Asset paths are relative to the project
root (not the `videos/` folder).

```json
{
  "project": "Cozy Journeys",
  "output": { "file": "out/riverbend-coffee.mp4", "width": 1620, "height": 1080, "fps": 30 },
  "defaults": { "fade_seconds": 3, "track_crossfade": 2, "open_close_fade": 2 },
  "scenes": [
    {
      "title": "Riverbend Coffee",
      "image": "assets/images/riverbend-coffee.png",
      "map": { "seconds": 0 },
      "pan": "left",
      "zoom": 1.1,
      "tracks": [
        "assets/music/Sunlit Breakfast.wav",
        "assets/music/Pumpkin Sax Parade.wav",
        "assets/music/Pumpkin Static.wav"
      ]
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `defaults.track_crossfade` | Overlap between songs, `0` for a hard cut |
| `defaults.fade_seconds` | Cross-fade between pictures, if there's more than one |
| `defaults.open_close_fade` | Fade from and to black at the very start and end |
| `pan` | `left`, `right`, `up`, `down` or `none` (default: still) |
| `zoom` | How far a pan crops in; `1.0` holds perfectly still |

### What the renderer can still do

The app edits one picture and its songs, but `build.py` reads a richer script
than that, and will keep honouring these if you hand-write them:

- **Several scenes**, each with its own picture and songs, cross-faded together.
- **A map card** that opens a scene so the viewer knows where they are. Set
  `"map": { "image": "assets/maps/riverbend.png", "seconds": 60 }`; the map eats
  into that scene's music rather than adding time. `"seconds": 0` skips it,
  which is what the app writes.
- **Several pictures in one scene** with `"images": [...]`, splitting the
  scene's time evenly.
- **Per-transition fades** with `"fade_in"` on a picture or map.
- `--scene N` to render a single scene while you're judging its look.

## Layout

```
build.py    the renderer
serve.py    the app
ui/         the app's front end
assets/     the library
out/        finished videos
```

The app's look follows [Paper & Ink](https://nicbenedetto.com/ds).
