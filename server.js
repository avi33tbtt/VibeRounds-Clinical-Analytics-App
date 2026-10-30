require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { from: copyFrom } = require('pg-copy-streams');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const sqlGuard = require('./security').sqlGuard;
const POP = require('./population');   // canonical population keys (batch:<suffix> / group:<base>) shared with analytics
const app = express();
const port = parseInt(process.env.PORT || '3001', 10); // Render sets PORT
console.log('Server.js loaded');

// Sanitize batch ID for use as table name suffix
function sanitizeBatchId(batchId) {
  return batchId.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '');
}


// ---- Import helpers: tolerant value extraction so one odd resource cannot abort a file ----
const stripRef = (r) => (typeof r === 'string' && r) ? r.replace(/^urn:uuid:/, '').replace(/^Patient\//, '') : null;
const cleanStr = (v) => (v === undefined || v === null) ? null : String(v).replace(/\u0000/g, '');
const safeDate = (v) => {
  if (!v) return null;
  const m = String(v).match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (!m) return null;
  const mm = m[2] || '01', dd = m[3] || '01';
  return (+mm >= 1 && +mm <= 12 && +dd >= 1 && +dd <= 31) ? `${m[1]}-${mm}-${dd}` : null;
};
const safeTs = (v) => {
  if (!v) return null;
  const d = safeDate(v); if (!d) return null;
  const t = String(v).match(/T(\d{2}:\d{2}(?::\d{2})?)/);
  return t ? `${d} ${t[1]}` : d;
};
const safeNum = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const safeJson = (o) => JSON.stringify(o).replace(/\\u0000/g, '');

// Enable CORS for all routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-Import-Password');
  next();
});

// Password lock for anything that imports data into the database. The password is IMPORT_PASSWORD (.env / Render env var).
// Fail closed: with no IMPORT_PASSWORD set, imports are refused. It runs BEFORE the body parser, so an unauthenticated
// request never has its (up to 10 GB) body read. The client sends it in the X-Import-Password header. The FHIR connector
// imports through this same server over loopback, so it presents a per-process random token instead of the password.
const crypto = require('crypto');
const IMPORT_TOKEN = crypto.randomBytes(32).toString('hex');
app.locals.importToken = IMPORT_TOKEN;

// Sign-in (users, sessions, role table). Registered here so its gate runs before the import password gate and the body
// parser below: an anonymous request is refused before any body is read. The pool is created further down, hence the getter.
// Audit log. Its request recorder must be registered BEFORE the auth gate (so refused requests are recorded too); its viewer
// routes are registered right after the gate (so only users with the audit:read permission reach them).
const audit = require('./security').audit(app, () => pool);
const auth = require('./security').auth(app, () => pool, { importToken: IMPORT_TOKEN, audit });
audit.routes();
const IMPORT_GATED = new Set(['/api/import-fhir', '/api/init-schema', '/api/ehr/fetch', '/api/snomed/hierarchy/load']);
const sha = v => crypto.createHash('sha256').update(String(v)).digest();
const sameSecret = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const importFails = new Map();   // ip -> { n, until }: 10 wrong passwords locks that address for 5 minutes
app.use((req, res, next) => {
  if (req.method !== 'POST' || !IMPORT_GATED.has(req.path)) return next();
  const expected = process.env.IMPORT_PASSWORD;
  if (!expected) return res.status(503).json({ success: false, error: 'Imports are locked: set IMPORT_PASSWORD on the server and restart.' });
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || '?';
  const tok = req.get('x-import-token');
  if (tok && sameSecret(tok, IMPORT_TOKEN)) return next();
  const f = importFails.get(ip);
  if (f && f.until > Date.now()) return res.status(429).json({ success: false, error: 'Too many wrong passwords. Try again in a few minutes.' });
  const given = req.get('x-import-password');
  if (given && sameSecret(given, expected)) { importFails.delete(ip); return next(); }
  const n = ((f && f.until <= Date.now() ? 0 : f && f.n) || 0) + 1;
  importFails.set(ip, { n, until: n >= 10 ? Date.now() + 5 * 60 * 1000 : 0 });
  return res.status(401).json({ success: false, code: 'IMPORT_PASSWORD_REQUIRED', error: given ? 'Wrong import password.' : 'Import password required.' });
});

// Parse JSON bodies
app.use(express.json({ limit: '10gb' })); // global parser runs first, so its limit must cover FHIR bundle imports

// Step D.2c: the analytics condition dropdown is built from the data and cached per scope. Clear that cache after any
// successful data-changing request (import, batch / group delete, cohort create/update/delete/activate, schema init).
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && !/^\/api\/(analytics|kg|concepts|synthetic|snomed)(\/|$)/.test(req.path)) {
    res.on('finish', () => { if (res.statusCode < 400 && app.locals.clearConceptCache) app.locals.clearConceptCache(); });
  }
  next();
});

