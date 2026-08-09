// Landing → videos → video → scene. Paths: /, /videos, /video?v=, /scene?v=&s=

const state = {
  page: "landing", // landing | list | video | scene
  videoId: null,
  videos: [],
  script: null,
  assets: { images: [], music: [], sounds: [], effects: [], animations: [] },
  selectedAnim: null,
  selectedOverlay: null, // "credit" | "now_playing" | null
  outputs: { video: { ready: false }, scenes: {} },
  render: { status: "idle", percent: 0, ready: false },
  sceneIndex: 0,
  saving: false,
  note: "",
  pickerOpen: false,
  movingScene: null, // index of scene waiting to be placed, or null
  placingTransition: null, // index of multi-use transition waiting to be placed, or null
  movingSong: null, // index of song waiting to be placed, or null
  pruneImages: false,
  pruneSongs: false,
  pruneSounds: false,
  pruneAnims: false,
  renamingPath: null,
  pictureExpanded: false,
  regionTool: false,
  regionAspect: "landscape", // landscape = 16:9, portrait = 9:16
  detailsDirty: false,
  detailsOpen: false,
  sceneDetailsOpen: false,
  libraryShowAll: {
    effects: false,
    animations: false,
    images: false,
    music: false,
    sounds: false,
  },
};

let drag = null;
let saveTimer = null;
let pollTimer = null;
let overlayUi = null;
let renderEtaSamples = [];
const OVERLAY_FADE = 0.6;
const DEFAULT_MAP_SECONDS = 30;
const DEFAULT_ZOOM_SECONDS = 3;
const DEFAULT_FADE_SECONDS = 3;

/* ---------- helpers ---------- */

const SVG_TAGS = new Set(["svg", "path", "circle", "line", "rect", "polyline", "polygon"]);

