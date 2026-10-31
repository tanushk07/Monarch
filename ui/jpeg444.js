// Baseline JPEG encoder with no chroma subsampling (4:4:4).
// The pump screen's decoder shows garbage in the lower half for 4:2:0 files,
// and browsers' built-in encoders subsample, so frames are encoded here.

const ZIGZAG = new Uint8Array([
  0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42, 3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18, 24, 31, 40, 44, 53,
  10, 19, 23, 32, 39, 45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60, 21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63,
]);
const STD_LUM_Q = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const STD_CHR_Q = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];

const DC_LUM_NRCODES = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_LUM_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUM_NRCODES = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUM_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa];
const DC_CHR_NRCODES = [0, 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_CHR_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_CHR_NRCODES = [0, 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHR_VALUES = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
  0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
  0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
  0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa];

function buildHuffman(nrcodes, values) {
  // returns table[value] = [code, length]
  const table = [];
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let j = 0; j < nrcodes[len]; j++) table[values[k++]] = [code++, len];
    code <<= 1;
  }
  return table;
}
const HT_DC_Y = buildHuffman(DC_LUM_NRCODES, DC_LUM_VALUES);
const HT_AC_Y = buildHuffman(AC_LUM_NRCODES, AC_LUM_VALUES);
const HT_DC_C = buildHuffman(DC_CHR_NRCODES, DC_CHR_VALUES);
const HT_AC_C = buildHuffman(AC_CHR_NRCODES, AC_CHR_VALUES);

const AAN = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.5411961, 0.275899379];

function scaledTables(quality) {
  quality = Math.max(1, Math.min(100, quality | 0));
  const sf = quality < 50 ? Math.floor(5000 / quality) : Math.floor(200 - quality * 2);
  const qY = new Uint8Array(64), qC = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    qY[ZIGZAG[i]] = Math.min(255, Math.max(1, Math.floor((STD_LUM_Q[i] * sf + 50) / 100)));
    qC[ZIGZAG[i]] = Math.min(255, Math.max(1, Math.floor((STD_CHR_Q[i] * sf + 50) / 100)));
  }
  // divisor tables for the AAN float DCT, in natural order
  const fY = new Float64Array(64), fC = new Float64Array(64);
  let k = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    fY[k] = 1.0 / (qY[ZIGZAG[k]] * AAN[r] * AAN[c] * 8.0);
    fC[k] = 1.0 / (qC[ZIGZAG[k]] * AAN[r] * AAN[c] * 8.0);
    k++;
  }
  return { qY, qC, fY, fC };
}

function fdct(d, fdtbl, out) {
  for (let off = 0; off < 64; off += 8) {
    const d0 = d[off], d1 = d[off + 1], d2 = d[off + 2], d3 = d[off + 3], d4 = d[off + 4], d5 = d[off + 5], d6 = d[off + 6], d7 = d[off + 7];
    const t0 = d0 + d7, t7 = d0 - d7, t1 = d1 + d6, t6 = d1 - d6, t2 = d2 + d5, t5 = d2 - d5, t3 = d3 + d4, t4 = d3 - d4;
    let t10 = t0 + t3; const t13 = t0 - t3; let t11 = t1 + t2; let t12 = t1 - t2;
    d[off] = t10 + t11; d[off + 4] = t10 - t11;
    const z1 = (t12 + t13) * 0.707106781;
    d[off + 2] = t13 + z1; d[off + 6] = t13 - z1;
    t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
    const z5 = (t10 - t12) * 0.382683433, z2 = 0.5411961 * t10 + z5, z4 = 1.306562965 * t12 + z5, z3 = t11 * 0.707106781;
    const z11 = t7 + z3, z13 = t7 - z3;
    d[off + 5] = z13 + z2; d[off + 3] = z13 - z2; d[off + 1] = z11 + z4; d[off + 7] = z11 - z4;
  }
  for (let off = 0; off < 8; off++) {
    const d0 = d[off], d1 = d[off + 8], d2 = d[off + 16], d3 = d[off + 24], d4 = d[off + 32], d5 = d[off + 40], d6 = d[off + 48], d7 = d[off + 56];
    const t0 = d0 + d7, t7 = d0 - d7, t1 = d1 + d6, t6 = d1 - d6, t2 = d2 + d5, t5 = d2 - d5, t3 = d3 + d4, t4 = d3 - d4;
    let t10 = t0 + t3; const t13 = t0 - t3; let t11 = t1 + t2; let t12 = t1 - t2;
    d[off] = t10 + t11; d[off + 32] = t10 - t11;
    const z1 = (t12 + t13) * 0.707106781;
    d[off + 16] = t13 + z1; d[off + 48] = t13 - z1;
    t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
    const z5 = (t10 - t12) * 0.382683433, z2 = 0.5411961 * t10 + z5, z4 = 1.306562965 * t12 + z5, z3 = t11 * 0.707106781;
    const z11 = t7 + z3, z13 = t7 - z3;
    d[off + 40] = z13 + z2; d[off + 24] = z13 - z2; d[off + 8] = z11 + z4; d[off + 56] = z11 - z4;
  }
  for (let i = 0; i < 64; i++) {
    const v = d[i] * fdtbl[i];
    out[ZIGZAG[i]] = v > 0 ? (v + 0.5) | 0 : (v - 0.5) | 0;
  }
}

