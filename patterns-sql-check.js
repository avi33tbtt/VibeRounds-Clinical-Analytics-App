/*
 * patterns-sql-check.js - OPTIONAL real-Postgres check of the SQL that patterns.js builds (chunk 3).
 * Not part of `npm test` and not a dependency: it uses PGlite (Postgres compiled to WASM, in memory, nothing to set up).
 *
 *   npm install --no-save @electric-sql/pglite
 *   node patterns-sql-check.js
 *
 * (Chunk 4 added the discharge-date check and a run of the three seed patterns.)
 * It creates tiny stand-ins for the scoped views (p, dx, rx, ob, en, ... and ref) and snomed_isa, plants patients
 * whose right answer is known, runs buildSql() output and compares outcome and reasons per patient.
 */
'use strict';
const assert = require('assert');
const { PGlite } = require('@electric-sql/pglite');
const patterns = require('./patterns');

const AS_OF = '2024-12-31';
const WITH = `WITH p AS (SELECT patient_id, NULL::text AS gender, NULL::date AS birth_date, '{}'::jsonb AS pj FROM t_p),
  dx AS (SELECT * FROM t_dx), rx AS (SELECT * FROM t_rx), ob AS (SELECT * FROM t_ob), pr AS (SELECT * FROM t_dx WHERE false),
  en AS (SELECT * FROM t_en), al AS (SELECT * FROM t_dx WHERE false), im AS (SELECT * FROM t_dx WHERE false),
  ref AS (SELECT DATE '${AS_OF}' AS d)`;

