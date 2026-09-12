import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve('.');
const types = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.json':'application/json', '.wasm':'application/wasm' };
http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'POST' && /^\/results\/(browser|native|electron)$/.test(pathname)) {
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 1000000) { res.writeHead(413).end(); return; } }
    try { JSON.parse(body); await mkdir('artifacts', {recursive:true}); await writeFile(`artifacts/${pathname.split('/').pop()}-results.json`, body); res.end('saved'); }
    catch { res.writeHead(400).end('invalid JSON'); } return;
  }
  const file = resolve(root, '.' + (pathname === '/' ? '/examples/browser/index.html' : decodeURIComponent(pathname)));
  if (!file.startsWith(root + sep) || /(?:^|\/)\./.test(pathname)) { res.writeHead(403).end(); return; }
  try { res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream'); res.end(await readFile(file)); }
  catch { res.writeHead(404).end('Not found'); }
}).listen(4173, '127.0.0.1', () => console.log('TuneJS: http://127.0.0.1:4173'));
