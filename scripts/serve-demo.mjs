import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../tests/fixtures/', import.meta.url);
const allowed = new Set(['index.html', 'demo.css', 'demo.js', 'ambiguous.html', 'french.html']);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!allowed.has(name)) { response.writeHead(404).end('Not found'); return; }
  try {
    const body = await readFile(new URL(name, root));
    response.writeHead(200, { 'Content-Type': types[name.slice(name.lastIndexOf('.'))], 'Cache-Control': 'no-store' });
    response.end(body);
  } catch { response.writeHead(500).end('Could not read the demo page.'); }
});
server.listen(4173, '127.0.0.1', () => console.log(`Price Converter demo: http://127.0.0.1:4173 (${fileURLToPath(root)})`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
