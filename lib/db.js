/*
* ORPA PostgreSQL-backed datastore.
* -----------------------------------------------------------
* When DATABASE_URL is set, all data lives in PostgreSQL —
* safe across Render restarts and free-tier sleeping.
* When no DATABASE_URL, falls back to the original JSON file
* store (for local development).
*
* IMPORTANT: Call init() once at server startup before using
* any other method. All methods return synchronously for the
* JSON path; for PostgreSQL, init() is async but after that
* reads happen from an in-memory cache that is kept in sync
* with the database, so the existing server.js code works
* without any async changes.
* -----------------------------------------------------------
*/

const fs = require('fs');
const path = require('path');

// ---------- JSON fallback (original logic, unchanged) ----------
const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
let cache = { users: [], loginRequests: [], userData: {}, archives: [] };

function ensureJson() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2));
  }
}

function loadJson() {
  ensureJson();
  try {
    cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || { users: [], archives: [] };
    if (!Array.isArray(cache.users)) cache.users = [];
    if (!Array.isArray(cache.loginRequests)) cache.loginRequests = [];
    if (!cache.userData || typeof cache.userData !== 'object' || Array.isArray(cache.userData)) cache.userData = {};
    if (!Array.isArray(cache.archives)) cache.archives = [];
  } catch (e) {
    cache = { users: [], loginRequests: [], userData: {}, archives: [] };
  }
  return cache;
}

let writeTimer = null;
function persistJson() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2)); }
    catch (e) { console.error('DB write failed:', e.message); }
  }, 50);
}

function persistSyncJson() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2)); }
  catch (e) { console.error('DB sync write failed:', e.message); }
}

// ---------- PostgreSQL layer ----------
// Uses an in-memory cache + write-through to PostgreSQL.
// This keeps the same synchronous API that server.js expects
// while ensuring data survives Render restarts.

let pool = null;
let usePg = false;