async function main() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE t_p (patient_id text);
    CREATE TABLE t_dx (patient_id text, code text, code_system text, onset_date date, j jsonb);
    CREATE TABLE t_rx (patient_id text, code text, code_system text, prescribed_date date, j jsonb);
    CREATE TABLE t_ob (patient_id text, code text, code_system text, value text, unit text, effective_date date, j jsonb);
    CREATE TABLE t_en (patient_id text, cls text, start_date date, end_date date, j jsonb);
    CREATE TABLE snomed_isa (child_code text, parent_code text);`);
  let rid = 0;
  const J = () => JSON.stringify({ id: 'r' + (++rid) });
  const q = (sql, params) => db.query(sql, params);
  const reset = async () => { for (const t of ['t_p', 't_dx', 't_rx', 't_ob', 't_en']) await db.exec('DELETE FROM ' + t); };
  const add = async (kind, pid, a, b, c) => {
    if (kind === 'p') return q('INSERT INTO t_p VALUES ($1)', [pid]);
    if (kind === 'dx') return q('INSERT INTO t_dx VALUES ($1,$2,$3,$4::date,$5::jsonb)', [pid, a, 'x', b, J()]);
    if (kind === 'rx') return q('INSERT INTO t_rx VALUES ($1,$2,$3,$4::date,$5::jsonb)', [pid, a, 'x', b, J()]);
    if (kind === 'ob') return q('INSERT INTO t_ob VALUES ($1,$2,$3,$4,$5,$6::date,$7::jsonb)', [pid, a, 'x', b, 'u', c, J()]);
    if (kind === 'en') return q('INSERT INTO t_en VALUES ($1,$2,$3::date,$4::date,$5::jsonb)', [pid, a, b, c === undefined ? b : c, J()]);   // c = end date (defaults to the start)
  };
  const patient = (ids) => Promise.all(ids.map((i) => add('p', i)));

  const base = (extra) => Object.assign({ plain: 'check', source: { kind: 'library' }, epistemic: { certainty: 'hypothesis', basis: 'expert', claim: 'association' } }, extra);
  async function run(spec, opts) {
    const v = patterns.validate(spec); assert.ok(v.ok, JSON.stringify(v.errors));
    const resolved = await patterns.resolveValueSets(v.spec, db);
    const b = patterns.buildSql(v.spec, { with: WITH }, resolved, opts);
    const rows = (await q(b.sql, b.params)).rows;
    const out = {}; rows.forEach((r) => { out[r.patient_id] = { outcome: r.outcome, reasons: r.reasons, records: r.records, codes: r.codes }; });
    return { out, resolved, built: b };
  }
  const expect = (out, want) => {
    for (const [id, [outcome, reasons]] of Object.entries(want)) {
      assert.ok(out[id], 'patient ' + id + ' missing from result');
      assert.strictEqual(out[id].outcome, outcome, id + ': ' + JSON.stringify(out[id]));
      if (reasons) assert.deepStrictEqual(out[id].reasons, reasons, id + ' reasons');
    }
  };
  let n = 0; const ok = (m) => { n++; console.log('  ok  ' + m); };

  // ---- 1. the plan's short-course antibiotic pattern, with descendants ----
  await db.exec(`INSERT INTO snomed_isa VALUES ('V1','V'),('V2','V1'),('V','V2')`);   // two levels and a cycle
  await patient(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10', 'p11']);
  await add('dx', 'p1', 'V', '2024-01-01'); await add('rx', 'p1', 'A', '2024-01-02');
  await add('dx', 'p2', 'V2', '2024-02-01'); await add('rx', 'p2', 'A', '2024-02-02');            // descendant code
  await add('dx', 'p3', 'V', '2024-03-01'); await add('rx', 'p3', 'A', '2024-03-10');            // 9 days: too late
  await add('dx', 'p4', 'V', null); await add('rx', 'p4', 'A', '2024-04-02');                    // diagnosis has no date
  await add('dx', 'p5', 'V', '2024-05-01'); await add('rx', 'p5', 'A', '2024-05-02'); await add('rx', 'p5', 'A', '2024-05-20');   // refill
  await add('dx', 'p6', 'V', '2024-06-01'); await add('rx', 'p6', 'A', '2024-06-02'); await add('dx', 'p6', 'V', '2024-06-15');   // returns
  await add('dx', 'p7', 'V', '2024-12-20'); await add('rx', 'p7', 'A', '2024-12-21');            // windows still open at as-of
  await add('dx', 'p8', 'V', '2024-07-01');                                                      // no antibiotic
  await add('rx', 'p9', 'A', '2024-07-01');                                                      // no diagnosis: not eligible
  await add('dx', 'p10', 'V', '2024-08-01'); await add('rx', 'p10', 'A', null);                  // antibiotic has no date
  await add('dx', 'p11', 'V', '2024-09-01'); await add('rx', 'p11', 'A', '2024-09-10'); await add('rx', 'p11', 'A', null);   // a false beats an unknown
  const short = base({ id: 'viral_short', valuesets: { viral: { domain: 'dx', codes: ['V'], mode: 'descendants' }, antibac: { domain: 'rx', codes: ['A'], mode: 'exact' } },
    events: [{ as: 'dx', valueset: 'viral', pick: 'first' }, { as: 'abx', valueset: 'antibac', pick: 'first_on_or_after:dx' }],
    when: [{ rel: 'within_days', a: 'abx.date', of: 'dx.date', range: [0, 3] }, { rel: 'none_in_window', event: 'dx', after: 'dx.date', range: [7, 30] },
      { rel: 'no_refill', event: 'abx', supply_days: 5, grace_days: 45 }] });
  let r = await run(short);
  assert.deepStrictEqual(r.resolved.codes.viral.sort(), ['V', 'V1', 'V2']); ok('descendants expand through two levels and survive a cycle');
  expect(r.out, { p1: ['matched'], p2: ['matched'], p3: ['not_matched'], p4: ['cannot_evaluate', ['dx_date_missing']], p5: ['not_matched'], p6: ['not_matched'],
    p7: ['cannot_evaluate', ['followup_incomplete']], p8: ['not_matched'], p10: ['cannot_evaluate', ['abx_date_missing']], p11: ['not_matched'] });
  assert.strictEqual(r.out.p9, undefined); assert.strictEqual(Object.keys(r.out).length, 10);
  ok('short-course pattern: match, not match, cannot evaluate (missing date, window open), a false beats an unknown, no diagnosis = not eligible');
  assert.deepStrictEqual(Object.keys(r.out.p1.records).sort(), ['abx', 'dx']); assert.ok(/^r\d+$/.test(r.out.p1.records.dx)); assert.strictEqual(r.out.p2.codes.dx, 'V2');
  ok('matches carry the source resource id and matched code per event');
  for (const [id, v] of Object.entries(r.out)) if (v.outcome !== 'cannot_evaluate') assert.deepStrictEqual(v.reasons, [], id);
  ok('reasons are only filled for cannot_evaluate');
  r = await run(short, { requireFollowUp: false });
  expect(r.out, { p7: ['matched'] }); ok('requireFollowUp: false judges open windows on what is there');
  const poff = patterns.buildSql(patterns.validate(short).spec, { with: WITH }, r.resolved, { paramOffset: 0 });
  assert.ok(poff.params.length >= 5); ok('parameters: ' + poff.params.length + ' bound values, none inlined');

  // ---- 2. return within days (readmission shape) ----
  await reset(); await patient(['q1', 'q2', 'q3', 'q4', 'q5', 'q6']);
  await add('en', 'q1', 'IMP', '2024-01-01'); await add('en', 'q1', 'IMP', '2024-01-20');
  await add('en', 'q2', 'IMP', '2024-01-01'); await add('en', 'q2', 'IMP', '2024-03-01');
  await add('en', 'q3', 'IMP', '2024-01-01');
  await add('en', 'q4', 'IMP', '2024-12-15');
  await add('en', 'q5', 'IMP', '2024-01-01'); await add('en', 'q5', 'IMP', '2024-01-01');     // same day does not count
  await add('en', 'q6', 'IMP', '2024-01-01'); await db.query(`INSERT INTO t_en VALUES ('q6','IMP',NULL,NULL,$1::jsonb)`, [J()]);
  const ret = base({ id: 'readmit', valuesets: { stay: { domain: 'en', codes: ['IMP'], mode: 'exact' } }, events: [{ as: 'adm', valueset: 'stay', pick: 'first' }],
    when: [{ rel: 'return_within_days', event: 'adm', of: 'adm.date', days: 30 }] });
  r = await run(ret);
  expect(r.out, { q1: ['matched'], q2: ['not_matched'], q3: ['not_matched'], q4: ['cannot_evaluate', ['followup_incomplete']], q5: ['not_matched'], q6: ['cannot_evaluate', ['adm_date_missing']] });
  ok('return_within_days: strictly after, window must be over, undated records make it unknown');

  // ---- 3. latest value in a window ----
  await reset(); await patient(['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7']);
  for (const i of ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7']) await add('en', i, 'IMP', '2024-01-01');
  await add('ob', 'l1', 'HB', '7.2', '2024-01-05');
  await add('ob', 'l2', 'HB', '5.0', '2024-01-05'); await add('ob', 'l2', 'HB', '7.0', '2024-01-10');
  await add('ob', 'l3', 'HB', '7.0', '2024-01-05'); await add('ob', 'l3', 'HB', '5.5', '2024-01-10');
  await add('ob', 'l4', 'HB', '9.0', '2024-02-20');
  await add('ob', 'l5', 'HB', 'abc', '2024-01-05');
  await add('ob', 'l7', 'HB', '8.0', null);
  const lat = base({ id: 'hb_high', valuesets: { stay: { domain: 'en', codes: ['IMP'], mode: 'exact' }, lab: { domain: 'ob', codes: ['HB'], mode: 'exact' } },
    events: [{ as: 'adm', valueset: 'stay', pick: 'first' }, { as: 'hb', valueset: 'lab', pick: 'any' }],
    when: [{ rel: 'latest_value_in_window', event: 'hb', of: 'adm.date', range: [0, 30], op: 'gte', value: 6.5 }] });
  r = await run(lat);
  expect(r.out, { l1: ['matched'], l2: ['matched'], l3: ['not_matched'], l4: ['not_matched'], l5: ['cannot_evaluate', ['hb_value_missing']], l6: ['not_matched'], l7: ['cannot_evaluate', ['hb_date_missing']] });
  ok('latest_value_in_window: latest value decides, outside window = no, non-numeric or undated = unknown');

  // ---- 4. counts, before/after ----
  await reset(); await patient(['c1', 'c2', 'c3', 'c4']);
  await add('en', 'c1', 'IMP', '2024-01-01'); await add('en', 'c1', 'IMP', '2024-02-01');
  await add('en', 'c2', 'IMP', '2024-01-01');
  await add('en', 'c3', 'IMP', '2024-01-01'); await add('en', 'c3', 'IMP', '2024-01-11');
  await add('dx', 'c1', 'V', '2024-01-05'); await add('dx', 'c2', 'V', '2024-01-05');
  const cnt = base({ id: 'two_stays', valuesets: { stay: { domain: 'en', codes: ['IMP'], mode: 'exact' } }, events: [{ as: 'adm', valueset: 'stay', pick: 'any' }], when: [{ rel: 'count_at_least', event: 'adm', count: 2 }] });
  r = await run(cnt); expect(r.out, { c1: ['matched'], c2: ['not_matched'], c3: ['matched'] }); ok('count_at_least without a window counts every record, dated or not');
  const win = base({ id: 'second_soon', valuesets: { stay: { domain: 'en', codes: ['IMP'], mode: 'exact' } }, events: [{ as: 'adm', valueset: 'stay', pick: 'first' }],
    when: [{ rel: 'count_at_least', event: 'adm', count: 2, of: 'adm.date', range: [0, 30] }] });
  r = await run(win); expect(r.out, { c1: ['not_matched'], c2: ['not_matched'], c3: ['matched'] }); ok('count_at_least in a window: both ends inclusive (day 31 is out), the index stay counts from day 0');
  const ord = base({ id: 'dx_after_adm', valuesets: { stay: { domain: 'en', codes: ['IMP'], mode: 'exact' }, d: { domain: 'dx', codes: ['V'], mode: 'exact' } },
    events: [{ as: 'adm', valueset: 'stay', pick: 'first' }, { as: 'dx', valueset: 'd', pick: 'first' }], when: [{ rel: 'before', a: 'adm.date', b: 'dx.date' }] });
  r = await run(ord); expect(r.out, { c1: ['matched'], c2: ['matched'], c3: ['not_matched'] }); ok('before: strict, a missing second event is a plain no');

  // ---- 5. no relations at all, and a value set that is all unknown to the data ----
  const none = base({ id: 'just_dx', valuesets: { d: { domain: 'dx', codes: ['V'], mode: 'exact' } }, events: [{ as: 'dx', valueset: 'd', pick: 'first' }], when: [] });
  r = await run(none); expect(r.out, { c1: ['matched'], c2: ['matched'] }); assert.strictEqual(r.out.c3, undefined); ok('a spec with no time relations matches every eligible patient');
  // ---- 6. return measured from the discharge date (chunk 4) ----
  await reset(); await patient(['d1', 'd2', 'd3', 'd4', 'd5', 'd6']);
  await add('en', 'd1', 'IMP', '2024-01-01', '2024-01-20'); await add('en', 'd1', 'IMP', '2024-02-10', '2024-02-12');   // 21 days after discharge, 40 after admission
  await add('en', 'd2', 'IMP', '2024-01-01', '2024-01-20'); await add('en', 'd2', 'IMP', '2024-03-01', '2024-03-02');   // 40 days after discharge
  await add('en', 'd3', 'IMP', '2024-01-01', '2024-01-10'); await add('en', 'd3', 'IMP', '2024-01-05', '2024-01-06');   // starts before discharge: not a return
  await add('en', 'd4', 'IMP', '2024-01-01', null);                                                                      // no discharge date
  await add('en', 'd5', 'IMP', '2024-12-20', '2024-12-28');                                                              // 30-day window still open
  await add('en', 'd6', 'IMP', '2024-01-01', '2024-01-20'); await add('en', 'd6', 'IMP', '2024-01-22', '2024-01-23');   // two days after discharge
  const dis = base({ id: 'readmit_dis', valuesets: { stay: { domain: 'en', codes: ['IMP'], mode: 'exact' } }, events: [{ as: 'adm', valueset: 'stay', pick: 'first' }],
    when: [{ rel: 'return_within_days', event: 'adm', of: 'adm.date', days: 30, from: 'end' }] });
  r = await run(dis);
  expect(r.out, { d1: ['matched'], d2: ['not_matched'], d3: ['not_matched'], d4: ['cannot_evaluate', ['adm_end_missing']], d5: ['cannot_evaluate', ['followup_incomplete']], d6: ['matched'] });
  const fromStart = JSON.parse(JSON.stringify(dis)); delete fromStart.when[0].from; fromStart.id = 'readmit_start';
  r = await run(fromStart);
  expect(r.out, { d1: ['not_matched'], d6: ['matched'], d4: ['not_matched'] });
  ok('return_within_days from "end": counted from discharge, an admission that starts before discharge is no return, no discharge date = unknown, from the start behaves as before');
  for (const seed of patterns.SEEDS) await run(seed);
  ok('the three seed patterns build and run on real Postgres');
  console.log(n + ' checks passed on real Postgres (PGlite)');
  await db.close();
}
main().catch((e) => { console.error('CHECK FAILED:', e && e.stack || e); process.exit(1); });
