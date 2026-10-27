// Test het brein van de iPhone-app op de pc (zonder iPhone): node scripts/test-backend.js <server> <gebruiker> <wachtwoord>
const fs = require('fs'), path = require('path'), vm = require('vm');
const [server, username, password] = process.argv.slice(2);
if (!password) { console.log('Gebruik: node scripts/test-backend.js <server> <gebruiker> <wachtwoord>'); process.exit(1); }
globalThis.window = globalThis;
globalThis.location = { search: '?app' };
const store = new Map();
globalThis.localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'www', 'backend.js'), 'utf8'));
const get = async (u, init) => { const t0 = Date.now(); const r = await fetch(u, init); const j = await r.json(); return [j, Date.now() - t0, r.status]; };
(async () => {
  console.log('login', (await get('/api/login', { method: 'POST', body: JSON.stringify({ server, username, password }) }))[0]);
  const [home, ms1] = await get('/api/home?type=live');
  console.log(`live (${ms1} ms):`, home.nl.slice(0, 4).map(r => `${r.title} ${r.items.length}`).join(' | '));
  const [rows, ms2] = await get('/api/rows?type=vod');
  console.log(`films (${ms2} ms):`, rows.slice(0, 6).map(r => `${r.name} ${r.total}`).join(' | '));
  const [srows, ms3] = await get('/api/rows?type=series');
  console.log(`series (${ms3} ms):`, srows.slice(0, 4).map(r => `${r.name} ${r.total}`).join(' | '));
  const [s, ms4] = await get('/api/search?q=zigo%20sprot');
  console.log(`zoeken (${ms4} ms):`, s.live.slice(0, 3).map(x => x.n).join(', '));
  const [top] = await get('/api/top?type=vod');
  console.log('top10 films:', top.map(x => x.n).slice(0, 5).join(', '));
  const [ch] = await get('/api/archive/channels');
  const d = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const [day] = await get(`/api/archive/day?id=${ch[0].id}&date=${d}`);
  console.log('terugkijken:', ch.length, 'zenders,', ch[0].n, d, day.length, 'programma\'s');
  const [epg] = await get('/api/epg?id=' + home.nl[0].items[0].id);
  console.log('epg:', epg[0]?.t);
  const [p] = await get('/api/profiles', { method: 'POST', body: JSON.stringify({ name: 'Test' }) });
  const [fav, , st] = await get('/api/me/favs', { headers: { 'X-Profile': p.id } });
  console.log('profiel + lijst:', p.name, st, JSON.stringify(fav));
  process.exit(0);
})().catch(e => { console.error('FOUT', e); process.exit(1); });
