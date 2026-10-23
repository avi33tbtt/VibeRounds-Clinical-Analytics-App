// Clinical analytics catalog for Vibe Rounds.
//
// Every analytic is implemented three ways on the same standardized FHIR tables:
//   v1  Text matching      - searches narratives / display text (text.div, code.text, display),
//                            with simple negation handling ("denies", "no history of"...). No codes.
//   v3  Code based         - SNOMED CT / LOINC / RxNorm identifiers. No dates.
//   v4  Code + temporality - codes AND dates: incidence by year, time-to-treatment, windows, trends.
//
// Scope = every imported batch (or one batch / batch group) restricted to the active cohort
// (or an explicit cohortId). Cohort criteria are applied exactly like the demographics endpoints do.

const T = require('./terminology');
const G = T.graph;

// ---------------------------------------------------------------- helpers
class Q { constructor() { this.params = []; } add(v, cast) { this.params.push(v); return `$${this.params.length}${cast ? '::' + cast : ''}`; } }
const reEsc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alt = terms => terms.map(reEsc).join('|');
const POS = terms => `\\m(?:${alt(terms)})\\M`;
const NEG = terms => `(?:\\mno\\M|\\mdenies\\M|\\mwithout\\M|negative for|ruled out|family history of)[^.;]{0,30}(?:${alt(terms)})`;
const strip = x => `regexp_replace(${x}, '<[^>]+>', ' ', 'g')`;
const CODE_TXT = `j->'text'->>'div', j->'code'->>'text', j->'code'->'coding'->0->>'display'`;
const TXT = {
  dx: `lower(${strip(`concat_ws(' ', ${CODE_TXT})`)})`,
  ob: `lower(${strip(`concat_ws(' ', ${CODE_TXT}, j->>'valueString')`)})`,
  rx: `lower(${strip(`concat_ws(' ', j->'text'->>'div', j->'medicationCodeableConcept'->>'text', j->'medicationCodeableConcept'->'coding'->0->>'display', j->'medicationReference'->>'display')`)})`,
  pr: `lower(${strip(`concat_ws(' ', ${CODE_TXT})`)})`,
  en: `lower(${strip(`concat_ws(' ', j->'text'->>'div', j->'type'->0->>'text', j->'reasonCode'->0->>'text', j->'class'->>'display')`)})`,
  al: `lower(${strip(`concat_ws(' ', ${CODE_TXT})`)})`
};
const DISPLAY = `j->'code'->'coding'->0->>'display'`;
const pct = (num, den) => `round(100.0*(${num})/NULLIF((${den}),0),1)::float8`;
const AGE_BANDS = ['0-1 years', '2-4 years', '5-17 years', '18-34 years', '35-44 years', '45-54 years', '55-64 years', '65-74 years', '75-84 years', '85+ years', 'Unknown'];
const bandCase = a => `CASE WHEN ${a} IS NULL THEN 'Unknown' WHEN ${a} < 2 THEN '0-1 years' WHEN ${a} < 5 THEN '2-4 years' WHEN ${a} < 18 THEN '5-17 years' WHEN ${a} < 35 THEN '18-34 years' WHEN ${a} < 45 THEN '35-44 years' WHEN ${a} < 55 THEN '45-54 years' WHEN ${a} < 65 THEN '55-64 years' WHEN ${a} < 75 THEN '65-74 years' WHEN ${a} < 85 THEN '75-84 years' ELSE '85+ years' END`;
const ombPath = (kind, field) => `jsonb_path_query_first(pj, '$.extension[*] ? (@.url == "http://hl7.org/fhir/us/core/StructureDefinition/us-core-${kind}").extension[*] ? (@.url == "${field}").${field === 'text' ? 'valueString' : 'valueCoding.display'}') #>> '{}'`;
const RACE = `COALESCE(${ombPath('race', 'ombCategory')}, ${ombPath('race', 'text')}, 'Unknown')`;
const ETHN = `COALESCE(${ombPath('ethnicity', 'ombCategory')}, ${ombPath('ethnicity', 'text')}, 'Unknown')`;

const S = (name, title, sql) => ({ name, title, sql });
const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const validDate = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const codesOf = (args, fallback) => (args.code ? String(args.code).split(',').map(s => s.trim()).filter(Boolean) : fallback);
const cond = a => T.CONDITIONS[a.concept] || null;
const label = (dict, k) => (dict[k] ? dict[k].display : k);

// ---- knowledge-graph expansion (Step 6.3). `expand` adds concepts linked to the chosen condition in graph.js.
// An explicit free-text term (V1) or code list (V3/V4) always wins over the chosen condition.
const wantsExpand = a => a.expand === true || /^(1|true|yes|on)$/i.test(String(a.expand ?? ''));
const bad400 = msg => Object.assign(new Error(msg), { status: 400 });
const dispOf = k => ((T.CONDITIONS[k] || T.MEDICATIONS[k] || T.LABS[k] || T.PROCEDURES[k] || {}).display) || k;

// ---- Step D.2a: dropdown value -> analytic arguments (data-driven condition options).
// Only these analytics get a data-driven condition dropdown (see the D.2 split note in the roadmap).
const CONCEPT_ANALYTICS = new Set(['condition_prevalence', 'demographics']);
// A dropdown value that needs a look-up in the data: a non-empty string that is neither a dictionary key nor a dictionary code.
// Returns the code to look up, or null when nothing needs to be looked up. Throws 400 on unusable values.
function conceptToLookUp(args) {
  const v = args && args.concept;
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > 100 || /[\u0000-\u001f\u007f]/.test(v)) throw bad400('Condition must be a short text value');
  if (Object.hasOwn(T.CONDITIONS, v)) return null;
  if (Object.values(T.CONDITIONS).some(c => c.code === v)) return null;
  return v;
}
// Pure function. `display` is the data display text of the code (string), or null when the code is not in the scope's diagnoses.
// - dictionary key stays as `concept`; a dictionary code becomes its key;
// - any other value becomes `code` (and `concept` is removed); in V1 with no `term` the display text is the search term.
// An explicit `code` or `term` from the caller always wins. `learned` (D.7d, optional): terms learned for the code; used for V1 instead of the display alone.
function normalizeConcept(args, display, mode, learned) {
  const out = { ...args };
  const v = out.concept;
  if (v === undefined || v === null || v === '') return out;
  if (typeof v !== 'string' || v.length > 100 || /[\u0000-\u001f\u007f]/.test(v)) throw bad400('Condition must be a short text value');
  if (Object.hasOwn(T.CONDITIONS, v)) return out;
  const key = Object.keys(T.CONDITIONS).find(k => T.CONDITIONS[k].code === v);
  if (key) { out.concept = key; return out; }
  if (display === null || display === undefined) throw bad400(`Unknown condition '${v.replace(/[^\w .:\-]/g, '').slice(0, 40)}': it is not a dictionary condition and not a diagnosis code in this scope`);
  delete out.concept;
  if (!out.code) out.code = v;
  if (mode === 'v1' && !out.term) {
    // Step D.7d: terms learned from the data (display strings and specific phrases); the label stays the data display. Without them the display alone is the term (Step D.2a).
    if (Array.isArray(learned) && learned.length) { out.term = display || learned[0]; out.termList = learned; }
    else if (display) out.term = display;
  }
  return out;
}
// Conditions to look for: [{ key, why }], or null when no condition is chosen.
function condPlan(a) {
  if (!a.concept) return null;
  const plan = [{ key: a.concept, why: 'selected' }];
  if (wantsExpand(a) && G.has(a.concept) && T.CONCEPT_KIND[a.concept] === 'condition')
    for (const n of G.expand(a.concept, { types: ['leads_to'], kinds: ['condition'] })) plan.push({ key: n.key, why: `${n.direction === 'out' ? 'complication of' : 'leads to'} ${dispOf(a.concept)} (graph)` });
  return plan;
}
// Drugs that treat the chosen condition (and, with expand, its linked conditions): [{ key, why }], or null.
function drugPlan(a) {
  if (!a.concept || a.term || a.code) return null;
  if (!Object.hasOwn(T.CONDITIONS, a.concept)) throw bad400(`Unknown condition '${a.concept}'`);
  const conds = [{ key: a.concept, why: dispOf(a.concept) }];
  if (wantsExpand(a)) for (const n of G.expand(a.concept, { types: ['leads_to'], kinds: ['condition'] })) conds.push({ key: n.key, why: dispOf(n.key) });
  const seen = new Map();
  for (const c of conds) for (const n of G.neighbors(c.key, { types: ['treated_by'], direction: 'out' })) if (!seen.has(n.key)) seen.set(n.key, { key: n.key, why: `treats ${c.why}` });
  if (!seen.size) throw bad400(`No drugs are linked to '${dispOf(a.concept)}' in the knowledge graph`);
  return [...seen.values()];
}
// Small section listing what a run actually looked for, so an expanded run is not a black box.
const usedSection = (plan, what) => S('concepts_used', `${what} included in this run`, q => `SELECT * FROM (VALUES ${plan.map(p => `(${q.add(dispOf(p.key), 'text')},${q.add(p.why, 'text')})`).join(',')}) AS t(concept, included_because)`);

// text-concept machinery: VALUES table of (key,label,pos,neg) + per-patient hits
function conceptCte(q, entries) {
  const rows = entries.map(e => `(${q.add(e.key, 'text')},${q.add(e.label, 'text')},${q.add(POS(e.terms), 'text')},${q.add(NEG(e.terms), 'text')})`);
  return `concepts(key,label,pos,neg) AS (VALUES ${rows.join(',')})`;
}
const hitsSql = srcs => srcs.map(s => `SELECT t.patient_id, c.key, c.label FROM (SELECT patient_id, ${TXT[s]} AS txt FROM ${s}) t JOIN concepts c ON t.txt ~* c.pos AND t.txt !~* c.neg`).join(' UNION ');
const entriesOf = (dict, pred = () => true) => Object.entries(dict).filter(([k, v]) => pred(k, v)).map(([k, v]) => ({ key: k, label: v.display, terms: v.terms }));
// `termList` is set only by the engine (Step D.7d, learned terms for a data code); run() removes it from caller input.
const termsOf = a => (Array.isArray(a.termList) && a.termList.length ? a.termList : [a.term]);
const customOr = (args, entries) => (args.term ? [{ key: 'custom', label: args.term, terms: termsOf(args) }] : entries);
const pairSql = (pc, n) => `SELECT a.label AS item_a, b.label AS item_b, count(*)::int AS patients_both, ca.c::int AS patients_a, cb.c::int AS patients_b,
  ${pct('count(*)', 'ca.c')} AS pct_of_a_with_b, round((count(*) * ${n}::numeric / (ca.c * cb.c)), 2)::float8 AS lift
  FROM ${pc} a JOIN ${pc} b ON a.patient_id = b.patient_id AND a.key < b.key
  JOIN cnt ca ON ca.key = a.key JOIN cnt cb ON cb.key = b.key
  GROUP BY a.label, b.label, ca.c, cb.c ORDER BY patients_both DESC LIMIT 25`;

// ---------------------------------------------------------------- catalog
const optsOf = dict => [{ value: '', label: '(all)' }, ...Object.entries(dict).map(([k, v]) => ({ value: k, label: v.display || v.label }))];
const P = {
  concept: { name: 'concept', label: 'Condition', type: 'select', options: () => optsOf(T.CONDITIONS) },
  code: { name: 'code', label: 'Code(s), comma separated', type: 'text', modes: ['v3', 'v4'] },
  term: { name: 'term', label: 'Free-text term', type: 'text', modes: ['v1'] },
  topN: { name: 'topN', label: 'Top N', type: 'number', default: 10 },
  expand: { name: 'expand', label: 'Include related concepts (knowledge graph)', type: 'select', default: '', options: [{ value: '', label: 'No' }, { value: 'yes', label: 'Yes' }] },
  from: { name: 'from', label: 'From date', type: 'date', modes: ['v4'] },
  to: { name: 'to', label: 'To date', type: 'date', modes: ['v4'] }
};

const CATALOG = [];
const def = a => CATALOG.push(a);