function h(tag, props = {}, ...children) {
  const node = SVG_TAGS.has(tag)
    ? document.createElementNS("http://www.w3.org/2000/svg", tag)
    : document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") {
      if (node instanceof SVGElement) node.setAttribute("class", value);
      else node.className = value;
    } else if (key === "style") Object.assign(node.style, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "text") node.textContent = value;
    else if (key === "draggable") {
      // Must be the string "true"/"false" — empty string is ignored by browsers.
      node.setAttribute("draggable", value ? "true" : "false");
      node.draggable = !!value;
    } else if (key === "value" || key === "checked" || key === "selected") {
      // Properties, not attributes — textarea ignores a value="" attribute entirely.
      node[key] = value;
    } else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clock(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const baseName = (path) => (path || "").split("/").pop().replace(/\.[^.]+$/, "");
const fileOf = (entry) => (typeof entry === "string" ? entry : entry?.file || "");
const songMeta = (path) => state.assets.music.find((song) => song.path === path);
const soundMeta = (path) => state.assets.sounds.find((sound) => sound.path === path);
const imageExists = (path) => state.assets.images.some((image) => image.path === path);
const withVideo = (path) => `${path}${path.includes("?") ? "&" : "?"}v=${encodeURIComponent(state.videoId)}`;

function trashIcon() {
  return h(
    "svg",
    {
      class: "icon",
      viewBox: "0 0 16 16",
      width: "14",
      height: "14",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.4",
      "aria-hidden": true,
    },
    h("path", {
      d: "M3.5 4.5h9M6 4.5V3.2A1.2 1.2 0 0 1 7.2 2h1.6A1.2 1.2 0 0 1 10 3.2V4.5M5 4.5l.4 8.2A1 1 0 0 0 6.4 13.5h3.2a1 1 0 0 0 1-.8L11 4.5",
    })
  );
}

function plusIcon() {
  return h(
    "svg",
    {
      class: "icon",
      viewBox: "0 0 16 16",
      width: "14",
      height: "14",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.6",
      "aria-hidden": true,
    },
    h("path", { d: "M8 3.5v9M3.5 8h9" })
  );
}

function gripIcon() {
  return h(
    "span",
    { class: "grip", "aria-hidden": true },
    h("span"),
    h("span"),
    h("span"),
    h("span"),
    h("span"),
    h("span")
  );
}

/* ---------- routing ---------- */

function readRoute() {
  const path = location.pathname.replace(/\/$/, "") || "/";
  const params = new URLSearchParams(location.search);
  if (path === "/video") {
    return { page: "video", videoId: params.get("v"), sceneIndex: 0 };
  }
  if (path === "/scene") {
    return {
      page: "scene",
      videoId: params.get("v"),
      sceneIndex: Math.max(0, Number(params.get("s") || 0)),
    };
  }
  if (path === "/videos") {
    return { page: "list", videoId: null, sceneIndex: 0 };
  }
  return { page: "landing", videoId: null, sceneIndex: 0 };
}

function go(page, { videoId = state.videoId, sceneIndex = state.sceneIndex } = {}) {
  let url = "/";
  if (page === "list") url = "/videos";
  if (page === "video") url = `/video?v=${encodeURIComponent(videoId)}`;
  if (page === "scene") url = `/scene?v=${encodeURIComponent(videoId)}&s=${sceneIndex}`;
  history.pushState({}, "", url);
  applyRoute();
}

async function applyRoute() {
  const route = readRoute();
  state.page = route.page;
  state.pickerOpen = false;
  state.note = "";

  state.movingScene = null;
  state.movingSong = null;
  state.selectedAnim = null;
  state.selectedOverlay = null;
  state.pictureExpanded = false;
  overlayUi = null;

  if (route.page === "landing") {
    state.videoId = null;
    state.script = null;
    render();
    return;
  }

  if (route.page === "list") {
    state.videoId = null;
    state.script = null;
    await loadVideos();
    render();
    return;
  }

  if (!route.videoId) {
    history.replaceState({}, "", "/");
    await applyRoute();
    return;
  }

  if (state.videoId !== route.videoId || !state.script) {
    const ok = await loadVideo(route.videoId);
    if (!ok) {
      history.replaceState({}, "", "/");
      await applyRoute();
      return;
    }
  }

  const nextScene = Math.min(route.sceneIndex, Math.max(0, scenes().length - 1));
  if (route.page === "scene" && state.sceneIndex !== nextScene) {
    state.libraryShowAll = {
      effects: false,
      animations: false,
      images: false,
      music: false,
      sounds: false,
    };
  }
  state.sceneIndex = nextScene;
  state.page = route.page;
  render();
}

/* ---------- script model ---------- */

const DEFAULT_PROMPT =
  "Museum-quality handcrafted miniature diorama, photographed as if it were a " +
  "real physical scale model. Hyperrealistic miniature craftsmanship with " +
  "meticulously detailed architecture, tiny handmade props, realistic wood grain, " +
  "painted plaster, textured stone, brass, aged metals, woven fabrics, ceramic, " +
  "glass, and miniature foliage. Every object feels tactile and hand-built rather " +
  "than computer generated. Warm cinematic lighting with practical lamps, glowing " +
  "windows, soft volumetric light, subtle bloom, rich golden highlights, and " +
  "gentle shadows. Premium color grading featuring warm amber, honey, cream, " +
  "walnut brown, muted greens, burnt orange, soft reds, and natural neutrals. No " +
  "oversaturated colors. Tiny handcrafted human figures with realistic painted " +
  "faces and clothing, posed naturally with subtle imperfections. Objects show " +
  "slight wear and lived-in character instead of looking pristine. Highly " +
  "realistic physical materials including glossy glass reflections, matte painted " +
  "wood, textured brick, wet stone, polished brass, tiny leaves, moss, cloth " +
  "fibers, and realistic weathering. The scene should look like an expensive " +
  "handcrafted railway exhibition rather than a toy. Elegant composition with " +
  "layered depth, atmospheric perspective, beautiful bokeh, soft reflections, " +
  "believable scale cues, and premium commercial photography aesthetics. Calm, " +
  "cozy, nostalgic, timeless, inviting, sophisticated, tactile, handcrafted, " +
  "believable.";

function ensureScript() {
  if (!state.script) return;
  state.script.scenes ||= [];
  state.script.defaults ||= {
    fade_seconds: DEFAULT_FADE_SECONDS,
    track_crossfade: 2,
    open_close_fade: 2,
    map_seconds: DEFAULT_MAP_SECONDS,
  };
  if (state.script.defaults.map_seconds == null) {
    state.script.defaults.map_seconds = DEFAULT_MAP_SECONDS;
  }
  if (state.script.defaults.fade_seconds == null) {
    state.script.defaults.fade_seconds = DEFAULT_FADE_SECONDS;
  }
  ensureOverlays();
  ensureCreativeBrief();
  if (!state.script.scenes.length) state.script.scenes.push(blankScene());
}

function ensureCreativeBrief() {
  if (!state.script) return;
  if (typeof state.script.feeling !== "string") state.script.feeling = "";
  // Only seed the house prompt once — never clobber while the user is editing.
  if (typeof state.script.prompt !== "string") {
    state.script.prompt = DEFAULT_PROMPT;
  }
  if (typeof state.script.music_prompt !== "string") state.script.music_prompt = "";
  migrateDestinationPromptsToScenes();
  if (!Array.isArray(state.script.destinations)) state.script.destinations = [""];
  else {
    state.script.destinations = state.script.destinations.map((entry) =>
      typeof entry === "string" ? entry : entry?.name || entry?.title || ""
    );
  }
  if (!state.script.destinations.length) state.script.destinations = [""];
  for (const entry of state.script.scenes || []) ensureSceneBrief(entry);
  const cast = Array.isArray(state.script.cast) ? state.script.cast : [];
  state.script.cast = [0, 1, 2].map((index) => {
    const entry = cast[index];
    if (!entry || typeof entry !== "object") return { image: "", note: "" };
    return {
      image: typeof entry.image === "string" ? entry.image : "",
      note: typeof entry.note === "string" ? entry.note : "",
    };
  });
}

function ensureSceneBrief(entry = scene()) {
  if (!entry || typeof entry !== "object") return entry;
  if (typeof entry.image_prompt !== "string") entry.image_prompt = "";
  if (typeof entry.music_prompt !== "string") entry.music_prompt = "";
  return entry;
}

const migratedDestPrompts = new Set();

function migrateDestinationPromptsToScenes() {
  if (!state.script || !state.videoId || migratedDestPrompts.has(state.videoId)) return;
  const destinations = Array.isArray(state.script.destinations) ? state.script.destinations : [];
  const sceneList = state.script.scenes || [];
  for (const raw of destinations) {
    if (!raw || typeof raw !== "object") continue;
    const name = String(raw.name || raw.title || "").trim();
    const imagePrompt = typeof raw.image_prompt === "string" ? raw.image_prompt.trim() : "";
    const musicPrompt = typeof raw.music_prompt === "string" ? raw.music_prompt.trim() : "";
    if (!name || (!imagePrompt && !musicPrompt)) continue;
    const match = sceneList.find((entry) => (entry.title || "").trim() === name);
    if (!match) continue;
    if (imagePrompt && !String(match.image_prompt || "").trim()) match.image_prompt = imagePrompt;
    if (musicPrompt && !String(match.music_prompt || "").trim()) match.music_prompt = musicPrompt;
  }
  migratedDestPrompts.add(state.videoId);
}

function ensureOverlays() {
  if (!state.script) return { credit: {}, now_playing: {} };
  const root = (state.script.overlays ||= {});
  const credit = root.credit && typeof root.credit === "object" ? root.credit : {};
  const now = root.now_playing && typeof root.now_playing === "object" ? root.now_playing : {};
  root.credit = {
    enabled: credit.enabled !== false,
    text: credit.text || "Built with hearthbound.com",
    x: Number.isFinite(credit.x) ? credit.x : 0.035,
    y: Number.isFinite(credit.y) ? credit.y : 0.9,
    show_seconds: Number.isFinite(Number(credit.show_seconds)) ? Number(credit.show_seconds) : 5,
  };
  root.now_playing = {
    enabled: now.enabled !== false,
    x: Number.isFinite(now.x) ? now.x : 0.58,
    y: Number.isFinite(now.y) ? now.y : 0.86,
    streaming_from: now.streaming_from || "hearthbound.com",
    show_seconds: Number.isFinite(Number(now.show_seconds)) ? Number(now.show_seconds) : 5,
  };
  return root;
}

function blankScene() {
  return {
    title: `Scene ${((state.script.scenes || []).length || 0) + 1}`,
    image: state.assets.images[0]?.path || "",
    map: { seconds: DEFAULT_MAP_SECONDS },
    pan: "none",
    zoom: 1,
    tracks: [],
    sounds: [],
    effects: [],
    animations: [],
    is_transition: false,
    transition_in: "fade",
    transition_out: "fade",
    fade_zoom: null,
    image_prompt: "",
    music_prompt: "",
  };
}

function blankTransition() {
  const entry = blankScene();
  const n = scenes().filter((scene) => scene.is_transition).length + 1;
  entry.is_transition = true;
  entry.title = `Transition ${n}`;
  entry.tracks = [];
  entry.map = { seconds: DEFAULT_MAP_SECONDS };
  entry.transition_in = "fade";
  entry.transition_out = "fade";
  entry.fade_zoom = {
    seconds: DEFAULT_ZOOM_SECONDS,
    include_start: true,
    include_end: true,
    start: { x: 0.15, y: 0.2, w: 0.35, h: 0.4 },
    end: { x: 0.5, y: 0.25, w: 0.35, h: 0.4 },
  };
  return entry;
}

const TRANSITION_FX = [
  { id: "fade", label: "Fade" },
  { id: "fade_zoom", label: "Fade zoom" },
];

function clampZoomRect(rect, fallback) {
  const clamp01 = (value, fb) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fb;
  };
  const src = rect && typeof rect === "object" ? rect : {};
  const fb = fallback || { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  const out = {
    x: clamp01(src.x, fb.x),
    y: clamp01(src.y, fb.y),
    w: clamp01(src.w, fb.w),
    h: clamp01(src.h, fb.h),
  };
  out.w = Math.min(1 - out.x, Math.max(0.05, out.w));
  out.h = Math.min(1 - out.y, Math.max(0.05, out.h));
  return out;
}

function ensureFadeZoom(entry) {
  if (!entry.fade_zoom || typeof entry.fade_zoom !== "object") {
    entry.fade_zoom = {};
  }
  const z = entry.fade_zoom;

  // Migrate legacy flat {x,y,w,h} into start/end rectangles.
  if (!z.start || typeof z.start !== "object") {
    if (Number.isFinite(Number(z.x)) || Number.isFinite(Number(z.w))) {
      z.start = clampZoomRect(z, { x: 0.15, y: 0.2, w: 0.35, h: 0.4 });
    } else {
      z.start = { x: 0.15, y: 0.2, w: 0.35, h: 0.4 };
    }
  }
  if (!z.end || typeof z.end !== "object") {
    z.end = clampZoomRect(z.start, { x: 0.5, y: 0.25, w: 0.35, h: 0.4 });
    if (Math.abs(z.end.x - z.start.x) < 0.02 && Math.abs(z.end.y - z.start.y) < 0.02) {
      z.end = clampZoomRect(
        { x: Math.min(0.55, z.start.x + 0.3), y: z.start.y, w: z.start.w, h: z.start.h },
        z.start
      );
    }
  }
  z.start = clampZoomRect(z.start, { x: 0.15, y: 0.2, w: 0.35, h: 0.4 });
  z.end = clampZoomRect(z.end, { x: 0.5, y: 0.25, w: 0.35, h: 0.4 });
  delete z.x;
  delete z.y;
  delete z.w;
  delete z.h;

  if (z.include_start === undefined) z.include_start = true;
  if (z.include_end === undefined) {
    // Legacy "no reverse exit" → no end zoom target.
    z.include_end = entry.fade_zoom_reverse_out !== false;
  }
  z.include_start = !!z.include_start;
  z.include_end = !!z.include_end;
  delete entry.fade_zoom_reverse_out;

  const zoomSecs = Number(z.seconds);
  z.seconds = Number.isFinite(zoomSecs) && zoomSecs >= 0 ? zoomSecs : DEFAULT_ZOOM_SECONDS;
  return z;
}

function transitionStyleOf(entry) {
  const style = entry?.transition_in || entry?.transition_out || "fade";
  return TRANSITION_FX.some((fx) => fx.id === style) ? style : "fade";
}

function transitionMapSeconds(entry) {
  const n = Number(entry?.map?.seconds);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Alpha fade at the map overlay edges (per transition, falls back to defaults). */
function transitionFadeSeconds(entry) {
  const own = Number(entry?.fade_seconds);
  if (Number.isFinite(own) && own >= 0) return own;
  const fallback = Number(state.script?.defaults?.fade_seconds);
  return Number.isFinite(fallback) && fallback >= 0 ? fallback : DEFAULT_FADE_SECONDS;
}

function transitionZoomSeconds(entry) {
  if (!entry || transitionStyleOf(entry) !== "fade_zoom") return 0;
  const z = ensureFadeZoom(entry);
  if (!z.include_start && !z.include_end) return 0;
  const n = Number(z.seconds);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_ZOOM_SECONDS;
}

/** Map hold + optional start/end zoom spans across the neighboring scenes. */
function transitionTiming(entry) {
  const map = transitionMapSeconds(entry);
  const mapHalf = map / 2;
  let zoom = 0;
  let hasStart = false;
  let hasEnd = false;
  if (entry && transitionStyleOf(entry) === "fade_zoom") {
    const z = ensureFadeZoom(entry);
    hasStart = !!z.include_start;
    hasEnd = !!z.include_end;
    zoom = transitionZoomSeconds(entry);
  }
  let startZoom = 0;
  let endZoom = 0;
  if (hasStart && hasEnd) {
    startZoom = zoom / 2;
    endZoom = zoom / 2;
  } else if (hasStart) startZoom = zoom;
  else if (hasEnd) endZoom = zoom;

  const outHold = mapHalf + startZoom;
  const inHold = mapHalf + endZoom;
  const total = outHold + inHold;
  return {
    map,
    zoom,
    hasStart,
    hasEnd,
    startZoom,
    endZoom,
    mapHalf,
    outHold,
    inHold,
    total,
    // Back-compat aliases used by a few call sites.
    side: total / 2,
    zoomHalf: zoom / 2,
  };
}

function transitionFxSelect(value, onPick, label) {
  return h(
    "label",
    { class: "transition-fx-field" },
    h("span", { text: label }),
    h(
      "select",
      {
        class: "transition-fx-select",
        value: value || "fade",
        onChange: (event) => onPick(event.target.value),
      },
      TRANSITION_FX.map((fx) => h("option", { value: fx.id, text: fx.label }))
    )
  );
}

function fadeZoomFields(entry) {
  const z = ensureFadeZoom(entry);
  const toggle = (key, label, hint) =>
    h(
      "label",
      { class: `fade-zoom-include${z[key] ? " on" : ""}` },
      h("input", {
        type: "checkbox",
        checked: !!z[key],
        onChange: (event) => {
          ensureFadeZoom(entry)[key] = !!event.target.checked;
          changed();
        },
      }),
      h("span", { text: label }),
      hint && h("span", { class: "meta", text: hint })
    );

  return h(
    "div",
    { class: "fade-zoom-panel" },
    h("p", {
      class: "meta transition-note",
      text: "Optional zoom targets on the full map. With only End: map holds full, then zooms in. With only Start: opens zoomed in and pulls out to the map.",
    }),
    h(
      "div",
      { class: "fade-zoom-includes" },
      toggle("include_start", "Include start", "zoom out from Start"),
      toggle("include_end", "Include end", "zoom in to End")
    )
  );
}

function fadeZoomGuide(which) {
  const z = ensureFadeZoom(scene());
  if (which === "start" && !z.include_start) return null;
  if (which === "end" && !z.include_end) return null;
  const rect = z[which];
  const label = which === "start" ? "Start" : "End";
  return h(
    "div",
    {
      class: `fade-zoom-guide is-${which}`,
      style: {
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.w * 100}%`,
        height: `${rect.h * 100}%`,
      },
      title: `${label} zoom target — drag to move, corner to resize`,
      "data-zoom-which": which,
      onPointerdown: (event) => beginFadeZoomMove(event, which),
    },
    h("span", { class: "fade-zoom-label", text: label }),
    h("div", {
      class: "fade-zoom-handle",
      title: "Resize",
      onPointerdown: (event) => beginFadeZoomResize(event, which),
    })
  );
}

function transitionDurationFields(entry) {
  const timing = transitionTiming(entry);
  const fadeSecs = transitionFadeSeconds(entry);
  const zoomStyle = transitionStyleOf(entry) === "fade_zoom";
  const showZoom = zoomStyle && (timing.hasStart || timing.hasEnd);
  return h(
    "div",
    { class: "transition-duration-fields" },
    h(
      "label",
      { class: "transition-map-hold" },
      h("span", { text: "Map (seconds)" }),
      h("input", {
        type: "number",
        min: "0",
        step: "1",
        value: String(timing.map),
        title: "How long the map holds (still) across the cut",
        onChange: (event) => {
          const next = Math.max(0, Number(event.target.value) || 0);
          if (!entry.map || typeof entry.map !== "object") entry.map = {};
          entry.map.seconds = next;
          changed();
        },
      })
    ),
    h(
      "label",
      { class: "transition-map-hold" },
      h("span", { text: "Fade (seconds)" }),
      h("input", {
        type: "number",
        min: "0",
        step: "0.25",
        value: String(fadeSecs),
        title: "How long the map fades in at the start and out at the end",
        onChange: (event) => {
          entry.fade_seconds = Math.max(0, Number(event.target.value) || 0);
          changed();
        },
      })
    ),
    showZoom &&
      h(
        "label",
        { class: "transition-map-hold" },
        h("span", { text: "Zoom (seconds)" }),
        h("input", {
          type: "number",
          min: "0",
          step: "0.5",
          value: String(Number(ensureFadeZoom(entry).seconds)),
          title: timing.hasStart && timing.hasEnd
            ? "Split across start zoom-out and end zoom-in"
            : timing.hasStart
              ? "Duration of the start zoom-out"
              : "Duration of the end zoom-in",
          onChange: (event) => {
            const next = Math.max(0, Number(event.target.value) || 0);
            ensureFadeZoom(entry).seconds = next;
            changed();
          },
        })
      ),
    h("span", {
      class: "meta transition-duration-total",
      text:
        timing.total > 0
          ? `Total ${clock(timing.total)} · ${clock(timing.outHold)} before · ${clock(timing.inHold)} after`
          : "No overlay",
    })
  );
}

function beginFadeZoomMove(event, which = "start") {
  if (event.target.closest(".fade-zoom-handle")) return;
  event.preventDefault();
  event.stopPropagation();
  const picture = event.currentTarget.closest(".picture");
  const guide = event.currentTarget;
  if (!picture || !isTransitionScene()) return;
  const entry = scene();
  const z = ensureFadeZoom(entry);
  const rect = z[which] || z.start;
  const box = picture.getBoundingClientRect();
  const startX = event.clientX;
  const startY = event.clientY;
  const originX = rect.x;
  const originY = rect.y;

  guide.classList.add("dragging");
  guide.setPointerCapture(event.pointerId);
  const move = (moveEvent) => {
    rect.x = Math.min(1 - rect.w, Math.max(0, originX + (moveEvent.clientX - startX) / box.width));
    rect.y = Math.min(1 - rect.h, Math.max(0, originY + (moveEvent.clientY - startY) / box.height));
    guide.style.left = `${rect.x * 100}%`;
    guide.style.top = `${rect.y * 100}%`;
  };
  const up = () => {
    guide.classList.remove("dragging");
    guide.releasePointerCapture(event.pointerId);
    guide.removeEventListener("pointermove", move);
    guide.removeEventListener("pointerup", up);
    guide.removeEventListener("pointercancel", up);
    ensureFadeZoom(entry);
    changed();
  };
  guide.addEventListener("pointermove", move);
  guide.addEventListener("pointerup", up);
  guide.addEventListener("pointercancel", up);
}

function beginFadeZoomResize(event, which = "start") {
  event.preventDefault();
  event.stopPropagation();
  const handle = event.currentTarget;
  const guide = handle.closest(".fade-zoom-guide");
  const picture = guide?.closest(".picture");
  if (!picture || !isTransitionScene()) return;
  const entry = scene();
  const z = ensureFadeZoom(entry);
  const rect = z[which] || z.start;
  const box = picture.getBoundingClientRect();
  const startX = event.clientX;
  const startY = event.clientY;
  const originW = rect.w;
  const originH = rect.h;

  guide.classList.add("dragging");
  handle.setPointerCapture(event.pointerId);
  const move = (moveEvent) => {
    rect.w = Math.min(1 - rect.x, Math.max(0.05, originW + (moveEvent.clientX - startX) / box.width));
    rect.h = Math.min(1 - rect.y, Math.max(0.05, originH + (moveEvent.clientY - startY) / box.height));
    guide.style.width = `${rect.w * 100}%`;
    guide.style.height = `${rect.h * 100}%`;
  };
  const up = () => {
    guide.classList.remove("dragging");
    handle.releasePointerCapture(event.pointerId);
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
    ensureFadeZoom(entry);
    changed();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
}

function isTransitionScene(entry = scene()) {
  return !!entry?.is_transition;
}

const sceneEffects = (index = state.sceneIndex) => (scene(index).effects ||= []);
const sceneAnims = (index = state.sceneIndex) => (scene(index).animations ||= []);
const sceneSounds = (index = state.sceneIndex) => (scene(index).sounds ||= []);

function normalizeSound(entry) {
  if (typeof entry === "string") return { file: entry, volume: 55 };
  const volume = Number(entry?.volume);
  return {
    file: entry?.file || "",
    volume: Number.isFinite(volume) ? Math.min(100, Math.max(0, volume)) : 55,
  };
}

function soundEntry(path, index = state.sceneIndex) {
  const list = sceneSounds(index);
  const at = list.findIndex((entry) => normalizeSound(entry).file === path);
  if (at < 0) return null;
  const normalized = normalizeSound(list[at]);
  list[at] = normalized;
  return normalized;
}

function normalizeEffect(entry) {
  if (typeof entry === "string") return { file: entry, speed: 100 };
  const speed = Number(entry?.speed);
  return {
    file: entry?.file || "",
    speed: Number.isFinite(speed) ? Math.min(400, Math.max(10, speed)) : 100,
  };
}

function effectEntry(path, index = state.sceneIndex) {
  const list = sceneEffects(index);
  const at = list.findIndex((entry) => normalizeEffect(entry).file === path);
  if (at < 0) return null;
  const normalized = normalizeEffect(list[at]);
  list[at] = normalized;
  return normalized;
}

function normalizeAnim(entry) {
  if (typeof entry === "string") {
    return {
      file: entry,
      x: 0.36,
      y: 0.28,
      w: 0.28,
      h: null,
      brightness: 100,
      saturation: 100,
      speed: 100,
      aspect: "native",
      soft_edges: false,
      locked: false,
      loop_in: null,
      loop_out: null,
    };
  }
  const brightness = Number(entry.brightness);
  const saturation = Number(entry.saturation);
  const speed = Number(entry.speed);
  const aspect =
    entry.aspect === "landscape" || entry.aspect === "portrait" ? entry.aspect : "native";
  const loopIn = Number(entry.loop_in);
  const loopOut = Number(entry.loop_out);
  const height = Number(entry.h);
  return {
    file: entry.file || "",
    x: Number.isFinite(entry.x) ? entry.x : 0.36,
    y: Number.isFinite(entry.y) ? entry.y : 0.28,
    w: Number.isFinite(entry.w) ? entry.w : 0.28,
    // Optional normalized height from a drawn region slot (picture is 3:2).
    h: Number.isFinite(height) && height > 0 ? Math.min(1, height) : null,
    brightness: Number.isFinite(brightness) ? Math.min(200, Math.max(20, brightness)) : 100,
    saturation: Number.isFinite(saturation) ? Math.min(200, Math.max(0, saturation)) : 100,
    speed: Number.isFinite(speed) ? Math.min(200, Math.max(25, speed)) : 100,
    aspect,
    soft_edges: !!entry.soft_edges,
    locked: !!entry.locked,
    // 0 means “unset / use the full clip”, not a zero-second out point.
    loop_in: Number.isFinite(loopIn) && loopIn > 0 ? Math.max(0, loopIn) : null,
    loop_out: Number.isFinite(loopOut) && loopOut > 0 ? Math.max(0, loopOut) : null,
  };
}

function isPendingAnim(entry) {
  return !normalizeAnim(entry).file;
}

function animLayerStyle(entry, video = null) {
  const style = {
    left: `${entry.x * 100}%`,
    top: `${entry.y * 100}%`,
    width: `${entry.w * 100}%`,
  };
  if (Number.isFinite(entry.h) && entry.h > 0) {
    style.height = `${entry.h * 100}%`;
    style.aspectRatio = "auto";
  } else {
    style.aspectRatio = animAspectCss(entry, video);
  }
  return style;
}

function animCssFilter(entry) {
  const brightness = entry.brightness ?? 100;
  const saturation = entry.saturation ?? 100;
  return `brightness(${brightness}%) saturate(${saturation}%)`;
}

function animSourceDuration(entry) {
  const meta = (state.assets.animations || []).find((item) => item.path === entry.file);
  return meta?.duration || 0;
}

function animLoopWindow(entry, duration) {
  const full = Number.isFinite(duration) && duration > 0 ? duration : animSourceDuration(entry);
  if (!full) return { start: 0, end: 0, duration: 0 };
  let start = Number.isFinite(entry.loop_in) && entry.loop_in > 0 ? entry.loop_in : 0;
  let end = Number.isFinite(entry.loop_out) && entry.loop_out > 0 ? entry.loop_out : full;
  start = Math.max(0, Math.min(start, Math.max(0, full - 0.25)));
  end = Math.max(start + 0.25, Math.min(end, full));
  return { start, end, duration: full };
}

function animAspectCss(entry, video = null) {
  if (entry.aspect === "landscape") return "16 / 9";
  if (entry.aspect === "portrait") return "9 / 16";
  if (video?.videoWidth && video?.videoHeight) {
    return `${video.videoWidth} / ${video.videoHeight}`;
  }
  // Picture frame is 3:2 — turn a normalized w×h box into CSS aspect-ratio.
  if (Number.isFinite(entry.h) && entry.h > 0 && entry.w > 0) {
    return `${entry.w * 3} / ${entry.h * 2}`;
  }
  return "auto";
}

function regionIcon() {
  return h(
    "svg",
    {
      class: "icon",
      viewBox: "0 0 16 16",
      width: "14",
      height: "14",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.5",
      "aria-hidden": true,
    },
    h("path", { d: "M3 5.5V3h2.5M10.5 3H13v2.5M13 10.5V13h-2.5M5.5 13H3v-2.5" }),
    h("rect", { x: "5", y: "5", width: "6", height: "6", rx: "0.5" })
  );
}

function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load scene image"));
    image.src = url;
  });
}

function animCropNorm(entry, video = null) {
  const normalized = normalizeAnim(entry);
  let height = normalized.h;
  if (!(Number.isFinite(height) && height > 0)) {
    let ratio = null;
    if (video?.videoWidth && video?.videoHeight) ratio = video.videoWidth / video.videoHeight;
    else if (normalized.aspect === "landscape") ratio = 16 / 9;
    else if (normalized.aspect === "portrait") ratio = 9 / 16;
    // Picture is 3:2: h = (w * picW / ratio) / picH = w * (3/2) / ratio
    if (ratio) height = (normalized.w * 1.5) / ratio;
  }
  if (!(Number.isFinite(height) && height > 0)) height = normalized.w * 0.75;
  return {
    x: Math.min(1, Math.max(0, normalized.x)),
    y: Math.min(1, Math.max(0, normalized.y)),
    w: Math.min(1 - normalized.x, Math.max(0.01, normalized.w)),
    h: Math.min(1 - normalized.y, Math.max(0.01, height)),
  };
}

async function exportAnimRegionStill(index, { clipboard = true } = {}) {
  const list = sceneAnims();
  if (index == null || index < 0 || index >= list.length) return;
  const entry = normalizeAnim(list[index]);
  list[index] = entry;

  const imagePath = scene()?.image;
  if (!imagePath || !imageExists(imagePath)) {
    state.note = "No scene image to crop";
    render();
    return;
  }
  try {
    const image = await loadImageElement(`/${imagePath}`);
    const box = animCropNorm(entry);
    const sx = Math.round(box.x * image.naturalWidth);
    const sy = Math.round(box.y * image.naturalHeight);
    const sw = Math.max(1, Math.round(box.w * image.naturalWidth));
    const sh = Math.max(1, Math.round(box.h * image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Could not export crop");

    const stem = baseName(imagePath) || "scene";
    const name = `${stem}-region-${Math.round(box.x * 100)}-${Math.round(box.y * 100)}.png`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);

    entry.locked = true;
    if (clipboard && navigator.clipboard?.write && window.ClipboardItem) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        state.note = "Copied and locked — drag/resize disabled for this slot";
      } catch {
        state.note = "Downloaded and locked — drag/resize disabled for this slot";
      }
    } else {
      state.note = "Downloaded and locked — drag/resize disabled for this slot";
    }
    changed();
  } catch (error) {
    state.note = error.message || "Could not export region";
    render();
  }
}

// Picture frame is 3:2. Region crops must be 16:9 or 9:16 in pixel space.
// Normalized w/h = pixelAspect × (2/3).
function regionNormWH(aspect = state.regionAspect) {
  const pixel = aspect === "portrait" ? 9 / 16 : 16 / 9;
  return pixel * (2 / 3);
}

function fitRegionBox(x0, y0, x1, y1, aspect = state.regionAspect) {
  const want = regionNormWH(aspect);
  const signX = x1 >= x0 ? 1 : -1;
  const signY = y1 >= y0 ? 1 : -1;
  let w = Math.abs(x1 - x0);
  let h = Math.abs(y1 - y0);
  if (w < 0.001 && h < 0.001) return { x: x0, y: y0, w: 0, h: 0 };

  if (w / Math.max(h, 1e-9) > want) h = w / want;
  else w = h * want;

  // Stay inside the picture from the drag origin corner.
  const maxW = signX > 0 ? 1 - x0 : x0;
  const maxH = signY > 0 ? 1 - y0 : y0;
  if (w > maxW) {
    w = maxW;
    h = w / want;
  }
  if (h > maxH) {
    h = maxH;
    w = h * want;
  }
  if (w > maxW) {
    w = maxW;
    h = w / want;
  }

  return {
    x: signX > 0 ? x0 : x0 - w,
    y: signY > 0 ? y0 : y0 - h,
    w,
    h,
  };
}

function applyAnimAspect(entry, aspect) {
  if (entry.locked) return;
  const next = aspect === "portrait" ? "portrait" : "landscape";
  entry.aspect = next;
  const want = regionNormWH(next);
  const cx = entry.x + entry.w / 2;
  const cy = entry.y + (entry.h || entry.w / want) / 2;
  let w = Math.min(1, Math.max(0.05, entry.w));
  let h = w / want;
  if (h > 1) {
    h = 1;
    w = h * want;
  }
  entry.w = w;
  entry.h = h;
  entry.x = Math.min(1 - w, Math.max(0, cx - w / 2));
  entry.y = Math.min(1 - h, Math.max(0, cy - h / 2));
}

function regionAspectToggle(current, onPick) {
  return h(
    "div",
    { class: "region-aspect" },
    h(
      "button",
      {
        class: `region-aspect-btn${current === "landscape" ? " on" : ""}`,
        type: "button",
        title: "16:9 landscape",
        onClick: (event) => {
          event.stopPropagation();
          onPick("landscape");
        },
      },
      "16:9"
    ),
    h(
      "button",
      {
        class: `region-aspect-btn${current === "portrait" ? " on" : ""}`,
        type: "button",
        title: "9:16 portrait",
        onClick: (event) => {
          event.stopPropagation();
          onPick("portrait");
        },
      },
      "9:16"
    )
  );
}

function beginRegionDraw(event) {
  event.preventDefault();
  event.stopPropagation();
  const surface = event.currentTarget;
  const picture = surface.closest(".picture");
  if (!picture) return;
  const box = picture.getBoundingClientRect();
  const startX = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
  const startY = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
  const marquee = h("div", { class: "region-marquee" });
  picture.append(marquee);
  const aspect = state.regionAspect === "portrait" ? "portrait" : "landscape";

  const paint = (rect) => {
    marquee.style.left = `${rect.x * 100}%`;
    marquee.style.top = `${rect.y * 100}%`;
    marquee.style.width = `${rect.w * 100}%`;
    marquee.style.height = `${rect.h * 100}%`;
    return rect;
  };
  paint({ x: startX, y: startY, w: 0, h: 0 });

  surface.setPointerCapture(event.pointerId);
  let last = { x: startX, y: startY, w: 0, h: 0 };
  const move = (moveEvent) => {
    const x = Math.min(1, Math.max(0, (moveEvent.clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (moveEvent.clientY - box.top) / box.height));
    last = paint(fitRegionBox(startX, startY, x, y, aspect));
  };
  const up = () => {
    surface.releasePointerCapture(event.pointerId);
    surface.removeEventListener("pointermove", move);
    surface.removeEventListener("pointerup", up);
    surface.removeEventListener("pointercancel", up);
    marquee.remove();
    if (last.w < 0.04 || last.h < 0.04) {
      state.note = "Draw a larger region";
      render();
      return;
    }
    const list = sceneAnims();
    const slot = normalizeAnim({
      file: "",
      x: last.x,
      y: last.y,
      w: last.w,
      h: last.h,
      soft_edges: true,
      aspect,
    });
    list.push(slot);
    state.selectedAnim = list.length - 1;
    state.regionTool = false;
    state.note =
      "Region saved — Copy still for Jim. Select this slot, then add the animated clip to fill it.";
    changed();
  };
  surface.addEventListener("pointermove", move);
  surface.addEventListener("pointerup", up);
  surface.addEventListener("pointercancel", up);
}

const scenes = () => {
  ensureScript();
  return state.script.scenes;
};

function scene(index = state.sceneIndex) {
  const list = scenes();
  return list[Math.min(Math.max(index, 0), list.length - 1)];
}

const sceneSongs = (index = state.sceneIndex) => (scene(index).tracks ||= []);

/** CSS transform for fade-zoom: progress 0 = full map, 1 = zoomed into the rect. */
function applyFadeZoomStyle(el, rect, progress) {
  if (!el) return;
  if (!rect || !(rect.w > 0) || !(rect.h > 0)) {
    el.style.transform = "";
    el.style.transformOrigin = "";
    return;
  }
  const zEnd = 1 / Math.max(Math.min(rect.w, rect.h), 0.05);
  const t = Math.min(1, Math.max(0, progress));
  const scale = 1 + (zEnd - 1) * t;
  el.style.transformOrigin = `${(rect.x + rect.w / 2) * 100}% ${(rect.y + rect.h / 2) * 100}%`;
  el.style.transform = `scale(${scale})`;
}

/** Map path + opacity (+ zoom) for a transition overlay sitting on a normal scene. */
function transitionOverlayAt(at = player.at) {
  const list = scenes();
  const item = activeVideoItem(at);
  if (!item || item.isTransition || !(item.duration > 0)) return null;
  const local = Math.max(0, at - item.start);
  const mapOf = (entry) => entry?.image || state.script?.map || "";

  const after = list[item.index + 1];
  if (after?.is_transition) {
    const timing = transitionTiming(after);
    const hold = timing.outHold;
    if (hold > 0.05 && local >= item.duration - hold - 0.001) {
      const into = local - (item.duration - hold);
      const fade = Math.max(0, transitionFadeSeconds(after));
      const fadeSpan = Math.min(fade || 0.001, hold);
      const opacity = Math.min(1, Math.max(0, into / fadeSpan));
      const path = mapOf(after);
      // Opening: optional zoom out from Start, otherwise stay on full map.
      let zoomProgress = 0;
      let zoomRect = null;
      if (timing.hasStart) {
        const fz = ensureFadeZoom(after);
        zoomRect = fz.start;
        zoomProgress =
          timing.startZoom > 0.001 ? 1 - Math.min(1, into / timing.startZoom) : 0;
      }
      if (path) {
        return {
          path,
          opacity,
          title: after.title || "Transition",
          entry: after,
          zoomProgress,
          zoomRect,
        };
      }
    }
  }

  const before = list[item.index - 1];
  if (before?.is_transition) {
    const timing = transitionTiming(before);
    const hold = timing.inHold;
    if (hold > 0.05 && local <= hold + 0.001) {
      const remaining = hold - local;
      const fade = Math.max(0, transitionFadeSeconds(before));
      const fadeSpan = Math.min(fade || 0.001, hold);
      const opacity = remaining >= fadeSpan ? 1 : Math.min(1, Math.max(0, remaining / fadeSpan));
      const path = mapOf(before);
      let zoomProgress = 0;
      let zoomRect = null;
      if (timing.hasEnd) {
        const fz = ensureFadeZoom(before);
        zoomRect = fz.end;
        // Closing: hold full map, then zoom in to End.
        zoomProgress =
          timing.endZoom > 0.001
            ? Math.min(1, Math.max(0, (local - timing.mapHalf) / timing.endZoom))
            : 0;
      }
      if (path) {
        return {
          path,
          opacity,
          title: before.title || "Transition",
          entry: before,
          zoomProgress,
          zoomRect,
        };
      }
    }
  }

  return null;
}

function sceneSequence(index) {
  // Transitions add no runtime to the video timeline — they overlay neighbors.
  if (isTransitionScene(scene(index))) return { list: [], total: 0 };

  const crossfade = Number(state.script.defaults?.track_crossfade ?? 2);
  let cursor = 0;
  const list = sceneSongs(index).map((entry) => {
    const path = fileOf(entry);
    const meta = songMeta(path);
    const duration = meta?.duration ?? 0;
    const item = { path, title: baseName(path), duration, missing: !meta, start: cursor };
    cursor += Math.max(0, duration - crossfade);
    return item;
  });
  const total = list.length
    ? list.reduce((sum, item) => sum + item.duration, 0) - crossfade * (list.length - 1)
    : 0;
  return { list, total: Math.max(0, total) };
}

/** Playable length on the scene page (map + zoom for transitions). */
function scenePlayTotal(index = state.sceneIndex) {
  const entry = scene(index);
  if (entry?.is_transition) return transitionTiming(entry).total;
  return sceneSequence(index).total;
}

function videoTimeline() {
  let start = 0;
  const items = scenes().map((entry, index) => {
    const { list, total } = sceneSequence(index);
    const mapOnly =
      !!entry.is_transition && transitionTiming(entry).total > 0 && !entry.image;
    const item = {
      index,
      title: entry.title || `Scene ${index + 1}`,
      image: entry.image || "",
      songs: list,
      duration: total,
      start,
      isTransition: !!entry.is_transition,
      missing: mapOnly ? false : !entry.image || !imageExists(entry.image),
    };
    start += total;
    return item;
  });
  return { items, total: items.reduce((sum, item) => sum + item.duration, 0) };
}

/** Flat song list with absolute start times across the whole video. */
function videoSongs() {
  const tl = cachedVideoTimeline();
  if (!tl._songs) {
    tl._songs = [];
    tl.items.forEach((item) => {
      item.songs.forEach((song) => {
        tl._songs.push({ ...song, start: item.start + song.start });
      });
    });
  }
  return tl._songs;
}

function activeVideoItem(at = player.at) {
  const { items } = cachedVideoTimeline();
  let active = items[0] || null;
  items.forEach((item) => {
    if (at >= item.start - 0.001) active = item;
  });
  return active;
}

function playScope() {
  if (state.page === "scene") {
    return { mode: "scene", scene: state.sceneIndex, total: scenePlayTotal(state.sceneIndex) };
  }
  return { mode: "video", scene: null, total: cachedVideoTimeline().total };
}

function isTransitionPreview() {
  return state.page === "scene" && isTransitionScene();
}

function audioKey() {
  const scope = playScope();
  const soundSig = (index) =>
    sceneSounds(index)
      .map((entry) => {
        const sound = normalizeSound(entry);
        return `${sound.file}@${sound.volume}`;
      })
      .join(",");
  const sceneSig = (index) => {
    const entry = scenes()[index];
    if (entry?.is_transition) {
      const timing = transitionTiming(entry);
      const z = ensureFadeZoom(entry);
      const s = z.include_start ? z.start || {} : {};
      const e = z.include_end ? z.end || {} : {};
      return `t:${entry.image || ""}:${timing.map}:${timing.zoom}:${transitionFadeSeconds(entry)}:${z.include_start ? 1 : 0}:${z.include_end ? 1 : 0}:${entry.transition_in || "fade"}:${s.x},${s.y},${s.w},${s.h}:${e.x},${e.y},${e.w},${e.h}`;
    }
    return (entry?.tracks || []).map(fileOf).join(",");
  };
  if (scope.mode === "scene") {
    return `${state.videoId}|scene:${scope.scene}|${sceneSig(scope.scene)}|${soundSig(scope.scene)}`;
  }
  return `${state.videoId}|video|${scenes()
    .map((entry, index) => `${sceneSig(index)}+${soundSig(index)}+t${entry.is_transition ? 1 : 0}`)
    .join("|")}`;
}

function audioSig(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 33 + key.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

function audioUrl() {
  const scope = playScope();
  const key = audioKey();
  const params = new URLSearchParams({ v: state.videoId, sig: audioSig(key) });
  if (scope.mode === "scene") params.set("scene", String(scope.scene));
  return { key, url: `/api/audio?${params}` };
}

/* ---------- player ---------- */

const audio = new Audio();
audio.preload = "none";
const player = { key: null, at: 0, playing: false, loading: false, total: 0 };
let scrubber = null;
let previewRaf = null; // silent transition-scene clock
let overlayRaf = null; // video-page playhead synced to audio each frame
let timelineCache = null;

function invalidateTimelineCache() {
  timelineCache = null;
}

function cachedVideoTimeline() {
  if (!timelineCache) timelineCache = videoTimeline();
  return timelineCache;
}

function stopPreviewClock() {
  if (previewRaf == null) return;
  cancelAnimationFrame(previewRaf);
  previewRaf = null;
}

function stopOverlayClock() {
  if (overlayRaf == null) return;
  cancelAnimationFrame(overlayRaf);
  overlayRaf = null;
}

function startPreviewClock() {
  stopPreviewClock();
  stopOverlayClock();
  const scope = playScope();
  const total = player.total || scope.total;
  if (!(total > 0)) return;
  const origin = performance.now() - player.at * 1000;
  const tick = (now) => {
    if (!player.playing) return;
    player.at = Math.min(total, (now - origin) / 1000);
    paintPlayhead();
    if (player.at >= total - 0.001) {
      player.playing = false;
      player.at = 0;
      stopPreviewClock();
      syncPlayButton();
      paintPlayhead();
      return;
    }
    previewRaf = requestAnimationFrame(tick);
  };
  previewRaf = requestAnimationFrame(tick);
}

/** Smooth video-page overlays (zoom/map) — audio timeupdate is only ~4Hz and looks choppy. */
function startOverlayClock() {
  stopOverlayClock();
  const tick = () => {
    if (!player.playing || isTransitionPreview()) {
      overlayRaf = null;
      return;
    }
    if (audio.getAttribute("src") && Number.isFinite(audio.currentTime)) {
      player.at = audio.currentTime;
      paintPlayhead();
    }
    overlayRaf = requestAnimationFrame(tick);
  };
  overlayRaf = requestAnimationFrame(tick);
}

/** Edit on the full map; only animate zoom while play is running. */
function syncSceneTransitionPreview() {
  if (!isTransitionPreview()) return;
  const still = document.querySelector(".stage .picture-still");
  const guides = document.querySelectorAll(".stage .fade-zoom-guide");
  if (!still) return;

  // Default / paused: full map so included Start/End targets can be placed.
  if (!player.playing) {
    applyFadeZoomStyle(still, null, 0);
    guides.forEach((guide) => guide.classList.remove("is-preview-hidden"));
    return;
  }

  const entry = scene();
  const timing = transitionTiming(entry);
  const hold = Math.max(0.001, timing.total);
  const at = Math.min(hold, Math.max(0, player.at));
  let zoomProgress = 0;
  let zoomRect = null;
  const fz = transitionStyleOf(entry) === "fade_zoom" ? ensureFadeZoom(entry) : null;
  if (at <= timing.outHold) {
    if (timing.hasStart && fz) {
      zoomRect = fz.start;
      zoomProgress =
        timing.startZoom > 0.001 ? 1 - Math.min(1, at / timing.startZoom) : 0;
    }
  } else if (timing.hasEnd && fz) {
    const local = at - timing.outHold;
    zoomRect = fz.end;
    zoomProgress =
      timing.endZoom > 0.001
        ? Math.min(1, Math.max(0, (local - timing.mapHalf) / timing.endZoom))
        : 0;
  }
  applyFadeZoomStyle(still, zoomRect, zoomProgress);
  guides.forEach((guide) => guide.classList.add("is-preview-hidden"));
}

function syncSource() {
  if (state.page === "list") return;
  const { key } = audioUrl();
  if (player.key === key) return;
  stopPreviewClock();
  stopOverlayClock();
  player.key = key;
  player.at = 0;
  player.playing = false;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  if (isTransitionPreview()) player.total = playScope().total;
}

function syncPlayButton() {
  const btn = document.querySelector(".player .play");
  if (!btn) return;
  btn.title = player.playing ? "Pause" : "Play";
  btn.textContent = player.loading ? "\u2026" : player.playing ? "\u23f8" : "\u25b6";
}

async function togglePlay() {
  const scope = playScope();
  if (!scope.total) return;
  if (player.playing) {
    if (isTransitionPreview()) {
      stopPreviewClock();
      player.playing = false;
      player.at = 0;
      syncPlayButton();
      paintPlayhead();
      return;
    }
    audio.pause();
    return;
  }

  clearTimeout(saveTimer);
  await save();

  // Transitions have no playlist — clock the map hold so animations/zoom can be tested.
  if (isTransitionPreview()) {
    player.key = audioKey();
    player.total = scope.total;
    player.loading = false;
    // Always begin from the Start zoom (full-map edit view → play zooms in).
    player.at = 0;
    player.playing = true;
    syncPlayButton();
    syncSceneTransitionPreview();
    startPreviewClock();
    return;
  }

  const { key, url } = audioUrl();
  if (player.key !== key || audio.getAttribute("src") !== url) {
    player.key = key;
    player.at = 0;
    player.loading = true;
    syncPlayButton();
    audio.src = url;
  }
  try {
    await audio.play();
  } catch {
    player.loading = false;
    state.note = "Could not play the mix";
    render();
  }
}

function seekTo(seconds) {
  const scope = playScope();
  const total = player.total || scope.total;
  const at = Math.min(Math.max(seconds, 0), total || 0);
  player.at = at;
  if (isTransitionPreview()) {
    if (player.playing) startPreviewClock();
    else paintPlayhead();
    return;
  }
  if (audio.getAttribute("src") && audio.readyState > 0) audio.currentTime = at;
  paintPlayhead();
}

audio.addEventListener("playing", () => {
  player.playing = true;
  player.loading = false;
  syncPlayButton();
  if (!isTransitionPreview()) startOverlayClock();
});
audio.addEventListener("pause", () => {
  player.playing = false;
  stopOverlayClock();
  syncPlayButton();
});
audio.addEventListener("ended", () => {
  player.playing = false;
  player.at = 0;
  stopOverlayClock();
  syncPlayButton();
  paintPlayhead();
});
audio.addEventListener("loadedmetadata", () => {
  if (Number.isFinite(audio.duration)) player.total = audio.duration;
  if (player.at) audio.currentTime = player.at;
});
audio.addEventListener("timeupdate", () => {
  // While the overlay clock is running, rAF owns the playhead (smoother zoom).
  if (overlayRaf != null) return;
  player.at = audio.currentTime;
  paintPlayhead();
});

function paintPlayhead() {
  if (scrubber) {
    const scope = playScope();
    const length = player.total || scope.total || 1;
    const fraction = Math.min(player.at / length, 1);
    scrubber.fill.style.width = `${fraction * 100}%`;
    scrubber.knob.style.left = `${fraction * 100}%`;
    scrubber.elapsed.textContent = clock(player.at);

    if (scope.mode === "video") {
      const activeItem = activeVideoItem();
      const activeIndex = activeItem?.index ?? -1;
      scrubber.cards?.forEach((card) =>
        card.classList.toggle("playing", Number(card.dataset.sceneIndex) === activeIndex)
      );
    } else {
      const { list } = sceneSequence(state.sceneIndex);
      let songActive = -1;
      list.forEach((song, index) => {
        if (player.at >= song.start - 0.001) songActive = index;
      });
      scrubber.rows?.forEach((row, index) => row.classList.toggle("playing", index === songActive));
    }
  }
  paintOverlays();
  syncSceneTransitionPreview();
}

function windowOpacity(start, showSeconds, at) {
  const end = start + showSeconds;
  if (at < start || at >= end) return 0;
  if (at < start + OVERLAY_FADE) return (at - start) / OVERLAY_FADE;
  if (at > end - OVERLAY_FADE) return Math.max(0, (end - at) / OVERLAY_FADE);
  return 1;
}

function currentSongAt(at, list) {
  let song = list[0] || null;
  list.forEach((entry) => {
    if (at >= entry.start - 0.001) song = entry;
  });
  return song;
}

function songOverlayOpacity(at, list, showSeconds) {
  let best = 0;
  list.forEach((song) => {
    best = Math.max(best, windowOpacity(song.start, showSeconds, at));
  });
  return best;
}

function paintOverlays() {
  if (!overlayUi || state.page !== "video") return;
  const overlays = ensureOverlays();
  const list = videoSongs();
  const at = player.at;
  const playing = player.playing;

  if (overlayUi.still) {
    const item = activeVideoItem(at);
    const path = item?.image && !item.missing ? item.image : "";
    if (path && overlayUi.still.dataset.path !== path) {
      overlayUi.still.dataset.path = path;
      const wide = state.pictureExpanded ? 1600 : 1200;
      overlayUi.still.style.backgroundImage = `url(/thumb?path=${encodeURIComponent(path)}&w=${wide})`;
      overlayUi.still.classList.remove("blank");
    } else if (!path && overlayUi.still.dataset.path !== "") {
      overlayUi.still.dataset.path = "";
      overlayUi.still.style.backgroundImage = "";
      overlayUi.still.classList.add("blank");
    }
  }

  if (overlayUi.map) {
    const overlay = transitionOverlayAt(at);
    const path = overlay?.path || "";
    const opacity = overlay?.opacity ?? 0;
    if (path && overlayUi.map.dataset.path !== path) {
      overlayUi.map.dataset.path = path;
      const wide = state.pictureExpanded ? 1600 : 1200;
      overlayUi.map.style.backgroundImage = `url(/thumb?path=${encodeURIComponent(path)}&w=${wide})`;
    } else if (!path && overlayUi.map.dataset.path !== "") {
      overlayUi.map.dataset.path = "";
      overlayUi.map.style.backgroundImage = "";
    }
    overlayUi.map.style.opacity = String(opacity);
    overlayUi.map.classList.toggle("is-hidden", opacity <= 0.01);
    if (overlay?.zoomRect && opacity > 0.01) {
      applyFadeZoomStyle(overlayUi.map, overlay.zoomRect, overlay.zoomProgress ?? 0);
    } else {
      applyFadeZoomStyle(overlayUi.map, null, 0);
    }
  }

  syncVideoPreviewMotion(at);

  if (overlayUi.songTitle) {
    const song = currentSongAt(at, list);
    const title = song?.title || "Song title";
    if (overlayUi.songTitle.textContent !== title) overlayUi.songTitle.textContent = title;
  }
  if (overlayUi.songFrom) {
    const from = `Streaming from ${overlays.now_playing.streaming_from}`;
    if (overlayUi.songFrom.textContent !== from) overlayUi.songFrom.textContent = from;
  }

  if (overlayUi.credit) {
    let creditOp = overlays.credit.enabled
      ? playing
        ? windowOpacity(0, overlays.credit.show_seconds, at)
        : 1
      : 0;
    if (state.selectedOverlay === "credit") creditOp = Math.max(creditOp, 0.45);
    overlayUi.credit.style.opacity = String(creditOp);
    overlayUi.credit.classList.toggle(
      "is-hidden",
      creditOp <= 0.01 && state.selectedOverlay !== "credit"
    );
  }

  if (overlayUi.song) {
    let songOp = 0;
    if (overlays.now_playing.enabled) {
      songOp = playing
        ? list.length
          ? songOverlayOpacity(at, list, overlays.now_playing.show_seconds)
          : 0
        : 1;
    }
    if (state.selectedOverlay === "now_playing") songOp = Math.max(songOp, 0.45);
    overlayUi.song.style.opacity = String(songOp);
    overlayUi.song.classList.toggle(
      "is-hidden",
      songOp <= 0.01 && state.selectedOverlay !== "now_playing"
    );
  }
}

/* ---------- persistence ---------- */

function changed() {
  render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}

async function save() {
  if (!state.videoId || !state.script) return;
  state.saving = true;
  paintDetailsSave();
  const response = await fetch(withVideo("/api/script"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.script),
  });
  state.saving = false;
  state.note = response.ok ? "" : "Could not save";
  if (response.ok) {
    state.detailsDirty = false;
    await refreshOutputs();
  }
  render();
}

function detailsComplete() {
  if (!state.script) return false;
  ensureCreativeBrief();
  const feeling = (state.script.feeling || "").trim();
  const prompt = (state.script.prompt || "").trim();
  const music = (state.script.music_prompt || "").trim();
  const destinations = (state.script.destinations || []).some((place) => String(place).trim());
  return Boolean(feeling && prompt && music && destinations);
}

function sceneDetailsComplete(entry = scene()) {
  ensureSceneBrief(entry);
  if (entry.is_transition) return Boolean((entry.image_prompt || "").trim() || entry.image);
  return Boolean((entry.image_prompt || "").trim() && (entry.music_prompt || "").trim());
}

function briefLabel(text, required = false) {
  return h(
    "span",
    { class: "brief-label" },
    text,
    required && h("span", { class: "req", text: "*", title: "Required" })
  );
}

function briefCopyButton(getText, title = "Copy", label = "Copy") {
  return h(
    "button",
    {
      class: "btn ghost brief-copy",
      type: "button",
      title,
      onClick: async (event) => {
        const text = getText() || "";
        const btn = event.currentTarget;
        const original = label;
        try {
          await navigator.clipboard.writeText(text);
          btn.textContent = "Copied";
          setTimeout(() => {
            if (btn.isConnected) btn.textContent = original;
          }, 1200);
        } catch {
          state.note = "Could not copy";
          render();
        }
      },
    },
    label
  );
}

function joinPrompts(...parts) {
  return parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

function fullSceneImagePrompt(entry = scene()) {
  ensureCreativeBrief();
  ensureSceneBrief(entry);
  return joinPrompts(
    state.script.prompt,
    entry.title?.trim() ? `Scene: ${entry.title.trim()}` : "",
    entry.image_prompt
  );
}

function fullSceneMusicPrompt(entry = scene()) {
  ensureCreativeBrief();
  ensureSceneBrief(entry);
  return joinPrompts(
    state.script.music_prompt,
    entry.title?.trim() ? `Scene: ${entry.title.trim()}` : "",
    entry.music_prompt
  );
}

function markDetailsDirty() {
  if (!state.detailsDirty) state.detailsDirty = true;
  paintDetailsChrome();
}

function paintDetailsSave() {
  paintDetailsChrome();
}

function paintDetailsChrome() {
  document.querySelectorAll(".details-save").forEach((btn) => {
    const dirty = state.detailsDirty;
    btn.disabled = !dirty || state.saving;
    btn.classList.toggle("primary", dirty);
    btn.classList.toggle("ghost", !dirty);
    btn.textContent = state.saving ? "Saving…" : dirty ? "Save" : "Saved";
  });
  const videoStatus = document.querySelector(".creative-brief:not(.scene-brief) .details-status");
  if (videoStatus) {
    const complete = detailsComplete();
    videoStatus.textContent = complete ? "Complete" : "Incomplete";
    videoStatus.classList.toggle("is-complete", complete);
    videoStatus.classList.toggle("is-incomplete", !complete);
  }
  const sceneStatus = document.querySelector(".scene-brief .details-status");
  if (sceneStatus) {
    const complete = sceneDetailsComplete();
    sceneStatus.textContent = complete ? "Complete" : "Incomplete";
    sceneStatus.classList.toggle("is-complete", complete);
    sceneStatus.classList.toggle("is-incomplete", !complete);
  }
}

function hasOutput(output) {
  return Boolean(output?.exists || output?.ready);
}

function outputTag(output) {
  if (!hasOutput(output)) return null;
  return h("span", {
    class: "ready-tag is-ready",
    text: "Rendered",
    title: output.name ? `Saved as out/${output.name}` : "Ready to stitch",
  });
}

function sceneOutput(index) {
  return state.outputs?.scenes?.[String(index + 1)] || null;
}

function videoOutputSummary(video) {
  const outputs = video.outputs || {};
  const full = outputs.video;
  if (hasOutput(full)) return outputTag(full);
  const scenes = Object.values(outputs.scenes || {});
  const rendered = scenes.filter((scene) => hasOutput(scene)).length;
  if (rendered > 0) {
    return h("span", {
      class: "ready-tag is-ready",
      text: `${rendered}/${scenes.length} scenes`,
      title: "Scene renders in out/",
    });
  }
  return null;
}

async function loadVideos() {
  const data = await (await fetch("/api/videos")).json();
  state.videos = data.videos || [];
}

async function loadVideo(videoId) {
  const response = await fetch(`/api/state?v=${encodeURIComponent(videoId)}`);
  if (!response.ok) return false;
  const data = await response.json();
  state.videoId = data.id;
  state.script = data.script;
  state.assets = data.assets;
  state.outputs = data.outputs;
  state.render = data.render;
  state.detailsDirty = false;
  state.detailsOpen = false;
  state.sceneDetailsOpen = false;
  ensureScript();
  return true;
}

async function refreshOutputs() {
  if (!state.videoId) return;
  const data = await (await fetch(withVideo("/api/state"))).json();
  state.outputs = data.outputs;
  state.render = data.render;
  if (data.assets) state.assets = data.assets;
}

let lastRenderStatus = "idle";

function resetRenderEta() {
  renderEtaSamples = [];
  state.renderEta = null;
}

function noteRenderProgress(percent) {
  const now = Date.now();
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  const last = renderEtaSamples[renderEtaSamples.length - 1];
  if (!last || value > last.percent + 0.15) {
    renderEtaSamples.push({ t: now, percent: value });
    if (renderEtaSamples.length > 40) renderEtaSamples.shift();
  }
  state.renderEta = estimateRenderEta(value);
}

function estimateRenderEta(percent) {
  if (percent >= 99) return 0;
  if (renderEtaSamples.length < 2) return null;
  const samples = renderEtaSamples.length >= 4 ? renderEtaSamples.slice(-8) : renderEtaSamples;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dp = last.percent - first.percent;
  const dt = (last.t - first.t) / 1000;
  if (dp < 0.4 || dt < 1) return null;
  return Math.max(0, (100 - percent) / (dp / dt));
}

function formatClockTime(date) {
  const hours = date.getHours();
  const mins = String(date.getMinutes()).padStart(2, "0");
  const h12 = hours % 12 || 12;
  const ampm = hours >= 12 ? "PM" : "AM";
  return `${h12}:${mins} ${ampm}`;
}

function formatRenderEta(seconds) {
  if (seconds === 0) return "Finishing…";
  if (seconds == null || !Number.isFinite(seconds)) return "Calculating…";
  const total = Math.max(1, Math.ceil(seconds));
  const minutes = Math.max(1, Math.ceil(total / 60));
  const left = minutes === 1 ? "~1 min left" : `~${minutes} min left`;
  const eta = formatClockTime(new Date(Date.now() + total * 1000));
  return `${left} · ${eta}`;
}

async function generate(sceneNumber = null) {
  clearTimeout(saveTimer);
  await save();
  resetRenderEta();
  const response = await fetch(withVideo("/api/render"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sceneNumber ? { scene: sceneNumber } : {}),
  });
  state.render = await response.json();
  lastRenderStatus = state.render.status;
  if (state.render.status === "running") noteRenderProgress(state.render.percent || 0);
  render();
  poll();
}

async function stopGenerate() {
  const response = await fetch("/api/render/stop", { method: "POST" });
  state.render = await response.json();
  lastRenderStatus = state.render.status;
  resetRenderEta();
  render();
}

function downloadOutput(sceneNumber = null) {
  let url = `/download?v=${encodeURIComponent(state.videoId)}`;
  if (sceneNumber) url += `&scene=${sceneNumber}`;
  window.location.href = url;
}

function downloadSceneImage() {
  const path = scene()?.image;
  if (!path) return;
  const name = path.split("/").pop() || "scene.png";
  window.location.href = `/download-asset?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`;
}

function poll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    state.render = await (await fetch("/api/render")).json();
    lastRenderStatus = state.render.status;
    if (state.render.status === "running") {
      noteRenderProgress(state.render.percent || 0);
    }
    if (state.render.status === "done") {
      resetRenderEta();
      await refreshOutputs();
    }
    if (state.render.status === "error" || state.render.status === "idle") {
      resetRenderEta();
    }
    render();
    if (state.render.status === "running") poll();
  }, 500);
}

/* ---------- chrome ---------- */

function breadcrumbs() {
  const crumbs = [h("a", { class: "crumb", href: "/videos", onClick: (event) => { event.preventDefault(); go("list"); }, text: "Videos" })];

  if (state.page !== "list" && state.script) {
    crumbs.push(h("span", { class: "sep", text: "/" }));
    crumbs.push(
      h("a", {
        class: "crumb",
        href: `/video?v=${encodeURIComponent(state.videoId)}`,
        onClick: (event) => {
          event.preventDefault();
          go("video", { videoId: state.videoId });
        },
        text: state.script.project || state.videoId,
      })
    );
  }

  if (state.page === "scene" && state.script) {
    crumbs.push(h("span", { class: "sep", text: "/" }));
    crumbs.push(h("span", { class: "crumb current", text: scene().title || `Scene ${state.sceneIndex + 1}` }));
  }

  return h("nav", { class: "breadcrumbs" }, crumbs);
}

function topbar(actions = []) {
  return h(
    "header",
    { class: "topbar" },
    breadcrumbs(),
    h("span", { class: "spacer" }),
    state.note && h("span", { class: "meta warn", text: state.note }),
    state.saving && h("span", { class: "meta", text: "Saving…" }),
    ...actions
  );
}

function sceneDownloadIconButton(sceneNumber, sceneOut) {
  const ready = hasOutput(sceneOut);
  return h(
    "button",
    {
      class: "btn ghost icon-btn",
      type: "button",
      disabled: !ready,
      title: ready ? sceneOut.name || "Download video" : "Process first to download",
      "aria-label": ready ? "Download video" : "Process first to download",
      onClick: () => {
        if (!ready) return;
        downloadOutput(sceneNumber);
      },
    },
    downloadIcon()
  );
}

function exportActions({ sceneMode = false } = {}) {
  const busy = state.render.status === "running" && state.render.video === state.videoId;
  const { total } = videoTimeline();
  const sceneTotal = sceneSequence(state.sceneIndex).total;
  const sceneNumber = state.sceneIndex + 1;
  const sceneOut = sceneOutput(state.sceneIndex);
  const videoOut = state.outputs?.video;
  const transition = sceneMode && isTransitionScene();

  if (busy) {
    const label =
      state.render.kind === "scene"
        ? `Stop scene ${state.render.percent}%`
        : `Stop video ${state.render.percent}%`;
    const actions = [];
    if (sceneMode && !transition) {
      actions.push(sceneDownloadIconButton(sceneNumber, sceneOut));
    } else if (!sceneMode && hasOutput(videoOut)) {
      actions.push(
        h(
          "button",
          {
            class: "btn ghost",
            type: "button",
            title: videoOut.name || "Download video",
            "aria-label": "Download video",
            onClick: () => downloadOutput(),
          },
          "Download"
        )
      );
    }
    actions.push(
      h("span", {
        class: "meta render-eta",
        text: formatRenderEta(state.renderEta),
        title: "Estimated time left and finish time",
      })
    );
    actions.push(
      h(
        "button",
        {
          class: "btn stop",
          type: "button",
          title: "Stop rendering",
          onClick: () => stopGenerate(),
          text: label,
        }
      )
    );
    return actions;
  }

  if (sceneMode) {
    return [
      h(
        "button",
        {
          class: "btn primary",
          disabled: transition || !sceneTotal,
          title: transition
            ? "Transitions bake into neighboring scenes — use Process Video"
            : "Render this scene only",
          onClick: () => generate(sceneNumber),
        },
        "Process Scene"
      ),
      transition
        ? null
        : h(
            "button",
            {
              class: "btn ghost",
              type: "button",
              disabled: !hasOutput(sceneOut),
              title: hasOutput(sceneOut)
                ? sceneOut.name || "Download this scene"
                : "Process Scene first",
              onClick: () => {
                if (!hasOutput(sceneOut)) return;
                downloadOutput(sceneNumber);
              },
            },
            "Download"
          ),
    ].filter(Boolean);
  }

  return [downloadVideoControl(), generateVideoButton(total, videoOut)];
}

function renderGateItems() {
  const items = scenes()
    .map((entry, index) =>
      entry.is_transition
        ? null
        : {
            key: `scene-${index}`,
            label: entry.title?.trim() || `Scene ${index + 1}`,
            ready: hasOutput(sceneOutput(index)),
          }
    )
    .filter(Boolean);
  items.push({
    key: "video",
    label: "Full video",
    ready: hasOutput(state.outputs?.video),
  });
  return items;
}

function downloadVideoControl() {
  const ready = hasOutput(state.outputs?.video);
  const items = renderGateItems();
  const pending = items.filter((item) => !item.ready);

  if (ready) {
    return h(
      "button",
      {
        class: "btn ghost",
        type: "button",
        title: state.outputs.video.name || "Download video",
        onClick: () => downloadOutput(),
      },
      "Download"
    );
  }

  return h(
    "div",
    { class: "download-gate" },
    h(
      "button",
      {
        class: "btn ghost",
        type: "button",
        disabled: true,
        text: "Download",
      }
    ),
    h(
      "div",
      { class: "download-gate-menu", role: "status" },
      h("p", { class: "download-gate-title", text: "Please process these first" }),
      h(
        "ul",
        { class: "download-gate-list" },
        items.map((item) =>
          h(
            "li",
            { class: item.ready ? "is-ready" : "is-pending" },
            h("span", {
              class: "download-gate-check",
              "aria-hidden": true,
              text: item.ready ? "✓" : "○",
            }),
            h("span", { class: "download-gate-label", text: item.label })
          )
        )
      ),
      pending.length > 0 &&
        h("p", {
          class: "download-gate-hint",
          text:
            pending.length === 1 && pending[0].key === "video"
              ? "Process Video to unlock download."
              : "Process each scene, then Process Video.",
        })
    )
  );
}

function generateVideoButton(total, videoOut) {
  return h(
    "button",
    {
      class: "btn primary",
      disabled: !total,
      title: hasOutput(videoOut) ? videoOut.name || "Re-render full video" : "Render full video",
      onClick: () => generate(),
    },
    "Process Video"
  );
}

/* ---------- views ---------- */

const app = document.getElementById("app");

const SCROLL_SELS = [".stage", ".video-page", ".library", ".library.tools"];

function captureScroll() {
  return {
    winX: window.scrollX,
    winY: window.scrollY,
    panels: SCROLL_SELS.map((sel) => {
      const el = document.querySelector(sel);
      return el ? { sel, top: el.scrollTop, left: el.scrollLeft } : null;
    }).filter(Boolean),
  };
}

function restoreScroll(saved) {
  if (!saved) return;
  window.scrollTo(saved.winX, saved.winY);
  for (const panel of saved.panels) {
    const el = document.querySelector(panel.sel);
    if (!el) continue;
    el.scrollTop = panel.top;
    el.scrollLeft = panel.left;
  }
}

function isTypingFocus(el) {
  if (!el || el === document.body || el === document.documentElement) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (el.type || "text").toLowerCase();
  return ![
    "checkbox",
    "radio",
    "button",
    "submit",
    "reset",
    "file",
    "range",
    "color",
    "hidden",
  ].includes(type);
}

function render() {
  // Don't rebuild the tree while a text field is focused — replaceChildren
  // steals the caret (scene title, rename, briefs, etc. after autosave).
  if (isTypingFocus(document.activeElement)) return;

  invalidateTimelineCache();
  const savedScroll = captureScroll();

  scrubber = null;
  if (state.page !== "list" && state.page !== "landing") {
    ensureScript();
    syncSource();
  }

  app.classList.toggle("shell--landing", state.page === "landing");
  if (state.page !== "scene" && state.page !== "video") {
    state.pictureExpanded = false;
    app.classList.remove("is-expanded");
  }
  if (state.page !== "video") overlayUi = null;

  if (state.page === "landing") app.replaceChildren(landingView());
  else if (state.page === "list") app.replaceChildren(listView());
  else if (state.page === "scene") app.replaceChildren(sceneView());
  else app.replaceChildren(videoView());

  restoreScroll(savedScroll);
  // Layout can settle after the first paint; restore again so we don't jump to top.
  requestAnimationFrame(() => restoreScroll(savedScroll));

  paintPlayhead();
}

function landingView() {
  return h(
    "section",
    { class: "landing", "aria-label": "Cozy Journeys" },
    h("div", {
      class: "landing-bg",
      style: {
        backgroundImage:
          "url(/thumb?path=" + encodeURIComponent("assets/images/harvest-festival.png") + "&w=1600)",
      },
      "aria-hidden": "true",
    }),
    h("div", { class: "landing-veil", "aria-hidden": "true" }),
    h(
      "div",
      { class: "landing-copy" },
      h("h1", { class: "landing-title", text: "Live in Your Dream World" }),
      h(
        "a",
        {
          class: "landing-cta",
          href: "/video?v=riverbend",
          onClick: (event) => {
            event.preventDefault();
            go("video", { videoId: "riverbend" });
          },
          text: "Enter",
        }
      )
    )
  );
}

function listView() {
  return h(
    "div",
    { class: "shell-inner" },
    topbar(),
    h(
      "div",
      { class: "video-page" },
      h("h1", { class: "page-title", text: "Videos" }),
      h("p", { class: "page-blurb", text: "Pick a video to arrange its scenes." }),
      h(
        "div",
        { class: "video-list" },
        state.videos.length
          ? state.videos.map((video) =>
              h(
                "button",
                {
                  class: "video-row",
                  type: "button",
                  onClick: () => go("video", { videoId: video.id }),
                },
                h("div", {
                  class: `video-thumb${video.thumb ? "" : " blank"}`,
                  style: video.thumb
                    ? { backgroundImage: `url(/thumb?path=${encodeURIComponent(video.thumb)}&w=240)` }
                    : {},
                }),
                h(
                  "div",
                  { class: "video-meta" },
                  h("span", { class: "name", text: video.title }),
                  h("span", {
                    class: "len",
                    text: `${video.scenes} scene${video.scenes === 1 ? "" : "s"} · ${clock(video.duration)}`,
                  })
                ),
                videoOutputSummary(video)
              )
            )
          : h("p", { class: "empty-note", text: "No videos yet — add a JSON file to videos/" })
      )
    )
  );
}

function sceneDetails() {
  const entry = ensureSceneBrief();
  const dirty = state.detailsDirty;
  const open = state.sceneDetailsOpen;
  const complete = sceneDetailsComplete(entry);

  return h(
    "div",
    { class: `creative-brief scene-brief${open ? " is-open" : ""}` },
    h(
      "button",
      {
        class: "details-toggle",
        type: "button",
        "aria-expanded": open ? "true" : "false",
        onClick: () => {
          state.sceneDetailsOpen = !state.sceneDetailsOpen;
          render();
        },
      },
      h(
        "span",
        { class: "details-toggle-label" },
        h("span", { class: "details-chevron", "aria-hidden": true, text: open ? "▾" : "▸" }),
        h("span", { text: "Scene details" })
      ),
      h("span", {
        class: `details-status${complete ? " is-complete" : " is-incomplete"}`,
        text: complete ? "Complete" : "Incomplete",
      })
    ),
    open &&
      h(
        "div",
        { class: "brief-body" },
        h(
          "div",
          { class: "brief-head" },
          h("span", {
            class: "meta",
            text: entry.is_transition
              ? "Map/still for this overlay — neighboring scenes keep their full songs"
              : "Prompts for generating this scene’s still and songs",
          }),
          h(
            "button",
            {
              class: `btn details-save${dirty ? " primary" : " ghost"}`,
              type: "button",
              disabled: !dirty || state.saving,
              onClick: () => save(),
            },
            state.saving ? "Saving…" : dirty ? "Save" : "Saved"
          )
        ),
        h(
          "div",
          { class: "brief-field" },
          h(
            "div",
            { class: "brief-label-row" },
            briefLabel("Image prompt", !entry.is_transition),
            h(
              "span",
              { class: "brief-copy-group" },
              briefCopyButton(() => entry.image_prompt || "", "Copy this scene’s image note only"),
              briefCopyButton(
                () => fullSceneImagePrompt(entry),
                "Copy full image prompt (episode + scene) for generating this still",
                "Copy full"
              )
            )
          ),
          h("p", {
            class: "brief-hint",
            text: "What we see here — Copy full includes the episode house style.",
          }),
          h("textarea", {
            class: "brief-input destination-prompt",
            rows: 4,
            value: entry.image_prompt || "",
            placeholder: "Describe this stop’s picture — appends to the episode image prompt.",
            onInput: (event) => {
              entry.image_prompt = event.target.value;
              markDetailsDirty();
            },
          })
        ),
        !entry.is_transition &&
          h(
            "div",
            { class: "brief-field" },
            h(
              "div",
              { class: "brief-label-row" },
              briefLabel("Music prompt", true),
              h(
                "span",
                { class: "brief-copy-group" },
                briefCopyButton(() => entry.music_prompt || "", "Copy this scene’s music note only"),
                briefCopyButton(
                  () => fullSceneMusicPrompt(entry),
                  "Copy full music prompt (episode + scene) for this scene’s songs",
                  "Copy full"
                )
              )
            ),
            h("p", {
              class: "brief-hint",
              text: "What we hear here — Copy full includes the episode music prompt.",
            }),
            h("textarea", {
              class: "brief-input destination-prompt",
              rows: 4,
              value: entry.music_prompt || "",
              placeholder: "Songs, texture, and energy for this stop.",
              onInput: (event) => {
                entry.music_prompt = event.target.value;
                markDetailsDirty();
              },
            })
          )
      )
  );
}

function creativeBrief() {
  ensureCreativeBrief();
  const cast = state.script.cast;
  const dirty = state.detailsDirty;
  const open = state.detailsOpen;
  const complete = detailsComplete();

  return h(
    "div",
    { class: `creative-brief${open ? " is-open" : ""}` },
    h(
      "button",
      {
        class: "details-toggle",
        type: "button",
        "aria-expanded": open ? "true" : "false",
        onClick: () => {
          state.detailsOpen = !state.detailsOpen;
          render();
        },
      },
      h(
        "span",
        { class: "details-toggle-label" },
        h("span", { class: "details-chevron", "aria-hidden": true, text: open ? "▾" : "▸" }),
        h("span", { text: "Video details" })
      ),
      h("span", {
        class: `details-status${complete ? " is-complete" : " is-incomplete"}`,
        text: complete ? "Complete" : "Incomplete",
      })
    ),
    open &&
      h(
        "div",
        { class: "brief-body" },
        h(
          "div",
          { class: "brief-head" },
          h("span", { class: "meta", text: "Episode brief for writing and art" }),
          h(
            "button",
            {
              class: `btn details-save${dirty ? " primary" : " ghost"}`,
              type: "button",
              disabled: !dirty || state.saving,
              onClick: () => save(),
            },
            state.saving ? "Saving…" : dirty ? "Save" : "Saved"
          )
        ),
        h(
          "label",
          { class: "brief-field" },
          briefLabel("Desired feeling", true),
          h("textarea", {
            class: "brief-input",
            rows: 3,
            value: state.script.feeling || "",
            placeholder:
              "What are you trying to express — how should this feel to the viewer? The melancholy but excitement of fall, quiet anticipation before rain, etc.",
            onInput: (event) => {
              state.script.feeling = event.target.value;
              markDetailsDirty();
            },
          })
        ),
        h(
          "div",
          { class: "brief-field" },
          h(
            "div",
            { class: "brief-label-row" },
            briefLabel("Image prompt", true),
            briefCopyButton(() => state.script.prompt || "", "Copy image prompt")
          ),
          h("p", {
            class: "brief-hint",
            text: "House style for every still — each scene adds its own place details.",
          }),
          h("textarea", {
            class: "brief-input brief-prompt",
            rows: 8,
            value: state.script.prompt || "",
            placeholder: "Use the feeling above to tune this house style for the episode.",
            onInput: (event) => {
              state.script.prompt = event.target.value;
              markDetailsDirty();
            },
          })
        ),
        h(
          "div",
          { class: "brief-field" },
          h(
            "div",
            { class: "brief-label-row" },
            briefLabel("Music prompt", true),
            briefCopyButton(() => state.script.music_prompt || "", "Copy music prompt")
          ),
          h("p", {
            class: "brief-hint",
            text: "Episode-wide playlist direction — each scene can get more specific.",
          }),
          h("textarea", {
            class: "brief-input brief-prompt",
            rows: 5,
            value: state.script.music_prompt || "",
            placeholder:
              "Describe the playlist mood — instrumentation, tempo, era, and how it should carry the feeling.",
            onInput: (event) => {
              state.script.music_prompt = event.target.value;
              markDetailsDirty();
            },
          })
        ),
        h(
          "div",
          { class: "brief-field" },
          briefLabel("Destinations", true),
          h("p", {
            class: "brief-hint",
            text: "Definite places this episode visits — open a scene for its prompts.",
          }),
          h(
            "div",
            { class: "destination-list" },
            state.script.destinations.map((place, index) =>
              h(
                "div",
                { class: "destination-row" },
                h("span", { class: "destination-index", text: String(index + 1) }),
                h("input", {
                  class: "destination-input",
                  type: "text",
                  value: place,
                  placeholder:
                    index === 0
                      ? "Riverbend Station"
                      : index === 1
                        ? "The coffee shop on Main"
                        : "Campfire overlook",
                  onInput: (event) => {
                    state.script.destinations[index] = event.target.value;
                    markDetailsDirty();
                  },
                  onKeydown: (event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      state.script.destinations.splice(index + 1, 0, "");
                      markDetailsDirty();
                      render();
                      queueMicrotask(() => {
                        const inputs = document.querySelectorAll(".destination-input");
                        inputs[index + 1]?.focus();
                      });
                    }
                  },
                }),
                h(
                  "button",
                  {
                    class: "destination-remove",
                    type: "button",
                    title: "Remove destination",
                    disabled: state.script.destinations.length === 1 && !place,
                    onClick: () => {
                      if (state.script.destinations.length === 1) {
                        state.script.destinations[0] = "";
                      } else {
                        state.script.destinations.splice(index, 1);
                      }
                      markDetailsDirty();
                      render();
                    },
                  },
                  trashIcon()
                )
              )
            )
          ),
          h(
            "button",
            {
              class: "btn ghost destination-add",
              type: "button",
              onClick: () => {
                state.script.destinations.push("");
                markDetailsDirty();
                render();
                queueMicrotask(() => {
                  const inputs = document.querySelectorAll(".destination-input");
                  inputs[inputs.length - 1]?.focus();
                });
              },
            },
            "+  Add destination"
          )
        ),
        h(
          "div",
          { class: "brief-field" },
          briefLabel("Cast"),
          h("p", {
            class: "brief-hint",
            text: "These will appear in each scene like an iSpy book. Leave blank if not desired.",
          }),
          h(
            "div",
            { class: "cast-grid" },
            cast.map((member, index) => castSlot(member, index))
          )
        )
      )
  );
}

function castSlot(member, index) {
  const input = h("input", {
    class: "file-input",
    type: "file",
    accept: "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp",
    onChange: async (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      await uploadCastImage(index, file);
    },
  });
  const hasImage = Boolean(member.image);

  return h(
    "div",
    { class: `cast-slot${hasImage ? " filled" : ""}` },
    h(
      "button",
      {
        class: `cast-thumb${hasImage ? "" : " blank"}`,
        type: "button",
        title: hasImage ? "Replace cast image" : "Add cast image",
        style: hasImage
          ? { backgroundImage: `url(/thumb?path=${encodeURIComponent(member.image)}&w=280)` }
          : {},
        onClick: () => input.click(),
      },
      !hasImage && h("span", { text: "Add" })
    ),
    h("input", {
      class: "cast-note",
      type: "text",
      value: member.note || "",
      placeholder: `Character ${index + 1}`,
      onInput: (event) => {
        member.note = event.target.value;
        markDetailsDirty();
      },
    }),
    hasImage &&
      h(
        "button",
        {
          class: "cast-clear",
          type: "button",
          title: "Clear this cast slot",
          onClick: () => {
            member.image = "";
            member.note = member.note || "";
            markDetailsDirty();
            render();
          },
        },
        "Clear"
      ),
    input
  );
}

async function uploadCastImage(index, file) {
  ensureCreativeBrief();
  state.note = `Uploading ${file.name}…`;
  render();
  try {
    const response = await fetch(
      `/api/asset?kind=${encodeURIComponent("images")}&name=${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      }
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Upload failed");
    await refreshOutputs();
    ensureCreativeBrief();
    state.script.cast[index].image = data.path || "";
    state.note = "";
    markDetailsDirty();
    render();
  } catch (error) {
    state.note = error.message || "Upload failed";
    render();
  }
}

function videoView() {
  const { items, total } = videoTimeline();
  const bar = playerBar(total, "video");
  app.classList.toggle("is-expanded", state.pictureExpanded);

  return h(
    "div",
    { class: "shell-inner" },
    topbar(exportActions()),
    h(
      "div",
      { class: "video-page" },
      h(
        "div",
        { class: "page-title-row" },
        h("h1", { class: "page-title", text: state.script.project || state.videoId }),
        outputTag(state.outputs?.video)
      ),
      h("p", {
        class: "page-blurb",
        text: "Scenes play one after another. Place lower thirds on the preview, then open a scene to edit it.",
      }),
      creativeBrief(),
      videoPreview(),
      overlayToggles(),
      bar,
      renderStatus(),
      h(
        "div",
        { class: "sequence-head" },
        h("span", { text: "Scenes" }),
        h(
          "span",
          { class: "meta" },
          (() => {
            const normalIndexes = scenes()
              .map((scene, index) => (!scene.is_transition ? index : -1))
              .filter((index) => index >= 0);
            const ready = normalIndexes.filter((index) => hasOutput(sceneOutput(index))).length;
            const parts = [clock(total)];
            if (ready) parts.push(`${ready}/${normalIndexes.length} rendered`);
            return parts.join(" · ");
          })()
        )
      ),
      sceneTimeline(items),
      h(
        "button",
        {
          class: "btn ghost add",
          type: "button",
          onClick: () => {
            state.placingTransition = null;
            scenes().push(blankScene());
            const index = scenes().length - 1;
            changed();
            go("scene", { videoId: state.videoId, sceneIndex: index });
          },
        },
        "+  Add scene"
      ),
      transitionPool()
    )
  );
}

function overlayToggles() {
  const overlays = ensureOverlays();
  return h(
    "div",
    { class: "overlay-toggles" },
    h(
      "label",
      { class: `overlay-toggle${overlays.credit.enabled ? " on" : ""}` },
      h("input", {
        type: "checkbox",
        checked: overlays.credit.enabled,
        onChange: () => {
          overlays.credit.enabled = !overlays.credit.enabled;
          if (!overlays.credit.enabled && state.selectedOverlay === "credit") {
            state.selectedOverlay = null;
          }
          changed();
        },
      }),
      h("span", { text: "Built with…" })
    ),
    h(
      "label",
      { class: `overlay-toggle${overlays.now_playing.enabled ? " on" : ""}` },
      h("input", {
        type: "checkbox",
        checked: overlays.now_playing.enabled,
        onChange: () => {
          overlays.now_playing.enabled = !overlays.now_playing.enabled;
          if (!overlays.now_playing.enabled && state.selectedOverlay === "now_playing") {
            state.selectedOverlay = null;
          }
          changed();
        },
      }),
      h("span", { text: "Now playing" })
    ),
    h("span", {
      class: "meta",
      text: "Video-wide · drag on the preview · 5s then fade",
    })
  );
}

/** Read-only animation layer for the video-page preview (no drag chrome). */
function previewAnimLayer(entry) {
  const normalized = normalizeAnim(entry);
  if (!normalized.file) return null;
  if (!(state.assets.animations || []).some((item) => item.path === normalized.file)) return null;

  const rate = Math.min(4, Math.max(0.1, (normalized.speed ?? 100) / 100));
  const soft = normalized.soft_edges ? " soft-edges" : "";
  const look = animCssFilter(normalized);
  const primary = h("video", {
    class: `anim-video${soft}`,
    src: `/${normalized.file}`,
    muted: true,
    playsinline: true,
    preload: "auto",
  });
  const secondary = h("video", {
    class: `anim-video${soft}`,
    src: `/${normalized.file}`,
    muted: true,
    playsinline: true,
    preload: "auto",
  });
  const frontWrap = h("div", { class: "anim-video-wrap is-front" }, primary);
  const backWrap = h("div", { class: "anim-video-wrap is-back" }, secondary);
  muteVideo(primary);
  muteVideo(secondary);
  primary.playbackRate = rate;
  secondary.playbackRate = rate;
  primary.style.filter = look;
  secondary.style.filter = look;

  queueMicrotask(() => {
    primary.playbackRate = rate;
    secondary.playbackRate = rate;
    bindSeamlessCrossfade(primary, secondary, frontWrap, backWrap, () =>
      animLoopWindow(normalized, primary.duration || animSourceDuration(normalized))
    );
  });

  const layer = h(
    "div",
    {
      class: `anim-layer is-preview aspect-${normalized.aspect || "native"}`,
      style: animLayerStyle(normalized),
      "aria-hidden": "true",
    },
    frontWrap,
    backWrap
  );

  const applyNativeAspect = () => {
    if (Number.isFinite(normalized.h) && normalized.h > 0) return;
    if ((normalized.aspect || "native") !== "native") return;
    if (!primary.videoWidth || !primary.videoHeight) return;
    layer.style.aspectRatio = animAspectCss(normalized, primary);
  };
  primary.addEventListener("loadedmetadata", applyNativeAspect);
  if (primary.readyState >= 1) applyNativeAspect();

  return layer;
}

/** Swap animation/effect layers when the active scene changes while scrubbing. */
function syncVideoPreviewMotion(at = player.at) {
  if (!overlayUi?.motion) return;
  const item = activeVideoItem(at);
  const index = item && !item.isTransition ? item.index : -1;
  if (overlayUi.motionScene === index) return;
  overlayUi.motionScene = index;
  overlayUi.motion.replaceChildren();
  if (index < 0) return;

  const entry = scenes()[index];
  if (!entry || entry.is_transition) return;

  (entry.animations || []).forEach((anim) => {
    const layer = previewAnimLayer(anim);
    if (layer) overlayUi.motion.append(layer);
  });

  (entry.effects || [])
    .map((effect) => normalizeEffect(effect))
    .filter((effect) => (state.assets.effects || []).some((item) => item.path === effect.file))
    .forEach((effect) => {
      overlayUi.motion.append(effectLayer(effect.file, effect.speed));
    });
}

function videoPreview() {
  const expanded = state.pictureExpanded;
  const overlays = ensureOverlays();
  const item = activeVideoItem(player.at);
  const image = item?.image || "";
  const known = image && imageExists(image);
  const creditLayer = overlays.credit.enabled ? lowerThirdLayer("credit", overlays.credit) : null;
  const songLayer = overlays.now_playing.enabled
    ? lowerThirdLayer("now_playing", overlays.now_playing)
    : null;
  const still = known
    ? h("div", {
        class: "picture-still",
        "data-path": image,
        style: {
          backgroundImage: `url(/thumb?path=${encodeURIComponent(image)}&w=${expanded ? 1600 : 1200})`,
        },
      })
    : h("div", {
        class: "picture-still blank",
        "data-path": "",
      });

  const mapLayer = h("div", {
    class: "picture-still picture-map-overlay is-hidden",
    "data-path": "",
    style: { opacity: "0" },
  });

  const motion = h("div", { class: "picture-motion", "aria-hidden": "true" });

  overlayUi = {
    still,
    map: mapLayer,
    motion,
    motionScene: null,
    credit: creditLayer,
    song: songLayer,
    songTitle: songLayer?.querySelector(".lower-third-title") || null,
    songFrom: songLayer?.querySelector(".lower-third-sub") || null,
  };
  queueMicrotask(paintOverlays);

  return h(
    "div",
    { class: `video-preview picture-frame${expanded ? " is-expanded" : ""}` },
    h(
      "button",
      {
        class: "picture-expand",
        type: "button",
        title: expanded ? "Exit full screen" : "Expand picture",
        "aria-label": expanded ? "Exit full screen" : "Expand picture",
        onClick: (event) => {
          event.stopPropagation();
          state.pictureExpanded = !state.pictureExpanded;
          render();
        },
      },
      expanded ? collapseIcon() : expandIcon()
    ),
    h(
      "div",
      {
        class: `picture${known ? "" : " blank"}`,
        onPointerdown: (event) => {
          if (event.target.closest(".lower-third, .picture-expand")) return;
          if (state.selectedOverlay !== null) {
            state.selectedOverlay = null;
            render();
          }
        },
      },
      still,
      motion,
      mapLayer,
      !known && h("span", { class: "picture-empty", text: "Add a scene picture to preview lower thirds" }),
      creditLayer,
      songLayer
    )
  );
}

function placeScene(fromIndex, insertAt) {
  const list = scenes();
  let at = insertAt;
  if (fromIndex < at) at -= 1;
  if (at === fromIndex) {
    state.movingScene = null;
    render();
    return;
  }
  const [moved] = list.splice(fromIndex, 1);
  list.splice(Math.max(0, Math.min(at, list.length)), 0, moved);
  state.sceneIndex = list.indexOf(moved);
  state.movingScene = null;
  state.placingTransition = null;
  changed();
}

function placeTransitionAfter(transIndex, afterSceneIndex) {
  const list = scenes();
  const source = list[transIndex];
  if (!source?.is_transition) return;
  // Stamp a copy — same transition can sit between many scene pairs.
  // Audio stays on the neighboring scenes; this is a visual marker only.
  const copy = JSON.parse(JSON.stringify(source));
  let at = afterSceneIndex + 1;
  while (at < list.length && list[at].is_transition) at += 1;
  list.splice(at, 0, copy);
  state.placingTransition = null;
  state.movingScene = null;
  changed();
}

function removeTransitionAt(index) {
  const list = scenes();
  if (!list[index]?.is_transition) return;
  list.splice(index, 1);
  if (state.sceneIndex >= list.length) state.sceneIndex = Math.max(0, list.length - 1);
  state.placingTransition = null;
  state.movingScene = null;
  changed();
}

/** Normal scenes in order, with transition indexes sitting in the gaps between them. */
function timelineLayout() {
  const list = scenes();
  const rows = [];
  let i = 0;
  const lead = [];
  while (i < list.length && list[i].is_transition) {
    lead.push(i);
    i += 1;
  }
  rows.push({ type: "gap", afterIndex: -1, transitions: lead });
  while (i < list.length) {
    if (list[i].is_transition) {
      i += 1;
      continue;
    }
    const sceneIndex = i;
    rows.push({ type: "scene", index: sceneIndex });
    i += 1;
    const mid = [];
    while (i < list.length && list[i].is_transition) {
      mid.push(i);
      i += 1;
    }
    rows.push({ type: "gap", afterIndex: sceneIndex, transitions: mid });
  }
  return rows;
}

function sceneSlot(insertAt, fromIndex) {
  if (insertAt === fromIndex || insertAt === fromIndex + 1) return null;
  return h("button", {
    class: "scene-slot",
    type: "button",
    title: "Place scene here",
    "aria-label": "Place scene here",
    onClick: () => placeScene(fromIndex, insertAt),
  });
}

function transitionGap(gap) {
  const placing = state.placingTransition;
  if (placing !== null) {
    return h("button", {
      class: "transition-drop",
      type: "button",
      title: "Add transition here (visual only — songs stay on the scenes)",
      "aria-label": "Add transition here",
      onClick: () => placeTransitionAfter(placing, gap.afterIndex),
    });
  }

  if (!gap.transitions.length) {
    return h("div", { class: "transition-gap-spacer", "aria-hidden": true });
  }

  return h(
    "div",
    { class: "transition-markers" },
    ...gap.transitions.map((index) => {
      const entry = scenes()[index];
      const title = entry?.title || "Transition";
      return h(
        "div",
        { class: "transition-dot-wrap", title: `${title} — visual overlay between scenes` },
        h("button", {
          class: "transition-dot",
          type: "button",
          "aria-label": `Open ${title}`,
          onClick: () => go("scene", { videoId: state.videoId, sceneIndex: index }),
        }),
        h(
          "button",
          {
            class: "transition-dot-x",
            type: "button",
            title: "Remove transition",
            "aria-label": `Remove ${title}`,
            onClick: (event) => {
              event.stopPropagation();
              removeTransitionAt(index);
            },
          },
          "×"
        )
      );
    })
  );
}

function sceneCard(index, item) {
  const moving = state.movingScene;
  const placingScene = moving !== null;
  const placingTransition = state.placingTransition !== null;

  const open = () => {
    if (placingScene || placingTransition) return;
    go("scene", { videoId: state.videoId, sceneIndex: index });
  };

  return h(
    "div",
    {
      class: `scene-card${item.missing ? " missing" : ""}${moving === index ? " moving" : ""}`,
      "data-scene-index": String(index),
    },
    h(
      "button",
      {
        class: "handle",
        type: "button",
        title: placingScene && moving === index ? "Cancel move" : "Move scene",
        "aria-label": placingScene && moving === index ? "Cancel move" : "Move scene",
        onClick: (event) => {
          event.stopPropagation();
          state.placingTransition = null;
          state.movingScene = moving === index ? null : index;
          render();
        },
      },
      gripIcon()
    ),
    h("div", {
      class: `scene-thumb${item.image && !item.missing ? "" : " blank"}`,
      style:
        item.image && !item.missing
          ? { backgroundImage: `url(/thumb?path=${encodeURIComponent(item.image)}&w=360)` }
          : {},
      text: item.missing ? "no image" : "",
      onClick: open,
    }),
    h(
      "div",
      { class: "scene-meta", onClick: open },
      h(
        "div",
        { class: "scene-meta-top" },
        h("span", { class: "name", text: item.title }),
        outputTag(sceneOutput(index))
      ),
      h("span", {
        class: "len",
        text: `${item.songs.length} song${item.songs.length === 1 ? "" : "s"} · ${clock(item.duration)}`,
      })
    ),
    h(
      "button",
      {
        class: "trash",
        type: "button",
        title: "Remove scene",
        onClick: (event) => {
          event.stopPropagation();
          if (scenes().filter((scene) => !scene.is_transition).length <= 1) {
            state.note = "Keep at least one scene";
            render();
            return;
          }
          scenes().splice(index, 1);
          if (state.sceneIndex >= scenes().length) state.sceneIndex = Math.max(0, scenes().length - 1);
          state.movingScene = null;
          state.placingTransition = null;
          changed();
        },
      },
      trashIcon()
    )
  );
}

/** Multi-use transition card — same thumbnail as a scene, Add instead of a grip. */
function transitionCard(index, item) {
  const entry = scenes()[index];
  const selected = state.placingTransition === index;
  const mapHold = transitionTiming(entry).total;
  const known = item.image && !item.missing;

  return h(
    "div",
    {
      class: `scene-card is-transition${selected ? " selected" : ""}`,
    },
    h(
      "button",
      {
        class: `transition-use-btn${selected ? " is-on" : ""}`,
        type: "button",
        title: selected ? "Cancel" : "Add between two scenes (visual only)",
        onClick: (event) => {
          event.stopPropagation();
          state.movingScene = null;
          state.placingTransition = selected ? null : index;
          render();
        },
      },
      selected ? "Cancel" : "Add"
    ),
    h("div", {
      class: `scene-thumb${known ? "" : " blank"}`,
      style: known
        ? { backgroundImage: `url(/thumb?path=${encodeURIComponent(item.image)}&w=360)` }
        : {},
      text: known ? "" : "no image",
      onClick: () => {
        state.placingTransition = null;
        go("scene", { videoId: state.videoId, sceneIndex: index });
      },
    }),
    h(
      "div",
      {
        class: "scene-meta",
        onClick: () => {
          state.placingTransition = null;
          go("scene", { videoId: state.videoId, sceneIndex: index });
        },
      },
      h("div", { class: "scene-meta-top" }, h("span", { class: "name", text: item.title })),
      h("span", {
        class: "len",
        text: mapHold > 0 ? `Visual · ${clock(mapHold)}` : "Visual overlay",
      })
    ),
    h(
      "button",
      {
        class: "trash",
        type: "button",
        title: "Delete transition",
        onClick: (event) => {
          event.stopPropagation();
          removeTransitionAt(index);
        },
      },
      trashIcon()
    )
  );
}

function sceneTimeline(items) {
  const moving = state.movingScene;
  const placingTransition = state.placingTransition;
  const placingScene = moving !== null;
  const layout = timelineLayout();
  const cards = [];
  const scrubCards = [];

  layout.forEach((row) => {
    if (row.type === "gap") {
      if (placingScene) {
        const slot = sceneSlot(row.afterIndex + 1, moving);
        if (slot) cards.push(slot);
      } else {
        const gap = transitionGap(row);
        if (gap) cards.push(gap);
      }
      return;
    }

    const index = row.index;
    const item = items[index];
    if (!item) return;
    const card = sceneCard(index, item);
    scrubCards.push(card);
    cards.push(card);
  });

  if (scrubber) scrubber.cards = scrubCards;

  return h(
    "div",
    {
      class: `scene-strip${placingScene ? " is-placing" : ""}${
        placingTransition !== null ? " is-placing-transition" : ""
      }`,
    },
    cards.length
      ? cards.filter(Boolean)
      : h("p", { class: "empty-note drop-hint", text: "Add a scene to get started" })
  );
}

function transitionPool() {
  const { items } = videoTimeline();
  const transitions = scenes()
    .map((entry, index) => ({ entry, index, item: items[index] }))
    .filter((row) => row.entry.is_transition);
  const placing = state.placingTransition;

  return h(
    "div",
    { class: "transition-pool" },
    h(
      "div",
      { class: "sequence-head" },
      h("span", { text: "Multi-use" }),
      h("span", {
        class: "meta",
        text:
          placing !== null
            ? "Click a red slot — stamps a copy (you can add this between many scenes)"
            : "Add stamps a visual overlay between scenes; each scene keeps its own songs",
      })
    ),
    h(
      "div",
      {
        class: `scene-strip transition-strip${placing !== null ? " is-placing-transition" : ""}`,
      },
      transitions.map(({ index, item }) => transitionCard(index, item)),
      h(
        "button",
        {
          class: "btn ghost transition-add",
          type: "button",
          onClick: () => {
            state.placingTransition = null;
            scenes().push(blankTransition());
            const index = scenes().length - 1;
            changed();
            go("scene", { videoId: state.videoId, sceneIndex: index });
          },
        },
        "+  New transition"
      )
    )
  );
}

function expandIcon() {
  return h(
    "svg",
    {
      class: "icon",
      viewBox: "0 0 16 16",
      width: "14",
      height: "14",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.5",
      "aria-hidden": true,
    },
    h("path", { d: "M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" })
  );
}

function collapseIcon() {
  return h(
    "svg",
    {
      class: "icon",
      viewBox: "0 0 16 16",
      width: "14",
      height: "14",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.5",
      "aria-hidden": true,
    },
    h("path", { d: "M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5" })
  );
}

function downloadIcon() {
  return h(
    "svg",
    {
      class: "icon",
      viewBox: "0 0 16 16",
      width: "14",
      height: "14",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.5",
      "aria-hidden": true,
    },
    h("path", { d: "M8 2.5v8M5 8l3 3 3-3M3 13.5h10" })
  );
}

function pictureStage(known, image) {
  const expanded = state.pictureExpanded;
  const regionOn = expanded && state.regionTool;
  return h(
    "div",
    { class: `picture-frame${expanded ? " is-expanded" : ""}` },
    known &&
      h(
        "button",
        {
          class: "picture-download",
          type: "button",
          title: `Download ${image.split("/").pop()}`,
          "aria-label": "Download image",
          onClick: (event) => {
            event.stopPropagation();
            downloadSceneImage();
          },
        },
        downloadIcon()
      ),
    expanded &&
      known &&
      h(
        "div",
        { class: "picture-region-tools" },
        h(
          "button",
          {
            class: `picture-region${regionOn ? " on" : ""}`,
            type: "button",
            title: regionOn ? "Cancel region tool" : "Draw a 16:9 or 9:16 region to clone",
            "aria-label": regionOn ? "Cancel region tool" : "Draw region",
            onClick: (event) => {
              event.stopPropagation();
              state.regionTool = !state.regionTool;
              state.note = state.regionTool
                ? `Draw a ${state.regionAspect === "portrait" ? "9:16" : "16:9"} region for Jim`
                : "";
              render();
            },
          },
          regionIcon()
        ),
        regionOn &&
          regionAspectToggle(state.regionAspect, (aspect) => {
            state.regionAspect = aspect;
            state.note = `Draw a ${aspect === "portrait" ? "9:16" : "16:9"} region for Jim`;
            render();
          })
      ),
    h(
      "button",
      {
        class: "picture-expand",
        type: "button",
        title: expanded ? "Exit full screen" : "Expand picture",
        "aria-label": expanded ? "Exit full screen" : "Expand picture",
        onClick: (event) => {
          event.stopPropagation();
          state.pictureExpanded = !state.pictureExpanded;
          if (!state.pictureExpanded) state.regionTool = false;
          render();
        },
      },
      expanded ? collapseIcon() : expandIcon()
    ),
    h(
      "div",
      {
        class: `picture${known ? "" : " blank"}${regionOn ? " region-mode" : ""}`,
        onPointerdown: (event) => {
          if (
            event.target.closest(
              ".anim-layer, .fade-zoom-guide, .picture-expand, .picture-download, .picture-region-tools, .region-capture"
            )
          )
            return;
          if (state.selectedAnim !== null) {
            state.selectedAnim = null;
            render();
          }
        },
      },
      known
        ? h("div", {
            class: "picture-still",
            style: {
              backgroundImage: `url(/thumb?path=${encodeURIComponent(image)}&w=${expanded ? 1600 : 1200})`,
            },
          })
        : h("span", { class: "picture-empty", text: "Pick a picture from Images" }),
      isTransitionScene() &&
        transitionStyleOf(scene()) === "fade_zoom" &&
        fadeZoomGuide("start"),
      isTransitionScene() &&
        transitionStyleOf(scene()) === "fade_zoom" &&
        fadeZoomGuide("end"),
      ...sceneAnims().map((entry, index) => animLayer(normalizeAnim(entry), index)),
      // Effects sit above animation overlays.
      ...sceneEffects()
        .map((entry) => normalizeEffect(entry))
        .filter((entry) => state.assets.effects.some((effect) => effect.path === entry.file))
        .map((entry) => effectLayer(entry.file, entry.speed)),
      regionOn &&
        h("div", {
          class: "region-capture",
          title: "Drag to draw a region",
          onPointerdown: beginRegionDraw,
        })
    )
  );
}

function lowerThirdLayer(kind, entry) {
  const selected = state.selectedOverlay === kind;
  const overlays = ensureOverlays();
  const song = currentSongAt(player.at, videoSongs());
  const children =
    kind === "credit"
      ? [h("div", { class: "lower-third-title", text: entry.text || "Built with hearthbound.com" })]
      : [
          h("div", { class: "lower-third-title", text: song?.title || "Song title" }),
          h("div", {
            class: "lower-third-sub",
            text: `Streaming from ${overlays.now_playing.streaming_from}`,
          }),
        ];

  return h(
    "div",
    {
      class: `lower-third lower-third-${kind}${selected ? " selected" : ""}`,
      style: {
        left: `${entry.x * 100}%`,
        top: `${entry.y * 100}%`,
      },
      title: "Drag to place",
      onPointerdown: (event) => beginOverlayMove(event, kind),
    },
    ...children
  );
}

function beginOverlayMove(event, kind) {
  event.preventDefault();
  event.stopPropagation();
  const overlays = ensureOverlays();
  const entry = kind === "credit" ? overlays.credit : overlays.now_playing;
  const picture = event.currentTarget.closest(".picture");
  const layer = event.currentTarget;
  if (state.selectedOverlay !== kind || state.selectedAnim !== null) {
    state.selectedOverlay = kind;
    state.selectedAnim = null;
    layer.classList.add("selected");
  }
  const box = picture.getBoundingClientRect();
  const startX = event.clientX;
  const startY = event.clientY;
  const originX = entry.x;
  const originY = entry.y;

  layer.setPointerCapture(event.pointerId);
  const move = (moveEvent) => {
    entry.x = Math.min(0.92, Math.max(0, originX + (moveEvent.clientX - startX) / box.width));
    entry.y = Math.min(0.94, Math.max(0, originY + (moveEvent.clientY - startY) / box.height));
    layer.style.left = `${entry.x * 100}%`;
    layer.style.top = `${entry.y * 100}%`;
  };
  const up = () => {
    layer.releasePointerCapture(event.pointerId);
    layer.removeEventListener("pointermove", move);
    layer.removeEventListener("pointerup", up);
    layer.removeEventListener("pointercancel", up);
    state.selectedOverlay = kind;
    changed();
  };
  layer.addEventListener("pointermove", move);
  layer.addEventListener("pointerup", up);
  layer.addEventListener("pointercancel", up);
}

function effectLayer(path, speed = 100) {
  const rate = Math.min(4, Math.max(0.1, speed / 100));
  const makeVideo = () => {
    const video = h("video", {
      class: "picture-fx-source",
      src: `/${path}`,
      muted: true,
      playsinline: true,
      preload: "auto",
      "data-effect": path,
    });
    muteVideo(video);
    video.loop = false;
    video.playbackRate = rate;
    return video;
  };
  const front = makeVideo();
  const back = makeVideo();
  const frontCanvas = h("canvas", { class: "picture-fx is-front" });
  const backCanvas = h("canvas", { class: "picture-fx is-back" });
  frontCanvas.style.opacity = "1";
  backCanvas.style.opacity = "0";
  queueMicrotask(() => {
    front.playbackRate = rate;
    back.playbackRate = rate;
    bindChromaCanvas(front, frontCanvas, path);
    bindChromaCanvas(back, backCanvas, path);
    // Effects use the full clip — keep crossfade displays on the canvases.
    bindSeamlessCrossfade(front, back, frontCanvas, backCanvas, null);
  });
  return h(
    "div",
    { class: "picture-fx-wrap", "aria-hidden": "true" },
    front,
    back,
    frontCanvas,
    backCanvas
  );
}

function bindChromaCanvas(video, canvas, path) {
  if (!video || !canvas || canvas.dataset.bound === "1") return;
  canvas.dataset.bound = "1";
  muteVideo(video);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  // Leaves sit on near-pure #00FF00 — only punch out that screen green.
  // (Snow uses a darker key; leave its tuning alone for now.)
  const snow = path.toLowerCase().includes("snow");

  const tick = () => {
    if (!canvas.isConnected) return;
    if (video.readyState >= 2 && video.videoWidth) {
      const box = canvas.parentElement?.getBoundingClientRect();
      const w = Math.max(2, Math.round(box?.width || 640));
      const h = Math.max(2, Math.round(box?.height || w * (video.videoHeight / video.videoWidth)));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      try {
        ctx.clearRect(0, 0, w, h);
        // Cover-fit into the picture frame, then punch out the green screen.
        const scale = Math.max(w / video.videoWidth, h / video.videoHeight);
        const dw = video.videoWidth * scale;
        const dh = video.videoHeight * scale;
        const dx = (w - dw) / 2;
        const dy = (h - dh) / 2;
        ctx.drawImage(video, dx, dy, dw, dh);
        const image = ctx.getImageData(0, 0, w, h);
        const data = image.data;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          if (snow) {
            const greenness = g - Math.max(r, b);
            if (g >= 90 && greenness >= 25) data[i + 3] = 0;
          } else {
            // Pure screen green: very high G, low R/B. Leaves are red/orange — keep them.
            const screen = g > 180 && r < 90 && b < 90 && g > r + 70 && g > b + 70;
            const fringe = g > 150 && r < 120 && b < 120 && g > r + 40 && g > b + 40;
            if (screen) {
              data[i + 3] = 0;
            } else if (fringe) {
              const t = Math.min(1, (g - Math.max(r, b)) / 90);
              data[i + 3] = Math.round(data[i + 3] * (1 - t));
              data[i + 1] = Math.min(g, Math.max(r, b) + 12);
            }
          }
        }
        ctx.putImageData(image, 0, 0);
      } catch {
        // Keep the canvas path even if a frame fails — retry next tick.
      }
    }
    requestAnimationFrame(tick);
  };

  const start = () => {
    muteVideo(video);
    video.play().catch(() => {});
    requestAnimationFrame(tick);
  };
  if (video.readyState >= 2) start();
  else {
    video.addEventListener("loadeddata", start, { once: true });
    video.addEventListener("error", () => {
      state.note = "Could not play effect preview";
    });
  }
}

function sceneView() {
  const current = scene();
  const transition = isTransitionScene(current);
  const { list } = sceneSequence(state.sceneIndex);
  const total = scenePlayTotal(state.sceneIndex);
  const image = current.image;
  const known = image && imageExists(image);
  const bar = playerBar(total, "scene");
  const { node: listNode, rows } = transition
    ? { node: null, rows: [] }
    : playlist(list);
  if (scrubber) scrubber.rows = rows;
  const timing = transition ? transitionTiming(current) : null;
  const mapHold = timing?.total || 0;

  app.classList.toggle("is-expanded", state.pictureExpanded);

  return h(
    "div",
    { class: "shell-inner" },
    topbar(exportActions({ sceneMode: true })),
    h(
      "div",
      { class: "body" },
      sceneToolbar(),
      h(
        "main",
        { class: "stage" },
        h(
          "div",
          { class: "page-title-row scene-title-row" },
          h("input", {
            class: "scene-title",
            type: "text",
            value: current.title || "",
            placeholder: transition ? "Transition title" : "Scene title",
            onInput: (event) => {
              current.title = event.target.value;
              clearTimeout(saveTimer);
              saveTimer = setTimeout(save, 400);
              const crumb = document.querySelector(".crumb.current");
              if (crumb) crumb.textContent = event.target.value || `Scene ${state.sceneIndex + 1}`;
            },
          }),
          h(
            "label",
            {
              class: `scene-transition-toggle${transition ? " on" : ""}`,
              title: "Map overlay between neighboring scenes — they keep their full songs",
            },
            h("input", {
              type: "checkbox",
              checked: transition,
              onChange: (event) => {
                const on = !!event.target.checked;
                if (on) {
                  const songs = (current.tracks || []).length;
                  if (
                    songs &&
                    !confirm(
                      `This scene has ${songs} song${songs === 1 ? "" : "s"}. Turning on Is transition will remove them from this scene. Continue?`
                    )
                  ) {
                    event.target.checked = false;
                    return;
                  }
                  current.is_transition = true;
                  current.tracks = [];
                  current.transition_in = current.transition_in || "fade";
                  current.transition_out = current.transition_out || current.transition_in || "fade";
                  if (transitionStyleOf(current) === "fade_zoom") ensureFadeZoom(current);
                  if (!current.map || typeof current.map !== "object") {
                    current.map = { seconds: DEFAULT_MAP_SECONDS };
                  } else if (!(Number(current.map.seconds) > 0)) {
                    current.map.seconds = DEFAULT_MAP_SECONDS;
                  }
                } else {
                  current.is_transition = false;
                }
                changed();
              },
            }),
            h("span", { text: "Is transition" })
          ),
          outputTag(sceneOutput(state.sceneIndex))
        ),
        sceneDetails(),
        pictureStage(known, image),
        sceneAnims().length > 0 &&
          h("p", {
            class: "anim-lock-note",
            text: "Expand the picture to drag or resize. Copy still locks the slot in place.",
          }),
        animControlsDial(),
        bar,
        renderStatus(),
        transition
          ? h(
              "div",
              { class: "transition-panel" },
              h(
                "div",
                { class: "sequence-head" },
                h("span", { text: "Map overlay" }),
                h("span", {
                  class: "meta",
                  text:
                    mapHold > 0
                      ? `${clock(timing.outHold)} before · ${clock(timing.inHold)} after`
                      : "—",
                })
              ),
              h("p", {
                class: "meta transition-note",
                text: "Visual only — neighbors keep their songs (hard cut at the midpoint). Length is map + any included zoom. Fade is the alpha in/out at each edge. Play above to preview.",
              }),
              h(
                "div",
                { class: "transition-fx-row" },
                transitionFxSelect(transitionStyleOf(current), (next) => {
                  current.transition_in = next;
                  current.transition_out = next;
                  if (next === "fade_zoom") ensureFadeZoom(current);
                  changed();
                }, "Style")
              ),
              transitionStyleOf(current) === "fade_zoom" && fadeZoomFields(current),
              transitionDurationFields(current),
              (() => {
                const list = scenes();
                const prev = list[state.sceneIndex - 1];
                const next = list[state.sceneIndex + 1];
                const rows = [
                  prev && !prev.is_transition
                    ? {
                        title: `Over “${prev.title || "Previous"}” (end)`,
                        len: timing.outHold > 0 ? clock(timing.outHold) : "—",
                      }
                    : null,
                  next && !next.is_transition
                    ? {
                        title: `Over “${next.title || "Next"}” (start)`,
                        len: timing.inHold > 0 ? clock(timing.inHold) : "—",
                      }
                    : null,
                ].filter(Boolean);
                return rows.length
                  ? h(
                      "ul",
                      { class: "transition-bridge-list" },
                      ...rows.map((item) =>
                        h(
                          "li",
                          {},
                          h("span", { text: item.title }),
                          h("span", { class: "len", text: item.len })
                        )
                      )
                    )
                  : h("p", {
                      class: "meta transition-note",
                      text: "Place this between two scenes that each have songs.",
                    });
              })()
            )
          : [
              h(
                "div",
                { class: "sequence-head" },
                h("span", {
                  text: list.length
                    ? `${list.length} song${list.length === 1 ? "" : "s"} over this picture`
                    : "Songs",
                }),
                h("span", { class: "meta", text: clock(total) })
              ),
              listNode,
            ]
      )
    )
  );
}

function libraryInScene(kind, path) {
  if (kind === "images") return scene().image === path;
  if (kind === "music") return sceneHasSong(path);
  if (kind === "sounds") return sceneHasSound(path);
  if (kind === "animations") return sceneHasAnim(path);
  if (kind === "effects") return !!effectEntry(path);
  return false;
}

function libraryVisibleItems(kind, items) {
  if (state.libraryShowAll[kind]) return items;
  return items.filter((item) => libraryInScene(kind, item.path));
}

function libraryShowAllToggle(kind) {
  const showAll = !!state.libraryShowAll[kind];
  return h(
    "button",
    {
      class: `group-filter${showAll ? " on" : ""}`,
      type: "button",
      title: showAll ? "Show only what’s in this scene" : "Browse the full library",
      onClick: () => {
        state.libraryShowAll[kind] = !showAll;
        render();
      },
      text: showAll ? "In scene" : "All",
    }
  );
}

function sceneToolbar() {
  const effectsAll = state.assets.effects || [];
  const effects = libraryVisibleItems("effects", effectsAll);
  const showAllEffects = !!state.libraryShowAll.effects;

  return h(
    "aside",
    { class: "library tools" },
    h(
      "div",
      { class: "library-group" },
      h(
        "div",
        { class: "group-label" },
        h("span", { class: "group-title", text: "Effects" }),
        h("span", { class: "group-actions" }, libraryShowAllToggle("effects"))
      ),
      effects.length
        ? effects.map((effect) => {
            const entry = effectEntry(effect.path);
            const on = !!entry;
            const speed = entry?.speed ?? 100;
            const renaming = state.renamingPath === effect.path;
            const toggleEffect = () => {
              if (renaming) return;
              const list = sceneEffects();
              const at = list.findIndex((item) => normalizeEffect(item).file === effect.path);
              if (at >= 0) list.splice(at, 1);
              else list.push({ file: effect.path, speed: 100 });
              changed();
            };
            return h(
              "div",
              { class: `effect-block${on ? " on" : ""}` },
              h(
                "div",
                {
                  class: `tool-row${on ? " on" : ""}`,
                  onClick: (event) => {
                    if (event.target.closest(".name-edit, .media-name, input")) return;
                    toggleEffect();
                  },
                },
                h("input", {
                  type: "checkbox",
                  checked: on,
                  disabled: renaming,
                  onChange: toggleEffect,
                }),
                renameField(effect, false, {
                  displayName: effect.name.replace(/[-_]/g, " "),
                })
              ),
              on &&
                h(
                  "div",
                  { class: "effect-speed" },
                  h("span", { class: "effect-speed-label", text: "Speed" }),
                  h("input", {
                    class: "effect-speed-range",
                    type: "range",
                    min: "25",
                    max: "200",
                    step: "5",
                    value: String(speed),
                    onInput: (event) => {
                      const next = Number(event.target.value);
                      const current = effectEntry(effect.path);
                      if (current) current.speed = next;
                      const label = event.target.parentElement?.querySelector(".effect-speed-value");
                      if (label) label.textContent = `${next}%`;
                      document
                        .querySelectorAll(`video[data-effect="${CSS.escape(effect.path)}"]`)
                        .forEach((video) => {
                          video.playbackRate = Math.min(4, Math.max(0.1, next / 100));
                        });
                    },
                    onChange: () => {
                      clearTimeout(saveTimer);
                      saveTimer = setTimeout(save, 400);
                    },
                  }),
                  h("span", { class: "effect-speed-value", text: `${speed}%` })
                )
            );
          })
        : h(
            "p",
            { class: "empty-note" },
            effectsAll.length && !showAllEffects
              ? "None in this scene — tap All to browse"
              : "Drop clips into assets/effects"
          )
    ),

    libraryGroup("Animations", "animations", state.assets.animations || [], state.pruneAnims, (on) => {
      state.pruneAnims = on;
      render();
    }),
    libraryGroup("Images", "images", libraryImages(), state.pruneImages, (on) => {
      state.pruneImages = on;
      render();
    }),
    !isTransitionScene() &&
      libraryGroup("Songs", "music", state.assets.music || [], state.pruneSongs, (on) => {
        state.pruneSongs = on;
        render();
      }),
    libraryGroup("Sounds", "sounds", state.assets.sounds || [], state.pruneSounds, (on) => {
      state.pruneSounds = on;
      render();
    })
  );
}

function libraryImages() {
  return (state.assets.images || []).filter((image) => image.path.startsWith("assets/images/"));
}

function libraryGroup(label, kind, items, pruning, setPruning) {
  const showAll = !!state.libraryShowAll[kind];
  const visible = libraryVisibleItems(kind, items);
  const accept =
    kind === "images"
      ? "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
      : kind === "animations"
        ? "video/mp4,video/webm,video/quicktime,.mp4,.mov,.webm,.mkv"
        : "audio/*,.mp3,.m4a,.wav,.flac,.aac,.ogg";
  const input = h("input", {
    class: "file-input",
    type: "file",
    accept,
    multiple: true,
    onChange: async (event) => {
      const files = [...(event.target.files || [])];
      event.target.value = "";
      for (const file of files) await uploadAsset(kind, file);
    },
  });

  const empty =
    items.length && !showAll
      ? "None in this scene — tap All to browse"
      : kind === "images"
        ? "No pictures yet"
        : kind === "animations"
          ? "No animations yet"
          : kind === "sounds"
            ? "Drop beds into assets/sounds"
            : "No songs yet";

  return h(
    "div",
    { class: "library-group" },
    h(
      "div",
      { class: "group-label spaced" },
      h("span", { class: "group-title", text: label }),
      h(
        "span",
        { class: "group-actions" },
        libraryShowAllToggle(kind),
        h(
          "button",
          {
            class: "group-icon",
            type: "button",
            title: `Add ${label.toLowerCase()}`,
            onClick: () => input.click(),
          },
          plusIcon()
        ),
        h(
          "button",
          {
            class: `group-icon${pruning ? " on" : ""}`,
            type: "button",
            title: pruning ? "Done removing" : `Remove ${label.toLowerCase()}`,
            onClick: () => setPruning(!pruning),
          },
          trashIcon()
        )
      ),
      input
    ),
    visible.length
      ? visible.map((item) => libraryItem(kind, item, pruning))
      : h("p", { class: "empty-note", text: empty })
  );
}

function renameField(item, pruning, { displayName = null, onActivate = null } = {}) {
  const renaming = state.renamingPath === item.path;
  const label = displayName ?? item.name;
  if (renaming) {
    return h("input", {
      class: "name-edit",
      type: "text",
      value: item.name,
      onKeydown: (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.target.blur();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          state.renamingPath = null;
          render();
        }
      },
      onBlur: (event) => commitRename(item.path, event.target.value),
    });
  }
  return h("span", {
    class: "name media-name",
    title: "Double-click to rename",
    text: label,
    onClick: (event) => {
      if (pruning || renaming) return;
      onActivate?.(event);
    },
    onDblclick: (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (pruning) return;
      state.renamingPath = item.path;
      render();
      queueMicrotask(() => {
        const input = document.querySelector(".name-edit");
        if (!input) return;
        input.focus();
        input.select();
      });
    },
  });
}

function libraryTrash(path) {
  return h(
    "button",
    {
      class: "media-trash",
      type: "button",
      title: "Delete from library",
      onClick: () => deleteAsset(path),
    },
    trashIcon()
  );
}

function sceneHasAnim(path) {
  return sceneAnims().some((entry) => (typeof entry === "string" ? entry : entry?.file) === path);
}

function sceneHasSong(path) {
  return sceneSongs().some((entry) => fileOf(entry) === path);
}

function sceneHasSound(path) {
  return sceneSounds().some((entry) => normalizeSound(entry).file === path);
}

function toggleSceneSound(path, on) {
  const list = sceneSounds();
  if (on) {
    if (sceneHasSound(path)) return;
    list.push(normalizeSound(path));
  } else {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (normalizeSound(list[i]).file === path) list.splice(i, 1);
    }
  }
  changed();
}