// Database connection config - using environment variables for Docker compatibility
// Database config. On Render set DATABASE_URL (the Postgres "Internal Database URL").
// Without it, the separate DB_* variables are used (local Docker / development).
// SSL: needed for Render's *external* URL (host ends in .render.com); not needed for the internal URL.
const dbUrl = process.env.DATABASE_URL;
const useSsl = process.env.DB_SSL === 'true' || (process.env.DB_SSL !== 'false' && !!dbUrl && /\.render\.com/.test(dbUrl));
const pool = new Pool(dbUrl ? {
  connectionString: dbUrl,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
} : {
  user: process.env.DB_USER || 'user',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'testdb',
  password: process.env.DB_PASSWORD || 'password',
  port: parseInt(process.env.DB_PORT || '5433', 10),
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Log the target without the password
console.log(dbUrl
  ? `Database config: DATABASE_URL (${(() => { try { const u = new URL(dbUrl); return u.hostname + ':' + (u.port || 5432) + u.pathname; } catch (e) { return 'unparseable URL'; } })()}), ssl=${useSsl}`
  : `Database config: ${process.env.DB_USER || 'user'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '5433'}/${process.env.DB_NAME || 'testdb'}`);


// ---- Read-only connection ----------------------------------------------------------------------------------------
// Everything that runs user-written SQL (cohort criteria) or analytics goes through readPool, which connects as a
// SELECT-only role (see db-readonly.sql). `pool` (read/write) is kept only for imports, schema set-up, cohort / settings
// bookkeeping, sign-in and the audit log. Set DATABASE_READONLY_URL (or DB_RO_USER + DB_RO_PASSWORD) and REQUIRE_READONLY=true.
const roUrl = process.env.DATABASE_READONLY_URL;
const roSsl = process.env.DB_SSL === 'true' || (process.env.DB_SSL !== 'false' && !!roUrl && /\.render\.com/.test(roUrl));
const readPool = roUrl ? new Pool({ connectionString: roUrl, ssl: roSsl ? { rejectUnauthorized: false } : false, statement_timeout: 120000 })
  : process.env.DB_RO_USER ? new Pool({ user: process.env.DB_RO_USER, password: process.env.DB_RO_PASSWORD || '', host: process.env.DB_HOST || 'localhost',
      database: process.env.DB_NAME || 'testdb', port: parseInt(process.env.DB_PORT || '5433', 10), ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false, statement_timeout: 120000 })
  : pool;
const hasReadOnlyPool = readPool !== pool;
if (hasReadOnlyPool) readPool.on('error', e => console.error('Read-only pool error:', e.message));
// Called at start-up. Reports (or, with REQUIRE_READONLY=true, refuses to start) when the "read-only" connection could still write.
async function verifyReadOnly() {
  const must = String(process.env.REQUIRE_READONLY || '').toLowerCase() === 'true';
  let problem = null;
  if (!hasReadOnlyPool) problem = 'No read-only database connection is configured (DATABASE_READONLY_URL). Cohort SQL and analytics run with the read/write connection; only the SQL text guard protects the data.';
  else {
    const r = await readPool.query(`SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su,
      (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
         AND (has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE') OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE'))) AS writable`);
    const x = r.rows[0];
    if (x.su || x.writable > 0) problem = `The read-only connection (user "${x.u}") is NOT read-only: ${x.su ? 'it is a superuser' : x.writable + ' table(s) are writable by it'}. Use the role from db-readonly.sql.`;
    else console.log(`Read-only connection verified: user "${x.u}" has no write access to any table.`);
  }
  if (problem) { console.error('READ-ONLY CHECK FAILED: ' + problem); if (must) { console.error('REQUIRE_READONLY=true, refusing to start.'); process.exit(1); } }
}

// Endpoint to fetch the "hello world" message from the DB
app.get('/api/hello', async (req, res) => {
  try {
    const result = await pool.query('SELECT content FROM messages LIMIT 1');
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No message found' });
    }
    res.json({ message: result.rows[0].content });
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});

// New endpoint to show database connection details
app.get('/api/db-info', async (req, res) => {
  try {
    // Test connection and get database info
    const versionResult = await pool.query('SELECT version();');
    const dbResult = await pool.query('SELECT current_database() as db, current_user as user, inet_server_addr() as host, inet_server_port() as port;');
    const tableResult = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';");
    
    res.json({
      success: true,
      database: {
        version: versionResult.rows[0].version,
        name: dbResult.rows[0].db,
        user: dbResult.rows[0].user,
        host: dbResult.rows[0].host,
        port: parseInt(dbResult.rows[0].port),
        tables: tableResult.rows.map(row => row.table_name)
      },
      connectionPool: {
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount,
        totalCount: pool.totalCount
      }
    });
  } catch (err) {
    console.error('Database info error:', err);
    res.status(500).json({ error: 'Failed to get database info', details: err.message });
  }
});

// ---- Database schema (single source of truth for /api/init-schema and startup) ----
const SCHEMA_SQL = `
      -- Create standardized FHIR tables

      -- Patients table
      CREATE TABLE IF NOT EXISTS fhir_patient (
        id SERIAL PRIMARY KEY,
        fhir_resource_id VARCHAR(255) UNIQUE NOT NULL,
        fhir_resource_type VARCHAR(50) NOT NULL DEFAULT 'Patient',
        patient_id VARCHAR(255) NOT NULL,
        gender VARCHAR(50),
        birth_date DATE,
        address JSONB,
        json_content JSONB,
        imported_at TIMESTAMP DEFAULT NOW(),
        ingestion_batch_id VARCHAR(255)
      );

      -- Encounters table
      CREATE TABLE IF NOT EXISTS fhir_encounter (
        id SERIAL PRIMARY KEY,
        fhir_resource_id VARCHAR(255) UNIQUE NOT NULL,
        fhir_resource_type VARCHAR(50) NOT NULL DEFAULT 'Encounter',
        patient_id VARCHAR(255) NOT NULL,
        encounter_type VARCHAR(50),
        start_date TIMESTAMP,
        end_date TIMESTAMP,
        json_content JSONB,
        imported_at TIMESTAMP DEFAULT NOW(),
        ingestion_batch_id VARCHAR(255)
      );

      -- Observations (labs, vitals) table
      CREATE TABLE IF NOT EXISTS fhir_observation (
        id SERIAL PRIMARY KEY,
        fhir_resource_id VARCHAR(255) UNIQUE NOT NULL,
        fhir_resource_type VARCHAR(50) NOT NULL DEFAULT 'Observation',
        patient_id VARCHAR(255) NOT NULL,
        code VARCHAR(50),
        code_system VARCHAR(255),
        value NUMERIC,
        unit VARCHAR(50),
        effective_date TIMESTAMP,
        json_content JSONB,
        imported_at TIMESTAMP DEFAULT NOW(),
        ingestion_batch_id VARCHAR(255)
      );

      -- Diagnoses/Conditions table
      CREATE TABLE IF NOT EXISTS fhir_diagnosis (
        id SERIAL PRIMARY KEY,
        fhir_resource_id VARCHAR(255) UNIQUE NOT NULL,
        fhir_resource_type VARCHAR(50) NOT NULL DEFAULT 'Condition',
        patient_id VARCHAR(255) NOT NULL,
        code VARCHAR(50),
        code_system VARCHAR(255),
        onset_date DATE,
        json_content JSONB,
        imported_at TIMESTAMP DEFAULT NOW(),
        ingestion_batch_id VARCHAR(255)
      );

      -- Procedures table
      CREATE TABLE IF NOT EXISTS fhir_procedure (
        id SERIAL PRIMARY KEY,
        fhir_resource_id VARCHAR(255) UNIQUE NOT NULL,
        fhir_resource_type VARCHAR(50) NOT NULL DEFAULT 'Procedure',
        patient_id VARCHAR(255) NOT NULL,
        code VARCHAR(50),
        performed_date TIMESTAMP,
        json_content JSONB,
        imported_at TIMESTAMP DEFAULT NOW(),
        ingestion_batch_id VARCHAR(255)
      );

      -- Immunizations table
      CREATE TABLE IF NOT EXISTS fhir_immunization (
        id SERIAL PRIMARY KEY,
        fhir_resource_id VARCHAR(255) UNIQUE NOT NULL,
        fhir_resource_type VARCHAR(50) NOT NULL DEFAULT 'Immunization',
        patient_id VARCHAR(255) NOT NULL,
        vaccine_code VARCHAR(50),
        occurrence_date TIMESTAMP,
        json_content JSONB,
        imported_at TIMESTAMP DEFAULT NOW(),
        ingestion_batch_id VARCHAR(255)
      );

      -- Medications table
      CREATE TABLE IF NOT EXISTS fhir_medication (
        id SERIAL PRIMARY KEY,
        fhir_resource_id VARCHAR(255) UNIQUE NOT NULL,
        fhir_resource_type VARCHAR(50) NOT NULL DEFAULT 'MedicationStatement',
        patient_id VARCHAR(255) NOT NULL,
        medication_code VARCHAR(50),
        prescribed_date TIMESTAMP,
        json_content JSONB,
        imported_at TIMESTAMP DEFAULT NOW(),
        ingestion_batch_id VARCHAR(255)
      );

      -- Allergies table
      CREATE TABLE IF NOT EXISTS fhir_allergy (
        id SERIAL PRIMARY KEY,
        fhir_resource_id VARCHAR(255) UNIQUE NOT NULL,
        fhir_resource_type VARCHAR(50) NOT NULL DEFAULT 'AllergyIntolerance',
        patient_id VARCHAR(255) NOT NULL,
        substance VARCHAR(255),
        reaction VARCHAR(255),
        severity VARCHAR(50),
        json_content JSONB,
        imported_at TIMESTAMP DEFAULT NOW(),
        ingestion_batch_id VARCHAR(255)
      );

      -- Cohorts table
      CREATE TABLE IF NOT EXISTS cohorts (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        criteria_sql TEXT,
        population_scope VARCHAR(255),
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      -- Saved PICO/PECO parameter templates (form values only, no patient data)
      CREATE TABLE IF NOT EXISTS pico_templates (
        id SERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL UNIQUE,
        analytic VARCHAR(40) NOT NULL,
        params_json JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- App settings (OpenRouter API key and model slug; plain text, fine for a local demo only)
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      -- Reviewer decisions about concepts and pairs (Step D.8): override, then data-derived value, then terminology.js seed. No patient data.
      CREATE TABLE IF NOT EXISTS concept_overrides (
        id SERIAL PRIMARY KEY,
        kind VARCHAR(20) NOT NULL CHECK (kind IN ('risky_pair','chronic','first_line','lab_limit')),
        key VARCHAR(100) NOT NULL,
        key2 VARCHAR(100) NOT NULL DEFAULT '',
        decision VARCHAR(10) NOT NULL CHECK (decision IN ('accepted','rejected','edited')),
        label VARCHAR(200),
        chronic BOOLEAN,
        first_line_for VARCHAR(100),
        risky_with VARCHAR(100),
        abnormal_low NUMERIC,
        abnormal_high NUMERIC,
        note VARCHAR(500),
        source VARCHAR(20) NOT NULL DEFAULT 'manual',
        suggested_scope VARCHAR(200),
        suggested_on DATE,
        reviewed_by VARCHAR(60) NOT NULL,
        reviewed_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (kind, key, key2)
      );

      -- Code enrichment (V3 / V5): one decision per (domain, text_key), global across batches. Strings and codes only, no patient data.
      -- A code is optional while a row is only proposed; an approved or edited row must carry a code.
      CREATE TABLE IF NOT EXISTS code_enrichment (
        id SERIAL PRIMARY KEY,
        domain VARCHAR(2) NOT NULL CHECK (domain IN ('dx','rx','ob','pr','al','im')),
        text_key VARCHAR(500) NOT NULL,
        system VARCHAR(200),
        code VARCHAR(100),
        display VARCHAR(500),
        assertion VARCHAR(10) NOT NULL DEFAULT 'confirmed' CHECK (assertion IN ('confirmed','suspected','negated')),
        status VARCHAR(10) NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','edited','rejected')),
        confidence NUMERIC(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        model VARCHAR(100),
        prompt_version VARCHAR(40),
        reviewed_by VARCHAR(60),
        reviewed_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (domain, text_key),
        CHECK (status NOT IN ('approved','edited') OR (code IS NOT NULL AND system IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_code_enrichment_status ON code_enrichment(status);

      -- Create indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_fhir_patient_patient_id ON fhir_patient(patient_id);
      CREATE INDEX IF NOT EXISTS idx_fhir_patient_batch ON fhir_patient(ingestion_batch_id);
      CREATE INDEX IF NOT EXISTS idx_fhir_encounter_patient_id ON fhir_encounter(patient_id);
      CREATE INDEX IF NOT EXISTS idx_fhir_encounter_batch ON fhir_encounter(ingestion_batch_id);
      CREATE INDEX IF NOT EXISTS idx_fhir_observation_patient_id ON fhir_observation(patient_id);
      CREATE INDEX IF NOT EXISTS idx_fhir_observation_code ON fhir_observation(code);
      CREATE INDEX IF NOT EXISTS idx_fhir_observation_batch ON fhir_observation(ingestion_batch_id);
      CREATE INDEX IF NOT EXISTS idx_fhir_diagnosis_patient_id ON fhir_diagnosis(patient_id);
      CREATE INDEX IF NOT EXISTS idx_fhir_diagnosis_code ON fhir_diagnosis(code);
      CREATE INDEX IF NOT EXISTS idx_fhir_diagnosis_batch ON fhir_diagnosis(ingestion_batch_id);
      CREATE INDEX IF NOT EXISTS idx_fhir_procedure_patient_id ON fhir_procedure(patient_id);
      CREATE INDEX IF NOT EXISTS idx_fhir_procedure_batch ON fhir_procedure(ingestion_batch_id);
      CREATE INDEX IF NOT EXISTS idx_fhir_immunization_patient_id ON fhir_immunization(patient_id);
      CREATE INDEX IF NOT EXISTS idx_fhir_immunization_batch ON fhir_immunization(ingestion_batch_id);
      CREATE INDEX IF NOT EXISTS idx_fhir_medication_patient_id ON fhir_medication(patient_id);
      CREATE INDEX IF NOT EXISTS idx_fhir_medication_batch ON fhir_medication(ingestion_batch_id);
      CREATE INDEX IF NOT EXISTS idx_fhir_allergy_patient_id ON fhir_allergy(patient_id);
      CREATE INDEX IF NOT EXISTS idx_fhir_allergy_batch ON fhir_allergy(ingestion_batch_id);
`;

// Startup also seeds the hello-world messages table
const STARTUP_SQL = `
      -- Initialize messages table for hello world endpoint
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        content VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      -- Remove duplicate messages from earlier runs, keep the oldest of each
      DELETE FROM messages a USING messages b WHERE a.content = b.content AND a.id > b.id;
      CREATE UNIQUE INDEX IF NOT EXISTS messages_content_uniq ON messages (content);
      
      INSERT INTO messages (content) SELECT 'Hello from Vibe Rounds!' WHERE NOT EXISTS (SELECT 1 FROM messages WHERE content = 'Hello from Vibe Rounds!');
` + SCHEMA_SQL;

// Endpoint to initialize database schema (including cohorts table)
app.post('/api/init-schema', async (req, res) => {
  try {
    
    await pool.query(SCHEMA_SQL);
    res.json({ success: true, message: 'Database schema initialized successfully' });
  } catch (err) {
    console.error('Schema init error:', err);
    res.status(500).json({ error: 'Schema initialization failed', details: err.message });
  }
});

// Endpoint to import FHIR data into batch-specific tables
// Limit is 10GB per request (the client sends small chunks, so this is just headroom)
app.post('/api/import-fhir', express.json({ limit: '10gb' }), async (req, res) => {
  console.log('Import FHIR endpoint called');
  const client = await pool.connect();
  try {
    const { batchId } = req.body;
    let bundle = req.body.bundle;
    // Accept a Bundle, a bare array of resources (CSV/NDJSON path) or a single resource
    if (Array.isArray(bundle)) bundle = { resourceType: 'Bundle', entry: bundle.map(r => (r && r.resource) ? r : { resource: r }) };
    else if (bundle && bundle.resourceType && bundle.resourceType !== 'Bundle') bundle = { resourceType: 'Bundle', entry: [{ resource: bundle }] };
    console.log('Import request:', { batchId, entries: bundle && bundle.entry ? bundle.entry.length : 0 });
    
    if (!batchId || typeof batchId !== 'string') {
      return res.status(400).json({ error: 'batchId is required' });
    }
    if (!bundle || !Array.isArray(bundle.entry)) {
      return res.status(400).json({ error: 'Invalid FHIR Bundle format: expected a Bundle with an entry array, an array of resources, or a single resource' });
    }
    
    await client.query('BEGIN');
    
    const importBatchId = batchId || `import_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const batchSuffix = sanitizeBatchId(importBatchId);
    console.log('Batch ID:', importBatchId, 'Batch suffix:', batchSuffix);
    
    // Define table structures - create SQL dynamically to avoid template literal evaluation at definition time
    const tableTypes = [
      { name: 'fhir_patient', sql: `
        CREATE TABLE IF NOT EXISTS fhir_patient_${batchSuffix} (
          id SERIAL PRIMARY KEY,
          fhir_resource_id VARCHAR(255) UNIQUE NOT NULL,
          fhir_resource_type VARCHAR(50) NOT NULL DEFAULT 'Patient',
          patient_id VARCHAR(255) NOT NULL,
          gender VARCHAR(50),
          birth_date DATE,
          address JSONB,
          json_content JSONB,
          imported_at TIMESTAMP DEFAULT NOW(),
          ingestion_batch_id VARCHAR(255)
        );
      `},
      { name: 'fhir_encounter', sql: `
        CREATE TABLE IF NOT EXISTS fhir_encounter_${batchSuffix} (
          id SERIAL PRIMARY KEY,
          fhir_resource_id VARCHAR(255) UNIQUE NOT NULL,
          fhir_resource_type VARCHAR(50) NOT NULL DEFAULT 'Encounter',
          patient_id VARCHAR(255) NOT NULL,
          encounter_type VARCHAR(50),
          start_date TIMESTAMP,
          end_date TIMESTAMP,
          json_content JSONB,
          imported_at TIMESTAMP DEFAULT NOW(),
          ingestion_batch_id VARCHAR(255)
        );
      `},
      { name: 'fhir_observation', sql: `
        CREATE TABLE IF NOT EXISTS fhir_observation_${batchSuffix} (
          id SERIAL PRIMARY KEY,
          fhir_resource_id VARCHAR(255) UNIQUE NOT NULL,
          fhir_resource_type VARCHAR(50) NOT NULL DEFAULT 'Observation',
          patient_id VARCHAR(255) NOT NULL,
          code VARCHAR(50),
          code_system VARCHAR(255),
          value NUMERIC,
          unit VARCHAR(50),
          effective_date TIMESTAMP,
          json_content JSONB,
          imported_at TIMESTAMP DEFAULT NOW(),
          ingestion_batch_id VARCHAR(255)
        );
      `},
      { name: 'fhir_diagnosis', sql: `
        CREATE TABLE IF NOT EXISTS fhir_diagnosis_${batchSuffix} (
          id SERIAL PRIMARY KEY,
          fhir_resource_id VARCHAR(255) UNIQUE NOT NULL,
          fhir_resource_type VARCHAR(50) NOT NULL DEFAULT 'Condition',
          patient_id VARCHAR(255) NOT NULL,
          code VARCHAR(50),
          code_system VARCHAR(255),
          onset_date DATE,
          json_content JSONB,
          imported_at TIMESTAMP DEFAULT NOW(),
          ingestion_batch_id VARCHAR(255)
        );
      `},
      { name: 'fhir_procedure', sql: `
        CREATE TABLE IF NOT EXISTS fhir_procedure_${batchSuffix} (
          id SERIAL PRIMARY KEY,
          fhir_resource_id VARCHAR(255) UNIQUE NOT NULL,
          fhir_resource_type VARCHAR(50) NOT NULL DEFAULT 'Procedure',
          patient_id VARCHAR(255) NOT NULL,
          code VARCHAR(50),
          performed_date TIMESTAMP,
          json_content JSONB,
          imported_at TIMESTAMP DEFAULT NOW(),
          ingestion_batch_id VARCHAR(255)
        );
      `},
      { name: 'fhir_immunization', sql: `
        CREATE TABLE IF NOT EXISTS fhir_immunization_${batchSuffix} (
          id SERIAL PRIMARY KEY,
          fhir_resource_id VARCHAR(255) UNIQUE NOT NULL,
          fhir_resource_type VARCHAR(50) NOT NULL DEFAULT 'Immunization',
          patient_id VARCHAR(255) NOT NULL,
          vaccine_code VARCHAR(50),
          occurrence_date TIMESTAMP,
          json_content JSONB,
          imported_at TIMESTAMP DEFAULT NOW(),
          ingestion_batch_id VARCHAR(255)
        );
      `},
      { name: 'fhir_medication', sql: `
        CREATE TABLE IF NOT EXISTS fhir_medication_${batchSuffix} (
          id SERIAL PRIMARY KEY,
          fhir_resource_id VARCHAR(255) UNIQUE NOT NULL,
          fhir_resource_type VARCHAR(50) NOT NULL DEFAULT 'MedicationStatement',
          patient_id VARCHAR(255) NOT NULL,
          medication_code VARCHAR(50),
          prescribed_date TIMESTAMP,
          json_content JSONB,
          imported_at TIMESTAMP DEFAULT NOW(),
          ingestion_batch_id VARCHAR(255)
        );
      `},
      { name: 'fhir_allergy', sql: `
        CREATE TABLE IF NOT EXISTS fhir_allergy_${batchSuffix} (
          id SERIAL PRIMARY KEY,
          fhir_resource_id VARCHAR(255) UNIQUE NOT NULL,
          fhir_resource_type VARCHAR(50) NOT NULL DEFAULT 'AllergyIntolerance',
          patient_id VARCHAR(255) NOT NULL,
          substance VARCHAR(255),
          reaction VARCHAR(255),
          severity VARCHAR(50),
          json_content JSONB,
          imported_at TIMESTAMP DEFAULT NOW(),
          ingestion_batch_id VARCHAR(255)
        );
      `}
    ];
    
    // Create all batch-specific tables
    for (const { name, sql } of tableTypes) {
      console.log(`Creating table for ${name} with suffix ${batchSuffix}`);
      await client.query(sql);
      console.log(`Created table for ${name}`);
      
      // Create indexes for common queries
      await client.query(`CREATE INDEX IF NOT EXISTS idx_fhir_${batchSuffix}_patient_id ON fhir_${name.split('_')[1]}_${batchSuffix}(patient_id);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_fhir_${batchSuffix}_batch ON fhir_${name.split('_')[1]}_${batchSuffix}(ingestion_batch_id);`);
      
      // Additional indexes based on table type
      if (name === 'fhir_observation') {
        await client.query(`CREATE INDEX IF NOT EXISTS idx_fhir_${batchSuffix}_observation_code ON fhir_observation_${batchSuffix}(code);`);
      }
      if (name === 'fhir_diagnosis') {
        await client.query(`CREATE INDEX IF NOT EXISTS idx_fhir_${batchSuffix}_diagnosis_code ON fhir_diagnosis_${batchSuffix}(code);`);
      }
      if (name === 'fhir_procedure') {
        await client.query(`CREATE INDEX IF NOT EXISTS idx_fhir_${batchSuffix}_procedure_patient_id ON fhir_procedure_${batchSuffix}(patient_id);`);
      }
      if (name === 'fhir_immunization') {
        await client.query(`CREATE INDEX IF NOT EXISTS idx_fhir_${batchSuffix}_immunization_patient_id ON fhir_immunization_${batchSuffix}(patient_id);`);
      }
      if (name === 'fhir_medication') {
        await client.query(`CREATE INDEX IF NOT EXISTS idx_fhir_${batchSuffix}_medication_patient_id ON fhir_medication_${batchSuffix}(patient_id);`);
      }
      if (name === 'fhir_allergy') {
        await client.query(`CREATE INDEX IF NOT EXISTS idx_fhir_${batchSuffix}_allergy_patient_id ON fhir_allergy_${batchSuffix}(patient_id);`);
      }
    }
    
    await client.query(`CREATE TABLE IF NOT EXISTS fhir_organization_${batchSuffix} (
      id SERIAL PRIMARY KEY, fhir_resource_id VARCHAR(255) UNIQUE NOT NULL, name TEXT, city VARCHAR(255),
      state VARCHAR(50), zip VARCHAR(20), phone VARCHAR(50), json_content JSONB, ingestion_batch_id VARCHAR(255))`);
    let importedCounts = {
      patients: 0,
      conditions: 0,
      observations: 0,
      medications: 0,
      encounters: 0,
      procedures: 0,
      immunizations: 0,
      allergies: 0,
      organizations: 0,
      skipped: 0
    };
    const skippedErrors = [];
    
    // Fast mode first (no per-row savepoints); if anything fails, the chunk is rolled back
    // and replayed in safe mode where each resource gets its own savepoint and bad ones are skipped.
    // Table definitions: column order is the order of values passed to emit().
    // `ts` tables also get imported_at = NOW(). `upd` = columns refreshed on conflict.
    const DEFS = {
      organization: { tbl: 'fhir_organization', ts: false, cols: ['fhir_resource_id','name','city','state','zip','phone','json_content','ingestion_batch_id'], upd: ['name','city','state','zip','phone','json_content'] },
      patient:      { tbl: 'fhir_patient',      ts: true,  cols: ['fhir_resource_id','fhir_resource_type','patient_id','gender','birth_date','address','json_content','ingestion_batch_id'], upd: ['gender','birth_date','address','json_content','ingestion_batch_id'] },
      diagnosis:    { tbl: 'fhir_diagnosis',    ts: true,  cols: ['fhir_resource_id','fhir_resource_type','patient_id','code','code_system','onset_date','json_content','ingestion_batch_id'], upd: ['patient_id','code','code_system','onset_date','json_content','ingestion_batch_id'] },
      observation:  { tbl: 'fhir_observation',  ts: true,  cols: ['fhir_resource_id','fhir_resource_type','patient_id','code','code_system','value','unit','effective_date','json_content','ingestion_batch_id'], upd: ['patient_id','code','code_system','value','unit','effective_date','json_content','ingestion_batch_id'] },
      medication:   { tbl: 'fhir_medication',   ts: true,  cols: ['fhir_resource_id','fhir_resource_type','patient_id','medication_code','prescribed_date','json_content','ingestion_batch_id'], upd: ['patient_id','medication_code','prescribed_date','json_content','ingestion_batch_id'] },
      encounter:    { tbl: 'fhir_encounter',    ts: true,  cols: ['fhir_resource_id','fhir_resource_type','patient_id','encounter_type','start_date','end_date','json_content','ingestion_batch_id'], upd: ['patient_id','encounter_type','start_date','end_date','json_content','ingestion_batch_id'] },
      procedure:    { tbl: 'fhir_procedure',    ts: true,  cols: ['fhir_resource_id','fhir_resource_type','patient_id','code','performed_date','json_content','ingestion_batch_id'], upd: ['patient_id','code','performed_date','json_content','ingestion_batch_id'] },
      immunization: { tbl: 'fhir_immunization', ts: true,  cols: ['fhir_resource_id','fhir_resource_type','patient_id','vaccine_code','occurrence_date','json_content','ingestion_batch_id'], upd: ['patient_id','vaccine_code','occurrence_date','json_content','ingestion_batch_id'] },
      allergy:      { tbl: 'fhir_allergy',      ts: true,  cols: ['fhir_resource_id','fhir_resource_type','patient_id','substance','reaction','severity','json_content','ingestion_batch_id'], upd: ['patient_id','substance','reaction','severity','json_content','ingestion_batch_id'] }
    };
    const upsertSet = (d) => d.upd.map(c => `${c} = EXCLUDED.${c}`).join(', ') + (d.ts ? ', imported_at = NOW()' : '');
    // Single-row upsert (safe mode)
    const insertSql = (d) => `INSERT INTO ${d.tbl}_${batchSuffix} (${d.cols.join(', ')}${d.ts ? ', imported_at' : ''})
      VALUES (${d.cols.map((_, i) => '$' + (i + 1)).join(', ')}${d.ts ? ', NOW()' : ''})
      ON CONFLICT (fhir_resource_id) DO UPDATE SET ${upsertSet(d)}`;
    // CSV field for COPY: NULL = unquoted empty, everything else quoted
    const csvField = (v) => (v === null || v === undefined) ? '' : '"' + String(v).replace(/"/g, '""') + '"';
    // Bulk path: COPY rows into a temp staging table, then one set-based upsert into the real table
    const bulkLoad = async (key, rows) => {
      const d = DEFS[key];
      const stg = `stg_${key}`;
      await client.query(`DROP TABLE IF EXISTS ${stg}`);
      await client.query(`CREATE TEMP TABLE ${stg} ON COMMIT DROP AS SELECT ${d.cols.join(', ')} FROM ${d.tbl}_${batchSuffix} WITH NO DATA`);
      const copyStream = client.query(copyFrom(`COPY ${stg} (${d.cols.join(', ')}) FROM STDIN WITH (FORMAT csv)`));
      function* chunks() {
        const PER = 2000;
        for (let i = 0; i < rows.length; i += PER) {
          yield rows.slice(i, i + PER).map(r => r.map(csvField).join(',')).join('\n') + '\n';
        }
      }
      await pipeline(Readable.from(chunks()), copyStream);
      // DISTINCT ON keeps the last occurrence of a duplicated resource id (matches row-by-row upsert semantics)
      await client.query(`INSERT INTO ${d.tbl}_${batchSuffix} (${d.cols.join(', ')}${d.ts ? ', imported_at' : ''})
        SELECT DISTINCT ON (fhir_resource_id) ${d.cols.join(', ')}${d.ts ? ', NOW()' : ''} FROM ${stg}
        ORDER BY fhir_resource_id, ctid DESC
        ON CONFLICT (fhir_resource_id) DO UPDATE SET ${upsertSet(d)}`);
      await client.query(`DROP TABLE ${stg}`);
    };

    // Fast mode (COPY, no per-row work in the DB) first; if anything fails, the chunk is rolled back
    // and replayed in safe mode where each resource gets its own savepoint and bad ones are skipped.
    const runAll = async (safe) => {
    for (const k of Object.keys(importedCounts)) importedCounts[k] = 0;
    skippedErrors.length = 0;
    const buf = {};
    for (const k of Object.keys(DEFS)) buf[k] = [];
    const emit = async (key, vals) => {
      if (safe) await client.query(insertSql(DEFS[key]), vals);
      else buf[key].push(vals);
    };
    for (const entry of bundle.entry) {
      const resource = entry.resource;
      if (!resource || !resource.resourceType) continue;
      
      const resourceType = resource.resourceType;
      const resourceId = cleanStr(resource.id) || `unknown_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      
      // Store the full JSON for reference
      const jsonContent = safeJson(resource);
      
      if (safe) await client.query('SAVEPOINT res_sp');
      try {
      switch (resourceType) {
        case 'Organization': {
          const addr = resource.address?.[0] || {};
          await emit('organization', [resourceId, cleanStr(resource.name), cleanStr(addr.city), cleanStr(addr.state), cleanStr(addr.postalCode), cleanStr(resource.telecom?.[0]?.value), jsonContent, importBatchId]);
          importedCounts.organizations++;
          break;
        }
        case 'Patient': {
          const gender = resource.gender || 'unknown';
          const birthDate = safeDate(resource.birthDate);
          const address = resource.address ? JSON.stringify(resource.address[0]) : null;
          await emit('patient', [resourceId, resourceType, resourceId, gender, birthDate, address, jsonContent, importBatchId]);
          importedCounts.patients++;
          break;
        }
        case 'Condition': {
          const patientId = stripRef(resource.subject?.reference) || stripRef(resource.patient?.reference) || 'unknown';
          const code = resource.code?.coding?.[0]?.code || null;
          const codeSystem = resource.code?.coding?.[0]?.system || null;
          const onsetDate = safeTs(resource.onsetDateTime || resource.recordedDate);
          await emit('diagnosis', [resourceId, resourceType, patientId, code, codeSystem, onsetDate, jsonContent, importBatchId]);
          importedCounts.conditions++;
          break;
        }
        case 'Observation': {
          const patientId = stripRef(resource.subject?.reference) || stripRef(resource.patient?.reference) || 'unknown';
          const code = resource.code?.coding?.[0]?.code || null;
          const codeSystem = resource.code?.coding?.[0]?.system || null;
          const value = safeNum(resource.valueQuantity?.value ?? resource.valueInteger ?? resource.valueString);
          const unit = resource.valueQuantity?.unit || null;
          const effectiveDate = safeTs(resource.effectiveDateTime || resource.issued);
          await emit('observation', [resourceId, resourceType, patientId, code, codeSystem, value, unit, effectiveDate, jsonContent, importBatchId]);
          importedCounts.observations++;
          break;
        }
        case 'MedicationStatement':
        case 'MedicationRequest': {
          const patientId = stripRef(resource.subject?.reference) || stripRef(resource.patient?.reference) || 'unknown';
          const medCode = cleanStr(resource.medicationCodeableConcept?.coding?.[0]?.code) || null;
          const prescribedDate = safeTs(resource.effectiveDateTime || resource.authoredOn);
          await emit('medication', [resourceId, resourceType, patientId, medCode, prescribedDate, jsonContent, importBatchId]);
          importedCounts.medications++;
          break;
        }
        case 'Encounter': {
          const patientId = stripRef(resource.subject?.reference) || stripRef(resource.patient?.reference) || 'unknown';
          const encounterType = resource.class?.code || null;
          const startDate = safeTs(resource.period?.start);
          const endDate = safeTs(resource.period?.end);
          await emit('encounter', [resourceId, resourceType, patientId, encounterType, startDate, endDate, jsonContent, importBatchId]);
          importedCounts.encounters++;
          break;
        }
        case 'Procedure': {
          const patientId = stripRef(resource.subject?.reference) || stripRef(resource.patient?.reference) || 'unknown';
          const code = resource.code?.coding?.[0]?.code || null;
          const performedDate = safeTs(resource.performedDateTime || resource.performedPeriod?.start);
          await emit('procedure', [resourceId, resourceType, patientId, code, performedDate, jsonContent, importBatchId]);
          importedCounts.procedures++;
          break;
        }
        case 'Immunization': {
          const patientId = stripRef(resource.patient?.reference) || stripRef(resource.subject?.reference) || 'unknown';
          const vaccineCode = resource.vaccineCode?.coding?.[0]?.code || null;
          const occurrenceDate = safeTs(resource.occurrenceDateTime || resource.occurrenceString);
          await emit('immunization', [resourceId, resourceType, patientId, vaccineCode, occurrenceDate, jsonContent, importBatchId]);
          importedCounts.immunizations++;
          break;
        }
        case 'AllergyIntolerance': {
          const patientId = resource.patient?.reference?.replace('Patient/', '') || null;
          const substance = resource.code?.coding?.[0]?.display || resource.code?.text || null;
          const reaction = resource.reaction?.[0]?.manifestation?.[0]?.coding?.[0]?.display || null;
          const severity = resource.reaction?.[0]?.severity || null;
          await emit('allergy', [resourceId, resourceType, patientId, substance, reaction, severity, jsonContent, importBatchId]);
          importedCounts.allergies++;
          break;
        }
      }
      if (safe) await client.query('RELEASE SAVEPOINT res_sp');
      } catch (rowErr) {
        if (!safe) throw rowErr;
        await client.query('ROLLBACK TO SAVEPOINT res_sp');
        importedCounts.skipped++;
        if (skippedErrors.length < 5) skippedErrors.push(`${resourceType}/${resourceId}: ${rowErr.message}`);
      }
    }
    if (!safe) {
      for (const key of Object.keys(DEFS)) {
        if (buf[key].length) await bulkLoad(key, buf[key]);
      }
    }
    };
    await client.query('SAVEPOINT chunk_sp');
    try {
      await runAll(false);
      await client.query('RELEASE SAVEPOINT chunk_sp');
    } catch (fastErr) {
      console.warn('Fast import failed, replaying chunk in safe mode:', fastErr.message);
      await client.query('ROLLBACK TO SAVEPOINT chunk_sp');
      await runAll(true);
    }
    
    await client.query('COMMIT');
    console.log('Import transaction committed successfully');
    
    res.json({
      success: true,
      batchId: importBatchId,
      batchSuffix: batchSuffix,
      tables: tableTypes.map(t => t.name.replace('fhir_', '')),
      imported: importedCounts,
      skippedSamples: skippedErrors,
      message: `Successfully imported FHIR data batch ${importBatchId} into batch-specific tables`
    });
    
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    console.error('Import error:', err);
    res.status(500).json({ error: 'Import failed', details: err.message });
  } finally {
    client.release();
  }
});

