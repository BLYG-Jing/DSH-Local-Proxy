#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { createHarnessAdapter, bootPluginUrls, isImmutableStaticRequest, localHeaders,
  patchConnectionPlugin, patchHtml } = require('./adapters/harness');
const { AUTH_COOKIE, createAuth, parseCookies } = require('./lib/auth');
const { DEFAULTS, createConfig } = require('./lib/config');
const { preferredEncoding, redirect, sendJson } = require('./lib/http-utils');
const { createHttpProxy } = require('./lib/proxy-http');
const { createWebSocketProxy } = require('./lib/proxy-websocket');
const { createUpstreamState } = require('./lib/upstream-state');

const APP_DIR = __dirname;
const LIVE_PATH = '/__health/live';
const READY_PATH = '/__health/ready';

function handleLocalInfo(req, res) {
  const file = path.join(APP_DIR, 'index.html');
  fs.createReadStream(file)
    .on('error', () => { res.writeHead(404); res.end('Not found'); })
    .on('open', () => res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    }))
    .pipe(res);
}

function createProxyServer(options = {}) {
  const config = createConfig(options);
  const auth = createAuth({
    password: config.password,
    sessionToken: options.sessionToken,
    cookieName: options.authCookie || AUTH_COOKIE,
  });
  const upstreamState = createUpstreamState(config.upstreamStateTtlMs, options.now);
  const adapterFactory = options.adapterFactory || createHarnessAdapter;
  const adapter = adapterFactory({
    upstreamPort: config.upstreamPort,
    historyReadTimeoutMs: config.historyReadTimeoutMs,
    auth,
  });
  const proxyHttp = createHttpProxy({ config, upstreamState, adapter });
  const proxyWebSocket = createWebSocketProxy({ config, upstreamState, auth, adapter });

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === LIVE_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
      return sendJson(req, res, 200, { status: 'ok' });
    }
    if (pathname === READY_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
      const snapshot = upstreamState.snapshot();
      return sendJson(req, res, snapshot.status === 'available' ? 200 : 503, { status: snapshot.status });
    }
    if (auth.handleHttp(req, res, pathname)) return;
    if (!auth.isAuthenticated(req)) {
      if (pathname === adapter.constants.manifestPath) return adapter.sendManifestUnavailable(req, res);
      if (pathname.startsWith('/__auth/')) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('Not found\n');
      }
      return redirect(res, '/__auth/login');
    }
    if (pathname === '/__local/' || pathname === '/__local/index.html') return handleLocalInfo(req, res);
    proxyHttp(req, res);
  });
  server.on('upgrade', proxyWebSocket);
  return server;
}

if (require.main === module) {
  const server = createProxyServer();
  server.on('error', (error) => {
    console.error(`dsh-local-proxy failed: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(DEFAULTS.listenPort, DEFAULTS.listenHost, () => {
    console.log(`dsh-local-proxy listening on http://${DEFAULTS.listenHost}:${DEFAULTS.listenPort}`);
    console.log(`authentication required before proxying to http://${DEFAULTS.upstreamHost}:${DEFAULTS.upstreamPort}`);
  });
}

module.exports = {
  AUTH_COOKIE, bootPluginUrls, createProxyServer, isImmutableStaticRequest, localHeaders,
  parseCookies, patchConnectionPlugin, patchHtml, preferredEncoding,
};
