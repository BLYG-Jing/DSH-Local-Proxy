#!/usr/bin/env node
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline, Readable } = require('stream');

function envBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  throw new Error(`${name} must be one of: 1, 0, true, false`);
}

const DEFAULTS = Object.freeze({
  listenHost: process.env.LISTEN_HOST || '127.0.0.1',
  listenPort: Number(process.env.LISTEN_PORT || 18082),
  upstreamHost: process.env.UPSTREAM_HOST || '127.0.0.1',
  upstreamPort: Number(process.env.UPSTREAM_PORT || 18080),
  upstreamTimeoutMs: 30000,
  historyReadTimeoutMs: Number(process.env.HISTORY_READ_TIMEOUT_MS || 120000),
  sseHeartbeatMs: 15000,
  compressionEnabled: envBoolean('RESPONSE_COMPRESSION', true),
  compressionThresholdBytes: Number(process.env.COMPRESSION_THRESHOLD_BYTES || 1024),
  maxPatchedResponseBytes: Number(process.env.MAX_PATCHED_RESPONSE_BYTES || 2097152),
  immutableCacheEnabled: envBoolean('IMMUTABLE_STATIC_CACHE', true),
  password: process.env.AUTH_PASSWORD,
});
const APP_DIR = __dirname;
const AUTH_COOKIE = 'dsh_proxy_session';
const MAX_LOGIN_BODY = 4096;
const MANIFEST_PATH = '/manifest.webmanifest';
const PLUGIN_EVENTS_PATH = '/plugins/events';
const SLOW_SESSION_READ_PATHS = new Set(['/api/session.list', '/api/session.history']);
const CONNECTION_PLUGIN_PATH = '/plugins/@deepseek-ai/dsh-client-connection/client.js';
const LOCAL_SEMANTICS_PATCH = 'function isLoopbackHostname(hostname) {';
const API_CLIENT_CONSTRUCTION = 'new WebApiClient()';
const HASHED_ASSET_PATH = /^\/assets\/[^/?]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;
const VERSIONED_PLUGIN_PATH = /^\/plugins\/.+\/client\.js$/;
const TEXT_CONTENT_TYPE = /^(?:text\/[^;]+|application\/(?:javascript|json|manifest\+json|wasm|xml|x-javascript))(?:;|$)/i;
const ALREADY_COMPRESSED_TYPE = /^(?:image\/(?!svg\+xml)|audio\/|video\/|application\/(?:zip|gzip|x-gzip|x-7z-compressed|x-rar-compressed|pdf))(?:;|$)/i;

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    cookies[name] = part.slice(separator + 1).trim();
  }
  return cookies;
}

function withoutAuthCookie(header) {
  const kept = String(header || '').split(';').map((part) => part.trim()).filter((part) => {
    const separator = part.indexOf('=');
    return separator < 0 || part.slice(0, separator).trim() !== AUTH_COOKIE;
  });
  return kept.filter(Boolean).join('; ');
}

function safeEqual(value, expected) {
  const left = Buffer.from(String(value));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function localHeaders(incoming, upstreamPort, options = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'host' || lower === 'origin' ||
        lower === 'referer' || lower.startsWith('x-forwarded-') ||
        lower === 'forwarded' || lower === 'via' ||
        lower === 'x-real-ip' || lower === 'x-client-ip' ||
        lower === 'cf-connecting-ip' || lower === 'true-client-ip' ||
        lower.startsWith('sec-fetch-') || lower === 'priority' ||
        (options.forceIdentity && lower === 'accept-encoding')) continue;
    if (lower === 'cookie') {
      const cookie = withoutAuthCookie(value);
      if (cookie) headers[name] = cookie;
      continue;
    }
    headers[name] = value;
  }
  headers.host = `localhost:${upstreamPort}`;
  headers.origin = `http://localhost:${upstreamPort}`;
  headers.referer = `http://localhost:${upstreamPort}/`;
  if (options.forceIdentity) headers['accept-encoding'] = 'identity';
  return headers;
}