// ---- 1. Demographics -------------------------------------------------------
function demoIdx(mode, q, a) {
  const from = validDate(a.from), to = validDate(a.to);
  const c = cond(a), codes = codesOf(a, c ? [c.code] : null);
  if (mode === 'v1') {
    const entries = a.term ? [{ key: 'custom', label: a.term, terms: termsOf(a) }] : c ? [{ key: a.concept, label: c.display, terms: c.terms }] : null;
    if (!entries) return { cte: `idx AS (SELECT patient_id, NULL::date AS d FROM p)`, dated: false, filtered: false };
    return { cte: `${conceptCte(q, entries)}, idx AS (SELECT DISTINCT patient_id, NULL::date AS d FROM (${hitsSql(['dx', 'en'])}) h)`, dated: false, filtered: true };
  }
  if (mode === 'v3') {
    if (!codes) return { cte: `idx AS (SELECT patient_id, NULL::date AS d FROM p)`, dated: false, filtered: false };
    return { cte: `idx AS (SELECT DISTINCT patient_id, NULL::date AS d FROM dx WHERE code = ANY(${q.add(codes, 'text[]')}))`, dated: false, filtered: true };
  }
  // v4: index date = first onset of the code inside the window (new cases), or first encounter in the window
  const w = (col) => `${from ? ` AND ${col} >= ${q.add(from, 'date')}` : ''}${to ? ` AND ${col} <= ${q.add(to, 'date')}` : ''}`;
  if (codes) return { cte: `idx AS (SELECT patient_id, min(onset_date) AS d FROM dx WHERE code = ANY(${q.add(codes, 'text[]')}) AND onset_date IS NOT NULL GROUP BY patient_id HAVING true${from ? ` AND min(onset_date) >= ${q.add(from, 'date')}` : ''}${to ? ` AND min(onset_date) <= ${q.add(to, 'date')}` : ''})`, dated: true, filtered: true };
  return { cte: `idx AS (SELECT patient_id, min(start_date)::date AS d FROM en WHERE start_date IS NOT NULL${w('start_date::date')} GROUP BY patient_id)`, dated: true, filtered: !!(from || to) };
}
function demoSections(mode, a, ctx) {
  const dims = a.dim && a.dim !== 'all' ? [a.dim] : ['gender', 'age', 'race', 'ethnicity'];
  const out = [];
  for (const dim of dims) out.push(S(dim, { gender: 'Gender', age: 'Age bands', race: 'Race', ethnicity: 'Ethnicity' }[dim], (q) => {
    const idx = demoIdx(mode, q, a);
    const ageExpr = idx.dated ? `EXTRACT(YEAR FROM age(idx.d, p.birth_date))` : `EXTRACT(YEAR FROM age((SELECT d FROM ref), p.birth_date))`;
    const val = { gender: `COALESCE(p.gender,'unknown')`, age: bandCase(`(CASE WHEN p.birth_date IS NULL THEN NULL ELSE ${ageExpr} END)`), race: RACE, ethnicity: ETHN }[dim];
    const order = dim === 'age' ? `array_position(ARRAY[${AGE_BANDS.map(b => `'${b}'`).join(',')}], value)` : 'count DESC';
    return `${ctx.with}, ${idx.cte}
      SELECT value, count(*)::int AS count, round(100.0*count(*)/sum(count(*)) OVER (),1)::float8 AS percentage
      FROM (SELECT ${val} AS value FROM p JOIN idx ON idx.patient_id = p.patient_id) s GROUP BY value ORDER BY ${order}`;
  }));
  if (mode === 'v4') out.push(S('new_cases_by_year', 'Index events by year and gender (age measured at index date)', (q) => {
    const idx = demoIdx(mode, q, a);
    return `${ctx.with}, ${idx.cte}
      SELECT EXTRACT(YEAR FROM idx.d)::int AS year, COALESCE(p.gender,'unknown') AS gender, count(*)::int AS patients
      FROM p JOIN idx ON idx.patient_id = p.patient_id WHERE idx.d IS NOT NULL GROUP BY 1,2 ORDER BY 1,2`;
  }));
  return out;
}
def({
  id: 'demographics', category: 'Population', title: 'Demographic distributions',
  description: 'Gender, age bands, race and ethnicity. V1 restricts to patients whose notes mention a term, V3 to patients carrying a condition code, V4 to new cases of a code inside a date window with age measured at the index date.',
  params: [{ name: 'dim', label: 'Dimension', type: 'select', options: [{ value: 'all', label: 'All' }, { value: 'gender', label: 'Gender' }, { value: 'age', label: 'Age bands' }, { value: 'race', label: 'Race' }, { value: 'ethnicity', label: 'Ethnicity' }], default: 'all' }, { ...P.concept, fromData: 'dx' }, P.term, P.code, P.from, P.to],
  v1: (a, c) => demoSections('v1', a, c), v3: (a, c) => demoSections('v3', a, c), v4: (a, c) => demoSections('v4', a, c)
});

// ---- 2. Condition prevalence & incidence ----------------------------------
def({
  id: 'condition_prevalence', category: 'Conditions', title: 'Condition prevalence & incidence',
  description: 'V1: how many patients have each condition mentioned in notes. V3: patients per condition code. V4: new cases per year and cumulative prevalence.',
  params: [{ ...P.concept, fromData: 'dx' }, P.expand, P.term, P.code, P.topN],
  v1: (a, c) => { const plan = condPlan(a), keys = plan && plan.map(p => p.key); return [...(plan && wantsExpand(a) && !a.term ? [usedSection(plan, 'Conditions')] : []), S('prevalence', 'Patients with condition mentioned in text', (q) => `${c.with}, ${conceptCte(q, customOr(a, entriesOf(T.CONDITIONS, k => !keys || keys.includes(k))))},
      pc AS (SELECT DISTINCT patient_id, key, label FROM (${hitsSql(['dx', 'en'])}) h)
      SELECT label AS condition, count(*)::int AS patients, ${pct('count(*)', '(SELECT count(*) FROM p)')} AS pct_of_patients FROM pc GROUP BY label ORDER BY patients DESC`)]; },
  v3: (a, c) => { const plan = condPlan(a), codes = plan && plan.map(p => T.CONDITIONS[p.key]?.code); return [...(plan && wantsExpand(a) && !a.code ? [usedSection(plan, 'Conditions')] : []), S('prevalence', 'Patients per condition code', (q) => `${c.with}
      SELECT code, code_system, COALESCE(max(${DISPLAY}), max(j->'code'->>'text')) AS display, count(DISTINCT patient_id)::int AS patients, count(*)::int AS records,
        ${pct('count(DISTINCT patient_id)', '(SELECT count(*) FROM p)')} AS pct_of_patients
      FROM dx ${a.code || a.concept ? `WHERE code = ANY(${q.add(codesOf(a, codes), 'text[]')})` : ''} GROUP BY code, code_system ORDER BY patients DESC LIMIT ${num(a.topN, 10)}`)]; },
  v4: (a, c) => { const plan = condPlan(a), codes = plan && plan.map(p => T.CONDITIONS[p.key]?.code); return [
    ...(plan && wantsExpand(a) && !a.code ? [usedSection(plan, 'Conditions')] : []),
    S('incidence', 'New cases per year and cumulative prevalence', (q) => `${c.with},
      fo AS (SELECT patient_id, code, min(onset_date) AS d, max(${DISPLAY}) AS display FROM dx WHERE onset_date IS NOT NULL ${a.code || a.concept ? `AND code = ANY(${q.add(codesOf(a, codes), 'text[]')})` : ''} GROUP BY patient_id, code),
      top AS (SELECT code FROM fo GROUP BY code ORDER BY count(*) DESC LIMIT ${num(a.topN, 8)}),
      yr AS (SELECT code, max(display) AS display, EXTRACT(YEAR FROM d)::int AS year, count(*)::int AS new_cases FROM fo WHERE code IN (SELECT code FROM top) GROUP BY code, EXTRACT(YEAR FROM d))
      SELECT code, display, year, new_cases, (sum(new_cases) OVER (PARTITION BY code ORDER BY year))::int AS cumulative_patients,
        ${pct('sum(new_cases) OVER (PARTITION BY code ORDER BY year)', '(SELECT count(*) FROM p)')} AS cumulative_pct
      FROM yr ORDER BY code, year`),
    S('span', 'First and last recorded onset per code', () => `${c.with}
      SELECT code, max(${DISPLAY}) AS display, count(DISTINCT patient_id)::int AS patients, min(onset_date) AS first_onset, max(onset_date) AS last_onset
      FROM dx WHERE onset_date IS NOT NULL GROUP BY code ORDER BY patients DESC LIMIT ${num(a.topN, 10)}`)]; }
});

// ---- 3. Medication utilization --------------------------------------------
def({
  id: 'medication_utilization', category: 'Medications', title: 'Medication utilization',
  description: 'V1: drugs mentioned in medication text. V3: patients and prescriptions per RxNorm code. V4: prescriptions per year, new starts, and exposure duration.',
  params: [{ ...P.concept, label: 'Condition (only drugs that treat it)' }, P.expand, P.term, P.code, P.topN],
  v1: (a, c) => { const plan = drugPlan(a), keys = plan && plan.map(p => p.key); return [...(plan && wantsExpand(a) ? [usedSection(plan, 'Drugs')] : []), S('drugs', 'Patients with drug mentioned in medication text', (q) => `${c.with}, ${conceptCte(q, customOr(a, entriesOf(T.MEDICATIONS, k => !keys || keys.includes(k))))},
      h AS (${hitsSql(['rx'])})
      SELECT label AS medication, count(DISTINCT patient_id)::int AS patients, count(*)::int AS records, ${pct('count(DISTINCT patient_id)', '(SELECT count(*) FROM p)')} AS pct_of_patients FROM h GROUP BY label ORDER BY patients DESC`)]; },
  v3: (a, c) => { const plan = drugPlan(a), codes = plan && plan.map(p => T.MEDICATIONS[p.key].code); return [...(plan && wantsExpand(a) ? [usedSection(plan, 'Drugs')] : []), S('drugs', 'Prescriptions per RxNorm code', (q) => `${c.with}
      SELECT code, COALESCE(max(j->'medicationCodeableConcept'->'coding'->0->>'display'), max(j->'medicationCodeableConcept'->>'text')) AS display, count(DISTINCT patient_id)::int AS patients, count(*)::int AS prescriptions,
        round(count(*)::numeric/count(DISTINCT patient_id),1)::float8 AS rx_per_patient
      FROM rx ${a.code || codes ? `WHERE code = ANY(${q.add(codesOf(a, codes), 'text[]')})` : ''} GROUP BY code ORDER BY patients DESC LIMIT ${num(a.topN, 10)}`)]; },
  v4: (a, c) => { const plan = drugPlan(a), codes = plan && plan.map(p => T.MEDICATIONS[p.key].code); return [
    ...(plan && wantsExpand(a) ? [usedSection(plan, 'Drugs')] : []),
    S('by_year', 'Prescriptions, patients and new starts per year', (q) => `${c.with},
      r AS (SELECT patient_id, code, prescribed_date::date AS d FROM rx WHERE prescribed_date IS NOT NULL ${a.code || codes ? `AND code = ANY(${q.add(codesOf(a, codes), 'text[]')})` : ''}),
      first AS (SELECT patient_id, code, min(d) AS d FROM r GROUP BY 1,2),
      top AS (SELECT code FROM r GROUP BY code ORDER BY count(DISTINCT patient_id) DESC LIMIT ${num(a.topN, 6)}),
      yr AS (SELECT code, EXTRACT(YEAR FROM d)::int AS year, count(*)::int AS prescriptions, count(DISTINCT patient_id)::int AS patients FROM r WHERE code IN (SELECT code FROM top) GROUP BY 1,2),
      ns AS (SELECT code, EXTRACT(YEAR FROM d)::int AS year, count(*)::int AS new_starts FROM first GROUP BY 1,2)
      SELECT yr.code, yr.year, yr.prescriptions, yr.patients, COALESCE(ns.new_starts,0)::int AS new_starts FROM yr LEFT JOIN ns ON ns.code = yr.code AND ns.year = yr.year ORDER BY yr.code, yr.year`),
    S('duration', 'Exposure span per patient (first to last prescription)', (q) => `${c.with},
      s AS (SELECT patient_id, code, min(prescribed_date::date) AS f, max(prescribed_date::date) AS l, count(*) AS n FROM rx WHERE prescribed_date IS NOT NULL ${a.code || codes ? `AND code = ANY(${q.add(codesOf(a, codes), 'text[]')})` : ''} GROUP BY 1,2)
      SELECT code, count(*)::int AS patients, percentile_cont(0.5) WITHIN GROUP (ORDER BY (l - f))::float8 AS median_days_exposure, round(avg(n),1)::float8 AS avg_prescriptions
      FROM s GROUP BY code ORDER BY patients DESC LIMIT ${num(a.topN, 10)}`)]; }
});

// ---- 4. Lab / vital summary -------------------------------------------------
const labOf = a => T.LABS[a.lab || 'hba1c'] || T.LABS.hba1c;
const abn = l => (l.dir === 'high' ? `v >= ${l.thr}` : l.dir === 'low' ? `v < ${l.thr}` : 'NULL');
function labObs(mode, q, a) {
  const l = labOf(a);
  const filter = mode === 'v1' ? `${TXT.ob} ~* ${q.add(POS(a.term ? [a.term] : l.terms), 'text')} AND ${TXT.ob} !~* ${q.add(NEG(a.term ? [a.term] : l.terms), 'text')}` : `code = ANY(${q.add(codesOf(a, [l.code]), 'text[]')})`;
  return `obs AS (SELECT patient_id, value::float8 AS v, effective_date FROM ob WHERE value IS NOT NULL AND ${filter})`;
}
const statSql = (extraFrom = 'obs', l, data) => `SELECT count(*)::int AS results, count(DISTINCT patient_id)::int AS patients, round(avg(v)::numeric,2)::float8 AS mean,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY v)::float8 AS median, percentile_cont(0.25) WITHIN GROUP (ORDER BY v)::float8 AS p25, percentile_cont(0.75) WITHIN GROUP (ORDER BY v)::float8 AS p75,
  min(v)::float8 AS min, max(v)::float8 AS max, ${data ? pct('count(*) FILTER (WHERE abn)', 'count(*) FILTER (WHERE abn IS NOT NULL)') : l.dir ? pct(`count(*) FILTER (WHERE ${abn(l)})`, 'count(*)') : 'NULL::float8'} AS pct_abnormal${data ? ", string_agg(DISTINCT src, ' / ') AS range_source" : ''} FROM ${extraFrom}`;
