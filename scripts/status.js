// Laat zien hoe het bouwen op GitHub gaat (en bij een fout de laatste regels van het logboek)
// Gebruik: node scripts/status.js [eigenaar/repo]
const fs = require('fs'), path = require('path');
const token = fs.readFileSync(path.join(__dirname, '..', '.github-token'), 'utf8').trim();
const repo = process.argv[2] || 'Henri123455/tv-app';
const gh = async (u, raw) => { const r = await fetch('https://api.github.com' + u, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'tv-app' } }); return raw ? r.text() : r.json(); };
(async () => {
  const runs = (await gh(`/repos/${repo}/actions/runs?per_page=5`)).workflow_runs || [];
  for (const r of runs) console.log(`${r.name} | ${r.status} | ${r.conclusion || '-'} | ${r.created_at} | id ${r.id}`);
  for (const r of runs.filter(x => x.conclusion === 'failure').slice(0, 1)) {
    const jobs = (await gh(`/repos/${repo}/actions/runs/${r.id}/jobs`)).jobs || [];
    for (const j of jobs) {
      const failed = (j.steps || []).filter(s => s.conclusion === 'failure').map(s => s.name);
      console.log('Mislukte stap:', failed.join(', '));
      const log = await gh(`/repos/${repo}/actions/jobs/${j.id}/logs`, true);
      console.log(log.split('\n').filter(l => /error|Error|failed|FAIL/.test(l)).slice(-25).join('\n'));
    }
  }
  const rel = await gh(`/repos/${repo}/releases/latest`);
  if (rel.assets) console.log('Release:', rel.tag_name, rel.assets.map(a => a.browser_download_url).join(' '));
})();
