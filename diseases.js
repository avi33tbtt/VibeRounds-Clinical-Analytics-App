'use strict';
// Vibe Rounds: disease profiles (plan chunk 0.1). Pure functions, no database, no network.
//   validate(profile, opts) -> { ok, errors: [{ path, message }], warnings: [{ path, message }] }
//   normalize(profile)      -> a cleaned copy with defaults filled in (never throws; run validate on the result)
//   check(profile, opts)    -> normalize + validate in one call: { profile, ok, errors, warnings }
// Profile fields follow section 2.1 of disease-department-plan.html. Codes are demo placeholders: a clinician must review them.
//
// opts (all optional):
//   knownDiseases  array / Set of disease keys that links may point to (the profile's own key is always rejected as a link target)
//   knownDepartments array / Set; if given, department keys must be in it
//   codeExists(system, code) -> boolean   (e.g. a lookup in the SNOMED / LOINC / RxNorm reference tables); when absent, only the code format is checked
// Self-test: node diseases.js --selftest

const T = require('./knowledge').terminology;

const KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
const SYSTEM_KEYS = ['snomed', 'loinc', 'rxnorm', 'cvx'];
const SYSTEM_URI = Object.fromEntries(SYSTEM_KEYS.map(k => [k, T.SYSTEMS[k]]));
const CODE_RE = {   // format only; existence is checked through opts.codeExists
  snomed: /^\d{6,18}$/, loinc: /^\d{1,7}-\d$/, rxnorm: /^\d{2,9}$/, cvx: /^\d{1,3}$/
};
const ICD10_RE = /^[A-Z]\d{2}(\.\d{1,4})?$/;
const COURSES = ['chronic', 'episodic', 'acute'];
const CONTROL_TYPES = ['lab', 'vital', 'score'];
const DIRECTIONS = ['below', 'above', 'range'];
const MONITOR_KINDS = ['test', 'screening', 'vaccine'];
const ONSET_SHAPES = ['uniform', 'normal', 'late'];
const EVENT_KEYS = ['ed', 'admission', 'procedure'];

// Plausible value range per LOINC code, to catch a goal typed in the wrong unit (HbA1c 70 instead of 7).
const PLAUSIBLE = {
  '4548-4': [3, 20], '8480-6': [60, 260], '8462-4': [30, 150], '39156-5': [10, 80], '2339-0': [20, 800],
  '18262-6': [20, 400], '2085-9': [10, 120], '2093-3': [50, 500], '2571-8': [20, 1500], '38483-4': [0.2, 15],
  '33914-3': [5, 150], '8867-4': [30, 220], '29463-7': [2, 300], '59408-5': [50, 100]
};

// ---------- small helpers ----------
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const str = v => (v == null ? '' : String(v).trim());
const lower = v => str(v).toLowerCase();
const toNum = v => { if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const setOf = x => (x instanceof Set ? x : new Set(Array.isArray(x) ? x : []));
const uniq = a => [...new Set(a)];
const strList = v => uniq((Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(lower).filter(Boolean));
const asBool = (v, d) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : d);
const sysKey = s => { const t = lower(s); if (SYSTEM_URI[t]) return t; const hit = SYSTEM_KEYS.find(k => SYSTEM_URI[k].toLowerCase() === t); return hit || t; };

// ---------- normalize ----------
function normCode(c, defSystem) {
  const o = isObj(c) ? c : {};
  return { system: sysKey(o.system || defSystem), code: str(o.code), display: str(o.display) };
}

function normalize(input) {
  const p = isObj(input) ? input : {};
  const dx = isObj(p.dx) ? p.dx : {};
  const pv = isObj(p.prevalence) ? p.prevalence : {};
  const co = isObj(p.course) ? p.course : {};
  const ct = isObj(p.control) ? p.control : {};
  const ms = isObj(p.mess) ? p.mess : {};
  const sr = isObj(p.source) ? p.source : {};
  const out = {
    key: lower(p.key),
    label: str(p.label),
    enabled: asBool(p.enabled, true),
    sensitive: asBool(p.sensitive, false),
    departments: strList(p.departments),
    dx: { ...normCode(dx, 'snomed'), terms: strList(dx.terms), icd10: str(dx.icd10).toUpperCase() },
    prevalence: {
      minAge: toNum(pv.minAge) ?? 18,
      ageBands: (Array.isArray(pv.ageBands) ? pv.ageBands : []).map(b => ({ from: toNum(b && b.from), to: toNum(b && b.to), male: toNum(b && b.male), female: toNum(b && b.female) })),
      onset: { shape: lower(pv.onset && pv.onset.shape) || 'uniform', mean: toNum(pv.onset && pv.onset.mean), sd: toNum(pv.onset && pv.onset.sd) },
      multipliers: (Array.isArray(pv.multipliers) ? pv.multipliers : []).map(m => ({ disease: lower(m && m.disease), multiplier: toNum(m && m.multiplier) }))
    },
    course: {
      type: lower(co.type) || 'chronic',
      severity: { mild: toNum(co.severity && co.severity.mild), moderate: toNum(co.severity && co.severity.moderate), severe: toNum(co.severity && co.severity.severe) },
      events: {}
    },
    control: null,
    treatment: (Array.isArray(p.treatment) ? p.treatment : []).map(t => {
      const o = isObj(t) ? t : {};
      return { ...normCode(o, 'rxnorm'), line: toNum(o.line) ?? 1, probability: toNum(o.probability), lagDays: toNum(o.lagDays) ?? 0, renewalDays: toNum(o.renewalDays) ?? 30,
        switchTo: str(o.switchTo), switchProbability: toNum(o.switchProbability) ?? 0 };
    }),
    monitoring: (Array.isArray(p.monitoring) ? p.monitoring : []).map(m => {
      const o = isObj(m) ? m : {};
      const kind = lower(o.kind) || 'test';
      return { kind, ...normCode(o, kind === 'test' ? 'loinc' : kind === 'vaccine' ? 'cvx' : 'snomed'),
        intervalControlledDays: toNum(o.intervalControlledDays), intervalUncontrolledDays: toNum(o.intervalUncontrolledDays) };
    }),
    links: (Array.isArray(p.links) ? p.links : []).map(l => ({ disease: lower(l && l.disease), multiplier: toNum(l && l.multiplier), direction: lower(l && l.direction) || 'raises' })),
    mess: { uncodedShare: toNum(ms.uncodedShare) ?? 0, localCodeShare: toNum(ms.localCodeShare) ?? 0, lowercaseShare: toNum(ms.lowercaseShare) ?? 0,
      unitSwapShare: toNum(ms.unitSwapShare) ?? 0, localCode: str(ms.localCode) },
    source: { note: str(sr.note), version: toNum(sr.version) ?? 1, updatedBy: str(sr.updatedBy), updatedAt: str(sr.updatedAt), approvedBy: str(sr.approvedBy) }
  };
  for (const k of EVENT_KEYS) {
    const e = co.events && isObj(co.events[k]) ? co.events[k] : null;
    if (e) out.course.events[k] = { controlled: toNum(e.controlled), uncontrolled: toNum(e.uncontrolled) };
  }
  if (isObj(p.control)) {
    out.control = {
      type: lower(ct.type) || 'lab', ...normCode(ct, 'loinc'), unit: str(ct.unit),
      goal: toNum(ct.goal), goalHigh: toNum(ct.goalHigh), direction: lower(ct.direction) || 'below',
      lookbackDays: toNum(ct.lookbackDays) ?? 365,
      start: { mean: toNum(ct.start && ct.start.mean), sd: toNum(ct.start && ct.start.sd) },
      target: toNum(ct.target), decayDays: toNum(ct.decayDays)
    };
  }
  return out;
}

// ---------- validate ----------
function validate(input, opts = {}) {
  const p = normalize(input);
  const errors = [], warnings = [];
  const err = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });
  const known = opts.knownDiseases ? setOf(opts.knownDiseases) : null;
  const knownDeps = opts.knownDepartments ? setOf(opts.knownDepartments) : null;
  const rate = (path, v, { required = false } = {}) => {
    if (v === null) { if (required) err(path, 'is required, a number from 0 to 1'); return; }
    if (v < 0 || v > 1) err(path, `must be between 0 and 1 (got ${v})`);
  };
  const posNum = (path, v, { required = false, allowZero = true, max = 36500 } = {}) => {
    if (v === null) { if (required) err(path, 'is required, a number of days'); return; }
    if (v < 0 || (!allowZero && v === 0)) err(path, `must be ${allowZero ? 'zero or more' : 'above zero'} (got ${v})`);
    else if (v > max) err(path, `is too large (got ${v}, limit ${max})`);
  };
  const code = (path, c, { required = true } = {}) => {
    if (!c.code) { if (required) err(path + '.code', 'is required'); return; }
    if (!CODE_RE[c.system]) { err(path + '.system', `must be one of: ${SYSTEM_KEYS.join(', ')}`); return; }
    if (!CODE_RE[c.system].test(c.code)) { err(path + '.code', `"${c.code.slice(0, 30)}" is not a valid ${c.system} code`); return; }
    if (typeof opts.codeExists === 'function' && !opts.codeExists(c.system, c.code)) err(path + '.code', `${c.system} code ${c.code} is not in the reference table`);
  };

  if (!isObj(input)) { err('', 'profile must be an object'); return { ok: false, errors, warnings }; }

  // identity
  if (!KEY_RE.test(p.key)) err('key', 'must be 2 to 40 characters: lower-case letters, digits, underscore, starting with a letter');
  if (!p.label) err('label', 'is required'); else if (p.label.length > 120) err('label', 'is too long (120 characters at most)');
  p.departments.forEach((d, i) => {
    if (!KEY_RE.test(d)) err(`departments[${i}]`, `"${d.slice(0, 30)}" is not a valid department key`);
    else if (knownDeps && !knownDeps.has(d)) err(`departments[${i}]`, `unknown department "${d}"`);
  });

  // diagnosis
  code('dx', p.dx);
  if (p.dx.code && p.dx.system !== 'snomed') err('dx.system', 'the diagnosis code must be a SNOMED CT code');
  if (!p.dx.display) warn('dx.display', 'no display text; the code will show without a name');
  if (!p.dx.terms.length) warn('dx.terms', 'no search words: the text-matching mode (V1) will not find this disease');
  if (p.dx.terms.some(t => t.length < 2 || t.length > 60)) err('dx.terms', 'each search word must be 2 to 60 characters');
  if (p.dx.icd10 && !ICD10_RE.test(p.dx.icd10)) err('dx.icd10', `"${p.dx.icd10.slice(0, 12)}" is not an ICD-10 code like E11 or E11.9`);

  // prevalence
  const pv = p.prevalence;
  if (pv.minAge < 0 || pv.minAge > 120) err('prevalence.minAge', 'must be an age from 0 to 120');
  if (!pv.ageBands.length) err('prevalence.ageBands', 'at least one age band is required');
  pv.ageBands.forEach((b, i) => {
    const at = `prevalence.ageBands[${i}]`;
    if (b.from === null || b.to === null) err(at, 'needs from and to (ages)');
    else if (b.from < 0 || b.to > 120 || b.from >= b.to) err(at, `age range ${b.from} to ${b.to} is invalid (0 to 120, from below to)`);
    rate(at + '.male', b.male, { required: true });
    rate(at + '.female', b.female, { required: true });
  });
  const bands = pv.ageBands.filter(b => b.from !== null && b.to !== null).sort((a, b) => a.from - b.from);
  for (let i = 1; i < bands.length; i++) if (bands[i].from < bands[i - 1].to) { err('prevalence.ageBands', `age bands overlap at ${bands[i].from}`); break; }
  if (!ONSET_SHAPES.includes(pv.onset.shape)) err('prevalence.onset.shape', `must be one of: ${ONSET_SHAPES.join(', ')}`);
  if (pv.onset.shape === 'normal') {
    if (pv.onset.mean === null || pv.onset.mean < 0 || pv.onset.mean > 120) err('prevalence.onset.mean', 'a normal onset needs a mean age from 0 to 120');
    if (pv.onset.sd === null || pv.onset.sd <= 0 || pv.onset.sd > 60) err('prevalence.onset.sd', 'a normal onset needs a standard deviation above 0 and up to 60');
  }
  pv.multipliers.forEach((m, i) => linkCheck(`prevalence.multipliers[${i}]`, m));

  // course
  if (!COURSES.includes(p.course.type)) err('course.type', `must be one of: ${COURSES.join(', ')}`);
  const sv = p.course.severity, svVals = [sv.mild, sv.moderate, sv.severe];
  if (svVals.some(v => v !== null)) {
    svVals.forEach((v, i) => { if (v === null) err('course.severity.' + ['mild', 'moderate', 'severe'][i], 'is required when any severity share is given'); else rate('course.severity.' + ['mild', 'moderate', 'severe'][i], v); });
    if (svVals.every(v => v !== null) && Math.abs(svVals.reduce((a, b) => a + b, 0) - 1) > 0.01) err('course.severity', 'mild, moderate and severe shares must add up to 1');
  }
  for (const [k, e] of Object.entries(p.course.events)) {
    rate(`course.events.${k}.controlled`, e.controlled, { required: true });
    rate(`course.events.${k}.uncontrolled`, e.uncontrolled, { required: true });
  }

  // control measure (optional as a whole)
  if (p.control) {
    const c = p.control, at = 'control';
    if (!CONTROL_TYPES.includes(c.type)) err(at + '.type', `must be one of: ${CONTROL_TYPES.join(', ')}`);
    code(at, c);
    if (!DIRECTIONS.includes(c.direction)) err(at + '.direction', `must be one of: ${DIRECTIONS.join(', ')}`);
    if (c.goal === null) err(at + '.goal', 'is required');
    if (c.direction === 'range') {
      if (c.goalHigh === null) err(at + '.goalHigh', 'a range goal needs goal (low end) and goalHigh (high end)');
      else if (c.goal !== null && c.goal >= c.goalHigh) err(at + '.goalHigh', 'must be above goal');
    }
    const pr = PLAUSIBLE[c.code];
    if (pr && c.type !== 'score') {
      for (const [f, v] of [['goal', c.goal], ['goalHigh', c.goalHigh], ['target', c.target], ['start.mean', c.start.mean]]) {
        if (v !== null && (v < pr[0] || v > pr[1])) err(`${at}.${f}`, `${v} is outside the plausible range ${pr[0]} to ${pr[1]} for this measure (wrong unit?)`);
      }
    } else if (c.code && c.type !== 'score') warn(at + '.goal', 'no plausible range is known for this code, so the goal was not range-checked');
    if (c.lookbackDays < 7 || c.lookbackDays > 1825) err(at + '.lookbackDays', 'must be between 7 and 1825 days');
    if (c.start.mean === null) err(at + '.start.mean', 'is required (start value of the series)');
    if (c.start.sd !== null && c.start.sd < 0) err(at + '.start.sd', 'must be zero or more');
    if (c.target === null) err(at + '.target', 'is required (the value the series moves to on treatment)');
    posNum(at + '.decayDays', c.decayDays, { required: true, allowZero: false, max: 3650 });
    if (c.goal !== null && c.target !== null && c.direction === 'below' && c.target >= c.goal) warn(at + '.target', 'the treated target is not below the goal, so treated patients will not reach control');
    if (c.goal !== null && c.target !== null && c.direction === 'above' && c.target <= c.goal) warn(at + '.target', 'the treated target is not above the goal, so treated patients will not reach control');
  } else if (p.monitoring.some(m => m.kind === 'test')) warn('control', 'monitoring tests are set but there is no control measure');

  // treatment
  p.treatment.forEach((t, i) => {
    const at = `treatment[${i}]`;
    code(at, t);
    if (t.code && t.system !== 'rxnorm') err(at + '.system', 'a drug code must be an RxNorm code');
    if (!Number.isInteger(t.line) || t.line < 1 || t.line > 5) err(at + '.line', 'must be a whole number from 1 to 5');
    rate(at + '.probability', t.probability, { required: true });
    posNum(at + '.lagDays', t.lagDays, { max: 3650 });
    posNum(at + '.renewalDays', t.renewalDays, { allowZero: false, max: 365 });
    rate(at + '.switchProbability', t.switchProbability);
    if (t.switchTo && !p.treatment.some((o, j) => j !== i && o.code === t.switchTo)) err(at + '.switchTo', `"${t.switchTo.slice(0, 20)}" is not the code of another treatment line in this profile`);
    if (t.switchProbability > 0 && !t.switchTo) err(at + '.switchTo', 'is required when switchProbability is above 0');
  });
  const lc = p.treatment.map(t => t.code).filter(Boolean);
  if (new Set(lc).size !== lc.length) err('treatment', 'the same drug code appears twice');
  if (p.treatment.length && !p.treatment.some(t => t.line === 1)) warn('treatment', 'no first-line (line 1) drug');

  // monitoring
  p.monitoring.forEach((m, i) => {
    const at = `monitoring[${i}]`;
    if (!MONITOR_KINDS.includes(m.kind)) err(at + '.kind', `must be one of: ${MONITOR_KINDS.join(', ')}`);
    code(at, m);
    posNum(at + '.intervalControlledDays', m.intervalControlledDays, { required: true, allowZero: false, max: 3650 });
    posNum(at + '.intervalUncontrolledDays', m.intervalUncontrolledDays, { required: true, allowZero: false, max: 3650 });
    if (m.intervalControlledDays !== null && m.intervalUncontrolledDays !== null && m.intervalUncontrolledDays > m.intervalControlledDays) warn(at, 'uncontrolled patients are tested less often than controlled ones');
  });

  // links
  function linkCheck(at, l) {
    if (!KEY_RE.test(l.disease)) err(at + '.disease', 'is required (a disease key)');
    else if (l.disease === p.key) err(at + '.disease', 'a disease cannot link to itself');
    else if (known && !known.has(l.disease)) err(at + '.disease', `unknown disease "${l.disease}"`);
    if (l.multiplier === null || l.multiplier <= 0 || l.multiplier > 50) err(at + '.multiplier', 'must be above 0 and at most 50');
  }
  p.links.forEach((l, i) => { linkCheck(`links[${i}]`, l); if (!['raises', 'lowers'].includes(l.direction)) err(`links[${i}].direction`, 'must be raises or lowers'); });
  const lk = p.links.map(l => l.disease).filter(Boolean);
  if (new Set(lk).size !== lk.length) err('links', 'the same disease is linked twice');

  // mess
  for (const f of ['uncodedShare', 'localCodeShare', 'lowercaseShare', 'unitSwapShare']) rate('mess.' + f, p.mess[f]);
  if (p.mess.uncodedShare + p.mess.localCodeShare > 1) err('mess', 'uncodedShare and localCodeShare together cannot exceed 1');
  if (p.mess.localCodeShare > 0 && !p.mess.localCode) err('mess.localCode', 'is required when localCodeShare is above 0');
  if (p.mess.unitSwapShare > 0 && !(p.control && p.control.unit)) warn('mess.unitSwapShare', 'a unit swap needs a control measure with a unit');

  // source
  if (!p.source.note) warn('source.note', 'no source note: say where the goals come from');
  if (!p.source.approvedBy) warn('source.approvedBy', 'not yet reviewed by a clinician');
  if (p.source.updatedAt && Number.isNaN(Date.parse(p.source.updatedAt))) err('source.updatedAt', 'is not a valid date');
  if (!Number.isInteger(p.source.version) || p.source.version < 1) err('source.version', 'must be a whole number, 1 or more');

  return { ok: errors.length === 0, errors, warnings };
}

function check(input, opts) {
  const profile = normalize(input);
  return { profile, ...validate(profile, opts) };
}

// ---------- storage and API (plan chunk 0.2) ----------
// Table disease_profiles (created in SCHEMA_SQL in server.js): key (PK), profile JSONB, enabled, builtin, updated_by, updated_at.
// Reads go through the read-only connection, writes through the owner connection. Every write is audited as disease.write (security.js).
//   GET    /api/diseases[?q=&department=&enabled=true|false]   list (summaries)
//   GET    /api/diseases/:key                                  one profile
//   POST   /api/diseases/validate     { profile }              dry run: { ok, errors, warnings, profile } (normalized), nothing stored
//   POST   /api/diseases              { profile }              create (201); 400 with errors; 409 when the key exists
//   PUT    /api/diseases/:key         { profile?, enabled? }   edit and / or switch on / off; a built-in profile can only be switched
//   DELETE /api/diseases/:key                                  refused (409) while another profile links to it; built-in profiles cannot be deleted
//   GET    /api/diseases/export[?keys=a,b&builtin=true&download=1]   (plan chunk 1.11c) a library document { format, version, exportedAt, count, needs, diseases: [profile, ...] };
//                                      built-in profiles are left out unless asked for (builtin=true or named in keys); needs = diseases the exported ones link to that are not in the file
//   POST   /api/diseases/import       { profile } | { profiles: [...] } | { diseases: [...] } (an export) | [...]   options: onExisting 'skip' (default) | 'overwrite', dryRun
//                                      every profile is validated first (links inside the file count, codes are checked as on create); one invalid profile and NOTHING is stored (400 with results);
//                                      built-in profiles are never replaced; an overwrite keeps the switch (on / off) and raises the version
//   GET    /api/diseases/review-sheet[?keys=a,b&builtin=true&format=csv|json]   (plan chunk 2.3) one row per profile: goals, drugs, intervals, source note and review status, plus empty
//                                      reviewer columns for a clinician; csv is a download. Registered BEFORE the /:key routes.
//   POST   /api/diseases/:key/truth-report   { profile?, count?, seed? }   (plan chunk 2.3) generates in memory and compares the generator's ground truth with what the records show
// Export, import and review-sheet are registered BEFORE the /:key routes.
// Department profiles (plan chunk 3.1a), table department_profiles, same rules as disease profiles (owner connection writes, read-only connection reads, audited as department.write):
//   GET    /api/departments[?q=&enabled=true|false]            list (summaries)
//   GET    /api/departments/:key                               one profile
//   POST   /api/departments/validate   { profile }             dry run: { ok, errors, warnings, profile }, nothing stored
//   POST   /api/departments            { profile }             create (201); 400 with errors; 409 when the key exists
//   PUT    /api/departments/:key       { profile?, enabled? }  edit and / or switch on / off (the key cannot change; a built-in one can only be switched)
//   GET    /api/departments/:key/bundle[?mode=]                the bundle resolved against the catalog and the diseases (analytics.js, chunk 3.2a); on save the bundle is checked against the catalog too
//   DELETE /api/departments/:key                               a built-in one cannot be deleted; diseases that still list the department are named in the answer
const COLS = 'key, profile, enabled, builtin, updated_by, updated_at';

// Codes the app knows without a database: the bundled demo dictionary (terminology.js) and the control measures listed in PLAUSIBLE.
const BUNDLED = new Set();
{
  const add = (sys, tbl) => Object.values(tbl || {}).forEach(e => { if (e && e.code) BUNDLED.add(sys + '|' + e.code); });
  [T.CONDITIONS, T.PROCEDURES, T.ALLERGENS, T.REACTIONS].forEach(t => add('snomed', t));
  add('rxnorm', T.MEDICATIONS); add('loinc', T.LABS); add('cvx', T.IMMUNIZATIONS);
  Object.keys(PLAUSIBLE).forEach(c => BUNDLED.add('loinc|' + c));
}

const httpErr = (status, message, extra) => Object.assign(new Error(message), { status, extra });

// Which of these [system, code] pairs exist in a reference: the bundled dictionary, codes seen in imported data (snomed_dictionary,
// any domain) and the loaded SNOMED concepts (snomed_concept). A missing table just means "nothing there yet".
async function knownCodes(db, pairs) {
  const found = new Set(pairs.filter(([s, c]) => BUNDLED.has(s + '|' + c)).map(([s, c]) => s + '|' + c));
  const rest = [...new Set(pairs.filter(([s, c]) => !found.has(s + '|' + c)).map(p => p[1]))];
  if (rest.length) {
    const inDb = new Set();
    for (const t of ['snomed_dictionary', 'snomed_concept']) {
      try { (await db.query(`SELECT code FROM ${t} WHERE code = ANY($1::text[])`, [rest])).rows.forEach(r => inDb.add(String(r.code))); }
      catch (e) { /* table not created yet */ }
    }
    for (const [s, c] of pairs) if (inDb.has(c)) found.add(s + '|' + c);
  }
  return found;
}

// normalize + validate against what is stored: links must point at existing diseases, codes must exist in a reference.
// DISEASE_CODE_CHECK=format switches the existence check off (format only), for sites without any reference loaded.
async function runCheck(db, raw) {
  const keys = (await db.query('SELECT key FROM disease_profiles')).rows.map(r => r.key);
  const wanted = new Map();
  const first = check(raw, { knownDiseases: keys, codeExists: (s, c) => { wanted.set(s + '|' + c, [s, c]); return true; } });
  if (String(process.env.DISEASE_CODE_CHECK || '').toLowerCase() === 'format' || !wanted.size) return first;
  const found = await knownCodes(db, [...wanted.values()]);
  return check(raw, { knownDiseases: keys, codeExists: (s, c) => found.has(s + '|' + c) });
}

