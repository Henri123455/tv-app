'use strict';
// ================= Basis =================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const main = $('#main');
const video = $('#video');
const playerEl = $('#player');
const UA = navigator.userAgent;
const IS_IOS = /iPhone|iPad|iPod/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
const APPLE_NATIVE = (IS_IOS || (/Safari/.test(UA) && !/Chrome|Chromium|Edg|Android|Firefox/.test(UA))) && !!video.canPlayType('application/vnd.apple.mpegurl');

const S = { tab: 'live', session: null, favs: [], hist: [], pages: {}, lists: new Map(), cats: {}, profile: null, profiles: [] };
const items = new Map();

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// Valt de verbinding met de pc even weg (pc herstart, wifi hapert)? Dan stil opnieuw proberen
// in plaats van "Load failed" te tonen; na een paar pogingen een rustige melding bovenaan.
async function api(url, opts = {}) {
  const get = !opts.method || opts.method === 'GET';
  for (let attempt = 0; ; attempt++) {
    let r;
    try { r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...(S.profile ? { 'X-Profile': S.profile.id } : {}) } }); }
    catch (e) {
      if (!get || attempt >= 6) { offline(true); throw new Error('Geen verbinding met de pc'); }
      if (attempt >= 1) offline(true);
      await new Promise(res => setTimeout(res, Math.min(4000, 500 * 2 ** attempt)));
      continue;
    }
    offline(false);
    if (r.status === 401) { showLogin(); throw new Error('Niet ingelogd'); }
    if (r.status >= 500 && get && attempt < 3) { await new Promise(res => setTimeout(res, 800)); continue; }
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Fout ' + r.status);
    return j;
  }
}
let offlineShown = false;
function offline(on) {
  if (on === offlineShown) return;
  offlineShown = on;
  let bar = $('#offline');
  if (!bar) { bar = document.createElement('div'); bar.id = 'offline'; bar.className = 'offline'; bar.textContent = S.session?.app ? 'Geen verbinding, opnieuw proberen…' : 'Verbinding met je pc herstellen…'; document.body.appendChild(bar); }
  bar.classList.toggle('on', on);
}
const put = (url, body) => api(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2200);
}

// Speler-bibliotheken pas laden als ze nodig zijn (de app start daardoor sneller)
const loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
let enginesP = null;
const engines = () => enginesP ||= Promise.all([
  loadScript('https://cdn.jsdelivr.net/npm/hls.js@1.6.13/dist/hls.min.js'),
  loadScript('https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.min.js'),
]).catch(e => { enginesP = null; throw e; });

// ================= Namen netjes maken =================
const SMALLCAPS = { 'ᴀ': 'A', 'ʙ': 'B', 'ᴄ': 'C', 'ᴅ': 'D', 'ᴇ': 'E', 'ꜰ': 'F', 'ɢ': 'G', 'ʜ': 'H', 'ɪ': 'I', 'ᴊ': 'J', 'ᴋ': 'K', 'ʟ': 'L', 'ᴍ': 'M', 'ɴ': 'N', 'ᴏ': 'O', 'ᴘ': 'P', 'ʀ': 'R', 'ꜱ': 'S', 'ᴛ': 'T', 'ᴜ': 'U', 'ᴠ': 'V', 'ᴡ': 'W', 'ʏ': 'Y', 'ᴢ': 'Z' };
const SUP = /[ᴬ-ᵪᶛ-ᶿʰ-˿⁰-₟]/g;
const KEEP = new Set(['NL', 'BE', 'DE', 'UK', 'US', 'TV', 'NPO', 'RTL', 'SBS', 'ESPN', 'DAZN', 'HBO', 'UFC', 'MMA', 'PPV', 'F1', 'IMDB', 'BBC', 'ITV', 'VTMGO', 'NOS', 'TLC', 'MTV', 'TMF', 'AT5', 'BVN', 'XL', 'ZDF', 'ARD', 'WDR', 'NDR', 'SWR', 'BR', 'ORF', 'CNN', 'NBC', 'ABC', 'CW', 'FX', 'MAX', 'NLZIET', 'TV+', 'NPO+']);
// Versiering (✦●✦●, ★, emoji's) weg, titel blijven staan
const DECOR = /[←-⇿⌀-⏿─-➿⤀-⥿⬀-⯿〰〽️‍⃣]|\p{Extended_Pictographic}/gu;
const stripDecor = s => String(s || '').replace(/([A-Za-z])⚽️?(?=[A-Za-z])/g, '$1O').replace(DECOR, ' ').replace(/\s{2,}/g, ' ').trim();
const fixCaps = s => stripDecor(s).replace(/[ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘʀꜱᴛᴜᴠᴡʏᴢ]/g, c => SMALLCAPS[c]);
// 16K/8K/4K/UHD/VIP-versiering weglaten: dat is reclame, geen echte kwaliteit
function tidyCat(s) {
  s = fixCaps(fixCaps(String(s || '')).replace(SUP, '').normalize('NFKC'));
  s = s.replace(/\b(16K|8K|4K|UHD|FHD|VIP|HQ|RAW|QHD)\b|\(TEST\)/gi, '').replace(/\s+/g, ' ').trim();
  return s.split(/(\s+)/).map(w => {
    const u = w.toUpperCase();
    if (KEEP.has(u.replace(/[^A-Z0-9+]/g, ''))) return u;
    if (/^[A-ZÀ-Ý&'+.-]{3,}$/.test(w)) return w[0] + w.slice(1).toLowerCase();
    return w;
  }).join('').replace(/^[\s|&-]+|[\s|&-]+$/g, '') || 'Overig';
}
const tidyName = s => fixCaps(String(s || '')).replace(SUP, '').replace(/^\s*\[[^\]]{1,24}\]\s*/, '').replace(/^\s*(16K|8K|4K|UHD|FHD|HD|SD)\s*[|:-]\s*/i, '').replace(/\s+/g, ' ').trim();
const initials = n => esc(tidyName(n).replace(/[^\p{L}\p{N} ]/gu, '').split(' ').filter(Boolean).slice(0, 2).map(w => w.slice(0, w.length < 4 ? 4 : 1)).join(' ').slice(0, 8) || '•');
// Series: het jaartal van het laatste seizoen in plaats van het startjaar ("Manifest (2018 - 2023)" wordt "Manifest (2023)").
// Meteen: het nieuwste jaar uit de naam. Zodra een serie in beeld komt haalt de app (op de achtergrond) het jaar
// van de nieuwste aflevering op en past het aan; dat wordt onthouden.
const YEAR_RE = /\s*\(\s*(19|20)\d\d\s*(-\s*((19|20)\d\d)?\s*)?\)\s*$/;
const lastSeason = {};
try { Object.assign(lastSeason, JSON.parse(localStorage.getItem('lastSeason2')) || {}); } catch {}
const yearFromName = n => Math.max(0, ...[...String(n || '').matchAll(/\b(19\d\d|20\d\d)\b/g)].map(m => +m[1]).filter(y => y <= new Date().getFullYear() + 1));
const seriesName = x => { const n = tidyName(x.n).replace(YEAR_RE, ''); const y = lastSeason[x.id] || yearFromName(x.n) || +x.y || 0; return y ? `${n} (${y})` : n; };
function rememberYears(m) {
  for (const [id, y] of Object.entries(m)) if (y) lastSeason[id] = y;
  try { localStorage.setItem('lastSeason2', JSON.stringify(lastSeason)); } catch {}
}
const yearQueue = new Set();
let yearTimer, yearBusy = false;
const yearIO = new IntersectionObserver(es => es.forEach(e => {
  if (!e.isIntersecting) return;
  yearIO.unobserve(e.target);
  const id = e.target.dataset.sy;
  if (id && !lastSeason[id]) { yearQueue.add(id); clearTimeout(yearTimer); yearTimer = setTimeout(flushYears, 400); }
}), { rootMargin: '200px 300px' });
async function flushYears() {
  if (yearBusy || !yearQueue.size) return;
  yearBusy = true;
  const ids = [...yearQueue].slice(0, 8); ids.forEach(id => yearQueue.delete(id));
  const names = Object.fromEntries(ids.map(id => [id, $(`[data-sy="${CSS.escape(id)}"]`)?.textContent || '']));
  try {
    const m = await api(`/api/seriesyears?ids=${ids.join(',')}&names=${encodeURIComponent(JSON.stringify(names))}`);
    rememberYears(m);
    for (const [id, y] of Object.entries(m)) if (y) $$(`[data-sy="${CSS.escape(id)}"]`).forEach(el => { el.textContent = el.textContent.replace(YEAR_RE, '') + ` (${y})`; el.removeAttribute('data-sy'); });
  } catch {}
  yearBusy = false;
  if (yearQueue.size) setTimeout(flushYears, 600); // rustig aan: niet alles tegelijk (zwakke telefoon, aanbieder)
}
// Speelduur netjes: "1 u 54 min" (de aanbieder geeft soms "01:54:00", soms alleen minuten "114")
function durSecs(i) {
  let s = Number(i?.duration_secs) || 0;
  const d = String(i?.duration || '').trim();
  if (!s && /^\d+:\d+(:\d+)?$/.test(d)) s = d.split(':').reduce((a, v) => a * 60 + Number(v), 0) * (d.split(':').length === 2 ? 60 : 1);
  if (!s && /^\d+$/.test(d)) s = Number(d) * 60;
  return s;
}
function fmtDuration(i) {
  const s = durSecs(i);
  if (s < 60) return '';
  const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60);
  return h ? `${h} u ${m} min` : `${m} min`;
}
const fmtTime = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

const COUNTRIES = {
  BE: 'België', DE: 'Duitsland', UK: 'Verenigd Koninkrijk', GB: 'Verenigd Koninkrijk', EN: 'Engels', US: 'Verenigde Staten', FR: 'Frankrijk', TR: 'Turkije',
  AR: 'Arabisch', ES: 'Spanje', IT: 'Italië', PT: 'Portugal', PL: 'Polen', AL: 'Albanië', AT: 'Oostenrijk', CH: 'Zwitserland', SE: 'Zweden', NO: 'Noorwegen',
  DK: 'Denemarken', FI: 'Finland', RO: 'Roemenië', BG: 'Bulgarije', GR: 'Griekenland', CY: 'Cyprus', RU: 'Rusland', UA: 'Oekraïne', IN: 'India', PK: 'Pakistan',
  MA: 'Marokko', EX: 'Ex-Joegoslavië', EXYU: 'Ex-Joegoslavië', HU: 'Hongarije', CZ: 'Tsjechië', SK: 'Slowakije', IR: 'Iran', KU: 'Koerdisch', AF: 'Afrika',
  CA: 'Canada', LAT: 'Latijns-Amerika', BR: 'Brazilië', MX: 'Mexico', AU: 'Australië', SR: 'Suriname', CW: 'Curaçao', LU: 'Luxemburg', MK: 'Noord-Macedonië',
  ALL: 'Internationaal', MULTI: 'Multi', OVERIG: 'Overig',
};
const countryName = c => COUNTRIES[c] || c;

