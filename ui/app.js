// Landing → videos → video → scene. Paths: /, /videos, /video?v=, /scene?v=&s=

const state = {
  page: "landing", // landing | list | video | scene
  videoId: null,
  videos: [],
  script: null,
  assets: { images: [], music: [], effects: [], animations: [] },
  selectedAnim: null,
  outputs: { video: { ready: false }, scenes: {} },
  render: { status: "idle", percent: 0, ready: false },
  sceneIndex: 0,
  saving: false,
  note: "",
  pickerOpen: false,
  movingScene: null, // index of scene waiting to be placed, or null
  pruneImages: false,
  pruneSongs: false,
  pruneAnims: false,
  renamingPath: null,
  pictureExpanded: false,
};

let drag = null;
let saveTimer = null;
let pollTimer = null;

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
  state.selectedAnim = null;
  state.pictureExpanded = false;

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

  state.sceneIndex = Math.min(route.sceneIndex, Math.max(0, scenes().length - 1));
  state.page = route.page;
  render();
}

/* ---------- script model ---------- */

function ensureScript() {
  if (!state.script) return;
  state.script.scenes ||= [];
  state.script.defaults ||= { fade_seconds: 3, track_crossfade: 2, open_close_fade: 2 };
  if (!state.script.scenes.length) state.script.scenes.push(blankScene());
}

function blankScene() {
  return {
    title: `Scene ${((state.script.scenes || []).length || 0) + 1}`,
    image: state.assets.images[0]?.path || "",
    map: { seconds: 0 },
    pan: "none",
    zoom: 1,
    tracks: [],
    effects: [],
    animations: [],
  };
}

const sceneEffects = (index = state.sceneIndex) => (scene(index).effects ||= []);
const sceneAnims = (index = state.sceneIndex) => (scene(index).animations ||= []);

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
    return { file: entry, x: 0.36, y: 0.28, w: 0.28 };
  }
  return {
    file: entry.file || "",
    x: Number.isFinite(entry.x) ? entry.x : 0.36,
    y: Number.isFinite(entry.y) ? entry.y : 0.28,
    w: Number.isFinite(entry.w) ? entry.w : 0.28,
  };
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

