'use strict';

const { HOP_BY_HOP, safeResponseHeaders, sendHtml, sendJson } = require('../lib/http-utils');

const MANIFEST_PATH = '/manifest.webmanifest';
const EVENT_STREAM_PATH = '/plugins/events';
const CONNECTION_PLUGIN_PATH = '/plugins/@deepseek-ai/dsh-client-connection/client.js';
const SLOW_REQUEST_PATHS = new Set(['/api/session.list', '/api/session.history']);
const LOCAL_SEMANTICS_PATCH = 'function isLoopbackHostname(hostname) {';
const API_CLIENT_CONSTRUCTION = 'new WebApiClient()';
const HASHED_ASSET_PATH = /^\/assets\/[^/?]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;
const VERSIONED_PLUGIN_PATH = /^\/plugins\/.+\/client\.js$/;

function canonicalVersionedPluginUrl(requestUrl, requestPath) {
  const parsed = new URL(requestUrl, 'http://localhost');
  const parameters = [...parsed.searchParams.entries()];
  if (requestPath === CONNECTION_PLUGIN_PATH || !VERSIONED_PLUGIN_PATH.test(requestPath) ||
      parameters.length !== 1 || parameters[0][0] !== 'rev' || !/^[a-f0-9]{12}$/i.test(parameters[0][1])) return null;
  return `${requestPath}${parsed.search}`;
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
  } catch { return null; }
}

function patchConnectionPlugin(body, historyReadTimeoutMs = 120000) {
  const source = body.toString('utf8');
  let patched = source;
  if (patched.includes(LOCAL_SEMANTICS_PATCH)) {
    patched = patched.replace(LOCAL_SEMANTICS_PATCH,
      `${LOCAL_SEMANTICS_PATCH} if (globalThis.__DSH_LOCAL_SEMANTICS__ === true) return true;`);
  }
  if (patched.includes(API_CLIENT_CONSTRUCTION)) {
    patched = patched.replace(API_CLIENT_CONSTRUCTION,
      `new WebApiClient(${JSON.stringify(historyReadTimeoutMs)})`);
  }
  return patched === source ? null : Buffer.from(patched, 'utf8');
}

function patchHtml(body) {
  const source = body.toString('utf8');
  const marker = `<script>
// dshWeb edge compatibility: HTTP non-loopback lacks crypto.randomUUID().
(()=>{const c=globalThis.crypto;if(c&&typeof c.randomUUID!=='function'&&typeof c.getRandomValues==='function'){const hex=[...Array(256)].map((_,i)=>i.toString(16).padStart(2,'0'));const uuid=()=>{const b=new Uint8Array(16);c.getRandomValues(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;return hex[b[0]]+hex[b[1]]+hex[b[2]]+hex[b[3]]+'-'+hex[b[4]]+hex[b[5]]+'-'+hex[b[6]]+hex[b[7]]+'-'+hex[b[8]]+hex[b[9]]+'-'+hex[b[10]]+hex[b[11]]+hex[b[12]]+hex[b[13]]+hex[b[14]]+hex[b[15]]};try{Object.defineProperty(c,'randomUUID',{value:uuid,configurable:true})}catch{try{c.randomUUID=uuid}catch{}}}globalThis.__DSH_LOCAL_SEMANTICS__=true})();
</script>`;
  if (source.includes('__DSH_LOCAL_SEMANTICS__')) return null;
  const patched = source.replace('</head>', `${marker}</head>`);
  return patched === source ? null : Buffer.from(patched, 'utf8');
}

function unavailablePage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Harness 暂不可用 · DSH Local Proxy</title><style>:root{color-scheme:light dark;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}body{min-height:100vh;margin:0;display:grid;place-items:center;background:#f3f5f9;color:#172033}main{width:min(92vw,520px);padding:34px;border:1px solid #dfe3eb;border-radius:16px;background:#fff}p{line-height:1.65;color:#647087}@media(prefers-color-scheme:dark){body{background:#111722;color:#eef2fa}main{background:#192130;border-color:#2d384b}p{color:#aeb8ca}}</style></head><body><main><h1>Harness 暂不可用</h1><p>代理仍在独立运行，但当前无法连接 Harness。Harness 恢复后可直接重试，无需重启代理。</p><p>本代理不会启动、停止或重启 Harness。</p><a href="/">重试</a> <a href="/__local/">查看代理状态</a></main></body></html>`;
}