// ================= Profielen =================
const profileKey = k => `${k}:${S.profile?.id}`;
function avatarHTML(p, size = '') {
  return `<span class="avatar ${size}" style="--c:${esc(p.color)}">${esc((p.name || '?').trim()[0]?.toUpperCase() || '?')}</span>`;
}
async function showWho(manage = false) {
  hideAll(); hideSplash();
  $('#who').hidden = false;
  S.profiles = await api('/api/profiles').catch(() => []);
  $('#who h1').textContent = manage ? 'Profielen beheren' : 'Wie kijkt er?';
  $('#whoList').innerHTML = S.profiles.map(p => `<div class="who-item"><button class="who-btn" data-pid="${esc(p.id)}">${avatarHTML(p, 'xl')}${manage ? '<span class="who-del">−</span>' : ''}</button><span>${esc(p.name)}</span></div>`).join('') +
    `<div class="who-item"><button class="who-btn" id="whoAdd"><span class="avatar xl add">+</span></button><span>Nieuw profiel</span></div>`;
  $('#whoEdit').textContent = manage ? 'Klaar' : 'Profielen beheren';
  $('#whoEdit').hidden = !S.profiles.length;
  $('#whoEdit').onclick = () => showWho(!manage);
  $$('#whoList [data-pid]').forEach(b => b.onclick = async () => {
    const p = S.profiles.find(x => x.id === b.dataset.pid);
    if (manage) {
      if (!confirm(`Profiel "${p.name}" verwijderen? Zijn of haar lijst gaat dan weg.`)) return;
      await api('/api/profiles/' + p.id, { method: 'DELETE' }); return showWho(true);
    }
    choose(p);
  });
  $('#whoAdd').onclick = () => {
    $('#whoList').innerHTML = `<form class="who-new" id="whoForm"><span class="avatar xl add">+</span><input name="name" placeholder="Naam" maxlength="20" required autocomplete="off"><button class="btn primary wide">Profiel maken</button><button type="button" class="link" id="whoCancel">Annuleren</button></form>`;
    $('#whoForm input').focus();
    $('#whoCancel').onclick = () => showWho();
    $('#whoForm').onsubmit = async e => {
      e.preventDefault();
      const p = await api('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: e.target.name.value }) });
      choose(p);
    };
  };
}
async function choose(p) {
  S.profile = p; store.set('profile', p.id);
  S.hist = store.get(profileKey('history'), []);
  S.favs = store.get(profileKey('favs'), []);
  $('#who').hidden = true;
  for (const el of Object.values(S.pages)) el.remove();
  S.pages = {};
  startApp();
  const [f, h] = await Promise.all([api('/api/me/favs').catch(() => null), api('/api/me/history').catch(() => null)]);
  // Samenvoegen in plaats van overschrijven: per titel telt de nieuwste plek (pc of telefoon), zo gaat er nooit iets verloren
  const merged = h ? mergeHist(S.hist, h) : null;
  const changed = (f && JSON.stringify(f) !== JSON.stringify(S.favs)) || (merged && JSON.stringify(merged) !== JSON.stringify(S.hist));
  if (f) { S.favs = f; store.set(profileKey('favs'), f); }
  if (merged) { S.hist = merged; store.set(profileKey('history'), merged); if (JSON.stringify(merged) !== JSON.stringify(h)) put('/api/me/history', merged); }
  if (changed && S.pages[S.tab]) { S.pages[S.tab].remove(); delete S.pages[S.tab]; setTab(S.tab); }
}

// ================= Mijn lijst & verder kijken (per profiel, gedeeld tussen pc en telefoon) =================
const favKey = (type, id) => `${type}:${id}`;
const isFav = k => S.favs.some(f => f.k === k);
function toggleFav(k) {
  const it = items.get(k); if (!it) return;
  if (isFav(k)) { S.favs = S.favs.filter(f => f.k !== k); toast('Verwijderd uit Mijn lijst'); }
  else { S.favs.unshift({ k, type: it.type, id: it.id, n: it.n, i: it.i, c: it.c, e: it.e, b: it.b, p: it.p, alt: it.alt }); toast('Opgeslagen in Mijn lijst'); }
  $$(`[data-fav="${CSS.escape(k)}"]`).forEach(el => el.classList.toggle('on', isFav(k)));
  if (P.favKey === k) $('#pFav').classList.toggle('on', isFav(k));
  store.set(profileKey('favs'), S.favs);
  put('/api/me/favs', S.favs);
  if (S.tab === 'mine') renderMine();
}
const hist = () => S.hist;
let histTimer;
function mergeHist(a, b) {
  const m = new Map();
  for (const x of [...(a || []), ...(b || [])]) { const o = m.get(x.k); if (!o || (x.t || 0) > (o.t || 0)) m.set(x.k, x); }
  return [...m.values()].sort((x, y) => (y.t || 0) - (x.t || 0)).slice(0, 60);
}
function saveHist(entry) {
  S.hist = [{ ...entry, t: Date.now() }, ...S.hist.filter(x => x.k !== entry.k)].slice(0, 60);
  store.set(profileKey('history'), S.hist);
  clearTimeout(histTimer); histTimer = setTimeout(flushHist, 3000);
}
// Meteen opslaan (ook als het venster/de app wordt gesloten): keepalive laat het verzoek afmaken
function flushHist() {
  clearTimeout(histTimer);
  if (!S.profile) return;
  fetch('/api/me/history', { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Profile': S.profile.id }, body: JSON.stringify(S.hist) }).catch(() => {});
}
addEventListener('pagehide', () => { saveProgress(); flushHist(); });
// Terug in de app na een tijdje (of elk halfuur open): kijken of er nieuwe films/series zijn
let lastFresh = Date.now();
const freshen = () => { if (Date.now() - lastFresh < 20 * 60e3) return; lastFresh = Date.now(); for (const el of Object.values(S.pages)) el._refresh?.(); checkNews(); };
document.addEventListener('visibilitychange', () => { if (document.hidden) { saveProgress(); flushHist(); } else freshen(); });
setInterval(() => { if (!document.hidden && playerEl.hidden) freshen(); }, 5 * 60e3);

// ================= Lijsten laden =================
async function getCats(type) {
  if (!S.cats[type]) S.cats[type] = api('/api/categories?type=' + type).catch(e => { delete S.cats[type]; throw e; });
  return S.cats[type];
}
async function getList(type, cat) {
  const k = type + ':' + cat;
  if (!S.lists.has(k)) S.lists.set(k, api(`/api/list?type=${type}&cat=${encodeURIComponent(cat)}`).catch(e => { S.lists.delete(k); throw e; }));
  return S.lists.get(k);
}
// Eerst direct uit het geheugen van het apparaat tonen, daarna stil verversen
async function cachedApi(url, onFresh) {
  const key = 'c:' + url, old = store.get(key, null);
  const fresh = api(url).then(v => { store.set(key, v); if (old && onFresh && JSON.stringify(v) !== JSON.stringify(old)) onFresh(v); return v; });
  if (old) { fresh.catch(() => {}); return old; }
  return fresh;
}

// ================= Kaarten =================
const HEART = '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z" fill="currentColor"/></svg>';
const CHEVRON = '<svg viewBox="0 0 24 24" class="chev"><path d="M9 5l7 7-7 7"/></svg>';
// Nette plek voor titels zonder plaatje (kleur afgeleid van de titel) terwijl we er een zoeken
function placeholder(n) {
  let h = 0; for (const ch of String(n)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `<span class="ph" style="--h:${h % 360}"><span>${esc(tidyName(n).replace(/\s*\((19|20)\d\d\)\s*$/, ''))}</span></span>`;
}
// TMDB-posters in het formaat dat een kaart nodig heeft (342 px breed) i.p.v. 600-2000 px:
// veel minder data en geheugen, vooral merkbaar op een iPhone
const TMDB = /^https?:\/\/(?:www\.themoviedb\.org|image\.tmdb\.org)\/t\/p\/[^/]+\//;
const sized = (url, w = 'w342') => TMDB.test(url || '') ? url.replace(TMDB, `https://image.tmdb.org/t/p/${w}/`) : url;
function cardHTML(type, x, opt = {}) {
  const k = favKey(type, x.id);
  const img = x.i || artCache.get(k) || '';
  items.set(k, { ...x, i: img, type });
  const live = type === 'live';
  if (!img && !live) needArt(type, x.id);
  const prog = opt.progress ? `<div class="progress"><i style="width:${Math.min(100, opt.progress * 100).toFixed(1)}%"></i></div>` : '';
  return `<button class="card ${live ? 'live' : 'poster'}" data-k="${esc(k)}">
    <div class="art">${img ? `<img decoding="async" referrerpolicy="no-referrer" alt="${esc(x.n)}" data-src="${esc(live ? img : sized(img))}">` : live ? `<span class="initials">${initials(x.n)}</span>` : placeholder(x.n)}
      <span class="fav-badge ${isFav(k) ? 'on' : ''}" data-fav="${esc(k)}">${HEART}</span>${prog}</div>
    <div class="name"${type === 'series' && !lastSeason[x.id] ? ` data-sy="${esc(x.id)}"` : ''}>${esc(type === 'series' ? seriesName(x) : tidyName(x.n))}</div>${opt.sub ?`<div class="sub">${esc(opt.sub)}</div>` : ''}
  </button>`;
}
// Afbeeldingen zacht laten infaden; kapotte logo's vervangen door initialen
document.addEventListener('load', e => { if (e.target.tagName === 'IMG') e.target.classList.add('ld'); }, true);
// Eigen "lui laden" van plaatjes: pas laden als een kaart bijna in beeld komt. Werkt ook in de
// zijwaartse rijen op de iPhone (daar laat het ingebouwde loading="lazy" plaatjes soms helemaal weg).
const imgIO = new IntersectionObserver(es => es.forEach(e => {
  if (!e.isIntersecting) return;
  const im = e.target; imgIO.unobserve(im);
  if (im.dataset.src) { im.src = im.dataset.src; im.removeAttribute('data-src'); }
}), { rootMargin: matchMedia('(pointer: coarse)').matches ? '350px 450px' : '700px 900px' }); // telefoon: minder tegelijk = geen haperingen
new MutationObserver(ms => {
  for (const m of ms) for (const n of m.addedNodes) {
    if (n.nodeType !== 1) continue;
    if (n.matches('img[data-src]')) imgIO.observe(n);
    else n.querySelectorAll('img[data-src]').forEach(i => imgIO.observe(i));
    if (n.matches('[data-sy]')) yearIO.observe(n);
    else n.querySelectorAll('[data-sy]').forEach(el => yearIO.observe(el));
  }
}).observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('error', e => {
  const img = e.target;
  if (img.tagName !== 'IMG' || !img.closest('.art')) return;
  const card = img.closest('.card[data-k]');
  const [type, id] = (card?.dataset.k || '').split(':');
  badArt.add(img.getAttribute('src'));
  if (card && type !== 'live') { img.outerHTML = placeholder(img.alt); needArt(type, id); return; }
  const s = document.createElement('span'); s.className = 'initials'; s.innerHTML = initials(img.alt); img.replaceWith(s);
}, true);

// Ontbrekende of kapotte plaatjes: in groepjes opvragen bij de server (uit de detailinfo van de aanbieder)
const artCache = new Map(), artTried = new Set(), badArt = new Set(), artQueue = new Map();
let artTimer;
function needArt(type, id) {
  const k = favKey(type, id);
  // Al eens een goed plaatje gevonden (bijv. rij opnieuw getekend)? Meteen weer gebruiken
  if (artCache.get(k)) return void setTimeout(() => applyArt(type, id, artCache.get(k)), 0);
  if (artTried.has(k)) return;
  artTried.add(k);
  if (!artQueue.has(type)) artQueue.set(type, []);
  artQueue.get(type).push(id);
  clearTimeout(artTimer); artTimer = setTimeout(flushArt, 120);
}
function flushArt() {
  for (const [type, ids] of artQueue) {
    artQueue.delete(type);
    for (let i = 0; i < ids.length; i += 24) {
      const part = ids.slice(i, i + 24);
      const names = Object.fromEntries(part.map(id => [id, items.get(favKey(type, id))?.n || $(`.card[data-k="${CSS.escape(favKey(type, id))}"] .name`)?.textContent || '']));
      api(`/api/art?type=${type}&ids=${part.join(',')}&names=${encodeURIComponent(JSON.stringify(names))}`).then(m => {
        for (const [id, url] of Object.entries(m)) if (url && !badArt.has(url)) applyArt(type, id, url);
      }).catch(() => {});
    }
  }
}
function applyArt(type, id, url) {
  const k = favKey(type, id);
  artCache.set(k, url);
  const it = items.get(k); if (it) it.i = url;
  $$(`.card[data-k="${CSS.escape(k)}"] .ph`).forEach(ph => {
    const img = new Image(); img.referrerPolicy = 'no-referrer'; img.decoding = 'async'; img.alt = it?.n || '';
    img.onload = () => { img.classList.add('ld'); ph.replaceWith(img); };
    img.src = sized(url);
  });
}

// Detailinfo alvast ophalen zodra je over een titel gaat of erop tikt: openen voelt direct
const infoCache = new Map();
function getInfo(type, id) {
  const k = type + ':' + id;
  if (!infoCache.has(k)) infoCache.set(k, api(`/api/${type === 'vod' ? 'vodinfo' : 'seriesinfo'}?id=${id}`).catch(e => { infoCache.delete(k); throw e; }));
  return infoCache.get(k);
}
let hoverTimer;
const prefetchFrom = e => {
  const card = e.target.closest?.('.card[data-k]'); if (!card) return;
  const [type, id] = card.dataset.k.split(':');
  if (type === 'live') return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => getInfo(type, id).catch(() => {}), e.type === 'touchstart' ? 0 : 120);
};
document.addEventListener('pointerover', prefetchFrom, { passive: true });
document.addEventListener('touchstart', prefetchFrom, { passive: true });

// Telefoon-app: de app meet hoe snel dit toestel is (zie measurePerf) en laadt daarnaar:
// trage telefoon = kleinere happen en minder vooruit laden. De pc-app laadt altijd op volle snelheid.
const IS_APP = !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());
// Telefoon-app: niet kunnen in- of uitzoomen (ook niet met dubbeltikken)
if (IS_APP) {
  document.querySelector('meta[name=viewport]')?.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
  document.documentElement.style.touchAction = 'manipulation';
  document.documentElement.classList.add('is-app'); // o.a. geen aantallen achter de kopjes
  document.addEventListener('gesturestart', e => e.preventDefault(), { passive: false });
}
const PERF = IS_APP ? (store.get('perf') || 'normal') : 'fast';
const TUNE = { slow: { chunk: 8, rows: '700px 0px', search: [4, 6] }, normal: { chunk: 12, rows: '1200px 0px', search: [6, 9] }, fast: { chunk: 30, rows: '1600px 0px', search: [8, 12] } }[PERF];
const CHUNK = matchMedia('(hover: none) and (pointer: coarse)').matches ? Math.min(TUNE.chunk, 12) : TUNE.chunk;
function measurePerf() {
  if (!IS_APP) return;
  // Een paar seconden na het openen: hoe vloeiend lopen de beelden? (iPhone 11 en ouder komen meestal op "normal" of "slow")
  setTimeout(() => {
    let frames = 0, worst = 0, last = performance.now();
    const t0 = last;
    const tick = now => {
      worst = Math.max(worst, now - last); last = now; frames++;
      if (now - t0 < 1500) return requestAnimationFrame(tick);
      const fps = frames * 1000 / (now - t0);
      const p = fps < 40 || worst > 120 ? 'slow' : fps > 57 && worst < 40 ? 'fast' : 'normal';
      store.set('perf', p);
    };
    requestAnimationFrame(tick);
  }, 6000);
}
function fillShelf(shelf, type, list, opt = {}) { // list/opt worden bijgewerkt als de hele rij binnenkomt
  shelf.innerHTML = '';
  shelf._list = list; shelf._type = type;
  let n = 0;
  const more = () => {
    const html = list.slice(n, n + CHUNK).map((x, i) => cardHTML(type, x, opt.progressOf ? { progress: opt.progressOf(x) } : opt)).join('');
    n += CHUNK;
    shelf.querySelector('.sentinel')?.remove();
    shelf.insertAdjacentHTML('beforeend', html);
    // Voorproefje op? Dan pas de rest van de rij ophalen als je echt naar rechts scrolt
    if (n >= list.length && opt.loadAll && list.length < (opt.total || 0)) {
      const s = document.createElement('div'); s.className = 'sentinel';
      shelf.appendChild(s);
      const io = new IntersectionObserver(async es => {
        if (!es[0].isIntersecting) return;
        io.disconnect();
        try { list = await opt.loadAll(); shelf._list = list; opt = { ...opt, loadAll: null }; more(); } catch { s.remove(); }
      }, { root: shelf, rootMargin: '0px 1200px 0px 0px' });
      io.observe(s);
      return;
    }
    if (n < list.length) {
      const s = document.createElement('div'); s.className = 'sentinel';
      shelf.appendChild(s);
      const io = new IntersectionObserver(es => { if (es[0].isIntersecting) { io.disconnect(); more(); } }, { root: shelf, rootMargin: '0px 900px 0px 0px' });
      io.observe(s);
    }
  };
  more();
}

function rowEl(title, { count, onAll } = {}) {
  const el = document.createElement('section');
  el.className = 'row';
  el.innerHTML = `<div class="row-head">${onAll ? `<button class="row-title">` : '<div class="row-title">'}<h3>${esc(title)}</h3>${onAll ? CHEVRON : ''}${onAll ? '</button>' : '</div>'}${count ? `<span class="count">${count}</span>` : ''}</div>
    <div class="row-wrap"><button class="row-arrow l" aria-label="Terug"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button><div class="shelf" data-ctx></div><button class="row-arrow r" aria-label="Verder"><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button></div>`;
  const shelf = $('.shelf', el);
  $('.row-arrow.l', el).onclick = () => shelf.scrollBy({ left: -shelf.clientWidth * .85, behavior: 'smooth' });
  $('.row-arrow.r', el).onclick = () => shelf.scrollBy({ left: shelf.clientWidth * .85, behavior: 'smooth' });
  if (onAll) $('.row-title', el).onclick = onAll;
  return el;
}
const skeletons = (type, n = 8) => Array.from({ length: n }, () => `<div class="card skeleton ${type === 'live' ? 'live' : 'poster'}"><div class="art"></div><div class="name">&nbsp;</div></div>`).join('');
function itemsRow(type, title, list, opt = {}) {
  const el = rowEl(title, { count: opt.count ? list.length : null, onAll: list.length > 6 ? () => openGridItems(title, type, list) : null });
  fillShelf($('.shelf', el), type, list, opt);
  return el;
}

// Rijen pas laden als ze bijna in beeld zijn
const rowIO = new IntersectionObserver(es => es.forEach(e => {
  if (e.isIntersecting) { rowIO.unobserve(e.target); e.target._load?.(); }
}), { rootMargin: TUNE.rows });

function lazyCategoryRow(type, cat) {
  const title = tidyCat(cat.name);
  const el = rowEl(title, { onAll: () => openGrid(type, cat) });
  const shelf = $('.shelf', el);
  shelf.innerHTML = skeletons(type);
  let tries = 0;
  // Lukt het even niet? Stil opnieuw proberen; je ziet gewoon de laadkaarten tot het er is
  el._load = async () => {
    try {
      const list = await getList(type, cat.id);
      if (!list.length) { el.remove(); return; }
      fillShelf(shelf, type, list);
    } catch { setTimeout(() => el._load(), Math.min(15000, 1000 * 2 ** tries++)); }
  };
  rowIO.observe(el);
  return el;
}

// ================= Achtergronden: alleen echte liggende foto's =================
// Een staande poster of een kapotte link als achtergrond ziet er fout uit; dan liever niks.
const bgCheck = new Map();
function isLandscape(url, minW = 500) {
  if (!url) return Promise.resolve(false);
  const key = url + '|' + minW;
  if (!bgCheck.has(key)) bgCheck.set(key, new Promise(res => {
    const im = new Image(); im.referrerPolicy = 'no-referrer';
    const t = setTimeout(() => res(false), 6000);
    // TMDB: met een klein versie controleren (zelfde verhouding, fractie van de data)
    const small = TMDB.test(url);
    im.onload = () => { clearTimeout(t); res((small || im.naturalWidth >= minW) && im.naturalWidth / im.naturalHeight >= 1.3); };
    im.onerror = () => { clearTimeout(t); res(false); };
    im.src = small ? sized(url, 'w300') : url;
  }));
  return bgCheck.get(key);
}
// Grote achtergrond in een formaat dat bij het scherm past
const bgSized = url => sized(url, innerWidth <= 800 ? 'w780' : 'w1280');
async function firstLandscape(urls, minW) {
  for (const u of urls.filter(Boolean)) if (await isLandscape(u, minW)) return u;
  return null;
}
// Hoort de info van de aanbieder echt bij deze titel? Soms koppelen ze een andere film
// (bijv. "Junk (2026)" met de foto en tekst van "Junk (2024)"). Dan tonen we die info niet.
function metaMatches(itemName, info) {
  const yearOf = s => +(String(s || '').match(/\((\d{4})\)/) || [])[1] || 0;
  const want = yearOf(itemName);
  const got = +String(info.releasedate || info.releaseDate || info.release_date || '').slice(0, 4) || yearOf(info.name);
  if (want && got && Math.abs(want - got) > 1) return false;
  const words = s => new Set(tidyName(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\(\d{4}\)/g, '').split(/[^a-z0-9]+/).filter(w => w.length > 1));
  const a = words(itemName), b = words(info.name || info.title || '');
  if (!a.size || !b.size) return true;
  const shared = [...a].filter(w => b.has(w)).length;
  return shared / Math.min(a.size, b.size) >= .5;
}
// Liefst een liggende achtergrondfoto; anders het originele plaatje (poster) netjes in beeld,
// met een vervaagde versie ervan als achtergrond. Nooit een leeg zwart vlak als er een plaatje is.
async function heroArt(el, urls, poster, minW) {
  const u = await firstLandscape([].concat(urls || []), minW);
  if (!el.isConnected) return;
  if (u) { el.style.backgroundImage = `url("${bgSized(u)}")`; el.classList.add('has-bg'); return; }
  if (!poster) return;
  el.classList.add('has-bg', 'poster');
  el.insertAdjacentHTML('afterbegin', `<div class="poster-fill" style="background-image:url('${esc(sized(poster, 'w154'))}')"></div><img class="poster-img" src="${esc(sized(poster, 'w500'))}" alt="" referrerpolicy="no-referrer">`);
  $('.poster-img', el).onerror = () => { el.classList.remove('poster', 'has-bg'); $('.poster-fill', el)?.remove(); $('.poster-img', el)?.remove(); };
}
const STAR = '<svg class="star" viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" fill="currentColor" stroke="none"/></svg>';
const metaHTML = list => list.filter(Boolean).map(x => typeof x === 'object' ? `<span class="rating">${STAR}${esc(x.star)}</span>` : `<span>${esc(x)}</span>`).join('<span class="dot">·</span>');

// ================= Hero-carrousel (zoals de Apple TV-app) =================
function heroCarousel(hero, slides) {
  if (!slides.length) { hero.classList.add('flat'); return; }
  const ambient = $('.ambient', hero.parentElement);
  const glow = s => { const u = s.bg || s.poster; if (ambient) ambient.style.backgroundImage = u ? `url("${u}")` : 'none'; };
  hero.innerHTML = slides.map((s, i) => `<div class="hero-slide ${i ? '' : 'on'} ${s.poster ? 'poster' : ''}">
      ${s.poster
        ? `<div class="hero-bg poster-fill" style="background-image:url('${esc(sized(s.poster, 'w154'))}')"></div><img class="hero-poster" src="${esc(sized(s.poster, 'w500'))}" alt="" referrerpolicy="no-referrer" loading="lazy">`
        : `<div class="hero-bg ${s.logo ? 'logo' : ''}" style="background-image:url('${esc(s.logo ? s.bg : bgSized(s.bg))}')"></div>`}
      <div class="hero-text"><div class="hero-kicker">${s.kicker}</div><h1>${esc(s.title)}</h1><p>${esc(s.text || '')}</p><div class="hero-actions">${s.actions}</div></div>
    </div>`).join('') + (slides.length > 1 ? `<div class="hero-dots">${slides.map((_, i) => `<button class="${i ? '' : 'on'}" data-i="${i}" aria-label="Dia ${i + 1}"></button>`).join('')}</div>` : '');
  let cur = 0, timer;
  const els = $$('.hero-slide', hero), dots = $$('.hero-dots button', hero);
  const show = i => {
    cur = (i + slides.length) % slides.length;
    els.forEach((e, j) => e.classList.toggle('on', j === cur));
    dots.forEach((e, j) => e.classList.toggle('on', j === cur));
    glow(slides[cur]);
    slides[cur].onShow?.(els[cur]);
  };
  const auto = () => { clearInterval(timer); if (slides.length > 1) timer = setInterval(() => {
    // Niet wisselen tijdens het scrollen of als de banner uit beeld is: dat gaf haperingen op de iPhone
    if (document.hidden || !hero.isConnected || hero.closest('[hidden]') || performance.now() - lastScroll < 1500 || hero.getBoundingClientRect().bottom < 0) return;
    show(cur + 1);
  }, 7000); };
  dots.forEach(d => d.onclick = () => { show(+d.dataset.i); auto(); });
  let x0 = null;
  hero.addEventListener('pointerdown', e => { x0 = e.clientX; });
  hero.addEventListener('pointerup', e => { if (x0 != null && Math.abs(e.clientX - x0) > 50) { show(cur + (e.clientX < x0 ? 1 : -1)); auto(); } x0 = null; });
  hero.onmouseenter = () => clearInterval(timer);
  hero.onmouseleave = auto;
  glow(slides[0]);
  slides[0].onShow?.(els[0]);
  auto();
}
const nowPlaying = (id, el) => api('/api/epg?id=' + id).then(e => {
  const now = e.find(x => x.s * 1000 <= Date.now() && x.e * 1000 > Date.now()) || e[0];
  if (now) { $('.hero-kicker', el).innerHTML = '<span class="live-pill">LIVE</span> Nu op tv'; $('p', el).textContent = now.t + (now.d ? ' — ' + now.d : ''); }
}).catch(() => {});

// ================= Pagina's =================
const RENDER = { live: renderLive, vod: renderBrowse, series: renderBrowse, archive: renderArchive, mine: renderMine, search: renderSearch };
// Een pagina aanmaken en opbouwen (zichtbaar of alvast verborgen op de achtergrond)
function buildPage(tab, visible) {
  S.pages[tab]?.remove();
  const el = document.createElement('div'); el.className = 'page'; el.hidden = !visible; main.appendChild(el); S.pages[tab] = el;
  // Eerst het tabblad meteen laten zien (met laadplaatjes), dan pas opbouwen: één tik is genoeg
  if (tab === 'vod' || tab === 'series') el.innerHTML = `<header class="hero flat"></header><div class="row"><div class="row-wrap"><div class="shelf">${skeletons(tab, 6)}</div></div></div>`;
  const render = () => Promise.resolve(RENDER[tab](tab)).finally(() => visible && document.dispatchEvent(new Event('tv-ready')));
  if (visible && TOUCH && tab !== 'search') requestAnimationFrame(() => setTimeout(() => { if (el.isConnected) render(); }, 0)); else render();
  return el;
}
function setTab(tab) {
  S.tab = tab;
  $$('.nav-pill button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  closeGrid(true);
  for (const [k, el] of Object.entries(S.pages)) el.hidden = k !== tab;
  S.pages[tab]?._showPending?.();
  if (!S.pages[tab] || tab === 'mine') buildPage(tab, true);
  // Elk tabblad begint weer "schoon": bovenaan, en alle rijen weer aan het begin
  window.scrollTo(0, 0);
  for (const s of S.pages[tab].querySelectorAll('.shelf')) if (s.scrollLeft) s.scrollLeft = 0;
  store.set('tab', tab);
  prepareTabs();
}
// Films en Series alvast op de achtergrond klaarzetten (als je even niets doet), zodat wisselen meteen gaat.
// Trage telefoon: niet, om haperingen te voorkomen.
let prepTimer;
function prepareTabs() {
  if (PERF === 'slow') return;
  clearTimeout(prepTimer);
  prepTimer = setTimeout(function step() {
    if (performance.now() - (window.__lastInput || 0) < 2500 || !playerEl.hidden) { prepTimer = setTimeout(step, 2000); return; }
    const next = ['vod', 'series'].find(t => !S.pages[t]);
    if (!next) return;
    buildPage(next, false);
    prepTimer = setTimeout(step, IS_APP ? 6000 : 3000);
  }, IS_APP ? 8000 : 4000);
}

function topRows(type, box) {
  const h = hist().filter(x => x.type === type);
  // Telefoon-app: bij Live TV geen "Recent bekeken" (wel bij films en series: "Verder kijken")
  if (h.length && !(IS_APP && type === 'live')) box.appendChild(itemsRow(type, type === 'live' ? 'Recent bekeken' : 'Verder kijken', h, { progressOf: x => x.dur ? x.pos / x.dur : 0 }));
  const f = S.favs.filter(x => x.type === type);
  if (f.length) box.appendChild(itemsRow(type, 'Mijn lijst', f));
  box.appendChild(topTen(type));
}

// Top 10 meest bekeken op dit moment (zoals in de Apple TV-app, met grote cijfers)
function topTen(type) {
  const el = rowEl(type === 'live' ? 'Top 10 zenders nu' : type === 'vod' ? 'Top 10 films · meest bekeken' : 'Top 10 series · meest bekeken');
  el.classList.add('top10');
  const shelf = $('.shelf', el);
  shelf.innerHTML = skeletons(type, 6);
  cachedApi('/api/top?type=' + type, l => draw(l)).then(l => draw(l)).catch(() => el.remove());
  function draw(list) {
    if (!list.length) return el.remove();
    shelf._list = list; shelf._type = type;
    shelf.innerHTML = list.map((x, n) => `<div class="ranked ${type === 'live' ? 'live' : 'poster'}"><span class="rank-num">${n + 1}</span>${cardHTML(type, x)}</div>`).join('');
    // Zenders: onder de naam wat er nu op is (rustig na elkaar opgehaald). De regel staat er altijd
    // (eventueel leeg), zodat alle zenders even hoog blijven.
    if (type === 'live') {
      for (const card of $$('.card[data-k]', shelf)) card.insertAdjacentHTML('beforeend', '<div class="now-t">&nbsp;</div>');
      setTimeout(async () => {
        for (const card of $$('.card[data-k]', shelf)) {
          if (!card.isConnected) return;
          try {
            const e = await api('/api/epg?id=' + card.dataset.k.split(':')[1]);
            const now = e.find(x => x.s * 1000 <= Date.now() && x.e * 1000 > Date.now());
            if (now) $('.now-t', card).textContent = now.t;
          } catch {}
        }
      }, 1500);
    }
  }
  return el;
}

// Pagina kon niet laden (pc onbereikbaar): rustig wachten en vanzelf opnieuw opbouwen zodra het weer kan
function retryPage(page, tab) {
  page.innerHTML = S.session?.app
    ? `<div class="empty top-pad"><div class="p-spinner-static"></div><h3>Laden…</h3><p>De aanbieder reageert traag of je internet hapert. Het gaat vanzelf verder.</p></div>`
    : `<div class="empty top-pad"><div class="p-spinner-static"></div><h3>Verbinden met je pc…</h3><p>Staat de pc aan en zit je op dezelfde wifi? Het gaat vanzelf verder.</p></div>`;
  const tryAgain = async () => {
    try { await fetch('/api/session', { cache: 'no-store' }); } catch { return setTimeout(tryAgain, 3000); }
    if (!page.isConnected) return;
    delete S.cats[tab]; S.lists.clear();
    page.remove(); delete S.pages[tab];
    if (S.tab === tab) setTab(tab);
  };
  setTimeout(tryAgain, 2000);
}

// ---- Live TV: Nederland in kopjes, daarna andere landen ----
async function renderLive() {
  const page = S.pages.live;
  page.innerHTML = `<div class="ambient"></div><header class="hero"></header><div class="rows-top"></div><div class="rows-nl"></div><div class="rows-other"></div>`;
  let home;
  try { home = await cachedApi('/api/home?type=live'); } catch (e) { return retryPage(page, 'live'); }
  const popular = home.nl[0]?.items || [];
  const sport = home.nl.find(r => /ESPN/.test(r.title))?.items || [];
  const pick = [...popular.slice(0, 5), ...sport.filter(x => /^ESPN 1$|^Ziggo Sport$/i.test(tidyName(x.n)))];
  heroCarousel($('.hero', page), pick.map(it => {
    const k = favKey('live', it.id); items.set(k, { ...it, type: 'live' });
    return {
      bg: it.i, logo: true, kicker: 'Live', title: tidyName(it.n), text: '',
      actions: `<button class="btn primary" data-play="${esc(k)}">${PLAY_ICON}Kijk live</button><button class="btn glass round-btn ${isFav(k) ? 'on' : ''}" data-fav="${esc(k)}" title="Mijn lijst">${HEART}</button>`,
      onShow: el => nowPlaying(it.id, el),
    };
  }));
  topRows('live', $('.rows-top', page));

  const nlBox = $('.rows-nl', page);
  nlBox.innerHTML = `<h2 class="section-title"><span class="nl-flag"></span>Nederland<button class="sport-pill" id="sportBtn"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5l4 2.9-1.5 4.7h-5L8 10.4z"/></svg>Sport vandaag</button></h2>`;
  $('#sportBtn', nlBox).onclick = openSportToday;
  for (const r of home.nl) nlBox.appendChild(itemsRow('live', r.title, r.items, { count: true }));

  const other = $('.rows-other', page);
  if (!home.countries.length) return;
  other.innerHTML = `<h2 class="section-title">Andere landen</h2>
    <div class="chips-bar"><div class="chips">${home.countries.map(c => `<button class="chip" data-code="${esc(c.code)}">${esc(countryName(c.code))}</button>`).join('')}</div></div>
    <div class="country-rows"></div>`;
  const box = $('.country-rows', other);
  const pickCountry = async code => {
    store.set('country:live', code);
    $$('.chip', other).forEach(b => b.classList.toggle('active', b.dataset.code === code));
    box.innerHTML = `<section class="row"><div class="shelf">${skeletons('live')}</div></section>`;
    const rows = await cachedApi('/api/country?code=' + encodeURIComponent(code)).catch(() => []);
    if (store.get('country:live') !== code) return;
    box.innerHTML = '';
    rows.forEach(r => box.appendChild(itemsRow('live', tidyCat(r.title), r.items, { count: true })));
  };
  $$('.chip', other).forEach(b => b.onclick = () => pickCountry(b.dataset.code));
  const saved = store.get('country:live', null);
  const codes = home.countries.map(c => c.code);
  pickCountry(codes.includes(saved) ? saved : codes.includes('BE') ? 'BE' : codes[0]);
}

// ---- Films en series ----
async function renderBrowse(type) {
  const page = S.pages[type];
  page.innerHTML = `<div class="ambient"></div><header class="hero"></header><div class="rows-top"></div><div class="rows-nl"></div><div class="rows-other"></div>`;
  let cats;
  try { cats = await getCats(type); } catch (e) { return retryPage(page, type); }
  const nl = cats.filter(c => c.code === 'NL');
  const groups = new Map();
  cats.filter(c => c.code !== 'NL' && c.code !== 'OVERIG').concat(cats.filter(c => c.code === 'OVERIG'))
    .forEach(c => { if (!groups.has(c.code)) groups.set(c.code, []); groups.get(c.code).push(c); });

  renderBrowseHero(type, $('.hero', page), nl);
  const top = $('.rows-top', page);
  topRows(type, top);
  if (type === 'vod') {
    const el = rowEl('Nieuw toegevoegd'); $('.shelf', el).innerHTML = skeletons(type); top.appendChild(el);
    cachedApi('/api/latest', l => fillShelf($('.shelf', el), 'vod', l)).then(l => fillShelf($('.shelf', el), 'vod', l)).catch(() => el.remove());
  }
  const nlBox = $('.rows-nl', page);
  if (nl.length) {
    nlBox.innerHTML = `<h2 class="section-title"><span class="nl-flag"></span>Nederland</h2>`;
    // Alle rijen in één keer (meteen uit het geheugen van het apparaat, daarna stil ververst):
    // snel scrollen toont direct kaarten, de rest van een rij komt pas als je naar rechts scrolt
    const holder = document.createElement('div');
    nlBox.appendChild(holder);
    const drawRows = rows => {
      holder.innerHTML = '';
      for (const r of rows) {
        const cat = { id: r.id, name: r.name };
        const el = rowEl(tidyCat(r.name), { onAll: () => openGrid(type, cat) });
        fillShelf($('.shelf', el), type, r.items, { total: r.total, loadAll: () => getList(type, r.id) });
        holder.appendChild(el);
      }
    };
    // Nieuwe films/series: eerst meteen de bewaarde rijen, daarna stil de verse lijst; die wordt getoond
    // zodra dat niet stoort (je zit bovenaan of op een ander tabblad). Ook later opnieuw, als de app lang openstaat.
    const onFresh = rows => {
      if (S.tab === type && scrollY > 400) { page._pending = rows; return; }
      drawRows(rows);
    };
    page._refresh = () => cachedApi(`/api/rows?type=${type}`, onFresh).catch(() => {});
    page._showPending = () => { if (page._pending) { drawRows(page._pending); page._pending = null; } };
    try { drawRows(await cachedApi(`/api/rows?type=${type}`, onFresh)); }
    catch { nl.forEach(c => holder.appendChild(lazyCategoryRow(type, c))); }
    // Alles op één plek: elke film/serie die er is (Nederlands eerst, populairste eerst)
    const label = type === 'vod' ? 'films' : 'series';
    nlBox.insertAdjacentHTML('beforeend', `<div class="all-wrap"><button class="all-btn"><span><b>Alle ${label}</b><small>Nederlands eerst, populairste bovenaan</small></span>${CHEVRON}</button></div>`);
    $('.all-btn', nlBox).onclick = () => openGridPaged(`Alle ${label}`, type);
    // Het aantal titels is bijzaak: uit het geheugen, en pas na een paar seconden opnieuw tellen (veel rekenwerk op de telefoon)
    const showTotal = r => { $('.all-btn small', nlBox).textContent = `${r.total.toLocaleString('nl-NL')} titels · Nederlands eerst, populairste bovenaan`; };
    const savedTotal = store.get('c:/api/all?type=' + type, null);
    if (savedTotal) showTotal(savedTotal);
    setTimeout(() => api(`/api/all?type=${type}&limit=1`).then(r => { store.set('c:/api/all?type=' + type, { total: r.total }); showTotal(r); }).catch(() => {}), IS_APP ? 8000 : 0);
  }
  const other = $('.rows-other', page);
  if (!groups.size) return;
  other.innerHTML = `<h2 class="section-title">Andere landen</h2>
    <div class="chips-bar"><div class="chips">${[...groups.keys()].map(code => `<button class="chip" data-code="${esc(code)}">${esc(countryName(code))}</button>`).join('')}</div></div>
    <div class="country-rows"></div>`;
  const box = $('.country-rows', other);
  const pick = code => {
    store.set('country:' + type, code);
    $$('.chip', other).forEach(b => b.classList.toggle('active', b.dataset.code === code));
    box.innerHTML = '';
    (groups.get(code) || []).forEach(c => box.appendChild(lazyCategoryRow(type, c)));
  };
  $$('.chip', other).forEach(b => b.onclick = () => pick(b.dataset.code));
  const saved = store.get('country:' + type, null);
  pick(groups.has(saved) ? saved : groups.has('BE') ? 'BE' : groups.keys().next().value);
}

// Welke titels in de grote banner komen (liefst met een liggende foto, anders met hun eigen poster).
// Kost tien info-verzoeken en foto-controles, dus de uitkomst wordt een paar uur bewaard.
async function heroPicks(type, nl) {
  if (type === 'vod') {
    const l = await cachedApi('/api/latest');
    const pool = [...l.filter(x => x.r >= 6), ...l].filter((x, i, a) => a.indexOf(x) === i).slice(0, 10);
    const infos = await Promise.all(pool.map(x => api('/api/vodinfo?id=' + x.id).catch(() => ({}))));
    const bgs = await Promise.all(infos.map((f, n) => f.info && metaMatches(pool[n].n, f.info) ? firstLandscape(f.info.backdrop_path || [], 900) : null));
    const all = pool.map((it, n) => ({ it, text: (infos[n].info && metaMatches(it.n, infos[n].info) && (infos[n].info.plot || infos[n].info.description)) || '', bg: bgs[n] }));
    return [...all.filter(s => s.bg), ...all.filter(s => !s.bg && s.it.i)].slice(0, 5);
  }
  const l = (await getList('series', nl[0].id)).filter(x => x.b || x.i).slice(0, 10);
  const bgs = await Promise.all(l.map(x => firstLandscape([x.b], 900)));
  const all = l.map((it, n) => ({ it, text: it.p || '', bg: bgs[n] }));
  return [...all.filter(s => s.bg), ...all.filter(s => !s.bg && s.it.i)].slice(0, 5);
}
async function renderBrowseHero(type, hero, nl) {
  try {
    const key = 'hero:' + type, saved = store.get(key, null);
    let picks = saved?.picks;
    const stale = !saved || Date.now() - saved.t > 6 * 3600e3;
    if (!picks?.length) picks = await heroPicks(type, nl);
    if (stale) (picks === saved?.picks ? heroPicks(type, nl) : Promise.resolve(picks)).then(p => p.length && store.set(key, { t: Date.now(), picks: p })).catch(() => {});
    const slides = picks.map(({ it, text, bg }) => {
      const k = favKey(type, it.id); items.set(k, { ...it, type });
      return {
        bg, poster: bg ? null : it.i, kicker: type === 'vod' ? 'Nieuw · film' : 'Serie', title: tidyName(it.n), text,
        actions: `<button class="btn primary" data-open="${esc(k)}">${PLAY_ICON}Bekijk</button><button class="btn glass round-btn ${isFav(k) ? 'on' : ''}" data-fav="${esc(k)}" title="Mijn lijst">${HEART}</button>`,
      };
    });
    heroCarousel(hero, slides);
  } catch { hero.classList.add('flat'); }
}

// Mijn lijst: twee tabbladen, "Opgeslagen" (hartjes) en "Recent bekeken" (met hoe ver je was)
function renderMine() {
  const page = S.pages.mine;
  const view = store.get('mine-view', 'saved');
  page.innerHTML = `<div class="grid-page top-pad"><h2 class="page-title">Mijn lijst</h2>
    <div class="seg mine-seg"><button data-view="saved" class="${view === 'saved' ? 'active' : ''}">Opgeslagen</button><button data-view="recent" class="${view === 'recent' ? 'active' : ''}">Recent bekeken</button></div>
    <div class="mine-body"></div></div>`;
  $$('.mine-seg button', page).forEach(b => b.onclick = () => { store.set('mine-view', b.dataset.view); renderMine(); });
  const body = $('.mine-body', page);
  const list = view === 'saved' ? S.favs : hist();
  if (!list.length) {
    body.innerHTML = view === 'saved'
      ? `<div class="empty"><div class="empty-icon">${HEART}</div><h3>Nog niets opgeslagen</h3><p>Tik op het hartje bij een zender, film of serie (of houd een kaart ingedrukt).</p></div>`
      : `<div class="empty"><h3>Nog niets bekeken</h3><p>Wat je kijkt, verschijnt hier, met hoe ver je was.</p></div>`;
    return;
  }
  // Per soort alleen de eerste paar (net als bij Zoeken); de rest achter "Alles laten zien", zo blijft de lijst kort
  const opt = x => view === 'recent' && x.dur ? { progress: x.pos / x.dur, sub: x.ep ? `S${x.ep.season} A${x.ep.num}` : '' } : (x.ep ? { sub: `S${x.ep.season} A${x.ep.num}` } : {});
  for (const [t, label] of [['live', 'Zenders'], ['vod', 'Films'], ['series', 'Series']]) {
    const l = list.filter(f => f.type === t);
    if (!l.length) continue;
    const max = TUNE.search[t === 'live' ? 0 : 1] * (TOUCH ? 1 : 2);
    body.insertAdjacentHTML('beforeend', `<h3 class="section-sub">${label}</h3><div class="grid ${t === 'live' ? 'live' : 'posters'}" data-ctx>${l.slice(0, max).map(x => cardHTML(t, x, opt(x))).join('')}</div>` +
      (l.length > max ? `<button class="show-all" data-all="${t}"><span>Alles laten zien</span><small>${l.length} ${label.toLowerCase()}</small>${CHEVRON}</button>` : ''));
    const g = $$('.grid[data-ctx]', body).pop(); g._list = l; g._type = t;
    const all = $(`[data-all="${t}"]`, body);
    if (all) all.onclick = () => {
      g.innerHTML = l.map(x => cardHTML(t, x, opt(x))).join('');
      all.remove();
    };
  }
}

// ---- Terugkijken: kies een dag, per zender alles wat er die dag was ----
const pad2 = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const hhmm = s => new Date(s * 1000).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
async function renderArchive() {
  const page = S.pages.archive;
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - i);
    return { date: ymd(d), back: i, label: i === 0 ? 'Vandaag' : i === 1 ? 'Gisteren' : d.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' }) };
  });
  page.innerHTML = `<div class="top-pad"><h2 class="page-title">Terugkijken</h2><p class="page-lead">Kies een dag en kijk terug wat er op tv was.</p>
    <div class="chips-bar"><div class="chips">${days.map(d => `<button class="chip" data-date="${d.date}">${esc(d.label)}</button>`).join('')}</div></div>
    <div class="arch-rows"></div></div>`;
  const box = $('.arch-rows', page);
  let channels;
  try { channels = await cachedApi('/api/archive/channels'); } catch { box.innerHTML = '<div class="empty"><p>Kon de zenders niet laden.</p></div>'; return; }
  const pick = date => {
    const day = days.find(d => d.date === date) || days[0];
    store.set('arch-day', day.back);
    $$('.chip', page).forEach(b => b.classList.toggle('active', b.dataset.date === day.date));
    box.innerHTML = '';
    for (const ch of channels.filter(c => c.days > day.back)) {
      const el = rowEl(tidyName(ch.n));
      $('.row-title', el).insertAdjacentHTML('afterbegin', ch.i ? `<span class="ch-logo"><img src="${esc(ch.i)}" alt="" referrerpolicy="no-referrer" loading="lazy"></span>` : '');
      const shelf = $('.shelf', el);
      shelf.innerHTML = Array.from({ length: 6 }, () => '<div class="prog skeleton"></div>').join('');
      el._load = async () => {
        let progs = [];
        try { progs = await api(`/api/archive/day?id=${ch.id}&date=${day.date}`); } catch {}
        if (!progs.length) { shelf.innerHTML = '<div class="muted pad">Geen uitzendingen gevonden voor deze dag.</div>'; return; }
        shelf.innerHTML = progs.map((p, i) => {
          const live = p.e * 1000 > Date.now();
          return `<button class="prog ${live ? 'now' : ''}" data-i="${i}">
            ${ch.i ? `<img class="prog-logo" src="${esc(ch.i)}" alt="" referrerpolicy="no-referrer" loading="lazy">` : ''}
            <div class="prog-time">${hhmm(p.s)}<span> · ${Math.round((p.e - p.s) / 60)} min</span>${live ? '<span class="live-pill">NU</span>' : ''}</div>
            <div class="prog-title">${esc(p.t)}</div>${p.d ? `<div class="prog-desc">${esc(p.d)}</div>` : ''}</button>`;
        }).join('');
        shelf.onclick = e => { const b = e.target.closest('.prog[data-i]'); if (b) playArchive(ch, progs[+b.dataset.i], day.label); };
        // Naar de avond scrollen (of het nieuwste programma vandaag)
        const target = day.back === 0 ? progs.length - 1 : Math.max(0, progs.findIndex(p => new Date(p.s * 1000).getHours() >= 20));
        shelf.scrollLeft = Math.max(0, (shelf.children[target]?.offsetLeft || 0) - shelf.clientWidth / 3);
      };
      rowIO.observe(el);
      box.appendChild(el);
    }
  };
  $$('.chip', page).forEach(b => b.onclick = () => pick(b.dataset.date));
  pick((days[store.get('arch-day', 0)] || days[0]).date);
}
// ---- Sport vandaag: alle wedstrijden/races/gevechten van vandaag, op tijd; tik = die zender live ----
async function openSportToday() {
  showSheet(`<div class="sheet-hero chan-hero"><div><h2>Sport vandaag</h2><div class="meta">Live op de Nederlandse sportzenders</div></div></div><div class="sheet-body"><div class="sport-list"><p class="muted">Programmagids laden…</p></div></div>`);
  let list = [];
  try { list = await api('/api/sport'); } catch {}
  const box = $('#sheetCard .sport-list'); if (!box) return;
  if (!list.length) { box.innerHTML = '<p class="muted">Geen sport gevonden in de programmagids van vandaag.</p>'; return; }
  const now = Date.now() / 1000;
  const row = (x, i) => `<button class="sport-item ${x.s <= now ? 'now' : ''}" data-si="${i}">
      <span class="sport-time">${x.s <= now ? '<i class="live-pill">LIVE</i>' : hhmm(x.s)}<small>${hhmm(x.e)}</small></span>
      <span class="sport-main"><b>${esc(x.t)}</b><small>${esc(tidyName(x.ch.n))}</small></span>
      ${x.ch.i ? `<span class="sport-logo"><img src="${esc(x.ch.i)}" alt="" referrerpolicy="no-referrer" loading="lazy"></span>` : ''}</button>`;
  const live = list.filter(x => x.s <= now), later = list.filter(x => x.s > now);
  box.innerHTML = (live.length ? `<h3 class="arch-head">Nu bezig</h3>${live.map(x => row(x, list.indexOf(x))).join('')}` : '') +
    (later.length ? `<h3 class="arch-head">Straks</h3>${later.map(x => row(x, list.indexOf(x))).join('')}` : '');
  $$('.sport-item', box).forEach(b => b.onclick = () => {
    const x = list[+b.dataset.si]; dropSheet();
    const it = { ...x.ch, type: 'live' }; items.set(favKey('live', it.id), it);
    playLive(it, [it]);
  });
}

// ---- Zender aangetikt: kan hij terugkijken? Dan eerst kiezen: live, of terugkijken (dag → programma, of een eigen tijd) ----
let archChans = null;
const chanNorm = n => tidyName(n).toUpperCase().replace(/\b(HD|FHD|UHD|4K|SD|NL|ODIDO|RAW)\b/g, '').replace(/[^A-Z0-9]/g, '');
async function archiveChannelFor(it) {
  if (!archChans) archChans = cachedApi('/api/archive/channels').catch(() => { archChans = null; return []; });
  const list = await archChans;
  const ids = new Set([it.id, ...(it.alt || [])].map(String));
  return list.find(c => ids.has(String(c.id))) || list.find(c => chanNorm(c.n) === chanNorm(it.n)) || null;
}
function dropSheet() { hideSheet(); const i = layers.indexOf(hideSheet); if (i >= 0) layers.splice(i, 1); }
async function openChannel(it, ctx) {
  const ch = await archiveChannelFor(it).catch(() => null);
  if (!ch) return playLive(it, ctx);
  const k = favKey('live', it.id);
  const days = Array.from({ length: Math.max(1, Math.min(7, ch.days || 1)) }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - i);
    return { date: ymd(d), back: i, label: i === 0 ? 'Vandaag' : i === 1 ? 'Gisteren' : d.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' }) };
  });
  showSheet(`<div class="sheet-hero chan-hero"><div>${it.i ? `<span class="chan-logo-big"><img src="${esc(it.i)}" alt="" referrerpolicy="no-referrer"></span>` : ''}<h2>${esc(tidyName(it.n))}</h2><div class="meta" id="chNow"></div></div></div>
    <div class="sheet-body">
      <div class="hero-actions"><button class="btn primary" id="chLive">${PLAY_ICON}Kijk live</button><button class="btn glass ${isFav(k) ? 'on' : ''}" data-fav="${esc(k)}">${HEART}Mijn lijst</button></div>
      <h3 class="arch-head">Terugkijken</h3>
      <div class="seasons">${days.map(d => `<button class="chip" data-day="${d.back}">${esc(d.label)}</button>`).join('')}</div>
      <div class="arch-time"><span>Of kies zelf een tijd</span><input type="time" id="chTime" value="20:00" step="300"><button class="btn glass" id="chTimeGo">${PLAY_ICON}Kijk vanaf deze tijd</button></div>
      <div class="arch-list"><p class="muted">Laden…</p></div>
    </div>`);
  $('#chLive').onclick = () => { dropSheet(); playLive(it, ctx); };
  api('/api/epg?id=' + it.id).then(e => {
    const now = e.find(x => x.s * 1000 <= Date.now() && x.e * 1000 > Date.now());
    if (now && $('#chNow')) $('#chNow').textContent = `Nu: ${now.t} · ${hhmm(now.s)}–${hhmm(now.e)}`;
  }).catch(() => {});
  let day = days[0], progs = [];
  // Tijdzone van de aanbieder: afgeleid uit de programmagids (start-tekst vs. echte tijd)
  let tzShift = 0;
  const showDay = async back => {
    day = days[back] || days[0];
    $$('#sheetCard [data-day]').forEach(b => b.classList.toggle('active', +b.dataset.day === day.back));
    const box = $('#sheetCard .arch-list'); if (!box) return;
    box.innerHTML = '<p class="muted">Laden…</p>';
    try { progs = await api(`/api/archive/day?id=${ch.id}&date=${day.date}`); } catch { progs = []; }
    if (day !== days[back]) return;
    const ref = progs.find(p => p.at);
    if (ref) tzShift = Date.parse(ref.at.replace(' ', 'T') + ':00Z') - ref.s * 1000;
    const past = progs.filter(p => p.s * 1000 < Date.now());
    box.innerHTML = past.length ? past.map(p => {
      const live = p.e * 1000 > Date.now();
      return `<button class="arch-prog ${live ? 'now' : ''}" data-s="${p.s}"><b>${hhmm(p.s)}</b><span>${esc(p.t)}${live ? ' <i class="live-pill">NU</i>' : ''}</span><small>${Math.round((p.e - p.s) / 60)} min</small></button>`;
    }).join('') : '<p class="muted">Geen uitzendingen gevonden voor deze dag.</p>';
    $$('.arch-prog', box).forEach(b => b.onclick = () => { const p = progs.find(x => String(x.s) === b.dataset.s); dropSheet(); playArchive(ch, p, day.label); });
    // Meteen naar de avond (of het nieuwste programma vandaag)
    const target = $$('.arch-prog', box).find(b => new Date(+b.dataset.s * 1000).getHours() >= 20) || $$('.arch-prog', box).pop();
    if (day.back > 0 && target) target.scrollIntoView({ block: 'nearest' });
  };
  $$('#sheetCard [data-day]').forEach(b => b.onclick = () => showDay(+b.dataset.day));
  $('#chTimeGo').onclick = () => {
    const [hh, mm] = ($('#chTime').value || '20:00').split(':').map(Number);
    const d = new Date(day.date + 'T00:00:00'); d.setHours(hh, mm, 0, 0);
    if (d.getTime() > Date.now() - 60000) return toast('Die tijd is nog niet geweest');
    if (Date.now() - d.getTime() > (ch.days || 1) * 864e5) return toast('Zo ver terug kan deze zender niet');
    const srv = new Date(d.getTime() + tzShift);
    const at = `${srv.getUTCFullYear()}-${pad2(srv.getUTCMonth() + 1)}-${pad2(srv.getUTCDate())} ${pad2(srv.getUTCHours())}:${pad2(srv.getUTCMinutes())}`;
    const s = Math.floor(d.getTime() / 1000), e = Math.min(Math.floor(Date.now() / 1000), s + 4 * 3600);
    const prog = progs.find(p => p.s <= s && p.e > s);
    dropSheet();
    playArchive(ch, { at: tzShift || progs.length ? at : `${day.date} ${pad2(hh)}:${pad2(mm)}`, s, e, t: prog ? prog.t : tidyName(it.n) }, `${day.label}`);
  };
  showDay(0);
}
function playArchive(ch, p, dayLabel) {
  const at = p.at.replace(' ', ':').replace(/:(\d\d)$/, '-$1');
  const dur = Math.max(1, Math.ceil((p.e - p.s) / 60)) + 2;
  // Pc: via de pc (Dolby-geluid van o.a. NPO wordt AAC, anders geen geluid in Chrome)
  const url = S.session?.ffmpeg ? `/play/fmp4a/${ch.id}/${at}/${dur}/index.m3u8${APPLE_NATIVE ? '' : '?w=1'}` : `/play/archive/${ch.id}/${at}/${dur}.m3u8`;
  playVod({ kind: 'archive', url, start: 0, duration: 0, title: p.t, sub: `${tidyName(ch.n)} · ${dayLabel} ${hhmm(p.s)}`, favKey: null, hist: null });
}

