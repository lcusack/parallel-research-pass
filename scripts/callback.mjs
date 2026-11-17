import { createServer } from 'node:http';

// Registration-only callback page. No authorization codes, tokens, or queries are logged or processed.
// The real prototype uses the device flow and keeps its research backend on a separate private port.
createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (req.method !== 'GET' || path !== '/auth/world/callback') {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  res.end('Parallel Research Pass\n\nThis prototype uses World ID device verification. Return to your agent to check verification and continue. This registration callback does not process browser authorization codes.\n');
}).listen(8792, '127.0.0.1', () => console.error('Registration callback page listening on port 8792'));
