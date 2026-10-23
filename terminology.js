// Shared clinical terminology used by the synthetic generator (synthetic.js)
// and the analytics catalog (analytics.js).
//
// NOTE: codes are representative demo codes. Verify against a terminology
// server (SNOMED CT / RxNorm / LOINC) before using this for anything beyond demos.
// `terms` are the free-text synonyms the V1 (text matching) analytics search for.

const SYSTEMS = {
  snomed: 'http://snomed.info/sct',
  loinc: 'http://loinc.org',
  rxnorm: 'http://www.nlm.nih.gov/research/umls/rxnorm',
  cvx: 'http://hl7.org/fhir/sid/cvx'
};

// ---- Conditions (SNOMED CT) ----
const CONDITIONS = {
  diabetes:     { code: '44054006',  display: 'Diabetes mellitus type 2',        chronic: true,  terms: ['diabetes', 't2dm', 'dm2', 'type 2 dm', 'diabetic', 'sugar diabetes'] },
  hypertension: { code: '38341003',  display: 'Hypertensive disorder',           chronic: true,  terms: ['hypertension', 'htn', 'high blood pressure', 'elevated bp'] },
  hyperlipidemia:{ code: '55822004', display: 'Hyperlipidemia',                  chronic: true,  terms: ['hyperlipidemia', 'dyslipidemia', 'high cholesterol'] },
  obesity:      { code: '414916001', display: 'Obesity',                         chronic: true,  terms: ['obesity', 'obese'] },
  ckd:          { code: '709044004', display: 'Chronic kidney disease',          chronic: true,  terms: ['chronic kidney disease', 'ckd', 'renal insufficiency'] },
  asthma:       { code: '195967001', display: 'Asthma',                          chronic: true,  terms: ['asthma', 'reactive airway'] },
  copd:         { code: '13645005',  display: 'Chronic obstructive lung disease',chronic: true,  terms: ['copd', 'chronic obstructive', 'emphysema'] },
  cad:          { code: '53741008',  display: 'Coronary arteriosclerosis',       chronic: true,  terms: ['coronary artery disease', 'cad', 'coronary heart disease', 'ischemic heart'] },
  heart_failure:{ code: '84114007',  display: 'Heart failure',                   chronic: true,  terms: ['heart failure', 'chf'] },
  afib:         { code: '49436004',  display: 'Atrial fibrillation',             chronic: true,  terms: ['atrial fibrillation', 'afib', 'a-fib'] },
  stroke:       { code: '230690007', display: 'Cerebrovascular accident',        chronic: true,  terms: ['stroke', 'cva', 'cerebrovascular'] },
  depression:   { code: '35489007',  display: 'Depressive disorder',             chronic: true,  terms: ['depression', 'depressive', 'mdd'] },
  osteoporosis: { code: '64859006',  display: 'Osteoporosis',                    chronic: true,  terms: ['osteoporosis'] },
  anemia:       { code: '271737000', display: 'Anemia',                          chronic: true,  terms: ['anemia', 'anaemia'] },
  breast_cancer:{ code: '254837009', display: 'Malignant neoplasm of breast',    chronic: true,  terms: ['breast cancer', 'breast carcinoma'] },
  colorectal_cancer:{ code: '363406005', display: 'Malignant tumor of colon',    chronic: true,  terms: ['colon cancer', 'colorectal cancer', 'colon carcinoma'] },
  pneumonia:    { code: '233604007', display: 'Pneumonia',                       chronic: false, terms: ['pneumonia'] },
  uti:          { code: '68566005',  display: 'Urinary tract infectious disease',chronic: false, terms: ['urinary tract infection', 'uti'] }
};