// Step D.3b: ranges = 'data' judges abnormal by the data (reviewer limit, reference range, interpretation flag, else statistical) via labFlagCtes of analytics-ext.js
const RANGES_PARAM = { name: 'ranges', label: 'Abnormal range (V3/V4)', type: 'select', default: 'dictionary', modes: ['v3', 'v4'], options: [{ value: 'dictionary', label: 'Dictionary threshold (terminology.js)' }, { value: 'data', label: 'From the data (range, flag or statistical; see range_source)' }] };
const dataRanges = a => a.ranges === 'data';
function labObsData(q, a, c) {
  if (!EXT.labFlagCtes) throw new Error('Data ranges are not available (analytics-ext.js did not load)');
  return `${c.with}, ${EXT.labFlagCtes(q, c)},
  obs AS (SELECT patient_id, v, effective_date, abn, src FROM lf WHERE code = ANY(${q.add(codesOf(a, [labOf(a).code]), 'text[]')}))`;
}
const labParams = [{ name: 'lab', label: 'Lab / vital', type: 'select', options: () => Object.entries(T.LABS).map(([k, v]) => ({ value: k, label: `${v.display} (${v.code})` })), default: 'hba1c' }, P.term, P.code];
def({
  id: 'lab_vital_summary', category: 'Labs & vitals', title: 'Lab & vital sign summary',
  description: 'Distribution and abnormal rate of a lab/vital. V1 finds the test by name in text, V3 by LOINC code, V4 adds yearly trend and per-patient change from first to last result. With Abnormal range = From the data (V3/V4, Step D.3b) abnormal is judged by a reviewer limit, the reference range or interpretation flag on the results, else the statistical 2.5th-97.5th percentile (NOT clinical; see range_source); results with no basis are not judged. V1 always uses the dictionary threshold.',
  params: [...labParams, RANGES_PARAM],
  v1: (a, c) => [S('summary', 'Result statistics (test identified by text)', (q) => `${c.with}, ${labObs('v1', q, a)} ${statSql('obs', labOf(a))}`)],
  v3: (a, c) => [S('summary', dataRanges(a) ? 'Result statistics (test identified by LOINC code, abnormal from the data)' : 'Result statistics (test identified by LOINC code)', (q) => dataRanges(a) ? `${labObsData(q, a, c)} ${statSql('obs', labOf(a), true)}` : `${c.with}, ${labObs('v3', q, a)} ${statSql('obs', labOf(a))}`)],
  v4: (a, c) => {
    const l = labOf(a), D = dataRanges(a), obsSql = q => D ? labObsData(q, a, c) : `${c.with}, ${labObs('v3', q, a)}`, better = l.dir === 'high' ? 'lst.v < fst.v' : l.dir === 'low' ? 'lst.v > fst.v' : 'NULL';
    return [
      S('summary', D ? 'Result statistics (abnormal from the data)' : 'Result statistics', (q) => `${obsSql(q)} ${statSql('obs', l, D)}`),
      S('by_year', D ? 'Yearly trend (abnormal from the data)' : 'Yearly trend', (q) => `${obsSql(q)}
        SELECT EXTRACT(YEAR FROM effective_date)::int AS year, count(*)::int AS results, count(DISTINCT patient_id)::int AS patients, round(avg(v)::numeric,2)::float8 AS mean,
          ${D ? pct('count(*) FILTER (WHERE abn)', 'count(*) FILTER (WHERE abn IS NOT NULL)') : l.dir ? pct(`count(*) FILTER (WHERE ${abn(l)})`, 'count(*)') : 'NULL::float8'} AS pct_abnormal
        FROM obs WHERE effective_date IS NOT NULL GROUP BY 1 ORDER BY 1`),
      S('change', 'Per-patient change, first vs last result (patients with 2+ results)', (q) => `${obsSql(q)},
        ranked AS (SELECT patient_id, v, effective_date, row_number() OVER (PARTITION BY patient_id ORDER BY effective_date) AS rn, row_number() OVER (PARTITION BY patient_id ORDER BY effective_date DESC) AS rn_desc FROM obs WHERE effective_date IS NOT NULL),
        fst AS (SELECT * FROM ranked WHERE rn = 1), lst AS (SELECT * FROM ranked WHERE rn_desc = 1)
        SELECT count(*)::int AS patients, round(avg(fst.v)::numeric,2)::float8 AS mean_first, round(avg(lst.v)::numeric,2)::float8 AS mean_last, round(avg(lst.v - fst.v)::numeric,2)::float8 AS mean_change,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY (lst.effective_date::date - fst.effective_date::date))::float8 AS median_follow_up_days,
          ${l.dir ? pct(`count(*) FILTER (WHERE ${better})`, 'count(*)') : 'NULL::float8'} AS pct_improved
        FROM fst JOIN lst ON fst.patient_id = lst.patient_id WHERE lst.effective_date > fst.effective_date`)
    ];
  }
});

// ---- 5. Comorbidity ------------------------------------------------------------
def({
  id: 'comorbidity', category: 'Conditions', title: 'Comorbidity patterns',
  description: 'V1/V3: which condition pairs occur together (lift > 1 = more than chance). V4: ordered pairs, i.e. condition B diagnosed within N days after condition A, with median gap.',
  params: [P.concept, { name: 'windowDays', label: 'Window (days, V4)', type: 'number', default: 365, modes: ['v4'] }, P.topN],
  v1: (a, c) => [S('pairs', 'Condition pairs co-mentioned in text', (q) => `${c.with}, ${conceptCte(q, entriesOf(T.CONDITIONS))},
      pc AS (SELECT DISTINCT patient_id, key, label FROM (${hitsSql(['dx', 'en'])}) h),
      cnt AS (SELECT key, count(*) AS c FROM pc GROUP BY key)
      ${pairSql('pc', '(SELECT count(*) FROM p)')}`)],
  v3: (a, c) => [S('pairs', 'Condition-code pairs among the most common codes', () => `${c.with},
      top AS (SELECT code FROM dx GROUP BY code ORDER BY count(DISTINCT patient_id) DESC LIMIT ${num(a.topN, 10)}),
      pc AS (SELECT patient_id, code AS key, COALESCE(max(${DISPLAY}), code) AS label FROM dx WHERE code IN (SELECT code FROM top) GROUP BY patient_id, code),
      cnt AS (SELECT key, count(*) AS c FROM pc GROUP BY key)
      ${pairSql('pc', '(SELECT count(*) FROM p)')}`)],
  v4: (a, c) => [S('ordered_pairs', `B diagnosed within ${num(a.windowDays, 365)} days after A`, () => `${c.with},
      top AS (SELECT code FROM dx GROUP BY code ORDER BY count(DISTINCT patient_id) DESC LIMIT ${num(a.topN, 10)}),
      fo AS (SELECT patient_id, code, min(onset_date) AS d, COALESCE(max(${DISPLAY}), code) AS label FROM dx WHERE onset_date IS NOT NULL AND code IN (SELECT code FROM top) GROUP BY patient_id, code),
      cnt AS (SELECT code, count(*) AS c FROM fo GROUP BY code)
      SELECT a.label AS first_condition, b.label AS then_condition, count(*)::int AS patients, ca.c::int AS patients_with_first,
        ${pct('count(*)', 'ca.c')} AS pct_of_first, percentile_cont(0.5) WITHIN GROUP (ORDER BY (b.d - a.d)::float8)::float8 AS median_days_gap
      FROM fo a JOIN fo b ON a.patient_id = b.patient_id AND a.code <> b.code AND b.d > a.d AND b.d <= a.d + ${num(a.windowDays, 365)}
      JOIN cnt ca ON ca.code = a.code ${cond(a) ? `WHERE a.code = '${cond(a).code}'` : ''}
      GROUP BY a.label, b.label, ca.c ORDER BY patients DESC LIMIT 25`)]
});

// ---- 6. Treatment patterns ----------------------------------------------------
const tm = (a, c) => { const fl = (c && c.firstLine) || T.TREATMENT_MAP; const k = Object.hasOwn(fl, a.concept) ? a.concept : 'diabetes'; if (!fl[k] || !fl[k].length) { const e = new Error(`No first-line drug is left for ${T.CONDITIONS[k].display} (all were rejected in the review table)`); e.status = 400; throw e; } return { key: k, c: T.CONDITIONS[k], meds: fl[k].map(m => ({ key: m, ...T.MEDICATIONS[m] })) }; };
const medValues = (q, meds) => `mv(code,label) AS (VALUES ${meds.map(m => `(${q.add(m.code, 'text')},${q.add(m.display, 'text')})`).join(',')})`;
def({
  id: 'treatment_patterns', category: 'Medications', title: 'Treatment patterns (condition to first-line drugs)',
  description: 'Share of patients with a condition who receive the expected first-line drugs. V4 adds time from diagnosis to first prescription and flags drugs started before the diagnosis.',
  params: [{ name: 'concept', label: 'Condition', type: 'select', options: () => Object.keys(T.TREATMENT_MAP).map(k => ({ value: k, label: T.CONDITIONS[k].display })), default: 'diabetes' }],
  v1: (a, c) => { const t = tm(a, c); return [S('by_drug', `${t.c.display}: patients with first-line drug mentioned`, (q) => `${c.with}, ${conceptCte(q, [{ key: t.key, label: t.c.display, terms: t.c.terms }])},
      cp AS (SELECT DISTINCT patient_id FROM (${hitsSql(['dx', 'en'])}) h),
      concepts2 AS (SELECT * FROM (VALUES ${t.meds.map(m => `(${q.add(m.key, 'text')},${q.add(m.display, 'text')},${q.add(POS(m.terms), 'text')},${q.add(NEG(m.terms), 'text')})`).join(',')}) v(key,label,pos,neg)),
      rp AS (SELECT DISTINCT r.patient_id, c.label FROM (SELECT patient_id, ${TXT.rx} AS txt FROM rx) r JOIN concepts2 c ON r.txt ~* c.pos AND r.txt !~* c.neg WHERE r.patient_id IN (SELECT patient_id FROM cp))
      SELECT label AS drug, count(*)::int AS patients_on_drug, (SELECT count(*) FROM cp)::int AS patients_with_condition, ${pct('count(*)', '(SELECT count(*) FROM cp)')} AS pct FROM rp GROUP BY label
      UNION ALL SELECT 'ANY first-line drug', count(DISTINCT patient_id)::int, (SELECT count(*) FROM cp)::int, ${pct('count(DISTINCT patient_id)', '(SELECT count(*) FROM cp)')} FROM rp ORDER BY patients_on_drug DESC`)]; },
  v3: (a, c) => { const t = tm(a, c); return [S('by_drug', `${t.c.display}: patients with first-line drug codes`, (q) => `${c.with}, ${medValues(q, t.meds)},
      cp AS (SELECT DISTINCT patient_id FROM dx WHERE code = ${q.add(t.c.code, 'text')}),
      rp AS (SELECT DISTINCT patient_id, code FROM rx WHERE code IN (SELECT code FROM mv) AND patient_id IN (SELECT patient_id FROM cp))
      SELECT mv.label AS drug, count(rp.patient_id)::int AS patients_on_drug, (SELECT count(*) FROM cp)::int AS patients_with_condition, ${pct('count(rp.patient_id)', '(SELECT count(*) FROM cp)')} AS pct FROM mv LEFT JOIN rp ON rp.code = mv.code GROUP BY mv.label
      UNION ALL SELECT 'ANY first-line drug', count(DISTINCT patient_id)::int, (SELECT count(*) FROM cp)::int, ${pct('count(DISTINCT patient_id)', '(SELECT count(*) FROM cp)')} FROM rp ORDER BY patients_on_drug DESC`)]; },
  v4: (a, c) => { const t = tm(a, c); return [
    S('time_to_treatment', `${t.c.display}: time from first diagnosis to first first-line prescription`, (q) => `${c.with}, ${medValues(q, t.meds)},
      fd AS (SELECT patient_id, min(onset_date) AS d FROM dx WHERE code = ${q.add(t.c.code, 'text')} AND onset_date IS NOT NULL GROUP BY patient_id),
      fr AS (SELECT patient_id, min(prescribed_date::date) AS d FROM rx WHERE code IN (SELECT code FROM mv) AND prescribed_date IS NOT NULL GROUP BY patient_id),
      j AS (SELECT fd.patient_id, (fr.d - fd.d) AS lag FROM fd LEFT JOIN fr ON fr.patient_id = fd.patient_id)
      SELECT count(*)::int AS patients_with_condition, count(lag)::int AS ever_treated, ${pct('count(lag)', 'count(*)')} AS pct_treated,
        count(*) FILTER (WHERE lag < 0)::int AS treated_before_diagnosis,
        ${pct('count(*) FILTER (WHERE lag BETWEEN 0 AND 30)', 'count(*)')} AS pct_within_30d, ${pct('count(*) FILTER (WHERE lag BETWEEN 0 AND 90)', 'count(*)')} AS pct_within_90d, ${pct('count(*) FILTER (WHERE lag BETWEEN 0 AND 365)', 'count(*)')} AS pct_within_365d,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY lag) FILTER (WHERE lag >= 0)::float8 AS median_days_to_treatment,
        percentile_cont(0.25) WITHIN GROUP (ORDER BY lag) FILTER (WHERE lag >= 0)::float8 AS p25_days, percentile_cont(0.75) WITHIN GROUP (ORDER BY lag) FILTER (WHERE lag >= 0)::float8 AS p75_days
      FROM j`),
    S('by_drug', 'Time to first prescription by drug', (q) => `${c.with}, ${medValues(q, t.meds)},
      fd AS (SELECT patient_id, min(onset_date) AS d FROM dx WHERE code = ${q.add(t.c.code, 'text')} AND onset_date IS NOT NULL GROUP BY patient_id)
      SELECT mv.label AS drug, count(*)::int AS patients, percentile_cont(0.5) WITHIN GROUP (ORDER BY (f.d - fd.d)::float8)::float8 AS median_days_from_diagnosis
      FROM (SELECT patient_id, code, min(prescribed_date::date) AS d FROM rx WHERE prescribed_date IS NOT NULL GROUP BY 1,2) f
      JOIN fd ON fd.patient_id = f.patient_id JOIN mv ON mv.code = f.code GROUP BY mv.label ORDER BY patients DESC`)]; }
});

