// Talks to the Monarch engine through WebView2. When the page is opened in a
// normal browser (design work), a simulated engine stands in.

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8ClampedArray(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function connect() {
  const wv = window.chrome && window.chrome.webview;
  if (!wv) {
    const { createMock } = await import("./mock.js");
    return createMock();
  }
  const listeners = {};
  const pending = new Map();
  let nextId = 1;
  wv.addEventListener("message", (e) => {
    const m = e.data;
    if (!m) return;
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error)) : res(m.result);
      return;
    }
    if (m.event) {
      let data = m.data;
      if (m.event === "frame" && data && typeof data.b64 === "string") data = { w: data.w, h: data.h, data: b64ToBytes(data.b64) };
      (listeners[m.event] || []).forEach((fn) => fn(data));
    }
  });
  return {
    live: true,
    call(method, ...args) {
      const id = nextId++;
      wv.postMessage({ id, method, args });
      return new Promise((res, rej) => pending.set(id, { res, rej }));
    },
    on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); },
  };
}
