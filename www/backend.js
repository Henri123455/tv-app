// TV â€” het "brein" van de iPhone-app.
// Doet wat op de pc server.js doet (lijsten, Ã©Ã©n beste versie, kopjes, zoeken, Top 10, terugkijken),
// maar dan in de app zelf: hij praat rechtstreeks met de Xtream-aanbieder. Geen pc nodig.
// Dit bestand wordt gemaakt door scripts/build.js (kop + gedeelde logica uit server.js + staart).
(function () {
'use strict';
const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
// Ook te testen in een gewone browser met ?app in het adres
if (!NATIVE && !/[?&]app\b/.test(location.search)) return;

const TTL = 30 * 60 * 1000;
const LIST_TTL = 3600e3; // elk uur kijken of er nieuwe films/series zijn
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
  return { get: k => run('readonly', s => s.get(k)).catch(() => null), set: (k, v) => run('readwrite', s => s.put(v, k)).catch(() => {}), clear: () => run('readwrite', s => s.clear()).catch(() => {}),
    // Alleen sleutels die aan test voldoen weggooien (bijv. alleen de lijsten)
    clearWhere: async test => { const keys = await run('readonly', s => s.getAllKeys()).catch(() => []) || []; await run('readwrite', s => { for (const k of keys) if (test(String(k))) s.delete(k); }).catch(() => {}); } };
})();

let cfg = readJSON('config', null);
let account = null;
const saveCfg = () => writeJSON('config', cfg);
const base = () => cfg.server.replace(/\/+$/, '');
const creds = () => `${encodeURIComponent(cfg.username)}/${encodeURIComponent(cfg.password)}`;
function apiURL(params, c = catalogAcc()) {
  const u = new URL(c.server.replace(/\/+$/, '') + '/player_api.php');
  u.searchParams.set('username', c.username);
  u.searchParams.set('password', c.password);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '' && k[0] !== '_') u.searchParams.set(k, v);
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
  for (let attempt = 0; ; attempt++) {
    // Eerst de rem (rustig aan bij de aanbieder, anders blokkeert hij je adres; _bg = achtergrondwerk, mag wachten),
    // pas daarna een plekje in de rij. Zo staat wat jij aantikt nooit achter achtergrondwerk te wachten.
    await apiGate(params._bg === 'now' ? 'now' : !!params._bg);
    try {
      // Wat jij aantikt hoeft niet te wachten op een vrij plekje (grote lijsten kunnen die lang bezet houden)
      const run = params._bg === 'now' ? (fn => fn()) : limited;
      return await run(async () => {
        const r = await realFetch(apiURL(params), { signal: AbortSignal.timeout(!params.category_id && /streams$|^get_series$/.test(params.action || '') ? 120000 : 30000) });
        noteHealth(true);
        if (!r.ok) throw new Error('API ' + r.status);
        return r.json();
      });
    } catch (e) {
      if (e?.name === 'TypeError' || /fetch failed|timeout|abort/i.test(String(e?.message || e))) noteHealth(false);
      if (attempt >= 1) throw e;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ===================== Gedeelde logica (uit server.js) =====================
// ---------- Namen opschonen ----------
const SMALLCAPS = { 'ᴀ': 'A', 'ʙ': 'B', 'ᴄ': 'C', 'ᴅ': 'D', 'ᴇ': 'E', 'ꜰ': 'F', 'ɢ': 'G', 'ʜ': 'H', 'ɪ': 'I', 'ᴊ': 'J', 'ᴋ': 'K', 'ʟ': 'L', 'ᴍ': 'M', 'ɴ': 'N', 'ᴏ': 'O', 'ᴘ': 'P', 'ʀ': 'R', 'ꜱ': 'S', 'ᴛ': 'T', 'ᴜ': 'U', 'ᴠ': 'V', 'ᴡ': 'W', 'ʏ': 'Y', 'ᴢ': 'Z' };
const SUP = /[ᴬ-ᵪᶛ-ᶿʰ-˿⁰-₟]/g;
const fixCaps = s => String(s || '').replace(/[ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘʀꜱᴛᴜᴠᴡʏᴢ]/g, c => SMALLCAPS[c]);
const plain = s => fixCaps(fixCaps(s).normalize('NFKC'));
const COUNTRY_RE = /^\s*([A-Z]{2,4})\s*(?:\||│|\sI\s)\s*/;
const QUALITY = /\b(16K|8K|4K|UHD|FHD|HD|SD|HEVC|H265|RAW|VIP|REC|50FPS|60FPS|BACKUP)\b/gi;
// Versiering van de aanbieder weghalen (✦●✦●, ★, ═══, emoji's); de titel zelf blijft staan.
// "ZIGGO SP⚽️RT" → "ZIGGO SPORT"
const DECOR = /[←-⇿⌀-⏿─-➿⤀-⥿⬀-⯿〰〽️‍⃣]|\p{Extended_Pictographic}/gu;
const stripDecor = s => String(s || '').replace(/([A-Za-z])⚽️?(?=[A-Za-z])/g, '$1O').replace(DECOR, ' ').replace(/\s{2,}/g, ' ').trim();
const cleanName = s => stripDecor(String(s || '').replace(COUNTRY_RE, '').replace(/^\s*\[[A-Z]{2,4}\]\s*/, ''));
const countryOf = s => { const m = String(s || '').match(COUNTRY_RE); return m ? m[1] : 'OVERIG'; };
// Zendernaam zonder land, kwaliteit en versiering: "16ᴋ | NPO 1ᵁᴴᴰ" → "NPO 1"
const channelName = s => {
  let n = stripDecor(fixCaps(s).replace(SUP, ''));
  for (let i = 0; i < 3; i++) n = n.replace(/^\s*(?:[A-Z]{2,4}|16K|8K|4K)\s*(?:\||│|:)\s*/i, '').replace(/^\s*\[[^\]]{1,24}\]\s*/, '');
  n = n.replace(/^\s*NL\s+/, '').replace(QUALITY, '').replace(/\(\s*\)|\[\s*\]/g, '');
  return n.replace(/\s+/g, ' ').replace(/^[\s|:-]+|[\s|:-]+$/g, '').trim();
};
const ALIAS = { ESPN: 'ESPN1', ZIGGOSPORT1: 'ZIGGOSPORT', NPO1HD: 'NPO1' };
const chanKey = s => { const k = channelName(s).toUpperCase().replace(/[^A-Z0-9+]+/g, '').replace(/SPORTS(?=\d*$)/, 'SPORT'); return ALIAS[k] || k; };
// Taallabel uit de titel: "[NL] Wonder (2017)" → NL, "[NL : NETFLIX ] …" → NL
const langTag = s => (String(s || '').match(/^\s*\[\s*([A-Z]{2,4})\b/) || [])[1] || '';
// Zelfde film/serie in een andere versie (punt erachter, HQ, ander taallabel) → zelfde sleutel
const titleKey = n => fold(n).replace(/\[[^\]]*\]/g, '').replace(/\b(hq|qhd|4k|uhd|fhd|nl gesproken|dubbed|cam versie|hdcam|cam|telesync|hdts)\b/g, '').replace(/\b(480|576|720|1080|2160)p\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\b((19|20)\d\d) (de|en|fr|nl|es|it|tr|pl|pt|ger|eng)$/, '$1');

async function categories(type) {
  const action = { live: 'get_live_categories', vod: 'get_vod_categories', series: 'get_series_categories' }[type];
  return cached('cat:' + type, async () => {
    const raw = await api({ action });
    const list = raw.map((c, i) => ({ id: String(c.category_id), name: cleanName(c.category_name), code: countryOf(c.category_name), order: i }));
    list.forEach(c => { if (c.code === 'NED' || c.code === 'HOL') c.code = 'NL'; });
    return list.sort((a, b) => (b.code === 'NL') - (a.code === 'NL') || a.order - b.order);
  }, true);
}

// Kapotte plaatjes van de aanbieder repareren:
//  - cover.diatunnel.link bestaat niet meer, maar de bestandsnaam is de TMDB-code van de poster
//  - weserv.moviemeter.nl blokkeert ons; het echte adres staat erin (?url=…)
function fixIcon(u) {
  u = String(u || '').trim();
  let m;
  // Ook series-covers ("/images/series/<code>_small.jpg") en rare subdomeinen van diatunnel
  if ((m = u.match(/diatunnel\.link(?::\d+)?\/images\/(?:[a-z]+\/)?([A-Za-z0-9]{20,40})(?:_\w+)?\.(jpe?g|png)/i))) return `https://image.tmdb.org/t/p/w600_and_h900_bestv2/${m[1]}.${m[2]}`;
  if ((m = u.match(/^https?:\/\/weserv\.[^/]+\/?\?url=([^&]+)/i))) { const inner = decodeURIComponent(m[1]); return /^https?:/.test(inner) ? inner : 'https://' + inner; }
  return u.replace(/^http:\/\/image\.tmdb\.org/, 'https://image.tmdb.org');
}

function slim(type, x) {
  if (type === 'live') return { id: x.stream_id, n: cleanName(x.name), i: x.stream_icon || '', c: String(x.category_id), raw: x.name, ...(Number(x.tv_archive) === 1 ? { ar: Number(x.tv_archive_duration) || 1 } : {}) };
  const extra = { lg: langTag(x.name), ...(/\bHQ\b/i.test(x.name) ? { hq: 1 } : {}) };
  if (type === 'vod') return { id: x.stream_id, n: cleanName(x.name).replace(/\s+HQ\b/i, '').replace(/\s*\.$/, ''), i: fixIcon(x.stream_icon), c: String(x.category_id), r: Number(x.rating) || 0, e: x.container_extension || 'mp4', a: Number(x.added) || 0, ...extra };
  return { id: x.series_id, n: cleanName(x.name).replace(/^\[[^\]]*\]\s*/, '').replace(/\s*\.$/, ''), i: fixIcon(x.cover), c: String(x.category_id), r: Number(x.rating) || 0, b: (x.backdrop_path || [])[0] || '', p: x.plot || '', y: (x.releaseDate || x.release_date || '').slice(0, 4), a: Number(x.last_modified) || 0, ...extra };
}

async function list(type, cat) {
  const action = { live: 'get_live_streams', vod: 'get_vod_streams', series: 'get_series' }[type];
  // Een categorie halen we uit de complete lijst (die al klaarstaat): direct, en nooit "laden mislukt"
  if (cat && type !== 'live') {
    let all = null;
    try { all = await list(type); } catch {}
    if (all) return catList(type, all, String(cat));
  }
  return cached(`list5:${type}:${cat || 'all'}`, async () => {
    const raw = await api({ action, category_id: cat || '' });
    return (Array.isArray(raw) ? raw : []).filter(x => !Number(x.is_adult)).map(x => slim(type, x));
  }, true);
}

