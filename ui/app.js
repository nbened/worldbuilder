// Landing → jars → jar → video → scene.
// Paths: /, /jars, /jar?j=, /video?v=&j=, /scene?v=&s=&j=

const state = {
  page: "landing", // landing | jars | jar | video | scene
  jarId: null,
  jar: null, // jar document (rules, prompt, …)
  jarMeta: null, // { id, title, descriptor }
  jars: [],
  videoId: null,
  site: null, // ui/site.json — landing copy, etc.
  videos: [],
  script: null,
  assets: { images: [], music: [], sounds: [], effects: [], animations: [] },
  selectedAnim: null,
  selectedEdit: null,
  selectedOverlay: null, // "credit" | "now_playing" | null
  outputs: { video: { ready: false }, scenes: {} },
  render: { status: "idle", percent: 0, ready: false },
  /** Bottom-right process panel: { open, jobs[], cancelling } or null */
  processPanel: null,
  sceneIndex: 0,
  saving: false,
  note: "",
  pickerOpen: false,
  movingScene: null, // index of scene waiting to be placed, or null
  placingTransition: null, // index of multi-use transition waiting to be placed, or null
  editingTransitionVariant: null, // scene index of placement whose zoom rects are being edited
  movingSong: null, // index of song waiting to be placed, or null
  pruneImages: false,
  pruneSongs: false,
  pruneSounds: false,
  pruneAnims: false,
  renamingPath: null,
  pictureExpanded: false,
  imagePickerOpen: false, // on-picture image dropdown next to expand
  regionTool: false, // draw a still or animation slot
  regionKind: "animation", // "animation" | "still"
  regionAspect: "landscape", // landscape = 16:9, portrait = 9:16
  shortCut: null, // { open, cx, duration, pendingDownload } — 9:16 scene snip
  landingMuted: true, // landing hero starts muted for autoplay; speaker toggles
  detailsDirty: false,
  detailsOpen: false,
  sceneDetailsOpen: false,
  transitionSettingsOpen: false,
  /** AI still generation on the scene page */
  sceneGen: {
    revealed: false, // show composed OpenAI prompt (disabled field)
    videoPromptOpen: false, // toggle for episode/video prompt above scene describe
    status: "idle", // idle | generating | error
    error: "",
  },
  /** Inline still edit: crop → Claude → ChatGPT image edit */
  stillGen: {
    change: "",
    jarToClaude: "", // Wonderjar → Claude instruction
    status: "idle", // idle | prompting | imaging | error
    editPrompt: "", // Claude → ChatGPT prompt
    useClaude: true,
    promptDone: false,
    imageDone: false,
    error: "",
    editIndex: null,
    collapsed: false,
    panelX: null, // dragged panel position (px)
    panelY: null,
  },
  /** Inline anim: crop → Claude → Veo */
  animGen: {
    change: "",
    jarToClaude: "", // Wonderjar → Claude (Veo) instruction
    status: "idle", // idle | prompting | imaging | error
    veoPrompt: "", // Claude → Veo prompt
    useClaude: true,
    promptDone: false,
    imageDone: false,
    error: "",
    animIndex: null,
    collapsed: false,
    panelX: null,
    panelY: null,
  },
  models: {
    anthropic: "",
    openaiImage: "",
    veo: "",
  },
  /** Per-video API cost ledger (estimated) */
  ledger: {
    open: false,
    loading: false,
    total: 0,
    entries: [],
    error: "",
  },
  libraryShowAll: {
    effects: false,
    animations: false,
    images: true, // images live in their own left rail — browse full library by default
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

function pictureIcon() {
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
    h("rect", { x: "2.5", y: "3.5", width: "11", height: "9", rx: "1.2" }),
    h("circle", { cx: "5.75", cy: "6.5", r: "1" }),
    h("path", { d: "M2.8 11.2 6.2 8.3l2.2 2.1 1.5-1.4 3.2 2.2" })
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

function withJarParam(url, jarId = state.jarId) {
  if (!jarId) return url;
  return `${url}${url.includes("?") ? "&" : "?"}j=${encodeURIComponent(jarId)}`;
}

function readRoute() {
  const path = location.pathname.replace(/\/$/, "") || "/";
  const params = new URLSearchParams(location.search);
  const jarId = params.get("j");
  if (path === "/video") {
    return { page: "video", videoId: params.get("v"), sceneIndex: 0, jarId };
  }
  if (path === "/scene") {
    return {
      page: "scene",
      videoId: params.get("v"),
      sceneIndex: Math.max(0, Number(params.get("s") || 0)),
      jarId,
    };
  }
  if (path === "/jar") {
    return { page: "jar", videoId: null, sceneIndex: 0, jarId: params.get("j") };
  }
  if (path === "/jars" || path === "/videos") {
    // /videos kept as alias → jars list
    return { page: "jars", videoId: null, sceneIndex: 0, jarId: null };
  }
  return { page: "landing", videoId: null, sceneIndex: 0, jarId: null };
}

function go(
  page,
  {
    videoId = state.videoId,
    sceneIndex = state.sceneIndex,
    jarId = state.jarId,
    editingVariant = undefined,
  } = {}
) {
  if (editingVariant !== undefined) state.editingTransitionVariant = editingVariant;
  let url = "/";
  if (page === "jars" || page === "list") url = "/jars";
  if (page === "jar") url = `/jar?j=${encodeURIComponent(jarId || "")}`;
  if (page === "video") {
    url = withJarParam(`/video?v=${encodeURIComponent(videoId)}`, jarId);
  }
  if (page === "scene") {
    url = withJarParam(
      `/scene?v=${encodeURIComponent(videoId)}&s=${sceneIndex}`,
      jarId
    );
  }
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
  state.selectedEdit = null;
  state.selectedOverlay = null;
  state.pictureExpanded = false;
  state.regionTool = false;
  state.shortCut = null;
  overlayUi = null;
  if (!state.models?.anthropic || !state.models?.openaiImage) {
    await loadModels();
  }

  if (route.page === "landing") {
    state.videoId = null;
    state.script = null;
    state.jarId = null;
    state.jar = null;
    state.jarMeta = null;
    await loadSite();
    render();
    return;
  }

  if (route.page === "jars") {
    state.videoId = null;
    state.script = null;
    state.jarId = null;
    state.jar = null;
    state.jarMeta = null;
    await loadJars();
    render();
    return;
  }

  if (route.page === "jar") {
    state.videoId = null;
    state.script = null;
    if (!route.jarId) {
      history.replaceState({}, "", "/jars");
      await applyRoute();
      return;
    }
    const ok = await loadJar(route.jarId);
    if (!ok) {
      history.replaceState({}, "", "/jars");
      await applyRoute();
      return;
    }
    render();
    return;
  }

  if (!route.videoId) {
    history.replaceState({}, "", "/jars");
    await applyRoute();
    return;
  }

  if (state.videoId !== route.videoId || !state.script) {
    const ok = await loadVideo(route.videoId, route.jarId);
    if (!ok) {
      history.replaceState({}, "", "/jars");
      await applyRoute();
      return;
    }
  } else if (route.jarId && route.jarId !== state.jarId) {
    state.jarId = route.jarId;
    await loadJar(route.jarId, { soft: true });
  }

  let nextScene = Math.min(route.sceneIndex, Math.max(0, scenes().length - 1));
  if (route.page === "scene") {
    const canonical = canonicalizeTransitionSceneIndex(nextScene);
    if (canonical !== nextScene) {
      nextScene = canonical;
      history.replaceState(
        {},
        "",
        withJarParam(
          `/scene?v=${encodeURIComponent(state.videoId)}&s=${nextScene}`,
          state.jarId
        )
      );
    }
  }
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
  ensureTransitionIds();
  if (!state.script.scenes.length) state.script.scenes.push(blankScene());
}

function newTransitionId() {
  return `t_${Math.random().toString(36).slice(2, 10)}`;
}

/** Templates get a stable id; thin placements use transition_of → that id. */
function ensureTransitionIds() {
  for (const entry of state.script.scenes || []) {
    if (!entry?.is_transition) continue;
    if (entry.transition_of) continue;
    if (typeof entry.id !== "string" || !entry.id) entry.id = newTransitionId();
  }
}

function isTransitionVariant(entry) {
  return !!entry?.is_transition && !!entry.transition_of;
}

function isTransitionTemplate(entry) {
  return !!entry?.is_transition && !entry.transition_of;
}

/** Shared config (map, timing, style) for a transition or one of its variants. */
function resolveTransition(entry) {
  if (!entry?.is_transition) return entry;
  const ref = entry.transition_of;
  if (!ref) return entry;
  const template = (state.script?.scenes || []).find(
    (scene) => isTransitionTemplate(scene) && scene.id === ref
  );
  return template || entry;
}

function transitionTemplateIndex(entry) {
  const template = resolveTransition(entry);
  if (!template) return -1;
  return scenes().findIndex((scene) => scene === template);
}

/**
 * Variants share the template scene; only zoom in/out rects (+ includes) differ.
 * Returns the entry that owns those rects for this placement.
 */
function transitionZoomOwner(entry) {
  if (!entry?.is_transition) return entry;
  if (isTransitionVariant(entry)) {
    seedVariantFadeZoom(entry);
    return entry;
  }
  return entry;
}

/** Copy template rects onto a thin variant once, then they can diverge. */
function seedVariantFadeZoom(variant) {
  if (!variant || typeof variant !== "object") return;
  if (variant.fade_zoom && typeof variant.fade_zoom === "object") {
    normalizeFadeZoomBlock(variant);
    return;
  }
  const template = resolveTransition(variant);
  const tz = normalizeFadeZoomBlock(template || variant);
  variant.fade_zoom = {
    include_start: tz.include_start,
    include_end: tz.include_end,
    start: { ...tz.start },
    end: { ...tz.end },
  };
  normalizeFadeZoomBlock(variant);
}

/** Which placement's zoom rects are active on the transition config page. */
function editingTransitionPlacementIndex() {
  const template = scene();
  if (!isTransitionTemplate(template)) return state.sceneIndex;
  const idx = state.editingTransitionVariant;
  if (idx != null) {
    const entry = scenes()[idx];
    if (entry?.is_transition && resolveTransition(entry)?.id === template.id) return idx;
  }
  const rows = transitionPlacementRows(template);
  const selfPlaced = rows.find((row) => row.index === state.sceneIndex);
  if (selfPlaced) return selfPlaced.index;
  const first = rows[0];
  return first ? first.index : state.sceneIndex;
}

function editingTransitionPlacement() {
  return scenes()[editingTransitionPlacementIndex()] || scene();
}

function openTransitionVariant(placementIndex) {
  const entry = scenes()[placementIndex];
  if (!entry?.is_transition) return;
  const templateIndex = transitionTemplateIndex(entry);
  const openIndex = templateIndex >= 0 ? templateIndex : placementIndex;
  go("scene", {
    videoId: state.videoId,
    sceneIndex: openIndex,
    editingVariant: placementIndex,
  });
}

/** Neighboring normal scenes for a transition index (skipping other transitions). */
function transitionNeighbors(index) {
  const list = scenes();
  let prev = null;
  let next = null;
  for (let j = index - 1; j >= 0; j -= 1) {
    if (!list[j].is_transition) {
      prev = list[j];
      break;
    }
  }
  for (let j = index + 1; j < list.length; j += 1) {
    if (!list[j].is_transition) {
      next = list[j];
      break;
    }
  }
  return { prev, next };
}

/**
 * Real timeline placement (red dot), not a pool-only template.
 * Mid-gap always counts. Open/close count for variants, and for a template
 * sitting before the first scene (legacy “start” transition). Templates parked
 * after the last scene are config-only and hidden.
 */
function isTimelineTransition(index) {
  const list = scenes();
  const entry = list[index];
  if (!entry?.is_transition) return false;
  const { prev, next } = transitionNeighbors(index);
  if (prev && next) return true;
  if (!prev && next) return true; // opening (before first scene)
  if (prev && !next) return isTransitionVariant(entry); // closing variant only
  return false;
}

/** 1-based variant number among timeline placements of this transition. */
function transitionVariantNumber(index) {
  const list = scenes();
  const entry = list[index];
  if (!entry?.is_transition || !isTimelineTransition(index)) return null;
  const template = resolveTransition(entry);
  const id = template?.id;
  if (!id) return 1;
  let n = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (!isTimelineTransition(i)) continue;
    if (resolveTransition(list[i])?.id !== id) continue;
    n += 1;
    if (i === index) return n;
  }
  return n || 1;
}

function transitionPlacementRows(template) {
  const id = template?.id;
  if (!id) return [];
  const list = scenes();
  const rows = [];
  let variant = 0;
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    if (!isTimelineTransition(i)) continue;
    if (resolveTransition(entry)?.id !== id) continue;
    variant += 1;
    const { prev, next } = transitionNeighbors(i);
    rows.push({
      index: i,
      variant,
      prev,
      next,
      linked: isTransitionVariant(entry),
      open: !prev && !!next,
      close: !!prev && !next,
    });
  }
  return rows;
}

/** If the route points at a thin variant, open the shared config instead. */
function canonicalizeTransitionSceneIndex(index) {
  const entry = scenes()[index];
  if (!isTransitionVariant(entry)) return index;
  const templateIndex = transitionTemplateIndex(entry);
  return templateIndex >= 0 ? templateIndex : index;
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
  const n = scenes().filter((scene) => isTransitionTemplate(scene)).length + 1;
  entry.is_transition = true;
  entry.id = newTransitionId();
  entry.title = `Transition ${n}`;
  entry.tracks = [];
  entry.map = { seconds: DEFAULT_MAP_SECONDS };
  entry.transition_in = "fade_zoom";
  entry.transition_out = "fade_zoom";
  entry.fade_zoom = {
    seconds: DEFAULT_ZOOM_SECONDS,
    include_start: true,
    include_end: true,
    start: defaultZoomRect(0.15, 0.2),
    end: defaultZoomRect(0.5, 0.25),
  };
  return entry;
}

const TRANSITION_FX = [
  { id: "fade", label: "Fade" },
  { id: "fade_zoom", label: "Fade zoom" },
];

/** Normalized w/h for a 16:9 zoom rect inside the 3:2 picture frame. */
function zoomRectNormWH() {
  return regionNormWH("landscape");
}

/** Fixed zoom target size: 1/4 of the picture wide, 16:9 tall. */
const ZOOM_RECT_W = 0.25;

function zoomRectSize() {
  const want = zoomRectNormWH();
  return { w: ZOOM_RECT_W, h: ZOOM_RECT_W / want };
}

function defaultZoomRect(x = 0.15, y = 0.2) {
  const { w, h } = zoomRectSize();
  return clampZoomRect({ x, y, w, h }, { x, y, w, h });
}

function clampZoomRect(rect, fallback) {
  const clamp01 = (value, fb) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fb;
  };
  const src = rect && typeof rect === "object" ? rect : {};
  const { w, h } = zoomRectSize();
  const fb = fallback || { x: 0.15, y: 0.2, w, h };
  let x = clamp01(src.x, fb.x);
  let y = clamp01(src.y, fb.y);
  // Same size for every Start/End rect — only position varies.
  x = Math.min(1 - w, Math.max(0, x));
  y = Math.min(1 - h, Math.max(0, y));
  return { x, y, w, h };
}

/** Normalize fade_zoom on this exact entry (no template resolve). */
function normalizeFadeZoomBlock(entry) {
  if (!entry || typeof entry !== "object") {
    return {
      seconds: DEFAULT_ZOOM_SECONDS,
      include_start: true,
      include_end: true,
      start: defaultZoomRect(0.15, 0.2),
      end: defaultZoomRect(0.5, 0.25),
    };
  }
  if (!entry.fade_zoom || typeof entry.fade_zoom !== "object") {
    entry.fade_zoom = {};
  }
  const z = entry.fade_zoom;

  // Migrate legacy flat {x,y,w,h} into start/end rectangles.
  if (!z.start || typeof z.start !== "object") {
    if (Number.isFinite(Number(z.x)) || Number.isFinite(Number(z.w))) {
      z.start = clampZoomRect(z, defaultZoomRect(0.15, 0.2));
    } else {
      z.start = defaultZoomRect(0.15, 0.2);
    }
  }
  if (!z.end || typeof z.end !== "object") {
    z.end = clampZoomRect(z.start, defaultZoomRect(0.5, 0.25));
    if (Math.abs(z.end.x - z.start.x) < 0.02 && Math.abs(z.end.y - z.start.y) < 0.02) {
      z.end = clampZoomRect(
        { x: Math.min(0.55, z.start.x + 0.3), y: z.start.y, w: z.start.w, h: z.start.h },
        z.start
      );
    }
  }
  z.start = clampZoomRect(z.start, defaultZoomRect(0.15, 0.2));
  z.end = clampZoomRect(z.end, defaultZoomRect(0.5, 0.25));
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
  if (Number.isFinite(zoomSecs) && zoomSecs >= 0) z.seconds = zoomSecs;
  else if (z.seconds == null) z.seconds = DEFAULT_ZOOM_SECONDS;
  return z;
}

/** Zoom rects for a placement (variant-local); falls back to template. */
function ensureFadeZoom(entry) {
  return normalizeFadeZoomBlock(transitionZoomOwner(entry) || entry);
}

/** Shared zoom duration lives on the template. */
function transitionZoomDurationSeconds(entry) {
  const cfg = resolveTransition(entry) || entry;
  const z = normalizeFadeZoomBlock(cfg);
  const n = Number(z.seconds);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_ZOOM_SECONDS;
}

function transitionStyleOf(entry) {
  entry = resolveTransition(entry) || entry;
  const style = entry?.transition_in || entry?.transition_out || "fade_zoom";
  return TRANSITION_FX.some((fx) => fx.id === style) ? style : "fade_zoom";
}

function transitionMapSeconds(entry) {
  entry = resolveTransition(entry) || entry;
  const n = Number(entry?.map?.seconds);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Alpha fade at the map overlay edges (per transition, falls back to defaults). */
function transitionFadeSeconds(entry) {
  entry = resolveTransition(entry) || entry;
  const own = Number(entry?.fade_seconds);
  if (Number.isFinite(own) && own >= 0) return own;
  const fallback = Number(state.script?.defaults?.fade_seconds);
  return Number.isFinite(fallback) && fallback >= 0 ? fallback : DEFAULT_FADE_SECONDS;
}

function transitionZoomSeconds(entry) {
  const cfg = resolveTransition(entry) || entry;
  if (!cfg || transitionStyleOf(cfg) !== "fade_zoom") return 0;
  const z = ensureFadeZoom(entry);
  if (!z.include_start && !z.include_end) return 0;
  return transitionZoomDurationSeconds(cfg);
}

function transitionPlacementMode(index) {
  if (index == null || index < 0 || !isTimelineTransition(index)) return "mid";
  const { prev, next } = transitionNeighbors(index);
  if (!prev && next) return "open";
  if (prev && !next) return "close";
  return "mid";
}

/** Map hold + optional start/end zoom spans across the neighboring scenes. */
function transitionTiming(entry, index = null) {
  const cfg = resolveTransition(entry) || entry;
  const map = transitionMapSeconds(cfg);
  const mapHalf = map / 2;
  let zoom = 0;
  let hasStart = false;
  let hasEnd = false;
  if (cfg && transitionStyleOf(cfg) === "fade_zoom") {
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

  let outHold = mapHalf + startZoom;
  let inHold = mapHalf + endZoom;
  const total = outHold + inHold;

  let idx = index;
  if (idx == null && entry) idx = scenes().findIndex((scene) => scene === entry);
  const mode = transitionPlacementMode(idx);
  if (mode === "open") {
    outHold = 0;
    inHold = total;
  } else if (mode === "close") {
    outHold = total;
    inHold = 0;
  }

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
    mode,
    // Back-compat aliases used by a few call sites.
    side: total / 2,
    zoomHalf: zoom / 2,
  };
}

function transitionFxSelect(value, onPick, label) {
  const current = value || "fade_zoom";
  // Set .value after options exist — assigning beforehand is ignored by browsers.
  const select = h(
    "select",
    {
      class: "transition-fx-select",
      onChange: (event) => onPick(event.target.value),
    },
    TRANSITION_FX.map((fx) =>
      h("option", {
        value: fx.id,
        text: fx.label,
        selected: current === fx.id,
      })
    )
  );
  select.value = current;
  return h("label", { class: "transition-fx-field" }, h("span", { text: label }), select);
}

/** Per-variant Start/End include toggles — lives on the variant row. */
function variantZoomIncludes(placementIndex) {
  const entry = scenes()[placementIndex];
  if (!entry?.is_transition) return null;
  const zoomEntry = transitionZoomOwner(entry);
  const z = ensureFadeZoom(zoomEntry);
  const toggle = (key, label) =>
    h(
      "label",
      {
        class: `fade-zoom-include is-compact${z[key] ? " on" : ""}`,
        title: key === "include_start" ? "Zoom out from Start" : "Zoom in to End",
        onClick: (event) => event.stopPropagation(),
      },
      h("input", {
        type: "checkbox",
        checked: !!z[key],
        onChange: (event) => {
          event.stopPropagation();
          state.editingTransitionVariant = placementIndex;
          ensureFadeZoom(zoomEntry)[key] = !!event.target.checked;
          changed();
        },
      }),
      h("span", { text: label })
    );
  return h(
    "div",
    {
      class: "fade-zoom-includes is-row",
      onClick: (event) => event.stopPropagation(),
    },
    toggle("include_start", "Start"),
    toggle("include_end", "End")
  );
}

function fadeZoomGuide(which) {
  const zoomEntry = isTransitionScene() ? editingTransitionPlacement() : scene();
  const z = ensureFadeZoom(zoomEntry);
  if (which === "start" && !z.include_start) return null;
  if (which === "end" && !z.include_end) return null;
  const rect = z[which];
  const label = which === "start" ? "Start" : "End";
  const variant = isTransitionScene()
    ? transitionVariantNumber(editingTransitionPlacementIndex())
    : null;
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
      title: variant
        ? `${label} · variant ${variant} — drag to move (fixed ¼-wide 16:9)`
        : `${label} zoom target — drag to move (fixed ¼-wide 16:9)`,
      "data-zoom-which": which,
      onPointerdown: (event) => beginFadeZoomMove(event, which),
    },
    h("span", {
      class: "fade-zoom-label",
      text: variant ? `${label} · ${variant}` : label,
    })
  );
}