// Cohort management endpoints

// Every change to "which cohort is active" (create, activate, deactivate, the list's clean-up) runs inside one transaction that holds
// this advisory lock, so two overlapping requests (a double click, two tabs, a click during a list refresh) run one after the other.
// Without it, two overlapping activations could leave TWO cohorts active, and "the active cohort" was then decided by whichever
// transaction started last (updated_at used NOW(), the transaction START time) - so an earlier click could win and the old cohort showed.
const COHORT_LOCK = 7340211;
async function withCohortLock(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock($1)', [COHORT_LOCK]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

// A cohort belongs to exactly one population (see population.js). It is orphaned when that population does not exist (any more),
// or when it was never saved (cohorts made before binding existed).
const isOrphaned = (row, allSuffixes) => !POP.exists(POP.toKey(row.population_scope), allSuffixes);

// Cohorts that disappear when the batches in `drop` are deleted: a batch cohort dies with its batch, a group cohort with its last batch.
async function cohortsLostBy(db, drop, allSuffixes) {
  const rows = (await db.query('SELECT id, name, population_scope, is_active FROM cohorts')).rows;
  const lost = new Set(POP.keysLostBy(drop, allSuffixes, rows.map(r => POP.toKey(r.population_scope)).filter(Boolean)));
  return rows.filter(r => lost.has(POP.toKey(r.population_scope)));
}
// dropdown value ('group:<base>' or a batch suffix) -> the batch suffixes it covers
const suffixesOfValue = (value, all) => POP.suffixes(POP.toKey(value), all);

// Get all cohorts
app.get('/api/cohorts', async (req, res) => {
  try {
    // Older data may still have several active cohorts: keep only the most recently updated one.
    await withCohortLock(c => c.query('UPDATE cohorts SET is_active = FALSE WHERE is_active AND id <> (SELECT id FROM cohorts WHERE is_active ORDER BY updated_at DESC, id DESC LIMIT 1)'));
    // A cohort whose population is gone (or was never saved) is flagged `orphaned` and cannot stay active.
    const all = await listBatchSuffixes();
    let rows = (await pool.query('SELECT * FROM cohorts ORDER BY created_at DESC')).rows;
    const stale = rows.filter(r => r.is_active && isOrphaned(r, all)).map(r => r.id);
    if (stale.length) {
      await withCohortLock(c => c.query('UPDATE cohorts SET is_active = FALSE, updated_at = clock_timestamp() WHERE id = ANY($1)', [stale]));
      rows = rows.map(r => stale.includes(r.id) ? { ...r, is_active: false } : r);
    }
    res.json({ success: true, cohorts: rows.map(r => ({ ...r, orphaned: isOrphaned(r, all), population_option: POP.toOption(POP.toKey(r.population_scope)) })) });
  } catch (err) {
    console.error('Error fetching cohorts:', err);
    res.status(500).json({ error: 'Failed to fetch cohorts', details: err.message });
  }
});

// Get a specific cohort
app.get('/api/cohorts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM cohorts WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cohort not found' });
    }
    res.json({ success: true, cohort: result.rows[0] });
  } catch (err) {
    console.error('Error fetching cohort:', err);
    res.status(500).json({ error: 'Failed to fetch cohort', details: err.message });
  }
});