// ---------- Populair in Nederland ----------
// Netflix publiceert elke week de officiële Top 10 per land. De laatste ~26 weken voor Nederland
// tellen mee (recent zwaarder). Daarbovenop telt wat er in deze app bekeken wordt.
const NF_FILE = path.join(DATA, 'netflix-nl.json');
const popKey = n => titleKey(n).replace(/\b(19|20)\d\d\b/g, '').replace(/\s+/g, ' ').trim();
let nf = { v: 0, films: new Map(), tv: new Map() };
function useNetflix(d) { nf = { v: d.t, films: new Map(d.films), tv: new Map(d.tv) }; }
async function loadNetflixNL() {
  const saved = readJSON(NF_FILE, null);
  if (saved) useNetflix(saved);
  if (saved && Date.now() - saved.t < 24 * 3600e3) return;
  // Elke dag klaargezet door GitHub (Netflix Top 10 NL + wat deze week trending is in Nederland, zie tv-iphone-app)
  try {
    const r = await fetch('https://raw.githubusercontent.com/Henri123455/tv-app/main/data/netflix-nl.json?t=' + Date.now(), { signal: AbortSignal.timeout(60000) });
    if (!r.ok) return;
    const d = await r.json();
    if (saved && saved.t === d.t) return;
    writeJSON(NF_FILE, d); useNetflix(d);
    console.log(`Populair in Nederland bijgewerkt (${d.day || d.week})`);
  } catch {}
}
function popScore(type, x) {
  const n = (type === 'vod' ? nf.films : nf.tv).get(popKey(x.n)) || 0;
  const v = viewTrend(`${type}:${x.id}`);
  const ageDays = x.a ? (Date.now() / 1000 - x.a) / 86400 : 999;
  // Wat Nederland deze week kijkt telt het zwaarst, daarna wat er in deze app bekeken wordt.
  // Echte kinderfilms/-series altijd achteraan (in de kinderrijen zelf blijft de volgorde gewoon kloppen)
  return n * 100 + v * 15 + (x.r || 0) + Math.max(0, 90 - ageDays) / 90 * 10 - (isKid(type, x) ? 1e6 : 0);
}
// Elke score één keer uitrekenen en dan sorteren (scheelt veel rekenwerk op de telefoon)
const byPop = (type, items) => items.map(x => [popScore(type, x), x]).sort((a, b) => b[0] - a[0]).map(e => e[1]);

// ---------- Echte kinderfilms: alles uit de kinder-categorieën (Kinderfilms, Bioscoop Kids, Disney+ Kids, NL gesproken …) ----------
// Niet weg, wel achteraan. Gezinsfilms die niet in zo'n categorie staan blijven gewoon vooraan.
const KIDS_CAT = /KIDS|KINDER|GESPROKEN|SINTERKLAAS|CARTOON|JUNIOR/;
const kidKeys = { vod: new Set(), series: new Set() };
// Ook "NL gesproken" (Nederlands nagesproken) telt als kinderfilm, waar die ook staat
const isKid = (type, x) => /GESPROKEN/i.test(x.n || '') || (!!kidKeys[type]?.size && kidKeys[type].has(titleKey(x.n)));
// Titels uit een paar categorieën (op de telefoon vervangen door alleen die categorieën ophalen)
async function listCats(type, ids) { const all = await list(type); return memo(all, 'cats:' + [...ids].join(','), () => all.filter(x => ids.has(x.c))); }
async function loadKids(type) {
  if (type === 'live') return 0;
  const cats = await categories(type);
  const ids = new Set(cats.filter(c => c.code === 'NL' && KIDS_CAT.test(plain(c.name).toUpperCase())).map(c => c.id));
  const items = await listCats(type, ids);
  kidKeys[type] = memo(items, 'kids', () => new Set(items.map(x => titleKey(x.n))));
  return kidKeys[type].size;
}

// ---------- Eén versie per titel, Nederlands gaat voor ----------
async function nlCatSet(type) {
  const cats = await categories(type);
  return memo(cats, 'nlset', () => {
    const s = new Set(cats.filter(c => c.code === 'NL').map(c => c.id));
    s.cam = new Set(cats.filter(c => /\bCAM\b/i.test(c.name)).map(c => c.id)); // bijv. "BIOSCOOP CAM VERSIE"
    return s;
  });
}
// Bioscoop-opnames (CAM) alleen als er geen normale versie is: herkend aan de naam én aan de categorie
const isCam = (x, nlSet) => /\b(HD)?CAM\b|TELESYNC|\bHDTS\b/i.test(x.n || '') || !!nlSet?.cam?.has(x.c);
// "HQ"-versies komen van een externe site: bij nieuwe films vaak een bioscoop-opname, en de server ligt vaker plat.
// Daarom gaat de eigen versie van de aanbieder voor; HQ alleen als die er niet is.
function versionScore(x, nlSet) {
  return (isCam(x, nlSet) ? -50 : 0) + (nlSet.has(x.c) ? 8 : 0) + (x.lg === 'NL' ? 4 : x.lg === 'ALL' || !x.lg ? 1 : 0) + (x.hq ? -2 : 0) + (x.i ? 1 : 0);
}
function bestVersion(versions, nlSet) {
  return versions.reduce((a, b) => versionScore(b, nlSet) > versionScore(a, nlSet) ? b : a);
}
// Losse sleutel: zonder jaartal, (SUB) en spaties, zodat "Batmanvs Two Face" en "Batman vs. Two-Face (2017)" bij elkaar horen
const looseKey = k => k.replace(/\b(19|20)\d\d\b/g, '').replace(/\b(sub|subs|subbed)\b/g, '').replace(/ /g, '');
const yearOfKey = k => (k.match(/\b(19|20)\d\d\b/) || [])[0] || '';
// Titels zonder jaartal bij de versie mét jaartal voegen, maar alleen als er precies één jaartal is (remakes blijven apart)
function looseMerge(g, merge) {
  const buckets = new Map();
  for (const [k, v] of g) { const l = looseKey(k); if (!l) continue; if (!buckets.has(l)) buckets.set(l, []); buckets.get(l).push([k, v]); }
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    const years = new Set(list.map(([k]) => yearOfKey(k)).filter(Boolean));
    if (years.size > 1) continue;
    const [k0, v0] = list.find(([k]) => yearOfKey(k)) || list[0];
    for (const [k, v] of list) if (k !== k0) { merge(v0, v); g.delete(k); }
  }
}
function dedupe(items, nlSet) {
  const g = new Map();
  for (const x of items) { const k = titleKey(x.n); if (!g.has(k)) g.set(k, []); g.get(k).push(x); }
  looseMerge(g, (into, from) => into.push(...from));
  return [...g.values()].map(v => {
    const best = bestVersion(v, nlSet);
    if (v.length < 2) return best;
    // De andere versies onthouden: werkt de beste even niet (bijv. een kapotte HQ-server), dan neemt de app de volgende
    const rest = v.filter(x => x !== best).sort((a, b) => versionScore(b, nlSet) - versionScore(a, nlSet));
    return { ...best, alt: rest.slice(0, 4).map(x => ({ id: x.id, e: x.e })) };
  });
}
// Alle Nederlandse titels, één versie elk, populairste eerst
// Alle versies van één titel voor de knop "Bron": de beste (die de app al koos) eerst, dan Nederlands, CAM als laatste
async function versionsOf(type, id, name, items) {
  const key = titleKey(name || ''), nlSet = await nlCatSet(type);
  const cats = new Map((await categories(type)).map(c => [c.id, c]));
  const seen = new Set();
  const score = x => (String(x.id) === String(id) ? 1000 : 0) + versionScore(x, nlSet);
  return items.filter(x => titleKey(x.n) === key && !seen.has(String(x.id)) && seen.add(String(x.id)))
    .sort((a, b) => score(b) - score(a)).slice(0, 12)
    .map(x => ({ id: x.id, e: x.e, cat: cats.get(x.c)?.name || '', ...(x.hq ? { hq: 1 } : {}), ...(isCam(x, nlSet) ? { cam: 1 } : {}), ...(nlSet.has(x.c) || x.lg === 'NL' ? { nl: 1 } : {}) }));
}

async function nlPool(type) {
  const [all, nlSet, kids] = await Promise.all([list(type), nlCatSet(type), loadKids(type)]);
  return memo(all, `nlpool:${nf.v}:${viewsVersion}:${kids}`, () => byPop(type, dedupe(all.filter(x => nlSet.has(x.c)), nlSet)));
}
async function nlKeys(type) {
  const pool = await nlPool(type);
  return memo(pool, 'keys', () => new Set(pool.map(x => titleKey(x.n))));
}
// Alles (ook buitenlands), maar wat in het Nederlands bestaat alleen in het Nederlands
async function allPool(type) {
  const [all, nlSet, pool] = await Promise.all([list(type), nlCatSet(type), nlPool(type)]);
  const keys = await nlKeys(type);
  return memo(pool, 'all', () => [...pool, ...byPop(type, dedupe(all.filter(x => !nlSet.has(x.c) && !keys.has(titleKey(x.n))), nlSet))]);
}

// Eén rij (categorie of samengevoegde categorieën, bijv. "Bioscoop" + "Bioscoop HQ"), populairste links
async function catList(type, all, catIds) {
  const [nlSet, kids] = await Promise.all([nlCatSet(type), loadKids(type)]);
  const ids = new Set(catIds.split(','));
  const isNL = [...ids].some(id => nlSet.has(id));
  const keys = isNL ? null : await nlKeys(type);
  return memo(all, `cat:${catIds}:${nf.v}:${viewsVersion}:${kids}`, () => {
    let items = dedupe(all.filter(x => ids.has(x.c)), nlSet);
    if (keys) items = items.filter(x => !keys.has(titleKey(x.n)));
    return byPop(type, items);
  });
}

// Categorieën voor Films en Series: HQ/TEST-varianten samengevoegd, bekende diensten bovenaan, kinderen onderaan
const ROW_ORDER = {
  vod: [/^BIOSCOOP$/, /^NETFLIX$/, /^VIDEOLAND$/, /^DISNEY\+$/, /^AMAZON PRIME$/, /^HBO MAX$/, /^PATHE THUIS$/, /^SKY ?SHOWTIME$/, /^APPLE TV\+$/, /^VIAPLAY$/, /^NPO\+/, /GESPROKEN/, /^PARAMOUNT/, /KLASSIEKERS|IMDB/, /^MOVIES/, /^OLD BUT GOLD/, /^LIONSGATE/],
  series: [/^NETFLIX$/, /^VIDEOLAND$/, /^SERIES$/, /^NPO\+/, /HBO/, /^DISNEY\+$/, /APPLE|AMAZON/, /^SKY ?SHOWTIME$/, /^VIAPLAY$/, /^CANAL\+/, /^PARAMOUNT/, /^HULU/, /^DISCOVERY/, /^STARZ/, /^PEACOCK/, /^TV SHOWS/],
};
const KIDS_ROW = /KIDS|KINDER|ANIME|CRUNCHYROLL|SINTERKLAAS|KERST|CARTOON/;
const LOW_ROW = /CAM VERSIE|BLACK|FAITH|WITHLOVE|VUDU|BOX MOVIES|GOOGLE PLAY|FIGHTCLUB|CONCERT|90 DAY|NORDIC/;
async function rowCategories(type) {
  const cats = await categories(type);
  if (type === 'live') return cats;
  return memo(cats, 'rows', () => {
    const base = n => plain(n).toUpperCase().replace(/\(TEST\)|\bQHD\b|\bHQ\b/g, '').replace(/\s+/g, ' ').trim();
    const groups = new Map();
    for (const c of cats) {
      const k = c.code + '|' + base(c.name);
      const g = groups.get(k);
      if (g) g.id += ',' + c.id; else groups.set(k, { ...c, id: c.id, name: base(c.name) });
    }
    const rank = c => {
      const n = c.name;
      if (KIDS_ROW.test(n)) return 900;
      if (LOW_ROW.test(n)) return 500;
      const i = (ROW_ORDER[type] || []).findIndex(re => re.test(n));
      return i >= 0 ? i : 100;
    };
    return [...groups.values()].sort((a, b) => (b.code === 'NL') - (a.code === 'NL') || (a.code === 'NL' ? rank(a) - rank(b) : 0) || a.order - b.order);
  });
}