// ---- Medications (RxNorm) ----
const MEDICATIONS = {
  metformin:     { code: '861007',  display: 'Metformin 500 MG Oral Tablet',        terms: ['metformin', 'glucophage'] },
  insulin_glargine:{ code: '311041',display: 'Insulin glargine 100 UNT/ML Injectable',terms: ['insulin', 'glargine', 'lantus'] },
  lisinopril:    { code: '314077',  display: 'Lisinopril 10 MG Oral Tablet',        terms: ['lisinopril', 'zestril'] },
  amlodipine:    { code: '197361',  display: 'Amlodipine 5 MG Oral Tablet',         terms: ['amlodipine', 'norvasc'] },
  losartan:      { code: '979492',  display: 'Losartan Potassium 50 MG Oral Tablet',terms: ['losartan', 'cozaar'] },
  atorvastatin:  { code: '617310',  display: 'Atorvastatin 20 MG Oral Tablet',      terms: ['atorvastatin', 'lipitor'] },
  albuterol:     { code: '745752',  display: 'Albuterol 0.09 MG/ACTUAT Inhaler',    terms: ['albuterol', 'salbutamol', 'ventolin'] },
  sertraline:    { code: '312938',  display: 'Sertraline 50 MG Oral Tablet',        terms: ['sertraline', 'zoloft'] },
  aspirin:       { code: '243670',  display: 'Aspirin 81 MG Oral Tablet',           terms: ['aspirin', 'asa 81'] },
  clopidogrel:   { code: '309362',  display: 'Clopidogrel 75 MG Oral Tablet',       terms: ['clopidogrel', 'plavix'] },
  furosemide:    { code: '310429',  display: 'Furosemide 40 MG Oral Tablet',        terms: ['furosemide', 'lasix'] },
  warfarin:      { code: '855332',  display: 'Warfarin Sodium 5 MG Oral Tablet',    terms: ['warfarin', 'coumadin'] },
  apixaban:      { code: '1364430', display: 'Apixaban 5 MG Oral Tablet',           terms: ['apixaban', 'eliquis'] },
  amoxicillin:   { code: '308191',  display: 'Amoxicillin 500 MG Oral Capsule',     terms: ['amoxicillin', 'amoxil'] }
};

// ---- Labs & vitals (LOINC). dir = which direction is abnormal, thr = threshold ----
const LABS = {
  hba1c: { code: '4548-4',  display: 'Hemoglobin A1c',            unit: '%',      dir: 'high', thr: 6.5, terms: ['hba1c', 'a1c', 'glycated hemoglobin', 'hemoglobin a1c'] },
  sbp:   { code: '8480-6',  display: 'Systolic blood pressure',   unit: 'mm[Hg]', dir: 'high', thr: 140, terms: ['systolic'] },
  dbp:   { code: '8462-4',  display: 'Diastolic blood pressure',  unit: 'mm[Hg]', dir: 'high', thr: 90,  terms: ['diastolic'] },
  bmi:   { code: '39156-5', display: 'Body mass index',           unit: 'kg/m2',  dir: 'high', thr: 30,  terms: ['bmi', 'body mass index'] },
  glucose:{ code: '2339-0', display: 'Glucose [Mass/volume] in Blood', unit: 'mg/dL', dir: 'high', thr: 126, terms: ['glucose', 'blood sugar'] },
  ldl:   { code: '18262-6', display: 'LDL cholesterol',           unit: 'mg/dL',  dir: 'high', thr: 130, terms: ['ldl'] },
  hdl:   { code: '2085-9',  display: 'HDL cholesterol',           unit: 'mg/dL',  dir: 'low',  thr: 40,  terms: ['hdl'] },
  tchol: { code: '2093-3',  display: 'Total cholesterol',         unit: 'mg/dL',  dir: 'high', thr: 200, terms: ['total cholesterol'] },
  tg:    { code: '2571-8',  display: 'Triglycerides',             unit: 'mg/dL',  dir: 'high', thr: 150, terms: ['triglyceride'] },
  creatinine:{ code: '38483-4', display: 'Creatinine',            unit: 'mg/dL',  dir: 'high', thr: 1.3, terms: ['creatinine'] },
  egfr:  { code: '33914-3', display: 'eGFR',                      unit: 'mL/min/{1.73_m2}', dir: 'low', thr: 60, terms: ['egfr', 'glomerular filtration'] },
  hr:    { code: '8867-4',  display: 'Heart rate',                unit: '/min',   dir: 'high', thr: 100, terms: ['heart rate', 'pulse'] },
  weight:{ code: '29463-7', display: 'Body weight',               unit: 'kg',     dir: null,   thr: null, terms: ['body weight', 'weight'] },
  spo2:  { code: '59408-5', display: 'Oxygen saturation',         unit: '%',      dir: 'low',  thr: 92,  terms: ['oxygen saturation', 'spo2'] }
};

