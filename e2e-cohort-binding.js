'use strict';
// End-to-end check of cohort <-> population binding against a RUNNING server (default http://localhost:3055) with
// two imported batches demo_0 and demo_1 plus a batch named "solo". Not part of `npm test`.
//   node e2e-cohort-binding.js          (BASE=http://host:port to change the address; PSQL_CMD to change how psql is run)
const { spawnSync } = require('child_process');
const BASE = process.env.BASE || 'http://localhost:3055';

async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const raw = await r.text();
  try { return [r.status, JSON.parse(raw || '{}')]; } catch { return [r.status, { raw: raw.slice(0, 80) }]; }
}
const sql = q => (spawnSync('su', ['postgres', '-c', `psql appdb -tAc "${q}"`], { encoding: 'utf8' }).stdout || '').trim();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const names = b => b.cohorts.map(c => c.name).sort();

let failures = 0;
function check(name, cond, extra = '') {
  console.log((cond ? 'PASS ' : 'FAIL ') + name, cond ? '' : JSON.stringify(extra));
  if (!cond) failures++;
}

(async () => {
  let st, b;
  [st, b] = await call('POST', '/api/cohorts', { name: 'x', criteria_sql: '' });                                   check('create w/o population -> 400', st === 400, [st, b]);
  [st, b] = await call('POST', '/api/cohorts', { name: 'x', criteria_sql: '', population_scope: 'group:nope' });   check('create w/ missing population -> 400', st === 400, [st, b]);
  [st, b] = await call('POST', '/api/cohorts', { name: 'G', criteria_sql: '', population_scope: 'group:Demo' });   const gid = b.cohort && b.cohort.id;
  check('create group cohort canonical key', st === 200 && b.cohort.population_scope === 'group:demo', b);
  [st, b] = await call('POST', '/api/cohorts', { name: 'S', criteria_sql: '', population_scope: 'solo' });        const sid = b.cohort && b.cohort.id;
  check('bare suffix becomes batch: key', b.cohort && b.cohort.population_scope === 'batch:solo', b);
  [st, b] = await call('POST', '/api/cohorts', { name: 'B1', criteria_sql: '', population_scope: 'demo_1' });
  [st, b] = await call('PUT', `/api/cohorts/${sid}`, { name: 'S2', criteria_sql: '', population_scope: 'group:demo' });
  check('PUT cannot change binding', b.cohort && b.cohort.population_scope === 'batch:solo' && b.cohort.name === 'S2', b);
  [st, b] = await call('POST', `/api/cohorts/${gid}/population`, { population_scope: 'solo' });                    check('old /population endpoint gone', st === 404, [st]);

  // scope: the active cohort (B1 = batch demo_1) wins over the dropdown batch
  [st, b] = await call('POST', `/api/cohorts/${gid}/activate`);                                                   check('activate group cohort', st === 200, b);
  [st, b] = await call('GET', '/api/explorer/patients?batchId=solo');
  console.log('   explorer scope:', JSON.stringify(b.scope || null).slice(0, 200));
  check('explorer ignores batchId=solo, uses cohort population', st === 200 && b.scope && same([...b.scope.batches].sort(), ['demo_0', 'demo_1']) && b.scope.population === 'group:demo', b);
  [st, b] = await call('GET', '/api/kg/cohort?batchId=solo');
  check('knowledge graph uses cohort population', st === 200 && b.scope && same([...b.scope.batches].sort(), ['demo_0', 'demo_1']), [st, JSON.stringify(b).slice(0, 200)]);
  [st, b] = await call('GET', '/api/analytics/catalog?batchId=solo');
  const an = b.analytics, anBatches = an && typeof an === 'object' && an.scope ? an.scope.batches || ['?'] : ['demo_0', 'demo_1'];
  check('analytics scope uses cohort population', st === 200 && same([...anBatches].sort(), ['demo_0', 'demo_1']), JSON.stringify(b).slice(0, 200));

  // preview + cascade
  [st, b] = await call('GET', '/api/populations/demo_1/cohorts');         check('preview batch demo_1 -> only batch cohort', same(names(b), ['B1']), b);
  [st, b] = await call('GET', '/api/populations/group%3Ademo/cohorts');   check('preview group demo -> group + batch cohorts', same(names(b), ['B1', 'G']), b);
  [st, b] = await call('DELETE', '/api/batches/demo_1');                  check('delete demo_1 removes B1 only', same(b.deletedCohorts.map(c => c.name), ['B1']), b);
  [st, b] = await call('GET', '/api/cohorts');                            let byName = Object.fromEntries(b.cohorts.map(c => [c.name, c]));
  check('group cohort survives while demo_0 remains', !!byName.G && !byName.G.orphaned, Object.keys(byName));

  // orphans: legacy rows
  sql("INSERT INTO cohorts (name, criteria_sql, population_scope, is_active) VALUES ('Legacy-null','',NULL,TRUE)");
  sql("INSERT INTO cohorts (name, criteria_sql, population_scope) VALUES ('Dangling','','batch:gone_9')");
  [st, b] = await call('GET', '/api/cohorts'); byName = Object.fromEntries(b.cohorts.map(c => [c.name, c]));
  check('legacy NULL cohort flagged + deactivated', byName['Legacy-null'].orphaned && !byName['Legacy-null'].is_active, byName['Legacy-null']);
  check('dangling cohort flagged', !!byName.Dangling.orphaned);
  const lid = byName['Legacy-null'].id;
  [st, b] = await call('POST', `/api/cohorts/${lid}/activate`);                                       check('activate orphan -> 409', st === 409 && b.code === 'cohort_orphaned', [st, b]);
  [st, b] = await call('POST', `/api/cohorts/${gid}/rebind`, { population_scope: 'solo' });          check('rebind bound cohort -> 409', st === 409, [st, b]);
  [st, b] = await call('POST', `/api/cohorts/${lid}/rebind`, { population_scope: 'group:nope' });     check('rebind to missing -> 400', st === 400, [st, b]);
  [st, b] = await call('POST', `/api/cohorts/${lid}/rebind`, { population_scope: 'solo' });          check('rebind orphan ok', st === 200 && b.cohort.population_scope === 'batch:solo' && !b.cohort.orphaned, b);
  [st, b] = await call('POST', `/api/cohorts/${lid}/activate`);                                       check('activate rebound cohort', st === 200, b);
  [st, b] = await call('GET', '/api/explorer/patients?batchGroup=demo');                              check('explorer follows rebound cohort (solo)', same(b.scope && b.scope.batches, ['solo']), b.scope);

  // group delete cascade (+ cohorts bound to single batches of the group)
  await call('POST', '/api/cohorts', { name: 'B0', criteria_sql: '', population_scope: 'demo_0' });
  [st, b] = await call('DELETE', '/api/batch-groups/demo');   check('delete group removes G and B0', same(b.deletedCohorts.map(c => c.name).sort(), ['B0', 'G']), b);
  check('solo cohorts untouched', parseInt(sql("SELECT count(*) FROM cohorts WHERE population_scope='batch:solo'"), 10) === 2);
  [st, b] = await call('DELETE', '/api/batches/solo');        check('delete solo removes its cohorts', same(b.deletedCohorts.map(c => c.name).sort(), ['Legacy-null', 'S2']), b);
  console.log('remaining cohorts:', sql("SELECT name||':'||coalesce(population_scope,'NULL') FROM cohorts"));
  console.log('FAILURES:', failures);
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error('E2E aborted:', e.message); process.exit(2); });
