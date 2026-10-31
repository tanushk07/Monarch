// Runs lighting effects written as SignalRGB-style "lightscripts": an HTML page
// with one 320 x 200 canvas, <meta property=...> controls that become globals,
// and an `engine` object for audio, screen and sensor data.

export function parseMeta(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const title = (doc.querySelector("title")?.textContent || "Untitled").trim();
  let description = "", publisher = "";
  const params = [];
  for (const m of doc.querySelectorAll("meta")) {
    if (m.hasAttribute("description")) description = m.getAttribute("description");
    if (m.hasAttribute("publisher")) publisher = m.getAttribute("publisher");
    const property = m.getAttribute("property");
    if (!property) continue;
    params.push({
      property,
      label: m.getAttribute("label") || property,
      type: (m.getAttribute("type") || "number").toLowerCase(),
      min: num(m.getAttribute("min"), 0),
      max: num(m.getAttribute("max"), 100),
      step: num(m.getAttribute("step"), 1),
      default: m.getAttribute("default") ?? "",
      values: (m.getAttribute("values") || "").split(",").map((s) => s.trim()).filter(Boolean),
      tooltip: m.getAttribute("tooltip") || "",
    });
  }
  return { title, description, publisher, params };
}

function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }

export function coerce(p, v) {
  switch (p.type) {
    case "number": case "hue": { const n = parseFloat(v); return Number.isFinite(n) ? n : num(p.default, 0); }
    case "boolean": return v === true || v === 1 || v === "1" || v === "true";
    default: return v == null ? "" : String(v);
  }
}

let seq = 0;
window.__fxEngines = window.__fxEngines || {};

export class EffectRunner {
  constructor(engine, { mount = document.body } = {}) {
    this.engine = engine;
    this.mount = mount;
    this.id = "fx" + ++seq;
    window.__fxEngines[this.id] = engine;
    this.meta = null;
    this.values = {};
    this.comp = document.createElement("canvas");
    this.comp.width = 320; this.comp.height = 200;
    this.cctx = this.comp.getContext("2d", { willReadFrequently: true });
  }

  async load(url, saved = {}) {
    const html = await (await fetch(url)).text();
    return this.loadHtml(html, saved);
  }

  loadHtml(html, saved = {}) {
    this.meta = parseMeta(html);
    this.values = {};
    const decl = [];
    for (const p of this.meta.params) {
      const v = coerce(p, p.property in saved ? saved[p.property] : p.default);
      this.values[p.property] = v;
      decl.push(`var ${p.property} = ${JSON.stringify(v)};`);
    }
    const boot = `<script>window.engine = parent.__fxEngines[${JSON.stringify(this.id)}];${decl.join("")}<\/script>`;
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    Object.assign(frame.style, { position: "fixed", left: "0", top: "0", width: "320px", height: "200px", border: "0", opacity: "0", pointerEvents: "none", zIndex: "-1" });
    frame.srcdoc = boot + html;
    if (this.frame) this.frame.remove();
    this.frame = frame;
    this.canvas = null;
    this.mount.appendChild(frame);
    return new Promise((res) => frame.addEventListener("load", () => res(this.meta), { once: true }));
  }

  setParam(k, raw) {
    const p = this.meta?.params.find((x) => x.property === k);
    if (!p) return;
    const v = coerce(p, raw);
    this.values[k] = v;
    const w = this.frame?.contentWindow;
    if (!w) return;
    try {
      w[k] = v;
      w.eval(`${k} = ${JSON.stringify(v)}`);
      const fn = w["on" + k + "Changed"];
      if (typeof fn === "function") fn();
    } catch (e) { /* effect threw; keep running */ }
  }

