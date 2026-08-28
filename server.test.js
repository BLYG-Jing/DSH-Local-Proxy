'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const test = require('node:test');
const zlib = require('node:zlib');
const {
  AUTH_COOKIE, createProxyServer, patchConnectionPlugin, preferredEncoding, isImmutableStaticRequest, bootPluginUrls,
} = require('./server');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          rawBody,
          body: rawBody.toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function readEventStream(port, cookie) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      error ? reject(error) : resolve(value);
    };
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: '/plugins/events',
      headers: { cookie },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => {
        chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        if (!body.includes(': proxy-heartbeat')) return;
        req.destroy();
        finish(null, { status: res.statusCode, headers: res.headers, body });
      });
    });
    req.setTimeout(2000, () => req.destroy(new Error('event stream timeout')));
    req.on('error', (error) => finish(error));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextSocketData(socket, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('socket data timeout'));
    }, timeoutMs);
    const onData = (chunk) => {
      cleanup();
      resolve(chunk.toString('utf8'));
    };
    const onClose = () => {
      cleanup();
      reject(new Error('socket closed before data'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
    };
    socket.once('data', onData);
    socket.once('close', onClose);
  });
}

function openWebSocketTunnel(port, cookie, path = '/api/events.mux') {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let response = '';
    const onData = (chunk) => {
      response += chunk.toString('latin1');
      if (!response.includes('\r\n\r\n')) return;
      socket.off('data', onData);
      resolve({ socket, response });
    };
    socket.setTimeout(2000, () => socket.destroy(new Error('websocket open timeout')));
    socket.once('connect', () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dW5pdC10ZXN0LWtleQ==',
        `Cookie: ${cookie}`,
        '', '',
      ].join('\r\n'));
    });
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

