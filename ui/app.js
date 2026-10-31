import { connect } from "./bridge.js";
import { Rig } from "./rig.js";
import { LayoutEditor } from "./layout-editor.js";
import { STATS } from "./lcd-faces.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(kid));
  return e;
};

let bridge, S;
const toastEl = $("#toast"), toastMsg = $("#toast-msg");
let toastT;
function toast(msg) {
  toastMsg.textContent = msg; toastEl.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove("show"), Math.min(6000, 2200 + msg.length * 35));
}

function sliderFill(input) { const p = ((input.value - input.min) / (input.max - input.min)) * 100; input.style.setProperty("--p", p + "%"); }

// ---------------------------------------------------------------- nav
let current = "rig", rigStale = false;
// Pages that changed while hidden are redrawn when they are opened, not on every update.
const stale = new Set();
const RENDER = {
  rig: () => { renderDevices(); renderNow(); },
  cooling: () => { renderFans(); renderFanSettings(); },
  pump: () => { renderLcd(); renderPumpStore(); },
  mouse: () => renderMouse(),
  wallpaper: () => renderWalls(),
  settings: () => renderSettings(),
};
function renderSoon(...views) {
  for (const v of views) { if (v === current) RENDER[v]?.(); else stale.add(v); }
}
function show(view) {
  current = view;
  document.body.dataset.view = view;
  bridge?.call("uiView", view).catch(() => {});
  $$(".nav button").forEach((b) => (b.dataset.view === view ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + view));
  if (stale.has(view)) { stale.delete(view); RENDER[view]?.(); }
  if (view === "rig" && rigStale && rig) { rigStale = false; rig.setLayout(S.layout, rigHidden(), activeLayout().items); }
  if (view === "cooling") drawCurve();
  if (view === "lighting") showTab(lightTab);
  else if (bridge) {
    bridge.call("previewSize", 64, 40).catch(() => {});
    if (finder) { finder = null; bridge.call("probeEnd").catch(() => {}); }
  }
}
$$(".nav button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));
document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-goto]"); if (g) show(g.dataset.goto);
  const t = e.target.closest("[data-goto-tab]"); if (t) { lightTab = t.dataset.gotoTab; show("lighting"); }
});
$("#btn-min").addEventListener("click", () => bridge.call("minimize"));
$("#btn-max").addEventListener("click", () => bridge.call("toggleMaximize"));
function setMaxIcon(max) {
  const b = $("#btn-max"); b.title = max ? "Restore" : "Maximize"; b.setAttribute("aria-label", b.title);
  b.innerHTML = max ? '<svg viewBox="0 0 12 12"><rect x="1.5" y="3.5" width="7" height="7" rx="1"/><path d="M3.5 3.5V2a.5.5 0 0 1 .5-.5h6a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-.5.5H8.5"/></svg>' : '<svg viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="1"/></svg>';
}
$("#btn-close").addEventListener("click", () => bridge.call("hide"));

// ---------------------------------------------------------------- what this PC has
// Pages and buttons for hardware or apps that aren't on this PC stay out of the way.
const seen = (id) => (S.seen || []).includes(id) || (S.devices || []).some((d) => d.id === id);
const hasCoolant = () => S.sensors?.coolant != null || !!S.cooling?.coolant;
function syncHardware() {
  const navBtn = (v) => $(`.nav button[data-view="${v}"]`);
  navBtn("pump").hidden = !seen("lcd");
  navBtn("mouse").hidden = !seen("mouse");
  if (navBtn(current)?.hidden) show("rig");
  const lcdName = (S.devices || []).find((d) => d.id === "lcd")?.detail;
  $("#pump-sub").textContent = `The round 480 × 480 screen on your ${lcdName || "pump"}. Changes go out live.`;
  $("#mouse-title").textContent = S.mouse?.model || "Mouse";
  $("#cool-sub").textContent = hasCoolant()
    ? "Pick a header, then drag the points to shape its curve. Coolant temperature is the steadiest input for the pump and radiator fans."
    : "Pick a header, then drag the points to shape its curve.";
  $("#btn-signal").hidden = !S.settings?.signalEffects;
  $("#btn-match").hidden = !(S.wallpaper?.items || []).length;
  $(".readouts .ro").hidden = !hasCoolant();
  const hero = $(".vital-hero .label");
  if (hero) hero.textContent = hasCoolant() ? "Coolant, read from the pump" : "CPU temperature";
}

// ---------------------------------------------------------------- live accent
let accent = [142, 197, 255], accentShown = "", accentAt = 0;
// Follows the lights, but is written to the page only a few times a second and only when it
// visibly changed: every write restyles the whole page.
function updateAccent(avg) {
  if (!avg) return;
  const [r, g, b] = avg.map((v) => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx < 0.04) return; // lights are dark: keep the last colour
  let hh = 0, d = mx - mn;
  if (d > 0.01) { hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; hh *= 60; if (hh < 0) hh += 360; }
  const sat = d < 0.06 ? 0.15 : Math.max(0.62, Math.min(0.95, d / (1 - Math.abs(mx + mn - 1))));
  const target = hslToRgb(hh, sat, 0.7);
  accent = accent.map((v, i) => v + (target[i] - v) * 0.06);
  const now = performance.now();
  if (now - accentAt < 250) return;
  const css = `rgb(${accent.map((v) => (v / 3 | 0) * 3).join(",")})`;
  if (css === accentShown) return;
  accentAt = now; accentShown = css;
  document.documentElement.style.setProperty("--live", css);
}
function hslToRgb(hh, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((hh / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

// ---------------------------------------------------------------- rig
let rig;
const routes = { fan: "cooling", pump: "pump", mouse: "mouse", gpu: "lighting", ram: "lighting", board: "lighting", strip: "lighting" };
function initRig() {
  rig = new Rig($("#stage"), { onPick: (it) => {
    if (it.unsplit) { lightTab = "devices"; show("lighting"); return; }
    show(routes[it.kind] || "lighting");
  } });
  rig.setLayout(S.layout, rigHidden(), activeLayout().items);
  rig.brightness = 1;
  const nb = $("#now-bright");
  nb.value = S.lighting.brightness; sliderFill(nb);
  nb.addEventListener("input", () => { S.lighting.brightness = +nb.value; syncBrightness(); bridge.call("setBrightness", +nb.value); });
  syncBrightness();
  renderNow();
  renderDevices();
  setTimeout(() => $("#shell").classList.remove("booting"), 2000);
}

function renderNow() {
  const fx = S.lighting.effects.find((f) => f.id === S.lighting.effect);
  $("#now-title").textContent = fx ? fx.name : "No effect";
  $("#now-sub").textContent = fx ? (fx.description || "Lighting effect") : "Pick one in Lighting";
}

function renderDevices() {
  const box = $("#v-devices"); box.innerHTML = "";
  if (rig) {
    const on = Object.fromEntries(S.devices.map((d) => [d.id, d.connected]));
    rig.dark = new Set([on.argb ? null : "argb", on.mouse ? null : "mouse", on.argb ? null : "board", on.gpu ? null : "gpu", on.ram ? null : "ram"].filter(Boolean));
  }
  for (const d of S.devices) box.append(h("span", { class: "pill", title: d.detail }, h("i", { class: "dot" + (d.connected ? "" : " off") }), d.name));
}

// Rows are kept and their text updated each second; the list is only rebuilt when rows come or go.
let vitalKeys = "", vitalEls = [];
function renderVitals(t) {
  const s = t.sensors;
  const cv = $("#v-coolant");
  const cool = s.coolant != null;
  const heroLabel = cool ? "Coolant, read from the pump" : "CPU temperature", hl = $(".vital-hero .label");
  if (hl.textContent !== heroLabel) hl.textContent = heroLabel;
  cv.firstChild.nodeValue = cool ? s.coolant.toFixed(1) : s.cpu == null ? "--" : Math.round(s.cpu);
  const fmt = (v) => (v == null ? "--" : Math.round(v));
  const fans = Object.fromEntries(t.fans.map((f) => [f.id, f]));
  const rows = cool ? [["cpu", "CPU", fmt(s.cpu), "°C", s.cpu > 85]] : [];
  rows.push(["gpu", "GPU", fmt(s.gpu), "°C", s.gpu > 80]);
  for (const f of S.cooling.fans.slice(0, 4)) {
    const live = fans[f.id];
    if (live) rows.push([f.id, f.name, Math.round(live.rpm).toLocaleString(), "rpm"]);
  }
  const st = S.mouse.stages[S.mouse.active];
  if (seen("mouse")) {
    const bt = mouseLink(S.mouse) === "bluetooth", b = battInfo(S.mouse);
    rows.push(S.mouse.connected && st ? ["mouse", "Mouse", st.dpi.toLocaleString(), bt ? "dpi over Bluetooth" : `dpi at ${S.mouse.polling} Hz`] : ["mouse", "Mouse", "--", "not connected"]);
    if (b) rows.push(["mouse-batt", "Mouse battery", b.pct, b.full ? "%, full" : b.charging ? "%, charging" : "%", b.low || b.critical]);
  }
  const keys = rows.map((r) => r[0]).join("|");
  const L = $("#v-list");
  if (keys !== vitalKeys) {
    vitalKeys = keys; L.innerHTML = "";
    vitalEls = rows.map(() => { const k = h("span", { class: "k" }), v = h("b", {}), u = h("small", {}); const row = h("div", { class: "vital-row" }, k, h("span", { class: "v" }, v, u)); L.append(row); return { row, k, v, u }; });
  }
  rows.forEach(([, k, v, u, hot], i) => {
    const e = vitalEls[i];
    if (e.k.textContent !== k) e.k.textContent = k;
    if (e.v.textContent !== String(v)) e.v.textContent = v;
    if (e.u.textContent !== u) e.u.textContent = u;
    e.row.classList.toggle("hot", !!hot);
  });
  const ro = (id, v, hot) => { const e = $(id); if (e.textContent !== v) e.textContent = v; e.classList.toggle("hot", !!hot); };
  ro("#ro-coolant", s.coolant == null ? "--" : s.coolant.toFixed(1) + "°");
  ro("#ro-cpu", fmt(s.cpu) + "°", s.cpu > 85);
  ro("#ro-gpu", fmt(s.gpu) + "°", s.gpu > 80);
  const hist = cool ? t.coolantHistory || [] : (renderVitals.cpuHist = [...(renderVitals.cpuHist || []), s.cpu].filter((v) => v != null).slice(-90));
  if (hist.length > 1) {
    const lo = Math.min(...hist) - 0.3, hi = Math.max(...hist) + 0.3;
    const pts = hist.map((v, i) => [(i / (hist.length - 1)) * 260, 80 - ((v - lo) / (hi - lo)) * 74]);
    const d = "M" + pts.map((p) => p.map((n) => n.toFixed(1)).join(" ")).join(" L");
    $("#v-spark .line").setAttribute("d", d);
    $("#v-spark .fill").setAttribute("d", d + " L260 84 L0 84 Z");
  }
}

function drawThumb(cv, frame) {
  const c = cv.getContext("2d");
  const img = c.createImageData(frame.w, frame.h);
  for (let i = 0, j = 0; j < frame.data.length; i += 4, j += 3) { img.data[i] = frame.data[j]; img.data[i + 1] = frame.data[j + 1]; img.data[i + 2] = frame.data[j + 2]; img.data[i + 3] = 255; }
  if (!cv._tmp) { cv._tmp = document.createElement("canvas"); }
  cv._tmp.width = frame.w; cv._tmp.height = frame.h;
  cv._tmp.getContext("2d").putImageData(img, 0, 0);
  c.imageSmoothingEnabled = true;
  c.drawImage(cv._tmp, 0, 0, cv.width, cv.height);
}

// ---------------------------------------------------------------- lighting
function renderLibrary() {
  const lib = $("#fx-library"); lib.innerHTML = "";
  for (const fx of S.lighting.effects) {
    const cv = h("canvas", { width: 160, height: 100 });
    if (fx.thumb) { const im = new Image(); im.onload = () => cv.getContext("2d").drawImage(im, 0, 0, 160, 100); im.src = fx.thumb; }
    else { const c = cv.getContext("2d"); c.fillStyle = "#1A1629"; c.fillRect(0, 0, 160, 100); }
    const tile = h("button", { class: "tile fx", "aria-pressed": String(fx.id === S.lighting.effect), onclick: () => pickEffect(fx.id) },
      cv, h("div", { class: "meta" }, h("div", { class: "name" }, fx.name), h("div", { class: "kind" }, fx.kind || "Built in")));
    if (S.playlist?.on) {
      const inList = S.playlist.items.includes(fx.id);
      const tick = h("span", { class: "pl-tick", role: "checkbox", "aria-checked": String(inList), title: inList ? "In the playlist" : "Add to the playlist" },
        svgIcon(inList ? "M5 10.5l3.2 3.2L15 7" : "M10 5v10M5 10h10"));
      tick.addEventListener("click", (e) => { e.stopPropagation(); togglePlaylistItem(fx.id); });
      tile.append(tick);
    }
    lib.append(tile);
  }
}

function svgIcon(d) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 20 20");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", d); s.append(p); return s;
}

// ---------------------------------------------------------------- playlist
function togglePlaylistItem(id) {
  const items = S.playlist.items;
  const i = items.indexOf(id);
  if (i >= 0) items.splice(i, 1); else items.push(id);
  bridge.call("setPlaylist", { items });
  renderLibrary(); renderPlaylist();
}

function renderPlaylist() {
  const box = $("#fx-playlist"); box.innerHTML = "";
  const pl = S.playlist; if (!pl) return;
  const on = h("input", { type: "checkbox", checked: pl.on });
  on.addEventListener("change", () => {
    pl.on = on.checked;
    if (pl.on && pl.items.length === 0) pl.items = [S.lighting.effect];
    bridge.call("setPlaylist", { on: pl.on, items: pl.items }); renderLibrary(); renderPlaylist();
  });
  box.append(h("label", { class: "row between" }, h("div", {}, h("b", {}, "Playlist"), h("p", { class: "muted" }, pl.on ? "Tick effects in the library to add them." : "Cycle through chosen effects on a timer.")), h("span", { class: "switch" }, on)));
  if (!pl.on) return;
  const mins = h("select", { class: "select" }, [1, 2, 5, 10, 15, 30, 60].map((m) => h("option", { value: m, selected: m === pl.minutes }, m === 1 ? "Every minute" : `Every ${m} minutes`)));
  mins.addEventListener("change", () => { pl.minutes = +mins.value; bridge.call("setPlaylist", { minutes: pl.minutes }); });
  const shuf = h("input", { type: "checkbox", checked: pl.shuffle });
  shuf.addEventListener("change", () => { pl.shuffle = shuf.checked; bridge.call("setPlaylist", { shuffle: pl.shuffle }); });
  const names = pl.items.map((id) => S.lighting.effects.find((f) => f.id === id)?.name).filter(Boolean);
  box.append(h("div", { class: "row between" }, mins, h("label", { class: "row", style: { gap: "10px" } }, h("span", { class: "muted" }, "Shuffle"), h("span", { class: "switch" }, shuf))),
    h("p", { class: "muted pl-names" }, names.length < 2 ? "Add at least two effects." : names.join(", ")));
}

async function pickEffect(id) {
  S.lighting.effect = id;
  const values = await bridge.call("setEffect", id);
  renderLibrary(); renderParams(values); renderNow();
  if (editor) { renderLayoutsCard(); syncTestBtn(); }
}

function renderParams(values) {
  const fx = S.lighting.effects.find((f) => f.id === S.lighting.effect);
  const box = $("#fx-params"); box.innerHTML = "";
  if (!fx) return;
  box.append(h("div", {}, h("h2", {}, fx.name), h("p", { class: "muted", style: { marginTop: "6px" } }, fx.description || "")));
  if (!fx.params.length) box.append(h("p", { class: "muted" }, "This effect has no settings."));
  if (fx.screen && S.capture) {
    const mon = S.capture.monitors.find((m) => m.id === S.capture.monitor) || S.capture.monitors[0];
    box.append(h("div", { class: "row between capture-link" },
      h("span", { class: "muted" }, `Watching ${mon ? mon.name.split(" · ")[0] : "the main display"} at ${S.capture.fps} fps`),
      h("button", { class: "btn ghost", onclick: () => { showTab("layout"); setTimeout(() => $("#ed-screen")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); } }, "Capture settings")));
  }
  for (const p of fx.params) {
    const v = values && p.property in values ? values[p.property] : p.default;
    const set = (val) => bridge.call("setEffectParam", p.property, val);
    let ctrl;
    if (p.type === "number" || p.type === "hue") {
      const out = h("span", { class: "num muted" }, String(v));
      const r = h("input", { class: "slider", type: "range", min: p.type === "hue" ? 0 : p.min, max: p.type === "hue" ? 360 : p.max, step: p.step || 1, value: v });
      sliderFill(r);
      r.addEventListener("input", () => { sliderFill(r); out.textContent = r.value; set(+r.value); });
      ctrl = h("div", { class: "field" }, h("div", { class: "row between" }, h("span", { class: "label" }, p.label), out), r);
    } else if (p.type === "color") {
      const c = h("input", { type: "color", class: "swatch", value: v });
      c.addEventListener("input", () => set(c.value));
      ctrl = h("div", { class: "row between" }, h("span", { class: "label muted" }, p.label), c);
    } else if (p.type === "boolean") {
      const c = h("input", { type: "checkbox", checked: v === true || v === 1 || v === "1" });
      c.addEventListener("change", () => set(c.checked));
      ctrl = h("label", { class: "row between" }, h("span", { class: "muted" }, p.label), h("span", { class: "switch" }, c));
    } else if (p.type === "combobox") {
      if (p.values.length <= 3) {
        const seg = h("div", { class: "seg", role: "group" });
        for (const val of p.values) seg.append(h("button", { "aria-pressed": String(val === v), onclick: (e) => { $$("button", seg).forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget))); set(val); } }, val));
        ctrl = h("div", { class: "field" }, h("span", { class: "label" }, p.label), seg);
      } else {
        const sel = h("select", { class: "select" }, p.values.map((val) => h("option", { value: val, selected: val === v }, val)));
        sel.addEventListener("change", () => set(sel.value));
        ctrl = h("div", { class: "field" }, h("span", { class: "label" }, p.label), sel);
      }
    } else {
      const t = h("input", { class: "text", value: v });
      t.addEventListener("change", () => set(t.value));
      ctrl = h("div", { class: "field" }, h("span", { class: "label" }, p.label), t);
    }
    box.append(ctrl);
  }
}

