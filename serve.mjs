// dev static server for ASCII CITY:  node serve.mjs [port] [root]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const PORT = +(process.argv[2] || 8123);
const ROOT = process.argv[3] || 'H:/projects/ASCII CITY';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mp3': 'audio/mpeg',
               '.wav': 'audio/wav', '.md': 'text/plain', '.json': 'application/json' };

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const rel = normalize(url === '/' ? 'index.html' : url.slice(1));
    if (rel.startsWith('..')) throw 0;
    const data = await readFile(join(ROOT, rel));
    res.writeHead(200, { 'content-type': MIME[extname(rel)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(PORT, () => console.log('serving on http://localhost:' + PORT));