// ---- Zoeken ----
const NL_SUGGEST = ['NPO 1', 'RTL 4', 'SBS 6', 'ESPN 1', 'Ziggo Sport', 'Eredivisie', 'Champions League', 'Formule 1', 'Viaplay', 'DAZN', 'NOS Journaal', 'Videoland', 'Netflix', 'Disney+', 'Kinderfilms', 'Nederlands gesproken'];
const SORTS = [['match', 'Beste match'], ['new', 'Nieuwste'], ['popular', 'Meest bekeken']];
function renderSearch() {
  const page = S.pages.search;
  page.innerHTML = `<div class="grid-page top-pad"><h2 class="page-title">Zoeken</h2>
    <div class="search-box"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg><input type="search" placeholder="Zenders, films, series…" autocomplete="off" enterkeyhint="search"></div>
    <div class="seg">${SORTS.map(([k, l]) => `<button data-sort="${k}">${l}</button>`).join('')}</div>
    <div class="suggest"></div><div class="results"></div></div>`;
  const input = $('input', page), out = $('.results', page), sug = $('.suggest', page);
  let sort = store.get('sort', 'match');
  const markSort = () => $$('.seg button', page).forEach(b => b.classList.toggle('active', b.dataset.sort === sort));
  markSort();
  const chips = (title, list) => list.length ? `<div class="sug-group"><h4>${title}</h4><div class="sug-chips">${list.map(s => `<button class="chip" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>` : '';
  const idle = () => {
    // Rustig en overzichtelijk: een paar suggesties en je laatste paar titels, elk op één regel
    const recent = [...new Set(hist().map(x => tidyName(x.n).replace(YEAR_RE, '')))].slice(0, 5);
    sug.innerHTML = chips('Recent bekeken', recent) + chips('Probeer', NL_SUGGEST.slice(0, 6));
    out.innerHTML = '';
  };
  sug.onclick = e => { const c = e.target.closest('[data-q]'); if (c) { input.value = c.dataset.q; run(true); } };
  $$('.seg button', page).forEach(b => b.onclick = () => { sort = b.dataset.sort; store.set('sort', sort); markSort(); run(true); });
  let timer, sugTimer, seq = 0, sugSeq = 0;
  const suggest = q => {
    clearTimeout(sugTimer);
    sugTimer = setTimeout(async () => {
      const my = ++sugSeq;
      const names = await api('/api/suggest?q=' + encodeURIComponent(q)).catch(() => []);
      if (my !== sugSeq || input.value.trim() !== q) return;
      sug.innerHTML = names.length ? `<div class="sug-chips">${names.filter(n => n.toLowerCase() !== q.toLowerCase()).map(n => `<button class="chip ghost" data-q="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : '';
    }, 140);
  };
  const run = now => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) return idle();
    if (q.length >= 2) suggest(q);
    timer = setTimeout(async () => {
      const my = ++seq;
      if (q.length < 2) { out.innerHTML = ''; return; }
      if (!out.children.length) out.innerHTML = '<div class="empty"><p>Zoeken…</p></div>';
      try {
        const r = await api(`/api/search?q=${encodeURIComponent(q)}&sort=${sort}`);
        if (my !== seq) return;
        const parts = [['live', 'Zenders'], ['vod', 'Films'], ['series', 'Series']].filter(([t]) => r[t].length);
        // Volgen: melding (belletje) zodra er iets met deze naam bij komt, bijv. een wedstrijd die nog niet beschikbaar is
        const followBtn = q.length >= 3 ? `<button class="follow-btn" data-follow="${esc(q)}"><svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>Laat het me weten als er iets nieuws met "${esc(q)}" verschijnt</button>` : '';
        if (!parts.length) { out.innerHTML = `<div class="empty"><h3>Niets gevonden</h3><p>Probeer een andere zoekterm.</p>${followBtn}</div>`; $('[data-follow]', out)?.addEventListener('click', e => followTerm(e.currentTarget.dataset.follow)); return; }
        // Per soort alleen de beste paar; de rest achter "Alles laten zien" (zo hoef je bij een film niet langs 100 zenders)
        const max = t => TUNE.search[t === 'live' ? 0 : 1] * (TOUCH ? 1 : 2);
        out.innerHTML = parts.map(([t, label]) => `<h3 class="section-sub">${label} <span class="count">${r[t].length}</span></h3><div class="grid ${t === 'live' ? 'live' : 'posters'}" data-ctx data-type="${t}">${r[t].slice(0, max(t)).map(x => cardHTML(t, x)).join('')}</div>` +
          (r[t].length > max(t) ? `<button class="show-all" data-all="${t}"><span>Alles laten zien</span><small>${r[t].length} ${label.toLowerCase()}</small>${CHEVRON}</button>` : '')).join('');
        $$('.grid[data-ctx]', out).forEach(g => { g._list = r[g.dataset.type]; g._type = g.dataset.type; });
        $$('[data-all]', out).forEach(b => b.onclick = () => { const t = b.dataset.all; openGridItems(`${parts.find(p => p[0] === t)[1]} · ${q}`, t, r[t]); });
        if (followBtn) { out.insertAdjacentHTML('beforeend', followBtn); $('[data-follow]', out).onclick = e => followTerm(e.currentTarget.dataset.follow); }
      } catch { out.innerHTML = '<div class="empty"><p>Zoeken mislukt.</p></div>'; }
    }, now ? 0 : 280);
  };
  input.oninput = () => run(false);
  input.onkeydown = e => { if (e.key === 'Enter') { input.blur(); run(true); } };
  idle();
  setTimeout(() => input.focus(), 50);
}

// Alle films/series: per 120 bijladen terwijl je scrolt
function openGridPaged(title, type) {
  const list = [];
  let total = Infinity, loading = false;
  const page = () => api(`/api/all?type=${type}&offset=${list.length}&limit=120`);
  openGridItems(title, type, page().then(r => { total = r.total; list.push(...r.items); return list; }), async grid => {
    if (loading || list.length >= total) return false;
    loading = true;
    try { const r = await page(); list.push(...r.items); grid.insertAdjacentHTML('beforeend', r.items.map(x => cardHTML(type, x)).join('')); }
    catch {} finally { loading = false; }
    return list.length < total;
  });
}

// "Alles" bekijken
let gridEl = null;
function openGridItems(title, type, listOrPromise, loadMore) {
  S.pages[S.tab]._scroll = scrollY;
  S.pages[S.tab].hidden = true;
  gridEl = document.createElement('div');
  gridEl.className = 'grid-page top-pad page';
  gridEl.innerHTML = `<h2 class="page-title"><button class="round sm" data-back><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>${esc(title)}</h2><div class="grid ${type === 'live' ? 'live' : 'posters'}" data-ctx>${skeletons(type, 12)}</div>`;
  main.appendChild(gridEl);
  window.scrollTo(0, 0);
  $('[data-back]', gridEl).onclick = () => closeTop();
  pushLayer(() => closeGrid());
  const grid = $('.grid', gridEl);
  Promise.resolve(listOrPromise).then(list => {
    grid._list = list; grid._type = type; grid.innerHTML = '';
    let n = 0;
    const more = () => {
      grid.insertAdjacentHTML('beforeend', list.slice(n, n + 90).map(x => cardHTML(type, x)).join(''));
      n += 90;
      if (n < list.length || loadMore) {
        const s = document.createElement('div'); s.className = 'grid-sentinel'; grid.appendChild(s);
        const io = new IntersectionObserver(async es => {
          if (!es[0].isIntersecting) return;
          io.disconnect(); s.remove();
          if (n < list.length) return more();
          if (await loadMore(grid)) { n = list.length; more(); }
        }, { rootMargin: '1200px' });
        io.observe(s);
      }
    };
    more();
  });
}
const openGrid = (type, cat) => openGridItems(tidyCat(cat.name), type, getList(type, cat.id));
function closeGrid(silent) {
  if (!gridEl) return;
  gridEl.remove(); gridEl = null;
  if (silent) return;
  S.pages[S.tab].hidden = false;
  window.scrollTo(0, S.pages[S.tab]._scroll || 0);
}

// ================= Terug-knop (Android/browser) sluit lagen =================
const layers = [];
function pushLayer(close) { layers.push(close); history.pushState({ layer: layers.length }, ''); }
function closeTop() { if (layers.length) history.back(); }
window.addEventListener('popstate', () => { const c = layers.pop(); c && c(); });

// ================= Klikken =================
let longPressFired = false;
document.addEventListener('click', e => {
  if (longPressFired) { longPressFired = false; e.preventDefault(); return; }
  const fav = e.target.closest('[data-fav]');
  if (fav) { e.stopPropagation(); e.preventDefault(); toggleFav(fav.dataset.fav); return; }
  const play = e.target.closest('[data-play]');
  if (play) { const it = items.get(play.dataset.play); if (it) playLive(it, [it]); return; }
  const open = e.target.closest('[data-open]');
  if (open) { openItem(items.get(open.dataset.open)); return; }
  const card = e.target.closest('.card[data-k]');
  if (card) {
    const it = items.get(card.dataset.k);
    const ctx = card.closest('[data-ctx]');
    if (it.type === 'live') openChannel(it, ctx?._list?.length ? ctx._list.map(x => ({ ...x, type: 'live' })) : [it]);
    else openItem(it);
  }
});
let lpTimer;
document.addEventListener('touchstart', e => {
  const card = e.target.closest('.card[data-k]'); if (!card) return;
  lpTimer = setTimeout(() => { longPressFired = true; navigator.vibrate?.(15); toggleFav(card.dataset.k); }, 520);
}, { passive: true });
['touchend', 'touchmove', 'touchcancel'].forEach(t => document.addEventListener(t, () => clearTimeout(lpTimer), { passive: true }));
document.addEventListener('contextmenu', e => { const card = e.target.closest('.card[data-k]'); if (card) { e.preventDefault(); toggleFav(card.dataset.k); } });

function openItem(it) {
  if (!it) return;
  if (it.type === 'live') return playLive(it, [it]);
  if (it.type === 'vod') return openMovie(it);
  return openSeries(it);
}

// ================= Detail-sheets =================
const CLOSE_BTN = `<button class="round sheet-close" data-close><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
function showSheet(html) {
  const sh = $('#sheet');
  $('#sheetCard').innerHTML = CLOSE_BTN + html;
  if (sh.hidden) { sh.hidden = false; document.body.style.overflow = 'hidden'; pushLayer(hideSheet); }
  $('#sheetCard').scrollTop = 0;
}
function hideSheet() { $('#sheet').hidden = true; document.body.style.overflow = ''; }
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet' || e.target.closest('[data-close]')) closeTop(); });

// Knop "Bron": andere versies van dezelfde film/serie, pas geladen als je erop tikt (beste en Nederlands eerst)
const SOURCE_ICON = '<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>';
function sourceButton(type, it, current, onPick) {
  const btn = $('#mSource'), box = $('#sheetCard .versions');
  if (!btn || !box) return;
  let loaded = null;
  btn.onclick = async () => {
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false;
    if (!loaded) {
      box.innerHTML = '<p class="muted">Versies zoeken…</p>';
      loaded = api(`/api/versions?type=${type}&id=${encodeURIComponent(it.id)}&name=${encodeURIComponent(it.n)}`).catch(() => []);
    }
    let list = await loaded;
    if (!list.some(v => String(v.id) === String(it.id))) list = [{ id: it.id, e: it.e, hq: it.hq }, ...list];
    const cur = current();
    box.innerHTML = `<h4>Kies een bron</h4>` + list.map((v, n) => {
      const tags = [n === 0 ? 'Beste' : '', v.nl ? 'Nederlands' : '', v.hq ? 'HQ' : '', v.cam ? 'CAM' : '', type === 'vod' && v.e ? String(v.e).toUpperCase() : ''].filter(Boolean);
      return `<button class="version ${String(v.id) === String(cur) ? 'on' : ''}" data-v="${n}"><b>Bron ${n + 1}</b><span>${esc(tidyCat(v.cat || '') || (n === 0 ? 'Gekozen door de app' : 'Andere versie'))}</span><small>${tags.map(esc).join(' · ')}</small></button>`;
    }).join('') + (list.length < 2 ? '<p class="muted">Geen andere versies gevonden.</p>' : '');
    $$('.version', box).forEach(b => b.onclick = () => { box.hidden = true; const v = list[+b.dataset.v]; onPick(v, list.filter(x => x !== v)); });
  };
}

async function openMovie(it) {
  const k = favKey('vod', it.id);
  showSheet(`<div class="sheet-hero"><div><h2>${esc(tidyName(it.n))}</h2></div></div><div class="sheet-body"><p class="muted">Laden…</p></div>`);
  let info = {};
  try { info = await getInfo('vod', it.id); } catch {}
  const md = info.movie_data || {};
  const raw = Array.isArray(info.info) ? {} : info.info || {};
  const i = metaMatches(it.n, raw) ? raw : { duration_secs: raw.duration_secs, duration: raw.duration };
  const ext = md.container_extension || it.e || 'mp4';
  const dur = durSecs(i) || durSecs(raw); // lengte: ook als de aanbieder alleen "114" (minuten) geeft
  const h = hist().find(x => x.k === k);
  const resume = h && h.pos > 30 && (!h.dur || h.pos < h.dur - 60) ? h.pos : 0;
  const backdrops = [...(i.backdrop_path || []), i.cover_big, i.movie_image];
  const rating = Number(i.rating) || it.r;
  $('#sheetCard').innerHTML = CLOSE_BTN + `
    <div class="sheet-hero"><div><h2>${esc(tidyName(i.name || it.n).replace(YEAR_RE, ''))}</h2>
      <div class="meta">${metaHTML([(i.releasedate || '').slice(0, 4) || (tidyName(it.n).match(/\((\d{4})\)/) || [])[1], fmtDuration(i), i.genre, rating ? { star: Number(rating).toFixed(1) } : ''])}</div></div></div>
    <div class="sheet-body">
      <div class="hero-actions">
        <button class="btn primary" id="mPlay">${PLAY_ICON}${resume ? 'Verder vanaf ' + fmtTime(resume) : 'Afspelen'}</button>
        ${resume ? '<button class="btn glass" id="mRestart">Vanaf begin</button>' : ''}
        <button class="btn glass ${isFav(k) ? 'on' : ''}" data-fav="${esc(k)}">${HEART}Mijn lijst</button>
        <button class="round" id="mSource" title="Andere bron">${SOURCE_ICON}</button>
      </div>
      <div class="versions" hidden></div>
      ${i.plot || i.description ? `<p class="plot">${esc(i.plot || i.description)}</p>` : ''}
      <div class="credits">${i.cast ? `<div><b>Met</b> ${esc(i.cast)}</div>` : ''}${i.director ? `<div><b>Regie</b> ${esc(i.director)}</div>` : ''}</div>
    </div>`;
  heroArt($('#sheetCard .sheet-hero'), backdrops, it.i || i.movie_image || i.cover_big, 700);
  const go = (start, v, rest) => playVod({ kind: 'movie', id: v ? v.id : it.id, ext: v ? v.e || 'mp4' : ext, hq: v ? !!v.hq : !!it.hq, start, duration: dur, title: tidyName(i.name || it.n), sub: (i.releasedate || '').slice(0, 4), favKey: k,
    item: v ? { ...it, hq: v.hq, alt: rest.map(x => ({ id: x.id, e: x.e })) } : it, hist: { k, type: 'vod', id: it.id, n: it.n, i: it.i } });
  $('#mPlay').onclick = () => go(resume);
  $('#mRestart') && ($('#mRestart').onclick = () => go(0));
  sourceButton('vod', it, () => it.id, (v, rest) => go(resume, v, rest));
}

async function openSeries(it, src) { // src: een andere versie van de serie (via de knop "Bron")
  const k = favKey('series', it.id);
  showSheet(`<div class="sheet-hero"><div><h2>${esc(tidyName(it.n))}</h2></div></div><div class="sheet-body"><p class="muted">Laden…</p></div>`);
  let info = {};
  try { info = await getInfo('series', src ? src.id : it.id); } catch {}
  const raw = Array.isArray(info.info) ? {} : info.info || {};
  const i = metaMatches(it.n, raw) ? raw : {};
  const eps = info.episodes || {};
  const seasons = Object.keys(eps).sort((a, b) => a - b);
  const h = hist().find(x => x.k === k);
  const backdrops = i.name ? [...(i.backdrop_path || []), it.b] : [];
  // Jaartal = nieuwste aflevering van het laatste seizoen, of het nieuwste jaar in de naam (zelfde regel als op de kaarten)
  const yearOf = d => { const y = +String(d || '').slice(0, 4); return y > 1900 && y <= new Date().getFullYear() + 1 ? y : 0; };
  const lastS = seasons.filter(s => Number(s) > 0).pop();
  const lastYear = Math.max(0, ...(eps[lastS] || []).map(e => yearOf(e.info?.air_date || e.info?.releasedate)),
    ...(Array.isArray(info.seasons) ? info.seasons : []).filter(s => String(s.season_number) === String(lastS)).map(s => yearOf(s.air_date)),
    yearFromName(it.n), yearFromName(i.name)) || yearOf(i.releaseDate || i.release_date) || 0;
  if (lastYear && lastSeason[it.id] !== lastYear) { rememberYears({ [it.id]: lastYear }); $$(`.card[data-k="${CSS.escape(k)}"] .name`).forEach(el => { el.textContent = el.textContent.replace(YEAR_RE, '') + ` (${lastYear})`; }); }
  $('#sheetCard').innerHTML = CLOSE_BTN + `
    <div class="sheet-hero"><div><h2>${esc(tidyName(i.name || it.n).replace(YEAR_RE, ''))}${lastYear ? ` <span class="h-year">(${lastYear})</span>` : ''}</h2>
      <div class="meta">${metaHTML([i.genre, Number(i.rating) ? { star: Number(i.rating).toFixed(1) } : '', seasons.length ? seasons.length + (seasons.length === 1 ? ' seizoen' : ' seizoenen') : ''])}</div></div></div>
    <div class="sheet-body">
      <div class="hero-actions">
        ${h?.ep ? `<button class="btn primary" id="sResume">${PLAY_ICON}Verder: S${h.ep.season} A${h.ep.num}</button>` : seasons.length ? `<button class="btn primary" id="sFirst">${PLAY_ICON}Afspelen</button>` : ''}
        <button class="btn glass ${isFav(k) ? 'on' : ''}" data-fav="${esc(k)}">${HEART}Mijn lijst</button>
        <button class="btn glass bell-btn ${isFollowed(it.id) ? 'on' : ''}" id="sBell" title="Melding bij een nieuwe aflevering">${BELL_ICON}<span>${isFollowed(it.id) ? 'Melding aan' : 'Melding'}</span></button>
        <button class="round" id="mSource" title="Andere bron">${SOURCE_ICON}</button>
      </div>
      <div class="versions" hidden></div>
      ${i.plot ? `<p class="plot">${esc(i.plot)}</p>` : ''}
      ${seasons.length ? `<div class="seasons">${seasons.map(s => `<button class="chip" data-season="${esc(s)}">Seizoen ${esc(s)}</button>`).join('')}</div><div class="episodes"></div>` : '<p class="muted">Geen afleveringen gevonden.</p>'}
    </div>`;
  heroArt($('#sheetCard .sheet-hero'), backdrops, it.i || i.cover, 700);
  // Melding bij nieuwe aflevering aan/uit (het huidige aantal afleveringen telt als "gezien")
  $('#sBell').onclick = () => {
    const on = !isFollowed(it.id), count = seasons.reduce((n, s) => n + (eps[s] || []).length, 0);
    setFollowSeries(it, on, count);
    $('#sBell').classList.toggle('on', on);
    $('#sBell span').textContent = on ? 'Melding aan' : 'Melding';
    toast(on ? 'Je krijgt een melding bij een nieuwe aflevering' : 'Geen meldingen meer voor deze serie');
  };
  sourceButton('series', it, () => src ? src.id : it.id, (v, rest) =>
    openSeries({ ...it, alt: rest.map(x => ({ id: x.id, e: x.e })) }, String(v.id) === String(it.id) ? null : v));
  const flat = seasons.flatMap(s => eps[s].map(e => ({ ...e, season: s })));
  const playEp = (e, start = 0) => {
    const idx = flat.indexOf(e);
    playVod({
      kind: 'series', id: e.id, ext: e.container_extension || 'mp4', start, duration: durSecs(e.info),
      title: tidyName(i.name || it.n), sub: `S${e.season} A${e.episode_num} · ${tidyName(e.title)}`, favKey: k, item: it,
      hist: { k, type: 'series', id: it.id, n: it.n, i: it.i, b: it.b, ep: { id: e.id, season: e.season, num: e.episode_num } },
      next: flat[idx + 1] ? () => playEp(flat[idx + 1]) : null,
      nextLabel: flat[idx + 1] ? `S${flat[idx + 1].season} A${flat[idx + 1].episode_num}` : '',
    });
  };
  const showSeason = s => {
    $$('[data-season]').forEach(b => b.classList.toggle('active', b.dataset.season === s));
    $('.episodes').innerHTML = eps[s].map(e => `<button class="ep" data-ep="${esc(e.id)}">
      <div class="thumb" data-bg="${esc(e.info?.movie_image || '')}">${h?.ep?.id == e.id && h.dur ? `<div class="progress"><i style="width:${Math.min(100, h.pos / h.dur * 100)}%"></i></div>` : ''}</div>
      <div><h4>${esc(e.episode_num)}. ${esc(tidyName(e.title).replace(/^.*?S\d+E\d+\s*-?\s*/i, '') || 'Aflevering ' + e.episode_num)}</h4><p>${esc(e.info?.plot || e.info?.duration || '')}</p></div></button>`).join('');
    $$('.episodes .thumb[data-bg]').forEach(t => heroArt(t, t.dataset.bg, it.i || i.cover, 200));
    $$('[data-ep]').forEach(b => b.onclick =() => { const e = flat.find(x => String(x.id) === b.dataset.ep); playEp(e, h?.ep?.id == e.id ? h.pos : 0); });
  };
  $$('[data-season]').forEach(b => b.onclick = () => showSeason(b.dataset.season));
  if (seasons.length) showSeason(h?.ep && eps[h.ep.season] ? String(h.ep.season) : seasons[0]);
  $('#sFirst') && ($('#sFirst').onclick = () => playEp(flat[0]));
  // Verder kijken: midden in een aflevering gestopt = daar verder; aflevering (bijna) af = de volgende vanaf het begin
  $('#sResume') && ($('#sResume').onclick = () => {
    const idx = Math.max(0, flat.findIndex(x => x.id == h.ep.id)), e = flat[idx] || flat[0];
    const done = h.dur > 0 && h.pos > h.dur - 120;
    if (done && flat[idx + 1]) playEp(flat[idx + 1], 0); else playEp(e, !done && h.pos > 30 ? h.pos : 0);
  });
}

// ================= Speler =================
const P = { item: null, stream: null, ctx: [], idx: 0, hls: null, ts: null, live: true, offset: 0, duration: 0, remux: false, src: null, tries: 0, opts: null, favKey: null, stages: null, stage: 0, sources: [], srcIdx: 0 };

const HLS_CONFIG = {
  enableWorker: true,
  lowLatencyMode: false,
  startLevel: -1,
  capLevelToPlayerSize: false,
  abrEwmaDefaultEstimate: 25e6,
  maxBufferLength: 40,
  maxMaxBufferLength: 90,
  backBufferLength: 20,
  // Rustig en stabiel: hele stukken laden (half binnengekomen stukken gaven haperingen) en wat meer voorraad bij live
  progressive: false,
  startFragPrefetch: true,
  liveSyncDurationCount: 3,
  liveMaxLatencyDurationCount: 10,
  maxLiveSyncPlaybackRate: 1.05,
  nudgeMaxRetry: 8,
  // Reageert een bron niet snel? Dan sneller door naar de volgende bron i.p.v. lang wachten
  manifestLoadPolicy: { default: { maxTimeToFirstByteMs: 7000, maxLoadTimeMs: 10000, timeoutRetry: { maxNumRetry: 1, retryDelayMs: 300, maxRetryDelayMs: 1000 }, errorRetry: { maxNumRetry: 1, retryDelayMs: 500, maxRetryDelayMs: 1000 } } },
  fragLoadPolicy: { default: { maxTimeToFirstByteMs: 9000, maxLoadTimeMs: 60000, timeoutRetry: { maxNumRetry: 4, retryDelayMs: 300, maxRetryDelayMs: 2000 }, errorRetry: { maxNumRetry: 6, retryDelayMs: 500, maxRetryDelayMs: 4000 } } },
};
// Kan deze browser HEVC zelf? Dan nooit het beeld omzetten (omzetten = kwaliteitsverlies en trager)
const HEVC_OK = !!window.MediaSource?.isTypeSupported?.('video/mp4; codecs="hvc1.1.6.L120.90"');

function destroyEngines() {
  if (P.hls) { P.hls.destroy(); P.hls = null; }
  if (P.ts) { try { P.ts.destroy(); } catch {} P.ts = null; }
  video.removeAttribute('src'); video.load();
}

// Automatisch volledig scherm bij afspelen op telefoon/tablet:
//  iPhone: Apple's eigen speler (zoals UHF en de Apple TV-app) — schermvullend en draait mee naar liggend
//  Android/tablet: volledig scherm en liggend vastzetten
const TOUCH = matchMedia('(hover: none) and (pointer: coarse)').matches;
const IPHONE = /iPhone|iPod/.test(UA);
if (IPHONE) { video.removeAttribute('playsinline'); video.removeAttribute('webkit-playsinline'); video.playsInline = false; }
video.addEventListener('webkitendfullscreen', () => { if (!playerEl.hidden) closeTop(); });
function autoFullscreen() {
  if (!TOUCH || IPHONE || document.fullscreenElement) return;
  try {
    const p = (playerEl.requestFullscreen || playerEl.webkitRequestFullscreen)?.call(playerEl, { navigationUI: 'hide' });
    Promise.resolve(p).then(() => screen.orientation?.lock?.('landscape')).catch(() => {});
  } catch {}
}
function openPlayer() {
  if (playerEl.hidden) {
    playerEl.hidden = false; document.body.style.overflow = 'hidden';
    pushLayer(closePlayer);
    autoFullscreen();
  }
  hideMsg(); poke();
}
function closePlayer() {
  saveProgress();
  // Zelf gesloten: alles wat nog liep (andere bron zoeken, opnieuw proberen) stopt hier, er start niets meer vanzelf
  P.token = (P.token || 0) + 1; P.src = null; P.stages = null; P.opts = null;
  hideNextUp(); toggleIntro(false);
  destroyEngines();
  stopSubs();
  playerEl.hidden = true; $('#pSide').hidden = true; document.body.style.overflow = '';
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  try { screen.orientation?.unlock?.(); } catch {}
  if (video.webkitDisplayingFullscreen) try { video.webkitExitFullscreen(); } catch {}
  P.item = null; P.favKey = null;
  $('#pBadge').textContent = '';
  cancelStats();
}

function setLoading(on) { playerEl.classList.toggle('loading', on); }
function showMsg(title, text, buttons = '') { const m = $('#pMsg'); m.innerHTML = `<h3>${esc(title)}</h3><p>${text}</p>${buttons}`; m.hidden = false; setLoading(false); }
function hideMsg() { $('#pMsg').hidden = true; }

async function attach(src, { forceNative = false } = {}) {
  if (playerEl.hidden) return; // speler al gesloten
  destroyEngines();
  P.src = src;
  setLoading(true); hideMsg();
  const isHls = /\.m3u8(\?|$)/.test(src);
  if (isHls && !APPLE_NATIVE && !forceNative) {
    try { await engines(); } catch { return showMsg('Geen internet', 'De speler kon niet geladen worden.'); }
    if (P.src !== src) return;
  }
  if (isHls && !APPLE_NATIVE && !forceNative && window.Hls?.isSupported()) {
    const hls = P.hls = new Hls(HLS_CONFIG);
    let mediaRecover = 0;
    hls.on(Hls.Events.MANIFEST_PARSED, (_, d) => {
      if (d.levels.length > 1) { hls.autoLevelCapping = -1; hls.nextLevel = d.levels.length - 1; }
      video.play().catch(() => playerEl.classList.add('paused'));
    });
    // Terugkijken dat leeg binnenkomt (aanbieder had het even te druk): de pc probeert opnieuw, wij halen het daarna opnieuw op
    hls.on(Hls.Events.LEVEL_LOADED, (_, d) => {
      if (P.live || !d.details?.endList || d.details.totalduration >= 1 || P.src !== src) return;
      if ((P.emptyTries = (P.emptyTries || 0) + 1) > 6) return fallback();
      setTimeout(() => { if (P.src === src) attach(src); }, 3000);
    });
    // Ondertitels in de afspeellijst (bij "HQ"-films): Nederlands of Engels, de rest niet
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => applySubPref());
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      if (d.response?.code === 509) return tooMany();
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecover++ < 1) { hls.recoverMediaError(); return; }
      if (d.type === Hls.ErrorTypes.NETWORK_ERROR && P.tries++ < 1) { setTimeout(() => hls.startLoad(), 800); return; }
      fallback();
    });
    hls.loadSource(src);
    hls.attachMedia(video);
  } else {
    video.src = src;
    video.play().catch(() => playerEl.classList.add('paused'));
  }
}
// ================= Ondertiteling (pc) =================
// Alleen Nederlands en Engels. Bij omgezette films (.mkv) schrijft de pc de ondertitels mee weg terwijl de film
// binnenkomt; de speler haalt ze steeds bij. Knop "CC" in de speler: Nederlands → Engels → uit (wordt onthouden).
const SUB_LABEL = { nl: 'Nederlands', en: 'English' };
const subTracks = {};
let subTimer = null, subAvail = [];
const subPref = () => store.get('subLang', 'nl');
function trackFor(lang) {
  if (!subTracks[lang]) subTracks[lang] = video.addTextTrack('subtitles', SUB_LABEL[lang], lang);
  return subTracks[lang];
}
function clearTrack(t) { while (t.cues && t.cues.length) t.removeCue(t.cues[0]); }
function stopSubs() {
  clearInterval(subTimer); subTimer = null; subAvail = [];
  for (const t of Object.values(subTracks)) { clearTrack(t); t.mode = 'disabled'; }
  updateSubsBtn();
}
const vttTime = s => { const p = s.trim().split(':').map(x => Number(x.replace(',', '.'))); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
function startSubs(o, start) {
  stopSubs();
  const seen = { nl: 0, en: 0 }, lastCue = {};
  const pull = async () => {
    if (P.opts !== o || !P.remux) return stopSubs();
    for (const lang of ['nl', 'en']) {
      try {
        const r = await fetch(`/play/subs/${o.kind}/${o.id}/${start}/${lang}.vtt`, { cache: 'no-store' });
        if (!r.ok) continue;
        const blocks = (await r.text()).split(/\r?\n\r?\n/);
        const t = trackFor(lang);
        if (!subAvail.includes(lang)) { subAvail.push(lang); applySubPref(); }
        for (let i = seen[lang]; i < blocks.length - 1; i++) { // laatste blok kan nog half zijn
          const lines = blocks[i].split(/\r?\n/), at = lines.findIndex(l => l.includes('-->'));
          if (at < 0) continue;
          const [a, b] = lines[at].split('-->');
          const text = lines.slice(at + 1).join('\n').replace(/<[^>]+>/g, '').trim();
          if (!text) continue;
          const start = vttTime(a), end = vttTime(b.split(' ').filter(Boolean)[0]);
          // Lange zinnen langer in beeld (leestempo ~13 tekens per seconde, minstens 1,5 s, max 8 s),
          // tot vlak voor de volgende ondertitel
          const prev = lastCue[lang];
          if (prev && prev.endTime > start - 0.05) prev.endTime = Math.max(prev.startTime + 0.5, Math.min(prev.endTime, start - 0.05));
          const cue = new VTTCue(start, Math.max(end, start + Math.min(8, 1.5 + text.length / 13)), text);
          try { t.addCue(cue); lastCue[lang] = cue; } catch {}
        }
        seen[lang] = Math.max(seen[lang], blocks.length - 1);
      } catch {}
    }
  };
  setTimeout(pull, 1500); setTimeout(pull, 3500);
  subTimer = setInterval(pull, 8000);
}
function availableSubs() {
  if (P.hls) return (P.hls.subtitleTracks || []).map((t, i) => ({ i, lang: /^(nl|nld|dut)/i.test(t.lang || t.name) ? 'nl' : /^(en|eng)/i.test(t.lang || t.name) ? 'en' : '' })).filter(x => x.lang);
  return subAvail.map(lang => ({ lang }));
}
function applySubPref() {
  const pref = subPref(), avail = availableSubs();
  const pick = pref === 'off' ? null : avail.find(x => x.lang === pref) || avail.find(x => x.lang === 'nl') || avail[0];
  if (P.hls) { P.hls.subtitleDisplay = !!pick; P.hls.subtitleTrack = pick ? pick.i : -1; }
  for (const [lang, t] of Object.entries(subTracks)) t.mode = !P.hls && pick?.lang === lang ? 'showing' : 'disabled';
  updateSubsBtn();
}
function updateSubsBtn() {
  const b = $('#pSubs'); if (!b) return;
  // Altijd zichtbaar bij films en series (ook als de ondertitels nog moeten binnenkomen)
  b.hidden = !!P.live || playerEl.hidden;
  const pref = subPref();
  const on = pref !== 'off' && availableSubs().length > 0;
  b.classList.toggle('on', on);
  $('#pSubsLang').textContent = on ? pref.toUpperCase() : pref === 'off' ? 'UIT' : '';
  b.title = pref === 'off' ? 'Ondertiteling uit' : 'Ondertiteling: ' + (SUB_LABEL[pref] || pref);
}
$('#pSubs')?.addEventListener('click', () => {
  const avail = availableSubs().map(x => x.lang);
  if (!avail.length) {
    // Film rechtstreeks afgespeeld (geen ondertitels zichtbaar)? Via de pc opnieuw starten, die haalt de ondertitels eruit
    if (P.opts && !P.remux && !P.hls && !P.opts.url && S.session?.ffmpeg && !IS_IOS) {
      if (subPref() === 'off') store.set('subLang', 'nl');
      toast('Ondertitels zoeken…');
      P.opts.forceRemux = true; seekVod(curTime(), true);
      return;
    }
    toast(P.remux && subTimer ? 'Ondertitels laden nog, of deze versie heeft geen Nederlandse/Engelse ondertitels' : 'Deze versie heeft geen Nederlandse of Engelse ondertitels');
    return;
  }
  const order = [...new Set(['nl', 'en'].filter(l => avail.includes(l))), 'off'];
  const next = order[(order.indexOf(subPref()) + 1) % order.length];
  store.set('subLang', next); applySubPref();
  toast(next === 'off' ? 'Ondertiteling uit' : 'Ondertiteling: ' + SUB_LABEL[next]);
});

function tooMany() {
  destroyEngines();
  showMsg('Al 2 schermen in gebruik', 'Je abonnement laat maar 2 apparaten tegelijk kijken. Stop op een ander apparaat en probeer het opnieuw.',
    `<div class="hero-actions center"><button class="btn primary" onclick="retryLive()">Opnieuw proberen</button></div>`);
}
window.retryLive = () => { P.stage = 0; startStage(); };

// Volgorde per apparaat:
//  iPhone/Safari: gewone HLS (H.264, werkt meteen en met AirPlay) → fMP4-HLS via de pc (voor HEVC) → H.264-omzetting
//  pc/Android:    HLS via hls.js → H.264-omzetting (als HEVC niet kan) → MPEG-TS
// Lukt het allemaal niet, dan automatisch de volgende bron van dezelfde zender.
function liveStages(id) {
  const ff = S.session?.ffmpeg, s = [];
  if (APPLE_NATIVE) { if (ff) s.push(`/play/fmp4/c/${id}/index.m3u8`); else s.push(`/play/live/${id}.m3u8`); if (ff) s.push(`/play/fmp4/x/${id}/index.m3u8`); }
  else { s.push(`/play/live/${id}.m3u8`); s.push('ts:' + id); if (ff && !HEVC_OK) s.push(`/play/fmp4/x/${id}/index.m3u8`); }
  return s;
}
async function startStage() {
  if (playerEl.hidden || !P.stages) return;
  const src = P.stages[P.stage];
  if (!src.startsWith('ts:')) return attach(src);
  try { await engines(); } catch {}
  if (playerEl.hidden) return;
  if (!window.mpegts?.getFeatureList().mseLivePlayback) return fallback();
  destroyEngines(); P.src = src; setLoading(true);
  const pl = P.ts = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: `${location.origin}/play/live/${P.stream}.ts` }, { enableWorker: true, liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 6, liveBufferLatencyMinRemain: 1.5, lazyLoad: false });
  pl.attachMediaElement(video); pl.load();
  pl.on(mpegts.Events.ERROR, () => fallback());
  video.play().catch(() => {});
}
function fallback() {
  if (playerEl.hidden) return; // zelf gesloten: geen andere bron proberen
  if (P.live && P.stages && P.stage < P.stages.length - 1) { P.stage++; P.tries = 0; startStage(); return; }
  if (P.live && P.srcIdx < P.sources.length - 1) { switchSource(P.srcIdx + 1, true); return; }
  // Film/aflevering kapot (bijv. server van een "HQ"-versie plat)? Meteen de volgende versie van dezelfde titel
  if (!P.live && P.opts && !P.opts.url) {
    const alts = P.opts.alts ||= (P.opts.item?.alt || []).filter(a => typeof a === 'object' && String(a.id) !== String(P.opts.id));
    const a = alts.shift();
    if (a) { toast('Andere versie geprobeerd'); Object.assign(P.opts, { id: a.id, ext: a.e || 'mp4', hq: !!a.hq, viaPc: false }); P.tries = 0; seekVod(P.opts.start || 0, true); return; }
  }
  destroyEngines();
  showMsg('Afspelen lukt niet', P.live ? 'Deze zender reageert nu niet. Probeer een andere zender.' : 'Deze film/aflevering kan niet worden geladen.',
    P.live ? `<div class="hero-actions center"><button class="btn primary" onclick="zap(1)">Volgende zender</button></div>` : '');
}
// Welke videocodec een zender heeft (onthouden per apparaat): H.264 kan de iPhone zelf direct
// afspelen, dus dan slaan we het omzetten via de pc over (sneller starten, minder werk voor de pc).
const codecMemo = store.get('codecs', {});
const liveInfo = store.get('liveInfo', {}); // pc: beeld- en geluidscodec per zender
async function codecOf(id) {
  if (codecMemo[id]) return codecMemo[id];
  const c = await Promise.race([api('/api/codec?id=' + id).then(r => r.codec).catch(() => ''), new Promise(r => setTimeout(() => r(''), 5000))]);
  if (c) { codecMemo[id] = c; store.set('codecs', codecMemo); }
  return c;
}
async function switchSource(i, auto) {
  P.srcIdx = i; P.stream = P.sources[i]; P.stage = 0; P.tries = 0;
  const token = P.token = (P.token || 0) + 1, id = P.stream;
  if (auto) toast('Andere bron geprobeerd');
  loadEpg(id);
  if (APPLE_NATIVE && S.session?.ffmpeg) {
    setLoading(true);
    const codec = await codecOf(id);
    if (token !== P.token) return;
    // H.264: eerst rechtstreeks bij de aanbieder (snelst, geen omweg), dan via de pc
    const direct = S.session.direct ? [`${S.session.direct.replace('/__/', '/live/')}/${id}.m3u8`] : [];
    P.stages = codec === 'h264' ? [...direct, `/play/live/${id}.m3u8`, `/play/fmp4/c/${id}/index.m3u8`, `/play/fmp4/x/${id}/index.m3u8`] : liveStages(id);
  } else if (!APPLE_NATIVE && S.session?.ffmpeg) {
    // Pc: zenders met Dolby-geluid (NPO e.d.) of HEVC-beeld via de pc (geluid naar AAC, beeld onaangeroerd).
    // Gewone H.264+AAC-zenders rechtstreeks (sneller). Onbekend = via de pc (werkt altijd), en meten voor de volgende keer.
    const info = liveInfo[id];
    const direct = info && info.audio === 'aac' && (info.codec === 'h264' || (info.codec === 'hevc' && HEVC_OK));
    const viaPc = info?.codec === 'hevc' && !HEVC_OK ? `/play/fmp4/x/${id}/index.m3u8` : `/play/fmp4/w/${id}/index.m3u8`;
    P.stages = direct ? [`/play/live/${id}.m3u8`, viaPc] : [viaPc, `/play/live/${id}.m3u8`];
    if (!info) api('/api/codec?id=' + id).then(r => { if (r.codec) { liveInfo[id] = r; store.set('liveInfo', liveInfo); } }).catch(() => {});
  } else P.stages = liveStages(id);
  startStage();
}