// Create a new cohort
app.post('/api/cohorts', express.json(), async (req, res) => {
  try {
    const { name, description } = req.body;
    const crit = sqlGuard.prepareCriteria(req.body.criteria_sql);   // comments are removed; the comment-free text is what is stored
    const criteria_sql = crit.sql;
    if (!crit.ok) return res.status(400).json({ success: false, error: crit.error });
    if (!name) {
      return res.status(400).json({ error: 'Cohort name is required' });
    }
    // Every cohort belongs to exactly one existing population (a batch or a batch group) for its whole life.
    const population_scope = POP.toKey(req.body.population_scope);   // canonical key; only compared / matched, never put in SQL text
    if (!population_scope) return res.status(400).json({ success: false, error: 'Select the population (or batch) this cohort is built for.' });
    if (!POP.exists(population_scope, await listBatchSuffixes())) return res.status(400).json({ success: false, error: 'That population does not exist (it may have been deleted). Reload the list and pick another.' });
    // Only one cohort is active at a time: the new cohort becomes the active one and every other cohort is switched off.
    const result = await withCohortLock(async client => {
      await client.query('UPDATE cohorts SET is_active = FALSE WHERE is_active');
      return client.query(
        `INSERT INTO cohorts (name, description, criteria_sql, population_scope, is_active, updated_at) VALUES ($1, $2, $3, $4, TRUE, clock_timestamp()) RETURNING *`,
        [name, description || null, criteria_sql || null, population_scope]
      );
    });
    res.json({ success: true, cohort: result.rows[0] });
  } catch (err) {
    console.error('Error creating cohort:', err);
    res.status(500).json({ error: 'Failed to create cohort', details: err.message });
  }
});