function transitionDurationFields(entry) {
  const cfg = resolveTransition(entry) || entry;
  const placement = isTransitionScene(cfg) ? editingTransitionPlacement() : entry;
  const timing = transitionTiming(placement);
  const fadeSecs = transitionFadeSeconds(cfg);
  const zoomStyle = transitionStyleOf(cfg) === "fade_zoom";
  const showZoom = zoomStyle && (timing.hasStart || timing.hasEnd);
  return h(
    "div",
    { class: "transition-duration-fields" },
    h(
      "label",
      { class: "transition-map-hold" },
      h("span", { text: "Map" }),
      h("input", {
        type: "number",
        min: "0",
        step: "1",
        value: String(timing.map),
        title: "Map hold in seconds",
        onChange: (event) => {
          const next = Math.max(0, Number(event.target.value) || 0);
          if (!cfg.map || typeof cfg.map !== "object") cfg.map = {};
          cfg.map.seconds = next;
          changed();
        },
      }),
      h("span", { class: "transition-unit", text: "sec" })
    ),
    h(
      "label",
      { class: "transition-map-hold" },
      h("span", { text: "Fade" }),
      h("input", {
        type: "number",
        min: "0",
        step: "0.25",
        value: String(fadeSecs),
        title: "Alpha fade in/out in seconds",
        onChange: (event) => {
          cfg.fade_seconds = Math.max(0, Number(event.target.value) || 0);
          changed();
        },
      }),
      h("span", { class: "transition-unit", text: "sec" })
    ),
    showZoom &&
      h(
        "label",
        { class: "transition-map-hold" },
        h("span", { text: "Zoom" }),
        h("input", {
          type: "number",
          min: "0",
          step: "0.5",
          value: String(transitionZoomDurationSeconds(cfg)),
          title: "Shared zoom length for every variant",
          onChange: (event) => {
            const next = Math.max(0, Number(event.target.value) || 0);
            normalizeFadeZoomBlock(cfg).seconds = next;
            changed();
          },
        }),
        h("span", { class: "transition-unit", text: "sec" })
      ),
    h("span", {
      class: "meta transition-duration-total",
      text:
        timing.total > 0
          ? `Total ${clock(timing.total)}${
              timing.mode === "open"
                ? ` · opens ${clock(timing.inHold)}`
                : timing.mode === "close"
                  ? ` · closes ${clock(timing.outHold)}`
                  : ` · ${clock(timing.outHold)} before · ${clock(timing.inHold)} after`
            }`
          : "No overlay",
    })
  );
}

function addTransitionVariantButton(template) {
  return h("button", {
    class: "btn primary",
    type: "button",
    text: "Add variant",
    title: "Add this transition on the video timeline",
    onClick: () => {
      if (!template.id) template.id = newTransitionId();
      state.placingTransition = scenes().findIndex((scene) => scene === template);
      if (state.placingTransition < 0) state.placingTransition = state.sceneIndex;
      go("video", { videoId: state.videoId });
    },
  });
}

function beginFadeZoomMove(event, which = "start") {
  event.preventDefault();
  event.stopPropagation();
  const picture = event.currentTarget.closest(".picture");
  const guide = event.currentTarget;
  if (!picture || !isTransitionScene()) return;
  const entry = editingTransitionPlacement();
  state.editingTransitionVariant = editingTransitionPlacementIndex();
  const z = ensureFadeZoom(entry);
  const rect = z[which] || z.start;
  Object.assign(rect, clampZoomRect(rect, rect));
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
    guide.style.width = `${rect.w * 100}%`;
    guide.style.height = `${rect.h * 100}%`;
  };
  const up = () => {
    guide.classList.remove("dragging");
    guide.releasePointerCapture(event.pointerId);
    guide.removeEventListener("pointermove", move);
    guide.removeEventListener("pointerup", up);
    guide.removeEventListener("pointercancel", up);
    Object.assign(rect, clampZoomRect(rect, rect));
    ensureFadeZoom(entry);
    changed();
  };
  guide.addEventListener("pointermove", move);
  guide.addEventListener("pointerup", up);
  guide.addEventListener("pointercancel", up);
}

function isTransitionScene(entry = scene()) {
  return !!entry?.is_transition;
}

const sceneEffects = (index = state.sceneIndex) => (scene(index).effects ||= []);
const sceneAnims = (index = state.sceneIndex) => (scene(index).animations ||= []);
/** Edits live on the transition template (shared map), not thin variants. */
function editOwnerScene(index = state.sceneIndex) {
  const entry = scene(index);
  if (entry?.is_transition) return resolveTransition(entry) || entry;
  return entry;
}
const sceneEdits = (index = state.sceneIndex) => (editOwnerScene(index).edits ||= []);
const sceneSounds = (index = state.sceneIndex) => (scene(index).sounds ||= []);

function normalizeEdit(entry) {
  if (typeof entry === "string") {
    return {
      file: entry,
      x: 0.36,
      y: 0.28,
      w: 0.28,
      h: null,
      aspect: "landscape",
      soft_edges: false,
      locked: false,
    };
  }
  const aspect =
    entry?.aspect === "portrait" || entry?.aspect === "landscape" ? entry.aspect : "landscape";
  const height = Number(entry?.h);
  return {
    file: entry?.file || "",
    x: Number.isFinite(entry?.x) ? entry.x : 0.36,
    y: Number.isFinite(entry?.y) ? entry.y : 0.28,
    w: Number.isFinite(entry?.w) ? entry.w : 0.28,
    h: Number.isFinite(height) && height > 0 ? Math.min(1, height) : null,
    aspect,
    soft_edges: !!entry?.soft_edges,
    locked: !!entry?.locked,
  };
}

function isPendingEdit(entry) {
  return !normalizeEdit(entry).file;
}

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

function editIcon() {
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
    h("path", { d: "M9.5 3.5l3 3L6 13H3v-3l6.5-6.5z" }),
    h("path", { d: "M8.5 4.5l3 3" })
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

function regionCropNorm(entry, video = null) {
  let height = entry.h;
  if (!(Number.isFinite(height) && height > 0)) {
    let ratio = null;
    if (video?.videoWidth && video?.videoHeight) ratio = video.videoWidth / video.videoHeight;
    else if (entry.aspect === "landscape") ratio = 16 / 9;
    else if (entry.aspect === "portrait") ratio = 9 / 16;
    // Picture is 3:2: h = (w * picW / ratio) / picH = w * (3/2) / ratio
    if (ratio) height = (entry.w * 1.5) / ratio;
  }
  if (!(Number.isFinite(height) && height > 0)) height = entry.w * 0.75;
  return {
    x: Math.min(1, Math.max(0, entry.x)),
    y: Math.min(1, Math.max(0, entry.y)),
    w: Math.min(1 - entry.x, Math.max(0.01, entry.w)),
    h: Math.min(1 - entry.y, Math.max(0.01, height)),
  };
}

function animCropNorm(entry, video = null) {
  return regionCropNorm(normalizeAnim(entry), video);
}

async function exportRegionStill(entry, { clipboard = true, label = "region" } = {}) {
  const imagePath = editOwnerScene()?.image || scene()?.image;
  if (!imagePath || !imageExists(imagePath)) {
    state.note = "No scene image to crop";
    render();
    return false;
  }
  try {
    const image = await loadImageElement(`/${imagePath}`);
    const box = regionCropNorm(entry);
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
    const name = `${stem}-${label}-${Math.round(box.x * 100)}-${Math.round(box.y * 100)}.png`;
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
        state.note = "Copied and locked — empty slot stays put until you Unlock or fill it";
      } catch {
        state.note = "Downloaded and locked — empty slot stays put until you Unlock or fill it";
      }
    } else {
      state.note = "Downloaded and locked — empty slot stays put until you Unlock or fill it";
    }
    return true;
  } catch (error) {
    state.note = error.message || "Could not export region";
    render();
    return false;
  }
}

async function exportAnimRegionStill(index, { clipboard = true } = {}) {
  const list = sceneAnims();
  if (index == null || index < 0 || index >= list.length) return;
  const entry = normalizeAnim(list[index]);
  list[index] = entry;
  if (await exportRegionStill(entry, { clipboard, label: "region" })) changed();
}

async function exportEditRegionStill(index, { clipboard = true } = {}) {
  const list = sceneEdits();
  if (index == null || index < 0 || index >= list.length) return;
  const entry = normalizeEdit(list[index]);
  list[index] = entry;
  if (await exportRegionStill(entry, { clipboard, label: "edit" })) changed();
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("Could not read crop"));
    reader.readAsDataURL(blob);
  });
}

async function cropSceneRegion(entry) {
  const imagePath = editOwnerScene()?.image || scene()?.image;
  if (!imagePath || !imageExists(imagePath)) {
    throw new Error("No scene image to crop");
  }
  const image = await loadImageElement(`/${imagePath}`);
  const box = regionCropNorm(entry);
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
  const image_b64 = await blobToBase64(blob);
  const portrait = entry.aspect === "portrait" || sh > sw;
  return {
    image_b64,
    media_type: "image/png",
    size: portrait ? "1024x1536" : "1536x1024",
    aspect_ratio: portrait ? "9:16" : "16:9",
  };
}

async function cropEditRegion(entry) {
  return cropSceneRegion(entry);
}

async function cropAnimRegion(entry) {
  return cropSceneRegion(entry);
}

const JAR_TO_CLAUDE_PREFIX =
  "Give me a ChatGPT prompt to basically give this exact same image, except ";

function composeJarToClaude(change = "") {
  const bit = String(change || "").trim();
  return JAR_TO_CLAUDE_PREFIX + (bit || "…");
}

const DEFAULT_JAR_TO_CLAUDE = composeJarToClaude("");

const DEFAULT_JAR_TO_CLAUDE_VEO = `VEO ANIMATION PROMPTS

Structure every animation prompt like this:

Static locked-off camera on [scene: what it is, what's in frame, time of day]. Only [the one thing that moves] moves. [Describe that motion mechanically: direction, rhythm, behavior, speed. Give it a vector and obstacles, not adjectives.] [Bound it: what it must not become. No whitewater. Never fully extinguishing. Stays the same size.] As [the light source] shifts, [one or two nearby specular surfaces: brass, glass, wet stone, water] catch highlights that move and break with it, and the glow rises and falls across [the nearest one or two diffuse surfaces]. The falloff is short: surfaces beyond that hold constant brightness. Everything else in the frame is completely frozen: [exhaustive list by name: buildings, figures, signage, text, numbered markers, trees, props, anything adjacent to the moving region] remain perfectly still and unchanged. Nothing [in the region / on the surface] moves except [the thing] itself. No camera movement, no zoom, no pan, no parallax, no focus pull. Photoreal tilt-shift miniature diorama, [angle] preserved, shallow depth of field preserved, [palette], film grain retained.

Additional rules:

- One mover only. Everything else is frozen by name.
- Motion is mechanical: direction, rhythm, speed, obstacles — not mood words.
- Bound the motion (what it must not become / must not do).
- Specular highlights and short light falloff only on the nearest surfaces.
- Never invent camera moves. Locked-off only.
- Match the crop aspect: 9:16 or 16:9.

Prompt example:

Static locked-off camera on [scene: what it is, what's in frame, time of day]. Only [the one thing that moves] moves. [Describe that motion mechanically: direction, rhythm, behavior, speed. Give it a vector and obstacles, not adjectives.] [Bound it: what it must not become. No whitewater. Never fully extinguishing. Stays the same size.] As [the light source] shifts, [one or two nearby specular surfaces: brass, glass, wet stone, water] catch highlights that move and break with it, and the glow rises and falls across [the nearest one or two diffuse surfaces]. The falloff is short: surfaces beyond that hold constant brightness. Everything else in the frame is completely frozen: [exhaustive list by name: buildings, figures, signage, text, numbered markers, trees, props, anything adjacent to the moving region] remain perfectly still and unchanged. Nothing [in the region / on the surface] moves except [the thing] itself. No camera movement, no zoom, no pan, no parallax, no focus pull. Photoreal tilt-shift miniature diorama, [angle] preserved, shallow depth of field preserved, [palette], film grain retained.`

function resetStillGen(partial = {}) {
  const prev = state.stillGen || {};
  state.stillGen = {
    change: "",
    jarToClaude: DEFAULT_JAR_TO_CLAUDE,
    status: "idle",
    editPrompt: "",
    useClaude: prev.useClaude !== false,
    promptDone: false,
    imageDone: false,
    error: "",
    editIndex: null,
    collapsed: prev.collapsed ?? false,
    panelX: prev.panelX ?? null,
    panelY: prev.panelY ?? null,
    ...partial,
  };
}

function stillGenStep(label, { active = false, done = false } = {}) {
  return h(
    "div",
    {
      class: `still-gen-step${active ? " is-active" : ""}${done ? " is-done" : ""}`,
      "aria-current": active ? "step" : "false",
    },
    h("span", {
      class: "still-gen-step-mark",
      "aria-hidden": true,
      text: done ? "✓" : active ? "…" : "○",
    }),
    h("span", {
      class: "still-gen-step-label",
      text: active ? `${label}…` : label,
    })
  );
}

function stillGenFieldLabel(text, model = "") {
  return h(
    "div",
    { class: "still-gen-label-row" },
    h("span", { class: "still-gen-label muted", text }),
    model && h("span", { class: "still-gen-model", text: model, title: model })
  );
}

function beginEditPanelDrag(event, kind = "still") {
  const panel = event.currentTarget.closest(".edit-dials");
  if (!panel || !state.pictureExpanded) return;
  if (event.button != null && event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const rect = panel.getBoundingClientRect();
  const startX = event.clientX;
  const startY = event.clientY;
  const originLeft = rect.left;
  const originTop = rect.top;
  panel.classList.add("is-moved", "is-dragging");
  panel.style.left = `${originLeft}px`;
  panel.style.top = `${originTop}px`;
  panel.style.right = "auto";
  panel.style.bottom = "auto";
  panel.style.transform = "none";

  const move = (moveEvent) => {
    const left = Math.max(8, originLeft + (moveEvent.clientX - startX));
    const top = Math.max(8, originTop + (moveEvent.clientY - startY));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  };
  const up = () => {
    panel.releasePointerCapture?.(event.pointerId);
    panel.removeEventListener("pointermove", move);
    panel.removeEventListener("pointerup", up);
    panel.removeEventListener("pointercancel", up);
    panel.classList.remove("is-dragging");
    const left = parseFloat(panel.style.left) || originLeft;
    const top = parseFloat(panel.style.top) || originTop;
    if (kind === "anim") {
      state.animGen = { ...(state.animGen || {}), panelX: left, panelY: top };
    } else {
      state.stillGen = { ...(state.stillGen || {}), panelX: left, panelY: top };
    }
  };
  panel.setPointerCapture?.(event.pointerId);
  panel.addEventListener("pointermove", move);
  panel.addEventListener("pointerup", up);
  panel.addEventListener("pointercancel", up);
}

function beginStillPanelDrag(event) {
  beginEditPanelDrag(event, "still");
}

function beginAnimPanelDrag(event) {
  beginEditPanelDrag(event, "anim");
}

function resetAnimGen(partial = {}) {
  const prev = state.animGen || {};
  state.animGen = {
    change: "",
    jarToClaude: DEFAULT_JAR_TO_CLAUDE_VEO,
    status: "idle",
    veoPrompt: "",
    useClaude: prev.useClaude !== false,
    promptDone: false,
    imageDone: false,
    error: "",
    animIndex: null,
    collapsed: prev.collapsed ?? false,
    panelX: prev.panelX ?? null,
    panelY: prev.panelY ?? null,
    ...partial,
  };
}

function stillGenStatusBar({
  useClaude,
  onToggleClaude,
  busy = false,
  prompting = false,
  imaging = false,
  promptDone = false,
  imageDone = false,
  claudeLabel = "Send to Claude",
  promptLabel = "Generate edit prompt",
  imageLabel = "Generate new image",
} = {}) {
  const promptSkipped = !useClaude && (imaging || imageDone || promptDone);
  return h(
    "div",
    { class: "still-gen-status-bar" },
    h(
      "label",
      {
        class: `anim-check still-gen-claude-toggle${useClaude ? " on" : ""}`,
        title: useClaude
          ? "On: Claude writes the model prompt from your change"
          : "Off: paste a prompt below and send it straight to the model",
      },
      h("input", {
        type: "checkbox",
        checked: useClaude,
        disabled: busy,
        onChange: onToggleClaude,
      }),
      h("span", { text: claudeLabel })
    ),
    h(
      "div",
      { class: "still-gen-steps", "aria-label": "Generation progress" },
      stillGenStep(promptLabel, {
        active: prompting,
        done: promptDone || promptSkipped,
      }),
      stillGenStep(imageLabel, {
        active: imaging,
        done: imageDone,
      })
    )
  );
}

async function runAnimGenerate(index) {
  const list = sceneAnims();
  if (index == null || index < 0 || index >= list.length) return;
  const entry = normalizeAnim(list[index]);
  list[index] = entry;
  const gen = state.animGen || {};
  const useClaude = gen.useClaude !== false;
  const change = String(
    document.querySelector(".anim-gen-change")?.value || gen.change || ""
  ).trim();
  const jarToClaude = String(
    document.querySelector(".anim-gen-jar")?.value ||
      gen.jarToClaude ||
      DEFAULT_JAR_TO_CLAUDE_VEO
  ).trim();
  const liveVeoPrompt = String(
    document.querySelector(".anim-gen-claude")?.value || gen.veoPrompt || ""
  ).trim();
  if (state.animGen) {
    state.animGen.change = change;
    state.animGen.jarToClaude = jarToClaude || DEFAULT_JAR_TO_CLAUDE_VEO;
    state.animGen.veoPrompt = liveVeoPrompt;
  }

  if (!useClaude && !liveVeoPrompt) {
    resetAnimGen({
      ...gen,
      change,
      jarToClaude: jarToClaude || DEFAULT_JAR_TO_CLAUDE_VEO,
      veoPrompt: liveVeoPrompt,
      animIndex: index,
      useClaude: false,
      status: "error",
      error: "Paste a Claude → Veo prompt, or turn Generate Veo prompt on.",
    });
    render();
    return;
  }
  if (useClaude && !change) {
    resetAnimGen({
      ...gen,
      change,
      jarToClaude: jarToClaude || DEFAULT_JAR_TO_CLAUDE_VEO,
      veoPrompt: liveVeoPrompt,
      animIndex: index,
      useClaude: true,
      status: "error",
      error: "Say what should move in this region.",
    });
    render();
    return;
  }

  const stem = `${(scene()?.image ? baseName(scene().image) : "anim") || "anim"}-loop`;

  try {
    state.animGen = {
      ...gen,
      change,
      jarToClaude: jarToClaude || DEFAULT_JAR_TO_CLAUDE_VEO,
      veoPrompt: liveVeoPrompt,
      animIndex: index,
      useClaude,
      status: useClaude ? "prompting" : "imaging",
      promptDone: !useClaude,
      imageDone: false,
      error: "",
    };
    render();

    const crop = await cropAnimRegion(entry);

    if (!useClaude) {
      await runAnimVideoFromPrompt(index, {
        veoPrompt: liveVeoPrompt,
        stem,
        crop,
      });
      return;
    }

    const promptRes = await fetch("/api/generate-anim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        step: "prompt",
        change,
        jar_to_claude: jarToClaude || DEFAULT_JAR_TO_CLAUDE_VEO,
        image_b64: crop.image_b64,
        media_type: crop.media_type,
        video: state.videoId,
      }),
    });
    const promptData = await promptRes.json().catch(() => ({}));
    if (!promptRes.ok) throw new Error(promptData.error || "Claude Veo prompt failed");
    const veoPrompt = (promptData.veo_prompt || "").trim();
    if (!veoPrompt) throw new Error("Claude returned an empty Veo prompt");

    state.animGen = {
      ...state.animGen,
      veoPrompt,
      promptDone: true,
      status: "imaging",
    };
    render();

    await runAnimVideoFromPrompt(index, { veoPrompt, stem, crop });
  } catch (error) {
    state.animGen = {
      ...state.animGen,
      animIndex: index,
      status: "error",
      error: error.message || "Animation generate failed",
    };
    state.note = state.animGen.error;
    render();
  }
}

async function runAnimVideoFromPrompt(index, { veoPrompt = "", stem = "", crop = null } = {}) {
  const list = sceneAnims();
  if (index == null || index < 0 || index >= list.length) return;
  const entry = normalizeAnim(list[index]);
  list[index] = entry;
  // Prefer an explicit prompt arg; empty DOM values must not wipe a pasted prompt.
  const livePrompt = String(
    veoPrompt ||
      document.querySelector(".anim-gen-claude")?.value ||
      state.animGen?.veoPrompt ||
      ""
  ).trim();
  if (!livePrompt) {
    state.animGen = {
      ...(state.animGen || {}),
      animIndex: index,
      status: "error",
      error: "Claude → Veo prompt is empty.",
    };
    render();
    return;
  }
  const name =
    stem || `${(scene()?.image ? baseName(scene().image) : "anim") || "anim"}-loop`;
  const region = crop || (await cropAnimRegion(entry));

  state.animGen = {
    ...(state.animGen || {}),
    animIndex: index,
    veoPrompt: livePrompt,
    promptDone: true,
    imageDone: false,
    status: "imaging",
    error: "",
  };
  render();

  try {
    const videoRes = await fetch("/api/generate-anim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        step: "video",
        veo_prompt: livePrompt,
        image_b64: region.image_b64,
        media_type: region.media_type,
        aspect_ratio: region.aspect_ratio,
        name,
        video: state.videoId,
      }),
    });
    const videoData = await videoRes.json().catch(() => ({}));
    if (!videoRes.ok) throw new Error(videoData.error || "Veo generation failed");
    await refreshOutputs();
    state.selectedAnim = index;
    if (!fillAnimSlot(videoData.path, { replace: true })) {
      throw new Error("Generated, but could not place the animation");
    }
    state.animGen = {
      ...state.animGen,
      veoPrompt: livePrompt,
      imageDone: true,
      status: "idle",
      error: "",
    };
    state.note = "Animation updated";
    refreshLedger({ silent: true });
    changed();
  } catch (error) {
    state.animGen = {
      ...state.animGen,
      animIndex: index,
      status: "error",
      error: error.message || "Veo generation failed",
    };
    state.note = state.animGen.error;
    render();
  }
}