function playLive(item, ctx) {
  P.live = true; P.remux = false; P.offset = 0; P.opts = null;
  stopSubs();
  P.item = item; P.ctx = ctx; P.idx = Math.max(0, ctx.findIndex(x => x.id === item.id));
  P.favKey = favKey('live', item.id);
  P.sources = [item.id, ...(item.alt || [])];
  items.set(P.favKey, { ...item, type: 'live' });
  playerEl.classList.add('live');
  $('#pTitle').textContent = tidyName(item.n);
  $('#pSub').textContent = '';
  $('#pBadge').textContent = '';
  $('#pFav').classList.toggle('on', isFav(P.favKey));
  $('#pQuality').hidden = P.sources.length < 2;
  openPlayer();
  switchSource(0);
  saveHist({ k: P.favKey, type: 'live', id: item.id, n: item.n, i: item.i, alt: item.alt });
  countView(P.favKey, item);
  $('#pFav').hidden = false;
  if (!$('#pSide').hidden && $('#pSide').dataset.mode === 'list') renderChannelList();
  if (!$('#pSide').hidden && $('#pSide').dataset.mode === 'quality') openQuality();
}
async function loadEpg(id) {
  try {
    const e = await api('/api/epg?id=' + id);
    if (P.stream !== id) return;
    const now = e.find(x => x.s * 1000 <= Date.now() && x.e * 1000 > Date.now());
    const next = e.find(x => x.s * 1000 > Date.now());
    const t = d => new Date(d * 1000).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    $('#pSub').textContent = [now && `Nu: ${now.t}`, next && `${t(next.s)} ${next.t}`].filter(Boolean).join('  ·  ');
  } catch {}
}
function zap(d) {
  if (!P.live || P.ctx.length < 2) return;
  P.idx = (P.idx + d + P.ctx.length) % P.ctx.length;
  playLive(P.ctx[P.idx], P.ctx);
}
window.zap = zap;

