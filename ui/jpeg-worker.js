// Encodes pump frames off the engine page's main thread, so effects and LEDs never wait on it.
// The pump rejects live frames above about 20 KB and falls back to its standby picture, so every
// frame is made to fit: quality adapts frame to frame, and a frame that comes out too big is
// encoded again at a lower quality until it fits.
import { encodeJpeg444 } from "./jpeg444.js";

const LIMIT = 20000;
let q = 60;
self.onmessage = (e) => {
  const { rgba, w, h } = e.data;
  const budget = Math.min(LIMIT, e.data.budget || LIMIT);
  const px = new Uint8ClampedArray(rgba);
  let out = encodeJpeg444(px, w, h, q);
  for (let tries = 0; out.length > budget && tries < 4 && q > 5; tries++) {
    // size grows roughly with quality in this range, so aim a bit under the budget
    q = Math.max(5, Math.min(q - 4, Math.round(q * (budget * 0.85) / out.length)));
    out = encodeJpeg444(px, w, h, q);
  }
  if (out.length > budget) { self.postMessage({ bytes: null, q }); return; }
  if (out.length < budget * 0.7 && q < 85) q = Math.min(85, q + 2);
  const bytes = new Uint8Array(out); // compact copy: the encoder hands back a view of a larger buffer
  self.postMessage({ bytes, q }, [bytes.buffer]);
};
