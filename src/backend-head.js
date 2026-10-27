// TV — het "brein" van de iPhone-app.
// Doet wat op de pc server.js doet (lijsten, één beste versie, kopjes, zoeken, Top 10, terugkijken),
// maar dan in de app zelf: hij praat rechtstreeks met de Xtream-aanbieder. Geen pc nodig.
// Dit bestand wordt gemaakt door scripts/build.js (kop + gedeelde logica uit server.js + staart).
(function () {
'use strict';
const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
// Ook te testen in een gewone browser met ?app in het adres
if (!NATIVE && !/[?&]app\b/.test(location.search)) return;

const TTL = 30 * 60 * 1000;
const LIST_TTL = 6 * 3600e3;
const realFetch = window.fetch.bind(window); // in de app: native (geen CORS- of http-blokkade)

// Opslag: kleine dingen in localStorage, grote lijsten in IndexedDB
const path = { join: (...a) => a.join('/') };
const DATA = 'data';
const readJSON = (f, d) => { try { const v = localStorage.getItem('tv:' + f); return v == null ? d : JSON.parse(v); } catch { return d; } };
const writeJSON = (f, v) => { try { localStorage.setItem('tv:' + f, JSON.stringify(v)); } catch {} };
const idb = (() => {
  let dbp;
  const open = () => dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('tv', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => { const t = db.transaction('kv', mode); const q = fn(t.objectStore('kv')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); });
  };
  return { get: k => run('readonly', s => s.get(k)).catch(() => null), set: (k, v) => run('readwrite', s => s.put(v, k)).catch(() => {}), clear: () => run('readwrite', s => s.clear()).catch(() => {}) };
})();

let cfg = readJSON('config', null);
let account = null;
const base = () => cfg.server.replace(/\/+$/, '');
const creds = () => `${encodeURIComponent(cfg.username)}/${encodeURIComponent(cfg.password)}`;
function apiURL(params, c = cfg) {
  const u = new URL(c.server.replace(/\/+$/, '') + '/player_api.php');
  u.searchParams.set('username', c.username);
  u.searchParams.set('password', c.password);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
  return u.href;
}

// Cache: geheugen + IndexedDB; verouderd wordt op de achtergrond ververst (je wacht er nooit op)
const cache = new Map();
function cached(key, fn, disk = false, ttl = TTL) {
  const dkey = () => (cfg ? cfg.username : '') + '|' + key;
  const refresh = hit => {
    if (hit.busy) return; hit.busy = true;
    fn().then(v => { cache.set(key, { t: Date.now(), p: Promise.resolve(v) }); if (disk) idb.set(dkey(), { t: Date.now(), v }); }).catch(() => { hit.busy = false; });
  };
  const hit = cache.get(key);
  if (hit) { if (Date.now() - hit.t > ttl) refresh(hit); return hit.p; }
  const entry = { t: Date.now(), p: null };
  entry.p = (async () => {
    if (disk) {
      const d = await idb.get(dkey());
      if (d) { entry.t = d.t; if (Date.now() - d.t > ttl) refresh(entry); return d.v; }
    }
    const v = await fn();
    if (disk) idb.set(dkey(), { t: Date.now(), v });
    return v;
  })();
  cache.set(key, entry);
  entry.p.catch(() => cache.delete(key));
  return entry.p;
}

let active = 0;
const waiting = [];
function limited(fn) {
  return new Promise((resolve, reject) => {
    const run = () => { active++; fn().then(resolve, reject).finally(() => { active--; waiting.shift()?.(); }); };
    active < 4 ? run() : waiting.push(run);
  });
}
async function api(params) {
  return limited(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const big = !params.category_id && /streams$|^get_series$/.test(params.action || '');
        const r = await realFetch(apiURL(params), { signal: AbortSignal.timeout(big ? 120000 : 30000) });
        if (!r.ok) throw new Error('API ' + r.status);
        return await r.json();
      } catch (e) {
        if (attempt >= 1) throw e;
        await new Promise(r => setTimeout(r, 700));
      }
    }
  });
}

// ===================== Gedeelde logica (uit server.js) =====================
