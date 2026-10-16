// Dashboard: project grid ("+" card first), Join app address, and the global media library.
import { h, toast } from './ui.js';
import { icon } from './icons.js';
import { listProjects, saveProject, deleteProject, newProject, listMedia, addMedia, deleteMedia, getJoinBase, setJoinBase, dbEvents, isVideo } from './db.js';
import { sync, normalizeSyncCode } from './sync.js';
import { renderQR } from './qr.js';
import { PHASE_LABEL } from './protocol.js';
import { audio } from './audio.js';
import { uid } from './protocol.js';

export function topbar(...right) {
  const muteBtn = h('button.btn.sm.ghost', { title: 'Mute all sound', onclick: () => { audio.unlock(); audio.toggleMute(); } });
  const paint = () => { muteBtn.replaceChildren(icon(audio.muted ? 'mute' : 'vol'), audio.muted ? 'Muted' : 'Sound'); muteBtn.classList.toggle('on', audio.muted); };
  paint();
  const off = audio.onChange(paint);
  const syncPill = h('a.pill.sync-pill', { href: '#/', title: 'Device sync' });
  const paintSync = () => {
    const st = sync.status;
    const n = sync.otherDevices.length;
    syncPill.replaceChildren(
      h('span.dot', { class: st === 'online' ? 'online' : st === 'connecting' ? 'connecting' : '' }),
      st === 'off' ? 'Sync off' : st === 'connecting' ? 'Syncing…' : n ? `Synced · ${n} other device${n === 1 ? '' : 's'}` : 'Sync on · no other devices',
    );
  };
  paintSync();
  sync.addEventListener('update', paintSync);
  const bar = h('header.topbar',
    h('a.brand', { href: '#/' }, h('span.brand-mark', '✦'), h('span', 'Clicker Show', h('small', ' · Host'))),
    ...right,
    h('div.spacer'),
    syncPill,
    muteBtn,
  );
  bar.cleanup = () => { off(); sync.removeEventListener('update', paintSync); };
  return bar;
}

const fmtSize = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB');
const fmtDate = (t) => new Date(t).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Normalizes what the host typed into a usable https URL ending in "/" (or "" if invalid). */
export function normalizeJoinUrl(raw) {
  let v = String(raw || '').trim();
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try {
    const u = new URL(v);
    u.search = '';
    u.hash = '';
    if (!u.pathname.endsWith('/') && !/\.html?$/i.test(u.pathname)) u.pathname += '/';
    return u.toString();
  } catch (e) {
    return '';
  }
}