// Plaatjes aanvullen voor titels zonder (werkend) plaatje: uit de detailinfo van de aanbieder
// Ontbrekend of kapot plaatje: eerst de plaatjes uit de detailinfo van de aanbieder (alleen een plaatje dat echt laadt),
// anders de poster opzoeken bij JustWatch op titel en jaar. De uitkomst wordt per titel onthouden.
async function imageOk(u) {
  if (!/^https?:\/\//.test(u || '')) return false;
  // Harde grens van 6 s (op de telefoon luistert het native verzoek niet altijd naar een afbreek-signaal)
  const check = fetch(u, { signal: AbortSignal.timeout(6000) }).then(r => r.ok && /^image\//.test(r.headers.get('content-type') || ''), () => false);
  return Promise.race([check, new Promise(res => setTimeout(() => res(false), 6500))]);
}
const JW_SEARCH = `query S($q: String!) { popularTitles(country: NL, first: 5, filter: { searchQuery: $q }) {
  edges { node { objectType content(country: NL, language: "nl") { title originalTitle originalReleaseYear posterUrl } } } } }`;
async function justWatchPoster(type, name) {
  const year = +(String(name).match(/\((\d{4})/) || [])[1] || 0;
  const q = tidyTitle(name);
  if (!q) return '';
  const r = await fetch('https://apis.justwatch.com/graphql', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ query: JW_SEARCH, variables: { q } }),
  });
  if (!r.ok) return '';
  const want = type === 'vod' ? 'MOVIE' : 'SHOW';
  const hits = ((await r.json()).data?.popularTitles?.edges || []).map(e => e.node).filter(n => n.content?.posterUrl);
  // Alleen dezelfde titel (Nederlandse of originele naam) telt, liefst met hetzelfde jaar: nooit "een film uit hetzelfde jaar"
  const key = popKey(q);
  const same = n => n.objectType === want && (popKey(n.content.title) === key || popKey(n.content.originalTitle) === key);
  const best = hits.find(n => same(n) && (!year || Math.abs(n.content.originalReleaseYear - year) <= 1))
    || (!year ? null : hits.find(n => same(n) && Math.abs(n.content.originalReleaseYear - year) <= 3));
  return best ? 'https://images.justwatch.com' + best.content.posterUrl.replace('{profile}', 's592').replace('{format}', 'jpg') : '';
}
// Titel zonder jaartal, taal-labels en [haakjes] om op te zoeken
const tidyTitle = n => String(n || '').replace(/\[[^\]]*\]/g, '').replace(/\(\s*\d{4}[^)]*\)/g, '').replace(/\b(NL GESPROKEN|HQ|4K|UHD)\b/gi, '').replace(/\s+/g, ' ').trim();
// Jaartal van een serie = het jaar van de nieuwste aflevering van het laatste seizoen.
// De info van de aanbieder is soms oud (Andy & Melisa: afleveringen "2015"), terwijl de naam wel "(2026)" zegt:
// daarom telt ook het (laatste) jaar in de naam mee, en wint het nieuwste.
const yearIn = d => { const y = +String(d || '').slice(0, 4); return y > 1900 && y <= new Date().getFullYear() + 1 ? y : 0; };
const nameYear = n => Math.max(0, ...[...String(n || '').matchAll(/\b(19\d\d|20\d\d)\b/g)].map(m => yearIn(m[1])));
function seriesYear(info, name) {
  const eps = info?.episodes || {};
  const last = Object.keys(eps).filter(k => Number(k) > 0).sort((a, b) => a - b).pop();
  const air = Math.max(0, ...(eps[last] || []).map(e => yearIn(e.info?.air_date || e.info?.releasedate)),
    ...(Array.isArray(info?.seasons) ? info.seasons : []).filter(s => String(s.season_number) === String(last)).map(s => yearIn(s.air_date)));
  const i = Array.isArray(info?.info) ? {} : info?.info || {};
  return Math.max(air, nameYear(name)) || yearIn(i.releaseDate || i.release_date) || 0;
}
async function seriesYears(ids, names = {}) {
  const out = {};
  await Promise.all(ids.slice(0, 16).map(async id => {
    try { out[id] = seriesYear(await cached('si:' + id, () => api({ action: 'get_series_info', series_id: id, _bg: 1 }), true), names[id]); } catch {}
  }));
  return out;
}

// ---------- Extra bij een film/serie: IMDb-score en "lijkt op" (via JustWatch), alleen titels die wij ook hebben ----------
const JW_EXTRA = `query S($q: String!) { popularTitles(country: NL, first: 5, filter: { searchQuery: $q }) {
  edges { node { objectType content(country: NL, language: "nl") { title originalTitle originalReleaseYear scoring { imdbScore imdbVotes } }
    ... on Movie { similarTitlesV2(country: NL, first: 30) { edges { node { objectType content(country: NL, language: "nl") { title originalTitle } } } } }
    ... on Show { similarTitlesV2(country: NL, first: 30) { edges { node { objectType content(country: NL, language: "nl") { title originalTitle } } } } }
  } } } }`;