// Update a cohort. The population a cohort is bound to is NOT editable here (any population_scope in the body is ignored).
app.put('/api/cohorts/:id', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;
    const crit = sqlGuard.prepareCriteria(req.body.criteria_sql);
    const criteria_sql = crit.sql;
    if (!crit.ok) return res.status(400).json({ success: false, error: crit.error });
    const result = await pool.query(
      'UPDATE cohorts SET name = $1, description = $2, criteria_sql = $3, updated_at = NOW() WHERE id = $4 RETURNING *',
      [name || null, description || null, criteria_sql || null, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cohort not found' });
    }
    res.json({ success: true, cohort: result.rows[0] });
  } catch (err) {
    console.error('Error updating cohort:', err);
    res.status(500).json({ error: 'Failed to update cohort', details: err.message });
  }
});

// Delete a cohort
app.delete('/api/cohorts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM cohorts WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cohort not found' });
    }
    res.json({ success: true, message: 'Cohort deleted successfully' });
  } catch (err) {
    console.error('Error deleting cohort:', err);
    res.status(500).json({ error: 'Failed to delete cohort', details: err.message });
  }
});

// Activate a cohort. Only one cohort is active at a time: activating one switches the others off.
app.post('/api/cohorts/:id/activate', async (req, res) => {
  try {
    const { id } = req.params;
    const cur = await pool.query('SELECT * FROM cohorts WHERE id = $1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Cohort not found' });
    if (isOrphaned(cur.rows[0], await listBatchSuffixes())) {
      return res.status(409).json({ success: false, code: 'cohort_orphaned', error: 'This cohort cannot be activated: its population no longer exists (or was never saved). Assign a population to it, or delete it.' });
    }
    // one statement, so there is never a moment with two active cohorts
    const all = await withCohortLock(c => c.query(
      'UPDATE cohorts SET is_active = (id = $1), updated_at = CASE WHEN id = $1 THEN clock_timestamp() ELSE updated_at END WHERE is_active OR id = $1 RETURNING *',
      [id]
    ));
    const result = { rows: all.rows.filter(r => String(r.id) === String(id)) };
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cohort not found' });
    }
    res.json({ success: true, cohort: result.rows[0] });
  } catch (err) {
    console.error('Error activating cohort:', err);
    res.status(500).json({ error: 'Failed to activate cohort', details: err.message });
  }
});

