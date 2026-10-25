// security.js: sign-in, audit log and the read-only SQL guard, in one file (replaces sql-guard.js, auth.js, audit.js).
//
// Sections (search for "SECTION:"):
//   sqlGuard  checkCriteria / assertCriteria: only a plain read-only WHERE expression reaches the database
//   auth      sessions, roles, the /login gate, /api/auth/*          (serves login.html)
//   audit     tamper-evident audit log and its routes
//
// Wiring in server.js:  const { sqlGuard, audit, auth } = require('./security');   then  audit(app, () => pool)  and  auth(app, () => pool, { importToken, audit })
// Each section is wrapped in its own function, so helper names never clash between sections.
// Self-test of every section (no database, no network):  node security.js --selftest

const __s = {};   // sections of this file, by name (so a section can reach another one without any local name hiding it)

// ======================================================================
// SECTION: SQL guard for user-written cohort criteria  (was sql-guard.js)
// ======================================================================
const sqlGuard = (() => {
const module = { exports: {} };
// Read-only guard for user-written SQL (cohort criteria). Defence in depth: the real barrier is the SELECT-only database
// role behind DATABASE_READONLY_URL (see db-readonly.sql); this module rejects anything that is not a plain boolean
// WHERE-expression before it ever reaches the database, so a mistake in the role set-up is not the only protection.
//
// A criteria string is the body of a WHERE clause, e.g.  gender = 'female' AND patient_id IN (SELECT patient_id FROM fhir_diagnosis WHERE code = '44054006')
// Allowed: comparisons, AND/OR/NOT, IN / EXISTS sub-selects on the fhir_* tables, functions such as lower(), date_part().
// Refused: several statements (;), comments, dollar-quoted / E'' / U&'' strings, any write / DDL / session command,
//          server-side file, sleep or sequence functions, and the app's own tables (users, sessions, audit_log, app_settings).
//
// Self-test: node security.js --selftest

const MAX_LEN = 20000;
const FORBIDDEN = [
  'insert', 'update', 'delete', 'merge', 'truncate', 'drop', 'alter', 'create', 'grant', 'revoke', 'copy', 'call', 'do', 'execute',
  'prepare', 'deallocate', 'declare', 'fetch', 'move', 'set', 'reset', 'show', 'vacuum', 'analyze', 'cluster', 'reindex', 'refresh',
  'comment', 'lock', 'listen', 'notify', 'unlisten', 'begin', 'commit', 'rollback', 'savepoint', 'into', 'security',
  'set_config', 'pg_sleep', 'nextval', 'setval', 'lastval', 'dblink', 'lo_import', 'lo_export', 'lo_create', 'lo_unlink',
  'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf', 'pg_rotate_logfile', 'pg_switch_wal',
  'users', 'sessions', 'audit_log', 'app_settings', 'information_schema'
];
const FORBIDDEN_RE = new RegExp(`(?<![A-Za-z0-9_])(?:${FORBIDDEN.join('|')})(?![A-Za-z0-9_])`, 'i');
const FORBIDDEN_PREFIX_RE = /(?<![A-Za-z0-9_])(?:pg_[a-z_]+|lo_[a-z_]+|current_setting)(?![A-Za-z0-9_])/i;   // pg_read_file, pg_ls_dir, pg_catalog tables, lo_* ...

// Replace the content of '...' strings with nothing (so words inside text such as 'do not use' are not mistaken for SQL).
// Returns null when a string is not closed.
function stripStrings(s) {
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      i++;
      for (;;) {
        if (i >= s.length) return null;
        if (s[i] === "'") { if (s[i + 1] === "'") { i += 2; continue; } i++; break; }
        i++;
      }
      out += "''";
    } else if (c === '"') {                       // quoted identifier: keep its text so a quoted "users" is still caught
      const j = s.indexOf('"', i + 1);
      if (j < 0) return null;
      out += ' ' + s.slice(i + 1, j) + ' '; i = j + 1;
    } else { out += c; i++; }
  }
  return out;
}

// Cohort criteria only: remove -- line comments and /* */ block comments (nested, as PostgreSQL reads them) that sit OUTSIDE
// quoted text, replacing each with one space. The result is then checked by checkCriteria() and that exact text is what is
// stored and run, so nothing the stripper and PostgreSQL might read differently can reach the database. An unclosed quote or
// block comment is left in place so checkCriteria() refuses it.
function stripComments(sql) {
  let out = '', i = 0; const n = sql.length;
  while (i < n) {
    const c = sql[i], d = sql[i + 1];
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= n) { out += sql.slice(i); i = n; break; }
        if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } j++; out += sql.slice(i, j); i = j; break; }
        j++;
      }
    } else if (c === '-' && d === '-') {
      let j = i + 2; while (j < n && sql[j] !== '\n' && sql[j] !== '\r') j++;
      out += ' '; i = j;
    } else if (c === '/' && d === '*') {
      let depth = 1, j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; } else if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; } else j++;
      }
      if (depth > 0) { out += sql.slice(i); i = n; } else { out += ' '; i = j; }
    } else { out += c; i++; }
  }
  return out;
}

// For cohort criteria that people write or paste (the create / edit routes and stored cohorts): comments are removed first,
// then the normal checks apply. -> { ok: true, sql } with sql = the comment-free text to store and run | { ok: false, error }
function prepareCriteria(sql) {
  if (typeof sql !== 'string') return checkCriteria(sql);
  return checkCriteria(stripComments(sql).trim());
}

