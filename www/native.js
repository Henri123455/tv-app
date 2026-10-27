// TV — afspelen in de iPhone-app met Apple's eigen speler (AVPlayer, net als UHF en de Apple TV-app):
// meteen schermvullend en liggend, met AirPlay en beeld-in-beeld. Streams komen rechtstreeks van de aanbieder.
(function () {
'use strict';
if (!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform())) return;
const VP = Capacitor.Plugins?.CapacitorVideoPlayer || window.capacitorExports?.registerPlugin('CapacitorVideoPlayer');
if (!VP) return;

const src = (kind, id, ext) => { const d = window.TVBackend.direct(); return `${d.base}/${kind}/${d.creds}/${id}.${ext}`; };
// Formaten die Apple's speler zelf aankan; de rest gaat naar de gratis VLC-app
const NATIVE_EXT = /^(mp4|m4v|mov|m3u8)$/i;

let cur = null;
VP.addListener('jeepCapVideoPlayerReady', () => {
  if (cur?.start > 5) VP.setCurrentTime({ playerId: 'fullscreen', seektime: cur.start }).catch(() => {});
});
VP.addListener('jeepCapVideoPlayerExit', d => { const c = cur; cur = null; c?.exit?.(Number(d?.currentTime) || 0); });
VP.addListener('jeepCapVideoPlayerEnded', () => { const c = cur; if (c) c.endedFlag = true; c?.ended?.(); });

async function nativePlay(o) {
  cur = { ...o, t0: Date.now() };
  try {
    const r = await VP.initPlayer({
      mode: 'fullscreen', playerId: 'fullscreen', componentTag: 'div', url: o.url,
      displayMode: 'landscape', exitOnEnd: true, pipEnabled: true, bkmodeEnabled: true, showControls: true,
      title: o.title || '', smallTitle: o.sub || '',
    });
    if (r && r.result === false) throw new Error(r.message);
  } catch (e) { cur = null; toast('Afspelen lukt niet'); }
}

function openInVLC(url) {
  location.href = 'vlc-x-callback://x-callback-url/stream?url=' + encodeURIComponent(url);
  // VLC niet geïnstalleerd? Dan blijft de app in beeld: uitleg tonen
  setTimeout(() => {
    if (document.hidden) return;
    showSheet(`<div class="account"><h2>Dit bestand speelt via VLC</h2>
      <p>Deze film is een .mkv/.avi-bestand. Apple's speler kan dat niet, de gratis app <b>VLC</b> wel (in volle kwaliteit, ook met AirPlay).</p>
      <a class="btn primary" href="https://apps.apple.com/app/vlc-media-player/id650377962">VLC downloaden</a></div>`);
  }, 1500);
}

// Live: beste bron eerst; lukt die niet (meteen weer gesloten zonder beeld), dan vanzelf de volgende
playLive = function (item, ctx) {
  const sources = [item.id, ...(item.alt || [])];
  const k = favKey('live', item.id);
  items.set(k, { ...item, type: 'live' });
  saveHist({ k, type: 'live', id: item.id, n: item.n, i: item.i, alt: item.alt });
  countView(k, item);
  const tryIdx = i => {
    const t0 = Date.now();
    nativePlay({
      url: src('live', sources[i], 'm3u8'), title: tidyName(item.n), sub: 'Live',
      exit: pos => { if (pos < 0.5 && Date.now() - t0 < 20000 && i + 1 < sources.length) { toast('Andere bron geprobeerd'); tryIdx(i + 1); } },
    });
  };
  tryIdx(0);
};

// Films en afleveringen
playVod = function (o) {
  hideSheet(); const li = layers.indexOf(hideSheet); if (li >= 0) layers.splice(li, 1);
  countView(o.favKey, o.item);
  const url = o.url || src(o.kind, o.id, o.ext);
  if (!o.url && !NATIVE_EXT.test(o.ext)) { if (o.hist) saveHist({ ...o.hist, pos: 0, dur: o.duration || 0 }); return openInVLC(url); }
  nativePlay({
    url, title: o.title, sub: o.sub || '', start: o.start || 0,
    exit: pos => { if (o.hist && pos > 5) saveHist({ ...o.hist, pos, dur: o.duration || 0 }); },
    ended: () => { if (o.hist) saveHist({ ...o.hist, pos: o.duration || 0, dur: o.duration || 0 }); if (o.next) setTimeout(o.next, 600); },
  });
};

// Terugkijken: rechtstreeks het programma van die dag bij de aanbieder
playArchive = function (ch, p, dayLabel) {
  const at = p.at.replace(' ', ':').replace(/:(\d\d)$/, '-$1');
  const dur = Math.max(1, Math.ceil((p.e - p.s) / 60)) + 2;
  const d = window.TVBackend.direct();
  playVod({ kind: 'archive', url: `${d.base}/timeshift/${d.creds}/${dur}/${at}/${ch.id}.m3u8`, start: 0, duration: 0, title: p.t, sub: `${tidyName(ch.n)} · ${dayLabel} ${hhmm(p.s)}`, favKey: null, hist: null });
};
})();
