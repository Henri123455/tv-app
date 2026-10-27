// Maakt de map www/ voor de iPhone-app uit de pc-app (../iptv-app):
//  - de schermen (index.html, app.js, style.css, icoon) worden gekopieerd
//  - backend.js = kop + de gedeelde logica uit server.js + staart (zelfde slimmigheid als de pc-app)
//  - native.js koppelt Apple's eigen speler
// Gebruik: node scripts/build.js   (draai dit op de pc na een wijziging in de pc-app, en zet www/ op GitHub)
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PC = path.join(ROOT, '..', 'iptv-app');
const WWW = path.join(ROOT, 'www');
const read = f => fs.readFileSync(f, 'utf8');

fs.mkdirSync(WWW, { recursive: true });
for (const f of ['app.js', 'style.css', 'icon.svg', 'icon.png', 'apple-touch-icon.png']) fs.copyFileSync(path.join(PC, 'public', f), path.join(WWW, f));

// Gedeelde logica: van "Namen opschonen" tot (niet met) "Profielen" uit server.js
const server = read(path.join(PC, 'server.js'));
const start = server.indexOf('// ---------- Namen opschonen ----------');
const end = server.indexOf('// ---------- Profielen');
if (start < 0 || end < 0) throw new Error('Markeringen in server.js niet gevonden');
const core = server.slice(start, end);
// Controle: geen Node-onderdelen (behalve decodeB64, die in de staart vervangen wordt)
const bad = core.split('\n').filter(l => /\b(fs|process|os|zlib|spawn|execFileSync)\.|require\(/.test(l));
if (bad.length) throw new Error('Node-code in gedeelde logica:\n' + bad.join('\n'));
fs.writeFileSync(path.join(WWW, 'backend.js'),
  read(path.join(ROOT, 'src', 'backend-head.js')) + core + read(path.join(ROOT, 'src', 'backend-tail.js')));
fs.copyFileSync(path.join(ROOT, 'src', 'native.js'), path.join(WWW, 'native.js'));
fs.copyFileSync(path.join(ROOT, 'src', 'vendor', 'capacitor.js'), path.join(WWW, 'capacitor.js')); // @capacitor/core 6.2.2 (registerPlugin)
if (!fs.existsSync(path.join(WWW, 'build-info.js'))) fs.writeFileSync(path.join(WWW, 'build-info.js'), "window.TV_REPO = '';\n");

// index.html: scripts erbij (backend vóór app.js, speler erna), geen pc-onderdelen
let html = read(path.join(PC, 'public', 'index.html')).replace(/^﻿/, '');
html = html.replace(/<script src="app\.js[^"]*"><\/script>/, '<script src="capacitor.js"></script>\n<script src="build-info.js"></script>\n<script src="backend.js"></script>\n<script src="app.js"></script>\n<script src="native.js"></script>');
html = html.replace(/<link rel="manifest"[^>]*>\n?/, '');
fs.writeFileSync(path.join(WWW, 'index.html'), html);
console.log('www/ klaar:', fs.readdirSync(WWW).join(', '));