function responseHeaders(upstreamHeaders, upstreamPort) {
  const headers = {};
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    if (name.toLowerCase() === 'location' && typeof value === 'string') {
      headers[name] = value
        .replaceAll(`http://localhost:${upstreamPort}`, '')
        .replaceAll(`http://127.0.0.1:${upstreamPort}`, '')
        .replaceAll(`https://localhost:${upstreamPort}`, '')
        .replaceAll(`https://127.0.0.1:${upstreamPort}`, '');
    } else {
      headers[name] = value;
    }
  }
  return headers;
}

function headerValue(headers, name) {
  const match = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  return match === undefined ? undefined : headers[match];
}

function deleteHeader(headers, name) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
  }
}

function appendVary(headers, token) {
  const current = String(headerValue(headers, 'vary') || '');
  const values = current.split(',').map((value) => value.trim()).filter(Boolean);
  if (!values.some((value) => value.toLowerCase() === token.toLowerCase())) values.push(token);
  headers.vary = values.join(', ');
}

function qualityForEncoding(header, wanted) {
  let wildcard;
  let explicit;
  for (const item of String(header || '').split(',')) {
    const [rawName, ...params] = item.trim().split(';');
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    let quality = 1;
    for (const parameter of params) {
      const match = /^\s*q\s*=\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*$/i.exec(parameter);
      if (match) quality = Number(match[1]);
    }
    if (name === wanted) explicit = explicit === undefined ? quality : Math.max(explicit, quality);
    if (name === '*') wildcard = wildcard === undefined ? quality : Math.max(wildcard, quality);
  }
  return explicit ?? wildcard ?? 0;
}

function preferredEncoding(acceptEncoding) {
  const candidates = [
    ['br', qualityForEncoding(acceptEncoding, 'br')],
    ['gzip', qualityForEncoding(acceptEncoding, 'gzip')],
  ].filter(([, quality]) => quality > 0);
  candidates.sort((left, right) => right[1] - left[1]);
  return candidates[0]?.[0] || null;
}

function canCompress(req, statusCode, headers, knownLength, thresholdBytes) {
  if (req.method !== 'GET' || statusCode !== 200) return false;
  if (knownLength !== undefined && knownLength < thresholdBytes) return false;
  if (headerValue(headers, 'content-encoding') !== undefined || headerValue(headers, 'content-range') !== undefined) return false;
  if (/\bno-transform\b/i.test(String(headerValue(headers, 'cache-control') || ''))) return false;
  const type = String(headerValue(headers, 'content-type') || '');
  return TEXT_CONTENT_TYPE.test(type) && !ALREADY_COMPRESSED_TYPE.test(type);
}

function compressionStream(encoding) {
  if (encoding === 'br') {
    return zlib.createBrotliCompress({
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
    });
  }
  if (encoding === 'gzip') return zlib.createGzip({ level: 6 });
  return null;
}

function canonicalVersionedPluginUrl(requestUrl, requestPath) {
  const parsed = new URL(requestUrl, 'http://localhost');
  const parameters = [...parsed.searchParams.entries()];
  if (requestPath === CONNECTION_PLUGIN_PATH || !VERSIONED_PLUGIN_PATH.test(requestPath) ||
      parameters.length !== 1 || parameters[0][0] !== 'rev' || !/^[a-f0-9]{12}$/i.test(parameters[0][1])) return null;
  return `${requestPath}${parsed.search}`;
}

function isCompressiblePublicAsset(requestPath) {
  return requestPath.startsWith('/assets/') || VERSIONED_PLUGIN_PATH.test(requestPath) || requestPath === MANIFEST_PATH;
}

function isImmutableStaticRequest(requestUrl, requestPath, trustedPluginUrls = new Set()) {
  const parsed = new URL(requestUrl, 'http://localhost');
  if (HASHED_ASSET_PATH.test(requestPath)) return [...parsed.searchParams.keys()].length === 0;
  const canonical = canonicalVersionedPluginUrl(requestUrl, requestPath);
  return canonical !== null && trustedPluginUrls.has(canonical);
}

