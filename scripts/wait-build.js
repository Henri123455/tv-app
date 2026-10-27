// Wacht tot de nieuwste "iPhone-app bouwen" klaar is en meldt de uitkomst (max. 40 minuten)
const fs = require('fs'), path = require('path');
const token = fs.readFileSync(path.join(__dirname, '..', '.github-token'), 'utf8').trim();
const repo = process.argv[2] || 'Henri123455/tv-app';
const gh = async u => (await fetch('https://api.github.com' + u, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'tv-app' } })).json();
(async () => {
  for (let i = 0; i < 80; i++) {
    const run = ((await gh(`/repos/${repo}/actions/workflows/iphone-app.yml/runs?per_page=1`)).workflow_runs || [])[0];
    if (run && run.status === 'completed') { console.log('KLAAR:', run.conclusion, run.html_url); return; }
    await new Promise(r => setTimeout(r, 30000));
  }
  console.log('Nog niet klaar na 40 minuten');
})();
