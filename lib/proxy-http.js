'use strict';

const http = require('http');
const { pipeline, Readable } = require('stream');
const {
  appendVary, canCompress, compressionStream, deleteHeader, headerValue, preferredEncoding,
} = require('./http-utils');

function createHttpProxy({ config, upstreamState, adapter }) {
  return function proxyRequest(req, res) {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const policy = adapter.classify(req, pathname);
    let downstreamClosed = false;
    const timeout = policy.timeoutMs === null ? config.upstreamTimeoutMs : policy.timeoutMs;
    const upstream = http.request({
      host: config.upstreamHost,
      port: config.upstreamPort,
      method: req.method,
      path: req.url,
      headers: adapter.requestHeaders(req.headers, policy),
      timeout,
    }, (upstreamRes) => {
      if (downstreamClosed) return upstreamRes.destroy();
      upstreamState.available();
      const statusCode = upstreamRes.statusCode || 502;
      if (policy.eventStream) {
        const headers = adapter.responseHeaders(upstreamRes.headers);
        headers['content-type'] = 'text/event-stream; charset=utf-8';
        headers['cache-control'] = 'no-cache, no-store, must-revalidate, no-transform';
        headers['x-accel-buffering'] = 'no';
        deleteHeader(headers, 'content-length');
        res.writeHead(statusCode, headers);
        res.flushHeaders();
        let ended = false;
        let cleaned = false;
        const heartbeat = setInterval(() => {
          if (!res.destroyed && !res.writableEnded) res.write(': proxy-heartbeat\n\n');
        }, config.sseHeartbeatMs);
        heartbeat.unref();
        const cleanup = (error, transportFailure = false) => {
          if (cleaned) return;
          cleaned = true;
          clearInterval(heartbeat);
          if (transportFailure) upstreamState.unavailable();
          if (!upstreamRes.destroyed) upstreamRes.destroy();
          if (!upstream.destroyed) upstream.destroy();
          if (error && !res.destroyed && !res.writableEnded) res.destroy(error);
        };
        upstreamRes.once('end', () => { ended = true; cleanup(); });
        upstreamRes.once('error', (error) => cleanup(error, true));
        upstreamRes.once('aborted', () => cleanup(new Error('upstream event stream aborted'), true));
        upstreamRes.once('close', () => {
          if (!ended) cleanup(new Error('upstream event stream closed before end'), true);
        });
        res.once('close', () => cleanup());
        upstreamRes.pipe(res);
        return;
      }

      if (policy.patchKind === null) {
        const headers = adapter.responseHeaders(upstreamRes.headers);
        const immutable = config.immutableCacheEnabled && (req.method === 'GET' || req.method === 'HEAD') &&
          statusCode === 200 && adapter.isImmutableRequest(req.url, pathname);
        if (immutable) headers['cache-control'] = 'private, max-age=31536000, immutable';
        const knownLengthValue = Number(headerValue(headers, 'content-length'));
        const knownLength = Number.isFinite(knownLengthValue) ? knownLengthValue : undefined;
        const encoding = config.compressionEnabled && policy.compressibleAsset
          ? preferredEncoding(req.headers['accept-encoding']) : null;
        const compressor = encoding !== null && canCompress(
          req, statusCode, headers, knownLength, config.compressionThresholdBytes
        ) ? compressionStream(encoding) : null;
        if (compressor === null) {
          res.writeHead(statusCode, headers);
          let ended = false;
          let cleaned = false;
          const cleanup = (error, transportFailure = false) => {
            if (cleaned) return;
            cleaned = true;
            if (transportFailure) upstreamState.unavailable();
            if (!upstreamRes.destroyed) upstreamRes.destroy();
            if (!upstream.destroyed) upstream.destroy();
            if (error && !res.destroyed && !res.writableEnded) res.destroy(error);
          };
          upstreamRes.once('end', () => { ended = true; cleanup(); });
          upstreamRes.once('error', (error) => cleanup(error, true));
          upstreamRes.once('aborted', () => cleanup(new Error('upstream response aborted'), true));
          upstreamRes.once('close', () => {
            if (!ended) cleanup(new Error('upstream response closed before end'), true);
          });
          res.once('close', () => cleanup());
          upstreamRes.pipe(res);
          return;
        }
        deleteHeader(headers, 'content-length');
        deleteHeader(headers, 'etag');
        deleteHeader(headers, 'content-md5');
        deleteHeader(headers, 'digest');
        headers['content-encoding'] = encoding;
        appendVary(headers, 'Accept-Encoding');
        res.writeHead(statusCode, headers);
        pipeline(upstreamRes, compressor, res, (error) => {
          if (error && !downstreamClosed) upstreamState.unavailable();
          if (!upstream.destroyed) upstream.destroy();
          if (error && !res.destroyed) res.destroy(error);
        });
        return;
      }

      if (headerValue(upstreamRes.headers, 'content-encoding') !== undefined) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        upstreamRes.destroy();
        res.end(adapter.encodedPatchError);
        return;
      }
      const chunks = [];
      let size = 0;
      let settled = false;
      let ended = false;
      const failBufferedResponse = (error, transportFailure = false) => {
        if (settled) return;
        settled = true;
        if (transportFailure && !downstreamClosed) upstreamState.unavailable();
        if (!downstreamClosed) {
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
            res.end(adapter.failedPatchError);
          } else if (!res.destroyed) res.destroy(error);
        }
        if (!upstreamRes.destroyed) upstreamRes.destroy();
      };
      upstreamRes.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > config.maxPatchedResponseBytes) {
          return failBufferedResponse(new Error('transformed response exceeds configured limit'));
        }
        chunks.push(chunk);
      });
      upstreamRes.on('end', () => {
        ended = true;
        if (settled) return;
        settled = true;
        const body = adapter.transform(policy.patchKind, Buffer.concat(chunks));
        const headers = adapter.responseHeaders(upstreamRes.headers);
        for (const name of ['content-length', 'etag', 'content-md5', 'digest', 'last-modified', 'expires']) {
          deleteHeader(headers, name);
        }
        headers['cache-control'] = 'no-store, no-cache, must-revalidate';
        headers.pragma = 'no-cache';
        headers['content-type'] ||= adapter.patchContentType(policy.patchKind);
        const encoding = config.compressionEnabled && canCompress(
          req, statusCode, headers, body.length, config.compressionThresholdBytes
        ) ? preferredEncoding(req.headers['accept-encoding']) : null;
        if (encoding !== null) {
          headers['content-encoding'] = encoding;
          appendVary(headers, 'Accept-Encoding');
          res.writeHead(statusCode, headers);
          pipeline(Readable.from(body), compressionStream(encoding), res, (error) => {
            if (error && !res.destroyed) res.destroy(error);
          });
          return;
        }
        headers['content-length'] = body.length;
        res.writeHead(statusCode, headers);
        if (req.method === 'HEAD') return res.end();
        res.end(body);
      });
      upstreamRes.on('error', (error) => failBufferedResponse(error, true));
      upstreamRes.on('aborted', () => failBufferedResponse(new Error('upstream transformed response aborted'), true));
      upstreamRes.on('close', () => {
        if (!ended) failBufferedResponse(new Error('upstream transformed response closed before end'), true);
      });
    });

    upstream.on('timeout', () => {
      const error = new Error('upstream timeout');
      error.code = 'PROXY_UPSTREAM_TIMEOUT';
      upstream.destroy(error);
    });
    upstream.on('error', (error) => {
      if (downstreamClosed) return;
      if (!res.headersSent) {
        upstreamState.unavailable();
        adapter.sendUnavailable(req, res, pathname,
          error.code === 'PROXY_UPSTREAM_TIMEOUT' ? 'timeout' : 'unavailable');
      } else res.destroy(error);
    });
    const cancelUpstream = () => {
      downstreamClosed = true;
      if (!upstream.destroyed) upstream.destroy();
    };
    req.on('aborted', cancelUpstream);
    res.on('close', () => { if (!res.writableEnded) cancelUpstream(); });
    req.pipe(upstream);
  };
}

module.exports = { createHttpProxy };
