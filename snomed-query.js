// SNOMED CT query builder backend (used by "Build SNOMED CT Query" on the Analytics tab).
//
//   1. Prepare dictionary  - distinct codes found in the imported FHIR batches, per domain, with patient counts.
//   2. Hierarchy (is-a)    - needed for "include descendants / ancestors". Sources: bundled demo links, a SNOMED CT RF2
//                            file, or a plain CSV (child_code,parent_code[,child_name[,parent_name]]).
//   3. Query generation    - rules (include / exclude, AND / OR, exact / descendants / ancestors) become a cohort
//                            WHERE clause plus a full runnable query for every batch.
//
// Tables created on first use (aggregate counts and code links only, no patient data):
//   snomed_isa, snomed_concept, snomed_dictionary, snomed_dictionary_meta, snomed_hier_meta
//
// Self-test (no database): node snomed-query.js --selftest

const fs = require('fs');
const readline = require('readline');

// ---------------------------------------------------------------------------------------------------------------------
// Domains: which table, which column holds the code, and where the display text sits in the stored FHIR JSON.
// ---------------------------------------------------------------------------------------------------------------------
const J = (col, path) => `json_content->'${col}'->'coding'->0->>'${path}'`;
const DOMAINS = {
  dx: { label: 'Conditions',    table: 'diagnosis',    code: 'code',            system: 'code_system',     display: `COALESCE(${J('code', 'display')}, json_content->'code'->>'text')` },
  pr: { label: 'Procedures',    table: 'procedure',    code: 'code',            system: J('code', 'system'), display: `COALESCE(${J('code', 'display')}, json_content->'code'->>'text')` },
  ob: { label: 'Observations',  table: 'observation',  code: 'code',            system: 'code_system',     display: `COALESCE(${J('code', 'display')}, json_content->'code'->>'text')` },
  rx: { label: 'Medications',   table: 'medication',   code: 'medication_code', system: J('medicationCodeableConcept', 'system'), display: `COALESCE(${J('medicationCodeableConcept', 'display')}, json_content->'medicationCodeableConcept'->>'text')` },
  al: { label: 'Allergies',     table: 'allergy',      code: `(${J('code', 'code')})`, system: J('code', 'system'), display: `COALESCE(${J('code', 'display')}, json_content->'code'->>'text', substance)` },
  im: { label: 'Immunizations', table: 'immunization', code: 'vaccine_code',    system: J('vaccineCode', 'system'), display: `COALESCE(${J('vaccineCode', 'display')}, json_content->'vaccineCode'->>'text')` }
};
const MODES = ['exact', 'descendants', 'ancestors'];
const TABLE_REF = /\bfhir_(patient|encounter|observation|diagnosis|procedure|medication|allergy|immunization)\b(?!_)/g;