const countView = (k, item) => k && fetch('/api/view', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ k, item }) }).catch(() => {});
function vodURL(o, start) {
  if (o.url) return { url: o.url, remux: false };
  // iPhone + mp4: rechtstreeks bij de aanbieder (sneller doorspoelen, geen omweg via de pc)
  if (IS_IOS && S.session?.direct && !o.viaPc && /^(mp4|m4v|mov)$/i.test(o.ext)) return { url: `${S.session.direct.replace('/__/', `/${o.kind}/`)}/${o.id}.${o.ext}`, remux: false };
  // "HQ"-versies zijn eigenlijk afspeellijsten: meteen als afspeellijst openen (anders eerst een fout en een omweg = traag)
  if ((o.hq ?? (o.item?.hq && o.id === o.item.id)) && o.kind === 'movie') return { url: `/play/hq/${o.kind}/${o.id}.${o.ext}/index.m3u8`, remux: false };
  const browserOk = /^(mp4|m4v|webm|mov|m3u8)$/i.test(o.ext) && !o.forceRemux;
  if (browserOk || !S.session?.ffmpeg || IS_IOS) return { url: `/play/${o.kind}/${o.id}.${o.ext}`, remux: false };
  return { url: `/play/remux/${o.kind}/${o.id}.${o.ext}?t=${Math.floor(start)}`, remux: true };
}
function playVod(o) {
  P.live = false; P.item = { id: o.id }; P.opts = o; P.tries = 0; P.emptyTries = 0; P.favKey = o.favKey; P.stages = null; P.sources = [];
  P.duration = o.duration || 0;
  playerEl.classList.remove('live');
  $('#pTitle').textContent = o.title;
  $('#pSub').textContent = o.sub || '';
  $('#pBadge').textContent = '';
  $('#pFav').classList.toggle('on', isFav(o.favKey));
  $('#pFav').hidden = !o.favKey;
  $('#pQuality').hidden = true;
  hideSheet(); const i = layers.indexOf(hideSheet); if (i >= 0) layers.splice(i, 1);
  openPlayer();
  countView(o.favKey, o.item);
  // iPhone + .mkv/.avi: de pc verpakt het (zonder kwaliteitsverlies) zodat Safari en AirPlay het afspelen
  if (IS_IOS && !o.url && !/^(mp4|m4v|mov|m3u8)$/i.test(o.ext) && S.session?.ffmpeg) o.url = `/play/fmp4v/${o.kind}/${o.id}.${o.ext}/index.m3u8`;
  if (IS_IOS && !o.url && !/^(mp4|m4v|mov|m3u8)$/i.test(o.ext)) {
    destroyEngines();
    const abs = location.origin + `/play/${o.kind}/${o.id}.${o.ext}`;
    showMsg('Open in VLC of Infuse', `Dit is een .${esc(o.ext)}-bestand; dat kan Safari op de iPhone niet afspelen. Met de gratis app VLC werkt het wel (ook AirPlay naar je tv).`,
      `<div class="hero-actions center"><a class="btn primary" href="vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(abs)}">Open in VLC</a><a class="btn glass" href="infuse://x-callback-url/play?url=${encodeURIComponent(abs)}">Infuse</a></div>`);
    return;
  }
  seekVod(o.start || 0, true);
}
function seekVod(t, first) {
  const o = P.opts; if (!o) return;
  t = Math.max(0, P.duration ? Math.min(t, P.duration - 2) : t);
  const v = vodURL(o, t);
  if (!first && !P.remux && !v.remux) { video.currentTime = t; return; }
  P.remux = v.remux; P.offset = v.remux ? Math.floor(t) : 0;
  attach(v.url);
  if (v.remux) startSubs(o, P.offset); else stopSubs();
  // Omgezette films/terugkijken groeien tijdens het kijken; de iPhone zou dan bij het "einde" beginnen
  const growing = /\/play\/fmp4[av]\//.test(v.url);
  if (!v.remux && (t > 0 || growing)) video.addEventListener('loadedmetadata', () => { video.currentTime = t; }, { once: true });
}
const curTime = () => P.offset + (video.currentTime || 0);
const totalTime = () => P.duration || (isFinite(video.duration) ? P.offset + video.duration : 0);

