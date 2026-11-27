// TV — afspelen in de iPhone-app.
//  - Apple's eigen speler (AVPlayer): voor gewone .mp4-films — met AirPlay en beeld-in-beeld
//  - ingebouwde VLC-speler (zoals UHF): voor alle zenders, .mkv/.avi en streams met een verkeerd label
// Lukt Apple's speler niet (meteen weer dicht zonder beeld), dan neemt VLC het vanzelf over.
(function () {
'use strict';
if (!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform())) return;
const reg = window.capacitorExports?.registerPlugin;
const AV = Capacitor.Plugins?.CapacitorVideoPlayer || reg?.('CapacitorVideoPlayer');
const VLC = Capacitor.Plugins?.VLCPlayer || reg?.('VLCPlayer');
if (!AV && !VLC) return;

// Adres bij de aanbieder; het account kiest de app zelf (primair, of het andere als daar al iemand kijkt)
const src = (kind, id, ext) => window.TVBackend.pick(`${kind}/${id}.${ext}`, kind !== 'live');
const APPLE_EXT = /^(mp4|m4v|mov|m3u8)$/i;

let cur = null;
// Zwart scherm met laadrondje zodra je op Afspelen tikt, tot de speler er is (niet eerst terug naar het hoofdscherm)
let coverTimer = 0;
function showCover() {
  let c = document.getElementById('launchCover');
  if (!c) {
    c = document.createElement('div'); c.id = 'launchCover';
    c.innerHTML = '<div class="lc-spin"></div>';
    c.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#000;display:grid;place-items:center;opacity:0;transition:opacity .15s';
    const st = document.createElement('style');
    st.textContent = '#launchCover .lc-spin{width:44px;height:44px;border-radius:50%;border:3px solid rgba(255,255,255,.18);border-top-color:#fff;animation:lcspin .8s linear infinite}@keyframes lcspin{to{transform:rotate(360deg)}}';
    document.head.appendChild(st); document.body.appendChild(c);
  }
  c.hidden = false; requestAnimationFrame(() => { c.style.opacity = '1'; });
  clearTimeout(coverTimer); coverTimer = setTimeout(hideCover, 30000); // vangnet
}
function hideCover() { clearTimeout(coverTimer); const c = document.getElementById('launchCover'); if (c) { c.style.opacity = '0'; setTimeout(() => { if (c.style.opacity === '0') c.hidden = true; }, 200); } }
const fail = msg => { hideCover(); toast(msg); };
// user = je hebt zelf gesloten (kruisje/Gereed): dan stoppen, nooit "kapot" denken en een andere bron starten
const done = (pos, ended, dur, user) => {
  const c = cur; cur = null; if (!c) return;
  if (ended) c.ended?.(); else c.exit?.(pos, dur, user);
  connMark(false, !c.live);
};
// Apple's speler: was de film geladen (klaar om te spelen)? Dan is sluiten altijd jouw keuze
AV?.addListener('jeepCapVideoPlayerReady', () => { if (cur) cur.ready = true; if (cur?.start > 5) AV.setCurrentTime({ playerId: 'fullscreen', seektime: cur.start }).catch(() => {}); });
AV?.addListener('jeepCapVideoPlayerExit', d => done(Number(d?.currentTime) || 0, false, 0, !!cur?.ready));
AV?.addListener('jeepCapVideoPlayerEnded', () => done(0, true));
VLC?.addListener('exit', d => done(Number(d?.currentTime) || 0, false, Number(d?.duration) || 0, !!d?.user));
VLC?.addListener('ended', () => done(0, true));
VLC?.addListener('airplay', d => { const c = cur; cur = null; c?.airplay?.(Number(d?.currentTime) || 0); });
VLC?.addListener('pip', d => { const c = cur; cur = null; c?.pip?.(Number(d?.currentTime) || 0); });
VLC?.addListener('zap', d => cur?.zap?.(Number(d?.dir) || 1));
VLC?.addListener('reload', d => { const c = cur; cur = null; c?.reload?.(Number(d?.currentTime) || 0); });
VLC?.addListener('progress', d => cur?.progress?.(Number(d?.currentTime) || 0, Number(d?.duration) || 0));

// Een live .ts-stream kan alleen VLC; Apple's speler krijgt dezelfde zender als .m3u8
const forApple = o => ({ ...o, url: o.url.replace(/\.ts$/, '.m3u8') });
async function withVLC(o) {
  connMark(true);
  // Naar de tv (AirPlay) gekozen in de speler: verder in Apple's speler op dezelfde plek, die stuurt het beeld door
  cur = { ...o, airplay: pos => AV ? withApple(forApple({ ...o, start: pos > 5 ? pos : o.start || 0 })) : null,
    // Beeld-in-beeld: verder in Apple's speler; daar het beeld-in-beeld-knopje (of veeg naar het beginscherm)
    pip: pos => { if (!AV) return; toast('Tik op het beeld-in-beeld-knopje in de speler'); withApple(forApple({ ...o, start: pos > 5 ? pos : o.start || 0 })); },
    // Andere ondertitelgrootte gekozen: dezelfde film op dezelfde plek opnieuw openen
    reload: pos => withVLC({ ...o, start: o.live ? 0 : pos }) };
  try { setTimeout(hideCover, 900); await VLC.play({ url: o.url, title: o.title || '', start: o.start || 0, live: !!o.live, series: !!o.series, nextTitle: o.nextTitle || '', castFirst: !!o.castFirst, run: o.run || 0, duration: Number(o.duration) || 0 }); }
  catch { cur = null; connMark(false); fail('Afspelen lukt niet'); }
}
async function withApple(o) {
  connMark(true);
  const t0 = Date.now();
  // Meteen weer dicht zonder beeld? Dan was dit formaat niets voor Apple's speler: VLC proberen
  cur = { ...o, exit: (pos, dur, user) => { if (!user && VLC && pos < 0.5 && Date.now() - t0 < 20000) { withVLC(o); } else o.exit?.(pos, dur, user); } };
  try {
    const r = await AV.initPlayer({
      mode: 'fullscreen', playerId: 'fullscreen', componentTag: 'div', url: o.url,
      displayMode: 'landscape', exitOnEnd: true, pipEnabled: true, bkmodeEnabled: true, showControls: true,
      title: o.title || '', smallTitle: o.sub || '',
    });
    if (r && r.result === false) throw new Error(r.message);
    setTimeout(hideCover, 600);
  } catch { if (VLC) withVLC(o); else { cur = null; connMark(false); fail('Afspelen lukt niet'); } }
}
const play = (o, preferVLC) => (preferVLC || !AV) && VLC ? withVLC(o) : withApple(o);

// Antwoordt een bron? Binnen ~4 seconden weten, zonder de speler te openen (dat duurde bij een kapotte bron lang).
// Films: alleen de eerste 2 bytes opvragen (de aanbieder kent geen HEAD). Afspeellijsten (.m3u8): ook het eerste stukje erachter controleren,
// want bij de "HQ"-versies werkt de lijst vaak wel maar de server met het beeld niet.
const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('traag')), ms))]);
// Elke doorverwijzing van de aanbieder telt als een apart scherm (en blijft na het stoppen nog minuten staan): daarom speelt VLC
// daarna het adres waar al naartoe verwezen is, zodat een film maar één scherm gebruikt
const finalURL = new Map();
async function alive(url, depth = 0) {
  try {
    const playlist = /\.m3u8(\?|$)/i.test(url) || depth > 0;
    const r = await within(fetch(url, playlist ? {} : { headers: { Range: 'bytes=0-1' } }), depth ? 3000 : 4000);
    if (!depth && r.url && r.url !== url && r.status < 400) finalURL.set(url, r.url);
    if (r.status === 404 || r.status === 410 || r.status >= 500) return false;
    if (!playlist || r.status >= 400 || depth >= 2) return r.status < 400 || r.status === 405;
    const text = await within(r.text(), 3000);
    if (!/^\s*#EXTM3U/.test(text)) return text.length > 0;
    const next = text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
    if (!next) return /#EXTINF|#EXT-X-STREAM-INF/.test(text);
    // Relatief adres na een doorverwijzing die we niet kennen: niet te controleren, dan maar proberen
    if (!/^https?:/i.test(next) && !r.url && r.redirected !== false) return true;
    const nextUrl = new URL(next, r.url || url).href;
    // Stukje video (.ts/.m4s): de kop is genoeg; nog een afspeellijst: één niveau dieper
    return /\.m3u8(\?|$)/i.test(nextUrl) ? alive(nextUrl, depth + 1) : within(fetch(nextUrl, { headers: { Range: 'bytes=0-1' } }), 3000).then(x => x.status < 400 || x.status === 405, () => false);
  } catch { return false; }
}

// Live: beste bron eerst (Apple's speler, met AirPlay); lukt het niet, dan VLC; en anders de volgende bron
// Elke keer afspelen krijgt een nummer: een oudere zoektocht naar een werkende bron mag nooit meer iets starten
let playRun = 0;
playLive = function (item, ctx) {
  showCover();
  const run = ++playRun;
  const sources = [item.id, ...(item.alt || [])];
  const k = favKey('live', item.id);
  items.set(k, { ...item, type: 'live' });
  saveHist({ k, type: 'live', id: item.id, n: item.n, i: item.i, alt: item.alt });
  countView(k, item);
  const tryIdx = async i => {
    // Niet vooraf proberen: elke proefverbinding bezet een scherm bij de aanbieder. VLC meldt een kapotte bron zelf binnen 10 s
    if (run !== playRun) return;
    if (i > 0) toast('Andere bron geprobeerd');
    const url = await src('live', sources[i], 'ts');
    if (run !== playRun) return;
    if (!url) { fail('Alle schermen zijn bezet. Stop eerst op een ander apparaat.'); return; }
    startLive(i, url, false);
  };
  const startLive = (i, url, otherAcc) => {
    const t0 = Date.now();
    play({
      url, title: tidyName(item.n), sub: 'Live', live: true,
      // Vegen in de speler: volgende/vorige zender uit dezelfde rij, zonder de speler te sluiten
      zap: async dir => {
        const list = ctx && ctx.length > 1 ? ctx : null; if (!list) return;
        let idx = list.findIndex(x => String(x.id) === String(item.id));
        idx = (idx + dir + list.length) % list.length;
        item = list[idx];
        const k2 = favKey('live', item.id);
        items.set(k2, { ...item, type: 'live' });
        saveHist({ k: k2, type: 'live', id: item.id, n: item.n, i: item.i, alt: item.alt });
        const old = url;
        window.TVBackend.release(old, 'now');
        const next = await src('live', item.id, 'ts');
        if (!next) { toast('Alle schermen zijn bezet'); return; }
        url = next;
        VLC.switchTo({ url: next, title: tidyName(item.n) }).catch(() => {});
      },
      exit: async (pos, dur, user) => {
        // Liep hij al en viel hij weg? Kijkt iemand anders nu op dit account, dan meteen verder op het andere
        if (!user && pos >= 0.5 && run === playRun) {
          const r = await window.TVBackend.moved(url, `live/${item.id}.ts`, false);
          if (run !== playRun) return;
          if (r === 'full') { fail('Iemand anders kijkt nu op dit account, en het andere account is ook bezet'); return; }
          if (r) { toast('Verder op je andere account'); return startLive(i, r, true); }
          return;
        }
        if (user || pos >= 0.5 || Date.now() - t0 >= 40000 || run !== playRun) { window.TVBackend.release(url, false); return; }
        // Was dit account vol (iemand anders keek)? Dan eerst dezelfde zender via het andere account
        if (otherAcc) window.TVBackend.release(url, false);
        const alt = otherAcc ? null : await window.TVBackend.failed(url, `live/${sources[i]}.ts`, false);
        if (run !== playRun) { if (alt) window.TVBackend.release(alt, false); return; }
        if (alt) return startLive(i, alt, true);
        if (i + 1 < sources.length) { showCover(); tryIdx(i + 1); } else fail('Deze zender werkt nu niet');
      },
    }, true); // Zenders altijd in VLC: Apple's speler haperde of gaf alleen het QuickTime-teken bij deze streams
  };
  tryIdx(0);
};

// Een aflevering in een andere versie van dezelfde serie zoeken (zelfde seizoen en afleveringnummer)
async function episodeInSeries(seriesId, season, num) {
  try {
    const info = await (await fetch('/api/seriesinfo?id=' + seriesId)).json();
    const e = (info.episodes?.[season] || []).find(x => String(x.episode_num) === String(num));
    return e ? { id: e.id, e: e.container_extension || 'mp4' } : null;
  } catch { return null; }
}

// Films en afleveringen: .mp4 in Apple's speler, al het andere (en de vermomde "HQ"-streams) in VLC.
// Werkt een versie niet (kapotte server), dan meteen de volgende versie van dezelfde film/aflevering.
playVod = function (o) {
  showCover();
  hideSheet(); const li = layers.indexOf(hideSheet); if (li >= 0) layers.splice(li, 1);
  countView(o.favKey, o.item);
  const sources = o.url ? [{ url: o.url }] : [{ id: o.id, e: o.ext, hq: o.item?.hq }];
  if (!o.url && o.kind === 'movie') for (const a of o.item?.alt || []) if (typeof a === 'object') sources.push({ id: a.id, e: a.e });
  let seriesAlts = !o.url && o.kind === 'series' && o.hist?.ep ? (o.item?.alt || []).filter(a => typeof a === 'object').map(a => a.id) : [];
  let askedAlts = false;
  const run = ++playRun;
  // "Op tv" gekozen: in de speler meteen de Chromecast-keuze tonen (VLC; Apple's speler heeft zelf AirPlay)
  const castFirst = typeof castNext !== 'undefined' && castNext; if (castFirst) castNext = false;
  // Ondertitels van internet (Nederlands en Engels) opzoeken terwijl de film start; VLC gebruikt ze als de film
  // zelf er geen heeft in jouw taal
  if (o.subInfo && VLC) {
    const si = o.subInfo, q = new URLSearchParams({ type: si.type, name: si.name || '', year: si.year || '', tmdb: si.tmdb || '', s: si.s || '', e: si.e || '' });
    fetch('/api/subs?' + q).then(r => r.json()).then(l => {
      const by = {}; for (const s of l || []) if (!by[s.lang]) by[s.lang] = s.url;
      if (Object.keys(by).length) VLC.setSubs({ run, ...by }).catch(() => {});
    }).catch(() => {});
  }
  const tryIdx = async i => {
    if (run !== playRun) return;
    showCover(); // ook bij de volgende versie: zwart scherm, niet even het hoofdscherm
    let s = sources[i];
    if (!s && !seriesAlts.length && !askedAlts && !o.url) {
      // Alle bekende versies kapot: zoek dezelfde titel in alle lijsten (ook internationaal)
      askedAlts = true;
      const isSeries = o.kind === 'series';
      const alts = await (await fetch(`/api/alternatives?type=${isSeries ? 'series' : 'vod'}&id=${isSeries ? o.item?.id : o.id}&name=${encodeURIComponent(o.item?.n || o.title)}`)).json().catch(() => []);
      if (isSeries) seriesAlts.push(...(alts || []).map(a => a.id));
      else for (const a of alts || []) if (!sources.some(x => String(x.id) === String(a.id))) sources.push(a);
      return tryIdx(i);
    }
    if (!s && seriesAlts.length) {
      // Serie: dezelfde aflevering in een andere versie van de serie
      const ep = await episodeInSeries(seriesAlts.shift(), o.hist.ep.season, o.hist.ep.num);
      if (ep) { sources.push(ep); s = ep; } else return tryIdx(i);
    }
    if (!s) {
      // Alles leek kapot bij de snelle controle: dan toch de eerste echt proberen (de controle kan zich vergissen)
      const first = sources.find(x => x.dead && !x.tried);
      if (first) { first.tried = true; sources.push({ ...first, dead: false, forced: true }); return tryIdx(i); }
      fail('Deze film/aflevering werkt nu niet. Probeer het later opnieuw.'); return;
    }
    let url = s.url || await src(o.kind, s.id, s.e);
    if (!url) { fail('Alle schermen zijn bezet. Stop eerst op een ander apparaat.'); return; }
    const picked = url, path = `${o.kind}/${s.id}.${s.e}`;
    if (!s.url && !s.forced && !(await alive(url))) {
      // Werkt niet: was dit account vol? Dan dezelfde versie via het andere account
      const alt = await window.TVBackend.failed(picked, path, true);
      if (alt && run === playRun) sources.splice(i + 1, 0, { ...s, url: alt, otherAcc: true });
      s.dead = true; return tryIdx(i + 1);
    }
    url = finalURL.get(url) || url;
    if (run !== playRun) return;
    if (i > 0) toast('Andere versie geprobeerd');
    const t0 = Date.now();
    let played = false, lastDur = o.duration || 0;
    play({
      url, title: o.title, sub: o.sub || '', start: o.start || 0, duration: o.duration || 0, run,
      series: o.kind === 'series', nextTitle: o.next ? (o.nextLabel || 'volgende') : '', castFirst,
      exit: async (pos, dur, user) => {
        // Halverwege weggegooid omdat iemand anders op dit account ging kijken? Verder op het andere account, zelfde plek
        if (!user && played && pos > 5 && !s.url && (!dur || pos < dur - 60) && run === playRun) {
          if (o.hist) saveHist({ ...o.hist, pos, dur: dur || lastDur });
          const r = await window.TVBackend.moved(picked, path, true);
          if (run !== playRun) return;
          if (r === 'full') { fail('Iemand anders kijkt nu op dit account, en het andere account is ook bezet'); return; }
          if (r) { toast('Verder op je andere account'); o.start = pos; sources.splice(i + 1, 0, { ...s, url: r, otherAcc: true, forced: true }); return tryIdx(i + 1); }
          return;
        }
        if (!user && pos < 0.5 && Date.now() - t0 < 45000 && !played) {
          // Account vol? Dan dezelfde versie via het andere account, anders meteen de volgende versie
          if (!s.url && !s.otherAcc) return window.TVBackend.failed(picked, path, true).then(alt => {
            if (run !== playRun) return;
            if (alt) sources.splice(i + 1, 0, { ...s, url: alt, otherAcc: true, forced: true });
            tryIdx(i + 1);
          });
          return tryIdx(i + 1);
        }
        window.TVBackend.release(picked, true);
        if (o.hist && pos > 5) saveHist({ ...o.hist, pos, dur: dur || o.duration || 0 });
      },
      // Tussendoor bewaren (elke 10 s): ook als de app wordt afgesloten of de telefoon uitvalt, weet hij waar je was
      progress: (pos, dur) => { played = true; if (dur > 0) lastDur = dur; if (o.hist && pos > 5) saveHist({ ...o.hist, pos, dur: dur || lastDur }); },
      // Afgelopen: als "helemaal gezien" bewaren (ook als de lengte onbekend was), zodat verder kijken de volgende aflevering neemt
      ended: () => { window.TVBackend.release(picked, true); if (o.hist) { const d = lastDur || 1; saveHist({ ...o.hist, pos: d, dur: d }); } if (o.next) setTimeout(o.next, 600); },
    }, true);
  };
  tryIdx(0);
};

// Terugkijken: rechtstreeks het programma van die dag bij de aanbieder
playArchive = async function (ch, p, dayLabel) {
  const at = p.at.replace(' ', ':').replace(/:(\d\d)$/, '-$1');
  const dur = Math.max(1, Math.ceil((p.e - p.s) / 60)) + 2;
  const url = await window.TVBackend.pick(`timeshift/${dur}/${at}/${ch.id}.m3u8`, true);
  playVod({ kind: 'archive', url, start: 0, duration: 0, title: p.t, sub: `${tidyName(ch.n)} · ${dayLabel} ${hhmm(p.s)}`, favKey: null, hist: null });
};
})();
