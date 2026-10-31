// Engine page. Runs inside a hidden WebView2 owned by the C# engine.
// It renders the lighting effect, samples it at every LED, and draws and
// encodes the pump screen. All device I/O stays in C#.
import { EffectRunner, makeEngine, setZoneFromRGBA, parseMeta } from "./fxhost.js";
import { drawFace } from "./lcd-faces.js";
import { ledPositions } from "./rig.js";

const wv = window.chrome.webview;
const send = (m) => wv.postMessage(m);
const log = (...a) => send({ type: "log", text: a.join(" ") });
window.addEventListener("error", (e) => log("host error:", e.message, e.filename + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e) => log("host rejection:", String(e.reason)));

const engine = makeEngine();
const runner = new EffectRunner(engine);

let points = [];          // LED positions in canvas space, in the order C# expects
let gains = [];           // per LED: layout brightness x device brightness, 0 for hidden parts
let previewW = 64, previewH = 40;
let brightness = 1;
let previewOn = false;
let identify = null;      // { set: Set<index>, until }
let ledFps = 30, lcdFps = 10;
const lcd = { mode: "vitals", brightness: 100, rotation: 0, overlay: true, heatTint: true, h12: false, media: "", accent: "#78B8FF", budget: 19500 };
let sensors = { coolant: 0, cpu: 0, gpu: 0 };
let mediaEl = null;

function b64(bytes) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
function unb64(str) { const bin = atob(str); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }

wv.addEventListener("message", async (e) => {
  const m = e.data;
  try {
    switch (m.type) {
      case "effect": {
        const meta = await runner.load(m.url, m.params || {});
        send({ type: "effectLoaded", url: m.url, meta, values: runner.values });
        break;
      }
      case "param": runner.setParam(m.k, m.v); break;
      case "brightness": brightness = Math.max(0, Math.min(1, m.v / 100)); break;
      case "layout": {
        const pts = [], g = [];
        for (const it of m.items || []) {
          const p = ledPositions(it, it.place);
          for (const q of p) { pts.push(q); g.push(it.place ? (it.place.hidden ? 0 : it.k ?? 1) : 1); }
        }
        points = pts; gains = g;
        break;
      }
      case "zone": zoneFromRgb(unb64(m.b64)); break;
      case "zoneBuf": { const b = shared.zone[m.slot]; if (b) zoneFromRgb(new Uint8Array(b, 0, 160 * 100 * 3)); break; }
      case "lcdReady": lcdBusy = false; break;
      case "audio": engine.audio.freq = unb64(m.b64).buffer; engine.audio.level = m.level; engine.audio.density = m.density; break;
      case "sensors": sensors = m.s; engine.sensors = { ...m.s }; break;
      case "preview": previewOn = !!m.on; if (m.w) { previewW = m.w; previewH = m.h; } break;
      case "identify": identify = { set: new Set(m.indices), until: performance.now() + (m.ms || 3000) }; break;
      case "lcd":
        if (m.opts.mode && m.opts.mode !== lcd.mode) capReady = false; // don't show the last mirror's picture
        Object.assign(lcd, m.opts); if ("media" in m.opts) loadMedia(lcd.media); break;
      case "fps": ledFps = m.led || ledFps; lcdFps = m.lcd || lcdFps; break;
      case "cap": {
        // a mirrored screen or window frame, already in shared memory
        const buf = shared.cap[m.slot];
        if (!buf || m.w * m.h * 4 > buf.byteLength) break;
        if (capCanvas.width !== m.w || capCanvas.height !== m.h) { capCanvas.width = m.w; capCanvas.height = m.h; }
        capCtx.putImageData(new ImageData(new Uint8ClampedArray(buf, 0, m.w * m.h * 4), m.w, m.h), 0, 0);
        capReady = true;
        break;
      }
      case "capJpeg": {
        const bmp = await createImageBitmap(new Blob([unb64(m.b64)], { type: "image/jpeg" }));
        if (capCanvas.width !== bmp.width || capCanvas.height !== bmp.height) { capCanvas.width = bmp.width; capCanvas.height = bmp.height; }
        capCtx.drawImage(bmp, 0, 0); bmp.close(); capReady = true;
        break;
      }
      case "thumbs": makeThumbs(m.items); break;
      case "meta": {
        const out = [];
        for (const it of m.items) {
          try { const html = await (await fetch(it.url)).text(); out.push({ id: it.id, meta: parseMeta(html) }); }
          catch (err) { out.push({ id: it.id, error: String(err) }); }
        }
        send({ type: "metaList", items: out });
        break;
      }
    }
  } catch (err) { log("host message", m.type, String(err && err.stack || err)); }
});

