// Live map of the rig. The map shares its coordinate system with the effect
// canvas (320 x 200), so every light is drawn exactly where it samples colour.

export const CANVAS_W = 320, CANVAS_H = 200;
const VB = { x: -12, y: -14, w: 344, h: 228 };
const NS = "http://www.w3.org/2000/svg";

// LED positions of a part around its own centre, before it is placed.
export function localLeds(item) {
  const n = Math.max(0, item.leds | 0);
  const out = [];
  const r = item.r || 21, w = item.w || 150, h = item.h || 40;
  switch (item.kind) {
    case "fan":
      for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + (i / n) * Math.PI * 2; out.push([Math.cos(a) * r * 0.74, Math.sin(a) * r * 0.74]); }
      break;
    case "pump":
      for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + (i / n) * Math.PI * 2; out.push([Math.cos(a) * (r + 3), Math.sin(a) * (r + 3)]); }
      break;
    case "gpu":
    case "strip": {
      const x0 = -w / 2 + 6, x1 = w / 2 - 6, y = item.kind === "gpu" ? (item.h || 18) / 2 - 2 : 0;
      for (let i = 0; i < n; i++) out.push([x0 + (x1 - x0) * (n === 1 ? 0.5 : i / (n - 1)), y]);
      break;
    }
    case "ram": {
      const y0 = -h / 2 + 3, y1 = h / 2 - 3;
      for (let i = 0; i < n; i++) out.push([0, y0 + (y1 - y0) * (n === 1 ? 0.5 : i / (n - 1))]);
      break;
    }
    case "mouse":
      if (n) out.push([0, -4]);
      break;
    case "board":
      for (let i = 0; i < n; i++) out.push([(i - (n - 1) / 2) * 5, 0]);
      break;
    case "monitor": { // lights along the back of the screen
      const x0 = -w / 2 + 6, x1 = w / 2 - 6;
      for (let i = 0; i < n; i++) out.push([x0 + (x1 - x0) * (n === 1 ? 0.5 : i / (n - 1)), 0]);
      break;
    }
  }
  return out;
}

// Size of a part's box at scale 1, in canvas units.
export function partSize(item) {
  const r = item.r || 21;
  switch (item.kind) {
    case "fan": return { w: r * 2, h: r * 2 };
    case "pump": return { w: r * 2 + 12, h: r * 2 + 12 };
    case "gpu": return { w: item.w || 150, h: item.h || 18 };
    case "strip": return { w: item.w || 150, h: 8 };
    case "ram": return { w: 7, h: item.h || 40 };
    case "mouse": return { w: 18, h: 30 };
    case "board": return { w: Math.max(1, item.leds) * 5 + 6, h: 8 };
    case "monitor": return { w: item.w || 60, h: item.h || 8 };
    default: return { w: 20, h: 20 };
  }
}

