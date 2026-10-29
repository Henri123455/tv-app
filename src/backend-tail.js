
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