function checkCriteria(sql) {
  if (sql === undefined || sql === null || String(sql).trim() === '') return { ok: true, sql: '' };
  if (typeof sql !== 'string') return { ok: false, error: 'Cohort criteria must be text.' };
  const s = sql.trim();
  if (s.length > MAX_LEN) return { ok: false, error: `Cohort criteria is too long (limit ${MAX_LEN} characters).` };
  if (s.includes('\u0000')) return { ok: false, error: 'Cohort criteria contains an invalid character.' };
  if (/(^|[^A-Za-z0-9_])[eE]'/.test(s) || /(^|[^A-Za-z0-9_])[uU]&['"]/.test(s)) return { ok: false, error: "Escape-style strings (E'...' and U&'...') are not allowed in cohort criteria." };
  if (/\$[A-Za-z_]*\$/.test(s)) return { ok: false, error: 'Dollar-quoted strings are not allowed in cohort criteria.' };
  const body = stripStrings(s);
  if (body === null) return { ok: false, error: 'Cohort criteria has an unclosed quote.' };
  if (body.includes(';')) return { ok: false, error: 'Only one expression is allowed: remove the semicolon (;).' };
  if (body.includes('--') || body.includes('/*') || body.includes('*/')) return { ok: false, error: 'SQL comments are not allowed in cohort criteria.' };
  let depth = 0;
  for (const ch of body) { if (ch === '(') depth++; else if (ch === ')') { depth--; if (depth < 0) return { ok: false, error: 'Cohort criteria has an unmatched ")".' }; } }
  if (depth !== 0) return { ok: false, error: 'Cohort criteria has an unmatched "(".' };
  const bad = body.match(FORBIDDEN_RE) || body.match(FORBIDDEN_PREFIX_RE);
  if (bad) return { ok: false, error: `Cohort criteria is read-only: "${bad[0]}" is not allowed.` };
  return { ok: true, sql: s };
}

// Throws an Error with .status = 400 (same shape the app's other validation errors use).
function assertCriteria(sql) {
  const r = prepareCriteria(sql);     // cohorts saved earlier with comments still run: the comments are dropped here
  if (!r.ok) { const e = new Error(r.error); e.status = 400; throw e; }
  return r.sql;
}

module.exports = { checkCriteria, prepareCriteria, assertCriteria, stripComments, MAX_LEN };

module.exports.selftest = () => {
  const assert = require('assert');
  const ok = s => assert.ok(checkCriteria(s).ok, 'should pass: ' + s), no = s => assert.ok(!checkCriteria(s).ok, 'should be refused: ' + s);
  ok(''); ok(null); ok("gender = 'female'"); ok("lower(gender) = 'male' AND birth_date < DATE '1980-01-01'");
  ok("patient_id IN (SELECT patient_id FROM fhir_diagnosis WHERE code IN ('44054006','73211009'))");
  ok("EXISTS (SELECT 1 FROM fhir_observation o WHERE o.patient_id = fhir_patient.patient_id AND o.value > 6.5)");
  ok("json_content->>'note' = 'do not delete; update later'");          // risky words inside text are fine
  ok("name = 'O''Brien'");
  no('1=1; DROP TABLE fhir_patient'); no("1=1; SELECT pg_sleep(30)"); no('1=1 -- rest'); no('1=1 /* x */');
  no("gender = 'x' OR (SELECT count(*) FROM users) > 0"); no('patient_id IN (SELECT password_hash FROM "users")');
  no('1=1) UNION SELECT 1 WHERE (1=1'); no("gender = 'unclosed"); no("1=1 AND pg_read_file('/etc/passwd') IS NOT NULL");
  no("gender = E'x\\'; DROP TABLE t; --'"); no('$$ x $$ = 1'); no('1=1 AND nextval(\'s\') > 0'); no('(SELECT 1 INTO TEMP t)');
  no('1=1 AND set_config(\'a\',\'b\',false) = \'b\''); no('x'.repeat(MAX_LEN + 1));
  assert.throws(() => assertCriteria('1=1; DELETE FROM cohorts'), e => e.status === 400);
  // cohort criteria may carry comments: they are stripped (outside quotes) and the rest is still fully checked
  const pk = s => assert.ok(prepareCriteria(s).ok, 'prepare should pass: ' + s), pn = s => assert.ok(!prepareCriteria(s).ok, 'prepare should refuse: ' + s);
  assert.strictEqual(prepareCriteria("-- Generated by Build SNOMED CT Query\n-- Scope: all\ngender = 'female' -- trailing").sql, "gender = 'female'");
  assert.strictEqual(prepareCriteria("patient_id IN (SELECT patient_id FROM fhir_diagnosis /* nested /* note */ still */ WHERE code = '1')").sql.includes('/*'), false);
  assert.strictEqual(prepareCriteria("json_content->>'note' = 'a -- b /* c */'").sql, "json_content->>'note' = 'a -- b /* c */'");   // comment markers inside text stay
  pk('1=1 -- rest'); pk('1=1 /* x */'); pk('1=1 --');
  pn('1=1; DROP TABLE t -- x'); pn('1=1 /* x */; DELETE FROM cohorts'); pn("gender = 'x' OR (SELECT count(*) FROM /* a */ users) > 0");
  pn('1=1 /* never closed'); pn("gender = 'unclosed -- x");
  assert.ok(!checkCriteria('1=1 -- x').ok, 'checkCriteria (used for analytics SQL) still refuses comments');
  console.log('sql-guard.js self-test: all checks passed');
};
return module.exports;
})();
__s.sqlGuard = sqlGuard;

// ======================================================================
// SECTION: Sign-in, sessions, roles and the access gate  (was auth.js)
// ======================================================================
const auth = (() => {
const module = { exports: {} };
// Authentication and authorization for Vibe Rounds.
//
//   Users      table `users` (email + scrypt password hash + role). Created on start if missing.
//   Sessions   table `sessions`: random 256-bit token in an HttpOnly cookie; only its SHA-256 is stored, so a database
//              leak does not leak live sessions. Logging out, changing the password or disabling a user revokes them.
//   Gate       every /api/* request needs a session (except login / me / logout), and "/" redirects to /login.
//              It runs BEFORE the JSON body parser, so an anonymous request never has its (up to 10 GB) body read.
//   Roles      ROLES below. Today only `admin` (all permissions). To add a role later: add an entry to ROLES with the
//              permissions it gets, optionally restrict routes in ROUTE_PERMISSIONS, and set users.role to its name.
//
// Environment:
//   ADMIN_EMAIL, ADMIN_PASSWORD   creates the first admin on start when that email has no account yet (min 12 chars)
//   ADMIN_RESET_PASSWORD=true     also resets that admin's password to ADMIN_PASSWORD and signs it out everywhere
//                                 (use once if you are locked out, then remove it)
//   SESSION_HOURS                 session lifetime, default 12
//   TRUST_PROXY=1                 behind a reverse proxy (set automatically on Render) so cookies are marked Secure
//   AUTH_DISABLED=true            development escape hatch only: skips the gate. Refused when NODE_ENV=production.
//
// Routes: GET /login, POST /api/auth/login, POST /api/auth/logout, GET /api/auth/me, POST /api/auth/change-password
//
// Self-test: node security.js --selftest

const crypto = require('crypto');
const path = require('path');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

// ---- roles ---------------------------------------------------------------------------------------------------
// permission '*' = everything. 'app:access' is the base permission the gate requires for any /api/* call.
const ROLES = {
  admin: { label: 'Administrator', permissions: ['*'] }
};
const DEFAULT_ROLE = 'admin';

// Optional per-route permissions for future roles: [HTTP method or '*', path RegExp, permission].
// First match wins; a request that matches nothing needs only 'app:access'. Example for later:
//   ['POST', /^\/api\/(import-fhir|init-schema)$/, 'data:import'],
//   ['DELETE', /^\/api\/(batches|batch-groups|cohorts)\//, 'data:delete'],
const ROUTE_PERMISSIONS = [
  ['*', /^\/api\/audit(\/|$)/, 'audit:read']           // the audit log: admin only today (admin has '*')
];

function can(user, permission) {
  const role = user && ROLES[user.role];
  if (!role) return false;                       // unknown or removed role: no access
  return role.permissions.includes('*') || role.permissions.includes(permission);
}
function requiredPermission(method, p) {
  for (const [m, re, perm] of ROUTE_PERMISSIONS) if ((m === '*' || m === method) && re.test(p)) return perm;
  return 'app:access';
}
const permissionsOf = user => (ROLES[user.role] ? ROLES[user.role].permissions.slice() : []);

// ---- passwords -----------------------------------------------------------------------------------------------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MIN_PASSWORD = 12;

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(String(pw), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), dk.toString('base64')].join('$');
}
async function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const want = Buffer.from(hash, 'base64');
    const dk = await scrypt(String(pw), Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p });
    return dk.length === want.length && crypto.timingSafeEqual(dk, want);
  } catch (e) { return false; }
}
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 256) return 'Password is too long (256 characters at most).';
  return null;
}
const normEmail = e => String(e || '').trim().toLowerCase();
const validEmail = e => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// ---- cookies / tokens ----------------------------------------------------------------------------------------
const COOKIE = 'vr_session';
const sha256hex = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (!k || k in out) return;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { out[k] = part.slice(i + 1).trim(); }
  });
  return out;
}
function setSessionCookie(res, token, maxAgeSec, secure) {
  res.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
}
function clearSessionCookie(res, secure) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}