function fillAnimSlot(path) {
  const list = sceneAnims();
  if (sceneHasAnim(path)) return false;
  let index = state.selectedAnim;
  if (index === null || index < 0 || index >= list.length || !isPendingAnim(list[index])) {
    index = list.findIndex((entry) => isPendingAnim(entry));
  }
  if (index < 0) return false;
  const slot = normalizeAnim(list[index]);
  slot.file = path;
  list[index] = slot;
  state.selectedAnim = index;
  state.note = "Animation snapped into the region";
  changed();
  return true;
}

function toggleSceneAnim(path, on) {
  const list = sceneAnims();
  if (on) {
    if (sceneHasAnim(path)) return;
    if (fillAnimSlot(path)) return;
    list.push(normalizeAnim(path));
    state.selectedAnim = list.length - 1;
  } else {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const file = typeof list[i] === "string" ? list[i] : list[i]?.file;
      if (file === path) list.splice(i, 1);
    }
    if (state.selectedAnim !== null && state.selectedAnim >= list.length) {
      state.selectedAnim = list.length ? list.length - 1 : null;
    }
  }
  changed();
}

function toggleSceneSong(path, on) {
  const list = sceneSongs();
  if (on) {
    if (sceneHasSong(path)) return;
    list.push(path);
  } else {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (fileOf(list[i]) === path) list.splice(i, 1);
    }
  }
  state.movingSong = null;
  changed();
}