// ---- 7. Encounter utilization ----------------------------------------------------
def({
  id: 'encounter_utilization', category: 'Utilization', title: 'Encounter utilization & readmissions',
  description: 'V1: visit type inferred from note text and top visit reasons. V3: encounters, patients and length of stay by encounter class. V4: yearly volumes, ED visits per 1,000 patients, and 30-day readmission rate.',
  params: [],
  v1: (a, c) => [
    S('visit_type', 'Visit type inferred from note text', () => `${c.with}, t AS (SELECT patient_id, ${TXT.en} AS txt FROM en)
      SELECT CASE WHEN txt ~* '\\m(emergency|er|ed)\\M' THEN 'Emergency' WHEN txt ~* 'inpatient|admission|admitted|hospital' THEN 'Inpatient' WHEN txt ~* 'clinic|office|ambulatory|follow' THEN 'Ambulatory' ELSE 'Unclassified' END AS visit_type,
        count(*)::int AS encounters, count(DISTINCT patient_id)::int AS patients FROM t GROUP BY 1 ORDER BY encounters DESC`),
    S('reasons', 'Top visit reasons (free text)', () => `${c.with}
      SELECT lower(j->'reasonCode'->0->>'text') AS reason, count(*)::int AS encounters, count(DISTINCT patient_id)::int AS patients FROM en WHERE j->'reasonCode'->0->>'text' IS NOT NULL GROUP BY 1 ORDER BY encounters DESC LIMIT 15`)],
  v3: (a, c) => [S('by_class', 'Encounters by class code', () => `${c.with}
      SELECT COALESCE(cls,'unknown') AS class_code, count(*)::int AS encounters, count(DISTINCT patient_id)::int AS patients, round(count(*)::numeric/count(DISTINCT patient_id),1)::float8 AS encounters_per_patient,
        round(avg(EXTRACT(EPOCH FROM (end_date - start_date))/86400)::numeric,2)::float8 AS avg_length_days FROM en GROUP BY cls ORDER BY encounters DESC`)],
  v4: (a, c) => [
    S('by_year', 'Encounters per year by class', () => `${c.with}
      SELECT EXTRACT(YEAR FROM start_date)::int AS year, COALESCE(cls,'unknown') AS class_code, count(*)::int AS encounters, count(DISTINCT patient_id)::int AS patients,
        round(avg(EXTRACT(EPOCH FROM (end_date - start_date))/86400)::numeric,2)::float8 AS avg_length_days
      FROM en WHERE start_date IS NOT NULL GROUP BY 1,2 ORDER BY 1,2`),
    S('ed_rate', 'Emergency visits per 1,000 active patients', () => `${c.with}
      SELECT EXTRACT(YEAR FROM start_date)::int AS year, count(*) FILTER (WHERE cls = 'EMER')::int AS ed_visits, count(DISTINCT patient_id)::int AS active_patients,
        round(1000.0*count(*) FILTER (WHERE cls = 'EMER')/NULLIF(count(DISTINCT patient_id),0),1)::float8 AS ed_visits_per_1000
      FROM en WHERE start_date IS NOT NULL GROUP BY 1 ORDER BY 1`),
    S('readmission', '30-day all-cause inpatient readmission by discharge year', () => `${c.with},
      imp AS (SELECT patient_id, start_date, end_date FROM en WHERE cls = 'IMP' AND end_date IS NOT NULL)
      SELECT EXTRACT(YEAR FROM a.end_date)::int AS year, count(*)::int AS discharges,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM imp b WHERE b.patient_id = a.patient_id AND b.start_date > a.end_date AND b.start_date <= a.end_date + interval '30 days'))::int AS readmissions_30d,
        ${pct(`count(*) FILTER (WHERE EXISTS (SELECT 1 FROM imp b WHERE b.patient_id = a.patient_id AND b.start_date > a.end_date AND b.start_date <= a.end_date + interval '30 days'))`, 'count(*)')} AS readmission_rate_pct
      FROM imp a GROUP BY 1 ORDER BY 1`)]
});

// ---- 8. Chronic disease control ----------------------------------------------
const cm = a => T.CONTROL_MEASURES[a.measure] || T.CONTROL_MEASURES.diabetes_hba1c;
function controlBase(mode, q, a) {
  const m = cm(a), c0 = T.CONDITIONS[m.condition], l = T.LABS[m.lab];
  if (mode === 'v1') return `${conceptCte(q, [{ key: m.condition, label: c0.display, terms: c0.terms }])},
    cp AS (SELECT DISTINCT patient_id FROM (${hitsSql(['dx', 'en'])}) h),
    obs AS (SELECT patient_id, value::float8 AS v, effective_date FROM ob WHERE value IS NOT NULL AND patient_id IN (SELECT patient_id FROM cp) AND ${TXT.ob} ~* ${q.add(POS(l.terms), 'text')} AND ${TXT.ob} !~* ${q.add(NEG(l.terms), 'text')})`;
  return `cp AS (SELECT DISTINCT patient_id FROM dx WHERE code = ${q.add(c0.code, 'text')}),
    obs AS (SELECT patient_id, value::float8 AS v, effective_date FROM ob WHERE value IS NOT NULL AND patient_id IN (SELECT patient_id FROM cp) AND code = ${q.add(l.code, 'text')})`;
}
const controlParams = [{ name: 'measure', label: 'Measure', type: 'select', options: () => Object.entries(T.CONTROL_MEASURES).map(([k, v]) => ({ value: k, label: v.label })), default: 'diabetes_hba1c' }];
const controlSummary = (m) => `pv AS (SELECT patient_id, avg(v) AS mean_v FROM obs GROUP BY patient_id)
  SELECT (SELECT count(*) FROM cp)::int AS patients_with_condition, count(*)::int AS patients_tested, ${pct('count(*)', '(SELECT count(*) FROM cp)')} AS pct_tested,
    count(*) FILTER (WHERE mean_v < ${m.goalBelow})::int AS at_goal, ${pct(`count(*) FILTER (WHERE mean_v < ${m.goalBelow})`, 'count(*)')} AS pct_at_goal_of_tested,
    ${pct(`count(*) FILTER (WHERE mean_v >= ${m.poorAtOrAbove})`, 'count(*)')} AS pct_poor_control_of_tested, round(avg(mean_v)::numeric,2)::float8 AS mean_of_patient_means FROM pv`;
def({
  id: 'chronic_control', category: 'Quality measures', title: 'Chronic disease control',
  description: 'Is the disease controlled? V1/V3 judge each patient by the mean of all their results (no dates). V4 uses the latest result in the last 12 months, control rate by year, and the gap between tests.',
  params: controlParams,
  v1: (a, c) => [S('summary', `${cm(a).label} (mean of all results; condition and test found in text)`, (q) => `${c.with}, ${controlBase('v1', q, a)}, ${controlSummary(cm(a))}`)],
  v3: (a, c) => [S('summary', `${cm(a).label} (mean of all results; coded)`, (q) => `${c.with}, ${controlBase('v3', q, a)}, ${controlSummary(cm(a))}`)],
  v4: (a, c) => { const m = cm(a); return [
    S('last_12_months', `${m.label}: latest result within 12 months of the as-of date`, (q) => `${c.with}, ${controlBase('v3', q, a)},
      lst AS (SELECT DISTINCT ON (patient_id) patient_id, v, effective_date::date AS d FROM obs WHERE effective_date IS NOT NULL ORDER BY patient_id, effective_date DESC)
      SELECT (SELECT count(*) FROM cp)::int AS patients_with_condition, count(*) FILTER (WHERE d >= (SELECT d FROM ref) - 365)::int AS tested_last_12m,
        ${pct('count(*) FILTER (WHERE d >= (SELECT d FROM ref) - 365)', '(SELECT count(*) FROM cp)')} AS pct_tested_last_12m,
        count(*) FILTER (WHERE d >= (SELECT d FROM ref) - 365 AND v < ${m.goalBelow})::int AS at_goal,
        ${pct(`count(*) FILTER (WHERE d >= (SELECT d FROM ref) - 365 AND v < ${m.goalBelow})`, '(SELECT count(*) FROM cp)')} AS pct_at_goal_of_all,
        ${pct(`count(*) FILTER (WHERE d >= (SELECT d FROM ref) - 365 AND v >= ${m.poorAtOrAbove})`, 'count(*) FILTER (WHERE d >= (SELECT d FROM ref) - 365)')} AS pct_poor_of_tested
      FROM lst`),
    S('by_year', 'Control rate by year (last result of the year per patient)', (q) => `${c.with}, ${controlBase('v3', q, a)},
      ly AS (SELECT DISTINCT ON (patient_id, EXTRACT(YEAR FROM effective_date)) patient_id, EXTRACT(YEAR FROM effective_date)::int AS year, v FROM obs WHERE effective_date IS NOT NULL ORDER BY patient_id, EXTRACT(YEAR FROM effective_date), effective_date DESC)
      SELECT year, count(*)::int AS patients_tested, count(*) FILTER (WHERE v < ${m.goalBelow})::int AS at_goal, ${pct(`count(*) FILTER (WHERE v < ${m.goalBelow})`, 'count(*)')} AS pct_at_goal FROM ly GROUP BY year ORDER BY year`),
    S('testing_interval', 'Days between consecutive tests', (q) => `${c.with}, ${controlBase('v3', q, a)},
      g AS (SELECT patient_id, effective_date::date - lag(effective_date::date) OVER (PARTITION BY patient_id ORDER BY effective_date) AS gap FROM obs WHERE effective_date IS NOT NULL)
      SELECT count(gap)::int AS intervals, percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)::float8 AS median_days, percentile_cont(0.9) WITHIN GROUP (ORDER BY gap)::float8 AS p90_days, ${pct('count(*) FILTER (WHERE gap > 365)', 'count(gap)')} AS pct_gaps_over_1y FROM g`)]; }
});

