// Patient data explorer (backend of the "Patient data explorer" section in the Analytics tab).
//
// Browse the patients of the current scope (Population / Batch + active cohort) and open one patient to see everything
// that was imported for them: demographics, conditions, medications, labs / vitals (with abnormal flags and a series per
// test), procedures, encounters, allergies and immunizations, plus the raw FHIR Patient resource.
//
//   GET /api/explorer/patients?[batchId=|batchGroup=][&cohortId=][&q=][&concept=][&gender=][&ageMin=][&ageMax=]
//                              [&sort=id|age_desc|age_asc][&limit=25][&offset=0]
//        q        matches patient id or name (substring, case-insensitive)
//        concept  matches a condition / medication / lab / procedure by display text or code (substring)
//        -> { scope, total, limit, offset, patients: [{ id, name, gender, birthDate, age, conditions, medications, labs, procedures, encounters }] }
//
//   GET /api/explorer/patient?id=<patient_id>[&batchId=|batchGroup=][&cohortId=]
//        -> { scope, patient, counts, conditions, medications, labs, procedures, encounters, allergies, immunizations, truncated }
//
// Read-only: it only SELECTs through the same scope CTE the analytics use, so nothing is written.
//
// Self-test: node patient-explorer.js --selftest

const T = require('./terminology');

const MAX_ROWS = 1000;   // per record type in the patient view (flagged as truncated when reached)

// ---- pure helpers -------------------------------------------------------------------------------------------
const LAB_BY_CODE = {};
for (const d of Object.values(T.LABS)) LAB_BY_CODE[d.code] = d;

const stripHtml = s => (s === null || s === undefined ? '' : String(s)).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const likeEsc = s => String(s).replace(/[\\%_]/g, c => '\\' + c);
const num = v => { if (v === null || v === undefined || v === '') return null; const x = Number(v); return Number.isFinite(x) ? x : null; };

// 'high' | 'low' | 'abnormal' | 'normal' | null (unknown). Order: the flag the source sent, then its reference range,
// then the abnormal limit in terminology.js (only when the unit is the one the limit is defined for).
function labFlag(o, dict = LAB_BY_CODE) {
  const v = num(o.value);
  if (v === null) return null;
  const i = String(o.interp || '').toUpperCase();
  if (['H', 'HH', 'HU', '>'].includes(i)) return 'high';
  if (['L', 'LL', 'LU', '<'].includes(i)) return 'low';
  if (['A', 'AA'].includes(i)) return 'abnormal';
  if (['N'].includes(i)) return 'normal';
  const hi = num(o.hi), lo = num(o.lo);
  if (hi !== null && v > hi) return 'high';
  if (lo !== null && v < lo) return 'low';
  if (hi !== null || lo !== null) return 'normal';
  const d = dict[o.code];
  if (d && (d.dir === 'high' || d.dir === 'low') && (!o.unit || !d.unit || o.unit === d.unit)) {
    if (d.dir === 'high') return v > d.thr ? 'high' : 'normal';
    return v < d.thr ? 'low' : 'normal';
  }
  return null;
}

// ORDER BY for the page (rows aliased p) and for the final select (rows aliased pg)
const SORTS = { id: ['p.patient_id', 'pg.id'], age_desc: ['p.age DESC NULLS LAST, p.patient_id', 'pg.age DESC NULLS LAST, pg.id'], age_asc: ['p.age ASC NULLS LAST, p.patient_id', 'pg.age ASC NULLS LAST, pg.id'] };

// shared SQL snippets (aliases used inside the scope CTE: dx, ob, rx, pr, en, al, im, p)
const DISP = {
  dx: `coalesce(dx.j->'code'->'coding'->0->>'display', dx.j->'code'->>'text')`,
  ob: `coalesce(ob.j->'code'->'coding'->0->>'display', ob.j->'code'->>'text')`,
  rx: `coalesce(rx.j->'medicationCodeableConcept'->'coding'->0->>'display', rx.j->'medicationCodeableConcept'->>'text')`,
  pr: `coalesce(pr.j->'code'->'coding'->0->>'display', pr.j->'code'->>'text')`
};
const NAME = `coalesce(nullif(concat_ws(' ', p.pj->'name'->0->'given'->>0, p.pj->'name'->0->>'family'), ''), p.pj->'name'->0->>'text')`;
const D = col => `to_char(${col}, 'YYYY-MM-DD')`;