function bootPluginUrls(body) {
  const source = body.toString('utf8');
  const prefix = 'globalThis["__DSH_BOOT__"] = ';
  const start = source.indexOf(prefix);
  if (start < 0) return null;
  const scriptEnd = source.indexOf('</script>', start + prefix.length);
  if (scriptEnd < 0) return null;
  let serialized = source.slice(start + prefix.length, scriptEnd).trim();
  if (serialized.endsWith(';')) serialized = serialized.slice(0, -1).trim();
  try {
    const graph = JSON.parse(serialized);
    if (!Array.isArray(graph.entries)) return null;
    const urls = new Set();
    for (const entry of graph.entries) {
      if (typeof entry?.url !== 'string') continue;
      const parsed = new URL(entry.url, 'http://localhost');
      const canonical = canonicalVersionedPluginUrl(entry.url, parsed.pathname);
      if (canonical !== null) urls.add(canonical);
    }
    return urls;
  } catch {
    return null;
  }
}

function patchConnectionPlugin(body, historyReadTimeoutMs = DEFAULTS.historyReadTimeoutMs) {
  const source = body.toString('utf8');
  let patched = source;
  if (patched.includes(LOCAL_SEMANTICS_PATCH)) {
    patched = patched.replace(
      LOCAL_SEMANTICS_PATCH,
      `${LOCAL_SEMANTICS_PATCH} if (globalThis.__DSH_LOCAL_SEMANTICS__ === true) return true;`
    );
  }
  // AbstractApiClient's default unary deadline is 30s. History/list are the
  // largest startup reads, so under a slow link they can abort while the shell
  // and cached assets still render. The constructor accepts the deadline; use
  // the proxy's matching weak-network budget for the real browser carrier.
  if (patched.includes(API_CLIENT_CONSTRUCTION)) {
    patched = patched.replace(
      API_CLIENT_CONSTRUCTION,
      `new WebApiClient(${JSON.stringify(historyReadTimeoutMs)})`
    );
  }
  return patched === source ? null : Buffer.from(patched, 'utf8');
}

function patchHtml(body) {
  const source = body.toString('utf8');
  const marker = `<script>
// dshWeb edge compatibility: HTTP non-loopback lacks crypto.randomUUID().
(()=>{
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID !== 'function' && typeof c.getRandomValues === 'function') {
    const hex = [...Array(256)].map((_, i) => i.toString(16).padStart(2, '0'));
    const uuid = () => {
      const b = new Uint8Array(16);
      c.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      return hex[b[0]]+hex[b[1]]+hex[b[2]]+hex[b[3]]+'-'+
        hex[b[4]]+hex[b[5]]+'-'+hex[b[6]]+hex[b[7]]+'-'+
        hex[b[8]]+hex[b[9]]+'-'+hex[b[10]]+hex[b[11]]+hex[b[12]]+
        hex[b[13]]+hex[b[14]]+hex[b[15]];
    };
    try { Object.defineProperty(c, 'randomUUID', { value: uuid, configurable: true }); }
    catch { try { c.randomUUID = uuid; } catch {} }
  }
  globalThis.__DSH_LOCAL_SEMANTICS__ = true;
})();
</script>`;
  if (source.includes('__DSH_LOCAL_SEMANTICS__')) return null;
  const patched = source.replace('</head>', `${marker}</head>`);
  return patched === source ? null : Buffer.from(patched, 'utf8');
}