let lastSave = 0;
function saveProgress() {
  if (!P.opts || P.live || !P.opts.hist) return;
  const pos = curTime(), dur = totalTime();
  if (pos < 5) return;
  saveHist({ ...P.opts.hist, pos, dur });
}

// Video-events
video.addEventListener('waiting', () => setLoading(true));
video.addEventListener('playing', () => { setLoading(false); playerEl.classList.remove('paused'); P.tries = 0; startStats(); });
video.addEventListener('canplay', () => setLoading(false));
video.addEventListener('pause', () => { playerEl.classList.add('paused'); poke(); });
video.addEventListener('play', () => playerEl.classList.remove('paused'));
video.addEventListener('error', () => {
  if (P.hls || P.ts || playerEl.hidden || !video.getAttribute('src')) return;
  if (P.live && P.tries++ < 1) { setTimeout(() => attach(P.src), 800); return; }
  // Rechtstreeks lukte niet? Dan via de pc
  if (!P.live && P.opts && /^https?:/.test(P.src || '') && !P.opts.viaPc) { P.opts.viaPc = true; const t = curTime(); seekVod(t, true); return; }
  if (!P.live && P.opts && !P.opts.url && !P.remux && S.session?.ffmpeg && !IS_IOS) { P.remux = true; P.offset = Math.floor(curTime()); attach(`/play/remux/${P.opts.kind}/${P.opts.id}.${P.opts.ext}?t=${P.offset}`); return; }
  fallback();
});
video.addEventListener('ended', () => { saveProgress(); hideNextUp(); if (P.opts?.next) P.opts.next(); });

