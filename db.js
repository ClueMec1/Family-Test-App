// IndexedDB persistence for the Host PWA.
// Stores: projects (event projects + slides), media (audio Blobs, global library),
//         sessions (live show state per project, so a reload resumes the same PIN), settings.
import { uid } from '../shared/protocol.js';
import { DEFAULT_JOIN_URL } from './config.js';

const DB_NAME = 'clicker-host';
const DB_VER = 1;
let dbp;

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
    teamSplit: false,         // default overlay: split bars by team
    timer: 20,                // seconds, 0 = disabled
    typeSpeed: 45,            // ms per character
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
    bgTrackId: null,
    bgVolume: 0.35,
    sfx: { reveal: null, timeup: null, answer: null, tick: null },
    slides: [
      newSlide({ question: 'What is the capital of France?', options: ['London', 'Paris', 'Berlin', 'Rome'], correct: 1 }),
      newSlide({ type: 'survey', question: 'How is the evening so far?', options: ['Amazing', 'Very good', 'OK'], correct: null, teamSplit: true, timer: 15 }),
    ],
  };
}

/* ---------- projects ---------- */
export const listProjects = async () => (await getAll('projects')).sort((a, b) => b.updatedAt - a.updatedAt);
export const getProject = (id) => get('projects', id);
export const saveProject = (p) => put('projects', { ...p, updatedAt: Date.now() });
export const deleteProject = async (id) => { await del('projects', id); await del('sessions', id); };

/* ---------- media library ---------- */
export const listMedia = async () => (await getAll('media')).sort((a, b) => b.createdAt - a.createdAt);
export const getMedia = (id) => (id ? get('media', id) : Promise.resolve(null));
export const deleteMedia = (id) => del('media', id);
export async function addMedia(file) {
  const item = { id: uid(10), name: file.name.replace(/\.[^.]+$/, ''), type: file.type || 'audio/mpeg', size: file.size, blob: file, createdAt: Date.now() };
  await put('media', item);
  return item;
}

/* ---------- live sessions ---------- */
export const getSession = (projectId) => get('sessions', projectId);
export const saveSession = (s) => put('sessions', s);
export const deleteSession = (projectId) => del('sessions', projectId);

/* ---------- settings ---------- */
export async function getSetting(key, fallback) {
  const r = await get('settings', key);
  return r ? r.value : fallback;
}
export const setSetting = (key, value) => put('settings', { key, value });

/* ---------- Join app address (the separately-published participant PWA) ---------- */
export async function getJoinBase() {
  return (await getSetting('joinUrl', '')) || DEFAULT_JOIN_URL || '';
}
export const setJoinBase = (url) => setSetting('joinUrl', url);