/* Initialise PostgreSQL. Call once at startup (async). */
async function initPg() {
  if (!process.env.DATABASE_URL) return false;

  try {
    const pg = require('pg');
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
      max: 5,               // keep small for free tier
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS login_requests (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        ip TEXT DEFAULT '',
        user_agent TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        approved_at TIMESTAMPTZ,
        denied_at TIMESTAMPTZ,
        otp_hash TEXT,
        otp_expires_at TIMESTAMPTZ,
        otp_attempts INTEGER NOT NULL DEFAULT 0,
        used_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_login_requests_user_id ON login_requests(user_id);
      CREATE INDEX IF NOT EXISTS idx_login_requests_status ON login_requests(status);

      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        email         TEXT UNIQUE NOT NULL,
        phone         TEXT DEFAULT '',
        school        TEXT DEFAULT '',
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'teacher',
        status        TEXT NOT NULL DEFAULT 'active',
        token_version INTEGER NOT NULL DEFAULT 1,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS user_data (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        data JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS archives (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        grade INTEGER NOT NULL,
        school TEXT DEFAULT '',
        assessment TEXT DEFAULT '',
        term TEXT DEFAULT '',
        year TEXT DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        data JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE INDEX IF NOT EXISTS idx_archives_user_created ON archives(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_archives_user_grade ON archives(user_id, grade);

    `);

    // Load all existing rows into the in-memory cache
    const res = await pool.query('SELECT * FROM users');
    const rr = await pool.query('SELECT * FROM login_requests ORDER BY created_at DESC LIMIT 500');
    const ud = await pool.query('SELECT user_id, data, updated_at FROM user_data');
    const ar = await pool.query('SELECT id,user_id,grade,school,assessment,term,year,created_at,data FROM archives ORDER BY created_at DESC LIMIT 1000');
    cache.userData = {};
    for (const row of ud.rows) cache.userData[row.user_id] = { data: row.data || {}, updatedAt: row.updated_at };
    cache.archives = ar.rows.map(row => ({
      id: row.id, userId: row.user_id, grade: row.grade, school: row.school || '',
      assessment: row.assessment || '', term: row.term || '', year: row.year || '',
      createdAt: row.created_at, data: row.data || {}
    }));
    cache.users = res.rows.map(row => ({
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone || '',
      school: row.school || '',
      passwordHash: row.password_hash,
      role: row.role,
      status: row.status,
      tokenVersion: row.token_version,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at || null,
    }));

    cache.loginRequests = rr.rows.map(row => ({
      id: row.id, userId: row.user_id, email: row.email, name: row.name,
      ip: row.ip || '', userAgent: row.user_agent || '', status: row.status,
      createdAt: row.created_at, expiresAt: row.expires_at,
      approvedAt: row.approved_at || null, deniedAt: row.denied_at || null,
      otpHash: row.otp_hash || null, otpExpiresAt: row.otp_expires_at || null,
      otpAttempts: row.otp_attempts || 0, usedAt: row.used_at || null,
    }));

    usePg = true;
    console.log(`[db] PostgreSQL connected — ${cache.users.length} user(s) loaded. Data persists across restarts!`);
    return true;
  } catch (e) {
    console.error('[db] PostgreSQL init failed, falling back to JSON file:', e.message);
    pool = null;
    return false;
  }
}

/* Write a single user row to PostgreSQL */
async function pgInsertUser(user) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO users (id, name, email, phone, school, password_hash, role, status, token_version, created_at, last_login_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO NOTHING`,
      [user.id, user.name, user.email, user.phone || '', user.school || '',
       user.passwordHash, user.role, user.status, user.tokenVersion || 1,
       user.createdAt, user.lastLoginAt || null]
    );
  } catch (e) {
    console.error('[db] pg insert error:', e.message);
  }
}

/* Update a user row in PostgreSQL */
async function pgUpdateUser(id, patch) {
  if (!pool) return;
  try {
    const sets = [];
    const vals = [];
    let n = 1;

    // Map JS field names to PG column names
    const colMap = {
      name: 'name',
      email: 'email',
      phone: 'phone',
      school: 'school',
      passwordHash: 'password_hash',
      role: 'role',
      status: 'status',
      tokenVersion: 'token_version',
      lastLoginAt: 'last_login_at',
    };

    for (const [key, val] of Object.entries(patch)) {
      const col = colMap[key];
      if (col) {
        sets.push(`${col} = $${n}`);
        vals.push(val);
        n++;
      }
    }

    if (sets.length === 0) return;

    vals.push(id);
    await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${n}`,
      vals
    );
  } catch (e) {
    console.error('[db] pg update error:', e.message);
  }
}

/* Delete a user row from PostgreSQL */
async function pgDeleteUser(id) {
  if (!pool) return;
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
  } catch (e) {
    console.error('[db] pg delete error:', e.message);
  }
}

async function pgInsertLoginRequest(r) {
  if (!pool) return;
  try {
    await pool.query(`INSERT INTO login_requests
      (id,user_id,email,name,ip,user_agent,status,created_at,expires_at,approved_at,denied_at,otp_hash,otp_expires_at,otp_attempts,used_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (id) DO NOTHING`,
      [r.id,r.userId,r.email,r.name,r.ip||'',r.userAgent||'',r.status,r.createdAt,r.expiresAt,r.approvedAt||null,r.deniedAt||null,r.otpHash||null,r.otpExpiresAt||null,r.otpAttempts||0,r.usedAt||null]);
  } catch(e){ console.error('[db] pg login request insert error:', e.message); }
}

async function pgUpdateLoginRequest(id, patch) {
  if (!pool) return;
  const colMap={userId:'user_id',email:'email',name:'name',ip:'ip',userAgent:'user_agent',status:'status',createdAt:'created_at',expiresAt:'expires_at',approvedAt:'approved_at',deniedAt:'denied_at',otpHash:'otp_hash',otpExpiresAt:'otp_expires_at',otpAttempts:'otp_attempts',usedAt:'used_at'};
  const sets=[], vals=[]; let n=1;
  for(const [k,v] of Object.entries(patch)){const col=colMap[k];if(col){sets.push(`${col}=$${n++}`);vals.push(v)}}
  if(!sets.length)return;
  vals.push(id);
  try{await pool.query(`UPDATE login_requests SET ${sets.join(', ')} WHERE id=$${n}`,vals)}catch(e){console.error('[db] pg login request update error:',e.message)}
}

function addLoginRequest(r){
  cache.loginRequests.unshift(r);
  cache.loginRequests=cache.loginRequests.slice(0,500);
  if(usePg) pgInsertLoginRequest(r);
  persist(); return r;
}
function findLoginRequest(id){return cache.loginRequests.find(r=>r.id===id)}
function updateLoginRequest(id,patch){const r=findLoginRequest(id);if(!r)return null;Object.assign(r,patch);if(usePg)pgUpdateLoginRequest(id,patch);persist();return r}
function allLoginRequests(){return cache.loginRequests}

// ---------- Persistent per-user application data ----------
async function getUserData(id) {
  if (!id) return null;
  if (usePg && pool) {
    try {
      const r = await pool.query('SELECT data, updated_at FROM user_data WHERE user_id = $1', [id]);
      if (!r.rows.length) return null;
      const item = { data: r.rows[0].data || {}, updatedAt: r.rows[0].updated_at };
      cache.userData[id] = item;
      return item;
    } catch (e) { console.error('[db] get user data error:', e.message); }
  }
  return cache.userData[id] || null;
}

async function saveUserData(id, data) {
  if (!id) throw new Error('Missing user id');
  const safe = (data && typeof data === 'object') ? data : {};
  const updatedAt = new Date().toISOString();
  cache.userData[id] = { data: safe, updatedAt };
  if (usePg && pool) {
    await pool.query(`
      INSERT INTO user_data (user_id, data, updated_at)
      VALUES ($1, $2::jsonb, $3)
      ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
    `, [id, JSON.stringify(safe), updatedAt]);
  }
  return cache.userData[id];
}


// ---------- Archived processed assessment data ----------
async function archiveUserData(id, archive) {
  if (!id) throw new Error('Missing user id');
  const safe = {
    id: String(archive.id || ('A' + Date.now().toString(36) + require('crypto').randomBytes(4).toString('hex'))),
    userId: id,
    grade: Number(archive.grade || 0),
    school: String(archive.school || ''),
    assessment: String(archive.assessment || ''),
    term: String(archive.term || ''),
    year: String(archive.year || ''),
    createdAt: archive.createdAt || new Date().toISOString(),
    data: archive.data && typeof archive.data === 'object' ? archive.data : {}
  };
  cache.archives.unshift(safe);
  cache.archives = cache.archives.slice(0, 1000);
  if (usePg && pool) {
    await pool.query(`
      INSERT INTO archives (id,user_id,grade,school,assessment,term,year,created_at,data)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
    `, [safe.id, safe.userId, safe.grade, safe.school, safe.assessment, safe.term, safe.year, safe.createdAt, JSON.stringify(safe.data)]);
  } else {
    persist();
  }
  return safe;
}

async function searchArchives(id, q) {
  const term = String(q || '').trim().toLowerCase();
  if (usePg && pool) {
    try {
      const params = [id];
      let sql = `SELECT id,user_id,grade,school,assessment,term,year,created_at,data
                 FROM archives WHERE user_id=$1`;
      if (term) {
        params.push('%' + term.replace(/[%_]/g, '\\$&') + '%');
        sql += ` AND (
          lower(coalesce(school,'')) LIKE $2 ESCAPE E'\\'
          OR lower(coalesce(assessment,'')) LIKE $2 ESCAPE E'\\'
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(data->'gradeData'->'learners','[]'::jsonb)) AS l
            WHERE lower(coalesce(l->>'name','')) LIKE $2 ESCAPE E'\\'
               OR lower(coalesce(l->>'adm','')) LIKE $2 ESCAPE E'\\'
          )
        )`;
      }
      sql += ` ORDER BY created_at DESC LIMIT 100`;
      const r = await pool.query(sql, params);
      return r.rows.map(row => ({
        id: row.id, userId: row.user_id, grade: row.grade, school: row.school || '',
        assessment: row.assessment || '', term: row.term || '', year: row.year || '',
        createdAt: row.created_at, data: row.data || {}
      }));
    } catch (e) {
      console.error('[db] archive search error:', e.message);
    }
  }
  const rows = cache.archives.filter(a => a.userId === id);
  if (!term) return rows.slice(0,100);
  return rows.filter(a => {
    const hay=[a.school,a.assessment,a.term,a.year].join(' ').toLowerCase();
    if(hay.includes(term)) return true;
    const learners=(((a.data||{}).gradeData||{}).learners)||[];
    return learners.some(l => String(l.name||'').toLowerCase().includes(term) || String(l.adm||'').toLowerCase().includes(term));
  }).slice(0,100);
}

async function getArchive(id, userId) {
  if (usePg && pool) {
    const r = await pool.query('SELECT id,user_id,grade,school,assessment,term,year,created_at,data FROM archives WHERE id=$1 AND user_id=$2', [id,userId]);
    if (!r.rows.length) return null;
    const row=r.rows[0];
    return {id:row.id,userId:row.user_id,grade:row.grade,school:row.school||'',assessment:row.assessment||'',term:row.term||'',year:row.year||'',createdAt:row.created_at,data:row.data||{}};
  }
  return cache.archives.find(a=>a.id===id && a.userId===userId) || null;
}

// ---------- Public API (same interface as original db.js) ----------

function load() {
  if (usePg) {
    // Already loaded during initPg(). Just return.
    return cache;
  }
  return loadJson();
}

function persist() {
  if (usePg) return; // PostgreSQL is write-through; no file persist needed
  persistJson();
}

function persistSync() {
  if (usePg) return;
  persistSyncJson();
}

function allUsers() {
  return cache.users;
}

function findByEmail(email) {
  const e = String(email || '').toLowerCase().trim();
  return cache.users.find((u) => u.email === e);
}

function findById(id) {
  return cache.users.find((u) => u.id === id);
}

function addUser(user) {
  cache.users.push(user);
  if (usePg) {
    pgInsertUser(user); // fire-and-forget write to PG
  }
  persist();
  return user;
}


async function addUserAsync(user) {
  const email = String(user.email || '').toLowerCase().trim();
  if (!email) throw new Error('Email is required.');
  if (findByEmail(email)) {
    const err = new Error('An account with this email already exists.');
    err.code = 'DUPLICATE_EMAIL';
    throw err;
  }
  user.email = email;
  if (usePg && pool) {
    try {
      await pool.query(
        `INSERT INTO users (id,name,email,phone,school,password_hash,role,status,token_version,created_at,last_login_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [user.id,user.name,user.email,user.phone||'',user.school||'',user.passwordHash,user.role,user.status,user.tokenVersion||1,user.createdAt,user.lastLoginAt||null]
      );
    } catch (e) {
      if (e && e.code === '23505') {
        const err = new Error('An account with this email already exists.');
        err.code = 'DUPLICATE_EMAIL';
        throw err;
      }
      throw e;
    }
    cache.users.push(user);
    return user;
  }
  return addUser(user);
}

function updateUser(id, patch) {
  const u = findById(id);
  if (!u) return null;
  Object.assign(u, patch);
  if (usePg) {
    pgUpdateUser(id, patch);
  }
  persist();
  return u;
}

function removeUser(id) {
  const i = cache.users.findIndex((u) => u.id === id);
  if (i < 0) return false;
  cache.users.splice(i, 1);
  if (usePg) {
    pgDeleteUser(id);
  }
  persist();
  return true;
}

module.exports = {
  init: initPg,   // NEW — call once at startup
  load,
  persist,
  persistSync,
  allUsers,
  findByEmail,
  findById,
  addUser,
  addUserAsync,
  updateUser,
  removeUser,
  addLoginRequest,
  findLoginRequest,
  updateLoginRequest,
  allLoginRequests,
  getUserData,
  saveUserData,
  archiveUserData,
  searchArchives,
  getArchive,
};
