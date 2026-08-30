'use strict';

const crypto = require('crypto');
const { redirect, sendHtml } = require('./http-utils');

const AUTH_COOKIE = 'dsh_proxy_session';
const MAX_LOGIN_BODY = 4096;

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

function removeCookie(header, cookieName) {
  return String(header || '').split(';').map((part) => part.trim()).filter((part) => {
    const separator = part.indexOf('=');
    return separator < 0 || part.slice(0, separator).trim() !== cookieName;
  }).filter(Boolean).join('; ');
}

function safeEqual(value, expected) {
  const left = Buffer.from(String(value));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
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
    if (size > MAX_LOGIN_BODY) return finish(new Error('request body too large'));
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (settled) return;
    try { finish(null, new URLSearchParams(Buffer.concat(chunks).toString('utf8'))); }
    catch (error) { finish(error); }
  });
  req.on('error', (error) => finish(error));
}

function loginPage(hasError = false) {
  const error = hasError
    ? '<p class="error" role="alert">密码不正确，请重新输入。</p>'
    : '<p class="hint">请输入访问密码以继续使用代理服务。</p>';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · DSH Local Proxy</title><style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;background:#f3f5f9;color:#172033}main{width:min(92vw,390px);padding:34px;border:1px solid #dfe3eb;border-radius:16px;background:#fff;box-shadow:0 16px 45px #24324a1f}h1{margin:0 0 8px;font-size:25px}p{margin:0 0 22px;color:#647087;line-height:1.5}.error{color:#b42318}label{display:block;margin-bottom:8px;font-weight:650}input{width:100%;height:46px;padding:0 13px;border:1px solid #b9c1cf;border-radius:9px;font:inherit}input:focus{outline:3px solid #2f6feb33;border-color:#2f6feb}button{width:100%;height:46px;margin-top:18px;border:0;border-radius:9px;background:#245eea;color:#fff;font:650 16px inherit;cursor:pointer}button:hover{background:#164ed2}@media(prefers-color-scheme:dark){body{background:#111722;color:#eef2fa}main{background:#192130;border-color:#2d384b}p{color:#aeb8ca}input{background:#111722;color:#fff;border-color:#59657a}}</style></head>
<body><main><h1>访问验证</h1>${error}<form method="post" action="/__auth/login"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">登录</button></form></main></body></html>`;
}

function createAuth({ password, sessionToken = crypto.randomBytes(32).toString('base64url'), cookieName = AUTH_COOKIE } = {}) {
  function isAuthenticated(req) {
    const token = parseCookies(req.headers.cookie)[cookieName];
    return typeof token === 'string' && safeEqual(token, sessionToken);
  }
  function handleHttp(req, res, pathname) {
    if (pathname === '/__auth/login' && (req.method === 'GET' || req.method === 'HEAD')) {
      if (isAuthenticated(req)) redirect(res, '/');
      else sendHtml(req, res, 200, loginPage(false));
      return true;
    }
    if (pathname === '/__auth/login' && req.method === 'POST') {
      readForm(req, (error, form) => {
        if (error) return sendHtml(req, res, 400, loginPage(true));
        if (!safeEqual(form.get('password') || '', password)) return sendHtml(req, res, 401, loginPage(true));
        redirect(res, '/', { 'set-cookie': `${cookieName}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict` });
      });
      return true;
    }
    if (pathname === '/__auth/logout' && req.method === 'POST') {
      redirect(res, '/__auth/login', {
        'set-cookie': `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      });
      return true;
    }
    return false;
  }
  return {
    cookieName, sessionToken, isAuthenticated, handleHttp,
    stripPrivateCookie: (header) => removeCookie(header, cookieName),
  };
}

module.exports = { AUTH_COOKIE, MAX_LOGIN_BODY, createAuth, parseCookies, removeCookie, safeEqual };
