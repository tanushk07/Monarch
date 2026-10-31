// Faces for the round 480 x 480 pump screen. Used by the live renderer that
// feeds the pump and by the preview in the UI, so both always match.

const TAU = Math.PI * 2;
const F_DISPLAY = '"Chakra Petch", "Segoe UI", sans-serif';
const F_TEXT = 'Figtree, "Segoe UI", sans-serif';

function rgbOf(hex) { const n = parseInt((hex || "#78B8FF").slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }

function backdrop(c, accent) {
  const [r, g, b] = rgbOf(accent);
  c.fillStyle = "#070B22";
  c.fillRect(0, 0, 480, 480);
  const gr = c.createRadialGradient(240, 300, 20, 240, 260, 300);
  gr.addColorStop(0, `rgba(${r},${g},${b},0.20)`);
  gr.addColorStop(1, "rgba(7,11,34,0)");
  c.fillStyle = gr;
  c.fillRect(0, 0, 480, 480);
}

function arc(c, from, to, color, width, r = 214) {
  c.beginPath();
  c.arc(240, 240, r, from, to);
  c.strokeStyle = color;
  c.lineWidth = width;
  c.lineCap = "round";
  c.stroke();
}

// Gauge that sweeps 270° from bottom-left to bottom-right.
function gauge(c, frac, accent) {
  const a0 = Math.PI * 0.75, span = Math.PI * 1.5;
  arc(c, a0, a0 + span, "rgba(237,241,251,0.10)", 14);
  const f = Math.max(0, Math.min(1, frac));
  if (f > 0.002) {
    c.save();
    c.shadowColor = accent; c.shadowBlur = 18;
    arc(c, a0, a0 + span * f, accent, 14);
    c.restore();
  }
  for (let i = 0; i <= 30; i++) {
    const a = a0 + (span * i) / 30;
    const r1 = 188, r2 = i % 5 ? 194 : 198;
    c.beginPath();
    c.moveTo(240 + Math.cos(a) * r1, 240 + Math.sin(a) * r1);
    c.lineTo(240 + Math.cos(a) * r2, 240 + Math.sin(a) * r2);
    c.strokeStyle = i / 30 <= f ? "rgba(237,241,251,.75)" : "rgba(237,241,251,.18)";
    c.lineWidth = 2;
    c.stroke();
  }
}

function heatColor(t, cold, hot) {
  const k = Math.max(0, Math.min(1, (t - cold) / (hot - cold)));
  const a = [120, 184, 255], b = [255, 107, 94];
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(",")})`;
}

export function drawVitals(c, s, opt = {}) {
  const accent = opt.accent || "#78B8FF";
  backdrop(c, accent);
  const has = s.coolant != null && s.coolant > 0;
  const t = has ? s.coolant : 20;
  const color = opt.heatTint === false ? accent : heatColor(t, 26, 44);
  gauge(c, has ? (t - 20) / 30 : 0, color);

  c.textAlign = "center";
  c.fillStyle = "#EDF1FB";
  c.font = `600 132px ${F_DISPLAY}`;
  const whole = has ? String(Math.floor(t)) : "--", dec = has ? Math.floor((t - Math.floor(t)) * 10) : "-";
  c.textBaseline = "alphabetic";
  const wWhole = c.measureText(whole).width;
  c.font = `500 52px ${F_DISPLAY}`;
  const wDec = c.measureText("." + dec).width;
  const x0 = 240 - (wWhole + wDec) / 2;
  c.textAlign = "left";
  c.font = `600 132px ${F_DISPLAY}`;
  c.fillText(whole, x0, 268);
  c.font = `500 52px ${F_DISPLAY}`;
  c.fillStyle = "rgba(237,241,251,.62)";
  c.fillText("." + dec, x0 + wWhole + 2, 268);
  c.textAlign = "center";
  c.font = `500 26px ${F_TEXT}`;
  c.fillStyle = "rgba(140,149,194,1)";
  c.fillText("coolant °C", 240, 306);

  const items = [["CPU", s.cpu], ["GPU", s.gpu]];
  c.font = `600 40px ${F_DISPLAY}`;
  items.forEach(([k, v], i) => {
    const x = i ? 300 : 180;
    c.fillStyle = "#EDF1FB";
    c.fillText(v == null ? "--" : Math.round(v) + "°", x, 372);
    c.font = `500 20px ${F_TEXT}`;
    c.fillStyle = "rgba(140,149,194,1)";
    c.fillText(k, x, 398);
    c.font = `600 40px ${F_DISPLAY}`;
  });
  c.fillStyle = "rgba(237,241,251,.18)";
  c.fillRect(239, 344, 2, 58);
}

export function drawClock(c, s, opt = {}) {
  const accent = opt.accent || "#78B8FF";
  backdrop(c, accent);
  const d = opt.now || new Date();
  const sec = d.getSeconds() + d.getMilliseconds() / 1000;
  arc(c, -Math.PI / 2, -Math.PI / 2 + TAU, "rgba(237,241,251,0.08)", 6, 220);
  c.save(); c.shadowColor = accent; c.shadowBlur = 14;
  arc(c, -Math.PI / 2, -Math.PI / 2 + (TAU * sec) / 60, accent, 6, 220);
  c.restore();
  const h = d.getHours(), m = d.getMinutes();
  const hh = String(opt.h12 ? ((h + 11) % 12) + 1 : h).padStart(2, "0"), mm = String(m).padStart(2, "0");
  c.textAlign = "center";
  c.fillStyle = "#EDF1FB";
  c.font = `600 124px ${F_DISPLAY}`;
  c.fillText(`${hh}:${mm}`, 240, 262);
  c.font = `500 28px ${F_TEXT}`;
  c.fillStyle = "rgba(140,149,194,1)";
  c.fillText(d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" }), 240, 312);
  if (s.coolant) {
    c.font = `600 30px ${F_DISPLAY}`;
    c.fillStyle = "rgba(237,241,251,.82)";
    c.fillText(`${s.coolant.toFixed(1)}°`, 240, 380);
    c.font = `500 18px ${F_TEXT}`;
    c.fillStyle = "rgba(140,149,194,1)";
    c.fillText("coolant", 240, 404);
  }
}

// src: an <img>, <video>, <canvas> or a decoded frame (VideoFrame / ImageBitmap)
// opt.fit: cover (fill the circle), contain (whole picture), stretch; opt.zoom in %; opt.offX/offY in % of the screen.
export function drawMedia(c, src, s, opt = {}) {
  c.fillStyle = opt.bg || "#000"; c.fillRect(0, 0, 480, 480);
  if (src) {
    const w = src.displayWidth || src.videoWidth || src.naturalWidth || src.width, h = src.displayHeight || src.videoHeight || src.naturalHeight || src.height;
    if (w && h) {
      const z = Math.max(10, opt.zoom || 100) / 100;
      let dw, dh;
      if (opt.fit === "stretch") { dw = 480 * z; dh = 480 * z; }
      else { const k = (opt.fit === "contain" ? Math.min(480 / w, 480 / h) : Math.max(480 / w, 480 / h)) * z; dw = w * k; dh = h * k; }
      const dx = ((opt.offX || 0) / 100) * 480, dy = ((opt.offY || 0) / 100) * 480;
      c.imageSmoothingQuality = "high";
      c.drawImage(src, 240 - dw / 2 + dx, 240 - dh / 2 + dy, dw, dh);
    }
  }
}

// What the System info face can show. value(s) returns a number or null.
const gb = (mb) => (mb == null ? null : mb / 1024);
export const STATS = {
  coolant: { label: "Coolant", unit: "°C", value: (s) => s.coolant, digits: 1 },
  cpuTemp: { label: "CPU", unit: "°C", value: (s) => s.cpu },
  cpuLoad: { label: "CPU load", unit: "%", value: (s) => s.cpuLoad },
  cpuClock: { label: "CPU clock", unit: "GHz", value: (s) => (s.cpuClock == null ? null : s.cpuClock / 1000), digits: 2 },
  cpuPower: { label: "CPU power", unit: "W", value: (s) => s.cpuPower },
  gpuTemp: { label: "GPU", unit: "°C", value: (s) => s.gpu },
  gpuHotspot: { label: "GPU hot spot", unit: "°C", value: (s) => s.gpuHotspot },
  gpuLoad: { label: "GPU load", unit: "%", value: (s) => s.gpuLoad },
  gpuClock: { label: "GPU clock", unit: "MHz", value: (s) => s.gpuClock },
  gpuPower: { label: "GPU power", unit: "W", value: (s) => s.gpuPower },
  vramUsed: { label: "VRAM used", unit: "GB", value: (s) => gb(s.vramUsed), digits: 1 },
  ramLoad: { label: "RAM load", unit: "%", value: (s) => s.ramLoad },
  ramUsed: { label: "RAM used", unit: "GB", value: (s) => s.ramUsed, digits: 1 },
  ramSpeed: { label: "RAM speed", unit: "MT/s", value: (s) => s.ramSpeed },
  ramTemp: { label: "RAM", unit: "°C", value: (s) => s.ramTemp, digits: 1 },
  pump: { label: "Pump", unit: "rpm", value: (s) => s.pump },
  time: { label: "Time", unit: "", text: (s, opt) => { const d = new Date(), h = d.getHours(); return `${String(opt.h12 ? ((h + 11) % 12) + 1 : h).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; } },
  date: { label: "Date", unit: "", text: () => new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) },
};