function libraryItem(kind, item, pruning) {
  const renaming = state.renamingPath === item.path;

  if (kind === "images") {
    const on = scene().image === item.path;
    return h(
      "div",
      { class: `media-row${on ? " current" : ""}${pruning ? " pruning" : ""}` },
      h("input", {
        class: "media-pick",
        type: "radio",
        name: "scene-image",
        checked: on,
        disabled: pruning || renaming,
        title: "Use this picture",
        onChange: () => {
          scene().image = item.path;
          changed();
        },
      }),
      h("span", {
        class: "media-thumb",
        title: item.path,
        style: { backgroundImage: `url(/thumb?path=${encodeURIComponent(item.path)}&w=120)` },
        onClick: () => {
          if (pruning || renaming) return;
          scene().image = item.path;
          changed();
        },
      }),
      renameField(item, pruning),
      pruning && libraryTrash(item.path)
    );
  }

  if (kind === "animations") {
    const on = sceneHasAnim(item.path);
    return h(
      "div",
      { class: `media-row${on ? " current" : ""}${pruning ? " pruning" : ""}` },
      h("input", {
        class: "media-pick",
        type: "checkbox",
        checked: on,
        disabled: pruning || renaming,
        title: "Show on the picture",
        onChange: (event) => toggleSceneAnim(item.path, event.target.checked),
      }),
      h("span", {
        class: "media-thumb wide",
        title: item.path,
        style: { backgroundImage: `url(/thumb?path=${encodeURIComponent(item.path)}&w=160)` },
        onClick: () => {
          if (pruning || renaming) return;
          toggleSceneAnim(item.path, !on);
        },
      }),
      renameField(item, pruning, {
        displayName: item.name.replace(/[-_]/g, " "),
      }),
      pruning && libraryTrash(item.path)
    );
  }

  if (kind === "sounds") {
    const on = sceneHasSound(item.path);
    const entry = on ? soundEntry(item.path) : null;
    return h(
      "div",
      { class: `media-row${on ? " current" : ""}${pruning ? " pruning" : ""}` },
      h("input", {
        class: "media-pick",
        type: "checkbox",
        checked: on,
        disabled: pruning || renaming,
        title: "Loop under this scene",
        onChange: (event) => toggleSceneSound(item.path, event.target.checked),
      }),
      h("span", { class: "media-note", text: "~", "aria-hidden": "true" }),
      renameField(item, pruning, {
        displayName: item.name.replace(/[-_]/g, " "),
      }),
      on &&
        entry &&
        !renaming &&
        h("input", {
          class: "sound-volume",
          type: "range",
          min: "0",
          max: "100",
          value: String(entry.volume),
          title: `Volume ${entry.volume}%`,
          onInput: (event) => {
            entry.volume = Number(event.target.value);
            event.target.title = `Volume ${entry.volume}%`;
            player.key = null;
            clearTimeout(saveTimer);
            saveTimer = setTimeout(save, 400);
          },
        }),
      pruning && libraryTrash(item.path)
    );
  }

  const on = sceneHasSong(item.path);
  return h(
    "div",
    { class: `media-row${on ? " current" : ""}${pruning ? " pruning" : ""}` },
    h("input", {
      class: "media-pick",
      type: "checkbox",
      checked: on,
      disabled: pruning || renaming,
      title: "Include in this scene",
      onChange: (event) => toggleSceneSong(item.path, event.target.checked),
    }),
    h("span", { class: "media-note", text: "\u266a", "aria-hidden": "true" }),
    renameField(item, pruning),
    !renaming && h("span", { class: "len", text: clock(item.duration) }),
    pruning && libraryTrash(item.path)
  );
}