// Shared memory from C#: screen zones and mirrored frames come in (two slots each, filled
// in turn), pump frames go out through "lcd".
const shared = { zone: [], cap: [], lcd: null };
wv.addEventListener("sharedbufferreceived", (e) => {
  const d = e.additionalData || {};
  const buf = e.getBuffer();
  if (d.kind === "lcd") shared.lcd = buf;
  else if (shared[d.kind]) shared[d.kind][d.slot || 0] = buf;
});
const zoneRgba = new Uint8ClampedArray(160 * 100 * 4);
function zoneFromRgb(rgb) {
  for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) { zoneRgba[i] = rgb[j]; zoneRgba[i + 1] = rgb[j + 1]; zoneRgba[i + 2] = rgb[j + 2]; zoneRgba[i + 3] = 255; }
  setZoneFromRGBA(engine, zoneRgba);
}

const capCanvas = document.createElement("canvas"); capCanvas.width = 2; capCanvas.height = 2;
const capCtx = capCanvas.getContext("2d", { willReadFrequently: false });
let capReady = false;

// Animated GIF / WebP played frame by frame with WebCodecs, so they move even though
// this page never paints on screen (a plain <img> would stay on its first frame).
class Animated {
  constructor(url, type) { this.url = url; this.type = type; this.frame = null; this.due = 0; this.index = 0; this.busy = false; }
  async init() {
    const buf = await (await fetch(this.url)).arrayBuffer();
    this.dec = new ImageDecoder({ data: buf, type: this.type });
    await this.dec.tracks.ready;
    this.count = this.dec.tracks.selectedTrack.frameCount || 1;
    await this.step();
    return this;
  }
  // Keeps real time: if the pump only takes 15 frames a second and the GIF has 30,
  // frames in between are skipped instead of the GIF playing in slow motion.
  async step() {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      const now = performance.now();
      if (!this.due || this.due < now - 1000) this.due = now;   // first frame, or we fell far behind
      for (let n = 0; this.due <= now && n < 12; n++) {
        const r = await this.dec.decode({ frameIndex: this.index });
        const old = this.frame; this.frame = r.image; if (old) old.close();
        this.due += Math.max(20, (r.image.duration || 100000) / 1000);
        this.index = (this.index + 1) % this.count;
      }
    } catch (e) { this.index = 0; this.due = 0; }
    this.busy = false;
  }
  current() { if (performance.now() >= this.due) this.step(); return this.frame; }
  close() { this.closed = true; try { this.frame?.close(); this.dec?.close(); } catch {} }
}

let animated = null;
function loadMedia(url) {
  const box = document.getElementById("media");
  box.innerHTML = ""; mediaEl = null;
  if (animated) { animated.close(); animated = null; }
  if (!url) return;
  const isVideo = /\.(mp4|webm|mkv|mov|m4v|avi)$/i.test(url);
  const anim = /\.(gif|webp)$/i.exec(url);
  if (anim && "ImageDecoder" in window) {
    const a = new Animated(url, anim[1].toLowerCase() === "gif" ? "image/gif" : "image/webp");
    a.init().then(() => { if (lcd.media === url) animated = a; else a.close(); }).catch((e) => log("media decode", String(e)));
    return;
  }
  const el = document.createElement(isVideo ? "video" : "img");
  if (isVideo) { el.muted = true; el.loop = true; el.autoplay = true; el.playsInline = true; }
  el.src = url;
  box.appendChild(el);
  if (isVideo) el.play().catch(() => {});
  mediaEl = el;
}

// ---- LEDs -----------------------------------------------------------------
function ledTick() {
  if (points.length) {
    const cols = runner.sample(points);
    if (cols) {
      const k = brightness;
      for (let i = 0; i < cols.length; i++) cols[i] = cols[i] * k * (gains[(i / 3) | 0] ?? 1);
      if (identify) {
        if (performance.now() > identify.until) identify = null;
        else {
          const on = Math.floor(performance.now() / 250) % 2 === 0;
          for (let i = 0; i < cols.length / 3; i++) {
            const lit = identify.set.has(i) && on;
            cols[i * 3] = cols[i * 3 + 1] = cols[i * 3 + 2] = lit ? 255 : 0;
          }
        }
      }
      send({ type: "leds", b64: b64(cols) });
    }
  }
}

