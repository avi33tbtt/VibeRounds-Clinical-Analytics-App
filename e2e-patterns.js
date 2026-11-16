'use strict';
// End-to-end check of the pattern encyclopedia against a RUNNING server.
//   BASE=http://localhost:3055 node e2e-patterns.js
// Needs sign-in switched off (AUTH_DISABLED=true) or COOKIE=<session cookie> of an administrator.
// Creates its own pattern (id e2e_pattern_*) and removes nothing: retire it from the tab if you want it gone.
// The run and explain steps need an active cohort; without one they are reported as SKIP, not as failures.
// The AI steps pass whether or not a model key is set: a bad or missing model must never produce a draft that fails the checker.
// Exit code 1 on any failure.
const assert = require('assert');
const B = process.env.BASE || 'http://localhost:3055';
const HDR = { 'Content-Type': 'application/json', ...(process.env.COOKIE ? { Cookie: process.env.COOKIE } : {}) };
let fails = 0, skips = 0;
const call = async (method, path, body) => {
  const r = await fetch(B + path, { method, headers: HDR, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j; try { j = JSON.parse(t || '{}'); } catch (e) { j = { raw: t.slice(0, 80) }; }
  return [r.status, j];
};
const check = async (name, fn) => {
  try { const r = await fn(); if (r === 'skip') { skips++; console.log('SKIP ' + name); } else console.log('PASS ' + name); }
  catch (e) { fails++; console.log('FAIL ' + name + ' :: ' + String(e.message).slice(0, 400)); }
};
(async () => {
  let seedId = 'drug_within_90d_of_dx', mine = null, version = null, bundle = null, runId = null;

  await check('seed creates the three patterns, a second seed creates none', async () => {
    const [s1, a] = await call('POST', '/api/patterns/seed'); assert.strictEqual(s1, 200, JSON.stringify(a));
    assert.strictEqual(a.created.length + a.existing.length, 3);
    const [, b] = await call('POST', '/api/patterns/seed'); assert.strictEqual(b.created.length, 0);
  });
  await check('list shows the seeds, and a bad status filter is 400', async () => {
    const [s, l] = await call('GET', '/api/patterns'); assert.strictEqual(s, 200);
    assert.ok(l.patterns.some((p) => p.id === seedId));
    assert.strictEqual((await call('GET', '/api/patterns?status=nope'))[0], 400);
  });
  await check('an invalid spec is rejected with 422 and nothing is saved', async () => {
    const [s] = await call('POST', '/api/patterns', { id: 'e2e_bad', plain: 'x', events: 'not a list' });
    assert.ok(s === 422 || s === 400, 'status ' + s);
    assert.strictEqual((await call('GET', '/api/patterns/e2e_bad'))[0], 404);
  });
  await check('a seed is a draft at hypothesis and cannot be raised without a reviewer note', async () => {
    const [, g] = await call('GET', '/api/patterns/' + seedId);
    const sp = g.pattern || g.spec || g; version = g.version || (g.pattern && g.pattern.version) || (g.spec && g.spec.version);
    assert.ok(JSON.stringify(g).includes('hypothesis'));
    const [s] = await call('POST', `/api/patterns/${seedId}/certainty`, { certainty: 'established', note: 'x', version });
    assert.ok(s >= 400 && s < 500, 'status ' + s);
  });
  await check('review flow: draft to reviewed needs a reason and the current version', async () => {
    const [, g] = await call('GET', '/api/patterns/' + 'viral_abx_short_course');
    const v = g.version || (g.pattern && g.pattern.version) || (g.spec && g.spec.version);
    const [s0] = await call('POST', '/api/patterns/viral_abx_short_course/status', { to: 'reviewed', version: v });
    assert.ok(s0 >= 400 && s0 < 500, 'no note: ' + s0);
    const [s1] = await call('POST', '/api/patterns/viral_abx_short_course/status', { to: 'active', note: 'skip a step', version: v });
    assert.strictEqual(s1, 409, 'draft cannot go straight to active');
    const [s2] = await call('POST', '/api/patterns/viral_abx_short_course/status', { to: 'reviewed', note: 'e2e review', version: 999999 });
    assert.strictEqual(s2, 409, 'stale version');
  });
  await check('export, then import the same file: nothing new, nothing invalid', async () => {
    await call('POST', `/api/patterns/viral_abx_short_course/status`, { to: 'reviewed', note: 'e2e review', version: (await call('GET', '/api/patterns/viral_abx_short_course'))[1].version }).catch(() => {});
    const [s, f] = await call('GET', '/api/patterns/export?status=draft'); assert.strictEqual(s, 200);
    bundle = f; assert.ok(Array.isArray(f.patterns) && f.patterns.length >= 1);
    const [s2, r] = await call('POST', '/api/patterns/import', { bundle: f, note: 'e2e' });
    assert.strictEqual(s2, 200, JSON.stringify(r)); assert.strictEqual(r.created.length, 0); assert.strictEqual(r.invalid.length, 0);
  });
  await check('a damaged export file is refused whole', async () => {
    if (!bundle) return 'skip';
    const bad = JSON.parse(JSON.stringify(bundle)); bad.patterns[0].plain = (bad.patterns[0].plain || '') + ' tampered';
    const [s] = await call('POST', '/api/patterns/import', { bundle: bad });
    assert.ok(s === 422 || s === 400, 'status ' + s);
  });
  await check('AI draft: a bad description or a missing key never returns an invalid draft', async () => {
    assert.strictEqual((await call('POST', '/api/patterns/ai-draft', {}))[0], 400);
    const [s, j] = await call('POST', '/api/patterns/ai-draft', { description: 'a drug started within 90 days after a diagnosis' });
    if (s === 200) { assert.strictEqual(j.ai_generated, true); assert.strictEqual(j.draft.status, 'draft'); assert.strictEqual(j.draft.epistemic.certainty, 'hypothesis'); }
    else assert.ok([400, 409, 422, 501, 502, 503].includes(s), 'status ' + s + ' ' + JSON.stringify(j).slice(0, 120));
  });
  await check('assistant: top diagnoses are listed, and a bad or unlisted code is refused', async () => {
    const [s, j] = await call('GET', '/api/patterns/assistant/diagnoses');
    if (s === 409) return 'skip';
    assert.strictEqual(s, 200, JSON.stringify(j).slice(0, 200));
    assert.ok(Array.isArray(j.diagnoses) && j.diagnoses.length <= 100);
    for (const d of j.diagnoses) assert.ok(d.code && Number(d.patients) >= (j.min_cell || 0), 'row under the minimum cell size: ' + JSON.stringify(d));
    assert.strictEqual((await call('POST', '/api/patterns/assistant/suggest', {}))[0], 400);
    assert.strictEqual((await call('POST', '/api/patterns/assistant/suggest', { code: 'x', extra: 1 }))[0], 400);
    assert.ok([400, 404].includes((await call('POST', '/api/patterns/assistant/suggest', { code: 'E2E-NOT-A-DX' }))[0]));
  });
  await check('assistant: suggestions are checked drafts, are not saved by the call, and the first one saves', async () => {
    const [s0, l] = await call('GET', '/api/patterns/assistant/diagnoses');
    if (s0 !== 200 || !l.diagnoses.length) return 'skip';
    const before = (await call('GET', '/api/patterns'))[1].patterns.length;
    const [s, j] = await call('POST', '/api/patterns/assistant/suggest', { code: l.diagnoses[0].code });
    if (s !== 200) { assert.ok([400, 404, 409, 422, 501, 502, 503].includes(s), 'status ' + s + ' ' + JSON.stringify(j).slice(0, 120)); return; }
    assert.strictEqual(j.ai_generated, true); assert.ok(j.suggestions.length >= 1);
    for (const g of j.suggestions) { assert.ok(g.title && g.plain); assert.strictEqual(g.draft.status, 'draft'); assert.strictEqual(g.draft.epistemic.certainty, 'hypothesis'); assert.strictEqual(g.draft.epistemic.basis, 'model_suggested'); }
    assert.strictEqual((await call('GET', '/api/patterns'))[1].patterns.length, before, 'the call must not save anything');
    const [s2, sv] = await call('POST', '/api/patterns', j.suggestions[0].draft);
    assert.ok(s2 === 200 || s2 === 201, 'saving the draft: ' + s2 + ' ' + JSON.stringify(sv).slice(0, 200));
  });
  await check('run on the active cohort returns counts and the three chips', async () => {
    const [s, j] = await call('POST', `/api/patterns/${seedId}/run`, {});
    if (s === 409) return 'skip';
    assert.strictEqual(s, 200, JSON.stringify(j).slice(0, 200));
    assert.ok(j.result && j.result.counts && j.epistemic && j.epistemic.text); runId = j.run.id;
  });
  await check('explain: chips first, and the model text (if any) has no digits', async () => {
    if (!runId) return 'skip';
    const [s, j] = await call('POST', `/api/patterns/${seedId}/explain`, { run_id: runId });
    if (s !== 200) { assert.ok(s >= 400, 'status ' + s); return; }
    assert.ok(Array.isArray(j.chips) && j.chips.length >= 3);
    if (j.explanation) assert.ok(!/\d/.test(j.explanation));
  });
  await check('runs list holds the saved run', async () => {
    if (!runId) return 'skip';
    const [s, j] = await call('GET', `/api/patterns/${seedId}/runs`); assert.strictEqual(s, 200);
    assert.ok(j.runs.some((r) => r.id === runId));
  });
  console.log(`\n${fails ? 'FAILED' : 'OK'}: ${fails} failed, ${skips} skipped`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
