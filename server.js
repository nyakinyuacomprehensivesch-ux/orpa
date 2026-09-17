/*
* ORPA backend server — PATCHED for PostgreSQL persistence
* -----------------------------------------------------------
* Changes from original:
*   1. db.load() moved inside async init()
*   2. seedOwner() moved inside async init() (after DB is ready)
*   3. server.listen() moved inside async init()
*   4. Added 'pg' dependency requirement
*
* Everything else is IDENTICAL to the original server.js
* -----------------------------------------------------------
*/

const path = require('path');
require('./lib/loadenv')();
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const db = require('./lib/db');
const email = require('./lib/email');

// Fire-and-forget email helper
function notify(templateName, user, extra) {
  try {
    Promise.resolve(email.sendTemplate(templateName, user, extra))
      .catch((e) => console.error('[email] send error:', e.message));
  } catch (e) {
    console.error('[email] notify error:', e.message);
  }
}

// ---------- Config ----------
const PORT = process.env.PORT || 8000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL = process.env.TOKEN_TTL || '12h';
const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'owner@orpa.local').toLowerCase();
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || 'changeme123';
const LOGIN_REQUEST_TTL_MS = 5 * 60 * 1000;
const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const loginRate = new Map();

if (!process.env.JWT_SECRET) {
  console.warn('[warn] JWT_SECRET not set — using a random secret. Sessions reset on restart. Set JWT_SECRET in production.');
}

// ---------- Seed owner account ----------
function seedOwner() {
  const existing = db.allUsers().find((u) => u.role === 'owner');
  if (existing) return;
  const hash = bcrypt.hashSync(OWNER_PASSWORD, 10);
  db.addUser({
    id: 'OWNER',
    name: 'System Owner',
    email: OWNER_EMAIL,
    phone: '',
    school: 'ORPA HQ',
    passwordHash: hash,
    role: 'owner',
    status: 'active',
    tokenVersion: 1,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  });
  console.log(`[seed] Owner account created: ${OWNER_EMAIL}`);
  if (!process.env.OWNER_PASSWORD) {
    console.warn(`[warn] Owner password defaults to "${OWNER_PASSWORD}". Change it via OWNER_PASSWORD env.`);
  }
}

// ---------- Presence (in-memory) ----------
const presence = new Map();

function presenceSnapshot() {
  const list = [];
  for (const [uid, p] of presence.entries()) {
    list.push({
      id: uid, name: p.name, email: p.email,
      grade: p.grade, lastActive: p.lastActive, sockets: p.sockets.size,
    });
  }
  return list;
}

let io;
function broadcastPresence() {
  if (io) io.to('admins').emit('presence', presenceSnapshot());
}

// ---------- Helpers ----------
function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, phone: u.phone,
    school: u.school, role: u.role, status: u.status,
    createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null,
  };
}

function signToken(u) {
  return jwt.sign({ uid: u.id, ver: u.tokenVersion }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const u = db.findById(payload.uid);
    if (!u) return null;
    if (u.status !== 'active') return null;
    if ((u.tokenVersion || 1) !== payload.ver) return null;
    return u;
  } catch (e) { return null; }
}

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json());

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const u = token && verifyToken(token);
  if (!u) return res.status(401).json({ error: 'Not authenticated or session ended.' });
  req.user = u;
  next();
}

function ownerOnly(req, res, next) {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access required.' });
  next();
}

function genId() {
  return 'T' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
}


// ---------- Login approval / OTP helpers ----------
function requestId() {
  return crypto.randomBytes(18).toString('base64url');
}
function generateOtp() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[crypto.randomInt(0, chars.length)];
  return out;
}
function hashOtp(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}
function cleanExpiredRequests() {
  const now = Date.now();
  for (const r of db.allLoginRequests()) {
    if ((r.status === 'pending' && new Date(r.expiresAt).getTime() <= now) ||
        (r.status === 'approved' && r.otpExpiresAt && new Date(r.otpExpiresAt).getTime() <= now)) {
      db.updateLoginRequest(r.id, { status: 'expired' });
    }
  }
}
function publicLoginRequest(r) {
  return {
    id: r.id, userId: r.userId, email: r.email, name: r.name,
    ip: r.ip || '', userAgent: r.userAgent || '', status: r.status,
    createdAt: r.createdAt, expiresAt: r.expiresAt,
    approvedAt: r.approvedAt || null, otpExpiresAt: r.otpExpiresAt || null,
    otpAttempts: r.otpAttempts || 0, usedAt: r.usedAt || null,
  };
}
function notifyOwnerLoginRequest(r) {
  const owner = db.allUsers().find(u => u.role === 'owner');
  if (io) io.to('admins').emit('login-request', publicLoginRequest(r));
  if (owner && owner.email) {
    notify('loginRequest', owner, { request: publicLoginRequest(r) });
  }
}
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket.remoteAddress || '';
}