// ---------------------------------------------------------------------------------------------------------------------
// Pure helpers (covered by the self-test)
// ---------------------------------------------------------------------------------------------------------------------
const lit = v => `'${String(v).replace(/\u0000/g, '').replace(/'/g, "''")}'`;
// Text that is placed inside a /* block comment */: no comment delimiters, no line breaks.
const commentSafe = v => String(v == null ? '' : v).replace(/\/\*|\*\//g, ' ').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 140);
const indent = (s, n = 2) => String(s).split('\n').map(l => (l ? ' '.repeat(n) + l : l)).join('\n');
const httpError = (status, message) => Object.assign(new Error(message), { status });

// Rules are combined strictly left to right: A AND B OR C  =>  ((A AND B) OR C). Equal connectors are flattened.
function combine(items) {
  if (!items.length) return 'TRUE';
  if (items.length === 1) return items[0].text;
  const rest = items.slice(1);
  if (rest.every(i => i.conn === rest[0].conn)) {
    return '(\n' + items.map((it, i) => indent(i === 0 ? it.text : `${it.conn} ${it.text}`)).join('\n') + '\n)';
  }
  let acc = items[0].text;
  for (const it of rest) acc = `(\n${indent(acc)}\n${indent(`${it.conn} ${it.text}`)}\n)`;
  return acc;
}

// Grouped rules: item = {conn, text, open, close, gnot}. open/close = number of "(" before / ")" after the rule; gnot = NOT applies
// to the outermost group opened at this rule. Inside one group the rules still run strictly left to right (see combine).
function combineGrouped(items) {
  if (!items.some(i => i.open || i.close)) return combine(items);
  const stack = [{ terms: [], not: false, conn: null }];
  items.forEach((it, idx) => {
    for (let k = 0; k < (it.open || 0); k++) stack.push({ terms: [], not: k === 0 && !!it.gnot, conn: k === 0 ? it.conn : null });
    stack[stack.length - 1].terms.push({ conn: it.open ? null : it.conn, text: it.text });
    for (let k = 0; k < (it.close || 0); k++) {
      if (stack.length < 2) throw httpError(400, `Rule ${idx + 1}: a ")" has no matching "(".`);
      const g = stack.pop(), inner = combine(g.terms);
      stack[stack.length - 1].terms.push({ conn: g.conn, text: g.not ? `NOT ${inner.startsWith('(') ? inner : '(' + inner + ')'}` : inner });
    }
  });
  if (stack.length > 1) throw httpError(400, 'A "(" is never closed. Add a ")" on a later rule.');
  return combine(stack[0].terms);
}

function predicate(domainKey, op, codes, comment) {
  const d = DOMAINS[domainKey], note = comment ? ` /* ${commentSafe(comment)} */` : '';
  if (!codes.length) return (op === 'exclude' ? 'TRUE' : 'FALSE') + note;
  const list = codes.map(lit).join(', ');
  const sub = `SELECT patient_id FROM fhir_${d.table} WHERE ${d.code} IN (${list})`;
  // NOT IN with a NULL patient_id would match nobody, so NULLs are filtered out of the excluded set.
  return (op === 'exclude' ? `patient_id NOT IN (${sub} AND patient_id IS NOT NULL)` : `patient_id IN (${sub})`) + note;
}

// One CSV line, optional double quotes.
function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Bundled demo hierarchy: SIMPLIFIED links for the demo codes in terminology.js / synthetic.js. Each link is a true
// ancestor relation but intermediate levels are left out. Load a real SNOMED CT release for anything beyond demos.
// ---------------------------------------------------------------------------------------------------------------------
const DEMO_NAMES = {
  '404684003': 'Clinical finding', '64572001': 'Disease', '362969004': 'Disorder of endocrine system', '75934005': 'Metabolic disease',
  '126877002': 'Disorder of glucose metabolism', '73211009': 'Diabetes mellitus', '46635009': 'Diabetes mellitus type 1', '44054006': 'Diabetes mellitus type 2',
  '49601007': 'Disorder of cardiovascular system', '56265001': 'Heart disease', '38341003': 'Hypertensive disorder', '84114007': 'Heart failure',
  '698247007': 'Cardiac arrhythmia', '49436004': 'Atrial fibrillation', '53741008': 'Coronary arteriosclerosis', '62914000': 'Cerebrovascular disease',
  '230690007': 'Cerebrovascular accident', '50043002': 'Disorder of respiratory system', '19829001': 'Disorder of lung', '195967001': 'Asthma',
  '13645005': 'Chronic obstructive lung disease', '233604007': 'Pneumonia', '40733004': 'Infectious disease', '68566005': 'Urinary tract infectious disease',
  '90708001': 'Kidney disease', '709044004': 'Chronic kidney disease', '55822004': 'Hyperlipidemia', '414916001': 'Obesity', '74732009': 'Mental disorder',
  '35489007': 'Depressive disorder', '928000': 'Musculoskeletal disorder', '64859006': 'Osteoporosis', '271737000': 'Anemia',
  '363346000': 'Malignant neoplastic disease', '254837009': 'Malignant neoplasm of breast', '363406005': 'Malignant tumor of colon',
  '71388002': 'Procedure', '277132007': 'Therapeutic procedure', '363680008': 'Radiographic imaging procedure', '71651007': 'Mammography',
  '399208008': 'Plain chest X-ray', '33367005': 'Coronary angiography', '108241001': 'Dialysis procedure', '29303009': 'Electrocardiographic procedure',
  '73761001': 'Colonoscopy', '105590001': 'Substance', '764146007': 'Penicillin', '387406002': 'Sulfonamide'
};
const DEMO_EDGES = [
  ['44054006', '73211009'], ['46635009', '73211009'], ['73211009', '126877002'], ['73211009', '362969004'], ['126877002', '75934005'], ['75934005', '64572001'], ['362969004', '64572001'],
  ['38341003', '49601007'], ['49601007', '64572001'], ['84114007', '56265001'], ['49436004', '698247007'], ['698247007', '56265001'], ['53741008', '56265001'], ['56265001', '49601007'],
  ['230690007', '62914000'], ['62914000', '64572001'], ['195967001', '50043002'], ['13645005', '19829001'], ['233604007', '19829001'], ['233604007', '40733004'], ['19829001', '50043002'],
  ['50043002', '64572001'], ['40733004', '64572001'], ['68566005', '40733004'], ['709044004', '90708001'], ['90708001', '64572001'], ['55822004', '75934005'], ['414916001', '64572001'],
  ['35489007', '74732009'], ['74732009', '64572001'], ['64859006', '928000'], ['928000', '64572001'], ['271737000', '64572001'], ['254837009', '363346000'], ['363406005', '363346000'],
  ['363346000', '64572001'], ['64572001', '404684003'],
  ['71651007', '363680008'], ['399208008', '363680008'], ['33367005', '363680008'], ['363680008', '71388002'], ['108241001', '277132007'], ['277132007', '71388002'],
  ['29303009', '71388002'], ['73761001', '71388002'],
  ['764146007', '105590001'], ['387406002', '105590001']
];

// ---------------------------------------------------------------------------------------------------------------------
function register(app, pool, opts = {}) {
  const sanitize = opts.sanitizeBatchId || (b => String(b).replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, ''));

  let ready = null;
  const ensure = () => ready || (ready = pool.query(`
    CREATE TABLE IF NOT EXISTS snomed_isa (child_code TEXT NOT NULL, parent_code TEXT NOT NULL, source TEXT, PRIMARY KEY (child_code, parent_code));
    CREATE INDEX IF NOT EXISTS idx_snomed_isa_parent ON snomed_isa(parent_code);
    CREATE TABLE IF NOT EXISTS snomed_concept (code TEXT PRIMARY KEY, display TEXT, source TEXT);
    CREATE TABLE IF NOT EXISTS snomed_dictionary (
      domain TEXT NOT NULL, code TEXT NOT NULL, code_system TEXT, display TEXT,
      patients INT NOT NULL DEFAULT 0, records INT NOT NULL DEFAULT 0, patients_rollup INT NOT NULL DEFAULT 0, in_data BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY (domain, code));
    CREATE TABLE IF NOT EXISTS snomed_dictionary_meta (domain TEXT PRIMARY KEY, scope TEXT, concepts INT, in_data INT, built_at TIMESTAMPTZ DEFAULT NOW(), hier_version BIGINT);
    CREATE TABLE IF NOT EXISTS snomed_hier_meta (id INT PRIMARY KEY DEFAULT 1, version BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT NOW());
    INSERT INTO snomed_hier_meta (id) VALUES (1) ON CONFLICT DO NOTHING;
  `).catch(e => { ready = null; throw e; }));

  const wrap = fn => async (req, res) => {
    try { await ensure(); res.json({ success: true, ...(await fn(req)) }); }
    catch (err) {
      if (!err.status) console.error('SNOMED query builder:', err);
      res.status(err.status || 500).json({ success: false, error: err.message });
    }
  };

  // ---- scope: which batch tables a dictionary / query covers -------------------------------------------------------
  async function resolveScope({ batchId, batchGroup } = {}) {
    const r = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name LIKE 'fhir\\_%'`);
    const names = new Set(r.rows.map(x => x.table_name));
    const all = [...names].filter(n => n.startsWith('fhir_patient_')).map(n => n.slice('fhir_patient_'.length)).sort();
    let suffixes, label;
    if (batchId) { const s = sanitize(String(batchId)).toLowerCase(); suffixes = all.filter(x => x === s); label = `batch ${s}`; }
    else if (batchGroup) { const g = sanitize(String(batchGroup)).toLowerCase(); suffixes = all.filter(x => x.startsWith(g)); label = `batch group ${g}`; }
    else { suffixes = all.length ? all : (names.has('fhir_patient') ? [''] : []); label = 'all batches'; }
    if (!suffixes.length) throw httpError(400, 'No imported data found for this population. Import or generate data first.');
    return { suffixes, names, label: `${label} (${suffixes.map(s => s || 'legacy tables').join(', ')})` };
  }
  const tbl = (type, s) => (s ? `fhir_${type}_${s}` : `fhir_${type}`);

  // ---- status ----------------------------------------------------------------------------------------------------
  async function status() {
    const meta = (await pool.query('SELECT * FROM snomed_dictionary_meta')).rows;
    const hv = (await pool.query('SELECT version, updated_at FROM snomed_hier_meta WHERE id = 1')).rows[0];
    const edges = Number((await pool.query('SELECT count(*) FROM snomed_isa')).rows[0].count);
    const concepts = Number((await pool.query('SELECT count(*) FROM snomed_concept')).rows[0].count);
    const sources = (await pool.query('SELECT source, count(*)::int AS links FROM snomed_isa GROUP BY 1 ORDER BY 2 DESC')).rows;
    let batches = [];
    try { batches = (await resolveScope()).suffixes.filter(Boolean); } catch (e) { /* no data yet */ }
    const domains = {};
    for (const [k, d] of Object.entries(DOMAINS)) {
      const m = meta.find(x => x.domain === k);
      // stale = the hierarchy changed after the build AND this domain actually uses hierarchy links (its roll-ups could differ)
      let stale = false;
      if (m && Number(m.hier_version) !== Number(hv.version)) {
        stale = (await pool.query(`SELECT EXISTS (SELECT 1 FROM snomed_dictionary d JOIN snomed_isa e ON e.child_code = d.code WHERE d.domain = $1 AND d.in_data)
                                       OR EXISTS (SELECT 1 FROM snomed_dictionary WHERE domain = $1 AND NOT in_data) AS s`, [k])).rows[0].s;
      }
      domains[k] = { key: k, label: d.label, built: !!(m && m.concepts > 0), concepts: m ? m.concepts : 0, inData: m ? m.in_data : 0, builtAt: m ? m.built_at : null, scope: m ? m.scope : null, stale };
    }
    return { domains, hierarchy: { links: edges, names: concepts, sources, version: Number(hv.version), updatedAt: hv.updated_at }, batches };
  }

  // ---- 1. prepare dictionary -------------------------------------------------------------------------------------
  async function buildDictionary(body) {
    const keys = [...new Set(Array.isArray(body.domains) ? body.domains : [])];
    if (!keys.length) throw httpError(400, 'Tick at least one domain to prepare.');
    for (const k of keys) if (!DOMAINS[k]) throw httpError(400, `Unknown domain: ${k}`);
    const sc = await resolveScope(body);
    const client = await pool.connect();
    const out = [];
    try {
      await client.query('BEGIN');
      const ver = (await client.query('SELECT version FROM snomed_hier_meta WHERE id = 1')).rows[0].version;
      for (const k of keys) {
        const d = DOMAINS[k];
        await client.query('DROP TABLE IF EXISTS _sq_src, _sq_codes, _sq_cp, _sq_cl, _sq_roll');
        await client.query('DELETE FROM snomed_dictionary WHERE domain = $1', [k]);
        const parts = sc.suffixes.filter(s => sc.names.has(tbl(d.table, s))).map(s =>
          `SELECT patient_id::text AS patient_id, NULLIF(${d.code}::text, '') AS code, ${d.system}::text AS system, ${d.display}::text AS display FROM ${tbl(d.table, s)}`);
        if (parts.length) {
          await client.query(`CREATE TEMP TABLE _sq_src AS ${parts.join(' UNION ALL ')}`);
          await client.query(`CREATE TEMP TABLE _sq_codes AS
            SELECT code, mode() WITHIN GROUP (ORDER BY system) FILTER (WHERE system IS NOT NULL) AS code_system,
                   mode() WITHIN GROUP (ORDER BY display) FILTER (WHERE display IS NOT NULL) AS display,
                   count(DISTINCT patient_id)::int AS patients, count(*)::int AS records
            FROM _sq_src WHERE code IS NOT NULL GROUP BY code`);
          await client.query(`CREATE TEMP TABLE _sq_cp AS SELECT DISTINCT code, patient_id FROM _sq_src WHERE code IS NOT NULL AND patient_id IS NOT NULL`);
          await client.query('CREATE INDEX ON _sq_cp (code)');
          // every code in the data plus all of its ancestors; patients are rolled up so a parent counts patients of its children once
          await client.query(`CREATE TEMP TABLE _sq_cl AS WITH RECURSIVE up(code, anc) AS (
              SELECT code, code FROM _sq_codes
              UNION SELECT up.code, e.parent_code FROM up JOIN snomed_isa e ON e.child_code = up.anc)
            SELECT code, anc FROM up`);
          await client.query('CREATE INDEX ON _sq_cl (code)');
          await client.query(`CREATE TEMP TABLE _sq_roll AS SELECT cl.anc AS code, count(DISTINCT cp.patient_id)::int AS n FROM _sq_cl cl JOIN _sq_cp cp ON cp.code = cl.code GROUP BY cl.anc`);
          await client.query(`INSERT INTO snomed_dictionary (domain, code, code_system, display, patients, records, patients_rollup, in_data)
            SELECT $1, c.code, c.code_system, COALESCE(c.display, sc.display), c.patients, c.records, COALESCE(r.n, c.patients), TRUE
            FROM _sq_codes c LEFT JOIN _sq_roll r ON r.code = c.code LEFT JOIN snomed_concept sc ON sc.code = c.code`, [k]);
          await client.query(`INSERT INTO snomed_dictionary (domain, code, display, patients, records, patients_rollup, in_data)
            SELECT $1, r.code, sc.display, 0, 0, r.n, FALSE FROM _sq_roll r LEFT JOIN snomed_concept sc ON sc.code = r.code
            WHERE NOT EXISTS (SELECT 1 FROM _sq_codes c WHERE c.code = r.code)`, [k]);
        }
        const cnt = (await client.query(`SELECT count(*)::int AS concepts, count(*) FILTER (WHERE in_data)::int AS in_data FROM snomed_dictionary WHERE domain = $1`, [k])).rows[0];
        await client.query(`INSERT INTO snomed_dictionary_meta (domain, scope, concepts, in_data, built_at, hier_version) VALUES ($1, $2, $3, $4, NOW(), $5)
          ON CONFLICT (domain) DO UPDATE SET scope = EXCLUDED.scope, concepts = EXCLUDED.concepts, in_data = EXCLUDED.in_data, built_at = NOW(), hier_version = EXCLUDED.hier_version`,
          [k, sc.label, cnt.concepts, cnt.in_data, ver]);
        out.push({ domain: k, label: d.label, concepts: cnt.concepts, inData: cnt.in_data, fromHierarchy: cnt.concepts - cnt.in_data });
      }
      await client.query('DROP TABLE IF EXISTS _sq_src, _sq_codes, _sq_cp, _sq_cl, _sq_roll');
      await client.query('COMMIT');
    } catch (err) { try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ } throw err; }
    finally { client.release(); }
    return { scope: sc.label, built: out };
  }

  // ---- concept search --------------------------------------------------------------------------------------------
  async function search(q) {
    const domain = String(q.domain || ''); if (!DOMAINS[domain]) throw httpError(400, 'Unknown domain.');
    const term = String(q.q || '').trim().slice(0, 100), lim = Math.min(Math.max(parseInt(q.limit, 10) || 30, 1), 100);
    const esc = term.replace(/[\\%_]/g, '\\$&');
    const r = await pool.query(`SELECT code, display, code_system, patients, patients_rollup, in_data FROM snomed_dictionary
      WHERE domain = $1 AND ($2 = '' OR display ILIKE $3 OR code LIKE $4)
      ORDER BY (code = $2) DESC, patients_rollup DESC, display NULLS LAST, code LIMIT $5`, [domain, term, `%${esc}%`, `${esc}%`, lim]);
    return { domain, concepts: r.rows.map(x => ({ code: x.code, display: x.display, system: x.code_system, patients: x.patients, patientsRollup: x.patients_rollup, inData: x.in_data })) };
  }

  // ---- expansion: selected codes -> codes that exist in the data -------------------------------------------------
  async function expand({ domain, codes, mode }) {
    if (!DOMAINS[domain]) throw httpError(400, 'Unknown domain.');
    if (!MODES.includes(mode)) throw httpError(400, 'Unknown match type.');
    const sel = [...new Set((Array.isArray(codes) ? codes : []).map(c => String(c).trim()).filter(Boolean))].slice(0, 500);
    if (!sel.length) return { domain, mode, selected: [], codes: [], total: 0, extra: 0 };
    const walk = mode === 'descendants'
      ? 'SELECT e.child_code FROM w JOIN snomed_isa e ON e.parent_code = w.code'
      : 'SELECT e.parent_code FROM w JOIN snomed_isa e ON e.child_code = w.code';
    const sql = mode === 'exact'
      ? `SELECT d.code, d.display, d.patients FROM snomed_dictionary d WHERE d.domain = $1 AND d.in_data AND d.code = ANY($2::text[]) ORDER BY d.patients DESC, d.code`
      : `WITH RECURSIVE w(code) AS (SELECT unnest($2::text[]) UNION ${walk})
         SELECT d.code, d.display, d.patients FROM snomed_dictionary d JOIN w ON w.code = d.code WHERE d.domain = $1 AND d.in_data ORDER BY d.patients DESC, d.code`;
    const hits = (await pool.query(sql, [domain, sel])).rows;
    const selRows = (await pool.query(`SELECT code, display, in_data FROM snomed_dictionary WHERE domain = $1 AND code = ANY($2::text[])`, [domain, sel])).rows;
    const exactInData = selRows.filter(r => r.in_data).length;
    return { domain, mode, selected: sel, codes: hits, total: hits.length, extra: Math.max(0, hits.length - exactInData), selectedNotInData: selRows.filter(r => !r.in_data).map(r => r.code) };
  }

  // ---- 3. query generation ---------------------------------------------------------------------------------------
  async function buildQuery(body) {
    const rules = Array.isArray(body.rules) ? body.rules : [];
    if (!rules.length) throw httpError(400, 'Add at least one rule.');
    if (rules.length > 30) throw httpError(400, 'At most 30 rules.');
    const built = (await pool.query('SELECT domain FROM snomed_dictionary_meta WHERE concepts > 0')).rows.map(r => r.domain);
    const items = [], summary = [], perRule = [], warnings = [];
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i] || {}, n = i + 1;
      if (!DOMAINS[r.domain]) throw httpError(400, `Rule ${n}: choose a domain.`);
      if (!built.includes(r.domain)) throw httpError(400, `Rule ${n}: prepare the ${DOMAINS[r.domain].label} dictionary first.`);
      if (!['include', 'exclude'].includes(r.op)) throw httpError(400, `Rule ${n}: choose include or exclude.`);
      if (!MODES.includes(r.mode)) throw httpError(400, `Rule ${n}: choose a match type.`);
      const conn = i === 0 ? null : String(r.conn || '').toUpperCase();
      if (i > 0 && !['AND', 'OR'].includes(conn)) throw httpError(400, `Rule ${n}: choose AND or OR.`);
      const codes = Array.isArray(r.codes) ? r.codes : [];
      if (!codes.length) throw httpError(400, `Rule ${n}: pick at least one concept.`);
      const ex = await expand({ domain: r.domain, codes, mode: r.mode });
      const nm = (await pool.query(`SELECT code, display FROM snomed_dictionary WHERE domain = $1 AND code = ANY($2::text[])`, [r.domain, ex.selected])).rows;
      const names = ex.selected.map(c => { const f = nm.find(x => x.code === c); return f && f.display ? f.display : c; });
      const how = { exact: 'exact', descendants: '+ descendants', ancestors: '+ ancestors' }[r.mode];
      const label = `${r.op === 'exclude' ? 'Exclude' : 'Include'} ${DOMAINS[r.domain].label}: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3} more` : ''} ${how} -> ${ex.total} code${ex.total === 1 ? '' : 's'}`;
      if (!ex.total) warnings.push(`Rule ${n} (${names.join(', ')}) matches no code in your data, so it ${r.op === 'exclude' ? 'excludes nobody' : 'matches nobody'}.`);
      const open = Math.max(0, Math.min(3, parseInt(r.open, 10) || 0)), close = Math.max(0, Math.min(3, parseInt(r.close, 10) || 0)), gnot = !!r.gnot && open > 0;
      items.push({ conn, open, close, gnot, text: predicate(r.domain, r.op, ex.codes.map(c => c.code), label) });
      summary.push(`${i === 0 ? '' : conn + ' '}${gnot ? 'NOT ' : ''}${'('.repeat(open)}${label}${')'.repeat(close)}`);
      perRule.push({ rule: n, domain: r.domain, op: r.op, mode: r.mode, selected: names, codes: ex.total });
    }
    const criteriaSql = combineGrouped(items);
    const sc = await resolveScope(body);
    const parts = sc.suffixes.map(s => `SELECT patient_id, gender, birth_date\nFROM ${tbl('patient', s)}\nWHERE ${indent(criteriaSql.replace(TABLE_REF, (m, t) => tbl(t, s)), 6).trimStart()}`);
    const union = parts.join('\nUNION ALL\n');
    const fullSql = `-- Generated by Build SNOMED CT Query\n-- Scope: ${sc.label}\n${summary.map(s => `-- ${commentSafe(s)}`).join('\n')}\n${union};`;
    let patientCount = null, countError = null;
    if (body.count !== false) {
      try { patientCount = Number((await pool.query(`SELECT count(*) FROM (${union}) q`)).rows[0].count); }
      catch (e) { countError = e.message; }
    }
    return { criteriaSql, fullSql, perRule, warnings, scope: sc.label, patientCount, countError };
  }

  // ---- hierarchy loading -----------------------------------------------------------------------------------------
  async function* linesOf(src) {
    if (src.path) {
      const p = String(src.path);
      let st; try { st = fs.statSync(p); } catch (e) { throw httpError(400, `File not found on the server: ${p}`); }
      if (!st.isFile()) throw httpError(400, `Not a file: ${p}`);
      const rl = readline.createInterface({ input: fs.createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const l of rl) yield l;
    } else {
      for (const l of String(src.text || '').split(/\r?\n/)) yield l;
    }
  }
  const bumpVersion = c => c.query('UPDATE snomed_hier_meta SET version = version + 1, updated_at = NOW() WHERE id = 1');

  async function loadHierarchy(body) {
    const format = String(body.format || '');
    if (!['demo', 'csv', 'rf2-relationships', 'rf2-descriptions'].includes(format)) throw httpError(400, 'format must be demo, csv, rf2-relationships or rf2-descriptions.');
    if (format !== 'demo' && !body.text && !body.path) throw httpError(400, 'Provide a file or a server path.');
    const client = await pool.connect();
    const counts = { links: 0, names: 0, skipped: 0 };
    const source = format === 'demo' ? 'demo' : format === 'csv' ? 'csv' : 'rf2';
    try {
      await client.query('BEGIN');
      if (body.replace || format === 'demo') {
        if (format === 'rf2-descriptions') await client.query('DELETE FROM snomed_concept');
        else { await client.query('DELETE FROM snomed_isa WHERE source = $1', [source]); }
      }
      let ec = [], ep = [], nc = [], nd = [];
      const flushEdges = async () => { if (!ec.length) return; await client.query(`INSERT INTO snomed_isa (child_code, parent_code, source) SELECT c, p, $3 FROM unnest($1::text[], $2::text[]) t(c, p) ON CONFLICT DO NOTHING`, [ec, ep, source]); ec = []; ep = []; };
      const flushNames = async () => { if (!nc.length) return; await client.query(`INSERT INTO snomed_concept (code, display, source) SELECT DISTINCT ON (c) c, d, $3 FROM unnest($1::text[], $2::text[]) t(c, d) ORDER BY c ON CONFLICT (code) DO UPDATE SET display = EXCLUDED.display, source = EXCLUDED.source`, [nc, nd, source]); nc = []; nd = []; };
      const edge = async (c, p) => { if (!c || !p || c === p) { counts.skipped++; return; } ec.push(c); ep.push(p); counts.links++; if (ec.length >= 5000) await flushEdges(); };
      const name = async (c, d) => { if (!c || !d) return; nc.push(c); nd.push(d); counts.names++; if (nc.length >= 5000) await flushNames(); };

      if (format === 'demo') {
        for (const [c, p] of DEMO_EDGES) await edge(c, p);
        for (const [c, d] of Object.entries(DEMO_NAMES)) await name(c, d);
      } else if (format === 'csv') {
        let first = true;
        for await (const line of linesOf(body)) {
          if (!line.trim()) continue;
          const f = parseCsvLine(line);
          if (first) { first = false; if (/child|parent|source|destination/i.test(f[0] + f[1])) continue; }
          await edge(f[0], f[1]); await name(f[0], f[2]); await name(f[1], f[3]);
        }
      } else if (format === 'rf2-relationships') {
        for await (const line of linesOf(body)) {            // id effectiveTime active moduleId sourceId destinationId group typeId ...
          const f = line.split('\t'); if (f.length < 8 || f[0] === 'id') continue;
          if (f[2] === '1' && f[7] === '116680003') await edge(f[4], f[5]); else counts.skipped++;
        }
      } else {
        for await (const line of linesOf(body)) {            // id effectiveTime active moduleId conceptId lang typeId term ...  (only the fully specified name)
          const f = line.split('\t'); if (f.length < 8 || f[0] === 'id') continue;
          if (f[2] === '1' && f[6] === '900000000000003001') await name(f[4], f[7].replace(/\s+\([^()]*\)$/, '')); else counts.skipped++;
        }
      }
      await flushEdges(); await flushNames();
      await bumpVersion(client);
      await client.query('COMMIT');
    } catch (err) { try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ } throw err; }
    finally { client.release(); }
    return { format, ...counts };
  }

  async function clearHierarchy() {
    const c = await pool.connect();
    try { await c.query('BEGIN'); await c.query('DELETE FROM snomed_isa'); await c.query('DELETE FROM snomed_concept'); await bumpVersion(c); await c.query('COMMIT'); }
    catch (e) { try { await c.query('ROLLBACK'); } catch (x) { /* ignore */ } throw e; }
    finally { c.release(); }
    return {};
  }

  app.get('/api/snomed/status', wrap(() => status()));
  app.post('/api/snomed/dictionary/build', wrap(req => buildDictionary(req.body || {})));
  app.get('/api/snomed/search', wrap(req => search(req.query || {})));
  app.post('/api/snomed/expand', wrap(req => expand(req.body || {})));
  app.post('/api/snomed/query/build', wrap(req => buildQuery(req.body || {})));
  app.post('/api/snomed/hierarchy/load', wrap(req => loadHierarchy(req.body || {})));
  app.delete('/api/snomed/hierarchy', wrap(() => clearHierarchy()));
}