async function titleExtra(type, name) {
  const q = tidyTitle(name), year = +(String(name).match(/\((\d{4})/) || [])[1] || 0;
  if (!q) return { imdb: 0, similar: [] };
  const jw = await cached(`jwx:${type}:${popKey(name)}`, async () => {
    const r = await fetch('https://apis.justwatch.com/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000), body: JSON.stringify({ query: JW_EXTRA, variables: { q } }) });
    if (!r.ok) throw new Error('JustWatch ' + r.status);
    const want = type === 'vod' ? 'MOVIE' : 'SHOW', key = popKey(q);
    const hits = ((await r.json()).data?.popularTitles?.edges || []).map(e => e.node);
    const same = n => n.objectType === want && (popKey(n.content?.title) === key || popKey(n.content?.originalTitle) === key);
    const hit = hits.find(n => same(n) && (!year || Math.abs((n.content.originalReleaseYear || 0) - year) <= 1)) || hits.find(same);
    if (!hit) return { imdb: 0, votes: 0, similar: [] };
    return {
      imdb: hit.content.scoring?.imdbScore || 0, votes: hit.content.scoring?.imdbVotes || 0,
      similar: (hit.similarTitlesV2?.edges || []).map(e => e.node).filter(n => n.objectType === want).map(n => [n.content.title, n.content.originalTitle]),
    };
  }, true);
  // "Lijkt op" koppelen aan onze eigen titels (Nederlandse lijst, populairste versie)
  const pool = await nlPool(type);
  const byKey = memo(pool, 'popkeys', () => { const m = new Map(); for (const x of pool) { const k = popKey(x.n); if (!m.has(k)) m.set(k, x); } return m; });
  const own = popKey(name), similar = [];
  for (const [t, o] of jw.similar || []) {
    const x = byKey.get(popKey(t)) || byKey.get(popKey(o));
    if (x && popKey(x.n) !== own && !similar.includes(x) && !isKid(type, x)) similar.push(x);
  }
  return { imdb: jw.imdb, votes: jw.votes, similar: similar.slice(0, 20) };
}

// Titels die de app meestuurt (om op te zoeken als de aanbieder zelf geen naam in de info heeft)
const artNames = s => { try { const o = JSON.parse(s || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
async function artFor(type, ids, names = {}) {
  const out = {};
  await Promise.all(ids.slice(0, 24).map(async id => {
    try {
      out[id] = await cached(`art3:${type}:${id}`, async () => {
        const j = type === 'vod'
          ? await cached('vi:' + id, () => api({ action: 'get_vod_info', vod_id: id, _bg: 1 }), true)
          : await cached('si:' + id, () => api({ action: 'get_series_info', series_id: id, _bg: 1 }), true);
        const i = Array.isArray(j.info) ? {} : j.info || {};
        const tries = [...new Set((type === 'vod' ? [i.movie_image, i.cover_big] : [i.cover]).map(fixIcon).filter(Boolean))];
        for (const u of tries) if (await imageOk(u)) return u;
        const jw = await Promise.race([justWatchPoster(type, names[id] || i.name || i.o_name || '').catch(() => ''), new Promise(res => setTimeout(() => res(''), 9000))]);
        if (jw) return jw;
        // Laatste kans: een liggende foto uit de info (alleen als die echt laadt)
        for (const u of [...new Set((i.backdrop_path || []).map(fixIcon))].filter(u => u && !tries.includes(u)).slice(0, 2)) if (await imageOk(u)) return u;
        return '';
      }, true, 7 * 864e5);
    } catch { out[id] = ''; }
  }));
  return out;
}

// ---------- Ondertitels van internet: OpenSubtitles (via de openbare Stremio-dienst, zonder account) ----------
// Heeft een film of aflevering zelf geen (Nederlandse) ondertitel, dan deze. Eerst het IMDb-nummer opzoeken
// (JustWatch), dan per taal een paar ondertitels. Nederlands en Engels.
const JW_IDS = `query S($q: String!) { popularTitles(country: NL, first: 8, filter: { searchQuery: $q }) {
  edges { node { objectType content(country: NL, language: "nl") { title originalTitle originalReleaseYear externalIds { imdbId tmdbId } } } } } }`;
const SUB_HOST = /^https:\/\/[\w.-]+\.strem\.io\//;
async function imdbOf(type, name, year, tmdb) {
  const q = tidyTitle(name); if (!q) return '';
  year = Number(year) || nameYear(name);
  return cached(`imdb:${type}:${popKey(name)}:${year}:${tmdb || ''}`, async () => {
    const r = await fetch('https://apis.justwatch.com/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000), body: JSON.stringify({ query: JW_IDS, variables: { q } }) });
    if (!r.ok) throw new Error('JustWatch ' + r.status);
    const want = type === 'series' ? 'SHOW' : 'MOVIE';
    const hits = ((await r.json()).data?.popularTitles?.edges || []).map(e => e.node).filter(n => n.objectType === want && n.content?.externalIds?.imdbId);
    const key = popKey(q);
    const same = n => popKey(n.content.title || '') === key || popKey(n.content.originalTitle || '') === key;
    const near = n => !year || Math.abs((n.content.originalReleaseYear || 0) - year) <= 1;
    const hit = (tmdb && hits.find(n => String(n.content.externalIds.tmdbId) === String(tmdb))) || hits.find(n => same(n) && near(n)) || (!year && hits.find(same));
    return hit ? hit.content.externalIds.imdbId : '';
  }, true);
}
async function subtitleList(type, name, year, tmdb, season, episode) {
  const imdb = await imdbOf(type, name, year, tmdb).catch(() => '');
  if (!imdb) return [];
  const id = type === 'series' ? `series/${imdb}:${Number(season) || 1}:${Number(episode) || 1}` : `movie/${imdb}`;
  const list = await cached('osub:' + id, async () => {
    const r = await fetch(`https://opensubtitles-v3.strem.io/subtitles/${id}.json`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('ondertitels ' + r.status);
    return (await r.json()).subtitles || [];
  }, true);
  const out = [], per = { nl: 0, en: 0 };
  for (const s of list) {
    const lang = /^(nld|dut)$/.test(s.lang) ? 'nl' : s.lang === 'eng' ? 'en' : '';
    if (!lang || per[lang] >= 4 || !SUB_HOST.test(s.url || '')) continue;
    per[lang]++; out.push({ lang, url: s.url });
  }
  return out;
}

// ---------- Nu op tv: per zender wat er nu is en wat er hierna komt (voor de kaarten bij Live TV) ----------
async function epgNow(ids) {
  const out = {};
  await Promise.all(ids.slice(0, 24).map(async id => {
    try {
      const j = await cached('epg:' + id, () => api({ action: 'get_short_epg', stream_id: id, limit: 4, _bg: 1 }));
      const l = (j.epg_listings || []).map(e => ({ t: decodeB64(e.title), s: Number(e.start_timestamp), e: Number(e.stop_timestamp) }));
      const now = Date.now() / 1000, i = l.findIndex(x => x.s <= now && x.e > now);
      if (i >= 0) out[id] = { t: l[i].t, s: l[i].s, e: l[i].e, n: l.slice(i + 1).find(x => x.t && x.t !== l[i].t)?.t || '' };
    } catch {}
  }));
  return out;
}

// ---------- Live: één beste versie per zender, ingedeeld in kopjes ----------
// Gemeten (okt 2026): niets is echt 4K/8K/16K. Odido = 1080p50 H.264 ~6,6 Mbps (beste en werkt overal),
// "HD Nederland" = 1080p50 HEVC ~2,5 Mbps, 16K/4K/8K = 1080p ~2-3 Mbps, SD = 540p.
function sourceRank(catName) {
  const n = plain(catName).toUpperCase();
  if (/ODIDO/.test(n)) return 10;
  if (/^SD\b/.test(n)) return 1;
  if (/^(HD|FHD)\b/.test(n)) return 6;
  if (/^(16K|4K|UHD)\b/.test(n)) return 5;
  if (/^8K\b/.test(n)) return 4;
  return 3;
}
const isQualityCat = name => /^(16K|8K|4K|UHD|FHD|HD|SD)\b/i.test(plain(name).trim()) || /^ODIDO$/i.test(plain(name).trim());

const MAIN_ORDER = ['NPO1', 'NPO2', 'NPO3', 'RTL4', 'RTL5', 'SBS6', 'RTL7', 'RTL8', 'NET5', 'VERONICA', 'SBS9', 'RTLZ', 'NPOPOLITIEKENNIEUWS', 'NPO1EXTRA', 'NPO2EXTRA'];
const TOPICS = [
  ['Nederlandse zenders', (n) => /^(NPO|RTL|SBS|NET 5|VERONICA|VTV|SBS9)\b/.test(n) && !/SPORT|EVENT/.test(n)],
  ['ESPN & Ziggo Sport', (n) => /ESPN|ZIGGO/.test(n)],
  ['Voetbal', (n, c) => /VOETBAL|FOOTBALL|EREDIVISIE|KEUKEN ?KAMPIOEN|CHAMPIONS|FEYENOORD|AJAX|PSV/.test(n + ' ' + c)],
  ['Formule 1 & racing', (n, c) => /\bF1\b|FORMUL|RACING|MOTOGP|NASCAR|INDYCAR/.test(n + ' ' + c)],
  ['DAZN & Viaplay', (n, c) => /DAZN|VIAPLAY/.test(n + ' ' + c)],
  ['Meer sport', (n, c) => /SPORT|EUROSPORT|FIGHT|UFC|GLORY|PPV|DARTS|TENNIS|GOLF|LIVE EVENT/.test(n + ' ' + c)],
  ['Films & series', (n, c) => /FILM|MOVIE|SERIE|HBO|VIDEOLAND|RAKUTEN|CINE|STAR ?CHANNEL|NETFLIX|SKYSHOWTIME/.test(n + ' ' + c)],
  ['Kids', (n, c) => /KIDS|NICK|JUNIOR|CARTOON|BOOMERANG|ZAPP|BABY|DISNEY|KINDER/.test(n + ' ' + c)],
  ['Documentaires', (n, c) => /DOCU|DISCOVERY|NAT ?GEO|NATIONAL GEO|HISTORY|ANIMAL|TLC|INVESTIGATION|CRIME/.test(n + ' ' + c)],
  ['Muziek & radio', (n, c) => /MUSIC|MUZIEK|RADIO|MTV|TMF|SLAM|538|QMUSIC|XITE|STINGRAY/.test(n + ' ' + c)],
  ['Regionaal', (n, c) => /REGIO|OMROEP|RTV|TV WEST|TV NOORD|BRABANT|GELDERLAND|AT5|FRYSLAN|DRENTHE|RIJNMOND|ZEELAND|LIMBURG|FLEVOLAND|BUITENLAND|BVN/.test(n + ' ' + c)],
  ['24/7 zenders', (n, c) => /ENJOY|24\/7|NONSTOP/.test(c)],
];
// Losse uitzendingen ("Feyenoord - Ajax", "2026 4 Post-Race Show") na de vaste zenders
const isEvent = n => /\s-\s|^LIVE\b|^\d{4}\s|^\d{1,2}[-/.]\d{1,2}\b|PERSCONFERENTIE|EVENT ONLY|\bVS\.?\b/i.test(n);
// Vaste zenders (die bij meerdere bronnen bestaan) eerst, losse extra kanalen daarna, uitzendingen als laatste
const natural = (a, b) => isEvent(a.n) - isEvent(b.n) || ((b.alt?.length >= 2) - (a.alt?.length >= 2)) || a.n.localeCompare(b.n, 'nl', { numeric: true, sensitivity: 'base' });

// Alle versies van een zender samenvoegen; de beste bron eerst, de rest als reserve (alt)
function mergeChannels(entries) {
  const groups = new Map();
  for (const { x, cat } of entries) {
    const key = chanKey(x.raw);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { key, versions: [], cats: new Set() });
    g.versions.push({ x, rank: sourceRank(cat.name) });
    if (!isQualityCat(cat.name)) g.cats.add(plain(cat.name).toUpperCase());
  }
  return [...groups.values()].map(g => {
    g.versions.sort((a, b) => b.rank - a.rank);
    const best = g.versions[0].x;
    const icon = (g.versions.find(v => v.x.i) || g.versions[0]).x.i;
    // Naam: liefst de "volledige" schrijfwijze ("ESPN 1" i.p.v. "ESPN")
    const named = g.versions.find(v => channelName(v.x.raw).toUpperCase().replace(/[^A-Z0-9+]+/g, '') === g.key) || g.versions[0];
    return { key: g.key, cats: [...g.cats].join(' '), item: { id: best.id, n: channelName(named.x.raw) || best.n, i: icon, alt: g.versions.slice(1, 6).map(v => v.x.id) } };
  });
}

async function liveHome() {
  const [all, cats] = await Promise.all([list('live'), categories('live')]);
  return memo(all, 'home:' + viewsVersion, () => {
    const catById = new Map(cats.map(c => [c.id, c]));
    const nl = all.map(x => ({ x, cat: catById.get(x.c) })).filter(e => e.cat && e.cat.code === 'NL');
    const merged = mergeChannels(nl);
    const rows = new Map(TOPICS.map(([t]) => [t, []]));
    rows.set('Meer zenders', []);
    for (const m of merged) {
      const n = m.item.n.toUpperCase();
      const topic = (TOPICS.find(([, test]) => test(n, m.cats)) || ['Meer zenders'])[0];
      rows.get(topic).push(m.item);
    }
    const main = rows.get('Nederlandse zenders');
    main.sort((a, b) => {
      const ia = MAIN_ORDER.indexOf(chanKey(a.n)), ib = MAIN_ORDER.indexOf(chanKey(b.n));
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || natural(a, b);
    });
    // Binnen een kopje (ESPN, Ziggo Sport …): de nu meest bekeken zenders eerst
    const watched = x => viewTrend('live:' + x.id) + (x.alt || []).reduce((s, id) => s + viewTrend('live:' + id), 0);
    for (const [t, l] of rows) if (t !== 'Nederlandse zenders') l.sort((a, b) => watched(b) - watched(a) || natural(a, b));
    const countries = new Map();
    for (const c of cats) if (c.code !== 'NL' && c.code !== 'OVERIG') countries.set(c.code, (countries.get(c.code) || 0) + 1);
    return {
      nl: [...rows].filter(([, l]) => l.length).map(([title, items]) => ({ title, items })),
      countries: [...countries].map(([code, n]) => ({ code, n })),
    };
  });
}

// ---------- Sport vandaag: alle wedstrijden, races en gevechten van vandaag op de Nederlandse sportzenders ----------
// Uit de programmagids van de sportzenders (ESPN, Ziggo Sport, Viaplay, DAZN …); herhalingen en studio-praat eruit.
const SPORT_TOPIC = /ESPN|ZIGGO|VOETBAL|FORMULE|RACING|DAZN|VIAPLAY|SPORT/i;
const NO_SPORT = /herhaling|samenvatting|highlights|replay|\(r\)|magazine|studio|journaal|nieuws|teleshop|programma|gesloten|einde uitzending|to be announced|tba$|vandaag|dit was|weekend|legends|iconic|voorbeschouwing|nabeschouwing|preview|review|documentaire|podcast|^ziggo( sport)?( tv)?$|^espn\s*\d*$|^viaplay|^dazn$/i;
let sportCache = null;
async function sportToday() {
  if (sportCache && Date.now() - sportCache.t < 10 * 60e3) return sportCache.data;
  const home = await liveHome();
  const chans = home.nl.filter(r => SPORT_TOPIC.test(r.title)).flatMap(r => r.items).slice(0, 36);
  const now = Date.now() / 1000, end = new Date(); end.setHours(23, 59, 59, 999);
  const out = [];
  for (let i = 0; i < chans.length; i += 6) {
    await Promise.all(chans.slice(i, i + 6).map(async ch => {
      try {
        const j = await api({ action: 'get_short_epg', stream_id: ch.id, limit: 16, _bg: 1 });
        for (const e of j.epg_listings || []) {
          const s = Number(e.start_timestamp), en = Number(e.stop_timestamp), t = decodeB64(e.title).trim();
          if (!t || en < now || s > end.getTime() / 1000 || en - s < 20 * 60 || NO_SPORT.test(t)) continue;
          out.push({ s, e: en, t, d: decodeB64(e.description).slice(0, 160), ch: { id: ch.id, n: ch.n, i: ch.i, alt: ch.alt } });
        }
      } catch {}
    }));
  }
  // Zelfde uitzending op meerdere zenders: één keer (eerste zender)
  const seen = new Set();
  const data = out.sort((a, b) => a.s - b.s || a.ch.n.localeCompare(b.ch.n))
    .filter(x => { const k = x.t.toLowerCase() + '|' + x.s; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 80);
  sportCache = { t: Date.now(), data };
  return data;
}

// Ander land: kwaliteitscategorieën (8K/4K/HD/SD …) worden één rij "Zenders" met per zender de beste versie
async function liveCountry(code) {
  const [all, cats] = await Promise.all([list('live'), categories('live')]);
  return memo(all, 'country:' + code, () => {
    const mine = cats.filter(c => c.code === code);
    const ids = new Set(mine.map(c => c.id));
    const byCat = new Map(mine.map(c => [c.id, []]));
    for (const x of all) if (ids.has(x.c)) byCat.get(x.c).push(x);
    const quality = mine.filter(c => isQualityCat(c.name));
    const rows = [];
    if (quality.length) {
      const merged = mergeChannels(quality.flatMap(c => byCat.get(c.id).map(x => ({ x, cat: c }))));
      rows.push({ title: 'Zenders', items: merged.map(m => m.item).sort(natural) });
    }
    for (const c of mine) {
      if (isQualityCat(c.name)) continue;
      const merged = mergeChannels(byCat.get(c.id).map(x => ({ x, cat: c })));
      if (merged.length) rows.push({ title: plain(c.name), items: merged.map(m => m.item) });
    }
    return rows;
  });
}

// ---------- Zoeken: beste match, nieuwste of meest bekeken; Nederlands gaat voor ----------
const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function matchScore(name, needle) { return matchFolded(fold(name), needle); }
function matchFolded(n, needle) {
  if (n === needle) return 100;
  if (n.startsWith(needle)) return 85;
  const i = n.indexOf(needle);
  if (i > 0) return /[a-z0-9]/.test(n[i - 1]) ? 45 : 70;
  const words = needle.split(/\s+/).filter(Boolean);
  return words.length > 1 && words.every(w => n.includes(w)) ? 30 : 0;
}

// ---- Tikfouten: "zigo sprot" vindt toch "Ziggo Sport" ----
// Afstand tussen twee woorden (letters vervangen/toevoegen/weglaten/omdraaien), stopt vroeg boven max
function editDistance(a, b, max) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev2 = null, prev = Array.from({ length: lb + 1 }, (_, j) => j);
  for (let i = 1; i <= la; i++) {
    const cur = [i]; let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v; if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return prev[lb];
}
const maxTypos = len => len >= 7 ? 2 : len >= 4 ? 1 : 0;
// Zoekindex per lijst (één keer opgebouwd): voorgevouwen namen + woord → items
function searchIndex(type, arr) {
  return memo(arr, 'idx', () => {
    const names = arr.map(x => fold(type === 'live' ? channelName(x.raw) : x.n));
    const tok = new Map();
    names.forEach((n, i) => { for (const w of new Set(n.split(/[^a-z0-9]+/))) if (w.length >= 2) { let l = tok.get(w); if (!l) tok.set(w, l = []); l.push(i); } });
    return { names, tok, words: [...tok.keys()], fuzzy: new Map() };
  });
}
function fuzzyHits(idx, needle) {
  if (idx.fuzzy.has(needle)) return idx.fuzzy.get(needle);
  const parts = needle.split(/[^a-z0-9]+/).filter(w => w.length >= 2);
  let result = null;
  for (const t of parts) {
    const d = maxTypos(t.length), set = new Set();
    for (const w of idx.words) {
      let hit = w.startsWith(t);
      if (!hit && d) hit = editDistance(t, w, d) <= d || (w.length > t.length + 1 && t.length >= 4 && editDistance(t, w.slice(0, t.length), 1) <= 1);
      if (hit) for (const i of idx.tok.get(w)) set.add(i);
    }
    result = result ? new Set([...result].filter(i => set.has(i))) : set;
    if (!result.size) break;
  }
  const out = result ? [...result] : [];
  if (idx.fuzzy.size > 200) idx.fuzzy.clear();
  idx.fuzzy.set(needle, out);
  return out;
}

// ---- Hoe vaak iets in deze app bekeken is (alle profielen samen). De aanbieder geeft geen kijkcijfers. ----
const VIEWS = path.join(DATA, 'views2.json');
const views = readJSON(VIEWS, {});
let viewsTimer;
function addView(k, item) {
  const v = views[k] ||= { c: 0, ts: [] };
  v.c++;
  v.ts = [...v.ts.filter(t => Date.now() - t < 14 * 864e5), Date.now()].slice(-100);
  if (item && item.n) v.item = Object.fromEntries(Object.entries(item).filter(([key, val]) => ['id', 'n', 'i', 'alt', 'e', 'b', 'p', 'c', 'r', 'a'].includes(key) && val != null && val !== ''));
  clearTimeout(viewsTimer);
  viewsTimer = setTimeout(() => writeJSON(VIEWS, views), 2000);
  // Gesorteerde lijsten hoogstens elke 5 minuten opnieuw ordenen (scheelt rekenwerk)
  if (Date.now() - lastBump > 5 * 60e3) { viewsVersion++; lastBump = Date.now(); }
}
let viewsVersion = 0, lastBump = 0;
const viewCount = k => views[k]?.c || 0;
const viewTrend = k => { const v = views[k]; if (!v) return 0; const now = Date.now(); return v.ts.reduce((a, t) => a + Math.pow(0.5, (now - t) / (2 * 864e5)), 0); };

// Top 10 van dit moment: recent kijken telt zwaarder (live: per 6 uur half zo zwaar, films/series per 2 dagen).
// Te weinig gekeken? Dan aangevuld met de grootste Nederlandse zenders / best beoordeelde nieuwe titels.
async function top10(type) {
  const now = Date.now(), half = type === 'live' ? 6 * 3600e3 : 2 * 864e5;
  const trending = Object.entries(views)
    .filter(([k, v]) => k.startsWith(type + ':') && v.item)
    .map(([, v]) => ({ item: v.item, s: v.ts.reduce((a, t) => a + Math.pow(0.5, (now - t) / half), 0) }))
    .filter(x => x.s > 0.05).sort((a, b) => b.s - a.s).map(x => x.item);
  let fill = [];
  if (type === 'live') {
    const h = await liveHome();
    fill = [...(h.nl[0]?.items || []).slice(0, 6), ...(h.nl.find(r => /ESPN/.test(r.title))?.items || []).filter(x => x.alt?.length >= 2).slice(0, 4)];
  } else {
    // Wat in Nederland nu het meest bekeken wordt (Netflix Top 10 NL + kijken in deze app)
    const kids = new Set((await categories(type)).filter(c => c.code === 'NL' && KIDS_ROW.test(plain(c.name).toUpperCase())).map(c => c.id));
    return (await nlPool(type)).filter(x => x.i && !kids.has(x.c) && !isKid(type, x)).slice(0, 10);
  }
  // Zelfde titel in andere versie (HQ, NL gesproken, …) maar één keer
  const keyOf = x => fold(x.n).replace(/\[[^\]]*\]|\b(hq|4k|uhd|nl gesproken)\b/g, '').replace(/[^a-z0-9]+/g, '');
  const seen = new Set(), out = [];
  for (const x of [...trending, ...fill]) { const k = keyOf(x); if (seen.has(k)) continue; seen.add(k); out.push(x); if (out.length === 10) break; }
  return out;
}

async function search(query, sort = 'match') {
  const needle = fold(query).trim();
  const out = { live: [], vod: [], series: [] };
  if (needle.length < 2) return out;
  for (const t of ['live', 'vod', 'series']) {
    const catById = new Map((await categories(t)).map(c => [c.id, c]));
    const all = await list(t);
    const idx = searchIndex(t, all);
    let found = [];
    idx.names.forEach((n, i) => { const s = matchFolded(n, needle); if (s) found.push([i, s]); });
    // Weinig of niets gevonden? Dan ook met tikfouten zoeken
    if (found.length < 8) {
      const have = new Set(found.map(([i]) => i));
      for (const i of fuzzyHits(idx, needle)) if (!have.has(i)) found.push([i, 25]);
    }
    let hits;
    if (t === 'live') {
      // Per land één beste versie van elke zender
      const byCountry = new Map(), scoreOf = new Map();
      for (const [i, s] of found) {
        const x = all[i], c = catById.get(x.c); if (!c) continue;
        if (!byCountry.has(c.code)) byCountry.set(c.code, []);
        byCountry.get(c.code).push({ x, cat: c });
        scoreOf.set(x.id, s);
      }
      // Bestaat de zender in Nederland, dan alleen de Nederlandse (geen Duitse "Ziggo Sport" ernaast)
      const merged = [...byCountry].map(([code, e]) => [code, mergeChannels(e)]);
      const nlChannelKeys = new Set((merged.find(([code]) => code === 'NL')?.[1] || []).map(m => m.key));
      hits = merged.flatMap(([code, ms]) => ms.filter(m => code === 'NL' || !nlChannelKeys.has(m.key))
        .map(m => ({ ...m.item, nl: code === 'NL' ? 1 : 0, base: Math.max(scoreOf.get(m.item.id) || 0, matchScore(m.item.n, needle)) || 25 })));
    } else {
      // Zelfde titel in meerdere talen/versies: alleen de beste (Nederlandse) versie
      const nlSet = await nlCatSet(t), groups = new Map();
      for (const [i, s] of found) {
        const x = all[i], k = titleKey(x.n);
        const g = groups.get(k) || { v: [], s: 0 };
        g.v.push(x); g.s = Math.max(g.s, s); groups.set(k, g);
      }
      looseMerge(groups, (into, from) => { into.v.push(...from.v); into.s = Math.max(into.s, from.s); });
      hits = [...groups.values()].map(g => { const x = bestVersion(g.v, nlSet); return { ...x, nl: nlSet.has(x.c) ? 1 : 0, base: g.s }; });
    }
    for (const x of hits) { x.score = x.base + x.nl * 12; x.v = t === 'live' ? viewTrend(`live:${x.id}`) : popScore(t, x); delete x.base; }
    const byMatch = (a, b) => b.score - a.score || a.n.length - b.n.length;
    const cmp = {
      match: byMatch,
      new: (a, b) => (b.a || 0) - (a.a || 0) || byMatch(a, b),
      popular: (a, b) => b.nl - a.nl || b.v - a.v || byMatch(a, b),
    }[sort] || byMatch;
    out[t] = hits.sort(cmp).slice(0, 80);
  }
  return out;
}

// ---------- Terugkijken ----------
async function archiveChannels() {
  const [all, cats] = await Promise.all([list('live'), categories('live')]);
  return memo(all, 'archive', () => {
    const nl = new Set(cats.filter(c => c.code === 'NL').map(c => c.id));
    const groups = new Map();
    for (const x of all) {
      if (!x.ar || !nl.has(x.c)) continue;
      const key = chanKey(x.raw);
      const g = groups.get(key);
      if (!g || x.ar > g.days) groups.set(key, { id: x.id, n: channelName(x.raw), i: x.i || g?.i || '', days: x.ar, key });
    }
    return [...groups.values()].sort((a, b) => {
      const ia = MAIN_ORDER.indexOf(a.key), ib = MAIN_ORDER.indexOf(b.key);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.n.localeCompare(b.n, 'nl', { numeric: true });
    }).map(({ key, ...x }) => x);
  });
}
async function archiveDay(id, date) {
  if (!/^\d+$/.test(String(id)) || !/^\d{4}-\d\d-\d\d$/.test(String(date))) return [];
  const key = 'arch:' + id;
  const t = await cached(key, () => api({ action: 'get_simple_data_table', stream_id: id }));
  const hit = cache.get(key); if (hit) hit.t = Math.min(hit.t, Date.now() - TTL + 10 * 60 * 1000); // na 10 min verversen
  const now = Date.now() / 1000;
  return (t.epg_listings || [])
    .filter(e => Number(e.has_archive) === 1 && String(e.start).startsWith(date) && Number(e.start_timestamp) < now)
    .map(e => ({ t: decodeB64(e.title), d: decodeB64(e.description), at: String(e.start).slice(0, 16), s: Number(e.start_timestamp), e: Number(e.stop_timestamp) }));
}

// Afgeleide lijsten onthouden zolang de bronlijst dezelfde is
const memos = new WeakMap();
function memo(src, key, fn) {
  let m = memos.get(src);
  if (!m) memos.set(src, m = new Map());
  if (!m.has(key)) m.set(key, fn());
  return m.get(key);
}

function decodeB64(s) { try { return Buffer.from(s || '', 'base64').toString('utf8'); } catch { return ''; } }

// ---------- Twee (of meer) accounts: voelt als één, kiest per keer afspelen het account waar niemand op kijkt ----------
// cfg.accounts = alle accounts van dezelfde aanbieder, cfg.primary = waar hij bij voorkeur op zit.
// Lijsten (zenders/films/series) komen van het primaire account, of van het eerste dat nog geldig is.
// Mijn lijst en verder kijken horen bij je profiel, niet bij een account: dat geldt dus voor allebei.
const accList = () => !cfg ? [] : (Array.isArray(cfg.accounts) && cfg.accounts.length ? cfg.accounts : [{ server: cfg.server, username: cfg.username, password: cfg.password }]);
const accId = a => a ? a.username + '@' + String(a.server).replace(/\/+$/, '') : '';
const accBase = a => a.server.replace(/\/+$/, '');
const accCreds = a => `${encodeURIComponent(a.username)}/${encodeURIComponent(a.password)}`;
const hostOf = s => { try { return new URL(s).host; } catch { return String(s || ''); } };
const accErr = (status, msg) => Object.assign(new Error(msg), { status });
const accInfos = new Map();
const accBusy = new Map(); // account → tot wanneer overslaan (de aanbieder zei net "vol" of gaf geen beeld)
function accInfo(a, maxAge = 30000) {
  const k = accId(a), hit = accInfos.get(k);
  // Verlopen of onbereikbaar account: maar eens per 5 minuten opnieuw vragen (anders blokkeert de aanbieder je adres)
  if (hit && maxAge > 0 && (!hit.last || !accValid(hit.last)) && hit.done) maxAge = Math.max(maxAge, 300000);
  if (hit && Date.now() - hit.t < maxAge) return hit.p;
  const e = { t: Date.now(), last: hit?.last || null };
  e.p = apiGate('now').then(() => fetch(apiURL({}, a), { signal: AbortSignal.timeout(5000) })).then(r => { noteHealth(true); return r.json(); }, err => { noteHealth(false); throw err; }).then(j => { const u = j?.user_info || null; if (u) e.last = u; return u; }).catch(() => e.last).finally(() => { e.done = true; });
  accInfos.set(k, e);
  return e.p;
}
const accValid = u => !!u && Number(u.auth) === 1 && !/expired|banned|disabled/i.test(u.status || '') && !(Number(u.exp_date) > 0 && Number(u.exp_date) * 1000 < Date.now());
const primaryIdx = () => Math.min(Math.max(0, Number(cfg?.primary) || 0), Math.max(0, accList().length - 1));
function accOrder() { const l = accList(), p = primaryIdx(); return l.length ? [l[p], ...l.filter((_, i) => i !== p)] : []; }
var catalogPick = null;
function catalogAcc() { return (catalogPick && accList().some(a => accId(a) === accId(catalogPick)) ? catalogPick : accOrder()[0]) || cfg; }
async function refreshCatalog() {
  const order = accOrder();
  if (order.length < 2) { catalogPick = null; return; }
  // Eén voor één: het tweede account wordt alleen gevraagd als het primaire niet werkt
  for (const a of order) if (accValid(await accInfo(a, 30 * 60e3))) { catalogPick = a; return; }
  catalogPick = order[0];
}
// Welk account nu? Primair als daar niemand op kijkt; kijkt daar iemand, dan het account waar niemand op kijkt;
// anders het account met de meeste plek. Verlopen accounts en accounts die net "vol" zeiden worden overgeslagen.
// BELANGRIJK (gemeten 2026-11-26): deze aanbieder blokkeert je hele internetadres een paar uur als er kort na elkaar
// veel geweigerde verzoeken binnenkomen (meer schermen dan het account mag = "509", of een verlopen account).
// En hij telt een nieuwe verbinding pas na een paar seconden mee. Daarom houdt de app zelf bij hoeveel verbindingen
// hij per account open heeft (en nog even daarna, zolang de aanbieder ze vasthoudt) en opent hij er nooit meer dan mag.
const accOpen = new Map(); // account → aantal eigen verbindingen (open, of net dicht maar nog vastgehouden)
function holdConn(a, holdMs = 4000) {
  if (!a) return () => {};
  const k = accId(a); accOpen.set(k, (accOpen.get(k) || 0) + 1);
  let done = false;
  return () => { if (done) return; done = true; setTimeout(() => { accOpen.set(k, Math.max(0, (accOpen.get(k) || 1) - 1)); fullUntil = 0; }, holdMs); };
}
const ownOpen = a => accOpen.get(accId(a)) || 0;
// ---- Is de aanbieder bereikbaar? (voor de meter in Instellingen) ----
// Alleen afgeleid van wat de app toch al vraagt. Geen antwoord/verbinding geweigerd = waarschijnlijk geblokkeerd.
const health = { okAt: 0, failAt: 0, since: 0 };
function noteHealth(ok) {
  const now = Date.now();
  if (ok) { health.okAt = now; health.since = 0; }
  else { health.failAt = now; if (!health.since) health.since = now; }
}
function healthView() {
  const blocked = health.since && health.failAt > health.okAt;
  return { state: blocked ? 'blocked' : health.okAt ? 'ok' : 'unknown', since: blocked ? health.since : 0, okAt: health.okAt, checked: Math.max(health.okAt, health.failAt) };
}
// ---- Rem op ALLE vragen aan de aanbieder (lijsten, info, gids, schermen tellen) ----
// Gemeten 2026-11-26: na "Alles opnieuw laden" vuurde de app honderden vragen in een paar seconden af (gids per
// zender, info per film/serie, sportgids) en blokkeerde de aanbieder je adres. Nu: hooguit 1 vraag per seconde,
// en achtergrondwerk (gids op de kaarten, posters, jaartallen, sport) hooguit 20 per minuut. Wat jij aantikt
// (een film openen, de gids in de speler) gaat altijd voor.
// Drie rijen: "nu" (wat jij aantikt: film/serie openen, gids in de speler, schermen) gaat altijd eerst,
// dan gewone lijsten, dan achtergrondwerk.
const apiQ = { now: [], fg: [], bg: [], last: 0, bgTimes: [], timer: null };
const API_GAP = 700, BG_PER_MIN = 30;
function apiGate(bg) {
  return new Promise((res, rej) => {
    const q = bg === 'now' ? apiQ.now : bg ? apiQ.bg : apiQ.fg;
    q.push({ res, rej });
    // Te veel achtergrondwerk in de rij (snel scrollen)? De oudste vragen laten vallen: die kaarten zijn al uit beeld
    while (apiQ.bg.length > 40) apiQ.bg.shift().rej(new Error('te druk'));
    pumpApi();
  });
}
function pumpApi() {
  if (apiQ.timer) return;
  const now = Date.now();
  apiQ.bgTimes = apiQ.bgTimes.filter(t => now - t < 60000);
  const canBg = apiQ.bgTimes.length < BG_PER_MIN;
  if (!apiQ.now.length && !apiQ.fg.length && !(canBg && apiQ.bg.length)) {
    if (apiQ.bg.length) apiQ.timer = setTimeout(() => { apiQ.timer = null; pumpApi(); }, 60000 - (now - apiQ.bgTimes[0]) + 10);
    return;
  }
  const wait = Math.max(0, apiQ.last + API_GAP - now);
  apiQ.timer = setTimeout(() => {
    apiQ.timer = null; apiQ.last = Date.now();
    const next = apiQ.now.shift() || apiQ.fg.shift() || (apiQ.bgTimes.push(Date.now()), apiQ.bg.shift());
    next?.res();
    pumpApi();
  }, wait);
}
// Nieuwe verbindingen rustig openen: minstens 1,2 s ertussen en hooguit 20 per minuut (anders ziet het eruit als een aanval)
const gate = { last: 0, times: [] };
async function connGate() {
  const now = Date.now();
  gate.times = gate.times.filter(t => now - t < 60000);
  if (gate.times.length >= 20) throw accErr(503, 'Even rustig aan');
  const wait = Math.max(0, gate.last + 1200 - now);
  gate.last = now + wait; gate.times.push(now + wait);
  if (wait) await new Promise(r => setTimeout(r, wait));
  await apiGate(false); // ook meetellen in de algemene rem
}
// Welk account nu? Primair als daar niemand op kijkt; kijkt daar iemand, dan het account waar niemand op kijkt;
// anders het account met de meeste plek. Verlopen accounts en accounts die net "vol" zeiden worden overgeslagen.
// full = alles bezet: dan NIET bij de aanbieder proberen (dat levert alleen een "509" op en telt mee voor een blokkade).
// Eén voor één, primair eerst. Een volgend account wordt pas aangesproken als het vorige vol is of niet werkt
// (de aanbieder lijkt het niet te waarderen als twee accounts steeds vanaf één adres worden gecontroleerd).
// Eerst de eigen telling: zit dit apparaat zelf al op het account, dan hoeft de aanbieder niet gevraagd te worden.
const knownMax = a => Number(accInfos.get(accId(a))?.last?.max_connections) || 1;
// Alles vol gezien? Dan 90 s lang meteen "vol" zeggen zonder de aanbieder te vragen (op "vol" blijven drukken of
// automatisch opnieuw proberen = geen verkeer). Stopt dit apparaat zelf met kijken, dan meteen opnieuw kijken.
var fullUntil = 0;
async function pickAccount(avoid) {
  const order = accOrder();
  if (Date.now() < fullUntil && !avoid) return { a: order[0], full: true };
  let first = null;
  for (const a of order) {
    if (accId(a) === accId(avoid) || (accBusy.get(accId(a)) || 0) > Date.now()) continue;
    first ||= a;
    if (ownOpen(a) >= knownMax(a)) continue; // zelf vol: niet vragen
    const u = await accInfo(a);
    if (order.length > 1 && !accValid(u)) continue;
    const max = Number(u?.max_connections) || 1, used = Math.max(Number(u?.active_cons) || 0, ownOpen(a));
    if (used < max) return { a, full: false };
  }
  if (!avoid) fullUntil = Date.now() + 90000;
  return { a: first || order[0], full: true };
}
const markBusy = (a, ms = 60000) => { if (a) accBusy.set(accId(a), Date.now() + ms); };
// Adres bij de aanbieder voor "live/123.ts", "movie/55.mkv", "timeshift/90/2026-11-25:20-00/123.m3u8".
// sticky: zo lang (ms, verlengd bij elk gebruik) blijft hetzelfde ding op hetzelfde account. Een film moet op één
// account blijven (elk nieuw account = een extra scherm bij de aanbieder).
const accSticky = new Map();
async function streamURL(p, { sticky = 0, avoid = null } = {}) {
  const i = p.indexOf('/'), kind = p.slice(0, i), rest = p.slice(i + 1);
  let s = accSticky.get(p), fresh = false;
  if (!s || !sticky || Date.now() - s.t > sticky || avoid) {
    s = { t: Date.now(), p: pickAccount(avoid) };
    accSticky.set(p, s); fresh = true;
    if (accSticky.size > 300) for (const [k, v] of accSticky) if (Date.now() - v.t > 3600e3) accSticky.delete(k);
  }
  s.t = Date.now();
  const r = await s.p, a = r.a;
  // Niets vrij: deze keuze niet onthouden, de volgende keer opnieuw kijken. (Iets dat al op een account loopt, zoals
  // de volgende stukjes van een film, is nooit "vol": dat is je eigen scherm.)
  if (r.full && fresh && accSticky.get(p) === s) accSticky.delete(p);
  return { url: `${accBase(a)}/${kind}/${accCreds(a)}/${rest}`, acc: a, full: r.full && fresh, fresh };
}
// Live nooit "vastplakken" aan een account: een net gesloten zender houdt de aanbieder nog ~3 s vast, dus elke keer
// opnieuw kiezen (met de eigen telling erbij). Films wel: die moeten op één account blijven.
const STICKY_VOD = 3 * 3600e3, STICKY_LIVE = 0;
async function accountsView() {
  // Meteen antwoorden met wat al bekend is (instellingen openen moet direct gaan, en mag de aanbieder niet belasten).
  // Alleen het primaire account wordt (op de achtergrond, hooguit eens per minuut) bijgewerkt; het tweede account
  // alleen als het toch al gebruikt werd.
  const l = accList(), p = primaryIdx();
  const known = a => accInfos.get(accId(a))?.last || null;
  if (l[p] && !known(l[p])) await accInfo(l[p], 60000).catch(() => null); else if (l[p]) accInfo(l[p], 60000).catch(() => {});
  const infos = l.map(known);
  return l.map((a, i) => {
    const u = infos[i] || {};
    return { i, name: a.name || '', username: a.username, host: hostOf(a.server), primary: i === p, valid: accValid(infos[i]), status: infos[i] ? (u.status || '') : 'Niet bereikbaar',
      exp: Number(u.exp_date) || 0, active: Number(u.active_cons) || 0, max: Number(u.max_connections) || 0 };
  });
}
async function connTotals() {
  const order = accOrder(); if (!order.length) return { active: -1, max: 0 };
  const u = await accInfo(order[0], 60000); // hooguit eens per minuut vragen
  if (!u || !accValid(u)) return { active: -1, max: 0 };
  let active = Number(u.active_cons) || 0, max = Number(u.max_connections) || 1;
  for (const a of order.slice(1)) { const last = accInfos.get(accId(a))?.last; if (last && !accValid(last)) continue; active += ownOpen(a); max += knownMax(a); }
  return { active: Math.min(active, max), max, accounts: order.length };
}
async function addAccount(b) {
  const c = { server: String(b.server || '').trim() || catalogAcc().server, username: String(b.username || '').trim(), password: String(b.password || '').trim() };
  const name = String(b.name || '').trim().slice(0, 30);
  if (name) c.name = name;
  if (!/^https?:\/\//.test(c.server)) c.server = 'http://' + c.server;
  if (!c.username || !c.password) throw accErr(400, 'Vul een gebruikersnaam en wachtwoord in');
  if (accList().some(a => a.username === c.username && hostOf(a.server) === hostOf(c.server))) throw accErr(400, 'Dit account staat er al in');
  let info;
  // (Bij een verkeerde inlog geeft deze aanbieder soms gewoon geen antwoord)
  try { info = await (await fetch(apiURL({}, c), { signal: AbortSignal.timeout(15000) })).json(); } catch { throw accErr(502, 'Geen antwoord van de server. Klopt de gebruikersnaam en het wachtwoord?'); }
  if (Number(info?.user_info?.auth) !== 1) throw accErr(401, 'Gebruikersnaam of wachtwoord klopt niet');
  // Zelfde aanbieder? Dan zijn de zenders en films hetzelfde genummerd (anders kan wisselen niet)
  const cats = async a => { try { const j = await (await fetch(apiURL({ action: 'get_live_categories' }, a), { signal: AbortSignal.timeout(20000) })).json(); return new Set((Array.isArray(j) ? j : []).map(x => String(x.category_id))); } catch { return new Set(); } };
  const [x, y] = await Promise.all([cats(catalogAcc()), cats(c)]);
  if (x.size > 5 && y.size > 5) {
    let same = 0; for (const id of y) if (x.has(id)) same++;
    if (same / Math.min(x.size, y.size) < 0.6) throw accErr(400, 'Dit account is van een andere aanbieder. Twee accounts werken alleen samen als ze van dezelfde aanbieder zijn.');
  }
  cfg.accounts = [...accList(), c];
  accInfos.set(accId(c), { t: Date.now(), p: Promise.resolve(info.user_info), last: info.user_info });
  saveCfg(); refreshCatalog().catch(() => {});
  return { ok: true };
}
function setPrimary(i) {
  if (!(i >= 0 && i < accList().length)) throw accErr(400, 'Onbekend account');
  cfg.accounts = accList(); cfg.primary = i; accSticky.clear();
  saveCfg(); refreshCatalog().catch(() => {});
  return { ok: true };
}
// Eigen naam voor een account (bijv. "Account van Henri"), alleen voor jezelf in de app
function renameAccount(i, name) {
  const l = accList();
  if (!(i >= 0 && i < l.length)) throw accErr(400, 'Onbekend account');
  cfg.accounts = l.map((a, j) => j === i ? { ...a, name: String(name || '').trim().slice(0, 30) } : a);
  saveCfg();
  return { ok: true };
}
function removeAccount(i) {
  const l = accList();
  if (!(i >= 0 && i < l.length)) throw accErr(400, 'Onbekend account');
  if (l.length < 2) throw accErr(400, 'Je laatste account kun je niet weghalen (gebruik Uitloggen)');
  const p = primaryIdx();
  cfg.accounts = l.filter((_, j) => j !== i);
  cfg.primary = i === p ? 0 : p > i ? p - 1 : p;
  // Het account waarmee je ooit inlogde weg? Dan wordt het volgende de basis
  if (!cfg.accounts.some(a => a.username === cfg.username && hostOf(a.server) === hostOf(cfg.server))) Object.assign(cfg, { server: cfg.accounts[0].server, username: cfg.accounts[0].username, password: cfg.accounts[0].password });
  accSticky.clear(); saveCfg(); refreshCatalog().catch(() => {});
  return { ok: true };
}


// ===================== Alleen in de app =====================

// Base64 → tekst (EPG-titels)
function decodeB64(s) { try { return new TextDecoder().decode(Uint8Array.from(atob(s || ''), c => c.charCodeAt(0))); } catch { return ''; } }

// Netflix Top 10 Nederland: GitHub zet dit elke dag klaar in de repo (data/netflix-nl.json)
async function loadNetflixNL() {
  const saved = readJSON(NF_FILE, null);
  if (saved) useNetflix(saved);
  if ((saved && Date.now() - (saved.fetched || 0) < 12 * 3600e3) || !window.TV_REPO) return;
  try {
    const r = await realFetch(`https://raw.githubusercontent.com/${window.TV_REPO}/main/data/netflix-nl.json?t=${Date.now()}`);
    if (!r.ok) return;
    const d = await r.json();
    d.fetched = Date.now();
    writeJSON(NF_FILE, d); useNetflix(d);
  } catch {}
}

// Lijsten op de telefoon: per Nederlandse categorie ophalen (klein en snel), de complete
// film- en serielijst pas als je zoekt of "Alle films" opent (die is groot).
const ACTION = { live: 'get_live_streams', vod: 'get_vod_streams', series: 'get_series' };
function fetchList(type, cat) {
  return cached(`l6:${type}:${cat || 'all'}`, async () => {
    const raw = await api({ action: ACTION[type], category_id: cat || '' });
    return (Array.isArray(raw) ? raw : []).filter(x => !Number(x.is_adult)).map(x => slim(type, x));
  }, true, LIST_TTL);
}
const stable = new Map();
function concatStable(key, parts) {
  const c = stable.get(key);
  if (c && c.parts.length === parts.length && c.parts.every((p, i) => p === parts[i])) return c.arr;
  const arr = [].concat(...parts);
  stable.set(key, { parts, arr });
  return arr;
}
const fullReady = {}, fullLoading = {};
function loadFull(type) {
  return fullLoading[type] ||= fetchList(type).then(l => (fullReady[type] = l)).catch(e => { delete fullLoading[type]; throw e; });
}
async function nlItems(type) {
  const cats = await categories(type);
  const parts = await Promise.all(cats.filter(c => c.code === 'NL').map(c => fetchList(type, c.id)));
  return concatStable('nl:' + type, parts);
}
async function list(type, cat) {
  if (type === 'live') return fetchList('live', cat);
  if (cat) {
    const parts = await Promise.all(String(cat).split(',').map(id => fetchList(type, id)));
    return catList(type, concatStable(`c:${type}:${cat}`, parts), String(cat));
  }
  return fullReady[type] || nlItems(type);
}

// Alleen de gevraagde categorieën ophalen (bijv. de kinder-categorieën), niet alles
async function listCats(type, ids) {
  const parts = await Promise.all([...ids].map(id => fetchList(type, id).catch(() => [])));
  return concatStable(`cats:${type}:${[...ids].join(',')}`, parts);
}

// Profielen, lijstjes en verder kijken: op de telefoon zelf
const COLORS = ['#ff375f', '#0a84ff', '#30d158', '#ff9f0a', '#bf5af2', '#64d2ff', '#ffd60a', '#ac8e68'];
const profiles = () => readJSON('profiles', []);
const profData = id => readJSON('prof:' + id, { favs: [], history: [] });
const newId = () => [...crypto.getRandomValues(new Uint8Array(5))].map(b => b.toString(16).padStart(2, '0')).join('');

const searchCache = new Map();
// Alles alvast klaarzetten na het openen, zodat wisselen naar Films/Series/Zoeken meteen gaat
function warmUp() {
  if (!cfg) return;
  refreshCatalog().catch(() => {});
  loadNetflixNL();
  // Elke stap pas als je even niet tikt of scrolt: zo reageert de app altijd meteen op je vinger
  // (dit rekenwerk deelt de telefoon met het scherm). Trage telefoons wachten wat langer.
  const slow = (() => { try { return JSON.parse(localStorage.getItem('perf')) === 'slow'; } catch { return false; } })();
  const quiet = () => new Promise(res => {
    const check = () => performance.now() - (window.__lastInput || 0) > (slow ? 2000 : 1200) ? setTimeout(res, slow ? 150 : 50) : setTimeout(check, 400);
    check();
  });
  categories('live').then(() => list('live')).then(() => liveHome())
    .then(quiet).then(() => route('/api/rows?type=vod', {}))
    .then(quiet).then(() => route('/api/rows?type=series', {}))
    .then(async () => { for (const t of ['live', 'vod', 'series']) { await quiet(); searchIndex(t, await list(t)); } })
    .catch(() => {});
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function route(url, init) {
  const u = new URL(url, 'http://app');
  const p = u.pathname, q = Object.fromEntries(u.searchParams);
  const method = (init.method || 'GET').toUpperCase();
  const body = () => { try { return JSON.parse(init.body || '{}'); } catch { return {}; } };
  const hdr = init.headers || {};
  const profileId = hdr['X-Profile'] || hdr['x-profile'] || (hdr.get && hdr.get('X-Profile'));
  let m;

  if (p === '/api/session') {
    if (!cfg) return { loggedIn: false, app: true };
    if (!account) { try { account = await (await realFetch(apiURL({}), { signal: AbortSignal.timeout(15000) })).json(); } catch {} }
    return { loggedIn: true, app: true, server: cfg.server, username: catalogAcc().username, user: account?.user_info || null, ffmpeg: false, lan: null, accounts: accList().length };
  }
  // Meter in Instellingen: kan de app bij de aanbieder? Bij twijfel hooguit eens per minuut kort kloppen (zonder inlog)
  if (p === '/api/health') {
    if (cfg && healthView().state !== 'ok' && Date.now() - (route.probeAt || 0) > 60000) {
      route.probeAt = Date.now();
      let ok = false;
      try { await realFetch(accBase(catalogAcc()) + '/', { method: 'HEAD', signal: AbortSignal.timeout(5000) }); ok = true; } catch {}
      noteHealth(ok);
    }
    return healthView();
  }
  // Accounts (zelfde als op de pc): bekijken, toevoegen, primair maken, weghalen
  if (p === '/api/accounts' && cfg) {
    if (method === 'POST') { const r = await addAccount(body()); account = null; return r; }
    return accountsView();
  }
  if ((m = p.match(/^\/api\/accounts\/(\d+)(\/primary|\/name)?$/)) && cfg) {
    const i = Number(m[1]);
    if (m[2] === '/name' && method === 'POST') return renameAccount(i, body().name);
    if (m[2] === '/primary' && method === 'POST') { const r = setPrimary(i); account = null; return r; }
    if (!m[2] && method === 'DELETE') { const r = removeAccount(i); account = null; return r; }
  }
  if (p === '/api/login' && method === 'POST') {
    const b = body();
    const c = { server: String(b.server || '').trim(), username: String(b.username || '').trim(), password: String(b.password || '').trim() };
    if (!/^https?:\/\//.test(c.server)) c.server = 'http://' + c.server;
    let info;
    try { info = await (await realFetch(apiURL({}, c), { signal: AbortSignal.timeout(15000) })).json(); }
    catch (e) { throw new HttpError(502, 'Server niet bereikbaar (' + (e && e.message || e) + ')'); }
    if (Number(info?.user_info?.auth) !== 1) throw new HttpError(401, 'Gebruikersnaam of wachtwoord klopt niet');
    cfg = c; account = info; cache.clear(); accSticky.clear(); catalogPick = null; writeJSON('config', cfg);
    warmUp();
    return { ok: true };
  }
  if (p === '/api/logout' && method === 'POST') { cfg = null; account = null; cache.clear(); localStorage.removeItem('tv:config'); idb.clear(); return { ok: true }; }

  if (p === '/api/profiles') {
    if (method === 'POST') {
      const name = String(body().name || '').trim().slice(0, 20);
      if (!name) throw new HttpError(400, 'Vul een naam in');
      const all = profiles();
      const prof = { id: newId(), name, color: COLORS[all.length % COLORS.length] };
      writeJSON('profiles', [...all, prof]);
      return prof;
    }
    return profiles();
  }
  if ((m = p.match(/^\/api\/profiles\/(\w+)$/)) && method === 'DELETE') {
    writeJSON('profiles', profiles().filter(x => x.id !== m[1]));
    localStorage.removeItem('tv:prof:' + m[1]);
    return { ok: true };
  }
  if ((m = p.match(/^\/api\/me\/(favs|history)$/))) {
    if (!profileId || !profiles().some(x => x.id === profileId)) throw new HttpError(400, 'Geen profiel');
    const d = profData(profileId);
    if (method === 'PUT') { const b = body(); d[m[1]] = Array.isArray(b) ? b.slice(0, 500) : []; writeJSON('prof:' + profileId, d); return { ok: true }; }
    return d[m[1]] || [];
  }

  if (!cfg) throw new HttpError(401, 'Niet ingelogd');

  // "Alles opnieuw laden": alles vergeten en vers ophalen bij de aanbieder
  if (p === '/api/refresh' && method === 'POST') {
    // Alleen de lijsten en de gids opnieuw; info/posters blijven (alles opnieuw = honderden vragen = blokkade)
    const LIST = /(^||)(cat:|l6:|epg:)/;
    for (const k of [...cache.keys()]) if (LIST.test(k)) cache.delete(k);
    stable.clear(); searchCache.clear();
    for (const t of ['vod', 'series']) { delete fullReady[t]; delete fullLoading[t]; }
    await idb.clearWhere(k => LIST.test(k));
    await route('/api/home?type=live', {});
    warmUp();
    return { ok: true };
  }

  if (p === '/api/home' && q.type === 'live') return liveHome();
  if (p === '/api/country') return liveCountry(q.code);
  if (p === '/api/categories') return rowCategories(q.type);
  if (p === '/api/list') { const l = await list(q.type, q.cat); return q.type === 'live' ? l.map(({ raw, ...x }) => x) : l; }
  if (p === '/api/rows') {
    const type = q.type === 'series' ? 'series' : 'vod';
    const [cats, all] = await Promise.all([rowCategories(type), list(type)]);
    const nl = cats.filter(c => c.code === 'NL');
    const lists = await Promise.all(nl.map(c => catList(type, all, c.id)));
    return memo(all, `rows:${nf.v}:${viewsVersion}`, () =>
      nl.map((c, i) => ({ id: c.id, name: c.name, total: lists[i].length, items: lists[i].slice(0, 24) })).filter(r => r.total));
  }
  if (p === '/api/all') {
    const type = q.type === 'series' ? 'series' : 'vod';
    await loadFull(type);
    const pool = await allPool(type);
    const off = Math.max(0, Number(q.offset) || 0), lim = Math.min(300, Number(q.limit) || 120);
    return { total: pool.length, items: pool.slice(off, off + lim) };
  }
  if (p === '/api/seriesyears') return seriesYears(String(q.ids || '').split(',').filter(x => /^\d+$/.test(x)), artNames(q.names));
  if (p === '/api/art') return artFor(q.type === 'series' ? 'series' : 'vod', String(q.ids || '').split(',').filter(x => /^\d+$/.test(x)), artNames(q.names));
  if (p === '/api/latest') {
    const pool = await nlPool('vod');
    return memo(pool, 'latest', () => pool.filter(x => x.i && !KIDS_ROW.test(x.n.toUpperCase()) && !isKid('vod', x)).sort((a, b) => b.a - a.a).slice(0, 40));
  }
  if (p === '/api/search' || p === '/api/suggest') {
    // Zoeken in alle zenders en alle Nederlandse films/series (die staan al op de telefoon).
    // De complete buitenlandse lijst (129.000 films) halen we hier bewust níet op: te zwaar voor een telefoon.
    const sort = p === '/api/search' ? (q.sort || 'match') : 'match';
    const key = sort + '|' + fold(q.q || '').trim();
    if (!searchCache.has(key)) { searchCache.set(key, search(q.q, sort)); if (searchCache.size > 40) searchCache.delete(searchCache.keys().next().value); }
    const r = await searchCache.get(key);
    if (p === '/api/search') return r;
    const seen = new Set(), out = [];
    for (const x of [...r.live, ...r.vod, ...r.series].sort((a, b) => b.score - a.score || b.nl - a.nl)) {
      const k = fold(x.n); if (seen.has(k)) continue; seen.add(k); out.push(x.n); if (out.length >= 8) break;
    }
    return out;
  }
  // Andere versies van een film/serie (Nederlandse én internationale lijsten), voor als de gekozen versie kapot is
  if (p === '/api/alternatives') {
    const type = q.type === 'series' ? 'series' : 'vod';
    const key = titleKey(q.name || '');
    const cats = await categories(type);
    const parts = await Promise.all(cats.filter(c => c.code === 'NL' || c.code === 'ALL').map(c => fetchList(type, c.id).catch(() => [])));
    const nlSet = await nlCatSet(type);
    return [].concat(...parts)
      .filter(x => titleKey(x.n) === key && String(x.id) !== String(q.id))
      .sort((a, b) => versionScore(b, nlSet) - versionScore(a, nlSet))
      .slice(0, 6).map(x => ({ id: x.id, e: x.e, hq: x.hq }));
  }
  if (p === '/api/versions') {
    const type = q.type === 'series' ? 'series' : 'vod';
    const cats = await categories(type);
    const parts = await Promise.all(cats.filter(c => c.code === 'NL' || c.code === 'ALL').map(c => fetchList(type, c.id).catch(() => [])));
    return versionsOf(type, q.id, q.name, [].concat(...parts));
  }
  if (p === '/api/view' && method === 'POST') { const b = body(); if (/^(live|vod|series):\d+$/.test(b.k)) addView(b.k, b.item); return { ok: true }; }
  if (p === '/api/codec') return { codec: '' };
  if (p === '/api/top') return top10(['live', 'vod', 'series'].includes(q.type) ? q.type : 'live');
  if (p === '/api/archive/channels') return archiveChannels();
  if (p === '/api/archive/day') return archiveDay(q.id, q.date);
  if (p === '/api/vodinfo') return cached('vi:' + q.id, () => api({ action: 'get_vod_info', vod_id: q.id, _bg: 'now' }), true, 7 * 864e5);
  if (p === '/api/seriesinfo') return cached('si:' + q.id, () => api({ action: 'get_series_info', series_id: q.id, _bg: 'now' }), true, 864e5);
  if (p === '/api/sport') return sportToday();
  if (p === '/api/conns') return connTotals().catch(() => ({ active: -1, max: 0 }));
  if (p === '/api/subs') return subtitleList(q.type === 'series' ? 'series' : 'movie', q.name || '', q.year, q.tmdb, q.s, q.e).catch(() => []);
  if (p === '/api/epgnow') return epgNow(String(q.ids || '').split(',').filter(x => /^\d+$/.test(x)));
  if (p === '/api/extra') return titleExtra(q.type === 'series' ? 'series' : 'vod', q.name || '').catch(() => ({ imdb: 0, similar: [] }));
  if (p === '/api/epg') {
    const j = await cached('epg:' + q.id, () => api({ action: 'get_short_epg', stream_id: q.id, limit: 3, _bg: 'now' }), false, 5 * 60e3);
    return (j.epg_listings || []).map(e => ({ t: decodeB64(e.title), d: decodeB64(e.description), s: Number(e.start_timestamp), e: Number(e.stop_timestamp) }));
  }
  throw new HttpError(404, 'Onbekend: ' + p);
}

// De app vraagt /api/... zoals bij de pc; hier wordt dat in de app zelf beantwoord
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith('/api/')) return realFetch(input, init);
  try {
    const data = await route(url, init);
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: e.status || 502, headers: { 'Content-Type': 'application/json' } });
  }
};

// Voor de speler: rechtstreekse adressen bij de aanbieder.
// pick("live/123.ts") kiest het account (primair, of het andere als daar al iemand kijkt); failed(url) = dit account
// gaf geen beeld (vol): de volgende keer meteen het andere.
const urlAcc = new Map();
// Elke verbinding van de speler wordt bijgehouden (zoals op de pc): nooit meer schermen per account openen dan mag.
// Deze aanbieder blokkeert je internetadres als er veel "vol"-weigeringen binnenkomen.
const urlHold = new Map();
async function pickURL(p, vod, avoid) {
  const r = await streamURL(p, { sticky: vod ? STICKY_VOD : STICKY_LIVE, avoid });
  if (r.full) return null; // alles bezet: niet proberen
  if (r.fresh) await connGate().catch(() => {});
  urlAcc.set(r.url, r.acc);
  if (!urlHold.has(r.url)) urlHold.set(r.url, holdConn(r.acc, 0));
  return r.url;
}
function releaseURL(url, ms) { const h = urlHold.get(url); if (!h) return; urlHold.delete(url); setTimeout(h, ms == null ? 4000 : ms); }
window.TVBackend = {
  direct: () => cfg ? { base: accBase(catalogAcc()), creds: accCreds(catalogAcc()) } : null,
  pick: (p, vod) => pickURL(p, vod),
  // Speler gestopt: dit scherm komt vrij zodra de aanbieder het loslaat (live ~4 s, film ~5 min)
  release: (url, vod) => releaseURL(url, vod ? 5 * 60e3 : 4000),
  // Kreeg dit adres geen beeld? Als het account vol zat: één keer het andere account, alleen als dat vrij is
  failed: async (url, p, vod) => {
    const a = urlAcc.get(url); releaseURL(url, vod ? 5 * 60e3 : 4000);
    if (!a || accList().length < 2) return null;
    const u = await accInfo(a, 0);
    if (u && accValid(u) && (Number(u.active_cons) || 0) < (Number(u.max_connections) || 1)) return null;
    markBusy(a);
    const next = await pickURL(p, vod, a);
    return next && next !== url ? next : null;
  },
  // Viel een lopende stream weg? Deze aanbieder gooit de oudste kijker eruit als iemand anders (bijv. UHF) op
  // hetzelfde account gaat kijken. Dan niet terugpakken (dan gooien jullie elkaar om de beurt eruit = blokkade),
  // maar verder op het andere account. Geeft: nieuw adres, 'full' (alles bezet) of null (niet weggegooid).
  moved: async (url, p, vod) => {
    const a = urlAcc.get(url); releaseURL(url, 0);
    if (!a) return null;
    const u = await accInfo(a, 0);
    if (!(u && (Number(u.active_cons) || 0) >= (Number(u.max_connections) || 1))) return null;
    markBusy(a, 60000);
    return (await pickURL(p, vod, a)) || 'full';
  },
  accounts: () => accList().length,
};
warmUp();
})();