function listSql(ctx, f) {
  const P = [], add = v => { P.push(v); return `$${P.length}`; };
  const w = [];
  if (f.gender) w.push(`lower(p.gender) = ${add(f.gender)}`);
  if (f.ageMin !== null) w.push(`date_part('year', age(ref.d, p.birth_date)) >= ${add(f.ageMin)}`);
  if (f.ageMax !== null) w.push(`date_part('year', age(ref.d, p.birth_date)) <= ${add(f.ageMax)}`);
  if (f.q) { const i = add('%' + likeEsc(f.q) + '%'); w.push(`(p.patient_id ILIKE ${i} OR coalesce(${NAME}, '') ILIKE ${i})`); }
  if (f.concept) {
    const i = add('%' + likeEsc(f.concept) + '%');
    w.push(`(EXISTS (SELECT 1 FROM dx WHERE dx.patient_id = p.patient_id AND (dx.code ILIKE ${i} OR ${DISP.dx} ILIKE ${i}))
      OR EXISTS (SELECT 1 FROM rx WHERE rx.patient_id = p.patient_id AND (rx.code ILIKE ${i} OR ${DISP.rx} ILIKE ${i}))
      OR EXISTS (SELECT 1 FROM ob WHERE ob.patient_id = p.patient_id AND (ob.code ILIKE ${i} OR ${DISP.ob} ILIKE ${i}))
      OR EXISTS (SELECT 1 FROM pr WHERE pr.patient_id = p.patient_id AND (pr.code ILIKE ${i} OR ${DISP.pr} ILIKE ${i})))`);
  }
  const sel = `sel AS (SELECT p.patient_id, p.gender, p.birth_date, p.pj, date_part('year', age(ref.d, p.birth_date))::int AS age
      FROM p, ref ${w.length ? 'WHERE ' + w.join(' AND ') : ''})`;
  const countSql = `${ctx.with}, ${sel} SELECT count(*)::int AS n FROM sel`;
  const [orderP, orderPg] = SORTS[f.sort] || SORTS.id;
  const pageSql = `${ctx.with}, ${sel},
    pg AS (SELECT p.patient_id AS id, p.gender, p.birth_date, p.age, p.pj FROM sel p ORDER BY ${orderP} LIMIT ${add(f.limit)} OFFSET ${add(f.offset)})
    SELECT pg.id, ${NAME.replace(/p\.pj/g, 'pg.pj')} AS name, pg.gender, ${D('pg.birth_date')} AS birth_date, pg.age,
      (SELECT count(DISTINCT dx.code)::int FROM dx WHERE dx.patient_id = pg.id) AS conditions,
      (SELECT count(DISTINCT rx.code)::int FROM rx WHERE rx.patient_id = pg.id) AS medications,
      (SELECT count(*)::int FROM ob WHERE ob.patient_id = pg.id) AS labs,
      (SELECT count(*)::int FROM pr WHERE pr.patient_id = pg.id) AS procedures,
      (SELECT count(*)::int FROM en WHERE en.patient_id = pg.id) AS encounters
    FROM pg ORDER BY ${orderPg}`;
  return { countSql, pageSql, params: P, countParams: P.slice(0, P.length - 2) };
}

function detailSql(ctx) {
  const agg = sub => `(SELECT coalesce(json_agg(t), '[]'::json) FROM (${sub} LIMIT ${MAX_ROWS + 1}) t)`;
  const text = col => `left(regexp_replace(regexp_replace(coalesce(${col}, ''), '<[^>]*>', ' ', 'g'), '\\s+', ' ', 'g'), 400)`;
  return `${ctx.with}
    SELECT
      (SELECT row_to_json(t) FROM (SELECT p.patient_id AS id, ${NAME} AS name, p.gender, ${D('p.birth_date')} AS birth_date,
         date_part('year', age(ref.d, p.birth_date))::int AS age, ref.d::text AS as_of, p.pj AS resource FROM p, ref WHERE p.patient_id = $1) t) AS patient,
      ${agg(`SELECT dx.code, dx.code_system AS system, ${DISP.dx} AS display, ${D('dx.onset_date')} AS date, dx.j->'clinicalStatus'->'coding'->0->>'code' AS status,
               ${text(`dx.j->'text'->>'div'`)} AS note FROM dx WHERE dx.patient_id = $1 ORDER BY dx.onset_date NULLS LAST, dx.code`)} AS conditions,
      ${agg(`SELECT rx.code, ${DISP.rx} AS display, ${D('rx.prescribed_date')} AS date, rx.j->>'status' AS status, rx.j->'dosageInstruction'->0->>'text' AS dosage,
               ${text(`rx.j->'text'->>'div'`)} AS note FROM rx WHERE rx.patient_id = $1 ORDER BY rx.prescribed_date NULLS LAST, rx.code`)} AS medications,
      ${agg(`SELECT ob.code, ob.code_system AS system, ${DISP.ob} AS display, ob.value, ob.unit, ${D('ob.effective_date')} AS date,
               ob.j->'interpretation'->0->'coding'->0->>'code' AS interp, ob.j->'referenceRange'->0->'high'->>'value' AS hi, ob.j->'referenceRange'->0->'low'->>'value' AS lo,
               ob.j->'valueString' AS text_value
             FROM ob WHERE ob.patient_id = $1 ORDER BY ob.effective_date NULLS LAST, ob.code`)} AS labs,
      ${agg(`SELECT pr.code, ${DISP.pr} AS display, ${D('pr.performed_date')} AS date, ${text(`pr.j->'text'->>'div'`)} AS note
             FROM pr WHERE pr.patient_id = $1 ORDER BY pr.performed_date NULLS LAST, pr.code`)} AS procedures,
      ${agg(`SELECT en.cls AS class, en.j->'type'->0->>'text' AS type, en.j->'reasonCode'->0->>'text' AS reason, ${D('en.start_date')} AS start, ${D('en.end_date')} AS "end",
               en.j->>'status' AS status FROM en WHERE en.patient_id = $1 ORDER BY en.start_date NULLS LAST`)} AS encounters,
      ${agg(`SELECT al.substance, al.reaction, al.severity FROM al WHERE al.patient_id = $1 ORDER BY al.substance`)} AS allergies,
      ${agg(`SELECT im.code, coalesce(im.j->'vaccineCode'->'coding'->0->>'display', im.j->'vaccineCode'->>'text') AS display, ${D('im.occurrence_date')} AS date
             FROM im WHERE im.patient_id = $1 ORDER BY im.occurrence_date NULLS LAST`)} AS immunizations`;
}