module.exports = register;
module.exports.DOMAINS = DOMAINS;
module.exports._test = { lit, commentSafe, combine, combineGrouped, predicate, parseCsvLine, DEMO_EDGES, DEMO_NAMES };

// ---------------------------------------------------------------------------------------------------------------------
if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert');
  const t = module.exports._test;
  assert.strictEqual(t.lit("O'Neil"), "'O''Neil'");
  assert.strictEqual(t.commentSafe('a /* b */ c\nd'), 'a b c d');
  assert.deepStrictEqual(t.parseCsvLine('1,"Heart, failure",2'), ['1', 'Heart, failure', '2']);
  assert.strictEqual(t.predicate('dx', 'include', [], 'x'), 'FALSE /* x */');
  assert.strictEqual(t.predicate('dx', 'exclude', [], ''), 'TRUE');
  assert.ok(/^patient_id IN \(SELECT patient_id FROM fhir_diagnosis WHERE code IN \('1', '2'\)\)$/.test(t.predicate('dx', 'include', ['1', '2'], '')));
  assert.ok(t.predicate('dx', 'exclude', ['1'], '').includes('NOT IN (') && t.predicate('dx', 'exclude', ['1'], '').includes('patient_id IS NOT NULL'));
  assert.ok(t.predicate('al', 'include', ['9'], '').includes("json_content->'code'->'coding'->0->>'code'"));
  assert.strictEqual(t.combine([{ text: 'A' }]), 'A');
  assert.strictEqual(t.combine([{ text: 'A' }, { conn: 'AND', text: 'B' }, { conn: 'AND', text: 'C' }]), '(\n  A\n  AND B\n  AND C\n)');
  // mixed connectors nest strictly left to right: (A AND B) OR C
  const m = t.combine([{ text: 'A' }, { conn: 'AND', text: 'B' }, { conn: 'OR', text: 'C' }]);
  assert.ok(m.indexOf('AND B') < m.indexOf('OR C') && m.split('(').length === 3);
  // grouping: A AND (B OR C), and NOT (B OR C)
  assert.strictEqual(t.combineGrouped([{ text: 'A' }, { conn: 'AND', text: 'B', open: 1 }, { conn: 'OR', text: 'C', close: 1 }]), '(\n  A\n  AND (\n    B\n    OR C\n  )\n)');
  assert.ok(t.combineGrouped([{ text: 'A' }, { conn: 'AND', text: 'B', open: 1, gnot: true }, { conn: 'OR', text: 'C', close: 1 }]).includes('AND NOT ('));
  assert.throws(() => t.combineGrouped([{ text: 'A', open: 1 }]), /never closed/);
  assert.throws(() => t.combineGrouped([{ text: 'A', close: 1 }]), /no matching/);
  // demo hierarchy: every link endpoint has a name, no self links, no duplicates
  const seen = new Set();
  for (const [c, p] of t.DEMO_EDGES) { assert.ok(t.DEMO_NAMES[c] && t.DEMO_NAMES[p], `unnamed concept in ${c}->${p}`); assert.notStrictEqual(c, p); assert.ok(!seen.has(c + p)); seen.add(c + p); }
  console.log('snomed-query selftest: ok');
}