const summary = r => {
  const p = r.profile || {};
  return { key: r.key, label: p.label || r.key, enabled: !!r.enabled, builtin: !!r.builtin, sensitive: !!p.sensitive, departments: p.departments || [],
    dx: { system: p.dx && p.dx.system, code: p.dx && p.dx.code, display: p.dx && p.dx.display }, approved: !!(p.source && p.source.approvedBy),
    updatedBy: r.updated_by || null, updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null };
};
const detail = r => ({ ...summary(r), profile: { ...r.profile, enabled: !!r.enabled } });

// ---------- department profiles (plan chunk 3.1a) ----------
// A department = a set of diseases + a measure set (what is shown first) + score definitions + an analytics bundle + an episode model for the generator + scope filters.
// Stored as JSON in department_profiles (SCHEMA_SQL in server.js). Catalog ids in the bundle are checked for FORMAT only here: chunk 3.2a checks them against the catalog.
const SCORE_DIRECTIONS = ['higher_worse', 'higher_better'], MEASURE_KINDS = ['lab', 'vital', 'score'], BUNDLE_MODES = ['v1', 'v2', 'v3', 'v4', 'v5'];
const ID_RE = /^[a-z][a-z0-9_]{1,59}$/;
function normalizeDepartment(input) {
  const p = isObj(input) ? input : {}, ep = isObj(p.episodeModel) ? p.episodeModel : {}, sf = isObj(p.scopeFilters) ? p.scopeFilters : {}, b = isObj(p.bundle) ? p.bundle : {}, sr = isObj(p.source) ? p.source : {};
  return {
    key: lower(p.key), label: str(p.label), enabled: asBool(p.enabled, true), sensitive: asBool(p.sensitive, false), description: str(p.description),
    diseases: strList(p.diseases),
    measureSet: (Array.isArray(p.measureSet) ? p.measureSet : []).map(m => { const o = isObj(m) ? m : {}, kind = lower(o.kind) || 'lab'; return { kind, ...normCode(o, kind === 'score' ? 'loinc' : 'loinc'), unit: str(o.unit) }; }),
    scores: (Array.isArray(p.scores) ? p.scores : []).map(x => { const o = isObj(x) ? x : {};
      return { key: lower(o.key), label: str(o.label), min: toNum(o.min), max: toNum(o.max), direction: lower(o.direction) || 'higher_worse',
        cutoffs: (Array.isArray(o.cutoffs) ? o.cutoffs : []).map(c => ({ label: str(c && c.label), from: toNum(c && c.from) })) }; }),
    bundle: { items: (Array.isArray(b.items) ? b.items : []).map(i => { const o = isObj(i) ? i : {}; return { analytic: lower(o.analytic), mode: lower(o.mode), sections: strList(o.sections) }; }) },
    episodeModel: { visitsPerYear: toNum(ep.visitsPerYear), admissionShare: toNum(ep.admissionShare), edShare: toNum(ep.edShare) },
    scopeFilters: { minAge: toNum(sf.minAge), maxAge: toNum(sf.maxAge), gender: lower(sf.gender) },
    source: { note: str(sr.note), version: toNum(sr.version) ?? 1, updatedBy: str(sr.updatedBy), updatedAt: str(sr.updatedAt), approvedBy: str(sr.approvedBy) }
  };
}
function validateDepartment(input, opts = {}) {
  const p = normalizeDepartment(input), errors = [], warnings = [], err = (path, message) => errors.push({ path, message }), warn = (path, message) => warnings.push({ path, message });
  const known = opts.knownDiseases ? setOf(opts.knownDiseases) : null;
  if (!p.key) err('key', 'is required'); else if (!KEY_RE.test(p.key)) err('key', 'must be 2 to 40 characters: a lower-case letter, then letters, digits or underscore');
  if (!p.label) err('label', 'is required'); else if (p.label.length > 80) err('label', 'is too long (80 characters at most)');
  if (p.description.length > 500) err('description', 'is too long (500 characters at most)');
  if (p.diseases.length > 100) err('diseases', 'lists too many diseases (100 at most)');
  p.diseases.forEach((d, i) => { if (!KEY_RE.test(d)) err(`diseases[${i}]`, `"${d.slice(0, 30)}" is not a valid disease key`); else if (known && !known.has(d)) err(`diseases[${i}]`, `unknown disease "${d}"`); });
  if (!p.diseases.length) warn('diseases', 'no disease is assigned yet');
  // scores first: score measures refer to them
  const scoreKeys = new Set();
  if (p.scores.length > 20) err('scores', 'has too many scores (20 at most)');
  p.scores.forEach((x, i) => {
    const at = `scores[${i}]`;
    if (!KEY_RE.test(x.key)) err(at + '.key', 'must be 2 to 40 characters: a lower-case letter, then letters, digits or underscore'); else if (scoreKeys.has(x.key)) err(at + '.key', `"${x.key}" is used twice`); else scoreKeys.add(x.key);
    if (!x.label) err(at + '.label', 'is required'); else if (x.label.length > 80) err(at + '.label', 'is too long (80 characters at most)');
    if (x.min === null || x.max === null) err(at, 'needs min and max (numbers)'); else if (x.min >= x.max) err(at, `min (${x.min}) must be below max (${x.max})`);
    if (!SCORE_DIRECTIONS.includes(x.direction)) err(at + '.direction', `must be one of: ${SCORE_DIRECTIONS.join(', ')}`);
    if (x.cutoffs.length > 10) err(at + '.cutoffs', 'has too many cutoffs (10 at most)');
    x.cutoffs.forEach((c, j) => { if (!c.label) err(`${at}.cutoffs[${j}].label`, 'is required'); if (c.from === null) err(`${at}.cutoffs[${j}].from`, 'is required, a number'); else if (x.min !== null && x.max !== null && (c.from < x.min || c.from > x.max)) err(`${at}.cutoffs[${j}].from`, `${c.from} is outside the score range ${x.min} to ${x.max}`); });
    for (let j = 1; j < x.cutoffs.length; j++) if (x.cutoffs[j].from !== null && x.cutoffs[j - 1].from !== null && x.cutoffs[j].from <= x.cutoffs[j - 1].from) err(`${at}.cutoffs[${j}].from`, 'cutoffs must go up (each above the one before)');
  });
  if (p.measureSet.length > 30) err('measureSet', 'has too many measures (30 at most)');
  const seen = new Set();
  p.measureSet.forEach((m, i) => {
    const at = `measureSet[${i}]`;
    if (!MEASURE_KINDS.includes(m.kind)) { err(at + '.kind', `must be one of: ${MEASURE_KINDS.join(', ')}`); return; }
    if (m.kind === 'score') {
      if (!scoreKeys.has(m.code)) err(at + '.code', `"${m.code.slice(0, 30)}" is not one of this department's scores`);
    } else if (!m.code) err(at + '.code', 'is required');
    else if (m.system !== 'loinc') err(at + '.system', 'a lab or vital measure uses loinc');
    else if (!CODE_RE.loinc.test(m.code)) err(at + '.code', `"${m.code.slice(0, 30)}" is not a LOINC code`);
    else if (opts.codeExists && !opts.codeExists(m.system, m.code)) err(at + '.code', `LOINC ${m.code} was not found in any reference table`);
    if (m.display.length > 120) err(at + '.display', 'is too long (120 characters at most)');
    const id = m.kind + '|' + m.code; if (seen.has(id)) err(at, `${m.kind} ${m.code} is listed twice`); seen.add(id);
  });
  if (p.bundle.items.length > 40) err('bundle.items', 'has too many items (40 at most)');
  const bseen = new Set();
  p.bundle.items.forEach((x, i) => {
    const at = `bundle.items[${i}]`;
    if (!ID_RE.test(x.analytic)) err(at + '.analytic', 'must be a catalog id (lower-case letters, digits, underscore)');
    if (x.mode && !BUNDLE_MODES.includes(x.mode)) err(at + '.mode', `must be one of: ${BUNDLE_MODES.join(', ')} (or empty for every mode)`);
    if (x.sections.length > 30) err(at + '.sections', 'lists too many sections (30 at most)');
    x.sections.forEach((s, j) => { if (!ID_RE.test(s)) err(`${at}.sections[${j}]`, `"${s.slice(0, 30)}" is not a valid section name`); });
    const id = x.analytic + '|' + x.mode; if (bseen.has(id)) err(at, `${x.analytic}${x.mode ? ' (' + x.mode + ')' : ''} is listed twice`); bseen.add(id);
    // chunk 3.2a: against the catalog, when the analytics module is loaded (opts.catalogInfo(id) -> { title, modes, sections | null } or null)
    const ci = ID_RE.test(x.analytic) && typeof opts.catalogInfo === 'function' ? opts.catalogInfo(x.analytic) : undefined;
    if (ci === null) err(at + '.analytic', `"${x.analytic}" is not in the analytics catalog`);
    else if (ci) {
      if (x.mode && BUNDLE_MODES.includes(x.mode) && !ci.modes.includes(x.mode)) err(at + '.mode', `${ci.title} has no ${x.mode.toUpperCase()} version (it has ${ci.modes.map(m => m.toUpperCase()).join(', ')})`);
      if (ci.sections) x.sections.forEach((n, j) => { const sec = ci.sections.find(y => y.name === n); if (!sec) err(`${at}.sections[${j}]`, `${ci.title} has no section "${n.slice(0, 30)}" (it has ${ci.sections.map(y => y.name).join(', ')})`); else if (x.mode && BUNDLE_MODES.includes(x.mode) && !sec.modes.includes(x.mode)) err(`${at}.sections[${j}]`, `section "${n}" is not offered in ${x.mode.toUpperCase()}`); });
    }
  });
  if (!p.bundle.items.length) warn('bundle.items', 'the bundle is empty: the department page will show no analytics');
  const e = p.episodeModel;
  if (e.visitsPerYear !== null && (e.visitsPerYear < 0 || e.visitsPerYear > 100)) err('episodeModel.visitsPerYear', 'must be between 0 and 100');
  for (const k of ['admissionShare', 'edShare']) if (e[k] !== null && (e[k] < 0 || e[k] > 1)) err('episodeModel.' + k, `must be between 0 and 1 (got ${e[k]})`);
  const f = p.scopeFilters;
  for (const k of ['minAge', 'maxAge']) if (f[k] !== null && (f[k] < 0 || f[k] > 120)) err('scopeFilters.' + k, 'must be between 0 and 120');
  if (f.minAge !== null && f.maxAge !== null && f.minAge > f.maxAge) err('scopeFilters', `minAge (${f.minAge}) is above maxAge (${f.maxAge})`);
  if (f.gender && !['male', 'female'].includes(f.gender)) err('scopeFilters.gender', 'must be male or female (or empty for everyone)');
  if (p.source.note.length > 1000) err('source.note', 'is too long (1000 characters at most)');
  if (!p.source.approvedBy) warn('source.approvedBy', 'not approved by a clinician yet');
  return { ok: !errors.length, errors, warnings };
}
const checkDepartment = (input, opts) => { const profile = normalizeDepartment(input); return { profile, ...validateDepartment(profile, opts) }; };
const DEPT_COLS = 'key, profile, enabled, builtin, updated_by, updated_at';
const deptSummary = r => { const p = r.profile || {};
  return { key: r.key, label: p.label || r.key, enabled: !!r.enabled, builtin: !!r.builtin, sensitive: !!p.sensitive, diseases: p.diseases || [], measures: (p.measureSet || []).length, scores: (p.scores || []).length,
    bundleItems: ((p.bundle && p.bundle.items) || []).length, approved: !!(p.source && p.source.approvedBy), updatedBy: r.updated_by || null, updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null }; };
const deptDetail = r => ({ ...deptSummary(r), profile: { ...r.profile, enabled: !!r.enabled } });
async function runDepartmentCheck(db, raw, catalogInfo) {
  const keys = (await db.query('SELECT key FROM disease_profiles')).rows.map(r => r.key);
  const wanted = new Map();
  const first = checkDepartment(raw, { knownDiseases: keys, catalogInfo, codeExists: (s, c) => { wanted.set(s + '|' + c, [s, c]); return true; } });
  if (String(process.env.DISEASE_CODE_CHECK || '').toLowerCase() === 'format' || !wanted.size) return first;
  const found = await knownCodes(db, [...wanted.values()]);
  return checkDepartment(raw, { knownDiseases: keys, catalogInfo, codeExists: (s, c) => found.has(s + '|' + c) });
}