function websocketAttempt(port, cookie = '') {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    socket.setTimeout(2000, () => socket.destroy(new Error('socket timeout')));
    socket.once('connect', () => {
      socket.write([
        'GET /socket HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        ...(cookie ? [`Cookie: ${cookie}`] : []),
        '', '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.once('error', reject);
  });
}

test('server refuses to start without an explicit password', () => {
  assert.throws(
    () => createProxyServer({ password: '' }),
    /AUTH_PASSWORD must be set to a non-empty value/
  );
});

test('content encoding negotiation honors quality values and safe canonical static URLs', () => {
  assert.equal(preferredEncoding('gzip, br'), 'br');
  assert.equal(preferredEncoding('br;q=0, gzip;q=0.8'), 'gzip');
  assert.equal(preferredEncoding('gzip;q=0.2, br;q=0.7'), 'br');
  assert.equal(preferredEncoding('*;q=0.4'), 'br');
  assert.equal(preferredEncoding('br;q=0, gzip;q=0'), null);
  const trusted = new Set(['/plugins/example/client.js?rev=abcdef123456']);
  assert.equal(isImmutableStaticRequest('/assets/index-AbCdEf123.js', '/assets/index-AbCdEf123.js', trusted), true);
  assert.equal(isImmutableStaticRequest('/assets/index-AbCdEf123.js?x=1', '/assets/index-AbCdEf123.js', trusted), false);
  assert.equal(isImmutableStaticRequest('/plugins/example/client.js?rev=abcdef123456', '/plugins/example/client.js', trusted), true);
  assert.equal(isImmutableStaticRequest('/plugins/example/client.js?rev=aaaaaaaaaaaa', '/plugins/example/client.js', trusted), false);
  assert.equal(isImmutableStaticRequest('/plugins/example/client.js?rev=abcdef123456&x=1', '/plugins/example/client.js', trusted), false);
  assert.equal(isImmutableStaticRequest('/plugins/example/client.js?rev=abcdef123456&rev=abcdef123456', '/plugins/example/client.js', trusted), false);
  assert.equal(isImmutableStaticRequest('/plugins/@deepseek-ai/dsh-client-connection/client.js?rev=abcdef123456', '/plugins/@deepseek-ai/dsh-client-connection/client.js', trusted), false);
  const graph = Buffer.from('<script>globalThis["__DSH_BOOT__"] = {"entries":[{"url":"/plugins/example/client.js?rev=abcdef123456"}]};</script>');
  assert.deepEqual([...bootPluginUrls(graph)], ['/plugins/example/client.js?rev=abcdef123456']);
});

test('authenticated static responses stream compressed and receive conservative cache policies', async (t) => {
  const javascript = 'const payload = "' + 'compress-me-'.repeat(400) + '";\n';
  const connectionSource = [
    'function isLoopbackHostname(hostname) { return hostname === "localhost"; }',
    'const api = new WebApiClient();',
    'const padding = "' + 'connection-'.repeat(300) + '";',
  ].join('\n');
  const upstream = http.createServer((req, res) => {
    if (req.url === '/') {
      assert.equal(req.headers['accept-encoding'], 'identity');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<html><head><script>globalThis["__DSH_BOOT__"] = {"entries":[{"url":"/plugins/example/client.js?rev=abcdef123456"}]};</script></head><body></body></html>');
    }
    if (req.url.startsWith('/plugins/@deepseek-ai/dsh-client-connection/client.js')) {
      assert.equal(req.headers['accept-encoding'], 'identity');
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(connectionSource);
    }
    if (req.url.startsWith('/plugins/example/client.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', vary: 'Origin' });
      return res.end(javascript);
    }
    if (req.url.startsWith('/assets/index-AbCdEf123.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(javascript) });
      return res.end(javascript);
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('missing');
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer({
    upstreamHost: '127.0.0.1', upstreamPort, password: 'unit-test-password',
    sessionToken: 'unit-test-session-token', compressionThresholdBytes: 1,
  });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });
  const headers = { cookie: `${AUTH_COOKIE}=unit-test-session-token`, 'accept-encoding': 'br, gzip' };

  const root = await request(proxyPort, '/', { headers });
  assert.equal(root.status, 200);
  assert.match(root.headers['cache-control'], /no-store/);

  const plugin = await request(proxyPort, '/plugins/example/client.js?rev=abcdef123456', { headers });
  assert.equal(plugin.status, 200);
  assert.equal(plugin.headers['content-encoding'], 'br');
  assert.match(plugin.headers.vary, /Origin/);
  assert.match(plugin.headers.vary, /Accept-Encoding/i);
  assert.equal(plugin.headers['cache-control'], 'private, max-age=31536000, immutable');
  assert.equal(zlib.brotliDecompressSync(plugin.rawBody).toString('utf8'), javascript);
  const forged = await request(proxyPort, '/plugins/example/client.js?rev=aaaaaaaaaaaa', { headers });
  assert.notEqual(forged.headers['cache-control'], 'private, max-age=31536000, immutable');

  const asset = await request(proxyPort, '/assets/index-AbCdEf123.js', {
    headers: { ...headers, 'accept-encoding': 'br;q=0, gzip;q=1' },
  });
  assert.equal(asset.headers['content-encoding'], 'gzip');
  assert.equal(asset.headers['cache-control'], 'private, max-age=31536000, immutable');
  assert.equal(zlib.gunzipSync(asset.rawBody).toString('utf8'), javascript);

  const connection = await request(
    proxyPort,
    '/plugins/@deepseek-ai/dsh-client-connection/client.js?rev=abcdef123456',
    { headers },
  );
  assert.equal(connection.headers['content-encoding'], 'br');
  assert.match(connection.headers['cache-control'], /no-store/);
  const patched = zlib.brotliDecompressSync(connection.rawBody).toString('utf8');
  assert.match(patched, /__DSH_LOCAL_SEMANTICS__/);
  assert.match(patched, /new WebApiClient\(120000\)/);

  const missing = await request(proxyPort, '/assets/missing-AbCdEf123.js', { headers });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers['content-encoding'], undefined);
  assert.notEqual(missing.headers['cache-control'], 'private, max-age=31536000, immutable');
});

test('patch routes preserve HEAD and Range semantics and terminate oversized bodies', async (t) => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/large') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('x'.repeat(4096));
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': '12345',
        etag: '"head-validator"',
      });
      return res.end();
    }
    if (req.headers.range) {
      res.writeHead(206, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-range': 'bytes 0-3/100',
        'content-length': '4',
      });
      return res.end('part');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head></head><body>' + 'x'.repeat(4096) + '</body></html>');
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer({
    upstreamHost: '127.0.0.1', upstreamPort, password: 'unit-test-password',
    sessionToken: 'unit-test-session-token', maxPatchedResponseBytes: 128,
  });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });
  const cookie = `${AUTH_COOKIE}=unit-test-session-token`;

  const head = await request(proxyPort, '/', { method: 'HEAD', headers: { cookie, 'accept-encoding': 'br' } });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], '12345');
  assert.equal(head.headers.etag, '"head-validator"');
  assert.equal(head.headers['content-encoding'], undefined);
  assert.equal(head.rawBody.length, 0);

  const range = await request(proxyPort, '/plugins/@deepseek-ai/dsh-client-connection/client.js', {
    headers: { cookie, range: 'bytes=0-3', 'accept-encoding': 'gzip' },
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers['content-range'], 'bytes 0-3/100');
  assert.equal(range.headers['content-encoding'], undefined);
  assert.equal(range.body, 'part');

  const oversized = await request(proxyPort, '/', { headers: { cookie } });
  assert.equal(oversized.status, 502);
  assert.equal(oversized.body, 'Harness patch response failed\n');
});

