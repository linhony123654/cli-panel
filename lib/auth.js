'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA, atomicWrite, sha } = require('./util');

const AUTH_FILE = path.join(DATA, 'auth.json');
const SESS_FILE = path.join(DATA, 'sessions.json');
const INIT_PW_FILE = path.join(DATA, 'INITIAL_PASSWORD.txt');
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const LOCK_AFTER = 5;            // 单 IP 连续失败次数
const LOCK_MS = 15 * 60 * 1000;
const GLOBAL_MAX = 30;           // 全局 15 分钟内失败上限

function scrypt(pw, salt) {
  return crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}

let auth = null;
let sessions = new Map(); // sha(token) -> { exp, created }
const fails = new Map();  // ip -> { n, until }
let globalFails = [];

function loadAuth() {
  if (fs.existsSync(AUTH_FILE)) {
    auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } else {
    const pw = crypto.randomBytes(9).toString('base64url');
    setPassword(pw);
    atomicWrite(INIT_PW_FILE, pw + '\n');
    console.log(`[auth] 已生成初始密码，见 ${INIT_PW_FILE}`);
  }
  try {
    const raw = JSON.parse(fs.readFileSync(SESS_FILE, 'utf8'));
    const now = Date.now();
    sessions = new Map(Object.entries(raw).filter(([, v]) => v.exp > now));
  } catch { sessions = new Map(); }
}

function saveSessions() {
  atomicWrite(SESS_FILE, JSON.stringify(Object.fromEntries(sessions)));
}

function setPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  auth = { salt, hash: scrypt(pw, salt), updated: new Date().toISOString() };
  atomicWrite(AUTH_FILE, JSON.stringify(auth, null, 2));
  sessions.clear();
  saveSessions();
  if (fs.existsSync(INIT_PW_FILE) && fs.readFileSync(INIT_PW_FILE, 'utf8').trim() !== pw) fs.unlinkSync(INIT_PW_FILE);
}

function checkPassword(pw) {
  const h = Buffer.from(scrypt(String(pw || ''), auth.salt), 'hex');
  return crypto.timingSafeEqual(h, Buffer.from(auth.hash, 'hex'));
}

function rateState(ip) {
  const now = Date.now();
  globalFails = globalFails.filter(t => now - t < LOCK_MS);
  const f = fails.get(ip);
  if (f && f.until > now) return { locked: true, wait: Math.ceil((f.until - now) / 1000) };
  if (globalFails.length >= GLOBAL_MAX) return { locked: true, wait: Math.ceil((LOCK_MS - (now - globalFails[0])) / 1000) };
  return { locked: false };
}

function login(ip, pw) {
  const st = rateState(ip);
  if (st.locked) return { ok: false, status: 429, error: `尝试过多，请 ${st.wait} 秒后再试` };
  if (!checkPassword(pw)) {
    const f = fails.get(ip) || { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= LOCK_AFTER) { f.until = Date.now() + LOCK_MS; f.n = 0; }
    fails.set(ip, f);
    globalFails.push(Date.now());
    const left = f.until > Date.now() ? 0 : LOCK_AFTER - f.n;
    return { ok: false, status: 401, error: left ? `密码错误，还可尝试 ${left} 次` : '密码错误，已锁定 15 分钟' };
  }
  fails.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(sha(token), { exp: Date.now() + SESSION_TTL, created: Date.now() });
  saveSessions();
  return { ok: true, token };
}

function verify(token) {
  if (!token) return false;
  const s = sessions.get(sha(token));
  if (!s) return false;
  if (s.exp < Date.now()) { sessions.delete(sha(token)); saveSessions(); return false; }
  return true;
}

function logout(token) {
  if (token && sessions.delete(sha(token))) saveSessions();
}

module.exports = { loadAuth, login, verify, logout, setPassword, checkPassword, SESSION_TTL, INIT_PW_FILE };