async function commitRename(path, nextName) {
  if (state.renamingPath !== path) return;
  state.renamingPath = null;
  const trimmed = String(nextName || "").trim();
  const current = PathStem(path);
  if (!trimmed || trimmed === current) {
    render();
    return;
  }
  state.note = "Renaming…";
  render();
  try {
    const response = await fetch("/api/asset/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, name: trimmed }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Rename failed");
    if (data.from && data.path && data.from !== data.path) {
      rewriteLocalAssetPath(data.from, data.path);
    }
    await refreshOutputs();
    state.note = "";
    changed();
  } catch (error) {
    state.note = error.message || "Rename failed";
    render();
  }
}

function PathStem(path) {
  return (path || "").split("/").pop().replace(/\.[^.]+$/, "");
}

function rewriteLocalAssetPath(from, to) {
  const rewriteEntry = (value) => {
    if (value === from) return to;
    if (value && typeof value === "object" && value.file === from) return { ...value, file: to };
    return value;
  };
  ensureCreativeBrief();
  for (const member of state.script.cast || []) {
    if (member.image === from) member.image = to;
  }
  for (const entry of scenes()) {
    if (entry.image === from) entry.image = to;
    if (Array.isArray(entry.images)) entry.images = entry.images.map(rewriteEntry);
    if (Array.isArray(entry.tracks)) entry.tracks = entry.tracks.map(rewriteEntry);
    if (Array.isArray(entry.sounds)) entry.sounds = entry.sounds.map(rewriteEntry);
    if (Array.isArray(entry.animations)) entry.animations = entry.animations.map(rewriteEntry);
    if (Array.isArray(entry.effects)) entry.effects = entry.effects.map(rewriteEntry);
  }
}