test('connection plugin patch extends the browser unary timeout for weak-network history reads', () => {
  const source = Buffer.from([
    'function isLoopbackHostname(hostname) { return hostname === "localhost"; }',
    'const api = new WebApiClient();',
  ].join('\n'));
  const patched = patchConnectionPlugin(source, 98765).toString('utf8');
  assert.match(patched, /__DSH_LOCAL_SEMANTICS__/);
  assert.match(patched, /new WebApiClient\(98765\)/);
});

test('history reads use the weak-network timeout while ordinary API calls still fail fast', async (t) => {
  const upstream = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }, 80);
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer({
    upstreamHost: '127.0.0.1',
    upstreamPort,
    password: 'unit-test-password',
    sessionToken: 'unit-test-session-token',
    upstreamTimeoutMs: 20,
    historyReadTimeoutMs: 200,
  });
  const proxyPort = await listen(proxy);
  t.after(async () => {
    await close(proxy);
    await close(upstream);
  });
  const cookie = `${AUTH_COOKIE}=unit-test-session-token`;

  const history = await request(proxyPort, '/api/session.history', { method: 'POST', headers: { cookie } });
  assert.equal(history.status, 200);
  assert.deepEqual(JSON.parse(history.body), { ok: true });

  const ordinary = await request(proxyPort, '/api/host.describe', { method: 'POST', headers: { cookie } });
  assert.equal(ordinary.status, 502);
  assert.match(ordinary.body, /upstream timeout/);
});