async function runStillEditGenerate(index) {
  const list = sceneEdits();
  if (index == null || index < 0 || index >= list.length) return;
  const entry = normalizeEdit(list[index]);
  list[index] = entry;
  const gen = state.stillGen || {};
  const useClaude = gen.useClaude !== false;
  const change = String(
    document.querySelector(".still-gen-change")?.value ?? gen.change ?? ""
  ).trim();
  const jarToClaude = String(
    document.querySelector(".still-gen-jar")?.value ?? gen.jarToClaude ?? DEFAULT_JAR_TO_CLAUDE
  ).trim();
  const liveEditPrompt = String(
    document.querySelector(".still-gen-claude")?.value ?? gen.editPrompt ?? ""
  ).trim();
  if (state.stillGen) {
    state.stillGen.change = change;
    state.stillGen.jarToClaude = jarToClaude || DEFAULT_JAR_TO_CLAUDE;
    state.stillGen.editPrompt = liveEditPrompt;
  }

  const owner = editOwnerScene();
  const stem = `${(owner?.image ? baseName(owner.image) : "edit") || "edit"}-edit`;

  try {
    const crop = await cropEditRegion(entry);

    if (!useClaude) {
      if (!liveEditPrompt) {
        resetStillGen({
          ...gen,
          change,
          jarToClaude: jarToClaude || DEFAULT_JAR_TO_CLAUDE,
          editPrompt: liveEditPrompt,
          editIndex: index,
          status: "error",
          error: "Paste a Claude → ChatGPT prompt, or turn Send to Claude on.",
        });
        render();
        return;
      }
      state.stillGen = {
        ...gen,
        change,
        jarToClaude: jarToClaude || DEFAULT_JAR_TO_CLAUDE,
        editPrompt: liveEditPrompt,
        editIndex: index,
        useClaude: false,
        promptDone: true,
        imageDone: false,
        status: "imaging",
        error: "",
      };
      render();
      await runStillImageFromPrompt(index, {
        editPrompt: liveEditPrompt,
        stem,
        crop,
      });
      return;
    }

    if (!change) {
      resetStillGen({
        ...gen,
        jarToClaude: jarToClaude || DEFAULT_JAR_TO_CLAUDE,
        editPrompt: liveEditPrompt,
        editIndex: index,
        status: "error",
        error: "Say what you’d like to change.",
      });
      render();
      return;
    }

    state.stillGen = {
      ...gen,
      change,
      jarToClaude: jarToClaude || DEFAULT_JAR_TO_CLAUDE,
      editPrompt: liveEditPrompt,
      editIndex: index,
      useClaude: true,
      status: "prompting",
      promptDone: false,
      imageDone: false,
      error: "",
    };
    render();
    const promptRes = await fetch("/api/edit-still", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        step: "prompt",
        change,
        jar_to_claude: jarToClaude || DEFAULT_JAR_TO_CLAUDE,
        image_b64: crop.image_b64,
        media_type: crop.media_type,
        video: state.videoId,
      }),
    });
    const promptData = await promptRes.json().catch(() => ({}));
    if (!promptRes.ok) throw new Error(promptData.error || "Claude edit prompt failed");
    const editPrompt = (promptData.edit_prompt || "").trim();
    if (!editPrompt) throw new Error("Claude returned an empty edit prompt");

    state.stillGen = {
      ...state.stillGen,
      editPrompt,
      promptDone: true,
      status: "imaging",
    };
    render();

    await runStillImageFromPrompt(index, {
      editPrompt,
      stem,
      crop,
    });
  } catch (error) {
    state.stillGen = {
      ...state.stillGen,
      editIndex: index,
      status: "error",
      error: error.message || "Still edit failed",
    };
    state.note = state.stillGen.error;
    render();
  }
}

async function runStillImageFromPrompt(index, { editPrompt = "", stem = "", crop = null } = {}) {
  const list = sceneEdits();
  if (index == null || index < 0 || index >= list.length) return;
  const entry = normalizeEdit(list[index]);
  list[index] = entry;
  const livePrompt = String(
    document.querySelector(".still-gen-claude")?.value ?? editPrompt ?? state.stillGen?.editPrompt ?? ""
  ).trim();
  if (!livePrompt) {
    state.stillGen = {
      ...(state.stillGen || {}),
      editIndex: index,
      status: "error",
      error: "Claude → ChatGPT prompt is empty.",
    };
    render();
    return;
  }
  const owner = editOwnerScene();
  const name =
    stem || `${(owner?.image ? baseName(owner.image) : "edit") || "edit"}-edit`;
  const region = crop || (await cropEditRegion(entry));

  state.stillGen = {
    ...(state.stillGen || {}),
    editIndex: index,
    editPrompt: livePrompt,
    promptDone: true,
    imageDone: false,
    status: "imaging",
    error: "",
  };
  render();

  try {
    const imageRes = await fetch("/api/edit-still", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        step: "image",
        edit_prompt: livePrompt,
        image_b64: region.image_b64,
        media_type: region.media_type,
        name,
        size: region.size,
        video: state.videoId,
      }),
    });
    const imageData = await imageRes.json().catch(() => ({}));
    if (!imageRes.ok) throw new Error(imageData.error || "Image generation failed");
    await refreshOutputs();
    state.selectedEdit = index;
    if (!fillEditSlot(imageData.path, { replace: true })) {
      throw new Error("Generated, but could not place the still");
    }
    const placed = normalizeEdit(sceneEdits()[index]);
    placed.locked = true;
    sceneEdits()[index] = placed;
    state.stillGen = {
      ...state.stillGen,
      editPrompt: livePrompt,
      imageDone: true,
      status: "idle",
      error: "",
    };
    state.note = "Still updated";
    refreshLedger({ silent: true });
    changed();
  } catch (error) {
    state.stillGen = {
      ...state.stillGen,
      editIndex: index,
      status: "error",
      error: error.message || "Image generation failed",
    };
    state.note = state.stillGen.error;
    render();
  }
}

function filledSceneEdits(index = state.sceneIndex) {
  return sceneEdits(index)
    .map((entry) => normalizeEdit(entry))
    .filter((entry) => entry.file);
}

/** Draw image into a rect with object-fit: cover. */
function drawImageCover(ctx, image, dx, dy, dw, dh) {
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  if (!(iw > 0 && ih > 0 && dw > 0 && dh > 0)) return;
  const ir = iw / ih;
  const br = dw / dh;
  let sx = 0;
  let sy = 0;
  let sw = iw;
  let sh = ih;
  if (ir > br) {
    sw = ih * br;
    sx = (iw - sw) / 2;
  } else {
    sh = iw / br;
    sy = (ih - sh) / 2;
  }
  ctx.drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh);
}