// ---- failed-login throttle (in memory, per IP + email) ---------------------------------------------------------
// 8 wrong passwords inside 15 minutes block that IP + email pair for the rest of the window. Per pair (not per account),
// so a stranger cannot lock the real admin out by guessing from another address.
function makeThrottle({ max = 8, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
  const m = new Map();
  return {
    blocked(key) { const f = m.get(key); return !!(f && f.until > now() && f.n >= max); },
    retryAfterSec(key) { const f = m.get(key); return f ? Math.max(1, Math.ceil((f.until - now()) / 1000)) : 0; },
    fail(key) {
      const t = now(), f = m.get(key);
      if (!f || f.until <= t) m.set(key, { n: 1, until: t + windowMs }); else f.n++;
      if (m.size > 5000) for (const [k, v] of m) if (v.until <= t) m.delete(k);
    },
    ok(key) { m.delete(key); }
  };
}

// ---- storage (PostgreSQL). The self-test swaps in an in-memory store with the same methods. -------------------------
function pgStore(getPool) {
  const q = (sql, params) => getPool().query(sql, params);
  return {
    async init() {
      await q(`CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_login_at TIMESTAMPTZ)`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email))');
      await q(`CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        ip TEXT, user_agent TEXT)`);
      await q('CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id)');
    },
    async countUsers() { return (await q('SELECT count(*)::int AS n FROM users')).rows[0].n; },
    async findByEmail(email) { return (await q('SELECT id, email, password_hash, role, is_active FROM users WHERE lower(email) = $1', [email])).rows[0] || null; },
    async createUser({ email, hash, role }) { return (await q('INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id', [email, hash, role])).rows[0].id; },
    async setPassword(id, hash) { await q('UPDATE users SET password_hash = $2 WHERE id = $1', [id, hash]); },
    async touchLogin(id) { await q('UPDATE users SET last_login_at = now() WHERE id = $1', [id]); },
    async createSession({ tokenHash, userId, ttlSec, ip, ua }) {
      await q(`INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES ($1, $2, now() + ($3 || ' seconds')::interval, $4, $5)`, [tokenHash, userId, String(ttlSec), ip, ua]);
    },
    async findSession(tokenHash) {
      return (await q(`SELECT u.id, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
                       WHERE s.token_hash = $1 AND s.expires_at > now() AND u.is_active`, [tokenHash])).rows[0] || null;
    },
    async deleteSession(tokenHash) { await q('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]); },
    async deleteUserSessions(userId, exceptHash) { await q('DELETE FROM sessions WHERE user_id = $1 AND ($2::text IS NULL OR token_hash <> $2)', [userId, exceptHash || null]); },
    async purgeExpired() { await q('DELETE FROM sessions WHERE expires_at <= now()'); }
  };
}

// ---- wiring --------------------------------------------------------------------------------------------------
// getPool is a function because the pool is created later in server.js than this module is registered.
function setup(app, getPool, { importToken, store: injected, env = process.env, logger = console, audit = null } = {}) {
  const store = injected || pgStore(getPool);
  const ttlSec = Math.max(1, Number(env.SESSION_HOURS) || 12) * 3600;
  const throttle = makeThrottle();
  const disabled = env.AUTH_DISABLED === 'true' && env.NODE_ENV !== 'production';
  if (env.AUTH_DISABLED === 'true' && !disabled) logger.warn('AUTH_DISABLED is ignored when NODE_ENV=production.');
  if (disabled) logger.warn('WARNING: AUTH_DISABLED=true. Authentication is OFF. Development only.');
  if (env.TRUST_PROXY === '1' || env.RENDER) app.set('trust proxy', 1);

  const json = require('express').json({ limit: '10kb' });
  const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
  const tokenOf = req => parseCookies(req.headers.cookie)[COOKIE] || null;
  const clientIp = req => req.ip || (req.socket && req.socket.remoteAddress) || '?';
  const publicUser = u => ({ id: u.id, email: u.email, role: u.role, roleLabel: ROLES[u.role] ? ROLES[u.role].label : u.role, permissions: permissionsOf(u) });
  // audit.record never throws and never blocks; without an audit module these calls do nothing
  const rec = (req, action, outcome, extra) => { if (audit) audit.record(Object.assign({ req, action, category: 'auth', outcome }, extra)); };
  const isApi = req => req.path === '/api' || req.path.startsWith('/api/');

  // Cross-site request forgery: SameSite=Lax already keeps the cookie off cross-site POSTs; this also refuses any state-changing
  // request whose Origin header names another host.
  function sameOrigin(req) {
    const o = req.get('origin');
    if (!o) return true;
    try { return new URL(o).host === req.get('host'); } catch (e) { return false; }
  }

  const PUBLIC_API = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/me']);

  // The gate. Order matters: it must be registered before the global body parser and before the import password gate.
  app.use(async (req, res, next) => {
    try {
      if (disabled || req.method === 'OPTIONS') return next();
      const wantsPage = req.method === 'GET' && (req.path === '/' || req.path === '/index.html');
      if (!isApi(req) && !wantsPage) return next();                    // /login and anything else static is public
      if (PUBLIC_API.has(req.path)) return next();                     // these three do their own checks
      // The FHIR connector imports through this server over loopback with a per-process random token (see server.js).
      if (importToken && req.method === 'POST' && req.path === '/api/import-fhir') {
        const t = req.get('x-import-token');
        if (t && t.length === importToken.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(importToken))) return next();
      }
      const tok = tokenOf(req);
      const user = tok ? await store.findSession(sha256hex(tok)) : null;
      if (!user) {
        if (wantsPage) return res.redirect(302, '/login');
        res.set('Cache-Control', 'no-store');
        return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', error: 'Sign in required.' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return res.status(403).json({ success: false, code: 'BAD_ORIGIN', error: 'Cross-site request refused.' });
      if (!can(user, requiredPermission(req.method, req.path))) return res.status(403).json({ success: false, code: 'FORBIDDEN', error: 'Your role is not allowed to do this.' });
      req.user = user;
      if (wantsPage) res.set('Cache-Control', 'no-store');
      next();
    } catch (err) {
      logger.error('Auth gate error:', err.message);
      res.status(500).json({ success: false, error: 'Authentication check failed.' });
    }
  });

  app.get('/login', (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'login.html')); });

  // A password to compare against when the email is unknown, so "no such user" and "wrong password" take the same time.
  let dummyHash = null;
  const getDummy = async () => dummyHash || (dummyHash = await hashPassword(crypto.randomBytes(12).toString('hex')));

  app.post('/api/auth/login', noStore, json, async (req, res) => {
    try {
      if (!sameOrigin(req)) return res.status(403).json({ success: false, error: 'Cross-site request refused.' });
      const email = normEmail(req.body && req.body.email), password = req.body && req.body.password;
      if (!email || typeof password !== 'string' || !password) return res.status(400).json({ success: false, error: 'Enter your email and password.' });
      const key = clientIp(req) + '|' + email;
      if (throttle.blocked(key)) { rec(req, 'login.blocked', 'denied', { status: 429, actor: { email }, details: { reason: 'too_many_failures' } }); res.set('Retry-After', String(throttle.retryAfterSec(key))); return res.status(429).json({ success: false, error: 'Too many failed attempts. Try again in a few minutes.' }); }
      const user = await store.findByEmail(email);
      const ok = await verifyPassword(password.slice(0, 256), user ? user.password_hash : await getDummy());
      if (!user || !ok || !user.is_active) { throttle.fail(key); rec(req, 'login.failure', 'denied', { status: 401, actor: { email }, details: { reason: !user ? 'unknown_user' : !user.is_active ? 'inactive' : 'bad_password' } }); return res.status(401).json({ success: false, code: 'BAD_CREDENTIALS', error: 'Wrong email or password.' }); }
      throttle.ok(key);
      const token = newToken();
      await store.createSession({ tokenHash: sha256hex(token), userId: user.id, ttlSec, ip: clientIp(req), ua: String(req.get('user-agent') || '').slice(0, 300) });
      await store.touchLogin(user.id);
      setSessionCookie(res, token, ttlSec, req.secure);
      rec(req, 'login.success', 'success', { status: 200, actor: user });
      res.json({ success: true, user: publicUser(user) });
    } catch (err) { logger.error('Login error:', err.message); res.status(500).json({ success: false, error: 'Sign-in failed.' }); }
  });

  app.post('/api/auth/logout', noStore, async (req, res) => {
    try {
      if (!sameOrigin(req)) return res.status(403).json({ success: false, error: 'Cross-site request refused.' });
      const tok = tokenOf(req);
      const who = tok ? await store.findSession(sha256hex(tok)) : null;
      if (tok) await store.deleteSession(sha256hex(tok));
      if (who) rec(req, 'logout', 'success', { status: 200, actor: who });
      clearSessionCookie(res, req.secure);
      res.json({ success: true });
    } catch (err) { logger.error('Logout error:', err.message); res.status(500).json({ success: false, error: 'Sign-out failed.' }); }
  });

  app.get('/api/auth/me', noStore, async (req, res) => {
    try {
      if (disabled) return res.json({ success: true, user: publicUser({ id: 0, email: 'auth-disabled@localhost', role: DEFAULT_ROLE }) });
      const tok = tokenOf(req);
      const user = tok ? await store.findSession(sha256hex(tok)) : null;
      if (!user) return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', error: 'Sign in required.' });
      res.json({ success: true, user: publicUser(user) });
    } catch (err) { logger.error('Auth me error:', err.message); res.status(500).json({ success: false, error: 'Could not read the session.' }); }
  });

  app.post('/api/auth/change-password', noStore, json, async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', error: 'Sign in required.' });
      const { currentPassword, newPassword } = req.body || {};
      const problem = passwordProblem(newPassword);
      if (problem) return res.status(400).json({ success: false, error: problem });
      const row = await store.findByEmail(normEmail(req.user.email));
      if (!row || !(await verifyPassword(String(currentPassword || '').slice(0, 256), row.password_hash))) { rec(req, 'password.change', 'denied', { status: 401, details: { reason: 'wrong_current_password' } }); return res.status(401).json({ success: false, code: 'BAD_CREDENTIALS', error: 'Current password is wrong.' }); }
      await store.setPassword(row.id, await hashPassword(newPassword));
      await store.deleteUserSessions(row.id, sha256hex(tokenOf(req)));       // sign out every other device
      rec(req, 'password.change', 'success', { status: 200 });
      res.json({ success: true });
    } catch (err) { logger.error('Change password error:', err.message); res.status(500).json({ success: false, error: 'Could not change the password.' }); }
  });

  // Call once at start, after the database is reachable: creates the tables and the first admin.
  async function ready() {
    await store.init();
    await store.purgeExpired();
    const t = setInterval(() => store.purgeExpired().catch(() => {}), 60 * 60 * 1000); if (t.unref) t.unref();
    const email = normEmail(env.ADMIN_EMAIL), pw = env.ADMIN_PASSWORD;
    if (email && pw) {
      if (!validEmail(email)) throw new Error('ADMIN_EMAIL is not a valid email address.');
      const problem = passwordProblem(pw);
      if (problem) throw new Error('ADMIN_PASSWORD: ' + problem);
      const existing = await store.findByEmail(email);
      if (!existing) { await store.createUser({ email, hash: await hashPassword(pw), role: 'admin' }); logger.log(`Auth: created admin account ${email}`); rec(null, 'user.create', 'success', { actor: { email: 'system' }, details: { email, role: 'admin', via: 'ADMIN_EMAIL' } }); }
      else if (env.ADMIN_RESET_PASSWORD === 'true') { await store.setPassword(existing.id, await hashPassword(pw)); await store.deleteUserSessions(existing.id); logger.log(`Auth: password reset for ${email}. Remove ADMIN_RESET_PASSWORD now.`); rec(null, 'user.password_reset', 'success', { actor: { email: 'system' }, details: { email, via: 'ADMIN_RESET_PASSWORD' } }); }
    }
    if (!disabled && (await store.countUsers()) === 0) logger.warn('Auth: there are no users, so nobody can sign in. Set ADMIN_EMAIL and ADMIN_PASSWORD (12+ characters) in .env and restart.');
  }

  return { ready, store, can };
}

