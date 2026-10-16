// Project & question configurator with live stage preview.
import { h, toast, debounce } from '../shared/ui.js';
import { icon } from '../shared/icons.js';
import { PHASE, TEAM_PRESETS, OPTION_COLORS, teamsFromNames } from '../shared/protocol.js';
import { getProject, saveProject, newSlide, listMedia, getJoinBase } from './db.js';
import { topbar } from './dashboard.js';
import { Stage } from './stage.js';
import { audio } from './audio.js';

const TIMERS = [0, 10, 20, 30, 60];

export async function mountEditor(root, id) {
  const project = await getProject(id);
  if (!project) { location.hash = '#/'; return null; }
  const media = await listMedia();
  const joinBase = await getJoinBase();
  let sel = 0;

  const savedEl = h('span.saved', 'Saved');
  const persist = debounce(async () => { await saveProject(project); savedEl.textContent = 'Saved ✓'; }, 400);
  const touch = () => { savedEl.textContent = 'Saving…'; persist(); };

  const nameIn = h('input.title-input', { value: project.name, dir: 'rtl', placeholder: 'Project name', 'aria-label': 'Project name', oninput: () => { project.name = nameIn.value; touch(); } });
  const bar = topbar(
    h('a.btn.sm.ghost', { href: '#/', title: 'Back' }, icon('back'), 'Projects'),
    nameIn, savedEl,
  );
  bar.insertBefore(h('button.btn.primary.sm', { onclick: async () => { persist.flush(); audio.unlock(); location.hash = `#/show/${project.id}`; } }, icon('play'), 'Start show'), bar.lastChild);

  const settings = h('section.panel');
  const listPanel = h('section.panel');
  const slideList = h('div.slide-list');
  const form = h('section.panel.stack');
  const previewBox = h('div.preview-box');
  const side = h('aside.side', settings, listPanel);
  const mainCol = h('div.stack', form, h('section.panel.stack',
    h('div.row', h('h3', icon('screen'), 'Screen preview'), h('div.spacer'), h('button.btn.sm', { onclick: replay }, icon('play'), 'Replay typing')),
    previewBox,
  ));
  root.append(bar, h('main.editor', side, mainCol));

  const stage = new Stage(previewBox);

  /* ---------- project settings ---------- */
  function mediaSelect(value, onChange, emptyLabel) {
    const s = h('select.input', { onchange: () => onChange(s.value || null) },
      h('option', { value: '' }, emptyLabel),
      media.map((m) => h('option', { value: m.id, selected: m.id === value }, m.name)));
    return s;
  }

  function renderSettings() {
    const presetId = TEAM_PRESETS.find((p) => p.teams.join('|') === project.teams.join('|'))?.id || 'custom';
    const teamsIn = h('input.input', { value: project.teams.join(', '), dir: 'rtl', placeholder: 'e.g. Men, Women', oninput: () => { project.teams = teamsIn.value.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 6); touch(); renderForm(); refreshPreview(); } });
    const preset = h('select.input', {
      onchange: () => {
        const p = TEAM_PRESETS.find((x) => x.id === preset.value);
        if (p) { project.teams = [...p.teams]; teamsIn.value = p.teams.join(', '); touch(); renderForm(); refreshPreview(); }
      },
    }, TEAM_PRESETS.map((p) => h('option', { value: p.id, selected: p.id === presetId }, p.label)), h('option', { value: 'custom', selected: presetId === 'custom' }, 'Custom'));
    const autoStart = h('input', { type: 'checkbox', checked: project.autoStart !== false, onchange: () => { project.autoStart = autoStart.checked; touch(); } });
    const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: project.bgVolume ?? 0.35, oninput: () => { project.bgVolume = Number(vol.value); touch(); } });
    const sfx = (slot, label) => h('label.field', h('span', label), mediaSelect(project.sfx?.[slot], (v) => { project.sfx = { ...(project.sfx || {}), [slot]: v }; touch(); }, 'Built-in effect'));
    settings.replaceChildren(
      h('h3', icon('users'), 'Event settings'),
      h('div.stack',
        h('label.field', h('span', 'Teams'), preset),
        h('label.field', h('span', 'Team names (comma-separated)'), teamsIn),
        h('label.toggle', autoStart, h('span', 'Open voting automatically when typing ends')),
        h('label.field', h('span', 'Background music'), mediaSelect(project.bgTrackId, (v) => { project.bgTrackId = v; touch(); }, 'None')),
        h('label.field', h('span', 'Background volume'), vol),
        h('details', h('summary.label', 'Sound effects'),
          h('div.stack', { style: { marginTop: '10px' } }, sfx('answer', 'Player taps an answer'), sfx('tick', 'Final seconds'), sfx('timeup', 'Time’s up'), sfx('reveal', 'Answer reveal'))),
        media.length ? null : h('p.hint', 'Upload music and effects in the Media library on the main screen.'),
      ),
    );
  }

  /* ---------- slide list (drag to reorder) ---------- */
  let dragFrom = null;
  function renderList() {
    slideList.replaceChildren(...project.slides.map((s, i) => {
      const item = h('div.slide-item', {
        draggable: true, role: 'button', tabindex: 0,
        onclick: () => select(i),
        onkeydown: (e) => { if (e.key === 'Enter') select(i); },
        ondragstart: (e) => { dragFrom = i; item.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; },
        ondragend: () => { item.classList.remove('dragging'); slideList.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before')); },
        ondragover: (e) => { e.preventDefault(); item.classList.add('drop-before'); },
        ondragleave: () => item.classList.remove('drop-before'),
        ondrop: (e) => { e.preventDefault(); if (dragFrom != null && dragFrom !== i) move(dragFrom, i); dragFrom = null; },
      },
        h('span.num', i + 1),
        h('span.q', h('span.q-line', { dir: s.question ? 'rtl' : 'ltr' }, s.question || 'Untitled question'), h('small', `${s.type === 'quiz' ? 'Quiz' : 'Survey'} · ${s.options.length} answers · ${s.timer ? s.timer + 's' : 'no timer'}`)),
        h('span.tools',
          h('button.icon-btn', { title: 'Move up', onclick: (e) => { e.stopPropagation(); if (i > 0) move(i, i - 1); } }, icon('up')),
          h('button.icon-btn', { title: 'Move down', onclick: (e) => { e.stopPropagation(); if (i < project.slides.length - 1) move(i, i + 1); } }, icon('down')),
          h('button.icon-btn', { title: 'Duplicate', onclick: (e) => { e.stopPropagation(); dup(i); } }, icon('copy')),
          h('button.icon-btn', { title: 'Delete', onclick: (e) => { e.stopPropagation(); remove(i); } }, icon('trash')),
        ),
      );
      item.classList.toggle('active', i === sel);
      return item;
    }));
  }
  listPanel.append(
    h('div.row', h('h3', icon('chart'), 'Slides'), h('div.spacer'), h('span.hint', 'Drag to reorder')),
    slideList,
    h('button.btn.sm', { style: { marginTop: '10px', width: '100%' }, onclick: add }, icon('plus'), 'New question'),
  );

  function move(from, to) {
    const [s] = project.slides.splice(from, 1);
    project.slides.splice(to, 0, s);
    sel = to;
    touch(); renderList(); renderForm(); refreshPreview();
  }
  function add() {
    const prev = project.slides[project.slides.length - 1];
    project.slides.push(newSlide(prev ? { timer: prev.timer, typeSpeed: prev.typeSpeed, type: prev.type, correct: prev.type === 'quiz' ? 0 : null } : {}));
    sel = project.slides.length - 1;
    touch(); renderList(); renderForm(); replay();
    form.querySelector('textarea')?.focus();
  }
  function dup(i) {
    project.slides.splice(i + 1, 0, { ...structuredClone(project.slides[i]), id: newSlide().id });
    sel = i + 1;
    touch(); renderList(); renderForm(); replay();
  }
  function remove(i) {
    if (project.slides.length <= 1) return toast('A project needs at least one slide', 'error');
    if (!confirm('Delete this slide?')) return;
    project.slides.splice(i, 1);
    sel = Math.min(sel, project.slides.length - 1);
    touch(); renderList(); renderForm(); replay();
  }
  function select(i) { sel = i; renderList(); renderForm(); replay(); }

  /* ---------- slide form ---------- */
  function seg(options, value, onPick) {
    const wrap = h('div.seg');
    options.forEach(([v, label, disabled]) => wrap.append(h('button', { type: 'button', class: v === value ? 'on' : '', disabled, onclick: () => onPick(v) }, label)));
    return wrap;
  }

  function renderForm() {
    const s = project.slides[sel];
    const update = (patch, { rerender = false } = {}) => {
      Object.assign(s, patch);
      touch();
      renderList();
      if (rerender) renderForm();
      refreshPreview(patch.question !== undefined || patch.options !== undefined);
    };
    const teamsOk = teamsFromNames(project.teams).length > 1;
    const q = h('textarea.input', { rows: 2, dir: 'rtl', placeholder: 'Type the question here…', value: s.question, oninput: () => update({ question: q.value }) });
    const optRows = s.options.map((o, i) => {
      const inp = h('input.input', { value: o, dir: 'rtl', placeholder: `Answer ${i + 1}`, oninput: () => { s.options[i] = inp.value; update({ options: s.options }); } });
      // RTL row: number on the right, then the answer, then the 'correct' toggle on the left
      return h('div.opt-edit', { dir: 'rtl' },
        h('span.num', { style: { '--c': OPTION_COLORS[i] } }, `${i + 1}.`),
        inp,
        s.type === 'quiz'
          ? h('button.correct-pick', { type: 'button', dir: 'ltr', class: s.correct === i ? 'on' : '', onclick: () => update({ correct: i }, { rerender: true }) }, icon('check'), s.correct === i ? 'Correct' : 'Mark correct')
          : h('span'),
      );
    });
    const custom = h('input.input', { type: 'number', min: 0, max: 600, value: s.timer, style: { width: '90px' }, oninput: () => update({ timer: Math.max(0, Math.min(600, Number(custom.value) || 0)) }) });
    const cps = Math.round(1000 / (s.typeSpeed || 45));
    const speedLabel = h('span.hint', `${cps} characters / second`);
    const speed = h('input', {
      type: 'range', min: 5, max: 80, step: 1, value: cps,
      oninput: () => { speedLabel.textContent = `${speed.value} characters / second`; Object.assign(s, { typeSpeed: Math.round(1000 / Number(speed.value)) }); touch(); },
      onchange: () => replay(),
    });
    const teamSplit = h('input', { type: 'checkbox', checked: !!s.teamSplit, disabled: !teamsOk, onchange: () => update({ teamSplit: teamSplit.checked }) });

    form.replaceChildren(
      h('div.row', h('h3', `Slide ${sel + 1}`), h('div.spacer'),
        seg([['quiz', 'Quiz (correct answer)'], ['survey', 'Opinion survey']], s.type, (v) => update({ type: v, correct: v === 'quiz' ? (s.correct ?? 0) : null }, { rerender: true }))),
      h('label.field', h('span', 'Question'), q),
      h('div.row', h('span.label', 'Number of buttons'),
        seg([1, 2, 3, 4, 5].map((n) => [n, String(n)]), s.options.length, (n) => {
          const opts = s.options.slice(0, n);
          while (opts.length < n) opts.push('');
          update({ options: opts, correct: s.type === 'quiz' ? Math.min(s.correct ?? 0, n - 1) : null }, { rerender: true });
        })),
      h('div.stack', optRows),
      h('div.row',
        h('label.toggle', teamSplit, h('span', 'Show team split by default')),
        teamsOk ? null : h('span.hint', '(needs at least 2 teams in Event settings)'),
      ),
      h('div.row', h('span.label', icon('timer'), ' Timer'),
        seg(TIMERS.map((t) => [t, t ? `${t}s` : 'Off']), s.timer, (t) => update({ timer: t }, { rerender: true })),
        h('span.hint', 'or'), custom, h('span.hint', 'seconds')),
      h('div.field', h('div.row', h('span.label', 'Typing speed'), h('div.spacer'), speedLabel), speed),
    );
  }

  /* ---------- preview ---------- */
  let typingStart = Date.now();
  function previewState() {
    const s = project.slides[sel];
    const teams = teamsFromNames(project.teams);
    const n = s.options.length;
    return {
      pin: '1234', joinUrl: joinBase ? joinBase + '?pin=1234' : '', projectName: project.name, teams,
      phase: PHASE.TYPING, idx: sel, total: project.slides.length, slide: s, typingStart,
      timerEnd: null, timerRemaining: null, timerTotal: (s.timer || 0) * 1000,
      overlays: { count: true, percent: false, teams: !!(s.teamSplit && teams.length > 1), leaderboard: false },
      stats: { counts: Array(n).fill(0), percents: Array(n).fill(0), byTeam: {}, teamTotals: {}, answered: 0, online: 0, joined: 0, leaderboard: [], leaderboardKind: 'correct' },
      recentNames: [],
    };
  }
  function refreshPreview(textChanged) {
    if (textChanged) typingStart = Date.now() - 1e7;    // show edits instantly, typed
    stage.setState(previewState());
  }
  function replay() { typingStart = Date.now(); stage.setState(previewState()); }

  renderSettings();
  renderList();
  renderForm();
  replay();

  const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); persist.flush(); toast('Saved', 'ok', 1200); } };
  window.addEventListener('keydown', onKey);
  return () => { persist.flush(); bar.cleanup(); stage.destroy(); window.removeEventListener('keydown', onKey); };
}