function sceneSequence(index) {
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

function videoTimeline() {
  let start = 0;
  const items = scenes().map((entry, index) => {
    const { list, total } = sceneSequence(index);
    const item = {
      index,
      title: entry.title || `Scene ${index + 1}`,
      image: entry.image || "",
      songs: list,
      duration: total,
      start,
      missing: !entry.image || !imageExists(entry.image),
    };
    start += total;
    return item;
  });
  return { items, total: items.reduce((sum, item) => sum + item.duration, 0) };
}

function playScope() {
  if (state.page === "scene") {
    return { mode: "scene", scene: state.sceneIndex, total: sceneSequence(state.sceneIndex).total };
  }
  return { mode: "video", scene: null, total: videoTimeline().total };
}

function audioKey() {
  const scope = playScope();
  if (scope.mode === "scene") {
    return `${state.videoId}|scene:${scope.scene}|${sceneSongs(scope.scene).map(fileOf).join(",")}`;
  }
  return `${state.videoId}|video|${scenes()
    .map((entry) => (entry.tracks || []).map(fileOf).join(","))
    .join("|")}`;
}

/* ---------- player ---------- */

const audio = new Audio();
audio.preload = "none";
const player = { key: null, at: 0, playing: false, loading: false, total: 0 };
let scrubber = null;

function syncSource() {
  if (state.page === "list") return;
  const key = audioKey();
  if (player.key === key) return;
  player.key = key;
  player.at = 0;
  player.playing = false;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
}

async function togglePlay() {
  const scope = playScope();
  if (!scope.total) return;
  if (player.playing) {
    audio.pause();
    return;
  }

  clearTimeout(saveTimer);
  await save();
  syncSource();

  if (!audio.getAttribute("src")) {
    player.loading = true;
    render();
    const params = new URLSearchParams({ v: state.videoId });
    if (scope.mode === "scene") params.set("scene", String(scope.scene));
    audio.src = `/api/audio?${params}`;
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
  if (audio.getAttribute("src") && audio.readyState > 0) audio.currentTime = at;
  paintPlayhead();
}

audio.addEventListener("playing", () => {
  player.playing = true;
  player.loading = false;
  render();
});
audio.addEventListener("pause", () => {
  player.playing = false;
  render();
});
audio.addEventListener("ended", () => {
  player.playing = false;
  player.at = 0;
  render();
});
audio.addEventListener("loadedmetadata", () => {
  if (Number.isFinite(audio.duration)) player.total = audio.duration;
  if (player.at) audio.currentTime = player.at;
});
audio.addEventListener("timeupdate", () => {
  player.at = audio.currentTime;
  paintPlayhead();
});

function paintPlayhead() {
  if (!scrubber) return;
  const scope = playScope();
  const length = player.total || scope.total || 1;
  const fraction = Math.min(player.at / length, 1);
  scrubber.fill.style.width = `${fraction * 100}%`;
  scrubber.knob.style.left = `${fraction * 100}%`;
  scrubber.elapsed.textContent = clock(player.at);

  if (scope.mode === "video") {
    const { items } = videoTimeline();
    let active = -1;
    items.forEach((item, index) => {
      if (player.at >= item.start - 0.001) active = index;
    });
    scrubber.cards?.forEach((card, index) => card.classList.toggle("playing", index === active));
    return;
  }

  const { list } = sceneSequence(state.sceneIndex);
  let songActive = -1;
  list.forEach((song, index) => {
    if (player.at >= song.start - 0.001) songActive = index;
  });
  scrubber.rows?.forEach((row, index) => row.classList.toggle("playing", index === songActive));
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
  const response = await fetch(withVideo("/api/script"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.script),
  });
  state.saving = false;
  state.note = response.ok ? "" : "Could not save";
  render();
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

async function generate(sceneNumber = null) {
  clearTimeout(saveTimer);
  await save();
  const response = await fetch(withVideo("/api/render"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sceneNumber ? { scene: sceneNumber } : {}),
  });
  state.render = await response.json();
  lastRenderStatus = state.render.status;
  render();
  poll();
}

async function stopGenerate() {
  const response = await fetch("/api/render/stop", { method: "POST" });
  state.render = await response.json();
  lastRenderStatus = state.render.status;
  render();
}

function downloadOutput(sceneNumber = null) {
  let url = `/download?v=${encodeURIComponent(state.videoId)}`;
  if (sceneNumber) url += `&scene=${sceneNumber}`;
  window.location.href = url;
}

function poll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    const previous = lastRenderStatus;
    state.render = await (await fetch("/api/render")).json();
    lastRenderStatus = state.render.status;
    if (state.render.status === "done") {
      await refreshOutputs();
      if (previous === "running" && state.render.ready && state.render.video === state.videoId) {
        downloadOutput(state.render.scene || null);
      }
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

function exportActions({ sceneMode = false } = {}) {
  const busy = state.render.status === "running";
  const { total } = videoTimeline();
  const sceneTotal = sceneSequence(state.sceneIndex).total;
  const sceneNumber = state.sceneIndex + 1;

  if (busy) {
    const label =
      state.render.kind === "scene"
        ? `Stop rendering scene ${state.render.percent}%`
        : `Stop rendering ${state.render.percent}%`;
    return [
      h(
        "button",
        {
          class: "btn stop",
          type: "button",
          title: "Stop rendering",
          onClick: () => stopGenerate(),
          text: label,
        }
      ),
    ];
  }

  if (sceneMode) {
    return [
      h(
        "button",
        {
          class: "btn primary",
          disabled: !sceneTotal,
          onClick: () => generate(sceneNumber),
        },
        "Generate scene"
      ),
    ];
  }

  return [
    h(
      "button",
      {
        class: "btn primary",
        disabled: !total,
        onClick: () => generate(),
      },
      "Generate video"
    ),
  ];
}

/* ---------- views ---------- */

const app = document.getElementById("app");

function render() {
  // Don't rebuild the tree while an inline rename field is focused — that
  // steals the caret on every keypress / incidental redraw.
  if (state.renamingPath && document.activeElement?.classList?.contains("name-edit")) {
    return;
  }

  scrubber = null;
  if (state.page !== "list" && state.page !== "landing") {
    ensureScript();
    syncSource();
  }

  app.classList.toggle("shell--landing", state.page === "landing");
  if (state.page !== "scene") {
    state.pictureExpanded = false;
    app.classList.remove("is-expanded");
  }

  if (state.page === "landing") app.replaceChildren(landingView());
  else if (state.page === "list") app.replaceChildren(listView());
  else if (state.page === "scene") app.replaceChildren(sceneView());
  else app.replaceChildren(videoView());

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
                video.outputs?.video?.ready && h("span", { class: "ready-tag", text: "Rendered" })
              )
            )
          : h("p", { class: "empty-note", text: "No videos yet — add a JSON file to videos/" })
      )
    )
  );
}

