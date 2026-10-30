// knowledge.js: terminology, SNOMED query builder, cohort knowledge graph and the FHIR server connector, in one file
// (replaces terminology.js, snomed-query.js, kg-cohort.js, fhir-connect.js).
//
// Sections (search for "SECTION:"):
//   terminology   demo code dictionary, relations and the graph helpers (data only, no routes)
//   snomedQuery   Build SNOMED CT Query:  /api/snomed/*
//   kgCohort      Cohort knowledge graph: GET /api/kg/cohort
//   fhirConnect   Fetch from a FHIR server into a batch (Analytics tab)
//
// Wiring: server.js requires snomedQuery and fhirConnect; analytics.js requires kgCohort; everything else requires terminology.
// Each section is wrapped in its own function, so helper names never clash between sections.
// Self-test of every section (no database, no network):  node knowledge.js --selftest

const __s = {};   // sections of this file, by name (so a section can reach another one without any local name hiding it)

// ======================================================================
// SECTION: Terminology: codes, relations and graph helpers  (was terminology.js)
// ======================================================================
const terminology = (() => {
const module = { exports: {} };
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
// Self-test (no database): node knowledge.js --selftest
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
module.exports.selftest = () => {
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
};
return module.exports;
})();
__s.terminology = terminology;

// ======================================================================
// SECTION: SNOMED CT query builder  (was snomed-query.js)
// ======================================================================
const snomedQuery = (() => {
const module = { exports: {} };
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
// Self-test (no database): node knowledge.js --selftest

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
  // No inline /* ... */ note: cohort criteria may not contain SQL comments (security.js refuses them, so a cohort saved with one
  // could never run). The rule labels are already written as -- comments in the full query header.
  const d = DOMAINS[domainKey], note = '';
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
module.exports.selftest = () => {
  const assert = require('assert');
  const t = module.exports._test;
  assert.strictEqual(t.lit("O'Neil"), "'O''Neil'");
  assert.strictEqual(t.commentSafe('a /* b */ c\nd'), 'a b c d');
  assert.deepStrictEqual(t.parseCsvLine('1,"Heart, failure",2'), ['1', 'Heart, failure', '2']);
  assert.strictEqual(t.predicate('dx', 'include', [], 'x'), 'FALSE');
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
};
return module.exports;
})();
__s.snomedQuery = snomedQuery;