function featherEditPatch(patch, dw, dh) {
  const canvas = document.createElement("canvas");
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(patch, 0, 0, dw, dh);
  const edge = Math.max(2, Math.round(Math.min(dw, dh) * 0.12));
  const image = ctx.getImageData(0, 0, dw, dh);
  const data = image.data;
  for (let y = 0; y < dh; y += 1) {
    for (let x = 0; x < dw; x += 1) {
      const dist = Math.min(x, y, dw - 1 - x, dh - 1 - y);
      if (dist >= edge) continue;
      const alpha = dist / edge;
      const i = (y * dw + x) * 4 + 3;
      data[i] = Math.round(data[i] * alpha);
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

async function composeFusedSceneCanvas() {
  const owner = editOwnerScene();
  const imagePath = owner?.image;
  if (!imagePath || !imageExists(imagePath)) {
    throw new Error("No scene image to fuse");
  }
  const edits = filledSceneEdits();
  if (!edits.length) throw new Error("No filled edits to fuse");

  const base = await loadImageElement(`/${imagePath}`);
  const canvas = document.createElement("canvas");
  canvas.width = base.naturalWidth;
  canvas.height = base.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(base, 0, 0);

  for (const edit of edits) {
    const patch = await loadImageElement(`/${edit.file}`);
    const box = regionCropNorm(edit);
    const dx = Math.round(box.x * canvas.width);
    const dy = Math.round(box.y * canvas.height);
    const dw = Math.max(1, Math.round(box.w * canvas.width));
    const dh = Math.max(1, Math.round(box.h * canvas.height));
    const temp = document.createElement("canvas");
    temp.width = dw;
    temp.height = dh;
    const tctx = temp.getContext("2d");
    drawImageCover(tctx, patch, 0, 0, dw, dh);
    const stamped = edit.soft_edges ? featherEditPatch(temp, dw, dh) : temp;
    ctx.drawImage(stamped, dx, dy);
  }
  return canvas;
}

async function fuseEditsAndDownload() {
  try {
    state.note = "Fusing edits…";
    render();
    const canvas = await composeFusedSceneCanvas();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Could not build fused image");
    const stem = baseName(editOwnerScene()?.image) || "scene";
    const name = `${stem}-fused.png`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
    state.note = `Downloaded ${name} — scene file unchanged. Compare, then we can overwrite later.`;
    render();
  } catch (error) {
    state.note = error.message || "Could not fuse edits";
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

function applyRegionAspect(entry, aspect) {
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

function applyAnimAspect(entry, aspect) {
  applyRegionAspect(entry, aspect);
}

function applyEditAspect(entry, aspect) {
  applyRegionAspect(entry, aspect);
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

function regionKindToggle(current, onPick, { disabled = false } = {}) {
  const kind = current === "still" ? "still" : "animation";
  const pick = (next) => {
    if (disabled || next === kind) return;
    onPick(next);
  };
  return h(
    "div",
    {
      class: `region-kind${disabled ? " is-disabled" : ""}`,
      title: disabled ? "Filled slots keep their kind" : "Still edit or animation slot",
    },
    h("button", {
      class: `region-kind-btn${kind === "still" ? " on" : ""}`,
      type: "button",
      disabled,
      text: "Still",
      onClick: (event) => {
        event.stopPropagation();
        pick("still");
      },
    }),
    h("button", {
      class: `region-kind-btn${kind === "animation" ? " on" : ""}`,
      type: "button",
      disabled,
      text: "Animation",
      onClick: (event) => {
        event.stopPropagation();
        pick("animation");
      },
    })
  );
}

/** Move an empty selected slot between edits[] and animations[]. */
function convertSelectedSlotKind(nextKind) {
  const wantStill = nextKind === "still";
  if (state.selectedEdit !== null) {
    const list = sceneEdits();
    const index = state.selectedEdit;
    if (index < 0 || index >= list.length) return;
    const entry = normalizeEdit(list[index]);
    if (entry.file) return;
    if (wantStill) {
      state.regionKind = "still";
      render();
      return;
    }
    list.splice(index, 1);
    const slot = normalizeAnim({
      file: "",
      x: entry.x,
      y: entry.y,
      w: entry.w,
      h: entry.h,
      aspect: entry.aspect === "portrait" ? "portrait" : "landscape",
      soft_edges: entry.soft_edges,
      locked: entry.locked,
    });
    sceneAnims().push(slot);
    state.selectedEdit = null;
    state.selectedAnim = sceneAnims().length - 1;
    state.regionKind = "animation";
    changed();
    return;
  }
  if (state.selectedAnim !== null) {
    const list = sceneAnims();
    const index = state.selectedAnim;
    if (index < 0 || index >= list.length) return;
    const entry = normalizeAnim(list[index]);
    if (entry.file) return;
    if (!wantStill) {
      state.regionKind = "animation";
      render();
      return;
    }
    list.splice(index, 1);
    const slot = normalizeEdit({
      file: "",
      x: entry.x,
      y: entry.y,
      w: entry.w,
      h: entry.h,
      aspect: entry.aspect === "portrait" ? "portrait" : "landscape",
      soft_edges: entry.soft_edges,
      locked: entry.locked,
    });
    sceneEdits().push(slot);
    state.selectedAnim = null;
    state.selectedEdit = sceneEdits().length - 1;
    state.regionKind = "still";
    changed();
  }
}

function beginRegionDraw(event) {
  event.preventDefault();
  event.stopPropagation();
  const surface = event.currentTarget;
  const picture = surface.closest(".picture");
  if (!picture) return;
  const kind = state.regionKind === "still" ? "still" : "animation";
  const box = picture.getBoundingClientRect();
  const startX = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
  const startY = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
  const marquee = h("div", { class: `region-marquee${kind === "still" ? " is-edit" : ""}` });
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
    if (kind === "still") {
      const list = sceneEdits();
      list.push(
        normalizeEdit({
          file: "",
          x: last.x,
          y: last.y,
          w: last.w,
          h: last.h,
          soft_edges: false,
          aspect,
        })
      );
      state.selectedEdit = list.length - 1;
      state.selectedAnim = null;
      state.stillGen = {
        ...(state.stillGen || {}),
        change: "",
        jarToClaude: DEFAULT_JAR_TO_CLAUDE,
        status: "idle",
        editPrompt: "",
        promptDone: false,
        imageDone: false,
        error: "",
        editIndex: list.length - 1,
      };
      state.note = "Still region saved — describe what to change below.";
    } else {
      const list = sceneAnims();
      list.push(
        normalizeAnim({
          file: "",
          x: last.x,
          y: last.y,
          w: last.w,
          h: last.h,
          soft_edges: true,
          aspect,
        })
      );
      state.selectedAnim = list.length - 1;
      state.selectedEdit = null;
      state.animGen = {
        ...(state.animGen || {}),
        change: "",
        jarToClaude: DEFAULT_JAR_TO_CLAUDE_VEO,
        status: "idle",
        veoPrompt: "",
        promptDone: false,
        imageDone: false,
        error: "",
        animIndex: list.length - 1,
      };
      state.note = "Animation region saved — describe what should move, then Generate.";
    }
    state.regionTool = false;
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

/**
 * Zoom state at local time along a transition's packed timeline:
 * [start zoom-out][map hold][end zoom-in].
 */
function transitionZoomAt(entry, index, at) {
  const timing = transitionTiming(entry, index);
  if (transitionStyleOf(entry) !== "fade_zoom") {
    return { zoomRect: null, zoomProgress: 0, timing };
  }
  const fz = ensureFadeZoom(entry);
  const t = Math.min(timing.total, Math.max(0, at));
  const startSpan = timing.hasStart ? timing.startZoom : 0;
  const endSpan = timing.hasEnd ? timing.endZoom : 0;
  const mapSpan = Math.max(0, timing.total - startSpan - endSpan);

  if (timing.hasStart && startSpan > 0 && t < startSpan) {
    return {
      zoomRect: fz.start,
      zoomProgress: 1 - Math.min(1, t / startSpan),
      timing,
    };
  }
  const afterStart = t - startSpan;
  if (afterStart <= mapSpan + 0.0001) {
    return { zoomRect: null, zoomProgress: 0, timing };
  }
  if (timing.hasEnd && endSpan > 0) {
    const into = afterStart - mapSpan;
    return {
      zoomRect: fz.end,
      zoomProgress: Math.min(1, Math.max(0, into / endSpan)),
      timing,
    };
  }
  return { zoomRect: null, zoomProgress: 0, timing };
}

/** Map path + opacity (+ zoom) for a transition overlay sitting on a normal scene. */
function transitionOverlayAt(at = player.at) {
  const list = scenes();
  const item = activeVideoItem(at);
  if (!item || item.isTransition || !(item.duration > 0)) return null;
  const local = Math.max(0, at - item.start);
  const mapOf = (entry) => entry?.image || state.script?.map || "";

  // Prefer an opening transition before this scene, then a mid/close after the previous cut.
  const beforeIndex = item.index - 1;
  const before = beforeIndex >= 0 ? list[beforeIndex] : null;
  // Opening may sit earlier than index-1 if other transitions cluster — use neighbor search.
  let openIndex = -1;
  for (let j = item.index - 1; j >= 0; j -= 1) {
    if (!list[j].is_transition) break;
    if (transitionPlacementMode(j) === "open") openIndex = j;
  }
  if (openIndex < 0 && before?.is_transition && transitionPlacementMode(beforeIndex) === "open") {
    openIndex = beforeIndex;
  }

  if (openIndex >= 0) {
    const opening = list[openIndex];
    const cfg = resolveTransition(opening);
    const timing = transitionTiming(opening, openIndex);
    const hold = timing.inHold;
    if (hold > 0.05 && local <= hold + 0.001) {
      const remaining = hold - local;
      const fade = Math.max(0, transitionFadeSeconds(cfg));
      const fadeSpan = Math.min(fade || 0.001, hold);
      const opacity = remaining >= fadeSpan ? 1 : Math.min(1, Math.max(0, remaining / fadeSpan));
      const path = mapOf(cfg);
      const zoom = transitionZoomAt(opening, openIndex, local);
      if (path) {
        return {
          path,
          opacity,
          title: cfg.title || "Transition",
          entry: opening,
          zoomProgress: zoom.zoomProgress,
          zoomRect: zoom.zoomRect,
        };
      }
    }
  }

  const afterIndex = item.index + 1;
  const after = list[afterIndex];
  if (after?.is_transition) {
    const cfg = resolveTransition(after);
    const timing = transitionTiming(after, afterIndex);
    const hold = timing.outHold;
    if (hold > 0.05 && local >= item.duration - hold - 0.001) {
      const into = local - (item.duration - hold);
      const fade = Math.max(0, transitionFadeSeconds(cfg));
      const fadeSpan = Math.min(fade || 0.001, hold);
      const opacity = Math.min(1, Math.max(0, into / fadeSpan));
      const path = mapOf(cfg);
      const zoom = transitionZoomAt(after, afterIndex, into);
      if (path) {
        return {
          path,
          opacity,
          title: cfg.title || "Transition",
          entry: after,
          zoomProgress: zoom.zoomProgress,
          zoomRect: zoom.zoomRect,
        };
      }
    }
  }

  if (before?.is_transition && transitionPlacementMode(beforeIndex) !== "open") {
    const cfg = resolveTransition(before);
    const timing = transitionTiming(before, beforeIndex);
    const hold = timing.inHold;
    if (hold > 0.05 && local <= hold + 0.001) {
      const remaining = hold - local;
      const fade = Math.max(0, transitionFadeSeconds(cfg));
      const fadeSpan = Math.min(fade || 0.001, hold);
      const opacity = remaining >= fadeSpan ? 1 : Math.min(1, Math.max(0, remaining / fadeSpan));
      const path = mapOf(cfg);
      // Mid incoming = second half of packed timeline (after the cut).
      const zoom = transitionZoomAt(before, beforeIndex, timing.outHold + local);
      if (path) {
        return {
          path,
          opacity,
          title: cfg.title || "Transition",
          entry: before,
          zoomProgress: zoom.zoomProgress,
          zoomRect: zoom.zoomRect,
        };
      }
    }
  }

  return null;
}

function silentSceneHold(entry = scene()) {
  for (const key of ["hold", "seconds", "duration"]) {
    const value = Number(entry?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const defaults = state.script?.defaults || {};
  for (const key of ["scene_seconds", "hold_seconds"]) {
    const value = Number(defaults[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 8;
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
  if (list.length) {
    const total =
      list.reduce((sum, item) => sum + item.duration, 0) - crossfade * (list.length - 1);
    return { list, total: Math.max(0, total) };
  }
  // No songs — still give the picture a quiet hold so process/preview work.
  const entry = scene(index);
  const hasPicture = !!(entry?.image || (entry?.images || []).length);
  return { list, total: hasPicture ? silentSceneHold(entry) : 0 };
}

/** Playable length on the scene page (map + zoom for transitions). */
function scenePlayTotal(index = state.sceneIndex) {
  const entry = scene(index);
  if (entry?.is_transition) {
    const placement =
      index === state.sceneIndex && isTransitionTemplate(entry)
        ? editingTransitionPlacement()
        : entry;
    return transitionTiming(placement).total;
  }
  return sceneSequence(index).total;
}

function videoTimeline() {
  let start = 0;
  const items = scenes().map((entry, index) => {
    const { list, total } = sceneSequence(index);
    const cfg = entry.is_transition ? resolveTransition(entry) : entry;
    const image = cfg?.image || "";
    const mapOnly =
      !!entry.is_transition && transitionTiming(cfg).total > 0 && !image;
    const item = {
      index,
      title: cfg?.title || entry.title || `Scene ${index + 1}`,
      image,
      songs: list,
      duration: total,
      start,
      isTransition: !!entry.is_transition,
      missing: mapOnly ? false : !image || !imageExists(image),
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
      const cfg = resolveTransition(entry);
      const timing = transitionTiming(entry);
      const z = ensureFadeZoom(entry);
      const s = z.include_start ? z.start || {} : {};
      const e = z.include_end ? z.end || {} : {};
      return `t:${cfg.id || ""}:${cfg.image || ""}:${timing.map}:${timing.zoom}:${transitionFadeSeconds(cfg)}:${z.include_start ? 1 : 0}:${z.include_end ? 1 : 0}:${cfg.transition_in || "fade_zoom"}:${s.x},${s.y},${s.w},${s.h}:${e.x},${e.y},${e.w},${e.h}`;
    }
    return (entry?.tracks || []).map(fileOf).join(",");
  };
  if (scope.mode === "scene") {
    const variantIndex = isTransitionScene(scenes()[scope.scene])
      ? editingTransitionPlacementIndex()
      : scope.scene;
    const variant = scenes()[variantIndex];
    const z = variant?.is_transition ? ensureFadeZoom(variant) : null;
    const variantSig = z
      ? `v${variantIndex}:${z.include_start ? 1 : 0}${z.include_end ? 1 : 0}:${z.start?.x},${z.start?.y},${z.end?.x},${z.end?.y}`
      : "";
    return `${state.videoId}|scene:${scope.scene}|${sceneSig(scope.scene)}|${variantSig}|${soundSig(scope.scene)}`;
  }
  return `${state.videoId}|video|${scenes()
    .map((entry, index) => {
      if (!entry?.is_transition) {
        return `${sceneSig(index)}+${soundSig(index)}+t0`;
      }
      const z = ensureFadeZoom(entry);
      return `${sceneSig(index)}+${soundSig(index)}+t1:${z.include_start ? 1 : 0}${z.include_end ? 1 : 0}`;
    })
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

/** Map + locked edits/anims share one plane so fade-zoom keeps them pinned to the map. */
function transitionZoomPlane() {
  return (
    document.querySelector(".stage .picture-zoom-plane") ||
    document.querySelector(".stage .picture-still")
  );
}

/** Edit on the full map; only animate zoom while play is running. */
function syncSceneTransitionPreview() {
  if (!isTransitionPreview()) return;
  const plane = transitionZoomPlane();
  const guides = document.querySelectorAll(".stage .fade-zoom-guide");
  if (!plane) return;

  // Default / paused: full map so included Start/End targets can be placed.
  if (!player.playing) {
    applyFadeZoomStyle(plane, null, 0);
    guides.forEach((guide) => guide.classList.remove("is-preview-hidden"));
    return;
  }

  // Use the selected variant — not the shared template alone.
  const entry = editingTransitionPlacement();
  const index = editingTransitionPlacementIndex();
  const timing = transitionTiming(entry, index);
  const hold = Math.max(0.001, timing.total);
  const at = Math.min(hold, Math.max(0, player.at));
  const zoom = transitionZoomAt(entry, index, at);
  applyFadeZoomStyle(plane, zoom.zoomRect, zoom.zoomProgress);
  guides.forEach((guide) => guide.classList.add("is-preview-hidden"));
}

function syncSource() {
  if (state.page === "jars" || state.page === "jar" || state.page === "landing") return;
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
      scrubber.events?.forEach((mark) => {
        const from = Number(mark.dataset.from);
        const to = Number(mark.dataset.to);
        const on =
          Number.isFinite(from) &&
          Number.isFinite(to) &&
          player.at >= from - 0.05 &&
          player.at <= to + 0.05;
        mark.classList.toggle("is-active", on);
      });
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
  paintShortRange();
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

  if (overlayUi.mapPlane || overlayUi.map) {
    const overlay = transitionOverlayAt(at);
    const path = overlay?.path || "";
    const opacity = overlay?.opacity ?? 0;
    const mapStill = overlayUi.map;
    const mapPlane = overlayUi.mapPlane || mapStill;
    if (mapStill) {
      if (path && mapStill.dataset.path !== path) {
        mapStill.dataset.path = path;
        const wide = state.pictureExpanded ? 1600 : 1200;
        mapStill.style.backgroundImage = `url(/thumb?path=${encodeURIComponent(path)}&w=${wide})`;
      } else if (!path && mapStill.dataset.path !== "") {
        mapStill.dataset.path = "";
        mapStill.style.backgroundImage = "";
      }
    }
    mapPlane.style.opacity = String(opacity);
    mapPlane.classList.toggle("is-hidden", opacity <= 0.01);
    if (overlay?.zoomRect && opacity > 0.01) {
      applyFadeZoomStyle(mapPlane, overlay.zoomRect, overlay.zoomProgress ?? 0);
    } else {
      applyFadeZoomStyle(mapPlane, null, 0);
    }
  }

  syncVideoPreviewMotion(at);
  syncVideoPreviewMapMotion(at);

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
    state.jar?.prompt,
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

/** Fresh render on disk (missing, stale, or truncated → not ready). */
function outputReady(output) {
  return Boolean(output?.ready);
}

function outputTag(output, { showMissing = false } = {}) {
  if (outputReady(output)) {
    return h("span", {
      class: "ready-tag is-ready",
      text: "Rendered",
      title: output.name ? `Saved as out/${output.name}` : "Ready to download",
    });
  }
  if (output?.incomplete) {
    return h("span", {
      class: "ready-tag is-outdated",
      text: "Incomplete",
      title: "Render was cut short — process this scene again",
    });
  }
  if (output?.exists || output?.stale) {
    return h("span", {
      class: "ready-tag is-outdated",
      text: "Outdated",
      title: "Scene changed since this render — process again",
    });
  }
  if (showMissing) {
    return h("span", {
      class: "ready-tag is-missing",
      text: "Never rendered",
      title: "Process this scene to create a downloadable clip",
    });
  }
  return null;
}

function sceneOutput(index) {
  return state.outputs?.scenes?.[String(index + 1)] || null;
}

function videoOutputSummary(video) {
  const outputs = video.outputs || {};
  const full = outputs.video;
  if (outputReady(full)) return outputTag(full);
  const scenes = Object.values(outputs.scenes || {});
  const rendered = scenes.filter((scene) => outputReady(scene)).length;
  if (rendered > 0) {
    return h("span", {
      class: "ready-tag is-ready",
      text: `${rendered}/${scenes.length} scenes`,
      title: "Scene renders in out/",
    });
  }
  return null;
}

async function loadSite() {
  if (state.site) return state.site;
  try {
    const data = await (await fetch("/site.json", { cache: "no-store" })).json();
    state.site = data && typeof data === "object" ? data : {};
  } catch {
    state.site = {};
  }
  return state.site;
}

function landingCopy() {
  const landing = state.site?.landing || {};
  return {
    brand: landing.brand || "Wonderjar",
    title: landing.title || "Build a world that pulls you in.",
    description: landing.description || "Build it. Light it. Share it.",
    cta: landing.cta || "Enter Riverbend",
    href: landing.href || "/video?v=riverbend",
    videoId: landing.videoId || "riverbend",
    secondary: landing.secondary || "or build your own",
    secondaryHref: landing.secondaryHref || "/videos",
    video: landing.video || "/assets/videos/landing-loop.mp4",
    poster: landing.poster || "/assets/videos/landing-poster.jpg",
  };
}

async function loadModels() {
  try {
    const data = await (await fetch("/api/config")).json();
    state.models = {
      anthropic: data.anthropic_model || "",
      openaiImage: data.openai_image_model || "",
      veo: data.veo_model || "",
    };
  } catch {
    /* optional chrome */
  }
}

function formatUsd(amount) {
  const n = Number(amount) || 0;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function formatLedgerWhen(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts.endsWith("Z") ? ts : `${ts}Z`);
    if (Number.isNaN(d.getTime())) return ts;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

async function refreshLedger({ silent = false } = {}) {
  if (!state.videoId) return;
  if (!silent) {
    state.ledger = { ...state.ledger, loading: true, error: "" };
    render();
  }
  try {
    const data = await (await fetch(withVideo("/api/ledger"))).json();
    if (data.error) throw new Error(data.error);
    state.ledger = {
      ...state.ledger,
      loading: false,
      total: data.total || 0,
      entries: Array.isArray(data.entries) ? data.entries.slice().reverse() : [],
      error: "",
    };
  } catch (error) {
    state.ledger = {
      ...state.ledger,
      loading: false,
      error: error.message || "Could not load ledger",
    };
  }
  render();
}

async function toggleLedgerPanel() {
  const open = !state.ledger?.open;
  state.ledger = { ...(state.ledger || {}), open };
  render();
  if (open) await refreshLedger();
}

function ledgerPanel() {
  const ledger = state.ledger || {};
  if (!ledger.open) return null;
  const entries = ledger.entries || [];
  return h(
    "div",
    { class: "ledger-panel", role: "dialog", "aria-label": "API cost ledger" },
    h(
      "div",
      { class: "ledger-panel-head" },
      h("span", { class: "ledger-panel-title", text: "API spend" }),
      h("span", {
        class: "ledger-panel-total",
        text: ledger.loading ? "…" : formatUsd(ledger.total),
        title: "Estimated total for this video",
      }),
      h(
        "button",
        {
          class: "ledger-panel-close",
          type: "button",
          "aria-label": "Close ledger",
          onClick: () => {
            state.ledger = { ...state.ledger, open: false };
            render();
          },
          text: "×",
        }
      )
    ),
    h("p", {
      class: "ledger-panel-note muted",
      text: "Estimated from published rates — APIs don’t return dollar amounts.",
    }),
    ledger.error && h("p", { class: "ledger-panel-error", text: ledger.error }),
    h(
      "div",
      { class: "ledger-panel-list" },
      !ledger.loading &&
        !entries.length &&
        h("p", { class: "muted", text: "No API calls logged for this video yet." }),
      ...entries.map((entry) =>
        h(
          "div",
          { class: "ledger-panel-item" },
          h(
            "div",
            { class: "ledger-panel-item-top" },
            h("span", {
              class: "ledger-panel-note-text",
              text: entry.note || "API call",
            }),
            h("span", {
              class: "ledger-panel-cost",
              text: formatUsd(entry.cost),
              title: entry.estimated ? "Estimated" : "Reported",
            })
          ),
          h("div", {
            class: "ledger-panel-item-meta muted",
            text: [
              entry.provider,
              entry.model,
              formatLedgerWhen(entry.ts),
            ]
              .filter(Boolean)
              .join(" · "),
          })
        )
      )
    )
  );
}

function ledgerButton() {
  const total = state.ledger?.total;
  const label =
    total > 0 ? `$${Number(total).toFixed(total >= 1 ? 2 : 3)}` : "$";
  return h(
    "button",
    {
      class: `btn ghost icon-btn ledger-btn${state.ledger?.open ? " is-open" : ""}`,
      type: "button",
      title: "API cost ledger for this video",
      "aria-label": "Open API cost ledger",
      "aria-expanded": state.ledger?.open ? "true" : "false",
      onClick: () => toggleLedgerPanel(),
      text: label,
    }
  );
}

async function loadJars() {
  const data = await (await fetch("/api/jars")).json();
  state.jars = data.jars || [];
}

async function loadJar(jarId, { soft = false } = {}) {
  const response = await fetch(`/api/jar?j=${encodeURIComponent(jarId)}`);
  if (!response.ok) {
    if (!soft) {
      state.jarId = null;
      state.jar = null;
      state.jarMeta = null;
      state.videos = [];
    }
    return false;
  }
  const data = await response.json();
  state.jarId = data.id;
  state.jar = data.jar || null;
  state.jarMeta = {
    id: data.id,
    title: (data.jar && data.jar.title) || data.id,
    descriptor: (data.jar && data.jar.descriptor) || "world",
  };
  state.videos = data.videos || [];
  return true;
}

async function loadVideos(jarId = null) {
  const qs = jarId ? `?j=${encodeURIComponent(jarId)}` : "";
  const data = await (await fetch(`/api/videos${qs}`)).json();
  state.videos = data.videos || [];
}

async function loadVideo(videoId, jarId = null) {
  let url = `/api/state?v=${encodeURIComponent(videoId)}`;
  if (jarId) url += `&j=${encodeURIComponent(jarId)}`;
  const response = await fetch(url);
  if (!response.ok) return false;
  const data = await response.json();
  state.videoId = data.id;
  state.script = data.script;
  state.assets = data.assets;
  state.outputs = data.outputs;
  state.render = data.render;
  state.jarId = data.jarId || jarId || data.script?.jar || null;
  state.jar = data.jar || state.jar;
  state.jarMeta = data.jarMeta || (state.jarId
    ? state.jarMeta || { id: state.jarId, title: state.jarId, descriptor: "world" }
    : null);
  if (state.jarId && !data.jarMeta) {
    await loadJar(state.jarId, { soft: true });
  }
  state.detailsDirty = false;
  state.detailsOpen = false;
  state.sceneDetailsOpen = false;
  state.ledger = {
    open: false,
    loading: false,
    total: 0,
    entries: [],
    error: "",
  };
  ensureScript();
  refreshLedger({ silent: true });
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
/** Wall-clock seconds per 1% of a render job — kept across Process Video queue steps. */
let renderPace = null;

function resetRenderEta() {
  renderEtaSamples = [];
  renderPace = null;
  state.renderEta = null;
}

/** Start ETA for a render; keep learned pace when chaining Process Video jobs. */
function beginRenderEta() {
  renderEtaSamples = [];
  if (state.processPanel?.open && renderPace != null) {
    state.renderEta = estimateRenderEta(0);
  } else if (!state.processPanel?.open) {
    renderPace = null;
    state.renderEta = null;
  } else {
    state.renderEta = null;
  }
}

function paceFromSamples(samples) {
  if (!samples || samples.length < 2) return null;
  const window = samples.length >= 4 ? samples.slice(-8) : samples;
  const first = window[0];
  const last = window[window.length - 1];
  const dp = last.percent - first.percent;
  const dt = (last.t - first.t) / 1000;
  if (dp < 0.4 || dt < 1) return null;
  return dt / dp;
}

function noteRenderProgress(percent) {
  const now = Date.now();
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  const last = renderEtaSamples[renderEtaSamples.length - 1];
  if (!last || value > last.percent + 0.15) {
    renderEtaSamples.push({ t: now, percent: value });
    if (renderEtaSamples.length > 40) renderEtaSamples.shift();
  }
  const measured = paceFromSamples(renderEtaSamples);
  if (measured != null) renderPace = measured;
  state.renderEta = estimateRenderEta(value);
}

function estimateRenderEta(percent) {
  if (percent >= 99) return 0;
  const measured = paceFromSamples(renderEtaSamples);
  if (measured != null) renderPace = measured;
  if (renderPace == null) return null;
  return Math.max(0, (100 - percent) * renderPace);
}

/** Duration left for one queue row alone (running = leftover %, pending = full job). */
function jobDurationSeconds(job) {
  if (renderPace == null) return null;
  if (job.status === "running") {
    return Math.max(0, (100 - (state.render.percent || 0)) * renderPace);
  }
  if (job.status === "pending" && (job.kind === "scene" || job.kind === "video")) {
    return 100 * renderPace;
  }
  return null;
}

/**
 * When this row finishes, from now — sums earlier remaining/pending jobs + this one.
 * (An 8‑min job behind another 8‑min job is ~16 min, not ~8.)
 */
function jobFinishEtaSeconds(job) {
  const panel = state.processPanel;
  if (!panel?.open || renderPace == null) return jobDurationSeconds(job);
  let sum = 0;
  for (const entry of panel.jobs) {
    const duration = jobDurationSeconds(entry);
    if (duration == null) continue;
    sum += duration;
    if (entry.key === job.key) return sum;
  }
  return null;
}

/** Whole Process Video queue remaining (current + pending jobs). */
function queueEtaSeconds() {
  const panel = state.processPanel;
  if (!panel?.open || renderPace == null) return state.renderEta;
  return panel.jobs.reduce((sum, job) => sum + (jobDurationSeconds(job) || 0), 0);
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
  beginRenderEta();
  const response = await fetch(withVideo("/api/render"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sceneNumber ? { scene: sceneNumber } : {}),
  });
  state.render = await response.json();
  lastRenderStatus = state.render.status;
  if (state.render.status === "running") {
    noteRenderProgress(state.render.percent || 0);
    render();
    poll();
    return;
  }
  // Start failed (busy / validation) — settle the queue job if any.
  await finishProcessJob(state.render.status === "error" ? "error" : "idle");
}

async function stopGenerate() {
  const response = await fetch("/api/render/stop", { method: "POST" });
  state.render = await response.json();
  lastRenderStatus = state.render.status;
  resetRenderEta();
  if (state.processPanel?.open) {
    state.processPanel.cancelling = true;
  }
  // Poll may already be mid-flight; also settle here so Cancel isn't stuck.
  await finishProcessJob("idle");
}

/** Build Process Video queue: catch up stale/missing scenes, always full video. */
function buildProcessJobs() {
  const jobs = [];
  scenes().forEach((entry, index) => {
    if (entry.is_transition) {
      jobs.push({
        key: `transition-${index}`,
        label: entry.title?.trim() || "Transition",
        kind: "transition",
        status: "bundled",
        detail: "Renders with full video",
      });
      return;
    }
    const ready = outputReady(sceneOutput(index));
    jobs.push({
      key: `scene-${index}`,
      label: entry.title?.trim() || `Scene ${index + 1}`,
      kind: "scene",
      scene: index + 1,
      status: ready ? "done" : "pending",
      preexisting: ready,
    });
  });
  jobs.push({
    key: "video",
    label: "Full video",
    kind: "video",
    status: "pending",
    detail: "Stitches scene clips + map transitions",
  });
  return jobs;
}

async function startProcessVideo() {
  if (state.render.status === "running" && state.render.video === state.videoId) return;
  const { total } = videoTimeline();
  if (!total) return;
  clearTimeout(saveTimer);
  await save();
  await refreshOutputs();
  resetRenderEta();
  state.processPanel = {
    open: true,
    jobs: buildProcessJobs(),
    cancelling: false,
  };
  render();
  await advanceProcessQueue();
}

async function advanceProcessQueue() {
  const panel = state.processPanel;
  if (!panel?.open) return;

  if (panel.cancelling) {
    panel.jobs.forEach((job) => {
      if (job.status === "pending") job.status = "cancelled";
      if (job.kind === "transition" && job.status === "bundled") job.status = "cancelled";
    });
    panel.cancelling = false;
    render();
    return;
  }

  const next = panel.jobs.find(
    (job) => job.status === "pending" && (job.kind === "scene" || job.kind === "video")
  );
  if (!next) {
    render();
    return;
  }

  next.status = "running";
  beginRenderEta();
  render();
  await generate(next.kind === "scene" ? next.scene : null);
}

async function finishProcessJob(status) {
  const panel = state.processPanel;
  if (!panel?.open) {
    // Process Scene / standalone renders still need a UI refresh.
    if (
      status === "done" &&
      state.shortCut?.pendingDownload &&
      state.render.kind === "scene" &&
      state.render.scene === state.sceneIndex + 1 &&
      outputReady(sceneOutput(state.sceneIndex))
    ) {
      state.shortCut.pendingDownload = false;
      downloadShort(state.sceneIndex + 1);
      return;
    }
    if ((status === "error" || status === "idle") && state.shortCut) {
      state.shortCut.pendingDownload = false;
    }
    render();
    return;
  }

  const running = panel.jobs.find((job) => job.status === "running");
  if (!running) {
    if (panel.cancelling) await advanceProcessQueue();
    else render();
    return;
  }

  if (status === "done") {
    running.status = "done";
    const finishedVideo = running.kind === "video";
    if (finishedVideo) {
      panel.jobs.forEach((job) => {
        if (job.kind === "transition" && job.status === "bundled") job.status = "done";
      });
    }
    render();
    await advanceProcessQueue();
    if (finishedVideo && outputReady(state.outputs?.video)) {
      downloadOutput();
    }
    return;
  }

  running.status = status === "error" ? "error" : "cancelled";
  panel.jobs.forEach((job) => {
    if (job.status === "pending") job.status = "cancelled";
    if (job.kind === "transition" && job.status === "bundled") job.status = "cancelled";
  });
  panel.cancelling = false;
  resetRenderEta();
  render();
}

async function cancelProcessQueue() {
  const panel = state.processPanel;
  if (!panel?.open) return;
  panel.cancelling = true;
  if (state.render.status === "running" && state.render.video === state.videoId) {
    await stopGenerate();
    return;
  }
  await advanceProcessQueue();
}

function closeProcessPanel() {
  const panel = state.processPanel;
  if (!panel?.open) return;
  if (panel.jobs.some((job) => job.status === "running")) return;
  state.processPanel = null;
  resetRenderEta();
  render();
}

function processPanelMark(job) {
  if (job.status === "done") return "✓";
  if (job.status === "running") return "…";
  if (job.status === "error") return "!";
  if (job.status === "cancelled") return "–";
  if (job.status === "bundled") return "○";
  return "○";
}

function processPanelMeta(job) {
  if (job.status === "running") {
    const pct = state.render.percent || 0;
    const seconds = jobFinishEtaSeconds(job);
    return seconds == null ? `${pct}%` : `${pct}% · ${formatRenderEta(seconds)}`;
  }
  if (job.status === "pending" && (job.kind === "scene" || job.kind === "video")) {
    const seconds = jobFinishEtaSeconds(job);
    return seconds == null ? "Queued" : formatRenderEta(seconds);
  }
  if (job.status === "done") {
    return job.preexisting ? "Ready — using saved clip" : "Done";
  }
  if (job.status === "error") return state.render.message || "Failed";
  if (job.status === "cancelled") return "Cancelled";
  if (job.status === "bundled") return job.detail || "With full video";
  return job.detail || "Queued";
}

function processPanelView() {
  const panel = state.processPanel;
  if (!panel?.open) return null;

  const jobs = panel.jobs;
  const running = jobs.some((job) => job.status === "running");
  const failed = jobs.some((job) => job.status === "error");
  const cancelled = !running && jobs.some((job) => job.status === "cancelled");
  const complete =
    !running &&
    !failed &&
    !cancelled &&
    jobs
      .filter((job) => job.kind === "scene" || job.kind === "video")
      .every((job) => job.status === "done") &&
    jobs
      .filter((job) => job.kind === "transition")
      .every((job) => job.status === "done" || job.status === "bundled");
  const videoReady = outputReady(state.outputs?.video);
  const totalSeconds = running ? queueEtaSeconds() : null;

  let title = "Processing…";
  if (complete) title = "Processing complete";
  else if (failed) title = "Processing failed";
  else if (cancelled) title = "Processing cancelled";

  return h(
    "aside",
    {
      class: "process-panel",
      role: "status",
      "aria-live": "polite",
      "aria-label": title,
    },
    h(
      "div",
      { class: "process-panel-head" },
      h("strong", { class: "process-panel-title", text: title }),
      !running &&
        h(
          "button",
          {
            class: "process-panel-close",
            type: "button",
            title: "Close",
            "aria-label": "Close",
            onClick: () => closeProcessPanel(),
            text: "×",
          }
        )
    ),
    h(
      "ul",
      { class: "process-panel-list" },
      jobs.map((job) =>
        h(
          "li",
          {
            class: [
              "process-panel-item",
              `is-${job.status}`,
              job.kind === "transition" ? "is-transition" : "",
            ]
              .filter(Boolean)
              .join(" "),
          },
          h("span", {
            class: "process-panel-mark",
            "aria-hidden": true,
            text: processPanelMark(job),
          }),
          h(
            "span",
            { class: "process-panel-copy" },
            h("span", { class: "process-panel-label", text: job.label }),
            h("span", { class: "process-panel-meta", text: processPanelMeta(job) })
          )
        )
      )
    ),
    running &&
      h(
        "div",
        { class: "process-panel-bar" },
        h("div", {
          class: "fill",
          style: { width: `${Math.min(100, state.render.percent || 0)}%` },
        })
      ),
    h(
      "div",
      { class: "process-panel-actions" },
      running &&
        totalSeconds != null &&
        h("span", {
          class: "process-panel-total",
          text: formatRenderEta(totalSeconds),
          title: "Total time left for all remaining steps",
        }),
      running
        ? h(
            "button",
            {
              class: "btn stop",
              type: "button",
              onClick: () => cancelProcessQueue(),
              text: "Cancel",
            }
          )
        : null,
      !running &&
        videoReady &&
        h(
          "button",
          {
            class: "btn primary",
            type: "button",
            onClick: () => downloadOutput(),
            text: "Download video",
          }
        ),
      !running &&
        !videoReady &&
        h(
          "button",
          {
            class: "btn ghost",
            type: "button",
            onClick: () => closeProcessPanel(),
            text: "Close",
          }
        )
    )
  );
}

function downloadOutput(sceneNumber = null) {
  let url = `/download?v=${encodeURIComponent(state.videoId)}`;
  if (sceneNumber) url += `&scene=${sceneNumber}`;
  window.location.href = url;
}

function shortCutOpen() {
  return !!(state.shortCut && state.shortCut.open);
}

/** Normalized width of a full-height 9:16 strip on the 3:2 picture. */
function shortRectWidth() {
  return regionNormWH("portrait");
}

function shortRectBox(cx = state.shortCut?.cx ?? 0.5) {
  const w = shortRectWidth();
  const x = Math.min(1 - w, Math.max(0, cx - w / 2));
  return { x, y: 0, w, h: 1, cx: x + w / 2 };
}

function openShortCut() {
  if (isTransitionScene()) {
    state.note = "Pick a picture scene — transitions don't have clips to snip";
    render();
    return;
  }
  if (!sceneSequence(state.sceneIndex).total) {
    state.note = "Add a picture (and optional songs) before cutting a short";
    render();
    return;
  }
  state.pictureExpanded = false;
  state.regionTool = false;
  state.selectedAnim = null;
  state.selectedEdit = null;
  state.shortCut = {
    open: true,
    cx: 0.5,
    duration: state.shortCut?.duration > 0 ? state.shortCut.duration : 15,
    pendingDownload: false,
  };
  state.note = "Drag the 9:16 frame, scrub the start, set duration, then Download";
  render();
}

function closeShortCut() {
  if (!state.shortCut) return;
  state.shortCut = null;
  state.note = "";
  render();
}

function downloadShort(sceneNumber = state.sceneIndex + 1) {
  const cut = state.shortCut;
  const cx = cut?.cx ?? 0.5;
  const start = Math.max(0, player.at || 0);
  const duration = Math.max(0.5, Number(cut?.duration) || 15);
  const url =
    `/download-short?v=${encodeURIComponent(state.videoId)}` +
    `&scene=${encodeURIComponent(sceneNumber)}` +
    `&cx=${encodeURIComponent(String(cx))}` +
    `&start=${encodeURIComponent(String(start))}` +
    `&duration=${encodeURIComponent(String(duration))}`;
  window.location.href = url;
  state.note = `Downloading ${duration}s 9:16 short…`;
  render();
}

async function confirmShortDownload() {
  if (!shortCutOpen()) return;
  const sceneNumber = state.sceneIndex + 1;
  if (state.render.status === "running" && state.render.video === state.videoId) {
    state.note = "Wait for the current render to finish";
    render();
    return;
  }
  if (!outputReady(sceneOutput(state.sceneIndex))) {
    state.shortCut.pendingDownload = true;
    state.note = "Processing scene, then downloading short…";
    render();
    await generate(sceneNumber);
    return;
  }
  state.shortCut.pendingDownload = false;
  downloadShort(sceneNumber);
}

function beginShortRectDrag(event) {
  if (!shortCutOpen()) return;
  event.preventDefault();
  event.stopPropagation();
  const picture = event.currentTarget.closest(".picture");
  if (!picture) return;
  const box = picture.getBoundingClientRect();
  const w = shortRectWidth();
  const grabX = (event.clientX - box.left) / box.width;
  const originCx = state.shortCut.cx;
  const offset = grabX - originCx;
  const layer = picture.querySelector(".short-rect");
  const shadeL = picture.querySelector(".short-shade-left");
  const shadeR = picture.querySelector(".short-shade-right");

  const paint = (cx) => {
    const rect = shortRectBox(cx);
    state.shortCut.cx = rect.cx;
    if (layer) {
      layer.style.left = `${rect.x * 100}%`;
      layer.style.width = `${rect.w * 100}%`;
    }
    if (shadeL) shadeL.style.width = `${rect.x * 100}%`;
    if (shadeR) {
      shadeR.style.left = `${(rect.x + rect.w) * 100}%`;
      shadeR.style.width = `${(1 - rect.x - rect.w) * 100}%`;
    }
  };

  const surface = event.currentTarget;
  surface.setPointerCapture(event.pointerId);
  const move = (moveEvent) => {
    const x = (moveEvent.clientX - box.left) / box.width;
    paint(Math.min(1 - w / 2, Math.max(w / 2, x - offset)));
  };
  const up = () => {
    surface.releasePointerCapture(event.pointerId);
    surface.removeEventListener("pointermove", move);
    surface.removeEventListener("pointerup", up);
    surface.removeEventListener("pointercancel", up);
  };
  surface.addEventListener("pointermove", move);
  surface.addEventListener("pointerup", up);
  surface.addEventListener("pointercancel", up);
}

function shortRectIcon() {
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
    h("rect", { x: "5", y: "1.5", width: "6", height: "13", rx: "1" })
  );
}

function shortCutPanel() {
  if (!shortCutOpen()) return null;
  const total = scenePlayTotal(state.sceneIndex) || 0;
  const start = Math.min(Math.max(0, player.at || 0), total || 0);
  const duration = Math.max(0.5, Number(state.shortCut.duration) || 15);
  const end = total ? Math.min(total, start + duration) : start + duration;
  const ready = outputReady(sceneOutput(state.sceneIndex));
  const busy =
    state.shortCut.pendingDownload ||
    (state.render.status === "running" && state.render.video === state.videoId);
  return h(
    "div",
    { class: "short-cut-panel" },
    h("div", { class: "short-cut-title", text: "Cut short" }),
    h(
      "div",
      { class: "short-cut-row" },
      h("label", { class: "short-cut-field" },
        h("span", { class: "meta", text: "Start (s)" }),
        h("input", {
          class: "short-cut-num short-cut-start",
          type: "number",
          min: "0",
          step: "0.5",
          value: String(Math.round(start * 10) / 10),
          title: "Type a start time, or scrub the timeline below",
          onInput: (event) => {
            const span = scenePlayTotal(state.sceneIndex) || 0;
            const next = Math.max(0, Number(event.target.value) || 0);
            seekTo(span > 0 ? Math.min(span, next) : next);
            paintShortRange();
          },
        })
      ),
      h("label", { class: "short-cut-field" },
        h("span", { class: "meta", text: "Duration (s)" }),
        h("input", {
          class: "short-cut-num short-cut-duration",
          type: "number",
          min: "0.5",
          step: "0.5",
          value: String(duration),
          onInput: (event) => {
            const next = Math.max(0.5, Number(event.target.value) || 0.5);
            state.shortCut.duration = next;
            paintShortRange();
          },
        })
      ),
      h("span", {
        class: "meta short-cut-end",
        text: `${clock(start)} → ${clock(end)}`,
      })
    ),
    h(
      "div",
      { class: "short-cut-actions" },
      h("button", {
        class: "btn",
        type: "button",
        text: "Cancel",
        onClick: () => closeShortCut(),
      }),
      h("button", {
        class: "btn primary",
        type: "button",
        disabled: busy,
        text: busy
          ? state.shortCut.pendingDownload
            ? "Processing…"
            : "Working…"
          : ready
            ? "Download"
            : "Process & download",
        title: ready
          ? "Download the 9:16 short"
          : "Process this scene, then download the short",
        onClick: () => confirmShortDownload(),
      })
    )
  );
}

function paintShortRange() {
  if (!shortCutOpen()) return;
  const total = player.total || scenePlayTotal(state.sceneIndex) || 0;
  const start = total > 0 ? Math.min(Math.max(0, player.at || 0), total) : Math.max(0, player.at || 0);
  const duration = Math.max(0.5, Number(state.shortCut.duration) || 15);
  if (scrubber?.shortRange) {
    if (!(total > 0)) {
      scrubber.shortRange.style.display = "none";
    } else {
      const width = Math.max(0, Math.min(total - start, duration)) / total;
      scrubber.shortRange.style.display = "";
      scrubber.shortRange.style.left = `${(start / total) * 100}%`;
      scrubber.shortRange.style.width = `${width * 100}%`;
    }
  }
  const startInput = document.querySelector(".short-cut-start");
  if (startInput && document.activeElement !== startInput) {
    const shown = String(Math.round(start * 10) / 10);
    if (startInput.value !== shown) startInput.value = shown;
  }
  const endLabel = document.querySelector(".short-cut-end");
  if (endLabel) {
    const end = total > 0 ? Math.min(total, start + duration) : start + duration;
    endLabel.textContent = `${clock(start)} → ${clock(end)}`;
  }
}

/** Debug: save a JSON snapshot of the scene or full script. */
function downloadJsonObject(data, filename) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function moreDotsIcon() {
  return h(
    "svg",
    {
      class: "icon",
      viewBox: "0 0 16 16",
      width: "14",
      height: "14",
      fill: "currentColor",
      "aria-hidden": true,
    },
    h("circle", { cx: "8", cy: "3", r: "1.25" }),
    h("circle", { cx: "8", cy: "8", r: "1.25" }),
    h("circle", { cx: "8", cy: "13", r: "1.25" })
  );
}

function debugObjectMenu({ getObject, filename, title = "Download object" }) {
  return h(
    "div",
    { class: "debug-menu" },
    h(
      "button",
      {
        class: "btn ghost icon-btn",
        type: "button",
        title: "More",
        "aria-label": "More options",
        "aria-haspopup": "menu",
        onClick: (event) => {
          event.stopPropagation();
          const root = event.currentTarget.closest(".debug-menu");
          const open = root.classList.toggle("is-open");
          if (open) {
            const close = (next) => {
              if (root.contains(next.target)) return;
              root.classList.remove("is-open");
              document.removeEventListener("pointerdown", close, true);
            };
            document.addEventListener("pointerdown", close, true);
          }
        },
      },
      moreDotsIcon()
    ),
    h(
      "div",
      { class: "debug-menu-panel", role: "menu" },
      h(
        "button",
        {
          class: "debug-menu-item",
          type: "button",
          role: "menuitem",
          onClick: (event) => {
            event.stopPropagation();
            downloadJsonObject(getObject(), filename);
            event.currentTarget.closest(".debug-menu")?.classList.remove("is-open");
          },
          text: title,
        }
      )
    )
  );
}

function sceneObjectFilename(index = state.sceneIndex) {
  const entry = scenes()[index] || {};
  const slug = (entry.title || `scene-${index + 1}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${state.videoId || "video"}-${slug || `scene-${index + 1}`}.json`;
}

function videoObjectFilename() {
  const slug = (state.script?.project || state.videoId || "video")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug || "video"}.json`;
}

function downloadSceneImage() {
  const path = editOwnerScene()?.image || scene()?.image;
  if (!path) return;
  const name = path.split("/").pop() || "scene.png";
  window.location.href = `/download-asset?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`;
}

async function clearSceneImage({ deleteAsset = false } = {}) {
  const owner = editOwnerScene() || scene();
  if (!owner) return;
  const path = owner.image || "";
  owner.image = "";
  if (deleteAsset && path) {
    try {
      await fetch(`/api/asset?path=${encodeURIComponent(path)}`, { method: "DELETE" });
      await refreshOutputs();
    } catch {
      /* still clear the scene assignment */
    }
  }
  state.note = "";
  changed();
}

async function createSceneImage() {
  const entry = ensureSceneBrief();
  const prompt = fullSceneImagePrompt(entry);
  const prev = state.sceneGen || {};
  if (!prompt.trim()) {
    state.sceneGen = {
      ...prev,
      revealed: true,
      status: "error",
      error: "Add a scene prompt (and jar/episode style) first.",
    };
    render();
    return;
  }
  state.sceneGen = { ...prev, revealed: true, status: "generating", error: "" };
  render();
  const stem =
    (entry.title || "").trim().replace(/\s+/g, "-").slice(0, 40) ||
    `scene-${(state.sceneIndex || 0) + 1}`;
  try {
    const response = await fetch("/api/generate-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, name: stem, video: state.videoId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Image generation failed");
    await refreshOutputs();
    pickImageForScene(data.path);
    state.sceneGen = { ...prev, revealed: true, status: "idle", error: "" };
    state.note = "Scene image generated";
    if (state.ledger?.open) await refreshLedger({ silent: true });
    else refreshLedger({ silent: true });
    render();
  } catch (error) {
    state.sceneGen = {
      ...prev,
      revealed: true,
      status: "error",
      error: error.message || "Image generation failed",
    };
    render();
  }
}

function sceneCreatePanel() {
  if (isTransitionScene() || state.pictureExpanded) return null;
  ensureCreativeBrief();
  const entry = ensureSceneBrief();
  const gen = state.sceneGen || {
    revealed: false,
    videoPromptOpen: false,
    status: "idle",
    error: "",
  };
  const generating = gen.status === "generating";
  const videoPromptOpen = !!gen.videoPromptOpen;
  return h(
    "section",
    { class: `scene-create${generating ? " is-generating" : ""}` },
    h(
      "div",
      { class: `scene-create-video${videoPromptOpen ? " is-open" : ""}` },
      h(
        "button",
        {
          class: "scene-create-video-toggle",
          type: "button",
          "aria-expanded": videoPromptOpen ? "true" : "false",
          onClick: () => {
            state.sceneGen = { ...gen, videoPromptOpen: !videoPromptOpen };
            render();
          },
        },
        h("span", {
          class: "details-chevron",
          "aria-hidden": true,
          text: videoPromptOpen ? "▾" : "▸",
        }),
        h("span", { text: "Video prompt" })
      ),
      videoPromptOpen &&
        h("textarea", {
          class: "brief-input scene-create-video-prompt",
          rows: 4,
          value: state.script.prompt || "",
          disabled: generating,
          "aria-label": "Video image prompt",
          title: "House style for this video — used by every scene",
          onInput: (event) => {
            state.script.prompt = event.target.value;
            markDetailsDirty();
            clearTimeout(saveTimer);
            saveTimer = setTimeout(save, 400);
          },
        })
    ),
    h("textarea", {
      class: "brief-input scene-create-prompt",
      rows: 3,
      value: entry.image_prompt || "",
      placeholder: "Describe this scene",
      disabled: generating,
      onInput: (event) => {
        entry.image_prompt = event.target.value;
        markDetailsDirty();
      },
    }),
    h(
      "div",
      { class: "scene-create-actions" },
      h(
        "button",
        {
          class: "btn primary scene-create-btn",
          type: "button",
          disabled: generating,
          onClick: () => createSceneImage(),
        },
        generating ? "Generating…" : "Create a scene"
      )
    ),
    generating && h("p", { class: "scene-create-status", text: "Generating" }),
    gen.status === "error" &&
      gen.error &&
      h("p", { class: "scene-create-error", text: gen.error })
  );
}

function poll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    state.render = await (await fetch("/api/render")).json();
    lastRenderStatus = state.render.status;
    if (state.render.status === "running") {
      noteRenderProgress(state.render.percent || 0);
      render();
      poll();
      return;
    }
    if (state.render.status === "done") {
      // Keep pace across Process Video steps; only drop the per-job sample window.
      if (state.processPanel?.open) beginRenderEta();
      else resetRenderEta();
      await refreshOutputs();
      await finishProcessJob("done");
      return;
    }
    if (state.render.status === "error") {
      resetRenderEta();
      await finishProcessJob("error");
      return;
    }
    if (state.render.status === "idle") {
      resetRenderEta();
      await finishProcessJob("idle");
      return;
    }
    render();
  }, 500);
}

/* ---------- chrome ---------- */

function breadcrumbs() {
  const crumbs = [
    h("a", {
      class: "crumb",
      href: "/jars",
      onClick: (event) => {
        event.preventDefault();
        go("jars");
      },
      text: "Jars",
    }),
  ];

  if (state.jarMeta && state.page !== "jars") {
    crumbs.push(h("span", { class: "sep", text: "/" }));
    crumbs.push(
      h("a", {
        class: "crumb",
        href: `/jar?j=${encodeURIComponent(state.jarMeta.id)}`,
        onClick: (event) => {
          event.preventDefault();
          go("jar", { jarId: state.jarMeta.id });
        },
        text: state.jarMeta.title,
      })
    );
  }

  if (state.script && (state.page === "video" || state.page === "scene")) {
    crumbs.push(h("span", { class: "sep", text: "/" }));
    crumbs.push(
      h("a", {
        class: "crumb",
        href: withJarParam(`/video?v=${encodeURIComponent(state.videoId)}`),
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
    crumbs.push(
      h("span", {
        class: "crumb current",
        text: scene().title || `Scene ${state.sceneIndex + 1}`,
      })
    );
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
  const ready = outputReady(sceneOut);
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

function sceneDisplayName(index = state.sceneIndex) {
  return (scenes()[index]?.title || "").trim() || `Scene ${index + 1}`;
}

function exportActions({ sceneMode = false } = {}) {
  const busy = state.render.status === "running" && state.render.video === state.videoId;
  const { total } = videoTimeline();
  const sceneTotal = sceneSequence(state.sceneIndex).total;
  const sceneNumber = state.sceneIndex + 1;
  const sceneOut = sceneOutput(state.sceneIndex);
  const videoOut = state.outputs?.video;
  const transition = sceneMode && isTransitionScene();
  const sceneName = sceneDisplayName();
  // Top-right order: status · ⋮ · download · Process
  const sceneDebug = debugObjectMenu({
    getObject: () => structuredClone(scenes()[state.sceneIndex] || {}),
    filename: sceneObjectFilename(),
  });
  const videoDebug = debugObjectMenu({
    getObject: () => structuredClone(state.script || {}),
    filename: videoObjectFilename(),
  });

  if (busy) {
    const renderingName =
      state.render.kind === "scene" && state.render.scene
        ? sceneDisplayName(state.render.scene - 1)
        : sceneName;
    const label =
      state.render.kind === "scene"
        ? `Stop processing '${renderingName}' ${state.render.percent}%`
        : `Stop processing video ${state.render.percent}%`;
    const actions = [];
    if (sceneMode && !transition) {
      actions.push(outputTag(sceneOut, { showMissing: true }));
    }
    actions.push(sceneMode ? sceneDebug : videoDebug);
    if (sceneMode && !transition) {
      actions.push(sceneDownloadIconButton(sceneNumber, sceneOut));
    } else if (!sceneMode) {
      actions.push(downloadVideoControl());
    }
    actions.push(
      h("span", {
        class: "meta render-eta",
        text: formatRenderEta(
          state.processPanel?.open ? queueEtaSeconds() : state.renderEta
        ),
        title: state.processPanel?.open
          ? "Estimated time left for the full process queue"
          : "Estimated time left and finish time",
      })
    );
    actions.push(
      h(
        "button",
        {
          class: "btn stop",
          type: "button",
          title: "Stop rendering",
          onClick: () =>
            state.processPanel?.open ? cancelProcessQueue() : stopGenerate(),
          text: label,
        }
      )
    );
    return actions.filter(Boolean);
  }

  if (sceneMode) {
    return [
      !transition && outputTag(sceneOut, { showMissing: true }),
      sceneDebug,
      !transition && sceneDownloadIconButton(sceneNumber, sceneOut),
      h(
        "button",
        {
          class: "btn primary",
          disabled: transition || !sceneTotal,
          title: transition
            ? "Transitions bake into the full video — use Process Video"
            : `Render '${sceneName}' only (no map transitions)`,
          onClick: () => generate(sceneNumber),
        },
        `Process '${sceneName}'`
      ),
    ].filter(Boolean);
  }

  return [videoDebug, downloadVideoControl(), generateVideoButton(total, videoOut)];
}

function renderGateItems() {
  const items = scenes()
    .map((entry, index) =>
      entry.is_transition
        ? null
        : {
            key: `scene-${index}`,
            label: entry.title?.trim() || `Scene ${index + 1}`,
            ready: outputReady(sceneOutput(index)),
          }
    )
    .filter(Boolean);
  items.push({
    key: "video",
    label: "Full video",
    ready: outputReady(state.outputs?.video),
  });
  return items;
}

function downloadVideoControl() {
  const ready = outputReady(state.outputs?.video);
  const items = renderGateItems();
  const pending = items.filter((item) => !item.ready);
  const downloadBtn = h(
    "button",
    {
      class: "btn ghost icon-btn",
      type: "button",
      disabled: !ready,
      title: ready
        ? state.outputs?.video?.name || "Download video"
        : "Process first to download",
      "aria-label": ready ? "Download video" : "Process first to download",
      onClick: () => {
        if (!ready) return;
        downloadOutput();
      },
    },
    downloadIcon()
  );

  if (ready) return downloadBtn;

  return h(
    "div",
    { class: "download-gate" },
    downloadBtn,
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
              : "Process Video catches up outdated scenes, then stitches clips and adds transitions.",
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
      title: outputReady(videoOut)
        ? "Catch up outdated scenes if needed, then stitch clips + transitions"
        : "Process missing/outdated scenes, then stitch clips + transitions",
      onClick: () => startProcessVideo(),
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
  if (state.page !== "jars" && state.page !== "jar" && state.page !== "landing") {
    ensureScript();
    syncSource();
  }

  app.classList.toggle("shell--landing", state.page === "landing");
  if (state.page !== "scene" && state.page !== "video") {
    state.pictureExpanded = false;
    app.classList.remove("is-expanded", "is-edit-split"); // is-edit-split legacy class
  }
  if (state.page !== "video") overlayUi = null;

  const view =
    state.page === "landing"
      ? landingView()
      : state.page === "jars"
        ? jarsView()
        : state.page === "jar"
          ? jarView()
          : state.page === "scene"
            ? sceneView()
            : videoView();
  const panel = processPanelView();
  app.replaceChildren(...[view, panel].filter(Boolean));

  restoreScroll(savedScroll);
  // Layout can settle after the first paint; restore again so we don't jump to top.
  requestAnimationFrame(() => restoreScroll(savedScroll));

  paintPlayhead();
}

function speakerIcon({ muted = false } = {}) {
  return h(
    "svg",
    {
      class: "icon",
      viewBox: "0 0 24 24",
      width: "20",
      height: "20",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.7",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": true,
    },
    h("path", { d: "M4 10v4h3l5 4V6L7 10H4z" }),
    muted
      ? h("path", { d: "M16 10.5l4 4m0-4l-4 4" })
      : h("path", { d: "M15.5 9.5a4 4 0 0 1 0 5M18 7.5a7 7 0 0 1 0 9" })
  );
}

function syncLandingMute(video, muted) {
  if (!video) return;
  video.muted = muted;
  video.defaultMuted = muted;
  if (muted) video.setAttribute("muted", "");
  else video.removeAttribute("muted");
}

function toggleLandingSound(event) {
  event.preventDefault();
  event.stopPropagation();
  const video = document.querySelector(".landing-video");
  const btn = event.currentTarget;
  if (!video || !btn) return;
  const nextMuted = !video.muted;
  state.landingMuted = nextMuted;
  syncLandingMute(video, nextMuted);
  if (!nextMuted) {
    const play = video.play();
    if (play && typeof play.catch === "function") play.catch(() => {});
  }
  btn.classList.toggle("is-muted", nextMuted);
  btn.setAttribute("aria-label", nextMuted ? "Unmute video" : "Mute video");
  btn.setAttribute("title", nextMuted ? "Unmute" : "Mute");
  btn.replaceChildren(speakerIcon({ muted: nextMuted }));
}

function landingView() {
  const copy = landingCopy();
  const muted = state.landingMuted !== false;
  state.landingMuted = muted;
  const video = h("video", {
    class: "landing-video",
    src: copy.video,
    poster: copy.poster,
    autoplay: true,
    muted,
    loop: true,
    playsinline: true,
    preload: "auto",
  });
  // Attribute-only muted/autoplay is flaky (Safari + Reduce Motion). Drive it.
  syncLandingMute(video, muted);
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  const kick = () => {
    // Keep the user's unmute choice — only force muted on first autoplay path.
    syncLandingMute(video, state.landingMuted !== false);
    const play = video.play();
    if (play && typeof play.catch === "function") play.catch(() => {});
  };
  video.addEventListener("loadeddata", kick);
  video.addEventListener("canplay", kick);
  document.addEventListener(
    "visibilitychange",
    () => {
      if (!document.hidden) kick();
    },
    { passive: true }
  );
  // One more nudge after mount — covers late layout / cached decode.
  requestAnimationFrame(() => kick());
  setTimeout(kick, 250);

  return h(
    "section",
    { class: "landing", "aria-label": copy.brand },
    h("div", { class: "landing-bg", "aria-hidden": "true" }, video),
    h("div", { class: "landing-veil", "aria-hidden": "true" }),
    h("div", { class: "landing-vignette", "aria-hidden": "true" }),
    h(
      "a",
      {
        class: "landing-brand",
        href: "/",
        onClick: (event) => {
          event.preventDefault();
          go("landing");
        },
        text: copy.brand,
      }
    ),
    h(
      "div",
      { class: "landing-copy" },
      h("h1", { class: "landing-title", text: copy.title }),
      copy.description
        ? h("p", { class: "landing-desc", text: copy.description })
        : null,
      h(
        "div",
        { class: "landing-actions" },
        h(
          "a",
          {
            class: "landing-cta",
            href: copy.href,
            onClick: (event) => {
              event.preventDefault();
              go("video", { videoId: copy.videoId });
            },
            text: copy.cta,
          }
        ),
        copy.secondary
          ? h(
              "a",
              {
                class: "landing-secondary",
                href: copy.secondaryHref,
                onClick: (event) => {
                  event.preventDefault();
                  go("jars");
                },
                text: copy.secondary,
              }
            )
          : null
      )
    ),
    h(
      "button",
      {
        class: `landing-sound${muted ? " is-muted" : ""}`,
        type: "button",
        title: muted ? "Unmute" : "Mute",
        "aria-label": muted ? "Unmute video" : "Mute video",
        onClick: toggleLandingSound,
      },
      speakerIcon({ muted })
    ),
    h(
      "div",
      { class: "landing-scroll", "aria-hidden": "true" },
      h("span", { class: "landing-scroll-mark" })
    )
  );
}

function mediaThumbStyle(path) {
  if (!path) return {};
  // Posters under assets/videos are served directly; images go through /thumb.
  if (/\.(mp4|mov|webm|mkv)$/i.test(path)) {
    return {};
  }
  if (path.startsWith("assets/videos/")) {
    return { backgroundImage: `url(/${path})` };
  }
  return {
    backgroundImage: `url(/thumb?path=${encodeURIComponent(path)}&w=240)`,
  };
}

function jarsView() {
  return h(
    "div",
    { class: "shell-inner" },
    topbar(),
    h(
      "div",
      { class: "video-page jars-page" },
      h("h1", { class: "page-title", text: "Jars" }),
      h("p", {
        class: "page-blurb",
        text: "Worlds you can build in — each jar holds videos, scenes, and shared rules.",
      }),
      h(
        "div",
        { class: "jar-grid" },
        state.jars.length
          ? state.jars.map((jar) =>
              h(
                "button",
                {
                  class: "jar-card",
                  type: "button",
                  onClick: () => go("jar", { jarId: jar.id }),
                },
                h("div", {
                  class: `jar-card-thumb${jar.thumb ? "" : " blank"}`,
                  style: mediaThumbStyle(jar.thumb),
                  text: jar.thumb ? "" : "No thumb",
                }),
                h(
                  "div",
                  { class: "jar-card-body" },
                  h(
                    "div",
                    { class: "jar-title-row" },
                    h("span", { class: "jar-card-name", text: jar.title }),
                    h("span", {
                      class: "jar-descriptor",
                      text: jar.descriptor || "world",
                    })
                  ),
                  jar.summary &&
                    h("p", { class: "jar-card-summary", text: jar.summary }),
                  h(
                    "div",
                    { class: "jar-card-foot" },
                    h("span", { class: "jar-card-dot", "aria-hidden": true }),
                    h("span", {
                      class: "jar-card-count",
                      text: `${jar.videos} video${jar.videos === 1 ? "" : "s"}`,
                    })
                  )
                )
              )
            )
          : h("p", {
              class: "empty-note",
              text: "No jars yet — add a JSON file to jars/",
            })
      )
    )
  );
}

function jarView() {
  const jar = state.jar || {};
  const title = state.jarMeta?.title || state.jarId || "Jar";
  const descriptor = state.jarMeta?.descriptor || jar.descriptor || "world";
  return h(
    "div",
    { class: "shell-inner" },
    topbar(),
    h(
      "div",
      { class: "video-page jar-page" },
      h(
        "div",
        { class: "page-title-row" },
        h("h1", { class: "page-title", text: title }),
        h("span", { class: "jar-descriptor is-large", text: descriptor })
      ),
      jar.summary
        ? h("p", { class: "page-blurb", text: jar.summary })
        : h("p", {
            class: "page-blurb",
            text: "Videos in this world. Rules and prompts below apply across them.",
          }),
      jar.hero
        ? h(
            "div",
            { class: "jar-hero" },
            h("video", {
              class: "jar-hero-video",
              src: jar.hero.startsWith("/") ? jar.hero : `/${jar.hero}`,
              poster: jar.thumb
                ? jar.thumb.startsWith("/")
                  ? jar.thumb
                  : `/${jar.thumb}`
                : "",
              autoplay: true,
              muted: true,
              loop: true,
              playsinline: true,
              onLoadedData: (event) => {
                const el = event.currentTarget;
                if (!el) return;
                el.muted = true;
                el.play().catch(() => {});
              },
            })
          )
        : null,
      h(
        "div",
        { class: "jar-panels" },
        h(
          "section",
          { class: "jar-panel" },
          h("h2", { class: "jar-panel-title", text: "Rules" }),
          h("p", {
            class: "jar-panel-body",
            text: jar.rules || "No rules set for this world yet.",
          })
        ),
        h(
          "section",
          { class: "jar-panel" },
          h("h2", { class: "jar-panel-title", text: "Global prompt" }),
          h("p", {
            class: "jar-panel-body",
            text: jar.prompt || "No global prompt yet.",
          })
        )
      ),
      h("h2", { class: "jar-section-title", text: "Videos" }),
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
                  onClick: () =>
                    go("video", { videoId: video.id, jarId: state.jarId }),
                },
                h("div", {
                  class: `video-thumb${video.thumb ? "" : " blank"}`,
                  style: mediaThumbStyle(video.thumb),
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
          : h("p", {
              class: "empty-note",
              text: "No videos in this jar yet — add ids to jars/<id>.json → videos.",
            })
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
  app.classList.remove("is-edit-split");

  return h(
    "div",
    { class: "shell-inner" },
    topbar(exportActions()),
    h(
      "div",
      { class: "video-page is-workspace" },
      h(
        "aside",
        { class: "video-sidebar" },
        h(
          "section",
          { class: "video-sidebar-section" },
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
                const ready = normalIndexes.filter((index) =>
                  outputReady(sceneOutput(index))
                ).length;
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
          )
        ),
        transitionPool()
      ),
      h(
        "div",
        { class: "video-main" },
        h(
          "div",
          { class: "page-title-row" },
          h("h1", { class: "page-title", text: state.script.project || state.videoId }),
          outputTag(state.outputs?.video),
          ledgerButton()
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
        ledgerPanel()
      )
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

/** Read-only still-edit layer for the video-page preview. */
function previewEditLayer(entry) {
  const normalized = normalizeEdit(entry);
  if (!normalized.file) return null;
  if (!(state.assets.images || []).some((item) => item.path === normalized.file)) {
    // Still may not be in the images scan yet — show if path looks like an image.
    if (!/\.(png|jpe?g|webp|gif)$/i.test(normalized.file)) return null;
  }
  const soft = normalized.soft_edges ? " soft-edges" : "";
  return h(
    "div",
    {
      class: `edit-layer anim-layer is-preview is-edit aspect-${normalized.aspect || "landscape"}`,
      style: animLayerStyle(normalized),
      "aria-hidden": "true",
    },
    h("img", {
      class: `edit-still${soft}`,
      src: `/${normalized.file}`,
      alt: "",
      draggable: false,
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

  (entry.edits || []).forEach((edit) => {
    const layer = previewEditLayer(edit);
    if (layer) overlayUi.motion.append(layer);
  });

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

/** Map-bridge edits/anims ride with the overlay (and fade-zoom), not the scene under it. */
function syncVideoPreviewMapMotion(at = player.at) {
  if (!overlayUi?.mapMotion) return;
  const overlay = transitionOverlayAt(at);
  const template = overlay?.path && overlay?.entry ? resolveTransition(overlay.entry) : null;
  const sig = template
    ? [
        template.id || "",
        (template.edits || []).map((e) => e.file || "").join("|"),
        (template.animations || []).map((a) => a.file || "").join("|"),
      ].join("::")
    : "";
  if (overlayUi.mapMotionKey === sig) return;
  overlayUi.mapMotionKey = sig;
  overlayUi.mapMotion.replaceChildren();
  if (!template) return;

  (template.edits || []).forEach((edit) => {
    const layer = previewEditLayer(edit);
    if (layer) overlayUi.mapMotion.append(layer);
  });
  (template.animations || []).forEach((anim) => {
    const layer = previewAnimLayer(anim);
    if (layer) overlayUi.mapMotion.append(layer);
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

  const mapStill = h("div", {
    class: "picture-still picture-map-still",
    "data-path": "",
  });
  const mapMotion = h("div", {
    class: "picture-motion picture-map-motion",
    "aria-hidden": "true",
  });
  // Map still + transition edits/anims share one plane so fade-zoom keeps them pinned.
  const mapPlane = h(
    "div",
    {
      class: "picture-map-overlay picture-zoom-plane is-hidden",
      style: { opacity: "0" },
    },
    mapStill,
    mapMotion
  );

  const motion = h("div", { class: "picture-motion", "aria-hidden": "true" });

  overlayUi = {
    still,
    map: mapStill,
    mapPlane,
    mapMotion,
    mapMotionKey: null,
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
      mapPlane,
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

function canPlaceTransitionAfter(afterSceneIndex) {
  const list = scenes();
  // before first scene
  if (afterSceneIndex === -1) return list.some((scene) => !scene.is_transition);
  if (afterSceneIndex < 0) return false;
  const prev = list[afterSceneIndex];
  if (!prev || prev.is_transition) return false;
  // mid-gap or after the last scene
  return true;
}

function placeTransitionAfter(transIndex, afterSceneIndex) {
  const list = scenes();
  const source = resolveTransition(list[transIndex]);
  if (!isTransitionTemplate(source)) return;
  if (!source.id) source.id = newTransitionId();
  if (!canPlaceTransitionAfter(afterSceneIndex)) {
    state.placingTransition = null;
    state.note = "Pick a slot before, between, or after scenes";
    render();
    return;
  }
  // Linked variant — same map/timing; own zoom in/out rectangles.
  const tz = normalizeFadeZoomBlock(source);
  const variant = {
    is_transition: true,
    transition_of: source.id,
    fade_zoom: {
      include_start: tz.include_start,
      include_end: tz.include_end,
      start: { ...tz.start },
      end: { ...tz.end },
    },
  };
  let at = afterSceneIndex + 1;
  while (at < list.length && list[at].is_transition) at += 1;
  list.splice(at, 0, variant);
  state.placingTransition = null;
  state.movingScene = null;
  state.editingTransitionVariant = at;
  state.note = `Variant ${transitionVariantNumber(at)} placed — open the transition to set its zoom rects`;
  changed();
}

/** Remove one placement (red ×). Variants unlink; a mid-gap template relocates to the pool if others remain. */
function removeTransitionAt(index) {
  const list = scenes();
  const entry = list[index];
  if (!entry?.is_transition) return;

  if (isTransitionVariant(entry)) {
    list.splice(index, 1);
  } else {
    const id = entry.id;
    const hasVariants = list.some((scene, i) => i !== index && scene.transition_of === id);
    list.splice(index, 1);
    if (hasVariants) list.push(entry);
  }

  if (state.sceneIndex >= list.length) state.sceneIndex = Math.max(0, list.length - 1);
  else if (isTransitionVariant(scenes()[state.sceneIndex])) {
    state.sceneIndex = canonicalizeTransitionSceneIndex(state.sceneIndex);
  }
  state.placingTransition = null;
  state.movingScene = null;
  changed();
}

/** Delete a transition template and every linked variant (pool trash). */
function deleteTransitionTemplate(index) {
  const list = scenes();
  const entry = list[index];
  if (!isTransitionTemplate(entry)) {
    removeTransitionAt(index);
    return;
  }
  const id = entry.id;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const scene = list[i];
    if (!scene?.is_transition) continue;
    if (scene.id === id || scene.transition_of === id) list.splice(i, 1);
  }
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
  const markers = (gap.transitions || []).filter(isTimelineTransition);
  if (placing !== null) {
    if (!canPlaceTransitionAfter(gap.afterIndex)) {
      if (!markers.length) {
        return h("div", { class: "transition-gap-spacer", "aria-hidden": true });
      }
    } else {
      return h("button", {
        class: "transition-drop",
        type: "button",
        title:
          gap.afterIndex < 0
            ? "Add opening variant before the first scene"
            : "Add transition here (visual only — songs stay on the scenes)",
        "aria-label": "Add transition here",
        onClick: () => placeTransitionAfter(placing, gap.afterIndex),
      });
    }
  }

  if (!markers.length) {
    return h("div", { class: "transition-gap-spacer", "aria-hidden": true });
  }

  return h(
    "div",
    { class: "transition-markers" },
    ...markers.map((index) => {
      const entry = scenes()[index];
      const cfg = resolveTransition(entry);
      const title = cfg?.title || "Transition";
      const variant = transitionVariantNumber(index);
      return h(
        "div",
        {
          class: "transition-dot-wrap",
          title: `${title} · variant ${variant} — edit this placement’s zoom in/out`,
        },
        h(
          "button",
          {
            class: "transition-dot",
            type: "button",
            "aria-label": `Open ${title} variant ${variant}`,
            text: String(variant),
            onClick: () => openTransitionVariant(index),
          }
        ),
        h(
          "button",
          {
            class: "transition-dot-x",
            type: "button",
            title: isTransitionVariant(entry)
              ? "Remove this variant"
              : "Remove transition (and all variants)",
            "aria-label": `Remove ${title} variant ${variant}`,
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
        !item.isTransition && outputTag(sceneOutput(index), { showMissing: true })
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

/** Multi-use transition card — open to edit; variants are placed from the scene. */
function transitionCard(index, item) {
  const entry = scenes()[index];
  const selected = state.placingTransition === index;
  const mapHold = transitionTiming(entry).total;
  const known = item.image && !item.missing;
  const variants = transitionPlacementRows(entry).length;
  const open = () => {
    state.placingTransition = null;
    go("scene", { videoId: state.videoId, sceneIndex: index });
  };

  return h(
    "div",
    {
      class: `scene-card is-transition${selected ? " selected" : ""}`,
    },
    h("div", {
      class: `scene-thumb${known ? "" : " blank"}`,
      style: known
        ? { backgroundImage: `url(/thumb?path=${encodeURIComponent(item.image)}&w=360)` }
        : {},
      text: known ? "" : "no image",
      onClick: open,
    }),
    h(
      "div",
      {
        class: "scene-meta",
        onClick: open,
      },
      h("div", { class: "scene-meta-top" }, h("span", { class: "name", text: item.title })),
      h("span", {
        class: "len",
        text:
          variants > 0
            ? `${variants} variant${variants === 1 ? "" : "s"}${
                mapHold > 0 ? ` · ${clock(mapHold)}` : ""
              }`
            : mapHold > 0
              ? `Visual · ${clock(mapHold)}`
              : "Visual overlay",
      })
    ),
    h(
      "button",
      {
        class: "trash",
        type: "button",
        title: variants
          ? "Delete transition and all variants"
          : "Delete transition",
        onClick: (event) => {
          event.stopPropagation();
          if (
            variants > 0 &&
            !confirm(
              variants > 1
                ? `Delete “${item.title}” and its ${variants} variants?`
                : `Delete “${item.title}”?`
            )
          ) {
            return;
          }
          deleteTransitionTemplate(index);
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
    .filter((row) => isTransitionTemplate(row.entry));
  const placing = state.placingTransition;

  return h(
    "section",
    { class: "video-sidebar-section transition-pool" },
    h(
      "div",
      { class: "sequence-head" },
      h("span", { text: "Transitions" }),
      h("span", {
        class: "meta",
        text:
          placing !== null
            ? "Click a red slot between scenes"
            : "Shared map & timing — variants live on the timeline",
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

function uploadIcon() {
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
    h("path", { d: "M8 13.5v-8M5 8l3-3 3 3M3 13.5h10" })
  );
}

function pickImageFile({ accept = "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    input.onchange = () => {
      const file = input.files?.[0] || null;
      input.remove();
      resolve(file);
    };
    input.oncancel = () => {
      input.remove();
      resolve(null);
    };
    document.body.append(input);
    input.click();
  });
}

async function downloadEditRectangle(index) {
  const list = sceneEdits();
  if (index == null || index < 0 || index >= list.length) return;
  const entry = normalizeEdit(list[index]);
  list[index] = entry;
  if (entry.file) {
    const name = baseName(entry.file) || "still";
    const link = document.createElement("a");
    link.href = `/${entry.file}`;
    link.download = /\.[^.]+$/.test(name) ? name : `${name}.png`;
    link.click();
    state.note = "Downloaded still";
    render();
    return;
  }
  await exportEditRegionStill(index, { clipboard: false });
}

function pickVideoFile() {
  return pickImageFile({
    accept: "video/mp4,video/webm,video/quicktime,.mp4,.mov,.webm,.mkv",
  });
}

async function downloadAnimRectangle(index) {
  const list = sceneAnims();
  if (index == null || index < 0 || index >= list.length) return;
  const entry = normalizeAnim(list[index]);
  list[index] = entry;
  // Always the region crop image — slot media is the video, not the download.
  await exportAnimRegionStill(index, { clipboard: false });
}

function clearEditSlotContent(index = state.selectedEdit) {
  const list = sceneEdits();
  if (index == null || index < 0 || index >= list.length) return;
  const entry = normalizeEdit(list[index]);
  list[index] = entry;
  if (!entry.file) {
    state.note = "Slot is already empty";
    render();
    return;
  }
  entry.file = "";
  if (state.stillGen?.editIndex === index) {
    resetStillGen({
      editIndex: index,
      useClaude: state.stillGen.useClaude !== false,
      change: state.stillGen.change || "",
      jarToClaude: state.stillGen.jarToClaude || DEFAULT_JAR_TO_CLAUDE,
      editPrompt: state.stillGen.editPrompt || "",
    });
  }
  state.note = "Cleared still — rectangle kept";
  changed();
}

function clearAnimSlotContent(index = state.selectedAnim) {
  const list = sceneAnims();
  if (index == null || index < 0 || index >= list.length) return;
  const entry = normalizeAnim(list[index]);
  list[index] = entry;
  if (!entry.file) {
    state.note = "Slot is already empty";
    render();
    return;
  }
  entry.file = "";
  if (state.animGen?.animIndex === index) {
    resetAnimGen({
      animIndex: index,
      useClaude: state.animGen.useClaude !== false,
      change: state.animGen.change || "",
      jarToClaude: state.animGen.jarToClaude || DEFAULT_JAR_TO_CLAUDE_VEO,
      veoPrompt: state.animGen.veoPrompt || "",
    });
  }
  state.note = "Cleared animation — rectangle kept";
  changed();
}

function pictureStage(known, image) {
  const expanded = state.pictureExpanded;
  const shortOn = shortCutOpen();
  const regionOn = expanded && state.regionTool && !shortOn;
  const kind = state.regionKind === "still" ? "still" : "animation";
  const canFuse = filledSceneEdits().length > 0;
  const shortRect = shortOn ? shortRectBox() : null;
  return h(
    "div",
    { class: `picture-frame${expanded ? " is-expanded" : ""}${shortOn ? " is-short-cut" : ""}` },
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
    known &&
      h(
        "button",
        {
          class: "picture-clear",
          type: "button",
          title: "Remove this picture",
          "aria-label": "Remove picture",
          onClick: (event) => {
            event.stopPropagation();
            clearSceneImage({ deleteAsset: false });
          },
        },
        "×"
      ),
    known &&
      !expanded &&
      !isTransitionScene() &&
      h(
        "button",
        {
          class: `picture-short${shortOn ? " on" : ""}`,
          type: "button",
          title: shortOn ? "Cancel cut short" : "Cut a 9:16 short from this scene",
          "aria-label": shortOn ? "Cancel cut short" : "Cut short",
          onClick: (event) => {
            event.stopPropagation();
            if (shortOn) closeShortCut();
            else openShortCut();
          },
        },
        shortRectIcon()
      ),
    expanded &&
      known &&
      h(
        "div",
        { class: "picture-region-tools" },
        h(
          "button",
          {
            class: `picture-region${regionOn ? " on" : ""}${kind === "still" ? " picture-edit" : ""}`,
            type: "button",
            title: regionOn
              ? "Cancel region tool"
              : `Draw a 16:9 or 9:16 ${kind === "still" ? "still" : "animation"} region`,
            "aria-label": regionOn ? "Cancel region tool" : "Draw region",
            onClick: (event) => {
              event.stopPropagation();
              state.regionTool = !state.regionTool;
              state.note = state.regionTool
                ? `Draw a ${state.regionAspect === "portrait" ? "9:16" : "16:9"} ${
                    kind === "still" ? "still" : "animation"
                  } region`
                : "";
              render();
            },
          },
          kind === "still" ? editIcon() : regionIcon()
        ),
        regionKindToggle(kind, (next) => {
          state.regionKind = next;
          if (state.regionTool) {
            state.note = `Draw a ${state.regionAspect === "portrait" ? "9:16" : "16:9"} ${
              next === "still" ? "still" : "animation"
            } region`;
          }
          render();
        }),
        regionOn &&
          regionAspectToggle(state.regionAspect, (aspect) => {
            state.regionAspect = aspect;
            state.note = `Draw a ${aspect === "portrait" ? "9:16" : "16:9"} ${
              kind === "still" ? "still" : "animation"
            } region`;
            render();
          }),
        canFuse &&
          h(
            "button",
            {
              class: "picture-region picture-fuse",
              type: "button",
              title: "Fuse filled edits into a downloadable still",
              "aria-label": "Fuse edits",
              onClick: (event) => {
                event.stopPropagation();
                fuseEditsAndDownload();
              },
            },
            h("span", { class: "picture-fuse-label", text: "Fuse" })
          )
      ),
    pictureImagePicker(),
    h(
      "button",
      {
        class: "picture-expand",
        type: "button",
        title: expanded ? "Exit full screen" : "Expand picture",
        "aria-label": expanded ? "Exit full screen" : "Expand picture",
        onClick: (event) => {
          event.stopPropagation();
          state.imagePickerOpen = false;
          state.pictureExpanded = !state.pictureExpanded;
          if (!state.pictureExpanded) state.regionTool = false;
          if (state.pictureExpanded && shortCutOpen()) {
            state.shortCut = null;
            state.note = "";
          }
          render();
        },
      },
      expanded ? collapseIcon() : expandIcon()
    ),
    h(
      "div",
      {
        class: `picture${known ? "" : " blank"}${regionOn ? " region-mode" : ""}${
          regionOn && kind === "still" ? " edit-mode" : ""
        }${shortOn ? " short-cut-mode" : ""}`,
        onPointerdown: (event) => {
          if (
            event.target.closest(
              ".anim-layer, .edit-layer, .fade-zoom-guide, .picture-expand, .picture-image-picker, .picture-download, .picture-clear, .picture-short, .picture-region-tools, .region-capture, .short-rect, .short-shade"
            )
          )
            return;
          if (state.imagePickerOpen) {
            state.imagePickerOpen = false;
            render();
          }
          if (shortOn) return;
          if (state.selectedAnim !== null || state.selectedEdit !== null) {
            state.selectedAnim = null;
            state.selectedEdit = null;
            render();
          }
        },
      },
      h(
        "div",
        { class: "picture-zoom-plane" },
        known
          ? h("div", {
              class: "picture-still",
              style: {
                backgroundImage: `url(/thumb?path=${encodeURIComponent(image)}&w=${
                  expanded ? 1600 : 1200
                })`,
              },
            })
          : h("span", {
              class: "picture-empty",
              text: "Create a scene above, or pick an image",
            }),
        // Still edits sit under animation overlays — all locked to the map zoom plane.
        ...(!shortOn
          ? sceneEdits().map((entry, index) => editLayer(normalizeEdit(entry), index))
          : []),
        ...(!shortOn
          ? sceneAnims().map((entry, index) => animLayer(normalizeAnim(entry), index))
          : []),
        ...(!shortOn
          ? sceneEffects()
              .map((entry) => normalizeEffect(entry))
              .filter((entry) => state.assets.effects.some((effect) => effect.path === entry.file))
              .map((entry) => effectLayer(entry.file, entry.speed))
          : [])
      ),
      shortOn &&
        shortRect &&
        h("div", {
          class: "short-shade short-shade-left",
          style: { width: `${shortRect.x * 100}%` },
        }),
      shortOn &&
        shortRect &&
        h("div", {
          class: "short-shade short-shade-right",
          style: {
            left: `${(shortRect.x + shortRect.w) * 100}%`,
            width: `${(1 - shortRect.x - shortRect.w) * 100}%`,
          },
        }),
      shortOn &&
        shortRect &&
        h(
          "div",
          {
            class: "short-rect",
            style: {
              left: `${shortRect.x * 100}%`,
              width: `${shortRect.w * 100}%`,
            },
            title: "Drag left or right",
            onPointerdown: beginShortRectDrag,
          },
          h("span", { class: "short-rect-label", text: "9:16" })
        ),
      isTransitionScene() &&
        transitionStyleOf(scene()) === "fade_zoom" &&
        fadeZoomGuide("start"),
      isTransitionScene() &&
        transitionStyleOf(scene()) === "fade_zoom" &&
        fadeZoomGuide("end"),
      regionOn &&
        h("div", {
          class: "region-capture",
          title:
            kind === "still"
              ? "Drag to draw a still region"
              : "Drag to draw an animation region",
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
  if (
    state.selectedOverlay !== kind ||
    state.selectedAnim !== null ||
    state.selectedEdit !== null
  ) {
    state.selectedOverlay = kind;
    state.selectedAnim = null;
    state.selectedEdit = null;
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
  const cfg = transition ? resolveTransition(current) : current;
  const { list } = sceneSequence(state.sceneIndex);
  const total = scenePlayTotal(state.sceneIndex);
  const image = cfg?.image || "";
  const known = image && imageExists(image);
  const bar = playerBar(total, "scene");
  const { node: listNode, rows } = transition
    ? { node: null, rows: [] }
    : playlist(list);
  if (scrubber) scrubber.rows = rows;
  const timing = transition ? transitionTiming(editingTransitionPlacement()) : null;
  const mapHold = timing?.total || 0;

  app.classList.toggle("is-expanded", state.pictureExpanded);
  app.classList.remove("is-edit-split");

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
                  delete current.transition_of;
                  if (!current.id) current.id = newTransitionId();
                  current.tracks = [];
                  current.transition_in = current.transition_in || "fade_zoom";
                  current.transition_out = current.transition_out || current.transition_in || "fade_zoom";
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
          )
        ),
        sceneDetails(),
        sceneCreatePanel(),
        pictureStage(known, image),
        shortCutPanel(),
        (sceneAnims().length > 0 || sceneEdits().length > 0) &&
          !shortCutOpen() &&
          h("p", {
            class: "anim-lock-note",
            text: "Still — describe a change to regenerate the crop. Animation — describe what moves, then Generate with Veo.",
          }),
        !shortCutOpen() && regionControlsDial(),
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
                      ? timing.mode === "open"
                        ? `Opens ${clock(timing.inHold)}`
                        : timing.mode === "close"
                          ? `Closes ${clock(timing.outHold)}`
                          : `${clock(timing.outHold)} before · ${clock(timing.inHold)} after`
                      : "—",
                })
              ),
              (() => {
                if (!current.id) current.id = newTransitionId();
                const rows = transitionPlacementRows(current);
                const active = editingTransitionPlacementIndex();
                const zoomStyle = transitionStyleOf(current) === "fade_zoom";
                const settingsOpen = state.transitionSettingsOpen;
                const styleLabel =
                  TRANSITION_FX.find((fx) => fx.id === transitionStyleOf(current))?.label ||
                  "Fade";
                return [
                  h(
                    "div",
                    {
                      class: `transition-settings${settingsOpen ? " is-open" : ""}`,
                    },
                    h(
                      "button",
                      {
                        class: "details-toggle transition-settings-toggle",
                        type: "button",
                        "aria-expanded": settingsOpen ? "true" : "false",
                        onClick: () => {
                          state.transitionSettingsOpen = !state.transitionSettingsOpen;
                          render();
                        },
                      },
                      h(
                        "span",
                        { class: "details-toggle-label" },
                        h("span", {
                          class: "details-chevron",
                          "aria-hidden": true,
                          text: settingsOpen ? "▾" : "▸",
                        }),
                        h("span", { text: "Settings" })
                      ),
                      h("span", {
                        class: "meta",
                        text: `${styleLabel} · Map ${timing.map}s · Fade ${transitionFadeSeconds(current)}s${
                          zoomStyle ? ` · Zoom ${transitionZoomDurationSeconds(current)}s` : ""
                        }`,
                      })
                    ),
                    settingsOpen &&
                      h(
                        "div",
                        { class: "transition-settings-body" },
                        h("p", {
                          class: "meta transition-note",
                          text: zoomStyle
                            ? "Shared map + timing. Each variant has its own Start/End zoom rects."
                            : "Shared map + timing. Fade style — no zoom rects.",
                        }),
                        h(
                          "div",
                          { class: "transition-fx-row" },
                          transitionFxSelect(transitionStyleOf(current), (next) => {
                            current.transition_in = next;
                            current.transition_out = next;
                            if (next === "fade_zoom") normalizeFadeZoomBlock(current);
                            changed();
                          }, "Style")
                        ),
                        transitionDurationFields(current)
                      )
                  ),
                  h(
                    "div",
                    { class: "transition-variants" },
                    h(
                      "div",
                      { class: "sequence-head transition-variants-head" },
                      h("span", { text: "Variants" }),
                      addTransitionVariantButton(current)
                    ),
                    rows.length
                      ? h(
                          "ul",
                          { class: "transition-bridge-list" },
                          ...rows.map((row) => {
                            const from = row.prev?.title || "Start";
                            const to = row.next?.title || "End";
                            const label = row.open
                              ? `Opening → ${to}`
                              : row.close
                                ? `${from} → End`
                                : `${from} → ${to}`;
                            const selected = row.index === active;
                            const rowTiming = transitionTiming(scenes()[row.index], row.index);
                            return h(
                              "li",
                              {
                                class: selected ? "is-selected" : "",
                                onClick: () => {
                                  state.editingTransitionVariant = row.index;
                                  render();
                                },
                              },
                              h(
                                "span",
                                { class: "transition-variant-label" },
                                h("span", {
                                  class: "transition-variant-num",
                                  text: String(row.variant),
                                }),
                                " ",
                                label
                              ),
                              zoomStyle && variantZoomIncludes(row.index),
                              h("span", {
                                class: "len",
                                text: rowTiming.total > 0 ? clock(rowTiming.total) : "—",
                              })
                            );
                          })
                        )
                      : h("p", {
                          class: "meta transition-note",
                          text: "No variants yet — Add variant, then click a red slot on the video page.",
                        }),
                    zoomStyle &&
                      rows.length > 0 &&
                      h("p", {
                        class: "meta transition-note",
                        text: "Toggle Start / End on a variant, then drag its rects on the map.",
                      })
                  ),
                ];
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
  if (kind === "images") return (editOwnerScene()?.image || scene().image) === path;
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

function pictureImagePicker() {
  const open = !!state.imagePickerOpen;
  const images = libraryImages();
  const current = editOwnerScene()?.image || scene()?.image || "";
  const input = h("input", {
    class: "file-input",
    type: "file",
    accept: "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp",
    multiple: true,
    onChange: async (event) => {
      const files = [...(event.target.files || [])];
      event.target.value = "";
      for (const file of files) await uploadAsset("images", file);
      state.imagePickerOpen = true;
      render();
    },
  });
  return h(
    "div",
    { class: `picture-image-picker${open ? " is-open" : ""}` },
    h(
      "button",
      {
        class: "picture-pick",
        type: "button",
        title: open ? "Close image picker" : "Pick an image",
        "aria-label": open ? "Close image picker" : "Pick an image",
        "aria-expanded": open ? "true" : "false",
        onClick: (event) => {
          event.stopPropagation();
          state.imagePickerOpen = !open;
          render();
        },
      },
      pictureIcon(),
      h("span", { class: "picture-pick-caret", "aria-hidden": true, text: open ? "▴" : "▾" })
    ),
    open &&
      h(
        "div",
        {
          class: "picture-image-menu",
          onClick: (event) => event.stopPropagation(),
          onPointerdown: (event) => event.stopPropagation(),
        },
        h(
          "div",
          { class: "picture-image-menu-head" },
          h("span", { text: "Images" }),
          h(
            "button",
            {
              class: "group-icon",
              type: "button",
              title: "Upload images",
              onClick: () => input.click(),
            },
            plusIcon()
          ),
          input
        ),
        images.length
          ? h(
              "div",
              { class: "picture-image-grid" },
              ...images.map((item) =>
                h("button", {
                  class: `picture-image-option${item.path === current ? " on" : ""}`,
                  type: "button",
                  title: item.name,
                  style: {
                    backgroundImage: `url(/thumb?path=${encodeURIComponent(item.path)}&w=160)`,
                  },
                  onClick: () => {
                    pickImageForScene(item.path);
                    state.imagePickerOpen = false;
                    render();
                  },
                })
              )
            )
          : h("p", { class: "empty-note", text: "No pictures yet" })
      )
  );
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

function fillAnimSlot(path, { replace = false } = {}) {
  const list = sceneAnims();
  if (!replace && sceneHasAnim(path)) return false;
  let index = state.selectedAnim;
  if (
    index === null ||
    index < 0 ||
    index >= list.length ||
    (!replace && !isPendingAnim(list[index]))
  ) {
    index = list.findIndex((entry) => isPendingAnim(entry));
  }
  if (index < 0 && replace && state.selectedAnim != null) {
    index = state.selectedAnim;
  }
  if (index < 0 || index >= list.length) return false;
  const slot = normalizeAnim(list[index]);
  slot.file = path;
  slot.locked = true;
  list[index] = slot;
  state.selectedAnim = index;
  state.selectedEdit = null;
  state.regionKind = "animation";
  state.note = "Animation snapped into the region";
  changed();
  return true;
}

function fillEditSlot(path, { replace = false } = {}) {
  if (!path) return false;
  const list = sceneEdits();
  let index = state.selectedEdit;
  if (index === null || index < 0 || index >= list.length) {
    index = list.findIndex((entry) => isPendingEdit(entry));
  } else if (!replace && !isPendingEdit(list[index])) {
    index = list.findIndex((entry) => isPendingEdit(entry));
  }
  if (index < 0) return false;
  const slot = normalizeEdit(list[index]);
  slot.file = path;
  slot.locked = true;
  list[index] = slot;
  state.selectedEdit = index;
  state.selectedAnim = null;
  state.regionKind = "still";
  state.note = "Edited still locked into the region";
  changed();
  return true;
}

function pickImageForScene(path) {
  if (
    state.selectedEdit !== null &&
    state.selectedEdit >= 0 &&
    state.selectedEdit < sceneEdits().length
  ) {
    if (fillEditSlot(path, { replace: true })) return;
  }
  editOwnerScene().image = path;
  changed();
}

function toggleSceneAnim(path, on) {
  const list = sceneAnims();
  if (on) {
    if (sceneHasAnim(path)) return;
    if (fillAnimSlot(path)) return;
    list.push(normalizeAnim(path));
    state.selectedAnim = list.length - 1;
    state.selectedEdit = null;
    state.regionKind = "animation";
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
    const on = (editOwnerScene()?.image || scene().image) === item.path;
    const editTarget =
      state.selectedEdit !== null &&
      state.selectedEdit < sceneEdits().length &&
      (isPendingEdit(sceneEdits()[state.selectedEdit]) ||
        !!normalizeEdit(sceneEdits()[state.selectedEdit]).file);
    return h(
      "div",
      { class: `media-row${on ? " current" : ""}${pruning ? " pruning" : ""}` },
      h("input", {
        class: "media-pick",
        type: "radio",
        name: "scene-image",
        checked: on,
        disabled: pruning || renaming,
        title: editTarget ? "Place into the selected edit slot" : "Use this picture",
        onChange: () => pickImageForScene(item.path),
      }),
      h("span", {
        class: "media-thumb",
        title: editTarget ? "Place into the selected edit slot" : item.path,
        style: { backgroundImage: `url(/thumb?path=${encodeURIComponent(item.path)}&w=120)` },
        onClick: () => {
          if (pruning || renaming) return;
          pickImageForScene(item.path);
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
    if (Array.isArray(entry.edits)) entry.edits = entry.edits.map(rewriteEntry);
    if (Array.isArray(entry.effects)) entry.effects = entry.effects.map(rewriteEntry);
  }
}

function selectUploadedForScene(kind, path) {
  if (!path || state.page !== "scene") return false;
  if (kind === "images") {
    pickImageForScene(path);
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
    if ((editOwnerScene()?.image || scene().image) === path) {
      editOwnerScene().image =
        libraryImages().find((image) => image.path !== path)?.path || "";
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

      const beforeEdits = (entry.edits || []).length;
      entry.edits = (entry.edits || []).filter((edit) => {
        const file = typeof edit === "string" ? edit : edit?.file;
        return file !== path;
      });
      if ((entry.edits || []).length !== beforeEdits) dirty = true;
    }

    if (state.selectedAnim !== null && state.selectedAnim >= sceneAnims().length) {
      state.selectedAnim = null;
    }
    if (state.selectedEdit !== null && state.selectedEdit >= sceneEdits().length) {
      state.selectedEdit = null;
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
  if (
    state.selectedAnim === index &&
    state.selectedOverlay === null &&
    state.selectedEdit === null
  )
    return;
  state.selectedAnim = index;
  state.selectedEdit = null;
  state.selectedOverlay = null;
  state.regionKind = "animation";
  render();
}

function animCanDrag(entry) {
  // Lock only freezes empty slots after Copy still. Filled clips stay movable.
  if (entry?.file) return true;
  return !entry?.locked;
}

function animChrome(index, entry) {
  const selected = state.selectedAnim === index;
  const canDrag = animCanDrag(entry);
  const hasMedia = !!entry.file;
  return [
    selected &&
      h(
        "button",
        {
          class: "anim-copy",
          type: "button",
          title: "Download the crop image from this rectangle",
          onClick: (event) => {
            event.stopPropagation();
            downloadAnimRectangle(index);
          },
        },
        downloadIcon()
      ),
    selected &&
      h(
        "button",
        {
          class: "anim-copy anim-upload",
          type: "button",
          title: "Upload an MP4 into this rectangle",
          onClick: async (event) => {
            event.stopPropagation();
            const file = await pickVideoFile();
            if (file) await uploadAnimVideo(file, index);
          },
        },
        uploadIcon()
      ),
    selected &&
      hasMedia &&
      h(
        "button",
        {
          class: "anim-copy anim-clear",
          type: "button",
          title: "Clear animation — keep rectangle",
          "aria-label": "Clear animation",
          onClick: (event) => {
            event.stopPropagation();
            clearAnimSlotContent(index);
          },
        },
        trashIcon()
      ),
    selected && h("div", { class: "anim-mark", "aria-hidden": "true" }),
    selected &&
      h("button", {
        class: "anim-remove",
        type: "button",
        title: "Remove rectangle",
        text: "×",
        onClick: (event) => {
          event.stopPropagation();
          sceneAnims().splice(index, 1);
          state.selectedAnim = null;
          if (state.animGen?.animIndex === index) resetAnimGen();
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
  if (
    event.target.closest(
      ".anim-handle, .anim-remove, .anim-copy, .anim-upload, .anim-clear, .anim-mark"
    )
  )
    return;
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
        title: canDrag
          ? "Drag to move, or Copy still to lock"
          : "Locked — Unlock below to move, or click to select",
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
      title: canDrag
        ? "Drag to move or resize"
        : "Locked — Unlock in the bar below to move, or click to select",
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

function selectEdit(index) {
  if (
    state.selectedEdit === index &&
    state.selectedOverlay === null &&
    state.selectedAnim === null
  )
    return;
  state.selectedEdit = index;
  state.selectedAnim = null;
  state.selectedOverlay = null;
  state.regionKind = "still";
  render();
}

function editCanDrag(entry) {
  // Lock only freezes empty slots after Copy still. Filled stills stay movable.
  if (entry?.file) return true;
  return !entry?.locked;
}

function editChrome(index, entry) {
  const selected = state.selectedEdit === index;
  const hasMedia = !!entry.file;
  return [
    selected &&
      h(
        "button",
        {
          class: "anim-copy",
          type: "button",
          title: entry.file
            ? "Download this still"
            : "Download crop from this rectangle",
          onClick: (event) => {
            event.stopPropagation();
            downloadEditRectangle(index);
          },
        },
        downloadIcon()
      ),
    selected &&
      h(
        "button",
        {
          class: "anim-copy anim-upload",
          type: "button",
          title: "Upload a photo into this rectangle",
          onClick: async (event) => {
            event.stopPropagation();
            const file = await pickImageFile();
            if (file) await uploadEditStill(file, index);
          },
        },
        uploadIcon()
      ),
    selected &&
      hasMedia &&
      h(
        "button",
        {
          class: "anim-copy anim-clear",
          type: "button",
          title: "Clear still — keep rectangle",
          "aria-label": "Clear still",
          onClick: (event) => {
            event.stopPropagation();
            clearEditSlotContent(index);
          },
        },
        trashIcon()
      ),
    selected && h("div", { class: "anim-mark", "aria-hidden": true }),
    selected &&
      h("button", {
        class: "anim-remove",
        type: "button",
        title: "Remove rectangle",
        text: "×",
        onClick: (event) => {
          event.stopPropagation();
          sceneEdits().splice(index, 1);
          state.selectedEdit = null;
          if (state.stillGen?.editIndex === index) {
            resetStillGen();
          }
          changed();
        },
      }),
  ];
}

function editLayerPointer(event, index, entry) {
  if (
    event.target.closest(
      ".anim-handle, .anim-remove, .anim-copy, .anim-upload, .anim-clear, .anim-mark"
    )
  )
    return;
  if (!editCanDrag(entry)) {
    event.stopPropagation();
    selectEdit(index);
    return;
  }
  beginEditMove(event, index);
}

function editLayer(entry, index) {
  const normalized = normalizeEdit(entry);
  sceneEdits()[index] = normalized;
  const selected = state.selectedEdit === index;
  const pending = !normalized.file;
  const soft = normalized.soft_edges ? " soft-edges" : "";

  if (pending) {
    return h(
      "div",
      {
        class: `edit-layer anim-layer is-pending is-edit${selected ? " selected" : ""} is-locked`,
        style: animLayerStyle(normalized),
        title: "Describe the change below — Claude + ChatGPT will fill this still",
        onPointerdown: (event) => {
          event.stopPropagation();
          selectEdit(index);
        },
      },
      h("div", { class: "anim-pending-fill", "aria-hidden": "true" }),
      h("span", { class: "anim-pending-label", text: "Edit" }),
      ...editChrome(index, normalized)
    );
  }

  return h(
    "div",
    {
      class: `edit-layer anim-layer is-edit aspect-${normalized.aspect || "landscape"}${
        selected ? " selected" : ""
      }`,
      style: animLayerStyle(normalized),
      title: "Still edit",
      onPointerdown: (event) => {
        if (event.target.closest(".anim-remove, .anim-mark")) return;
        event.stopPropagation();
        selectEdit(index);
      },
    },
    h("img", {
      class: `edit-still${soft}`,
      src: `/${normalized.file}`,
      alt: "",
      draggable: false,
    }),
    ...editChrome(index, normalized)
  );
}

function stillSlotDial(entry, index) {
  const gen = state.stillGen || {};
  const forThis = gen.editIndex == null || gen.editIndex === index;
  const busy = forThis && (gen.status === "prompting" || gen.status === "imaging");
  const change = forThis ? gen.change || "" : "";
  // Keep the except-clause live from the change box (manual jar edits are overwritten on type).
  const jarToClaude = composeJarToClaude(change);
  const editPrompt = forThis ? gen.editPrompt || "" : "";
  const useClaude = forThis ? gen.useClaude !== false : true;
  const promptDone = forThis && !!gen.promptDone;
  const imageDone = forThis && !!gen.imageDone;
  const prompting = forThis && gen.status === "prompting";
  const imaging = forThis && gen.status === "imaging";
  const error = forThis ? gen.error || "" : "";

  const patchStillGen = (patch, { redraw = true } = {}) => {
    state.stillGen = {
      change: "",
      jarToClaude: DEFAULT_JAR_TO_CLAUDE,
      status: "idle",
      editPrompt: "",
      useClaude: true,
      promptDone: false,
      imageDone: false,
      error: "",
      ...(state.stillGen || {}),
      editIndex: index,
      ...patch,
    };
    if (redraw) render();
  };

  return [
    h("div", { class: "still-gen" },
      stillGenStatusBar({
        useClaude,
        busy,
        prompting,
        imaging,
        promptDone,
        imageDone,
        promptLabel: "Generate edit prompt",
        imageLabel: "Generate new image",
        onToggleClaude: () => {
          patchStillGen({ useClaude: !useClaude });
        },
      }),
      h("p", {
        class: "still-gen-label",
        text: "What would you like to change?",
      }),
      h("textarea", {
        class: "brief-input still-gen-change",
        rows: 3,
        value: change,
        placeholder: "e.g. add a steaming mug on the table",
        disabled: busy,
        onInput: (event) => {
          const next = event.target.value;
          const jar = composeJarToClaude(next);
          patchStillGen({ change: next, jarToClaude: jar, error: "" }, { redraw: false });
          const root = event.target.closest(".still-gen");
          const jarEl = root?.querySelector(".still-gen-jar");
          if (jarEl) jarEl.value = jar;
          const err = root?.querySelector(".still-gen-error");
          if (err) err.remove();
        },
      }),
      stillGenFieldLabel("Wonderjar → Claude", state.models?.anthropic || ""),
      h("textarea", {
        class: "brief-input still-gen-jar",
        rows: 2,
        value: jarToClaude,
        disabled: busy || !useClaude,
        "aria-label": "Wonderjar to Claude prompt",
        onInput: (event) => {
          patchStillGen({ jarToClaude: event.target.value }, { redraw: false });
        },
      }),
      stillGenFieldLabel("Claude → ChatGPT", state.models?.openaiImage || ""),
      h("textarea", {
        class: "brief-input still-gen-claude is-editable",
        rows: 6,
        value: editPrompt,
        disabled: busy,
        "aria-label": "Claude to ChatGPT prompt",
        title: "Editable — paste your own prompt to skip Claude, or let Claude fill this",
        placeholder: "Claude’s ChatGPT prompt will show here — or paste your own…",
        onInput: (event) => {
          patchStillGen({ editPrompt: event.target.value, error: "" }, { redraw: false });
        },
      }),
      h(
        "label",
        { class: `anim-check${entry.soft_edges ? " on" : ""}` },
        h("input", {
          type: "checkbox",
          checked: entry.soft_edges,
          disabled: busy,
          onChange: () => {
            entry.soft_edges = !entry.soft_edges;
            changed();
          },
        }),
        h("span", { text: "Fade edges" })
      ),
      h(
        "div",
        { class: "still-gen-actions" },
        h(
          "button",
          {
            class: "btn ghost",
            type: "button",
            disabled: busy,
            title: entry.file
              ? "Download the still in this rectangle"
              : "Download the crop inside this rectangle",
            onClick: () => downloadEditRectangle(index),
            text: "Download",
          }
        ),
        h(
          "button",
          {
            class: "btn ghost",
            type: "button",
            disabled: busy,
            title: "Upload a photo into this rectangle",
            onClick: async () => {
              const file = await pickImageFile();
              if (file) await uploadEditStill(file, index);
            },
            text: "Upload",
          }
        ),
        entry.file &&
          !busy &&
          h(
            "button",
            {
              class: "btn ghost still-gen-clear",
              type: "button",
              title: "Clear still — keep rectangle",
              "aria-label": "Clear still",
              onClick: () => clearEditSlotContent(index),
            },
            trashIcon()
          ),
        h(
          "button",
          {
            class: "btn primary still-gen-run",
            type: "button",
            disabled: busy,
            onClick: () => {
              const liveChange =
                document.querySelector(".still-gen-change")?.value ??
                state.stillGen?.change ??
                "";
              const liveJar =
                document.querySelector(".still-gen-jar")?.value ??
                state.stillGen?.jarToClaude ??
                DEFAULT_JAR_TO_CLAUDE;
              const livePrompt =
                document.querySelector(".still-gen-claude")?.value ??
                state.stillGen?.editPrompt ??
                "";
              const sendClaude = state.stillGen?.useClaude !== false;
              patchStillGen({
                change: liveChange,
                jarToClaude: liveJar,
                // Clear only when Claude will refill; keep paste when Claude is off.
                editPrompt: sendClaude ? "" : livePrompt,
                useClaude: sendClaude,
                status: "idle",
                error: "",
                promptDone: false,
                imageDone: false,
              });
              runStillEditGenerate(index);
            },
          },
          busy
            ? prompting
              ? "Asking Claude…"
              : "Editing with ChatGPT…"
            : entry.file
              ? "Replace still"
              : "Generate still"
        ),
        editPrompt &&
          !busy &&
          h(
            "button",
            {
              class: "btn ghost still-gen-rerun",
              type: "button",
              title: "Send this crop + Claude → ChatGPT prompt to ChatGPT again",
              onClick: () => runStillImageFromPrompt(index),
            },
            "Regenerate from prompt"
          )
      ),
      error && h("p", { class: "still-gen-error", text: error })
    ),
  ];
}

function animSlotDial(entry, index) {
  const gen = state.animGen || {};
  const forThis = gen.animIndex == null || gen.animIndex === index;
  const busy = forThis && (gen.status === "prompting" || gen.status === "imaging");
  const change = forThis ? gen.change || "" : "";
  const jarToClaude =
    forThis && gen.jarToClaude ? gen.jarToClaude : DEFAULT_JAR_TO_CLAUDE_VEO;
  const veoPrompt = forThis ? gen.veoPrompt || "" : "";
  const useClaude = forThis ? gen.useClaude !== false : true;
  const promptDone = forThis && !!gen.promptDone;
  const imageDone = forThis && !!gen.imageDone;
  const prompting = forThis && gen.status === "prompting";
  const imaging = forThis && gen.status === "imaging";
  const error = forThis ? gen.error || "" : "";

  const patchAnimGen = (patch, { redraw = true } = {}) => {
    state.animGen = {
      change: "",
      jarToClaude: DEFAULT_JAR_TO_CLAUDE_VEO,
      status: "idle",
      veoPrompt: "",
      useClaude: true,
      promptDone: false,
      imageDone: false,
      error: "",
      ...(state.animGen || {}),
      animIndex: index,
      ...patch,
    };
    if (redraw) render();
  };

  return [
    h("div", { class: "still-gen anim-gen" },
      stillGenStatusBar({
        useClaude,
        busy,
        prompting,
        imaging,
        promptDone,
        imageDone,
        claudeLabel: "Generate Veo prompt",
        promptLabel: "Generate Veo prompt",
        imageLabel: "Generate animation",
        onToggleClaude: () => {
          patchAnimGen({ useClaude: !useClaude });
        },
      }),
      h("p", {
        class: "still-gen-label",
        text: "What should move in this region?",
      }),
      h("textarea", {
        class: "brief-input still-gen-change anim-gen-change",
        rows: 3,
        value: change,
        placeholder: "e.g. only the candle flame flickers; everything else stays frozen",
        disabled: busy,
        onInput: (event) => {
          patchAnimGen({ change: event.target.value, error: "" }, { redraw: false });
          const err = event.target.closest(".anim-gen")?.querySelector(".still-gen-error");
          if (err) err.remove();
        },
      }),
      stillGenFieldLabel("Wonderjar → Claude", state.models?.anthropic || ""),
      h("textarea", {
        class: "brief-input still-gen-jar anim-gen-jar",
        rows: 3,
        value: jarToClaude,
        disabled: busy || !useClaude,
        "aria-label": "Wonderjar to Claude Veo prompt",
        onInput: (event) => {
          patchAnimGen({ jarToClaude: event.target.value }, { redraw: false });
        },
      }),
      stillGenFieldLabel("Claude → Veo", state.models?.veo || ""),
      h("textarea", {
        class: "brief-input still-gen-claude anim-gen-claude is-editable",
        rows: 6,
        value: veoPrompt,
        disabled: busy,
        "aria-label": "Claude to Veo prompt",
        title: "Editable — paste your own prompt to skip Claude, or let Claude fill this",
        placeholder: "Claude’s Veo prompt will show here — or paste your own…",
        onInput: (event) => {
          patchAnimGen({ veoPrompt: event.target.value, error: "" }, { redraw: false });
        },
      }),
      h(
        "label",
        { class: `anim-check${entry.soft_edges ? " on" : ""}` },
        h("input", {
          type: "checkbox",
          checked: entry.soft_edges,
          disabled: busy,
          onChange: () => {
            entry.soft_edges = !entry.soft_edges;
            changed();
          },
        }),
        h("span", { text: "Fade edges" })
      ),
      h(
        "div",
        { class: "still-gen-actions" },
        h(
          "button",
          {
            class: "btn ghost",
            type: "button",
            disabled: busy,
            title: "Download the crop image from this rectangle",
            onClick: () => downloadAnimRectangle(index),
            text: "Download",
          }
        ),
        h(
          "button",
          {
            class: "btn ghost",
            type: "button",
            disabled: busy,
            title: "Upload an MP4 into this rectangle",
            onClick: async () => {
              const file = await pickVideoFile();
              if (file) await uploadAnimVideo(file, index);
            },
            text: "Upload",
          }
        ),
        entry.file &&
          !busy &&
          h(
            "button",
            {
              class: "btn ghost still-gen-clear",
              type: "button",
              title: "Clear animation — keep rectangle",
              "aria-label": "Clear animation",
              onClick: () => clearAnimSlotContent(index),
            },
            trashIcon()
          ),
        h(
          "button",
          {
            class: "btn primary still-gen-run",
            type: "button",
            disabled: busy,
            onClick: () => {
              const liveChange =
                document.querySelector(".anim-gen-change")?.value ||
                state.animGen?.change ||
                "";
              const liveJar =
                document.querySelector(".anim-gen-jar")?.value ||
                state.animGen?.jarToClaude ||
                DEFAULT_JAR_TO_CLAUDE_VEO;
              const livePrompt =
                document.querySelector(".anim-gen-claude")?.value ||
                state.animGen?.veoPrompt ||
                "";
              const sendClaude = state.animGen?.useClaude !== false;
              // Keep the pasted Veo prompt in state; skip a full redraw so we
              // don't race the generate call against a replaced textarea.
              state.animGen = {
                ...(state.animGen || {}),
                change: liveChange,
                jarToClaude: liveJar,
                veoPrompt: livePrompt,
                useClaude: sendClaude,
                animIndex: index,
                status: "idle",
                error: "",
                promptDone: false,
                imageDone: false,
              };
              runAnimGenerate(index);
            },
          },
          busy
            ? prompting
              ? "Asking Claude…"
              : "Generating with Veo…"
            : entry.file
              ? "Replace animation"
              : "Generate animation"
        ),
        veoPrompt &&
          !busy &&
          h(
            "button",
            {
              class: "btn ghost still-gen-rerun",
              type: "button",
              title: "Send this crop + Claude → Veo prompt to Veo again",
              onClick: () => runAnimVideoFromPrompt(index),
            },
            "Regenerate from prompt"
          ),
        h(
          "button",
          {
            class: "btn ghost",
            type: "button",
            disabled: busy,
            title: entry.locked
              ? "Copy the still again (slot stays locked)"
              : "Download and copy crop — locks this slot",
            onClick: () => exportAnimRegionStill(index),
            text: entry.locked ? "Copy again" : "Copy still",
          }
        ),
        entry.locked &&
          !busy &&
          h("button", {
            class: "btn ghost",
            type: "button",
            text: "Unlock",
            title: "Unlock so you can drag or resize this slot again",
            onClick: () => {
              entry.locked = false;
              changed();
            },
          })
      ),
      error && h("p", { class: "still-gen-error", text: error })
    ),
  ];
}

function pendingAnimSlotDial(entry, index) {
  return animSlotDial(entry, index);
}

function filledAnimSlotDial(entry, index, { chrome = true } = {}) {
  const setAspect = (next) => {
    entry.aspect = entry.aspect === next ? "native" : next;
    changed();
  };
  return [
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
    chrome &&
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
    chrome &&
      entry.locked &&
      h("button", {
        class: "btn",
        type: "button",
        text: "Unlock",
        title: "Clear the lock flag (filled clips can already be dragged)",
        onClick: () => {
          entry.locked = false;
          changed();
        },
      }),
    animTrimControl(entry, index),
  ];
}

function regionPanelHead(label, { kind = "still", collapsed = false } = {}) {
  const drag = state.pictureExpanded
    ? kind === "anim"
      ? beginAnimPanelDrag
      : beginStillPanelDrag
    : undefined;
  // Kind (Still/Animation) lives on the picture toolbar — header is drag + collapse only.
  return h(
    "div",
    {
      class: `still-gen-drag${drag ? "" : " no-drag"}`,
      title: drag ? "Drag to move" : collapsed ? "Expand form" : "Collapse form",
      onPointerdown: drag,
    },
    label && h("span", { class: "still-gen-drag-label", text: label }),
    h(
      "div",
      { class: "still-gen-drag-actions" },
      drag && h("span", { class: "still-gen-drag-grip", "aria-hidden": true, text: "⠿" }),
      h(
        "button",
        {
          class: "still-gen-collapse",
          type: "button",
          title: collapsed ? "Expand form" : "Collapse form",
          "aria-label": collapsed ? "Expand form" : "Collapse form",
          "aria-expanded": collapsed ? "false" : "true",
          onPointerdown: (event) => event.stopPropagation(),
          onClick: (event) => {
            event.stopPropagation();
            if (kind === "anim") {
              state.animGen = {
                ...(state.animGen || {}),
                animIndex: state.selectedAnim,
                collapsed: !collapsed,
              };
            } else {
              state.stillGen = {
                ...(state.stillGen || {}),
                editIndex: state.selectedEdit,
                collapsed: !collapsed,
              };
            }
            render();
          },
          text: collapsed ? "▸" : "▾",
        }
      )
    )
  );
}

function regionCollapsedMeta(gen, { imagingLabel = "Working…" } = {}) {
  return h("p", {
    class: "still-gen-collapsed-meta muted",
    text:
      gen?.status === "prompting"
        ? "Asking Claude…"
        : gen?.status === "imaging"
          ? imagingLabel
          : String(gen?.change || "").trim() || "Collapsed — expand to edit",
  });
}

function regionControlsDial() {
  if (state.selectedEdit !== null) {
    const list = sceneEdits();
    if (state.selectedEdit >= list.length) return null;
    const entry = normalizeEdit(list[state.selectedEdit]);
    list[state.selectedEdit] = entry;
    const gen = state.stillGen || {};
    const collapsed = !!gen.collapsed;
    const moved =
      state.pictureExpanded &&
      Number.isFinite(gen.panelX) &&
      Number.isFinite(gen.panelY);
    return h(
      "div",
      {
        class: `anim-dials pending-hint edit-dials${moved ? " is-moved" : ""}${
          collapsed ? " is-collapsed" : ""
        }`,
        style: moved
          ? {
              left: `${gen.panelX}px`,
              top: `${gen.panelY}px`,
              right: "auto",
              bottom: "auto",
              transform: "none",
            }
          : {},
      },
      regionPanelHead("", { kind: "still", collapsed }),
      ...(collapsed
        ? [regionCollapsedMeta(gen, { imagingLabel: "Editing with ChatGPT…" })]
        : stillSlotDial(entry, state.selectedEdit))
    );
  }
  if (state.selectedAnim === null) return null;
  const list = sceneAnims();
  if (state.selectedAnim >= list.length) return null;
  const entry = normalizeAnim(list[state.selectedAnim]);
  list[state.selectedAnim] = entry;
  const gen = state.animGen || {};
  const collapsed = !!gen.collapsed;
  const moved =
    state.pictureExpanded &&
    Number.isFinite(gen.panelX) &&
    Number.isFinite(gen.panelY);
  const panelClass = `anim-dials pending-hint edit-dials${moved ? " is-moved" : ""}${
    collapsed ? " is-collapsed" : ""
  }`;
  const panelStyle = moved
    ? {
        left: `${gen.panelX}px`,
        top: `${gen.panelY}px`,
        right: "auto",
        bottom: "auto",
        transform: "none",
      }
    : {};
  const collapsedBits = [
    regionCollapsedMeta(gen, { imagingLabel: "Generating with Veo…" }),
  ];
  if (!entry.file) {
    return h(
      "div",
      { class: panelClass, style: panelStyle },
      regionPanelHead("", { kind: "anim", collapsed }),
      ...(collapsed ? collapsedBits : pendingAnimSlotDial(entry, state.selectedAnim))
    );
  }
  return h(
    "div",
    {
      class: state.pictureExpanded
        ? panelClass
        : `anim-dials pending-hint edit-dials${collapsed ? " is-collapsed" : ""}`,
      style: state.pictureExpanded ? panelStyle : {},
    },
    regionPanelHead("", { kind: "anim", collapsed }),
    ...(collapsed
      ? collapsedBits
      : [
          ...animSlotDial(entry, state.selectedAnim),
          ...filledAnimSlotDial(entry, state.selectedAnim, { chrome: false }),
        ])
  );
}

async function uploadEditStill(file, index = state.selectedEdit) {
  if (!file || index == null) return;
  state.selectedEdit = index;
  state.note = `Uploading ${file.name}…`;
  render();
  try {
    const owner = editOwnerScene();
    const stem = (owner?.image ? baseName(owner.image) : "edit") || "edit";
    const ext = (file.name.match(/\.[^.]+$/) || [".png"])[0].toLowerCase();
    const name = `${stem}-edit-${Date.now()}${ext}`;
    const response = await fetch(
      `/api/asset?kind=${encodeURIComponent("images")}&name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      }
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Upload failed");
    await refreshOutputs();
    if (!fillEditSlot(data.path, { replace: true })) {
      state.note = "Uploaded, but no edit slot was selected";
      render();
    }
  } catch (error) {
    state.note = error.message || "Upload failed";
    render();
  }
}

async function uploadAnimVideo(file, index = state.selectedAnim) {
  if (!file || index == null) return;
  state.selectedAnim = index;
  state.selectedEdit = null;
  state.regionKind = "animation";
  state.note = `Uploading ${file.name}…`;
  render();
  try {
    const owner = editOwnerScene();
    const stem = (owner?.image ? baseName(owner.image) : "anim") || "anim";
    const ext = (file.name.match(/\.[^.]+$/) || [".mp4"])[0].toLowerCase();
    const name = `${stem}-anim-${Date.now()}${ext}`;
    const response = await fetch(
      `/api/asset?kind=${encodeURIComponent("animations")}&name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      }
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Upload failed");
    await refreshOutputs();
    if (!fillAnimSlot(data.path, { replace: true })) {
      state.note = "Uploaded, but no animation slot was selected";
      render();
    }
  } catch (error) {
    state.note = error.message || "Upload failed";
    render();
  }
}

async function pasteEditStill(file) {
  if (!file || state.page !== "scene") return false;
  if (state.selectedEdit === null || state.selectedEdit >= sceneEdits().length) {
    const pending = sceneEdits().findIndex((entry) => isPendingEdit(entry));
    if (pending < 0) return false;
    state.selectedEdit = pending;
  }
  await uploadEditStill(file, state.selectedEdit);
  return true;
}

function beginEditMove(event, index) {
  event.preventDefault();
  event.stopPropagation();
  const picture = event.currentTarget.closest(".picture");
  const layer = event.currentTarget;
  const entry = normalizeEdit(sceneEdits()[index]);
  sceneEdits()[index] = entry;
  if (!editCanDrag(entry)) {
    selectEdit(index);
    return;
  }
  if (state.selectedEdit !== index || state.selectedAnim !== null) {
    state.selectedEdit = index;
    state.selectedAnim = null;
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
    state.selectedEdit = index;
    changed();
  };
  layer.addEventListener("pointermove", move);
  layer.addEventListener("pointerup", up);
  layer.addEventListener("pointercancel", up);
}

function beginEditResize(event, index) {
  event.preventDefault();
  event.stopPropagation();
  const handle = event.currentTarget;
  const layer = handle.closest(".edit-layer");
  const picture = layer.closest(".picture");
  const entry = normalizeEdit(sceneEdits()[index]);
  sceneEdits()[index] = entry;
  if (!editCanDrag(entry)) return;
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
    state.selectedEdit = index;
    changed();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
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
  if (
    state.selectedAnim !== index ||
    state.selectedOverlay !== null ||
    state.selectedEdit !== null
  ) {
    state.selectedAnim = index;
    state.selectedEdit = null;
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

/** Transition windows on the video timeline (overlay neighbors around each cut). */
function videoTransitionEvents(total) {
  if (!(total > 0)) return [];
  const { items } = cachedVideoTimeline();
  const list = scenes();
  const events = [];
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index];
    if (!isTimelineTransition(index)) continue;
    let prevItem = null;
    let nextItem = null;
    for (let j = index - 1; j >= 0; j -= 1) {
      if (!list[j].is_transition && items[j]?.duration > 0) {
        prevItem = items[j];
        break;
      }
    }
    for (let j = index + 1; j < list.length; j += 1) {
      if (!list[j].is_transition && items[j]?.duration > 0) {
        nextItem = items[j];
        break;
      }
    }
    const cfg = resolveTransition(entry);
    const timing = transitionTiming(entry, index);
    if (!(timing.total > 0.05)) continue;
    const variant = transitionVariantNumber(index);
    let cut;
    let from;
    let to;
    if (timing.mode === "open" && nextItem) {
      cut = nextItem.start;
      from = nextItem.start;
      to = Math.min(total, nextItem.start + timing.inHold);
    } else if (timing.mode === "close" && prevItem) {
      cut = prevItem.start + prevItem.duration;
      from = Math.max(0, cut - timing.outHold);
      to = cut;
    } else if (prevItem && nextItem) {
      cut = prevItem.start + prevItem.duration;
      from = Math.max(0, cut - timing.outHold);
      to = Math.min(total, cut + timing.inHold);
    } else {
      continue;
    }
    events.push({
      index,
      title: `${cfg.title || "Transition"} · ${variant}`,
      cut,
      from,
      to,
      leftPct: (from / total) * 100,
      widthPct: (Math.max(to - from, 0) / total) * 100,
      cutPct: (cut / total) * 100,
    });
  }
  return events;
}

function playerBar(total, mode) {
  const fill = h("div", { class: "fill" });
  const knob = h("div", { class: "knob" });
  const elapsed = h("span", { class: "meta time", text: clock(player.at) });
  const eventMarks = [];
  const children = [h("div", { class: "rail-fill" }, fill)];

  if (mode === "video" && total > 0) {
    videoTransitionEvents(total).forEach((ev) => {
      children.push(
        h("div", {
          class: "rail-event-span is-transition",
          style: {
            left: `${ev.leftPct}%`,
            width: `${Math.max(ev.widthPct, 0.35)}%`,
          },
          title: `${ev.title} · ${clock(ev.from)}–${clock(ev.to)}`,
          "aria-hidden": true,
        })
      );
      const mark = h("button", {
        type: "button",
        class: "rail-event is-transition",
        style: { left: `${ev.cutPct}%` },
        title: `${ev.title} — jump to transition (${clock(ev.from)})`,
        "aria-label": `${ev.title} at ${clock(ev.cut)}`,
        "data-from": String(ev.from),
        "data-to": String(ev.to),
        onPointerdown: (event) => {
          event.preventDefault();
          event.stopPropagation();
          seekTo(ev.from);
        },
      });
      eventMarks.push(mark);
      children.push(mark);
    });
  }

  const shortRange = h("div", {
    class: "rail-short-range",
    style: { display: shortCutOpen() ? "" : "none" },
    "aria-hidden": true,
  });
  children.push(shortRange);
  children.push(knob);
  const rail = h(
    "div",
    { class: "rail", onPointerdown: (event) => beginScrub(event, rail, total) },
    ...children
  );

  scrubber = {
    fill,
    knob,
    elapsed,
    rows: [],
    cards: [],
    events: eventMarks,
    shortRange,
  };

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
  // Queue progress lives in the bottom-right process panel.
  if (state.processPanel?.open) return null;
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
    if (state.ledger?.open) {
      state.ledger = { ...state.ledger, open: false };
      render();
      return;
    }
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
    if (
      state.selectedAnim !== null ||
      state.selectedEdit !== null ||
      state.selectedOverlay !== null
    ) {
      state.selectedAnim = null;
      state.selectedEdit = null;
      state.selectedOverlay = null;
      render();
      return;
    }
    if (state.page === "scene") go("video", { videoId: state.videoId });
    else if (state.page === "video") {
      if (state.jarId) go("jar", { jarId: state.jarId });
      else go("jars");
    } else if (state.page === "jar") go("jars");
  }
  if (
    event.code === "Space" &&
    !event.target.closest("input, textarea, button, a") &&
    state.page !== "jars" &&
    state.page !== "jar" &&
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

document.addEventListener("paste", async (event) => {
  if (state.page !== "scene") return;
  if (event.target.closest("input, textarea, [contenteditable]")) return;
  const items = event.clipboardData?.items;
  if (!items?.length) return;
  let file = null;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      file = item.getAsFile();
      break;
    }
  }
  if (!file) return;
  const hasEditTarget =
    (state.selectedEdit !== null && state.selectedEdit < sceneEdits().length) ||
    sceneEdits().some((entry) => isPendingEdit(entry));
  if (!hasEditTarget) return;
  event.preventDefault();
  await pasteEditStill(file);
});

applyRoute();