$("#btn-match").addEventListener("click", () => matchWallpaper().catch(() => toast("Couldn't read that wallpaper's picture")));
$("#btn-signal").addEventListener("click", async () => { const r = await bridge.call("importSignalEffects"); toast(r?.message || "Done"); if (r?.ok) { S = await bridge.call("getState"); renderLibrary(); } });
$("#btn-import").addEventListener("click", async () => { const r = await bridge.call("importEffect"); if (r?.message) toast(r.message); if (r?.ok) { S = await bridge.call("getState"); renderLibrary(); } });

// ---------------------------------------------------------------- cooling
const RANGES = { coolant: [20, 60], cpu: [30, 100], gpu: [30, 100] };
const SRC_NAMES = { coolant: "Coolant", cpu: "CPU", gpu: "GPU" };
let lastTelemetry = null;

function selFan() { return S.cooling.fans.find((f) => f.id === S.cooling.selected) || S.cooling.fans[0]; }

let pawnBusy = false;
async function installPawn() {
  pawnBusy = true; renderFans(); if (lightTab === "devices") renderDevicesTab();
  toast("Installing PawnIO. If Windows asks, click Yes.");
  let r;
  try { r = await bridge.call("installPawnIo"); } catch (e) { r = { ok: false, message: String(e.message || e) }; }
  pawnBusy = false;
  const ok = r === true || r?.ok;
  toast(ok ? "PawnIO installed. Fan control is on." : (r?.message || "PawnIO didn't install. Open the logs from Settings."));
  S = await bridge.call("getState");
  renderFans(); renderFanSettings(); if (lightTab === "devices") renderDevicesTab();
}

function renderFans() {
  const L = $("#fan-list"); L.innerHTML = "";
  const C = S.cooling;
  if (C.ready === false || !C.fans.length) {
    const msg = C.pawnio === false ? "Fan control needs the PawnIO driver, the same one LibreHardwareMonitor and FanControl use." : C.problem || "No fan headers found yet.";
    L.style.gridTemplateColumns = "1fr";
    L.append(h("div", { class: "box card" },
      h("div", { class: "row between" }, h("div", {}, h("b", {}, pawnBusy ? "Installing PawnIO" : "Fan control isn't running"), h("p", { class: "muted", style: { marginTop: "4px" } }, pawnBusy ? "This takes a few seconds. Fan control and the RAM lights start by themselves once it's done." : msg)),
        C.pawnio === false ? h("button", { class: "btn primary" + (pawnBusy ? " busy" : ""), disabled: pawnBusy, onclick: installPawn }, pawnBusy ? "Installing…" : "Install PawnIO") : null),
      pawnBusy ? h("div", { class: "upbar indeterminate" }, h("i", {})) : null));
    $(".grid-2", $("#view-cooling")).style.display = "none";
    return;
  }
  L.style.gridTemplateColumns = "";
  $(".grid-2", $("#view-cooling")).style.display = "";
  for (const f of S.cooling.fans) {
    const live = lastTelemetry?.fans.find((x) => x.id === f.id) || f;
    const how = f.mode === "fixed" ? "Fixed speed" : f.mode === "bios" ? "Motherboard decides" : `Follows ${f.source === "coolant" ? "coolant" : SRC_NAMES[f.source]}`;
    L.append(h("button", { class: "tile fan", "data-id": f.id, "aria-pressed": String(f.id === S.cooling.selected), onclick: () => { S.cooling.selected = f.id; selectedCurvePoint = -1; addingCurvePoint = false; renderFans(); renderFanSettings(); drawCurve(); } },
      h("div", { class: "head" }, h("b", {}, f.name), h("span", {}, f.header)),
      h("div", { class: "rpm" }, h("span", { class: "rpm-v" }, Math.round(live.rpm).toLocaleString()), h("small", {}, "rpm")),
      h("div", { class: "src" }, how, h("span", { class: "duty" }, ` at ${Math.round(live.duty)}%`)),
      h("span", { class: "bar" }, h("i", { style: { width: Math.round(live.duty) + "%" } }))));
  }
}

// Each second only the numbers change, so only the numbers are touched.
function updateFansLive() {
  if (!lastTelemetry || !$(".fan[data-id]")) { renderFans(); return; }
  for (const x of lastTelemetry.fans) {
    const tile = $(`.fan[data-id="${CSS.escape(x.id)}"]`); if (!tile) continue;
    $(".rpm-v", tile).textContent = Math.round(x.rpm).toLocaleString();
    $(".duty", tile).textContent = ` at ${Math.round(x.duty)}%`;
    $(".bar i", tile).style.width = Math.round(x.duty) + "%";
  }
}

function renderFanSettings() {
  const f = selFan(); const box = $("#fan-settings"); box.innerHTML = ""; if (!f) return;
  const seg = (items, cur, on) => { const s = h("div", { class: "seg", role: "group" }); for (const [k, label] of items) s.append(h("button", { "aria-pressed": String(k === cur), onclick: () => on(k) }, label)); return s; };
  const update = (patch) => { if (patch.mode && patch.mode !== "curve") { addingCurvePoint = false; selectedCurvePoint = -1; } Object.assign(f, patch); bridge.call("setFan", f.id, patch); renderFans(); renderFanSettings(); drawCurve(); };
  const nameIn = h("input", { class: "text", value: f.name, "aria-label": "Name" });
  nameIn.addEventListener("change", () => { f.name = nameIn.value || f.name; bridge.call("renameFan", f.id, f.name); renderFans(); });
  const find = h("button", { class: "btn ghost", title: "Runs this header at full speed for 6 seconds", onclick: async () => {
    const ok = await bridge.call("identifyFan", f.id);
    toast(ok ? `${f.header} runs at full speed for 6 seconds. Watch which fans spin up.` : "Fan control isn't running");
    find.disabled = true; setTimeout(() => (find.disabled = false), 6000);
  } }, "Find it");
  box.append(
    h("div", { class: "field" }, h("div", { class: "row between" }, h("span", { class: "label" }, `Name for ${f.header}`), find), nameIn),
    h("div", { class: "field" }, h("span", { class: "label" }, "Control"), seg([["curve", "Curve"], ["fixed", "Fixed speed"], ["bios", "Motherboard"]], f.mode, (m) => update({ mode: m }))),
  );
  const pumpSw = h("input", { type: "checkbox", checked: !!f.pump });
  pumpSw.addEventListener("change", () => update({ pump: pumpSw.checked }));
  box.append(h("label", { class: "row between" }, h("span", {}, h("span", {}, "A pump is on this header"), h("p", { class: "muted small" }, "It never runs below 40%, so the coolant keeps moving.")), h("span", { class: "switch" }, pumpSw)));
  if (f.mode === "curve") {
    const sources = (hasCoolant() ? [["coolant", "Coolant"]] : []).concat([["cpu", "CPU"], ["gpu", "GPU"]]);
    box.append(h("div", { class: "field" }, h("span", { class: "label" }, "Follow this temperature"), seg(sources, f.source, (s) => update({ source: s }))));
    const out = h("span", { class: "num muted" }, f.min + "%");
    const r = h("input", { class: "slider", type: "range", min: 0, max: 60, value: f.min }); sliderFill(r);
    r.addEventListener("input", () => { sliderFill(r); out.textContent = r.value + "%"; });
    r.addEventListener("change", () => update({ min: +r.value }));
    box.append(h("div", { class: "field" }, h("div", { class: "row between" }, h("span", { class: "label" }, "Never slower than"), out), r));
  }
  if (f.mode === "fixed") {
    const out = h("span", { class: "num muted" }, f.fixed + "%");
    const r = h("input", { class: "slider", type: "range", min: 0, max: 100, value: f.fixed }); sliderFill(r);
    r.addEventListener("input", () => { sliderFill(r); out.textContent = r.value + "%"; });
    r.addEventListener("change", () => update({ fixed: +r.value }));
    box.append(h("div", { class: "field" }, h("div", { class: "row between" }, h("span", { class: "label" }, "Speed"), out), r),
      h("p", { class: "muted small" }, `Most PWM fans can't stop: at 0% they idle at their lowest speed. To let a header stop its fans, set it to Voltage (DC) mode in the BIOS fan settings${/gigabyte|aorus/i.test(S.cooling.board || "") ? " (Smart Fan 6)" : ""}.${f.pump ? " A pump never goes below 40%." : ""}`));
  }
  if (f.mode === "bios") box.append(h("p", { class: "muted" }, "Monarch leaves this header alone and your BIOS fan curve stays in charge."));
}

$$("#fan-presets button").forEach((b) => b.addEventListener("click", async () => {
  const f = selFan();
  const curve = await bridge.call("preset", b.dataset.preset);
  const [lo, hi] = RANGES[f.source];
  // presets are written for 20-70 °C; stretch them to this sensor's range
  f.curve = curve.map(([t, p]) => [Math.round(lo + ((t - 20) / 50) * (hi - lo)), p]);
  selectedCurvePoint = -1; addingCurvePoint = false;
  f.mode = "curve";
  bridge.call("setFan", f.id, { curve: f.curve, mode: "curve" });
  renderFans(); renderFanSettings(); drawCurve();
}));

const CW = 600, CH = 330, PAD = { l: 42, r: 16, t: 14, b: 32 };
let curveGeom = null;
let selectedCurvePoint = -1, addingCurvePoint = false;

function updateCurveTools() {
  const f = selFan(), add = $("#curve-add"), remove = $("#curve-remove"), help = $("#curve-help"), svg = $("#curve");
  if (!f || !add || !remove || !help || !svg) return;
  const canEdit = f.mode === "curve";
  add.disabled = !canEdit;
  add.setAttribute("aria-pressed", String(addingCurvePoint));
  add.textContent = addingCurvePoint ? "Click graph…" : "Add point";
  remove.disabled = !canEdit || selectedCurvePoint < 0 || f.curve.length <= 2;
  help.textContent = addingCurvePoint
    ? "Click the graph to place a point. Add point again to cancel."
    : "Live dot shows current speed. Drag a point; select it to remove. Add point, then click graph.";
  svg.classList.toggle("adding-point", addingCurvePoint);
}

function removeSelectedCurvePoint() {
  const f = selFan();
  if (!f || f.mode !== "curve" || selectedCurvePoint < 0) return;
  if (f.curve.length <= 2) { toast("A curve needs at least two points."); return; }
  f.curve.splice(selectedCurvePoint, 1);
  selectedCurvePoint = -1;
  addingCurvePoint = false;
  bridge.call("setFan", f.id, { curve: f.curve });
  drawCurve();
}

$("#curve-add").addEventListener("click", () => {
  const f = selFan();
  if (!f || f.mode !== "curve") return;
  addingCurvePoint = !addingCurvePoint;
  updateCurveTools();
});
$("#curve-remove").addEventListener("click", removeSelectedCurvePoint);