// ---------- Auth routes ----------
app.post('/api/register', async (req, res) => {
  const { name, email, phone, school, password } = req.body || {};
  if (!name || !email || !email.includes('@')) return res.status(400).json({ error: 'Valid name and email required.' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (db.findByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists.' });

  const hash = bcrypt.hashSync(password, 10);
  const user = {
    id: genId(), name: name.trim(), email: email.toLowerCase().trim(),
    phone: (phone || '').trim(), school: (school || '').trim(),
    passwordHash: hash, role: 'teacher', status: 'pending',
    tokenVersion: 1, createdAt: new Date().toISOString(), lastLoginAt: null,
  };
  try {
    await db.addUserAsync(user);
  } catch (e) {
    if (e.code === 'DUPLICATE_EMAIL' || e.code === '23505') {
      return res.status(409).json({ error: 'An account with this email already exists. One email can only have one ORPA account.' });
    }
    console.error('[register] create error:', e.message);
    return res.status(500).json({ error: 'Could not create the account. Please try again.' });
  }
  const owner = db.allUsers().find(x => x.role === 'owner');
  if (owner) notify('registrationPending', owner, { teacher: publicUser(user) });
  res.status(201).json({ requiresActivation: true, user: publicUser(user), message: 'Account created. Your account is waiting for administrator approval.' });
});

app.post('/api/login', (req, res) => {
  cleanExpiredRequests();
  const { email, password } = req.body || {};
  const normalizedEmail = String(email || '').toLowerCase().trim();
  const u = db.findByEmail(normalizedEmail);
  const key = clientIp(req) + '|' + normalizedEmail;
  const now = Date.now();
  const recent = loginRate.get(key) || [];
  const activeRecent = recent.filter(t => now - t < 10 * 60 * 1000);
  if (activeRecent.length >= 8) return res.status(429).json({ error: 'Too many login attempts. Please wait a few minutes and try again.' });
  activeRecent.push(now); loginRate.set(key, activeRecent);

  if (!u || !bcrypt.compareSync(password || '', u.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  if (u.status === 'pending') {
    return res.status(403).json({ error: 'Your account was created successfully but is awaiting administrator approval. You will be able to sign in after the administrator activates your account.' });
  }
  if (u.status !== 'active') {
    return res.status(403).json({ error: 'This account has been suspended. Contact the administrator.' });
  }

  // The owner can sign in directly. Teacher accounts always require owner approval.
  if (u.role === 'owner') {
    db.updateUser(u.id, { lastLoginAt: new Date().toISOString() });
    return res.json({ token: signToken(u), user: publicUser(u), approved: true });
  }

  // Avoid flooding the owner with duplicate pending requests from repeated clicks.
  const existing = db.allLoginRequests().find(r =>
    r.userId === u.id && r.status === 'pending' && new Date(r.expiresAt).getTime() > now
  );
  if (existing) {
    return res.json({ requiresApproval: true, requestId: existing.id, expiresAt: existing.expiresAt, message: 'Login request already waiting for administrator approval.' });
  }

  const r = {
    id: requestId(), userId: u.id, email: u.email, name: u.name,
    ip: clientIp(req), userAgent: String(req.headers['user-agent'] || '').slice(0, 500),
    status: 'pending', createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LOGIN_REQUEST_TTL_MS).toISOString(),
    approvedAt: null, deniedAt: null, otpHash: null, otpExpiresAt: null,
    otpAttempts: 0, usedAt: null,
  };
  db.addLoginRequest(r);
  notifyOwnerLoginRequest(r);
  res.json({ requiresApproval: true, requestId: r.id, expiresAt: r.expiresAt, message: 'Credentials verified. Waiting for administrator approval.' });
});

app.get('/api/login/status/:id', (req, res) => {
  cleanExpiredRequests();
  const r = db.findLoginRequest(req.params.id);
  if (!r) return res.status(404).json({ error: 'Login request not found.' });
  res.json({ request: publicLoginRequest(r), ready: r.status === 'approved' });
});

app.post('/api/login/verify-otp', (req, res) => {
  cleanExpiredRequests();
  const id = String(req.body && req.body.requestId || '');
  const code = String(req.body && req.body.otp || '').trim().toUpperCase();
  const r = db.findLoginRequest(id);
  if (!r) return res.status(404).json({ error: 'Login request not found.' });
  if (r.status === 'pending') return res.status(409).json({ error: 'Administrator approval is still pending.' });
  if (r.status === 'denied' || r.status === 'expired') return res.status(403).json({ error: 'This login request is no longer valid. Please sign in again.' });
  if (r.status !== 'approved') return res.status(403).json({ error: 'This login request cannot be used.' });
  if (!r.otpHash || !r.otpExpiresAt || new Date(r.otpExpiresAt).getTime() <= Date.now()) {
    db.updateLoginRequest(r.id, { status: 'expired' });
    return res.status(403).json({ error: 'The authorization code has expired. Please sign in again.' });
  }
  if ((r.otpAttempts || 0) >= MAX_OTP_ATTEMPTS) {
    db.updateLoginRequest(r.id, { status: 'expired' });
    return res.status(429).json({ error: 'Too many incorrect authorization codes. Please start again.' });
  }
  if (!/^[A-Z0-9]{6}$/.test(code) || hashOtp(code) !== r.otpHash) {
    db.updateLoginRequest(r.id, { otpAttempts: (r.otpAttempts || 0) + 1 });
    return res.status(401).json({ error: 'Incorrect authorization code.' });
  }
  const u = db.findById(r.userId);
  if (!u || u.status !== 'active') return res.status(403).json({ error: 'This account is no longer active.' });
  db.updateLoginRequest(r.id, { status: 'used', usedAt: new Date().toISOString(), otpHash: null });
  db.updateUser(u.id, { lastLoginAt: new Date().toISOString() });
  res.json({ token: signToken(u), user: publicUser(u) });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.post('/api/logout', auth, (req, res) => {
  res.status(204).end();
});

app.put('/api/me', auth, (req, res) => {
  const { name, phone, school, currentPassword, newPassword } = req.body || {};
  const patch = {};
  if (typeof name === 'string' && name.trim()) patch.name = name.trim();
  if (typeof phone === 'string') patch.phone = phone;
  if (typeof school === 'string') patch.school = school;
  if (newPassword) {
    if (!bcrypt.compareSync(currentPassword || '', req.user.passwordHash)) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    patch.passwordHash = bcrypt.hashSync(newPassword, 10);
    patch.tokenVersion = (req.user.tokenVersion || 1) + 1;
  }
  const u = db.updateUser(req.user.id, patch);
  res.json({ user: publicUser(u) });
});

app.put('/api/me/school', auth, (req, res) => {
  const school = (req.body && typeof req.body.school === 'string') ? req.body.school : '';
  const u = db.updateUser(req.user.id, { school });
  res.json({ user: publicUser(u) });
});

// ---------- Persistent teacher grading data ----------
// Classes, learners, marks, assessment settings and other app state are
// stored against the authenticated teacher account in PostgreSQL.
app.get('/api/me/data', auth, async (req, res) => {
  try {
    const item = await db.getUserData(req.user.id);
    res.json({ data: item ? item.data : null, updatedAt: item ? item.updatedAt : null });
  } catch (e) {
    console.error('[data] load error:', e.message);
    res.status(500).json({ error: 'Could not load your saved grading data.' });
  }
});

app.put('/api/me/data', auth, async (req, res) => {
  try {
    const data = req.body && req.body.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return res.status(400).json({ error: 'Invalid grading data.' });
    }
    const bytes = Buffer.byteLength(JSON.stringify(data), 'utf8');
    if (bytes > 5 * 1024 * 1024) return res.status(413).json({ error: 'Saved grading data is too large.' });
    const saved = await db.saveUserData(req.user.id, data);
    res.json({ ok: true, updatedAt: saved.updatedAt });
  } catch (e) {
    console.error('[data] save error:', e.message);
    res.status(500).json({ error: 'Could not save your grading data.' });
  }
});


// ---------- Archived processed assessment data ----------
app.post('/api/archives', auth, async (req, res) => {
  try {
    const body = req.body || {};
    const archive = body.archive || {};
    if (!archive.data || typeof archive.data !== 'object') {
      return res.status(400).json({ error: 'No processed assessment data supplied.' });
    }
    const grade = Number(archive.grade);
    if (!Number.isInteger(grade) || grade < 1 || grade > 9) {
      return res.status(400).json({ error: 'Invalid grade.' });
    }
    const learners = (((archive.data || {}).gradeData || {}).learners) || [];
    const hasLearner = learners.some(l => String(l.name || '').trim() || String(l.adm || '').trim());
    if (!hasLearner) return res.status(400).json({ error: 'There are no learners to archive.' });
    const saved = await db.archiveUserData(req.user.id, {
      ...archive,
      grade,
      school: archive.school || req.user.school || '',
      createdAt: new Date().toISOString()
    });
    res.status(201).json({
      ok: true,
      archive: { id:saved.id, grade:saved.grade, school:saved.school, assessment:saved.assessment,
        term:saved.term, year:saved.year, createdAt:saved.createdAt }
    });
  } catch (e) {
    console.error('[archive] save error:', e.message);
    res.status(500).json({ error: 'Could not archive the processed assessment.' });
  }
});

app.get('/api/archives/search', auth, async (req, res) => {
  try {
    const rows = await db.searchArchives(req.user.id, req.query.q || '');
    res.json({ archives: rows.map(a => ({
      id:a.id, grade:a.grade, school:a.school, assessment:a.assessment, term:a.term,
      year:a.year, createdAt:a.createdAt,
      learnerCount: (((a.data||{}).gradeData||{}).learners||[]).filter(l => l.name || l.adm).length
    }))});
  } catch (e) {
    console.error('[archive] search error:', e.message);
    res.status(500).json({ error: 'Could not search archived records.' });
  }
});

app.get('/api/archives/:id', auth, async (req, res) => {
  try {
    const a = await db.getArchive(req.params.id, req.user.id);
    if (!a) return res.status(404).json({ error: 'Archived record not found.' });
    res.json({ archive: a });
  } catch (e) {
    console.error('[archive] fetch error:', e.message);
    res.status(500).json({ error: 'Could not fetch archived record.' });
  }
});

// ---------- Admin routes (owner only) ----------

app.get('/api/admin/login-requests', auth, ownerOnly, (req, res) => {
  cleanExpiredRequests();
  const requests = db.allLoginRequests().filter(r => ['pending','approved'].includes(r.status)).slice(0,100).map(publicLoginRequest);
  res.json({ requests });
});

app.post('/api/admin/login-requests/:id/approve', auth, ownerOnly, (req, res) => {
  cleanExpiredRequests();
  const r = db.findLoginRequest(req.params.id);
  if (!r) return res.status(404).json({ error: 'Login request not found.' });
  if (r.status !== 'pending') return res.status(409).json({ error: 'This request is no longer pending.' });
  if (new Date(r.expiresAt).getTime() <= Date.now()) { db.updateLoginRequest(r.id, { status: 'expired' }); return res.status(410).json({ error: 'This request has expired.' }); }
  const u = db.findById(r.userId);
  if (!u || u.status !== 'active') return res.status(403).json({ error: 'User is no longer active.' });
  const otp = generateOtp();
  const updated = db.updateLoginRequest(r.id, {
    status: 'approved', approvedAt: new Date().toISOString(),
    otpHash: hashOtp(otp), otpExpiresAt: new Date(Date.now() + OTP_TTL_MS).toISOString(), otpAttempts: 0,
  });
  if (io) io.to('admins').emit('login-approved', { request: publicLoginRequest(updated) });
  // The code is returned only to the authenticated owner/admin, never to the teacher before verification.
  res.json({ ok: true, request: publicLoginRequest(updated), otp });
});

app.post('/api/admin/login-requests/:id/deny', auth, ownerOnly, (req, res) => {
  const r = db.findLoginRequest(req.params.id);
  if (!r) return res.status(404).json({ error: 'Login request not found.' });
  if (r.status !== 'pending') return res.status(409).json({ error: 'This request is no longer pending.' });
  const updated = db.updateLoginRequest(r.id, { status: 'denied', deniedAt: new Date().toISOString() });
  if (io) io.to('admins').emit('login-denied', { request: publicLoginRequest(updated) });
  res.json({ ok: true });
});

app.get('/api/admin/users', auth, ownerOnly, (req, res) => {
  const online = new Set(presence.keys());
  const users = db.allUsers().map((u) => ({
    ...publicUser(u),
    online: online.has(u.id),
    lastActive: presence.get(u.id) ? presence.get(u.id).lastActive : null,
  }));
  res.json({ users });
});

app.get('/api/admin/sessions', auth, ownerOnly, (req, res) => {
  res.json({ sessions: presenceSnapshot() });
});

function kickUserSockets(userId, reason) {
  const p = presence.get(userId);
  if (p && io) {
    for (const sid of p.sockets) {
      io.to(sid).emit('force-logout', { reason: reason || 'Your session was ended by the administrator.' });
      const s = io.sockets.sockets.get(sid);
      if (s) s.disconnect(true);
    }
  }
}

app.post('/api/admin/users/:id/suspend', auth, ownerOnly, (req, res) => {
  const u = db.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  if (u.role === 'owner') return res.status(400).json({ error: 'Cannot suspend the owner account.' });
  db.updateUser(u.id, { status: 'suspended', tokenVersion: (u.tokenVersion || 1) + 1 });
  kickUserSockets(u.id, 'Your account has been suspended by the administrator.');
  notify('suspended', u, { ownerName: req.user.name, reason: (req.body && req.body.reason) || '' });
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/activate', auth, ownerOnly, (req, res) => {
  const u = db.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  db.updateUser(u.id, { status: 'active' });
  notify('activated', u, { ownerName: req.user.name });
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/logout', auth, ownerOnly, (req, res) => {
  const u = db.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  db.updateUser(u.id, { tokenVersion: (u.tokenVersion || 1) + 1 });
  kickUserSockets(u.id, 'You were signed out by the administrator.');
  notify('forceLogout', u, { ownerName: req.user.name });
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', auth, ownerOnly, (req, res) => {
  const u = db.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  if (u.role === 'owner') return res.status(400).json({ error: 'Cannot delete the owner account.' });
  kickUserSockets(u.id, 'Your account has been removed by the administrator.');
  notify('deleted', u, { ownerName: req.user.name });
  db.removeUser(u.id);
  res.json({ ok: true });
});

// ---------- Static frontend ----------
app.use(express.static(path.join(__dirname, 'public')));

// ---------- HTTP + Socket.IO ----------
const server = http.createServer(app);
io = new Server(server, { cors: { origin: '*' } });

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const u = token && verifyToken(token);
  if (!u) return next(new Error('unauthorized'));
  socket.user = u;
  next();
});

io.on('connection', (socket) => {
  const u = socket.user;
  if (u.role === 'owner') {
    socket.join('admins');
    socket.emit('presence', presenceSnapshot());
    return;
  }
  let p = presence.get(u.id);
  if (!p) {
    p = { sockets: new Set(), lastActive: Date.now(), grade: null, name: u.name, email: u.email };
    presence.set(u.id, p);
  }
  p.sockets.add(socket.id);
  p.lastActive = Date.now();
  broadcastPresence();

  socket.on('activity', (data) => {
    p.lastActive = Date.now();
    if (data && typeof data.grade === 'number') p.grade = data.grade;
    broadcastPresence();
  });

  socket.on('disconnect', () => {
    p.sockets.delete(socket.id);
    if (p.sockets.size === 0) presence.delete(u.id);
    broadcastPresence();
  });
});

// ========== ASYNC STARTUP — connect to PostgreSQL FIRST ==========
async function start() {
  // 1. Initialize database (PostgreSQL if available, else JSON file)
  await db.init();

  // 2. Load data (for JSON path; PG path already loaded in init)
  db.load();

  // 3. Seed the owner account
  seedOwner();

  // 4. Start listening — bind to 0.0.0.0 so Render can reach us
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`ORPA server running on http://0.0.0.0:${PORT}`);
    console.log(`Owner login: ${OWNER_EMAIL}`);
  });
}

start().catch((err) => {
  console.error('[fatal] Server failed to start:', err);
  process.exit(1);
});

// ---------- Graceful shutdown ----------
process.on('SIGINT', () => { db.persistSync(); process.exit(0); });
process.on('SIGTERM', () => { db.persistSync(); process.exit(0); });