function register(app, pool, opts = {}) {
  const rpool = opts.readPool || pool;
  const changed = () => { try { if (typeof opts.onChange === 'function') opts.onChange(); } catch (e) { /* a cache hook must never fail a write */ } };
  const who = req => str(req.user && req.user.email).slice(0, 254) || 'local';
  const fail = (res, status, error, extra) => res.status(status).json({ success: false, error, ...extra });
  const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { if (e && e.status) return fail(res, e.status, e.message, e.extra); console.error('Disease API error:', e.message); fail(res, 500, 'The disease profile request failed.'); }
  };
  const keyOf = req => { const k = lower(req.params.key); if (!KEY_RE.test(k)) throw httpErr(400, 'Invalid disease key.'); req.auditTarget = k; return k; };
  const bodyProfile = b => (isObj(b) ? (isObj(b.profile) ? b.profile : (b.key !== undefined || b.label !== undefined ? b : null)) : null);
  const stamp = (profile, req, enabled, version) => ({ ...profile, enabled, source: { ...profile.source, version, updatedBy: who(req), updatedAt: new Date().toISOString() } });
  const load = async key => (await pool.query(`SELECT ${COLS} FROM disease_profiles WHERE key = $1`, [key])).rows[0];
  const invalid = r => httpErr(400, 'The profile is not valid.', { errors: r.errors, warnings: r.warnings });

  app.get('/api/diseases', wrap(async (req, res) => {
    const all = (await rpool.query(`SELECT ${COLS} FROM disease_profiles ORDER BY key`)).rows;
    const q = lower(req.query.q), dep = lower(req.query.department), en = lower(req.query.enabled);
    const words = r => { const p = r.profile || {}; return [r.key, p.label, p.dx && p.dx.code, p.dx && p.dx.display, ...((p.dx && p.dx.terms) || [])]; };
    const rows = all.filter(r => (!q || words(r).some(v => lower(v).includes(q))) && (!dep || ((r.profile && r.profile.departments) || []).includes(dep))
      && (en !== 'true' && en !== 'false' || !!r.enabled === (en === 'true'))).map(summary);
    res.json({ success: true, count: rows.length, diseases: rows });
  }));

  // plan chunk 1.11c: export and import. Registered before the /:key routes (otherwise "export" would be read as a key).
  const LIB_FORMAT = 'vibe-rounds-disease-library', MAX_IMPORT = 200;
  const linksOf = p => [...((p && p.links) || []), ...((p && p.prevalence && p.prevalence.multipliers) || [])].map(l => l && l.disease).filter(Boolean);
  app.get('/api/diseases/review-sheet', wrap(async (req, res) => {
    const want = new Set(str(req.query.keys).split(',').map(lower).filter(Boolean)), withBuiltin = lower(req.query.builtin) !== 'false';
    const all = (await rpool.query(`SELECT ${COLS} FROM disease_profiles ORDER BY key`)).rows;
    const rows = all.filter(r => (want.size ? want.has(r.key) : withBuiltin || !r.builtin));
    const missing = [...want].filter(k => !rows.some(r => r.key === k));
    if (missing.length) throw httpErr(404, `No disease ${missing.map(k => `"${k}"`).join(', ')}.`);
    const sheet = reviewSheet(rows.map(r => detail(r).profile));
    if (lower(req.query.format) === 'csv') {
      if (typeof res.setHeader === 'function') { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="disease-review-sheet.csv"'); }
      return res.send(reviewSheetCsv(sheet));
    }
    res.json({ success: true, columns: REVIEW_COLUMNS, count: sheet.length, rows: sheet });
  }));

  app.get('/api/diseases/export', wrap(async (req, res) => {
    const want = new Set(str(req.query.keys).split(',').map(lower).filter(Boolean)), withBuiltin = lower(req.query.builtin) === 'true';
    const all = (await rpool.query(`SELECT ${COLS} FROM disease_profiles ORDER BY key`)).rows;
    const rows = all.filter(r => (want.size ? want.has(r.key) : withBuiltin || !r.builtin));
    const missing = [...want].filter(k => !rows.some(r => r.key === k));
    if (missing.length) throw httpErr(404, `No disease ${missing.map(k => `"${k}"`).join(', ')}.`);
    const diseases = rows.map(r => detail(r).profile), inFile = new Set(diseases.map(p => p.key));
    const needs = [...new Set(diseases.flatMap(linksOf))].filter(k => !inFile.has(k)).sort();
    const doc = { format: LIB_FORMAT, version: 1, exportedAt: new Date().toISOString(), count: diseases.length, needs, diseases };
    const dl = lower(req.query.download);
    if (dl && dl !== '0' && dl !== 'false' && typeof res.setHeader === 'function') res.setHeader('Content-Disposition', `attachment; filename="${want.size === 1 ? [...want][0] : 'disease-library'}.json"`);
    res.json(doc);
  }));

  // what the body holds: an export document, { profiles }, { diseases }, a bare list, { profile } or one flat profile
  const libOf = b => {
    if (Array.isArray(b)) return b;
    if (!isObj(b)) return null;
    if (Array.isArray(b.diseases)) return b.diseases;
    if (Array.isArray(b.profiles)) return b.profiles;
    if (isObj(b.library)) return libOf(b.library);
    const one = bodyProfile(b); return one ? [one] : null;
  };
  app.post('/api/diseases/import', wrap(async (req, res) => {
    const body = req.body, list = libOf(body);
    if (!list || !list.length) throw httpErr(400, 'Send one profile ({ profile }), a list ({ profiles: [...] }) or an exported library.');
    if (list.length > MAX_IMPORT) throw httpErr(400, `At most ${MAX_IMPORT} profiles per import (this file has ${list.length}).`);
    const opt = isObj(body) ? body : {}, mode = lower(opt.onExisting || req.query.onExisting || 'skip');
    if (mode !== 'skip' && mode !== 'overwrite') throw httpErr(400, 'onExisting must be "skip" or "overwrite".');
    const dryRun = opt.dryRun === true || lower(req.query.dryRun) === 'true';
    const raws = list.map(x => (isObj(x) ? (isObj(x.profile) ? x.profile : x) : null));
    const keys = raws.map(r => (r ? lower(r.key) : ''));
    req.auditTarget = (list.length === 1 && KEY_RE.test(keys[0]) ? keys[0] : `${list.length} profiles`).slice(0, 40);
    const stored = new Map((await pool.query(`SELECT ${COLS} FROM disease_profiles ORDER BY key`)).rows.map(r => [r.key, r]));
    // validate everything first; a link may point at a stored disease or at another profile in the same file
    const known = [...new Set([...stored.keys(), ...keys.filter(k => KEY_RE.test(k))])], wanted = new Map();
    const checkAll = codeExists => raws.map(r => (r ? check(r, { knownDiseases: known, codeExists }) : null));
    let checked = checkAll((s, c) => { wanted.set(s + '|' + c, [s, c]); return true; });
    if (String(process.env.DISEASE_CODE_CHECK || '').toLowerCase() !== 'format' && wanted.size) { const found = await knownCodes(pool, [...wanted.values()]); checked = checkAll((s, c) => found.has(s + '|' + c)); }
    const seen = new Set();
    const results = raws.map((r, i) => {
      const c = checked[i], key = keys[i] || null, base = { index: i, key, label: c ? c.profile.label : null };
      if (!r) return { ...base, status: 'invalid', errors: [{ path: '', message: 'not a profile object' }] };
      const errors = c.ok ? [] : c.errors.slice();
      if (seen.has(key)) errors.push({ path: 'key', message: 'the same key appears twice in this file' }); seen.add(key);
      if (errors.length) return { ...base, status: 'invalid', errors, warnings: c.warnings };
      const cur = stored.get(c.profile.key);
      const status = !cur ? 'created' : cur.builtin ? 'skipped_builtin' : mode === 'overwrite' ? 'updated' : 'skipped_exists';
      return { ...base, status, warnings: c.warnings };
    });
    const bad = results.filter(r => r.status === 'invalid');
    if (bad.length) throw httpErr(400, `Nothing was imported: ${bad.length} of ${results.length} profile${results.length === 1 ? ' is' : 's are'} not valid.`, { results, imported: 0 });
    if (!dryRun) {
      for (const r of results) {
        if (r.status !== 'created' && r.status !== 'updated') continue;
        const c = checked[r.index], cur = stored.get(c.profile.key);
        if (r.status === 'created') {
          const p = stamp(c.profile, req, c.profile.enabled, 1);
          const ins = await pool.query(`INSERT INTO disease_profiles (key, profile, enabled, builtin, updated_by) VALUES ($1, $2::jsonb, $3, FALSE, $4)
            ON CONFLICT (key) DO NOTHING RETURNING ${COLS}`, [p.key, JSON.stringify(p), p.enabled, who(req)]);
          if (!ins.rows.length) r.status = 'skipped_exists';                      // someone created it a moment ago
        } else {
          const enabled = !!cur.enabled, p = stamp(c.profile, req, enabled, Math.max(1, Number(cur.profile && cur.profile.source && cur.profile.source.version) || 1) + 1);
          await pool.query(`UPDATE disease_profiles SET profile = $2::jsonb, enabled = $3, updated_by = $4, updated_at = NOW() WHERE key = $1 RETURNING ${COLS}`, [p.key, JSON.stringify(p), enabled, who(req)]);
        }
      }
      if (results.some(r => r.status === 'created' || r.status === 'updated')) changed();
    }
    const counts = { created: 0, updated: 0, skipped_exists: 0, skipped_builtin: 0 }; results.forEach(r => { counts[r.status]++; });
    res.status(!dryRun && counts.created ? 201 : 200).json({ success: true, dryRun, onExisting: mode, counts, results });
  }));

  app.get('/api/diseases/:key', wrap(async (req, res) => {
    const k = keyOf(req);
    const r = (await rpool.query(`SELECT ${COLS} FROM disease_profiles WHERE key = $1`, [k])).rows[0];
    if (!r) throw httpErr(404, `No disease "${k}".`);
    res.json({ success: true, disease: detail(r) });
  }));

  app.post('/api/diseases/validate', wrap(async (req, res) => {
    const raw = bodyProfile(req.body); if (!raw) throw httpErr(400, 'Send the profile as { profile: {...} }.');
    const r = await runCheck(rpool, raw);
    res.json({ success: true, ok: r.ok, errors: r.errors, warnings: r.warnings, profile: r.profile });
  }));

  // plan chunk 1.11a: generate a small synthetic population in memory (nothing is written) and summarise the disease it produced.
  // Send { profile } to preview what is in the form (saved or not), or nothing to preview the saved profile. Optional: count (1 to 200, default 20), seed, years.
  app.post('/api/diseases/:key/preview', wrap(async (req, res) => {
    const k = keyOf(req), b = isObj(req.body) ? req.body : {};
    let raw = isObj(b.profile) ? { ...b.profile } : null;
    if (!raw) {
      const cur = (await rpool.query(`SELECT ${COLS} FROM disease_profiles WHERE key = $1`, [k])).rows[0];
      if (!cur) throw httpErr(404, `No disease \"${k}\". Send { profile } to preview one that is not saved yet.`);
      raw = { ...cur.profile };
    }
    const r = await runCheck(rpool, { ...raw, key: k, enabled: true }); if (!r.ok) throw invalid(r);
    // diseases this one links to (links, prevalence multipliers) are generated too, otherwise its rates could not be worked out
    const list = [r.profile], have = new Set([k]), linked = p => [...(p.links || []), ...((p.prevalence && p.prevalence.multipliers) || [])].map(l => l && l.disease).filter(Boolean);
    for (let todo = linked(r.profile); todo.length;) {
      const key = todo.shift(); if (have.has(key)) continue; have.add(key);
      const row = (await rpool.query(`SELECT ${COLS} FROM disease_profiles WHERE key = $1`, [key])).rows[0];
      if (row && row.profile) { list.unshift({ ...row.profile, enabled: true }); todo.push(...linked(row.profile)); }
    }
    const n = Math.max(1, Math.min(200, Math.floor(Number(b.count)) || 20)), seed = b.seed === undefined || b.seed === null || b.seed === '' ? 42 : String(b.seed).slice(0, 40);
    const out = require('./synthetic').generateBundle({ count: n, seed, years: b.years, endDate: new Date().toISOString().slice(0, 10), profiles: list });
    const skipped = ((out.summary.diseaseProfiles || {}).skipped || []).find(x => x.key === k);
    res.json({ success: true, key: k, label: r.profile.label, warnings: r.warnings, sample: { patients: n, seed, years: out.summary.years, endDate: out.summary.endDate },
      skipped: skipped ? skipped.reason : null, ...(skipped ? {} : summarizePreview(r.profile, out, n)) });
  }));

  app.post('/api/diseases/:key/truth-report', wrap(async (req, res) => {
    const k = keyOf(req), b = isObj(req.body) ? req.body : {};
    let raw = isObj(b.profile) ? { ...b.profile } : null;
    if (!raw) {
      const cur = (await rpool.query(`SELECT ${COLS} FROM disease_profiles WHERE key = $1`, [k])).rows[0];
      if (!cur) throw httpErr(404, `No disease \"${k}\". Send { profile } to check one that is not saved yet.`);
      raw = { ...cur.profile };
    }
    const r = await runCheck(rpool, { ...raw, key: k, enabled: true }); if (!r.ok) throw invalid(r);
    const list = [r.profile], have = new Set([k]), linked = p => [...(p.links || []), ...((p.prevalence && p.prevalence.multipliers) || [])].map(l => l && l.disease).filter(Boolean);
    for (let todo = linked(r.profile); todo.length;) {
      const key = todo.shift(); if (have.has(key)) continue; have.add(key);
      const row = (await rpool.query(`SELECT ${COLS} FROM disease_profiles WHERE key = $1`, [key])).rows[0];
      if (row && row.profile) { list.unshift({ ...row.profile, enabled: true }); todo.push(...linked(row.profile)); }
    }
    const n = Math.max(50, Math.min(2000, Math.floor(Number(b.count)) || 400)), seed = b.seed === undefined || b.seed === null || b.seed === '' ? 42 : String(b.seed).slice(0, 40);
    const out = require('./synthetic').generateBundle({ count: n, seed, years: b.years, endDate: new Date().toISOString().slice(0, 10), profiles: list });
    const skipped = ((out.summary.diseaseProfiles || {}).skipped || []).find(x => x.key === k);
    res.json({ success: true, key: k, label: r.profile.label, sample: { patients: n, seed, years: out.summary.years, endDate: out.summary.endDate },
      skipped: skipped ? skipped.reason : null, ...(skipped ? {} : { report: truthReport(r.profile, out, n) }) });
  }));

  app.post('/api/diseases', wrap(async (req, res) => {
    const raw = bodyProfile(req.body); if (!raw) throw httpErr(400, 'Send the profile as { profile: {...} }.');
    if (str(raw.key)) req.auditTarget = lower(raw.key).slice(0, 40);
    const r = await runCheck(pool, raw); if (!r.ok) throw invalid(r);
    const p = stamp(r.profile, req, r.profile.enabled, 1);
    const ins = await pool.query(`INSERT INTO disease_profiles (key, profile, enabled, builtin, updated_by) VALUES ($1, $2::jsonb, $3, FALSE, $4)
      ON CONFLICT (key) DO NOTHING RETURNING ${COLS}`, [p.key, JSON.stringify(p), p.enabled, who(req)]);
    if (!ins.rows.length) throw httpErr(409, `A disease "${p.key}" already exists.`);
    changed();
    res.status(201).json({ success: true, disease: detail(ins.rows[0]), warnings: r.warnings });
  }));

  app.put('/api/diseases/:key', wrap(async (req, res) => {
    const k = keyOf(req), b = isObj(req.body) ? req.body : {};
    const raw = isObj(b.profile) ? b.profile : null, hasEnabled = typeof b.enabled === 'boolean';
    if (!raw && !hasEnabled) throw httpErr(400, 'Send { profile } and / or { enabled: true|false }.');
    const cur = await load(k); if (!cur) throw httpErr(404, `No disease "${k}".`);
    if (raw && cur.builtin) throw httpErr(403, 'A built-in profile cannot be edited: copy it under a new key. It can still be switched on or off.', { code: 'BUILTIN' });
    if (raw && str(raw.key) && lower(raw.key) !== k) throw httpErr(400, 'The key cannot be changed.', { errors: [{ path: 'key', message: 'cannot be changed; create a new profile instead' }] });
    const enabled = hasEnabled ? b.enabled : !!cur.enabled;
    let p;
    if (raw) {
      const r = await runCheck(pool, { ...raw, key: k, enabled }); if (!r.ok) throw invalid(r);
      p = stamp(r.profile, req, enabled, Math.max(1, Number(cur.profile && cur.profile.source && cur.profile.source.version) || 1) + 1);
    } else p = { ...cur.profile, enabled };
    const up = await pool.query(`UPDATE disease_profiles SET profile = $2::jsonb, enabled = $3, updated_by = $4, updated_at = NOW() WHERE key = $1 RETURNING ${COLS}`,
      [k, JSON.stringify(p), enabled, who(req)]);
    changed();
    res.json({ success: true, disease: detail(up.rows[0]) });
  }));

  app.delete('/api/diseases/:key', wrap(async (req, res) => {
    const k = keyOf(req);
    const cur = await load(k); if (!cur) throw httpErr(404, `No disease "${k}".`);
    if (cur.builtin) throw httpErr(403, 'A built-in profile cannot be deleted. Switch it off instead.', { code: 'BUILTIN' });
    const others = (await pool.query('SELECT key, profile FROM disease_profiles WHERE key <> $1', [k])).rows;
    const dependents = others.filter(o => { const p = o.profile || {}; return [...(p.links || []), ...((p.prevalence && p.prevalence.multipliers) || [])].some(l => l && l.disease === k); }).map(o => o.key);
    if (dependents.length) throw httpErr(409, `Other diseases link to "${k}": ${dependents.join(', ')}. Remove those links first.`, { dependents });
    const del = await pool.query('DELETE FROM disease_profiles WHERE key = $1 AND NOT builtin RETURNING key', [k]);
    if (!del.rows.length) throw httpErr(404, `No disease "${k}".`);
    changed();
    res.json({ success: true, deleted: k });
  }));

  // ---- department profiles (plan chunk 3.1a)
  const cinfo = () => (typeof opts.catalogInfo === 'function' ? opts.catalogInfo : app.locals && typeof app.locals.catalogInfo === 'function' ? app.locals.catalogInfo : undefined);   // looked up per request: analytics.js registers first
  const dload = async key => (await pool.query(`SELECT ${DEPT_COLS} FROM department_profiles WHERE key = $1`, [key])).rows[0];
  const dstamp = (profile, req, enabled, version) => ({ ...profile, enabled, source: { ...profile.source, version, updatedBy: who(req), updatedAt: new Date().toISOString() } });
  app.get('/api/departments', wrap(async (req, res) => {
    const q = lower(req.query.q), en = lower(req.query.enabled);
    let rows = (await rpool.query(`SELECT ${DEPT_COLS} FROM department_profiles ORDER BY key`)).rows.map(deptSummary);
    if (q) rows = rows.filter(r => r.key.includes(q) || lower(r.label).includes(q));
    if (en === 'true' || en === 'false') rows = rows.filter(r => r.enabled === (en === 'true'));
    res.json({ success: true, count: rows.length, departments: rows });
  }));
  app.post('/api/departments/validate', wrap(async (req, res) => {
    const raw = bodyProfile(req.body); if (!raw) throw httpErr(400, 'Send the profile as { profile: {...} }.');
    const r = await runDepartmentCheck(rpool, raw, cinfo());
    res.json({ success: true, ok: r.ok, errors: r.errors, warnings: r.warnings, profile: r.profile });
  }));
  // chunk 3.5a: POST /api/departments/install-library { keys?, dryRun? } stores the library departments that are missing (never overwrites; an existing department stays as it is; a deleted one comes back, so
  // use keys to choose). Diseases of a library department that have no profile here are left out of it and named in the answer. Audited as department.write.
  app.post('/api/departments/install-library', wrap(async (req, res) => {
    const b = isObj(req.body) ? req.body : {}, want = new Set((Array.isArray(b.keys) ? b.keys : []).map(lower).filter(Boolean)), dry = b.dryRun === true;
    const have = new Set((await pool.query('SELECT key FROM disease_profiles')).rows.map(r => r.key)), results = [];
    for (const raw of libraryDepartments(1)) {
      if (want.size && !want.has(raw.key)) continue;
      if (await dload(raw.key)) { results.push({ key: raw.key, status: 'skipped_exists' }); continue; }
      const missing = raw.diseases.filter(d => !have.has(d)), r = await runDepartmentCheck(pool, { ...raw, diseases: raw.diseases.filter(d => have.has(d)) }, cinfo());
      if (!r.ok) { results.push({ key: raw.key, status: 'invalid', errors: r.errors }); continue; }
      if (!dry) {
        const p = dstamp(r.profile, req, true, 1);
        const ins = await pool.query(`INSERT INTO department_profiles (key, profile, enabled, builtin, updated_by) VALUES ($1, $2::jsonb, $3, FALSE, $4) ON CONFLICT (key) DO NOTHING RETURNING key`, [p.key, JSON.stringify(p), true, who(req)]);
        if (!ins.rows.length) { results.push({ key: raw.key, status: 'skipped_exists' }); continue; }
      }
      results.push({ key: raw.key, status: dry ? 'would_create' : 'created', diseases: r.profile.diseases.length, missingDiseases: missing, warnings: r.warnings.length });
    }
    const counts = {}; results.forEach(x => { counts[x.status] = (counts[x.status] || 0) + 1; });
    if (!dry && counts.created) changed();
    res.json({ success: true, dryRun: dry, counts, results });
  }));
  app.get('/api/departments/:key', wrap(async (req, res) => {
    const k = keyOf(req), row = (await rpool.query(`SELECT ${DEPT_COLS} FROM department_profiles WHERE key = $1`, [k])).rows[0];
    if (!row) throw httpErr(404, `No department "${k}".`);
    res.json({ success: true, department: deptDetail(row) });
  }));
  app.post('/api/departments', wrap(async (req, res) => {
    const raw = bodyProfile(req.body); if (!raw) throw httpErr(400, 'Send the profile as { profile: {...} }.');
    if (str(raw.key)) req.auditTarget = lower(raw.key).slice(0, 40);
    const r = await runDepartmentCheck(pool, raw, cinfo()); if (!r.ok) throw invalid(r);
    const p = dstamp(r.profile, req, r.profile.enabled, 1);
    const ins = await pool.query(`INSERT INTO department_profiles (key, profile, enabled, builtin, updated_by) VALUES ($1, $2::jsonb, $3, FALSE, $4)
      ON CONFLICT (key) DO NOTHING RETURNING ${DEPT_COLS}`, [p.key, JSON.stringify(p), p.enabled, who(req)]);
    if (!ins.rows.length) throw httpErr(409, `A department "${p.key}" already exists.`);
    changed();
    res.status(201).json({ success: true, department: deptDetail(ins.rows[0]), warnings: r.warnings });
  }));
  app.put('/api/departments/:key', wrap(async (req, res) => {
    const k = keyOf(req), b = isObj(req.body) ? req.body : {};
    const raw = isObj(b.profile) ? b.profile : null, hasEnabled = typeof b.enabled === 'boolean';
    if (!raw && !hasEnabled) throw httpErr(400, 'Send { profile } and / or { enabled: true|false }.');
    const cur = await dload(k); if (!cur) throw httpErr(404, `No department "${k}".`);
    if (raw && cur.builtin) throw httpErr(403, 'A built-in department cannot be edited: copy it under a new key. It can still be switched on or off.', { code: 'BUILTIN' });
    if (raw && str(raw.key) && lower(raw.key) !== k) throw httpErr(400, 'The key cannot be changed.', { errors: [{ path: 'key', message: 'cannot be changed; create a new department instead' }] });
    const enabled = hasEnabled ? b.enabled : !!cur.enabled;
    let p, warnings = [];
    if (raw) {
      const r = await runDepartmentCheck(pool, { ...raw, key: k, enabled }, cinfo()); if (!r.ok) throw invalid(r);
      warnings = r.warnings;
      p = dstamp(r.profile, req, enabled, Math.max(1, Number(cur.profile && cur.profile.source && cur.profile.source.version) || 1) + 1);
    } else p = { ...cur.profile, enabled };
    const up = await pool.query(`UPDATE department_profiles SET profile = $2::jsonb, enabled = $3, updated_by = $4, updated_at = NOW() WHERE key = $1 RETURNING ${DEPT_COLS}`, [k, JSON.stringify(p), enabled, who(req)]);
    changed();
    res.json({ success: true, department: deptDetail(up.rows[0]), warnings });
  }));
  app.delete('/api/departments/:key', wrap(async (req, res) => {
    const k = keyOf(req), cur = await dload(k); if (!cur) throw httpErr(404, `No department "${k}".`);
    if (cur.builtin) throw httpErr(403, 'A built-in department cannot be deleted. Switch it off instead.', { code: 'BUILTIN' });
    const del = await pool.query('DELETE FROM department_profiles WHERE key = $1 AND NOT builtin RETURNING key', [k]);
    if (!del.rows.length) throw httpErr(404, `No department "${k}".`);
    const listing = (await pool.query('SELECT key, profile FROM disease_profiles')).rows.filter(o => ((o.profile || {}).departments || []).includes(k)).map(o => o.key);
    changed();
    res.json({ success: true, deleted: k, diseasesStillListingIt: listing });
  }));
}

// ---------- built-in profiles (plan chunk 0.3) ----------
// Diabetes and hypertension, the two diseases the Disease module used to hardcode. Everything the module reads comes from terminology.js exactly as before
// (condition code, control lab, goal, drugs in line order), so its numbers do not change. The generator fields (age curve, start / target values, drug share)
// are approximations of what synthetic.js draws today; chunk 1.x makes the generator read them. Demo values: a clinician must review them (approvedBy is empty).
const SEED_NOTE = 'Built-in demo profile, moved from the former hardcoded Disease module list (terminology.js control measures and treatment map). Generator values approximate synthetic.js. Not clinician-reviewed.';
// Age bands with the rate synthetic.js uses at the band's middle age: clamp((age - from) / div, 0, cap), the same for both sexes.
const ageCurve = (from, div, cap) => [[18, 30], [30, 40], [40, 50], [50, 60], [60, 70], [70, 80], [80, 100]].map(([a, b]) => {
  const r = Math.round(Math.min(Math.max(((a + b) / 2 - from) / div, 0), cap) * 1000) / 1000;
  return { from: a, to: b, male: r, female: r };
});
const SEED_SPEC = [
  { key: 'diabetes', measure: 'diabetes_hba1c', short: 'HbA1c', unit: '%', label: 'Type 2 diabetes', icd10: 'E11.9', departments: ['endocrinology', 'family_medicine', 'internal_medicine'],
    curve: [30, 160, 0.3], multipliers: [], start: [8.8, 0.8], target: 6.2, shares: [[0.9, 0], [0.25, 365]] },
  { key: 'hypertension', measure: 'htn_bp', short: 'systolic BP', unit: 'mm[Hg]', label: 'Hypertension', icd10: 'I10', departments: ['cardiology', 'family_medicine', 'internal_medicine'],
    curve: [25, 90, 0.6], multipliers: [{ disease: 'diabetes', multiplier: 1.3 }], start: [152, 8], target: 122, shares: [[0.38, 0], [0.26, 0], [0.21, 0]] }
];
function seedProfiles() {
  return SEED_SPEC.map(s => {
    const m = T.CONTROL_MEASURES[s.measure], cond = T.CONDITIONS[m.condition], lab = T.LABS[m.lab], drugs = T.TREATMENT_MAP[m.condition];
    return {
      key: s.key, label: s.label, enabled: true, sensitive: false, departments: s.departments,
      dx: { system: 'snomed', code: cond.code, display: cond.display, terms: cond.terms.slice(), icd10: s.icd10 },
      prevalence: { minAge: 18, ageBands: ageCurve(...s.curve), onset: { shape: 'normal', mean: 55, sd: 12 }, multipliers: s.multipliers },
      course: { type: 'chronic' },
      control: { type: 'lab', system: 'loinc', code: lab.code, display: s.short, unit: s.unit, goal: Number(m.goalBelow), direction: 'below', lookbackDays: 365,
        start: { mean: s.start[0], sd: s.start[1] }, target: s.target, decayDays: 150 },
      treatment: drugs.map((k, i) => ({ system: 'rxnorm', code: T.MEDICATIONS[k].code, display: T.MEDICATIONS[k].display, line: i + 1, probability: s.shares[i][0], lagDays: s.shares[i][1], renewalDays: 30 })),
      source: { note: SEED_NOTE, version: 1, updatedBy: 'system', approvedBy: '' }
    };
  });
}

