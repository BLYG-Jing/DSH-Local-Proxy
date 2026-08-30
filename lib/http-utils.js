'use strict';

const zlib = require('zlib');

const TEXT_CONTENT_TYPE = /^(?:text\/[^;]+|application\/(?:javascript|json|manifest\+json|wasm|xml|x-javascript))(?:;|$)/i;
const ALREADY_COMPRESSED_TYPE = /^(?:image\/(?!svg\+xml)|audio\/|video\/|application\/(?:zip|gzip|x-gzip|x-7z-compressed|x-rar-compressed|pdf))(?:;|$)/i;
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function safeResponseHeaders(upstreamHeaders) {
  const headers = {};
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
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
    return zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
  }
  if (encoding === 'gzip') return zlib.createGzip({ level: 6 });
  return null;
}

function sendJson(req, res, statusCode, value, extraHeaders = {}) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  if (req.method === 'HEAD') return res.end();
  res.end(body);
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

module.exports = {
  HOP_BY_HOP, appendVary, canCompress, compressionStream, deleteHeader,
  headerValue, preferredEncoding, redirect, safeResponseHeaders, sendHtml, sendJson,
};