// trims the +1 probe row, flags truncation, adds the abnormal flag to labs and strips FHIR narrative
function shapeDetail(row) {
  const truncated = {}, take = k => { const a = row[k] || []; if (a.length > MAX_ROWS) { truncated[k] = true; return a.slice(0, MAX_ROWS); } return a; };
  const out = { patient: row.patient };
  for (const k of ['conditions', 'medications', 'labs', 'procedures', 'encounters', 'allergies', 'immunizations']) out[k] = take(k);
  out.labs = out.labs.map(o => { const v = num(o.value); return { code: o.code, system: o.system, display: o.display || o.code, value: v, textValue: v === null && typeof o.text_value === 'string' ? o.text_value : null,
    unit: o.unit, date: o.date, flag: labFlag(o) }; });
  for (const k of ['conditions', 'medications', 'procedures']) out[k] = out[k].map(x => Object.assign({}, x, { note: stripHtml(x.note) || null, display: x.display || x.code }));
  out.counts = Object.fromEntries(['conditions', 'medications', 'labs', 'procedures', 'encounters', 'allergies', 'immunizations'].map(k => [k, out[k].length]));
  out.truncated = truncated;
  return out;
}

// ---- Express wiring -----------------------------------------------------------------------------------------
function register(app, pool, engine, { fail }) {
  const one = v => (Array.isArray(v) ? v[0] : v);
  const int = (v, lo, hi, def) => { if (v === undefined || v === '') return def; const x = Math.floor(Number(v)); if (!Number.isFinite(x)) return def; return Math.min(hi, Math.max(lo, x)); };
  const scopeOf = q => ({ batchId: one(q.batchId), batchGroup: one(q.batchGroup), cohortId: one(q.cohortId), useCohort: true });
  const scopeOut = ctx => ({ patients: ctx.patients, cohort: ctx.cohort, batches: ctx.suffixes.map(x => x || '(legacy tables)'), asOf: ctx.asOf });

  app.get('/api/explorer/patients', async (req, res) => {
    try {
      const q = req.query, gender = String(one(q.gender) || '').toLowerCase();
      if (gender && !['male', 'female', 'other', 'unknown'].includes(gender)) return res.status(400).json({ success: false, error: 'gender must be male, female, other or unknown' });
      const ageMin = int(one(q.ageMin), 0, 130, null), ageMax = int(one(q.ageMax), 0, 130, null);
      if (ageMin !== null && ageMax !== null && ageMin > ageMax) return res.status(400).json({ success: false, error: 'ageMin is larger than ageMax' });
      const f = { gender: gender || null, ageMin, ageMax, q: String(one(q.q) || '').trim().slice(0, 100), concept: String(one(q.concept) || '').trim().slice(0, 100),
        sort: String(one(q.sort) || 'id'), limit: int(one(q.limit), 1, 200, 25), offset: int(one(q.offset), 0, 10000000, 0) };
      const ctx = await engine.resolveScope(scopeOf(q));
      const s = listSql(ctx, f);
      const total = (await pool.query(s.countSql, s.countParams)).rows[0].n;
      const rows = (await pool.query(s.pageSql, s.params)).rows;
      res.json({ success: true, scope: scopeOut(ctx), total, limit: f.limit, offset: f.offset,
        patients: rows.map(r => ({ id: r.id, name: r.name || null, gender: r.gender, birthDate: r.birth_date, age: r.age, conditions: r.conditions, medications: r.medications, labs: r.labs, procedures: r.procedures, encounters: r.encounters })) });
    } catch (err) { fail(res, 'Patient explorer list', err); }
  });

  app.get('/api/explorer/patient', async (req, res) => {
    try {
      const id = String(one(req.query.id) || '').trim();
      if (!id) return res.status(400).json({ success: false, error: 'id is required' });
      const ctx = await engine.resolveScope(scopeOf(req.query));
      const row = (await pool.query(detailSql(ctx), [id])).rows[0];
      if (!row || !row.patient) return res.status(404).json({ success: false, error: 'Patient not found in the current Population / Batch and cohort' });
      res.json(Object.assign({ success: true, scope: scopeOut(ctx) }, shapeDetail(row)));
    } catch (err) { fail(res, 'Patient explorer record', err); }
  });
}