function statText(key, s, opt = {}) {
  const st = STATS[key]; if (!st) return ["--", "", key];
  if (st.text) return [st.text(s, opt), "", st.label];
  const v = st.value(s);
  return [v == null || Number.isNaN(v) ? "--" : (st.digits ? v.toFixed(st.digits) : String(Math.round(v))), st.unit, st.label];
}

// A few readings, laid out to sit inside the circle.
export function drawSystem(c, s, opt = {}) {
  const accent = opt.accent || "#78B8FF";
  backdrop(c, accent);
  const keys = (opt.stats && opt.stats.length ? opt.stats : ["coolant", "cpuTemp", "gpuTemp", "cpuLoad"]).slice(0, 6);
  const cells = {
    1: [[240, 250, 1.6]],
    2: [[240, 185, 1.15], [240, 330, 1.15]],
    3: [[240, 175, 1.15], [160, 325, 0.85], [320, 325, 0.85]],
    4: [[160, 190, 0.95], [320, 190, 0.95], [160, 330, 0.95], [320, 330, 0.95]],
    5: [[240, 130, 0.8], [160, 245, 0.8], [320, 245, 0.8], [160, 360, 0.8], [320, 360, 0.8]],
    6: [[160, 140, 0.75], [320, 140, 0.75], [160, 255, 0.75], [320, 255, 0.75], [160, 370, 0.75], [320, 370, 0.75]],
  }[keys.length];
  arc(c, -Math.PI / 2, Math.PI * 1.5, "rgba(237,241,251,0.07)", 4, 226);
  c.textAlign = "center"; c.textBaseline = "alphabetic";
  keys.forEach((k, i) => {
    const [x, y, z] = cells[i];
    const [val, unit, label] = statText(k, s, opt);
    c.fillStyle = "#EDF1FB";
    c.font = `600 ${Math.round(64 * z)}px ${F_DISPLAY}`;
    const w = c.measureText(val).width;
    c.font = `500 ${Math.round(24 * z)}px ${F_DISPLAY}`;
    const wu = c.measureText(unit).width;
    const x0 = x - (w + wu + 4) / 2;
    c.textAlign = "left";
    c.font = `600 ${Math.round(64 * z)}px ${F_DISPLAY}`;
    c.fillText(val, x0, y);
    c.font = `500 ${Math.round(24 * z)}px ${F_DISPLAY}`;
    c.fillStyle = "rgba(237,241,251,.6)";
    c.fillText(unit, x0 + w + 4, y);
    c.textAlign = "center";
    c.font = `500 ${Math.round(20 * Math.max(0.8, z))}px ${F_TEXT}`;
    c.fillStyle = accent;
    c.fillText(label.toUpperCase(), x, y + Math.round(30 * Math.max(0.8, z)));
  });
}