// Moves the "running now" marker without rebuilding the chart, so hover and drags aren't disturbed.
function drawCurveNow() {
  const g = curveGeom, f = selFan();
  if (!g || g.f !== f || !g.nowLine.isConnected) { drawCurve(); return; }
  const cur = lastTelemetry?.sensors?.[f.source];
  const show = f.mode === "curve" && cur != null;
  g.nowLine.style.display = g.nowPt.style.display = show ? "" : "none";
  if (show) {
    const duty = lastTelemetry.fans.find((x) => x.id === f.id)?.duty ?? 0;
    const x = g.X(Math.max(RANGES[f.source][0], Math.min(RANGES[f.source][1], cur)));
    g.nowLine.setAttribute("x1", x); g.nowLine.setAttribute("x2", x); g.nowLine.setAttribute("y1", PAD.t); g.nowLine.setAttribute("y2", CH - PAD.b);
    g.nowPt.setAttribute("cx", x); g.nowPt.setAttribute("cy", g.Y(duty));
    $("#curve-readout").textContent = `${SRC_NAMES[f.source]} ${cur.toFixed(1)}° gives ${Math.round(duty)}%`;
  } else $("#curve-readout").textContent = f.mode === "fixed" ? `Fixed at ${f.fixed}%` : f.mode === "bios" ? "Motherboard curve" : "";
}
function drawCurve() {
  const svg = $("#curve"); const f = selFan(); if (!f || !svg) return;
  if (selectedCurvePoint >= f.curve.length) selectedCurvePoint = -1;
  const [lo, hi] = RANGES[f.source];
  const X = (t) => PAD.l + ((t - lo) / (hi - lo)) * (CW - PAD.l - PAD.r);
  const Y = (p) => CH - PAD.b - (p / 100) * (CH - PAD.t - PAD.b);
  const inv = (px, py) => [lo + ((px - PAD.l) / (CW - PAD.l - PAD.r)) * (hi - lo), ((CH - PAD.b - py) / (CH - PAD.t - PAD.b)) * 100];
  const NS = "http://www.w3.org/2000/svg";
  const e = (n, a, p = svg) => { const x = document.createElementNS(NS, n); for (const k in a) x.setAttribute(k, a[k]); p.appendChild(x); return x; };
  svg.innerHTML = "";
  const grid = e("g", { class: "grid" }), axis = e("g", { class: "axis" });
  for (let p = 0; p <= 100; p += 25) { e("line", { x1: PAD.l, x2: CW - PAD.r, y1: Y(p), y2: Y(p) }, grid); e("text", { x: PAD.l - 10, y: Y(p) + 4, "text-anchor": "end" }, axis).textContent = p + "%"; }
  const step = (hi - lo) / 5;
  for (let t = lo; t <= hi + 0.1; t += step) { e("line", { x1: X(t), x2: X(t), y1: PAD.t, y2: CH - PAD.b }, grid); e("text", { x: X(t), y: CH - 10, "text-anchor": "middle" }, axis).textContent = Math.round(t) + "°"; }
  const pts = f.curve.map(([t, p]) => [X(Math.max(lo, Math.min(hi, t))), Y(p)]);
  const d = `M${PAD.l} ${pts[0][1]} L` + pts.map((p) => p.join(" ")).join(" L") + ` L${CW - PAD.r} ${pts[pts.length - 1][1]}`;
  e("path", { class: "curve-fill", d: d + ` L${CW - PAD.r} ${CH - PAD.b} L${PAD.l} ${CH - PAD.b} Z` });
  e("path", { class: "curve-line", d });
  const nowLine = e("line", { class: "now", id: "curve-now" }), nowPt = e("circle", { class: "nowpt", id: "curve-nowpt", r: 5 });
  curveGeom = { f, X, Y, nowLine, nowPt };
  drawCurveNow();
  $("#curve-title").textContent = `${f.name} curve`;
  updateCurveTools();
  if (f.mode !== "curve") { svg.style.opacity = 0.35; return; }
  svg.style.opacity = 1;
  pts.forEach((p, i) => {
    const c = e("circle", { class: "pt" + (i === selectedCurvePoint ? " selected" : ""), cx: p[0], cy: p[1], r: 6, tabindex: 0, role: "button", "aria-label": `${Math.round(f.curve[i][0])} degrees, ${Math.round(f.curve[i][1])}% fan speed`, "aria-pressed": String(i === selectedCurvePoint) });
    c.addEventListener("pointerdown", (ev) => {
      selectedCurvePoint = i;
      addingCurvePoint = false;
      $$(`circle.pt`, svg).forEach((point, index) => {
        const selected = index === i;
        point.classList.toggle("selected", selected);
        point.setAttribute("aria-pressed", String(selected));
      });
      updateCurveTools();
      c.setPointerCapture(ev.pointerId); c.classList.add("drag");
      const box = svg.getBoundingClientRect();
      const move = (m) => {
        const px = ((m.clientX - box.left) / box.width) * CW, py = ((m.clientY - box.top) / box.height) * CH;
        let [t, pc] = inv(px, py);
        const minT = i ? f.curve[i - 1][0] + 1 : lo, maxT = i < f.curve.length - 1 ? f.curve[i + 1][0] - 1 : hi;
        t = Math.round(Math.max(minT, Math.min(maxT, t)));
        pc = Math.round(Math.max(0, Math.min(100, pc)));
        f.curve[i] = [t, pc];
        drawCurve();
      };
      const up = () => { svg.removeEventListener("pointermove", move); svg.removeEventListener("pointerup", up); bridge.call("setFan", f.id, { curve: f.curve }); };
      svg.addEventListener("pointermove", move); svg.addEventListener("pointerup", up);
    });
  });
}

$("#curve").addEventListener("click", (ev) => {
  if (!addingCurvePoint || ev.target.closest?.("circle.pt")) return;
  const f = selFan();
  if (!f || f.mode !== "curve") return;
  const svgPoint = ev.currentTarget.createSVGPoint();
  svgPoint.x = ev.clientX; svgPoint.y = ev.clientY;
  const chartPoint = svgPoint.matrixTransform(ev.currentTarget.getScreenCTM().inverse());
  if (chartPoint.x < PAD.l || chartPoint.x > CW - PAD.r || chartPoint.y < PAD.t || chartPoint.y > CH - PAD.b) return;
  const px = chartPoint.x, py = chartPoint.y;
  const [lo, hi] = RANGES[f.source];
  const xToTemp = (x) => lo + ((x - PAD.l) / (CW - PAD.l - PAD.r)) * (hi - lo);
  const temp = Math.round(xToTemp(px)), speed = Math.round(((CH - PAD.b - py) / (CH - PAD.t - PAD.b)) * 100);
  const index = f.curve.findIndex(([t]) => t > temp);
  const before = index > 0 ? f.curve[index - 1][0] : null;
  const after = index >= 0 ? f.curve[index][0] : null;
  if ((before != null && temp <= before) || (after != null && temp >= after)) {
    toast("Choose a temperature between existing points.");
    return;
  }
  f.curve.splice(index < 0 ? f.curve.length : index, 0, [temp, speed]);
  selectedCurvePoint = index < 0 ? f.curve.length - 1 : index;
  addingCurvePoint = false;
  bridge.call("setFan", f.id, { curve: f.curve });
  drawCurve();
});

// ---------------------------------------------------------------- pump screen
const LCD_MODES = [
  ["vitals", "Vitals", "Coolant gauge with CPU and GPU"],
  ["system", "System info", "Pick up to six readings"],
  ["clock", "Clock", "Time and date with coolant"],
  ["media", "Picture or video", "GIF, MP4, JPG or PNG"],
  ["screen", "Screen mirror", "Part of a display, live"],
  ["window", "Window", "One app, even behind others"],
  ["effect", "Lighting", "Shows the current effect"],
  ["off", "Off", "Backlight off"],
];
const OVERLAY_MODES = new Set(["media", "effect", "screen", "window"]);
let mirrorStatus = "";
function renderLcd() {
  const M = $("#lcd-modes"); M.innerHTML = "";
  for (const [k, name, sub] of LCD_MODES) M.append(h("button", { class: "tile mode", "aria-pressed": String(S.lcd.mode === k), onclick: () => { S.lcd.mode = k; bridge.call("setLcd", { mode: k }); renderLcd(); } }, h("b", {}, name), h("span", {}, sub)));
  const box = $("#lcd-settings"); box.innerHTML = "";
  const set = (patch) => { Object.assign(S.lcd, patch); bridge.call("setLcd", patch); };
  const out = h("span", { class: "num muted" }, S.lcd.brightness + "%");
  const br = h("input", { class: "slider", type: "range", min: 0, max: 100, value: S.lcd.brightness }); sliderFill(br);
  br.addEventListener("input", () => { sliderFill(br); out.textContent = br.value + "%"; });
  br.addEventListener("change", () => set({ brightness: +br.value }));
  const rot = h("div", { class: "seg", role: "group" });
  for (const d of [0, 90, 180, 270]) rot.append(h("button", { "aria-pressed": String(S.lcd.rotation === d), onclick: () => { set({ rotation: d }); renderLcd(); renderPumpStore(); } }, d + "°"));
  box.append(h("div", { class: "field" }, h("div", { class: "row between" }, h("span", { class: "label" }, "Brightness"), out), br));
  box.append(h("div", { class: "field" }, h("span", { class: "label" }, "Rotation, if the pump is mounted sideways"), rot));
  if (S.lcd.mode === "media") {
    box.append(h("div", { class: "drop" },
      h("div", {}, h("b", {}, S.lcd.media ? decodeURIComponent(S.lcd.media.split(/[\\/]/).pop()) : "No file chosen"), h("p", { class: "muted" }, "Videos and GIFs play in a loop.")),
      h("button", { class: "btn", onclick: async () => { const p = await bridge.call("pickLcdMedia"); if (p) { S.lcd.media = p; S.lcd.mode = "media"; renderLcd(); } else if (!bridge.live) toast("Picking a file works in the app."); } }, "Choose file")));
    box.append(...mediaFitControls(set));
  }
  if (S.lcd.mode === "screen") box.append(...screenMirrorControls(set), ...mediaFitControls(set));
  if (S.lcd.mode === "window") box.append(...windowMirrorControls(set), ...mediaFitControls(set));
  if (S.lcd.mode === "system") {
    const chosen = S.lcd.stats || [];
    const grid = h("div", { class: "stat-pick" });
    for (const [k, st] of Object.entries(STATS)) {
      const on = chosen.includes(k);
      grid.append(h("button", { class: "stat-chip", "aria-pressed": String(on), onclick: () => {
        let list = (S.lcd.stats || []).slice();
        if (list.includes(k)) list = list.filter((x) => x !== k); else if (list.length < 6) list.push(k); else { toast("Six at most"); return; }
        if (!list.length) { toast("Keep at least one"); return; }
        set({ stats: list }); renderLcd();
      } }, st.label, h("small", {}, st.unit)));
    }
    box.append(h("div", { class: "field" }, h("div", { class: "row between" }, h("span", { class: "label" }, "Readings on the screen"), h("span", { class: "muted small" }, `${chosen.length} of 6, in the order you pick them`)), grid));
  }
  if (S.lcd.mode === "vitals") {
    const c = h("input", { type: "checkbox", checked: S.lcd.heatTint });
    c.addEventListener("change", () => set({ heatTint: c.checked }));
    box.append(h("label", { class: "row between" }, h("span", { class: "muted" }, "Gauge turns warmer as coolant heats up"), h("span", { class: "switch" }, c)));
  }
  if (S.lcd.mode === "clock") {
    const c = h("input", { type: "checkbox", checked: S.lcd.h12 });
    c.addEventListener("change", () => set({ h12: c.checked }));
    box.append(h("label", { class: "row between" }, h("span", { class: "muted" }, "12-hour time"), h("span", { class: "switch" }, c)));
  }
  renderOverlays();
}

// ---- readings on top of a picture, video, mirror or the effect
function overlayList() { return (S.lcd.overlays || []).map((o) => ({ ...o })); }
function saveOverlays(list, live = false) {
  S.lcd.overlays = list;
  if (live) { clearTimeout(saveOverlays.t); saveOverlays.t = setTimeout(() => bridge.call("setLcd", { overlays: list }), 60); }
  else bridge.call("setLcd", { overlays: list });
}
const OV_COLORS = ["#EDF1FB", "#78B8FF", "#FF6B5E", "#7CF2B0", "#FFD166"];
function renderOverlays() {
  const card = $("#lcd-overlays"); const layer = $("#ov-layer");
  const on = OVERLAY_MODES.has(S.lcd.mode);
  card.hidden = !on; layer.innerHTML = "";
  if (!on) return;
  card.innerHTML = "";
  const list = overlayList();
  card.append(h("div", { class: "row between" }, h("h2", {}, "Readings on top"), h("span", { class: "muted small" }, "Drag them on the preview to move them")));
  if (!list.length) card.append(h("p", { class: "muted" }, "Nothing on top yet. Add the readings you want over the picture."));
  // every change starts from the saved list, so one edit never undoes another
  list.forEach((o, i) => {
    const upd = (patch, live) => { const l = overlayList(); if (!l[i]) return; Object.assign(l[i], patch); saveOverlays(l, live); if (!live) renderOverlays(); else placeHandles(); };
    const stat = h("select", { class: "select" }, Object.entries(STATS).map(([k, st]) => h("option", { value: k, selected: k === o.stat }, st.label + (st.unit ? ` (${st.unit})` : ""))));
    stat.addEventListener("change", () => upd({ stat: stat.value }));
    const size = h("input", { class: "slider", type: "range", min: 16, max: 140, value: o.size || 48, title: "Size" }); sliderFill(size);
    size.addEventListener("input", () => { sliderFill(size); upd({ size: +size.value }, true); });
    const col = h("input", { type: "color", class: "swatch", value: o.color || "#EDF1FB", title: "Colour" });
    col.addEventListener("input", () => upd({ color: col.value }, true));
    const lab = h("input", { type: "checkbox", checked: o.label !== false });
    lab.addEventListener("change", () => upd({ label: lab.checked }));
    card.append(h("div", { class: "ov-row" + (o.hidden ? " is-hidden" : "") },
      iconBtn(o.hidden ? "eyeOff" : "eye", o.hidden ? "Show it on the screen" : "Hide it (keeps its place and settings)", () => upd({ hidden: !o.hidden })),
      stat,
      h("label", { class: "ov-size" }, h("span", { class: "muted small" }, "Size"), size),
      col,
      h("label", { class: "row small muted", style: { gap: "6px" }, title: "Show the name under the value" }, "Name", h("span", { class: "switch sm" }, lab)),
      iconBtn("x", "Remove", () => { const l = overlayList(); l.splice(i, 1); saveOverlays(l); renderOverlays(); })));
  });
  card.append(h("div", { class: "row", style: { gap: "8px" } },
    h("button", { class: "btn", disabled: list.length >= 12, onclick: () => {
      const l = overlayList();
      const used = new Set(l.map((o) => o.stat));
      const stat = ["coolant", "cpuTemp", "gpuTemp", "cpuLoad", "gpuLoad", "time", "ramLoad", "cpuClock", "gpuClock"].find((k) => !used.has(k)) || "coolant";
      // a free spot: below the lowest reading, wrapping to the top
      const y = l.length ? Math.max(...l.map((o) => o.y ?? 0.5)) + 0.16 : 0.5;
      l.push({ stat, x: 0.5, y: y > 0.85 ? 0.2 : y, size: 48, color: OV_COLORS[l.length % OV_COLORS.length], label: true, unit: true });
      saveOverlays(l); renderOverlays();
    } }, "Add a reading")));
  placeHandles();
}

// Handles over the preview, one per reading. The preview shows the rotated screen,
// so positions are turned the same way.
function placeHandles() {
  const layer = $("#ov-layer"); if (!layer) return; layer.innerHTML = "";
  if (!OVERLAY_MODES.has(S.lcd.mode)) return;
  const rot = ((S.lcd.rotation || 0) * Math.PI) / 180;
  const toView = (x, y) => { const dx = x - 0.5, dy = y - 0.5; return [0.5 + dx * Math.cos(rot) - dy * Math.sin(rot), 0.5 + dx * Math.sin(rot) + dy * Math.cos(rot)]; };
  const fromView = (x, y) => { const dx = x - 0.5, dy = y - 0.5; return [0.5 + dx * Math.cos(-rot) - dy * Math.sin(-rot), 0.5 + dx * Math.sin(-rot) + dy * Math.cos(-rot)]; };
  const list = overlayList();
  list.forEach((o, i) => {
    if (o.hidden) return;
    const [vx, vy] = toView(o.x ?? 0.5, o.y ?? 0.5);
    const k = 100 / 480, sz = o.size || 48;   // percent of the preview per screen pixel
    const el = h("div", { class: "ov-h", title: `${STATS[o.stat]?.label || o.stat}: drag to move`,
      style: { left: vx * 100 + "%", top: (vy + (o.label !== false ? sz * 0.2 / 480 : 0)) * 100 + "%", width: Math.max(8, sz * 2.4 * k) + "%", height: Math.max(5, sz * (o.label !== false ? 1.65 : 1.15) * k) + "%" } },
      h("span", {}, STATS[o.stat]?.label || o.stat));
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault(); el.setPointerCapture(e.pointerId); el.classList.add("drag");
      const r = layer.getBoundingClientRect();
      const move = (m) => {
        const px = Math.max(0, Math.min(1, (m.clientX - r.left) / r.width)), py = Math.max(0, Math.min(1, (m.clientY - r.top) / r.height));
        el.style.left = px * 100 + "%"; el.style.top = (py + (o.label !== false ? sz * 0.2 / 480 : 0)) * 100 + "%";
        const [fx, fy] = fromView(px, py);
        list[i].x = Math.round(fx * 1000) / 1000; list[i].y = Math.round(fy * 1000) / 1000;
        saveOverlays(list.map((x) => ({ ...x })), true);
      };
      const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.classList.remove("drag"); saveOverlays(list.map((x) => ({ ...x }))); };
      el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
    });
    layer.append(el);
  });
}