// ======================================================================
// SECTION: Cohort knowledge graph  (was kg-cohort.js)
// ======================================================================
const kgCohort = (() => {
const module = { exports: {} };
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
// Self-test: node knowledge.js --selftest

const T = __s.terminology;

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

      res.json({ success: true, scope: { patients: ctx.patients, cohort: ctx.cohort, population: ctx.population, batches: ctx.suffixes.map(x => x || '(legacy tables)'), asOf: ctx.asOf },
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
module.exports.selftest = () => {
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
};
return module.exports;
})();
__s.kgCohort = kgCohort;

// ======================================================================
// SECTION: FHIR server connector  (was fhir-connect.js)
// ======================================================================
const fhirConnect = (() => {
const module = { exports: {} };
// Connect to any FHIR R4 server and import its data as a batch (backend of the "Connect to a FHIR server" card, Analytics tab).
//
// Works with open servers (HAPI, SMART Health IT, Oracle Health open sandbox) and with servers that need a login:
//   auth types   none | bearer (paste a token) | basic | client_secret (OAuth2 client credentials, e.g. Oracle Health system accounts)
//                | private_key_jwt (SMART Backend Services, e.g. Epic on FHIR "Backend Systems") | headers (custom headers / API keys)
//   patient sources
//                list   Patient?_count=N (+ optional search params, e.g. family=Smith or _lastUpdated=gt2024-01-01)
//                ids    explicit Patient ids (Epic and Oracle Health do not allow an unfiltered patient list)
//                group  members of Group/{id}
//                bulk   FHIR Bulk Data $export (system or Group), the supported route for large pulls from Epic / Oracle Health
//
// Everything goes through the existing POST /api/import-fhir, so a fetch becomes a normal batch for cohorts and analytics.
//
//   GET  /api/ehr/info            presets, resource list, auth types, limits
//   POST /api/ehr/test            { connection }                       check the server (and the login) work
//   POST /api/ehr/fetch           { connection, source, batchId, maxPatients, resources?, queryProfile?, queryOverrides? } -> { jobId }
//   GET  /api/ehr/jobs/:id        progress
//   POST /api/ehr/jobs/:id/cancel
//
//   connection = { baseUrl, auth: { type, token, username, password, clientId, clientSecret, clientAuth: 'basic'|'post',
//                  tokenUrl, scope, alg, kid, privateKey, headers: {Name: value} } }
//   source     = { type, ids, groupId, patientQuery }
//
// Secrets are used only in memory for the duration of the request / job. They are never written to the database,
// logged, or returned by the API.
//
// SAFETY: a production EHR returns REAL patient data that will be stored in your database. Only do that with authorization
// (data use agreement / IRB / BAA) and a properly secured deployment. For demos use the sandboxes (synthetic data).
// Environment: EHR_BASE_URL (default server), EHR_ALLOW_HTTP=1 (allow plain http on a trusted network),
//              EHR_ALLOWED_HOSTS=host1,host2 (restrict outbound hosts), EHR_BULK_TIMEOUT_MIN (default 30).
// Self-test (mock servers, no network): node knowledge.js --selftest

const crypto = require('crypto');

const DEFAULT_BASE = String(process.env.EHR_BASE_URL || 'https://hapi.fhir.org/baseR4').replace(/\/+$/, '');
const ALLOW_HTTP = process.env.EHR_ALLOW_HTTP === '1';
const ALLOWED_HOSTS = (process.env.EHR_ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const BULK_TIMEOUT_MS = (Number(process.env.EHR_BULK_TIMEOUT_MIN) || 30) * 60000;

// Per-patient searches. "strict" is for servers that refuse an Observation search without a category (Epic, Oracle Health).
const DEFAULT_Q = {
  Condition: [{}], Observation: [{}], MedicationRequest: [{ _include: 'MedicationRequest:medication' }],
  Encounter: [{}], Procedure: [{}], AllergyIntolerance: [{}], Immunization: [{}]
};
const STRICT_Q = Object.assign({}, DEFAULT_Q, { Observation: [{ category: 'laboratory' }, { category: 'vital-signs' }], MedicationRequest: [{}] });
const RESOURCES = DEFAULT_Q;
const DEFAULT_RESOURCES = Object.keys(RESOURCES);
const CHUNK = 5000, PAGE_LIMIT = 200, CONCURRENCY = 4, MAX_PATIENTS = 2000;
const ID_RE = /^[A-Za-z0-9\-.]{1,64}$/;
const AUTH_TYPES = ['none', 'bearer', 'basic', 'client_secret', 'private_key_jwt', 'headers'];
const JWT_ALGS = { RS256: 'sha256', RS384: 'sha384', RS512: 'sha512', ES256: 'sha256', ES384: 'sha384', ES512: 'sha512' };

// Starting points for the form. URLs and tenant ids change: check the vendor documentation. The form lets you edit everything.
const PRESETS = [
  { id: 'hapi', name: 'HAPI public test server (open)', baseUrl: 'https://hapi.fhir.org/baseR4', auth: 'none', source: 'list', queryProfile: 'default',
    note: 'Shared synthetic test data. No login.' },
  { id: 'smart-open', name: 'SMART Health IT sandbox (open)', baseUrl: 'https://r4.smarthealthit.org', auth: 'none', source: 'list', queryProfile: 'default',
    note: 'Synthetic (Synthea) patients. No login.' },
  { id: 'oracle-open', name: 'Oracle Health (Cerner) open sandbox', baseUrl: 'https://fhir-open.cerner.com/r4/ec2458f2-1e24-41c8-b71b-0e701af7583d', auth: 'none', source: 'ids',
    queryProfile: 'strict', ids: '12724066', note: 'Open sandbox tenant, read-only, no login. It does not list patients: enter patient ids (12724066 is a documented sandbox patient).' },
  { id: 'oracle-secure', name: 'Oracle Health (Cerner) secured / production tenant', baseUrl: 'https://fhir-ehr.cerner.com/r4/<tenant-id>', auth: 'client_secret', source: 'bulk', queryProfile: 'strict',
    note: 'Register a system account in the Oracle Health developer console, replace <tenant-id>, then enter client id and secret. Token URL is discovered from the server if left empty.' },
  { id: 'epic', name: 'Epic on FHIR (Backend Systems app)', baseUrl: 'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4', auth: 'private_key_jwt', alg: 'RS384', source: 'ids', queryProfile: 'strict',
    note: 'Register a Backend Systems app on fhir.epic.com, upload your public key there, then paste the client id, key id and your PRIVATE key here. Epic does not list all patients: use patient ids, a Group, or Bulk export. Use each customer\'s own FHIR base URL in production.' },
  { id: 'bearer', name: 'Any server with an access token (Medplum, Azure, AWS HealthLake, Google...)', baseUrl: '', auth: 'bearer', source: 'list', queryProfile: 'default',
    note: 'Paste a valid access token. For cloud FHIR stores you can also use "OAuth2 client credentials" with the provider\'s token URL.' },
  { id: 'custom', name: 'Custom server', baseUrl: '', auth: 'none', source: 'list', queryProfile: 'default', note: '' }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
const noteErr = (j, msg) => { if (j.errors.length < 20) j.errors.push(msg); };

// ---- outbound URL guard (this server fetches whatever URL the form contains) -----------------------------------
function guardUrl(raw, what = 'URL') {
  let u; try { u = new URL(raw); } catch (e) { throw httpErr(400, `${what} is not a valid URL`); }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (loopback || ALLOW_HTTP))) throw httpErr(400, `${what} must use https (set EHR_ALLOW_HTTP=1 to allow plain http on a trusted network)`);
  if (/^169\.254\./.test(host) || host === 'metadata.google.internal' || host.startsWith('fe80:')) throw httpErr(400, `${what} points to a blocked address`);
  if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.includes(host)) throw httpErr(403, `${host} is not in EHR_ALLOWED_HOSTS`);
  return u;
}

// ---- auth ---------------------------------------------------------------------------------------------------
function normalizeAuth(a) {
  a = a || {};
  const type = AUTH_TYPES.includes(a.type) ? a.type : 'none', s = k => String(a[k] == null ? '' : a[k]).trim();
  const out = { type, token: s('token').replace(/^Bearer\s+/i, ''), username: s('username'), password: String(a.password || ''), clientId: s('clientId'), clientSecret: String(a.clientSecret || ''),
    clientAuth: a.clientAuth === 'post' ? 'post' : 'basic', tokenUrl: s('tokenUrl'), scope: s('scope'), alg: s('alg') || 'RS384', kid: s('kid'),
    privateKey: String(a.privateKey || '').replace(/\\n/g, '\n').trim(), headers: {} };
  for (const [k, v] of Object.entries(a.headers && typeof a.headers === 'object' ? a.headers : {})) {
    if (!/^[A-Za-z0-9-]{1,60}$/.test(k) || /^(host|content-length|connection|transfer-encoding)$/i.test(k)) throw httpErr(400, `Header name "${k}" is not allowed`);
    out.headers[k] = String(v).replace(/[\r\n]/g, ' ').slice(0, 2000);
  }
  if (type === 'bearer' && !out.token) throw httpErr(400, 'Access token is required');
  if (type === 'basic' && !out.username) throw httpErr(400, 'Username is required');
  if ((type === 'client_secret' || type === 'private_key_jwt') && !out.clientId) throw httpErr(400, 'Client id is required');
  if (type === 'client_secret' && !out.clientSecret) throw httpErr(400, 'Client secret is required');
  if (type === 'private_key_jwt') {
    if (!JWT_ALGS[out.alg]) throw httpErr(400, `Signing algorithm must be one of ${Object.keys(JWT_ALGS).join(', ')}`);
    if (!out.privateKey) throw httpErr(400, 'Private key (PEM) is required');
    try { crypto.createPrivateKey(out.privateKey); } catch (e) { throw httpErr(400, 'Private key is not a valid PEM key (use "-----BEGIN PRIVATE KEY-----" PKCS#8 or RSA / EC PEM)'); }
  }
  if (type === 'headers' && !Object.keys(out.headers).length) throw httpErr(400, 'Add at least one header');
  if (out.tokenUrl) guardUrl(out.tokenUrl, 'Token URL');
  return out;
}

const b64u = x => Buffer.from(x).toString('base64url');
// SMART Backend Services client assertion (RFC 7523): short-lived JWT signed with the app's private key
function signJwt({ clientId, tokenUrl, privateKey, kid, alg }) {
  const header = { alg, typ: 'JWT' }; if (kid) header.kid = kid;
  const now = Math.floor(Date.now() / 1000), payload = { iss: clientId, sub: clientId, aud: tokenUrl, jti: crypto.randomUUID(), iat: now, exp: now + 240 };
  const data = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`, key = crypto.createPrivateKey(privateKey);
  const sig = alg.startsWith('ES') ? crypto.sign(JWT_ALGS[alg], Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }) : crypto.sign(JWT_ALGS[alg], Buffer.from(data), key);
  return `${data}.${b64u(sig)}`;
}

// ---- HTTP client for one connection ---------------------------------------------------------------------------
function makeClient(raw) {
  const c = raw || {};
  const base = String(c.baseUrl || DEFAULT_BASE).trim().replace(/\/+$/, '');
  const baseUrl = guardUrl(base, 'Server URL'), origin = baseUrl.origin;
  const auth = normalizeAuth(c.auth), needsToken = auth.type === 'client_secret' || auth.type === 'private_key_jwt';
  let tok = null, tokExp = 0, pending = null, tokenUrl = auth.tokenUrl;

  async function discoverTokenUrl(signal) {
    const plain = async p => { const r = await fetch(`${base}${p}`, { headers: { Accept: 'application/json' }, signal }); if (!r.ok) throw new Error(String(r.status)); return r.json(); };
    try { const j = await plain('/.well-known/smart-configuration'); if (j.token_endpoint) return j.token_endpoint; } catch (e) { /* try the capability statement */ }
    try {
      const cs = await plain('/metadata?_summary=true');
      const ext = (((cs.rest || [])[0] || {}).security || {}).extension || [];
      const uris = ext.find(x => /oauth-uris$/.test(x.url || ''));
      const t = uris && (uris.extension || []).find(x => x.url === 'token');
      if (t && t.valueUri) return t.valueUri;
    } catch (e) { /* fall through */ }
    throw httpErr(400, 'Could not find the token URL on the server; enter it in "Token URL"');
  }

  async function requestToken(signal) {
    if (!tokenUrl) tokenUrl = await discoverTokenUrl(signal);
    guardUrl(tokenUrl, 'Token URL');
    const body = new URLSearchParams({ grant_type: 'client_credentials' }), headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (auth.scope) body.set('scope', auth.scope);
    if (auth.type === 'private_key_jwt') {
      body.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      body.set('client_assertion', signJwt({ clientId: auth.clientId, tokenUrl, privateKey: auth.privateKey, kid: auth.kid, alg: auth.alg }));
    } else if (auth.clientAuth === 'post') { body.set('client_id', auth.clientId); body.set('client_secret', auth.clientSecret); }
    else headers.Authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(auth.clientId)}:${encodeURIComponent(auth.clientSecret)}`).toString('base64');
    const r = await fetch(tokenUrl, { method: 'POST', headers, body: body.toString(), signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw httpErr(401, `Token request failed (${r.status}): ${j.error_description || j.error || 'no access_token in the answer'}`);
    tok = j.access_token; tokExp = Date.now() + (Number(j.expires_in) || 300) * 1000;
    return tok;
  }
  const getToken = (force, signal) => {
    if (!force && tok && Date.now() < tokExp - 30000) return Promise.resolve(tok);
    if (!pending) pending = requestToken(signal).finally(() => { pending = null; });
    return pending;
  };
  async function authHeaders(force, signal) {
    const h = Object.assign({}, auth.headers);
    if (auth.type === 'bearer') h.Authorization = `Bearer ${auth.token}`;
    else if (auth.type === 'basic') h.Authorization = 'Basic ' + Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
    else if (needsToken) h.Authorization = `Bearer ${await getToken(force, signal)}`;
    return h;
  }

  // GET (or other) with retry on 429 / 5xx and one token refresh on 401. Credentials are only sent to the configured server.
  async function request(url, { signal, accept = 'application/fhir+json', method = 'GET', headers: extra = {}, auth: useAuth } = {}) {
    const u = guardUrl(url, 'URL'), sendAuth = useAuth !== false && u.origin === origin;
    let refreshed = false, force = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (signal && signal.aborted) throw httpErr(499, 'Cancelled');
      const h = Object.assign({ Accept: accept }, extra, sendAuth ? await authHeaders(force, signal) : {});
      force = false;
      const r = await fetch(url, { method, headers: h, signal });
      if (r.ok) return r;
      const drop = () => r.body && r.body.cancel().catch(() => {});
      if (r.status === 401 && needsToken && sendAuth && !refreshed) { refreshed = true; force = true; await drop(); continue; }
      if (r.status === 429 || r.status >= 500) { const ra = Number(r.headers.get('retry-after')); await drop(); await sleep(ra > 0 ? Math.min(ra, 60) * 1000 : 500 * 2 ** attempt); continue; }
      throw httpErr(r.status, `${r.status} on ${url.replace(/\?.*/, '')}: ${(await r.text()).slice(0, 160)}`);
    }
    throw httpErr(502, `Server kept failing on ${url.replace(/\?.*/, '')}`);
  }
  const getJson = async (url, signal) => (await request(url, { signal })).json();
  return { base, host: baseUrl.host, authType: auth.type, request, getJson, getToken };
}

// ---- paging / helpers -----------------------------------------------------------------------------------------
// follow Bundle.link[next], always on the configured server
function sameServer(u, base) {
  if (!/^https?:\/\//i.test(u)) return `${base}/${u.replace(/^\/+/, '')}`;
  const x = new URL(u), bp = new URL(base).pathname.replace(/\/+$/, '');
  const p = bp && x.pathname.startsWith(bp) ? x.pathname.slice(bp.length) : x.pathname;
  return `${base}${p}${x.search}`;
}
async function* pages(firstUrl, client, signal) {
  let url = firstUrl, n = 0;
  while (url && n++ < PAGE_LIMIT) {
    const b = await client.getJson(url, signal); yield b;
    const nx = (b.link || []).find(l => l.relation === 'next'); url = nx ? sameServer(nx.url, client.base) : null;
  }
}

// MedicationRequest often only points to a Medication resource; copy its code so the importer keeps the drug code
function inlineOne(r, meds) {
  if (r.resourceType !== 'MedicationRequest' || r.medicationCodeableConcept || !r.medicationReference) return;
  const ref = String(r.medicationReference.reference || '').replace(/^#/, '').replace(/^Medication\//, '');
  const m = (meds && meds.get(ref)) || (r.contained || []).find(c => c.id === ref);
  if (m && m.code) r.medicationCodeableConcept = m.code;
  else if (r.medicationReference.display) r.medicationCodeableConcept = { text: r.medicationReference.display, coding: [{ display: r.medicationReference.display }] };
}
function inlineMedications(entries) {
  const meds = new Map(entries.filter(e => e.resource.resourceType === 'Medication').map(e => [e.resource.id, e.resource]));
  for (const e of entries) inlineOne(e.resource, meds);
  return entries.filter(e => e.resource.resourceType !== 'Medication');
}
const patientIdOf = r => { const m = String(((r.subject || r.patient || {}).reference) || '').match(/(?:^|\/)Patient\/([^/]+)$/); return m ? m[1] : null; };

// ---- input normalisation --------------------------------------------------------------------------------------
function normalizeSource(s) {
  s = s || {};
  const type = ['list', 'ids', 'group', 'bulk'].includes(s.type) ? s.type : 'list';
  const ids = [...new Set(String(s.ids || '').split(/[\s,;]+/).filter(Boolean))];
  if (ids.some(x => !ID_RE.test(x))) throw httpErr(400, 'Patient ids may only contain letters, digits, - and .');
  const groupId = String(s.groupId || '').trim();
  if (groupId && !ID_RE.test(groupId)) throw httpErr(400, 'Group id may only contain letters, digits, - and .');
  if (type === 'ids' && !ids.length) throw httpErr(400, 'Enter at least one patient id');
  if (type === 'group' && !groupId) throw httpErr(400, 'Enter a group id');
  const pq = String(s.patientQuery || '').trim().replace(/^\?/, '');
  if (pq.length > 300) throw httpErr(400, 'Patient search parameters are too long');
  return { type, ids, groupId, query: Object.fromEntries(new URLSearchParams(pq)) };
}
function buildQueries(profile, overrides) {
  const q = JSON.parse(JSON.stringify(profile === 'strict' ? STRICT_Q : DEFAULT_Q));
  let o = overrides;
  if (typeof o === 'string') { if (!o.trim()) o = null; else try { o = JSON.parse(o); } catch (e) { throw httpErr(400, 'Search overrides are not valid JSON'); } }
  if (o && typeof o === 'object') for (const [t, list] of Object.entries(o)) {
    if (!q[t]) throw httpErr(400, `Unknown resource type in search overrides: ${t}`);
    if (!Array.isArray(list) || list.some(x => !x || typeof x !== 'object' || Object.values(x).some(v => typeof v !== 'string'))) throw httpErr(400, `Search overrides for ${t} must be a list of {"param": "value"} objects`);
    q[t] = list.length ? list : [{}];
  }
  return q;
}

// ---- jobs ---------------------------------------------------------------------------------------------------
const JOBS = new Map();
function newJob(batchId, meta) {
  const j = Object.assign({ id: crypto.randomUUID(), status: 'running', phase: 'starting', batchId, patientsTotal: 0, patientsDone: 0, resources: {}, imported: 0, errors: [], startedAt: Date.now(), finishedAt: null, ctl: new AbortController() }, meta || {});
  JOBS.set(j.id, j); if (JOBS.size > 30) JOBS.delete(JOBS.keys().next().value); return j;
}
const view = j => ({ id: j.id, status: j.status, phase: j.phase, batchId: j.batchId, batchSuffix: j.batchSuffix || null, server: j.server || null, source: j.sourceType || null,
  patientsTotal: j.patientsTotal, patientsDone: j.patientsDone, resources: j.resources, imported: j.imported, errors: j.errors, message: j.message || null,
  seconds: Math.round(((j.finishedAt || Date.now()) - j.startedAt) / 1000) });

// sends resources to /api/import-fhir in chunks, one at a time
function makeFlusher(job, importUrl) {
  let buf = [], chain = Promise.resolve();
  const send = part => { chain = chain.then(async () => {
    job.phase = 'importing';
    const r = await fetch(importUrl, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, job.importHeaders || {}), body: JSON.stringify({ batchId: job.batchId, bundle: { resourceType: 'Bundle', type: 'collection', entry: part } }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) throw httpErr(502, `Import failed: ${j.details || j.error || r.status}`);
    job.batchSuffix = j.batchSuffix; job.imported += part.length; job.phase = 'fetching';
  }); return chain; };
  return {
    async add(entries) { buf.push(...entries); if (buf.length >= CHUNK) { const part = buf; buf = []; await send(part); } },
    async done() { if (buf.length) { const part = buf; buf = []; await send(part); } await chain; }
  };
}

async function findPatients(client, max, signal, query) {
  const out = new Map(), qs = new URLSearchParams(Object.assign({ _count: String(Math.min(max, 100)) }, query || {}));
  for await (const b of pages(`${client.base}/Patient?${qs}`, client, signal)) {
    for (const e of b.entry || []) if (e.resource && e.resource.resourceType === 'Patient' && e.resource.id && out.size < max) out.set(e.resource.id, e.resource);
    if (out.size >= max) break;
  }
  return [...out.values()];
}
async function resolvePatients(job, client, source, max, signal) {
  if (source.type === 'list') return findPatients(client, max, signal, source.query);
  let ids = source.ids;
  if (source.type === 'group') {
    const g = await client.getJson(`${client.base}/Group/${encodeURIComponent(source.groupId)}`, signal);
    ids = (g.member || []).map(m => String(((m.entity || {}).reference) || '').replace(/^Patient\//, '')).filter(x => ID_RE.test(x));
    if (!ids.length) throw httpErr(404, 'The group has no patient members');
  }
  ids = [...new Set(ids)].slice(0, max);
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, async () => {
    while (i < ids.length) {
      const id = ids[i++];
      try { const p = await client.getJson(`${client.base}/Patient/${encodeURIComponent(id)}`, signal); if (p && p.resourceType === 'Patient') out.push(p); }
      catch (e) { if (signal.aborted) return; noteErr(job, `Patient ${id}: ${e.message}`); }
    }
  }));
  return out;
}

// per patient: one search per resource type
async function runPaged(job, { client, resources, maxPatients, source, queries, importUrl }) {
  const signal = job.ctl.signal;
  job.phase = 'finding patients';
  const patients = await resolvePatients(job, client, source, maxPatients, signal);
  if (!patients.length) throw httpErr(404, 'The server returned no patients');
  job.patientsTotal = patients.length; job.resources.Patient = patients.length;
  const fl = makeFlusher(job, importUrl);
  await fl.add(patients.map(p => ({ fullUrl: `Patient/${p.id}`, resource: p })));
  job.phase = 'fetching';
  let idx = 0;
  const worker = async () => {
    while (idx < patients.length) {
      if (signal.aborted) return;
      const p = patients[idx++], mine = [];
      for (const type of resources) for (const extra of queries[type]) {
        const qs = new URLSearchParams(Object.assign({}, extra, { patient: p.id, _count: '100' }));
        try {
          for await (const b of pages(`${client.base}/${type}?${qs}`, client, signal))
            for (const e of b.entry || []) if (e.resource && e.resource.resourceType !== 'OperationOutcome') mine.push({ fullUrl: `${e.resource.resourceType}/${e.resource.id}`, resource: e.resource });
        } catch (e) { if (signal.aborted) return; noteErr(job, `${type} for patient ${p.id}: ${e.message}`); }
      }
      const fixed = inlineMedications(mine);
      for (const e of fixed) job.resources[e.resource.resourceType] = (job.resources[e.resource.resourceType] || 0) + 1;
      job.patientsDone++;
      await fl.add(fixed);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, patients.length) }, worker));
  if (signal.aborted) return;
  await fl.done();
}

// FHIR Bulk Data: kick-off, poll, download NDJSON files, keep the first N patients and only their data
async function* ndjson(res) {
  const dec = new TextDecoder(); let rest = '';
  const parse = line => { try { return JSON.parse(line); } catch (e) { return null; } };
  for await (const chunk of res.body) {
    rest += dec.decode(chunk, { stream: true }); let i;
    while ((i = rest.indexOf('\n')) >= 0) { const line = rest.slice(0, i).trim(); rest = rest.slice(i + 1); const o = line && parse(line); if (o) yield o; }
  }
  const o = rest.trim() && parse(rest.trim()); if (o) yield o;
}
async function runBulk(job, { client, resources, maxPatients, source, importUrl, pollMinMs = 2000 }) {
  const signal = job.ctl.signal;
  const types = ['Patient', ...resources, ...(resources.includes('MedicationRequest') ? ['Medication'] : [])];
  const kick = source.groupId ? `${client.base}/Group/${encodeURIComponent(source.groupId)}/$export` : `${client.base}/Patient/$export`;
  job.phase = 'requesting export';
  const r0 = await client.request(`${kick}?${new URLSearchParams({ _type: types.join(','), _outputFormat: 'application/fhir+ndjson' })}`, { signal, headers: { Prefer: 'respond-async' } });
  const loc = r0.headers.get('content-location'); await (r0.body && r0.body.cancel().catch(() => {}));
  if (!loc) throw httpErr(502, 'The server accepted $export but sent no Content-Location to poll');
  const statusUrl = new URL(loc, client.base + '/').toString();
  let manifest = null;
  try {
    const deadline = Date.now() + BULK_TIMEOUT_MS; let wait = pollMinMs;
    while (!manifest) {
      if (Date.now() > deadline) throw httpErr(504, 'The bulk export did not finish in time (EHR_BULK_TIMEOUT_MIN)');
      await sleep(wait);
      const r = await client.request(statusUrl, { signal, accept: 'application/json' });
      if (r.status === 202) {
        const ra = Number(r.headers.get('retry-after')), pr = r.headers.get('x-progress');
        wait = Math.min(30000, Math.max(pollMinMs, ra > 0 ? ra * 1000 : wait * 1.5)); job.phase = `waiting for the server to prepare the export${pr ? ` (${String(pr).slice(0, 60)})` : ''}`;
        await (r.body && r.body.cancel().catch(() => {}));
      } else manifest = await r.json();
    }
    const rank = t => (t === 'Patient' ? 0 : t === 'Medication' ? 1 : 2);
    const files = (manifest.output || []).filter(o => types.includes(o.type) && o.url).sort((a, b) => rank(a.type) - rank(b.type));
    if (!files.length) throw httpErr(404, 'The export contained no files for the selected resources');
    const keep = new Set(), meds = new Map(), fl = makeFlusher(job, importUrl);
    job.phase = 'downloading';
    for (const f of files) {
      if (signal.aborted) return;
      const res = await client.request(f.url, { signal, accept: 'application/fhir+ndjson' });
      for await (const x of ndjson(res)) {
        if (signal.aborted) return;
        const t = x.resourceType;
        if (t === 'Patient') { if (!x.id || keep.size >= maxPatients) { if (keep.size >= maxPatients) break; continue; } keep.add(x.id); job.patientsTotal = job.patientsDone = keep.size; }
        else if (t === 'Medication') { meds.set(x.id, x); continue; }
        else { const pid = patientIdOf(x); if (!pid || !keep.has(pid)) continue; inlineOne(x, meds); }
        job.resources[t] = (job.resources[t] || 0) + 1;
        await fl.add([{ fullUrl: `${t}/${x.id}`, resource: x }]);
      }
    }
    if (!keep.size) throw httpErr(404, 'The export contained no patients');
    await fl.done();
  } finally {
    client.request(statusUrl, { method: 'DELETE', accept: 'application/json' }).catch(() => {});   // tell the server it can delete the export
  }
}

async function runJob(job, opts) {
  try {
    if (opts.source.type === 'bulk') await runBulk(job, opts); else await runPaged(job, opts);
    if (job.ctl.signal.aborted) { job.status = 'cancelled'; job.message = 'Cancelled. Anything already imported stays in the batch; delete the batch to remove it.'; return; }
    job.status = 'done'; job.phase = 'done';
    job.message = `Imported ${job.imported.toLocaleString()} resources for ${job.patientsDone} patients into batch "${job.batchId}".`;
  } catch (err) {
    job.status = job.ctl.signal.aborted ? 'cancelled' : 'error'; job.message = err.message; noteErr(job, err.message);
  } finally { job.finishedAt = Date.now(); }
}

// ---- Express wiring -----------------------------------------------------------------------------------------
function register(app, pool, { port, importToken }) {
  const json = require('express').json({ limit: '1mb' });
  const fail = (res, err) => res.status(err.status >= 400 && err.status < 600 ? err.status : 500).json({ success: false, error: err.message });

  app.get('/api/ehr/info', (req, res) => res.json({ success: true, baseUrl: DEFAULT_BASE, resources: DEFAULT_RESOURCES, maxPatients: MAX_PATIENTS, presets: PRESETS,
    authTypes: AUTH_TYPES, jwtAlgs: Object.keys(JWT_ALGS), allowHttp: ALLOW_HTTP, allowedHosts: ALLOWED_HOSTS }));

  app.post('/api/ehr/test', json, async (req, res) => {
    try {
      const client = makeClient((req.body || {}).connection);
      if (client.authType === 'client_secret' || client.authType === 'private_key_jwt') await client.getToken(true);
      const cs = await client.getJson(`${client.base}/metadata?_summary=true`);
      let listPatients = true;
      try { await client.getJson(`${client.base}/Patient?_count=1`); } catch (e) { listPatients = false; }
      res.json({ success: true, host: client.host, fhirVersion: cs.fhirVersion || null, software: (cs.software || {}).name || null, authenticated: client.authType !== 'none', listPatients });
    } catch (err) { fail(res, err); }
  });

  app.post('/api/ehr/fetch', json, async (req, res) => {
    try {
      const b = req.body || {}, batchId = String(b.batchId || '').trim();
      if (!/^[A-Za-z0-9_ .-]{1,60}$/.test(batchId)) throw httpErr(400, 'Batch name is required (letters, digits, space, _ . -, up to 60)');
      const resources = (Array.isArray(b.resources) && b.resources.length ? b.resources : DEFAULT_RESOURCES).filter(r => RESOURCES[r]);
      if (!resources.length) throw httpErr(400, 'Pick at least one resource type');
      const maxPatients = Math.min(MAX_PATIENTS, Math.max(1, Math.floor(Number(b.maxPatients) || 25)));
      const client = makeClient(b.connection), source = normalizeSource(b.source), queries = buildQueries(b.queryProfile, b.queryOverrides);
      if ([...JOBS.values()].some(j => j.status === 'running')) throw httpErr(409, 'Another fetch is still running');
      const job = newJob(batchId, { server: client.host, sourceType: source.type });
      if (importToken) Object.defineProperty(job, 'importHeaders', { value: { 'X-Import-Token': importToken }, enumerable: false });   // loopback import passes the server's lock
      runJob(job, { client, resources, maxPatients, source, queries, importUrl: `http://127.0.0.1:${port}/api/import-fhir` });
      res.json({ success: true, jobId: job.id });
    } catch (err) { fail(res, err); }
  });

  app.get('/api/ehr/jobs/:id', (req, res) => { const j = JOBS.get(req.params.id); if (!j) return res.status(404).json({ success: false, error: 'Unknown job' }); res.json({ success: true, job: view(j) }); });
  app.post('/api/ehr/jobs/:id/cancel', (req, res) => { const j = JOBS.get(req.params.id); if (!j) return res.status(404).json({ success: false, error: 'Unknown job' }); j.ctl.abort(); res.json({ success: true }); });
}

module.exports = register;
module.exports.pure = { inlineMedications, sameServer, runJob, newJob, makeClient, normalizeAuth, normalizeSource, buildQueries, signJwt, guardUrl, RESOURCES, DEFAULT_Q, STRICT_Q };

// ---- self-test (mock FHIR servers + token endpoint + import endpoint) -------------------------------------------
module.exports.selftest = () => {
  return (async () => {
    const assert = require('assert'), http = require('http'), imported = [];
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const mk = (type, id, pid, extra) => Object.assign({ resourceType: type, id, subject: { reference: `Patient/${pid}` } }, extra);
    const state = { tokens: 0, deleted: 0, polls: 0, jwtOk: false, secretOk: false };
    let origin = '', dataOrigin = '';
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x'), send = (o, c = 200, h = {}) => { res.writeHead(c, Object.assign({ 'Content-Type': 'application/json' }, h)); res.end(typeof o === 'string' ? o : JSON.stringify(o)); };
      let body = ''; req.on('data', d => body += d); req.on('end', () => {
        if (u.pathname === '/api/import-fhir') { const j = JSON.parse(body); imported.push(...j.bundle.entry); return send({ success: true, batchSuffix: 'b1', batchId: j.batchId }); }
        if (u.pathname === '/token') {
          const f = new URLSearchParams(body);
          if (f.get('client_assertion')) {
            const [h, p, s] = f.get('client_assertion').split('.'), pl = JSON.parse(Buffer.from(p, 'base64url')), hd = JSON.parse(Buffer.from(h, 'base64url'));
            state.jwtOk = crypto.verify('sha384', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')) && pl.iss === 'app1' && pl.sub === 'app1' && pl.aud === `${origin}/token` && hd.kid === 'k1' && hd.alg === 'RS384';
            if (!state.jwtOk) return send({ error: 'invalid_client' }, 401);
          } else { state.secretOk = req.headers.authorization === 'Basic ' + Buffer.from('cid:sec').toString('base64'); if (!state.secretOk) return send({ error: 'invalid_client' }, 401); }
          state.tokens++; return send({ access_token: `tok${state.tokens}`, expires_in: 300 });
        }
        if (u.pathname === '/fhir/.well-known/smart-configuration') return send({ token_endpoint: `${origin}/token` });
        if (!u.pathname.startsWith('/fhir/') && !u.pathname.startsWith('/status/')) return send({}, 404);
        const authz = req.headers.authorization || '';
        if (!/^Bearer tok\d+$/.test(authz) || (state.tokens > 1 && authz !== `Bearer tok${state.tokens}`)) return send({ resourceType: 'OperationOutcome' }, 401);
        if (u.pathname === '/status/1') {
          if (req.method === 'DELETE') { state.deleted++; return send({}, 202); }
          if (++state.polls < 2) return send({}, 202, { 'Retry-After': '0', 'X-Progress': '50%' });
          return send({ output: [{ type: 'Condition', url: `${dataOrigin}/data/condition.ndjson` }, { type: 'MedicationRequest', url: `${dataOrigin}/data/medreq.ndjson` },
            { type: 'Medication', url: `${dataOrigin}/data/med.ndjson` }, { type: 'Patient', url: `${dataOrigin}/data/patient.ndjson` }] });
        }
        if (u.pathname === '/fhir/Patient/$export') return send({}, 202, { 'Content-Location': `${origin}/status/1` });
        if (u.pathname === '/fhir/Group/g1') return send({ resourceType: 'Group', member: [{ entity: { reference: 'Patient/p2' } }, { entity: { reference: 'Patient/p1' } }] });
        const rd = u.pathname.match(/^\/fhir\/Patient\/([^/]+)$/); if (rd) return send({ resourceType: 'Patient', id: rd[1] });
        if (u.pathname === '/fhir/Patient') { const p = u.searchParams.get('page'); return send({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Patient', id: p ? 'p2' : 'p1' } }],
          link: p ? [] : [{ relation: 'next', url: `http://${req.headers.host}/fhir/Patient?page=2` }] }); }
        const pid = u.searchParams.get('patient'), t = u.pathname.replace('/fhir/', '');
        if (t === 'Condition') return send({ resourceType: 'Bundle', entry: [{ resource: mk('Condition', `c-${pid}`, pid, { code: { coding: [{ code: '44054006' }] } }) }] });
        if (t === 'MedicationRequest') return send({ resourceType: 'Bundle', entry: [{ resource: mk('MedicationRequest', `m-${pid}`, pid, { medicationReference: { reference: 'Medication/rx1' } }) },
          { resource: { resourceType: 'Medication', id: 'rx1', code: { coding: [{ code: '860975' }] } } }] });
        if (t === 'Observation') return pid === 'p2' ? send({ resourceType: 'OperationOutcome' }, 400) : send({ resourceType: 'Bundle', entry: [{ resource: mk('Observation', `o-${pid}`, pid) }] });
        return send({ resourceType: 'Bundle', entry: [] });
      });
    });
    const data = {
      'patient.ndjson': ['p1', 'p2', 'p3'].map(id => ({ resourceType: 'Patient', id })),
      'condition.ndjson': ['p1', 'p2', 'p3'].map(id => mk('Condition', `c-${id}`, id, { code: { coding: [{ code: '44054006' }] } })),
      'med.ndjson': [{ resourceType: 'Medication', id: 'rx1', code: { coding: [{ code: '860975' }] } }],
      'medreq.ndjson': ['p1', 'p3'].map(id => mk('MedicationRequest', `m-${id}`, id, { medicationReference: { reference: 'Medication/rx1' } }))
    };
    const seenAuth = [];
    const dataSrv = http.createServer((req, res) => { seenAuth.push(req.headers.authorization || ''); const f = data[req.url.replace('/data/', '')]; if (!f) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': 'application/fhir+ndjson' }); res.end(f.map(o => JSON.stringify(o)).join('\n') + '\n'); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r)); await new Promise(r => dataSrv.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${srv.address().port}`;
    dataOrigin = `http://127.0.0.1:${dataSrv.address().port}`;   // bulk files live on another origin

    // --- pure helpers
    const { sameServer: ss } = module.exports.pure;
    assert.strictEqual(ss('http://other/fhir/Patient?page=2', `${origin}/fhir`), `${origin}/fhir/Patient?page=2`, 'next link stays on the configured server');
    assert.strictEqual(ss('https://r4.example.org/Patient?page=2', 'https://r4.example.org'), 'https://r4.example.org/Patient?page=2', 'server without a path prefix');
    assert.throws(() => guardUrl('http://example.org/fhir'), /https/); assert.throws(() => guardUrl('https://169.254.169.254/x'), /blocked/); guardUrl('http://127.0.0.1:1/x');
    assert.throws(() => normalizeAuth({ type: 'bearer' }), /token/); assert.throws(() => normalizeAuth({ type: 'private_key_jwt', clientId: 'a', privateKey: 'nope' }), /PEM/);
    assert.throws(() => normalizeSource({ type: 'ids', ids: '../x' }), /ids may only/); assert.deepStrictEqual(normalizeSource({ type: 'list', patientQuery: '?family=Smith' }).query, { family: 'Smith' });
    assert.deepStrictEqual(buildQueries('strict').Observation.map(o => o.category), ['laboratory', 'vital-signs']);
    assert.deepStrictEqual(buildQueries('default', '{"Observation":[{"code":"4548-4"}]}').Observation, [{ code: '4548-4' }]); assert.throws(() => buildQueries('default', '{"Nope":[]}'), /Unknown/);

    // --- no credentials -> 401 from the server
    await assert.rejects(makeClient({ baseUrl: `${origin}/fhir` }).getJson(`${origin}/fhir/Patient`), e => e.status === 401);

    // --- private_key_jwt (Epic style) + paged list
    const mkConn = () => ({ baseUrl: `${origin}/fhir`, auth: { type: 'private_key_jwt', clientId: 'app1', kid: 'k1', alg: 'RS384', privateKey: pem } });   // token URL discovered
    let client = makeClient(mkConn()); const list = { type: 'list', ids: [], query: {} }, queries = buildQueries('default');
    let job = newJob('mock batch');
    await runJob(job, { client, resources: ['Condition', 'Observation', 'MedicationRequest'], maxPatients: 10, source: list, queries, importUrl: `${origin}/api/import-fhir` });
    assert.strictEqual(job.status, 'done', job.message); assert.ok(state.jwtOk, 'signed client assertion verified with the public key');
    assert.strictEqual(job.patientsTotal, 2, 'paged patient search followed the next link');
    let types = imported.map(e => e.resource.resourceType);
    assert.strictEqual(types.filter(t => t === 'Patient').length, 2); assert.strictEqual(types.filter(t => t === 'Condition').length, 2);
    assert.strictEqual(types.filter(t => t === 'Observation').length, 1, 'a failing resource search is skipped, not fatal');
    assert.ok(job.errors.some(e => /Observation for patient p2/.test(e)), 'and reported as a warning');
    assert.ok(!types.includes('Medication')); assert.strictEqual(imported.find(e => e.resource.resourceType === 'MedicationRequest').resource.medicationCodeableConcept.coding[0].code, '860975');
    assert.strictEqual(job.batchSuffix, 'b1'); assert.ok(!JSON.stringify(view(job)).includes('BEGIN'), 'job view carries no secrets');

    // --- token refresh on 401 (server rotated its token)
    state.tokens += 1; const before = state.tokens;
    client = makeClient(mkConn()); await client.getJson(`${origin}/fhir/Patient/p1`);
    assert.ok(state.tokens > before, 'token fetched');

    // --- client_secret (Oracle Health style) + ids and group sources
    client = makeClient({ baseUrl: `${origin}/fhir`, auth: { type: 'client_secret', clientId: 'cid', clientSecret: 'sec', tokenUrl: `${origin}/token`, scope: 'system/*.read' } });
    imported.length = 0; job = newJob('ids');
    await runJob(job, { client, resources: ['Condition'], maxPatients: 10, source: normalizeSource({ type: 'ids', ids: 'p1, p2' }), queries, importUrl: `${origin}/api/import-fhir` });
    assert.ok(state.secretOk && job.status === 'done', job.message); assert.strictEqual(job.patientsTotal, 2);
    imported.length = 0; job = newJob('group');
    await runJob(job, { client, resources: ['Condition'], maxPatients: 1, source: normalizeSource({ type: 'group', groupId: 'g1' }), queries, importUrl: `${origin}/api/import-fhir` });
    assert.strictEqual(job.patientsTotal, 1, 'group members limited by maxPatients');

    // --- bulk export: files on another origin (no credentials sent there), patients limited to 2, medications inlined, export deleted afterwards
    imported.length = 0; job = newJob('bulk');
    await runJob(job, { client, resources: ['Condition', 'MedicationRequest'], maxPatients: 2, source: normalizeSource({ type: 'bulk' }), queries, pollMinMs: 5, importUrl: `${origin}/api/import-fhir` });
    assert.strictEqual(job.status, 'done', job.message); assert.strictEqual(job.patientsTotal, 2);
    types = imported.map(e => e.resource.resourceType);
    assert.strictEqual(types.filter(t => t === 'Patient').length, 2); assert.strictEqual(types.filter(t => t === 'Condition').length, 2, 'only the kept patients\' data');
    assert.strictEqual(types.filter(t => t === 'MedicationRequest').length, 1, 'p3 was cut off, p1 kept'); assert.ok(!types.includes('Medication'));
    assert.strictEqual(imported.find(e => e.resource.resourceType === 'MedicationRequest').resource.medicationCodeableConcept.coding[0].code, '860975', 'Medication file inlined');
    assert.ok(seenAuth.length >= 4 && seenAuth.every(a => a === ''), 'credentials are not sent to the other origin');
    await sleep(50); assert.strictEqual(state.deleted, 1, 'export deleted on the server');
    srv.close(); dataSrv.close();
    console.log('fhir-connect.js self-test: all checks passed');
  })().catch(e => { console.error(e); process.exit(1); });
};
return module.exports;
})();
__s.fhirConnect = fhirConnect;

// ======================================================================
// SECTION: Enrichment candidates  (V3 / V5 chunk 10)
// ======================================================================
// POST /api/enrichment/candidates  { domain: 'dx'|'rx'|'ob'|'pr'|'al'|'im', strings: [ ... up to 100 ... ] }
//   -> { domain, results: [ { text_key, status: 'candidates'|'unverified', candidates: [ { system, code, display, score, source, in_data? } ] } ], counts, sources }
// Gives the LLM (and the reviewer) REAL codes to choose from; nothing here invents a code. Only strings come in, only reference data is read.
//   dx, pr   the bundled demo dictionary (terminology), the domain's snomed_dictionary (codes seen in the data) and snomed_concept (loaded hierarchy names)
//   rx, ob, al, im   the bundled demo dictionary (terminology): medications, labs, allergens, immunizations
// A string with no candidate is 'unverified': the proposal step must not pick a code for it.
// snomed_concept has no semantic tag (the "(disorder)" suffix is stripped on load), so a dx / pr string can also match a concept of the other kind; those
// rows are marked source 'snomed_concept' and ranked a little below codes seen in the data.
// Reads only (parameterized queries, no writes). A missing snomed table just means no database candidates.
// Self-test (no database): node knowledge.js --selftest
const enrichCandidates = (() => {
const T = __s.terminology;
const MAX_STRINGS = 100, MAX_LEN = 200, MAX_CANDIDATES = 8, MIN_SCORE = 0.3;
const STOP = new Set(['a', 'an', 'and', 'of', 'the', 'with', 'for', 'in', 'to', 'on', 'at', 'by']);
// words that say little about WHICH concept is meant: dropped from matching unless nothing else is left (so "high bp" is matched on "bp", not on "high")
const GENERIC = new Set(['high', 'low', 'disease', 'disorder', 'chronic', 'acute', 'syndrome', 'unspecified', 'other', 'left', 'right', 'history', 'screening']);
const SOURCES = {   // domain -> bundled dictionary, code system, and whether the SNOMED reference tables apply
  dx: { dict: T.CONDITIONS,     system: T.SYSTEMS.snomed, snomed: true },
  pr: { dict: T.PROCEDURES,     system: T.SYSTEMS.snomed, snomed: true },
  rx: { dict: T.MEDICATIONS,    system: T.SYSTEMS.rxnorm, snomed: false },
  ob: { dict: T.LABS,           system: T.SYSTEMS.loinc,  snomed: false },
  al: { dict: T.ALLERGENS,      system: T.SYSTEMS.snomed, snomed: false },
  im: { dict: T.IMMUNIZATIONS,  system: T.SYSTEMS.cvx,    snomed: false }
};
const httpErr = (status, message) => Object.assign(new Error(message), { status });
// same normalization as the coverage endpoint and the join in analytics.js (lower case, trimmed, white space collapsed, 500 characters at most)
const normKey = v => { const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 500); return t || null; };
const tokens = s => {
  const all = String(s).toLowerCase().replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-z])(\d)/g, '$1 $2').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(t => t && !STOP.has(t));
  const core = all.filter(t => !GENERIC.has(t)); return core.length ? core : all;
};
const tokMatch = (a, b) => a === b || (a.length >= 3 && b.length >= 3 && !/^\d/.test(a) && !/^\d/.test(b) && (a.startsWith(b) || b.startsWith(a)));
// 0..1 similarity of the string's tokens to one candidate text. Prefix matches stand in for abbreviations ("amox" ~ "amoxicillin"); numbers must be equal.
function similarity(sTok, text) {
  const cTok = tokens(text); if (!sTok.length || !cTok.length) return 0;
  if (sTok.join(' ') === cTok.join(' ')) return 1;
  const used = new Set(); let m = 0;
  for (const s of sTok) {
    let at = cTok.findIndex((c, i) => !used.has(i) && c === s); if (at < 0) at = cTok.findIndex((c, i) => !used.has(i) && tokMatch(s, c));
    if (at >= 0) { used.add(at); m++; }
  }
  let score = 2 * m / (sTok.length + cTok.length);
  if (m === cTok.length) score = Math.max(score, cTok.length >= 2 ? 0.85 : 0.7);   // the whole candidate name appears in the string ("sugar diabetes type 2")
  return score;
}
const bestOf = (sTok, texts) => texts.reduce((b, t) => Math.max(b, similarity(sTok, t)), 0);