function videoView() {
  const { items, total } = videoTimeline();
  const bar = playerBar(total, "video");

  return h(
    "div",
    { class: "shell-inner" },
    topbar(exportActions()),
    h(
      "div",
      { class: "video-page" },
      h("h1", { class: "page-title", text: state.script.project || state.videoId }),
      h("p", {
        class: "page-blurb",
        text: "Scenes play one after another. Open a scene to edit it.",
      }),
      bar,
      renderStatus(),
      h(
        "div",
        { class: "sequence-head" },
        h("span", { text: "Scenes" }),
        h("span", { class: "meta", text: clock(total) })
      ),
      sceneStrip(items),
      h(
        "button",
        {
          class: "btn ghost add",
          type: "button",
          onClick: () => {
            scenes().push(blankScene());
            const index = scenes().length - 1;
            changed();
            go("scene", { videoId: state.videoId, sceneIndex: index });
          },
        },
        "+  Add scene"
      )
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
  changed();
}

function sceneSlot(insertAt, fromIndex) {
  // Slots next to the moving card's current edges are no-ops — skip them.
  if (insertAt === fromIndex || insertAt === fromIndex + 1) return null;
  return h("button", {
    class: "scene-slot",
    type: "button",
    title: "Place here",
    "aria-label": "Place scene here",
    onClick: () => placeScene(fromIndex, insertAt),
  });
}

function sceneStrip(items) {
  const moving = state.movingScene;
  const placing = moving !== null;
  const cards = [];
  const scrubCards = [];

  if (placing) cards.push(sceneSlot(0, moving));

  items.forEach((item, index) => {
    const card = h(
      "div",
      {
        class: `scene-card${item.missing ? " missing" : ""}${moving === index ? " moving" : ""}`,
      },
      h(
        "button",
        {
          class: "handle",
          type: "button",
          title: placing && moving === index ? "Cancel move" : "Move scene",
          "aria-label": placing && moving === index ? "Cancel move" : "Move scene",
          onClick: (event) => {
            event.stopPropagation();
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
        onClick: () => {
          if (placing) return;
          go("scene", { videoId: state.videoId, sceneIndex: index });
        },
      }),
      h(
        "div",
        {
          class: "scene-meta",
          onClick: () => {
            if (placing) return;
            go("scene", { videoId: state.videoId, sceneIndex: index });
          },
        },
        h("span", { class: "name", text: item.title }),
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
            if (scenes().length === 1) {
              state.note = "Keep at least one scene";
              render();
              return;
            }
            scenes().splice(index, 1);
            if (state.sceneIndex >= scenes().length) state.sceneIndex = scenes().length - 1;
            state.movingScene = null;
            changed();
          },
        },
        trashIcon()
      )
    );
    scrubCards.push(card);
    cards.push(card);
    if (placing) cards.push(sceneSlot(index + 1, moving));
  });

  if (scrubber) scrubber.cards = scrubCards;

  return h(
    "div",
    { class: `scene-strip${placing ? " is-placing" : ""}` },
    cards.length
      ? cards.filter(Boolean)
      : h("p", { class: "empty-note drop-hint", text: "Add a scene to get started" })
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

function pictureStage(known, image) {
  const expanded = state.pictureExpanded;
  return h(
    "div",
    { class: `picture-frame${expanded ? " is-expanded" : ""}` },
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
          if (event.target.closest(".anim-layer, .picture-expand")) return;
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
      ...sceneAnims().map((entry, index) => animLayer(normalizeAnim(entry), index)),
      // Effects sit above animation overlays.
      ...sceneEffects()
        .map((entry) => normalizeEffect(entry))
        .filter((entry) => state.assets.effects.some((effect) => effect.path === entry.file))
        .map((entry) => effectLayer(entry.file, entry.speed))
    )
  );
}

function effectLayer(path, speed = 100) {
  const video = h("video", {
    class: "picture-fx-source",
    src: `/${path}`,
    autoplay: true,
    loop: true,
    muted: true,
    playsinline: true,
    preload: "auto",
    "data-effect": path,
  });
  const canvas = h("canvas", { class: "picture-fx" });
  muteVideo(video);
  video.playbackRate = Math.min(4, Math.max(0.1, speed / 100));
  queueMicrotask(() => {
    video.playbackRate = Math.min(4, Math.max(0.1, speed / 100));
    bindChromaCanvas(video, canvas, path);
  });
  return h("div", { class: "picture-fx-wrap", "aria-hidden": "true" }, video, canvas);
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
      const h = Math.max(2, Math.round(w * (video.videoHeight / video.videoWidth)));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      try {
        ctx.drawImage(video, 0, 0, w, h);
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
        // If the frame can't be read, fall back to showing the raw video briefly.
        canvas.replaceWith(video);
        video.className = "picture-fx";
        video.style.filter = "none";
        return;
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
  const { list, total } = sceneSequence(state.sceneIndex);
  const image = current.image;
  const known = image && imageExists(image);
  const bar = playerBar(total, "scene");
  const { node: listNode, rows } = playlist(list);
  if (scrubber) scrubber.rows = rows;

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
        h("input", {
          class: "scene-title",
          type: "text",
          value: current.title || "",
          placeholder: "Scene title",
          onInput: (event) => {
            current.title = event.target.value;
            clearTimeout(saveTimer);
            saveTimer = setTimeout(save, 400);
            const crumb = document.querySelector(".crumb.current");
            if (crumb) crumb.textContent = event.target.value || `Scene ${state.sceneIndex + 1}`;
          },
        }),
        pictureStage(known, image),
        bar,
        renderStatus(),
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
        listNode
      )
    )
  );
}

