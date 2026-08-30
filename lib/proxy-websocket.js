'use strict';

const crypto = require('crypto');
const net = require('net');
const { safeEqual } = require('./auth');

function createWebSocketProxy({ config, upstreamState, auth, adapter }) {
  return function proxyWebSocket(req, clientSocket, head) {
    if (!auth.isAuthenticated(req)) {
      clientSocket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const policy = adapter.classify(req, new URL(req.url, 'http://localhost').pathname);
    const headers = adapter.requestHeaders(req.headers, policy);
    const upstreamSocket = net.connect(config.upstreamPort, config.upstreamHost);
    let established = false;
    let closed = false;
    const sendUnavailable = () => {
      if (clientSocket.destroyed || clientSocket.writableEnded) return;
      const body = adapter.websocketUnavailableBody();
      clientSocket.end([
        'HTTP/1.1 503 Service Unavailable', 'Connection: close', 'Cache-Control: no-store',
        'Retry-After: 3', 'Content-Type: application/json; charset=utf-8',
        `Content-Length: ${Buffer.byteLength(body)}`, '', body,
      ].join('\r\n'));
    };
    const closeBoth = () => {
      if (closed) return;
      closed = true;
      clearTimeout(handshakeTimer);
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    };
    const failBeforeConnect = () => {
      if (closed) return;
      upstreamState.unavailable();
      closed = true;
      clearTimeout(handshakeTimer);
      sendUnavailable();
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    };
    const handshakeTimer = setTimeout(failBeforeConnect, config.webSocketHandshakeTimeoutMs);
    handshakeTimer.unref();
    upstreamSocket.once('connect', () => {
      if (closed || clientSocket.destroyed) return closeBoth();
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (const [name, value] of Object.entries(headers)) {
        lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
      }
      lines.push('Connection: Upgrade', 'Upgrade: websocket', '', '');
      upstreamSocket.write(lines.join('\r\n'));
      if (head.length) upstreamSocket.write(head);
    });
    let handshakeBuffer = Buffer.alloc(0);
    const handleHandshakeData = (chunk) => {
      if (closed) return;
      handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
      if (handshakeBuffer.length > 65536) return failBeforeConnect();
      const headerEnd = handshakeBuffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const lines = handshakeBuffer.subarray(0, headerEnd).toString('latin1').split('\r\n');
      const statusValid = /^HTTP\/1\.[01] 101(?:\s|$)/.test(lines.shift() || '');
      const responseHeaders = new Map();
      for (const line of lines) {
        const separator = line.indexOf(':');
        if (separator <= 0) return failBeforeConnect();
        const name = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        responseHeaders.set(name, responseHeaders.has(name) ? `${responseHeaders.get(name)}, ${value}` : value);
      }
      const upgradeValid = /^websocket$/i.test(responseHeaders.get('upgrade') || '');
      const connectionValid = String(responseHeaders.get('connection') || '')
        .split(',').some((token) => token.trim().toLowerCase() === 'upgrade');
      const clientKey = String(req.headers['sec-websocket-key'] || '');
      const expectedAccept = crypto.createHash('sha1')
        .update(`${clientKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      const acceptValid = clientKey !== '' && safeEqual(responseHeaders.get('sec-websocket-accept') || '', expectedAccept);
      if (!statusValid || !upgradeValid || !connectionValid || !acceptValid) return failBeforeConnect();
      upstreamSocket.off('data', handleHandshakeData);
      established = true;
      upstreamState.available();
      clearTimeout(handshakeTimer);
      clientSocket.write(handshakeBuffer);
      clientSocket.pipe(upstreamSocket).pipe(clientSocket);
    };
    upstreamSocket.on('data', handleHandshakeData);
    clientSocket.setKeepAlive(true, 30000);
    upstreamSocket.setKeepAlive(true, 30000);
    clientSocket.setNoDelay(true);
    upstreamSocket.setNoDelay(true);
    upstreamSocket.on('error', () => established ? closeBoth() : failBeforeConnect());
    clientSocket.on('error', closeBoth);
    upstreamSocket.on('close', () => established ? closeBoth() : failBeforeConnect());
    clientSocket.on('close', closeBoth);
  };
}

module.exports = { createWebSocketProxy };
