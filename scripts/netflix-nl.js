// Wat er in Nederland deze week bekeken wordt, elke dag klaargezet in data/netflix-nl.json:
//  - de officiële Netflix Top 10 van Nederland (laatste weken, deze week veruit het zwaarst)
//  - de trending-lijst van JustWatch voor Nederland (alle diensten: Netflix, Videoland, Prime, Disney+, HBO, bioscoop …)
// De app zet daarmee per categorie vooraan wat mensen nu leuk vinden.
const fs = require('fs'), path = require('path');
const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const titleKey = n => fold(n).replace(/\[[^\]]*\]/g, '').replace(/\b(hq|qhd|4k|uhd|fhd|nl gesproken|dubbed|cam versie|hdcam|cam|telesync|hdts)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const popKey = n => titleKey(n).replace(/\b(19|20)\d\d\b/g, '').replace(/\s+/g, ' ').trim();
const add = (m, k, v) => { if (k) m.set(k, (m.get(k) || 0) + v); };

// Nederland telt volledig, Belgie half, de rest van West-Europa een beetje: samen "wat Nederlanders/Europeanen nu kijken".
// Deze week telt het zwaarst (vorige week nog maar een kwart).
const EUROPE = { NL: 1, BE: 0.5, DE: 0.25, FR: 0.2, GB: 0.25, ES: 0.15, IT: 0.15, AT: 0.15, CH: 0.15, DK: 0.1, SE: 0.1, NO: 0.1, PL: 0.1, IE: 0.1, PT: 0.1 };
async function netflix(films, tv) {
  const r = await fetch('https://www.netflix.com/tudum/top10/data/all-weeks-countries.tsv');
  if (!r.ok) throw new Error('Netflix gaf ' + r.status);
  const rows = (await r.text()).split('\n').map(l => l.split('\t')).filter(x => EUROPE[x[1]]);
  const latest = rows.reduce((m, x) => x[2] > m ? x[2] : m, '');
  for (const [, code, week, catg, rank, title] of rows) {
    const ageWeeks = (Date.parse(latest) - Date.parse(week)) / (7 * 864e5);
    if (ageWeeks > 3) continue;
    add(catg === 'Films' ? films : tv, popKey(title), (11 - Number(rank)) * EUROPE[code] * Math.pow(0.25, ageWeeks));
  }
  return latest;
}

const JW_QUERY = `query P($country: Country!, $first: Int!, $after: String, $filter: TitleFilter) {
  popularTitles(country: $country, first: $first, after: $after, filter: $filter, sortBy: TRENDING) {
    pageInfo { endCursor hasNextPage }
    edges { node { content(country: $country, language: "en") { title originalTitle } } }
  } }`;
async function justwatch(type, m, country = 'NL', weight = 1, total = 400) {
  let after = null, rank = 0;
  while (rank < total) {
    const r = await fetch('https://apis.justwatch.com/graphql', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: JW_QUERY, variables: { country, first: 100, after, filter: { objectTypes: [type] } } }),
    });
    if (!r.ok) throw new Error('JustWatch gaf ' + r.status);
    const p = (await r.json()).data.popularTitles;
    for (const { node } of p.edges) {
      const v = 10 * weight * (1 - rank / total), keys = new Set([popKey(node.content.title), popKey(node.content.originalTitle)]);
      for (const k of keys) add(m, k, v);
      rank++;
    }
    if (!p.pageInfo.hasNextPage) break;
    after = p.pageInfo.endCursor;
  }
  return rank;
}

(async () => {
  const films = new Map(), tv = new Map();
  const week = await netflix(films, tv).catch(e => { console.error(e.message); return ''; });
  const nf = films.size + tv.size;
  const jw = await Promise.all([justwatch('MOVIE', films), justwatch('SHOW', tv)]).catch(e => { console.error(e.message); return [0, 0]; });
  // Trending in Belgie, Duitsland en het VK telt mee (minder zwaar dan Nederland)
  for (const [country, w] of [['BE', 0.5], ['DE', 0.3], ['GB', 0.3]])
    await Promise.all([justwatch('MOVIE', films, country, w, 200), justwatch('SHOW', tv, country, w, 200)]).catch(e => console.error(country, e.message));
  if (!nf && !jw[0]) throw new Error('Geen cijfers');
  const out = path.join(__dirname, '..', 'data', 'netflix-nl.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(out, JSON.stringify({ t: Date.parse(day), week, day, films: [...films].map(([k, v]) => [k, +v.toFixed(2)]), tv: [...tv].map(([k, v]) => [k, +v.toFixed(2)]) }));
  console.log(`${day}: Netflix week ${week}, JustWatch ${jw[0]} films / ${jw[1]} series -> ${films.size} films, ${tv.size} series`);
})().catch(e => { console.error(e); process.exit(1); });