class BitWriter {
  constructor(size) { this.buf = new Uint8Array(size); this.pos = 0; this.acc = 0; this.n = 0; }
  byte(b) { if (this.pos >= this.buf.length) { const nb = new Uint8Array(this.buf.length * 2); nb.set(this.buf); this.buf = nb; } this.buf[this.pos++] = b; }
  word(w) { this.byte((w >> 8) & 255); this.byte(w & 255); }
  bits(code, len) {
    this.acc = (this.acc << len) | (code & ((1 << len) - 1));
    this.n += len;
    while (this.n >= 8) {
      const b = (this.acc >> (this.n - 8)) & 255;
      this.byte(b);
      if (b === 0xff) this.byte(0);
      this.n -= 8;
      this.acc &= (1 << this.n) - 1;
    }
  }
  flush() { if (this.n > 0) this.bits((1 << (8 - this.n)) - 1, 8 - this.n); }
}

function category(v) { let a = v < 0 ? -v : v, n = 0; while (a) { n++; a >>= 1; } return n; }

function encodeBlock(w, coefs, prevDC, dcT, acT) {
  const diff = coefs[0] - prevDC;
  const cat = category(diff);
  w.bits(dcT[cat][0], dcT[cat][1]);
  if (cat) w.bits(diff < 0 ? diff + (1 << cat) - 1 : diff, cat);
  let last = 63;
  while (last > 0 && coefs[last] === 0) last--;
  let run = 0;
  for (let i = 1; i <= last; i++) {
    const v = coefs[i];
    if (v === 0) { run++; continue; }
    while (run >= 16) { w.bits(acT[0xf0][0], acT[0xf0][1]); run -= 16; }
    const c = category(v);
    const sym = (run << 4) | c;
    w.bits(acT[sym][0], acT[sym][1]);
    w.bits(v < 0 ? v + (1 << c) - 1 : v, c);
    run = 0;
  }
  if (last < 63) w.bits(acT[0][0], acT[0][1]);
  return coefs[0];
}

function writeHeaders(w, width, height, t) {
  w.word(0xffd8);
  // APP0 JFIF 1.1, 96 x 96 dpi
  w.word(0xffe0); w.word(16); [0x4a, 0x46, 0x49, 0x46, 0].forEach((b) => w.byte(b)); w.byte(1); w.byte(1); w.byte(1); w.word(96); w.word(96); w.byte(0); w.byte(0);
  // DQT
  w.word(0xffdb); w.word(132);
  w.byte(0); for (let i = 0; i < 64; i++) w.byte(t.qY[i]);
  w.byte(1); for (let i = 0; i < 64; i++) w.byte(t.qC[i]);
  // SOF0, three components, all 1x1 sampling (4:4:4)
  w.word(0xffc0); w.word(17); w.byte(8); w.word(height); w.word(width); w.byte(3);
  w.byte(1); w.byte(0x11); w.byte(0);
  w.byte(2); w.byte(0x11); w.byte(1);
  w.byte(3); w.byte(0x11); w.byte(1);
  // DHT
  const dht = (cls, nr, vals) => { w.byte(cls); for (let i = 1; i <= 16; i++) w.byte(nr[i]); vals.forEach((v) => w.byte(v)); };
  w.word(0xffc4); w.word(2 + 4 * 17 + DC_LUM_VALUES.length + AC_LUM_VALUES.length + DC_CHR_VALUES.length + AC_CHR_VALUES.length);
  dht(0x00, DC_LUM_NRCODES, DC_LUM_VALUES);
  dht(0x10, AC_LUM_NRCODES, AC_LUM_VALUES);
  dht(0x01, DC_CHR_NRCODES, DC_CHR_VALUES);
  dht(0x11, AC_CHR_NRCODES, AC_CHR_VALUES);
  // SOS
  w.word(0xffda); w.word(12); w.byte(3);
  w.byte(1); w.byte(0x00); w.byte(2); w.byte(0x11); w.byte(3); w.byte(0x11);
  w.byte(0); w.byte(0x3f); w.byte(0);
}

const tableCache = new Map();

// rgba: Uint8ClampedArray / Uint8Array (width*height*4). Returns Uint8Array JPEG.
export function encodeJpeg444(rgba, width, height, quality = 40) {
  let t = tableCache.get(quality);
  if (!t) { t = scaledTables(quality); tableCache.set(quality, t); }
  const w = new BitWriter(64 * 1024);
  writeHeaders(w, width, height, t);
  const Y = new Float64Array(64), U = new Float64Array(64), V = new Float64Array(64);
  const cY = new Int32Array(64), cU = new Int32Array(64), cV = new Int32Array(64);
  let dY = 0, dU = 0, dV = 0;
  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      for (let k = 0; k < 64; k++) {
        const x = Math.min(width - 1, bx + (k & 7)), y = Math.min(height - 1, by + (k >> 3));
        const p = (y * width + x) * 4;
        const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
        Y[k] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
        U[k] = -0.168736 * r - 0.331264 * g + 0.5 * b;
        V[k] = 0.5 * r - 0.418688 * g - 0.081312 * b;
      }
      fdct(Y, t.fY, cY); fdct(U, t.fC, cU); fdct(V, t.fC, cV);
      dY = encodeBlock(w, cY, dY, HT_DC_Y, HT_AC_Y);
      dU = encodeBlock(w, cU, dU, HT_DC_C, HT_AC_C);
      dV = encodeBlock(w, cV, dV, HT_DC_C, HT_AC_C);
    }
  }
  w.flush();
  w.word(0xffd9);
  return w.buf.subarray(0, w.pos);
}

// Encode at the highest quality that fits in maxBytes.
export function encodeJpeg444Fit(rgba, width, height, maxBytes = 20000, start = 60) {
  let q = start, out;
  for (;;) {
    out = encodeJpeg444(rgba, width, height, q);
    if (out.length <= maxBytes || q <= 8) return out;
    q -= q > 30 ? 10 : 5;
  }
}