module.exports = setup;
module.exports.can = can;
module.exports.ROLES = ROLES;
module.exports.pure = { hashPassword, verifyPassword, passwordProblem, parseCookies, makeThrottle, requiredPermission, sha256hex, normEmail, validEmail };

// ---- self-test (pure helpers + the whole HTTP flow against an in-memory store) -----------------------------------------
module.exports.selftest = () => {
  return (async () => {
    const assert = require('assert');
    const express = require('express');
    const http = require('http');

    // helpers
    const h = await hashPassword('correct horse battery');
    assert.ok(h.startsWith('scrypt$'));
    assert.ok(await verifyPassword('correct horse battery', h)); assert.ok(!(await verifyPassword('wrong', h))); assert.ok(!(await verifyPassword('x', 'garbage')));
    assert.ok(passwordProblem('short') && !passwordProblem('long enough password'));
    assert.deepStrictEqual(parseCookies('a=1; vr_session=abc%3D; b=2'), { a: '1', vr_session: 'abc=', b: '2' });
    assert.ok(can({ role: 'admin' }, 'anything') && !can({ role: 'nope' }, 'app:access') && !can(null, 'app:access'));
    assert.strictEqual(requiredPermission('GET', '/api/cohorts'), 'app:access');
    let clock = 0; const th = makeThrottle({ max: 3, windowMs: 1000, now: () => clock });
    th.fail('k'); th.fail('k'); assert.ok(!th.blocked('k')); th.fail('k'); assert.ok(th.blocked('k')); clock = 2000; assert.ok(!th.blocked('k'));

    // in-memory store
    const users = [], sessions = new Map();
    const mem = {
      async init() {}, async purgeExpired() {}, async countUsers() { return users.length; },
      async findByEmail(e) { return users.find(u => u.email === e) || null; },
      async createUser({ email, hash, role }) { users.push({ id: users.length + 1, email, password_hash: hash, role, is_active: true }); return users.length; },
      async setPassword(id, hash) { users.find(u => u.id === id).password_hash = hash; }, async touchLogin() {},
      async createSession({ tokenHash, userId }) { sessions.set(tokenHash, userId); },
      async findSession(th) { const id = sessions.get(th); const u = users.find(x => x.id === id); return u && u.is_active ? { id: u.id, email: u.email, role: u.role } : null; },
      async deleteSession(th) { sessions.delete(th); },
      async deleteUserSessions(id, except) { for (const [k, v] of sessions) if (v === id && k !== except) sessions.delete(k); }
    };
    const quiet = { log() {}, warn() {}, error() {} };
    const app = express();
    const TOKEN = 'loopback-token-loopback-token-123456';
    const auth = setup(app, () => null, { importToken: TOKEN, store: mem, env: { ADMIN_EMAIL: 'Admin@Example.org', ADMIN_PASSWORD: 'a very long password' }, logger: quiet });
    app.get('/api/ping', (req, res) => res.json({ success: true, who: req.user.email }));
    app.post('/api/import-fhir', (req, res) => res.json({ success: true }));
    app.get('/', (req, res) => res.send('app'));
    await auth.ready();
    assert.strictEqual(users.length, 1); assert.strictEqual(users[0].email, 'admin@example.org'); assert.strictEqual(users[0].role, 'admin');
    await auth.ready(); assert.strictEqual(users.length, 1, 'bootstrap is idempotent');

    const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = { host: '127.0.0.1', port: srv.address().port };
    const call = (method, p, { body, cookie, headers } = {}) => new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request(Object.assign({ method, path: p, headers: Object.assign({}, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, cookie ? { Cookie: cookie } : {}, headers || {}) }, base), res => {
        let s = ''; res.on('data', c => s += c); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) {} resolve({ status: res.statusCode, headers: res.headers, json: j, text: s }); });
      });
      req.on('error', reject); if (data) req.write(data); req.end();
    });
    try {
      let r = await call('GET', '/api/ping'); assert.strictEqual(r.status, 401); assert.strictEqual(r.json.code, 'AUTH_REQUIRED');
      r = await call('GET', '/'); assert.strictEqual(r.status, 302); assert.strictEqual(r.headers.location, '/login');
      r = await call('GET', '/about'); assert.notStrictEqual(r.status, 401, '/about is public'); assert.notStrictEqual(r.status, 302, '/about does not redirect to sign-in');
      r = await call('POST', '/api/import-fhir'); assert.strictEqual(r.status, 401);
      r = await call('POST', '/api/import-fhir', { headers: { 'X-Import-Token': TOKEN } }); assert.strictEqual(r.status, 200, 'loopback token passes the gate for import only');
      r = await call('GET', '/api/ping', { headers: { 'X-Import-Token': TOKEN } }); assert.strictEqual(r.status, 401);
      r = await call('GET', '/api/auth/me'); assert.strictEqual(r.status, 401);
      r = await call('POST', '/api/auth/login', { body: { email: 'admin@example.org', password: 'nope nope nope' } }); assert.strictEqual(r.status, 401);
      r = await call('POST', '/api/auth/login', { body: { email: 'nobody@example.org', password: 'nope nope nope' } }); assert.strictEqual(r.status, 401);
      r = await call('POST', '/api/auth/login', { body: { email: 'admin@example.org', password: 'a very long password' }, headers: { Origin: 'http://evil.example' } }); assert.strictEqual(r.status, 403);
      r = await call('POST', '/api/auth/login', { body: { email: ' ADMIN@example.org ', password: 'a very long password' } });
      assert.strictEqual(r.status, 200); assert.strictEqual(r.json.user.role, 'admin'); assert.ok(r.json.user.permissions.includes('*')); assert.ok(!('password_hash' in r.json.user));
      const sc = r.headers['set-cookie'][0]; assert.ok(/HttpOnly/.test(sc) && /SameSite=Lax/.test(sc));
      const cookie = sc.split(';')[0];
      r = await call('GET', '/api/ping', { cookie }); assert.strictEqual(r.status, 200); assert.strictEqual(r.json.who, 'admin@example.org');
      r = await call('GET', '/', { cookie }); assert.strictEqual(r.status, 200);
      r = await call('GET', '/api/auth/me', { cookie }); assert.strictEqual(r.json.user.email, 'admin@example.org');
      r = await call('POST', '/api/import-fhir', { cookie, headers: { Origin: 'http://evil.example', Host: '127.0.0.1:' + base.port } }); assert.strictEqual(r.status, 403, 'cross-site POST refused');
      r = await call('POST', '/api/auth/change-password', { cookie, body: { currentPassword: 'wrong', newPassword: 'another long password' } }); assert.strictEqual(r.status, 401);
      r = await call('POST', '/api/auth/change-password', { cookie, body: { currentPassword: 'a very long password', newPassword: 'short' } }); assert.strictEqual(r.status, 400);
      r = await call('POST', '/api/auth/change-password', { cookie, body: { currentPassword: 'a very long password', newPassword: 'another long password' } }); assert.strictEqual(r.status, 200);
      r = await call('GET', '/api/ping', { cookie }); assert.strictEqual(r.status, 200, 'current session survives a password change');
      users[0].role = 'viewer';
      r = await call('GET', '/api/ping', { cookie }); assert.strictEqual(r.status, 403, 'a role with no permissions is refused');
      users[0].role = 'admin';
      r = await call('POST', '/api/auth/logout', { cookie }); assert.strictEqual(r.status, 200);
      r = await call('GET', '/api/ping', { cookie }); assert.strictEqual(r.status, 401, 'session is dead after logout');
      for (let i = 0; i < 8; i++) await call('POST', '/api/auth/login', { body: { email: 'admin@example.org', password: 'bad bad bad bad' } });
      r = await call('POST', '/api/auth/login', { body: { email: 'admin@example.org', password: 'another long password' } }); assert.strictEqual(r.status, 429, 'throttled after repeated failures');
    } finally { srv.close(); }
    console.log('auth.js self-test: all checks passed');
  })().catch(e => { console.error(e); process.exit(1); });
};
return module.exports;
})();
__s.auth = auth;