function selectUploadedForScene(kind, path) {
  if (!path || state.page !== "scene") return false;
  if (kind === "images") {
    scene().image = path;
    changed();
    return true;
  }
  if (kind === "music") {
    if (isTransitionScene()) return false;
    toggleSceneSong(path, true);
    return true;
  }
  if (kind === "sounds") {
    toggleSceneSound(path, true);
    return true;
  }
  if (kind === "animations") {
    toggleSceneAnim(path, true);
    return true;
  }
  if (kind === "effects") {
    if (!effectEntry(path)) sceneEffects().push({ file: path, speed: 100 });
    changed();
    return true;
  }
  return false;
}

async function uploadAsset(kind, file) {
  state.note = `Uploading ${file.name}…`;
  render();
  try {
    const response = await fetch(
      `/api/asset?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      }
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Upload failed");
    await refreshOutputs();
    state.note = "";
    if (selectUploadedForScene(kind, data.path)) return;
    render();
  } catch (error) {
    state.note = error.message || "Upload failed";
    render();
  }
}

async function deleteAsset(path) {
  if (!confirm(`Delete ${path.split("/").pop()} from the library?`)) return;
  try {
    const response = await fetch(`/api/asset?path=${encodeURIComponent(path)}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Delete failed");

    let dirty = false;
    if (scene().image === path) {
      scene().image = libraryImages().find((image) => image.path !== path)?.path || "";
      dirty = true;
    }
    ensureCreativeBrief();
    for (const member of state.script.cast || []) {
      if (member.image === path) {
        member.image = "";
        dirty = true;
      }
    }
    for (const entry of scenes()) {
      const beforeTracks = (entry.tracks || []).length;
      entry.tracks = (entry.tracks || []).filter((track) => fileOf(track) !== path);
      if ((entry.tracks || []).length !== beforeTracks) dirty = true;

      const beforeSounds = (entry.sounds || []).length;
      entry.sounds = (entry.sounds || []).filter((sound) => normalizeSound(sound).file !== path);
      if ((entry.sounds || []).length !== beforeSounds) dirty = true;

      const beforeAnims = (entry.animations || []).length;
      entry.animations = (entry.animations || []).filter((anim) => {
        const file = typeof anim === "string" ? anim : anim?.file;
        return file !== path;
      });
      if ((entry.animations || []).length !== beforeAnims) dirty = true;
    }

    if (state.selectedAnim !== null && state.selectedAnim >= sceneAnims().length) {
      state.selectedAnim = null;
    }

    await refreshOutputs();
    state.note = "";
    if (dirty) changed();
    else render();
  } catch (error) {
    state.note = error.message || "Delete failed";
    render();
  }
}

const ANIM_FADE = 3;

function muteVideo(video) {
  video.muted = true;
  video.defaultMuted = true;
  video.volume = 0;
  video.setAttribute("muted", "");
  video.setAttribute("playsinline", "");
}

function selectAnim(index) {
  if (state.selectedAnim === index && state.selectedOverlay === null) return;
  state.selectedAnim = index;
  state.selectedOverlay = null;
  render();
}

function animCanDrag(entry) {
  return state.pictureExpanded && !entry?.locked;
}

function animChrome(index, entry) {
  const selected = state.selectedAnim === index;
  const locked = !!entry.locked;
  const canDrag = animCanDrag(entry);
  return [
    selected &&
      h(
        "button",
        {
          class: "anim-copy",
          type: "button",
          title: locked
            ? "Copy still again (already locked)"
            : "Copy still for Jim — locks position",
          onClick: (event) => {
            event.stopPropagation();
            exportAnimRegionStill(index);
          },
        },
        downloadIcon()
      ),
    selected && h("div", { class: "anim-mark", "aria-hidden": "true" }),
    selected &&
      h("button", {
        class: "anim-remove",
        type: "button",
        title: "Remove",
        text: "×",
        onClick: (event) => {
          event.stopPropagation();
          sceneAnims().splice(index, 1);
          state.selectedAnim = null;
          changed();
        },
      }),
    selected &&
      canDrag &&
      h("div", {
        class: "anim-handle",
        title: "Resize",
        onPointerdown: (event) => beginAnimResize(event, index),
      }),
  ];
}

function animLayerPointer(event, index, entry) {
  if (event.target.closest(".anim-handle, .anim-remove, .anim-copy, .anim-mark")) return;
  if (!animCanDrag(entry)) {
    event.stopPropagation();
    selectAnim(index);
    return;
  }
  beginAnimMove(event, index);
}

function animLayer(entry, index) {
  const normalized = normalizeAnim(entry);
  sceneAnims()[index] = normalized;
  const selected = state.selectedAnim === index;
  const pending = !normalized.file;
  const locked = !!normalized.locked;

  const canDrag = animCanDrag(normalized);
  if (pending) {
    return h(
      "div",
      {
        class: `anim-layer is-pending${selected ? " selected" : ""}${
          locked ? " is-locked" : ""
        }${canDrag ? " can-drag" : ""}`,
        style: animLayerStyle(normalized),
        title: locked
          ? "Locked — click to select"
          : canDrag
            ? "Drag to move, or Copy still to lock"
            : "Expand the picture to drag or resize",
        onPointerdown: (event) => animLayerPointer(event, index, normalized),
      },
      h("div", { class: "anim-pending-fill", "aria-hidden": "true" }),
      h("span", { class: "anim-pending-label", text: locked ? "Locked" : "Slot" }),
      ...animChrome(index, normalized)
    );
  }

  const rate = Math.min(4, Math.max(0.1, (normalized.speed ?? 100) / 100));
  const soft = normalized.soft_edges ? " soft-edges" : "";
  const look = animCssFilter(normalized);
  const primary = h("video", {
    class: `anim-video${soft}`,
    src: `/${normalized.file}`,
    muted: true,
    playsinline: true,
    preload: "auto",
    "data-anim": String(index),
  });
  const secondary = h("video", {
    class: `anim-video${soft}`,
    src: `/${normalized.file}`,
    muted: true,
    playsinline: true,
    preload: "auto",
    "data-anim": String(index),
  });
  // Opacity lives on wrappers so soft-edge masks don't kill the dissolve.
  const frontWrap = h("div", { class: "anim-video-wrap is-front" }, primary);
  const backWrap = h("div", { class: "anim-video-wrap is-back" }, secondary);
  muteVideo(primary);
  muteVideo(secondary);
  primary.playbackRate = rate;
  secondary.playbackRate = rate;
  primary.style.filter = look;
  secondary.style.filter = look;

  queueMicrotask(() => {
    primary.playbackRate = rate;
    secondary.playbackRate = rate;
    bindSeamlessCrossfade(primary, secondary, frontWrap, backWrap, () =>
      animLoopWindow(normalized, primary.duration || animSourceDuration(normalized))
    );
  });

  const layer = h(
    "div",
    {
      class: `anim-layer aspect-${normalized.aspect || "native"}${selected ? " selected" : ""}${
        locked ? " is-locked" : ""
      }${canDrag ? " can-drag" : ""}`,
      style: animLayerStyle(normalized),
      title: locked
        ? "Locked — click to select"
        : canDrag
          ? "Drag to move"
          : "Expand the picture to drag or resize",
      onPointerdown: (event) => animLayerPointer(event, index, normalized),
    },
    frontWrap,
    backWrap,
    ...animChrome(index, normalized)
  );

  const applyNativeAspect = () => {
    if (Number.isFinite(normalized.h) && normalized.h > 0) return;
    if ((normalized.aspect || "native") !== "native") return;
    if (!primary.videoWidth || !primary.videoHeight) return;
    layer.style.aspectRatio = animAspectCss(normalized, primary);
  };
  primary.addEventListener("loadedmetadata", applyNativeAspect);
  if (primary.readyState >= 1) applyNativeAspect();

  return layer;
}

function animDialRow(label, { min, max, step, value, title, onSlide }) {
  return h(
    "div",
    { class: "anim-dial" },
    h("span", { class: "anim-dial-label", text: label }),
    h("input", {
      class: "anim-dial-range",
      type: "range",
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(value),
      title,
      onInput: (event) => {
        const next = Number(event.target.value);
        onSlide(next, event.target);
      },
      onChange: () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, 400);
      },
    }),
    h("span", { class: "anim-dial-value", text: `${value}%` })
  );
}

