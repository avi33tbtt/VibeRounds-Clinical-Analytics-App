'use strict';
// Population keys: the one place that decides what a cohort's "population" is and which batch suffixes it covers.
//   batch:<suffix>   exactly one imported batch   (tables fhir_*_<suffix>)
//   group:<base>     every batch whose suffix is <base> or <base>_<number>   (the "population" in the dropdown)
// Old dropdown values (a bare batch suffix, or "group:<base>") are accepted and turned into the canonical key.
// Names are lower-cased because PostgreSQL stores the unquoted table names in lower case.
// Pure functions, no database.  Self-test:  node population.js --selftest

const sanitize = s => String(s).replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
const baseOf = suffix => String(suffix).replace(/(_\d+)$/, '');

// dropdown value / stored value -> canonical key, or null when it is empty or has no usable name
function toKey(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > 255) return null;
  let type = 'batch', name = t;
  if (/^group:/i.test(t)) { type = 'group'; name = t.slice(6); }
  else if (/^batch:/i.test(t)) { name = t.slice(6); }
  name = sanitize(name);
  return name ? `${type}:${name}` : null;
}

function parse(key) {
  const m = /^(group|batch):([a-z0-9_]+)$/.exec(String(key || ''));
  return m ? { type: m[1], name: m[2] } : null;
}

// the batch suffixes (from `allSuffixes`, e.g. every fhir_patient_<suffix> table) that a key covers
function suffixes(key, allSuffixes) {
  const p = parse(key);
  if (!p) return [];
  const all = (allSuffixes || []).map(s => String(s).toLowerCase());
  return p.type === 'batch' ? all.filter(s => s === p.name) : all.filter(s => baseOf(s) === p.name);
}

const exists = (key, allSuffixes) => suffixes(key, allSuffixes).length > 0;

// canonical key -> value of the Population / Batch dropdown (batch keys are a bare suffix there)
const toOption = key => { const p = parse(key); return !p ? '' : p.type === 'group' ? `group:${p.name}` : p.name; };

// Which stored population keys stop existing when `suffixesToDrop` disappear, given every suffix that exists now?
//  - a batch key dies with its batch
//  - a group key dies only when none of its batches is left
function keysLostBy(suffixesToDrop, allSuffixes, storedKeys) {
  const drop = new Set((suffixesToDrop || []).map(s => String(s).toLowerCase()));
  const left = (allSuffixes || []).map(s => String(s).toLowerCase()).filter(s => !drop.has(s));
  return (storedKeys || []).filter(k => { const p = parse(k); return p && !exists(k, left) && exists(k, allSuffixes); });
}

module.exports = { sanitize, baseOf, toKey, parse, suffixes, exists, toOption, keysLostBy };

module.exports.selftest = () => {
  const assert = require('assert');
  assert.strictEqual(toKey('group:Demo'), 'group:demo');
  assert.strictEqual(toKey('demo_1'), 'batch:demo_1');
  assert.strictEqual(toKey('batch:Demo 1'), 'batch:demo_1');
  assert.strictEqual(toKey(''), null); assert.strictEqual(toKey('   '), null); assert.strictEqual(toKey(null), null);
  assert.strictEqual(toKey('group:'), null); assert.strictEqual(toKey('x'.repeat(256)), null);
  assert.strictEqual(toKey("a'; DROP TABLE x;--"), 'batch:a___drop_table_x');   // never usable as SQL text
  assert.deepStrictEqual(parse('group:demo'), { type: 'group', name: 'demo' });
  assert.strictEqual(parse('demo'), null); assert.strictEqual(parse('group:a b'), null);
  const all = ['a_1', 'a_2', 'ab_1', 'a', 'b'];
  assert.deepStrictEqual(suffixes('group:a', all), ['a_1', 'a_2', 'a']);          // does NOT match ab_1
  assert.deepStrictEqual(suffixes('batch:a_1', all), ['a_1']);
  assert.deepStrictEqual(suffixes('batch:zzz', all), []); assert.deepStrictEqual(suffixes(null, all), []);
  assert.ok(exists('group:ab', all) && !exists('group:abc', all));
  assert.strictEqual(toOption('group:a'), 'group:a'); assert.strictEqual(toOption('batch:a_1'), 'a_1');
  const keys = ['group:a', 'batch:a_1', 'batch:b', 'group:ab', 'batch:gone'];
  assert.deepStrictEqual(keysLostBy(['a_1'], all, keys).sort(), ['batch:a_1']);                       // group a keeps a_2 / a
  assert.deepStrictEqual(keysLostBy(['a_1', 'a_2', 'a'], all, keys).sort(), ['batch:a_1', 'group:a']); // last member gone
  assert.deepStrictEqual(keysLostBy(['b'], all, keys), ['batch:b']);
  console.log('population.js self-test: all checks passed');
};
if (require.main === module && process.argv.includes('--selftest')) module.exports.selftest();
