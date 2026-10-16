// QR rendering. Uses the tiny `qrcode-generator` library from a CDN (cached by the service
// worker after the first online load). If it can't load, we fall back to showing the URL.
const QR_URL = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js';
let qrPromise = null;

function loadQR() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  if (!qrPromise) {
    qrPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = QR_URL;
      s.crossOrigin = 'anonymous';
      s.onload = () => (window.qrcode ? resolve(window.qrcode) : reject(new Error('qr lib missing')));
      s.onerror = () => { qrPromise = null; reject(new Error('qr lib offline')); };
      document.head.appendChild(s);
    });
  }
  return qrPromise;
}

/** Returns an SVG string (square, scalable) or null if the library is unavailable. */
export async function qrSvg(text, { dark = '#0b0b14', light = '#ffffff', margin = 2 } = {}) {
  try {
    const qrcode = await loadQR();
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const size = n + margin * 2;
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR"><rect width="100%" height="100%" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
  } catch (e) {
    return null;
  }
}

/** Render a QR into an element; fallback to a readable URL. */
export async function renderQR(el, text, opts) {
  const svg = await qrSvg(text, opts);
  if (svg) {
    el.innerHTML = svg;
    el.classList.remove('qr-fallback');
  } else {
    el.classList.add('qr-fallback');
    el.textContent = text;
  }
}
