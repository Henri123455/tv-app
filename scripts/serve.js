// Kleine webserver om www/ op de pc te bekijken (open http://localhost:8790/?app om de app-modus te testen)
const http = require('http'), fs = require('fs'), path = require('path');
const WWW = path.join(__dirname, '..', 'www');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(WWW, p === '/' ? 'index.html' : p));
  if (!file.startsWith(WWW)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}).listen(Number(process.env.PORT) || 8790, () => console.log('www op http://localhost:' + (process.env.PORT || 8790) + '/?app'));