// ---- Procedures (SNOMED CT) ----
const PROCEDURES = {
  colonoscopy:  { code: '73761001',  display: 'Colonoscopy',               terms: ['colonoscopy'] },
  mammography:  { code: '71651007',  display: 'Mammography',               terms: ['mammogram', 'mammography'] },
  ecg:          { code: '29303009',  display: 'Electrocardiographic procedure', terms: ['ecg', 'ekg', 'electrocardiogram'] },
  chest_xray:   { code: '399208008', display: 'Plain chest X-ray',         terms: ['chest x-ray', 'chest xray', 'cxr'] },
  angiography:  { code: '33367005',  display: 'Coronary angiography',      terms: ['angiography', 'angiogram', 'cath'] },
  dialysis:     { code: '108241001', display: 'Dialysis procedure',        terms: ['dialysis', 'hemodialysis'] }
};

// ---- Allergens (SNOMED CT substances) and reactions ----
const ALLERGENS = {
  penicillin:  { code: '764146007', display: 'Penicillin',  terms: ['penicillin'] },
  peanut:      { code: '762952008', display: 'Peanut',      terms: ['peanut'] },
  latex:       { code: '111088007', display: 'Latex',       terms: ['latex'] },
  sulfonamide: { code: '387406002', display: 'Sulfonamide', terms: ['sulfa', 'sulfonamide'] },
  shellfish:   { code: '735029006', display: 'Shellfish',   terms: ['shellfish'] }
};
const REACTIONS = {
  rash:        { code: '271807003', display: 'Skin rash' },
  hives:       { code: '247472004', display: 'Hives' },
  anaphylaxis: { code: '39579001',  display: 'Anaphylaxis' },
  nausea:      { code: '422587007', display: 'Nausea' }
};

// ---- Immunizations (CVX). Representative demo codes: verify against the CDC CVX table before real use ----
const IMMUNIZATIONS = {
  influenza: { code: '140', display: 'Influenza, seasonal, injectable, preservative free', terms: ['influenza vaccine', 'flu shot', 'flu vaccine'], doses: 'annual' },
  tdap:      { code: '115', display: 'Tdap (tetanus, diphtheria, acellular pertussis)',     terms: ['tdap', 'tetanus', 'td booster'],               doses: 'every 10 years' },
  covid19:   { code: '208', display: 'COVID-19 mRNA vaccine, 30 mcg/0.3 mL',               terms: ['covid-19 vaccine', 'covid vaccine', 'sars-cov-2 vaccine'], doses: '2-dose series plus boosters' }
};

// Which medications are expected first-line treatment for each condition (treatment-pattern analytics)
const TREATMENT_MAP = {
  diabetes: ['metformin', 'insulin_glargine'],
  hypertension: ['lisinopril', 'amlodipine', 'losartan'],
  hyperlipidemia: ['atorvastatin'],
  asthma: ['albuterol'],
  depression: ['sertraline'],
  heart_failure: ['furosemide', 'lisinopril'],
  cad: ['aspirin', 'clopidogrel', 'atorvastatin'],
  afib: ['warfarin', 'apixaban'],
  stroke: ['aspirin', 'clopidogrel'],
  pneumonia: ['amoxicillin'],
  uti: ['amoxicillin']
};

