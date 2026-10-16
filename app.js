// Host PWA entry: hash router  #/  |  #/project/:id  |  #/show/:id[?local=1]
import { registerSW } from '../shared/ui.js';
import { mountDashboard } from './dashboard.js';
import { mountEditor } from './editor.js';
import { mountShow } from './show.js';

registerSW('./sw.js');

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

window.addEventListener('hashchange', route);
route();
