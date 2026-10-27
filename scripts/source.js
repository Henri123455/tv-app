// Maakt data/source.json: een "bron" voor SideStore. Wie die bron toevoegt, ziet TV in SideStore
// met een Installeer-knop, en krijgt nieuwe versies vanzelf als update.
// Gebruik (door GitHub na het bouwen): node scripts/source.js <versie> <grootte-in-bytes> <eigenaar/repo>
const fs = require('fs'), path = require('path');
const [version, size, repo] = process.argv.slice(2);
const raw = `https://raw.githubusercontent.com/${repo}/main`;
const source = {
  name: 'TV',
  identifier: `io.github.${repo.split('/')[0].toLowerCase()}.tv`,
  subtitle: 'Live tv, films en series in Apple TV-stijl',
  iconURL: `${raw}/resources/icon-1024.png`,
  apps: [{
    name: 'TV',
    bundleIdentifier: 'nl.tvapp.speler',
    developerName: repo.split('/')[0],
    subtitle: 'Live tv, films en series',
    localizedDescription: 'IPTV-speler in Apple TV-stijl: Nederland bovenaan, één beste versie per zender, terugkijken, Top 10 en Apple\'s eigen speler.',
    iconURL: `${raw}/resources/icon-1024.png`,
    tintColor: '5E5CE6',
    versions: [{
      version,
      date: new Date().toISOString(),
      size: Number(size),
      downloadURL: `https://github.com/${repo}/releases/download/v${version}/TV.ipa`,
      minOSVersion: '15.0',
    }],
  }],
};
const out = path.join(__dirname, '..', 'data', 'source.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(source, null, 2));
console.log('SideStore-bron:', version);