// ---- 9. Preventive screening --------------------------------------------------
const sc = a => T.SCREENINGS[a.screen] || T.SCREENINGS.mammogram;
function elig(q, a) { const s = sc(a); return `elig AS (SELECT patient_id FROM p WHERE birth_date IS NOT NULL ${s.gender ? `AND gender = ${q.add(s.gender, 'text')}` : ''} AND EXTRACT(YEAR FROM age((SELECT d FROM ref), birth_date)) BETWEEN ${s.minAge} AND ${s.maxAge})`; }
const screenParams = [{ name: 'screen', label: 'Screening', type: 'select', options: () => Object.entries(T.SCREENINGS).map(([k, v]) => ({ value: k, label: v.label })), default: 'mammogram' }];
def({
  id: 'preventive_screening', category: 'Quality measures', title: 'Preventive screening / care gaps',
  description: 'Eligible patients (by age and sex) who were screened. V1 finds the procedure in text, V3 by code (ever screened), V4 only counts screening inside the recommended interval and lists overdue patients.',
  params: screenParams,
  v1: (a, c) => { const s = sc(a), pd = T.PROCEDURES[s.proc]; return [S('summary', s.label, (q) => `${c.with}, ${elig(q, a)},
      pr1 AS (SELECT DISTINCT patient_id FROM (SELECT patient_id, ${TXT.pr} AS txt FROM pr) t WHERE txt ~* ${q.add(POS(pd.terms), 'text')} AND txt !~* ${q.add(NEG(pd.terms), 'text')})
      SELECT (SELECT count(*) FROM elig)::int AS eligible, count(*)::int AS ever_screened, ${pct('count(*)', '(SELECT count(*) FROM elig)')} AS pct_screened FROM pr1 WHERE patient_id IN (SELECT patient_id FROM elig)`)]; },
  v3: (a, c) => { const s = sc(a); return [S('summary', s.label, (q) => `${c.with}, ${elig(q, a)},
      pr1 AS (SELECT DISTINCT patient_id FROM pr WHERE code = ${q.add(T.PROCEDURES[s.proc].code, 'text')})
      SELECT (SELECT count(*) FROM elig)::int AS eligible, count(*)::int AS ever_screened, ${pct('count(*)', '(SELECT count(*) FROM elig)')} AS pct_screened FROM pr1 WHERE patient_id IN (SELECT patient_id FROM elig)`)]; },
  v4: (a, c) => { const s = sc(a); const last = (q) => `${elig(q, a)}, lastp AS (SELECT patient_id, max(performed_date::date) AS d FROM pr WHERE code = ${q.add(T.PROCEDURES[s.proc].code, 'text')} AND performed_date IS NOT NULL GROUP BY patient_id)`; return [
    S('summary', `${s.label}: screened within ${s.windowYears} year(s) of the as-of date`, (q) => `${c.with}, ${last(q)}
      SELECT (SELECT count(*) FROM elig)::int AS eligible,
        count(*) FILTER (WHERE l.d >= (SELECT d FROM ref) - ${Math.round(s.windowYears * 365.25)})::int AS up_to_date,
        count(*) FILTER (WHERE l.d < (SELECT d FROM ref) - ${Math.round(s.windowYears * 365.25)})::int AS overdue,
        ((SELECT count(*) FROM elig) - count(l.d))::int AS never_screened,
        ${pct(`count(*) FILTER (WHERE l.d >= (SELECT d FROM ref) - ${Math.round(s.windowYears * 365.25)})`, '(SELECT count(*) FROM elig)')} AS pct_up_to_date,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY ((SELECT d FROM ref) - l.d)) / 365.25)::numeric,1)::float8 AS median_years_since_last
      FROM elig e LEFT JOIN lastp l ON l.patient_id = e.patient_id`),
    S('by_year', 'Eligible patients screened per year', (q) => `${c.with}, ${elig(q, a)}
      SELECT EXTRACT(YEAR FROM performed_date)::int AS year, count(DISTINCT patient_id)::int AS patients_screened FROM pr
      WHERE code = ${q.add(T.PROCEDURES[s.proc].code, 'text')} AND performed_date IS NOT NULL AND patient_id IN (SELECT patient_id FROM elig) GROUP BY 1 ORDER BY 1`)]; }
});

// ---- 10. Polypharmacy -------------------------------------------------------------
const thr = a => Math.max(2, num(a.threshold, 5));
const distSql = (src) => `SELECT n::text || CASE WHEN n >= 8 THEN '+' ELSE '' END AS count_per_patient, count(*)::int AS patients FROM (SELECT LEAST(n, 8) AS n FROM ${src}) s GROUP BY n ORDER BY n`;
const polyParams = [{ name: 'threshold', label: 'Polypharmacy threshold (drugs)', type: 'number', default: 5 }];
// Risky pairs (Step D.8c): the dictionary seed (T.RISKY_PAIRS), then reviewer decisions from concept_overrides (kind risky_pair):
// accepted/edited adds a pair (or updates the note of a seed pair), rejected removes it. Keys are medication dictionary keys or RxNorm codes.
// With no overrides the list equals the seed, in the same order. Pure function (also exported for tests).
const medOf = k => (typeof k === 'string' && Object.prototype.hasOwnProperty.call(T.MEDICATIONS, k)) ? T.MEDICATIONS[k] : null;
function riskyList(overrides = []) {
  const list = T.RISKY_PAIRS.filter(r => T.MEDICATIONS[r.a] && T.MEDICATIONS[r.b])
    .map(r => ({ a: T.MEDICATIONS[r.a].code, b: T.MEDICATIONS[r.b].code, da: T.MEDICATIONS[r.a].display, db: T.MEDICATIONS[r.b].display, note: r.note, from: 'dictionary' }));
  const pk = (x, y) => [x, y].sort().join('|');
  for (const o of overrides) {
    if (!o || o.kind !== 'risky_pair') continue;
    const ma = medOf(o.key), mb = medOf(o.key2), a = ma ? ma.code : o.key, b = mb ? mb.code : o.key2;
    if (!a || !b || a === b) continue;
    const at = list.findIndex(r => pk(r.a, r.b) === pk(a, b));
    if (o.decision === 'rejected') { if (at >= 0) list.splice(at, 1); continue; }
    const da = ma ? ma.display : a, db = mb ? mb.display : b;
    const note = (o.note || o.label || '').trim() || `Reviewer-accepted risky pair (${da} + ${db})`;
    if (at >= 0) { if (o.note || o.label) list[at].note = note; list[at].from = 'reviewer'; }
    else list.push({ a, b, da, db, note, from: 'reviewer' });
  }
  return list;
}
// Chronic list and first-line map (Step D.8d): same rule as the risky pairs (override, then seed). Pure functions (also exported for tests).
// Keys are dictionary keys or raw codes. chronic: accepted/edited adds the code (unless the override says chronic = false), rejected removes it.
// first_line: key = condition, key2 = drug; both must resolve to terminologies in terminology.js (the text search and the labels need their terms),
// anything else is ignored. accepted/edited appends the drug as the LAST line, rejected removes it. With no overrides the results equal the seed.
const condOf = k => (typeof k === 'string' && Object.prototype.hasOwnProperty.call(T.CONDITIONS, k)) ? k : (typeof k === 'string' ? Object.keys(T.CONDITIONS).find(x => T.CONDITIONS[x].code === k) || null : null);
const medKeyOf = k => (typeof k === 'string' && Object.prototype.hasOwnProperty.call(T.MEDICATIONS, k)) ? k : (typeof k === 'string' ? Object.keys(T.MEDICATIONS).find(x => T.MEDICATIONS[x].code === k) || null : null);
function chronicList(overrides = []) {
  const set = new Set(Object.values(T.CONDITIONS).filter(x => x.chronic).map(x => x.code));
  for (const o of overrides) {
    if (!o || o.kind !== 'chronic' || typeof o.key !== 'string' || !o.key) continue;
    const ck = condOf(o.key), code = ck ? T.CONDITIONS[ck].code : o.key;
    if (o.decision === 'rejected' || o.chronic === false) set.delete(code); else set.add(code);
  }
  return [...set];
}
function firstLineMap(overrides = []) {
  const map = {};
  for (const [k, v] of Object.entries(T.TREATMENT_MAP)) map[k] = v.slice();
  for (const o of overrides) {
    if (!o || o.kind !== 'first_line') continue;
    const ck = condOf(o.key), mk = medKeyOf(o.key2);
    if (!ck || !mk) continue;
    const list = map[ck] || (map[ck] = []), at = list.indexOf(mk);
    if (o.decision === 'rejected') { if (at >= 0) list.splice(at, 1); }
    else if (at < 0) list.push(mk);
  }
  return map;
}
// Lab limits (Step D.8e): reviewer limits per lab code. key = T.LABS dictionary key (the limit then applies only to results in that lab's dictionary unit)
// or a raw lab code (any unit). accepted/edited with at least one numeric limit sets it (later decision wins), rejected removes it. Abnormal = below low or above high.
// Pure function (also exported for tests).
function labLimitList(overrides = []) {
  const by = new Map();
  for (const o of overrides) {
    if (!o || o.kind !== 'lab_limit' || typeof o.key !== 'string' || !o.key) continue;
    const lab = Object.prototype.hasOwnProperty.call(T.LABS, o.key) ? T.LABS[o.key] : null, code = lab ? lab.code : o.key;
    const lo = Number.isFinite(Number(o.abnormal_low)) && o.abnormal_low !== null ? Number(o.abnormal_low) : null;
    const hi = Number.isFinite(Number(o.abnormal_high)) && o.abnormal_high !== null ? Number(o.abnormal_high) : null;
    if (o.decision === 'rejected' || (lo === null && hi === null)) { by.delete(code); continue; }
    by.set(code, { code, unit: lab && lab.unit ? lab.unit : null, lo, hi });
  }
  return [...by.values()];
}
const riskyValues = (q, c) => { const L = (c && c.risky) || riskyList([]); return `risky(a_code,b_code,note) AS (VALUES ${L.length ? L.map(r => `(${q.add(r.a, 'text')},${q.add(r.b, 'text')},${q.add(r.note, 'text')})`).join(',') : '(NULL::text,NULL::text,NULL::text)'})`; };
def({
  id: 'polypharmacy', category: 'Medications', title: 'Polypharmacy & risky combinations',
  description: 'Patients on many drugs and on known risky pairs (e.g. warfarin + aspirin). V1 counts distinct drugs named in text, V3 distinct RxNorm codes, V4 uses rolling 12-month windows and requires the pair within 90 days.',
  params: polyParams,
  v1: (a, c) => [
    S('distribution', 'Distinct drugs per patient (named in text)', (q) => `${c.with}, ${conceptCte(q, entriesOf(T.MEDICATIONS))},
      pp AS (SELECT patient_id, count(DISTINCT key) AS n FROM (${hitsSql(['rx'])}) h GROUP BY patient_id) ${distSql('pp')}`),
    S('summary', `Patients with ${thr(a)}+ drugs`, (q) => `${c.with}, ${conceptCte(q, entriesOf(T.MEDICATIONS))},
      pp AS (SELECT patient_id, count(DISTINCT key) AS n FROM (${hitsSql(['rx'])}) h GROUP BY patient_id)
      SELECT count(*)::int AS patients_on_any_drug, count(*) FILTER (WHERE n >= ${thr(a)})::int AS polypharmacy_patients, ${pct(`count(*) FILTER (WHERE n >= ${thr(a)})`, 'count(*)')} AS pct_polypharmacy FROM pp`)],
  v3: (a, c) => [
    S('distribution', 'Distinct drug codes per patient', () => `${c.with}, pp AS (SELECT patient_id, count(DISTINCT code) AS n FROM rx WHERE code IS NOT NULL GROUP BY patient_id) ${distSql('pp')}`),
    S('summary', `Patients with ${thr(a)}+ distinct drug codes`, () => `${c.with}, pp AS (SELECT patient_id, count(DISTINCT code) AS n FROM rx WHERE code IS NOT NULL GROUP BY patient_id)
      SELECT count(*)::int AS patients_on_any_drug, count(*) FILTER (WHERE n >= ${thr(a)})::int AS polypharmacy_patients, ${pct(`count(*) FILTER (WHERE n >= ${thr(a)})`, 'count(*)')} AS pct_polypharmacy FROM pp`),
    S('risky_pairs', 'Patients ever prescribed a risky pair', (q) => `${c.with}, ${riskyValues(q, c)}
      SELECT r.note, count(DISTINCT x.patient_id)::int AS patients FROM risky r JOIN rx x ON x.code = r.a_code JOIN rx y ON y.patient_id = x.patient_id AND y.code = r.b_code GROUP BY r.note, r.a_code, r.b_code ORDER BY patients DESC`)],
  v4: (a, c) => [
    S('summary', `Patients with ${thr(a)}+ distinct drugs in any rolling 365 days, and currently`, () => `${c.with},
      r AS (SELECT patient_id, code, prescribed_date::date AS d FROM rx WHERE prescribed_date IS NOT NULL AND code IS NOT NULL),
      w AS (SELECT a.patient_id, a.d, count(DISTINCT b.code) AS n FROM r a JOIN r b ON b.patient_id = a.patient_id AND b.d >= a.d AND b.d < a.d + 365 GROUP BY a.patient_id, a.d),
      pm AS (SELECT patient_id, max(n) AS maxn FROM w GROUP BY patient_id),
      cur AS (SELECT patient_id, count(DISTINCT code) AS n FROM r WHERE d >= (SELECT d FROM ref) - 365 GROUP BY patient_id)
      SELECT (SELECT count(*) FROM pm)::int AS patients_on_any_drug, (SELECT count(*) FROM pm WHERE maxn >= ${thr(a)})::int AS ever_polypharmacy_in_12m_window,
        ${pct(`(SELECT count(*) FROM pm WHERE maxn >= ${thr(a)})`, '(SELECT count(*) FROM pm)')} AS pct_ever,
        (SELECT count(*) FROM cur)::int AS patients_with_rx_last_12m, (SELECT count(*) FROM cur WHERE n >= ${thr(a)})::int AS currently_polypharmacy,
        ${pct(`(SELECT count(*) FROM cur WHERE n >= ${thr(a)})`, '(SELECT count(*) FROM cur)')} AS pct_current`),
    S('risky_pairs', 'Risky pairs prescribed within 90 days of each other', (q) => `${c.with}, ${riskyValues(q, c)}
      SELECT r.note, count(DISTINCT x.patient_id)::int AS patients FROM risky r JOIN rx x ON x.code = r.a_code JOIN rx y ON y.patient_id = x.patient_id AND y.code = r.b_code
      AND abs(y.prescribed_date::date - x.prescribed_date::date) <= 90 GROUP BY r.note, r.a_code, r.b_code ORDER BY patients DESC`)]
});

