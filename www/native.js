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

const src = (kind, id, ext) => { const d = window.TVBackend.direct(); return `${d.base}/${kind}/${d.creds}/${id}.${ext}`; };
const APPLE_EXT = /^(mp4|m4v|mov|m3u8)$/i;

let cur = null;
const done = (pos, ended) => { const c = cur; cur = null; if (!c) return; if (ended) c.ended?.(); else c.exit?.(pos); };
AV?.addListener('jeepCapVideoPlayerReady', () => { if (cur?.start > 5) AV.setCurrentTime({ playerId: 'fullscreen', seektime: cur.start }).catch(() => {}); });
AV?.addListener('jeepCapVideoPlayerExit', d => done(Number(d?.currentTime) || 0, false));
AV?.addListener('jeepCapVideoPlayerEnded', () => done(0, true));
VLC?.addListener('exit', d => done(Number(d?.currentTime) || 0, false));
VLC?.addListener('ended', () => done(0, true));

async function withVLC(o) {
  cur = o;
  try { await VLC.play({ url: o.url, title: o.title || '', start: o.start || 0 }); }
  catch { cur = null; toast('Afspelen lukt niet'); }
}
async function withApple(o) {
  const t0 = Date.now();
  // Meteen weer dicht zonder beeld? Dan was dit formaat niets voor Apple's speler: VLC proberen
  cur = { ...o, exit: pos => { if (VLC && pos < 0.5 && Date.now() - t0 < 20000) { withVLC(o); } else o.exit?.(pos); } };
  try {
    const r = await AV.initPlayer({
      mode: 'fullscreen', playerId: 'fullscreen', componentTag: 'div', url: o.url,
      displayMode: 'landscape', exitOnEnd: true, pipEnabled: true, bkmodeEnabled: true, showControls: true,
      title: o.title || '', smallTitle: o.sub || '',
    });
    if (r && r.result === false) throw new Error(r.message);
  } catch { if (VLC) withVLC(o); else { cur = null; toast('Afspelen lukt niet'); } }
}
const play = (o, preferVLC) => (preferVLC || !AV) && VLC ? withVLC(o) : withApple(o);

// Antwoordt een bron? Binnen ~4 seconden weten, zonder de speler te openen (dat duurde bij een kapotte bron lang).
// Films: alleen de eerste 2 bytes opvragen (de aanbieder kent geen HEAD). Afspeellijsten (.m3u8): ook het eerste stukje erachter controleren,
// want bij de "HQ"-versies werkt de lijst vaak wel maar de server met het beeld niet.
const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('traag')), ms))]);
async function alive(url, depth = 0) {
  try {
    const playlist = /\.m3u8(\?|$)/i.test(url) || depth > 0;
    const r = await within(fetch(url, playlist ? {} : { headers: { Range: 'bytes=0-1' } }), depth ? 3000 : 4000);
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
playLive = function (item, ctx) {
  const sources = [item.id, ...(item.alt || [])];
  const k = favKey('live', item.id);
  items.set(k, { ...item, type: 'live' });
  saveHist({ k, type: 'live', id: item.id, n: item.n, i: item.i, alt: item.alt });
  countView(k, item);
  const tryIdx = async i => {
    // Kapotte bron? Meteen de volgende, zonder eerst de speler te openen
    if (i + 1 < sources.length && !(await alive(src('live', sources[i], 'm3u8')))) return tryIdx(i + 1);
    if (i > 0) toast('Andere bron geprobeerd');
    const t0 = Date.now();
    play({
      url: src('live', sources[i], 'm3u8'), title: tidyName(item.n), sub: 'Live',
      exit: pos => { if (pos < 0.5 && Date.now() - t0 < 40000 && i + 1 < sources.length) tryIdx(i + 1); },
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
  hideSheet(); const li = layers.indexOf(hideSheet); if (li >= 0) layers.splice(li, 1);
  countView(o.favKey, o.item);
  const sources = o.url ? [{ url: o.url }] : [{ id: o.id, e: o.ext, hq: o.item?.hq }];
  if (!o.url && o.kind === 'movie') for (const a of o.item?.alt || []) if (typeof a === 'object') sources.push({ id: a.id, e: a.e });
  let seriesAlts = !o.url && o.kind === 'series' && o.hist?.ep ? (o.item?.alt || []).filter(a => typeof a === 'object').map(a => a.id) : [];
  let askedAlts = false;
  const tryIdx = async i => {
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
      toast('Deze film/aflevering werkt nu niet. Probeer het later opnieuw.'); return;
    }
    const url = s.url || src(o.kind, s.id, s.e);
    if (!s.url && !s.forced && !(await alive(url))) { s.dead = true; return tryIdx(i + 1); }
    if (i > 0) toast('Andere versie geprobeerd');
    const t0 = Date.now();
    play({
      url, title: o.title, sub: o.sub || '', start: o.start || 0,
      exit: pos => {
        if (pos < 0.5 && Date.now() - t0 < 45000) return tryIdx(i + 1);
        if (o.hist && pos > 5) saveHist({ ...o.hist, pos, dur: o.duration || 0 });
      },
      ended: () => { if (o.hist) saveHist({ ...o.hist, pos: o.duration || 0, dur: o.duration || 0 }); if (o.next) setTimeout(o.next, 600); },
    }, !s.url && (!APPLE_EXT.test(s.e || '') || s.hq));
  };
  tryIdx(0);
};

// Terugkijken: rechtstreeks het programma van die dag bij de aanbieder
playArchive = function (ch, p, dayLabel) {
  const at = p.at.replace(' ', ':').replace(/:(\d\d)$/, '-$1');
  const dur = Math.max(1, Math.ceil((p.e - p.s) / 60)) + 2;
  const d = window.TVBackend.direct();
  playVod({ kind: 'archive', url: `${d.base}/timeshift/${d.creds}/${dur}/${at}/${ch.id}.m3u8`, start: 0, duration: 0, title: p.t, sub: `${tidyName(ch.n)} · ${dayLabel} ${hhmm(p.s)}`, favKey: null, hist: null });
};
})();