// ---- mirroring
function screenMirrorControls(set) {
  const c = S.capture || { monitors: [] };
  const mon = h("select", { class: "select" }, c.monitors.map((m) => h("option", { value: m.id, selected: m.id === (S.lcd.capMonitor || "") || (!S.lcd.capMonitor && m.name.endsWith("main")) }, m.name)));
  mon.addEventListener("change", () => set({ capMonitor: mon.value }));
  const trim = (key, label) => {
    const v = Math.round((S.lcd[key] || 0) * 100);
    const out = h("span", { class: "num muted" }, v + "%");
    const r = h("input", { class: "slider", type: "range", min: 0, max: 90, value: v }); sliderFill(r);
    r.addEventListener("input", () => { sliderFill(r); out.textContent = r.value + "%"; set({ [key]: r.value / 100 }); });
    return h("div", { class: "field" }, h("div", { class: "row between" }, h("span", { class: "label" }, label), out), r);
  };
  const quick = (label, patch) => h("button", { class: "btn ghost small", onclick: () => { set(patch); renderLcd(); } }, label);
  const cur = h("input", { type: "checkbox", checked: !!S.lcd.capCursor });
  cur.addEventListener("change", () => set({ capCursor: cur.checked }));
  return [
    h("div", { class: "field" }, h("span", { class: "label" }, "Display"), mon),
    h("div", { class: "field" }, h("div", { class: "row between" }, h("span", { class: "label" }, "Area of the display"),
      h("div", { class: "row", style: { gap: "4px" } }, quick("Whole display", { capLeft: 0, capTop: 0, capRight: 0, capBottom: 0 }), quick("Square in the middle", { capLeft: 0.2188, capRight: 0.2188, capTop: 0, capBottom: 0 }))),
      h("div", { class: "trims" }, trim("capLeft", "Trim left"), trim("capRight", "Trim right"), trim("capTop", "Trim top"), trim("capBottom", "Trim bottom"))),
    h("label", { class: "row between" }, h("span", { class: "muted" }, "Show the mouse pointer"), h("span", { class: "switch" }, cur)),
    h("p", { class: "muted small mirror-status" }, mirrorStatus),
  ];
}

let windowsCache = [];
function windowMirrorControls(set) {
  const sel = h("select", { class: "select grow" });
  const fill = () => {
    sel.innerHTML = "";
    const curName = S.lcd.capWindow || "";
    if (!windowsCache.some((w) => w.title === curName) && curName) sel.append(h("option", { value: "", selected: true }, `${curName} (not open)`));
    if (!curName) sel.append(h("option", { value: "", selected: true }, "Pick a window"));
    for (const w of windowsCache) sel.append(h("option", { value: String(w.id), selected: w.title === curName }, `${w.title} (${w.process})`));
  };
  const refresh = async () => { try { windowsCache = await bridge.call("listWindows") || []; } catch { windowsCache = []; } fill(); };
  sel.addEventListener("change", () => {
    const w = windowsCache.find((x) => String(x.id) === sel.value); if (!w) return;
    set({ capWindowId: w.id, capWindow: w.title, capProcess: w.process });
    S.lcd.capWindow = w.title; S.lcd.capProcess = w.process;
    toast(`Mirroring ${w.title}`);
  });
  fill(); refresh();
  const cur = h("input", { type: "checkbox", checked: !!S.lcd.capCursor });
  cur.addEventListener("change", () => set({ capCursor: cur.checked }));
  return [
    h("div", { class: "field" }, h("span", { class: "label" }, "Window"), h("div", { class: "row", style: { gap: "8px" } }, sel, h("button", { class: "btn ghost", onclick: refresh }, "Refresh"))),
    h("p", { class: "muted small" }, "It keeps showing when other windows cover it. Minimised windows pause."),
    h("label", { class: "row between" }, h("span", { class: "muted" }, "Show the mouse pointer"), h("span", { class: "switch" }, cur)),
    h("p", { class: "muted small mirror-status" }, mirrorStatus),
  ];
}

// Fit, zoom and position for pictures and videos (also used for what gets saved into the pump).
function mediaFitControls(set) {
  const fit = h("div", { class: "seg", role: "group" });
  for (const [k, label] of [["cover", "Fill"], ["contain", "Whole picture"], ["stretch", "Stretch"]])
    fit.append(h("button", { "aria-pressed": String((S.lcd.fit || "cover") === k), onclick: () => { set({ fit: k }); renderLcd(); } }, label));
  const slider = (key, label, min, max, unit, def) => {
    const v = S.lcd[key] ?? def;
    const out = h("span", { class: "num muted" }, v + unit);
    const r = h("input", { class: "slider", type: "range", min, max, value: v }); sliderFill(r);
    r.addEventListener("input", () => { sliderFill(r); out.textContent = r.value + unit; set({ [key]: +r.value }); });
    return h("div", { class: "field" }, h("div", { class: "row between" }, h("span", { class: "label" }, label), out), r);
  };
  const bg = h("input", { type: "color", class: "swatch", value: S.lcd.bg || "#000000" });
  bg.addEventListener("input", () => set({ bg: bg.value }));
  return [
    h("div", { class: "field" }, h("span", { class: "label" }, "Fit"), fit),
    slider("zoom", "Zoom", 25, 300, "%", 100),
    h("div", { class: "nf-grid" }, slider("offX", "Move left / right", -50, 50, "%", 0), slider("offY", "Move up / down", -50, 50, "%", 0)),
    h("div", { class: "row between" }, h("span", { class: "muted" }, "Background, where the picture doesn't reach"), bg),
  ];
}

// Pictures stored inside the pump: they show even when the PC is off or Monarch isn't running.
// Each has its own fit, zoom and position; the rotation is the pump's mounting, shared with the live screen.
const pumpPicks = {};
const LOOK_DEFAULT = { fit: "cover", zoom: 100, offX: 0, offY: 0, bg: "#000000" };
function pumpLook(kind) { return { ...LOOK_DEFAULT, ...(S.lcd[kind + "Look"] || {}) }; }

// Places the picked picture in a round preview the same way Monarch renders it for the pump.
function placePumpPreview(box, img, look) {
  const S0 = box.clientWidth || 150, k = S0 / 480;
  const iw = img.naturalWidth || 480, ih = img.naturalHeight || 480;
  let w, hh;
  if (look.fit === "stretch") { w = 480; hh = 480; }
  else { const sc = look.fit === "contain" ? Math.min(480 / iw, 480 / ih) : Math.max(480 / iw, 480 / ih); w = iw * sc; hh = ih * sc; }
  const z = Math.max(10, look.zoom || 100) / 100; w *= z; hh *= z;
  const dx = (look.offX || 0) / 100 * 480, dy = (look.offY || 0) / 100 * 480;
  box.style.background = look.bg || "#000";
  Object.assign(img.style, { width: w * k + "px", height: hh * k + "px",
    transform: `rotate(${S.lcd.rotation || 0}deg) translate(${(-w / 2 + dx) * k}px, ${(-hh / 2 + dy) * k}px)` });
}

function renderPumpStore() {
  const box = $("#pump-store"); if (!box) return; box.innerHTML = "";
  const slot = (kind, title, sub, current) => {
    const p = pumpPicks[kind];
    const look = pumpLook(kind);
    const prog = h("div", { class: "upbar", hidden: !p?.busy }, h("i", { style: { width: (p?.pct || 0) + "%" } }));
    const status = h("p", { class: "muted small" }, p?.msg || (current ? `On the pump now: ${current}` : "Nothing saved from Monarch yet."));
    let prev;
    if (p?.url || p?.preview) {
      const img = h("img", { alt: "", src: p.url || p.preview, draggable: "false" });
      prev = h("div", { class: "pump-prev" }, img);
      img.addEventListener("load", () => placePumpPreview(prev, img, pumpLook(kind)));
      requestAnimationFrame(() => { if (img.complete) placePumpPreview(prev, img, pumpLook(kind)); });
    } else prev = h("div", { class: "pump-prev empty" });
    const pick = h("button", { class: "btn", disabled: !!p?.busy, onclick: async () => {
      const r = await bridge.call("pickPumpFile", kind);
      if (!r) { if (!bridge.live) toast("Picking a file works in the app."); return; }
      if (r.error) { toast(r.error); return; }
      pumpPicks[kind] = { ...r, msg: kind === "boot" ? `${r.name}: ${r.frames} frame${r.frames > 1 ? "s" : ""}, ${r.frameMs} ms each` : r.name };
      renderPumpStore();
    } }, p?.name ? "Choose another" : "Choose file");
    const save = h("button", { class: "btn primary", disabled: !p?.name || !!p?.busy, onclick: async () => {
      pumpPicks[kind] = { ...p, busy: true, pct: 0, msg: "Preparing" }; renderPumpStore();
      const r = await bridge.call("savePumpFile", kind);
      if (!r?.ok) { pumpPicks[kind] = { ...p, busy: false, msg: r?.message || "Couldn't start" }; renderPumpStore(); }
    } }, p?.busy ? "Saving…" : "Save to pump");

    // fit, zoom and position for this picture only
    const controls = [];
    if (p?.name && !p.busy) {
      const setLook = (patch, rerender) => {
        const next = { ...pumpLook(kind), ...patch };
        S.lcd[kind + "Look"] = next;
        const img = $("img", prev); if (img) placePumpPreview(prev, img, next);
        clearTimeout(setLook.t); setLook.t = setTimeout(() => bridge.call("setLcd", { [kind + "Look"]: next }), 120);
        if (rerender) renderPumpStore();
      };
      const fit = h("div", { class: "seg small", role: "group" });
      for (const [k2, label] of [["cover", "Fill"], ["contain", "Whole picture"], ["stretch", "Stretch"]])
        fit.append(h("button", { "aria-pressed": String(look.fit === k2), onclick: () => setLook({ fit: k2 }, true) }, label));
      const slider = (key, label, min, max, unit) => {
        const out = h("span", { class: "num muted small" }, look[key] + unit);
        const r = h("input", { class: "slider", type: "range", min, max, value: look[key] }); sliderFill(r);
        r.addEventListener("input", () => { sliderFill(r); out.textContent = r.value + unit; setLook({ [key]: +r.value }); });
        return h("div", { class: "field" }, h("div", { class: "row between" }, h("span", { class: "label" }, label), out), r);
      };
      const bg = h("input", { type: "color", class: "swatch", value: look.bg || "#000000", title: "Background, where the picture doesn't reach" });
      bg.addEventListener("input", () => setLook({ bg: bg.value }));
      controls.push(h("div", { class: "pump-look" },
        h("div", { class: "row between" }, fit, h("label", { class: "row small muted", style: { gap: "8px" } }, "Background", bg)),
        slider("zoom", "Zoom", 25, 300, "%"),
        h("div", { class: "nf-grid" }, slider("offX", "Move left / right", -50, 50, "%"), slider("offY", "Move up / down", -50, 50, "%")),
        h("button", { class: "btn ghost small", onclick: () => setLook({ ...LOOK_DEFAULT }, true) }, "Reset")));
    }
    return h("div", { class: "pump-slot" }, prev,
      h("div", { class: "grow stack", style: { gap: "10px" } }, h("b", {}, title), h("p", { class: "muted small" }, sub), status, prog,
        ...controls, h("div", { class: "row", style: { gap: "8px" } }, pick, save)));
  };
  box.append(h("div", { class: "row between" }, h("h2", {}, "Saved on the pump"), h("span", { class: "muted small" }, "Each picture has its own fit and position. Rotation follows the setting above.")),
    h("p", { class: "muted" }, "These live inside the pump. They show while the PC boots and whenever Monarch isn't driving the screen."),
    h("div", { class: "pump-slots" },
      slot("boot", "Boot animation", "A GIF or picture that plays when the PC starts. Up to about 10 MB once packed.", S.lcd.bootFile),
      slot("standby", "Standby picture", "One still picture: the pump stores a single image here, so a GIF keeps its first frame. Shows when nothing is driving the screen, like after Monarch closes.", S.lcd.standbyFile)));
}

// ---------------------------------------------------------------- mouse
// How the mouse is linked right now. The engine reports "dongle", "bluetooth" or "wired". An older
// engine only says whether it is wired, and "wireless" alone can't tell the dongle from Bluetooth,
// so that case stays unnamed rather than guessed.
const LINKS = {
  dongle: { name: "2.4 GHz dongle", sub: "Wireless, through the 2.4 GHz USB dongle." },
  bluetooth: { name: "Bluetooth", sub: "Wireless, over Bluetooth." },
  wired: { name: "USB cable", sub: "Wired, through the USB cable." },
  wireless: { name: "Wireless", sub: "Wireless." },
};
function mouseLink(m) {
  if (!m?.connected) return null;
  if (LINKS[m.connection]) return m.connection;
  return m.wireless === false ? "wired" : "wireless";
}
const POLL_NOTE = {
  dongle: "How often the mouse reports its position. 1000 Hz is the most this dongle supports.",
  bluetooth: "Over Bluetooth, Windows and the mouse agree on the rate between themselves, usually well below 1000 Hz, so it can't be set here. Switch to the dongle or the cable to choose it.",
  other: "How often the mouse reports its position. 1000 Hz is the most it supports.",
};

// The low battery warning is sent by the engine, so it still arrives when this window is closed.
// The page only shows the level and changes the setting. This copy keeps the slider where it was
// put when the engine doesn't report the setting back.
let alertLocal = { on: true, at: 20 };
const battAlert = () => S?.mouse?.batteryAlert || alertLocal;
function battInfo(m) {
  if (!m?.connected || m.battery == null) return null;
  const pct = Math.max(0, Math.min(100, Math.round(m.battery)));
  const charging = !!m.charging;
  const low = !charging && pct <= battAlert().at, critical = !charging && pct <= 10;
  return { pct, charging, full: charging && pct >= 100, low, critical, tone: charging ? "charge" : critical ? "crit" : low ? "low" : "" };
}