// ---- 11. Allergy profile & drug-allergy conflicts --------------------------------------
const ACODE = `j->'code'->'coding'->0->>'code'`;
const ADATE = `NULLIF(COALESCE(j->>'recordedDate', j->>'onsetDateTime'),'')::timestamp`;
def({
  id: 'allergy_profile', category: 'Safety', title: 'Allergy profile & drug-allergy conflicts',
  description: 'V1: allergens named in text. V3: patients per allergen code, severity, reactions, and penicillin-allergic patients ever prescribed amoxicillin. V4: new allergy records per year and conflicts where amoxicillin was prescribed AFTER the allergy was recorded.',
  params: [],
  v1: (a, c) => [S('allergens', 'Allergens named in text', (q) => `${c.with}, ${conceptCte(q, entriesOf(T.ALLERGENS))}, h AS (${hitsSql(['al'])})
      SELECT label AS allergen, count(DISTINCT patient_id)::int AS patients, ${pct('count(DISTINCT patient_id)', '(SELECT count(*) FROM p)')} AS pct_of_patients FROM h GROUP BY label ORDER BY patients DESC`),
    S('conflicts', 'Penicillin allergy in text and amoxicillin in medication text', (q) => `${c.with}, ${conceptCte(q, [{ key: 'pen', label: 'penicillin', terms: T.ALLERGENS.penicillin.terms }])},
      ap AS (SELECT DISTINCT patient_id FROM (SELECT patient_id, ${TXT.al} AS txt FROM al) t JOIN concepts c ON t.txt ~* c.pos AND t.txt !~* c.neg),
      rp AS (SELECT DISTINCT patient_id FROM (SELECT patient_id, ${TXT.rx} AS txt FROM rx) t WHERE txt ~* ${q.add(POS(T.MEDICATIONS.amoxicillin.terms), 'text')})
      SELECT (SELECT count(*) FROM ap)::int AS penicillin_allergic_patients, count(*)::int AS also_on_amoxicillin FROM rp WHERE patient_id IN (SELECT patient_id FROM ap)`)],
  v3: (a, c) => [
    S('allergens', 'Patients per allergen code with severity', () => `${c.with}
      SELECT ${ACODE} AS allergen_code, COALESCE(max(substance), '') AS allergen, count(DISTINCT patient_id)::int AS patients,
        count(*) FILTER (WHERE severity = 'severe')::int AS severe, ${pct("count(*) FILTER (WHERE severity = 'severe')", 'count(*)')} AS pct_severe
      FROM al GROUP BY 1 ORDER BY patients DESC`),
    S('reactions', 'Reaction and severity', () => `${c.with} SELECT COALESCE(reaction,'unknown') AS reaction, COALESCE(severity,'unknown') AS severity, count(*)::int AS records FROM al GROUP BY 1,2 ORDER BY records DESC`),
    S('conflicts', 'Penicillin-allergic patients ever prescribed amoxicillin (no dates)', (q) => `${c.with},
      ap AS (SELECT DISTINCT patient_id FROM al WHERE ${ACODE} = ${q.add(T.ALLERGENS.penicillin.code, 'text')})
      SELECT (SELECT count(*) FROM ap)::int AS penicillin_allergic_patients, count(DISTINCT patient_id)::int AS also_on_amoxicillin FROM rx WHERE code = ${q.add(T.MEDICATIONS.amoxicillin.code, 'text')} AND patient_id IN (SELECT patient_id FROM ap)`)],
  v4: (a, c) => [
    S('by_year', 'New allergy records per year by severity', () => `${c.with}
      SELECT EXTRACT(YEAR FROM ${ADATE})::int AS year, COALESCE(severity,'unknown') AS severity, count(*)::int AS records FROM al WHERE ${ADATE} IS NOT NULL GROUP BY 1,2 ORDER BY 1,2`),
    S('conflicts', 'Amoxicillin prescribed AFTER a penicillin allergy was recorded', (q) => `${c.with},
      ap AS (SELECT patient_id, min(${ADATE}) AS recorded FROM al WHERE ${ACODE} = ${q.add(T.ALLERGENS.penicillin.code, 'text')} GROUP BY patient_id),
      cf AS (SELECT DISTINCT r.patient_id FROM rx r JOIN ap ON ap.patient_id = r.patient_id WHERE r.code = ${q.add(T.MEDICATIONS.amoxicillin.code, 'text')} AND r.prescribed_date > ap.recorded)
      SELECT (SELECT count(*) FROM ap)::int AS penicillin_allergic_patients, (SELECT count(*) FROM cf)::int AS true_conflicts, ${pct('(SELECT count(*) FROM cf)', '(SELECT count(*) FROM ap)')} AS pct_conflict`)]
});

// ---- 12. Procedure volume ----------------------------------------------------------------
def({
  id: 'procedure_volume', category: 'Utilization', title: 'Procedure volume',
  description: 'V1: procedures named in text. V3: procedures per code. V4: yearly volume and median age at procedure.',
  params: [P.term, P.code, P.topN],
  v1: (a, c) => [S('procedures', 'Procedures mentioned in text', (q) => `${c.with}, ${conceptCte(q, customOr(a, entriesOf(T.PROCEDURES)))}, h AS (${hitsSql(['pr'])})
      SELECT label AS procedure, count(DISTINCT patient_id)::int AS patients, count(*)::int AS records FROM h GROUP BY label ORDER BY patients DESC`)],
  v3: (a, c) => [S('procedures', 'Procedures per code', (q) => `${c.with}
      SELECT code, COALESCE(max(${DISPLAY}), max(j->'code'->>'text')) AS display, count(DISTINCT patient_id)::int AS patients, count(*)::int AS procedures FROM pr ${a.code ? `WHERE code = ANY(${q.add(codesOf(a), 'text[]')})` : ''} GROUP BY code ORDER BY patients DESC LIMIT ${num(a.topN, 10)}`)],
  v4: (a, c) => [
    S('by_year', 'Procedures per year', (q) => `${c.with}, top AS (SELECT code FROM pr GROUP BY code ORDER BY count(*) DESC LIMIT ${num(a.topN, 6)})
      SELECT code, EXTRACT(YEAR FROM performed_date)::int AS year, count(*)::int AS procedures, count(DISTINCT patient_id)::int AS patients FROM pr
      WHERE performed_date IS NOT NULL AND code IN (SELECT code FROM top) ${a.code ? `AND code = ANY(${q.add(codesOf(a), 'text[]')})` : ''} GROUP BY 1,2 ORDER BY 1,2`),
    S('age_at_procedure', 'Median age at procedure', () => `${c.with}
      SELECT pr.code, count(*)::int AS procedures, percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(YEAR FROM age(pr.performed_date, p.birth_date)))::float8 AS median_age
      FROM pr JOIN p ON p.patient_id = pr.patient_id WHERE pr.performed_date IS NOT NULL AND p.birth_date IS NOT NULL GROUP BY pr.code ORDER BY procedures DESC LIMIT ${num(a.topN, 10)}`)]
});

// ---- 13. Multimorbidity -----------------------------------------------------------------------
const chronicCodes = Object.values(T.CONDITIONS).filter(x => x.chronic).map(x => x.code);
const chronicOf = c => (c && c.chronic) || chronicCodes; // Step D.8d: reviewed list from the run context, else the seed
const mmSummary = `SELECT count(*)::int AS patients, round(avg(n)::numeric,2)::float8 AS mean_chronic_conditions, ${pct('count(*) FILTER (WHERE n >= 2)', 'count(*)')} AS pct_2plus, ${pct('count(*) FILTER (WHERE n >= 3)', 'count(*)')} AS pct_3plus FROM pp`;
def({
  id: 'multimorbidity', category: 'Conditions', title: 'Multimorbidity burden',
  description: 'Number of chronic conditions per patient. V1 counts conditions found in text, V3 distinct chronic codes, V4 shows accrual over time and the gap between first and second chronic diagnosis.',
  params: [],
  v1: (a, c) => { const pp = (q) => `${conceptCte(q, entriesOf(T.CONDITIONS, (k, v) => chronicOf(c).includes(v.code)))}, hh AS (${hitsSql(['dx', 'en'])}), pp AS (SELECT p.patient_id, count(DISTINCT hh.key) AS n FROM p LEFT JOIN hh ON hh.patient_id = p.patient_id GROUP BY p.patient_id)`; return [
    S('distribution', 'Chronic conditions per patient (from text)', (q) => `${c.with}, ${pp(q)} ${distSql('pp')}`), S('summary', 'Summary', (q) => `${c.with}, ${pp(q)} ${mmSummary}`)]; },
  v3: (a, c) => { const pp = (q) => `pp AS (SELECT p.patient_id, count(DISTINCT dx.code) FILTER (WHERE dx.code = ANY(${q.add(chronicOf(c), 'text[]')})) AS n FROM p LEFT JOIN dx ON dx.patient_id = p.patient_id GROUP BY p.patient_id)`; return [
    S('distribution', 'Distinct chronic condition codes per patient', (q) => `${c.with}, ${pp(q)} ${distSql('pp')}`), S('summary', 'Summary', (q) => `${c.with}, ${pp(q)} ${mmSummary}`)]; },
  v4: (a, c) => { const fo = (q) => `fo AS (SELECT patient_id, code, min(onset_date) AS d FROM dx WHERE onset_date IS NOT NULL AND code = ANY(${q.add(chronicOf(c), 'text[]')}) GROUP BY patient_id, code)`; return [
    S('accrual', 'Patients with 2+ and 3+ chronic conditions at the end of each year', (q) => `${c.with}, ${fo(q)},
      yrs AS (SELECT generate_series((SELECT EXTRACT(YEAR FROM min(d))::int FROM fo), EXTRACT(YEAR FROM (SELECT d FROM ref))::int) AS y),
      pyn AS (SELECT yrs.y, p.patient_id, count(fo.code) AS n FROM yrs CROSS JOIN p LEFT JOIN fo ON fo.patient_id = p.patient_id AND fo.d <= make_date(yrs.y,12,31) GROUP BY yrs.y, p.patient_id)
      SELECT y AS year, count(*) FILTER (WHERE n >= 1)::int AS with_1plus, count(*) FILTER (WHERE n >= 2)::int AS with_2plus, count(*) FILTER (WHERE n >= 3)::int AS with_3plus, ${pct('count(*) FILTER (WHERE n >= 2)', 'count(*)')} AS pct_2plus FROM pyn GROUP BY y ORDER BY y`),
    S('second_condition', 'Time from first to second chronic diagnosis', (q) => `${c.with}, ${fo(q)},
      rk AS (SELECT patient_id, d, row_number() OVER (PARTITION BY patient_id ORDER BY d, code) AS rn FROM fo),
      two AS (SELECT a.patient_id, a.d AS d1, b.d AS d2 FROM rk a JOIN rk b ON a.patient_id = b.patient_id AND a.rn = 1 AND b.rn = 2)
      SELECT count(*)::int AS patients_with_2plus, percentile_cont(0.5) WITHIN GROUP (ORDER BY ((two.d2 - two.d1)/365.25)::float8)::float8 AS median_years_between_1st_and_2nd,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(YEAR FROM age(two.d2, p.birth_date)))::float8 AS median_age_at_2nd FROM two JOIN p ON p.patient_id = two.patient_id`)]; }
});

