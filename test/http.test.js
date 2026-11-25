// -----------------------------------------------------------------------------
// The HTTP transport against real loopback servers: the token in the
// Authorization header only, no redirect followed, the size cap applied before
// the whole body arrives, a deadline for the whole exchange.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { CODES, httpGet } from '../src/sentry/http.js';
import { SentryClient } from '../src/sentry/client.js';

const TOKEN = 'sntryu_http-test-secret';

async function serve(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

test('GET with the token in the Authorization header, our User-Agent, no compression', async (t) => {
  const srv = await serve(t, (req, res) => res.end('[]'));
  const res = await httpGet(`${srv.url}/api/0/x/?a=1`, {
    token: TOKEN,
    timeout: 2000,
    maxBytes: 100,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), '[]');
  const [{ url, headers }] = srv.requests;
  assert.equal(url, '/api/0/x/?a=1');
  assert.equal(headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(headers['accept-encoding'], 'identity');
  assert.match(
    headers['user-agent'],
    /^gladys-sentry\/0\.1\.0 \(\+https:\/\/github\.com\/LM1LC3N7\/gladys-sentry\)$/,
  );
});

test('a redirect is never followed (the token would go along)', async (t) => {
  const other = await serve(t, (req, res) => res.end('[]'));
  const srv = await serve(t, (req, res) => {
    res.writeHead(302, { location: `${other.url}/steal` });
    res.end();
  });
  const client = new SentryClient({ base: srv.url, token: TOKEN, organization: 'acme' });
  await assert.rejects(
    client.projects(),
    (err) => err.code === CODES.REDIRECT && err.status === 302,
  );
  assert.equal(other.requests.length, 0);
});

test('size cap: an announced length above it is refused at once; a chunked body cut when it passes', async (t) => {
  const srv = await serve(t, (req, res) => {
    if (req.url === '/announced') {
      res.writeHead(200, { 'content-length': 1_000_000 });
      res.write('x'.repeat(10)); // the rest never comes: refused on the header
      return;
    }
    res.writeHead(200);
    const timer = setInterval(() => res.write('x'.repeat(1000)), 1);
    res.on('close', () => clearInterval(timer));
  });
  const started = performance.now();
  await assert.rejects(
    httpGet(`${srv.url}/announced`, { token: TOKEN, timeout: 5000, maxBytes: 1000 }),
    (err) => err.code === CODES.TOO_LARGE,
  );
  await assert.rejects(
    httpGet(`${srv.url}/chunked`, { token: TOKEN, timeout: 5000, maxBytes: 5000 }),
    (err) => err.code === CODES.TOO_LARGE,
  );
  assert.ok(performance.now() - started < 4000);
});

test('a server that never answers: rejected at the deadline, the socket closed', async (t) => {
  const srv = await serve(t, () => {});
  const started = performance.now();
  await assert.rejects(
    httpGet(`${srv.url}/`, { token: TOKEN, timeout: 300, maxBytes: 100 }),
    (err) => err.code === CODES.TIMEOUT && !err.message.includes(TOKEN),
  );
  assert.ok(performance.now() - started < 2000);
});

test('https to something that is not TLS: refused, the token never sent in clear', async (t) => {
  const received = [];
  const server = net.createServer((socket) => {
    socket.on('data', (d) => received.push(d));
    socket.on('error', () => {});
    socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n[]');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  await assert.rejects(
    httpGet(`https://127.0.0.1:${server.address().port}/`, {
      token: TOKEN,
      timeout: 2000,
      maxBytes: 100,
    }),
    (err) => err.code === CODES.UNREACHABLE,
  );
  assert.ok(!Buffer.concat(received).toString('latin1').includes(TOKEN));
});

test('an error status keeps the status, never the body (it may quote the token)', async (t) => {
  const srv = await serve(t, (req, res) => {
    res.writeHead(500);
    res.end(`{"detail": "bad token ${TOKEN}"}`);
  });
  const client = new SentryClient({ base: srv.url, token: TOKEN, organization: 'acme' });
  await assert.rejects(client.issues('1'), (err) => {
    assert.equal(err.status, 500);
    assert.ok(!JSON.stringify({ ...err, message: err.message }).includes(TOKEN));
    return true;
  });
});

test('a closed client cuts the request in flight', async (t) => {
  const srv = await serve(t, () => {});
  const client = new SentryClient({ base: srv.url, token: TOKEN, organization: 'acme' });
  const pending = client.issues('1');
  const deadline = performance.now() + 2000;
  while (srv.requests.length === 0 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const started = performance.now();
  client.close();
  await assert.rejects(pending, (err) => err.code === CODES.CLOSED);
  assert.ok(performance.now() - started < 1000);
  await assert.rejects(client.issues('1'), (err) => err.code === CODES.CLOSED);
  assert.equal(srv.requests.length, 1);
});

test('https with a certificate no authority signed: refused before any request (token never sent)', async (t) => {
  const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  const requests = [];
  const server = https.createServer(
    { key: fixture('selfsigned.key'), cert: fixture('selfsigned.crt') },
    (req, res) => {
      requests.push(req.headers);
      res.end('[]');
    },
  );
  server.on('tlsClientError', () => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  });
  await assert.rejects(
    httpGet(`https://127.0.0.1:${server.address().port}/api/0/`, {
      token: TOKEN,
      timeout: 2000,
      maxBytes: 100,
    }),
    (err) => err.code === CODES.UNREACHABLE,
  );
  assert.equal(requests.length, 0);
});