// Give an ORPHANED cohort (population deleted, or never saved) a population again. This is the only way a binding changes;
// a cohort that is still bound to an existing population is refused. The cohort stays inactive: activate it afterwards.
app.post('/api/cohorts/:id/rebind', express.json(), async (req, res) => {
  try {
    const key = POP.toKey(req.body && req.body.population_scope);
    if (!key) return res.status(400).json({ success: false, error: 'Select a population.' });
    const all = await listBatchSuffixes();
    if (!POP.exists(key, all)) return res.status(400).json({ success: false, error: 'That population does not exist.' });
    const out = await withCohortLock(async c => {
      const cur = await c.query('SELECT * FROM cohorts WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!cur.rows.length) return { status: 404, body: { error: 'Cohort not found' } };
      if (!isOrphaned(cur.rows[0], all)) return { status: 409, body: { success: false, error: 'This cohort is still bound to an existing population; the binding cannot be changed.' } };
      const r = await c.query('UPDATE cohorts SET population_scope = $2, is_active = FALSE, updated_at = clock_timestamp() WHERE id = $1 RETURNING *', [req.params.id, key]);
      return { status: 200, body: { success: true, cohort: { ...r.rows[0], orphaned: false, population_option: POP.toOption(key) } } };
    });
    res.status(out.status).json(out.body);
  } catch (err) {
    console.error('Error rebinding cohort:', err);
    res.status(500).json({ error: 'Failed to assign the population', details: err.message });
  }
});

// Deactivate a cohort
app.post('/api/cohorts/:id/deactivate', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await withCohortLock(c => c.query(
      'UPDATE cohorts SET is_active = FALSE, updated_at = clock_timestamp() WHERE id = $1 RETURNING *',
      [id]
    ));
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cohort not found' });
    }
    res.json({ success: true, cohort: result.rows[0] });
  } catch (err) {
    console.error('Error deactivating cohort:', err);
    res.status(500).json({ error: 'Failed to deactivate cohort', details: err.message });
  }
});

// ---- Delete batch / batch group (drops the batch-specific tables) ----
const BATCH_TABLE_TYPES = ['patient', 'encounter', 'observation', 'diagnosis', 'procedure', 'immunization', 'medication', 'allergy', 'organization'];

async function dropBatchTables(client, suffix) {
  if (!suffix || !/^[a-zA-Z0-9_]+$/.test(suffix)) throw new Error('Invalid batch id');
  for (const t of BATCH_TABLE_TYPES) {
    await client.query(`DROP TABLE IF EXISTS "fhir_${t}_${suffix}"`);
  }
}

async function listBatchSuffixes() {
  const r = await pool.query(
    "SELECT SUBSTRING(table_name FROM 'fhir_patient_(.+)') AS suffix FROM information_schema.tables " +
    "WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name LIKE 'fhir_patient_%'"
  );
  return r.rows.map(x => x.suffix).filter(Boolean);
}

// Preview for the delete confirmation: which cohorts would be deleted together with this population (dropdown value: 'group:<base>' or a batch suffix)
app.get('/api/populations/:value/cohorts', async (req, res) => {
  try {
    const all = await listBatchSuffixes();
    const drop = suffixesOfValue(req.params.value, all);
    if (!drop.length) return res.status(404).json({ error: 'Population not found' });
    const lost = await cohortsLostBy(pool, drop, all);
    res.json({ success: true, cohorts: lost.map(r => ({ id: r.id, name: r.name, is_active: r.is_active })) });
  } catch (err) {
    console.error('Error previewing population delete:', err);
    res.status(500).json({ error: 'Failed to look up the cohorts of this population', details: err.message });
  }
});

// Delete one batch
app.delete('/api/batches/:batchId', async (req, res) => {
  const suffix = sanitizeBatchId(req.params.batchId || '').toLowerCase();
  const client = await pool.connect();
  try {
    const all = await listBatchSuffixes();
    if (!all.includes(suffix)) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [COHORT_LOCK]);
    const lost = await cohortsLostBy(client, [suffix], all);   // cohorts bound to this batch (or to a group whose last batch this is)
    if (lost.length) await client.query('DELETE FROM cohorts WHERE id = ANY($1)', [lost.map(r => r.id)]);
    await dropBatchTables(client, suffix);
    await client.query('COMMIT');
    res.json({ success: true, deleted: [suffix], deletedCohorts: lost.map(r => ({ id: r.id, name: r.name })), message: `Batch ${suffix} deleted` + (lost.length ? ` together with ${lost.length} cohort(s) bound to it` : '') });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error deleting batch:', err);
    res.status(500).json({ error: 'Failed to delete batch', details: err.message });
  } finally {
    client.release();
  }
});

// Delete a whole population (batch group = all batches sharing the base name)
app.delete('/api/batch-groups/:baseName', async (req, res) => {
  const baseName = sanitizeBatchId(req.params.baseName || '').toLowerCase();
  const client = await pool.connect();
  try {
    const all = await listBatchSuffixes();
    const members = POP.suffixes(`group:${baseName}`, all);
    if (members.length === 0) return res.status(404).json({ error: 'Batch group not found' });
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [COHORT_LOCK]);
    const lost = await cohortsLostBy(client, members, all);   // the group's cohorts, plus cohorts bound to any single batch of it
    if (lost.length) await client.query('DELETE FROM cohorts WHERE id = ANY($1)', [lost.map(r => r.id)]);
    for (const sfx of members) await dropBatchTables(client, sfx);
    await client.query('COMMIT');
    res.json({ success: true, deleted: members, deletedCohorts: lost.map(r => ({ id: r.id, name: r.name })), message: `Deleted ${members.length} batch(es) in group ${baseName}` + (lost.length ? ` together with ${lost.length} cohort(s) bound to it` : '') });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error deleting batch group:', err);
    res.status(500).json({ error: 'Failed to delete batch group', details: err.message });
  } finally {
    client.release();
  }
});