// ---- Series: "Intro overslaan" in het begin, en aan het eind de volgende aflevering met aftellen ----
function seriesExtras() {
  const o = P.opts;
  if (!o || P.live || playerEl.hidden) return hideNextUp(), toggleIntro(false);
  const c = curTime(), d = totalTime();
  toggleIntro(o.kind === 'series' && !o.introSkipped && c > 5 && c < 150);
  if (o.next && d > 60 && d - c <= 15 && !o.nextCancelled) showNextUp(Math.max(0, Math.ceil(d - c)));
  else hideNextUp();
}
function toggleIntro(on) {
  let b = $('#pIntro');
  if (!b && on) {
    b = document.createElement('button'); b.id = 'pIntro'; b.className = 'skip-btn'; b.textContent = 'Intro overslaan';
    b.onclick = e => { e.stopPropagation(); P.opts.introSkipped = true; toggleIntro(false); seekVod(curTime() + 80); };
    playerEl.appendChild(b);
  }
  if (b) b.hidden = !on;
}
function showNextUp(sec) {
  let c = $('#pNext2');
  if (!c) {
    c = document.createElement('div'); c.id = 'pNext2'; c.className = 'next-up';
    c.innerHTML = `<button class="next-go">${PLAY_ICON}<span></span></button><button class="next-no" title="Annuleren"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
    $('.next-go', c).onclick = e => { e.stopPropagation(); const n = P.opts?.next; hideNextUp(); saveProgress(); n && n(); };
    $('.next-no', c).onclick = e => { e.stopPropagation(); if (P.opts) P.opts.nextCancelled = true; hideNextUp(); };
    playerEl.appendChild(c);
  }
  $('.next-go span', c).textContent = `Volgende aflevering${P.opts?.nextLabel ? ' · ' + P.opts.nextLabel : ''} (${sec})`;
  c.hidden = false;
}
function hideNextUp() { const c = $('#pNext2'); if (c) c.hidden = true; }
video.addEventListener('timeupdate', seriesExtras);
let seeking = false;
video.addEventListener('timeupdate', () => {
  if (P.live) return;
  const c = curTime(), d = totalTime();
  $('#pCur').textContent = fmtTime(c); $('#pDur').textContent = fmtTime(d);
  if (!seeking && d) $('#pSeek').value = Math.round(c / d * 1000);
  if (Date.now() - lastSave > 5000) { lastSave = Date.now(); saveProgress(); }
});

// Hapert de stream? Dan automatisch herstellen
let stall = { t: -1, n: 0 };
setInterval(() => {
  if (playerEl.hidden || video.paused || !P.live || !$('#pMsg').hidden) { stall.n = 0; return; }
  if (video.currentTime === stall.t) stall.n++; else { stall.n = 0; stall.t = video.currentTime; }
  if (stall.n === 4 && P.hls) { P.hls.startLoad(); }
  if (stall.n >= 8) { stall.n = 0; startStage(); }
}, 1000);

// Beeldkwaliteit + echte fps meten
let statTimer = null, fps = 0;
function startStats() {
  cancelStats();
  if (!video.getVideoPlaybackQuality) { updateBadge(); return; }
  let last = video.getVideoPlaybackQuality().totalVideoFrames, t = performance.now();
  statTimer = setInterval(() => {
    const now = performance.now(), total = video.getVideoPlaybackQuality().totalVideoFrames;
    if (!video.paused && total > last) { fps = Math.round((total - last) * 1000 / (now - t) / 5) * 5 || Math.round((total - last) * 1000 / (now - t)); }
    last = total; t = now; updateBadge();
  }, 2000);
  updateBadge();
}
function cancelStats() { clearInterval(statTimer); statTimer = null; fps = 0; }
function updateBadge() {
  const h = video.videoHeight, w = video.videoWidth; if (!h) return;
  const label = w >= 3800 || h >= 2100 ? '4K' : w >= 2500 || h >= 1400 ? '1440p' : w >= 1900 || h >= 1000 ? '1080p' : w >= 1260 || h >= 700 ? '720p' : h + 'p';
  $('#pBadge').textContent = label + (fps ? ` · ${fps} fps` : '');
}

// Bediening
function togglePlay() { video.paused ? video.play().catch(() => {}) : video.pause(); }
$('#pPlay').onclick = togglePlay;
$('#pBack').onclick = () => closeTop();
$('#pPrev').onclick = () => zap(-1);
$('#pNext').onclick = () => zap(1);
$('#pFav').onclick = () => P.favKey && toggleFav(P.favKey);
$('#pFull').onclick = toggleFull;
$('#pPip').onclick = async () => {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (video.requestPictureInPicture) await video.requestPictureInPicture();
    else video.webkitSetPresentationMode?.('picture-in-picture');
  } catch { toast('Beeld-in-beeld werkt hier niet'); }
};
function toggleFull() {
  if (document.fullscreenElement) return document.exitFullscreen();
  if (playerEl.requestFullscreen) playerEl.requestFullscreen().catch(() => {});
  else video.webkitEnterFullscreen?.();
}
video.addEventListener('dblclick', toggleFull);
video.addEventListener('click', () => { if (matchMedia('(hover: hover)').matches) togglePlay(); });

const seek = $('#pSeek');
seek.addEventListener('input', () => { seeking = true; $('#pCur').textContent = fmtTime(seek.value / 1000 * totalTime()); poke(); });
seek.addEventListener('change', () => { seeking = false; seekVod(seek.value / 1000 * totalTime()); });

// Zenderlijst / bron in zijpaneel
$('#pList').onclick = () => { const s = $('#pSide'); if (!s.hidden && s.dataset.mode === 'list') { s.hidden = true; return; } renderChannelList(); };
$('#pQuality').onclick = () => openQuality();
$('#pSideClose').onclick = () => $('#pSide').hidden = true;
function renderChannelList() {
  const s = $('#pSide'); s.hidden = false; s.dataset.mode = 'list';
  $('#pSideTitle').textContent = 'Zenders';
  if (!P.live) { s.hidden = true; return; }
  $('#pSideList').innerHTML = P.ctx.slice(0, 600).map((c, i) => `<button class="ch ${i === P.idx ? 'active' : ''}" data-i="${i}"><span class="logo">${c.i ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(c.i)}" alt="">` : ''}</span><span class="t"><div>${esc(tidyName(c.n))}</div></span></button>`).join('');
  $$('#pSideList .ch').forEach(b => b.onclick = () => { P.idx = +b.dataset.i; playLive(P.ctx[P.idx], P.ctx); });
  $('#pSideList .ch.active')?.scrollIntoView({ block: 'center' });
}
function openQuality() {
  const s = $('#pSide'); s.hidden = false; s.dataset.mode = 'quality';
  $('#pSideTitle').textContent = 'Bron';
  $('#pSideList').innerHTML = P.sources.map((id, i) => `<button class="ch ${i === P.srcIdx ? 'active' : ''}" data-i="${i}"><span class="logo"><b>${i + 1}</b></span><span class="t"><div>Bron ${i + 1}${i === 0 ? ' · beste' : ''}</div><small>${i === 0 ? 'Hoogste beeldkwaliteit' : 'Reserve, als de eerste hapert'}</small></span></button>`).join('') +
    `<div class="tip">De app kiest zelf de beste versie en schakelt automatisch over als een bron niet werkt.</div>`;
  $$('#pSideList .ch').forEach(b => b.onclick = () => { switchSource(+b.dataset.i); openQuality(); });
}

// Naar tv sturen: AirPlay (iPhone/Mac), Chromecast (Android/Chrome), anders uitleg
// ---- Chromecast vanaf de pc (Chrome): de tv haalt het beeld via de pc op, in een vorm die elke Chromecast kan ----
let castLoaded = null;
function loadCast() {
  if (castLoaded) return castLoaded;
  castLoaded = new Promise((res, rej) => {
    window.__onGCastApiAvailable = ok => ok ? res() : rej(new Error('geen cast'));
    const s = document.createElement('script');
    s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
    s.onerror = () => rej(new Error('niet geladen'));
    document.head.appendChild(s);
    setTimeout(() => rej(new Error('traag')), 8000);
  }).then(() => {
    cast.framework.CastContext.getInstance().setOptions({ receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID, autoJoinPolicy: chrome.auth?.AutoJoinPolicy?.ORIGIN_SCOPED || 'origin_scoped' });
  }).catch(e => { castLoaded = null; throw e; });
  return castLoaded;
}
function castMedia() {
  const lan = S.session?.lan; if (!lan) return null;
  const pos = P.live ? 0 : curTime();
  if (P.live) return { url: `${lan}/play/fmp4/w/${P.stream}/index.m3u8`, type: 'application/x-mpegurl', fmp4: true, live: true, pos };
  const o = P.opts; if (!o) return null;
  if (o.kind === 'archive') return { url: lan + o.url.replace(/\?.*$/, '') + '?w=1', type: 'application/x-mpegurl', fmp4: /fmp4a/.test(o.url), pos };
  if (o.hq ?? o.item?.hq) return { url: `${lan}/play/hq/${o.kind}/${o.id}.${o.ext}/index.m3u8`, type: 'application/x-mpegurl', fmp4: false, pos };
  if (/^(mp4|m4v)$/i.test(o.ext) && S.session.direct) return { url: `${S.session.direct.replace('/__/', `/${o.kind}/`)}/${o.id}.${o.ext}`, type: 'video/mp4', pos };
  return { url: `${lan}/play/fmp4v/${o.kind}/${o.id}.${o.ext}/index.m3u8?w=1`, type: 'application/x-mpegurl', fmp4: true, pos };
}
async function chromecast() {
  const m = castMedia(); if (!m) return false;
  try { await loadCast(); } catch { return false; }
  const ctx = cast.framework.CastContext.getInstance();
  try { if (!ctx.getCurrentSession()) await ctx.requestSession(); } catch { return true; } // venster weggeklikt
  const session = ctx.getCurrentSession(); if (!session) return true;
  const info = new chrome.cast.media.MediaInfo(m.url, m.type);
  info.streamType = m.live ? chrome.cast.media.StreamType.LIVE : chrome.cast.media.StreamType.BUFFERED;
  if (m.type.includes('mpegurl')) {
    info.hlsSegmentFormat = m.fmp4 ? chrome.cast.media.HlsSegmentFormat.FMP4 : chrome.cast.media.HlsSegmentFormat.TS;
    info.hlsVideoSegmentFormat = m.fmp4 ? chrome.cast.media.HlsVideoSegmentFormat.FMP4 : chrome.cast.media.HlsVideoSegmentFormat.MPEG2_TS;
  }
  info.metadata = new chrome.cast.media.GenericMediaMetadata();
  info.metadata.title = $('#pTitle').textContent;
  const req = new chrome.cast.media.LoadRequest(info);
  req.currentTime = m.pos || 0; req.autoplay = true;
  // Eigen beeld stoppen: de aanbieder staat maar 2 verbindingen toe, de tv heeft er nu een nodig
  destroyEngines(); P.token = (P.token || 0) + 1;
  try { await session.loadMedia(req); }
  catch { showMsg('Casten lukt niet', 'De tv kon dit niet afspelen. Probeer een andere bron of zender.'); return true; }
  showMsg('Speelt af op je tv', `Op ${esc(session.getCastDevice().friendlyName || 'je Chromecast')}.`,
    `<div class="hero-actions center"><button class="btn primary" id="castStop">Stoppen met casten</button></div>`);
  $('#castStop').onclick = () => { session.endSession(true); hideMsg(); closeTop(); };
  return true;
}

$('#pCast').onclick = async () => {
  if (video.webkitShowPlaybackTargetPicker) { video.webkitShowPlaybackTargetPicker(); return; }
  // Chrome op de pc: echte Chromecast-knop
  if (window.chrome && !/Edg\//.test(navigator.userAgent) && !TOUCH && S.session?.lan && await chromecast()) return;
  if (video.remote && video.remote.state !== 'connected') {
    if (P.hls && video.canPlayType('application/vnd.apple.mpegurl')) {
      const src = P.live && S.session?.ffmpeg ? `/play/fmp4/c/${P.stream}/index.m3u8` : P.src;
      P.hls.destroy(); P.hls = null; P.src = src; video.src = src; video.play().catch(() => {});
    }
    if (!P.hls && !P.ts && !P.remux) { video.remote.prompt().catch(() => castHelp()); return; }
  }
  castHelp();
};
function castHelp() {
  const lan = S.session?.lan;
  $('#pSide').hidden = false; $('#pSide').dataset.mode = 'cast';
  $('#pSideTitle').textContent = 'Naar je tv';
  $('#pSideList').innerHTML = `<div class="tips">
    <div class="tip"><b>Chromecast / Google TV</b><br>Chrome: menu <b>⋮</b> → <b>Casten, opslaan en delen</b> → <b>Casten…</b><br>Edge: menu <b>···</b> → <b>Meer hulpmiddelen</b> → <b>Media casten naar apparaat</b>.</div>
    <div class="tip"><b>Smart-tv met Miracast</b><br>Druk op <b>Windows + K</b> en kies je tv.</div>
    <div class="tip"><b>iPhone → Apple TV / AirPlay-tv</b><br>Open de app op je iPhone en tik op deze knop.</div>
    ${lan ? `<div class="tip"><b>Direct op de tv</b> (beste beeld)<br>Open in de browser van je smart-tv: <code>${esc(lan)}</code></div>` : ''}
  </div>`;
}

// Bediening verbergen na 3 seconden niks doen
let idleTimer;
function poke() {
  playerEl.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!video.paused && $('#pSide').hidden && $('#pMsg').hidden) playerEl.classList.add('idle'); }, 3000);
}
['mousemove', 'touchstart', 'keydown'].forEach(t => playerEl.addEventListener(t, poke, { passive: true }));