// ---- 14. Data quality -----------------------------------------------------------------------
const TBL = { dx: 'diagnoses', ob: 'observations', rx: 'medications', pr: 'procedures', en: 'encounters', al: 'allergies' };
const allT = f => Object.keys(TBL).map(t => f(t)).join(' UNION ALL ');
def({
  id: 'data_quality', category: 'Data quality', title: 'Data quality & completeness',
  description: 'How usable is the data for each method? V1: narrative text coverage. V3: coding coverage and unrecognised code systems. V4: date completeness, date range, and impossible dates.',
  params: [],
  v1: (a, c) => [S('text_coverage', 'Records with usable narrative text', () => `${c.with} ${allT(t => `SELECT '${TBL[t]}' AS resource, count(*)::int AS records, count(*) FILTER (WHERE length(trim(${TXT[t]})) > 0)::int AS with_text, ${pct(`count(*) FILTER (WHERE length(trim(${TXT[t]})) > 0)`, 'count(*)')} AS pct_with_text, round(avg(length(${TXT[t]}))::numeric,0)::float8 AS avg_text_length FROM ${t}`)}`)],
  v3: (a, c) => [
    S('coding_coverage', 'Records with a code', () => `${c.with}
      SELECT 'diagnoses' AS resource, count(*)::int AS records, count(code)::int AS coded, ${pct('count(code)', 'count(*)')} AS pct_coded, count(DISTINCT code)::int AS distinct_codes, count(*) FILTER (WHERE code_system ~* 'snomed|icd|loinc|rxnorm')::int AS recognised_system FROM dx
      UNION ALL SELECT 'observations', count(*)::int, count(code)::int, ${pct('count(code)', 'count(*)')}, count(DISTINCT code)::int, count(*) FILTER (WHERE code_system ~* 'snomed|icd|loinc|rxnorm')::int FROM ob
      UNION ALL SELECT 'medications', count(*)::int, count(code)::int, ${pct('count(code)', 'count(*)')}, count(DISTINCT code)::int, NULL FROM rx
      UNION ALL SELECT 'procedures', count(*)::int, count(code)::int, ${pct('count(code)', 'count(*)')}, count(DISTINCT code)::int, NULL FROM pr`),
    S('unrecognised_systems', 'Code systems that are not SNOMED / ICD / LOINC / RxNorm', () => `${c.with}
      SELECT COALESCE(code_system,'(none)') AS code_system, count(*)::int AS records FROM (SELECT code_system FROM dx UNION ALL SELECT code_system FROM ob) s
      WHERE code_system IS NULL OR code_system !~* 'snomed|icd|loinc|rxnorm' GROUP BY 1 ORDER BY records DESC LIMIT 10`)],
  v4: (a, c) => [
    S('date_quality', 'Date completeness and impossible dates', () => `${c.with},
      d AS (SELECT 'diagnoses' AS resource, patient_id, onset_date::timestamp AS dt FROM dx UNION ALL SELECT 'observations', patient_id, effective_date FROM ob UNION ALL SELECT 'medications', patient_id, prescribed_date FROM rx
        UNION ALL SELECT 'procedures', patient_id, performed_date FROM pr UNION ALL SELECT 'encounters', patient_id, start_date FROM en)
      SELECT d.resource, count(*)::int AS records, count(d.dt)::int AS with_date, ${pct('count(d.dt)', 'count(*)')} AS pct_dated, min(d.dt)::date AS earliest, max(d.dt)::date AS latest,
        count(*) FILTER (WHERE d.dt < p.birth_date)::int AS before_birth, count(*) FILTER (WHERE d.dt > now())::int AS in_future
      FROM d LEFT JOIN p ON p.patient_id = d.patient_id GROUP BY d.resource ORDER BY d.resource`),
    S('end_before_start', 'Encounters ending before they start', () => `${c.with} SELECT count(*)::int AS encounters, count(*) FILTER (WHERE end_date < start_date)::int AS end_before_start FROM en`),
    S('coverage_by_year', 'Records per year', () => `${c.with},
      d AS (SELECT 'diagnoses' AS t, onset_date::timestamp AS dt FROM dx UNION ALL SELECT 'observations', effective_date FROM ob UNION ALL SELECT 'medications', prescribed_date FROM rx UNION ALL SELECT 'procedures', performed_date FROM pr UNION ALL SELECT 'encounters', start_date FROM en)
      SELECT EXTRACT(YEAR FROM dt)::int AS year, count(*) FILTER (WHERE t='diagnoses')::int AS diagnoses, count(*) FILTER (WHERE t='observations')::int AS observations, count(*) FILTER (WHERE t='medications')::int AS medications,
        count(*) FILTER (WHERE t='procedures')::int AS procedures, count(*) FILTER (WHERE t='encounters')::int AS encounters FROM d WHERE dt IS NOT NULL GROUP BY 1 ORDER BY 1`)]
});

const METHOD_INFO = {
  v1: 'V1 - Text matching: searches narratives and display text. No codes or dates are used; synonyms and simple negations ("denies", "no history of") are handled, nothing else.',
  v3: 'V3 - Code based: uses SNOMED CT / LOINC / RxNorm identifiers on the standardized tables. No dates are used.',
  v4: 'V4 - Code + temporality: codes combined with onset / effective / prescribed / encounter dates (incidence, windows, time-to-event, trends).'
};

const EXT = require('./analytics-ext')({ def, P, S, Q, T, pct, num, validDate, codesOf, bandCase, RACE, ETHN, ombPath, hitsSql, conceptCte, entriesOf, customOr, TXT, label }) || {};