// ---------- seed library, batch 1 (plan chunk 2.1) ----------
// Five family-medicine profiles that are NOT built in: libraryProfiles() returns them, `node diseases.js --write-library` writes disease-library-batch1.json, and the Diseases tab
// imports that file (Import profiles; they arrive switched on, editable and deletable). Why separate from seedProfiles(): the generator leaves out any disease whose key or code
// terminology.js already has (the built-in condition model writes those), and hyperlipidemia, obesity, asthma, copd and ckd are all there. So each profile here uses a more
// specific SNOMED concept (not in terminology.js) and a new key, which lets the generator write it from the profile. Goals, rates and drug choices are demo values for the
// generator ("needs clinician review", approvedBy empty); the SNOMED codes must be checked against the reference loaded on your server (the Add / Import check does that).
// Only drugs, labs, vaccines and procedures that terminology.js already has are used, so every code below is one the rest of the app knows.
const LIB_NOTE = 'Seed library batch 1: demo values for the sample-data generator. NEEDS CLINICIAN REVIEW (goals, rates, drugs and intervals are not approved). ';
function libraryProfiles(batch = 1) {
  const lab = k => ({ system: 'loinc', code: T.LABS[k].code }), drug = (k, line, probability, lagDays, extra = {}) => ({ system: 'rxnorm', code: T.MEDICATIONS[k].code, display: T.MEDICATIONS[k].display, line, probability, lagDays, renewalDays: 30, ...extra });
  const test = (k, display, c, u) => ({ kind: 'test', ...lab(k), display, intervalControlledDays: c, intervalUncontrolledDays: u });
  const flu = { kind: 'vaccine', system: 'cvx', code: T.IMMUNIZATIONS.influenza.code, display: 'Influenza vaccine', intervalControlledDays: 365, intervalUncontrolledDays: 365 };
  const bands = rows => rows.map(([from, to, r]) => ({ from, to, male: r, female: r }));
  const base = (key, label, departments, dx, extra) => ({
    key, label, enabled: true, sensitive: false, departments, dx: { system: 'snomed', ...dx }, links: [],
    mess: { uncodedShare: 0.04, localCodeShare: 0, localCode: '', lowercaseShare: 0.15, unitSwapShare: 0 },
    ...extra, source: { note: LIB_NOTE + extra.note, version: 1, updatedBy: 'system', approvedBy: '' }
  });
  if (batch === 2) {
    // Batch 2 (plan chunk 2.2). terminology.js has none of these labs or drugs, so the codes are written here: LOINC 3016-3 TSH, 3024-7 free T4, 3084-1 uric acid, 44261-6 PHQ-9;
    // RxNorm ingredient codes (not tablet-level, unlike the codes in terminology.js): levothyroxine 10582, methimazole 6835, propranolol 8787, escitalopram 321988, sertraline (terminology.js),
    // omeprazole 7646, pantoprazole 40790, allopurinol 519, colchicine 2683, acetaminophen 161, naproxen 7258. Check them against your RxNorm / LOINC / SNOMED reference before clinical use.
    const L2 = (code, display) => ({ system: 'loinc', code, display }), rx = (code, display, line, probability, lagDays, extra = {}) => ({ system: 'rxnorm', code, display, line, probability, lagDays, renewalDays: 30, ...extra });
    const t2 = (code, display, c, u) => ({ kind: 'test', system: 'loinc', code, display, intervalControlledDays: c, intervalUncontrolledDays: u });
    const sexBands = rows => rows.map(([from, to, male, female]) => ({ from, to, male, female }));
    return [
      base('hypothyroidism', 'Hypothyroidism', ['endocrinology', 'family_medicine', 'internal_medicine'],
        { code: '40930008', display: 'Hypothyroidism (disorder)', terms: ['hypothyroidism', 'underactive thyroid', 'hashimoto', 'low thyroid'], icd10: 'E03.9' }, {
          note: 'Control = latest TSH inside 0.4 to 4.0 mIU/L on levothyroxine; the usual reference range, individual targets vary. More common in women.',
          prevalence: { minAge: 18, ageBands: sexBands([[18, 30, 0.01, 0.03], [30, 50, 0.02, 0.07], [50, 70, 0.04, 0.12], [70, 100, 0.06, 0.16]]), onset: { shape: 'normal', mean: 48, sd: 15 }, multipliers: [] },
          course: { type: 'chronic', severity: { mild: 0.7, moderate: 0.25, severe: 0.05 }, events: {} },
          control: { type: 'lab', ...L2('3016-3', 'TSH'), unit: 'm[IU]/L', goal: 0.4, goalHigh: 4, direction: 'range', lookbackDays: 365, start: { mean: 9, sd: 3 }, target: 2, decayDays: 120 },
          treatment: [rx('10582', 'levothyroxine', 1, 0.9, 14)], monitoring: [t2('3016-3', 'TSH', 365, 90)] }),
      base('hyperthyroidism', 'Hyperthyroidism', ['endocrinology', 'family_medicine', 'internal_medicine'],
        { code: '34486009', display: 'Hyperthyroidism (disorder)', terms: ['hyperthyroidism', 'overactive thyroid', 'graves', 'thyrotoxicosis'], icd10: 'E05.90' }, {
          note: 'Control = latest free T4 inside 0.8 to 1.8 ng/dL (a typical reference range; TSH is suppressed early in treatment, so free T4 is used). Methimazole first, propranolol for symptoms.',
          prevalence: { minAge: 18, ageBands: sexBands([[18, 40, 0.003, 0.012], [40, 70, 0.005, 0.02], [70, 100, 0.008, 0.025]]), onset: { shape: 'normal', mean: 45, sd: 15 }, multipliers: [] },
          course: { type: 'chronic', severity: { mild: 0.5, moderate: 0.35, severe: 0.15 }, events: { ed: { controlled: 0.01, uncontrolled: 0.08 } } },
          control: { type: 'lab', ...L2('3024-7', 'Free T4'), unit: 'ng/dL', goal: 0.8, goalHigh: 1.8, direction: 'range', lookbackDays: 180, start: { mean: 3, sd: 0.6 }, target: 1.3, decayDays: 90 },
          treatment: [rx('6835', 'methimazole', 1, 0.85, 7), rx('8787', 'propranolol', 2, 0.4, 7)], monitoring: [t2('3024-7', 'Free T4', 90, 45), t2('3016-3', 'TSH', 180, 90)] }),
      base('depression_mild', 'Depression, mild', ['psychiatry', 'family_medicine', 'internal_medicine'],
        { code: '310495003', display: 'Mild depression (disorder)', terms: ['depression', 'mild depression', 'low mood', 'depressive symptoms'], icd10: 'F32.0' }, {
          note: 'Depression is followed with a score (PHQ-9), and score control measures arrive with phase 4, so there is no control measure yet; PHQ-9 is monitored as a test. Mental-health diagnoses may need the sensitive flag at your site (switch it on in the form).',
          prevalence: { minAge: 18, ageBands: sexBands([[18, 30, 0.06, 0.1], [30, 50, 0.05, 0.09], [50, 70, 0.04, 0.07], [70, 100, 0.04, 0.06]]), onset: { shape: 'uniform', mean: null, sd: null }, multipliers: [] },
          course: { type: 'episodic', severity: { mild: 0.8, moderate: 0.18, severe: 0.02 }, events: {} },
          control: null, treatment: [rx(T.MEDICATIONS.sertraline.code, T.MEDICATIONS.sertraline.display, 1, 0.5, 14), rx('321988', 'escitalopram', 2, 0.2, 60)],
          monitoring: [t2('44261-6', 'PHQ-9 total score', 120, 60)] }),
      base('gerd', 'Gastro-oesophageal reflux disease', ['gastroenterology', 'family_medicine', 'internal_medicine'],
        { code: '235595009', display: 'Gastroesophageal reflux disease (disorder)', terms: ['gerd', 'reflux', 'acid reflux', 'heartburn', 'gastroesophageal reflux'], icd10: 'K21.9' }, {
          note: 'Control is by symptoms, so there is no control measure. A proton-pump inhibitor is first line.',
          prevalence: { minAge: 18, ageBands: sexBands([[18, 30, 0.1, 0.1], [30, 50, 0.16, 0.16], [50, 70, 0.22, 0.22], [70, 100, 0.2, 0.2]]), onset: { shape: 'uniform', mean: null, sd: null }, multipliers: [] },
          course: { type: 'chronic', severity: { mild: 0.65, moderate: 0.28, severe: 0.07 }, events: {} },
          control: null, treatment: [rx('7646', 'omeprazole', 1, 0.7, 7), rx('40790', 'pantoprazole', 2, 0.15, 90)], monitoring: [] }),
      base('gout', 'Gout', ['rheumatology', 'family_medicine', 'internal_medicine'],
        { code: '90560007', display: 'Gout (disorder)', terms: ['gout', 'gouty arthritis', 'hyperuricemia', 'podagra'], icd10: 'M10.9' }, {
          note: 'Control = latest serum uric acid below 6 mg/dL on urate-lowering treatment (the usual target). Allopurinol first line; colchicine is added for flares. Linked to hypertension, which must exist where this is imported.',
          prevalence: { minAge: 18, ageBands: sexBands([[18, 40, 0.01, 0.002], [40, 60, 0.05, 0.01], [60, 80, 0.09, 0.03], [80, 100, 0.1, 0.05]]), onset: { shape: 'normal', mean: 52, sd: 13 }, multipliers: [{ disease: 'hypertension', multiplier: 1.5 }] },
          course: { type: 'episodic', severity: { mild: 0.5, moderate: 0.35, severe: 0.15 }, events: { ed: { controlled: 0.02, uncontrolled: 0.1 } } },
          control: { type: 'lab', ...L2('3084-1', 'Uric acid'), unit: 'mg/dL', goal: 6, direction: 'below', lookbackDays: 365, start: { mean: 8.4, sd: 1 }, target: 5.4, decayDays: 150 },
          treatment: [rx('519', 'allopurinol', 1, 0.6, 30), rx('2683', 'colchicine', 2, 0.3, 30)], monitoring: [t2('3084-1', 'Uric acid', 180, 90), t2(T.LABS.creatinine.code, 'Creatinine', 365, 180)] }),
      base('osteoarthritis', 'Osteoarthritis', ['rheumatology', 'orthopaedics', 'family_medicine'],
        { code: '396275006', display: 'Osteoarthritis (disorder)', terms: ['osteoarthritis', 'oa', 'degenerative joint disease', 'knee pain'], icd10: 'M19.90' }, {
          note: 'Control is by pain and function scores, so there is no control measure yet. Acetaminophen and an oral NSAID (naproxen) are the usual first steps.',
          prevalence: { minAge: 30, ageBands: ageCurve(35, 110, 0.5).filter(b => b.from >= 30), onset: { shape: 'late', mean: 62, sd: 11 }, multipliers: [] },
          course: { type: 'chronic', severity: { mild: 0.55, moderate: 0.35, severe: 0.1 }, events: { procedure: { controlled: 0.005, uncontrolled: 0.03 } } },
          control: null, treatment: [rx('161', 'acetaminophen', 1, 0.6, 0), rx('7258', 'naproxen', 2, 0.35, 30)], monitoring: [] })
    ];
  }
  const out = [
    base('hypercholesterolaemia', 'Hypercholesterolaemia', ['family_medicine', 'cardiology', 'internal_medicine'],
      { code: '13644009', display: 'Hypercholesterolemia (disorder)', terms: ['hypercholesterolemia', 'hypercholesterolaemia', 'high cholesterol', 'raised ldl'], icd10: 'E78.0' }, {
        note: 'LDL goal below 100 mg/dL is the common primary-prevention goal; individual goals depend on cardiovascular risk.',
        prevalence: { minAge: 18, ageBands: ageCurve(25, 120, 0.35), onset: { shape: 'normal', mean: 50, sd: 12 }, multipliers: [{ disease: 'diabetes', multiplier: 1.4 }] },
        course: { type: 'chronic', severity: { mild: 0.6, moderate: 0.3, severe: 0.1 }, events: {} },
        control: { type: 'lab', ...lab('ldl'), display: 'LDL cholesterol', unit: 'mg/dL', goal: 100, direction: 'below', lookbackDays: 365, start: { mean: 145, sd: 25 }, target: 90, decayDays: 120 },
        treatment: [drug('atorvastatin', 1, 0.6, 30)],
        monitoring: [test('ldl', 'LDL cholesterol', 365, 120), test('tchol', 'Total cholesterol', 365, 180), test('tg', 'Triglycerides', 365, 180)] }),
    base('obesity_bmi30', 'Obesity (BMI 30 or more)', ['family_medicine', 'internal_medicine', 'endocrinology'],
      { code: '162864005', display: 'Body mass index 30+ - obesity (finding)', terms: ['obesity', 'obese', 'bmi 30+', 'class 1 obesity'], icd10: 'E66.9' }, {
        note: 'Control = latest BMI below 30 kg/m2 (weight goals are individual). No drug line: the app has no anti-obesity drug in terminology.js.',
        prevalence: { minAge: 18, ageBands: bands([[18, 30, 0.2], [30, 40, 0.3], [40, 60, 0.36], [60, 80, 0.32], [80, 100, 0.2]]), onset: { shape: 'uniform', mean: null, sd: null }, multipliers: [] },
        course: { type: 'chronic', severity: { mild: 0.6, moderate: 0.28, severe: 0.12 }, events: {} },
        control: { type: 'vital', ...lab('bmi'), display: 'BMI', unit: 'kg/m2', goal: 30, direction: 'below', lookbackDays: 365, start: { mean: 34, sd: 3.5 }, target: 29, decayDays: 300 },
        treatment: [],
        monitoring: [test('bmi', 'BMI', 180, 90), test('hba1c', 'HbA1c (diabetes screening)', 365, 365), test('ldl', 'LDL cholesterol', 365, 365)] }),
    base('asthma_allergic', 'Allergic asthma', ['family_medicine', 'pulmonology', 'internal_medicine'],
      { code: '389145006', display: 'Allergic asthma (disorder)', terms: ['asthma', 'allergic asthma', 'wheezing', 'reactive airway'], icd10: 'J45.909' }, {
        note: 'Asthma control is judged by a symptom score (ACT); scores arrive with phase 4, so there is no control measure yet. Reliever only (albuterol) is the one asthma drug in terminology.js.',
        prevalence: { minAge: 18, ageBands: bands([[18, 30, 0.09], [30, 50, 0.08], [50, 70, 0.07], [70, 100, 0.07]]), onset: { shape: 'uniform', mean: null, sd: null }, multipliers: [] },
        course: { type: 'episodic', severity: { mild: 0.6, moderate: 0.3, severe: 0.1 }, events: { ed: { controlled: 0.02, uncontrolled: 0.12 }, admission: { controlled: 0.005, uncontrolled: 0.04 } } },
        control: null, treatment: [drug('albuterol', 1, 0.85, 0)],
        monitoring: [flu, test('spo2', 'Oxygen saturation', 365, 180)] }),
    base('copd_bronchitis', 'COPD (chronic obstructive bronchitis)', ['pulmonology', 'family_medicine', 'internal_medicine'],
      { code: '185086009', display: 'Chronic obstructive bronchitis (disorder)', terms: ['copd', 'chronic obstructive pulmonary disease', 'chronic bronchitis', 'emphysema'], icd10: 'J44.9' }, {
        note: 'No control measure yet (exacerbation counts and symptom scores are not lab or vital values). Reliever (albuterol) is the one respiratory drug in terminology.js. Influenza vaccine yearly.',
        prevalence: { minAge: 40, ageBands: ageCurve(40, 220, 0.15), onset: { shape: 'late', mean: 62, sd: 9 }, multipliers: [] },
        course: { type: 'chronic', severity: { mild: 0.35, moderate: 0.4, severe: 0.25 }, events: { ed: { controlled: 0.08, uncontrolled: 0.3 }, admission: { controlled: 0.04, uncontrolled: 0.18 } } },
        control: null, treatment: [drug('albuterol', 1, 0.8, 0)],
        monitoring: [flu, test('spo2', 'Oxygen saturation', 180, 90),
          { kind: 'screening', system: 'snomed', code: T.PROCEDURES.chest_xray.code, display: 'Chest X-ray', intervalControlledDays: 730, intervalUncontrolledDays: 365 }] }),
    base('ckd_stage3', 'Chronic kidney disease, stage 3', ['nephrology', 'family_medicine', 'internal_medicine'],
      { code: '433144002', display: 'Chronic kidney disease stage 3 (disorder)', terms: ['ckd', 'ckd 3', 'chronic kidney disease', 'stage 3 ckd', 'renal impairment'], icd10: 'N18.30' }, {
        note: 'Control = latest systolic BP below 130 mmHg (a common target in CKD; individual targets vary). eGFR and creatinine are monitored, not used as the control measure.',
        prevalence: { minAge: 40, ageBands: ageCurve(45, 200, 0.2), onset: { shape: 'late', mean: 66, sd: 10 }, multipliers: [{ disease: 'diabetes', multiplier: 2 }, { disease: 'hypertension', multiplier: 1.8 }] },
        course: { type: 'chronic', severity: { mild: 0.55, moderate: 0.35, severe: 0.1 }, events: { admission: { controlled: 0.04, uncontrolled: 0.12 } } },
        control: { type: 'vital', ...lab('sbp'), display: 'systolic BP', unit: 'mm[Hg]', goal: 130, direction: 'below', lookbackDays: 365, start: { mean: 146, sd: 10 }, target: 124, decayDays: 150 },
        treatment: [drug('lisinopril', 1, 0.5, 30), drug('losartan', 2, 0.2, 90)],
        monitoring: [test('egfr', 'eGFR', 180, 90), test('creatinine', 'Creatinine', 180, 90), flu] })
  ];
  return out;
}

// What the Disease module (analytics.js) needs from a profile, or null when the profile is not usable there yet (no control measure, a lab or vital that must
// stay BELOW a goal is the only rule the module's SQL knows; other directions come with the generic sections of chunk 1.6). Same fields as the old DISEASES entries.
function toModuleEntry(input) {
  const p = normalize(input), c = p.control;
  if (!p.key || !c || !p.dx.code || !c.code || !['lab', 'vital'].includes(c.type) || c.direction !== 'below' || c.goal === null) return null;
  return { label: `${p.label} (${c.display || c.code} below goal)`, condCode: p.dx.code, labCode: c.code, goalBelow: c.goal, drugCodes: p.treatment.map(t => t.code).filter(Boolean) };
}

// What the generic disease sections (analytics.js, analytic disease_profile; plan chunk 1.6a) need from a profile: only the diagnosis. Unlike toModuleEntry there is no
// control-measure rule, so every profile with a diagnosis code is usable. terms = the V1 search words (the profile's terms plus its display text, lower-case, at most 30,
// each up to 80 characters; the label when there is nothing else). Returns null when the profile has no key or no diagnosis code.
function toCohortEntry(input) {
  const p = normalize(input);
  if (!p.key || !p.dx.code) return null;
  const terms = uniq([...p.dx.terms, lower(p.dx.display)].map(t => t.slice(0, 80).trim()).filter(Boolean)).slice(0, 30);
  if (!terms.length && lower(p.label)) terms.push(lower(p.label).slice(0, 80));
  return { key: p.key, label: p.label || p.key, code: p.dx.code, system: p.dx.system, terms, sensitive: p.sensitive, control: toControlRule(p.control), treatment: toTreatmentLines(p.treatment), monitoring: toMonitoringItems(p.monitoring) };
}

// The treatment lines as the generic treatment section reads them (plan chunk 1.7b): only lines with a drug code, each drug once, at most 12, line a whole number 1-99, supply = the
// profile's renewal interval in days (the days one fill is taken to cover), limited to 7-180 like the other adherence analytics (30 when missing).
function toTreatmentLines(list) {
  const out = [], seen = new Set();
  for (const t of Array.isArray(list) ? list : []) {
    if (!t || !t.code || seen.has(t.code) || out.length >= 12) continue;
    seen.add(t.code);
    const line = Number.isFinite(t.line) ? Math.min(Math.max(Math.round(t.line), 1), 99) : 1, rd = Number.isFinite(t.renewalDays) && t.renewalDays > 0 ? t.renewalDays : 30;
    out.push({ code: String(t.code), display: String(t.display || t.code).slice(0, 120), line, supply: Math.min(Math.max(Math.round(rd), 7), 180) });
  }
  return out;
}

// The monitoring items as the care-gaps section reads them (plan chunk 1.8a): kind test / screening / vaccine, a code, and how often it is due (days) for controlled and for
// uncontrolled patients. An item without a code or without any interval is dropped; with only one interval both are set to it; intervals are whole days 1-3650; each kind + code once; at most 20.
function toMonitoringItems(list) {
  const out = [], seen = new Set(), day = v => Number.isFinite(v) && v > 0 ? Math.min(Math.max(Math.round(v), 1), 3650) : null;
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || !m.code || !MONITOR_KINDS.includes(m.kind) || seen.has(m.kind + '|' + m.code) || out.length >= 20) continue;
    const ic = day(m.intervalControlledDays), iu = day(m.intervalUncontrolledDays);
    if (ic === null && iu === null) continue;
    seen.add(m.kind + '|' + m.code);
    out.push({ kind: m.kind, code: String(m.code), display: String(m.display || m.code).slice(0, 120), intervalControlledDays: ic ?? iu, intervalUncontrolledDays: iu ?? ic });
  }
  return out;
}

// The control measure as the generic sections read it (plan chunk 1.6b), or null when they cannot use it: no measure, a score (score observations come with phase 4), no code,
// no numeric goal, an unknown direction, or a range without its high end. Rule: below = result under the goal, above = result over the goal, range = from goal to goalHigh (both included).
function toControlRule(c) {
  if (!c || !['lab', 'vital'].includes(c.type) || !c.code || c.goal === null || !DIRECTIONS.includes(c.direction)) return null;
  if (c.direction === 'range' && (c.goalHigh === null || c.goalHigh <= c.goal)) return null;
  const days = Math.min(Math.max(Math.round(c.lookbackDays || 365), 1), 3650);
  return { type: c.type, code: c.code, display: c.display || c.code, unit: c.unit || '', goal: c.goal, goalHigh: c.direction === 'range' ? c.goalHigh : null, direction: c.direction, lookbackDays: days };
}

// ---------- department library, batch B1 (plan chunk 3.5a) ----------
// Four department profiles built from section 8 of the plan: cardiology, endocrinology, nephrology, pulmonology. They use only what exists today (the disease profiles, the current tables
// and the analytics catalog): no score observations yet (phase 4), so `scores` is empty and every measure is a LOINC lab or vital. Diseases of section 8 that have no profile yet (coronary artery
// disease, heart failure, atrial fibrillation, type 1 diabetes ...) are NOT listed; add the profile first, then assign it. All values are NEEDS CLINICIAN REVIEW: measures, bundle and rates are the
// generator's and the page's defaults, not approved. libraryDepartments() returns plain profiles; POST /api/departments/install-library stores the missing ones (never overwrites).
// A bundle item with no mode runs in every mode its analytic has; one that only exists in V4 / V5 is fixed to V4.
function libraryDepartments(batch = 1) {
  if (batch !== 1) return [];
  const note = (what) => `Department library batch B1 (plan chunk 3.5a): ${what} NEEDS CLINICIAN REVIEW (measures, bundle, episode rates and scope are defaults, not approved). Built from section 8 of disease-department-plan.html; diseases without a profile yet are not listed.`;
  const m = (kind, code, display, unit) => ({ kind, system: 'loinc', code, display, unit });
  const it = (analytic, mode = '', sections = []) => ({ analytic, mode, sections });
  const dp = it('disease_profile');
  return [
    { key: 'cardiology', label: 'Cardiology', enabled: true, sensitive: false, description: 'Blood pressure and lipid pathways; heart failure, rhythm and ischaemic disease follow when their profiles exist.',
      diseases: ['hypertension', 'hypercholesterolaemia'],
      measureSet: [m('vital', '8480-6', 'Systolic blood pressure', 'mm[Hg]'), m('vital', '8462-4', 'Diastolic blood pressure', 'mm[Hg]'), m('lab', '18262-6', 'LDL cholesterol', 'mg/dL'), m('lab', '2085-9', 'HDL cholesterol', 'mg/dL'), m('lab', '2571-8', 'Triglycerides', 'mg/dL'), m('vital', '8867-4', 'Heart rate', '/min'), m('lab', '38483-4', 'Creatinine', 'mg/dL')],
      scores: [], bundle: { items: [dp, it('disease_module', 'v4'), it('guideline_adherence', 'v4'), it('chronic_control'), it('treatment_patterns'), it('medication_adherence', 'v4'), it('polypharmacy'), it('readmission_drivers', 'v4')] },
      episodeModel: { visitsPerYear: 3, admissionShare: 0.12, edShare: 0.15 }, scopeFilters: { minAge: 18, maxAge: null, gender: '' }, source: { note: note('Blood pressure, LDL and heart rate are the measures the profiles can use.'), version: 1, updatedBy: 'system', approvedBy: '' } },
    { key: 'endocrinology', label: 'Endocrinology', enabled: true, sensitive: false, description: 'Diabetes, thyroid disease and obesity: glycaemic and thyroid control, screening and treatment.',
      diseases: ['diabetes', 'hypothyroidism', 'hyperthyroidism', 'obesity_bmi30'],
      measureSet: [m('lab', '4548-4', 'HbA1c', '%'), m('lab', '2339-0', 'Glucose', 'mg/dL'), m('lab', '3016-3', 'TSH', 'm[IU]/L'), m('lab', '3024-7', 'Free T4', 'ng/dL'), m('vital', '39156-5', 'BMI', 'kg/m2'), m('lab', '33914-3', 'eGFR', 'mL/min/{1.73_m2}')],
      scores: [], bundle: { items: [dp, it('disease_module', 'v4'), it('chronic_control'), it('guideline_adherence', 'v4'), it('medication_adherence', 'v4'), it('treatment_patterns'), it('preventive_screening'), it('test_ordering')] },
      episodeModel: { visitsPerYear: 3, admissionShare: 0.05, edShare: 0.08 }, scopeFilters: { minAge: 18, maxAge: null, gender: '' }, source: { note: note('HbA1c, TSH and free T4 are the control measures of the diseases listed.'), version: 1, updatedBy: 'system', approvedBy: '' } },
    { key: 'nephrology', label: 'Nephrology', enabled: true, sensitive: false, description: 'Chronic kidney disease and the diseases that drive it (diabetes, hypertension); dialysis and transplant need the device and episode data of phase 4.',
      diseases: ['ckd_stage3', 'diabetes', 'hypertension'],
      measureSet: [m('lab', '33914-3', 'eGFR', 'mL/min/{1.73_m2}'), m('lab', '38483-4', 'Creatinine', 'mg/dL'), m('vital', '8480-6', 'Systolic blood pressure', 'mm[Hg]'), m('lab', '4548-4', 'HbA1c', '%')],
      scores: [], bundle: { items: [dp, it('chronic_control'), it('medication_adherence', 'v4'), it('polypharmacy'), it('readmission_drivers', 'v4'), it('test_ordering'), it('lab_cooccurrence', 'v4')] },
      episodeModel: { visitsPerYear: 4, admissionShare: 0.1, edShare: 0.12 }, scopeFilters: { minAge: 18, maxAge: null, gender: '' }, source: { note: note('eGFR and creatinine are monitored; the control measure of CKD stage 3 is systolic BP.'), version: 1, updatedBy: 'system', approvedBy: '' } },
    { key: 'pulmonology', label: 'Pulmonology', enabled: true, sensitive: false, description: 'Asthma and COPD: reliever use, exacerbations, admissions and the yearly influenza vaccine; spirometry and scores need phase 4.',
      diseases: ['asthma_allergic', 'copd_bronchitis'],
      measureSet: [m('vital', '59408-5', 'Oxygen saturation', '%'), m('vital', '8867-4', 'Heart rate', '/min')],
      scores: [], bundle: { items: [dp, it('treatment_patterns'), it('encounter_utilization'), it('readmission_drivers', 'v4'), it('seasonal_pattern', 'v4'), it('vaccination_coverage'), it('procedure_volume')] },
      episodeModel: { visitsPerYear: 3, admissionShare: 0.1, edShare: 0.18 }, scopeFilters: { minAge: 18, maxAge: null, gender: '' }, source: { note: note('Oxygen saturation is monitored; asthma and COPD have no control measure yet.'), version: 1, updatedBy: 'system', approvedBy: '' } }
  ];
}

// The LOINC codes the seed library itself uses (TSH, free T4, uric acid, PHQ-9 ...) count as known codes: a department that lists them must not be refused on a database that has no such data yet.
for (const p of [...libraryProfiles(1), ...libraryProfiles(2)]) for (const x of [p.control, ...(p.monitoring || [])]) if (x && x.system === 'loinc' && x.code) BUNDLED.add('loinc|' + x.code);

// Write the built-in rows once (owner connection). Existing rows are never touched, so a switch-off survives a restart. Returns the number inserted.
async function seedBuiltins(db) {
  const raws = seedProfiles(), keys = raws.map(r => r.key);
  let added = 0;
  for (const raw of raws) {
    const r = check(raw, { knownDiseases: keys });
    if (!r.ok) { console.error('Built-in disease profile "' + raw.key + '" is not valid:', JSON.stringify(r.errors)); continue; }
    const p = { ...r.profile, enabled: true, source: { ...r.profile.source, updatedAt: new Date().toISOString() } };
    const ins = await db.query(`INSERT INTO disease_profiles (key, profile, enabled, builtin, updated_by) VALUES ($1, $2::jsonb, TRUE, TRUE, 'system') ON CONFLICT (key) DO NOTHING RETURNING key`, [p.key, JSON.stringify(p)]);
    added += ins.rows.length;
  }
  return added;
}

// ---------- generator input (plan chunk 1.1) ----------
// prepareProfiles(list, { builtinKeys }) -> { profiles, problems }
//   list         raw profiles (as stored in disease_profiles, or as typed); disabled ones are dropped without a message
//   builtinKeys  condition keys of the demo dictionary that links / multipliers may also point at (obesity, ...)
// Every profile is normalized and validated (format only, no database). A profile that fails goes to `problems` ({ key, errors }); a repeated key is a problem too.
// The returned profiles are ordered so a profile comes after the profiles its multipliers / links point at (a cycle keeps the given order).
function prepareProfiles(list, opts = {}) {
  const raws = Array.isArray(list) ? list.filter(isObj) : [];
  const known = uniq([...raws.map(r => lower(r.key)).filter(Boolean), ...(opts.builtinKeys || [])]);
  const profiles = [], problems = [], seen = new Set();
  for (const raw of raws) {
    const r = check(raw, { knownDiseases: known });
    if (r.profile.key && seen.has(r.profile.key)) { problems.push({ key: r.profile.key, errors: [{ path: 'key', message: 'appears twice in the list' }] }); continue; }
    if (r.profile.key) seen.add(r.profile.key);
    if (!r.profile.enabled) continue;
    if (!r.ok) problems.push({ key: r.profile.key || '(no key)', errors: r.errors }); else profiles.push(r.profile);
  }
  const keys = new Set(profiles.map(p => p.key)), placed = new Set(), ordered = [];
  const deps = p => [...p.prevalence.multipliers, ...p.links].map(l => l.disease).filter(d => keys.has(d) && d !== p.key);
  while (ordered.length < profiles.length) {
    const next = profiles.find(p => !placed.has(p.key) && deps(p).every(d => placed.has(d))) || profiles.find(p => !placed.has(p.key));
    placed.add(next.key); ordered.push(next);
  }
  return { profiles: ordered, problems };
}

// ---------- profiles for the generator (plan chunk 1.11b) ----------
// profilesFor(db, want) -> the profiles generateBundle should run, read from disease_profiles.
//   want = 'enabled' (or true): every profile that is switched on;  want = ['gout', ...]: those keys, switched on or off (the person asked for them).
// Diseases the chosen ones link to (links, prevalence multipliers) are added, because their rates cannot be worked out without them.
async function profilesFor(db, want) {
  const sel = want === 'enabled' || want === true ? null : Array.isArray(want) ? uniq(want.map(lower)).filter(Boolean) : undefined;
  if (sel === undefined) throw httpErr(400, 'Send diseases as a list of keys or \"enabled\".');
  if (sel && (sel.length > 60 || sel.some(k => !KEY_RE.test(k)))) throw httpErr(400, 'Invalid disease key.');
  const rows = (await db.query(`SELECT ${COLS} FROM disease_profiles ORDER BY key`)).rows, by = new Map(rows.map(r => [r.key, r]));
  const todo = sel ? [...sel] : rows.filter(r => r.enabled).map(r => r.key), out = new Map();
  for (const k of todo) if (!by.has(k)) throw httpErr(404, `No disease \"${k}\".`);
  while (todo.length) {
    const k = todo.shift(); if (out.has(k)) continue;
    const r = by.get(k); if (!r || !isObj(r.profile)) continue;
    out.set(k, { ...r.profile, key: k, enabled: true });
    for (const l of [...(r.profile.links || []), ...((r.profile.prevalence && r.profile.prevalence.multipliers) || [])]) if (l && l.disease) todo.push(l.disease);
  }
  return [...out.values()];
}