// Everything the battery and link show, updated in place: this runs on every mouse update, on
// any page, so it never rebuilds the slider (a reading that lands mid-drag would drop it).
const battAt = $("#batt-at"), battOn = $("#batt-on");
let battDragging = false;
function renderBattery() {
  const m = S?.mouse || {}, b = battInfo(m), link = mouseLink(m), al = battAlert();
  const tone = b?.tone || "";

  // page head: the link, and the battery next to it
  const status = $("#mouse-status"); status.innerHTML = "";
  status.append(h("i", { class: "dot" + (link ? "" : " off") }), link ? LINKS[link].name : "Not found");
  status.title = link ? "Connected" : "";
  $("#mouse-sub").textContent = link ? LINKS[link].sub : "Turn the mouse on, or move it to wake it. It connects through the dongle, Bluetooth or the cable.";
  const pill = $("#mouse-batt");
  pill.hidden = !b; pill.dataset.tone = tone;
  if (b) {
    $("#mouse-batt-pct").textContent = b.pct + "%";
    pill.title = b.full ? "Fully charged" : b.charging ? "Charging" : "Battery";
    pill.querySelector(".b-lvl").setAttribute("width", b.pct ? Math.max(1, 18 * b.pct / 100).toFixed(2) : 0);
  }

  // title bar, on every page but the rig (the rig lists it with the vitals)
  $("#ro-mouse-wrap").hidden = !b;
  if (b) { const ro = $("#ro-mouse"); ro.textContent = b.pct + "%"; ro.classList.toggle("hot", b.low || b.critical); }

  // battery card
  const card = $("#batt-card");
  card.dataset.tone = tone;
  $("#batt-num").textContent = b ? b.pct : "--";
  const bar = $("#batt-bar");
  bar.style.setProperty("--pct", (b ? b.pct : 0) + "%");
  const state = $("#batt-state"); state.innerHTML = "";
  const [dot, label] = !link ? ["off", "Not connected"] : !b ? ["off", "Not read yet"] : b.full ? ["", "Full"] : b.charging ? ["", "Charging"] : b.low || b.critical ? ["warn", "Low"] : ["", "On battery"];
  state.append(h("i", { class: "dot" + (dot ? " " + dot : "") }), label);
  const note = !link ? "Turn the mouse on, or move it to wake it."
    : !b ? "The mouse hasn't reported its battery yet."
    : b.full ? "Fully charged. You can unplug the cable."
    : b.charging ? (link === "wired" ? "Charging through the USB cable." : "Charging.")
    : b.critical ? "Almost empty. Plug in the USB cable; the mouse keeps working while it charges."
    : b.low ? "Below your warning level. Plug in the USB cable to charge it; the mouse keeps working while it charges."
    : "";
  const noteEl = $("#batt-note"); noteEl.textContent = note; noteEl.hidden = !note;

  // the warning setting
  if (!battDragging) { battAt.value = al.at; sliderFill(battAt); }
  showAlertLevel(battDragging ? +battAt.value : al.at, al.on);
  battOn.checked = al.on;
  battAt.disabled = !al.on;
}
function showAlertLevel(at, on) {
  $("#batt-at-val").textContent = at + "%";
  const bar = $("#batt-bar");
  bar.style.setProperty("--at", at + "%");
  bar.classList.toggle("no-mark", !on);
}
async function commitAlert(patch) {
  const next = { ...battAlert(), ...patch };
  alertLocal = next;
  if (S.mouse) S.mouse.batteryAlert = next;
  renderBattery(); renderVitalsMouse();
  try { const r = await bridge.call("setBatteryAlert", next); if (r?.message) toast(r.message); }
  catch { toast("This version of Monarch can't send low battery warnings yet."); }
}
// While the thumb is held, readings leave the slider alone. The browser sends "change" after the
// pointer is released, so the flag is cleared a moment later, not on release itself.
battAt.addEventListener("pointerdown", () => (battDragging = true));
window.addEventListener("pointerup", () => { if (battDragging) setTimeout(() => (battDragging = false)); });
battAt.addEventListener("input", () => { sliderFill(battAt); showAlertLevel(+battAt.value, battOn.checked); });
battAt.addEventListener("change", () => { battDragging = false; commitAlert({ at: +battAt.value }); });
battOn.addEventListener("change", () => commitAlert({ on: battOn.checked }));
$("#batt-test").addEventListener("click", async () => {
  try { const r = await bridge.call("testBatteryAlert"); toast(r?.message || "Sent a test notification. If nothing appears, check that Do not disturb is off in Windows."); }
  catch { toast("This version of Monarch can't send notifications yet."); }
});

let editStage = 2;
function renderMouse() {
  const m = S.mouse;
  renderBattery();
  const st = $("#dpi-stages"); st.innerHTML = "";
  m.stages.forEach((s, i) => st.append(h("button", { class: "tile stg", "data-off": String(!s.enabled), "aria-pressed": String(i === editStage), onclick: () => { editStage = i; renderMouse(); } },
    h("div", { class: "dpi" }, s.dpi.toLocaleString(), h("small", {}, "dpi")),
    h("div", { class: "foot" }, h("span", {}, i === m.active ? "In use" : s.enabled ? `Stage ${i + 1}` : "Off"), h("i", { class: "chip", style: { background: s.color, color: s.color } })))));
  const s = m.stages[editStage];
  const ed = $("#dpi-editor"); ed.innerHTML = "";
  const commit = async (patch) => { Object.assign(s, patch); renderMouse(); renderVitalsMouse(); const r = await bridge.call("setStage", editStage, patch); if (r && r.message) toast(r.message); };
  const num = h("input", { class: "text num", type: "number", min: 50, max: 26000, step: 50, value: s.dpi });
  const r = h("input", { class: "slider", type: "range", min: 50, max: 26000, step: 50, value: s.dpi, style: { flex: 1 } }); sliderFill(r);
  r.addEventListener("input", () => { sliderFill(r); num.value = r.value; });
  r.addEventListener("change", () => commit({ dpi: +r.value }));
  num.addEventListener("change", () => { const v = Math.round(Math.max(50, Math.min(26000, +num.value)) / 50) * 50; commit({ dpi: v }); });
  const col = h("input", { type: "color", class: "swatch", value: s.color, title: "Stage colour" });
  col.addEventListener("change", () => commit({ color: col.value }));
  const en = h("input", { type: "checkbox", checked: s.enabled, disabled: editStage !== 4 });
  en.addEventListener("change", () => commit({ enabled: en.checked }));
  ed.append(h("b", { style: { minWidth: "70px" } }, `Stage ${editStage + 1}`), r, num, col,
    h("label", { class: "row muted", style: { gap: "8px" }, title: editStage === 4 ? "" : "The mouse needs stages 1 to 4 on" }, "On", h("span", { class: "switch" }, en)),
    h("button", { class: "btn", disabled: editStage === m.active || !s.enabled, onclick: async () => { m.active = editStage; renderMouse(); renderVitalsMouse(); const r = await bridge.call("setActiveStage", editStage); if (r && r.message) toast(r.message); } }, editStage === m.active ? "In use" : "Use now"));

  // Over Bluetooth the rate is the Bluetooth link's, not a setting of the mouse.
  const link = mouseLink(m), bt = link === "bluetooth";
  $("#poll-note").textContent = bt ? POLL_NOTE.bluetooth : link === "dongle" ? POLL_NOTE.dongle : POLL_NOTE.other;
  const poll = $("#poll"); poll.innerHTML = "";
  for (const hz of [125, 250, 500, 1000]) poll.append(h("button", { "aria-pressed": String(!bt && m.polling === hz), disabled: bt, onclick: async () => { m.polling = hz; renderMouse(); renderVitalsMouse(); const r = await bridge.call("setPolling", hz); if (r && r.message) toast(r.message); } }, hz + " Hz"));

}
function renderVitalsMouse() { if (lastTelemetry) renderVitals(lastTelemetry); }

// ---------------------------------------------------------------- wallpaper
let wallBusy = false, wallImport = null;
async function setWall(w) {
  if (wallBusy) return;
  wallBusy = w.id; renderWalls();
  let r;
  try { r = await bridge.call("setWallpaper", w.id); } catch (e) { r = { ok: false, message: String(e.message || e) }; }
  wallBusy = false;
  if (r?.state) S.wallpaper = r.state;
  renderWalls();
  toast(r?.ok ? `Wallpaper: ${w.title}` : (r?.message || "That wallpaper didn't start"));
}

function renderWalls() {
  const W = S.wallpaper; if (!W) return;
  const A = $("#wall-actions"); A.innerHTML = "";
  const status = W.on ? (W.paused ? "Paused while something is fullscreen" : W.status || "Showing") : "Windows wallpaper";
  A.append(h("span", { class: "wall-status" }, h("i", { class: "dot" + (W.on ? "" : " off") }), status),
    h("button", { class: "btn", onclick: async () => {
      const r = await bridge.call("addWallpaper");
      if (r?.state) { S.wallpaper = r.state; renderWalls(); }
      if (r?.message) toast(r.message); else if (r?.ok) toast("Added. Click it to put it on the desktop.");
      else if (!bridge.live) toast("Adding files works in the app.");
    } }, "Add wallpapers"),
    ...[W.on ? h("button", { class: "btn ghost", onclick: async () => { S.wallpaper = await bridge.call("stopWallpaper"); renderWalls(); toast("Back to the Windows wallpaper"); } }, "Stop") : null].filter(Boolean));

  const I = $("#wall-import"); I.innerHTML = "";
  if (W.livelyFound > 0 && (W.livelyImported === 0 || wallImport)) {
    const prog = wallImport ? h("div", { class: "upbar" }, h("i", { style: { width: Math.round((wallImport.i / Math.max(1, wallImport.total)) * 100) + "%" } })) : null;
    I.append(h("div", { class: "box card stack" },
      h("div", { class: "row between" },
        h("div", {}, h("b", {}, `Bring over your Lively library (${W.livelyFound} wallpapers)`),
          h("p", { class: "muted", style: { marginTop: "4px" } }, wallImport ? `Copying ${wallImport.title}` : "Monarch copies them into its own library and takes over the one Lively is showing. After that you can uninstall Lively.")),
        h("button", { class: "btn primary" + (wallImport ? " busy" : ""), disabled: !!wallImport, onclick: async () => {
          wallImport = { i: 0, total: W.livelyFound, title: "" }; renderWalls();
          let r; try { r = await bridge.call("importLively"); } catch (e) { r = null; }
          wallImport = null;
          if (r?.state) S.wallpaper = r.state;
          renderWalls();
          toast(r ? (r.took ? `Brought over ${r.count}. Now showing ${r.took}` : `Brought over ${r.count} wallpapers`) : "Couldn't copy Lively's library");
        } }, wallImport ? "Copying…" : "Bring them over")),
      prog));
  }

  const O = $("#wall-options"); O.innerHTML = "";
  const opt = async (patch) => { Object.assign(W, patch); const r = await bridge.call("setWallOptions", patch); if (r) { S.wallpaper = r; renderWalls(); } };
  const fit = h("div", { class: "seg", role: "group" });
  for (const [k, label] of [["fill", "Fill"], ["fit", "Fit"], ["stretch", "Stretch"]]) fit.append(h("button", { "aria-pressed": String(W.fit === k), onclick: () => opt({ fit: k }) }, label));
  const pause = h("input", { type: "checkbox", checked: W.pauseFullscreen }); pause.addEventListener("change", () => opt({ pauseFullscreen: pause.checked }));
  const sound = h("input", { type: "checkbox", checked: W.sound }); sound.addEventListener("change", () => opt({ sound: sound.checked }));
  const mons = W.monitors || [];
  const mon = mons.length > 1 ? h("select", { class: "select" }, mons.map((m) => h("option", { value: m.id, selected: m.id === W.monitor || (!W.monitor && m.name.endsWith("main")) }, m.name))) : null;
  if (mon) mon.addEventListener("change", () => opt({ monitor: mon.value }));
  O.append(h("div", { class: "field" }, h("span", { class: "label" }, "Fit"), fit),
    h("label", { class: "row between" }, h("span", {}, h("b", {}, "Pause while a game or app is fullscreen"), h("p", { class: "muted small" }, "Saves GPU time. It also rests while the PC is locked or the screen is off.")), h("span", { class: "switch" }, pause)),
    h("label", { class: "row between" }, h("span", {}, h("b", {}, "Sound"), h("p", { class: "muted small" }, "For videos and web wallpapers that have audio.")), h("span", { class: "switch" }, sound)),
    ...[mon ? h("div", { class: "field" }, h("span", { class: "label" }, "Display"), mon) : null].filter(Boolean));

  const G = $("#walls"); G.innerHTML = "";
  for (const w of W.items) {
    const cur = W.on && w.id === W.current;
    const tile = h("div", { class: "wall-tile" },
      h("button", { class: "tile wall", "aria-pressed": String(cur), onclick: () => setWall(w) },
        h("div", { class: "thumb", style: { backgroundImage: w.thumb ? `url("${w.thumb}")` : "" } }, wallBusy === w.id ? h("span", { class: "thumb-busy" }, "Starting…") : null),
        h("div", { class: "meta" }, h("b", {}, w.title), h("span", { class: "muted" }, cur ? "On the desktop" : { video: "Video", picture: "Picture", web: "Web" }[w.type] || w.type))),
      iconBtn("x", "Remove from the library", async () => { S.wallpaper = await bridge.call("removeWallpaper", w.id); renderWalls(); toast(`Removed ${w.title}`); }, { class: "icon-btn wall-x" }));
    G.append(tile);
  }
  if (!W.items.length) G.append(h("div", { class: "box card" }, h("b", {}, "No wallpapers yet"), h("p", { class: "muted" }, W.livelyFound ? "Bring over your Lively library above, or add your own files." : "Add a video, GIF, picture or an HTML wallpaper's index.html.")));
}

// ---------------------------------------------------------------- settings
function renderSettings() {
  const g = $("#set-general"); g.innerHTML = "";
  const sw = (key, title, sub) => { const c = h("input", { type: "checkbox", checked: !!S.settings[key] }); c.addEventListener("change", () => { S.settings[key] = c.checked; bridge.call("setSetting", key, c.checked); }); return h("div", { class: "set-row" }, h("div", {}, h("b", {}, title), h("p", {}, sub)), h("span", { class: "switch" }, c)); };
  g.append(h("h2", { style: { marginBottom: "6px" } }, "General"),
    sw("startup", "Start with Windows", "Fan curves and the motherboard lights start with Windows, before you sign in. The full app opens the moment you sign in, with the rights fan control needs and no prompt."),
    sw("startMinimized", "Start in the tray", "Lights, fans and the pump screen run without opening this window."),
    sw("closeToTray", "Closing keeps Monarch running", "The close button hides the window. Quit from the tray icon."),
    sw("autoCloseConflicts", "Close conflicting apps at start", "Quits the apps listed under Other apps when Monarch starts, so they can't grab your devices."),
    sw("fanControl", "Let Monarch control fans", "Off hands every fan header back to your BIOS curve."),
    h("div", { class: "set-row" }, h("div", {}, h("b", {}, "Logs"), h("p", {}, `Version ${S.version}. Useful when something doesn't work.`)), h("button", { class: "btn", onclick: () => bridge.call("openLogs") }, "Open logs folder")));

  const C = $("#set-conflicts"); C.innerHTML = "";
  const list = S.settings.conflicts || [];
  C.append(h("h2", {}, "Other apps"),
    h("p", { class: "muted", style: { margin: "6px 0 4px" } }, list.length
      ? "These are on this PC and can take over hardware Monarch drives. Only one app can drive a device, so close them while Monarch runs. Once everything works the way you want, you can uninstall them."
      : "No other lighting, fan, pump screen or wallpaper app that could take over your devices is on this PC."));
  for (const c of list) C.append(h("div", { class: "set-row" },
    h("div", {}, h("b", {}, c.name), h("p", {}, c.note)),
    c.running ? h("button", { class: "btn", onclick: async () => { await bridge.call("closeConflict", c.id); c.running = false; renderSettings(); renderConflictBadge(); } }, "Close it") : h("span", { class: "pill" }, h("i", { class: "dot off" }), "Not running")));
  if (S.settings.signalEffects)
    C.append(h("div", { class: "set-row" }, h("div", {}, h("b", {}, "Bring over your SignalRGB effects"), h("p", {}, "Copies the effects already on this PC into Monarch, so you keep them after uninstalling SignalRGB.")), h("button", { class: "btn", onclick: async () => { const r = await bridge.call("importSignalEffects"); toast(r?.message || "Done"); if (r?.ok) { S = await bridge.call("getState"); renderLibrary(); } } }, "Import")));
}
function renderConflictBadge() {}