// ---------------------------------------------------------------- engine
function createEngine(pool, { sanitizeBatchId = s => String(s).replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '') } = {}) {
  const httpErr = (status, msg) => { const e = new Error(msg); e.status = status; return e; };
  const tbl = (type, s) => `fhir_${type}${s ? '_' + s : ''}`;

  async function resolveScope(opts = {}) {
    const names = new Set((await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name LIKE 'fhir\\_%'`)).rows.map(r => r.table_name));
    const all = [...names].map(n => (n.match(/^fhir_patient_(.+)$/) || [])[1]).filter(Boolean);
    let suffixes;
    if (opts.batchId) suffixes = [sanitizeBatchId(opts.batchId)];
    else if (opts.batchGroup) suffixes = all.filter(s => s.startsWith(opts.batchGroup));
    else suffixes = all;
    suffixes = suffixes.filter(s => names.has(tbl('patient', s)));
    if (!suffixes.length) {
      if (!opts.batchId && !opts.batchGroup && names.has('fhir_patient')) suffixes = [''];
      else throw httpErr(404, 'No imported FHIR data found. Import a batch or generate synthetic data first.');
    }
    let cohort = null;
    if (opts.useCohort !== false) {
      const r = opts.cohortId
        ? await pool.query('SELECT id, name, criteria_sql FROM cohorts WHERE id = $1', [opts.cohortId])
        : await pool.query('SELECT id, name, criteria_sql FROM cohorts WHERE is_active = TRUE ORDER BY updated_at DESC LIMIT 1').catch(() => ({ rows: [] }));
      if (opts.cohortId && !r.rows.length) throw httpErr(404, 'Cohort not found');
      cohort = r.rows[0] || null;
    }
    const criteria = ((cohort && cohort.criteria_sql) || '').trim();
    const refRegex = /\bfhir_(patient|encounter|observation|diagnosis|procedure|medication|allergy|immunization)\b(?!_)/g;
    const un = (type, cols, emptyCols) => {
      const parts = suffixes.filter(s => names.has(tbl(type, s))).map(s => `SELECT ${cols} FROM ${tbl(type, s)}`);
      return parts.length ? parts.join(' UNION ALL ') : `SELECT ${emptyCols} WHERE false`;
    };
    const pParts = suffixes.map(s => `SELECT patient_id, gender, birth_date, json_content AS pj FROM ${tbl('patient', s)}${criteria ? ` WHERE ${criteria.replace(refRegex, (m, t) => tbl(t, s))}` : ''}`);
    const inP = 'patient_id IN (SELECT patient_id FROM p)';
    // One row per patient_id even when the same id sits in several batches (or twice in one): duplicates multiplied joins (Kaplan-Meier double counting, 'more than one row returned by a subquery' in the disease module).
    const withSql = `WITH p AS (SELECT DISTINCT ON (patient_id) patient_id, gender, birth_date, pj FROM (${pParts.join(' UNION ALL ')}) pu ORDER BY patient_id),
      dx AS (SELECT patient_id, code, code_system, onset_date::date AS onset_date, json_content AS j FROM (${un('diagnosis', 'patient_id, code, code_system, onset_date, json_content', `NULL::text AS patient_id, NULL::text AS code, NULL::text AS code_system, NULL::date AS onset_date, NULL::jsonb AS json_content`)}) u WHERE ${inP}),
      ob AS (SELECT patient_id, code, code_system, value, unit, effective_date, json_content AS j FROM (${un('observation', 'patient_id, code, code_system, value, unit, effective_date, json_content', `NULL::text AS patient_id, NULL::text AS code, NULL::text AS code_system, NULL::numeric AS value, NULL::text AS unit, NULL::timestamp AS effective_date, NULL::jsonb AS json_content`)}) u WHERE ${inP}),
      rx AS (SELECT patient_id, medication_code AS code, prescribed_date, json_content AS j FROM (${un('medication', 'patient_id, medication_code, prescribed_date, json_content', `NULL::text AS patient_id, NULL::text AS medication_code, NULL::timestamp AS prescribed_date, NULL::jsonb AS json_content`)}) u WHERE ${inP}),
      pr AS (SELECT patient_id, code, performed_date, json_content AS j FROM (${un('procedure', 'patient_id, code, performed_date, json_content', `NULL::text AS patient_id, NULL::text AS code, NULL::timestamp AS performed_date, NULL::jsonb AS json_content`)}) u WHERE ${inP}),
      en AS (SELECT patient_id, encounter_type AS cls, start_date, end_date, json_content AS j FROM (${un('encounter', 'patient_id, encounter_type, start_date, end_date, json_content', `NULL::text AS patient_id, NULL::text AS encounter_type, NULL::timestamp AS start_date, NULL::timestamp AS end_date, NULL::jsonb AS json_content`)}) u WHERE ${inP}),
      al AS (SELECT patient_id, substance, reaction, severity, json_content AS j FROM (${un('allergy', 'patient_id, substance, reaction, severity, json_content', `NULL::text AS patient_id, NULL::text AS substance, NULL::text AS reaction, NULL::text AS severity, NULL::jsonb AS json_content`)}) u WHERE ${inP}),
      im AS (SELECT patient_id, vaccine_code AS code, occurrence_date, json_content AS j FROM (${un('immunization', 'patient_id, vaccine_code, occurrence_date, json_content', `NULL::text AS patient_id, NULL::text AS vaccine_code, NULL::timestamp AS occurrence_date, NULL::jsonb AS json_content`)}) u WHERE ${inP})`;
    let asOf = validDate(opts.asOf);
    if (!asOf) {
      const r = await pool.query(`${withSql} SELECT GREATEST((SELECT max(effective_date) FROM ob), (SELECT max(start_date) FROM en), (SELECT max(onset_date) FROM dx), (SELECT max(prescribed_date) FROM rx), (SELECT max(performed_date) FROM pr))::date AS d`);
      const d = r.rows[0] && r.rows[0].d;
      asOf = d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : new Date().toISOString().slice(0, 10);
    }
    const total = (await pool.query(`${withSql} SELECT count(*)::int AS n FROM p`)).rows[0].n;
    return { with: `${withSql}, ref AS (SELECT '${asOf}'::date AS d)`, suffixes, cohort: cohort ? { id: cohort.id, name: cohort.name } : null, asOf, patients: Number(total) };
  }

  const clean = v => (typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.toISOString().slice(0, 10) : v);
  async function runSections(sections, ctx) {
    const out = [];
    for (const s of sections) {
      const q = new Q();
      const sql = s.sql(q, ctx);
      const r = await pool.query(sql, q.params);
      const rows = r.rows.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, clean(v)])));
      out.push({ name: s.name, title: s.title, columns: rows.length ? Object.keys(rows[0]) : (r.fields || []).map(f => f.name), rows });
    }
    return out;
  }

  async function run({ id, mode = 'v3', args = {}, ...scopeOpts }) {
    const a = CATALOG.find(x => x.id === id);
    if (!a) throw httpErr(404, `Unknown analytic '${id}'`);
    if (!['v1', 'v3', 'v4'].includes(mode)) throw httpErr(400, `Mode '${mode}' is not supported (use v1, v3 or v4)`);
    if (typeof a[mode] !== 'function') throw httpErr(400, `'${a.title}' has no ${mode.toUpperCase()} version`);
    args = { ...args }; delete args.termList; // internal only (Step D.7d)
    // Fill declared defaults for params the caller left out (run-all and the dashboard send none), so analytics that need a drug or condition run instead of throwing 'Pick a ...'.
    for (const p of (Array.isArray(a.params) ? a.params : [])) if (p.default !== undefined && (args[p.name] === undefined || args[p.name] === null || args[p.name] === '') && (!p.modes || p.modes.includes(mode))) args[p.name] = p.default;
    const ctx = await resolveScope({ ...scopeOpts, asOf: args.asOf || scopeOpts.asOf });
    ctx.overrides = await getOverrides(); ctx.risky = riskyList(ctx.overrides); // Step D.8c
    ctx.chronic = chronicList(ctx.overrides); ctx.firstLine = firstLineMap(ctx.overrides); // Step D.8d
    ctx.labLimits = labLimitList(ctx.overrides); // Step D.8e
    let useArgs = args;
    if (CONCEPT_ANALYTICS.has(id)) {
      const code = conceptToLookUp(args);
      let display;
      if (code !== null) {
        const r = await pool.query(`${ctx.with} SELECT count(*)::int AS n, mode() WITHIN GROUP (ORDER BY COALESCE(${DISPLAY}, j->'code'->>'text')) AS display FROM dx WHERE code = $1`, [code]);
        display = Number(r.rows[0].n) > 0 ? (r.rows[0].display || '') : null;
      }
      let learned = null;
      if (mode === 'v1' && code !== null && display !== null && display !== undefined && !args.term && !args.code && EXT.learnedTermsQuery) {
        try { const lq = EXT.learnedTermsQuery(code, ctx.with); learned = (await pool.query(lq.sql, lq.params)).rows.map(r => r.term).filter(t => typeof t === 'string' && /^[a-z0-9][a-z0-9 -]*$/.test(t)); }
        catch (e) { learned = null; } // learning is a convenience: on any problem fall back to the display text (Step D.2a)
      }
      useArgs = normalizeConcept(args, display, mode, learned);
    }
    const sections = await runSections(a[mode](useArgs, ctx), ctx);
    return { success: true, id, title: a.title, mode, methodInfo: METHOD_INFO[mode], scope: { patients: ctx.patients, cohort: ctx.cohort, batches: ctx.suffixes.map(s => s || '(legacy tables)'), asOf: ctx.asOf }, sections };
  }

  async function demographics({ dim = 'gender', mode = 'v1', args = {}, ...scopeOpts }) {
    const res = await run({ id: 'demographics', mode, args: { ...args, dim }, ...scopeOpts });
    const sec = res.sections.find(s => s.name === dim) || res.sections[0];
    const total = sec.rows.reduce((t, r) => t + r.count, 0);
    return { success: true, dimension: dim, mode, cohort: res.scope.cohort || { id: null, name: 'All patients (no active cohort)' }, total_patients: total, distributions: sec.rows.map(r => ({ value: r.value || 'Unknown', count: r.count, percentage: r.percentage != null ? r.percentage.toFixed(1) : '0.0' })), methodInfo: res.methodInfo, scope: res.scope };
  }

  // Step D.2c: params flagged `fromData: 'dx'` get their options from the scope's data ('(all)' first); every other param is unchanged.
  // A failure to read the inventory never breaks the catalog (conceptOptions falls back to the dictionary list).
  async function catalog(scopeOpts = {}) {
    let dx = null;
    const optsFor = async p => {
      if (p.fromData !== 'dx') return typeof p.options === 'function' ? p.options() : p.options;
      if (!dx) dx = await conceptOptions(scopeOpts).catch(() => Object.entries(T.CONDITIONS).map(([k, v]) => ({ value: k, label: v.display || v.label })));
      return [{ value: '', label: '(all)' }, ...dx];
    };
    const out = [];
    for (const a of CATALOG) out.push({ id: a.id, title: a.title, category: a.category, description: a.description, modes: ['v1', 'v3', 'v4'].filter(m => typeof a[m] === 'function'), params: await Promise.all(a.params.map(async p => ({ ...p, options: await optsFor(p) }))) });
    return out;
  }
  // ---- Step D.1: concept inventory. Every code in the scoped data, per resource type, with how often it is used.
  // type: dx (diagnoses), ob (observations), rx (medications), pr (procedures). Same scope rules as every analytic (batch, group, active cohort).
  const INVENTORY = {
    dx: { label: 'Diagnoses', cte: 'dx', sys: 'code_system', disp: DISPLAY, text: `j->'code'->>'text'`, date: 'onset_date' },
    ob: { label: 'Observations', cte: 'ob', sys: 'code_system', disp: DISPLAY, text: `j->'code'->>'text'`, date: 'effective_date' },
    rx: { label: 'Medications', cte: 'rx', sys: `j->'medicationCodeableConcept'->'coding'->0->>'system'`, disp: `j->'medicationCodeableConcept'->'coding'->0->>'display'`, text: `j->'medicationCodeableConcept'->>'text'`, date: 'prescribed_date' },
    pr: { label: 'Procedures', cte: 'pr', sys: `j->'code'->'coding'->0->>'system'`, disp: DISPLAY, text: `j->'code'->>'text'`, date: 'performed_date' }
  };
  async function concepts({ type, limit, ...scopeOpts } = {}) {
    const t = typeof type === 'string' && Object.prototype.hasOwnProperty.call(INVENTORY, type) ? INVENTORY[type] : null;
    if (!t) throw httpErr(400, `Send type=${Object.keys(INVENTORY).join('|')} (got '${type === undefined ? '' : String(type).slice(0, 40)}')`);
    const lim = Math.min(5000, Math.max(1, Math.floor(num(limit, 1000))));
    const ctx = await resolveScope(scopeOpts);
    const sql = `${ctx.with}
      SELECT code, code_system, mode() WITHIN GROUP (ORDER BY display) AS display, count(DISTINCT patient_id)::int AS patients, count(*)::int AS records,
        min(d)::date AS first_seen, max(d)::date AS last_seen
      FROM (SELECT code, ${t.sys} AS code_system, COALESCE(${t.disp}, ${t.text}) AS display, patient_id, ${t.date}::timestamp AS d FROM ${t.cte}) x
      WHERE code IS NOT NULL
      GROUP BY code, code_system ORDER BY patients DESC, records DESC, code, code_system LIMIT $1`;
    const r = await pool.query(sql, [lim + 1]);
    const rows = r.rows.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, clean(v)])));
    const truncated = rows.length > lim;
    return { success: true, type, label: t.label, scope: { patients: ctx.patients, cohort: ctx.cohort, batches: ctx.suffixes.map(x => x || '(legacy tables)'), asOf: ctx.asOf }, count: Math.min(rows.length, lim), truncated, concepts: rows.slice(0, lim) };
  }

  // ---- Step D.2b: condition options built from the data (the D.1 `dx` inventory), cached per scope.
  // value = dictionary key when the code is in T.CONDITIONS (so V1 text matching and graph expansion keep working), else the raw code.
  // The '(all)' entry is not included; the catalog route (D.2c) adds it. No data in the scope (or any error) falls back to the dictionary list.
  const dictOptions = () => Object.entries(T.CONDITIONS).map(([k, v]) => ({ value: k, label: v.display || v.label }));
  const conceptCache = new Map();
  const scopeKey = o => JSON.stringify([o.batchId || '', o.batchGroup || '', o.cohortId || '', o.useCohort !== false]);
  async function conceptOptions(scopeOpts = {}) {
    const key = scopeKey(scopeOpts);
    if (conceptCache.has(key)) return conceptCache.get(key);
    let opts;
    try {
      const inv = await concepts({ type: 'dx', limit: 5000, ...scopeOpts, useCohort: scopeOpts.useCohort !== false });
      const seen = new Set(), list = [];
      for (const c of inv.concepts) {                       // sorted by patients, so the first row per code is the largest
        if (seen.has(c.code)) continue;                     // the same code in two code systems is one option
        seen.add(c.code);
        const dictKey = Object.keys(T.CONDITIONS).find(k => T.CONDITIONS[k].code === c.code);
        const name = dictKey ? (T.CONDITIONS[dictKey].display || c.display || c.code) : (c.display || c.code);
        list.push({ value: dictKey || c.code, label: `${name} (${c.patients} patients)` });
      }
      opts = list.length ? list : null;
    } catch (e) { opts = null; }
    if (!opts) return dictOptions();                        // fallback is not cached, so data that arrives later is picked up
    conceptCache.set(key, opts);
    return opts;
  }
  // ---- Step D.8c: reviewer decisions (concept_overrides), loaded once and cached until clearConceptCache() (server.js calls it after every non-GET request, including /api/overrides).
  // A missing table or any error gives an empty list and is not cached, so the engine works before the schema is initialised.
  let overridesCache = null, overridesGen = 0;
  async function getOverrides() {
    if (overridesCache) return overridesCache;
    const gen = overridesGen;
    try {
      const r = await pool.query(`SELECT kind, key, key2, decision, label, chronic, abnormal_low::float8 AS abnormal_low, abnormal_high::float8 AS abnormal_high, note FROM concept_overrides ORDER BY reviewed_at, id`);
      if (gen === overridesGen) overridesCache = r.rows;
      return r.rows;
    } catch (e) { return []; }
  }
  const clearConceptCache = () => { conceptCache.clear(); overridesCache = null; overridesGen++; };

  return { run, demographics, catalog, concepts, conceptOptions, clearConceptCache, getOverrides, resolveScope, CATALOG };
}

// ---------------------------------------------------------------- express wiring
function register(app, pool, helpers = {}) {
  const engine = createEngine(pool, helpers);
  const { generateBundle } = require('./synthetic');
  const fail = (res, label, err) => { console.error(`${label}:`, err); res.status(err.status || 500).json({ success: false, error: err.status ? err.message : `${label} failed`, details: err.message }); };
  const scopeOf = b => ({ batchId: b.batchId, batchGroup: b.batchGroup, cohortId: b.cohortId, useCohort: true }); // analytics always run on the active cohort

  app.locals.clearConceptCache = engine.clearConceptCache; // server.js calls this after data-changing requests (Step D.2c)
  app.get('/api/analytics/catalog', async (req, res) => {
    try {
      const q = req.query, one = v => (Array.isArray(v) ? v[0] : v);
      res.json({ success: true, analytics: await engine.catalog({ batchId: one(q.batchId), batchGroup: one(q.batchGroup), cohortId: one(q.cohortId), useCohort: true }) });
    } catch (err) { fail(res, 'Catalog', err); }
  });

  // Knowledge graph (Step 6.3): GET /api/kg/neighbors?key=diabetes[&type=treated_by,leads_to][&direction=out|in|both][&depth=1-6]
  // Reads only the static relations in terminology.js: no database, no patient data.
  app.get('/api/kg/neighbors', (req, res) => {
    try {
      const q = req.query, one = v => (Array.isArray(v) ? v[0] : v);
      const key = String(one(q.key) ?? '');
      if (!G.has(key)) return res.status(404).json({ success: false, error: key ? `Unknown concept '${key}'` : 'Send ?key=<concept>, for example ?key=diabetes' });
      const opts = {};
      if (q.type) opts.types = [].concat(q.type).join(',').split(',').map(x => x.trim()).filter(Boolean);
      if (q.direction) opts.direction = String(one(q.direction));
      const show = n => ({ ...n, display: dispOf(n.key) });
      const out = { success: true, key, kind: T.CONCEPT_KIND[key], display: dispOf(key), neighbors: G.neighbors(key, opts).map(show) };
      if (q.depth !== undefined) out.expanded = G.expand(key, { ...opts, depth: Number(one(q.depth)) }).map(show);
      res.json(out);
    } catch (err) {
      if (/^graph:/.test(err.message)) return res.status(400).json({ success: false, error: err.message });
      fail(res, 'Knowledge graph lookup', err);
    }
  });

  app.post('/api/analytics/catalog/run', async (req, res) => {
    try { const b = req.body || {}; res.json(await engine.run({ id: b.id, mode: b.mode, args: b.args || {}, ...scopeOf(b) })); }
    catch (err) { fail(res, 'Analytics run', err); }
  });

  // Concept inventory (Step D.1): GET /api/concepts?type=dx|ob|rx|pr[&limit=1-5000][&batchId=...][&batchGroup=...][&cohortId=...]
  app.get('/api/concepts', async (req, res) => {
    try {
      const q = req.query, one = v => (Array.isArray(v) ? v[0] : v);
      res.json(await engine.concepts({ type: one(q.type), limit: one(q.limit), batchId: one(q.batchId), batchGroup: one(q.batchGroup), cohortId: one(q.cohortId), useCohort: true }));
    } catch (err) { fail(res, 'Concept inventory', err); }
  });

  app.post('/api/analytics/catalog/run-all', async (req, res) => {
    const b = req.body || {}, results = [];
    for (const a of CATALOG) {
      if (typeof a[b.mode] !== 'function') continue;
      try { results.push(await engine.run({ id: a.id, mode: b.mode, args: {}, ...scopeOf(b) })); }
      catch (err) { results.push({ success: false, id: a.id, title: a.title, mode: b.mode, error: err.message }); }
    }
    res.json({ success: true, mode: b.mode, results });
  });

  app.get('/api/analytics/demographics', async (req, res) => {
    try { const { dim, mode, ...args } = req.query; res.json(await engine.demographics({ dim, mode, args, batchId: req.query.batchId, batchGroup: req.query.batchGroup })); }
    catch (err) { fail(res, 'Demographic analysis', err); }
  });

  require('./evidence').registerStudies(app, pool, engine, { catalog: () => CATALOG, fail, scopeOf });

  app.post('/api/synthetic/generate', (req, res) => {
    try { const { count, seed, years, endDate, messy, inpatient, enrich } = req.body || {}; const out = generateBundle({ count, seed: seed ?? Date.now() % 100000, years, messy, inpatient, enrich, endDate: endDate || new Date().toISOString().slice(0, 10) }); res.json({ success: true, ...out }); }
    catch (err) { fail(res, 'Synthetic data generation', err); }
  });
}

module.exports = register;
module.exports.createEngine = createEngine;
module.exports.normalizeConcept = normalizeConcept;
module.exports.CATALOG = CATALOG;
module.exports.riskyList = riskyList;
module.exports.chronicList = chronicList;
module.exports.firstLineMap = firstLineMap;
module.exports.labLimitList = labLimitList;
module.exports.EXT = EXT;
module.exports.Q = Q;
