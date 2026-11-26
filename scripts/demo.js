import { createServer } from 'node:http';

const port = 8765;
const base = '/webrequest-mv3/';
createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === base) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(`<title>webRequest MV3 demo</title><h1>webRequest MV3 demo</h1>
      <p><a href="blocked">Blocked navigation</a> should not reach the server.</p>
      <p><a href="old">Redirect</a> should land on the headers page.</p>
      <p><a href="headers">Headers</a> should echo MV3. Inspect X-Demo-Response in DevTools.</p>`);
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (req.url === base + 'headers') return res.end(`X-Demo-Request: ${req.headers['x-demo-request'] || '(absent)'}\n`);
  res.writeHead(404);
  res.end('No demo rule handled this path. Is the extension loaded?\n');
}).listen(port, '127.0.0.1', () => console.log(`Open http://127.0.0.1:${port}${base}`));