// ---------------------------------------------------------------- lighting: tabs
let lightTab = "effects";
const TAB_SUB = {
  effects: "One effect paints every device.",
  layout: "Every light shows the part of the effect under it. With Screen ambience, that is the part of your screen under it.",
  devices: "What Monarch found, and what is plugged into each header.",
};
function showTab(tab) {
  lightTab = tab;
  if (finder && tab !== "devices") { finder = null; bridge?.call("probeEnd").catch(() => {}); }
  $$("#light-tabs [role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  $$("#view-lighting .tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + tab));
  $("#light-sub").textContent = TAB_SUB[tab];
  if (!bridge) return;
  bridge.call("previewSize", tab === "layout" ? 160 : 64, tab === "layout" ? 100 : 40).catch(() => {});
  if (tab === "layout") {
    ensureEditor(); renderLayoutsCard(); renderSelection(); renderPartsList(); renderScreenCard();
    bridge.call("getCapture").then((c) => { if (c) { S.capture = c; renderScreenCard(); } }).catch(() => {});
  }
  if (tab === "devices") renderDevicesTab();
}
$$("#light-tabs [role=tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

function syncBrightness() {
  for (const id of ["#now-bright", "#light-bright"]) { const r = $(id); r.value = S.lighting.brightness; sliderFill(r); }
  $("#light-bright-v").textContent = S.lighting.brightness + "%";
}
$("#light-bright").addEventListener("input", (e) => { S.lighting.brightness = +e.target.value; syncBrightness(); bridge.call("setBrightness", S.lighting.brightness); });

// ---------------------------------------------------------------- lighting: layout editor
let editor, selIds = [];
const activeLayout = () => S.setup.layouts.find((l) => l.name === S.setup.active) || S.setup.layouts[0];
const partById = (id) => S.setup.parts.find((p) => p.id === id);
const placeById = (id) => activeLayout().items.find((p) => p.id === id);
// Parts you can place: they have LEDs (or are the pump's screen) and sit on a device Monarch is talking to right now.
function placeable(p) {
  if (!(p.leds > 0) && p.kind !== "pump") return false;
  return S.setup.devices.some((d) => d.parts.some((q) => q.id === p.id));
}
const skipIds = () => new Set(S.setup.parts.filter((p) => !placeable(p)).map((p) => p.id));
const ICON = {
  undo: "M7 5 3 9l4 4M3 9h9a5 5 0 0 1 0 10h-2", redo: "M13 5l4 4-4 4M17 9H8a5 5 0 0 0 0 10h2",
  rot: "M15.5 8A6 6 0 1 0 16 12M16 3v5h-5", flip: "M10 2v16M7 5 3 15h4zM13 5l4 10h-4z",
  eye: "M2 10s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6zM10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  eyeOff: "M3 3l14 14M8.6 4.2A8 8 0 0 1 10 4c5 0 8 6 8 6a14 14 0 0 1-2.4 3.1M12.1 15.6A7 7 0 0 1 10 16c-5 0-8-6-8-6a14 14 0 0 1 3.3-3.8",
  plus: "M10 4v12M4 10h12", copy: "M7 7h9v9H7zM4 13V4h9", pen: "M4 16l1-4 8-8 3 3-8 8zM12 5l3 3", trash: "M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10",
  up: "M10 15V5M5 10l5-5 5 5", down: "M10 5v10M5 10l5 5 5-5", x: "M5 5l10 10M15 5 5 15", bulb: "M10 2a5 5 0 0 0-3 9v2h6v-2a5 5 0 0 0-3-9zM8 16h4",
};
const iconBtn = (icon, title, onclick, extra = {}) => h("button", { class: "icon-btn", title, "aria-label": title, onclick, ...extra }, svgIcon(ICON[icon]));

function ensureEditor() {
  if (!editor) {
    editor = new LayoutEditor($("#editor"), {
      onChange: (items, final) => {
        const lay = activeLayout();
        lay.items = JSON.parse(JSON.stringify(items));
        rigStale = true;
        bridge.call("setPlacements", lay.name, items);
        if (final) { renderSelection(); renderPartsList(); } else updateSelectionFields();
      },
      onSelect: (ids) => { selIds = ids; renderSelection(); renderPartsList(); },
    });
    renderEdBar();
    applyEdBackground();
  }
  editor.setData(S.setup.parts, activeLayout().items, skipIds());
}

// How strongly the effect shows behind the parts.
const store = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
let edOpacity = +store.get("ed-opacity", 100);
function applyEdBackground() { if (editor) editor.setOpacity(edOpacity / 100); }
function edBgControls() {
  const r = h("input", { class: "slider", type: "range", min: 0, max: 100, value: edOpacity, "aria-label": "Effect opacity behind the parts" });
  sliderFill(r);
  r.addEventListener("input", () => { sliderFill(r); edOpacity = +r.value; store.set("ed-opacity", r.value); applyEdBackground(); });
  return h("label", { class: "row ed-bgctl", style: { gap: "10px" } }, h("span", { class: "muted small" }, "Effect behind"), r);
}

function renderEdBar() {
  const bar = $("#ed-bar"); bar.innerHTML = "";
  const act = (fn) => () => { if (!selIds.length) { toast("Pick a part first"); return; } editor.edit(fn); renderSelection(); };
  bar.append(
    h("div", { class: "row", style: { gap: "6px" } },
      iconBtn("undo", "Undo (Ctrl+Z)", () => editor.undo()),
      iconBtn("redo", "Redo (Ctrl+Y)", () => editor.redo()),
      h("i", { class: "sep" }),
      iconBtn("rot", "Rotate 90°", act((it) => { it.rot = ((it.rot || 0) + 90) % 360; })),
      iconBtn("flip", "Mirror (for fans mounted the other way)", act((it) => { it.flip = !it.flip; })),
      iconBtn("eyeOff", "Hide from the canvas (Delete)", act((it) => { it.hidden = true; })),
      h("i", { class: "sep" }),
      testBtn(),
      h("i", { class: "sep" }),
      edBgControls()),
    h("p", { class: "muted ed-hint" }, "Drag to move. Corners resize freely, edges stretch one way, Shift keeps the shape. The top dot rotates. Shift+click or drag a box to pick several. Alt snaps."));
}

// Side to side test: swaps in the sweep effect, and back again.
let effectBeforeTest = null;
function testBtn() {
  const b = h("button", { class: "btn small", id: "ed-test", onclick: async () => {
    if (S.lighting.effect === "sweep.html" && effectBeforeTest) { const back = effectBeforeTest; effectBeforeTest = null; await pickEffect(back); }
    else { effectBeforeTest = S.lighting.effect; await pickEffect("sweep.html"); }
    syncTestBtn();
  } });
  setTimeout(syncTestBtn, 0);
  return b;
}
function syncTestBtn() { const b = $("#ed-test"); if (b) b.textContent = S.lighting.effect === "sweep.html" && effectBeforeTest ? "Stop the test" : "Test with a sweep"; }

// ---- layouts card
let renaming = false;
function renderLayoutsCard() {
  const box = $("#ed-layouts") || $("#ed-side").appendChild(h("div", { class: "box card stack", id: "ed-layouts" }));
  ensureSideOrder();
  box.innerHTML = "";
  const lay = activeLayout();
  let head;
  if (renaming) {
    const t = h("input", { class: "text", value: lay.name, maxlength: 32 });
    const done = async (save) => { renaming = false; if (save && t.value.trim() && t.value.trim() !== lay.name) applySetup(await bridge.call("renameLayout", lay.name, t.value.trim())); else renderLayoutsCard(); };
    t.addEventListener("keydown", (e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); });
    head = h("div", { class: "row", style: { gap: "6px" } }, t, h("button", { class: "btn", onclick: () => done(true) }, "Save"));
    setTimeout(() => { t.focus(); t.select(); }, 0);
  } else {
    const sel = h("select", { class: "select grow" }, S.setup.layouts.map((l) => h("option", { value: l.name, selected: l.name === lay.name }, l.name)));
    sel.addEventListener("change", async () => applySetup(await bridge.call("setActiveLayout", sel.value)));
    head = h("div", { class: "row", style: { gap: "6px" } }, sel,
      iconBtn("plus", "New layout from this one", async () => { renaming = true; applySetup(await bridge.call("newLayout", lay.name + " copy", lay.name)); }),
      iconBtn("pen", "Rename", () => { renaming = true; renderLayoutsCard(); }),
      iconBtn("trash", "Delete this layout", async () => {
        if (S.setup.layouts.length < 2) { toast("Keep at least one layout"); return; }
        applySetup(await bridge.call("deleteLayout", lay.name)); toast(`Deleted ${lay.name}`);
      }));
  }
  const out = h("span", { class: "num muted" }, lay.brightness + "%");
  const br = h("input", { class: "slider", type: "range", min: 0, max: 100, value: lay.brightness });
  sliderFill(br);
  br.addEventListener("input", () => { sliderFill(br); out.textContent = br.value + "%"; lay.brightness = +br.value; bridge.call("setLayoutBrightness", lay.name, +br.value); });

  // tie this layout to effects, so it loads by itself
  const fx = S.lighting.effects.find((f) => f.id === S.lighting.effect);
  const linked = Object.entries(S.setup.effectLayouts || {}).filter(([, n]) => n === lay.name).map(([id]) => id);
  const chips = h("div", { class: "chips" }, linked.map((id) => {
    const name = S.lighting.effects.find((f) => f.id === id)?.name || id;
    return h("span", { class: "chip-tag" }, name, h("button", { title: "Stop loading with " + name, onclick: async () => { delete S.setup.effectLayouts[id]; S.setup.effectLayouts = await bridge.call("linkLayout", id, ""); renderLayoutsCard(); } }, svgIcon(ICON.x)));
  }));
  const linkBtn = fx && S.setup.effectLayouts?.[fx.id] !== lay.name
    ? h("button", { class: "btn ghost", onclick: async () => { S.setup.effectLayouts = await bridge.call("linkLayout", fx.id, lay.name); renderLayoutsCard(); toast(`${lay.name} now loads with ${fx.name}`); } }, `Load with ${fx.name}`)
    : null;
  box.append(h("div", { class: "row between" }, h("h3", {}, "Layout"), h("span", { class: "muted small" }, `${S.setup.layouts.length} saved`)), head,
    h("div", { class: "field" }, h("div", { class: "row between" }, h("span", { class: "label" }, "Layout brightness"), out), br),
    h("div", { class: "field" }, h("span", { class: "label" }, "Loads by itself with"), linked.length ? chips : h("p", { class: "muted small" }, "No effect yet. Linked effects switch to this layout when they start."), linkBtn));
}

function ensureSideOrder() {
  const side = $("#ed-side");
  for (const id of ["ed-layouts", "ed-selection", "ed-parts", "ed-screen"])
    if (!$("#" + id)) side.append(h("div", { class: "box card stack", id }));
}

// ---- selected part(s)
let selFields = null;
function renderSelection() {
  ensureSideOrder();
  const box = $("#ed-selection"); box.innerHTML = ""; selFields = null;
  const ids = selIds.filter((id) => placeById(id) && !placeById(id).hidden);
  if (!ids.length) {
    box.append(h("h3", {}, "Selection"), h("p", { class: "muted small" }, "Click a part on the canvas to move it, or drag a box around several. Ctrl+A picks everything."));
    return;
  }
  if (ids.length > 1) {
    box.append(h("div", { class: "row between" }, h("h3", {}, `${ids.length} parts`), h("button", { class: "btn ghost", onclick: () => editor.select([]) }, "Clear")),
      h("p", { class: "muted small" }, "Drag them together, or use the handles to resize and turn the whole group."),
      h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
        h("button", { class: "btn", onclick: () => identifyParts(ids) }, "Light them up"),
        h("button", { class: "btn", onclick: () => { editor.edit((it) => { it.hidden = true; }); editor.select([]); renderPartsList(); } }, "Hide")));
    return;
  }
  const id = ids[0], part = partById(id), pl = placeById(id);
  const numIn = (key, label, unit, get, put, step = 1) => {
    const t = h("input", { class: "text num", type: "number", step, value: get(pl) });
    t.addEventListener("change", () => { if (t.value === "") return; editor.edit((it) => put(it, +t.value), [id]); });
    return { el: h("label", { class: "nf" }, h("span", { class: "label" }, label), h("span", { class: "nf-in" }, t, h("i", {}, unit))), t, get };
  };
  const f = {
    x: numIn("x", "X", "", (p) => Math.round(p.x), (it, v) => { it.x = v; }),
    y: numIn("y", "Y", "", (p) => Math.round(p.y), (it, v) => { it.y = v; }),
    w: numIn("w", "Width", "%", (p) => Math.round((p.sx || p.scale || 1) * 100), (it, v) => { it.sx = Math.max(0.05, Math.min(12, v / 100)); }, 5),
    h: numIn("h", "Height", "%", (p) => Math.round((p.sy || p.scale || 1) * 100), (it, v) => { it.sy = Math.max(0.05, Math.min(12, v / 100)); }, 5),
    r: numIn("r", "Turn", "°", (p) => Math.round(p.rot || 0), (it, v) => { it.rot = ((v % 360) + 360) % 360; }, 15),
  };
  selFields = f;
  const mir = h("input", { type: "checkbox", checked: !!pl.flip });
  mir.addEventListener("change", () => editor.edit((it) => { it.flip = mir.checked; }, [id]));
  const title = renamingPart === "sel:" + id
    ? partNameInput(part, renderSelection)
    : h("div", { class: "row", style: { gap: "4px" } }, h("h3", { title: "Double-click to rename", ondblclick: () => { renamingPart = "sel:" + id; renderSelection(); } }, part.label || id),
        iconBtn("pen", "Rename", () => { renamingPart = "sel:" + id; renderSelection(); }));
  box.append(h("div", { class: "row between" }, title, h("span", { class: "muted small" }, part.kind === "pump" ? "Screen, no LEDs" : `${part.leds} LED${part.leds === 1 ? "" : "s"}`)),
    h("div", { class: "nf-grid" }, f.x.el, f.y.el, f.w.el, f.h.el, f.r.el,
      h("div", { class: "nf" }, h("span", { class: "label" }, "Same shape"), h("button", { class: "btn ghost small", onclick: () => editor.edit((it) => { const k = Math.max(it.sx, it.sy); it.sx = it.sy = k; }, [id]) }, "Square up"))),
    h("label", { class: "row between" }, h("span", { class: "muted" }, "Mirrored"), h("span", { class: "switch" }, mir)),
    h("div", { class: "row", style: { gap: "8px" } },
      h("button", { class: "btn", onclick: () => identifyParts([id]) }, "Light it up"),
      h("button", { class: "btn ghost", onclick: () => { editor.edit((it) => { it.hidden = true; }, [id]); editor.select([]); renderPartsList(); } }, "Hide")));
}
function updateSelectionFields() {
  if (!selFields || selIds.length !== 1) return;
  const pl = placeById(selIds[0]); if (!pl) return;
  for (const k in selFields) if (document.activeElement !== selFields[k].t) selFields[k].t.value = selFields[k].get(pl);
}
function identifyParts(ids) { ids.forEach((id, i) => setTimeout(() => bridge.call("identify", id), i * 40)); toast(ids.length > 1 ? "They flash white for 3 seconds" : "It flashes white for 3 seconds"); }

