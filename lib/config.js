'use strict';

function envBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  throw new Error(`${name} must be one of: 1, 0, true, false`);
}

function envPassword() {
  const encoded = process.env.AUTH_PASSWORD_B64;
  if (encoded === undefined || encoded === '') return process.env.AUTH_PASSWORD;
  const normalized = encoded.replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || normalized.length % 4 === 1) {
    throw new Error('AUTH_PASSWORD_B64 must be valid base64');
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64').replace(/=+$/, '') !== normalized) {
    throw new Error('AUTH_PASSWORD_B64 must be valid base64');
  }
  const password = decoded.toString('utf8');
  if (!Buffer.from(password, 'utf8').equals(decoded)) {
    throw new Error('AUTH_PASSWORD_B64 must encode valid UTF-8');
  }
  return password;
}

const DEFAULTS = Object.freeze({
  listenHost: process.env.LISTEN_HOST || '127.0.0.1',
  listenPort: Number(process.env.LISTEN_PORT || 18082),
  upstreamHost: process.env.UPSTREAM_HOST || '127.0.0.1',
  upstreamPort: Number(process.env.UPSTREAM_PORT || 18080),
  upstreamTimeoutMs: 30000,
  historyReadTimeoutMs: Number(process.env.HISTORY_READ_TIMEOUT_MS || 120000),
  webSocketHandshakeTimeoutMs: Number(process.env.WEBSOCKET_HANDSHAKE_TIMEOUT_MS || 10000),
  upstreamStateTtlMs: Number(process.env.UPSTREAM_STATE_TTL_MS || 60000),
  sseHeartbeatMs: 15000,
  compressionEnabled: envBoolean('RESPONSE_COMPRESSION', true),
  compressionThresholdBytes: Number(process.env.COMPRESSION_THRESHOLD_BYTES || 1024),
  maxPatchedResponseBytes: Number(process.env.MAX_PATCHED_RESPONSE_BYTES || 2097152),
  immutableCacheEnabled: envBoolean('IMMUTABLE_STATIC_CACHE', true),
  password: envPassword(),
});

function createConfig(options = {}) {
  const config = { ...DEFAULTS, ...options };
  if (typeof config.password !== 'string' || config.password.length === 0) {
    throw new Error('AUTH_PASSWORD must be set to a non-empty value');
  }
  for (const [name, value] of [
    ['COMPRESSION_THRESHOLD_BYTES', config.compressionThresholdBytes],
    ['MAX_PATCHED_RESPONSE_BYTES', config.maxPatchedResponseBytes],
    ['WEBSOCKET_HANDSHAKE_TIMEOUT_MS', config.webSocketHandshakeTimeoutMs],
    ['UPSTREAM_STATE_TTL_MS', config.upstreamStateTtlMs],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative safe integer`);
    }
  }
  return config;
}

module.exports = { DEFAULTS, createConfig, envBoolean, envPassword };