// Database overview endpoint - supports batch filtering
app.get('/api/db-overview', async (req, res) => {
  console.log('DB OVERVIEW ENDPOINT CALLED');
  try {
    const { batchId } = req.query;
    
    if (batchId) {
      // Return overview for specific batch
      const batchSuffix = sanitizeBatchId(batchId);
      const tables = [
        { name: `fhir_patient_${batchSuffix}`, label: 'Patients' },
        { name: `fhir_encounter_${batchSuffix}`, label: 'Encounters' },
        { name: `fhir_observation_${batchSuffix}`, label: 'Observations' },
        { name: `fhir_diagnosis_${batchSuffix}`, label: 'Conditions' },
        { name: `fhir_procedure_${batchSuffix}`, label: 'Procedures' },
        { name: `fhir_immunization_${batchSuffix}`, label: 'Immunizations' },
        { name: `fhir_medication_${batchSuffix}`, label: 'Medications' },
        { name: `fhir_allergy_${batchSuffix}`, label: 'Allergies' }
      ];
      const overview = {};
      for (const { name, label } of tables) {
        try {
          const result = await pool.query(`SELECT COUNT(*) as count FROM ${name}`);
          overview[label] = parseInt(result.rows[0].count, 10);
        } catch (tableErr) {
          // Table might not exist for this batch
          overview[label] = 0;
        }
      }
      res.json({ success: true, overview, batchId });
    } else {
      // Return overview of all batches
      // Discover all batch tables from information_schema
      const tablesQuery = `
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND (
            table_name LIKE 'fhir_patient_%' OR
            table_name LIKE 'fhir_encounter_%' OR
            table_name LIKE 'fhir_observation_%' OR
            table_name LIKE 'fhir_diagnosis_%' OR
            table_name LIKE 'fhir_procedure_%' OR
            table_name LIKE 'fhir_immunization_%' OR
            table_name LIKE 'fhir_medication_%' OR
            table_name LIKE 'fhir_allergy_%'
          )
          AND table_type = 'BASE TABLE'
      `;
      
      const tablesResult = await pool.query(tablesQuery);
      const batchTables = tablesResult.rows;
      
      // Extract unique batch suffixes
      const batchSuffixes = new Set();
      batchTables.forEach(row => {
        const match = row.table_name.match(/fhir_(?:patient|encounter|observation|diagnosis|procedure|medication|allergy)_(.+)/);
        if (match) {
          batchSuffixes.add(match[1]);
        }
      });
      
      // Map table type to its display label (for consistent capitalized keys)
      const tableLabelMap = {
        patient: 'Patients',
        encounter: 'Encounters',
        observation: 'Observations',
        diagnosis: 'Conditions',
        procedure: 'Procedures',
        immunization: 'Immunizations',
        medication: 'Medications',
        allergy: 'Allergies'
      };
      
      // Build overview for each batch
      const batches = [];
      const standardTables = ['patient', 'encounter', 'observation', 'diagnosis', 'procedure', 'immunization', 'medication', 'allergy'];
      
      for (const suffix of batchSuffixes) {
        const batchOverview = {};
        let hasData = false;
        
        for (const tableType of standardTables) {
          const tableName = `fhir_${tableType}_${suffix}`;
          try {
            const result = await pool.query(`SELECT COUNT(*) as count FROM ${tableName}`);
            const count = parseInt(result.rows[0].count, 10);
            batchOverview[tableLabelMap[tableType]] = count;
            if (count > 0) hasData = true;
          } catch (tableErr) {
            batchOverview[tableLabelMap[tableType]] = 0;
          }
        }
        
        if (hasData) {
          batches.push({
            batchId: suffix, // This is the sanitized version
            originalBatchId: suffix, // For now, same as sanitized
            overview: batchOverview
          });
        }
      }
      
      // Group batches by base name (remove _0, _1, etc. suffixes)
      const batchGroups = new Map();
      for (const suffix of batchSuffixes) {
        // Extract base name by removing trailing _number pattern
        const baseName = suffix.replace(/(_\d+)$/, '');
        if (!batchGroups.has(baseName)) {
          batchGroups.set(baseName, {
            baseName: baseName,
            batches: [],
            overview: {}
          });
        }
        batchGroups.get(baseName).batches.push(suffix);
      }
      
      // Calculate overview for each batch group
      const batchGroupOverviews = [];
      
      for (const [baseName, groupInfo] of batchGroups) {
        const batchOverview = {};
        let hasData = false;
        
        // Sum counts across all batches in this group
        for (const tableType of standardTables) {
          let totalCount = 0;
          let batchHasData = false;
          
          for (const batchSuffix of groupInfo.batches) {
            const tableName = `fhir_${tableType}_${batchSuffix}`;
            try {
              const result = await pool.query(`SELECT COUNT(*) as count FROM ${tableName}`);
              const count = parseInt(result.rows[0].count, 10);
              totalCount += count;
              if (count > 0) batchHasData = true;
            } catch (tableErr) {
              // Table might not exist for this batch, treat as 0
            }
          }
          
          batchOverview[tableLabelMap[tableType]] = totalCount;
          if (batchHasData) hasData = true;
        }
        
        if (hasData) {
          batchGroupOverviews.push({
            baseName: baseName,
            batchCount: groupInfo.batches.length,
            batches: groupInfo.batches,
            overview: batchOverview
          });
        }
      }
      
      // Also get total counts across all batches (legacy format) - aggregate across all batch tables
      const legacyTables = [
        { name: 'cohorts', label: 'Cohorts' }
      ];
      const legacyOverview = {};
      for (const { name, label } of legacyTables) {
        try {
          const result = await pool.query(`SELECT COUNT(*) as count FROM ${name}`);
          legacyOverview[label] = parseInt(result.rows[0].count, 10);
        } catch (tableErr) {
          legacyOverview[label] = 0;
        }
      }
      // Aggregate record counts across all batch-specific tables
      for (const tableType of standardTables) {
        let totalCount = 0;
        for (const batch of batches) {
          try {
            const result = await pool.query(`SELECT COUNT(*) as count FROM fhir_${tableType}_${batch.batchId}`);
            const count = parseInt(result.rows[0].count, 10);
            totalCount += count;
          } catch (tableErr) {
            // table might not exist, treat as 0
          }
        }
        legacyOverview[tableLabelMap[tableType]] = totalCount;
      }
      
      res.json({ 
        success: true, 
        batches, // Keep original batches array for backward compatibility
        batchGroups: batchGroupOverviews, // New grouped batches
        overview: legacyOverview, // Legacy format for backward compatibility
        totalBatches: batches.length,
        totalBatchGroups: batchGroupOverviews.length
      });
    }
  } catch (err) {
    console.error('Error fetching db overview:', err);
    res.status(500).json({ error: 'Failed to fetch database overview', details: err.message });
  }
});

// --- Demographic endpoint (population details for the active cohort) ---

// Resolve the currently active cohort and build a patient subquery that covers
// every batch, filtered by the cohort's criteria. Used by the population-details endpoint.
async function getActiveCohortPatientSource() {
  const cohortResult = await pool.query(
    'SELECT id, name, criteria_sql FROM cohorts WHERE is_active = TRUE ORDER BY updated_at DESC, id DESC LIMIT 1'
  );
  if (cohortResult.rows.length === 0) {
    const err = new Error('No active cohort. Activate a cohort in "Existing Cohorts" first.');
    err.status = 400;
    throw err;
  }
  const cohort = cohortResult.rows[0];
  cohort.criteria_sql = sqlGuard.assertCriteria(cohort.criteria_sql);   // refuse stored criteria that are not a plain read-only expression (comments, if any, are dropped)

  const suffixResult = await readPool.query(`
    SELECT SUBSTRING(table_name FROM 'fhir_patient_(.+)') AS suffix
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name LIKE 'fhir_patient_%'
  `);
  const suffixes = suffixResult.rows.map(r => r.suffix).filter(Boolean);

  let parts = [];
  const criteria = (cohort.criteria_sql || '').trim();
  const tableRefRegex = /\bfhir_(patient|encounter|observation|diagnosis|procedure|medication|allergy|immunization)\b(?!_)/g;

  if (suffixes.length > 0) {
    parts = suffixes.map(s => {
      const where = criteria ? ` WHERE (${criteria.replace(tableRefRegex, `fhir_$1_${s}`)})` : '';
      return `SELECT patient_id, gender, birth_date, json_content FROM fhir_patient_${s}${where}`;
    });
  } else {
    // Legacy un-suffixed table
    const where = criteria ? ` WHERE (${criteria})` : '';
    parts = [`SELECT patient_id, gender, birth_date, json_content FROM fhir_patient${where}`];
  }
  return { cohort, suffixes, source: `(${parts.join(' UNION ALL ')}) AS patients` };
}

