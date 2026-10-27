// Haalt de officiële Netflix Top 10 per land op en bewaart de Nederlandse cijfers (laatste ~26 weken,
// recent zwaarder) in data/netflix-nl.json. Zelfde berekening als in de pc-app.
const fs = require('fs'), path = require('path');
const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const titleKey = n => fold(n).replace(/\[[^\]]*\]/g, '').replace(/\b(hq|qhd|4k|uhd|fhd|nl gesproken|dubbed)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const popKey = n => titleKey(n).replace(/\b(19|20)\d\d\b/g, '').replace(/\s+/g, ' ').trim();
(async () => {
  const r = await fetch('https://www.netflix.com/tudum/top10/data/all-weeks-countries.tsv');
  if (!r.ok) throw new Error('Netflix gaf ' + r.status);
  const rows = (await r.text()).split('\n').filter(l => l.startsWith('Netherlands\tNL\t')).map(l => l.split('\t'));
  const latest = rows.reduce((m, x) => x[2] > m ? x[2] : m, '');
  const films = new Map(), tv = new Map();
  for (const [, , week, catg, rank, title] of rows) {
    const ageWeeks = (Date.parse(latest) - Date.parse(week)) / (7 * 864e5);
    if (ageWeeks > 26) continue;
    const m = catg === 'Films' ? films : tv, k = popKey(title);
    m.set(k, (m.get(k) || 0) + (11 - Number(rank)) * Math.pow(0.5, ageWeeks / 3));
  }
  const out = path.join(__dirname, '..', 'data', 'netflix-nl.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // t = de week: verandert alleen als Netflix nieuwe cijfers heeft (dan pas een nieuwe versie in de repo)
  fs.writeFileSync(out, JSON.stringify({ t: Date.parse(latest), week: latest, films: [...films], tv: [...tv] }));
  console.log(`Week ${latest}: ${films.size} films, ${tv.size} series`);
})().catch(e => { console.error(e); process.exit(1); });