function loginPage(hasError = false) {
  const error = hasError
    ? '<p class="error" role="alert">密码不正确，请重新输入。</p>'
    : '<p class="hint">请输入访问密码以继续使用 DeepSeek Harness。</p>';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>登录 · DSH Local Proxy</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui,-apple-system,"Segoe UI",sans-serif; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #f3f5f9; color: #172033; }
    main { width: min(92vw,390px); padding: 34px; border: 1px solid #dfe3eb; border-radius: 16px; background: #fff; box-shadow: 0 16px 45px #24324a1f; }
    h1 { margin: 0 0 8px; font-size: 25px; }
    p { margin: 0 0 22px; color: #647087; line-height: 1.5; }
    .error { color: #b42318; }
    label { display: block; margin-bottom: 8px; font-weight: 650; }
    input { width: 100%; height: 46px; padding: 0 13px; border: 1px solid #b9c1cf; border-radius: 9px; font: inherit; }
    input:focus { outline: 3px solid #2f6feb33; border-color: #2f6feb; }
    button { width: 100%; height: 46px; margin-top: 18px; border: 0; border-radius: 9px; background: #245eea; color: white; font: 650 16px inherit; cursor: pointer; }
    button:hover { background: #164ed2; }
    @media (prefers-color-scheme: dark) { body { background:#111722; color:#eef2fa; } main { background:#192130; border-color:#2d384b; } p { color:#aeb8ca; } input { background:#111722; color:#fff; border-color:#59657a; } }
  </style>
</head>
<body>
  <main>
    <h1>访问验证</h1>
    ${error}
    <form method="post" action="/__auth/login">
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
      <button type="submit">登录</button>
    </form>
  </main>
</body>
</html>`;
}

function sendHtml(req, res, status, html, extraHeaders = {}) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...extraHeaders,
  });
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}

function redirect(res, location, extraHeaders = {}) {
  res.writeHead(303, { location, 'cache-control': 'no-store', ...extraHeaders });
  res.end();
}

function sendManifestUnavailable(req, res) {
  const body = Buffer.from('{}\n', 'utf8');
  res.writeHead(401, {
    'content-type': 'application/manifest+json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store, no-cache, must-revalidate',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}

function readForm(req, callback) {
  let size = 0;
  let settled = false;
  const chunks = [];
  const finish = (error, form) => {
    if (settled) return;
    settled = true;
    callback(error, form);
  };
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_LOGIN_BODY) {
      finish(new Error('request body too large'));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (settled) return;
    try {
      finish(null, new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
    } catch (error) {
      finish(error);
    }
  });
  req.on('error', (error) => finish(error));
}

function createProxyServer(options = {}) {
  const config = { ...DEFAULTS, ...options };
  if (typeof config.password !== 'string' || config.password.length === 0) {
    throw new Error('AUTH_PASSWORD must be set to a non-empty value');
  }
  for (const [name, value] of [
    ['COMPRESSION_THRESHOLD_BYTES', config.compressionThresholdBytes],
    ['MAX_PATCHED_RESPONSE_BYTES', config.maxPatchedResponseBytes],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  }
  const sessionToken = options.sessionToken || crypto.randomBytes(32).toString('base64url');
  let trustedPluginUrls = new Set();

  function isAuthenticated(req) {
    const token = parseCookies(req.headers.cookie)[AUTH_COOKIE];
    return typeof token === 'string' && safeEqual(token, sessionToken);
  }

  function proxyRequest(req, res) {
    const requestPath = new URL(req.url, 'http://localhost').pathname;
    const isEventStream = requestPath === PLUGIN_EVENTS_PATH;
    const patchCandidate = requestPath === '/' || requestPath === '/index.html' ||
      requestPath === CONNECTION_PLUGIN_PATH;
    const shouldPatch = req.method === 'GET' && req.headers.range === undefined && patchCandidate;
    const upstreamTimeout = isEventStream
      ? 0
      : SLOW_SESSION_READ_PATHS.has(requestPath)
        ? config.historyReadTimeoutMs
        : config.upstreamTimeoutMs;
    const upstream = http.request({
      host: config.upstreamHost,
      port: config.upstreamPort,
      method: req.method,
      path: req.url,
      headers: localHeaders(req.headers, config.upstreamPort, { forceIdentity: shouldPatch }),
      timeout: upstreamTimeout,
    }, (upstreamRes) => {
      const statusCode = upstreamRes.statusCode || 502;
      if (isEventStream) {
        const headers = responseHeaders(upstreamRes.headers, config.upstreamPort);
        headers['content-type'] = 'text/event-stream; charset=utf-8';
        headers['cache-control'] = 'no-cache, no-store, must-revalidate, no-transform';
        headers['x-accel-buffering'] = 'no';
        deleteHeader(headers, 'content-length');
        res.writeHead(statusCode, headers);
        res.flushHeaders();
        upstreamRes.pipe(res);
        const heartbeat = setInterval(() => {
          if (!res.destroyed && !res.writableEnded) res.write(': proxy-heartbeat\n\n');
        }, config.sseHeartbeatMs);
        heartbeat.unref();
        const cleanup = () => clearInterval(heartbeat);
        res.once('close', () => {
          cleanup();
          if (!upstreamRes.destroyed) upstreamRes.destroy();
          if (!upstream.destroyed) upstream.destroy();
        });
        upstreamRes.once('close', cleanup);
        upstreamRes.once('end', cleanup);
        return;
      }

      if (!shouldPatch) {
        const headers = responseHeaders(upstreamRes.headers, config.upstreamPort);
        const immutable = config.immutableCacheEnabled && (req.method === 'GET' || req.method === 'HEAD') &&
          statusCode === 200 && isImmutableStaticRequest(req.url, requestPath, trustedPluginUrls);
        if (immutable) headers['cache-control'] = 'private, max-age=31536000, immutable';
        const knownLengthValue = Number(headerValue(headers, 'content-length'));
        const knownLength = Number.isFinite(knownLengthValue) ? knownLengthValue : undefined;
        const encoding = config.compressionEnabled && isCompressiblePublicAsset(requestPath)
          ? preferredEncoding(req.headers['accept-encoding'])
          : null;
        const compressor = encoding !== null && canCompress(
          req, statusCode, headers, knownLength, config.compressionThresholdBytes
        ) ? compressionStream(encoding) : null;
        if (compressor === null) {
          res.writeHead(statusCode, headers);
          return upstreamRes.pipe(res);
        }
        deleteHeader(headers, 'content-length');
        deleteHeader(headers, 'etag');
        deleteHeader(headers, 'content-md5');
        deleteHeader(headers, 'digest');
        headers['content-encoding'] = encoding;
        appendVary(headers, 'Accept-Encoding');
        res.writeHead(statusCode, headers);
        pipeline(upstreamRes, compressor, res, (error) => {
          if (error && !res.destroyed) res.destroy(error);
        });
        return;
      }

      if (headerValue(upstreamRes.headers, 'content-encoding') !== undefined) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        upstreamRes.destroy();
        res.end('Harness returned an encoded response for a dshWeb patch route\n');
        return;
      }
      const chunks = [];
      let size = 0;
      let settled = false;
      let ended = false;
      const failPatchedResponse = (error) => {
        if (settled) return;
        settled = true;
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end('Harness patch response failed\n');
        } else if (!res.destroyed) {
          res.destroy(error);
        }
        if (!upstreamRes.destroyed) upstreamRes.destroy();
      };
      upstreamRes.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > config.maxPatchedResponseBytes) {
          failPatchedResponse(new Error('patched response exceeds configured limit'));
          return;
        }
        chunks.push(chunk);
      });
      upstreamRes.on('end', () => {
        ended = true;
        if (settled) return;
        settled = true;
        const original = Buffer.concat(chunks);
        if (requestPath === '/' || requestPath === '/index.html') {
          const discovered = bootPluginUrls(original);
          if (discovered !== null) trustedPluginUrls = discovered;
        }
        const transformed = requestPath === CONNECTION_PLUGIN_PATH
          ? patchConnectionPlugin(original, config.historyReadTimeoutMs)
          : patchHtml(original);
        const body = transformed || original;
        const headers = responseHeaders(upstreamRes.headers, config.upstreamPort);
        deleteHeader(headers, 'content-length');
        deleteHeader(headers, 'etag');
        deleteHeader(headers, 'content-md5');
        deleteHeader(headers, 'digest');
        deleteHeader(headers, 'last-modified');
        deleteHeader(headers, 'expires');
        headers['cache-control'] = 'no-store, no-cache, must-revalidate';
        headers.pragma = 'no-cache';
        headers['content-type'] ||= requestPath === CONNECTION_PLUGIN_PATH
          ? 'text/javascript; charset=utf-8'
          : 'text/html; charset=utf-8';
        const encoding = config.compressionEnabled && canCompress(
          req, statusCode, headers, body.length, config.compressionThresholdBytes
        ) ? preferredEncoding(req.headers['accept-encoding']) : null;
        if (encoding !== null) {
          const compressor = compressionStream(encoding);
          headers['content-encoding'] = encoding;
          appendVary(headers, 'Accept-Encoding');
          res.writeHead(statusCode, headers);
          pipeline(Readable.from(body), compressor, res, (error) => {
            if (error && !res.destroyed) res.destroy(error);
          });
          return;
        }
        headers['content-length'] = body.length;
        res.writeHead(statusCode, headers);
        if (req.method === 'HEAD') return res.end();
        res.end(body);
      });
      upstreamRes.on('error', failPatchedResponse);
      upstreamRes.on('aborted', () => failPatchedResponse(new Error('upstream patch response aborted')));
      upstreamRes.on('close', () => {
        if (!ended) failPatchedResponse(new Error('upstream patch response closed before end'));
      });
    });

    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`无法连接本机上游 ${config.upstreamHost}:${config.upstreamPort}: ${err.message}\n`);
      } else {
        res.destroy(err);
      }
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  }

  function handleLocalInfo(req, res) {
    const file = path.join(APP_DIR, 'index.html');
    fs.createReadStream(file)
      .on('error', () => { res.writeHead(404); res.end('Not found'); })
      .on('open', () => res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      }))
      .pipe(res);
  }

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;

    if ((pathname === '/__auth/login') && (req.method === 'GET' || req.method === 'HEAD')) {
      if (isAuthenticated(req)) return redirect(res, '/');
      return sendHtml(req, res, 200, loginPage(false));
    }

    if (pathname === '/__auth/login' && req.method === 'POST') {
      return readForm(req, (error, form) => {
        if (error) return sendHtml(req, res, 400, loginPage(true));
        const submitted = form.get('password') || '';
        if (!safeEqual(submitted, config.password)) {
          return sendHtml(req, res, 401, loginPage(true));
        }
        redirect(res, '/', {
          'set-cookie': `${AUTH_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict`,
        });
      });
    }

    if (pathname === '/__auth/logout' && req.method === 'POST') {
      return redirect(res, '/__auth/login', {
        'set-cookie': `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      });
    }

    if (!isAuthenticated(req)) {
      if (pathname === MANIFEST_PATH) return sendManifestUnavailable(req, res);
      if (pathname.startsWith('/__auth/')) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('Not found\n');
      }
      return redirect(res, '/__auth/login');
    }

    if (pathname === '/__local/' || pathname === '/__local/index.html') {
      return handleLocalInfo(req, res);
    }
    proxyRequest(req, res);
  });

  server.on('upgrade', (req, clientSocket, head) => {
    if (!isAuthenticated(req)) {
      clientSocket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }

    const headers = localHeaders(req.headers, config.upstreamPort);
    const upstreamSocket = net.connect(config.upstreamPort, config.upstreamHost, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (const [name, value] of Object.entries(headers)) {
        lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
      }
      lines.push('Connection: Upgrade', 'Upgrade: websocket', '', '');
      upstreamSocket.write(lines.join('\r\n'));
      if (head.length) upstreamSocket.write(head);
      clientSocket.pipe(upstreamSocket).pipe(clientSocket);
    });

    // Conversation and agent status updates use long-lived WebSockets that may
    // legitimately stay idle for minutes. Never apply an application idle
    // timeout here; use TCP keepalive only, and tear both halves down together
    // so the browser can observe a loss and run its reconnect/resync path.
    clientSocket.setKeepAlive(true, 30000);
    upstreamSocket.setKeepAlive(true, 30000);
    clientSocket.setNoDelay(true);
    upstreamSocket.setNoDelay(true);
    let closed = false;
    const closeBoth = () => {
      if (closed) return;
      closed = true;
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    };
    upstreamSocket.on('error', closeBoth);
    clientSocket.on('error', closeBoth);
    upstreamSocket.on('close', closeBoth);
    clientSocket.on('close', closeBoth);
  });

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
  AUTH_COOKIE,
  createProxyServer,
  localHeaders,
  parseCookies,
  patchConnectionPlugin,
  patchHtml,
  preferredEncoding,
  isImmutableStaticRequest,
  bootPluginUrls,
};
