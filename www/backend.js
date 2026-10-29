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
const titleKey = n => fold(n).replace(/\[[^\]]*\]/g, '').replace(/\b(hq|qhd|4k|uhd|fhd|nl gesproken|dubbed|cam versie|hdcam|cam|telesync|hdts)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

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
  if ((m = u.match(/diatunnel\.link(?::\d+)?\/images\/([A-Za-z0-9]{20,40})(?:_\w+)?\.(jpe?g|png)/i))) return `https://image.tmdb.org/t/p/w600_and_h900_bestv2/${m[1]}.${m[2]}`;
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
  // Wat Nederland deze week kijkt telt het zwaarst, daarna wat er in deze app bekeken wordt
  return n * 100 + v * 60 + (x.r || 0) * 3 + Math.max(0, 90 - ageDays) / 90 * 25;
}

// ---------- Eén versie per titel, Nederlands gaat voor ----------
async function nlCatSet(type) {
  const cats = await categories(type);
  return memo(cats, 'nlset', () => new Set(cats.filter(c => c.code === 'NL').map(c => c.id)));
}
// Bioscoop-opnames (CAM) alleen als er geen normale versie is
const isCam = x => /\b(HD)?CAM\b|TELESYNC|\bHDTS\b/i.test(x.n || '');
function bestVersion(versions, nlSet) {
  const score = x => (isCam(x) ? -50 : 0) + (nlSet.has(x.c) ? 8 : 0) + (x.lg === 'NL' ? 4 : x.lg === 'ALL' || !x.lg ? 1 : 0) + (x.hq ? 1 : 0) + (x.i ? 1 : 0);
  return versions.reduce((a, b) => score(b) > score(a) ? b : a);
}
function dedupe(items, nlSet) {
  const g = new Map();
  for (const x of items) { const k = titleKey(x.n); if (!g.has(k)) g.set(k, []); g.get(k).push(x); }
  return [...g.values()].map(v => {
    const best = bestVersion(v, nlSet);
    if (v.length < 2) return best;
    // De andere versies onthouden: werkt de beste even niet (bijv. een kapotte HQ-server), dan neemt de app de volgende
    const rest = v.filter(x => x !== best).sort((a, b) => (isCam(a) - isCam(b)) || (nlSet.has(b.c) - nlSet.has(a.c)) || ((b.lg === 'NL') - (a.lg === 'NL')));
    return { ...best, alt: rest.slice(0, 4).map(x => ({ id: x.id, e: x.e })) };
  });
}
// Alle Nederlandse titels, één versie elk, populairste eerst
// Alle versies van één titel voor de knop "Bron": de beste (die de app al koos) eerst, dan Nederlands, CAM als laatste
async function versionsOf(type, id, name, items) {
  const key = titleKey(name || ''), nlSet = await nlCatSet(type);
  const cats = new Map((await categories(type)).map(c => [c.id, c]));
  const seen = new Set();
  const score = x => (String(x.id) === String(id) ? 1000 : 0) + (isCam(x) ? -50 : 0) + (nlSet.has(x.c) ? 8 : 0) + (x.lg === 'NL' ? 4 : 0) + (x.hq ? 1 : 0);
  return items.filter(x => titleKey(x.n) === key && !seen.has(String(x.id)) && seen.add(String(x.id)))
    .sort((a, b) => score(b) - score(a)).slice(0, 12)
    .map(x => ({ id: x.id, e: x.e, cat: cats.get(x.c)?.name || '', ...(x.hq ? { hq: 1 } : {}), ...(isCam(x) ? { cam: 1 } : {}), ...(nlSet.has(x.c) || x.lg === 'NL' ? { nl: 1 } : {}) }));
}

async function nlPool(type) {
  const [all, nlSet] = await Promise.all([list(type), nlCatSet(type)]);
  return memo(all, 'nlpool:' + nf.v + ':' + viewsVersion, () => dedupe(all.filter(x => nlSet.has(x.c)), nlSet).sort((a, b) => popScore(type, b) - popScore(type, a)));
}
async function nlKeys(type) {
  const pool = await nlPool(type);
  return memo(pool, 'keys', () => new Set(pool.map(x => titleKey(x.n))));
}
// Alles (ook buitenlands), maar wat in het Nederlands bestaat alleen in het Nederlands
async function allPool(type) {
  const [all, nlSet, pool] = await Promise.all([list(type), nlCatSet(type), nlPool(type)]);
  const keys = await nlKeys(type);
  return memo(pool, 'all', () => [...pool, ...dedupe(all.filter(x => !nlSet.has(x.c) && !keys.has(titleKey(x.n))), nlSet).sort((a, b) => popScore(type, b) - popScore(type, a))]);
}

