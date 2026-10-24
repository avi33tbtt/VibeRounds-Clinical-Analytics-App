// Cohort knowledge graph (backend of the "Cohort knowledge graph" card in the Analytics tab).
//
// Unlike /api/kg/neighbors (hand-written demo relations in terminology.js, no patient data), this builds the graph
// FROM THE DATA of the current scope: Population / Batch + active cohort (+ an optional gender / age lens).
//
//   nodes  conditions, medications, labs/vitals, procedures actually present in the cohort (top N per kind by patients)
//   edges  patient co-occurrence between two nodes, with n, lift, Jaccard, P(b|a), P(a|b), approx. z,
//          which one usually comes first in time, and the median gap in days
//   curated  every edge that also exists in terminology.js RELATIONS is tagged, and curated links whose two ends are
//          both in the graph but never co-occur are returned with n = 0, so the picture shows "known, not seen here"
//   labThr  abnormal limits of the lab nodes present (for the cohort SQL builder)
//   patients  a deterministic sample of patients with the node ids each one has (for the patient projection view)
//
// GET /api/kg/cohort?[batchId=|batchGroup=][&cohortId=][&pool=25][&maxPatients=250][&gender=][&ageMin=][&ageMax=]
//
// Self-test: node kg-cohort.js --selftest

const T = require('./terminology');

const KINDS = ['condition', 'medication', 'lab', 'procedure'];
const DICT = { condition: T.CONDITIONS, medication: T.MEDICATIONS, lab: T.LABS, procedure: T.PROCEDURES };

// code -> dictionary key, per kind (so curated relations and display names line up with the data)
const KEY_BY_CODE = {};
for (const kind of KINDS) { KEY_BY_CODE[kind] = {}; for (const [k, v] of Object.entries(DICT[kind])) KEY_BY_CODE[kind][v.code] = k; }

const nodeId = (kind, code) => KEY_BY_CODE[kind][code] || `${kind}:${code}`;

// ---- pure helpers -------------------------------------------------------------------------------------------
// Neutral names on purpose: these are co-occurrence in patients, not clinical claims. The `curated` tag on an edge says
// when terminology.js also knows the link as treated_by / monitored_by / interacts_with / screened_by / leads_to.
const EDGE_TYPE = { 'condition|condition': 'comorbid', 'condition|medication': 'prescribed_with', 'condition|lab': 'measured_with',
  'condition|procedure': 'procedure_with', 'medication|medication': 'co_prescribed' };
const edgeType = (ka, kb) => EDGE_TYPE[[ka, kb].sort().join('|')] || 'co_occurs';