// ---------- preview summary (plan chunk 1.11a) ----------
// What the generator made for one disease, in the three views the form shows: prevalence, control, treatment (plus a few extras). Pure: takes generateBundle's result.
const r2 = n => Math.round(n * 100) / 100, r3 = n => Math.round(n * 1000) / 1000;
const meanOf = a => (a.length ? a.reduce((t, x) => t + x, 0) / a.length : null);
const medianOf = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const shareOf = (n, d) => (d ? r3(n / d) : null);
const tally = (list, f) => list.reduce((o, x) => { const k = f(x); o[k] = (o[k] || 0) + 1; return o; }, {});
const AGE_BANDS = [['0-17', 0, 17], ['18-39', 18, 39], ['40-64', 40, 64], ['65+', 65, 200]];
function summarizePreview(profile, out, total) {
  const key = profile.key, gt = (out.groundTruth || []).filter(x => x.disease === key), endMs = Date.parse(out.summary.endDate);
  const has = new Set(gt.map(x => x.patient)), groups = new Map(), add = (name, has1) => { const g = groups.get(name) || { group: name, patients: 0, withDisease: 0 }; g.patients++; if (has1) g.withDisease++; groups.set(name, g); };
  for (const e of out.bundle.entry) {
    const r = e && e.resource; if (!r || r.resourceType !== 'Patient') continue;
    const h = has.has(r.id), age = Math.floor((endMs - Date.parse(r.birthDate)) / (365.25 * 86400000)), band = AGE_BANDS.find(([, lo, hi]) => age >= lo && age <= hi);
    add(r.gender === 'female' ? 'women' : 'men', h); if (band) add('age ' + band[0], h);
  }
  const prevalence = { patients: total, withDisease: gt.length, share: shareOf(gt.length, total), groups: ['men', 'women', ...AGE_BANDS.map(b => 'age ' + b[0])].filter(n => groups.has(n)).map(n => ({ ...groups.get(n), share: shareOf(groups.get(n).withDisease, groups.get(n).patients) })) };
  const c = profile.control;
  const withResult = gt.filter(x => x.controlled === true || x.controlled === false), ok = withResult.filter(x => x.controlled).length, vals = gt.map(x => x.lastValue).filter(isNum);
  const control = c ? { measure: c.display || c.code, unit: c.unit || null, type: c.type, direction: c.direction, goal: c.goal, goalHigh: isNum(c.goalHigh) ? c.goalHigh : null,
    patients: gt.length, withResult: withResult.length, controlled: ok, uncontrolled: withResult.length - ok, noResult: gt.length - withResult.length, controlledShare: shareOf(ok, withResult.length),
    lastValue: vals.length ? { min: r2(Math.min(...vals)), median: r2(medianOf(vals)), max: r2(Math.max(...vals)) } : null } : null;
  const tx = ((out.summary.diseaseProfiles || {}).treatment || {})[key] || {}, treated = gt.filter(x => x.treated), adh = gt.map(x => x.adherence).filter(isNum);
  const days = treated.map(x => (Date.parse(x.firstTreatment) - Date.parse(x.onset)) / 86400000).filter(Number.isFinite), med = medianOf(days);
  const treatment = { lines: (profile.treatment || []).length, patients: gt.length, treated: treated.length, treatedShare: shareOf(treated.length, gt.length), daysToFirstTreatmentMedian: med === null ? null : Math.round(med),
    adherenceMean: adh.length ? r3(meanOf(adh)) : null, adherenceBelow80: adh.filter(a => a < 0.8).length, fills: tx.fills || 0, switches: tx.switches || 0 };
  const ev = { ed: 0, admission: 0, procedure: 0 }; for (const x of gt) for (const k of Object.keys(ev)) ev[k] += (x.events && x.events[k]) || 0;
  const other = { severity: tally(gt, x => x.severity), coding: tally(gt, x => x.coding), monitored: gt.filter(x => x.monitored).length, events: ev };
  const note = total < 100 ? `Only ${total} patients: the shares are rough. Raise the count for steadier numbers.` : null;
  return { prevalence, control, treatment, other, note };
}

// ---------- chunk 2.3: review sheet and ground-truth report ----------
// Review sheet: one row per profile with what a clinician has to confirm (goal, drugs, intervals, source note) and empty reviewer columns. Seed-library values are demo values
// ("needs clinician review"); a profile counts as approved only when source.approvedBy is filled in. Pure functions: no database.
const REVIEW_COLUMNS = ['key', 'label', 'departments', 'sensitive', 'dx_code', 'dx_display', 'icd10', 'prevalence', 'onset', 'control_measure', 'control_goal', 'treatment', 'monitoring', 'links', 'course',
  'source_note', 'source_version', 'updated_by', 'approved_by', 'review_status', 'reviewer', 'decision', 'comments'];