function sceneToolbar() {
  const effects = state.assets.effects || [];

  return h(
    "aside",
    { class: "library tools" },
    h(
      "div",
      { class: "library-group" },
      h("div", { class: "group-label" }, h("span", { class: "group-title", text: "Effects" })),
      effects.length
        ? effects.map((effect) => {
            const entry = effectEntry(effect.path);
            const on = !!entry;
            const speed = entry?.speed ?? 100;
            return h(
              "div",
              { class: `effect-block${on ? " on" : ""}` },
              h(
                "label",
                { class: `tool-row${on ? " on" : ""}` },
                h("input", {
                  type: "checkbox",
                  checked: on,
                  onChange: () => {
                    const list = sceneEffects();
                    const at = list.findIndex((item) => normalizeEffect(item).file === effect.path);
                    if (at >= 0) list.splice(at, 1);
                    else list.push({ file: effect.path, speed: 100 });
                    changed();
                  },
                }),
                h("span", { class: "name", text: effect.name.replace(/[-_]/g, " ") })
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
        : h("p", { class: "empty-note", text: "Drop clips into assets/effects" })
    ),

    libraryGroup("Animations", "animations", state.assets.animations || [], state.pruneAnims, (on) => {
      state.pruneAnims = on;
      render();
    }),
    libraryGroup("Images", "images", libraryImages(), state.pruneImages, (on) => {
      state.pruneImages = on;
      render();
    }),
    libraryGroup("Songs", "music", state.assets.music || [], state.pruneSongs, (on) => {
      state.pruneSongs = on;
      render();
    })
  );
}

function libraryImages() {
  return (state.assets.images || []).filter((image) => image.path.startsWith("assets/images/"));
}

function libraryGroup(label, kind, items, pruning, setPruning) {
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
    kind === "images" ? "No pictures yet" : kind === "animations" ? "No animations yet" : "No songs yet";

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
    items.length ? items.map((item) => libraryItem(kind, item, pruning)) : h("p", { class: "empty-note", text: empty })
  );
}

function libraryItem(kind, item, pruning) {
  if (kind === "images") {
    const renaming = state.renamingPath === item.path;
    return h(
      "div",
      { class: `media-row${scene().image === item.path ? " current" : ""}` },
      h(
        "button",
        {
          class: "media-thumb-btn",
          type: "button",
          title: item.path,
          onClick: () => {
            if (pruning || renaming) return;
            scene().image = item.path;
            changed();
          },
        },
        h("span", {
          class: "media-thumb",
          style: { backgroundImage: `url(/thumb?path=${encodeURIComponent(item.path)}&w=120)` },
        })
      ),
      renaming
        ? h("input", {
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
          })
        : h("span", {
            class: "name media-name",
            title: "Double-click to rename",
            text: item.name,
            onClick: () => {
              if (pruning || renaming) return;
              scene().image = item.path;
              changed();
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
          }),
      pruning &&
        h(
          "button",
          {
            class: "media-trash",
            type: "button",
            title: "Delete from library",
            onClick: () => deleteAsset(item.path),
          },
          trashIcon()
        )
    );
  }

  if (kind === "animations") {
    return h(
      "div",
      { class: `media-row${pruning ? " pruning" : ""}` },
      h(
        "button",
        {
          class: "media",
          type: "button",
          title: pruning ? item.path : "Add on the picture — drag and resize",
          onClick: () => {
            if (pruning) return;
            sceneAnims().push(normalizeAnim(item.path));
            state.selectedAnim = sceneAnims().length - 1;
            changed();
          },
        },
        h("span", {
          class: "media-thumb wide",
          style: { backgroundImage: `url(/thumb?path=${encodeURIComponent(item.path)}&w=160)` },
        }),
        h("span", { class: "name", text: item.name.replace(/[-_]/g, " ") })
      ),
      pruning &&
        h(
          "button",
          {
            class: "media-trash",
            type: "button",
            title: "Delete from library",
            onClick: () => deleteAsset(item.path),
          },
          trashIcon()
        )
    );
  }

  return h(
    "div",
    { class: `media-row${pruning ? " pruning" : ""}` },
    h(
      "div",
      {
        class: "media song",
        draggable: !pruning,
        title: pruning ? item.path : "Drag into the song list, or click Add song",
        onDragstart: pruning
          ? null
          : (event) => startDrag(event, { from: "library", path: item.path }),
        onDragend: pruning ? null : endDrag,
      },
      h("span", { class: "media-note", text: "\u266a" }),
      h("span", { class: "name", text: item.name }),
      h("span", { class: "len", text: clock(item.duration) })
    ),
    pruning &&
      h(
        "button",
        {
          class: "media-trash",
          type: "button",
          title: "Delete from library",
          onClick: () => deleteAsset(item.path),
        },
        trashIcon()
      )
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
      for (const entry of scenes()) {
        if (entry.image === data.from) entry.image = data.path;
        if (Array.isArray(entry.images)) {
          entry.images = entry.images.map((image) =>
            image === data.from || image?.file === data.from
              ? typeof image === "string"
                ? data.path
                : { ...image, file: data.path }
              : image
          );
        }
      }
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
    if (kind === "images" && data.path && !scene().image) scene().image = data.path;
    await refreshOutputs();
    state.note = "";
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
    for (const entry of scenes()) {
      const beforeTracks = (entry.tracks || []).length;
      entry.tracks = (entry.tracks || []).filter((track) => fileOf(track) !== path);
      if ((entry.tracks || []).length !== beforeTracks) dirty = true;

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

function animLayer(entry, index) {
  const selected = state.selectedAnim === index;
  const primary = h("video", {
    class: "anim-video is-front",
    src: `/${entry.file}`,
    autoplay: true,
    muted: true,
    playsinline: true,
    preload: "auto",
  });
  const secondary = h("video", {
    class: "anim-video is-back",
    src: `/${entry.file}`,
    muted: true,
    playsinline: true,
    preload: "auto",
  });
  muteVideo(primary);
  muteVideo(secondary);
  queueMicrotask(() => bindAnimCrossfade(primary, secondary));

  return h(
    "div",
    {
      class: `anim-layer${selected ? " selected" : ""}`,
      style: {
        left: `${entry.x * 100}%`,
        top: `${entry.y * 100}%`,
        width: `${entry.w * 100}%`,
      },
      onPointerdown: (event) => {
        if (event.target.closest(".anim-handle, .anim-remove")) return;
        beginAnimMove(event, index);
      },
    },
    primary,
    secondary,
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
      h("div", {
        class: "anim-handle",
        title: "Resize",
        onPointerdown: (event) => beginAnimResize(event, index),
      })
  );
}

function bindAnimCrossfade(front, back) {
  if (!front || !back || front.dataset.crossfade === "1") return;
  front.dataset.crossfade = "1";
  muteVideo(front);
  muteVideo(back);
  front.loop = false;
  back.loop = false;
  front.style.opacity = "1";
  back.style.opacity = "0";

  let fading = false;
  let lead = front;
  let trail = back;
  let raf = 0;

  const playMuted = async (video) => {
    muteVideo(video);
    video.loop = false;
    try {
      await video.play();
    } catch {
      /* autoplay can fail until a gesture; ignore */
    }
  };

  const startFade = () => {
    if (fading || !front.isConnected) return;
    const duration = lead.duration;
    if (!Number.isFinite(duration) || duration <= ANIM_FADE + 0.05) {
      lead.currentTime = 0;
      playMuted(lead);
      return;
    }
    fading = true;
    try {
      trail.currentTime = 0;
    } catch {
      /* ignore seek errors before ready */
    }
    playMuted(trail);
    const started = performance.now();
    const fadeMs = Math.min(ANIM_FADE, duration * 0.45) * 1000;
    const tick = (now) => {
      if (!front.isConnected) return;
      const t = Math.min(1, (now - started) / fadeMs);
      lead.style.opacity = String(1 - t);
      trail.style.opacity = String(t);
      if (t < 1) {
        requestAnimationFrame(tick);
        return;
      }
      lead.pause();
      try {
        lead.currentTime = 0;
      } catch {
        /* ignore */
      }
      lead.style.opacity = "0";
      trail.style.opacity = "1";
      const swap = lead;
      lead = trail;
      trail = swap;
      fading = false;
    };
    requestAnimationFrame(tick);
  };

  const watch = () => {
    if (!front.isConnected) return;
    if (!fading) {
      const duration = lead.duration;
      const fade = Number.isFinite(duration) ? Math.min(ANIM_FADE, duration * 0.45) : ANIM_FADE;
      if (Number.isFinite(duration) && duration > fade + 0.05) {
        if (lead.currentTime >= duration - fade) startFade();
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
  playMuted(front);
  raf = requestAnimationFrame(watch);
  front.addEventListener(
    "remove",
    () => cancelAnimationFrame(raf),
    { once: true }
  );
}

function beginAnimMove(event, index) {
  event.preventDefault();
  event.stopPropagation();
  const picture = event.currentTarget.closest(".picture");
  const layer = event.currentTarget;
  const entry = normalizeAnim(sceneAnims()[index]);
  sceneAnims()[index] = entry;
  if (state.selectedAnim !== index) {
    state.selectedAnim = index;
    // Keep drag going on this node; selection chrome updates on next render after release if needed.
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
  const box = picture.getBoundingClientRect();
  const startX = event.clientX;
  const originW = entry.w;

  handle.setPointerCapture(event.pointerId);
  const move = (moveEvent) => {
    entry.w = Math.min(1 - entry.x, Math.max(0.08, originW + (moveEvent.clientX - startX) / box.width));
    layer.style.width = `${entry.w * 100}%`;
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

function playlist(list) {
  const rows = list.map((song, index) => {
    return h(
      "div",
      {
        class: `song-row${song.missing ? " missing" : ""}`,
        draggable: true,
        onDragstart: (event) => {
          if (!event.target.closest(".handle")) {
            event.preventDefault();
            return;
          }
          startDrag(event, { from: "list", index }, event.currentTarget);
        },
        onDragend: endDrag,
        onDragover: (event) => rowDragOver(event, index),
        onDrop: (event) => rowDrop(event, index),
        onClick: (event) => {
          if (event.target.closest(".handle, .trash")) return;
          seekTo(song.start);
        },
      },
      h(
        "span",
        { class: "handle", title: "Drag to reorder", "aria-label": "Drag to reorder" },
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
            if (!sceneSongs().length) state.pickerOpen = true;
            changed();
          },
        },
        trashIcon()
      )
    );
  });

  return {
    rows,
    node: h(
      "div",
      { class: "playlist-wrap" },
      h(
        "div",
        {
          class: "playlist",
          onDragover: listDragOver,
          onDragleave: (event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) clearMarks();
          },
          onDrop: (event) => rowDrop(event, list.length),
        },
        rows.length
          ? rows
          : h("p", {
              class: "empty-note drop-hint",
              text: "No songs yet — add one below, or drag from the library",
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
    if (state.pictureExpanded) {
      state.pictureExpanded = false;
      render();
      return;
    }
    if (state.movingScene !== null) {
      state.movingScene = null;
      render();
      return;
    }
    if (state.selectedAnim !== null) {
      state.selectedAnim = null;
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