// Where a part sits on the canvas: centre, width and height multipliers, rotation (degrees)
// and mirror. Without a placement, a part sits at its home spot on the rig drawing.
export function placeOf(item, pl) {
  if (!pl) return { x: item.x, y: item.y, sx: 1, sy: 1, rot: 0, flip: false };
  const s = pl.scale ?? 1;
  return { x: +pl.x, y: +pl.y, sx: pl.sx || s, sy: pl.sy || s, rot: pl.rot ?? 0, flip: !!pl.flip };
}
export function toCanvas(pl, lx, ly) {
  const sx = (pl.flip ? -lx : lx) * (pl.sx ?? pl.scale ?? 1), sy = ly * (pl.sy ?? pl.scale ?? 1);
  const a = ((pl.rot || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [pl.x + sx * c - sy * s, pl.y + sx * s + sy * c];
}
export function ledPositions(item, pl) {
  const p = placeOf(item, pl);
  return localLeds(item).map(([x, y]) => toCanvas(p, x, y));
}

export function sampleFrame(frame, x, y) {
  if (!frame) return [0, 0, 0];
  const fx = Math.min(frame.w - 1, Math.max(0, Math.round((x / CANVAS_W) * (frame.w - 1))));
  const fy = Math.min(frame.h - 1, Math.max(0, Math.round((y / CANVAS_H) * (frame.h - 1))));
  const i = (fy * frame.w + fx) * 3;
  return [frame.data[i], frame.data[i + 1], frame.data[i + 2]];
}

function el(name, attrs, parent) {
  const e = document.createElementNS(NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

export class Rig {
  constructor(root, { onPick } = {}) {
    this.root = root;
    this.ambient = document.getElementById("stage-ambient");   // the aura behind the whole page
    this.ledCanvas = root.querySelector("#stage-leds");
    this.svg = root.querySelector("#stage-art");
    this.onPick = onPick;
    this.items = [];
    this.places = {};
    this.brightness = 1;
    this.frame = null;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(root);
    if (this.ambient) this.ro.observe(this.ambient);
    this.small = document.createElement("canvas");
    this.dark = new Set(); // sources whose device isn't connected: drawn unlit
  }

  // The drawing is the Layout: every part sits where the active layout puts it.
  // hide: ids of parts not drawn (their device isn't answering). LED offsets still count them.
  setLayout(items, hide = new Set(), placements = []) {
    this.items = items;
    this.hide = hide;
    this.places = Object.fromEntries((placements || []).map((p) => [p.id, p]));
    let off = 0;
    this.cache = items.map((it) => {
      const pl = this.places[it.id];
      const P = placeOf(it, pl);
      const pts = ledPositions(it, pl);
      const e = { item: it, pl: P, pts, off, gone: !!(pl && pl.hidden) || hide.has(it.id) };
      off += pts.length; return e;
    });
    this.total = off;
    this.drawArt();
    if (this.frame) this.render(this.frame);
  }

  // Real LED colours as sent to the devices (brightness already applied).
  setLeds(bytes) { this.leds = bytes; this.ledsAt = performance.now(); }

  setLcd(src) {
    if (this.lcdSrc === src) return;
    this.lcdSrc = src;
    for (const im of this.lcdImgs || []) im.setAttribute("href", src);
  }

  resize() {
    const r = this.root.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.ledCanvas.width = Math.max(1, Math.round(r.width * dpr));
    this.ledCanvas.height = Math.max(1, Math.round(r.height * dpr));
    // The aura is soft anyway: a tiny canvas, blurred while tiny and stretched by the GPU.
    // (A CSS blur over the full-size canvas cost a big blur on every frame.)
    const ar = this.ambient.getBoundingClientRect();
    this.ambient.width = Math.max(1, Math.round(ar.width / 16));
    this.ambient.height = Math.max(1, Math.round(ar.height / 16));
    this.W = r.width; this.H = r.height; this.dpr = dpr;
    const s = Math.min(r.width / VB.w, r.height / VB.h);
    this.s = s;
    this.ox = (r.width - VB.w * s) / 2 - VB.x * s;
    this.oy = (r.height - VB.h * s) / 2 - VB.y * s;
    if (this.frame) this.render(this.frame);
  }

  drawArt() {
    const svg = this.svg;
    svg.setAttribute("viewBox", `${VB.x} ${VB.y} ${VB.w} ${VB.h}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.innerHTML = "";
    const defs = el("defs", {}, svg);
    const line = "rgba(214,236,255,.5)", faint = "rgba(214,236,255,.15)", shade = "rgba(11,9,20,.42)";
    this.lcdImgs = [];

    // the frame: the effect canvas, which is where every part samples its colour
    el("rect", { x: -4, y: -4, width: CANVAS_W + 8, height: CANVAS_H + 8, rx: 6, fill: "rgba(214,236,255,.015)", stroke: "rgba(214,236,255,.2)", "stroke-width": 0.8 }, svg);
    el("rect", { x: -0.5, y: -0.5, width: CANVAS_W + 1, height: CANVAS_H + 1, rx: 4, fill: "none", stroke: "rgba(214,236,255,.06)", "stroke-width": 0.5 }, svg);

    let n = 0;
    for (const { item: it, pl, gone } of this.cache || []) {
      if (gone) continue;
      const g = el("g", { class: "part", "data-id": it.id, style: "cursor:pointer" }, svg);
      g.addEventListener("click", () => this.onPick && this.onPick(it));
      el("title", {}, g).textContent = it.label;
      const body = el("g", { transform: `translate(${pl.x} ${pl.y}) rotate(${pl.rot || 0}) scale(${(pl.flip ? -1 : 1) * pl.sx} ${pl.sy})` }, g);
      const sw = (v) => ({ "stroke-width": v, "vector-effect": "non-scaling-stroke" });
      switch (it.kind) {
        case "fan": {
          const r = it.r || 21;
          el("rect", { x: -r, y: -r, width: r * 2, height: r * 2, rx: 2.5, fill: shade, stroke: line, ...sw(0.9) }, body);
          el("circle", { cx: 0, cy: 0, r: r * 0.86, fill: "none", stroke: faint, ...sw(0.8) }, body);
          for (let i = 0; i < 7; i++) {
            const a = (i / 7) * Math.PI * 2;
            const x1 = Math.cos(a) * r * 0.22, y1 = Math.sin(a) * r * 0.22;
            const x2 = Math.cos(a + 0.9) * r * 0.66, y2 = Math.sin(a + 0.9) * r * 0.66;
            const cx = Math.cos(a + 0.2) * r * 0.62, cy = Math.sin(a + 0.2) * r * 0.62;
            el("path", { d: `M${x1} ${y1} Q${cx} ${cy} ${x2} ${y2}`, fill: "none", stroke: "rgba(214,236,255,.2)", ...sw(0.8) }, body);
          }
          el("circle", { cx: 0, cy: 0, r: r * 0.2, fill: "rgba(214,236,255,.08)", stroke: line, ...sw(0.8) }, body);
          break;
        }
        case "pump": {
          const r = it.r || 22, id = "lcdclip" + n++;
          const clip = el("clipPath", { id }, defs);
          el("circle", { cx: 0, cy: 0, r: r - 2.2 }, clip);
          el("circle", { cx: 0, cy: 0, r: r + 6, fill: "#E6EAF3", opacity: 0.94 }, body);
          el("circle", { cx: 0, cy: 0, r: r - 1.6, fill: "#000" }, body);
          const im = el("image", { x: -r + 2.2, y: -r + 2.2, width: (r - 2.2) * 2, height: (r - 2.2) * 2, "clip-path": `url(#${id})`, preserveAspectRatio: "xMidYMid slice" }, body);
          if (this.lcdSrc) im.setAttribute("href", this.lcdSrc);
          this.lcdImgs.push(im);
          for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
            el("circle", { cx: Math.cos(a) * (r + 3.4), cy: Math.sin(a) * (r + 3.4), r: 0.9, fill: "#2a2f40" }, body);
          }
          break;
        }
        case "gpu": {
          const w = it.w || 150, h = it.h || 18;
          el("rect", { x: -w / 2, y: -h / 2, width: w, height: h, rx: 2.5, fill: shade, stroke: line, ...sw(0.9) }, body);
          for (let i = 0; i < 3; i++) el("circle", { cx: -w / 3 + (i * w) / 3, cy: -1, r: h * 0.34, fill: "none", stroke: faint, ...sw(0.8) }, body);
          break;
        }
        case "ram": {
          const h = it.h || 40;
          el("rect", { x: -2.6, y: -h / 2, width: 5.2, height: h, rx: 1, fill: shade, stroke: line, ...sw(0.8) }, body);
          break;
        }
        case "mouse":
          el("path", { d: "M-8 -4 C-8 -16 8 -16 8 -4 L8 8 C8 17 -8 17 -8 8 Z", fill: shade, stroke: line, ...sw(0.9) }, body);
          el("path", { d: "M0 -13 L0 -6", stroke: faint, ...sw(0.8) }, body);
          break;
        case "board": {
          const w = Math.max(1, it.leds) * 5 + 6;
          el("rect", { x: -w / 2, y: -3, width: w, height: 6, rx: 3, fill: "none", stroke: faint, ...sw(0.8) }, body);
          break;
        }
        case "monitor": {
          const w = it.w || 60, h = it.h || 8;
          el("rect", { x: -w / 2, y: -h / 2, width: w, height: h, rx: 2, fill: shade, stroke: line, ...sw(0.9) }, body);
          break;
        }
        default: { // strip, or a header that hasn't been split into fans yet
          const w = it.w || 150;
          el("rect", { x: -w / 2, y: -2.5, width: w, height: 5, rx: 2.5, fill: "none", stroke: it.unsplit ? faint : line, "stroke-dasharray": it.unsplit ? "2 2" : "", ...sw(0.8) }, body);
        }
      }
      if (it.label && it.showLabel !== false) {
        // under the part's box, whichever way it is turned
        const { w, h } = partSize(it);
        const a = ((pl.rot || 0) * Math.PI) / 180;
        const half = (Math.abs(w * pl.sx * Math.sin(a)) + Math.abs(h * pl.sy * Math.cos(a))) / 2;
        const extra = it.kind === "pump" ? -1.5 : it.kind === "mouse" ? 2 : 0;
        const t = el("text", { x: pl.x, y: Math.min(CANVAS_H + 9, pl.y + half + extra + 7.5), "text-anchor": "middle", fill: "rgba(156,151,182,.95)", "font-size": 4.4, "font-family": "Figtree, sans-serif" }, g);
        t.textContent = it.kind === "ram" && it.showLabel !== false && this.items.filter((x) => x.kind === "ram").length > 1 ? "RAM" : it.label;
        if (it.unsplit) {
          const hint = el("text", { x: pl.x, y: Math.min(CANVAS_H + 9, pl.y + half + 13), "text-anchor": "middle", fill: "rgba(214,236,255,.7)", "font-size": 3.6, "font-family": "Figtree, sans-serif" }, g);
          hint.textContent = "Not split into fans yet: Lighting > Devices > Find fans";
        }
      }
    }
  }

  // frame = { w, h, data: Uint8ClampedArray RGB }
  render(frame) {
    this.frame = frame;
    if (!this.W) return;
    const dpr = this.dpr, s = this.s;
    // ambient: the whole effect field, blurred and dim, filling the page
    const a = this.ambient.getContext("2d");
    const sm = this.small;
    if (sm.width !== frame.w || sm.height !== frame.h) { sm.width = frame.w; sm.height = frame.h; this.smImg = null; }
    const sctx = sm.getContext("2d");
    if (!this.smImg) this.smImg = sctx.createImageData(frame.w, frame.h);
    const px = this.smImg.data;
    for (let i = 0, j = 0; i < frame.w * frame.h; i++, j += 3) {
      px[i * 4] = frame.data[j]; px[i * 4 + 1] = frame.data[j + 1]; px[i * 4 + 2] = frame.data[j + 2]; px[i * 4 + 3] = 255;
    }
    sctx.putImageData(this.smImg, 0, 0);
    a.setTransform(1, 0, 0, 1, 0, 0);
    a.clearRect(0, 0, this.ambient.width, this.ambient.height);
    a.globalAlpha = 0.24 * this.brightness;
    a.imageSmoothingEnabled = true;
    a.filter = "blur(3px)";
    a.drawImage(sm, -6, -6, this.ambient.width + 12, this.ambient.height + 12);
    a.filter = "none";
    a.globalAlpha = 1;

    // LEDs
    const c = this.ledCanvas.getContext("2d");
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.ledCanvas.width, this.ledCanvas.height);
    c.setTransform(dpr * s, 0, 0, dpr * s, dpr * this.ox, dpr * this.oy);
    c.globalCompositeOperation = "lighter";
    const b = this.brightness;
    // LEDs are emissive, so lift dark values the way the eye sees them glowing
    const lift = (v) => 255 * Math.pow(Math.max(0, v) / 255, 0.62);
    let sr = 0, sg = 0, sb = 0, sn = 0;
    const real = this.leds && this.leds.length === this.total * 3 && performance.now() - this.ledsAt < 600 ? this.leds : null;
    for (const { item, pl, pts, off, gone } of this.cache || []) {
      if (gone || this.dark.has(item.source)) continue;
      const glow = item.kind === "fan" ? 9 : item.kind === "mouse" ? 12 : item.kind === "gpu" ? 8 : 6;
      let ir = 0, ig = 0, ib = 0;
      const cols = pts.map(([x, y], k) => {
        let r, g, bb;
        if (real) { const i = (off + k) * 3; r = real[i]; g = real[i + 1]; bb = real[i + 2]; }
        else { [r, g, bb] = sampleFrame(frame, x, y); r *= b; g *= b; bb *= b; }
        const R = lift(r), G = lift(g), B = lift(bb);
        sr += r; sg += g; sb += bb; sn++;
        ir += R; ig += G; ib += B;
        return [R | 0, G | 0, B | 0];
      });
      if (pts.length && item.kind === "fan") {
        // light spilling onto the blades
        const n = pts.length, R = (ir / n) | 0, G = (ig / n) | 0, B = (ib / n) | 0;
        const rr = (item.r || 21) * (pl.sx + pl.sy) / 2;
        const sp = c.createRadialGradient(pl.x, pl.y, rr * 0.15, pl.x, pl.y, rr * 0.95);
        sp.addColorStop(0, `rgba(${R},${G},${B},0.05)`);
        sp.addColorStop(0.75, `rgba(${R},${G},${B},0.32)`);
        sp.addColorStop(1, `rgba(${R},${G},${B},0)`);
        c.fillStyle = sp;
        c.beginPath(); c.arc(pl.x, pl.y, rr, 0, Math.PI * 2); c.fill();
      }
      pts.forEach(([x, y], k) => {
        const [R, G, B] = cols[k];
        const grad = c.createRadialGradient(x, y, 0, x, y, glow);
        grad.addColorStop(0, `rgba(${R},${G},${B},.8)`);
        grad.addColorStop(0.35, `rgba(${R},${G},${B},.28)`);
        grad.addColorStop(1, `rgba(${R},${G},${B},0)`);
        c.fillStyle = grad;
        c.fillRect(x - glow, y - glow, glow * 2, glow * 2);
        c.fillStyle = `rgb(${Math.min(255, R + 70)},${Math.min(255, G + 70)},${Math.min(255, B + 70)})`;
        c.beginPath(); c.arc(x, y, 1.1, 0, Math.PI * 2); c.fill();
      });
    }
    c.globalCompositeOperation = "source-over";
    return sn ? [sr / sn, sg / sn, sb / sn] : null;
  }
}

export const DEFAULT_LAYOUT = [
  // what a migrated older setup looks like: the headers are lit as one line until Find fans splits them
  // (psx/prot: the preview's placement for that part)
  { id: "hdr58", kind: "strip", label: "ARGB header 1", x: 152, y: 32, w: 200, leds: 36, channel: 0x58, source: "argb", unsplit: true, psx: 0.71 },
  { id: "pump", kind: "pump", label: "Pump", x: 98, y: 108, r: 22, leds: 0, source: "none" },
  { id: "ram1", kind: "ram", label: "RAM 1", showLabel: false, x: 146, y: 106, h: 40, leds: 8, source: "ram", index: 0 },
  { id: "ram2", kind: "ram", label: "RAM 2", x: 154, y: 106, h: 40, leds: 8, source: "ram", index: 1 },
  { id: "gpu", kind: "gpu", label: "RTX 5080", x: 120, y: 157, w: 150, h: 18, leds: 1, source: "gpu" },
  { id: "hdr59", kind: "strip", label: "ARGB header 2", x: 246, y: 116, w: 200, leds: 24, channel: 0x59, source: "argb", unsplit: true, psx: 0.45, prot: 90 },
  { id: "board", kind: "board", label: "Board", x: 184, y: 76, leds: 4, source: "board" },
  { id: "mouse", kind: "mouse", label: "Pulsefire Haste 2", x: 306, y: 168, leds: 1, source: "mouse" },
  { id: "monitor", kind: "monitor", label: "AW2725QF", x: 260, y: 10, w: 60, h: 8, leds: 1, source: "monitor" },
];