// ---- renaming a part in place: Enter or clicking away saves, Escape cancels
let renamingPart = null;
function partNameInput(p, after) {
  const t = h("input", { class: "text part-rename", value: p.label || "", maxlength: 24, "aria-label": "Name" });
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true; renamingPart = null;
    const v = t.value.trim();
    if (save && v && v !== p.label) { applySetup(await bridge.call("setPart", p.id, { label: v })); toast(`Renamed to ${v}`); }
    after();
  };
  t.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); e.stopPropagation(); });
  t.addEventListener("blur", () => finish(true));
  setTimeout(() => { t.focus(); t.select(); }, 0);
  return t;
}

// ---- parts list
function renderPartsList() {
  ensureSideOrder();
  const box = $("#ed-parts"); box.innerHTML = "";
  const lay = activeLayout();
  const setHidden = (ids, hidden) => { editor.edit((it) => { it.hidden = hidden; }, ids); renderPartsList(); renderSelection(); };
  const rows = S.setup.parts.filter(placeable).map((p) => {
    const pl = lay.items.find((q) => q.id === p.id); if (!pl) return null;
    const dev = S.setup.devices.find((d) => d.parts.some((q) => q.id === p.id));
    const eye = iconBtn(pl.hidden ? "eyeOff" : "eye", pl.hidden ? "Show on the canvas" : "Hide from the canvas", () => setHidden([p.id], !pl.hidden));
    const sub = h("span", { class: "muted small" }, `${dev ? dev.name : ""}${p.kind === "pump" ? "" : `, ${p.leds} LED${p.leds === 1 ? "" : "s"}`}`);
    if (renamingPart === p.id)
      return h("div", { class: "part-row on" }, eye, h("div", { class: "part-name editing" }, partNameInput(p, renderPartsList), sub));
    // click picks the part; clicking it again once it's picked renames it (like files in Explorer)
    const name = h("button", { class: "part-name", title: "Click to pick it, click again to rename", onclick: () => {
      if (selIds.length === 1 && selIds[0] === p.id && !pl.hidden) { renamingPart = p.id; renderPartsList(); return; }
      if (pl.hidden) setHidden([p.id], false); editor.select([p.id]);
    } }, h("b", {}, p.label || p.id), sub);
    return h("div", { class: "part-row" + (selIds.includes(p.id) ? " on" : "") + (pl.hidden ? " hidden" : "") },
      eye, name, iconBtn("pen", "Rename", () => { renamingPart = p.id; renderPartsList(); }, { class: "icon-btn part-pen" }));
  }).filter(Boolean);
  let confirmReset = false;
  const reset = h("button", { class: "btn ghost", onclick: async () => {
    if (!confirmReset) { confirmReset = true; reset.textContent = "Sure? Click again"; setTimeout(() => { confirmReset = false; reset.textContent = "Reset positions"; }, 3000); return; }
    applySetup(await bridge.call("resetPlacements")); editor.resetHistory(); toast("Parts are back where they sit in the rig drawing");
  } }, "Reset positions");
  box.append(h("div", { class: "row between" }, h("h3", {}, "Parts"), h("div", { class: "row", style: { gap: "4px" } },
      h("button", { class: "btn ghost small", onclick: () => setHidden(lay.items.filter((i) => placeable(partById(i.id) || {})).map((i) => i.id), false) }, "Show all"),
      h("button", { class: "btn ghost small", onclick: () => setHidden(lay.items.filter((i) => placeable(partById(i.id) || {})).map((i) => i.id), true) }, "Hide all"))),
    h("p", { class: "muted small" }, "Hidden parts stay dark. To check your layout, run the Side to side effect: the band should pass through your parts in the order they sit in the case."),
    h("div", { class: "part-list" }, rows), reset);
}

// ---- screen capture (what ambience watches)
function renderScreenCard() {
  ensureSideOrder();
  const box = $("#ed-screen"); box.innerHTML = "";
  const c = S.capture; if (!c) return;
  const save = async (patch) => { Object.assign(c, patch); const r = await bridge.call("setCapture", patch); if (r) { S.capture = r; status.textContent = r.status; drawTrim(); } };
  const mon = h("select", { class: "select" }, c.monitors.map((m) => h("option", { value: m.id, selected: m.id === c.monitor || (!c.monitor && m.name.endsWith("main")) }, m.name)));
  mon.addEventListener("change", () => save({ monitor: mon.value }));
  const seg = h("div", { class: "seg", role: "group" });
  for (const f of [20, 30, 60]) seg.append(h("button", { "aria-pressed": String(f === c.fps), onclick: (e) => { $$("button", seg).forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget))); save({ fps: f }); } }, f + " fps"));
  const status = h("p", { class: "muted small" }, c.status);
  const pic = h("div", { class: "trim-pic" }, h("div", { class: "trim-area" }));
  function drawTrim() { Object.assign($(".trim-area", pic).style, { left: c.left * 100 + "%", top: c.top * 100 + "%", right: c.right * 100 + "%", bottom: c.bottom * 100 + "%" }); }
  const trim = (key, label) => {
    const out = h("span", { class: "num muted" }, Math.round(c[key] * 100) + "%");
    const r = h("input", { class: "slider", type: "range", min: 0, max: 45, step: 1, value: Math.round(c[key] * 100) });
    sliderFill(r);
    r.addEventListener("input", () => { sliderFill(r); out.textContent = r.value + "%"; c[key] = r.value / 100; drawTrim(); });
    r.addEventListener("change", () => save({ [key]: r.value / 100 }));
    return h("div", { class: "field" }, h("div", { class: "row between" }, h("span", { class: "label" }, label), out), r);
  };
  box.append(h("h3", {}, "Screen"),
    h("p", { class: "muted small" }, "Screen ambience stretches this part of your screen across the canvas."),
    h("div", { class: "field" }, h("span", { class: "label" }, "Display"), mon),
    h("div", { class: "field" }, h("span", { class: "label" }, "Frame rate"), seg),
    h("div", { class: "field" }, h("span", { class: "label" }, "Watched area"), pic),
    h("div", { class: "trims" }, trim("left", "Trim left"), trim("right", "Trim right"), trim("top", "Trim top"), trim("bottom", "Trim bottom")),
    status);
  drawTrim();
}

// With nothing lit to draw, the rig page says what Monarch is waiting for instead of showing an empty frame.
function rigEmptyState() {
  const stage = $("#stage"); let e = $(".rig-empty", stage);
  const any = S.layout.some((p) => placeable(p));
  if (any) { e?.remove(); return; }
  if (!e) stage.append(h("div", { class: "rig-empty" }, h("b", {}, "Nothing lit to show yet"),
    h("p", { class: "muted" }, "Parts appear here as Monarch finds lights it can drive. Lighting > Devices lists what it supports; fans live on the Cooling page.")));
}

// The rig drawing shows the pump and the parts of devices Monarch is talking to.
function rigHidden() { return new Set(S.setup ? S.layout.filter((p) => !placeable(p)).map((p) => p.id) : []); }

// A new setup from C# (layouts, parts, devices).
function applySetup(setup) {
  if (!setup) return;
  S.setup = setup;
  S.layout = setup.parts;
  if (rig) rig.setLayout(S.layout, rigHidden(), activeLayout().items);
  rigEmptyState();
  if (editor) { editor.setData(S.setup.parts, activeLayout().items, skipIds()); }
  $("#dev-count").textContent = String(setup.devices.filter((d) => d.supported && d.connected).length);
  if (lightTab === "layout" && current === "lighting") { renderLayoutsCard(); renderSelection(); renderPartsList(); }
  if (lightTab === "devices" && current === "lighting") renderDevicesTab();
}

// ---------------------------------------------------------------- lighting: devices
const DEV_ICON = {
  argb: "M3 6h14v8H3zM6 6V3M10 6V3M14 6V3M6 17v-3M10 17v-3M14 17v-3",
  mouse: "M10 2a5 5 0 0 0-5 5v6a5 5 0 0 0 10 0V7a5 5 0 0 0-5-5zM10 2v5",
  lcd: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  gpu: "M2 6h16v8H2zM6 10h0M7 10a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0M15 10a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0M4 14v2",
  ram: "M2 7h16v6H2zM5 13v2M8 13v2M11 13v2M14 13v2M5 9h2M9 9h2M13 9h2",
  monitor: "M2 3h16v11H2zM7 17h6M10 14v3",
};
const SUPPORTED = [
  "Gigabyte motherboards with the IT5711 RGB controller: ARGB headers and onboard lights",
  "Thermaltake TH V2 Ultra AIOs: the round pump screen and its coolant sensor",
  "HyperX Pulsefire Haste 2 mice: DPI, polling rate and the logo light",
  "Colorful iGame graphics cards with lights",
  "Memory with ENE light controllers (needs PawnIO, from the Cooling page)",
  "Alienware monitors, through the monitor's USB cable",
  "Fan headers on most motherboards (needs PawnIO)",
];
function renderDevicesTab() {
  const grid = $("#dev-grid"); grid.innerHTML = "";
  for (const d of S.setup.devices) grid.append(deviceCard(d));
  grid.firstChild?.classList.add("main");
  if (!S.setup.devices.length) grid.append(h("div", { class: "box card stack" }, h("b", {}, "No lights found yet"),
    h("p", { class: "muted" }, "Lights show up here once Monarch is talking to them. It can drive:"),
    h("ul", { class: "muted small supported" }, SUPPORTED.map((x) => h("li", {}, x)))));
  if (S.setup.devices.some((d) => d.id === "argb" || d.id === "gpu" || d.id === "ram" || d.id === "monitor")) grid.append(powerCard());
}

function deviceCard(d) {
  const card = h("div", { class: "box card dev-card" + (d.supported === false ? " unsupported" : ""), "data-dev": d.id },
    h("div", { class: "dev-head" },
      h("span", { class: "dev-icon" }, svgIcon(DEV_ICON[d.id] || DEV_ICON.argb)),
      h("div", { class: "grow" }, h("h3", {}, d.name), h("p", { class: "muted small" }, d.detail)),
      d.supported === false ? h("span", { class: "pill" }, h("i", { class: "dot warn" }), "Not supported yet") : h("span", { class: "pill" }, h("i", { class: "dot" }), "Connected")));
  if (d.supported === false) return card;
  if (d.id === "monitor") card.append(h("p", { class: "muted small" }, "The logo, the size number and the power button take one colour: the colour under the monitor's box on the Layout tab. Close Alienware Command Center, or it takes them back."));
  if (d.id === "gpu") card.append(h("p", { class: "muted small" }, "The card's light takes one colour, the colour under its middle on the Layout tab."));
  if (d.id === "ram") card.append(h("p", { class: "muted small" }, "Each stick follows its own spot on the Layout tab."));
  if (d.id !== "lcd") {
    const on = h("input", { type: "checkbox", checked: !d.off });
    on.addEventListener("change", () => { d.off = !on.checked; bridge.call("setDevice", d.id, { off: d.off }); card.classList.toggle("is-off", d.off); });
    const out = h("span", { class: "num muted" }, d.brightness + "%");
    const br = h("input", { class: "slider", type: "range", min: 0, max: 100, value: d.brightness });
    sliderFill(br);
    br.addEventListener("input", () => { sliderFill(br); out.textContent = br.value + "%"; d.brightness = +br.value; bridge.call("setDevice", d.id, { brightness: +br.value }); });
    card.append(h("div", { class: "dev-bright" }, h("span", { class: "label" }, "Brightness"), br, out, h("span", { class: "switch", title: "Lights on" }, on)));
    if (d.off) card.classList.add("is-off");
  }
  if (d.id === "argb") card.append(...headerSections(d));
  if (d.id === "mouse") card.append(mouseLightSection(d));
  if (d.id === "lcd") {
    const showFx = h("input", { type: "checkbox", checked: S.lcd.mode === "effect" });
    showFx.addEventListener("change", () => { S.lcd.mode = showFx.checked ? "effect" : "vitals"; bridge.call("setLcd", { mode: S.lcd.mode }); toast(showFx.checked ? "The pump screen shows the lighting effect" : "The pump screen shows vitals"); });
    card.append(h("label", { class: "row between" }, h("span", {}, "Show the lighting effect on it"), h("span", { class: "switch" }, showFx)),
      h("div", {}, h("button", { class: "btn ghost", "data-goto": "pump" }, "Pump screen settings")));
  }
  return card;
}

// ---- fan finder: plain ARGB can't report what's plugged in, so the user shows Monarch
// where each fan ends by lighting LEDs one count at a time.
let finder = null; // { ch, segs: [{kind, leds}], cur, shared }
const FINDER_COLORS = ["#C81E1E", "#1EBE3C", "#2850E6", "#D2AA14", "#BE28BE", "#1EB4BE", "#E66E14", "#783CDC"];
function probe() { if (finder) bridge.call("probeHeader", finder.ch, finder.segs.map((s) => s.leds), finder.cur).catch(() => {}); }
function openFinder(ch) { finder = { ch, segs: [], cur: 8, shared: false }; probe(); renderDevicesTab(); }
function closeFinder() { finder = null; bridge.call("probeEnd").catch(() => {}); renderDevicesTab(); }