function demoError(res, label, err) {
  console.error(`Error fetching ${label} distribution:`, err);
  res.status(err.status || 500).json({ success: false, error: err.status ? err.message : `Failed to fetch ${label} distribution`, details: err.message });
}

// Active cohort summary (patient count) for the Demographic Distributions panel
app.get('/api/demographics/population-details', async (req, res) => {
  try {
    const { cohort, source, suffixes } = await getActiveCohortPatientSource();
    const full = await readPool.query('SELECT id, name, description, criteria_sql, is_active, created_at, updated_at FROM cohorts WHERE id = $1', [cohort.id]);
    const total = await readPool.query(`SELECT COUNT(*) AS count FROM ${source}`);
    const gender = await readPool.query(`SELECT COALESCE(gender,'Unknown') AS value, COUNT(*) AS count FROM ${source} GROUP BY 1 ORDER BY 2 DESC`);
    const age = await readPool.query(`SELECT COUNT(birth_date) AS with_dob, MIN(birth_date) AS oldest_dob, MAX(birth_date) AS youngest_dob,
      ROUND(AVG(EXTRACT(YEAR FROM age(birth_date)))::numeric, 1) AS avg_age,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(YEAR FROM age(birth_date))) AS median_age FROM ${source}`);
    const race = await readPool.query(`SELECT COUNT(*) AS count FROM ${source} WHERE jsonb_path_exists(json_content, '$.extension[*] ? (@.url == "http://hl7.org/fhir/us/core/StructureDefinition/us-core-race")')`);

    const sfx = suffixes.length ? suffixes.map(x => `_${x}`) : [''];
    const inCohort = `patient_id IN (SELECT patient_id FROM ${source})`;
    const types = { encounters: 'encounter', observations: 'observation', conditions: 'diagnosis', procedures: 'procedure', immunizations: 'immunization', medications: 'medication', allergies: 'allergy' };
    const counts = {};
    for (const [label, t] of Object.entries(types)) {
      try {
        const parts = sfx.map(x => `SELECT patient_id FROM fhir_${t}${x} WHERE ${inCohort}`).join(' UNION ALL ');
        const r = await readPool.query(`SELECT COUNT(*) AS records, COUNT(DISTINCT patient_id) AS patients FROM (${parts}) AS u`);
        counts[label] = { records: parseInt(r.rows[0].records, 10), patients: parseInt(r.rows[0].patients, 10) };
      } catch (e) { counts[label] = null; }
    }
    const top = async (t) => {
      try {
        const parts = sfx.map(x => `SELECT code FROM fhir_${t}${x} WHERE ${inCohort}`).join(' UNION ALL ');
        const r = await readPool.query(`SELECT code, COUNT(*) AS count FROM (${parts}) AS u GROUP BY code ORDER BY count DESC LIMIT 10`);
        return r.rows.map(x => ({ code: x.code, count: parseInt(x.count, 10) }));
      } catch (e) { return []; }
    };
    const n = parseInt(total.rows[0].count, 10);
    const a0 = age.rows[0];
    res.json({
      success: true,
      cohort: full.rows[0],
      total_patients: n,
      source_batches: suffixes,
      gender: gender.rows.map(r => ({ value: r.value, count: parseInt(r.count, 10) })),
      age: { with_birth_date: parseInt(a0.with_dob, 10), missing_birth_date: n - parseInt(a0.with_dob, 10), oldest_dob: a0.oldest_dob, youngest_dob: a0.youngest_dob, avg_age: a0.avg_age, median_age: a0.median_age },
      race_data_patients: parseInt(race.rows[0].count, 10),
      counts,
      top_conditions: await top('diagnosis'),
      top_observations: await top('observation')
    });
  } catch (err) {
    demoError(res, 'population', err);
  }
});

// Clinical analytics catalog (five modes: V1 text / V2 codes / V3 enriched codes / V4 codes+time / V5 enriched codes+time) and synthetic FHIR generator
require('./analytics')(app, pool, { sanitizeBatchId, readPool });

// Research tab: AI study plans (checked against the templates and the codes in the active cohort) and a step runner
require('./research')(app, pool);

// OpenRouter settings (key stays on the server)
require('./evidence').registerAi(app, pool);

// SNOMED CT query builder (dictionary from the data, is-a hierarchy, SQL generator)
require('./knowledge').snomedQuery(app, pool, { sanitizeBatchId });

// Enrichment candidates (V3 / V5): real codes from the reference tables for strings that have no source code (read-only, strings in, codes out)
require('./knowledge').enrichCandidates(app, pool);

// Fetch patients from Epic / Oracle Health / any FHIR server into a batch (Analytics tab)
require('./knowledge').fhirConnect(app, pool, { port, importToken: IMPORT_TOKEN });

// Serve static files from the current directory (for the web interface) - after API routes
const path = require('path');
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
// Public About page: no sign-in needed (the auth gate only guards /, /index.html and /api/*), so it is open to signed-in and signed-out visitors alike.
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'about.html')));

// Initialize database schema on server start (creates tables if they don't exist)
async function initializeDatabaseSchema() {
  try {
    await pool.query(STARTUP_SQL);
    // A cohort is bound to the Population / Batch it was made for (canonical key batch:<suffix> or group:<base>, see population.js).
    try { await pool.query('ALTER TABLE IF EXISTS cohorts ADD COLUMN IF NOT EXISTS population_scope VARCHAR(255)'); }
    catch (err) { console.error('Could not add cohorts.population_scope (cohorts will not remember their population):', err.message); }
    // Agreement report (V3 / V5 chunk 13): the model's own pick is kept when a reviewer acts on a proposal (llm_pick), and bulk approvals are flagged
    // so they do not count as individual reviews. Plain ADD COLUMN IF NOT EXISTS: existing rows keep working (llm_pick NULL = pick not recorded).
    try { await pool.query('ALTER TABLE IF EXISTS code_enrichment ADD COLUMN IF NOT EXISTS llm_pick JSONB, ADD COLUMN IF NOT EXISTS bulk_approved BOOLEAN NOT NULL DEFAULT FALSE'); }
    catch (err) { console.error('Could not add code_enrichment.llm_pick / bulk_approved (the agreement report will be empty):', err.message); }
    // Binding migration: store canonical keys (batch:<suffix> / group:<base>). Cohorts without a usable population are NOT deleted;
    // they show up as `orphaned` (cannot be activated until a population is assigned or the cohort is deleted).
    try {
      const rows = (await pool.query('SELECT id, population_scope FROM cohorts WHERE population_scope IS NOT NULL')).rows;
      for (const r of rows) { const k = POP.toKey(r.population_scope); if (k !== r.population_scope) await pool.query('UPDATE cohorts SET population_scope = $2 WHERE id = $1', [r.id, k]); }
      await pool.query(`ALTER TABLE cohorts DROP CONSTRAINT IF EXISTS cohorts_population_scope_chk`);
      await pool.query(`ALTER TABLE cohorts ADD CONSTRAINT cohorts_population_scope_chk CHECK (population_scope IS NULL OR population_scope ~ '^(group|batch):[a-z0-9_]+$')`);
      const all = await listBatchSuffixes();
      const stale = (await pool.query('SELECT * FROM cohorts WHERE is_active')).rows.filter(r => isOrphaned(r, all)).map(r => r.id);
      if (stale.length) { await pool.query('UPDATE cohorts SET is_active = FALSE, updated_at = clock_timestamp() WHERE id = ANY($1)', [stale]); console.warn(`Deactivated ${stale.length} cohort(s) whose population no longer exists.`); }
      const orphans = (await pool.query('SELECT * FROM cohorts')).rows.filter(r => isOrphaned(r, all)).length;
      if (orphans) console.warn(`${orphans} cohort(s) are not bound to an existing population (flagged "orphaned" in the Cohorts tab).`);
    } catch (err) { console.error('Cohort population migration failed:', err.message); }
    console.log('Database schema initialized successfully');
  } catch (err) {
    console.error('Error initializing database schema:', err);
  }
  try { await audit.ready(); } catch (err) { console.error('Audit log setup failed (events are NOT being recorded until this is fixed):', err.message); }
  try { await verifyReadOnly(); } catch (err) { console.error('Read-only check could not run:', err.message); if (String(process.env.REQUIRE_READONLY || '').toLowerCase() === 'true') process.exit(1); }
  try { await auth.ready(); } catch (err) { console.error('Auth setup failed (nobody can sign in until this is fixed):', err.message); }
}

// Start the HTTP server (no request timeout so long imports are not cut off)
function startServer(cb) {
  const srv = app.listen(port, cb);
  srv.requestTimeout = 0;
  srv.headersTimeout = 120000;
  srv.keepAliveTimeout = 65000;
  return srv;
}
// On shutdown (Render sends SIGTERM) write the queued audit events first, but never wait more than 5 seconds.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { setTimeout(() => process.exit(0), 5000).unref(); audit.flush().finally(() => process.exit(0)); });

initializeDatabaseSchema().then(() => {
  startServer(() => {
    console.log(`Server running at http://localhost:${port}`);
    
  });
}).catch(err => {
  console.error('Failed to initialize database schema:', err);
  console.log('Server will start anyway - database initialization can be retried via the UI');
  startServer(() => {
    console.log(`Server running at http://localhost:${port}`);
  });
});