let lastPreview = 0;
function previewTick(now) {
  if (!previewOn || now - lastPreview < 50) return;
  lastPreview = now;
  const fr = runner.grab(previewW, previewH);
  if (!fr) return;
  const k = brightness;
  if (k < 1) for (let i = 0; i < fr.data.length; i++) fr.data[i] *= k;
  send({ type: "frame", w: fr.w, h: fr.h, b64: b64(fr.data) });
}

// ---- pump screen ----------------------------------------------------------
const lcdCanvas = document.createElement("canvas");
lcdCanvas.width = 480; lcdCanvas.height = 480;
const lctx = lcdCanvas.getContext("2d", { willReadFrequently: true });
let lastLcd = 0, lcdBusy = false, lcdSentAt = 0;
// The pump paces the frames: a new one is made only once C# says the pump took the last one,
// so frames never queue up and what the pump shows is always the newest picture.
const jpegWorker = new Worker("jpeg-worker.js", { type: "module" });
jpegWorker.onmessage = (e) => {
  const bytes = e.data.bytes;
  if (!bytes) { lcdBusy = false; return; } // couldn't fit: the pump keeps the last frame
  if (shared.lcd && bytes.length <= shared.lcd.byteLength) {
    new Uint8Array(shared.lcd).set(bytes);
    send({ type: "lcdFrame", len: bytes.length });
  } else send({ type: "lcdFrame", b64: b64(bytes) });
};
jpegWorker.onerror = (e) => { log("jpeg worker", e.message); lcdBusy = false; };
function lcdTick(now) {
  if (lcd.mode === "off") return;
  if (lcdBusy && now - lcdSentAt < 1500) return;
  const live = (lcd.mode === "media" && (animated || (mediaEl && mediaEl.tagName === "VIDEO"))) || lcd.mode === "screen" || lcd.mode === "window" || lcd.mode === "effect";
  const fps = lcd.mode === "vitals" || lcd.mode === "system" ? Math.min(lcdFps, 4) : live ? 30 : Math.max(lcdFps, 4);
  if (now - lastLcd < 1000 / fps - 2) return;
  lastLcd = now;
  const opt = { ...lcd };
  if (lcd.mode === "effect") { runner.composite(); opt.effectCanvas = runner.comp; }
  if (lcd.mode === "media") opt.media = animated ? animated.current() : mediaEl;
  if (lcd.mode === "screen" || lcd.mode === "window") opt.capture = capReady ? capCanvas : null;
  drawFace(lctx, lcd.mode, sensors, opt);
  const px = lctx.getImageData(0, 0, 480, 480).data;
  lcdBusy = true; lcdSentAt = now;
  jpegWorker.postMessage({ rgba: px.buffer, w: 480, h: 480, budget: Math.min(lcd.budget || 19500, 20000) }, [px.buffer]);
}

// ---- thumbnails for the library --------------------------------------------
async function makeThumbs(items) {
  const tr = new EffectRunner(engine);
  for (const it of items) {
    try {
      await tr.load(it.url);
      await new Promise((r) => setTimeout(r, 1200));
      const fr = tr.grab(160, 100);
      if (!fr) continue;
      const cv = document.createElement("canvas"); cv.width = 160; cv.height = 100;
      const c = cv.getContext("2d"); const img = c.createImageData(160, 100);
      for (let i = 0, j = 0; j < fr.data.length; i += 4, j += 3) { img.data[i] = fr.data[j]; img.data[i + 1] = fr.data[j + 1]; img.data[i + 2] = fr.data[j + 2]; img.data[i + 3] = 255; }
      c.putImageData(img, 0, 0);
      send({ type: "thumb", id: it.id, dataUrl: cv.toDataURL("image/jpeg", 0.85) });
    } catch (err) { log("thumb", it.id, String(err)); }
  }
  tr.dispose();
}

// ---- loop -----------------------------------------------------------------
let lastLed = 0;
function loop() {
  const now = performance.now();
  if (now - lastLed >= 1000 / ledFps - 2) { lastLed = now; ledTick(); }
  previewTick(now);
  lcdTick(now);
}
setInterval(loop, 8);
document.fonts.ready.then(() => send({ type: "ready" }));