function animControlsDial() {
  if (state.selectedAnim === null) return null;
  const list = sceneAnims();
  if (state.selectedAnim >= list.length) return null;
  const entry = normalizeAnim(list[state.selectedAnim]);
  list[state.selectedAnim] = entry;
  if (!entry.file) {
    const aspect = entry.aspect === "portrait" ? "portrait" : "landscape";
    const index = state.selectedAnim;
    return h(
      "div",
      { class: "anim-dials pending-hint" },
      !entry.locked &&
        regionAspectToggle(aspect, (next) => {
          applyAnimAspect(entry, next);
          state.regionAspect = next;
          changed();
        }),
      h("button", {
        class: "btn primary",
        type: "button",
        text: entry.locked ? "Copy again" : "Copy still",
        title: entry.locked
          ? "Copy the still again (slot stays locked)"
          : "Download and copy for Jim — locks this slot",
        onClick: () => exportAnimRegionStill(index),
      }),
      h("span", {
        class: "meta",
        text: entry.locked
          ? "Locked. Upload/add an animation while this slot is selected — it snaps here."
          : state.pictureExpanded
            ? "Drag or resize here, then Copy still to lock. Next animation you add fills this slot."
            : "Expand the picture to drag or resize, then Copy still to lock.",
      })
    );
  }
  const index = state.selectedAnim;

  const setAspect = (next) => {
    entry.aspect = entry.aspect === next ? "native" : next;
    changed();
  };

  return h(
    "div",
    { class: "anim-dials" },
    animDialRow("Light", {
      min: 20,
      max: 180,
      step: 5,
      value: entry.brightness,
      title: "Animation brightness",
      onSlide: (next, input) => {
        entry.brightness = next;
        const label = input.parentElement?.querySelector(".anim-dial-value");
        if (label) label.textContent = `${next}%`;
        const look = animCssFilter(entry);
        document
          .querySelectorAll(".anim-layer.selected .anim-video")
          .forEach((video) => {
            video.style.filter = look;
          });
      },
    }),
    animDialRow("Color", {
      min: 0,
      max: 200,
      step: 5,
      value: entry.saturation,
      title: "Animation saturation",
      onSlide: (next, input) => {
        entry.saturation = next;
        const label = input.parentElement?.querySelector(".anim-dial-value");
        if (label) label.textContent = `${next}%`;
        const look = animCssFilter(entry);
        document
          .querySelectorAll(".anim-layer.selected .anim-video")
          .forEach((video) => {
            video.style.filter = look;
          });
      },
    }),
    animDialRow("Speed", {
      min: 25,
      max: 200,
      step: 5,
      value: entry.speed,
      title: "Animation speed",
      onSlide: (next, input) => {
        entry.speed = next;
        const label = input.parentElement?.querySelector(".anim-dial-value");
        if (label) label.textContent = `${next}%`;
        const rate = Math.min(4, Math.max(0.1, next / 100));
        document
          .querySelectorAll(`video[data-anim="${CSS.escape(String(index))}"]`)
          .forEach((video) => {
            video.playbackRate = rate;
          });
      },
    }),
    h(
      "div",
      { class: "anim-aspect" },
      h("span", { class: "anim-dial-label", text: "Frame" }),
      h(
        "div",
        { class: "anim-aspect-choices" },
        h("button", {
          class: `anim-aspect-btn landscape${entry.aspect === "landscape" ? " on" : ""}`,
          type: "button",
          title: entry.aspect === "landscape" ? "Use native frame" : "16:9 landscape",
          "aria-label": "Landscape 16 by 9",
          onClick: () => setAspect("landscape"),
        }),
        h("button", {
          class: `anim-aspect-btn portrait${entry.aspect === "portrait" ? " on" : ""}`,
          type: "button",
          title: entry.aspect === "portrait" ? "Use native frame" : "9:16 portrait",
          "aria-label": "Portrait 9 by 16",
          onClick: () => setAspect("portrait"),
        })
      ),
      h("span", {
        class: "anim-dial-value",
        text: entry.aspect === "native" ? "native" : entry.aspect === "landscape" ? "16:9" : "9:16",
      })
    ),
    h(
      "label",
      { class: `anim-check${entry.soft_edges ? " on" : ""}` },
      h("input", {
        type: "checkbox",
        checked: entry.soft_edges,
        onChange: () => {
          entry.soft_edges = !entry.soft_edges;
          changed();
        },
      }),
      h("span", { text: "Fade edges" })
    ),
    animTrimControl(entry, index)
  );
}

