// Live show console: runs the ShowHub, renders the stage (preview / fullscreen / second window),
// and offers operator controls, overlays, participants list, QR codes and the phone remote.
import { h, toast, debounce, fmtTime } from './ui.js';
import { icon } from './icons.js';
import { PHASE, PHASE_LABEL, RESULT_PHASES } from './protocol.js';
import { renderQR } from './qr.js';
import { getProject, getSession, saveSession, deleteSession, getJoinBase } from './db.js';
import { ShowHub } from './hub.js';
import { Stage } from './stage.js';
import { audio } from './audio.js';
import { sync } from './sync.js';

const NET_LABEL = { online: 'Online', connecting: 'Connecting…', reconnecting: 'Reconnecting…', offline: 'Offline' };
const SESSION_TTL = 12 * 3600e3;

export async function mountShow(root, id, { backend }) {
  const project = await getProject(id);
  if (!project) { location.hash = '#/'; return null; }
  let session = await getSession(id);
  if (session && Date.now() - session.savedAt > SESSION_TTL) session = null;

  const joinBase = await getJoinBase();
  const hub = new ShowHub(project, session, { backend, joinBase });
  audio.configure(project);
  window.__hub = hub; // handy for debugging from devtools
  window.__audioMuted = () => audio.muted;

  /* ---------- layout ---------- */
  const netPill = h('span.pill', h('span.dot'), h('span'));
  const pinPill = h('span.pill', 'Code', h('b.pin-pill'));
  const muteBtn = h('button.btn.sm', { title: 'Mute (M)', onclick: () => hub.command('mute') });
  const bgBtn = h('button.btn.sm', { title: 'Music on/off for this step (B)', onclick: () => { audio.unlock(); hub.command('music'); } });
  const bar = h('header.topbar',
    h('a.btn.sm.ghost', { href: `#/project/${id}`, title: 'Back to editing' }, icon('back'), 'Edit'),
    h('strong.display', { dir: 'auto' }, project.name),
    backend === 'local' ? h('span.pill', { title: 'All tabs in this browser — no internet needed' }, 'Local rehearsal') : null,
    netPill, pinPill,
    h('div.spacer'),
    h('button.btn.sm', { title: 'QR code for players', onclick: () => qrModal('join') }, icon('qr'), 'Join QR'),
    h('button.btn.sm', { title: 'Phone remote for the host', onclick: () => qrModal('remote') }, icon('phone'), 'Remote'),
    h('button.btn.sm', { title: 'Open a display window for a second screen', onclick: openDisplayWindow }, icon('screen'), 'Display window'),
    h('button.btn.sm.primary', { title: 'Fullscreen (F)', onclick: fullscreen }, icon('full'), 'Fullscreen'),
    bgBtn, muteBtn,
    h('button.btn.sm.ghost', { title: 'Export results (CSV)', onclick: exportCSV }, icon('csv')),
    h('button.btn.sm.ghost.danger', { title: 'Reset session (players and answers)', onclick: resetSession }, icon('trash')),
  );

  const stageBox = h('div.stage-box', h('span.pill.live-tag', 'LIVE'));
  const strip = h('nav.strip');
  const nextHint = h('div.next-hint');
  const phaseCard = h('div.phase-card', h('div.phase-name', h('span.dot'), h('span')), h('div.phase-sub'), nextHint);
  const ctrl = (cmd, label, ico, kbd, cls = '') => h(`button.btn${cls}`, { dataset: { cmd }, onclick: () => { audio.unlock(); hub.command(cmd); } }, icon(ico), label, kbd ? h('span.kbd', kbd) : null);
  const ctrls = h('div.big-ctrls',
    ctrl('prev', 'Previous', 'prev', '←'),
    ctrl('next', 'Next', 'next', '→', '.primary'),
  );
  // Manual controls — Next does all of this automatically, these are for when you want to take over.
  const manual = h('div.big-ctrls.manual',
    ctrl('toggleTimer', 'Start', 'play', 'Space', '.wide'),
    ctrl('skip', 'Skip typing', 'skip', 'S'),
    ctrl('lock', 'Close voting', 'lock', 'L'),
    ctrl('reveal', 'Reveal', 'eye', 'R'),
    ctrl('intro', 'Intro', 'sparkle', 'I'),
    ctrl('lobby', 'Join screen', 'qr', 'J'),
    ctrl('joinLock', 'Let late players join', 'users', ''),
    ctrl('resetSlide', 'Reset question', 'stop', ''),
  );
  const ov = (name, label, ico, kbd) => h('button.btn.sm', { dataset: { ov: name }, onclick: () => hub.command('overlay', name) }, icon(ico), label, h('span.kbd', kbd));
  const ovHint = h('p.hint.ov-hint');
  const overlays = h('div.ov-grid',
    ov('count', 'Player count', 'users', '1'),
    ov('percent', 'Percentages', 'percent', '2'),
    ov('teams', 'Team split', 'split', '3'),
    ov('leaderboard', 'Top 10 fastest', 'trophy', '4'),
  );
  const peopleHead = h('h3');
  const people = h('div.people');
  const side = h('aside.console-side',
    phaseCard,
    h('section.panel', ctrls),
    h('details.panel.manual-panel', h('summary', icon('edit'), ' Manual controls'), manual),
    h('section.panel', h('h3', icon('chart'), 'Show on screen'), overlays, ovHint),
    h('section.panel', peopleHead, people),
  );
  root.append(bar, h('main.console', h('div.console-main', stageBox, strip), side));

  const stage = new Stage(stageBox, { audible: true });

  /* ---------- sound: needs one click/key after a page reload (browser rule) ---------- */
  const soundGate = h('button.sound-gate', { onclick: () => { audio.unlock(); } }, icon('vol'), 'Click to turn on sound');
  stageBox.append(soundGate);
  const paintGate = () => { soundGate.hidden = audio.ready; };
  paintGate();
  const unlockOnce = () => { audio.unlock(); };
  window.addEventListener('pointerdown', unlockOnce);

  /* ---------- music: decided by the current step ----------
   * Join screen: the project's music, automatically.   Intro: the intro music (text intro).
   * Voting: the question's music — the built-in ticking countdown by default, or a track.
   * Everything else: silence, unless the host turns music on (Music button / B).            */
  let musicOverride = null;          // null = automatic, 'on' / 'off' = host's choice for this step
  let musicStep = '';
  function stepMusic() {
    const ph = hub.phase;
    const s = hub.slide;
    const intro = hub.intro;
    const track = (id) => (id ? { kind: 'track', id } : null);
    const countdown = () => ({ kind: 'countdown', endsAt: hub.timerEnd, total: hub.timerTotal });
    let auto = null;
    let manual = track(project.bgTrackId);   // what the Music button plays on this step
    if (ph === PHASE.LOBBY) auto = track(project.bgTrackId);
    else if (ph === PHASE.INTRO) {
      if (intro.type === 'video' && intro.videoId) manual = null;          // the video has its own sound
      else if (intro.musicId) { auto = track(intro.musicId); manual = auto; }
    } else if (s && [PHASE.TYPING, PHASE.READY, PHASE.OPEN, PHASE.PAUSED].includes(ph)) {
      const m = s.music ?? 'countdown';
      const autoOn = s.musicAuto !== false;
      if (m === 'countdown') {
        manual = ph === PHASE.OPEN ? countdown() : manual;
        if (ph === PHASE.OPEN && autoOn) auto = countdown();
      } else if (m !== 'none') {
        manual = track(m);
        if ((ph === PHASE.OPEN || ph === PHASE.PAUSED) && autoOn) auto = track(m);
      }
    }
    return { auto, manual };
  }
  function applyMusic() {
    const step = `${hub.phase}:${hub.idx}`;
    if (step !== musicStep) { musicStep = step; musicOverride = null; }
    const { auto, manual } = stepMusic();
    const want = musicOverride === 'off' ? null : musicOverride === 'on' ? (manual || auto) : auto;
    audio.setMusic(want);
    hub.musicOn = !!want;
    hub.musicAvailable = !!(manual || auto);
  }
  hub.on('musicToggle', () => {
    audio.unlock();
    musicOverride = hub.musicOn ? 'off' : 'on';
    applyMusic();
  });

  /* ---------- second-screen display channel ---------- */
  const bc = new BroadcastChannel('clicker-display');
  bc.onmessage = (e) => {
    if (e.data?.t === 'hello') bc.postMessage({ t: 'ds', state: hub.displayState() });
    if (e.data?.t === 'cmd') hub.command(e.data.cmd, e.data.value);
  };
  function openDisplayWindow() {
    window.open('./display.html' + location.search, 'clicker-display', 'popup,width=1280,height=720');
    toast('Drag the window to the HDMI screen and click it for fullscreen', 'info', 4500);
  }
  function fullscreen() {
    audio.unlock();
    if (document.fullscreenElement) document.exitFullscreen();
    else stageBox.requestFullscreen?.().catch(() => toast('The browser blocked fullscreen', 'error'));
  }

  /* ---------- render ---------- */
  const pushRemotes = throttle(() => hub.pushRemotes(), 200);
  // Tell every synced device that this show is running (so their dashboards/remotes can control it).
  let netReady = false;
  const announce = throttle(() => {
    if (!netReady || hub.destroyed) return;
    sync.announceShow({
      projectId: project.id, projectName: project.name, pin: hub.pin, remoteKey: hub.remoteKey, backend,
      phase: hub.phase, idx: hub.idx, total: hub.slides.length, players: hub.onlineCount(),
    });
  }, 1000);
  let resetting = false;
  const persist = debounce(() => { if (!resetting) saveSession(hub.serialize()); }, 800);

  function render() {
    if (hub.destroyed) return;
    applyMusic();
    paintGate();
    const ds = hub.displayState();
    stage.setState(ds);
    bc.postMessage({ t: 'ds', state: ds });
    pushRemotes();
    announce();
    persist();

    netPill.querySelector('.dot').className = 'dot ' + hub.netStatus;
    netPill.lastChild.textContent = NET_LABEL[hub.netStatus] || hub.netStatus;
    pinPill.querySelector('b').textContent = hub.pin;
    muteBtn.replaceChildren(icon(audio.muted ? 'mute' : 'vol'));
    muteBtn.classList.toggle('on', audio.muted);
    bgBtn.replaceChildren(icon('music'), hub.musicOn ? 'Music on' : 'Music off');
    bgBtn.classList.toggle('on', !!hub.musicOn);
    bgBtn.disabled = !hub.musicAvailable && !hub.musicOn;

    // phase card
    const s = hub.slide;
    phaseCard.querySelector('.dot').className = 'dot ' + ({ open: 'online', paused: 'connecting', typing: 'connecting' }[hub.phase] || '');
    phaseCard.querySelector('.phase-name span:last-child').textContent = PHASE_LABEL[hub.phase];
    const rem = hub.remaining();
    const sub = phaseCard.querySelector('.phase-sub');
    nextHint.replaceChildren(h('span.kbd', '→'), h('b', 'Next: '), hub.nextLabel());
    nextHint.hidden = hub.phase === PHASE.END;
    if (hub.phase === PHASE.LOBBY) sub.replaceChildren(`${ds.stats.joined} joined · ${ds.stats.online} connected`);
    else if (hub.phase === PHASE.INTRO) sub.replaceChildren(`Intro · ${ds.stats.online} connected · joining ${hub.joinOpen ? 'open' : 'closed'}`);
    else if (s) sub.replaceChildren(`${hub.idx + 1}/${hub.slides.length}${rem != null ? ' · ' + fmtTime(rem) + 's' : ''} · `, h('span', { dir: 'rtl' }, s.question));
    else sub.replaceChildren();

    // control states
    const open = hub.phase === PHASE.OPEN;
    const tBtn = manual.querySelector('[data-cmd="toggleTimer"]');
    tBtn.replaceChildren(icon(open ? 'pause' : 'play'), open ? 'Pause timer' : hub.phase === PHASE.PAUSED ? 'Resume timer' : hub.phase === PHASE.CLOSED ? 'Reopen voting' : 'Open voting', h('span.kbd', 'Space'));
    tBtn.disabled = [PHASE.LOBBY, PHASE.INTRO, PHASE.END, ...RESULT_PHASES].includes(hub.phase);
    manual.querySelector('[data-cmd="skip"]').disabled = hub.phase !== PHASE.TYPING;
    manual.querySelector('[data-cmd="lock"]').disabled = ![PHASE.OPEN, PHASE.PAUSED, PHASE.READY, PHASE.TYPING].includes(hub.phase);
    manual.querySelector('[data-cmd="reveal"]').disabled = [PHASE.LOBBY, PHASE.INTRO, PHASE.END].includes(hub.phase) || !s;
    manual.querySelector('[data-cmd="intro"]').disabled = !hub.hasIntro || hub.phase === PHASE.INTRO;
    const jl = manual.querySelector('[data-cmd="joinLock"]');
    jl.replaceChildren(icon('users'), hub.phase === PHASE.LOBBY ? 'Joining is open' : hub.lateJoin ? 'Close joining' : 'Let late players join');
    jl.disabled = hub.phase === PHASE.LOBBY;
    jl.classList.toggle('on', hub.lateJoin);
    ctrls.querySelector('[data-cmd="next"]').disabled = hub.phase === PHASE.END;
    ctrls.querySelector('[data-cmd="prev"]').disabled = hub.phase === PHASE.LOBBY;
    const voting = [PHASE.TYPING, PHASE.READY, PHASE.OPEN, PHASE.PAUSED].includes(hub.phase);
    overlays.querySelectorAll('[data-ov]').forEach((b) => {
      b.classList.toggle('on', !!hub.overlays[b.dataset.ov]);
      if (b.dataset.ov !== 'count') b.disabled = voting || (b.dataset.ov === 'teams' && hub.teams.length < 2);
    });
    ovHint.textContent = voting ? 'Results stay hidden while people vote — they appear step by step after the question.' : '';
    ovHint.hidden = !voting;

    // strip
    const sig = `${hub.phase}:${hub.idx}:${Object.keys(hub.answers).join(',')}`;
    if (sig !== strip._sig) {
      strip._sig = sig;
      strip.replaceChildren(
        h('button.chip.lobby-chip', { class: hub.phase === PHASE.LOBBY ? 'active' : '', onclick: () => hub.command('lobby') }, icon('qr'), h('span', 'Join')),
        hub.hasIntro ? h('button.chip.lobby-chip', { class: hub.phase === PHASE.INTRO ? 'active' : '', onclick: () => hub.command('intro') }, icon('sparkle'), h('span', 'Intro')) : null,
        ...hub.slides.map((sl, i) => h('button.chip', {
          class: [![PHASE.LOBBY, PHASE.INTRO, PHASE.END].includes(hub.phase) && i === hub.idx ? 'active' : '', hub.answers[sl.id] ? 'done' : ''].join(' '),
          title: sl.question,
          onclick: () => hub.command('goto', i),
        }, h('b', `${i + 1}.`), h('span', { dir: 'rtl' }, sl.question || '—'))),
        h('button.chip', { class: hub.phase === PHASE.END ? 'active' : '', onclick: () => hub.command('end') }, icon('flag'), h('span', 'End')),
      );
      strip.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    // participants
    const bucket = (s && hub.answers[s.id]) || {};
    const list = [...hub.participants.values()].sort((a, b) => (b._online - a._online) || a.joinedAt - b.joinedAt);
    peopleHead.replaceChildren(icon('users'), ` Players · ${ds.stats.online} connected · ${ds.stats.answered} answered`);
    const psig = list.map((p) => `${p.pid}${p._online ? 1 : 0}${bucket[p.pid] ? 1 : 0}${p.name}`).join('|');
    if (psig !== people._sig) {
      people._sig = psig;
      people.replaceChildren(...(list.length ? list.map((p) => h('div.person', { class: p._online ? '' : 'off' },
        h('span.team', { style: { '--c': hub._teamColor(p.team) } }),
        h('span.nm', { dir: 'auto' }, p.name),
        bucket[p.pid] ? h('span.ans', icon('check')) : null,
      )) : [h('div.empty', 'No players yet — show the join screen')]));
    }
  }

  hub.on('change', render);
  hub.on('fx', (e) => { if (hub.destroyed) return; stage.fxEvent(e); bc.postMessage({ t: 'fx', e }); });
  const offAudio = audio.onChange(() => { paintGate(); hub.changed(); });
  const remoteTimer = setInterval(() => { if (hub.remotes.size) hub.pushRemotes(); if (hub.remaining() != null) render(); }, 1000);
  render();

  hub.start().then(() => {
    netReady = true;
    announce();
    if (!session) toast(`Session ready · code ${hub.pin}`, 'ok');
    else toast(`Resumed your previous session · code ${hub.pin}`, 'ok');
    if (!hub.joinUrl()) setTimeout(() => toast('Set the Join app address on the dashboard so the QR codes work', 'error', 7000), 1200);
  }).catch((e) => {
    if (hub.destroyed) return;
    console.error(e);
    stageBox.append(h('div.modal-back', { style: { position: 'absolute' } }, h('div.modal',
      h('h3', 'Couldn’t reach the connection server'),
      h('p.hint', 'Check this computer’s internet connection, then try again.'),
      h('button.btn.primary', { onclick: () => location.reload() }, 'Try again'),
    )));
  });

  /* ---------- QR modals ---------- */
  function qrModal(kind) {
    const url = kind === 'join' ? hub.joinUrl() : hub.remoteUrl();
    if (!url) {
      toast('Set the Join app address on the dashboard first — the QR code points there', 'error', 6000);
      return;
    }
    const qr = h('div.qr');
    renderQR(qr, url);
    const back = h('div.modal-back', { onclick: (e) => { if (e.target === back) back.remove(); } },
      h('div.modal',
        h('h3', kind === 'join' ? 'Players join here' : 'Host phone remote'),
        h('p.hint', kind === 'join' ? `Scan with the camera or open the link. Code: ${hub.pin}` : 'Scan with your own phone only — this link gives full control of the show.'),
        qr,
        h('div.link', url),
        h('div.row', { style: { justifyContent: 'center' } },
          h('button.btn.sm', { onclick: () => navigator.clipboard?.writeText(url).then(() => toast('Link copied', 'ok')) }, icon('copy'), 'Copy'),
          kind === 'join' ? h('button.btn.sm', { onclick: () => { hub.command('lobby'); back.remove(); } }, icon('screen'), 'Show on screen') : h('a.btn.sm', { href: url, target: '_blank' }, icon('phone'), 'Open here'),
          h('button.btn.sm.primary', { onclick: () => back.remove() }, 'Close'),
        ),
      ));
    document.body.append(back);
  }

  function exportCSV() {
    const blob = new Blob([hub.toCSV()], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${project.name}-results.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  async function resetSession() {
    if (!confirm('Reset the session? All players and answers will be deleted and a new code created.')) return;
    resetting = true;
    sync.endShow(project.id);
    hub.destroy();
    await deleteSession(id);
    location.reload();
  }

  /* ---------- keyboard ---------- */
  const keys = (e) => {
    if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    const map = {
      ArrowRight: 'next', PageDown: 'next', ArrowLeft: 'prev', PageUp: 'prev', ' ': 'toggleTimer',
      s: 'skip', l: 'lock', r: 'reveal', j: 'lobby', i: 'intro', m: 'mute', b: 'music',
    };
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    audio.unlock();
    if (map[k]) { e.preventDefault(); hub.command(map[k]); }
    else if (['1', '2', '3', '4'].includes(k)) hub.command('overlay', ['count', 'percent', 'teams', 'leaderboard'][Number(k) - 1]);
    else if (k === 'f') fullscreen();
  };
  window.addEventListener('keydown', keys);

  // keep the presenter screen awake
  let wake = null;
  const grabWake = async () => { try { wake = await navigator.wakeLock?.request('screen'); } catch (e) { /* */ } };
  grabWake();
  const onVis = () => { if (document.visibilityState === 'visible') grabWake(); };
  document.addEventListener('visibilitychange', onVis);
  const onUnload = () => { sync.endShow(project.id); if (!resetting) saveSession(hub.serialize()); };
  window.addEventListener('beforeunload', onUnload);

  return async () => {
    window.removeEventListener('keydown', keys);
    window.removeEventListener('beforeunload', onUnload);
    document.removeEventListener('visibilitychange', onVis);
    clearInterval(remoteTimer);
    sync.endShow(project.id);
    offAudio();
    if (!resetting) try { await saveSession(hub.serialize()); } catch (e) { /* */ }
    hub.destroy();
    stage.destroy();
    bc.close();
    audio.setMusic(null);
    window.removeEventListener('pointerdown', unlockOnce);
    wake?.release?.();
    if (document.fullscreenElement) document.exitFullscreen();
    document.querySelectorAll('.modal-back').forEach((m) => m.remove());
  };
}

function throttle(fn, ms) {
  let last = 0;
  let t = null;
  return () => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(); return; }
    clearTimeout(t);
    t = setTimeout(() => { last = Date.now(); fn(); }, ms - (now - last));
  };
}