const numTxt = v => (isNum(v) ? String(r3(v)) : '?');
function reviewSheet(profiles) {
  return (Array.isArray(profiles) ? profiles : []).map(input => {
    const p = normalize(input), c = p.control, dir = { below: 'below', above: 'above', range: 'inside' };
    const goal = c ? (c.direction === 'range' ? `inside ${numTxt(c.goal)} to ${numTxt(c.goalHigh)}` : `${dir[c.direction] || c.direction} ${numTxt(c.goal)}`) + (c.unit ? ' ' + c.unit : '') : 'none';
    return {
      key: p.key, label: p.label, departments: p.departments.join('; '), sensitive: p.sensitive ? 'yes' : 'no', dx_code: `${p.dx.system}:${p.dx.code}`, dx_display: p.dx.display, icd10: p.dx.icd10,
      prevalence: `from age ${numTxt(p.prevalence.minAge)}: ` + p.prevalence.ageBands.map(b => `${numTxt(b.from)}-${numTxt(b.to)} M ${numTxt(b.male)} F ${numTxt(b.female)}`).join(', '),
      onset: p.prevalence.onset.shape + (isNum(p.prevalence.onset.mean) ? ` (mean ${numTxt(p.prevalence.onset.mean)}, sd ${numTxt(p.prevalence.onset.sd)})` : ''),
      control_measure: c ? `${c.display || c.code} (${c.system}:${c.code}), ${c.type}, look-back ${numTxt(c.lookbackDays)} d, start mean ${numTxt(c.start.mean)} sd ${numTxt(c.start.sd)}, target ${numTxt(c.target)}` : 'none',
      control_goal: goal,
      treatment: p.treatment.map(t => `line ${numTxt(t.line)}: ${t.display || t.code} (${t.code}) p=${numTxt(t.probability)}, lag ${numTxt(t.lagDays)} d, renewal ${numTxt(t.renewalDays)} d`).join('; ') || 'none',
      monitoring: p.monitoring.map(m => `${m.kind}: ${m.display || m.code} (${m.code}) every ${numTxt(m.intervalControlledDays)} d controlled / ${numTxt(m.intervalUncontrolledDays)} d uncontrolled`).join('; ') || 'none',
      links: [...p.links.map(l => `${l.disease} x${numTxt(l.multiplier)} (${l.direction})`), ...p.prevalence.multipliers.map(m => `${m.disease} prevalence x${numTxt(m.multiplier)}`)].join('; ') || 'none',
      course: `${p.course.type}; severity mild ${numTxt(p.course.severity.mild)} moderate ${numTxt(p.course.severity.moderate)} severe ${numTxt(p.course.severity.severe)}`,
      source_note: p.source.note, source_version: p.source.version, updated_by: p.source.updatedBy, approved_by: p.source.approvedBy,
      review_status: p.source.approvedBy ? 'approved' : 'needs clinician review', reviewer: '', decision: '', comments: ''
    };
  });
}
// CSV with a header row; a cell that starts with = + - @ (or a tab / carriage return) gets a leading apostrophe so a spreadsheet does not run it as a formula.
function reviewSheetCsv(rows) {
  const cell = v => { let t = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  return [REVIEW_COLUMNS.join(','), ...rows.map(r => REVIEW_COLUMNS.map(c => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

// Ground-truth report: what the generator KNEW (out.groundTruth) against what the generated records SHOW, worked out here the way an analytic would, from the bundle only.
//   conditions:  patients with a disease record vs the truth list (must be equal), patients whose record carries the diagnosis code vs truth "coded" (equal)
//   control:     the latest control value inside the look-back window, judged with the profile's goal, vs the truth status; a value in another unit (unitSwapShare) can flip a status, so the
//                tolerance is unitSwapShare + 2% of the patients with a result; "untested" (no value in the window) must match exactly
//   consistency: the truth's own lastValue judged with the same rule must give the truth status (exact)
// Returns { key, patients, withDisease, ok (null for a built-in profile, which has no ground truth), note, checks: [{ name, truth, records, difference, tolerance, ok }], differences: [first 10 patient ids that disagree, with both answers] }.
function truthReport(profileInput, out, total) {
  const p = normalize(profileInput), key = p.key, gt = (out.groundTruth || []).filter(x => x.disease === key), c = p.control;
  if (!gt.length && seedProfiles().some(x => x.key === key)) return { key, label: p.label, patients: total, withDisease: 0, ok: null, checks: [], differences: [], note: 'Built-in profile: the original generator writes it and keeps no ground truth, so there is nothing to compare.' };
  const endMs = Date.parse(out.summary.endDate), DAY = 86400000, res = [];
  for (const e of out.bundle.entry) if (e && e.resource) res.push(e.resource);
  const pidOf = r => String((r.subject && r.subject.reference) || '').replace(/^Patient\//, '');
  const condRe = new RegExp(`-dz-${key.replace(/[^a-z0-9_]/g, '')}-\\d+$`), obRe = new RegExp(`-dz-ob-${key.replace(/[^a-z0-9_]/g, '')}-`);
  const conds = res.filter(r => r.resourceType === 'Condition' && condRe.test(String(r.id)));
  const condPatients = new Set(conds.map(pidOf)), coded = new Set(conds.filter(r => ((r.code && r.code.coding) || []).some(x => x && x.code === p.dx.code)).map(pidOf));
  const checks = [], differences = [];
  const add = (name, truth, records, tolerance) => { const d = records - truth; checks.push({ name, truth, records, difference: d, tolerance, ok: Math.abs(d) <= tolerance }); };
  add('patients with the disease recorded', gt.length, condPatients.size, 0);
  add('patients whose record carries the diagnosis code', gt.filter(x => x.coding === 'coded').length, coded.size, 0);
  const inTruth = new Set(gt.map(x => x.patient)); const stray = [...condPatients].filter(x => !inTruth.has(x)).length;
  add('disease records for patients that are not in the truth list', 0, stray, 0);
  const rule = c && ['lab', 'vital'].includes(c.type) && isNum(c.goal) && DIRECTIONS.includes(c.direction) && (c.direction !== 'range' || (isNum(c.goalHigh) && c.goalHigh > c.goal)) ? c : null;
  if (rule) {
    const judge = v => (rule.direction === 'below' ? v < rule.goal : rule.direction === 'above' ? v > rule.goal : v >= rule.goal && v <= rule.goalHigh);
    const from = endMs - (rule.lookbackDays || 365) * DAY, last = new Map();
    for (const r of res) {
      if (r.resourceType !== 'Observation' || !obRe.test(String(r.id)) || !r.valueQuantity || !isNum(r.valueQuantity.value)) continue;
      if (!((r.code && r.code.coding) || []).some(x => x && x.code === rule.code)) continue;
      const t = Date.parse(r.effectiveDateTime); if (!(t >= from && t <= endMs)) continue;
      const k = pidOf(r), cur = last.get(k); if (!cur || t >= cur.t) last.set(k, { t, v: r.valueQuantity.value });
    }
    const withTruth = gt.filter(x => x.controlled === true || x.controlled === false);
    let flipped = 0, untestedOff = 0, selfOff = 0;
    for (const x of gt) {
      const got = last.has(x.patient) ? judge(last.get(x.patient).v) : null, want = x.controlled === true || x.controlled === false ? x.controlled : null;
      if ((got === null) !== (want === null)) { untestedOff++; if (differences.length < 10) differences.push({ patient: x.patient, truth: want, records: got, why: 'tested in one and not in the other' }); }
      else if (got !== null && got !== want) { flipped++; if (differences.length < 10) differences.push({ patient: x.patient, truth: want, records: got, why: 'other side of the goal' }); }
      if (isNum(x.lastValue) && judge(x.lastValue) !== want) selfOff++;
    }
    const tol = Math.ceil((p.mess.unitSwapShare + 0.02) * Math.max(withTruth.length, 1));
    add('patients with a control result in the window', withTruth.length, gt.filter(x => last.has(x.patient)).length, 0);
    add('control status that differs between truth and records', 0, flipped + untestedOff, tol);
    add('truth status that disagrees with its own last value', 0, selfOff, 0);
  }
  return { key, label: p.label, patients: total, withDisease: gt.length, ok: checks.every(x => x.ok), checks, differences, note: gt.length ? null : 'No patient has the disease in this sample: raise the count.' };
}

module.exports = { validate, normalize, check, register, normalizeDepartment, validateDepartment, checkDepartment, reviewSheet, reviewSheetCsv, truthReport, REVIEW_COLUMNS, prepareProfiles, summarizePreview, profilesFor, seedProfiles, libraryProfiles, libraryDepartments, seedBuiltins, toModuleEntry, toCohortEntry, knownCodes, runCheck, KEY_RE, SYSTEM_URI, PLAUSIBLE, COURSES, CONTROL_TYPES, DIRECTIONS, MONITOR_KINDS, ONSET_SHAPES, EVENT_KEYS };

// ---------- self-test ----------
// node diseases.js --write-library [file] [--batch=2]   writes a seed library (batch 1 by default) as an importable library file (default disease-library-batch<N>.json)
if (require.main === module && process.argv.includes('--write-library')) {
  const out = process.argv[process.argv.indexOf('--write-library') + 1], bm = process.argv.find(a => /^--batch=\d+$/.test(a)), batch = bm ? Number(bm.slice(8)) : 1;
  const file = out && !out.startsWith('--') ? out : `disease-library-batch${batch}.json`, list = libraryProfiles(batch);
  const have = new Set(list.map(p => p.key)), needs = [...new Set(list.flatMap(p => [...(p.links || []), ...p.prevalence.multipliers].map(l => l.disease)))].filter(k => !have.has(k)).sort();
  require('fs').writeFileSync(file, JSON.stringify({ format: 'vibe-rounds-disease-library', version: 1, exportedAt: new Date().toISOString(), count: list.length, needs, diseases: list }, null, 2) + '\n');
  console.log('wrote ' + list.length + ' profiles to ' + file);
}
// node diseases.js --review-sheet [file]   writes the review sheet (CSV) of the built-in and both library batches (default disease-review-sheet.csv)
if (require.main === module && process.argv.includes('--review-sheet')) {
  const out = process.argv[process.argv.indexOf('--review-sheet') + 1], file = out && !out.startsWith('--') ? out : 'disease-review-sheet.csv';
  const list = [...seedProfiles(), ...libraryProfiles(1), ...libraryProfiles(2)];
  require('fs').writeFileSync(file, reviewSheetCsv(reviewSheet(list)));
  console.log('wrote ' + list.length + ' rows to ' + file);
}
if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert');
  const good = () => ({
    key: 'diabetes', label: 'Type 2 diabetes', departments: ['endocrinology', 'family_medicine'],
    dx: { system: 'snomed', code: T.CONDITIONS.diabetes.code, display: 'Diabetes mellitus type 2', terms: ['Diabetes', 't2dm'], icd10: 'E11' },
    prevalence: { minAge: 18, ageBands: [{ from: 18, to: 45, male: 0.03, female: 0.025 }, { from: 45, to: 75, male: 0.15, female: 0.12 }], onset: { shape: 'normal', mean: 55, sd: 12 }, multipliers: [{ disease: 'obesity', multiplier: 1.8 }] },
    course: { type: 'chronic', severity: { mild: 0.5, moderate: 0.35, severe: 0.15 }, events: { ed: { controlled: 0.05, uncontrolled: 0.2 } } },
    control: { type: 'lab', code: '4548-4', unit: '%', goal: 7, direction: 'below', lookbackDays: 365, start: { mean: 8.6, sd: 1.2 }, target: 6.8, decayDays: 180 },
    treatment: [{ code: T.MEDICATIONS.metformin.code, display: 'Metformin', line: 1, probability: 0.8, lagDays: 14, renewalDays: 90, switchTo: T.MEDICATIONS.insulin_glargine.code, switchProbability: 0.2 },
      { code: T.MEDICATIONS.insulin_glargine.code, display: 'Insulin glargine', line: 2, probability: 0.3, lagDays: 365, renewalDays: 30 }],
    monitoring: [{ kind: 'test', code: '4548-4', intervalControlledDays: 180, intervalUncontrolledDays: 90 }, { kind: 'screening', code: T.PROCEDURES.ecg.code, intervalControlledDays: 365, intervalUncontrolledDays: 365 }],
    links: [{ disease: 'hypertension', multiplier: 1.4 }],
    mess: { uncodedShare: 0.1, localCodeShare: 0.05, localCode: 'DM-2', lowercaseShare: 0.1, unitSwapShare: 0.02 },
    source: { note: 'demo goal, needs clinician review', version: 1 }
  });
  const errAt = (p, opts) => validate(p, opts).errors.map(e => e.path);
  const mut = f => { const p = good(); f(p); return p; };

  // a good profile passes, warnings only for the missing clinician approval
  let r = validate(good());
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepStrictEqual(r.warnings.map(w => w.path), ['source.approvedBy']);

  // normalize: trims, lower-cases, de-duplicates, fills defaults; does not mutate the input
  const raw = { key: ' Diabetes ', label: ' X ', dx: { code: ' 44054006 ', terms: ['A1c', 'a1c', ' DM '] }, enabled: 'false' };
  const snap = JSON.stringify(raw), n = normalize(raw);
  assert.strictEqual(JSON.stringify(raw), snap);
  assert.deepStrictEqual([n.key, n.label, n.dx.code, n.dx.system, n.enabled, n.sensitive], ['diabetes', 'X', '44054006', 'snomed', false, false]);
  assert.deepStrictEqual(n.dx.terms, ['a1c', 'dm']);
  assert.strictEqual(n.control, null);
  assert.doesNotThrow(() => { normalize(null); normalize('x'); normalize([]); normalize({ treatment: 'bad', links: 5 }); });
  assert.deepStrictEqual(normalize(good()), normalize(normalize(good())));   // idempotent
  assert.strictEqual(normalize({ dx: { system: T.SYSTEMS.snomed } }).dx.system, 'snomed');   // system URI is accepted

  // not an object
  assert.strictEqual(validate(null).ok, false); assert.strictEqual(validate([]).ok, false);

  // identity
  assert.ok(errAt(mut(p => { p.key = 'Bad Key!'; })).includes('key'));
  assert.ok(errAt(mut(p => { p.key = '1abc'; })).includes('key'));
  assert.ok(errAt(mut(p => { p.label = ''; })).includes('label'));
  assert.ok(errAt(mut(p => { p.departments = ['ok_dep', 'Bad Dep']; })).includes('departments[1]'));
  assert.ok(errAt(mut(p => { p.departments = ['cardiology']; }), { knownDepartments: ['endocrinology'] }).includes('departments[0]'));

  // codes: format, system, existence
  assert.ok(errAt(mut(p => { p.dx.code = 'ABC'; })).includes('dx.code'));
  assert.ok(errAt(mut(p => { p.dx.code = ''; })).includes('dx.code'));
  assert.ok(errAt(mut(p => { p.dx.system = 'loinc'; p.dx.code = '4548-4'; })).includes('dx.system'));
  assert.ok(errAt(mut(p => { p.dx.system = 'icd'; })).includes('dx.system'));
  assert.ok(errAt(mut(p => { p.dx.icd10 = 'XYZ'; })).includes('dx.icd10'));
  assert.ok(errAt(good(), { codeExists: () => false }).includes('dx.code'));
  assert.ok(validate(good(), { codeExists: () => true }).ok);
  assert.ok(errAt(mut(p => { p.treatment[0].code = '4548-4'; })).includes('treatment[0].code'));
  assert.ok(errAt(mut(p => { p.control.code = '44054006'; })).includes('control.code'));

  // rates outside 0-1 rejected everywhere
  assert.ok(errAt(mut(p => { p.prevalence.ageBands[0].male = 1.2; })).includes('prevalence.ageBands[0].male'));
  assert.ok(errAt(mut(p => { p.prevalence.ageBands[1].female = -0.1; })).includes('prevalence.ageBands[1].female'));
  assert.ok(errAt(mut(p => { p.prevalence.ageBands[0].male = null; })).includes('prevalence.ageBands[0].male'));
  assert.ok(errAt(mut(p => { p.treatment[0].probability = 2; })).includes('treatment[0].probability'));
  assert.ok(errAt(mut(p => { p.treatment[0].switchProbability = 1.5; })).includes('treatment[0].switchProbability'));
  assert.ok(errAt(mut(p => { p.mess.uncodedShare = 3; })).includes('mess.uncodedShare'));
  assert.ok(errAt(mut(p => { p.course.events.ed.uncontrolled = 9; })).includes('course.events.ed.uncontrolled'));
  assert.ok(errAt(mut(p => { p.mess.uncodedShare = 0.7; p.mess.localCodeShare = 0.5; })).includes('mess'));
  assert.ok(errAt(mut(p => { p.course.severity.severe = 0.5; })).includes('course.severity'));

  // age bands and onset
  assert.ok(errAt(mut(p => { p.prevalence.ageBands = []; })).includes('prevalence.ageBands'));
  assert.ok(errAt(mut(p => { p.prevalence.ageBands[0].to = 50; })).includes('prevalence.ageBands'));   // overlaps band 2
  assert.ok(errAt(mut(p => { p.prevalence.ageBands[0].from = 60; })).includes('prevalence.ageBands[0]'));
  assert.ok(errAt(mut(p => { p.prevalence.onset.shape = 'weird'; })).includes('prevalence.onset.shape'));
  assert.ok(errAt(mut(p => { p.prevalence.onset.sd = null; })).includes('prevalence.onset.sd'));

  // control: goal inside the plausible range, direction, range goal, warnings
  assert.ok(errAt(mut(p => { p.control.goal = 70; })).includes('control.goal'));          // HbA1c 70 instead of 7
  assert.ok(errAt(mut(p => { p.control.direction = 'up'; })).includes('control.direction'));
  assert.ok(errAt(mut(p => { p.control.direction = 'range'; })).includes('control.goalHigh'));
  assert.ok(validate(mut(p => { p.control.direction = 'range'; p.control.goal = 6; p.control.goalHigh = 8; })).ok);
  assert.ok(errAt(mut(p => { p.control.direction = 'range'; p.control.goal = 8; p.control.goalHigh = 7; })).includes('control.goalHigh'));
  assert.ok(errAt(mut(p => { p.control.decayDays = 0; })).includes('control.decayDays'));
  assert.ok(errAt(mut(p => { p.control.lookbackDays = 2; })).includes('control.lookbackDays'));
  assert.ok(validate(mut(p => { p.control.target = 7.5; })).warnings.some(w => w.path === 'control.target'));
  assert.ok(validate(mut(p => { p.control = null; })).ok);   // no control measure is allowed
  assert.ok(validate(mut(p => { p.control.type = 'score'; p.control.code = '44261-6'; p.control.goal = 5; p.control.start.mean = 15; p.control.target = 4; })).ok);   // scores are not range-checked

  // treatment
  assert.ok(errAt(mut(p => { p.treatment[0].line = 0; })).includes('treatment[0].line'));
  assert.ok(errAt(mut(p => { p.treatment[0].lagDays = -3; })).includes('treatment[0].lagDays'));
  assert.ok(errAt(mut(p => { p.treatment[0].renewalDays = 0; })).includes('treatment[0].renewalDays'));
  assert.ok(errAt(mut(p => { p.treatment[0].switchTo = '999999'; })).includes('treatment[0].switchTo'));
  assert.ok(errAt(mut(p => { p.treatment[0].switchTo = ''; })).includes('treatment[0].switchTo'));
  assert.ok(errAt(mut(p => { p.treatment[1].code = p.treatment[0].code; p.treatment[0].switchTo = ''; p.treatment[0].switchProbability = 0; })).includes('treatment'));

  // monitoring
  assert.ok(errAt(mut(p => { p.monitoring[0].kind = 'x'; })).includes('monitoring[0].kind'));
  assert.ok(errAt(mut(p => { p.monitoring[0].intervalControlledDays = null; })).includes('monitoring[0].intervalControlledDays'));
  assert.ok(errAt(mut(p => { p.monitoring[0].intervalUncontrolledDays = 0; })).includes('monitoring[0].intervalUncontrolledDays'));

  // links: unknown diseases, self, duplicates, multipliers
  assert.ok(errAt(good(), { knownDiseases: ['obesity'] }).includes('links[0].disease'));                         // hypertension unknown
  assert.ok(errAt(good(), { knownDiseases: new Set(['obesity']) }).includes('links[0].disease'));
  assert.ok(!errAt(good(), { knownDiseases: ['obesity', 'hypertension'] }).length);
  assert.ok(errAt(mut(p => { p.links[0].disease = 'diabetes'; })).includes('links[0].disease'));
  assert.ok(errAt(mut(p => { p.links.push({ disease: 'hypertension', multiplier: 1.1 }); })).includes('links'));
  assert.ok(errAt(mut(p => { p.links[0].multiplier = 0; })).includes('links[0].multiplier'));
  assert.ok(errAt(mut(p => { p.links[0].direction = 'sideways'; })).includes('links[0].direction'));
  assert.ok(errAt(mut(p => { p.prevalence.multipliers[0].disease = 'diabetes'; })).includes('prevalence.multipliers[0].disease'));

  // mess and source
  assert.ok(errAt(mut(p => { p.mess.localCode = ''; })).includes('mess.localCode'));
  assert.ok(errAt(mut(p => { p.source.updatedAt = 'not a date'; })).includes('source.updatedAt'));
  assert.ok(errAt(mut(p => { p.source.version = 0; })).includes('source.version'));
  assert.ok(validate(mut(p => { p.source.approvedBy = 'Dr A'; })).warnings.length === 0);

  // check() = normalize + validate; hostile input cannot throw or pollute
  const c = check({ key: 'Gout', label: 'Gout', __proto__: { x: 1 }, dx: { code: '90560007' } });
  assert.strictEqual(c.profile.key, 'gout'); assert.strictEqual(c.ok, false);
  assert.doesNotThrow(() => validate({ key: 5, label: {}, dx: 'x', prevalence: 'y', control: [], treatment: [null, 3], monitoring: [null], links: [null], mess: 7, source: 1 }));
  assert.ok(errAt({ key: 'a'.repeat(300), label: 'x'.repeat(500) }).includes('key'));

  // ---- API (chunk 0.2) against in-memory stand-ins for express and pg ----
  const mkPool = (rows = new Map()) => {
    const log = [], ref = { snomed_dictionary: new Set(['70000001']), snomed_concept: new Set(), missing: new Set() };
    const out = r => ({ rows: r }), depts = new Map();
    const row = (k, v) => ({ key: k, profile: v.profile, enabled: v.enabled, builtin: v.builtin, updated_by: v.updated_by, updated_at: v.updated_at });
    return {
      rows, log, ref, depts,
      async query(sql, p = []) {
        sql = sql.replace(/\s+/g, ' ').trim(); log.push(sql);
        let m;
        if ((m = /^SELECT code FROM (snomed_dictionary|snomed_concept) WHERE/.exec(sql))) { if (ref.missing.has(m[1])) throw new Error('relation does not exist'); return out(p[0].filter(c => ref[m[1]].has(c)).map(code => ({ code }))); }
        if (/^SELECT key FROM disease_profiles$/.test(sql)) return out([...rows.keys()].map(key => ({ key })));
        if (/^SELECT key, profile FROM disease_profiles WHERE key <> \$1$/.test(sql)) return out([...rows].filter(([k]) => k !== p[0]).map(([key, v]) => ({ key, profile: v.profile })));
        if (/^SELECT .* FROM disease_profiles ORDER BY key$/.test(sql)) return out([...rows].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => row(k, v)));
        if (/^SELECT .* FROM disease_profiles WHERE key = \$1$/.test(sql)) return out(rows.has(p[0]) ? [row(p[0], rows.get(p[0]))] : []);
        if (/^INSERT INTO disease_profiles/.test(sql)) { if (rows.has(p[0])) return out([]); const v = { profile: JSON.parse(p[1]), enabled: p[2], builtin: false, updated_by: p[3], updated_at: new Date() }; rows.set(p[0], v); return out([row(p[0], v)]); }
        if (/^UPDATE disease_profiles SET/.test(sql)) { const v = rows.get(p[0]); if (!v) return out([]); Object.assign(v, { profile: JSON.parse(p[1]), enabled: p[2], updated_by: p[3], updated_at: new Date() }); return out([row(p[0], v)]); }
        if (/^DELETE FROM disease_profiles WHERE key = \$1 AND NOT builtin RETURNING key$/.test(sql)) { const v = rows.get(p[0]); if (!v || v.builtin) return out([]); rows.delete(p[0]); return out([{ key: p[0] }]); }
        if (/^SELECT key, profile FROM disease_profiles$/.test(sql)) return out([...rows].map(([key, v]) => ({ key, profile: v.profile })));
        if (/^SELECT .* FROM department_profiles ORDER BY key$/.test(sql)) return out([...depts].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => row(k, v)));
        if (/^SELECT .* FROM department_profiles WHERE key = \$1$/.test(sql)) return out(depts.has(p[0]) ? [row(p[0], depts.get(p[0]))] : []);
        if (/^INSERT INTO department_profiles/.test(sql)) { if (depts.has(p[0])) return out([]); const v = { profile: JSON.parse(p[1]), enabled: p[2], builtin: false, updated_by: p[3], updated_at: new Date() }; depts.set(p[0], v); return out([row(p[0], v)]); }
        if (/^UPDATE department_profiles SET/.test(sql)) { const v = depts.get(p[0]); if (!v) return out([]); Object.assign(v, { profile: JSON.parse(p[1]), enabled: p[2], updated_by: p[3], updated_at: new Date() }); return out([row(p[0], v)]); }
        if (/^DELETE FROM department_profiles WHERE key = \$1 AND NOT builtin RETURNING key$/.test(sql)) { const v = depts.get(p[0]); if (!v || v.builtin) return out([]); depts.delete(p[0]); return out([{ key: p[0] }]); }
        throw new Error('unexpected SQL: ' + sql);
      }
    };
  };
  const mkApp = () => { const routes = []; const add = m => (path, ...h) => routes.push({ m, path, h: h[h.length - 1] }); return { routes, get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE') }; };
  const callApi = async (app, method, url, { body, user = { email: 'dr@example.org' } } = {}) => {
    const [pathPart, qs] = url.split('?'), query = Object.fromEntries(new URLSearchParams(qs || ''));
    for (const r of app.routes) {
      if (r.m !== method) continue;
      const names = [], re = new RegExp('^' + r.path.replace(/:([a-z]+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$'), x = re.exec(pathPart);
      if (!x) continue;
      const req = { method, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(x[i + 1])])), query, body, user };
      const res = { code: 200, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } };
      await r.h(req, res); return { status: res.code, body: res.body, headers: res.headers, req };
    }
    throw new Error('no route ' + method + ' ' + pathPart);
  };
  const mk = (key, label, code, more = {}) => ({ ...good(), key, label, dx: { ...good().dx, code }, links: [], prevalence: { ...good().prevalence, multipliers: [] }, ...more });
  const oldCheck = process.env.DISEASE_CODE_CHECK; delete process.env.DISEASE_CODE_CHECK;

  return (async () => {
    const pool = mkPool(), rpool = mkPool(pool.rows), app = mkApp();
    register(app, pool, { readPool: rpool });
    const api = (m, u, o) => callApi(app, m, u, o);
    let r;

    // create: 201, stamped, audit target set, stored with the user
    r = await api('POST', '/api/diseases', { body: { profile: mk('hypertension', 'Hypertension', T.CONDITIONS.hypertension.code) } });
    assert.strictEqual(r.status, 201); assert.strictEqual(r.req.auditTarget, 'hypertension');
    assert.deepStrictEqual([r.body.disease.profile.source.version, r.body.disease.profile.source.updatedBy, r.body.disease.updatedBy, r.body.disease.builtin], [1, 'dr@example.org', 'dr@example.org', false]);
    assert.ok(r.body.disease.profile.source.updatedAt && r.body.warnings.some(w => w.path === 'source.approvedBy'));
    assert.strictEqual((await api('POST', '/api/diseases', { body: { profile: mk('hypertension', 'Again', T.CONDITIONS.hypertension.code) } })).status, 409);
    assert.strictEqual((await api('POST', '/api/diseases', { body: mk('flatprof', 'Flat body also works', T.CONDITIONS.obesity.code) })).status, 201);
    // anonymous (sign-in switched off): written as "local"
    assert.strictEqual((await api('POST', '/api/diseases', { body: { profile: mk('gout', 'Gout', T.CONDITIONS.hyperlipidemia.code) }, user: null })).body.disease.updatedBy, 'local');

    // invalid input is refused and nothing is stored
    const before = pool.rows.size;
    r = await api('POST', '/api/diseases', { body: { profile: mk('badone', 'Bad', T.CONDITIONS.obesity.code, { mess: { uncodedShare: 1.5 }, links: [{ disease: 'nosuch', multiplier: 2, direction: 'raises' }] }) } });
    assert.strictEqual(r.status, 400); assert.ok(r.body.errors.some(e => e.path === 'mess.uncodedShare') && r.body.errors.some(e => e.path === 'links[0].disease')); assert.strictEqual(pool.rows.size, before);
    assert.strictEqual((await api('POST', '/api/diseases', { body: { profile: mk('Bad Key!', 'x', T.CONDITIONS.obesity.code) } })).status, 400);
    assert.strictEqual((await api('POST', '/api/diseases', { body: 'nonsense' })).status, 400);
    assert.strictEqual((await api('POST', '/api/diseases', { body: [] })).status, 400);

    // codes: unknown SNOMED code rejected; accepted when it is in the data dictionary or the loaded concepts; a missing reference table is not an error
    r = await api('POST', '/api/diseases', { body: { profile: mk('mystery', 'Mystery', '123456789') } });
    assert.strictEqual(r.status, 400); assert.ok(r.body.errors.some(e => e.path === 'dx.code' && /reference table/.test(e.message)));
    assert.strictEqual((await api('POST', '/api/diseases', { body: { profile: mk('indata', 'In data', '70000001') } })).status, 201);
    pool.ref.snomed_concept.add('80000002'); pool.ref.missing.add('snomed_dictionary');
    assert.strictEqual((await api('POST', '/api/diseases', { body: { profile: mk('inconcept', 'In concepts', '80000002') } })).status, 201);
    assert.strictEqual((await api('POST', '/api/diseases', { body: { profile: mk('nodict', 'No dict', '70000009') } })).status, 400);
    pool.ref.missing.add('snomed_concept'); assert.strictEqual((await api('POST', '/api/diseases', { body: { profile: mk('nonetab', 'No tables', '70000009') } })).status, 400);
    pool.ref.missing.clear();
    process.env.DISEASE_CODE_CHECK = 'format'; assert.strictEqual((await api('POST', '/api/diseases', { body: { profile: mk('formatonly', 'Format only', '123456789') } })).status, 201); delete process.env.DISEASE_CODE_CHECK;
    r = await api('POST', '/api/diseases', { body: { profile: mk('wrongunit', 'Wrong unit', T.CONDITIONS.obesity.code, { control: { ...good().control, goal: 70 } }) } });
    assert.strictEqual(r.status, 400); assert.ok(r.body.errors.length > 0);

    // validate: a dry run, normalized profile back, nothing stored
    const n0 = pool.rows.size;
    r = await api('POST', '/api/diseases/validate', { body: { profile: { ...mk('Newone', ' New one ', T.CONDITIONS.obesity.code) } } });
    assert.deepStrictEqual([r.status, r.body.ok, r.body.profile.key, r.body.profile.label], [200, true, 'newone', 'New one']); assert.strictEqual(pool.rows.size, n0);
    r = await api('POST', '/api/diseases/validate', { body: { profile: { key: 'x', dx: { code: 'abc' } } } });
    assert.strictEqual(r.body.ok, false); assert.ok(r.body.errors.some(e => e.path === 'dx.code'));
    assert.strictEqual((await api('POST', '/api/diseases/validate', { body: {} })).status, 400);

    // reads: list, filters, one
    r = await api('GET', '/api/diseases'); assert.strictEqual(r.body.count, pool.rows.size); assert.deepStrictEqual(r.body.diseases.map(d => d.key), [...pool.rows.keys()].sort());
    assert.deepStrictEqual(Object.keys(r.body.diseases[0]).sort(), ['approved', 'builtin', 'departments', 'dx', 'enabled', 'key', 'label', 'sensitive', 'updatedAt', 'updatedBy']);
    assert.ok((await api('GET', '/api/diseases?q=high')).body.count === 0);
    assert.deepStrictEqual((await api('GET', '/api/diseases?q=HYPERT')).body.diseases.map(d => d.key), ['hypertension']);
    assert.ok((await api('GET', '/api/diseases?q=t2dm')).body.count === pool.rows.size);                 // search terms count
    assert.ok((await api('GET', '/api/diseases?department=family_medicine')).body.count === pool.rows.size && (await api('GET', '/api/diseases?department=cardiology')).body.count === 0);
    assert.strictEqual((await api('GET', '/api/diseases?enabled=false')).body.count, 0);
    r = await api('GET', '/api/diseases/hypertension'); assert.deepStrictEqual([r.status, r.body.disease.profile.dx.code, r.body.disease.profile.enabled], [200, T.CONDITIONS.hypertension.code, true]);
    assert.strictEqual((await api('GET', '/api/diseases/nosuch')).status, 404); assert.strictEqual((await api('GET', '/api/diseases/Bad%20Key')).status, 400);

    // edit: new version; key cannot change; toggle only keeps the version; bad edits change nothing
    const upd = mk('hypertension', 'Hypertension (edited)', T.CONDITIONS.hypertension.code);
    r = await api('PUT', '/api/diseases/hypertension', { body: { profile: upd }, user: { email: 'b@example.org' } });
    assert.deepStrictEqual([r.status, r.body.disease.label, r.body.disease.profile.source.version, r.body.disease.updatedBy], [200, 'Hypertension (edited)', 2, 'b@example.org']);
    assert.strictEqual((await api('PUT', '/api/diseases/hypertension', { body: { profile: { ...upd, key: 'other' } } })).status, 400);
    r = await api('PUT', '/api/diseases/hypertension', { body: { profile: { ...upd, mess: { uncodedShare: 2 } } } }); assert.strictEqual(r.status, 400);
    assert.strictEqual(pool.rows.get('hypertension').profile.label, 'Hypertension (edited)');
    r = await api('PUT', '/api/diseases/hypertension', { body: { enabled: false } });
    assert.deepStrictEqual([r.status, r.body.disease.enabled, r.body.disease.profile.enabled, r.body.disease.profile.source.version], [200, false, false, 2]);
    assert.strictEqual((await api('GET', '/api/diseases?enabled=false')).body.count, 1);
    r = await api('PUT', '/api/diseases/hypertension', { body: { profile: upd } }); assert.strictEqual(r.body.disease.enabled, false);       // an edit does not switch it back on
    assert.strictEqual((await api('PUT', '/api/diseases/hypertension', { body: {} })).status, 400);
    assert.strictEqual((await api('PUT', '/api/diseases/nosuch', { body: { enabled: true } })).status, 404);

    // links need existing diseases; delete is refused while something links to it
    r = await api('PUT', '/api/diseases/flatprof', { body: { profile: mk('flatprof', 'Obesity', T.CONDITIONS.obesity.code, { links: [{ disease: 'hypertension', multiplier: 1.5, direction: 'raises' }] }) } });
    assert.strictEqual(r.status, 200);
    r = await api('DELETE', '/api/diseases/hypertension'); assert.deepStrictEqual([r.status, r.body.dependents], [409, ['flatprof']]);
    await api('POST', '/api/diseases', { body: { profile: mk('viamult', 'Via multiplier', T.CONDITIONS.hyperlipidemia.code, { prevalence: { ...good().prevalence, multipliers: [{ disease: 'gout', multiplier: 2 }] } }) } });
    assert.deepStrictEqual((await api('DELETE', '/api/diseases/gout')).body.dependents, ['viamult']);
    await api('PUT', '/api/diseases/flatprof', { body: { profile: mk('flatprof', 'Obesity', T.CONDITIONS.obesity.code) } });
    r = await api('DELETE', '/api/diseases/hypertension'); assert.deepStrictEqual([r.status, r.body.deleted, pool.rows.has('hypertension')], [200, 'hypertension', false]);
    assert.strictEqual((await api('DELETE', '/api/diseases/hypertension')).status, 404);

    // built-in profiles: switch yes, edit / delete no
    pool.rows.set('seeded', { profile: mk('seeded', 'Seed', T.CONDITIONS.obesity.code), enabled: true, builtin: true, updated_by: 'seed', updated_at: new Date() });
    r = await api('PUT', '/api/diseases/seeded', { body: { profile: mk('seeded', 'Hacked', T.CONDITIONS.obesity.code) } }); assert.deepStrictEqual([r.status, r.body.code], [403, 'BUILTIN']);
    assert.strictEqual((await api('DELETE', '/api/diseases/seeded')).body.code, 'BUILTIN');
    r = await api('PUT', '/api/diseases/seeded', { body: { enabled: false } }); assert.deepStrictEqual([r.status, r.body.disease.enabled, r.body.disease.builtin], [200, false, true]);
    assert.strictEqual(pool.rows.get('seeded').profile.label, 'Seed');
    assert.strictEqual((await api('GET', '/api/diseases?enabled=false')).body.diseases.find(d => d.key === 'seeded').builtin, true);

    // read-only connection: reads only; owner connection: all the writes; a database failure is a 500 without details
    assert.ok(rpool.log.length > 0 && rpool.log.every(q => /^SELECT /.test(q)), 'read-only pool saw a write');
    assert.ok(pool.log.some(q => /^INSERT /.test(q)) && pool.log.some(q => /^UPDATE /.test(q)) && pool.log.some(q => /^DELETE /.test(q)));
    const sick = { async query() { throw new Error('password authentication failed for user "secret"'); } }, app2 = mkApp(); register(app2, sick);
    const origErr = console.error; console.error = () => {}; r = await callApi(app2, 'GET', '/api/diseases'); console.error = origErr;
    assert.strictEqual(r.status, 500); assert.ok(!JSON.stringify(r.body).includes('secret'));

    // ---- chunk 0.3: built-in profiles
    const seeds = seedProfiles(), seedKeys = seeds.map(s => s.key);
    assert.deepStrictEqual(seedKeys, ['diabetes', 'hypertension']);
    seeds.forEach(s => { const v = check(s, { knownDiseases: seedKeys }); assert.ok(v.ok, s.key + ': ' + JSON.stringify(v.errors)); });
    // the Disease module entries equal the old hardcoded ones field by field (this is what keeps its numbers identical)
    const old = (cond, measure, lab, label) => ({ label, condCode: T.CONDITIONS[cond].code, labCode: T.LABS[lab].code, goalBelow: Number(T.CONTROL_MEASURES[measure].goalBelow), drugCodes: T.TREATMENT_MAP[cond].map(k => T.MEDICATIONS[k].code) });
    assert.deepStrictEqual(toModuleEntry(seeds[0]), old('diabetes', 'diabetes_hba1c', 'hba1c', 'Type 2 diabetes (HbA1c below goal)'));
    assert.deepStrictEqual(toModuleEntry(seeds[1]), old('hypertension', 'htn_bp', 'sbp', 'Hypertension (systolic BP below goal)'));
    // a profile the module cannot use yet is left out: no control, direction above, a score
    const base = () => JSON.parse(JSON.stringify(seeds[0]));
    const noCtl = base(); delete noCtl.control; const up = base(); up.control.direction = 'above'; const sc = base(); sc.control.type = 'score';
    assert.deepStrictEqual([noCtl, up, sc].map(toModuleEntry), [null, null, null]);
    // chunk 1.6a: the generic sections need only the diagnosis, so those same three profiles are usable there; no key or no code is not
    assert.deepStrictEqual([noCtl, up, sc].map(p => toCohortEntry(p).code), ['44054006', '44054006', '44054006']);
    assert.deepStrictEqual(toCohortEntry({ key: 'Gout', label: 'Gout', dx: { code: '90560007', display: 'Gout (disorder)', terms: ['Gout', ' podagra ', 'gout', ''] } }),
      { key: 'gout', label: 'Gout', code: '90560007', system: 'snomed', terms: ['gout', 'podagra', 'gout (disorder)'], sensitive: false, control: null, treatment: [], monitoring: [] });
    // chunk 1.6b: the control rule. below / above / range are usable, a score, a missing goal and a range without its high end are not
    const rule = c => toCohortEntry({ ...base(), control: c }).control, cb = base().control;
    assert.deepStrictEqual(rule(cb), { type: 'lab', code: '4548-4', display: 'HbA1c', unit: '%', goal: 7, goalHigh: null, direction: 'below', lookbackDays: 365 });
    assert.strictEqual(rule({ ...cb, display: '' }).display, '4548-4', 'no display text: the code is shown');
    assert.strictEqual(rule({ ...cb, direction: 'above' }).direction, 'above');
    assert.deepStrictEqual([rule({ ...cb, direction: 'range', goal: 100, goalHigh: 140 }).goal, rule({ ...cb, direction: 'range', goal: 100, goalHigh: 140 }).goalHigh], [100, 140]);
    assert.strictEqual(rule({ ...cb, direction: 'range', goal: 100 }), null); assert.strictEqual(rule({ ...cb, direction: 'range', goal: 100, goalHigh: 90 }), null);
    assert.strictEqual(rule({ ...cb, type: 'score' }), null); assert.strictEqual(rule({ ...cb, goal: null }), null); assert.strictEqual(rule({ ...cb, direction: 'sideways' }), null); assert.strictEqual(rule(null), null);
    assert.strictEqual(rule({ ...cb, lookbackDays: 99999 }).lookbackDays, 3650, 'look-back is limited to 10 years'); assert.strictEqual(rule({ ...cb, lookbackDays: 0 }).lookbackDays, 365, 'no look-back = the 365-day default'); assert.strictEqual(rule({ ...cb, lookbackDays: 0.4 }).lookbackDays, 1);
    // chunk 1.7b: treatment lines for the generic treatment section
    const tl = t => toCohortEntry({ ...base(), treatment: t }).treatment;
    assert.deepStrictEqual(tl([{ code: '6809', display: 'Metformin', line: 1, renewalDays: 90 }, { code: '6809', line: 2 }, { code: '', line: 1 }, { code: '5856', line: 2.6, renewalDays: 3 }]),
      [{ code: '6809', display: 'Metformin', line: 1, supply: 90 }, { code: '5856', display: '5856', line: 3, supply: 7 }], 'lines without a code and repeated codes are dropped; line rounded; supply 7-180');
    assert.strictEqual(tl([{ code: 'a', renewalDays: 9999 }])[0].supply, 180); assert.strictEqual(tl([{ code: 'a' }])[0].supply, 30); assert.strictEqual(tl(Array.from({ length: 30 }, (_, i) => ({ code: 'c' + i }))).length, 12);
    // chunk 1.8a: monitoring items for the care-gaps section
    const ml = m => toCohortEntry({ ...base(), monitoring: m }).monitoring;
    assert.deepStrictEqual(ml([{ kind: 'test', code: '4548-4', display: 'HbA1c', intervalControlledDays: 180, intervalUncontrolledDays: 90 }, { kind: 'test', code: '4548-4', intervalControlledDays: 1 }, { kind: 'vaccine', code: '141', intervalControlledDays: 365.4 },
      { kind: 'sideways', code: 'x', intervalControlledDays: 5 }, { kind: 'screening', code: '', intervalControlledDays: 5 }, { kind: 'screening', code: '9', intervalControlledDays: null }, { kind: 'screening', code: '8', intervalUncontrolledDays: 99999 }]),
      [{ kind: 'test', code: '4548-4', display: 'HbA1c', intervalControlledDays: 180, intervalUncontrolledDays: 90 }, { kind: 'vaccine', code: '141', display: '141', intervalControlledDays: 365, intervalUncontrolledDays: 365 }, { kind: 'screening', code: '8', display: '8', intervalControlledDays: 3650, intervalUncontrolledDays: 3650 }],
      'unknown kind, no code, no interval and repeated items are dropped; one interval fills both; days 1-3650');
    assert.strictEqual(ml(Array.from({ length: 40 }, (_, i) => ({ kind: 'test', code: 'c' + i, intervalControlledDays: 30 }))).length, 20);
    assert.deepStrictEqual(toCohortEntry({ key: 'x1', label: 'Only a label', dx: { code: '1' } }).terms, ['only a label'], 'the label is the last-resort search word');
    assert.strictEqual(toCohortEntry({ key: 'x1', dx: { code: '' } }), null); assert.strictEqual(toCohortEntry({ dx: { code: '1' } }), null); assert.strictEqual(toCohortEntry(null), null);
    assert.strictEqual(toCohortEntry({ key: 'x1', dx: { code: '1', terms: Array.from({ length: 50 }, (_, i) => 't' + i + 'x'.repeat(100)) } }).terms.length, 30, 'at most 30 terms');
    assert.ok(toCohortEntry({ key: 'x1', dx: { code: '1', terms: ['y'.repeat(200)] } }).terms[0].length <= 80, 'a term is cut at 80 characters');
    // seeding writes both rows once as built-in, enabled, and never touches an existing row
    const rows = new Map(), seedDb = { async query(sql, p) { assert.ok(/^INSERT INTO disease_profiles/.test(sql)); assert.ok(/TRUE, TRUE/.test(sql)); if (rows.has(p[0])) return { rows: [] }; rows.set(p[0], JSON.parse(p[1])); return { rows: [{ key: p[0] }] }; } };
    assert.strictEqual(await seedBuiltins(seedDb), 2); assert.strictEqual(await seedBuiltins(seedDb), 0);
    assert.deepStrictEqual([...rows.keys()], seedKeys); assert.strictEqual(rows.get('diabetes').source.updatedBy, 'system'); assert.ok(rows.get('hypertension').prevalence.multipliers.some(m => m.disease === 'diabetes'));
    // a stored built-in row comes back through the module mapping unchanged
    assert.deepStrictEqual(toModuleEntry(rows.get('diabetes')), toModuleEntry(seeds[0]));

    // ---- chunk 1.1: prepareProfiles
    {
      const a = mk('zeta', 'Zeta', '70000001'), b = mk('alpha', 'Alpha', '70000002');
      a.prevalence = { ...a.prevalence, multipliers: [{ disease: 'alpha', multiplier: 2 }] };
      const off = { ...mk('dormant', 'Dormant', '70000003'), enabled: false }, bad = { ...mk('broken', 'Broken', '70000004'), prevalence: { ...good().prevalence, ageBands: [] } };
      const out = prepareProfiles([a, b, off, bad, mk('zeta', 'Dup', '70000005')]);
      assert.deepStrictEqual(out.profiles.map(p => p.key), ['alpha', 'zeta'], 'dependency first, disabled dropped');
      assert.deepStrictEqual(out.problems.map(p => p.key).sort(), ['broken', 'zeta']);
      const c2 = mk('c2', 'C2', '70000006'); c2.links = [{ disease: 'obesity', multiplier: 1.5, direction: 'raises' }];
      assert.strictEqual(prepareProfiles([c2]).problems.length, 1); assert.strictEqual(prepareProfiles([c2], { builtinKeys: ['obesity'] }).problems.length, 0);
      assert.deepStrictEqual(prepareProfiles(undefined), { profiles: [], problems: [] });
    }

    // plan chunk 1.11a: POST /api/diseases/:key/preview generates in memory and summarises prevalence, control and treatment
    {
      const oc = process.env.DISEASE_CODE_CHECK; process.env.DISEASE_CODE_CHECK = 'format';
      const lib = seedProfiles()[0], prof = { ...lib, key: 'prev_dz', dx: { ...lib.dx, code: '70000099' }, links: [], prevalence: { ...lib.prevalence, multipliers: [] } };
      const app4 = mkApp(), pool4 = mkPool(); register(app4, pool4);
      let r4 = await callApi(app4, 'POST', '/api/diseases/prev_dz/preview', { body: { profile: prof, count: 200, seed: 5 } });
      assert.strictEqual(r4.status, 200, JSON.stringify(r4.body)); const b4 = r4.body;
      assert.deepStrictEqual([b4.skipped, b4.sample.patients, b4.sample.seed], [null, 200, '5']);
      assert.ok(b4.prevalence.withDisease > 0 && b4.prevalence.withDisease < 200 && b4.prevalence.patients === 200, 'prevalence');
      assert.deepStrictEqual(b4.prevalence.groups.map(g => g.group).filter(g => /^(men|women)$/.test(g)).sort(), ['men', 'women'], 'split by sex');
      assert.strictEqual(b4.prevalence.groups.filter(g => /^(men|women)$/.test(g.group)).reduce((t, g) => t + g.withDisease, 0), b4.prevalence.withDisease, 'sex groups add up to the cases');
      assert.ok(b4.control.withResult > 0 && b4.control.controlled + b4.control.uncontrolled === b4.control.withResult && b4.control.direction === 'below' && b4.control.lastValue.min <= b4.control.lastValue.max, 'control');
      assert.ok(b4.treatment.treated > 0 && b4.treatment.lines === prof.treatment.length && b4.treatment.fills > 0 && b4.treatment.adherenceMean > 0, 'treatment');
      assert.strictEqual(Object.values(b4.other.severity).reduce((t, x) => t + x, 0), b4.prevalence.withDisease, 'severity counts every case'); assert.strictEqual(b4.note, null);
      r4 = await callApi(app4, 'POST', '/api/diseases/prev_dz/preview', { body: { profile: prof, count: 200, seed: 5 } });
      assert.deepStrictEqual([r4.body.prevalence, r4.body.control, r4.body.treatment], [b4.prevalence, b4.control, b4.treatment], 'same seed, same summary');
      r4 = await callApi(app4, 'POST', '/api/diseases/prev_dz/preview', { body: { profile: prof } });
      assert.deepStrictEqual([r4.status, r4.body.sample.patients, r4.body.sample.seed, typeof r4.body.note], [200, 20, 42, 'string'], 'default is 20 patients, seed 42, with a small-sample note');
      assert.strictEqual((await callApi(app4, 'POST', '/api/diseases/prev_dz/preview', { body: { profile: prof, count: 99999 } })).body.sample.patients, 200, 'count is capped at 200');
      assert.strictEqual((await callApi(app4, 'POST', '/api/diseases/prev_dz/preview')).status, 404, 'not saved and no profile sent');
      pool4.rows.set('prev_dz', { profile: { ...prof, enabled: false }, enabled: false, builtin: false, updated_by: 'x', updated_at: new Date() });
      r4 = await callApi(app4, 'POST', '/api/diseases/prev_dz/preview', { body: { count: 40 } });
      assert.deepStrictEqual([r4.status, r4.body.key, r4.body.sample.patients], [200, 'prev_dz', 40], 'a saved profile previews even when it is switched off');
      r4 = await callApi(app4, 'POST', '/api/diseases/prev_dz/preview', { body: { profile: { ...prof, prevalence: { ...prof.prevalence, ageBands: [{ from: 0, to: 120, male: 2, female: 2 }] } } } });
      assert.strictEqual(r4.status, 400); assert.ok(r4.body.errors && r4.body.errors.length, 'an invalid profile is refused with its errors');
      assert.strictEqual((await callApi(app4, 'POST', '/api/diseases/BAD KEY/preview', { body: { profile: prof } })).status, 400);
      r4 = await callApi(app4, 'POST', '/api/diseases/' + lib.key + '/preview', { body: { profile: lib } });
      assert.strictEqual(r4.status, 200); assert.ok(r4.body.skipped && !r4.body.prevalence, 'a disease the built-in model already generates says so');
      assert.ok(!pool4.log.some(q => /^(INSERT|UPDATE|DELETE)/.test(q)), 'preview writes nothing');
      if (oc === undefined) delete process.env.DISEASE_CODE_CHECK; else process.env.DISEASE_CODE_CHECK = oc;
    }

    // plan chunk 2.1: seed library batch 1 (hypercholesterolaemia, obesity, asthma, COPD, CKD)
    {
      const L = libraryProfiles(), builtin = seedProfiles(), S = require('./synthetic'), cond = Object.values(T.CONDITIONS).map(c => c.code);
      assert.deepStrictEqual(L.map(p => p.key), ['hypercholesterolaemia', 'obesity_bmi30', 'asthma_allergic', 'copd_bronchitis', 'ckd_stage3']);
      for (const p of L) {
        const r = check(p, { knownDiseases: [...builtin.map(b => b.key), ...L.map(x => x.key)] });
        assert.ok(r.ok, p.key + ' is valid: ' + JSON.stringify(r.errors));
        assert.ok(!Object.hasOwn(T.CONDITIONS, p.key) && !cond.includes(p.dx.code), p.key + ' is not a code or key the built-in generator already writes');
        assert.ok(/NEEDS CLINICIAN REVIEW/.test(p.source.note) && p.source.approvedBy === '' && r.warnings.some(w => w.path === 'source.approvedBy'), p.key + ' is marked for clinician review');
        assert.ok(p.departments.length && p.dx.terms.length && p.dx.icd10 && p.source.note.length < 500, p.key + ' has departments, terms, ICD-10 and a short source note');
        assert.deepStrictEqual(normalize(p), normalize(JSON.parse(JSON.stringify(p))), p.key + ' survives a JSON round trip');
      }
      assert.strictEqual(new Set(L.map(p => p.dx.code)).size, 5); assert.ok(!L.some(p => builtin.some(b => b.key === p.key)));
      // every one generates, with the built-in diseases they link to, and the ground truth agrees with the data
      const end = '2026-06-30', r = S.generateBundle({ count: 3000, seed: 21, endDate: end, profiles: [...builtin, ...L] }), dp = r.summary.diseaseProfiles;
      assert.deepStrictEqual(dp.skipped.map(x => x.key).sort(), ['diabetes', 'hypertension'], 'only the built-in diseases come from the built-in model');
      const res = r.bundle.entry.map(e => e.resource);
      for (const p of L) {
        const tr = r.groundTruth.filter(x => x.disease === p.key);
        assert.ok(tr.length > 40, p.key + ' generates ' + tr.length); assert.strictEqual(dp.generated[p.key], tr.length, p.key + ': one truth record per patient');
        assert.strictEqual(new Set(tr.map(x => x.patient)).size, tr.length);
        const withDx = new Set(res.filter(x => x.resourceType === 'Condition' && x.id.includes('-dz-' + p.key + '-')).map(x => x.subject.reference));
        assert.ok(withDx.size > 0 && withDx.size <= tr.length, p.key + ' has its own condition records');
        if (p.control) assert.ok(tr.some(x => x.controlled === true) && tr.some(x => x.controlled === false), p.key + ' has patients on both sides of the goal');
        else assert.ok(tr.every(x => x.controlled === null), p.key + ' has no control measure, so no control result');
        if (p.treatment.length) assert.ok(tr.some(x => x.treated), p.key + ' has treated patients'); else assert.ok(tr.every(x => !x.treated), p.key + ' has no drug line');
        assert.ok(tr.every(x => x.onset <= end), p.key + ': onset is never after the end date');
      }
      const ck = r.groundTruth.filter(x => x.disease === 'ckd_stage3').length, co = r.groundTruth.filter(x => x.disease === 'copd_bronchitis').length;
      assert.ok(ck > 0 && co > 0);
      // the library file is what Import profiles reads: all five are created, none is built in, a second import changes nothing
      const oc = process.env.DISEASE_CODE_CHECK; process.env.DISEASE_CODE_CHECK = 'format';
      const ap = mkApp(), pl = mkPool(); register(ap, pl);
      for (const b of builtin) pl.rows.set(b.key, { profile: b, enabled: true, builtin: true, updated_by: 'system', updated_at: new Date() });
      let r2 = await callApi(ap, 'POST', '/api/diseases/import', { body: { diseases: L } }); assert.deepStrictEqual([r2.status, r2.body.counts.created], [201, 5], JSON.stringify(r2.body));
      assert.ok([...pl.rows].filter(([k]) => L.some(p => p.key === k)).every(([, v]) => v.builtin === false && v.enabled === true));
      r2 = await callApi(ap, 'POST', '/api/diseases/import', { body: { diseases: L } }); assert.strictEqual(r2.body.counts.skipped_exists, 5);
      if (oc === undefined) delete process.env.DISEASE_CODE_CHECK; else process.env.DISEASE_CODE_CHECK = oc;
    }

    // plan chunk 2.2: seed library batch 2 (hypothyroidism, hyperthyroidism, depression, GERD, gout, osteoarthritis)
    {
      const L = libraryProfiles(2), L1 = libraryProfiles(1), builtin = seedProfiles(), S = require('./synthetic'), cond = Object.values(T.CONDITIONS).map(c => c.code);
      assert.deepStrictEqual(L.map(p => p.key), ['hypothyroidism', 'hyperthyroidism', 'depression_mild', 'gerd', 'gout', 'osteoarthritis']);
      for (const p of L) {
        const r = check(p, { knownDiseases: builtin.map(b => b.key) });
        assert.ok(r.ok, p.key + ' is valid: ' + JSON.stringify(r.errors));
        assert.ok(!Object.hasOwn(T.CONDITIONS, p.key) && !cond.includes(p.dx.code), p.key + ' is not a code or key the built-in generator already writes');
        assert.ok(/NEEDS CLINICIAN REVIEW/.test(p.source.note) && p.source.approvedBy === '' && r.warnings.some(w => w.path === 'source.approvedBy'), p.key + ' is marked for clinician review');
        assert.ok(p.departments.length && p.dx.terms.length && p.dx.icd10 && p.source.note.length < 500, p.key + ' has departments, terms, ICD-10 and a short source note');
        assert.deepStrictEqual(normalize(p), normalize(JSON.parse(JSON.stringify(p))), p.key + ' survives a JSON round trip');
        assert.ok(p.prevalence.multipliers.every(m => builtin.some(b => b.key === m.disease)), p.key + ' links only to built-in diseases, so batch 2 imports without batch 1');
      }
      assert.strictEqual(new Set([...L, ...L1].map(p => p.dx.code)).size, 11, 'no code or key is used twice across the two batches'); assert.strictEqual(new Set([...L, ...L1].map(p => p.key)).size, 11);
      const end = '2026-06-30', r = S.generateBundle({ count: 4000, seed: 22, endDate: end, profiles: [...builtin, ...L, ...L1] }), dp = r.summary.diseaseProfiles;
      assert.deepStrictEqual(dp.skipped.map(x => x.key).sort(), ['diabetes', 'hypertension'], 'only the built-in diseases come from the built-in model');
      const only = S.generateBundle({ count: 800, seed: 5, endDate: end, profiles: [...builtin, ...L] }); assert.ok(L.every(p => only.summary.diseaseProfiles.generated[p.key] > 0), 'batch 2 generates without batch 1');
      const res = r.bundle.entry.map(e => e.resource);
      for (const p of L) {
        const tr = r.groundTruth.filter(x => x.disease === p.key);
        assert.ok(tr.length > 25, p.key + ' generates ' + tr.length); assert.strictEqual(dp.generated[p.key], tr.length, p.key + ': one truth record per patient');
        assert.strictEqual(new Set(tr.map(x => x.patient)).size, tr.length);
        const withDx = new Set(res.filter(x => x.resourceType === 'Condition' && x.id.includes('-dz-' + p.key + '-')).map(x => x.subject.reference));
        assert.ok(withDx.size > 0 && withDx.size <= tr.length, p.key + ' has its own condition records');
        if (p.control) assert.ok(tr.some(x => x.controlled === true) && tr.some(x => x.controlled === false), p.key + ' has patients on both sides of the goal');
        else assert.ok(tr.every(x => x.controlled === null), p.key + ' has no control measure, so no control result');
        if (p.treatment.length) assert.ok(tr.some(x => x.treated), p.key + ' has treated patients');
        assert.ok(tr.every(x => x.onset <= end), p.key + ': onset is never after the end date');
      }
      // sex-specific rates come through: hypothyroidism is mostly women, gout mostly men
      const sexOf = new Map(res.filter(x => x.resourceType === 'Patient').map(x => [x.id, x.gender])), share = k => { const t = r.groundTruth.filter(x => x.disease === k); return t.filter(x => sexOf.get(x.patient) === 'female').length / t.length; };
      assert.ok(share('hypothyroidism') > 0.65 && share('hyperthyroidism') > 0.65 && share('gout') < 0.35, 'female share ' + share('hypothyroidism') + ' / ' + share('gout'));
      // the library file imports as six new profiles when the built-in diseases are there, and is refused as a whole when the one it links to is not
      const oc = process.env.DISEASE_CODE_CHECK; process.env.DISEASE_CODE_CHECK = 'format';
      const ap = mkApp(), pl = mkPool(); register(ap, pl);
      let r2 = await callApi(ap, 'POST', '/api/diseases/import', { body: { diseases: L } }); assert.strictEqual(r2.status, 400, 'gout links to hypertension: not there yet');
      for (const b of builtin) pl.rows.set(b.key, { profile: b, enabled: true, builtin: true, updated_by: 'system', updated_at: new Date() });
      r2 = await callApi(ap, 'POST', '/api/diseases/import', { body: { diseases: L } }); assert.deepStrictEqual([r2.status, r2.body.counts.created], [201, 6], JSON.stringify(r2.body));
      r2 = await callApi(ap, 'POST', '/api/diseases/import', { body: { diseases: L1 } }); assert.deepStrictEqual([r2.status, r2.body.counts.created], [201, 5], 'both batches live side by side');
      if (oc === undefined) delete process.env.DISEASE_CODE_CHECK; else process.env.DISEASE_CODE_CHECK = oc;
    }

    // plan chunk 1.11c: export and import
    {
      const ap = mkApp(), pl = mkPool(); let hits = 0; register(ap, pl, { onChange: () => { hits++; } });
      const call = (m, u, o) => callApi(ap, m, u, o), core = k => { const { source, ...rest } = pl.rows.get(k).profile; return rest; };
      pl.ref.snomed_dictionary.add('70000011'); pl.ref.snomed_dictionary.add('70000012');
      const a = mk('lib_a', 'Lib A', '70000011'), b = mk('lib_b', 'Lib B', '70000012', { links: [{ disease: 'lib_a', multiplier: 1.5, direction: 'raises' }] });
      // a library whose first profile links to the second (the link target is in the same file) imports in one go
      let r = await call('POST', '/api/diseases/import', { body: { diseases: [b, a] } });
      assert.deepStrictEqual([r.status, r.body.counts.created, r.body.results.map(x => x.status)], [201, 2, ['created', 'created']], JSON.stringify(r.body)); assert.strictEqual(hits, 1);
      assert.deepStrictEqual([pl.rows.get('lib_a').profile.source.version, pl.rows.get('lib_a').builtin, pl.rows.get('lib_a').updated_by], [1, false, 'dr@example.org']);
      // export: both, sorted, as a library document; keys picks some and says what the others need
      r = await call('GET', '/api/diseases/export');
      assert.deepStrictEqual([r.status, r.body.format, r.body.version, r.body.count, r.body.diseases.map(p => p.key), r.body.needs], [200, 'vibe-rounds-disease-library', 1, 2, ['lib_a', 'lib_b'], []]);
      const lib = r.body, before = { lib_a: core('lib_a'), lib_b: core('lib_b') };
      r = await call('GET', '/api/diseases/export?keys=lib_b&download=1'); assert.deepStrictEqual([r.body.count, r.body.needs], [1, ['lib_a']]);
      assert.strictEqual((await call('GET', '/api/diseases/export?keys=lib_a,nosuch')).status, 404);
      // round trip: delete both, import the export, the profiles come back the same
      assert.strictEqual((await call('DELETE', '/api/diseases/lib_b')).status, 200); assert.strictEqual((await call('DELETE', '/api/diseases/lib_a')).status, 200);
      r = await call('POST', '/api/diseases/import', { body: lib }); assert.deepStrictEqual([r.status, r.body.counts.created], [201, 2], JSON.stringify(r.body));
      assert.deepStrictEqual({ lib_a: core('lib_a'), lib_b: core('lib_b') }, before, 'export then import round-trips');
      // importing again changes nothing (skip), unless asked to overwrite; an overwrite keeps the switch and raises the version
      r = await call('POST', '/api/diseases/import', { body: lib }); assert.deepStrictEqual([r.status, r.body.counts.skipped_exists, r.body.counts.created], [200, 2, 0]);
      const hitsBefore = hits; pl.rows.get('lib_a').enabled = false;
      r = await call('POST', '/api/diseases/import', { body: { profiles: [{ ...a, label: 'Lib A renamed' }], onExisting: 'overwrite' } });
      assert.deepStrictEqual([r.status, r.body.counts.updated], [200, 1], JSON.stringify(r.body)); assert.strictEqual(hits, hitsBefore + 1);
      assert.deepStrictEqual([pl.rows.get('lib_a').profile.label, pl.rows.get('lib_a').profile.source.version, pl.rows.get('lib_a').enabled, pl.rows.get('lib_a').profile.enabled], ['Lib A renamed', 2, false, false]);
      // all or nothing: an invalid profile, a link to nothing, a duplicate key, a non-object, an unknown code: 400, nothing stored
      const n0 = pl.rows.size, logN = pl.log.length;
      for (const bad of [[mk('lib_c', 'C', '70000011'), mk('Bad Key!', 'x', '70000011')],
                         [mk('lib_c', 'C', '70000011', { links: [{ disease: 'nosuch', multiplier: 2, direction: 'raises' }] })],
                         [mk('lib_c', 'C', '70000011'), mk('lib_c', 'C again', '70000011')], [mk('lib_c', 'C', '70000011'), 'text'], [mk('lib_c', 'C', '123456789')]]) {
        r = await call('POST', '/api/diseases/import', { body: { profiles: bad } });
        assert.strictEqual(r.status, 400, JSON.stringify(bad)); assert.ok(r.body.results.some(x => x.status === 'invalid' && x.errors.length) && r.body.imported === 0 && /Nothing was imported/.test(r.body.error));
      }
      assert.strictEqual(pl.rows.size, n0, 'nothing stored'); assert.ok(!pl.log.slice(logN).some(q => /^(INSERT|UPDATE|DELETE)/.test(q)), 'no write was attempted');
      // dry run reports and writes nothing
      const logD = pl.log.length; r = await call('POST', '/api/diseases/import', { body: { profiles: [mk('lib_d', 'D', '70000011'), a], dryRun: true } });
      assert.deepStrictEqual([r.status, r.body.dryRun, r.body.counts.created, r.body.counts.skipped_exists, pl.rows.has('lib_d')], [200, true, 1, 1, false]); assert.ok(!pl.log.slice(logD).some(q => /^(INSERT|UPDATE|DELETE)/.test(q)));
      // a built-in profile is never replaced and is left out of an export unless asked for
      pl.rows.set('bi_dz', { profile: { ...mk('bi_dz', 'Built in', '70000011'), enabled: true }, enabled: true, builtin: true, updated_by: 'seed', updated_at: new Date() });
      r = await call('POST', '/api/diseases/import', { body: { profiles: [mk('bi_dz', 'Hacked', '70000011')], onExisting: 'overwrite' } });
      assert.deepStrictEqual([r.status, r.body.counts.skipped_builtin, pl.rows.get('bi_dz').profile.label], [200, 1, 'Built in']);
      assert.ok(!(await call('GET', '/api/diseases/export')).body.diseases.some(p => p.key === 'bi_dz')); assert.ok((await call('GET', '/api/diseases/export?builtin=true')).body.diseases.some(p => p.key === 'bi_dz'));
      assert.strictEqual((await call('GET', '/api/diseases/export?keys=bi_dz')).body.count, 1);
      // the body may be one profile ({ profile } or flat), a bare list, or an export; anything else is refused
      r = await call('POST', '/api/diseases/import', { body: { profile: mk('one_a', 'One', '70000011') } }); assert.deepStrictEqual([r.status, r.body.counts.created, r.req.auditTarget], [201, 1, 'one_a']);
      r = await call('POST', '/api/diseases/import', { body: mk('one_b', 'Flat', '70000011') }); assert.deepStrictEqual([r.status, r.body.counts.created], [201, 1]);
      r = await call('POST', '/api/diseases/import', { body: [mk('one_c', 'Bare', '70000011'), { profile: mk('one_d', 'Wrapped', '70000011') }] }); assert.deepStrictEqual([r.status, r.body.counts.created, r.req.auditTarget], [201, 2, '2 profiles']);
      for (const body of [{}, [], 'nonsense', { diseases: [] }, { profiles: [mk('x_a', 'X', '70000011')], onExisting: 'replace' }, { profiles: Array.from({ length: 201 }, (_, i) => mk('many_' + i, 'M', '70000011')) }]) {
        assert.strictEqual((await call('POST', '/api/diseases/import', { body })).status, 400, JSON.stringify(body).slice(0, 60));
      }
      // "format only" code checking works on import as on create
      process.env.DISEASE_CODE_CHECK = 'format'; r = await call('POST', '/api/diseases/import', { body: { profiles: [mk('fmt_a', 'Fmt', '123456789')] } }); delete process.env.DISEASE_CODE_CHECK; assert.strictEqual(r.status, 201);
    }

    // plan chunk 1.11b: profilesFor picks what the generator route runs
    {
      const pl = mkPool(), on = mk('on_dz', 'On', '70000001'), off = mk('off_dz', 'Off', '70000002'), linked = mk('lk_dz', 'Linked', '70000003'), dep = mk('dep_dz', 'Dep', '70000004');
      dep.links = [{ disease: 'lk_dz', multiplier: 2, direction: 'raises' }];
      const put = (p, en) => pl.rows.set(p.key, { profile: p, enabled: en, builtin: false, updated_by: 'x', updated_at: new Date() });
      put(on, true); put(off, false); put(linked, false); put(dep, true);
      assert.deepStrictEqual((await profilesFor(pl, 'enabled')).map(p => p.key).sort(), ['dep_dz', 'lk_dz', 'on_dz'], 'enabled ones, plus what they link to');
      assert.deepStrictEqual((await profilesFor(pl, ['off_dz'])).map(p => [p.key, p.enabled]), [['off_dz', true]], 'a chosen key runs even when switched off');
      assert.deepStrictEqual((await profilesFor(pl, ['on_dz', 'ON_DZ'])).map(p => p.key), ['on_dz'], 'duplicates and case');
      await assert.rejects(() => profilesFor(pl, ['nope_dz']), e => e.status === 404);
      await assert.rejects(() => profilesFor(pl, ['BAD KEY']), e => e.status === 400);
      await assert.rejects(() => profilesFor(pl, 'all'), e => e.status === 400);
    }

    // plan chunk 3.1a: department profiles
    {
      const good = () => ({ key: 'cardiology', label: 'Cardiology', diseases: ['dz_a', 'dz_b'], description: 'Heart and circulation',
        measureSet: [{ kind: 'vital', code: '8480-6', display: 'Systolic BP', unit: 'mm[Hg]' }, { kind: 'lab', code: '18262-6', display: 'LDL' }, { kind: 'score', code: 'nyha', display: 'NYHA class' }],
        scores: [{ key: 'nyha', label: 'NYHA class', min: 1, max: 4, direction: 'higher_worse', cutoffs: [{ label: 'symptomatic', from: 2 }, { label: 'severe', from: 3 }] }],
        bundle: { items: [{ analytic: 'disease_profile', mode: 'v4', sections: ['cohort', 'control_status'] }, { analytic: 'medication_utilization' }] },
        episodeModel: { visitsPerYear: 3, admissionShare: 0.1, edShare: 0.05 }, scopeFilters: { minAge: 18, maxAge: 100 }, source: { note: 'demo' } });
      const bad = (mut, re) => { const p = good(); mut(p); const r = validateDepartment(p, { knownDiseases: ['dz_a', 'dz_b'] }); assert.ok(!r.ok && r.errors.some(e => re.test(e.path + ' ' + e.message)), re + ' -> ' + JSON.stringify(r.errors)); };
      let v = checkDepartment(good(), { knownDiseases: ['dz_a', 'dz_b'] }); assert.ok(v.ok, JSON.stringify(v.errors)); assert.ok(v.warnings.some(w => w.path === 'source.approvedBy'));
      assert.deepStrictEqual(validateDepartment({ key: 'x_y', label: 'Empty' }).warnings.map(w => w.path).sort(), ['bundle.items', 'diseases', 'source.approvedBy'], 'an empty department is valid with warnings');
      bad(p => { p.key = 'Bad Key'; }, /key/); bad(p => { p.key = ''; }, /key/); bad(p => { p.label = ''; }, /label/); bad(p => { p.diseases = ['nope']; }, /unknown disease/); bad(p => { p.diseases = ['BAD KEY']; }, /valid disease key/);
      bad(p => { p.scores[0].min = 5; }, /min/); bad(p => { p.scores[0].direction = 'up'; }, /direction/); bad(p => { p.scores.push({ ...p.scores[0] }); }, /used twice/); bad(p => { p.scores[0].cutoffs[0].from = 9; }, /outside the score range/);
      bad(p => { p.scores[0].cutoffs = [{ label: 'a', from: 3 }, { label: 'b', from: 2 }]; }, /go up/); bad(p => { p.measureSet[2].code = 'zzz'; }, /not one of this department's scores/); bad(p => { p.measureSet[0].code = 'abc'; }, /not a LOINC code/);
      bad(p => { p.measureSet[0].kind = 'drug'; }, /kind/); bad(p => { p.measureSet.push({ ...p.measureSet[0] }); }, /listed twice/); bad(p => { p.measureSet[0].system = 'snomed'; }, /loinc/);
      bad(p => { p.bundle.items[0].analytic = 'Drop Table'; }, /catalog id/); bad(p => { p.bundle.items[0].mode = 'v9'; }, /mode/); bad(p => { p.bundle.items.push({ ...p.bundle.items[1] }); }, /listed twice/); bad(p => { p.bundle.items[0].sections = ['ok_one', 'Bad Name']; }, /valid section name/);
      bad(p => { p.episodeModel.admissionShare = 1.5; }, /admissionShare/); bad(p => { p.episodeModel.visitsPerYear = 500; }, /visitsPerYear/); bad(p => { p.scopeFilters = { minAge: 70, maxAge: 20 }; }, /above maxAge/); bad(p => { p.scopeFilters.gender = 'other'; }, /gender/);
      assert.deepStrictEqual(normalizeDepartment(null).diseases, []); assert.strictEqual(normalizeDepartment({ key: ' CARDIO ' }).key, 'cardio'); assert.deepStrictEqual(normalizeDepartment({ diseases: ['A', 'a', ' b '] }).diseases, ['a', 'b']);
      // the API
      const ap = mkApp(), pl = mkPool(); let hits = 0; register(ap, pl, { onChange: () => { hits++; } }); const call = (m, u, o) => callApi(ap, m, u, o);
      for (const k of ['dz_a', 'dz_b']) pl.rows.set(k, { profile: mk(k, k.toUpperCase(), '70000001', { departments: k === 'dz_a' ? ['cardiology'] : [] }), enabled: true, builtin: false, updated_by: 'x', updated_at: new Date() });
      process.env.DISEASE_CODE_CHECK = 'format';
      let r = await call('POST', '/api/departments/validate', { body: { profile: { ...good(), diseases: ['nope'] } } }); assert.deepStrictEqual([r.status, r.body.ok, r.body.errors.length], [200, false, 1]); assert.strictEqual(pl.depts.size, 0, 'validate stores nothing');
      assert.strictEqual((await call('POST', '/api/departments', { body: { profile: { ...good(), diseases: ['nope'] } } })).status, 400); assert.strictEqual((await call('POST', '/api/departments', { body: {} })).status, 400);
      r = await call('POST', '/api/departments', { body: { profile: good() } }); assert.deepStrictEqual([r.status, r.body.department.key, r.body.department.measures, r.body.department.bundleItems, r.body.department.builtin, r.req.auditTarget], [201, 'cardiology', 3, 2, false, 'cardiology'], JSON.stringify(r.body).slice(0, 300));
      assert.deepStrictEqual([pl.depts.get('cardiology').profile.source.version, pl.depts.get('cardiology').updated_by, hits], [1, 'dr@example.org', 1]);
      assert.strictEqual((await call('POST', '/api/departments', { body: { profile: good() } })).status, 409);
      r = await call('GET', '/api/departments'); assert.deepStrictEqual([r.body.count, r.body.departments[0].diseases], [1, ['dz_a', 'dz_b']]); assert.strictEqual((await call('GET', '/api/departments?q=zzz')).body.count, 0); assert.strictEqual((await call('GET', '/api/departments?enabled=false')).body.count, 0);
      r = await call('GET', '/api/departments/cardiology'); assert.deepStrictEqual([r.status, r.body.department.profile.scores[0].key, r.body.department.profile.enabled], [200, 'nyha', true]); assert.strictEqual((await call('GET', '/api/departments/nosuch')).status, 404); assert.strictEqual((await call('GET', '/api/departments/BAD KEY')).status, 400);
      // edit: version goes up, the key cannot change, a bad edit stores nothing, the switch alone keeps the profile
      r = await call('PUT', '/api/departments/cardiology', { body: { profile: { ...good(), label: 'Cardiology and vascular', key: 'cardiology' } } }); assert.deepStrictEqual([r.status, r.body.department.label, pl.depts.get('cardiology').profile.source.version, r.req.auditTarget], [200, 'Cardiology and vascular', 2, 'cardiology']);
      assert.strictEqual((await call('PUT', '/api/departments/cardiology', { body: { profile: { ...good(), key: 'other_key' } } })).status, 400); assert.strictEqual((await call('PUT', '/api/departments/cardiology', { body: { profile: { ...good(), diseases: ['nope'] } } })).status, 400);
      assert.strictEqual(pl.depts.get('cardiology').profile.label, 'Cardiology and vascular'); assert.strictEqual((await call('PUT', '/api/departments/cardiology', { body: {} })).status, 400); assert.strictEqual((await call('PUT', '/api/departments/nosuch', { body: { enabled: false } })).status, 404);
      r = await call('PUT', '/api/departments/cardiology', { body: { enabled: false } }); assert.deepStrictEqual([r.status, r.body.department.enabled, pl.depts.get('cardiology').profile.source.version], [200, false, 2]); assert.strictEqual((await call('GET', '/api/departments?enabled=false')).body.count, 1);
      // built-in: switch only, no edit, no delete
      pl.depts.get('cardiology').builtin = true;
      r = await call('PUT', '/api/departments/cardiology', { body: { profile: good() } }); assert.deepStrictEqual([r.status, r.body.code], [403, 'BUILTIN']); assert.strictEqual((await call('PUT', '/api/departments/cardiology', { body: { enabled: true } })).status, 200);
      r = await call('DELETE', '/api/departments/cardiology'); assert.deepStrictEqual([r.status, r.body.code], [403, 'BUILTIN']); pl.depts.get('cardiology').builtin = false;
      // delete names the diseases that still list the department
      hits = 0; r = await call('DELETE', '/api/departments/cardiology'); assert.deepStrictEqual([r.status, r.body.deleted, r.body.diseasesStillListingIt, pl.depts.size, hits], [200, 'cardiology', ['dz_a'], 0, 1]); assert.strictEqual((await call('DELETE', '/api/departments/cardiology')).status, 404);
      // the disease routes still work next to them, and a department write never touches disease_profiles
      assert.strictEqual((await call('GET', '/api/diseases')).body.count, 2); assert.ok(!pl.log.some(q => /^(INSERT|UPDATE|DELETE).*disease_profiles/.test(q)), 'no disease write');
      delete process.env.DISEASE_CODE_CHECK;
      // chunk 3.2a: the bundle is checked against the catalog when one is available (opts.catalogInfo or app.locals.catalogInfo)
      {
        const all5 = ['v1', 'v2', 'v3', 'v4', 'v5'], cat = { disease_profile: { title: 'Disease profile', modes: all5, sections: [{ name: 'cohort', modes: all5 }, { name: 'control_status', modes: ['v4', 'v5'] }] }, medication_utilization: { title: 'Medication use', modes: ['v1', 'v2'], sections: null } };
        const ci = id => cat[id] || null, run = p => validateDepartment(p, { knownDiseases: ['dz_a', 'dz_b'], catalogInfo: ci });
        const withItems = items => { const p = good(); p.bundle.items = items; return p; }, bundleBad = (items, re) => { const r = run(withItems(items)); assert.ok(!r.ok && r.errors.some(e => re.test(e.message)), re + ' -> ' + JSON.stringify(r.errors)); };
        assert.ok(run(good()).ok, JSON.stringify(run(good()).errors)); assert.ok(run(withItems([{ analytic: 'medication_utilization', sections: ['anything'] }])).ok, 'sections of an analytic that declares none are not checked');
        bundleBad([{ analytic: 'no_such' }], /not in the analytics catalog/); bundleBad([{ analytic: 'medication_utilization', mode: 'v4' }], /no V4 version/); bundleBad([{ analytic: 'disease_profile', sections: ['nosuch'] }], /no section "nosuch"/);
        bundleBad([{ analytic: 'disease_profile', mode: 'v1', sections: ['control_status'] }], /not offered in V1/);
        assert.ok(validateDepartment(withItems([{ analytic: 'no_such' }]), { knownDiseases: ['dz_a', 'dz_b'] }).ok, 'without a catalog only the format is checked');
        const ap2 = mkApp(); ap2.locals = { catalogInfo: ci }; const pl2 = mkPool(); for (const k of ['dz_a', 'dz_b']) pl2.rows.set(k, { profile: mk(k, k, '70000001'), enabled: true, builtin: false, updated_by: 'x', updated_at: new Date() });
        register(ap2, pl2); process.env.DISEASE_CODE_CHECK = 'format';
        let r2 = await callApi(ap2, 'POST', '/api/departments', { body: { profile: withItems([{ analytic: 'no_such' }]) } }); assert.deepStrictEqual([r2.status, /analytics catalog/.test(JSON.stringify(r2.body.errors))], [400, true]);
        r2 = await callApi(ap2, 'POST', '/api/departments/validate', { body: { profile: withItems([{ analytic: 'disease_profile', sections: ['nosuch'] }]) } }); assert.strictEqual(r2.body.ok, false);
        r2 = await callApi(ap2, 'POST', '/api/departments', { body: { profile: good() } }); assert.strictEqual(r2.status, 201, JSON.stringify(r2.body).slice(0, 200));
        r2 = await callApi(ap2, 'PUT', '/api/departments/cardiology', { body: { profile: withItems([{ analytic: 'no_such' }]) } }); assert.strictEqual(r2.status, 400);
        delete process.env.DISEASE_CODE_CHECK;
      }
      // a score measure needs no code lookup; a lab code unknown to every reference is refused unless format-only checking is on
      r = await call('POST', '/api/departments/validate', { body: { profile: { ...good(), measureSet: [{ kind: 'lab', code: '1234-5' }] } } }); assert.deepStrictEqual([r.body.ok, /not found in any reference/.test(JSON.stringify(r.body.errors))], [false, true]);
      r = await call('POST', '/api/departments/validate', { body: { profile: { ...good(), measureSet: [{ kind: 'lab', code: '4548-4' }] } } }); assert.strictEqual(r.body.ok, true, JSON.stringify(r.body.errors));
    }

    // plan chunk 3.5a: the B1 department library (cardiology, endocrinology, nephrology, pulmonology)
    {
      let catalog = null; try { catalog = require('./analytics').catalogInfo; } catch (e) { /* analytics.js needs its own modules: without it only the format is checked */ }
      const libDz = [...seedProfiles(), ...libraryProfiles(1), ...libraryProfiles(2)], keys = libDz.map(p => p.key), libs = libraryDepartments(1);
      assert.deepStrictEqual(libs.map(d => d.key), ['cardiology', 'endocrinology', 'nephrology', 'pulmonology']); assert.deepStrictEqual(libraryDepartments(2), []);
      for (const d of libs) {
        const r = checkDepartment(d, { knownDiseases: keys, catalogInfo: catalog || undefined, codeExists: (sy, c) => BUNDLED.has(sy + '|' + c) });
        assert.ok(r.ok, d.key + ': ' + JSON.stringify(r.errors)); assert.ok(!r.warnings.some(w => w.path !== 'source.approvedBy'), d.key + ' warnings: ' + JSON.stringify(r.warnings));
        assert.ok(d.diseases.length >= 1 && d.measureSet.length >= 2 && d.bundle.items.length >= 6, d.key + ' has diseases, measures and a bundle'); assert.ok(d.bundle.items.some(i => i.analytic === 'disease_profile'), d.key + ' has the generic disease sections');
        assert.ok(/NEEDS CLINICIAN REVIEW/.test(d.source.note) && !d.source.approvedBy, d.key + ' is marked for review');
        // every disease the department lists names it, or is one it is built around (the Diseases tab filters by either link)
        for (const k of d.diseases) assert.ok(keys.includes(k), d.key + ' lists a disease with a profile: ' + k);
      }
      for (const d of libs.filter(x => x.key !== 'nephrology')) for (const p of libDz.filter(x => (x.departments || []).includes(d.key))) assert.ok(d.diseases.includes(p.key), d.key + ' lists ' + p.key + ' (which names the department)');
      const ap3 = mkApp(); if (catalog) ap3.locals = { catalogInfo: catalog }; const pl3 = mkPool(); for (const p of libDz) pl3.rows.set(p.key, { profile: p, enabled: true, builtin: false, updated_by: 'x', updated_at: new Date() });
      register(ap3, pl3);
      let q = await callApi(ap3, 'POST', '/api/departments/install-library', { body: { dryRun: true } }); assert.deepStrictEqual([q.status, q.body.counts, pl3.depts.size], [200, { would_create: 4 }, 0]);
      q = await callApi(ap3, 'POST', '/api/departments/install-library', { body: { keys: ['pulmonology', 'nosuch'] } }); assert.deepStrictEqual([q.status, q.body.counts, [...pl3.depts.keys()]], [200, { created: 1 }, ['pulmonology']]); assert.strictEqual(q.req.auditTarget === undefined || typeof q.req.auditTarget === 'string', true);
      q = await callApi(ap3, 'POST', '/api/departments/install-library', { body: {} }); assert.deepStrictEqual([q.status, q.body.counts, pl3.depts.size], [200, { skipped_exists: 1, created: 3 }, 4]);
      assert.ok(q.body.results.every(x => x.status === 'skipped_exists' || (x.missingDiseases.length === 0 && x.diseases >= 1)), JSON.stringify(q.body.results));
      assert.deepStrictEqual([...pl3.depts.keys()].sort(), ['cardiology', 'endocrinology', 'nephrology', 'pulmonology']); assert.ok([...pl3.depts.values()].every(v => v.builtin === false && v.profile.source.updatedBy !== undefined), 'stored editable, stamped');
      q = await callApi(ap3, 'POST', '/api/departments/install-library', { body: {} }); assert.deepStrictEqual([q.body.counts, pl3.depts.size], [{ skipped_exists: 4 }, 4]);
      // a database without the disease profiles still installs: the missing diseases are dropped and named
      const ap4 = mkApp(); if (catalog) ap4.locals = { catalogInfo: catalog }; const pl4 = mkPool(); pl4.rows.set('hypertension', { profile: libDz.find(p => p.key === 'hypertension'), enabled: true, builtin: false, updated_by: 'x', updated_at: new Date() }); register(ap4, pl4);
      q = await callApi(ap4, 'POST', '/api/departments/install-library', { body: { keys: ['cardiology'] } }); assert.deepStrictEqual([q.body.counts, q.body.results[0].diseases, q.body.results[0].missingDiseases], [{ created: 1 }, 1, ['hypercholesterolaemia']]);
      console.log('  department library: ' + (catalog ? 'bundles checked against the real catalog' : 'catalog not loadable here, format only'));
    }

    // plan chunk 2.3: review sheet and ground-truth report
    {
      const sheet = reviewSheet([...libraryProfiles(1), ...libraryProfiles(2)]);
      assert.strictEqual(sheet.length, 11); assert.ok(sheet.every(r => r.review_status === 'needs clinician review' && REVIEW_COLUMNS.every(c => c in r) && r.reviewer === '' && r.decision === ''), 'library profiles are not approved; reviewer columns are empty');
      const gout = sheet.find(r => r.key === 'gout'); assert.ok(/uric acid/i.test(gout.control_measure) && gout.control_goal === 'below 6 mg/dL' && /allopurinol/.test(gout.treatment) && /hypertension/.test(gout.links), JSON.stringify(gout));
      assert.strictEqual(sheet.find(r => r.key === 'hypothyroidism').control_goal, 'inside 0.4 to 4 m[IU]/L'); assert.strictEqual(sheet.find(r => r.key === 'gerd').control_goal, 'none');
      const ap = { ...libraryProfiles(1)[0], label: '=HYPERLINK("x")', source: { note: 'a, "quoted"\nline', approvedBy: 'Dr A' } }, row = reviewSheet([ap])[0];
      assert.strictEqual(row.review_status, 'approved'); const csv = reviewSheetCsv([row]).split('\r\n');
      assert.strictEqual(csv[0], REVIEW_COLUMNS.join(',')); assert.ok(csv[1].includes(`"'=HYPERLINK(""x"")"`) || csv[1].includes(`'=HYPERLINK(""x"")`), 'formula guarded and quoted: ' + csv[1].slice(0, 80)); assert.ok(reviewSheetCsv([row]).includes('"a, ""quoted""\nline"'));
      assert.deepStrictEqual(reviewSheet(null), []);
      // the route (before /:key): json, csv, a named key, an unknown key
      const app = mkApp(), pl = mkPool(); register(app, pl); const call = (m, u, o) => callApi(app, m, u, o);
      pl.rows.set('rs_a', { profile: mk('rs_a', 'Rs A', '70000011'), enabled: true, builtin: false, updated_by: 'x', updated_at: new Date() }); pl.rows.set('rs_b', { profile: mk('rs_b', 'Rs B', '70000012'), enabled: true, builtin: true, updated_by: 'x', updated_at: new Date() });
      let r = await call('GET', '/api/diseases/review-sheet'); assert.deepStrictEqual([r.status, r.body.count, r.body.rows.map(x => x.key), r.body.columns.length], [200, 2, ['rs_a', 'rs_b'], REVIEW_COLUMNS.length]);
      r = await call('GET', '/api/diseases/review-sheet?builtin=false'); assert.deepStrictEqual(r.body.rows.map(x => x.key), ['rs_a']);
      r = await call('GET', '/api/diseases/review-sheet?keys=rs_b&format=csv'); assert.ok(r.status === 200 && typeof r.body === 'string' && r.body.split('\r\n')[1].startsWith('rs_b,') && /attachment/.test(r.headers['Content-Disposition']), String(r.body).slice(0, 80));
      assert.strictEqual((await call('GET', '/api/diseases/review-sheet?keys=nosuch')).status, 404);
      // ground truth: every library profile agrees with its own records; a built-in has nothing to compare
      const S = require('./synthetic'), all = [...seedProfiles(), ...libraryProfiles(1), ...libraryProfiles(2)].map(p => ({ ...p, enabled: true }));
      const out = S.generateBundle({ count: 500, seed: 7, years: 5, endDate: '2026-10-01', profiles: all });
      for (const p of all) {
        const t = truthReport(p, out, 500);
        if (['diabetes', 'hypertension'].includes(p.key)) { assert.deepStrictEqual([t.ok, t.withDisease, t.checks.length], [null, 0, 0], 'built-in: nothing to compare'); continue; }
        assert.ok(t.ok === true && t.withDisease > 0, p.key + ': ' + JSON.stringify(t.checks.filter(c => !c.ok)).slice(0, 300) + ' ' + t.withDisease);
        assert.strictEqual(t.checks.length, p.control ? 6 : 3, p.key + ': the control checks only when the profile has a control measure');
      }
      // the report is not a rubber stamp: tamper with the records and it must say so
      const clone = o => ({ ...o, bundle: { ...o.bundle, entry: o.bundle.entry.map(e => ({ ...e })) } }), chol = all.find(p => p.key === 'hypercholesterolaemia');
      const t1 = clone(out); t1.bundle.entry = t1.bundle.entry.map(e => (e.resource.resourceType === 'Observation' && /-dz-ob-hypercholesterolaemia-/.test(e.resource.id) ? { ...e, resource: { ...e.resource, valueQuantity: { ...e.resource.valueQuantity, value: 1e6 } } } : e));
      let t = truthReport(chol, t1, 500); assert.ok(t.ok === false && t.checks.some(c => /differs/.test(c.name) && !c.ok) && t.differences.length > 0 && t.differences[0].why, 'control values moved to the wrong side are caught');
      const t2 = clone(out); let dropped = false; t2.bundle.entry = t2.bundle.entry.filter(e => { if (!dropped && /-dz-hypercholesterolaemia-\d+$/.test(e.resource.id)) { dropped = true; return false; } return true; });
      t = truthReport(chol, t2, 500); assert.ok(t.ok === false && t.checks[0].difference === -1, 'a missing condition record is caught');
      assert.strictEqual(truthReport(chol, { ...out, groundTruth: [] }, 500).note, 'No patient has the disease in this sample: raise the count.');
      // the route runs the generator for a saved profile and answers with the report
      pl.ref.snomed_dictionary.add('70000011'); pl.ref.snomed_dictionary.add('70000012');
      r = await call('POST', '/api/diseases/rs_a/truth-report', { body: { count: 200, seed: 3 } }); assert.deepStrictEqual([r.status, r.body.key, r.body.sample.patients, r.body.skipped, r.body.report.ok], [200, 'rs_a', 200, null, true], JSON.stringify(r.body).slice(0, 300));
      assert.strictEqual((await call('POST', '/api/diseases/nosuch/truth-report', { body: {} })).status, 404); assert.strictEqual((await call('POST', '/api/diseases/BAD KEY/truth-report', { body: {} })).status, 400);
    }

    // the onChange hook runs after create, edit and delete, and a failing hook never fails the write
    let hits = 0; const app3 = mkApp(), pool3 = mkPool(); register(app3, pool3, { onChange: () => { hits++; throw new Error('hook'); } });
    r = await callApi(app3, 'POST', '/api/diseases', { body: { profile: mk('gout', 'Gout', '70000001') } }); assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    r = await callApi(app3, 'PUT', '/api/diseases/gout', { body: { enabled: false } }); assert.strictEqual(r.status, 200);
    r = await callApi(app3, 'DELETE', '/api/diseases/gout'); assert.strictEqual(r.status, 200);
    assert.strictEqual(hits, 3, 'onChange called ' + hits + ' times');

    if (oldCheck !== undefined) process.env.DISEASE_CODE_CHECK = oldCheck;
    console.log('diseases.js self-test: all checks passed');
  })().catch(e => { console.error(e); process.exit(1); });
}