export function drawEffect(c, effectCanvas, s, opt = {}) {
  c.fillStyle = "#000"; c.fillRect(0, 0, 480, 480);
  if (effectCanvas) c.drawImage(effectCanvas, 40, 0, 240, 200, 0, 0, 480, 480);
}

// Readings drawn on top of a picture, video, capture or the effect.
// Each: { stat, x, y (0..1 of the screen, the value's centre), size (px), color, label, unit }
export function drawOverlays(c, s, list, opt = {}) {
  for (const o of list || []) {
    if (o.hidden) continue;
    const [val, unit, label] = statText(o.stat, s, opt);
    const size = Math.max(12, Math.min(200, o.size || 48));
    const x = (o.x ?? 0.5) * 480, y = (o.y ?? 0.5) * 480;
    const col = o.color || "#EDF1FB";
    c.save();
    c.shadowColor = "rgba(0,0,0,.65)"; c.shadowBlur = size * 0.22; c.shadowOffsetY = size * 0.03;
    c.textBaseline = "middle";
    c.font = `600 ${size}px ${F_DISPLAY}`;
    const w = c.measureText(val).width;
    const us = Math.round(size * 0.42);
    c.font = `500 ${us}px ${F_DISPLAY}`;
    const wu = o.unit === false || !unit ? 0 : c.measureText(unit).width + size * 0.06;
    const x0 = x - (w + wu) / 2;
    c.textAlign = "left";
    c.fillStyle = col;
    c.font = `600 ${size}px ${F_DISPLAY}`;
    c.fillText(val, x0, y);
    if (wu) { c.globalAlpha = 0.7; c.font = `500 ${us}px ${F_DISPLAY}`; c.fillText(unit, x0 + w + size * 0.06, y - size * 0.12); c.globalAlpha = 1; }
    if (o.label !== false) {
      c.textAlign = "center";
      c.globalAlpha = 0.75;
      c.font = `600 ${Math.max(10, Math.round(size * 0.3))}px ${F_TEXT}`;
      c.fillText(label.toUpperCase(), x, y + size * 0.62);
    }
    c.restore();
  }
}

export const OVERLAY_MODES = new Set(["media", "effect", "screen", "window"]);

export function drawFace(c, mode, s, opt = {}) {
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  if (opt.rotation) { c.translate(240, 240); c.rotate((opt.rotation * Math.PI) / 180); c.translate(-240, -240); }
  switch (mode) {
    case "vitals": drawVitals(c, s, opt); break;
    case "clock": drawClock(c, s, opt); break;
    case "media": drawMedia(c, opt.media, s, opt); break;
    case "screen": case "window": drawMedia(c, opt.capture, s, opt); break;
    case "system": drawSystem(c, s, opt); break;
    case "effect": drawEffect(c, opt.effectCanvas, s, opt); break;
    default: c.fillStyle = "#000"; c.fillRect(0, 0, 480, 480);
  }
  if (OVERLAY_MODES.has(mode) && opt.overlays?.length) drawOverlays(c, s, opt.overlays, opt);
  c.restore();
}