test('authentication blocks all upstream HTTP and WebSocket access until login', async (t) => {
  let upstreamRequests = 0;
  let upstreamConnections = 0;
  let upstreamUpgradeSocket = null;
  let lastCookie = null;
  const upstream = http.createServer((req, res) => {
    upstreamRequests += 1;
    lastCookie = req.headers.cookie || '';
    if (req.url === '/plugins/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      return;
    }
    if (req.url === '/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': 'application/manifest+json' });
      return res.end('{"name":"Test Harness"}');
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`upstream:${req.url}`);
  });
  upstream.on('connection', () => { upstreamConnections += 1; });
  upstream.on('upgrade', (req, socket) => {
    upstreamUpgradeSocket = socket;
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      '', '',
    ].join('\r\n'));
  });
  const upstreamPort = await listen(upstream);

  const proxy = createProxyServer({
    upstreamHost: '127.0.0.1',
    upstreamPort,
    password: 'unit-test-password',
    sessionToken: 'unit-test-session-token',
    upstreamTimeoutMs: 30,
    sseHeartbeatMs: 50,
  });
  const proxyPort = await listen(proxy);

  t.after(async () => {
    await close(proxy);
    await close(upstream);
  });

  const deniedRoot = await request(proxyPort, '/');
  assert.equal(deniedRoot.status, 303);
  assert.equal(deniedRoot.headers.location, '/__auth/login');

  const deniedAsset = await request(proxyPort, '/assets/private.js');
  assert.equal(deniedAsset.status, 303);

  const deniedManifest = await request(proxyPort, '/manifest.webmanifest');
  assert.equal(deniedManifest.status, 401);
  assert.equal(deniedManifest.headers['content-type'], 'application/manifest+json; charset=utf-8');
  assert.deepEqual(JSON.parse(deniedManifest.body), {});
  assert.equal(upstreamRequests, 0);

  const deniedDiagnostics = await request(proxyPort, '/__local/');
  assert.equal(deniedDiagnostics.status, 303);

  const login = await request(proxyPort, '/__auth/login');
  assert.equal(login.status, 200);
  assert.match(login.body, /访问验证/);
  assert.doesNotMatch(login.body, /unit-test-password/);
  assert.equal(upstreamRequests, 0);

  const wrongBody = 'password=wrong';
  const wrong = await request(proxyPort, '/__auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': Buffer.byteLength(wrongBody),
    },
    body: wrongBody,
  });
  assert.equal(wrong.status, 401);
  assert.match(wrong.body, /密码不正确/);
  assert.equal(upstreamRequests, 0);

  const connectionsBeforeWebSocket = upstreamConnections;
  const deniedUpgrade = await websocketAttempt(proxyPort);
  assert.match(deniedUpgrade, /^HTTP\/1\.1 401 Unauthorized/);
  assert.equal(upstreamConnections, connectionsBeforeWebSocket);

  const passwordBody = 'password=unit-test-password';
  const accepted = await request(proxyPort, '/__auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': Buffer.byteLength(passwordBody),
    },
    body: passwordBody,
  });
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.location, '/');
  const setCookie = accepted.headers['set-cookie'][0];
  assert.match(setCookie, new RegExp(`^${AUTH_COOKIE}=unit-test-session-token;`));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const authCookie = setCookie.split(';')[0];

  const proxied = await request(proxyPort, '/private?ok=1', {
    headers: { cookie: `${authCookie}; harness_cookie=kept` },
  });
  assert.equal(proxied.status, 200);
  assert.equal(proxied.body, 'upstream:/private?ok=1');
  assert.equal(upstreamRequests, 1);
  assert.equal(lastCookie, 'harness_cookie=kept');

  const manifest = await request(proxyPort, '/manifest.webmanifest', {
    headers: { cookie: authCookie },
  });
  assert.equal(manifest.status, 200);
  assert.deepEqual(JSON.parse(manifest.body), { name: 'Test Harness' });

  const events = await readEventStream(proxyPort, authCookie);
  assert.equal(events.status, 200);
  assert.equal(events.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(events.headers['x-accel-buffering'], 'no');
  assert.match(events.headers['cache-control'], /no-transform/);
  assert.match(events.body, /: connected/);
  assert.match(events.body, /: proxy-heartbeat/);
  assert.equal(upstreamRequests, 3);

  const tunnel = await openWebSocketTunnel(proxyPort, authCookie);
  assert.match(tunnel.response, /^HTTP\/1\.1 101 Switching Protocols/);
  tunnel.socket.setTimeout(0);
  await delay(100);
  assert.equal(tunnel.socket.destroyed, false, 'idle WebSocket tunnel must stay open');
  assert.ok(upstreamUpgradeSocket);
  const stateFrame = nextSocketData(tunnel.socket);
  upstreamUpgradeSocket.write('agent-finished');
  assert.equal(await stateFrame, 'agent-finished', 'state updates must cross after an idle period');
  const tunnelClosed = new Promise((resolve) => tunnel.socket.once('close', resolve));
  upstreamUpgradeSocket.destroy();
  await Promise.race([
    tunnelClosed,
    delay(1000).then(() => { throw new Error('upstream WebSocket close was not propagated'); }),
  ]);
  assert.equal(tunnel.socket.destroyed, true);

  const loggedOut = await request(proxyPort, '/__auth/logout', {
    method: 'POST',
    headers: { cookie: authCookie },
  });
  assert.equal(loggedOut.status, 303);
  assert.match(loggedOut.headers['set-cookie'][0], /Max-Age=0/);

  const deniedAgain = await request(proxyPort, '/', { headers: { cookie: authCookie.replace('unit-test-session-token', 'invalid') } });
  assert.equal(deniedAgain.status, 303);
  assert.equal(upstreamRequests, 3);
});