export async function mountDashboard(root) {
  const installBtn = h('button.btn.sm', { hidden: !window.__installPrompt, onclick: async () => { window.__installPrompt?.prompt(); window.__installPrompt = null; installBtn.hidden = true; } }, icon('download'), 'Install app');
  const onInstallable = () => { installBtn.hidden = false; };
  window.addEventListener('installable', onInstallable);
  const bar = topbar(installBtn);

  const grid = h('div.grid');
  const mediaList = h('div.media-list');
  const fileIn = h('input', { type: 'file', accept: 'audio/*,video/*,.mp3,.wav,.ogg,.m4a,.mp4,.webm,.mov', multiple: true, hidden: true, onchange: () => upload(fileIn.files) });
  const importIn = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: () => importProject(importIn.files[0]) });
  const drop = h('label.drop', icon('upload'), h('div', h('b', 'Upload music, sound effects & intro videos'), h('div.hint', 'MP3 / WAV / MP4 — saved on this device (and your synced devices) for every project')), fileIn);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); upload(e.dataTransfer.files); });

  /* ---------- Join app address ---------- */
  const joinIn = h('input.input', { type: 'url', placeholder: 'https://your-username.github.io/clicker-join/', spellcheck: false, autocomplete: 'off' });
  const joinStatus = h('span.hint');
  const joinPanel = h('section.panel.join-panel',
    h('div.row',
      h('h3', icon('phone'), 'Join app address'),
      h('div.spacer'),
      joinStatus,
    ),
    h('p.hint', 'Where you published the Join app (the participant PWA). The QR codes on screen send players there.'),
    h('form.row', { onsubmit: async (e) => { e.preventDefault(); await saveJoin(); } },
      joinIn,
      h('button.btn.primary.sm', { type: 'submit' }, 'Save'),
      h('button.btn.sm.ghost', { type: 'button', title: 'Open the Join app in a new tab', onclick: () => { const u = normalizeJoinUrl(joinIn.value); if (u) window.open(u, '_blank'); } }, icon('screen'), 'Test'),
    ),
  );
  async function saveJoin() {
    const raw = joinIn.value.trim();
    const url = normalizeJoinUrl(raw);
    if (raw && !url) { toast('That doesn’t look like a web address', 'error'); return; }
    await setJoinBase(url);
    joinIn.value = url;
    paintJoin(url);
    toast(url ? 'Join app address saved' : 'Join app address cleared', 'ok');
  }
  function paintJoin(url) {
    joinStatus.textContent = url ? '✓ Set' : 'Not set yet';
    joinStatus.style.color = url ? 'var(--ok)' : 'var(--accent)';
    joinPanel.classList.toggle('warn', !url);
  }
  const savedJoin = await getJoinBase();
  joinIn.value = savedJoin;
  paintJoin(savedJoin);

  /* ---------- live shows running on any synced device ---------- */
  const liveSection = h('section.live');
  function renderLive() {
    const shows = sync.liveShows();
    liveSection.hidden = !shows.length;
    liveSection.replaceChildren(
      h('div.section-head', h('h2', h('span.live-dot'), 'Live now'), h('p', 'Shows running on your synced devices')),
      h('div.live-list', shows.map((s) => {
        const remote = new URL('./remote.html', location.href);
        remote.search = '';
        remote.hash = '';
        remote.searchParams.set('pin', s.pin);
        remote.searchParams.set('key', s.remoteKey);
        if (s.backend === 'local') remote.searchParams.set('local', '1');
        const own = s.deviceId === sync.deviceId;
        return h('article.live-card',
          h('div.live-info',
            h('b', { dir: 'auto' }, s.projectName || 'Untitled'),
            h('span.hint', `${own ? 'This device' : s.deviceName} · code ${s.pin} · ${PHASE_LABEL[s.phase] || ''}${s.total ? ` · slide ${Math.min(s.idx + 1, s.total)}/${s.total}` : ''}${s.players != null ? ` · ${s.players} players` : ''}`),
          ),
          h('a.btn.primary', { href: remote.toString() }, icon('phone'), 'Control this show'),
        );
      })),
    );
  }

  /* ---------- device sync panel ---------- */
  const syncPanel = h('section.panel.sync-panel');
  function renderSyncPanel() {
    const st = sync.status;
    if (st === 'off') {
      const codeIn = h('input.input', { placeholder: 'XXXX-XXXX-XXXX', spellcheck: false, autocomplete: 'off', style: { textTransform: 'uppercase' } });
      syncPanel.replaceChildren(
        h('div.row', h('h3', icon('users'), 'Sync your host devices'), h('div.spacer'), h('span.hint', 'Off')),
        h('p.hint', 'Keep projects, music and settings the same on all your computers and phones, and control a running show from any of them. Devices connect directly to each other — nothing is stored on a server.'),
        h('div.row',
          h('button.btn.primary.sm', { onclick: async () => { await sync.createGroup(); toast('Sync group created — now add your other devices', 'ok'); } }, icon('plus'), 'Create a sync group'),
          h('span.hint', 'or join one:'),
          h('form.row', { onsubmit: async (e) => { e.preventDefault(); const c = normalizeSyncCode(codeIn.value); if (!c) return toast('The code has 12 letters and numbers', 'error'); await sync.join(c); toast('Joined — syncing now', 'ok'); } },
            codeIn, h('button.btn.sm', { type: 'submit' }, 'Join')),
        ),
      );
      return;
    }
    const others = sync.otherDevices;
    const remotes = sync.roster.filter((d) => d.lite).length;
    const nameIn = h('input.input', { value: sync.deviceName, maxlength: 32, style: { maxWidth: '220px' } });
    syncPanel.replaceChildren(
      h('div.row',
        h('h3', icon('users'), 'Device sync'),
        h('div.spacer'),
        h('span.pill', h('span.dot', { class: st === 'online' ? 'online' : 'connecting' }),
          st !== 'online' ? 'Looking for your devices…' : others.length ? `Connected to ${others.length} device${others.length === 1 ? '' : 's'}` : 'Online · no other devices right now'),
      ),
      others.length ? h('div.device-list', others.map((d) => h('span.device', icon(/phone|iPhone|Android/i.test(d.name) ? 'phone' : 'screen'), d.name))) : null,
      remotes ? h('p.hint', `${remotes} phone remote${remotes === 1 ? '' : 's'} connected`) : null,
      h('div.row',
        h('span.label', 'Sync code'), h('code.sync-code', sync.code),
        h('div.spacer'),
        h('button.btn.primary.sm', { onclick: addDeviceModal }, icon('qr'), 'Add a device'),
        h('button.btn.sm.ghost.danger', { onclick: async () => { if (confirm('Stop syncing this device? Its projects and media stay here, but changes will no longer be shared.')) { await sync.leave(); } } }, 'Leave'),
      ),
      h('form.row', { onsubmit: async (e) => { e.preventDefault(); await sync.setDeviceName(nameIn.value); toast('Device name saved', 'ok'); } },
        h('span.label', 'This device'), nameIn, h('button.btn.sm', { type: 'submit' }, 'Rename')),
      h('p.hint', 'Devices sync whenever the Host app is open on them. Everything is saved on each device, so it keeps working without the others.'),
    );
  }
  function addDeviceModal() {
    const link = new URL(location.href);
    link.search = new URLSearchParams(location.search).get('local') === '1' ? location.search : '';
    link.hash = `#/?sync=${sync.code}`;
    const qr = h('div.qr');
    renderQR(qr, link.toString());
    const back = h('div.modal-back', { onclick: (e) => { if (e.target === back) back.remove(); } },
      h('div.modal',
        h('h3', 'Add a device'),
        h('p.hint', 'Scan this with the other phone or computer — it opens the Host app and joins this sync group. Or open the Host app there and type the code.'),
        qr,
        h('code.sync-code.big', sync.code),
        h('div.link', link.toString()),
        h('div.row', { style: { justifyContent: 'center' } },
          h('button.btn.sm', { onclick: () => navigator.clipboard?.writeText(link.toString()).then(() => toast('Link copied', 'ok')) }, icon('copy'), 'Copy link'),
          h('button.btn.sm.primary', { onclick: () => back.remove() }, 'Done'),
        ),
        h('p.hint', 'Only share this with your own devices — anyone with the code gets a copy of your projects.'),
      ));
    document.body.append(back);
  }

  root.append(
    bar,
    h('main.page',
      liveSection,
      syncPanel,
      joinPanel,
      h('div.section-head', h('h2', 'My projects'), h('div.spacer'),
        h('button.btn.sm.ghost', { onclick: () => importIn.click() }, icon('upload'), 'Import project'), importIn),
      grid,
      h('section.media',
        h('div.section-head', h('h2', 'Media library'), h('p', 'Background tracks and sound effects for any event')),
        drop,
        mediaList,
      ),
    ),
  );

  async function renderProjects() {
    const projects = await listProjects();
    const newCard = h('button.new-card', { onclick: create },
      h('div.plus', icon('plus')), h('b', 'New project'), h('span.hint', 'An event, quiz or survey'));
    grid.replaceChildren(newCard, ...projects.map(card));
  }

  function card(p) {
    const quiz = p.slides.filter((s) => s.type === 'quiz').length;
    return h('article.card.proj-card',
      h('button.proj-open', { onclick: () => { location.hash = `#/project/${p.id}`; } },
        h('h3', { dir: 'auto' }, p.name || 'Untitled'),
        h('div.proj-meta', `${plural(p.slides.length, 'slide', 'slides')} · ${quiz} quiz · ${p.slides.length - quiz} survey`),
        h('div.proj-meta', `Updated ${fmtDate(p.updatedAt)}`),
        h('div.timeline', { title: 'Slide sequence' }, p.slides.map((s) => h('i', { style: { '--c': s.type === 'quiz' ? 'var(--accent)' : 'var(--hot)', height: `${30 + Math.min(70, (s.timer || 8) * 2)}%` } }))),
      ),
      h('div.proj-actions',
        h('button.btn.primary.sm', { onclick: () => { audio.unlock(); location.hash = `#/show/${p.id}`; } }, icon('play'), 'Present'),
        h('button.btn.sm.ghost', { title: 'Edit', onclick: () => { location.hash = `#/project/${p.id}`; } }, icon('edit')),
        h('button.btn.sm.ghost', { title: 'Duplicate', onclick: () => duplicate(p) }, icon('copy')),
        h('button.btn.sm.ghost', { title: 'Export', onclick: () => exportProject(p) }, icon('download')),
        h('button.btn.sm.ghost.danger', { title: 'Delete', onclick: () => remove(p) }, icon('trash')),
      ),
    );
  }

  async function create() {
    const p = newProject();
    await saveProject(p);
    location.hash = `#/project/${p.id}`;
  }
  async function duplicate(p) {
    await saveProject({ ...structuredClone(p), id: uid(10), name: p.name + ' (copy)', createdAt: Date.now() });
    renderProjects();
    toast('Project duplicated', 'ok');
  }
  async function remove(p) {
    if (!confirm(`Delete "${p.name}"? This can’t be undone.`)) return;
    await deleteProject(p.id);
    renderProjects();
  }
  function exportProject(p) {
    const blob = new Blob([JSON.stringify({ kind: 'clicker-show-project', version: 1, project: p }, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${p.name || 'project'}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function importProject(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const p = data.project || data;
      if (!Array.isArray(p.slides)) throw new Error('bad file');
      await saveProject({ ...p, id: uid(10), createdAt: Date.now() });
      toast('Project imported', 'ok');
      renderProjects();
    } catch (e) {
      toast('That file isn’t a valid project', 'error');
    }
    importIn.value = '';
  }

  async function upload(files) {
    const list = [...(files || [])].filter((f) => /^(audio|video)\//.test(f.type) || /\.(mp3|wav|ogg|m4a|mp4|m4v|webm|mov)$/i.test(f.name));
    if (!list.length) return toast('Only audio and video files can be uploaded', 'error');
    for (const f of list) await addMedia(f);
    toast(list.length === 1 ? 'Added to the library' : `${list.length} files added`, 'ok');
    fileIn.value = '';
    renderMedia();
  }

  async function renderMedia() {
    const items = await listMedia();
    if (!items.length) { mediaList.replaceChildren(h('div.empty', 'The library is empty. Without files, built-in sound effects are used.')); return; }
    mediaList.replaceChildren(...items.map((m) => {
      const video = isVideo(m);
      const play = video ? h('button.icon-btn', { title: 'Watch', onclick: () => previewVideo(m) }, icon('play')) : h('button.icon-btn', { title: 'Play', onclick: () => { if (audio.previewNode && play.classList.contains('on')) { audio.stopPreview(); } else { mediaList.querySelectorAll('.on').forEach((b) => b.classList.remove('on')); play.classList.add('on'); audio.preview(m.id); } } }, icon('play'));
      const seed = [...m.id].reduce((a, c) => a + c.charCodeAt(0), 0);
      return h('div.media-row',
        play,
        h('span', icon(video ? 'screen' : 'music')),
        h('span.name', { dir: 'auto' }, m.name),
        h('div.wave', Array.from({ length: 24 }, (_, i) => h('i', { style: { height: `${20 + Math.abs(Math.sin(seed + i * 1.7)) * 80}%` } }))),
        h('span.size', fmtSize(m.size)),
        h('button.icon-btn', { title: 'Delete', onclick: async () => { if (confirm(`Delete "${m.name}"?`)) { await deleteMedia(m.id); renderMedia(); } } }, icon('trash')),
      );
    }));
  }
  function previewVideo(m) {
    const url = URL.createObjectURL(m.blob);
    const back = h('div.modal-back', { onclick: (e) => { if (e.target === back) { URL.revokeObjectURL(url); back.remove(); } } },
      h('div.modal', { style: { width: 'min(860px, 100%)' } },
        h('h3', { dir: 'auto' }, m.name),
        h('video', { src: url, controls: true, autoplay: true, playsInline: true, style: { width: '100%', borderRadius: '12px', background: '#000' } }),
        h('button.btn.sm.primary', { onclick: () => { URL.revokeObjectURL(url); back.remove(); } }, 'Close'),
      ));
    document.body.append(back);
  }
  const offPreview = audio.onChange(() => { if (!audio.previewNode) mediaList.querySelectorAll('.on').forEach((b) => b.classList.remove('on')); });

  await Promise.all([renderProjects(), renderMedia()]);
  renderLive();
  renderSyncPanel();

  // refresh when another device changes something, or the group/live shows change
  let refreshT;
  const onDb = (e) => {
    if (e.detail.kind === 'setting' && e.detail.id !== 'joinUrl') return;
    clearTimeout(refreshT);
    refreshT = setTimeout(async () => {
      const u = await getJoinBase();
      if (document.activeElement !== joinIn && joinIn.value !== u) { joinIn.value = u; paintJoin(u); }
      renderProjects();
      renderMedia();
    }, 150);
  };
  dbEvents.addEventListener('change', onDb);
  let lastSyncSig = '';
  const onSync = () => {
    renderLive();
    const sig = `${sync.status}|${sync.code}|${sync.roster.map((d) => d.deviceId + d.name + d.lite).join(',')}`;
    const typing = syncPanel.contains(document.activeElement) && document.activeElement.matches('input');
    if (sig !== lastSyncSig && !typing) { lastSyncSig = sig; renderSyncPanel(); }
  };
  sync.addEventListener('update', onSync);
  const liveTimer = setInterval(renderLive, 5000);

  return () => {
    bar.cleanup(); offPreview(); audio.stopPreview(); window.removeEventListener('installable', onInstallable);
    dbEvents.removeEventListener('change', onDb); sync.removeEventListener('update', onSync); clearInterval(liveTimer);
  };
}