// Known risky co-prescriptions (RxNorm codes) used by polypharmacy analytics
const RISKY_PAIRS = [
  { a: 'warfarin', b: 'aspirin',    note: 'Bleeding risk (anticoagulant + antiplatelet)' },
  { a: 'warfarin', b: 'clopidogrel',note: 'Bleeding risk (anticoagulant + antiplatelet)' },
  { a: 'apixaban', b: 'aspirin',    note: 'Bleeding risk (anticoagulant + antiplatelet)' },
  { a: 'lisinopril', b: 'losartan', note: 'Dual RAAS blockade (ACE inhibitor + ARB)' }
];

// Chronic-disease-control measures (quality-style)
const CONTROL_MEASURES = {
  diabetes_hba1c: { label: 'Diabetes: HbA1c < 7%',        condition: 'diabetes',       lab: 'hba1c', goalBelow: 7,   poorAtOrAbove: 9 },
  htn_bp:         { label: 'Hypertension: systolic < 140', condition: 'hypertension',   lab: 'sbp',   goalBelow: 140, poorAtOrAbove: 160 },
  lipids_ldl:     { label: 'Hyperlipidemia: LDL < 100',   condition: 'hyperlipidemia', lab: 'ldl',   goalBelow: 100, poorAtOrAbove: 160 }
};

// Preventive screening programs
const SCREENINGS = {
  mammogram:   { label: 'Mammography (women 50-74, every 2 years)', proc: 'mammography', gender: 'female', minAge: 50, maxAge: 74, windowYears: 2 },
  colonoscopy: { label: 'Colonoscopy (age 45-75, every 10 years)',  proc: 'colonoscopy', gender: null,     minAge: 45, maxAge: 75, windowYears: 10 }
};

// ---- Relations (knowledge graph, light version) ----
// Directed links between concept keys, built from the dictionaries above plus a few hand-written demo links.
//   type 'treated_by'    condition -> medication         (from TREATMENT_MAP, earlier drug = earlier line; `line` = 1, 2, ...)
//   type 'monitored_by'  condition -> lab                (from CONTROL_MEASURES)
//   type 'interacts_with' medication -> medication       (from RISKY_PAIRS; `note` carries the reason; treat as two-way)
//   type 'screened_by'   condition -> procedure          (hand-written, matches SCREENINGS)
//   type 'leads_to'      condition -> condition          (hand-written demo links; NOT a clinical reference)
// `source` says where a link came from, so later steps can tell derived links from hand-written ones.
const CONCEPT_KIND = {};
for (const [kind, dict] of [['condition', CONDITIONS], ['medication', MEDICATIONS], ['lab', LABS], ['procedure', PROCEDURES]]) {
  for (const key of Object.keys(dict)) {
    if (Object.hasOwn(CONCEPT_KIND, key)) throw new Error(`terminology: key "${key}" is used by two concept kinds`);
    CONCEPT_KIND[key] = kind;
  }
}
const RELATIONS = [];
const addRel = (from, to, type, source, extra) => {
  if (!Object.hasOwn(CONCEPT_KIND, from) || !Object.hasOwn(CONCEPT_KIND, to)) throw new Error(`terminology: bad relation ${from} -> ${to}`);
  if (RELATIONS.some(r => r.from === from && r.to === to && r.type === type)) return;
  RELATIONS.push(Object.assign({ from, to, type, source }, extra || {}));
};
for (const [cond, drugs] of Object.entries(TREATMENT_MAP)) drugs.forEach((drug, i) => addRel(cond, drug, 'treated_by', 'treatment_map', { line: i + 1 }));
for (const m of Object.values(CONTROL_MEASURES)) addRel(m.condition, m.lab, 'monitored_by', 'control_measures');
for (const p of RISKY_PAIRS) addRel(p.a, p.b, 'interacts_with', 'risky_pairs', { note: p.note });
[['breast_cancer', 'mammography'], ['colorectal_cancer', 'colonoscopy']].forEach(([c, pr]) => addRel(c, pr, 'screened_by', 'demo'));
[['obesity', 'diabetes'], ['diabetes', 'ckd'], ['diabetes', 'hypertension'], ['diabetes', 'cad'], ['hypertension', 'ckd'], ['hypertension', 'stroke'],
 ['hypertension', 'heart_failure'], ['cad', 'heart_failure'], ['afib', 'stroke'], ['ckd', 'anemia']].forEach(([a, b]) => addRel(a, b, 'leads_to', 'demo'));