function metrics(n, na, nb, N) {
  const e = (na * nb) / N, v = e * (1 - na / N) * (1 - nb / N);
  return {
    pab: na ? n / na : 0, pba: nb ? n / nb : 0,
    lift: e > 0 ? n / e : null,
    jaccard: na + nb - n > 0 ? n / (na + nb - n) : 0,
    z: v > 0 ? (n - e) / Math.sqrt(v) : null
  };
}
// who comes first? needs at least 5 patients with two dates and a 60% majority, otherwise 'none'
function direction(aFirst, bFirst) {
  const t = aFirst + bFirst;
  if (t < 5) return 'none';
  if (aFirst / t >= 0.6) return 'a_to_b';
  if (bFirst / t >= 0.6) return 'b_to_a';
  return 'none';
}
const round = (x, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

// curated relations as a map "idA|idB" (sorted) -> [{type, source, line, note, from, to}]
function curatedIndex(nodeIds) {
  const have = new Set(nodeIds), idx = new Map();
  for (const r of T.RELATIONS) {
    if (!have.has(r.from) || !have.has(r.to)) continue;
    const k = [r.from, r.to].sort().join('|');
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push({ type: r.type, from: r.from, to: r.to, source: r.source, line: r.line, note: r.note });
  }
  return idx;
}

// nodes: [{id, kind, patients}], pairs: [{a, b, n, aFirst, bFirst, gap}] (a, b are node ids, a sorted before b by kind then code)
function buildGraph(nodes, pairs, N) {
  const byId = new Map(nodes.map(x => [x.id, x]));
  const cur = curatedIndex(nodes.map(x => x.id));
  const seen = new Set();
  const edges = [];
  for (const p of pairs) {
    const A = byId.get(p.a), B = byId.get(p.b);
    if (!A || !B || p.n < 1) continue;
    const key = [p.a, p.b].sort().join('|');
    seen.add(key);
    edges.push(Object.assign({ a: p.a, b: p.b, type: edgeType(A.kind, B.kind), n: p.n, aFirst: p.aFirst, bFirst: p.bFirst, gap: round(p.gap, 0),
      dir: direction(p.aFirst, p.bFirst), curated: cur.get(key) || [] }, mapR(metrics(p.n, A.patients, B.patients, N))));
  }
  for (const [key, list] of cur) {           // known links that never co-occur in this cohort
    if (seen.has(key)) continue;
    const [x, y] = key.split('|'), A = byId.get(x), B = byId.get(y);
    const [a, b] = [A, B].sort((m, n) => KINDS.indexOf(m.kind) - KINDS.indexOf(n.kind) || (m.id < n.id ? -1 : 1));
    edges.push({ a: a.id, b: b.id, type: edgeType(a.kind, b.kind), n: 0, aFirst: 0, bFirst: 0, gap: null, dir: 'none', curated: list, pab: 0, pba: 0, lift: 0, jaccard: 0, z: null });
  }
  return edges;
}
const mapR = m => ({ pab: round(m.pab), pba: round(m.pba), lift: round(m.lift, 2), jaccard: round(m.jaccard), z: round(m.z, 1) });

// ---- Express wiring -----------------------------------------------------------------------------------------
function register(app, pool, engine, { fail }) {
  const one = v => (Array.isArray(v) ? v[0] : v);
  const int = (v, lo, hi, def) => { if (v === undefined || v === '') return def; const x = Math.floor(Number(v)); if (!Number.isFinite(x)) return def; return Math.min(hi, Math.max(lo, x)); };

  app.get('/api/kg/cohort', async (req, res) => {
    let client;
    try {
      const q = req.query;
      const poolN = int(one(q.pool), 3, 100, 25), maxPatients = int(one(q.maxPatients), 0, 500, 250);
      const gender = String(one(q.gender) || '').toLowerCase();
      if (gender && !['male', 'female', 'other', 'unknown'].includes(gender)) return res.status(400).json({ success: false, error: 'gender must be male, female, other or unknown' });
      const ageMin = int(one(q.ageMin), 0, 130, null), ageMax = int(one(q.ageMax), 0, 130, null);
      if (ageMin !== null && ageMax !== null && ageMin > ageMax) return res.status(400).json({ success: false, error: 'ageMin is larger than ageMax' });

      const ctx = await engine.resolveScope({ batchId: one(q.batchId), batchGroup: one(q.batchGroup), cohortId: one(q.cohortId), useCohort: true });

      const params = [gender || null, ageMin, ageMax];
      const labRows = Object.values(T.LABS).filter(l => l.dir === 'high' || l.dir === 'low');
      const labVals = labRows.map(l => { params.push(l.code, l.dir, l.thr); const i = params.length; return `($${i - 2}::text,$${i - 1}::text,$${i}::numeric)`; }).join(',');
      const DSP = `j->'code'->'coding'->0->>'display'`;

      client = await pool.connect();
      await client.query('BEGIN');   // temp tables only; they vanish at COMMIT, nothing is written to real tables
      await client.query(`CREATE TEMP TABLE kgc_pc ON COMMIT DROP AS ${ctx.with},
        sel AS (SELECT p.patient_id, lower(p.gender) AS gender, date_part('year', age(ref.d, p.birth_date))::int AS age FROM p, ref
                WHERE ($1::text IS NULL OR lower(p.gender) = $1::text)
                  AND ($2::int IS NULL OR date_part('year', age(ref.d, p.birth_date)) >= $2::int)
                  AND ($3::int IS NULL OR date_part('year', age(ref.d, p.birth_date)) <= $3::int)),
        lt(code, dir, thr) AS (VALUES ${labVals}),
        c AS (SELECT dx.patient_id, 'condition'::text AS kind, dx.code, min(dx.onset_date)::date AS fd, max(dx.${DSP}) AS disp, count(*)::int AS recs, NULL::boolean AS abn
                FROM dx WHERE dx.code IS NOT NULL AND dx.patient_id IN (SELECT patient_id FROM sel) GROUP BY dx.patient_id, dx.code),
        m AS (SELECT rx.patient_id, 'medication'::text, rx.code, min(rx.prescribed_date)::date, max(rx.j->'medicationCodeableConcept'->'coding'->0->>'display'), count(*)::int, NULL::boolean
                FROM rx WHERE rx.code IS NOT NULL AND rx.patient_id IN (SELECT patient_id FROM sel) GROUP BY rx.patient_id, rx.code),
        l AS (SELECT ob.patient_id, 'lab'::text, ob.code, min(ob.effective_date)::date, max(ob.${DSP}), count(*)::int,
                bool_or(CASE lt.dir WHEN 'high' THEN ob.value > lt.thr WHEN 'low' THEN ob.value < lt.thr END)
                FROM ob LEFT JOIN lt ON lt.code = ob.code WHERE ob.code IS NOT NULL AND ob.patient_id IN (SELECT patient_id FROM sel) GROUP BY ob.patient_id, ob.code),
        r AS (SELECT pr.patient_id, 'procedure'::text, pr.code, min(pr.performed_date)::date, max(pr.${DSP}), count(*)::int, NULL::boolean
                FROM pr WHERE pr.code IS NOT NULL AND pr.patient_id IN (SELECT patient_id FROM sel) GROUP BY pr.patient_id, pr.code)
        SELECT u.*, s.gender, s.age FROM (SELECT * FROM c UNION ALL SELECT * FROM m UNION ALL SELECT * FROM l UNION ALL SELECT * FROM r) u JOIN sel s USING (patient_id)`, params);
      const total = (await client.query(`${ctx.with}, sel AS (SELECT p.patient_id FROM p, ref WHERE ($1::text IS NULL OR lower(p.gender) = $1::text)
          AND ($2::int IS NULL OR date_part('year', age(ref.d, p.birth_date)) >= $2::int) AND ($3::int IS NULL OR date_part('year', age(ref.d, p.birth_date)) <= $3::int))
          SELECT count(*)::int AS n FROM sel`, [params[0], params[1], params[2]])).rows[0].n;

      await client.query(`CREATE TEMP TABLE kgc_top ON COMMIT DROP AS SELECT kind, code, patients, records, abn_patients, disp FROM (
          SELECT kind, code, count(DISTINCT patient_id)::int AS patients, sum(recs)::int AS records, count(*) FILTER (WHERE abn)::int AS abn_patients,
                 mode() WITHIN GROUP (ORDER BY disp) AS disp,
                 row_number() OVER (PARTITION BY kind ORDER BY count(DISTINCT patient_id) DESC, code) AS rn
          FROM kgc_pc GROUP BY kind, code) x WHERE rn <= $1`, [poolN]);
      await client.query(`CREATE TEMP TABLE kgc_pt ON COMMIT DROP AS SELECT pc.patient_id, pc.kind, pc.code, pc.fd, pc.gender, pc.age FROM kgc_pc pc JOIN kgc_top t USING (kind, code)`);
      await client.query('CREATE INDEX ON kgc_pt (patient_id)');
      await client.query('ANALYZE kgc_pt');

      const nodeRows = (await client.query('SELECT * FROM kgc_top ORDER BY patients DESC, kind, code')).rows;
      const pairRows = (await client.query(`SELECT a.kind AS ak, a.code AS ac, b.kind AS bk, b.code AS bc, count(*)::int AS n,
          count(*) FILTER (WHERE a.fd < b.fd)::int AS a_first, count(*) FILTER (WHERE b.fd < a.fd)::int AS b_first,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY (b.fd - a.fd)) FILTER (WHERE a.fd IS NOT NULL AND b.fd IS NOT NULL) AS gap
          FROM kgc_pt a JOIN kgc_pt b ON a.patient_id = b.patient_id AND (a.kind, a.code) < (b.kind, b.code) GROUP BY 1, 2, 3, 4`)).rows;
      const sample = maxPatients ? (await client.query(`SELECT patient_id, min(gender) AS gender, min(age) AS age, array_agg(kind || '|' || code ORDER BY kind, code) AS items
          FROM kgc_pt GROUP BY patient_id ORDER BY md5(patient_id) LIMIT $1`, [maxPatients])).rows : [];
      const withConcepts = (await client.query('SELECT count(DISTINCT patient_id)::int AS n FROM kgc_pt')).rows[0].n;
      await client.query('COMMIT');

      const nodes = nodeRows.map(r => {
        const id = nodeId(r.kind, r.code), d = DICT[r.kind][id];
        return { id, kind: r.kind, code: r.code, dict: !!d, display: (d && d.display) || r.disp || r.code, patients: r.patients, prevalence: total ? round(r.patients / total) : 0,
          records: r.records, abnPatients: r.kind === 'lab' && d && (d.dir === 'high' || d.dir === 'low') ? r.abn_patients : null,
          abnPct: r.kind === 'lab' && d && (d.dir === 'high' || d.dir === 'low') && r.patients ? round(r.abn_patients / r.patients) : null };
      });
      const pairs = pairRows.map(r => ({ a: nodeId(r.ak, r.ac), b: nodeId(r.bk, r.bc), n: r.n, aFirst: r.a_first, bFirst: r.b_first, gap: r.gap === null ? null : Number(r.gap) }));
      const edges = buildGraph(nodes, pairs, Math.max(total, 1));
      const labThr = {};                       // abnormal limits (terminology.js) for the lab nodes present, used by "abnormal only" in the cohort SQL builder
      nodes.forEach(n => { if (n.abnPct !== null) labThr[n.id] = { dir: T.LABS[n.id].dir, thr: T.LABS[n.id].thr }; });
      const patients = sample.map(r => ({ id: r.patient_id, gender: r.gender, age: r.age, items: r.items.map(s => { const [k, c] = s.split('|'); return nodeId(k, c); }) }));

      res.json({ success: true, scope: { patients: ctx.patients, cohort: ctx.cohort, batches: ctx.suffixes.map(x => x || '(legacy tables)'), asOf: ctx.asOf },
        lens: { gender: gender || null, ageMin, ageMax }, totals: { patients: total, withConcepts, sampled: patients.length },
        params: { pool: poolN, maxPatients }, nodes, edges, labThr, patients });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      fail(res, 'Cohort knowledge graph', err);
    } finally { if (client) client.release(); }
  });
}

module.exports = register;
module.exports.pure = { edgeType, metrics, direction, buildGraph, curatedIndex, nodeId };

// ---- self-test ----------------------------------------------------------------------------------------------
if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert');
  assert.strictEqual(edgeType('condition', 'medication'), 'prescribed_with');
  assert.strictEqual(edgeType('medication', 'condition'), 'prescribed_with');
  assert.strictEqual(edgeType('lab', 'lab'), 'co_occurs');
  assert.strictEqual(nodeId('condition', T.CONDITIONS.diabetes.code), 'diabetes');
  assert.strictEqual(nodeId('condition', '999'), 'condition:999');
  const m = metrics(30, 60, 50, 600);               // expected 5, observed 30 -> lift 6
  assert.strictEqual(round(m.lift, 2), 6); assert.strictEqual(round(m.pab), 0.5); assert.strictEqual(round(m.jaccard), round(30 / 80));
  assert.ok(m.z > 5);
  assert.strictEqual(metrics(1, 0, 5, 10).pab, 0);
  assert.strictEqual(direction(2, 1), 'none');       // too few
  assert.strictEqual(direction(9, 1), 'a_to_b'); assert.strictEqual(direction(1, 9), 'b_to_a'); assert.strictEqual(direction(5, 5), 'none');
  const nodes = [{ id: 'diabetes', kind: 'condition', patients: 60 }, { id: 'ckd', kind: 'condition', patients: 20 }, { id: 'metformin', kind: 'medication', patients: 50 }, { id: 'hba1c', kind: 'lab', patients: 55 }];
  const pairs = [{ a: 'diabetes', b: 'metformin', n: 45, aFirst: 40, bFirst: 2, gap: 31 }, { a: 'ckd', b: 'diabetes', n: 3, aFirst: 1, bFirst: 1, gap: null }];
  const edges = buildGraph(nodes, pairs, 600);
  const dm = edges.find(e => e.a === 'diabetes' && e.b === 'metformin');
  assert.strictEqual(dm.type, 'prescribed_with'); assert.strictEqual(dm.dir, 'a_to_b'); assert.ok(dm.curated.some(c => c.type === 'treated_by'));
  const dh = edges.find(e => e.b === 'hba1c' || e.a === 'hba1c');
  assert.ok(dh && dh.n === 0 && dh.curated.length, 'curated-only link is returned with n = 0');
  assert.ok(edges.find(e => e.a === 'ckd' && e.b === 'diabetes' && e.type === 'comorbid' && e.curated.length), 'leads_to tagged on a comorbid pair');
  assert.ok(!edges.some(e => e.n === 0 && e.curated.length === 0), 'no n = 0 edge without a curated link');
  console.log('kg-cohort.js self-test: all checks passed');
}