// ======================================================================
// SECTION: Audit log  (was audit.js)
// ======================================================================
const audit = (() => {
const module = { exports: {} };
// Audit log for Vibe Rounds: who did what, when, from where, and whether it worked.
//
//   Recorded   sign-in events (auth.js), every data-changing request (imports, deletes, cohorts, settings, ...),
//              reads of patient-level data (patient explorer, cohort graph sample), data sent to an external AI model,
//              exports, refused requests (403) and the audit log's own export / verify.
//              AUDIT_LEVEL=verbose also records every other /api/ request. Default is "standard".
//   Never      request bodies, passwords, API keys, tokens or cookies. Only a short whitelist of fields (batch id, cohort
//              id, name, counts) and, for patient-data reads, the query string (it holds the patient id).
//   Storage    table `audit_log`, append-only: a trigger refuses UPDATE, DELETE and TRUNCATE. Every row also carries the
//              SHA-256 of the previous row's hash plus its own fields (a hash chain), so an edited or removed row is
//              found by GET /api/audit/verify. A database superuser can still drop the trigger and rewrite the whole
//              chain: this makes tampering visible, it does not make it impossible. Note the `head` hash that verify
//              returns somewhere outside the database if you need to detect removal of the newest rows too.
//   Writes     queued and written in order after the response is sent, so a slow database never slows a request. If
//              the database is down the event is lost and an error is logged (queue is capped at 2000).
//   Viewing    needs the permission `audit:read` (admin has it through '*'; see ROUTE_PERMISSIONS in auth.js).
//
// Routes: GET /api/audit (filters: from, to, actor, action prefix, category, outcome, q, limit, before)
//         GET /api/audit/facets, GET /api/audit/export.csv, GET /api/audit/verify
//
// Self-test: node security.js --selftest

const crypto = require('crypto');

const GENESIS = '0'.repeat(64);
const MAX_QUEUE = 2000;
const LOCK_KEY = 7340211;                     // pg advisory lock: one writer at a time keeps the chain linear across instances

// ---- helpers -------------------------------------------------------------------------------------------------
function stableStringify(v) {                  // JSON with sorted keys: jsonb does not keep key order, the hash must not care
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
const clean = (s, n) => (s === undefined || s === null) ? null : String(s).replace(/\u0000/g, '').slice(0, n);

// the exact fields the hash covers, in a fixed order
function hashRow(prevHash, r) {
  const body = stableStringify([r.ts, r.actor_id, r.actor_email, r.actor_role, r.ip, r.user_agent, r.action, r.category, r.method, r.path, r.status, r.outcome, r.details]);
  return crypto.createHash('sha256').update(prevHash + '\n' + body).digest('hex');
}
function normalize(r) {                        // what is stored and hashed (stable types: strings, ints, null, plain object)
  const details = {};
  for (const [k, v] of Object.entries(r.details || {})) {
    if (v === undefined) continue;
    details[clean(k, 60)] = (v !== null && typeof v === 'object') ? JSON.parse(JSON.stringify(v, (kk, vv) => typeof vv === 'string' ? clean(vv, 300) : vv)) : (typeof v === 'string' ? clean(v, 300) : v);
  }
  return {
    ts: r.ts, actor_id: Number.isInteger(r.actor_id) ? r.actor_id : null, actor_email: clean(r.actor_email, 254), actor_role: clean(r.actor_role, 60),
    ip: clean(r.ip, 64), user_agent: clean(r.user_agent, 300), action: clean(r.action, 80), category: clean(r.category, 40),
    method: clean(r.method, 10), path: clean(r.path, 300), status: Number.isInteger(r.status) ? r.status : null, outcome: clean(r.outcome, 20), details
  };
}
const outcomeOf = s => s < 400 ? 'success' : (s === 401 || s === 403 || s === 429) ? 'denied' : 'failure';

function csvCell(v) {
  let s = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                 // spreadsheet formula injection
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ---- which requests are audited --------------------------------------------------------------------------------
// [method, path regex (group 1 = target id), action, category, options]. First match wins. action null = never audit it
// (it still shows up as access.denied when refused with 403). Anything else that changes data gets "api.write".
const RULES = [
  ['GET',    /^\/api\/audit\/export\.csv$/, 'audit.export', 'security'],
  ['GET',    /^\/api\/audit\/verify$/, 'audit.verify', 'security'],
  ['POST',   /^\/api\/import-fhir$/, 'data.import', 'data', { entries: true }],
  ['POST',   /^\/api\/init-schema$/, 'schema.init', 'admin'],
  ['POST',   /^\/api\/ehr\/fetch$/, 'ehr.fetch', 'data'],
  ['DELETE', /^\/api\/batches\/([^/]+)$/, 'batch.delete', 'data'],
  ['DELETE', /^\/api\/batch-groups\/([^/]+)$/, 'batch.group_delete', 'data'],
  ['POST',   /^\/api\/cohorts$/, 'cohort.create', 'cohort'],
  ['PUT',    /^\/api\/cohorts\/([^/]+)$/, 'cohort.update', 'cohort'],
  ['DELETE', /^\/api\/cohorts\/([^/]+)$/, 'cohort.delete', 'cohort'],
  ['POST',   /^\/api\/cohorts\/([^/]+)\/activate$/, 'cohort.activate', 'cohort'],
  ['POST',   /^\/api\/cohorts\/([^/]+)\/deactivate$/, 'cohort.deactivate', 'cohort'],
  ['POST',   /^\/api\/overrides$/, 'override.save', 'data'],
  ['DELETE', /^\/api\/overrides\/([^/]+)$/, 'override.delete', 'data'],
  ['POST',   /^\/api\/pico-templates$/, 'template.save', 'data'],
  ['DELETE', /^\/api\/pico-templates\/([^/]+)$/, 'template.delete', 'data'],
  ['POST',   /^\/api\/llm\/settings$/, 'settings.llm_update', 'admin'],
  ['POST',   /^\/api\/llm\/test$/, 'settings.llm_test', 'admin'],
  ['POST',   /^\/api\/synthetic\/generate$/, 'synthetic.generate', 'data'],
  ['POST',   /^\/api\/snomed\/hierarchy\/load$/, 'terminology.load', 'data'],
  ['DELETE', /^\/api\/snomed\/hierarchy$/, 'terminology.delete', 'data'],
  ['POST',   /^\/api\/snomed\/dictionary\/build$/, 'terminology.dictionary_build', 'data'],
  ['POST',   /^\/api\/notebook\/download$/, 'export.notebook', 'export'],
  ['POST',   /^\/api\/(?:ai|pico)\/([a-z-]+)$/, 'ai.request', 'external'],          // text / statistics sent to an external model
  ['POST',   /^\/api\/analytics\/custom\/(generate)$/, 'ai.request', 'external'],     // the question text is sent to an external model
  ['GET',    /^\/api\/explorer\/patients$/, 'phi.list', 'phi', { query: true }],
  ['GET',    /^\/api\/explorer\/patient$/, 'phi.view', 'phi', { query: true }],
  ['GET',    /^\/api\/kg\/cohort$/, 'phi.cohort_graph', 'phi', { query: true }],
  // noise: analytics runs, previews and polling are not audited one by one (use AUDIT_LEVEL=verbose to see them)
  ['POST',   /^\/api\/(?:analytics\/(?:catalog\/(?:run|run-all|compare)|custom\/run)|readiness\/.*|notebook\/preview|snomed\/(?:expand|query\/.*)|ehr\/(?:test|jobs\/.*))$/, null, null]
];
const BODY_KEYS = ['batchId', 'batchGroup', 'name', 'cohortId', 'maxPatients', 'count'];     // the only body fields that are ever stored

function classify(method, p) {
  for (const [m, re, action, category, opts] of RULES) {
    if (m !== method) continue;
    const x = re.exec(p);
    if (x) return action ? { action, category, opts: opts || {}, target: x[1] ? safeDecode(x[1]) : null } : { ignore: true };
  }
  return null;
}
const safeDecode = s => { try { return decodeURIComponent(s); } catch (e) { return s; } };

// ---- storage -----------------------------------------------------------------------------------------------------
const COLS = 'id, ts, actor_id, actor_email, actor_role, ip, user_agent, action, category, method, path, status, outcome, details, prev_hash, row_hash';
const fromPg = r => Object.assign({}, r, { id: Number(r.id), ts: new Date(r.ts).toISOString() });
const likeEsc = s => String(s).replace(/[\\%_]/g, '\\$&');

function pgStore(getPool) {
  const pool = () => getPool();
  return {
    async init() {
      const q = s => pool().query(s);
      await q(`CREATE TABLE IF NOT EXISTS audit_log (
        id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL,
        actor_id INTEGER, actor_email TEXT, actor_role TEXT, ip TEXT, user_agent TEXT,
        action TEXT NOT NULL, category TEXT, method TEXT, path TEXT, status INTEGER, outcome TEXT NOT NULL,
        details JSONB NOT NULL DEFAULT '{}', prev_hash TEXT NOT NULL, row_hash TEXT NOT NULL)`);
      await q('CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts DESC)');
      await q('CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action, id DESC)');
      await q('CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (lower(actor_email), id DESC)');
      await q(`CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'audit_log is append-only'; END; $$ LANGUAGE plpgsql`);
      await q('DROP TRIGGER IF EXISTS audit_log_no_change ON audit_log');
      await q('CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable()');
      await q('DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log');
      await q('CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable()');
    },
    async append(r) {
      const c = await pool().connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
        const last = (await c.query('SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1')).rows[0];
        const prev = last ? last.row_hash : GENESIS;
        await c.query(`INSERT INTO audit_log (ts, actor_id, actor_email, actor_role, ip, user_agent, action, category, method, path, status, outcome, details, prev_hash, row_hash)
                       VALUES ($1::timestamptz,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)`,
          [r.ts, r.actor_id, r.actor_email, r.actor_role, r.ip, r.user_agent, r.action, r.category, r.method, r.path, r.status, r.outcome, JSON.stringify(r.details), prev, hashRow(prev, r)]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    },
    async list(f, limit) {
      const { sql, params } = whereFilters(f);
      params.push(limit);
      return (await pool().query(`SELECT ${COLS} FROM audit_log ${sql} ORDER BY id DESC LIMIT $${params.length}`, params)).rows.map(fromPg);
    },
    async facets() {
      const a = await pool().query('SELECT action, category, count(*)::int AS n FROM audit_log GROUP BY action, category ORDER BY action');
      const u = await pool().query('SELECT actor_email, count(*)::int AS n FROM audit_log WHERE actor_email IS NOT NULL GROUP BY actor_email ORDER BY n DESC LIMIT 100');
      return { actions: a.rows, actors: u.rows };
    },
    async chain(afterId, limit) { return (await pool().query(`SELECT ${COLS} FROM audit_log WHERE id > $1 ORDER BY id ASC LIMIT $2`, [afterId, limit])).rows.map(fromPg); }
  };
}
// filters -> SQL (kept separate so the free-text search can reuse one parameter four times)
function whereFilters(f) {
  const w = [], p = [];
  const add = (sql, v) => { p.push(v); w.push(sql.replace(/\?/g, '$' + p.length)); };
  if (f.from) add('ts >= ?::timestamptz', f.from);
  if (f.to) add('ts <= ?::timestamptz', f.to);
  if (f.actor) add('actor_email ILIKE ?', '%' + likeEsc(f.actor) + '%');
  if (f.action) add('action ILIKE ?', likeEsc(f.action) + '%');
  if (f.category) add('category = ?', f.category);
  if (f.outcome) add('outcome = ?', f.outcome);
  if (f.q) add('(path ILIKE ? OR actor_email ILIKE ? OR ip ILIKE ? OR details::text ILIKE ?)', '%' + likeEsc(f.q) + '%');
  if (f.before) add('id < ?', f.before);
  return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', params: p };
}

// ---- chain check ------------------------------------------------------------------------------------------------
async function verifyChain(store) {
  let prev = GENESIS, after = 0, checked = 0, head = null;
  for (;;) {
    const rows = await store.chain(after, 2000);
    if (!rows.length) break;
    for (const r of rows) {
      if (r.prev_hash !== prev) return { ok: false, checked, head, firstBad: { id: r.id, reason: checked ? 'a row before this one was removed or changed' : 'the first row does not start the chain' } };
      const norm = normalize(Object.assign({}, r, { ts: r.ts }));
      if (hashRow(prev, norm) !== r.row_hash) return { ok: false, checked, head, firstBad: { id: r.id, reason: 'this row was changed' } };
      prev = r.row_hash; after = r.id; checked++; head = { id: r.id, ts: r.ts, hash: r.row_hash };
    }
  }
  return { ok: true, checked, head, firstBad: null };
}

// ---- wiring ------------------------------------------------------------------------------------------------------
function setup(app, getPool, { store: injected, env = process.env, logger = console } = {}) {
  const store = injected || pgStore(getPool);
  const level = env.AUDIT_LEVEL === 'verbose' ? 'verbose' : 'standard';
  let tail = Promise.resolve(), pending = 0, dropped = 0, ready = false;

  // record({req?, actor?, action, category, outcome, status?, method?, path?, details?}); never throws, never blocks
  function record(e) {
    try {
      const req = e.req, user = e.actor || (req && req.user) || null;
      const rec = normalize({
        ts: (e.ts || new Date()).toISOString(), actor_id: user && user.id, actor_email: user && user.email, actor_role: user && user.role,
        ip: req ? (req.ip || (req.socket && req.socket.remoteAddress)) : null, user_agent: req ? req.get('user-agent') : null,
        action: e.action, category: e.category || null, method: e.method || (req && req.method) || null,
        path: e.path || (req && req.originalUrl ? req.originalUrl.split('?')[0] : null), status: e.status, outcome: e.outcome || 'success', details: e.details
      });
      if (pending >= MAX_QUEUE) { if (!dropped++ || dropped % 100 === 0) logger.error(`Audit queue full: ${dropped} event(s) dropped`); return; }
      pending++;
      tail = tail.then(() => store.append(rec)).catch(err => logger.error('Audit write failed:', err.message)).then(() => { pending--; });
    } catch (err) { logger.error('Audit record failed:', err.message); }
  }
  const flush = () => tail;

  function observe(req, res, ms) {
    const method = req.method;
    if (method === 'OPTIONS' || method === 'HEAD') return;
    const p = req.path;
    if (p.startsWith('/api/auth/')) return;                     // sign-in events are recorded by auth.js
    const status = res.statusCode, user = req.user || null;
    const c = classify(method, p);
    let sel = null;
    if (c && !c.ignore) sel = c;
    else if (status === 403) sel = { action: 'access.denied', category: 'security', opts: {}, target: null };
    else if (c && c.ignore) sel = null;
    else if (method !== 'GET' && user) sel = { action: 'api.write', category: 'data', opts: {}, target: null };    // unknown new write route
    else if (level === 'verbose' && !/^\/api\/(hello|db-info)$/.test(p)) sel = { action: method === 'GET' ? 'api.read' : 'api.write', category: 'access', opts: {}, target: null };
    if (!sel) return;
    const details = { ms };
    if (sel.target) details.target = sel.target;
    const b = req.body;
    if (b && typeof b === 'object' && !Array.isArray(b)) {
      for (const k of BODY_KEYS) if (typeof b[k] === 'string' || typeof b[k] === 'number') details[k] = b[k];
      if (sel.opts.entries && b.bundle && Array.isArray(b.bundle.entry)) details.entries = b.bundle.entry.length;
    }
    if (sel.opts.query || sel.action === 'audit.export') {       // patient ids live in the query string of the patient-data reads
      const q = {}; let n = 0;
      for (const [k, v] of Object.entries(req.query || {})) { if (n++ >= 20) break; q[k] = Array.isArray(v) ? v.map(x => String(x).slice(0, 200)) : String(v).slice(0, 200); }
      if (n) details.query = q;
    }
    record({ req, action: sel.action, category: sel.category, outcome: outcomeOf(status), status, details });
  }

  // 1) the request recorder: registered FIRST so it also sees what the auth gate refuses
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    const t0 = Date.now();
    res.on('finish', () => { try { observe(req, res, Date.now() - t0); } catch (err) { logger.error('Audit observe failed:', err.message); } });
    next();
  });

  // 2) the viewer routes: call after the auth gate is registered, so only users with `audit:read` reach them
  function routes() {
    const one = v => (Array.isArray(v) ? v[0] : v);
    const iso = v => { v = one(v); if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? undefined : d.toISOString(); };
    const filters = q => {
      const f = { from: iso(q.from), to: iso(q.to), actor: String(one(q.actor) || '').trim().slice(0, 100), action: String(one(q.action) || '').trim().slice(0, 80),
        category: String(one(q.category) || '').trim().slice(0, 40), outcome: String(one(q.outcome) || '').trim().slice(0, 20), q: String(one(q.q) || '').trim().slice(0, 100) };
      if (f.from === undefined || f.to === undefined) return null;
      if (f.outcome && !['success', 'denied', 'failure'].includes(f.outcome)) return null;
      return f;
    };
    const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

    app.get('/api/audit', noStore, async (req, res) => {
      try {
        const f = filters(req.query); if (!f) return res.status(400).json({ success: false, error: 'Invalid filter (check the dates and outcome).' });
        const limit = Math.min(500, Math.max(1, Math.floor(Number(one(req.query.limit))) || 100));
        const before = Math.floor(Number(one(req.query.before))); if (before > 0) f.before = before;
        const rows = await store.list(f, limit + 1);
        const more = rows.length > limit; if (more) rows.pop();
        res.json({ success: true, rows, nextBefore: more ? rows[rows.length - 1].id : null, level });
      } catch (err) { logger.error('Audit list error:', err.message); res.status(500).json({ success: false, error: 'Could not read the audit log.' }); }
    });
    app.get('/api/audit/facets', noStore, async (req, res) => {
      try { res.json(Object.assign({ success: true }, await store.facets())); }
      catch (err) { logger.error('Audit facets error:', err.message); res.status(500).json({ success: false, error: 'Could not read the audit log.' }); }
    });
    app.get('/api/audit/verify', noStore, async (req, res) => {
      try { res.json(Object.assign({ success: true }, await verifyChain(store))); }
      catch (err) { logger.error('Audit verify error:', err.message); res.status(500).json({ success: false, error: 'Could not verify the audit log.' }); }
    });
    app.get('/api/audit/export.csv', noStore, async (req, res) => {
      try {
        const f = filters(req.query); if (!f) return res.status(400).json({ success: false, error: 'Invalid filter (check the dates and outcome).' });
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"` });
        res.write('id,time,actor,role,ip,action,category,outcome,status,method,path,details\r\n');
        let before = null, sent = 0;
        while (sent < 100000) {                                  // newest first, at most 100,000 rows per export
          const rows = await store.list(Object.assign({}, f, before ? { before } : {}), 1000);
          if (!rows.length) break;
          for (const r of rows) res.write([r.id, r.ts, r.actor_email, r.actor_role, r.ip, r.action, r.category, r.outcome, r.status, r.method, r.path, r.details].map(csvCell).join(',') + '\r\n');
          sent += rows.length; before = rows[rows.length - 1].id;
          if (rows.length < 1000) break;
        }
        res.end();
      } catch (err) { logger.error('Audit export error:', err.message); if (!res.headersSent) res.status(500).json({ success: false, error: 'Export failed.' }); else res.end(); }
    });
  }

  async function init() {
    await store.init(); ready = true;
    record({ action: 'server.start', category: 'system', outcome: 'success', actor: { email: 'system' }, details: { level } });
  }

  return { record, flush, routes, ready: init, store, level, isReady: () => ready };
}

module.exports = setup;
module.exports.pure = { stableStringify, hashRow, normalize, classify, outcomeOf, csvCell, verifyChain, GENESIS };

// ---- self-test ---------------------------------------------------------------------------------------------------
module.exports.selftest = () => {
  return (async () => {
    const assert = require('assert');
    const express = require('express');
    const http = require('http');
    const authSetup = __s.auth;

    // pure
    assert.strictEqual(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
    assert.strictEqual(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"'); assert.strictEqual(csvCell('a,b'), '"a,b"'); assert.strictEqual(csvCell(null), ''); assert.strictEqual(csvCell('-1+1'), "'-1+1");
    assert.deepStrictEqual([200, 302, 401, 403, 429, 404, 500].map(outcomeOf), ['success', 'success', 'denied', 'denied', 'denied', 'failure', 'failure']);
    assert.strictEqual(classify('POST', '/api/import-fhir').action, 'data.import');
    assert.strictEqual(classify('DELETE', '/api/batches/my%20batch').target, 'my batch');
    assert.strictEqual(classify('POST', '/api/pico/parse').action, 'ai.request');
    assert.ok(classify('POST', '/api/readiness/check').ignore);
    assert.strictEqual(classify('GET', '/api/hello'), null);
    const n1 = normalize({ ts: 't', action: 'x', outcome: 'success', details: { z: 1, a: 'x\u0000y' } });
    assert.strictEqual(n1.details.a, 'xy'); assert.strictEqual(n1.status, null);
    assert.notStrictEqual(hashRow(GENESIS, n1), hashRow(GENESIS, Object.assign({}, n1, { path: '/x' })));

    // in-memory store with the same chain logic as the real one
    const rows = [];
    const mem = {
      async init() {},
      async append(r) { const prev = rows.length ? rows[rows.length - 1].row_hash : GENESIS; rows.push(Object.assign({ id: rows.length + 1, prev_hash: prev, row_hash: hashRow(prev, r) }, JSON.parse(JSON.stringify(r)))); },
      async list(f, limit) {
        return rows.filter(r => (!f.from || r.ts >= f.from) && (!f.to || r.ts <= f.to) && (!f.actor || (r.actor_email || '').includes(f.actor)) && (!f.action || r.action.startsWith(f.action))
          && (!f.category || r.category === f.category) && (!f.outcome || r.outcome === f.outcome) && (!f.q || JSON.stringify(r).includes(f.q)) && (!f.before || r.id < f.before)).sort((a, b) => b.id - a.id).slice(0, limit);
      },
      async facets() { return { actions: [], actors: [] }; },
      async chain(after, limit) { return rows.filter(r => r.id > after).slice(0, limit).map(r => JSON.parse(JSON.stringify(r))); }
    };
    const users = [], sessions = new Map();
    const memAuth = {
      async init() {}, async purgeExpired() {}, async countUsers() { return users.length; },
      async findByEmail(e) { return users.find(u => u.email === e) || null; },
      async createUser({ email, hash, role }) { users.push({ id: users.length + 1, email, password_hash: hash, role, is_active: true }); return users.length; },
      async setPassword(id, hash) { users.find(u => u.id === id).password_hash = hash; }, async touchLogin() {},
      async createSession({ tokenHash, userId }) { sessions.set(tokenHash, userId); },
      async findSession(th) { const id = sessions.get(th); const u = users.find(x => x.id === id); return u && u.is_active ? { id: u.id, email: u.email, role: u.role } : null; },
      async deleteSession(th) { sessions.delete(th); },
      async deleteUserSessions(id, except) { for (const [k, v] of sessions) if (v === id && k !== except) sessions.delete(k); }
    };
    const quiet = { log() {}, warn() {}, error(...a) { console.error(...a); } };
    const app = express();
    const audit = setup(app, () => null, { store: mem, env: {}, logger: quiet });
    const auth = authSetup(app, () => null, { importToken: 'tok-tok-tok-tok-tok-tok-tok-tok-1', store: memAuth, audit, env: { ADMIN_EMAIL: 'admin@example.org', ADMIN_PASSWORD: 'a very long password' }, logger: quiet });
    audit.routes();
    app.use(express.json());
    app.post('/api/import-fhir', (req, res) => res.json({ success: true }));
    app.delete('/api/cohorts/:id', (req, res) => res.json({ success: true }));
    app.get('/api/explorer/patient', (req, res) => res.json({ success: true }));
    app.get('/api/ping', (req, res) => res.json({ success: true }));
    app.post('/api/brand-new-write', (req, res) => res.json({ success: true }));
    await audit.ready(); await auth.ready();
    const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const port = srv.address().port;
    const call = (method, p, { body, cookie } = {}) => new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: Object.assign({}, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, cookie ? { Cookie: cookie } : {}) }, res => {
        let s = ''; res.on('data', c => s += c); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) {} resolve({ status: res.statusCode, headers: res.headers, json: j, text: s }); });
      });
      req.on('error', reject); if (data) req.write(data); req.end();
    });
    const find = (action, pred = () => true) => rows.filter(r => r.action === action && pred(r));
    try {
      await call('POST', '/api/import-fhir', { body: { batchId: 'b1', bundle: { entry: [{}, {}] } } });                   // anonymous
      await call('POST', '/api/auth/login', { body: { email: 'admin@example.org', password: 'wrong wrong wrong' } });
      let r = await call('POST', '/api/auth/login', { body: { email: 'admin@example.org', password: 'a very long password' } });
      const cookie = r.headers['set-cookie'][0].split(';')[0];
      await call('POST', '/api/import-fhir', { cookie, body: { batchId: 'b1', password: 'SECRET-IN-BODY', bundle: { entry: [{ patient: 'Jane Doe' }, {}] } } });
      await call('DELETE', '/api/cohorts/7', { cookie });
      await call('GET', '/api/explorer/patient?id=p-123&batchId=b1', { cookie });
      await call('GET', '/api/ping', { cookie });
      await call('POST', '/api/brand-new-write', { cookie, body: {} });
      await call('POST', '/api/auth/change-password', { cookie, body: { currentPassword: 'a very long password', newPassword: 'another long password' } });
      await audit.flush();

      assert.ok(find('server.start').length === 1 && find('user.create').length === 1, 'system events');
      assert.ok(find('login.failure').length === 1 && find('login.success').length === 1, 'sign-in events');
      assert.strictEqual(find('login.failure')[0].actor_email, 'admin@example.org'); assert.strictEqual(find('login.failure')[0].outcome, 'denied');
      assert.strictEqual(find('data.import', x => x.outcome === 'denied')[0].status, 401, 'anonymous import attempt is recorded');
      const imp = find('data.import', x => x.outcome === 'success')[0];
      assert.strictEqual(imp.actor_email, 'admin@example.org'); assert.strictEqual(imp.details.entries, 2); assert.strictEqual(imp.details.batchId, 'b1'); assert.strictEqual(imp.actor_role, 'admin');
      assert.ok(!JSON.stringify(rows).includes('SECRET-IN-BODY') && !JSON.stringify(rows).includes('Jane Doe') && !JSON.stringify(rows).includes('wrong wrong') && !JSON.stringify(rows).includes('long password'), 'no secrets or payloads stored');
      assert.strictEqual(find('cohort.delete')[0].details.target, '7');
      assert.strictEqual(find('phi.view')[0].details.query.id, 'p-123');
      assert.strictEqual(find('api.write')[0].path, '/api/brand-new-write', 'unknown write routes are still caught');
      assert.ok(!rows.some(x => x.path === '/api/ping'), 'plain reads are not recorded at the standard level');
      assert.ok(find('password.change').length === 1);

      r = await call('GET', '/api/audit?action=phi.', { cookie }); assert.strictEqual(r.status, 200); assert.ok(r.json.rows.length === 1 && r.json.rows[0].action === 'phi.view');
      r = await call('GET', '/api/audit?outcome=denied&limit=1', { cookie }); assert.strictEqual(r.json.rows.length, 1); assert.ok(r.json.nextBefore > 0);
      r = await call('GET', '/api/audit?outcome=bogus', { cookie }); assert.strictEqual(r.status, 400);
      r = await call('GET', '/api/audit?from=not-a-date', { cookie }); assert.strictEqual(r.status, 400);
      r = await call('GET', '/api/audit'); assert.strictEqual(r.status, 401, 'viewer needs a session');
      r = await call('GET', '/api/audit/export.csv?action=data.', { cookie }); assert.strictEqual(r.status, 200); assert.ok(/^id,time,actor/.test(r.text) && r.text.includes('data.import') && !r.text.includes('phi.view'));
      r = await call('GET', '/api/audit/verify', { cookie }); assert.ok(r.json.ok && r.json.checked >= 10 && r.json.head.hash.length === 64, 'chain verifies');

      // tampering is found
      const keep = rows[2].path; rows[2].path = '/api/other';
      r = await call('GET', '/api/audit/verify', { cookie }); assert.ok(!r.json.ok && r.json.firstBad.id === rows[2].id, 'edited row found'); rows[2].path = keep;
      const gone = rows.splice(3, 1)[0];
      r = await call('GET', '/api/audit/verify', { cookie }); assert.ok(!r.json.ok, 'removed row found'); rows.splice(3, 0, gone);
      r = await call('GET', '/api/audit/verify', { cookie }); assert.ok(r.json.ok, 'restored chain verifies again');

      // a role without audit:read is refused, and the refusal is recorded
      users[0].role = 'viewer';
      r = await call('GET', '/api/audit', { cookie }); assert.strictEqual(r.status, 403);
      await audit.flush(); assert.ok(find('access.denied').length >= 1, 'refusals are recorded');
      users[0].role = 'admin';
    } finally { srv.close(); }
    console.log('audit.js self-test: all checks passed');
  })().catch(e => { console.error(e); process.exit(1); });
};
return module.exports;
})();
__s.audit = audit;

// ======================================================================
// EXPORTS AND SELF-TEST RUNNER
// ======================================================================
module.exports = { sqlGuard, auth, audit };

if (require.main === module && process.argv.includes('--selftest')) {
  (async () => {
    for (const m of [sqlGuard, auth, audit]) await m.selftest();
    console.log('security.js: all self-tests passed');
  })().catch(e => { console.error(e); process.exit(1); });
}