module.exports = register;
module.exports.pure = { stripHtml, likeEsc, labFlag, listSql, detailSql, shapeDetail };

// ---- self-test ----------------------------------------------------------------------------------------------
if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert');
  assert.strictEqual(stripHtml('<div xmlns="x">Diabetes &amp; <b>HTN</b>.</div>'), 'Diabetes & HTN .');
  assert.strictEqual(likeEsc('50%_a\\b'), '50\\%\\_a\\\\b');
  // lab flags: source flag > reference range > terminology.js limit
  assert.strictEqual(labFlag({ value: 5, interp: 'H' }), 'high');
  assert.strictEqual(labFlag({ value: 5, interp: 'N', hi: 1 }), 'normal');
  assert.strictEqual(labFlag({ value: 5, hi: 4 }), 'high'); assert.strictEqual(labFlag({ value: 1, lo: 2 }), 'low'); assert.strictEqual(labFlag({ value: 3, lo: 2, hi: 4 }), 'normal');
  const hb = T.LABS.hba1c; assert.ok(hb, 'terminology.js has hba1c');
  assert.strictEqual(labFlag({ code: hb.code, value: hb.thr + 1, unit: hb.unit }), 'high'); assert.strictEqual(labFlag({ code: hb.code, value: hb.thr - 1, unit: hb.unit }), 'normal');
  assert.strictEqual(labFlag({ code: hb.code, value: hb.thr + 1, unit: 'some-other-unit' }), null);   // limit only applies in its own unit
  assert.strictEqual(labFlag({ code: 'nope', value: 3 }), null); assert.strictEqual(labFlag({ value: null }), null);
  // SQL builders: placeholders line up with the params, LIMIT / OFFSET are always the last two
  const ctx = { with: 'WITH p AS (SELECT 1), ref AS (SELECT now()::date AS d)' };
  const s = listSql(ctx, { gender: 'female', ageMin: 40, ageMax: null, q: 'a_b', concept: 'diab', sort: 'age_desc', limit: 25, offset: 50 });
  assert.deepStrictEqual(s.params, ['female', 40, '%a\\_b%', '%diab%', 25, 50]); assert.strictEqual(s.countParams.length, 4);
  assert.ok(/\$6/.test(s.pageSql) && !/\$7/.test(s.pageSql) && !/\$5/.test(s.countSql), 'placeholders match');
  assert.ok(/ORDER BY p\.age DESC/.test(s.pageSql) && /ORDER BY pg\.age DESC/.test(s.pageSql));
  const s2 = listSql(ctx, { gender: null, ageMin: null, ageMax: null, q: '', concept: '', sort: 'bogus', limit: 10, offset: 0 });
  assert.deepStrictEqual(s2.params, [10, 0]); assert.ok(!/WHERE lower/.test(s2.pageSql));
  assert.ok(/\$1/.test(detailSql(ctx)));
  // shapeDetail
  const big = Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({ code: 'c' + i, display: null, note: '<div>x</div>' }));
  const sh = shapeDetail({ patient: { id: 'p1' }, conditions: big, medications: [], labs: [{ code: hb.code, display: 'HbA1c', value: String(hb.thr + 2), unit: hb.unit, date: '2024-01-01' }, { code: 'z', value: null, text_value: 'positive' }],
    procedures: [], encounters: [], allergies: [], immunizations: [] });
  assert.strictEqual(sh.conditions.length, MAX_ROWS); assert.ok(sh.truncated.conditions); assert.strictEqual(sh.conditions[0].display, 'c0'); assert.strictEqual(sh.conditions[0].note, 'x');
  assert.strictEqual(sh.labs[0].flag, 'high'); assert.strictEqual(sh.labs[0].value, hb.thr + 2); assert.strictEqual(sh.labs[1].textValue, 'positive'); assert.strictEqual(sh.counts.labs, 2);
  console.log('patient-explorer.js self-test: all checks passed');
}