function createHarnessAdapter({ upstreamPort, historyReadTimeoutMs, auth } = {}) {
  let trustedPluginUrls = new Set();
  function classify(req, pathname) {
    const patchKind = req.method === 'GET' && req.headers.range === undefined
      ? pathname === CONNECTION_PLUGIN_PATH ? 'connection-plugin'
        : (pathname === '/' || pathname === '/index.html') ? 'html' : null
      : null;
    return {
      eventStream: pathname === EVENT_STREAM_PATH,
      patchKind,
      forceIdentity: patchKind !== null,
      timeoutMs: pathname === EVENT_STREAM_PATH ? 0
        : SLOW_REQUEST_PATHS.has(pathname) ? historyReadTimeoutMs : null,
      compressibleAsset: pathname.startsWith('/assets/') || VERSIONED_PLUGIN_PATH.test(pathname) || pathname === MANIFEST_PATH,
    };
  }
  function requestHeaders(incoming, policy) {
    const headers = {};
    for (const [name, value] of Object.entries(incoming)) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || lower === 'host' || lower === 'origin' || lower === 'referer' ||
          lower.startsWith('x-forwarded-') || lower === 'forwarded' || lower === 'via' ||
          lower === 'x-real-ip' || lower === 'x-client-ip' || lower === 'cf-connecting-ip' ||
          lower === 'true-client-ip' || lower.startsWith('sec-fetch-') || lower === 'priority' ||
          (policy.forceIdentity && lower === 'accept-encoding')) continue;
      if (lower === 'cookie') {
        const cookie = auth.stripPrivateCookie(value);
        if (cookie) headers[name] = cookie;
      } else headers[name] = value;
    }
    headers.host = `localhost:${upstreamPort}`;
    headers.origin = `http://localhost:${upstreamPort}`;
    headers.referer = `http://localhost:${upstreamPort}/`;
    if (policy.forceIdentity) headers['accept-encoding'] = 'identity';
    return headers;
  }
  function responseHeaders(headers) {
    const copied = safeResponseHeaders(headers);
    for (const [name, value] of Object.entries(copied)) {
      if (name.toLowerCase() === 'location' && typeof value === 'string') {
        copied[name] = value.replaceAll(`http://localhost:${upstreamPort}`, '')
          .replaceAll(`http://127.0.0.1:${upstreamPort}`, '')
          .replaceAll(`https://localhost:${upstreamPort}`, '')
          .replaceAll(`https://127.0.0.1:${upstreamPort}`, '');
      }
    }
    return copied;
  }
  function transform(kind, original) {
    if (kind === 'html') {
      const discovered = bootPluginUrls(original);
      if (discovered !== null) trustedPluginUrls = discovered;
      return patchHtml(original) || original;
    }
    return patchConnectionPlugin(original, historyReadTimeoutMs) || original;
  }
  function sendUnavailable(req, res, pathname, kind = 'unavailable') {
    const navigation = (req.method === 'GET' || req.method === 'HEAD') &&
      (req.headers['sec-fetch-mode'] === 'navigate' ||
       ((pathname === '/' || pathname === '/index.html') && String(req.headers.accept || '').includes('text/html')));
    if (navigation) return sendHtml(req, res, 503, unavailablePage(), { 'retry-after': '3' });
    return sendJson(req, res, 503, { error: {
      code: kind === 'timeout' ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
      message: 'Harness is unavailable', retryable: true,
    } }, { 'retry-after': '3' });
  }
  return {
    constants: { manifestPath: MANIFEST_PATH }, classify, requestHeaders, responseHeaders, transform,
    isImmutableRequest: (url, pathname) => isImmutableStaticRequest(url, pathname, trustedPluginUrls),
    sendUnavailable,
    sendManifestUnavailable(req, res) {
      const body = Buffer.from('{}\n');
      res.writeHead(401, { 'content-type': 'application/manifest+json; charset=utf-8',
        'content-length': body.length, 'cache-control': 'no-store, no-cache, must-revalidate',
        'x-content-type-options': 'nosniff' });
      if (req.method === 'HEAD') return res.end();
      res.end(body);
    },
    websocketUnavailableBody() {
      return '{"error":{"code":"UPSTREAM_UNAVAILABLE","message":"Harness is unavailable","retryable":true}}\n';
    },
    patchContentType(kind) { return kind === 'connection-plugin' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8'; },
    encodedPatchError: 'Harness returned an encoded response for a dshWeb patch route\n',
    failedPatchError: 'Harness patch response failed\n',
  };
}

function localHeaders(incoming, upstreamPort, options = {}) {
  const auth = { stripPrivateCookie(header) {
    return String(header || '').split(';').map((part) => part.trim()).filter((part) =>
      !part.startsWith('dsh_proxy_session=')).filter(Boolean).join('; ');
  } };
  return createHarnessAdapter({ upstreamPort, historyReadTimeoutMs: 120000, auth })
    .requestHeaders(incoming, { forceIdentity: options.forceIdentity === true });
}

module.exports = {
  CONNECTION_PLUGIN_PATH, EVENT_STREAM_PATH, MANIFEST_PATH, bootPluginUrls,
  canonicalVersionedPluginUrl, createHarnessAdapter, isImmutableStaticRequest,
  localHeaders, patchConnectionPlugin, patchHtml,
};