// candidates from the bundled dictionary
function fromTerminology(domain, sTok) {
  const cfg = SOURCES[domain], out = [];
  for (const e of Object.values(cfg.dict)) {
    const score = bestOf(sTok, [e.display, ...(e.terms || [])]);
    if (score >= MIN_SCORE) out.push({ system: cfg.system, code: String(e.code), display: e.display, score, source: 'terminology' });
  }
  return out;
}

// candidates from the SNOMED reference tables (dx, pr): one round trip per string, parameterized
const likeEsc = t => t.replace(/[\\%_]/g, '\\$&');
async function fromSnomed(pool, domain, sTok) {
  const keys = [...new Set(sTok.filter(t => t.length >= 3 && !/^\d+$/.test(t)))].sort((a, b) => b.length - a.length).slice(0, 5);
  if (!keys.length) return [];
  const pats = keys.map(k => `%${likeEsc(k)}%`);
  const r = await pool.query(`
    SELECT * FROM (SELECT code, display, code_system, patients, in_data, 'dictionary' AS src FROM snomed_dictionary
                   WHERE domain = $2 AND display ILIKE ANY($1::text[]) ORDER BY patients DESC, length(display) LIMIT 200) a
    UNION ALL
    SELECT * FROM (SELECT code, display, NULL::text, 0, FALSE, 'snomed_concept' FROM snomed_concept
                   WHERE display ILIKE ANY($1::text[]) ORDER BY length(display) LIMIT 200) b`, [pats, domain]);
  const out = [];
  for (const x of r.rows) {
    if (!x.code || !x.display) continue;
    let score = similarity(sTok, x.display);
    if (x.src === 'snomed_concept') score *= 0.9;                                   // kind of concept is unknown: rank below codes seen in this domain's data
    else if (x.in_data) score = Math.min(1, score + 0.02);
    if (score >= MIN_SCORE) out.push({ system: x.code_system || T.SYSTEMS.snomed, code: String(x.code), display: x.display, score, source: x.src, in_data: !!x.in_data });
  }
  return out;
}