// Eén rij (categorie of samengevoegde categorieën, bijv. "Bioscoop" + "Bioscoop HQ"), populairste links
async function catList(type, all, catIds) {
  const [nlSet] = await Promise.all([nlCatSet(type)]);
  const ids = new Set(catIds.split(','));
  const isNL = [...ids].some(id => nlSet.has(id));
  const keys = isNL ? null : await nlKeys(type);
  return memo(all, `cat:${catIds}:${nf.v}:${viewsVersion}`, () => {
    let items = dedupe(all.filter(x => ids.has(x.c)), nlSet);
    if (keys) items = items.filter(x => !keys.has(titleKey(x.n)));
    return items.sort((a, b) => popScore(type, b) - popScore(type, a));
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
async function artFor(type, ids) {
  const out = {};
  await Promise.all(ids.slice(0, 24).map(async id => {
    try {
      if (type === 'vod') {
        const j = await cached('vi:' + id, () => api({ action: 'get_vod_info', vod_id: id }), true);
        const i = Array.isArray(j.info) ? {} : j.info || {};
        out[id] = fixIcon(i.movie_image || i.cover_big || (i.backdrop_path || [])[0] || '');
      } else {
        const j = await cached('si:' + id, () => api({ action: 'get_series_info', series_id: id }), true);
        const i = Array.isArray(j.info) ? {} : j.info || {};
        out[id] = fixIcon(i.cover || (i.backdrop_path || [])[0] || '');
      }
    } catch { out[id] = ''; }
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
    return (await nlPool(type)).filter(x => x.i && !kids.has(x.c)).slice(0, 10);
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

// Profielen, lijstjes en verder kijken: op de telefoon zelf
const COLORS = ['#ff375f', '#0a84ff', '#30d158', '#ff9f0a', '#bf5af2', '#64d2ff', '#ffd60a', '#ac8e68'];
const profiles = () => readJSON('profiles', []);
const profData = id => readJSON('prof:' + id, { favs: [], history: [] });
const newId = () => [...crypto.getRandomValues(new Uint8Array(5))].map(b => b.toString(16).padStart(2, '0')).join('');

const searchCache = new Map();
// Alles alvast klaarzetten na het openen, zodat wisselen naar Films/Series/Zoeken meteen gaat
function warmUp() {
  if (!cfg) return;
  loadNetflixNL();
  categories('live').then(() => list('live')).then(() => liveHome())
    .then(() => route('/api/rows?type=vod', {})).then(() => route('/api/rows?type=series', {}))
    .then(() => { for (const t of ['live', 'vod', 'series']) list(t).then(l => searchIndex(t, l)); })
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
    return { loggedIn: true, app: true, server: cfg.server, username: cfg.username, user: account?.user_info || null, ffmpeg: false, lan: null };
  }
  if (p === '/api/login' && method === 'POST') {
    const b = body();
    const c = { server: String(b.server || '').trim(), username: String(b.username || '').trim(), password: String(b.password || '').trim() };
    if (!/^https?:\/\//.test(c.server)) c.server = 'http://' + c.server;
    let info;
    try { info = await (await realFetch(apiURL({}, c), { signal: AbortSignal.timeout(15000) })).json(); }
    catch (e) { throw new HttpError(502, 'Server niet bereikbaar (' + (e && e.message || e) + ')'); }
    if (Number(info?.user_info?.auth) !== 1) throw new HttpError(401, 'Gebruikersnaam of wachtwoord klopt niet');
    cfg = c; account = info; cache.clear(); writeJSON('config', cfg);
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
    cache.clear(); stable.clear(); searchCache.clear();
    for (const t of ['vod', 'series']) { delete fullReady[t]; delete fullLoading[t]; }
    await idb.clear();
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
  if (p === '/api/art') return artFor(q.type === 'series' ? 'series' : 'vod', String(q.ids || '').split(',').filter(x => /^\d+$/.test(x)));
  if (p === '/api/latest') {
    const pool = await nlPool('vod');
    return memo(pool, 'latest', () => pool.filter(x => x.i && !KIDS_ROW.test(x.n.toUpperCase())).sort((a, b) => b.a - a.a).slice(0, 40));
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
      .sort((a, b) => (isCam(a) - isCam(b)) || (nlSet.has(b.c) - nlSet.has(a.c)) || ((a.hq ? 1 : 0) - (b.hq ? 1 : 0)))
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
  if (p === '/api/vodinfo') return cached('vi:' + q.id, () => api({ action: 'get_vod_info', vod_id: q.id }), true, 7 * 864e5);
  if (p === '/api/seriesinfo') return cached('si:' + q.id, () => api({ action: 'get_series_info', series_id: q.id }), true, 864e5);
  if (p === '/api/epg') {
    const j = await cached('epg:' + q.id, () => api({ action: 'get_short_epg', stream_id: q.id, limit: 3 }), false, 5 * 60e3);
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

// Voor de speler: rechtstreekse adressen bij de aanbieder
window.TVBackend = { direct: () => cfg ? { base: base(), creds: creds() } : null };
warmUp();
})();
