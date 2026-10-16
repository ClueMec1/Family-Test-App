// IndexedDB persistence for the Host PWA.
// Stores: projects, media (audio Blobs), sessions (live show state per project),
//         settings, tombstones (deletions, so they sync to other devices too).
//
// Every write fires a `change` event on `dbEvents` ({kind, id, origin}). The sync module listens
// to it to push local changes to the other host devices, and the UI listens to refresh itself.
// Writes coming FROM sync carry an `origin` so they aren't echoed back.
import { uid } from './protocol.js';
import { DEFAULT_JOIN_URL } from './config.js';

// `?db=name` lets several "devices" run in one browser for testing (each gets its own database).
const DB_NAME = 'clicker-host' + (new URLSearchParams(location.search).get('db') ? '-' + new URLSearchParams(location.search).get('db') : '');
const DB_VER = 2;
let dbp;

export const dbEvents = new EventTarget();
const emit = (kind, id, origin = 'local') => dbEvents.dispatchEvent(new CustomEvent('change', { detail: { kind, id, origin } }));

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'projectId' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('tombstones')) db.createObjectStore('tombstones', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const getAll = (store) => tx(store, 'readonly', (s) => s.getAll());
const get = (store, key) => tx(store, 'readonly', (s) => s.get(key));
const put = (store, val) => tx(store, 'readwrite', (s) => s.put(val));
const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));

/* ---------- model factories ---------- */

export function newSlide(partial = {}) {
  return {
    id: uid(8),
    type: 'quiz',             // 'quiz' | 'survey'
    question: '',
    options: ['', '', '', ''],
    correct: 0,               // index (quiz only)
    timer: 20,                // seconds, 0 = disabled
    typeSpeed: 45,            // ms per character
    music: 'countdown',       // while voting: 'countdown' (built-in ticking clock) | 'none' | media id
    musicAuto: true,          // start that music automatically when voting opens
    teamStep: true,           // after the reveal, show a team-results step
    boardStep: true,          // quiz: then show the top-10 fastest correct players
    ...partial,
  };
}

export function newProject(name = 'New project') {
  const now = Date.now();
  return {
    id: uid(10),
    name,
    createdAt: now,
    updatedAt: now,
    teams: ['Men', 'Women'],
    autoStart: true,          // open voting + timer as soon as typing ends
    autoReveal: false,        // reveal the answer automatically when time runs out
    bgTrackId: null,          // join-screen music (plays automatically there; Music button anywhere)
    intro: { type: 'text', title: '', text: '', showSteps: true, musicId: null, videoId: null },
    bgVolume: 0.35,
    sfx: { reveal: null, timeup: null, answer: null, tick: null },
    slides: [
      newSlide({ question: 'What is the capital of France?', options: ['London', 'Paris', 'Berlin', 'Rome'], correct: 1 }),
      newSlide({ type: 'survey', question: 'How is the evening so far?', options: ['Amazing', 'Very good', 'OK'], correct: null, timer: 15 }),
    ],
  };
}

/* ---------- tombstones (deletions that must reach other devices) ---------- */
export const listTombstones = () => getAll('tombstones');
async function tombstone(kind, id, at = Date.now()) { await put('tombstones', { id, kind, at }); }
export const getTombstone = (id) => get('tombstones', id);

/* ---------- projects ---------- */
export const listProjects = async () => (await getAll('projects')).sort((a, b) => b.updatedAt - a.updatedAt);
export const getProject = (id) => get('projects', id);
export async function saveProject(p) {
  await put('projects', { ...p, updatedAt: Date.now() });
  emit('project', p.id);
}
export async function deleteProject(id) {
  await del('projects', id);
  await del('sessions', id);
  await tombstone('project', id);
  emit('tomb', id);
}

/* ---------- media library ---------- */
export const listMedia = async () => (await getAll('media')).sort((a, b) => b.createdAt - a.createdAt);
export const getMedia = (id) => (id ? get('media', id) : Promise.resolve(null));
export async function deleteMedia(id) {
  await del('media', id);
  await tombstone('media', id);
  emit('tomb', id);
}
export const isVideo = (item) => /^video\//.test(item?.type || '');
export function mediaTypeOf(file) {
  if (file.type) return file.type;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4' }[ext] || 'audio/mpeg';
}
export async function addMedia(file) {
  const item = { id: uid(10), name: file.name.replace(/\.[^.]+$/, ''), type: mediaTypeOf(file), size: file.size, blob: file, createdAt: Date.now() };
  await put('media', item);
  emit('media', item.id);
  return item;
}

/* ---------- writes that arrive from another device (no new timestamps) ---------- */
export async function applyRemoteProject(p, origin) {
  const tomb = await getTombstone(p.id);
  if (tomb && tomb.at >= p.updatedAt) return false;
  const local = await getProject(p.id);
  if (local && local.updatedAt >= p.updatedAt) return false;
  if (tomb) await del('tombstones', p.id);
  await put('projects', p);
  emit('project', p.id, origin);
  return true;
}
export async function applyRemoteMedia(item, origin) {
  if (await getTombstone(item.id)) return false;
  if (await getMedia(item.id)) return false;
  await put('media', item);
  emit('media', item.id, origin);
  return true;
}
export async function applyRemoteTombstone(t, origin) {
  const existing = await getTombstone(t.id);
  if (existing && existing.at >= t.at) return false;
  if (t.kind === 'project') {
    const local = await getProject(t.id);
    if (local && local.updatedAt > t.at) return false;     // edited after it was deleted elsewhere: keep it
    await del('projects', t.id);
    await del('sessions', t.id);
  } else {
    await del('media', t.id);
  }
  await put('tombstones', t);
  emit('tomb', t.id, origin);
  return true;
}

/* ---------- live sessions (device-local) ---------- */
export const getSession = (projectId) => get('sessions', projectId);
export const saveSession = (s) => put('sessions', s);
export const deleteSession = (projectId) => del('sessions', projectId);

/* ---------- settings ---------- */
export async function getSetting(key, fallback) {
  const r = await get('settings', key);
  return r ? r.value : fallback;
}
export const getSettingRecord = (key) => get('settings', key);
export async function setSetting(key, value, { at = Date.now(), origin = 'local' } = {}) {
  await put('settings', { key, value, at });
  emit('setting', key, origin);
}

/* ---------- Join app address (the separately-published participant PWA) — synced ---------- */
export async function getJoinBase() {
  return (await getSetting('joinUrl', '')) || DEFAULT_JOIN_URL || '';
}
export const setJoinBase = (url) => setSetting('joinUrl', url);

/* ---------- this device ---------- */
export async function getDeviceId() {
  let id = await getSetting('deviceId', null);
  if (!id) { id = 'd-' + uid(10); await put('settings', { key: 'deviceId', value: id, at: Date.now() }); }
  return id;
}
export function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows computer';
  if (/CrOS/.test(ua)) return 'Chromebook';
  return 'Computer';
}
export async function getDeviceName() { return (await getSetting('deviceName', '')) || guessDeviceName(); }