// one string -> up to MAX_CANDIDATES distinct codes, best first
async function candidatesFor(pool, domain, key, state) {
  const sTok = tokens(key);
  if (!sTok.length) return [];
  let all = fromTerminology(domain, sTok);
  if (SOURCES[domain].snomed && !state.snomedOff) {
    try { all = all.concat(await fromSnomed(pool, domain, sTok)); state.snomedUsed = true; }
    catch (e) { if (e && e.code === '42P01') state.snomedOff = true; else throw e; }   // reference tables not created yet: terminology only
  }
  const byCode = new Map();
  for (const c of all) { const k = c.system + '|' + c.code, o = byCode.get(k); if (!o || c.score > o.score || (c.score === o.score && c.source === 'terminology')) byCode.set(k, c); }
  return [...byCode.values()].sort((a, b) => b.score - a.score || (b.in_data ? 1 : 0) - (a.in_data ? 1 : 0) || a.code.localeCompare(b.code)).slice(0, MAX_CANDIDATES)
    .map(c => { const o = { system: c.system, code: c.code, display: c.display, score: Math.round(c.score * 1000) / 1000, source: c.source }; if (c.in_data !== undefined) o.in_data = c.in_data; return o; });
}

async function lookup(pool, { domain, strings } = {}) {
  if (typeof domain !== 'string' || !Object.hasOwn(SOURCES, domain)) throw httpErr(400, `domain must be one of ${Object.keys(SOURCES).join(', ')}`);
  if (!Array.isArray(strings) || !strings.length) throw httpErr(400, 'strings must be a non-empty list');
  if (strings.length > MAX_STRINGS) throw httpErr(400, `at most ${MAX_STRINGS} strings per request (got ${strings.length})`);
  const keys = [], seen = new Set();
  for (const s of strings) {
    if (typeof s !== 'string') throw httpErr(400, 'every string must be text');
    if (s.length > 500) throw httpErr(400, 'a string is longer than 500 characters');
    const k = normKey(s); if (!k || seen.has(k)) continue; seen.add(k); keys.push(k);
  }
  if (!keys.length) throw httpErr(400, 'strings has no usable text');
  const state = { snomedOff: false, snomedUsed: false }, results = [];
  for (const key of keys) {
    const cands = key.length > MAX_LEN ? [] : await candidatesFor(pool, domain, key, state);   // too long to be a name: nothing to match
    results.push({ text_key: key, status: cands.length ? 'candidates' : 'unverified', candidates: cands });
  }
  const withC = results.filter(r => r.candidates.length).length;
  return { domain, results, counts: { strings: results.length, with_candidates: withC, unverified: results.length - withC },
    sources: { terminology: true, snomed: SOURCES[domain].snomed && state.snomedUsed } };
}

