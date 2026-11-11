// Standalone catalog review UI (EditPro also serves it under Review > Catalog). Read-only towards Shopify; writes only review/feedback.json.
// Usage: node serve.js   -> http://localhost:5178
const http = require('http');
const fs = require('fs');
const { FB, PAGE, SCRIPT, data, readFeedback, saveFeedback } = require('./data');

const PORT = 5178;

const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, fs.readFileSync(PAGE), 'text/html; charset=utf-8');
    if (url.pathname === '/app.js') return send(res, 200, fs.readFileSync(SCRIPT), 'text/javascript; charset=utf-8');
    if (url.pathname === '/api/data') return send(res, 200, JSON.stringify(data()));
    if (url.pathname === '/api/feedback' && req.method === 'GET') return send(res, 200, readFeedback());
    if (url.pathname === '/api/feedback' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { saveFeedback(JSON.parse(body)); send(res, 200, '{"ok":true}'); }
        catch (e) { send(res, 400, JSON.stringify({ error: e.message })); }
      });
      return;
    }
    if (url.pathname === '/export') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="catalog-feedback.json"' });
      return res.end(readFeedback());
    }
    send(res, 404, 'Not found', 'text/plain');
  } catch (e) { send(res, 500, JSON.stringify({ error: e.message })); }
}).listen(PORT, () => console.log(`Catalog review: http://localhost:${PORT}  (feedback -> ${FB})`));