function finderPanel(ch) {
  const f = finder;
  const used = f.segs.reduce((n, s) => n + s.leds, 0);
  const out = h("span", { class: "num" }, String(f.cur));
  const r = h("input", { class: "slider", type: "range", min: 1, max: Math.max(1, 120 - used), value: f.cur, "aria-label": "LEDs lit" });
  sliderFill(r);
  const setCur = (v) => { f.cur = Math.max(1, Math.min(120 - used, v)); r.value = f.cur; sliderFill(r); out.textContent = f.cur; probe(); };
  r.addEventListener("input", () => setCur(+r.value));
  const step = (d) => h("button", { class: "icon-btn", title: d < 0 ? "One fewer" : "One more", onclick: () => setCur(f.cur + d) }, svgIcon(d < 0 ? "M5 10h10" : ICON.plus));
  const mark = (kind) => { f.segs.push({ kind, leds: f.cur }); if (f.shared) f.cur = 0; probe(); renderDevicesTab(); };
  const n = f.segs.length;
  const which = f.shared ? "one fan" : n === 0 ? "the first fan" : `fan ${n + 1}`;
  const shared = h("input", { type: "checkbox", checked: f.shared });
  shared.addEventListener("change", () => { f.shared = shared.checked; if (f.shared && f.segs.length > 1) f.segs = f.segs.slice(0, 1); probe(); renderDevicesTab(); });
  const save = async () => {
    const parts = f.shared
      ? [{ kind: "fan", label: "Fans (shared signal)", leds: f.segs[0]?.leds || f.cur }]
      : f.segs.map((s, i) => ({ kind: s.kind, leds: s.leds, label: s.kind === "fan" ? `Fan ${f.segs.slice(0, i + 1).filter((x) => x.kind === "fan").length}` : `Strip ${f.segs.slice(0, i + 1).filter((x) => x.kind === "strip").length}` }));
    finder = null;
    applySetup(await bridge.call("setHeaderParts", ch.id, parts));
    toast(`${ch.name} now has ${parts.length} part${parts.length > 1 ? "s" : ""}. Place them on the Layout tab.`);
  };
  const done = f.shared ? f.segs.length === 1 : f.segs.length > 0;
  return h("div", { class: "finder stack" },
    h("p", { class: "muted small" }, f.shared
      ? "All fans on this header copy one signal, so they light up together. Move the slider until one fan is fully white, then mark it."
      : `Move the slider until ${which} is fully white and the next one stays dark. Fans you've marked keep their colour.`),
    h("div", { class: "finder-row" }, h("span", { class: "label" }, "LEDs lit"), step(-1), r, step(1), out),
    h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
      h("button", { class: "btn", disabled: f.shared && n >= 1, onclick: () => mark("fan") }, `That's ${f.shared ? "the fan" : which}`),
      f.shared ? null : h("button", { class: "btn ghost", onclick: () => mark("strip") }, "It's a strip"),
      h("button", { class: "btn ghost", disabled: !n, onclick: () => { const last = f.segs.pop(); f.cur = last.leds; probe(); renderDevicesTab(); } }, "Undo")),
    n ? h("div", { class: "finder-segs" }, f.segs.map((s, i) => h("span", { class: "chip-tag" }, h("i", { class: "seg-dot", style: { background: FINDER_COLORS[i % FINDER_COLORS.length] } }), `${s.kind === "fan" ? "Fan" : "Strip"} ${i + 1}, ${s.leds} LEDs`))) : null,
    h("label", { class: "row between" }, h("span", { class: "muted small" }, "Every fan lights up at the same time (splitter or hub)"), h("span", { class: "switch sm" }, shared)),
    h("div", { class: "row", style: { gap: "8px" } },
      h("button", { class: "btn primary", disabled: !done, onclick: save }, f.shared ? "Save" : `Save ${n} part${n === 1 ? "" : "s"}`),
      h("button", { class: "btn ghost", onclick: closeFinder }, "Cancel")));
}

function headerSections(d) {
  const out = [];
  for (const ch of d.channels) {
    const total = ch.parts.reduce((n, p) => n + p.leds, 0);
    const finding = finder && finder.ch === ch.id;
    const unsplit = ch.parts.length === 1 && ch.parts[0].unsplit;
    const sec = h("div", { class: "chan" + (finding ? " finding" : "") }, h("div", { class: "row between chan-head" }, h("b", {}, ch.name),
      h("div", { class: "row", style: { gap: "10px" } },
        h("span", { class: "muted small" }, unsplit ? `${total} LEDs as one line` : ch.parts.length ? `${ch.parts.length} part${ch.parts.length > 1 ? "s" : ""}, ${total} LEDs` : "Nothing set up"),
        finding ? null : h("button", { class: "btn small" + (unsplit || !ch.parts.length ? " primary" : ""), disabled: !!finder, onclick: () => openFinder(ch.id) }, ch.parts.length && !unsplit ? "Find fans again" : "Find fans"))));
    if (finding) { sec.append(finderPanel(ch)); out.push(sec); continue; }
    if (unsplit) {
      sec.append(h("p", { class: "muted small" }, "Monarch doesn't know yet which fans are on this header, so its LEDs light as one line. Find fans splits it into the real fans so each one shows its own part of the effect."));
      out.push(sec); continue;
    }
    ch.parts.forEach((p, i) => {
      const name = h("input", { class: "text part-label", value: p.label, maxlength: 24 });
      name.addEventListener("change", async () => applySetup(await bridge.call("setPart", p.id, { label: name.value })));
      const leds = h("input", { class: "text num", type: "number", min: 1, max: 120, value: p.leds, title: "LEDs" });
      leds.addEventListener("change", async () => applySetup(await bridge.call("setPart", p.id, { leds: +leds.value })));
      const rev = h("input", { type: "checkbox", checked: p.reverse });
      rev.addEventListener("change", async () => applySetup(await bridge.call("setPart", p.id, { reverse: rev.checked })));
      sec.append(h("div", { class: "chain-row" },
        h("span", { class: "chain-n" }, String(i + 1)),
        name,
        h("label", { class: "nf-in", title: "LED count" }, leds, h("i", {}, "LEDs")),
        h("label", { class: "row small muted", style: { gap: "6px" }, title: "Data runs the other way round" }, "Reversed", h("span", { class: "switch sm" }, rev)),
        h("div", { class: "row", style: { gap: "2px" } },
          iconBtn("bulb", "Light it up", () => identifyParts([p.id])),
          iconBtn("up", "Earlier in the chain", async () => applySetup(await bridge.call("movePart", p.id, -1)), { disabled: i === 0 }),
          iconBtn("down", "Later in the chain", async () => applySetup(await bridge.call("movePart", p.id, 1)), { disabled: i === ch.parts.length - 1 }),
          iconBtn("x", "Remove", async () => { applySetup(await bridge.call("removePart", p.id)); toast(`${p.label} removed`); }))));
    });
    sec.append(h("div", { class: "row chan-add" },
      h("button", { class: "btn ghost small", onclick: async () => { applySetup(await bridge.call("addPart", ch.id, "fan", 12)); toast("Fan added. Place it on the Layout tab."); } }, "+ Fan, 12 LEDs"),
      h("button", { class: "btn ghost small", onclick: async () => { applySetup(await bridge.call("addPart", ch.id, "strip", 20)); toast("Strip added. Set its LED count, then place it on the Layout tab."); } }, "+ Strip")));
    out.push(sec);
  }
  const board = d.parts.find((p) => p.kind === "board");
  if (board) out.push(h("div", { class: "chan" }, h("div", { class: "row between chan-head" }, h("b", {}, "Onboard lights"), h("span", { class: "muted small" }, `${board.leds} zones on the board`))));
  return out;
}

function mouseLightSection(d) {
  const m = d.lighting;
  const box = h("div", { class: "stack", style: { gap: "12px" } });
  const seg = h("div", { class: "seg", role: "group" });
  for (const [k, label] of [["effect", "Follow the effect"], ["static", "One colour"], ["off", "Off"]])
    seg.append(h("button", { "aria-pressed": String(m.mode === k), onclick: () => { m.mode = k; S.mouse.lighting.mode = k; bridge.call("setMouseLighting", { mode: k }); renderDevicesTab(); } }, label));
  box.append(h("span", { class: "label" }, "Logo light"), seg);
  if (m.mode === "static") {
    const c = h("input", { type: "color", class: "swatch", value: m.color });
    c.addEventListener("input", () => { m.color = c.value; S.mouse.lighting.color = c.value; bridge.call("setMouseLighting", { color: c.value }); });
    box.append(h("div", { class: "row between" }, h("span", { class: "muted" }, "Colour"), c));
  }
  return box;
}

function powerCard() {
  const P = h("div", { class: "box card dev-card wide" });
  const psw = (key, title, sub) => { const c = h("input", { type: "checkbox", checked: !!S.power[key] }); c.addEventListener("change", () => { S.power[key] = c.checked; bridge.call("setPower", { [key]: c.checked }); }); return h("div", { class: "set-row" }, h("div", {}, h("b", {}, title), h("p", {}, sub)), h("span", { class: "switch" }, c)); };
  P.append(h("div", { class: "dev-head" }, h("span", { class: "dev-icon" }, svgIcon("M15 12.5A6.5 6.5 0 0 1 7.5 5a6.5 6.5 0 1 0 7.5 7.5z")), h("div", { class: "grow" }, h("h3", {}, "When you step away"), h("p", { class: "muted small" }, "Turns every light dark, then back on when you return."))),
    h("div", { class: "power-grid" },
      psw("offOnSleep", "PC sleeps", "Dark before sleep, back on when it wakes."),
      psw("offOnShutdown", "PC shuts down", "Otherwise the board keeps the last colours while the PC is off."),
      psw("offOnDisplayOff", "Displays turn off", "When Windows switches the monitors off after you go idle."),
      psw("offOnLock", "PC locks", "Windows key + L darkens the rig until you sign back in."),
      psw("pumpScreenToo", "Pump screen too", "The pump screen goes dark along with the lights.")),
    S.setup.devices.some((d) => d.id === "argb")
      ? h("p", { class: "muted small" }, "For the board to stay dark while the PC is off, also turn its LEDs off for sleep and soft-off in the BIOS" + (/gigabyte|aorus/i.test(S.cooling.board || "") ? " (Settings > Miscellaneous > LEDs in Sleep, Hibernation, and Soft Off States)." : "."))
      : null);
  return P;
}

// fallback window drag + double-click to maximize on the title bar
$(".bar").addEventListener("mousedown", (e) => { if (e.button === 0 && !e.target.closest("button")) bridge.call("drag"); });
$(".bar").addEventListener("dblclick", (e) => { if (!e.target.closest("button")) bridge.call("toggleMaximize"); });

async function matchWallpaper() {
  const w = S.wallpaper.items.find((x) => x.id === S.wallpaper.current) || S.wallpaper.items[0];
  if (!w || !w.thumb) { toast("Pick a wallpaper first"); return; }
  const im = new Image(); im.crossOrigin = "anonymous";
  await new Promise((r, j) => { im.onload = r; im.onerror = j; im.src = w.thumb; });
  const cv = document.createElement("canvas"); cv.width = 48; cv.height = 27;
  const c = cv.getContext("2d"); c.drawImage(im, 0, 0, 48, 27);
  const px = c.getImageData(0, 0, 48, 27).data;
  const buckets = new Array(12).fill(0).map(() => ({ n: 0, r: 0, g: 0, b: 0 }));
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx < 40 || mx - mn < 40) continue;
    let hh = mx === r ? ((g - b) / (mx - mn)) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4;
    hh = ((hh * 60) + 360) % 360;
    const k = Math.floor(hh / 30), w8 = (mx - mn) / 255;
    buckets[k].n += w8; buckets[k].r += r * w8; buckets[k].g += g * w8; buckets[k].b += b * w8;
  }
  const top = buckets.filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 3);
  if (!top.length) { toast("That wallpaper has no strong colours to match"); return; }
  while (top.length < 3) top.push(top[top.length - 1]);
  const hex = (x) => "#" + [x.r / x.n, x.g / x.n, x.b / x.n].map((v) => Math.round(Math.min(255, v * 1.15)).toString(16).padStart(2, "0")).join("");
  await pickEffect("aurora.html");
  for (const [i, x] of top.entries()) await bridge.call("setEffectParam", "color" + (i + 1), hex(x));
  renderParams(await bridge.call("getEffectValues"));
  toast(`Lights matched to ${w.title}`);
}

// ---------------------------------------------------------------- boot
(async function main() {
  bridge = await connect();
  S = await bridge.call("getState");
  document.body.dataset.view = current;
  bridge.call("uiView", current).catch(() => {});
  syncHardware();
  initRig();
  renderLibrary();
  renderParams(await bridge.call("getEffectValues"));
  renderPlaylist();
  renderFans(); renderFanSettings();
  renderLcd(); renderPumpStore(); renderMouse(); renderWalls(); renderSettings();
  applySetup(S.setup);

  const nowThumb = $("#now-thumb"), preview = $("#fx-preview");
  bridge.on("frame", (fr) => {
    if (current === "rig") updateAccent(rig.render(fr));
    else updateAccent(averageFrame(fr));
    drawThumb(nowThumb, fr);
    if (current === "lighting" && lightTab === "layout" && editor) editor.setFrame(fr);
    else if (current === "lighting") {
      const r = preview.getBoundingClientRect();
      if (preview.width !== Math.round(r.width)) { preview.width = Math.round(r.width); preview.height = Math.round(r.height); }
      drawThumb(preview, fr);
    }
  });
  bridge.on("telemetry", (t) => {
    lastTelemetry = t;
    S.sensors = t.sensors;
    renderVitals(t);
    if (current === "cooling") { updateFansLive(); drawCurveNow(); }
  });
  // The pump page gets every frame the pump gets. Frames are decoded off the main thread and one at a
  // time: if one is still decoding when the next arrives, the newer one waits and the older is skipped.
  let lcdDecoding = false, lcdNext = null, lcdRigAt = 0;
  const lcdCtx = $("#lcd-preview").getContext("2d");
  async function showLcd(src) {
    lcdDecoding = true;
    try {
      const blob = await (await fetch(src)).blob();
      const bmp = await createImageBitmap(blob);
      lcdCtx.drawImage(bmp, 0, 0, 480, 480); bmp.close();
    } catch {}
    lcdDecoding = false;
    if (lcdNext) { const n = lcdNext; lcdNext = null; showLcd(n); }
  }
  bridge.on("lcd", (src) => {
    const now = performance.now();
    if (now - lcdRigAt > 240) { lcdRigAt = now; rig.setLcd(src); }
    if (current !== "pump") return;
    if (lcdDecoding) lcdNext = src; else showLcd(src);
  });
  bridge.on("effects", (list) => { S.lighting.effects = list; renderLibrary(); });
  bridge.on("state", (s) => { const keep = S.lighting.effects; S = s; if (!S.lighting.effects.length) S.lighting.effects = keep; renderDevices(); renderBattery(); renderSoon("mouse", "settings", "cooling", "wallpaper"); applySetup(S.setup); syncBrightness(); syncHardware(); });
  bridge.on("lighting", (setup) => applySetup(setup));
  bridge.on("leds", (b64) => {
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    rig.setLeds(u);
    if (editor && current === "lighting" && lightTab === "layout") editor.setLeds(u);
  });
  bridge.on("toast", (m) => toast(m));
  bridge.on("wallpaper", (w) => { S.wallpaper = w; $("#btn-match").hidden = !(w.items || []).length; if (current === "wallpaper") renderWalls(); });
  bridge.on("wallImport", (p) => { wallImport = p; if (current === "wallpaper") renderWalls(); });
  bridge.on("mirror", (st) => { mirrorStatus = st; $$(".mirror-status").forEach((e) => (e.textContent = st)); });
  bridge.on("mouse", (m) => { S.mouse = m; renderBattery(); renderSoon("mouse"); });
  bridge.on("navigate", (v) => show(v));
  bridge.on("window", (w) => setMaxIcon(!!w.max));
  bridge.on("pumpSave", (e) => {
    const p = pumpPicks[e.kind] || {};
    pumpPicks[e.kind] = { ...p, busy: !e.done, pct: e.pct, msg: e.msg };
    if (e.done) { if (e.lcd) S.lcd = e.lcd; toast(e.msg); if (e.ok) pumpPicks[e.kind] = { msg: e.msg }; }
    renderPumpStore();
  });
  bridge.on("effectChanged", ({ id, values }) => { S.lighting.effect = id; renderLibrary(); renderParams(values); renderNow(); if (editor) renderLayoutsCard(); });
})();

function averageFrame(fr) {
  let r = 0, g = 0, b = 0; const n = fr.data.length / 3;
  for (let i = 0; i < fr.data.length; i += 3) { r += fr.data[i]; g += fr.data[i + 1]; b += fr.data[i + 2]; }
  return [r / n, g / n, b / n];
}
