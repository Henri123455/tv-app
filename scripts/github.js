// Zet deze map op GitHub en start het bouwen — zonder git of andere programma's.
// Inloggen gaat veilig via GitHub zelf: je krijgt een code die je invult op github.com/login/device.
// (We gebruiken daarvoor dezelfde inlogmethode als het officiële GitHub CLI-programma.)
// Gebruik: node scripts/github.js [repo-naam]
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const REPO = process.argv[2] || 'tv-app';
const TOKEN_FILE = path.join(ROOT, '.github-token');
const CLIENT_ID = '178c6fc778ccc68e1d6a'; // GitHub CLI (openbare device-login)
const SKIP = /^(node_modules|ios|android|\.git)(\/|$)|^\.github-token$|\.ipa$/;

const gh = async (method, url, body) => {
  const r = await fetch(url.startsWith('http') ? url : 'https://api.github.com' + url, {
    method, headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'tv-app', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const j = text ? JSON.parse(text) : {};
  if (!r.ok) { const e = new Error(`${method} ${url}: ${r.status} ${j.message || ''}`); e.status = r.status; throw e; }
  return j;
};
let token = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : '';

async function login() {
  const form = (o) => new URLSearchParams(o).toString();
  const d = await (await fetch('https://github.com/login/device/code', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ client_id: CLIENT_ID, scope: 'repo workflow' }) })).json();
  console.log(`CODE: ${d.user_code}`);
  console.log(`Open ${d.verification_uri} en vul de code in.`);
  let wait = (d.interval || 5) * 1000;
  for (;;) {
    await new Promise(r => setTimeout(r, wait));
    const t = await (await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ client_id: CLIENT_ID, device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) })).json();
    if (t.access_token) { token = t.access_token; fs.writeFileSync(TOKEN_FILE, token); return; }
    if (t.error === 'slow_down') wait += 5000;
    else if (t.error !== 'authorization_pending') throw new Error('Inloggen mislukt: ' + t.error);
  }
}

function files(dir = ROOT, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (SKIP.test(r)) continue;
    if (e.isDirectory()) out.push(...files(path.join(dir, e.name), r)); else out.push(r);
  }
  return out;
}

(async () => {
  if (token) { try { await gh('GET', '/user'); } catch { token = ''; } }
  if (!token) await login();
  const me = await gh('GET', '/user');
  console.log('Ingelogd als', me.login);
  let repo;
  try { repo = await gh('GET', `/repos/${me.login}/${REPO}`); }
  catch { repo = await gh('POST', '/user/repos', { name: REPO, description: 'TV — iPhone-app (IPTV-speler in Apple TV-stijl)', private: false, auto_init: true }); console.log('Repository gemaakt'); await new Promise(r => setTimeout(r, 3000)); }
  const full = repo.full_name, branch = repo.default_branch || 'main';
  // Alles in één keer als één nieuwe versie (commit)
  const ref = await gh('GET', `/repos/${full}/git/ref/heads/${branch}`);
  const parent = await gh('GET', `/repos/${full}/git/commits/${ref.object.sha}`);
  const tree = [];
  for (const f of files()) {
    const blob = await gh('POST', `/repos/${full}/git/blobs`, { content: fs.readFileSync(path.join(ROOT, f)).toString('base64'), encoding: 'base64' });
    tree.push({ path: f, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const t = await gh('POST', `/repos/${full}/git/trees`, { base_tree: parent.tree.sha, tree });
  const c = await gh('POST', `/repos/${full}/git/commits`, { message: 'TV-app bijgewerkt', tree: t.sha, parents: [ref.object.sha] });
  await gh('PATCH', `/repos/${full}/git/refs/heads/${branch}`, { sha: c.sha });
  console.log(`${tree.length} bestanden geüpload naar https://github.com/${full}`);
  // Netflix-cijfers één keer meteen ophalen (daarna elke ochtend vanzelf); de app-bouw start vanzelf door de upload
  await new Promise(r => setTimeout(r, 5000));
  try { await gh('POST', `/repos/${full}/actions/workflows/netflix-nl.yml/dispatches`, { ref: branch }); } catch (e) { console.log('Netflix-taak later starten:', e.message); }
  console.log('REPO: ' + full);
})().catch(e => { console.error('FOUT', e.message); process.exit(1); });
