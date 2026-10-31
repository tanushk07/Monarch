// Layout editor: the effect canvas with a box for every lit part. Drag to move,
// corner handles resize freely (Shift keeps the shape), edge handles stretch one way,
// the top dot rotates. Several parts can be moved, resized and rotated together.
// Coordinates are effect-canvas units (320 x 200).
import { CANVAS_W, CANVAS_H, localLeds, partSize, placeOf, toCanvas } from "./rig.js";

const NS = "http://www.w3.org/2000/svg";
const PAD_X = 18, PAD_Y = 14;
const VB = { x: -PAD_X, y: -PAD_Y, w: CANVAS_W + PAD_X * 2, h: CANVAS_H + PAD_Y * 2 };
const MIN_S = 0.05, MAX_S = 12;

function el(name, attrs = {}, parent) {
  const e = document.createElementNS(NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const deg = (r) => (r * 180) / Math.PI;
const clampS = (v) => Math.max(MIN_S, Math.min(MAX_S, v));
const rotV = (x, y, a) => { const c = Math.cos(a), s = Math.sin(a); return [x * c - y * s, x * s + y * c]; };

// Outline of a part around its own centre, as SVG elements (drawn inside a scaled group).
function drawShape(g, it) {
  const { w, h } = partSize(it);
  const stroke = { fill: "none", stroke: "currentColor", "stroke-width": 0.7, "vector-effect": "non-scaling-stroke" };
  switch (it.kind) {
    case "fan":
      el("rect", { x: -w / 2, y: -h / 2, width: w, height: h, rx: 3, ...stroke }, g);
      el("circle", { cx: 0, cy: 0, r: w * 0.43, ...stroke, opacity: 0.45 }, g);
      el("circle", { cx: 0, cy: 0, r: w * 0.1, ...stroke, opacity: 0.6 }, g);
      break;
    case "pump":
      el("circle", { cx: 0, cy: 0, r: w / 2, ...stroke }, g);
      break;
    case "mouse":
      el("path", { d: "M-8 -4 C-8 -16 8 -16 8 -4 L8 8 C8 17 -8 17 -8 8 Z", ...stroke }, g);
      break;
    default:
      el("rect", { x: -w / 2, y: -h / 2, width: w, height: h, rx: Math.min(3, h / 2), ...stroke }, g);
  }
}

export class LayoutEditor {
  constructor(root, { onChange, onSelect } = {}) {
    this.root = root;
    this.onChange = onChange || (() => {});
    this.onSelect = onSelect || (() => {});
    this.parts = [];
    this.items = [];        // placements
    this.sel = new Set();
    this.skip = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.leds = null;

    root.classList.add("editor");
    this.bg = document.createElement("canvas");
    this.bg.className = "ed-bg";
    Object.assign(this.bg.style, {
      left: (PAD_X / VB.w) * 100 + "%", top: (PAD_Y / VB.h) * 100 + "%",
      width: (CANVAS_W / VB.w) * 100 + "%", height: (CANVAS_H / VB.h) * 100 + "%",
    });
    this.bg.width = 320; this.bg.height = 200;
    this.tmp = document.createElement("canvas");
    this.svg = el("svg", { class: "ed-svg", viewBox: `${VB.x} ${VB.y} ${VB.w} ${VB.h}`, tabindex: 0 });
    root.append(this.bg, this.svg);
    el("rect", { x: 0, y: 0, width: CANVAS_W, height: CANVAS_H, class: "ed-edge" }, this.svg);
    this.gParts = el("g", {}, this.svg);
    this.gDots = el("g", { class: "ed-dots" }, this.svg);
    this.gLabels = el("g", { class: "ed-labels" }, this.svg);
    this.gSel = el("g", { class: "ed-sel" }, this.svg);
    this.marquee = el("rect", { class: "ed-marquee", visibility: "hidden" }, this.svg);

    this.svg.addEventListener("pointerdown", (e) => this.down(e));
    this.svg.addEventListener("pointermove", (e) => this.move(e));
    this.svg.addEventListener("pointerup", (e) => this.up(e));
    this.svg.addEventListener("pointercancel", (e) => this.up(e));
    this.svg.addEventListener("keydown", (e) => this.key(e));
  }

  // skip: ids of parts that are not drawn (no LEDs, or a device Monarch can't drive yet)
  setData(parts, items, skip = new Set()) {
    this.parts = parts;
    this.skip = skip;
    this.items = clone(items).map((p) => ({ ...p, sx: p.sx || p.scale || 1, sy: p.sy || p.scale || 1 }));
    for (const id of [...this.sel]) if (!this.visible(id)) this.sel.delete(id);
    this.offsets = {};
    let off = 0;
    for (const p of parts) { this.offsets[p.id] = off; off += localLeds(p).length; }
    this.total = off;
    this.draw();
  }

  resetHistory() { this.undoStack = []; this.redoStack = []; }
  part(id) { return this.parts.find((p) => p.id === id); }
  place(id) { return this.items.find((p) => p.id === id); }
  visible(id) { const p = this.place(id); return !!(p && !p.hidden && this.part(id) && !this.skip.has(id)); }

  // ---- drawing --------------------------------------------------------------
  draw() {
    this.gParts.innerHTML = ""; this.gLabels.innerHTML = ""; this.gDots.innerHTML = "";
    this.dots = {};
    // selected parts last, so they sit on top and can always be grabbed
    const order = this.parts.filter((p) => this.visible(p.id)).sort((a, b) => (this.sel.has(a.id) ? 1 : 0) - (this.sel.has(b.id) ? 1 : 0));
    for (const part of order) {
      const pl = this.place(part.id);
      const g = el("g", { class: "ed-part" + (this.sel.has(part.id) ? " on" : ""), "data-id": part.id, transform: this.tf(pl) }, this.gParts);
      const { w, h } = partSize(part);
      el("rect", { x: -w / 2 - 2, y: -h / 2 - 2, width: w + 4, height: h + 4, class: "ed-hit" }, g);
      drawShape(g, part);
      // LEDs drawn in canvas space so they stay round however the part is stretched
      const P = placeOf(part, pl);
      this.dots[part.id] = localLeds(part).map(([x, y], i) => {
        const [cx, cy] = toCanvas(P, x, y);
        return el("circle", { cx, cy, r: i === 0 ? 2.1 : 1.5, class: i === 0 ? "ed-led first" : "ed-led" }, this.gDots);
      });
      const c = this.corners(part, pl);
      const bottom = Math.max(...c.map((q) => q[1])), cx = c.reduce((s, q) => s + q[0], 0) / 4;
      const t = el("text", { x: cx, y: Math.min(CANVAS_H + PAD_Y - 2, bottom + 6.5), "text-anchor": "middle" }, this.gLabels);
      // sticks sit side by side, so each gets just its number
      t.textContent = part.kind === "ram" ? String((part.index ?? 0) + 1) : part.label || part.id;
    }
    this.paintLeds();
    this.drawSelection();
  }

  tf(pl) { return `translate(${pl.x} ${pl.y}) rotate(${pl.rot || 0}) scale(${(pl.flip ? -1 : 1) * pl.sx} ${pl.sy})`; }

  corners(part, pl) {
    const { w, h } = partSize(part);
    const P = placeOf(part, pl);
    return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => toCanvas({ ...P, flip: false }, x, y));
  }

  setLeds(bytes) { this.leds = bytes; this.paintLeds(); }
  paintLeds() {
    if (!this.dots) return;
    const L = this.leds && this.leds.length === this.total * 3 ? this.leds : null;
    const lift = (v) => Math.round(255 * Math.pow(v / 255, 0.7));
    for (const id in this.dots) {
      const off = this.offsets[id];
      this.dots[id].forEach((d, k) => {
        if (!L) { d.style.fill = ""; return; }
        const i = (off + k) * 3;
        d.style.fill = `rgb(${lift(L[i])},${lift(L[i + 1])},${lift(L[i + 2])})`;
      });
    }
  }

  // What sits behind the parts: the effect itself, or a picture of the watched screen area.
  setBackground(mode) { this.bgMode = mode; if (mode === "effect") { this.bg.width = 320; this.bg.height = 200; } }
  setOpacity(v) { this.bg.style.opacity = String(Math.max(0, Math.min(1, v))); }
  setScreen(url) {
    if (this.bgMode !== "screen") return;
    const im = this._screenImg || (this._screenImg = new Image());
    im.onload = () => {
      if (this.bgMode !== "screen") return;
      if (this.bg.width !== im.naturalWidth) { this.bg.width = im.naturalWidth; this.bg.height = im.naturalHeight; }
      this.bg.getContext("2d").drawImage(im, 0, 0, this.bg.width, this.bg.height);
    };
    im.src = url;
  }

  setFrame(fr) {
    if (this.bgMode === "screen") return;
    const c = this.bg.getContext("2d");
    if (this.tmp.width !== fr.w || this.tmp.height !== fr.h) { this.tmp.width = fr.w; this.tmp.height = fr.h; this.img = null; }
    const t = this.tmp.getContext("2d");
    if (!this.img) this.img = t.createImageData(fr.w, fr.h);
    const px = this.img.data;
    for (let i = 0, j = 0; j < fr.data.length; i += 4, j += 3) { px[i] = fr.data[j]; px[i + 1] = fr.data[j + 1]; px[i + 2] = fr.data[j + 2]; px[i + 3] = 255; }
    t.putImageData(this.img, 0, 0);
    c.imageSmoothingEnabled = true;
    c.drawImage(this.tmp, 0, 0, this.bg.width, this.bg.height);
  }

  // Selection box: for one part its own rotated box, for several the box around all of them.
  selBox() {
    const ids = [...this.sel].filter((id) => this.visible(id));
    if (!ids.length) return null;
    if (ids.length === 1) {
      const part = this.part(ids[0]), pl = this.place(ids[0]);
      return { ids, c: this.corners(part, pl), center: [pl.x, pl.y], rot: pl.rot || 0, single: true };
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of ids) for (const [x, y] of this.corners(this.part(id), this.place(id))) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return { ids, c: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], center: [(x0 + x1) / 2, (y0 + y1) / 2], rot: 0, single: false, bounds: [x0, y0, x1, y1] };
  }

  drawSelection() {
    this.gSel.innerHTML = "";
    for (const g of this.gParts.children) g.classList.toggle("on", this.sel.has(g.dataset.id));
    const b = this.selBox();
    if (!b) return;
    el("path", { d: "M" + b.c.map((q) => q.join(" ")).join(" L") + " Z", class: "ed-box" }, this.gSel);
    // handles: corners (hx, hy) and edge middles
    const H = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [1, 0], [0, 1], [-1, 0]];
    const mid = (a, b2) => [(a[0] + b2[0]) / 2, (a[1] + b2[1]) / 2];
    const pos = [b.c[0], b.c[1], b.c[2], b.c[3], mid(b.c[0], b.c[1]), mid(b.c[1], b.c[2]), mid(b.c[2], b.c[3]), mid(b.c[3], b.c[0])];
    H.forEach(([hx, hy], i) => {
      const [x, y] = pos[i];
      const corner = hx && hy;
      const a = (b.rot * Math.PI) / 180;
      const ang = ((deg(Math.atan2(hy, hx) + a) % 180) + 180) % 180;
      const cursor = ang < 22.5 || ang >= 157.5 ? "ew-resize" : ang < 67.5 ? "nwse-resize" : ang < 112.5 ? "ns-resize" : "nesw-resize";
      el("rect", { x: x - (corner ? 2.4 : 1.9), y: y - (corner ? 2.4 : 1.9), width: corner ? 4.8 : 3.8, height: corner ? 4.8 : 3.8, rx: corner ? 1 : 1.9,
        class: "ed-handle" + (corner ? "" : " edge"), "data-h": "scale", "data-hx": hx, "data-hy": hy, style: `cursor:${cursor}` }, this.gSel);
    });
    // rotate handle: out from the middle of the top edge
    const top = mid(b.c[0], b.c[1]);
    const a = ((b.rot - 90) * Math.PI) / 180;
    const rh = [top[0] + Math.cos(a) * 11, top[1] + Math.sin(a) * 11];
    el("line", { x1: top[0], y1: top[1], x2: rh[0], y2: rh[1], class: "ed-box" }, this.gSel);
    el("circle", { cx: rh[0], cy: rh[1], r: 3, class: "ed-handle rot", "data-h": "rotate" }, this.gSel);
  }

  // ---- interaction ------------------------------------------------------------
  pt(e) {
    const m = this.svg.getScreenCTM().inverse();
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
    return [p.x, p.y];
  }

  // The part under a point: a selected one first, otherwise the smallest, so a big
  // stretched part never hides the ones underneath it.
  pick(p) {
    let best = null, bestArea = Infinity;
    for (const part of this.parts) {
      if (!this.visible(part.id)) continue;
      const pl = this.place(part.id), P = placeOf(part, pl);
      const { w, h } = partSize(part);
      const [lx, ly] = rotV(p[0] - P.x, p[1] - P.y, (-(P.rot || 0) * Math.PI) / 180);
      const hw = (w / 2) * P.sx + 2, hh = (h / 2) * P.sy + 2;
      if (Math.abs(lx) > hw || Math.abs(ly) > hh) continue;
      const area = hw * hh * (this.sel.has(part.id) ? 1e-6 : 1);
      if (area < bestArea) { bestArea = area; best = part.id; }
    }
    return best;
  }

  down(e) {
    if (e.button !== 0) return;
    this.svg.focus({ preventScroll: true });
    const p = this.pt(e);
    const handle = e.target.closest("[data-h]");
    this.svg.setPointerCapture(e.pointerId);
    if (handle) {
      const b = this.selBox();
      this.drag = { mode: handle.dataset.h, start: p, center: b.center, base: clone(this.items), ids: b.ids, box: b,
        hx: +handle.dataset.hx || 0, hy: +handle.dataset.hy || 0 };
      return;
    }
    const id = this.pick(p);
    if (id) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) { this.sel.has(id) ? this.sel.delete(id) : this.sel.add(id); }
      else if (!this.sel.has(id)) this.sel = new Set([id]);
      this.draw(); this.onSelect([...this.sel]);
      this.drag = { mode: "move", start: p, base: clone(this.items), ids: [...this.sel] };
      return;
    }
    if (!(e.shiftKey || e.ctrlKey)) { this.sel.clear(); this.draw(); this.onSelect([]); }
    this.drag = { mode: "marquee", start: p, keep: new Set(this.sel) };
  }

  move(e) {
    const d = this.drag;
    if (!d) return;
    const p = this.pt(e);
    const dx = p[0] - d.start[0], dy = p[1] - d.start[1];
    if (d.mode === "marquee") {
      const x = Math.min(p[0], d.start[0]), y = Math.min(p[1], d.start[1]), w = Math.abs(dx), h = Math.abs(dy);
      Object.entries({ x, y, width: w, height: h, visibility: "visible" }).forEach(([k, v]) => this.marquee.setAttribute(k, v));
      this.sel = new Set(d.keep);
      for (const it of this.items) if (this.visible(it.id) && it.x >= x && it.x <= x + w && it.y >= y && it.y <= y + h) this.sel.add(it.id);
      this.drawSelection();
      return;
    }
    d.moved = d.moved || Math.hypot(dx, dy) > 0.4;
    if (!d.moved) return;
    if (d.mode === "move") {
      for (const id of d.ids) {
        const b = d.base.find((q) => q.id === id), it = this.place(id);
        if (!b || !it) continue;
        let nx = b.x + dx, ny = b.y + dy;
        if (e.altKey) { nx = Math.round(nx / 5) * 5; ny = Math.round(ny / 5) * 5; }
        it.x = nx; it.y = ny;
      }
    } else if (d.mode === "scale") {
      if (d.box.single) this.resizeOne(d, p, e.shiftKey);
      else this.resizeGroup(d, p, e.shiftKey);
    } else if (d.mode === "rotate") {
      let a = Math.atan2(p[1] - d.center[1], p[0] - d.center[0]) - Math.atan2(d.start[1] - d.center[1], d.start[0] - d.center[0]);
      if (e.shiftKey) a = (Math.round(deg(a) / 15) * 15 * Math.PI) / 180;
      for (const id of d.ids) {
        const b = d.base.find((q) => q.id === id), it = this.place(id);
        if (!b || !it) continue;
        const [ox, oy] = rotV(b.x - d.center[0], b.y - d.center[1], a);
        it.x = d.center[0] + ox; it.y = d.center[1] + oy;
        it.rot = (((b.rot || 0) + deg(a)) % 360 + 360) % 360;
      }
    }
    this.draw();
    this.emit(false);
  }

  // One part: the opposite corner (or edge) stays put, the dragged one follows the pointer.
  resizeOne(d, p, keepShape) {
    const id = d.ids[0], b = d.base.find((q) => q.id === id), it = this.place(id), part = this.part(id);
    const { w, h } = partSize(part);
    const a = ((b.rot || 0) * Math.PI) / 180;
    const [lx, ly] = rotV(p[0] - b.x, p[1] - b.y, -a);         // pointer in the part's own axes
    const W0 = w * b.sx, H0 = h * b.sy;
    let W = W0, Hh = H0, cx = 0, cy = 0;
    if (d.hx) { const ax = (-d.hx * W0) / 2; W = Math.max(w * MIN_S, d.hx * (lx - ax)); cx = ax + (d.hx * W) / 2; }
    if (d.hy) { const ay = (-d.hy * H0) / 2; Hh = Math.max(h * MIN_S, d.hy * (ly - ay)); cy = ay + (d.hy * Hh) / 2; }
    let sx = W / w, sy = Hh / h;
    if (keepShape || (part.kind === "mouse")) {
      const k = d.hx && d.hy ? Math.max(sx / b.sx, sy / b.sy) : d.hx ? sx / b.sx : sy / b.sy;
      sx = b.sx * k; sy = b.sy * k;
      if (d.hx) cx = (-d.hx * W0) / 2 + (d.hx * w * sx) / 2; else cx = 0;
      if (d.hy) cy = (-d.hy * H0) / 2 + (d.hy * h * sy) / 2; else cy = 0;
    }
    it.sx = clampS(sx); it.sy = clampS(sy);
    const [ox, oy] = rotV(cx, cy, a);
    it.x = b.x + ox; it.y = b.y + oy;
  }

  // Several parts: stretch the group box; each part grows along its own axes.
  resizeGroup(d, p, keepShape) {
    const [x0, y0, x1, y1] = d.box.bounds;
    const ax = d.hx > 0 ? x0 : x1, ay = d.hy > 0 ? y0 : y1;
    let fx = d.hx ? Math.max(0.05, (p[0] - ax) / ((d.hx > 0 ? x1 : x0) - ax)) : 1;
    let fy = d.hy ? Math.max(0.05, (p[1] - ay) / ((d.hy > 0 ? y1 : y0) - ay)) : 1;
    if (keepShape) { const k = d.hx && d.hy ? Math.max(fx, fy) : d.hx ? fx : fy; fx = fy = k; }
    const cxA = d.hx ? ax : (x0 + x1) / 2, cyA = d.hy ? ay : (y0 + y1) / 2;
    for (const id of d.ids) {
      const b = d.base.find((q) => q.id === id), it = this.place(id);
      if (!b || !it) continue;
      it.x = cxA + (b.x - cxA) * fx; it.y = cyA + (b.y - cyA) * fy;
      const r = (((b.rot || 0) % 180) + 180) % 180;
      if (r < 10 || r > 170) { it.sx = clampS(b.sx * fx); it.sy = clampS(b.sy * fy); }
      else if (Math.abs(r - 90) < 10) { it.sx = clampS(b.sx * fy); it.sy = clampS(b.sy * fx); }
      else { const k = Math.sqrt(fx * fy); it.sx = clampS(b.sx * k); it.sy = clampS(b.sy * k); }
    }
  }

  up(e) {
    const d = this.drag;
    this.drag = null;
    try { this.svg.releasePointerCapture(e.pointerId); } catch {}
    this.marquee.setAttribute("visibility", "hidden");
    if (!d) return;
    if (d.mode === "marquee") { this.draw(); this.onSelect([...this.sel]); return; }
    if (d.moved) { this.pushUndo(d.base); this.emit(true); }
  }

  key(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); this.redo(); return; }
    if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); this.sel = new Set(this.items.filter((i) => this.visible(i.id)).map((i) => i.id)); this.draw(); this.onSelect([...this.sel]); return; }
    if (e.key === "Escape") { this.sel.clear(); this.draw(); this.onSelect([]); return; }
    if (!this.sel.size) return;
    const step = e.shiftKey ? 10 : 1;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      this.edit((it) => { it.x += moves[e.key][0]; it.y += moves[e.key][1]; });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      this.edit((it) => { it.hidden = true; });
      this.sel.clear(); this.onSelect([]);
      this.draw();
    }
  }

  // Apply a change to every selected part, with undo.
  edit(fn, ids = [...this.sel]) {
    const base = clone(this.items);
    for (const id of ids) { const it = this.place(id); if (it) fn(it, this.part(id)); }
    this.pushUndo(base);
    this.draw();
    this.emit(true);
  }

  pushUndo(base) { this.undoStack.push(base); if (this.undoStack.length > 80) this.undoStack.shift(); this.redoStack = []; }
  undo() { if (!this.undoStack.length) return; this.redoStack.push(clone(this.items)); this.items = this.undoStack.pop(); this.draw(); this.emit(true); }
  redo() { if (!this.redoStack.length) return; this.undoStack.push(clone(this.items)); this.items = this.redoStack.pop(); this.draw(); this.emit(true); }

  select(ids) { this.sel = new Set(ids.filter((id) => this.visible(id))); this.draw(); this.onSelect([...this.sel]); }

  emit(final) {
    if (final) { this.lastEmit = 0; this.onChange(this.items, true); return; }
    const now = performance.now();
    if (now - (this.lastEmit || 0) > 70) { this.lastEmit = now; this.onChange(this.items, false); }
  }
}