  // Composite the effect canvas the way it appears on the page (CSS size,
  // position and filter included), then return it as a 320 x 200 2D context.
  composite() {
    const doc = this.frame?.contentDocument;
    if (!doc) return null;
    if (!this.canvas || !this.canvas.isConnected) this.canvas = doc.querySelector("canvas");
    const cv = this.canvas;
    if (!cv) return null;
    const c = this.cctx;
    c.filter = "none";
    c.fillStyle = "#000"; c.fillRect(0, 0, 320, 200);
    const r = cv.getBoundingClientRect();
    const f = cv.style.filter || doc.defaultView.getComputedStyle(cv).filter;
    c.filter = f && f !== "none" ? f : "none";
    try { c.drawImage(cv, 0, 0, cv.width, cv.height, r.left, r.top, r.width || 320, r.height || 200); } catch (e) {}
    c.filter = "none";
    return c;
  }

  // Downscaled RGB frame for previews: { w, h, data }
  grab(w = 64, h = 40) {
    if (!this.composite()) return null;
    if (!this.small) { this.small = document.createElement("canvas"); }
    if (this.small.width !== w) { this.small.width = w; this.small.height = h; }
    const s = this.small.getContext("2d", { willReadFrequently: true });
    s.drawImage(this.comp, 0, 0, w, h);
    const px = s.getImageData(0, 0, w, h).data;
    const out = new Uint8ClampedArray(w * h * 3);
    for (let i = 0, j = 0; i < px.length; i += 4, j += 3) { out[j] = px[i]; out[j + 1] = px[i + 1]; out[j + 2] = px[i + 2]; }
    return { w, h, data: out };
  }

  // Exact colours at canvas points (320 x 200 space), with a small box average.
  sample(points) {
    if (!this.composite()) return null;
    const img = this.cctx.getImageData(0, 0, 320, 200).data;
    const out = new Uint8Array(points.length * 3);
    for (let k = 0; k < points.length; k++) {
      const cx = Math.max(1, Math.min(318, Math.round(points[k][0])));
      const cy = Math.max(1, Math.min(198, Math.round(points[k][1])));
      let r = 0, g = 0, b = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const i = ((cy + dy) * 320 + (cx + dx)) * 4;
        r += img[i]; g += img[i + 1]; b += img[i + 2];
      }
      out[k * 3] = r / 9; out[k * 3 + 1] = g / 9; out[k * 3 + 2] = b / 9;
    }
    return out;
  }

  dispose() { this.frame?.remove(); delete window.__fxEngines[this.id]; }
}

// Engine object handed to effects. The host updates its fields every frame.
export function makeEngine() {
  return {
    audio: { level: -100, density: 0, freq: new ArrayBuffer(200) },
    zone: { imagedata: new ArrayBuffer(160 * 100 * 4), hue: new ArrayBuffer(560 * 2), saturation: new ArrayBuffer(560), lightness: new ArrayBuffer(560) },
    sensors: { coolant: 0, cpu: 0, gpu: 0 },
  };
}

// Fill engine.zone from an RGBA screen grab of 160 x 100.
export function setZoneFromRGBA(engine, rgba) {
  engine.zone.imagedata = rgba.buffer.slice(0);
  const hue = new Int16Array(560), sat = new Int8Array(560), lit = new Int8Array(560);
  for (let z = 0; z < 560; z++) {
    const zr = Math.floor(z / 28), zc = z % 28;
    const x0 = Math.floor((zc * 160) / 28), x1 = Math.floor(((zc + 1) * 160) / 28);
    const y0 = zr * 5, y1 = y0 + 5;
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * 160 + x) * 4; r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++; }
    r /= n * 255; g /= n * 255; b /= n * 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0, s = 0; const l = (mx + mn) / 2;
    if (d) {
      s = d / (1 - Math.abs(2 * l - 1));
      h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    hue[z] = Math.round(h); sat[z] = Math.round(s * 100); lit[z] = Math.round(l * 100);
  }
  engine.zone.hue = hue.buffer; engine.zone.saturation = sat.buffer; engine.zone.lightness = lit.buffer;
}