// Toetsenbord
document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea')) return;
  if (!playerEl.hidden) {
    const k = e.key;
    if (k === ' ' || k === 'k') { e.preventDefault(); togglePlay(); }
    else if (k === 'f') toggleFull();
    else if (k === 'm') video.muted = !video.muted;
    else if (k === 'Escape') { if (!$('#pSide').hidden) $('#pSide').hidden = true; else if (!document.fullscreenElement) closeTop(); }
    else if (P.live && (k === 'ArrowUp' || k === 'PageUp')) { e.preventDefault(); zap(-1); }
    else if (P.live && (k === 'ArrowDown' || k === 'PageDown')) { e.preventDefault(); zap(1); }
    else if (!P.live && k === 'ArrowRight') seekVod(curTime() + 10);
    else if (!P.live && k === 'ArrowLeft') seekVod(curTime() - 10);
    return;
  }
  if (e.key === 'Escape' && layers.length) closeTop();
  if (e.key === '/') { e.preventDefault(); setTab('search'); }
});

// ================= Profiel & delen =================
let qrP = null;
const loadQR = () => qrP ||= loadScript('https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js');
$('#accountBtn').onclick = async () => {
  const u = S.session?.user || {};
  const exp = u.exp_date ? new Date(u.exp_date * 1000).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
  const lan = S.session?.lan;
  showSheet(`<div class="account">
    <div class="acc-head">${avatarHTML(S.profile, 'lg')}<div><h2>${esc(S.profile.name)}</h2><button class="link" id="switchProfile">Wissel van profiel</button></div></div>

    ${S.session?.app ? '' : `<div class="group">
      <h3>Op je telefoon</h3>
      ${lan ? `<div class="qr-row"><div class="qr" id="qr"></div><ol>
        <li>Zet je telefoon op dezelfde wifi als deze pc.</li>
        <li>Scan de code met je camera, of open <code>${esc(lan)}</code> in Safari.</li>
        <li>Tik op <b>Deel</b> → <b>Zet op beginscherm</b>. Nu heb je een TV-app-icoon.</li></ol></div>` : '<p class="muted">Geen wifi-netwerk gevonden.</p>'}
      <p class="muted small">De pc moet aan staan met de app open. Buiten de deur kijken, GitHub en delen: <a class="link" href="/uitleg.html" target="_blank">lees de uitleg</a>.</p>
    </div>

    <div class="group">
      <h3>Delen met vrienden</h3>
      <p>Dubbelklik in de map van de app op <b>Maak deelbestand.cmd</b>. Je krijgt dan <b>TV installeren.cmd</b> in je Downloads; stuur dat door. Jouw inlog en profielen gaan er <b>niet</b> mee in.</p>
      <p class="muted small">Je vriend logt zelf in en maakt een eigen profiel. Met jouw abonnement kunnen maximaal 2 apparaten tegelijk kijken (pc's, telefoons en tv's samen).</p>
    </div>`}

    <div class="group">
      <h3>Weergave</h3>
      <div class="seg theme-seg">${[['auto', 'Automatisch'], ['light', 'Licht'], ['dark', 'Donker']].map(([k, l]) => `<button data-theme-pick="${k}" class="${store.get('theme', 'auto') === k ? 'active' : ''}">${l}</button>`).join('')}</div>
      <p class="muted small">Automatisch volgt de instelling van je apparaat. Geldt alleen voor dit apparaat.</p>
    </div>

    <div class="group">
      <h3>Lijsten verversen</h3>
      <p class="muted small">Haalt alle zenders, films, series en programma's opnieuw op bij je aanbieder (bijvoorbeeld als er iets nieuws is of als iets niet klopt).</p>
      <button class="btn glass reload-btn" id="reloadAll">Alles opnieuw laden</button>
    </div>

    <div class="group">
      <h3>Abonnement</h3>
      <div class="kv"><span>Status</span><span>${esc(u.status || '—')}</span><span>Geldig tot</span><span>${esc(exp)}</span><span>Schermen tegelijk</span><span>${esc(u.max_connections || '—')}</span><span>Gebruiker</span><span>${esc(S.session?.username)}</span></div>
    </div>
    <button class="btn glass" id="logoutBtn">${S.session?.app ? 'Uitloggen' : 'Uitloggen op deze pc'}</button></div>`);
  $$('[data-theme-pick]').forEach(b => b.onclick = () => {
    store.set('theme', b.dataset.themePick); applyTheme();
    $$('[data-theme-pick]').forEach(x => x.classList.toggle('active', x === b));
  });
  $('#reloadAll').onclick = async e => {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'Bezig met laden…';
    try { await api('/api/refresh', { method: 'POST' }); } catch {}
    // Ook alles wat dit apparaat onthouden had weggooien, en de pagina's opnieuw opbouwen
    for (const k of Object.keys(localStorage)) if (k.startsWith('c:')) localStorage.removeItem(k);
    S.cats = {}; S.lists.clear(); infoCache.clear();
    for (const el of Object.values(S.pages)) el.remove();
    S.pages = {};
    closeTop();
    setTab(S.tab);
    toast('Alles is opnieuw geladen');
  };
  $('#switchProfile').onclick = () => { closeTop(); setTimeout(showWho, 60); };
  $('#logoutBtn').onclick = async () => { if (!confirm('Uitloggen? Je moet daarna opnieuw je server, gebruikersnaam en wachtwoord invullen.')) return; await fetch('/api/logout', { method: 'POST' }); location.reload(); };
  if (lan) {
    try { await loadQR(); const qr = qrcode(0, 'M'); qr.addData(lan); qr.make(); $('#qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); } catch {}
  }
};

// ================= Licht / donker =================
const lightQuery = matchMedia('(prefers-color-scheme: light)');
function applyTheme() {
  const t = store.get('theme', 'auto');
  const light = t === 'light' || (t === 'auto' && lightQuery.matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  $('meta[name="theme-color"]').content = light ? '#f5f5f7' : '#000000';
}
lightQuery.addEventListener?.('change', applyTheme);
applyTheme();

// ================= Inloggen =================
function hideAll() { $('#login').hidden = true; $('#who').hidden = true; $('#nav').hidden = true; main.hidden = true; }
// Opstartscherm zacht laten verdwijnen
function hideSplash() {
  const s = $('#splash'); if (!s || s.hidden) return;
  s.classList.add('out'); setTimeout(() => s.hidden = true, 450);
}
function showLogin() { hideAll(); hideSplash(); $('#login').hidden = false; }
$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#loginError').textContent = '';
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(f)) });
  const j = await r.json().catch(() => ({}));
  if (j.ok) { S.session = await (await fetch('/api/session')).json(); showWho(); }
  else $('#loginError').textContent = j.error || 'Inloggen mislukt';
};

// ================= Start =================
$$('.nav-pill button').forEach(b => {
  b.onclick = () => setTab(b.dataset.tab);
  // iPhone: tijdens het uitrollen van het scrollen stopt de eerste tik alleen het scrollen en komt er geen "klik".
  // Daarom reageren de tabbladen al op het loslaten van je vinger, ook als het scherm nog beweegt.
  let start = null;
  b.addEventListener('touchstart', e => { const t = e.touches[0]; start = { x: t.clientX, y: t.clientY }; }, { passive: true });
  b.addEventListener('touchend', e => {
    const t = e.changedTouches[0];
    if (start && Math.abs(t.clientX - start.x) < 12 && Math.abs(t.clientY - start.y) < 12) { e.preventDefault(); setTab(b.dataset.tab); }
    start = null;
  }, { passive: false });
});
let lastScroll = 0, navScrolled = false;
// iPhone: na het toetsenbord (zoeken) of het draaien bleven de vaste balken soms halverwege het scherm hangen.
// Even "op dezelfde plek scrollen" laat de telefoon alles opnieuw goed neerzetten.
const resettle = () => setTimeout(() => requestAnimationFrame(() => window.scrollTo(window.scrollX, window.scrollY)), 60);
addEventListener('focusout', e => { if (e.target.matches?.('input, textarea')) resettle(); });
addEventListener('orientationchange', resettle);
window.visualViewport?.addEventListener('resize', resettle);
// window.__lastInput: de achtergrond-voorbereiding in de telefoon-app wacht tot je even niets doet
addEventListener('pointerdown', () => { window.__lastInput = performance.now(); }, { passive: true, capture: true });
document.addEventListener('scroll', e => {
  lastScroll = window.__lastInput = performance.now();
  if (e.target !== document) return;
  const s = scrollY > 10;
  if (s !== navScrolled) { navScrolled = s; $('#nav').classList.toggle('scrolled', s); }
}, { passive: true, capture: true });

// ================= Nieuw voor jou =================
// Een belletje bovenin. Meldt: nieuwe afleveringen van series die je volgt (Mijn lijst + recent bekeken),
// en titels die je via Zoeken "volgt" (bijv. een bokswedstrijd die nog niet beschikbaar is) zodra ze er zijn.
// Gecontroleerd bij het openen van de app en daarna af en toe; per profiel bewaard.
const watchKey = () => profileKey('watch');
const watchData = () => Object.assign({ eps: {}, terms: [], news: [], series: {} }, store.get(watchKey(), {}));
const BELL_ICON = '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>';
// Series waarvoor je zelf "Melding" hebt aangezet (knop bij de serie)
const isFollowed = id => !!watchData().series[id];
function setFollowSeries(it, on, count) {
  const w = watchData();
  if (on) { w.series[it.id] = { id: it.id, n: it.n, i: it.i }; w.eps[it.id] = count; }
  else delete w.series[it.id];
  saveWatch(w);
}
const saveWatch = w => { w.news = w.news.slice(0, 40); store.set(watchKey(), w); updateBell(w); };
function updateBell(w = watchData()) {
  const n = w.news.filter(x => !x.read).length;
  const b = $('#newsBtn'); if (!b) return;
  b.classList.toggle('has', n > 0);
  $('#newsCount').textContent = n > 9 ? '9+' : n || '';
}
function followTerm(q) {
  q = q.trim(); if (q.length < 3) return;
  const w = watchData();
  if (w.terms.some(t => t.q.toLowerCase() === q.toLowerCase())) return toast('Je volgt dit al');
  // Wat er nu al is telt niet als nieuw: alleen wat er hierna bij komt wordt gemeld
  api('/api/search?q=' + encodeURIComponent(q)).then(r => {
    const w2 = watchData();
    w2.terms.push({ q, seen: ['live', 'vod', 'series'].flatMap(t => (r[t] || []).map(x => t + ':' + x.id)) });
    saveWatch(w2);
    toast(`Je krijgt een melding zodra "${q}" verschijnt`);
  }).catch(() => toast('Lukt nu even niet'));
}
let newsBusy = false;
async function checkNews() {
  if (newsBusy || !S.profile) return;
  newsBusy = true;
  const w = watchData();
  let added = 0;
  try {
    // 1. Series met "Melding" aan (en die in Mijn lijst): meer afleveringen dan vorige keer = nieuwe aflevering
    const follow = [...Object.values(w.series), ...S.favs.filter(f => f.type === 'series')]
      .filter((x, i, a) => a.findIndex(y => String(y.id) === String(x.id)) === i).slice(0, 25);
    for (const s of follow) {
      try {
        const info = await api(`/api/seriesinfo?id=${s.id}`);
        const all = Object.entries(info.episodes || {}).flatMap(([season, l]) => (l || []).map(e => ({ season, e })));
        const count = all.length, last = all[all.length - 1];
        const known = w.eps[s.id];
        if (known != null && count > known && last) {
          w.news.unshift({ key: 'ep:' + s.id + ':' + count, type: 'series', id: s.id, n: s.n, i: s.i, text: `Nieuwe aflevering: S${last.season} A${last.e.episode_num}`, t: Date.now() });
          added++;
        }
        w.eps[s.id] = count;
        await new Promise(r => setTimeout(r, 300)); // rustig aan (zwakke telefoon, aanbieder)
      } catch {}
    }
    // 2. Gevolgde zoekwoorden: iets nieuws gevonden?
    for (const term of w.terms) {
      try {
        const r = await api('/api/search?q=' + encodeURIComponent(term.q));
        for (const t of ['vod', 'series', 'live']) for (const x of r[t] || []) {
          const k = t + ':' + x.id;
          if (term.seen.includes(k)) continue;
          term.seen.push(k);
          w.news.unshift({ key: 'q:' + k, type: t, id: x.id, n: x.n, i: x.i, alt: x.alt, text: `Nu te zien (je volgt "${term.q}")`, t: Date.now() });
          added++;
        }
      } catch {}
    }
  } finally { newsBusy = false; }
  w.news = w.news.filter((x, i, a) => a.findIndex(y => y.key === x.key) === i);
  saveWatch(w);
  if (added) toast(added === 1 ? '1 nieuw ding voor jou (belletje bovenin)' : `${added} nieuwe dingen voor jou (belletje bovenin)`);
}
function openNews() {
  const w = watchData();
  const list = w.news.length ? w.news.map((x, i) => `<button class="news-item ${x.read ? '' : 'unread'}" data-ni="${i}">
      <span class="news-art">${x.i ? `<img src="${esc(x.type === 'live' ? x.i : sized(x.i))}" alt="" referrerpolicy="no-referrer">` : ''}</span>
      <span><b>${esc(x.type === 'series' ? tidyName(x.n).replace(YEAR_RE, '') : tidyName(x.n))}</b><small>${esc(x.text)}</small><small class="muted">${new Date(x.t).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' })}</small></span></button>`).join('')
    : '<p class="muted">Nog niets nieuws. Hier verschijnen nieuwe afleveringen van je series en dingen die je volgt.</p>';
  const terms = w.terms.length ? `<h3 class="arch-head">Je volgt</h3><div class="follow-list">${w.terms.map((t, i) => `<span class="chip">${esc(t.q)}<button data-unfollow="${i}" title="Niet meer volgen">×</button></span>`).join('')}</div>` : '';
  showSheet(`<div class="sheet-hero chan-hero"><div><h2>Nieuw voor jou</h2><div class="meta">Nieuwe afleveringen en dingen die je volgt</div></div></div>
    <div class="sheet-body"><div class="news-list">${list}</div>${terms}
    <p class="muted small">Tip: zoek iets dat er nog niet is (bijv. een wedstrijd) en tik op "Laat het me weten".</p></div>`);
  $$('#sheetCard [data-ni]').forEach(b => b.onclick = () => {
    const x = w.news[+b.dataset.ni]; dropSheet();
    const it = { ...x, type: x.type }; items.set(favKey(x.type, x.id), it);
    if (x.type === 'live') openChannel(it, [it]); else openItem(it);
  });
  $$('#sheetCard [data-unfollow]').forEach(b => b.onclick = () => { const w2 = watchData(); w2.terms.splice(+b.dataset.unfollow, 1); saveWatch(w2); openNews(); });
  w.news.forEach(x => x.read = true); saveWatch(w);
}

function startApp() {
  hideAll();
  $('#nav').hidden = false; main.hidden = false;
  $('#accountBtn').innerHTML = avatarHTML(S.profile, 'sm');
  if (!$('#newsBtn')) {
    $('#accountBtn').insertAdjacentHTML('beforebegin', `<button id="newsBtn" class="nav-bell" title="Nieuw voor jou"><svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg><i id="newsCount"></i></button>`);
    $('#newsBtn').onclick = openNews;
  }
  updateBell();
  setTimeout(checkNews, IS_APP ? 20000 : 8000);
  // Opstartscherm blijft staan tot de eerste pagina klaar is (minstens 1 en hoogstens 4 seconden),
  // zodat je meteen een volle, rustige pagina ziet in plaats van alles dat nog binnenkomt
  const t0 = Date.now();
  const ready = () => setTimeout(hideSplash, Math.max(0, 1000 - (Date.now() - t0)) + 250);
  document.addEventListener('tv-ready', ready, { once: true });
  measurePerf();
  setTimeout(hideSplash, 4000);
  const t = store.get('tab', 'live');
  setTab(['live', 'vod', 'series', 'archive', 'mine', 'search'].includes(t) ? t : 'live');
  // De iPhone speelt alles zelf af; alleen andere apparaten hebben de speler-bibliotheken nodig
  if (!APPLE_NATIVE) (window.requestIdleCallback || setTimeout)(() => engines().catch(() => {}), { timeout: 3000 });
}

(async function init() {
  try { S.session = await (await fetch('/api/session')).json(); } catch { S.session = { loggedIn: false }; }
  if (!S.session.loggedIn) return showLogin();
  const saved = store.get('profile', null);
  S.profiles = await api('/api/profiles').catch(() => []);
  const p = S.profiles.find(x => x.id === saved);
  if (p) choose(p); else showWho();
})();