// V1 text matching should also recognise the standard display names (e.g. "Hypertensive disorder"),
// not only the lay synonyms listed above.
for (const dict of [CONDITIONS, MEDICATIONS, LABS, PROCEDURES, ALLERGENS, IMMUNIZATIONS]) {
  for (const d of Object.values(dict)) { const disp = d.display.toLowerCase(); if (!d.terms.includes(disp)) d.terms.push(disp); }
}


// ======================================================================
// SECTION: knowledge graph over RELATIONS (Step 6.2; was graph.js). Exported as `graph`.
// Light knowledge graph over terminology.js RELATIONS (Step 6.2). Plain adjacency maps, no library.
//   neighbors(key, opts)   direct links of a concept
//   path(a, b, opts)       shortest chain of links (BFS), or null when none
//   expand(key, opts)      concepts reachable within `depth` hops (the start concept is not included)
// Keys are the dictionary keys used in terminology.js ('diabetes', 'metformin', ...), not codes.
// opts.types : array of relation types to follow (default: all). opts.direction : 'out' | 'in' | 'both' (default 'both').
// 'interacts_with' is two-way by nature, so it is followed in both directions whatever `direction` says.
// Every result link looks like { key, kind, type, direction, source, line?, note? }:
//   direction 'out' = the start concept points at `key`; 'in' = `key` points at the start concept.
// Self-test (no database): node terminology.js --selftest
// ======================================================================
const graph = (() => {
const T = { RELATIONS, CONCEPT_KIND };

const TWO_WAY = new Set(['interacts_with']);
const out = new Map(), inn = new Map();   // key -> [{ other, rel }]
const add = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
for (const rel of T.RELATIONS) { add(out, rel.from, { other: rel.to, rel }); add(inn, rel.to, { other: rel.from, rel }); }

const has = key => Object.hasOwn(T.CONCEPT_KIND, key);
function need(key) { if (!has(key)) throw new Error(`graph: unknown concept "${key}"`); }
function typesOf(opts) {
  const t = opts && opts.types;
  if (t === undefined || t === null) return null;
  if (!Array.isArray(t)) throw new Error('graph: types must be an array');
  return new Set(t);
}
function dirOf(opts) {
  const d = (opts && opts.direction) || 'both';
  if (!['out', 'in', 'both'].includes(d)) throw new Error('graph: direction must be out, in or both');
  return d;
}
const link = (other, rel, direction) => {
  const o = { key: other, kind: T.CONCEPT_KIND[other], type: rel.type, direction, source: rel.source };
  if (rel.line !== undefined) o.line = rel.line;
  if (rel.note !== undefined) o.note = rel.note;
  return o;
};

function neighbors(key, opts) {
  need(key);
  const types = typesOf(opts), dir = dirOf(opts), res = [];
  const take = (list, direction) => { for (const { other, rel } of list || []) if (!types || types.has(rel.type)) res.push(link(other, rel, direction)); };
  if (dir !== 'in') take(out.get(key), 'out');
  if (dir !== 'out') take(inn.get(key), 'in');
  if (dir === 'out') for (const { other, rel } of inn.get(key) || []) if (TWO_WAY.has(rel.type) && (!types || types.has(rel.type))) res.push(link(other, rel, 'in'));
  if (dir === 'in') for (const { other, rel } of out.get(key) || []) if (TWO_WAY.has(rel.type) && (!types || types.has(rel.type))) res.push(link(other, rel, 'out'));
  return res;
}

// Breadth-first search. Returns [] when a === b, null when no chain exists within maxDepth (default 6),
// otherwise an array of steps { from, to, type, direction, source } from a to b.
function path(a, b, opts) {
  need(a); need(b);
  if (a === b) return [];
  const maxDepth = opts && opts.maxDepth !== undefined ? opts.maxDepth : 6;
  if (!Number.isInteger(maxDepth) || maxDepth < 1) throw new Error('graph: maxDepth must be a whole number of 1 or more');
  const prev = new Map([[a, null]]);
  let frontier = [a];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next = [];
    for (const k of frontier) for (const n of neighbors(k, opts)) {
      if (prev.has(n.key)) continue;
      prev.set(n.key, { from: k, n });
      if (n.key === b) {
        const steps = [];
        for (let cur = b; prev.get(cur); cur = prev.get(cur).from) { const { from, n: x } = prev.get(cur); steps.unshift({ from, to: x.key, type: x.type, direction: x.direction, source: x.source }); }
        return steps;
      }
      next.push(n.key);
    }
    frontier = next;
  }
  return null;
}

// Concepts within `depth` hops (default 1), nearest first, each once, with the first link that reached it.
// opts.kinds (array of 'condition' | 'medication' | 'lab' | 'procedure') keeps only those kinds in the result
// (the walk still passes through other kinds).
function expand(key, opts) {
  need(key);
  const depth = opts && opts.depth !== undefined ? opts.depth : 1;
  if (!Number.isInteger(depth) || depth < 1 || depth > 6) throw new Error('graph: depth must be a whole number from 1 to 6');
  const kinds = opts && opts.kinds ? new Set(opts.kinds) : null;
  const seen = new Map([[key, 0]]), res = [];
  let frontier = [key];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next = [];
    for (const k of frontier) for (const n of neighbors(k, opts)) {
      if (seen.has(n.key)) continue;
      seen.set(n.key, d); next.push(n.key);
      if (!kinds || kinds.has(n.kind)) res.push({ key: n.key, kind: n.kind, depth: d, via: k, type: n.type, direction: n.direction });
    }
    frontier = next;
  }
  return res;
}

