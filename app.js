// Host PWA entry: hash router  #/  |  #/project/:id  |  #/show/:id[?local=1]
import { registerSW } from './ui.js';
import { mountDashboard } from './dashboard.js';
import { mountEditor } from './editor.js';
import { mountShow } from './show.js';
import { sync, normalizeSyncCode } from './sync.js';

registerSW('./sw.js');

// Device sync starts as soon as the app opens (on every page of the app).
const syncReady = sync.init();

// "Add a device" links look like  …/#/?sync=K7QF-M2XA-9TRD
async function handleSyncLink() {
  const m = location.hash.match(/[?&]sync=([A-Za-z0-9-]+)/);
  if (!m) return;
  const code = normalizeSyncCode(m[1]);
  history.replaceState(null, '', location.pathname + location.search + '#/');
  await syncReady;
  if (!code || code === sync.code) return;
  const msg = sync.code
    ? `Switch this device to sync group ${code}? It will stop syncing with its current group.`
    : `Join sync group ${code}? This device will receive all projects and media from your other host devices.`;
  if (confirm(msg)) await sync.join(code);
}

const root = document.getElementById('app');
let cleanup = null;

// keep the install prompt for the dashboard's "install" button
window.__installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); window.__installPrompt = e; window.dispatchEvent(new Event('installable')); });

async function route() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  if (cleanup) { try { await cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  root.replaceChildren();
  window.scrollTo(0, 0);
  if (parts[0] === 'project' && parts[1]) cleanup = await mountEditor(root, parts[1]);
  else if (parts[0] === 'show' && parts[1]) cleanup = await mountShow(root, parts[1], { backend: params.get('local') === '1' ? 'local' : 'peer' });
  else cleanup = await mountDashboard(root);
}

window.__remount = route;
window.addEventListener('hashchange', route);
handleSyncLink().then(route);