function animTrimControl(entry, index) {
  const duration = animSourceDuration(entry);
  if (!duration) {
    return h("p", {
      class: "empty-note",
      text: "Loop trim available once the clip duration is known",
    });
  }
  const { start, end } = animLoopWindow(entry, duration);
  const pct = (value) => `${(value / duration) * 100}%`;

  const applyTrim = (nextIn, nextOut) => {
    let loopIn = Math.max(0, Math.min(nextIn, duration - 0.25));
    let loopOut = Math.max(loopIn + 0.25, Math.min(nextOut, duration));
    entry.loop_in = loopIn;
    entry.loop_out = loopOut;
    const fill = document.querySelector(".anim-trim-fill");
    if (fill) {
      fill.style.left = pct(loopIn);
      fill.style.width = pct(loopOut - loopIn);
    }
    const label = document.querySelector(".anim-trim-value");
    if (label) label.textContent = `${clock(loopIn)}–${clock(loopOut)}`;
    const startInput = document.querySelector(".anim-trim-start");
    const endInput = document.querySelector(".anim-trim-end");
    if (startInput) startInput.value = String(loopIn);
    if (endInput) endInput.value = String(loopOut);
    document.querySelectorAll(`video[data-anim="${CSS.escape(String(index))}"]`).forEach((video) => {
      if (video.currentTime < loopIn || video.currentTime > loopOut) {
        try {
          video.currentTime = loopIn;
        } catch {
          /* ignore */
        }
      }
    });
  };

  return h(
    "div",
    { class: "anim-trim" },
    h("span", { class: "anim-dial-label", text: "Loop" }),
    h(
      "div",
      { class: "anim-trim-rail" },
      h("div", {
        class: "anim-trim-fill",
        style: { left: pct(start), width: pct(end - start) },
      }),
      h("input", {
        class: "anim-trim-start",
        type: "range",
        min: "0",
        max: String(duration),
        step: "0.05",
        value: String(start),
        title: "Loop start",
        onInput: (event) => applyTrim(Number(event.target.value), entry.loop_out ?? duration),
        onChange: () => {
          clearTimeout(saveTimer);
          saveTimer = setTimeout(save, 400);
        },
      }),
      h("input", {
        class: "anim-trim-end",
        type: "range",
        min: "0",
        max: String(duration),
        step: "0.05",
        value: String(end),
        title: "Loop end",
        onInput: (event) => applyTrim(entry.loop_in ?? 0, Number(event.target.value)),
        onChange: () => {
          clearTimeout(saveTimer);
          saveTimer = setTimeout(save, 400);
        },
      })
    ),
    h("span", { class: "anim-dial-value anim-trim-value", text: `${clock(start)}–${clock(end)}` })
  );
}

function bindSeamlessCrossfade(
  front,
  back,
  frontDisplay = front,
  backDisplay = back,
  rangeFor = null
) {
  if (!front || !back || front.dataset.crossfade === "1") return;
  front.dataset.crossfade = "1";
  muteVideo(front);
  muteVideo(back);
  front.loop = false;
  back.loop = false;
  frontDisplay.style.opacity = "1";
  backDisplay.style.opacity = "0";

  let fading = false;
  let lead = front;
  let trail = back;
  let leadDisplay = frontDisplay;
  let trailDisplay = backDisplay;
  let raf = 0;

  const windowOf = () => {
    const live =
      Number.isFinite(lead.duration) && lead.duration > 0
        ? lead.duration
        : Number.isFinite(front.duration) && front.duration > 0
          ? front.duration
          : 0;
    if (!rangeFor) return { start: 0, end: live, duration: live };
    const ranged = rangeFor();
    const full = live || ranged.duration || 0;
    if (!full) return { start: 0, end: 0, duration: 0 };
    // If trim helpers ran before duration was known, fall back to the full clip.
    if (!ranged.duration && !ranged.end) return { start: 0, end: full, duration: full };
    let start = Number.isFinite(ranged.start) ? ranged.start : 0;
    let end = Number.isFinite(ranged.end) && ranged.end > 0 ? ranged.end : full;
    start = Math.max(0, Math.min(start, Math.max(0, full - 0.25)));
    end = Math.max(start + 0.25, Math.min(end, full));
    return { start, end, duration: full };
  };

  const seekTo = (video, time) =>
    new Promise((resolve) => {
      if (!Number.isFinite(time)) {
        resolve();
        return;
      }
      const done = () => {
        video.removeEventListener("seeked", done);
        resolve();
      };
      video.addEventListener("seeked", done);
      try {
        const already = Math.abs((video.currentTime || 0) - time) < 0.04;
        video.currentTime = time;
        if (already || video.readyState < 1) {
          video.removeEventListener("seeked", done);
          resolve();
        }
      } catch {
        video.removeEventListener("seeked", done);
        resolve();
      }
    });

  const playMuted = async (video) => {
    muteVideo(video);
    video.loop = false;
    const rate = Math.max(0.1, lead.playbackRate || video.playbackRate || 1);
    video.playbackRate = rate;
    try {
      await video.play();
    } catch {
      /* autoplay can fail until a gesture; ignore */
    }
  };

  const nearLoopEnd = () => {
    const { start, end, duration } = windowOf();
    const span = Math.max(0, end - start);
    if (!duration || span < 0.2) return false;
    const fade = Math.min(ANIM_FADE, Math.max(0.15, Math.min(span * 0.4, span - 0.05)));
    const t = lead.currentTime || 0;
    // Don't trust a stale ended flag after seeks — require being near the window end.
    return t >= end - fade || (lead.ended && t >= end - 0.15);
  };

  const startFade = async () => {
    if (fading || !front.isConnected) return;
    const { start, end, duration } = windowOf();
    const span = Math.max(0, end - start);
    if (!Number.isFinite(duration) || span < 0.2) {
      await seekTo(lead, start);
      playMuted(lead);
      return;
    }
    fading = true;
    // Prefer a visible dissolve; short windows get a shorter fade, not a hard cut.
    const fade = Math.min(ANIM_FADE, Math.max(0.15, Math.min(span * 0.4, span - 0.05)));
    trail.playbackRate = Math.max(0.1, lead.playbackRate || 1);
    await seekTo(trail, start);
    await playMuted(trail);
    const started = performance.now();
    const rate = Math.max(0.1, lead.playbackRate || 1);
    const fadeMs = (fade / rate) * 1000;
    const tick = (now) => {
      if (!front.isConnected) return;
      const t = Math.min(1, (now - started) / Math.max(fadeMs, 1));
      leadDisplay.style.opacity = String(1 - t);
      trailDisplay.style.opacity = String(t);
      if (t < 1) {
        requestAnimationFrame(tick);
        return;
      }
      lead.pause();
      seekTo(lead, start);
      leadDisplay.style.opacity = "0";
      trailDisplay.style.opacity = "1";
      const swap = lead;
      lead = trail;
      trail = swap;
      const swapDisplay = leadDisplay;
      leadDisplay = trailDisplay;
      trailDisplay = swapDisplay;
      fading = false;
    };
    requestAnimationFrame(tick);
  };

  const watch = () => {
    if (!front.isConnected) {
      cancelAnimationFrame(raf);
      return;
    }
    if (!fading) {
      const { start, end, duration } = windowOf();
      if (Number.isFinite(duration) && duration > 0) {
        const t = lead.currentTime || 0;
        if (t < start - 0.02) seekTo(lead, start);
        // Clamp runaway playback past the loop window before the next frame paints.
        if (t > end + 0.02) {
          startFade();
        } else if (nearLoopEnd()) {
          startFade();
        }
      }
    }
    raf = requestAnimationFrame(watch);
  };

  front.addEventListener("ended", (event) => {
    if (event.target === lead) startFade();
  });
  back.addEventListener("ended", (event) => {
    if (event.target === lead) startFade();
  });

  const boot = async () => {
    const { start } = windowOf();
    await seekTo(front, start);
    await playMuted(front);
    // Warm the trail so the first crossfade has frames ready.
    seekTo(back, start);
    raf = requestAnimationFrame(watch);
  };
  if (front.readyState >= 1) boot();
  else front.addEventListener("loadedmetadata", boot, { once: true });
}

function beginAnimMove(event, index) {
  event.preventDefault();
  event.stopPropagation();
  const picture = event.currentTarget.closest(".picture");
  const layer = event.currentTarget;
  const entry = normalizeAnim(sceneAnims()[index]);
  sceneAnims()[index] = entry;
  if (!animCanDrag(entry)) {
    selectAnim(index);
    return;
  }
  if (state.selectedAnim !== index || state.selectedOverlay !== null) {
    state.selectedAnim = index;
    state.selectedOverlay = null;
    layer.classList.add("selected");
  }
  const box = picture.getBoundingClientRect();
  const startX = event.clientX;
  const startY = event.clientY;
  const originX = entry.x;
  const originY = entry.y;

  layer.setPointerCapture(event.pointerId);
  const move = (moveEvent) => {
    entry.x = Math.min(1 - entry.w, Math.max(0, originX + (moveEvent.clientX - startX) / box.width));
    entry.y = Math.min(0.92, Math.max(0, originY + (moveEvent.clientY - startY) / box.height));
    layer.style.left = `${entry.x * 100}%`;
    layer.style.top = `${entry.y * 100}%`;
  };
  const up = () => {
    layer.releasePointerCapture(event.pointerId);
    layer.removeEventListener("pointermove", move);
    layer.removeEventListener("pointerup", up);
    layer.removeEventListener("pointercancel", up);
    state.selectedAnim = index;
    changed();
  };
  layer.addEventListener("pointermove", move);
  layer.addEventListener("pointerup", up);
  layer.addEventListener("pointercancel", up);
}

function beginAnimResize(event, index) {
  event.preventDefault();
  event.stopPropagation();
  const handle = event.currentTarget;
  const layer = handle.closest(".anim-layer");
  const picture = layer.closest(".picture");
  const entry = normalizeAnim(sceneAnims()[index]);
  sceneAnims()[index] = entry;
  if (!animCanDrag(entry)) return;
  const box = picture.getBoundingClientRect();
  const startX = event.clientX;
  const originW = entry.w;
  const originH = entry.h;
  const keepRatio = Number.isFinite(originH) && originH > 0 && originW > 0;

  handle.setPointerCapture(event.pointerId);
  const move = (moveEvent) => {
    entry.w = Math.min(1 - entry.x, Math.max(0.08, originW + (moveEvent.clientX - startX) / box.width));
    layer.style.width = `${entry.w * 100}%`;
    if (keepRatio) {
      entry.h = Math.min(1 - entry.y, Math.max(0.04, originH * (entry.w / originW)));
      layer.style.height = `${entry.h * 100}%`;
      layer.style.aspectRatio = "auto";
    }
  };
  const up = () => {
    handle.releasePointerCapture(event.pointerId);
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
    state.selectedAnim = index;
    changed();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
}

function playerBar(total, mode) {
  const fill = h("div", { class: "fill" });
  const knob = h("div", { class: "knob" });
  const elapsed = h("span", { class: "meta time", text: clock(player.at) });
  const rail = h(
    "div",
    { class: "rail", onPointerdown: (event) => beginScrub(event, rail, total) },
    h("div", { class: "rail-fill" }, fill),
    knob
  );

  scrubber = { fill, knob, elapsed, rows: [], cards: [] };

  return h(
    "div",
    { class: `player${mode === "video" ? " video-player" : ""}` },
    h(
      "button",
      {
        type: "button",
        class: "play",
        disabled: !total,
        title: player.playing ? "Pause" : "Play",
        onClick: togglePlay,
        text: player.loading ? "\u2026" : player.playing ? "\u23f8" : "\u25b6",
      }
    ),
    elapsed,
    rail,
    h("span", { class: "meta time", text: clock(total) })
  );
}

function beginScrub(event, rail, total) {
  if (!total) return;
  const box = rail.getBoundingClientRect();
  const to = (clientX) => seekTo(((clientX - box.left) / box.width) * total);
  rail.setPointerCapture(event.pointerId);
  to(event.clientX);
  const move = (moveEvent) => to(moveEvent.clientX);
  const done = () => {
    rail.removeEventListener("pointermove", move);
    rail.removeEventListener("pointerup", done);
    rail.removeEventListener("pointercancel", done);
  };
  rail.addEventListener("pointermove", move);
  rail.addEventListener("pointerup", done);
  rail.addEventListener("pointercancel", done);
}

function placeSong(fromIndex, insertAt) {
  const list = sceneSongs();
  let at = insertAt;
  if (fromIndex < at) at -= 1;
  if (at === fromIndex) {
    state.movingSong = null;
    render();
    return;
  }
  const [moved] = list.splice(fromIndex, 1);
  list.splice(Math.max(0, Math.min(at, list.length)), 0, moved);
  state.movingSong = null;
  changed();
}

function songSlot(insertAt, fromIndex) {
  if (insertAt === fromIndex || insertAt === fromIndex + 1) return null;
  return h("button", {
    class: "song-slot",
    type: "button",
    title: "Place here",
    "aria-label": "Place song here",
    onClick: () => placeSong(fromIndex, insertAt),
  });
}

function playlist(list) {
  const moving = state.movingSong;
  const placing = moving !== null;
  const rows = [];
  const scrubRows = [];

  if (placing) {
    const slot = songSlot(0, moving);
    if (slot) rows.push(slot);
  }

  list.forEach((song, index) => {
    const row = h(
      "div",
      {
        class: `song-row${song.missing ? " missing" : ""}${moving === index ? " moving" : ""}`,
        onClick: (event) => {
          if (placing || event.target.closest(".handle, .trash")) return;
          seekTo(song.start);
        },
      },
      h(
        "button",
        {
          class: "handle",
          type: "button",
          title: placing && moving === index ? "Cancel move" : "Move song",
          "aria-label": placing && moving === index ? "Cancel move" : "Move song",
          onClick: (event) => {
            event.stopPropagation();
            state.movingSong = moving === index ? null : index;
            render();
          },
        },
        gripIcon()
      ),
      h("span", { class: "index", text: String(index + 1) }),
      h("span", { class: "name", text: song.title }),
      h("span", { class: "at", text: clock(song.start) }),
      h("span", { class: "len", text: song.missing ? "missing" : clock(song.duration) }),
      h(
        "button",
        {
          class: "trash",
          type: "button",
          title: "Remove song",
          onClick: (event) => {
            event.stopPropagation();
            sceneSongs().splice(index, 1);
            state.movingSong = null;
            if (!sceneSongs().length) state.pickerOpen = true;
            changed();
          },
        },
        trashIcon()
      )
    );
    scrubRows.push(row);
    rows.push(row);
    if (placing) {
      const slot = songSlot(index + 1, moving);
      if (slot) rows.push(slot);
    }
  });

  return {
    rows: scrubRows,
    node: h(
      "div",
      { class: "playlist-wrap" },
      h(
        "div",
        { class: `playlist${placing ? " is-placing" : ""}` },
        rows.length
          ? rows.filter(Boolean)
          : h("p", {
              class: "empty-note drop-hint",
              text: "No songs yet — check songs in the library",
            })
      ),
      addSongControl()
    ),
  };
}

function addSongControl() {
  const available = state.assets.music;
  return h(
    "div",
    { class: "add-song" },
    h(
      "button",
      {
        class: "btn ghost add",
        type: "button",
        disabled: !available.length,
        onClick: () => {
          state.pickerOpen = !state.pickerOpen;
          render();
        },
      },
      "+  Add song"
    ),
    state.pickerOpen &&
      h(
        "div",
        { class: "picker" },
        available.map((song) =>
          h(
            "button",
            {
              class: "picker-row",
              type: "button",
              onClick: () => {
                sceneSongs().push(song.path);
                state.pickerOpen = false;
                changed();
              },
            },
            h("span", { class: "media-note", text: "\u266a" }),
            h("span", { class: "name", text: song.name }),
            h("span", { class: "len", text: clock(song.duration) })
          )
        )
      )
  );
}

function renderStatus() {
  if (state.render.status === "running" && state.render.video === state.videoId) {
    return h(
      "div",
      { class: "progress" },
      h("div", { class: "track" }, h("div", { class: "fill", style: { width: `${state.render.percent}%` } })),
      h("span", { class: "meta", text: `${state.render.percent}%` })
    );
  }
  if (state.render.status === "error" && state.render.video === state.videoId) {
    return h("div", { class: "callout error", text: state.render.message || "The render failed" });
  }
  return null;
}

/* ---------- drag and drop ---------- */

function startDrag(event, payload, subject = null) {
  drag = payload;
  event.dataTransfer.effectAllowed = payload.from === "library" ? "copy" : "move";
  event.dataTransfer.setData("text/plain", payload.from);
  (subject || event.currentTarget).classList.add("dragging");
}

function endDrag() {
  drag = null;
  document.querySelectorAll(".dragging").forEach((node) => node.classList.remove("dragging"));
  clearMarks();
}

function clearMarks() {
  document
    .querySelectorAll(".drop-above, .drop-below, .drop-into, .drop-before, .drop-after")
    .forEach((node) =>
      node.classList.remove("drop-above", "drop-below", "drop-into", "drop-before", "drop-after")
    );
}

function listDragOver(event) {
  if (!drag || (drag.from !== "library" && drag.from !== "list")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = drag.from === "library" ? "copy" : "move";
  if (!event.currentTarget.querySelector(".song-row")) {
    clearMarks();
    event.currentTarget.classList.add("drop-into");
  }
}

function rowDragOver(event, index) {
  if (!drag || (drag.from !== "library" && drag.from !== "list")) return;
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = drag.from === "library" ? "copy" : "move";
  const box = event.currentTarget.getBoundingClientRect();
  const below = event.clientY > box.top + box.height / 2;
  clearMarks();
  event.currentTarget.classList.add(below ? "drop-below" : "drop-above");
}

function rowDrop(event, index) {
  if (!drag || (drag.from !== "library" && drag.from !== "list")) return;
  event.preventDefault();
  event.stopPropagation();

  let at = index;
  if (event.currentTarget.classList.contains("song-row")) {
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientY > box.top + box.height / 2) at += 1;
  }
  clearMarks();

  const list = sceneSongs();
  if (drag.from === "library") {
    list.splice(at, 0, drag.path);
  } else {
    const [moved] = list.splice(drag.index, 1);
    if (drag.index < at) at -= 1;
    list.splice(at, 0, moved);
  }
  drag = null;
  changed();
}

/* ---------- go ---------- */

window.addEventListener("popstate", () => {
  applyRoute();
});

window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "s") {
    event.preventDefault();
    save();
  }
  if (event.key === "Escape") {
    if (state.pickerOpen) {
      state.pickerOpen = false;
      render();
      return;
    }
    if (state.regionTool) {
      state.regionTool = false;
      state.note = "";
      render();
      return;
    }
    if (state.pictureExpanded) {
      state.pictureExpanded = false;
      state.regionTool = false;
      render();
      return;
    }
    if (
      state.movingScene !== null ||
      state.movingSong !== null ||
      state.placingTransition !== null
    ) {
      state.movingScene = null;
      state.movingSong = null;
      state.placingTransition = null;
      render();
      return;
    }
    if (state.selectedAnim !== null || state.selectedOverlay !== null) {
      state.selectedAnim = null;
      state.selectedOverlay = null;
      render();
      return;
    }
    if (state.page === "scene") go("video", { videoId: state.videoId });
    else if (state.page === "video") go("list");
  }
  if (
    event.code === "Space" &&
    !event.target.closest("input, textarea, button, a") &&
    state.page !== "list" &&
    state.page !== "landing"
  ) {
    event.preventDefault();
    togglePlay();
  }
});

document.addEventListener("pointerdown", (event) => {
  if (!state.pickerOpen) return;
  if (event.target.closest(".add-song")) return;
  state.pickerOpen = false;
  render();
});

applyRoute();