return { has, neighbors, path, expand };
})();

module.exports = { SYSTEMS, CONDITIONS, MEDICATIONS, LABS, PROCEDURES, ALLERGENS, IMMUNIZATIONS, REACTIONS, TREATMENT_MAP, RISKY_PAIRS, CONTROL_MEASURES, SCREENINGS, CONCEPT_KIND, RELATIONS, graph };

// ---------------------------------------------------------------- self-test (graph)
if (require.main === module && process.argv.includes('--selftest')) {
  const { has, neighbors, path, expand } = graph, T = module.exports;
  const assert = require('assert');
  const keys = r => r.map(x => x.key).sort();
  // neighbors
  const dm = neighbors('diabetes');
  assert.deepStrictEqual(keys(neighbors('diabetes', { types: ['treated_by'] })), ['insulin_glargine', 'metformin']);
  assert.strictEqual(neighbors('diabetes', { types: ['treated_by'] }).find(x => x.key === 'metformin').line, 1);
  assert.strictEqual(neighbors('diabetes', { types: ['treated_by'] }).find(x => x.key === 'insulin_glargine').line, 2);
  assert.deepStrictEqual(keys(neighbors('diabetes', { types: ['leads_to'], direction: 'out' })), ['cad', 'ckd', 'hypertension']);
  assert.deepStrictEqual(keys(neighbors('diabetes', { types: ['leads_to'], direction: 'in' })), ['obesity']);
  assert.ok(dm.some(x => x.key === 'hba1c' && x.type === 'monitored_by' && x.kind === 'lab'));
  assert.deepStrictEqual(neighbors('warfarin', { types: ['interacts_with'], direction: 'out' }).map(x => x.key).sort(), ['aspirin', 'clopidogrel']);
  const asp = neighbors('aspirin', { types: ['interacts_with'], direction: 'out' }).map(x => x.key).sort();   // two-way: warfarin and apixaban point at aspirin
  assert.deepStrictEqual(asp, ['apixaban', 'warfarin']);
  assert.ok(neighbors('warfarin', { types: ['interacts_with'] }).every(x => x.note));
  assert.deepStrictEqual(neighbors('metformin', { types: ['leads_to'] }), []);
  assert.deepStrictEqual(neighbors('mammography', { direction: 'in' }).map(x => x.key), ['breast_cancer']);
  // every relation is reachable from both ends
  for (const r of T.RELATIONS) {
    assert.ok(neighbors(r.from, { types: [r.type], direction: 'out' }).some(x => x.key === r.to), `${r.from}->${r.to}`);
    assert.ok(neighbors(r.to, { types: [r.type], direction: 'in' }).some(x => x.key === r.from), `${r.to}<-${r.from}`);
  }
  // path
  assert.deepStrictEqual(path('diabetes', 'diabetes'), []);
  const p1 = path('obesity', 'ckd');
  assert.ok(p1 && p1.length === 2 && p1[0].from === 'obesity' && p1[1].to === 'ckd');
  for (let i = 1; i < p1.length; i++) assert.strictEqual(p1[i].from, p1[i - 1].to);
  assert.strictEqual(path('obesity', 'stroke').length, 3);   // obesity -> diabetes -> hypertension -> stroke (3 hops)
  assert.strictEqual(path('obesity', 'metformin').length, 2);
  assert.strictEqual(path('metformin', 'obesity', { types: ['leads_to'] }), null);
  assert.strictEqual(path('obesity', 'stroke', { maxDepth: 2 }), null);
  assert.strictEqual(path('stroke', 'obesity').length, 3);   // walks the links backwards
  assert.strictEqual(path('stroke', 'obesity', { direction: 'out' }), null);
  assert.strictEqual(path('asthma', 'diabetes'), null);   // asthma only links to albuterol: no chain
  // expand
  assert.deepStrictEqual(keys(expand('ckd', { types: ['leads_to'], direction: 'out' })), ['anemia']);
  const e1 = expand('diabetes', { types: ['leads_to'], direction: 'out', depth: 2 });
  assert.deepStrictEqual(keys(e1), ['cad', 'ckd', 'anemia', 'heart_failure', 'hypertension', 'stroke'].sort());
  assert.ok(e1.every(x => !['diabetes'].includes(x.key)), 'start concept is not returned');
  assert.ok(e1.filter(x => x.depth === 1).length === 3 && e1.filter(x => x.depth === 2).length === 3);
  assert.deepStrictEqual(keys(expand('diabetes', { kinds: ['medication'] })), ['insulin_glargine', 'metformin']);
  assert.strictEqual(new Set(expand('hypertension', { depth: 3 }).map(x => x.key)).size, expand('hypertension', { depth: 3 }).length, 'each concept once');
  // errors
  for (const f of [() => neighbors('nope'), () => path('diabetes', 'nope'), () => expand('nope'), () => neighbors('diabetes', { types: 'treated_by' }),
    () => neighbors('diabetes', { direction: 'sideways' }), () => expand('diabetes', { depth: 0 }), () => expand('diabetes', { depth: 2.5 }), () => path('diabetes', 'ckd', { maxDepth: 0 }),
    () => neighbors('__proto__'), () => neighbors('constructor')]) assert.throws(f, /graph:/);
  console.log('terminology.js (graph) self-test: all checks passed');
}