function register(app, pool) {
  app.post('/api/enrichment/candidates', async (req, res) => {
    try { res.json({ success: true, ...(await lookup(pool, req.body || {})) }); }
    catch (err) {
      if (!err.status) console.error('Enrichment candidates:', err);
      res.status(err.status || 500).json({ success: false, error: err.status ? err.message : 'Candidate lookup failed' });
    }
  });
}

module.exports = register;
module.exports._test = { tokens, similarity, lookup, normKey, MAX_STRINGS };
module.exports.lookup = lookup;   // used by evidence.js (enrichment proposals)

module.exports.selftest = async () => {
  const assert = require('assert'), t = register._test;
  // tokens / similarity
  assert.deepStrictEqual(t.tokens('Amox 500mg'), ['amox', '500', 'mg']);
  assert.strictEqual(t.similarity(t.tokens('colonoscopy'), 'Colonoscopy'), 1);
  assert.ok(t.similarity(t.tokens('amox 500mg'), 'Amoxicillin 500 MG Oral Capsule') >= 0.7, 'abbreviation by prefix');
  assert.ok(t.similarity(t.tokens('amox 250mg'), 'Amoxicillin 500 MG Oral Capsule') < t.similarity(t.tokens('amox 500mg'), 'Amoxicillin 500 MG Oral Capsule'), 'numbers must match');
  assert.ok(t.similarity(t.tokens('sugar diabetes type 2'), 'sugar diabetes') >= 0.85);
  assert.strictEqual(t.similarity(t.tokens('mystery pill'), 'Amoxicillin'), 0);
  assert.deepStrictEqual(t.tokens('High BP'), ['bp']); assert.deepStrictEqual(t.tokens('chronic disease'), ['chronic', 'disease'], 'all-generic text keeps its words');
  // a mock pool: records the SQL, answers the snomed query, can simulate missing tables
  const mk = (rows, missing) => { const seen = []; return { seen, query: async (sql, p) => { seen.push({ sql, p }); if (missing) throw Object.assign(new Error('relation "snomed_dictionary" does not exist'), { code: '42P01' }); return { rows }; } }; };
  const dict = [{ code: '44054006', display: 'Diabetes mellitus type 2', code_system: T.SYSTEMS.snomed, patients: 40, in_data: true, src: 'dictionary' },
                { code: '99999999', display: 'Gestational diabetes mellitus', code_system: null, patients: 0, in_data: false, src: 'snomed_concept' }];
  let pool = mk(dict), r = await t.lookup(pool, { domain: 'dx', strings: ['  Sugar   DIABETES ', 'sugar diabetes', 'xyzzy'] });
  assert.deepStrictEqual([r.counts.strings, r.counts.with_candidates, r.counts.unverified], [2, 1, 1], 'normalized duplicates collapse');
  assert.strictEqual(r.results[0].text_key, 'sugar diabetes'); assert.strictEqual(r.results[0].candidates[0].code, '44054006');
  assert.strictEqual(r.results[0].candidates.filter(c => c.code === '44054006').length, 1, 'same code from two sources appears once');
  assert.strictEqual(r.results[1].status, 'unverified'); assert.deepStrictEqual(r.results[1].candidates, []);
  assert.strictEqual(r.sources.snomed, true);
  assert.ok(pool.seen.every(q => Array.isArray(q.p) && !/sugar|xyzzy/i.test(q.sql)), 'the string is a bound parameter, never SQL text');
  assert.ok(r.results[0].candidates.every(c => c.system && c.code && c.display && typeof c.score === 'number'));
  // other domains use only the bundled dictionary (no database call)
  pool = mk([]); r = await t.lookup(pool, { domain: 'rx', strings: ['Amox 500mg', 'Lipitor'] });
  assert.strictEqual(r.results[0].candidates[0].code, T.MEDICATIONS.amoxicillin.code); assert.strictEqual(r.results[0].candidates[0].system, T.SYSTEMS.rxnorm);
  assert.strictEqual(r.results[1].candidates[0].code, T.MEDICATIONS.atorvastatin.code); assert.strictEqual(pool.seen.length, 0); assert.strictEqual(r.sources.snomed, false);
  assert.strictEqual((await t.lookup(pool, { domain: 'ob', strings: ['glycated hemoglobin'] })).results[0].candidates[0].code, T.LABS.hba1c.code);
  assert.strictEqual((await t.lookup(pool, { domain: 'al', strings: ['PCN allergy', 'penicillin allergy'] })).results[1].candidates[0].code, T.ALLERGENS.penicillin.code);
  assert.strictEqual((await t.lookup(pool, { domain: 'im', strings: ['flu shot'] })).results[0].candidates[0].code, T.IMMUNIZATIONS.influenza.code);
  assert.strictEqual((await t.lookup(pool, { domain: 'pr', strings: ['colonoscopy (screening)'] })).results[0].candidates[0].code, T.PROCEDURES.colonoscopy.code);
  assert.strictEqual((await t.lookup(mk([]), { domain: 'pr', strings: ['scope of the colon'] })).results[0].candidates[0].code, T.PROCEDURES.colonoscopy.code, 'a lay description still finds its procedure');
  assert.strictEqual((await t.lookup(mk([]), { domain: 'pr', strings: ['zzz unknown thing'] })).results[0].status, 'unverified', 'no match is unverified, never a guess');
  // limits and bad input are 400s and run nothing
  for (const bad of [{}, { domain: 'zz', strings: ['a'] }, { domain: 'dx' }, { domain: 'dx', strings: [] }, { domain: 'dx', strings: [1] }, { domain: 'dx', strings: ['   '] },
    { domain: 'dx', strings: Array.from({ length: t.MAX_STRINGS + 1 }, (_, i) => 's' + i) }, { domain: 'dx', strings: ['x'.repeat(501)] }, { domain: 'constructor', strings: ['a'] }]) {
    const p = mk([]); await assert.rejects(() => t.lookup(p, bad), e => e.status === 400, 'refused: ' + JSON.stringify(bad).slice(0, 60)); assert.strictEqual(p.seen.length, 0);
  }
  // a string longer than 200 characters is not a name: unverified, no query
  pool = mk(dict); r = await t.lookup(pool, { domain: 'dx', strings: ['diabetes '.repeat(30)] }); assert.strictEqual(r.results[0].status, 'unverified'); assert.strictEqual(pool.seen.length, 0);
  // at most 8 candidates, best first
  const many = Array.from({ length: 30 }, (_, i) => ({ code: String(1000 + i), display: 'Chest pain variant ' + i, code_system: null, patients: i, in_data: true, src: 'dictionary' }));
  r = await t.lookup(mk(many), { domain: 'dx', strings: ['chest pain'] }); assert.strictEqual(r.results[0].candidates.length, 8);
  assert.ok(r.results[0].candidates.every((c, i, a) => !i || a[i - 1].score >= c.score));
  r = await t.lookup(mk([]), { domain: 'dx', strings: ['high bp'] }); assert.deepStrictEqual(r.results[0].candidates.map(c => c.code), [T.CONDITIONS.hypertension.code], 'a generic word alone does not pull other conditions');
  // snomed tables missing: terminology candidates still come back, and the table is not asked again
  pool = mk([], true); r = await t.lookup(pool, { domain: 'dx', strings: ['sugar diabetes', 'high bp'] });
  assert.strictEqual(r.results[0].candidates[0].code, T.CONDITIONS.diabetes.code); assert.strictEqual(r.sources.snomed, false); assert.strictEqual(pool.seen.length, 1);
  // any other database error is not swallowed
  await assert.rejects(() => t.lookup({ query: async () => { throw new Error('boom'); } }, { domain: 'dx', strings: ['diabetes'] }), /boom/);
  // route: bad input -> 400 JSON, good input -> success
  const routes = {}, app = { post: (p, h) => { routes[p] = h; } }; register(app, mk(dict));
  const call = async body => { let code = 200, out; await routes['/api/enrichment/candidates']({ body }, { status(c) { code = c; return this; }, json(o) { out = o; } }); return [code, out]; };
  let [c1, o1] = await call({ domain: 'dx', strings: ['sugar diabetes'] }); assert.strictEqual(c1, 200); assert.strictEqual(o1.success, true);
  [c1, o1] = await call({ domain: 'nope', strings: ['x'] }); assert.strictEqual(c1, 400); assert.strictEqual(o1.success, false);
  console.log('knowledge.js enrichment-candidates self-test: all checks passed');
};
return module.exports;
})();
__s.enrichCandidates = enrichCandidates;

// ======================================================================
// EXPORTS AND SELF-TEST RUNNER
// ======================================================================
module.exports = { terminology, snomedQuery, kgCohort, enrichCandidates, fhirConnect };

if (require.main === module && process.argv.includes('--selftest')) {
  (async () => {
    for (const m of [terminology, snomedQuery, kgCohort, enrichCandidates, fhirConnect]) await m.selftest();
    console.log('knowledge.js: all self-tests passed');
  })().catch(e => { console.error(e); process.exit(1); });
}
