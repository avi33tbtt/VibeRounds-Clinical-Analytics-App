/*
 * patterns.js - Vibe Rounds pattern encyclopedia
 *
 * Chunk 1: spec shape, validator, normalizer and self-test (pure functions).
 * Chunk 2: pattern store (tables patterns, pattern_history, pattern_runs) and routes
 *          GET/POST /api/patterns, GET/PUT /api/patterns/:id.
 * Chunk 3: resolveValueSets (is-a expansion), buildSql (spec -> one parameterized statement), explainReasons.
 * Chunk 4: run endpoint POST /api/patterns/:id/run (active cohort, counts with min-cell hiding, reasons, matches, saved run),
 *          GET /api/patterns/:id/runs, POST /api/patterns/seed (three seed patterns), and the discharge anchor
 *          (from: "end") for return_within_days.
 * Chunk 5: run labels (reliability: thin, gappy, weak_hierarchy), evidence_mix and plain epistemic copy in every run result.
 * Chunk 8: review flow (draft, reviewed, active, retired), certainty control, history with status columns, audit details.
 *          POST /api/patterns/:id/status and /certainty; only a user with the permission patterns:review (security.js) may use them.
 * Chunk 9: create from one case. abstractCase (only domain, code, day offsets, age band; no id, name, address, date or text), draftFromCase,
 *          POST /api/patterns/from-case (reads one patient of the active cohort, returns a DRAFT, saves nothing, flags rare sequences).
 *          Model wording is off unless PATTERN_CASE_MODEL_WORDING=true and helpers.wordCase is wired (chunk 12).
 * Chunk 10: create from a few cases. mineCases (codes shared by max(min-cell, half) of the patients, usual order, longest gap; groups under the min-cell
 *          are refused) and POST /api/patterns/from-cases (patient_ids in the active cohort, returns a DRAFT, saves nothing, no model).
 * Chunk 11: import and export. GET /api/patterns/export (reviewed and active by default; registered before /:id), POST /api/patterns/import
 *          (file checksum, every pattern re-validated, arrives as a draft at hypothesis). makeBundle, checkBundle, asImportedDraft.
 * Later chunks add the AI draft (12) and so on in this file.
 *
 * Wiring (analytics.js register):  require('./patterns')(app, pool, { fail, readPool, engine, scopeOf });
 *   pool is the OWNER pool: the pattern tables are written with it. Runs query through readPool (read-only transaction).
 * Exports: the register function itself, with validate, normalize, constants, selftest attached.
 * Run the self-test:  node patterns.js --selftest   (no database, no network)
 *
 * A spec is plain JSON. It may only use the vocabulary below. Anything else is rejected.
 * No model text ever reaches SQL: the executor (chunk 3) builds SQL from the validated
 * fields only, and every value is a parameter.
 */
'use strict';

const SPEC_VERSION = 1;

// ---------- vocabulary ----------
const STATUSES = ['draft', 'reviewed', 'active', 'retired'];
const SOURCE_KINDS = ['one_case', 'few_cases', 'library'];
const CERTAINTY = ['established', 'supported', 'hypothesis', 'contested'];
const BASIS = ['guideline', 'literature', 'expert', 'observed_in_data', 'model_suggested'];
const CLAIM = ['descriptive', 'association', 'causal'];
const EVIDENCE = ['documented', 'derived', 'inferred'];
const MODES = ['exact', 'descendants'];

// domain -> view name and the date column the views already have (see analytics.js)
const DOMAINS = {
  dx: { date: 'onset_date', hasValue: false },
  rx: { date: 'prescribed_date', hasValue: false },
  ob: { date: 'effective_date', hasValue: true },
  pr: { date: 'performed_date', hasValue: false },
  en: { date: 'start_date', hasValue: false }, // codes are encounter classes (cls)
  im: { date: 'occurrence_date', hasValue: false },
  al: { date: null, hasValue: false },         // no date column known: cannot be used in time relations
};
const NO_DESCENDANTS = ['en']; // classes have no is-a links

const PICKS_SIMPLE = ['first', 'last', 'any'];
const PICK_AFTER = /^first_on_or_after:([a-z][a-z0-9_]{0,23})$/;

const VALUE_OPS = ['lt', 'lte', 'gt', 'gte', 'eq'];

// Fixed relation list. Each entry says which fields it takes and how to check them.
// kinds: ref = "alias.date", ev = event alias, range = [min,max] days, int/num = bounded number
const RELATIONS = {
  within_days:          { a: 'ref', of: 'ref', range: 'range' },
  before:               { a: 'ref', b: 'ref' },
  after:                { a: 'ref', b: 'ref' },
  none_in_window:       { event: 'ev', after: 'ref', range: 'range' },
  no_refill:            { event: 'ev', supply_days: ['int', 1, 365], grace_days: ['int', 0, 365] },
  return_within_days:   { event: 'ev', of: 'ref', days: ['int', 1, 365], from: 'from?' },   // from: "start" (default) or "end" (discharge, encounters only)
  latest_value_in_window: { event: 'ev', of: 'ref', range: 'range', op: 'op', value: ['num', -1e9, 1e9] },
  count_at_least:       { event: 'ev', count: ['int', 1, 1000], of: 'ref?', range: 'range?' },
};

const LIMITS = {
  maxValuesets: 20, maxEvents: 10, maxWhen: 12, maxCodes: 200, maxTags: 10,
  maxPlain: 600, maxNote: 500, maxDays: 3650, maxId: 64,
};

const ID_RE = /^[a-z][a-z0-9_]{1,63}$/;
const ALIAS_RE = /^[a-z][a-z0-9_]{0,23}$/;
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-|]{0,39}$/;
const TAG_RE = /^[a-z0-9][a-z0-9_\-]{0,23}$/;
const REF_RE = /^([a-z][a-z0-9_]{0,23})\.(date|value)$/;

const TOP_KEYS = ['id', 'plain', 'source', 'status', 'valuesets', 'events', 'when',
  'epistemic', 'needs', 'min_evidence', 'spec_version'];

// ---------- helpers ----------
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clean = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();

function checkRange(v, path, err) {
  if (!Array.isArray(v) || v.length !== 2 || !isInt(v[0]) || !isInt(v[1])) {
    err(path, 'range must be [min, max] whole days'); return false;
  }
  if (v[0] < 0 || v[1] > LIMITS.maxDays || v[0] > v[1]) {
    err(path, 'range must satisfy 0 <= min <= max <= ' + LIMITS.maxDays); return false;
  }
  return true;
}

/**
 * validate(input, opts) -> { ok, errors: [{path, message}], spec }
 * opts.reviewer: true when a reviewer is saving. Only then may certainty be above
 *   "hypothesis" ("contested" is also allowed for non-reviewers, since it lowers trust).
 * spec is the normalized copy and is only set when ok is true.
 * The input is never changed.
 */
function validate(input, opts) {
  opts = opts || {};
  const errors = [];
  const err = (path, message) => errors.push({ path, message });

  if (!isObj(input)) return { ok: false, errors: [{ path: '', message: 'spec must be an object' }], spec: null };

  for (const k of Object.keys(input)) {
    if (!TOP_KEYS.includes(k)) err(k, 'unknown field');
  }

  // id, plain
  if (typeof input.id !== 'string' || !ID_RE.test(input.id)) err('id', 'id must match ' + ID_RE);
  if (typeof input.plain !== 'string' || !clean(input.plain)) err('plain', 'plain-English statement is required');
  else if (clean(input.plain).length > LIMITS.maxPlain) err('plain', 'plain text longer than ' + LIMITS.maxPlain);

  // spec_version, status, min_evidence
  if (own(input, 'spec_version') && input.spec_version !== SPEC_VERSION) err('spec_version', 'unsupported spec_version (expected ' + SPEC_VERSION + ')');
  if (own(input, 'status') && !STATUSES.includes(input.status)) err('status', 'status must be one of ' + STATUSES.join(', '));
  if (own(input, 'min_evidence') && !EVIDENCE.includes(input.min_evidence)) err('min_evidence', 'min_evidence must be one of ' + EVIDENCE.join(', '));

  // source
  const src = input.source;
  let sourceKind = null, fromModel = false;
  if (!isObj(src)) err('source', 'source is required');
  else {
    if (!SOURCE_KINDS.includes(src.kind)) err('source.kind', 'kind must be one of ' + SOURCE_KINDS.join(', '));
    else sourceKind = src.kind;
    if (own(src, 'n') && !(isInt(src.n) && src.n >= 1 && src.n <= 1e6)) err('source.n', 'n must be a whole number >= 1');
    for (const k of ['model', 'prompt_version']) {
      if (own(src, k) && !(typeof src[k] === 'string' && src[k].length <= 80)) err('source.' + k, k + ' must be a short string');
    }
    for (const k of Object.keys(src)) if (!['kind', 'n', 'model', 'prompt_version'].includes(k)) err('source.' + k, 'unknown field');
    fromModel = typeof src.model === 'string' && src.model.length > 0;
  }

  // valuesets
  const vsNames = new Set();
  const vsDomain = {};
  if (!isObj(input.valuesets) || Object.keys(input.valuesets).length === 0) err('valuesets', 'at least one value set is required');
  else {
    const names = Object.keys(input.valuesets);
    if (names.length > LIMITS.maxValuesets) err('valuesets', 'at most ' + LIMITS.maxValuesets + ' value sets');
    for (const name of names) {
      const p = 'valuesets.' + name, vs = input.valuesets[name];
      if (!ALIAS_RE.test(name)) { err(p, 'value set name must match ' + ALIAS_RE); continue; }
      if (!isObj(vs)) { err(p, 'value set must be an object'); continue; }
      for (const k of Object.keys(vs)) if (!['domain', 'codes', 'mode'].includes(k)) err(p + '.' + k, 'unknown field');
      if (!own(DOMAINS, vs.domain)) err(p + '.domain', 'domain must be one of ' + Object.keys(DOMAINS).join(', '));
      if (!MODES.includes(vs.mode)) err(p + '.mode', 'mode must be one of ' + MODES.join(', '));
      else if (vs.mode === 'descendants' && NO_DESCENDANTS.includes(vs.domain)) err(p + '.mode', 'domain ' + vs.domain + ' has no hierarchy; use exact');
      if (!Array.isArray(vs.codes) || vs.codes.length === 0) err(p + '.codes', 'codes must be a non-empty list');
      else if (vs.codes.length > LIMITS.maxCodes) err(p + '.codes', 'at most ' + LIMITS.maxCodes + ' codes');
      else vs.codes.forEach((c, i) => {
        if (typeof c !== 'string' || !CODE_RE.test(c)) err(p + '.codes[' + i + ']', 'invalid code format');
      });
      vsNames.add(name);
      if (own(DOMAINS, vs.domain)) vsDomain[name] = vs.domain;
    }
  }

  // events
  const evDomain = {};   // alias -> domain
  const evIndex = {};    // alias -> position
  const evPick = {};     // alias -> pick
  if (!Array.isArray(input.events) || input.events.length === 0) err('events', 'at least one event is required');
  else {
    if (input.events.length > LIMITS.maxEvents) err('events', 'at most ' + LIMITS.maxEvents + ' events');
    input.events.forEach((ev, i) => {
      const p = 'events[' + i + ']';
      if (!isObj(ev)) { err(p, 'event must be an object'); return; }
      for (const k of Object.keys(ev)) if (!['as', 'valueset', 'pick'].includes(k)) err(p + '.' + k, 'unknown field');
      if (typeof ev.as !== 'string' || !ALIAS_RE.test(ev.as)) err(p + '.as', 'alias must match ' + ALIAS_RE);
      else if (own(evIndex, ev.as)) err(p + '.as', 'duplicate event alias "' + ev.as + '"');
      if (typeof ev.valueset !== 'string' || !vsNames.has(ev.valueset)) err(p + '.valueset', 'unknown value set');
      if (typeof ev.pick !== 'string') err(p + '.pick', 'pick is required');
      else if (!PICKS_SIMPLE.includes(ev.pick)) {
        const m = PICK_AFTER.exec(ev.pick);
        if (!m) err(p + '.pick', 'pick must be first, last, any or first_on_or_after:<earlier alias>');
        else if (!own(evIndex, m[1])) err(p + '.pick', 'first_on_or_after needs an earlier event alias, "' + m[1] + '" is not defined before this event');
      }
      if (typeof ev.as === 'string' && ALIAS_RE.test(ev.as) && !own(evIndex, ev.as)) {
        evIndex[ev.as] = i;
        evPick[ev.as] = ev.pick;
        if (typeof ev.valueset === 'string' && own(vsDomain, ev.valueset)) evDomain[ev.as] = vsDomain[ev.valueset];
      }
    });
  }

  // reference helpers (need event aliases)
  const refOk = (v, path, needValue, allowAny) => {
    if (typeof v !== 'string') { err(path, 'reference must be a string like "dx.date"'); return false; }
    const m = REF_RE.exec(v);
    if (!m) { err(path, 'reference must look like alias.date or alias.value'); return false; }
    if (!own(evDomain, m[1])) { err(path, 'unknown event "' + m[1] + '"'); return false; }
    const d = DOMAINS[evDomain[m[1]]];
    if (!allowAny && evPick[m[1]] === 'any') { err(path, 'event "' + m[1] + '" uses pick "any" and has no single date; use first, last or first_on_or_after'); return false; }
    if (m[2] === 'date' && !d.date) { err(path, 'domain ' + evDomain[m[1]] + ' has no date column'); return false; }
    if (m[2] === 'value' && !d.hasValue) { err(path, 'domain ' + evDomain[m[1]] + ' has no value'); return false; }
    if (needValue && m[2] !== 'value') { err(path, 'a value reference is required here'); return false; }
    return true;
  };
  const evOk = (v, path) => {
    if (typeof v !== 'string' || !own(evDomain, v)) { err(path, 'unknown event alias'); return false; }
    return true;
  };

  // when
  const usedEvidence = [];
  if (!Array.isArray(input.when)) err('when', 'when must be a list (it may be empty)');
  else {
    if (input.when.length > LIMITS.maxWhen) err('when', 'at most ' + LIMITS.maxWhen + ' time relations');
    input.when.forEach((w, i) => {
      const p = 'when[' + i + ']';
      if (!isObj(w)) { err(p, 'relation must be an object'); return; }
      if (typeof w.rel !== 'string' || !own(RELATIONS, w.rel)) {
        err(p + '.rel', 'unknown relation (allowed: ' + Object.keys(RELATIONS).join(', ') + ')'); return;
      }
      const def = RELATIONS[w.rel];
      for (const k of Object.keys(w)) if (k !== 'rel' && !own(def, k)) err(p + '.' + k, 'field not allowed for ' + w.rel);
      for (const f of Object.keys(def)) {
        const kind = def[f];
        const optional = typeof kind === 'string' && kind.endsWith('?');
        if (!own(w, f)) { if (!optional) err(p + '.' + f, 'required for ' + w.rel); continue; }
        const fp = p + '.' + f, v = w[f];
        if (kind === 'ref' || kind === 'ref?') refOk(v, fp, false);
        else if (kind === 'ev') evOk(v, fp);
        else if (kind === 'range' || kind === 'range?') checkRange(v, fp, err);
        else if (kind === 'op') { if (!VALUE_OPS.includes(v)) err(fp, 'op must be one of ' + VALUE_OPS.join(', ')); }
        else if (kind === 'from?') { if (v !== 'start' && v !== 'end') err(fp, 'from must be "start" or "end"'); }
        else if (Array.isArray(kind)) {
          const [t, lo, hi] = kind;
          const okType = t === 'int' ? isInt(v) : isNum(v);
          if (!okType) err(fp, 'must be a ' + (t === 'int' ? 'whole number' : 'number'));
          else if (v < lo || v > hi) err(fp, 'must be between ' + lo + ' and ' + hi);
        }
      }
      // pairing rules
      if (own(w, 'of') !== own(w, 'range') && w.rel === 'count_at_least') err(p, 'count_at_least needs both of and range, or neither');
      if (w.rel === 'return_within_days' && w.from === 'end') {
        const m = typeof w.of === 'string' ? REF_RE.exec(w.of) : null;
        if (!m || !own(evDomain, m[1]) || evDomain[m[1]] !== 'en') err(p + '.from', 'from "end" needs the anchor to be an encounter (en) event, which has a discharge date');
      }
      if (w.rel === 'latest_value_in_window' && typeof w.event === 'string' && own(evDomain, w.event) && !DOMAINS[evDomain[w.event]].hasValue) {
        err(p + '.event', 'latest_value_in_window needs an observation (ob) event');
      }
      if (w.rel === 'no_refill' && typeof w.event === 'string' && own(evDomain, w.event) && evDomain[w.event] !== 'rx') {
        err(p + '.event', 'no_refill needs a medication (rx) event');
      }
      if (w.rel === 'no_refill' && typeof w.event === 'string' && evPick[w.event] === 'any') {
        err(p + '.event', 'no_refill needs an event with pick first, last or first_on_or_after (it anchors on one fill)');
      }
      if (w.rel === 'no_refill') usedEvidence.push('derived');
    });
  }

  // needs
  if (own(input, 'needs')) {
    if (!Array.isArray(input.needs)) err('needs', 'needs must be a list');
    else input.needs.forEach((n, i) => refOk(n, 'needs[' + i + ']', false, true));
  }

  // epistemic
  const ep = input.epistemic;
  let certainty = null, basis = null, claim = null;
  if (own(input, 'epistemic') && !isObj(ep)) err('epistemic', 'epistemic must be an object');
  else {
    const e = ep || {};
    for (const k of Object.keys(e)) if (!['certainty', 'basis', 'claim', 'note', 'tags'].includes(k)) err('epistemic.' + k, 'unknown field');
    // defaults match normalize()
    certainty = own(e, 'certainty') ? e.certainty : 'hypothesis';
    basis = own(e, 'basis') ? e.basis : defaultBasis(sourceKind, fromModel);
    claim = own(e, 'claim') ? e.claim : 'descriptive';
    if (!CERTAINTY.includes(certainty)) { err('epistemic.certainty', 'certainty must be one of ' + CERTAINTY.join(', ')); certainty = null; }
    if (!BASIS.includes(basis)) { err('epistemic.basis', 'basis must be one of ' + BASIS.join(', ')); basis = null; }
    if (!CLAIM.includes(claim)) { err('epistemic.claim', 'claim must be one of ' + CLAIM.join(', ')); claim = null; }
    const note = own(e, 'note') ? e.note : '';
    if (typeof note !== 'string' || note.length > LIMITS.maxNote) err('epistemic.note', 'note must be text up to ' + LIMITS.maxNote + ' characters');
    const hasNote = typeof note === 'string' && clean(note).length > 0;
    if (own(e, 'tags')) {
      if (!Array.isArray(e.tags) || e.tags.length > LIMITS.maxTags) err('epistemic.tags', 'tags must be a list of at most ' + LIMITS.maxTags);
      else e.tags.forEach((t, i) => { if (typeof t !== 'string' || !TAG_RE.test(t.toLowerCase())) err('epistemic.tags[' + i + ']', 'tag must be short lowercase text'); });
    }

    // rule 1: model drafts and patterns mined from cases start at hypothesis; only a reviewer raises it
    if (certainty && certainty !== 'hypothesis' && certainty !== 'contested' && !opts.reviewer) {
      err('epistemic.certainty', 'only a reviewer can set certainty above hypothesis');
    }
    // rule 1b: a model-suggested basis cannot carry established or supported (reviewer must change the basis first)
    if ((certainty === 'established' || certainty === 'supported') && (basis === 'model_suggested' || fromModel && basis === null)) {
      err('epistemic.basis', 'model_suggested basis cannot support ' + certainty + '; a reviewer must record the real basis');
    }
    // rule 2: established and supported need a source note; contested needs a note on the disagreement
    if ((certainty === 'established' || certainty === 'supported') && !hasNote) {
      err('epistemic.note', certainty + ' needs a source note (guideline name or citation)');
    }
    if (certainty === 'contested' && !hasNote) err('epistemic.note', 'contested needs a note describing the disagreement');
    // rule 3: causal needs at least supported
    if (claim === 'causal' && certainty && certainty !== 'established' && certainty !== 'supported') {
      err('epistemic.claim', 'a causal claim needs certainty of at least supported; use association instead');
    }
  }

  if (errors.length) return { ok: false, errors, spec: null };
  const spec = normalize(input);
  return { ok: true, errors: [], spec };
}

function defaultBasis(kind, fromModel) {
  if (fromModel) return 'model_suggested';
  if (kind === 'one_case' || kind === 'few_cases') return 'observed_in_data';
  return 'expert';
}

/**
 * normalize(input) -> new object with defaults filled and text cleaned.
 * Call only on input that passed validate(); validate() does this for you.
 * Idempotent: normalize(normalize(x)) deep-equals normalize(x).
 */
function normalize(input) {
  const src = input.source || {};
  const fromModel = typeof src.model === 'string' && src.model.length > 0;
  const e = isObj(input.epistemic) ? input.epistemic : {};

  const valuesets = {};
  for (const name of Object.keys(input.valuesets).sort()) {
    const vs = input.valuesets[name];
    valuesets[name] = { domain: vs.domain, codes: Array.from(new Set(vs.codes.map((c) => c.trim()))), mode: vs.mode };
  }

  const events = input.events.map((ev) => ({ as: ev.as, valueset: ev.valueset, pick: ev.pick }));
  const when = input.when.map((w) => {
    const o = { rel: w.rel };
    for (const f of Object.keys(RELATIONS[w.rel])) if (own(w, f)) o[f] = Array.isArray(w[f]) ? w[f].slice() : w[f];
    return o;
  });

  // needs: keep the given ones and add every date or value the spec reads
  const needs = new Set(Array.isArray(input.needs) ? input.needs : []);
  const evDomain = {};
  events.forEach((ev) => { evDomain[ev.as] = valuesets[ev.valueset].domain; });
  const addDate = (alias) => { if (DOMAINS[evDomain[alias]].date) needs.add(alias + '.date'); };
  const addRef = (r) => { if (typeof r === 'string') { const m = REF_RE.exec(r); if (m) needs.add(r); } };
  events.forEach((ev) => { if (ev.pick !== 'any') addDate(ev.as); });
  when.forEach((w) => {
    for (const f of ['a', 'b', 'of', 'after']) addRef(w[f]);
    if (w.rel === 'latest_value_in_window') needs.add(w.event + '.value');
  });

  return {
    id: input.id,
    plain: clean(input.plain),
    source: Object.assign({ kind: src.kind }, own(src, 'n') ? { n: src.n } : {},
      fromModel ? { model: src.model } : {}, own(src, 'prompt_version') ? { prompt_version: src.prompt_version } : {}),
    status: input.status || 'draft',
    valuesets,
    events,
    when,
    epistemic: {
      certainty: own(e, 'certainty') ? e.certainty : 'hypothesis',
      basis: own(e, 'basis') ? e.basis : defaultBasis(src.kind, fromModel),
      claim: own(e, 'claim') ? e.claim : 'descriptive',
      note: typeof e.note === 'string' ? clean(e.note) : '',
      tags: Array.from(new Set((Array.isArray(e.tags) ? e.tags : []).map((t) => t.toLowerCase()))),
    },
    needs: Array.from(needs).sort(),
    min_evidence: input.min_evidence || 'documented',
    spec_version: SPEC_VERSION,
  };
}

// ---------- store and routes (chunk 2) ----------
const PATTERN_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS patterns (
  id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewed','active','retired')),
  plain text NOT NULL,
  spec jsonb NOT NULL,
  certainty text NOT NULL,
  basis text NOT NULL,
  claim text NOT NULL,
  source_kind text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pattern_history (
  id bigserial PRIMARY KEY,
  pattern_id text NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by text,
  action text NOT NULL,
  from_certainty text,
  to_certainty text,
  note text,
  spec jsonb,
  from_status text,
  to_status text
);
ALTER TABLE pattern_history ADD COLUMN IF NOT EXISTS from_status text;
ALTER TABLE pattern_history ADD COLUMN IF NOT EXISTS to_status text;
CREATE INDEX IF NOT EXISTS pattern_history_pattern_idx ON pattern_history (pattern_id, id DESC);
CREATE TABLE IF NOT EXISTS pattern_runs (
  id bigserial PRIMARY KEY,
  pattern_id text NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
  spec_version integer NOT NULL,
  run_at timestamptz NOT NULL DEFAULT now(),
  run_by text,
  scope jsonb,
  result jsonb
);`;

const LIST_SQL = 'SELECT id, plain, status, certainty, basis, claim, source_kind, version, created_by, created_at, updated_by, updated_at FROM patterns';
const INSERT_SQL = `INSERT INTO patterns (id, status, plain, spec, certainty, basis, claim, source_kind, created_by, updated_by)
  VALUES ($1, 'draft', $2, $3::jsonb, $4, $5, $6, $7, $8, $8) ON CONFLICT (id) DO NOTHING RETURNING *`;
const UPDATE_SQL = `UPDATE patterns SET plain = $2, spec = $3::jsonb, certainty = $4, basis = $5, claim = $6, source_kind = $7,
  updated_by = $8, updated_at = now(), version = version + 1 WHERE id = $1 RETURNING *`;
const STATUS_UPDATE_SQL = `UPDATE patterns SET status = $2, spec = $3::jsonb, certainty = $4, claim = $5,
  updated_by = $6, updated_at = now(), version = version + $7::int WHERE id = $1 RETURNING *`;
const HISTORY_INSERT_SQL = `INSERT INTO pattern_history (pattern_id, action, changed_by, from_certainty, to_certainty, note, spec, from_status, to_status)
  VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`;
const HISTORY_LIST_SQL = 'SELECT id, changed_at, changed_by, action, from_status, to_status, from_certainty, to_certainty, note FROM pattern_history WHERE pattern_id = $1 ORDER BY id DESC LIMIT 50';

const apiError = (status, message, extra) => Object.assign(new Error(message), { status }, extra || {});

async function tx(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* keep the original error */ }
    throw e;
  } finally { c.release(); }
}

// ---------- review flow (chunk 8) ----------
// Status moves only along these arrows, and only a reviewer moves it. Edits to the logic are possible only in draft.
const TRANSITIONS = {
  draft: ['reviewed', 'retired'],
  reviewed: ['active', 'draft', 'retired'],
  active: ['reviewed', 'retired'],
  retired: ['draft'],
};
const canTransition = (from, to) => Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
const RAISED = ['supported', 'established'];            // certainty that needs a reviewer, a real basis and a source note
const MIN_REASON = 3;
const REVIEW_PERMISSION = 'patterns:review';

// Who made the change. security.js sets req.user = { id, email, role } for every signed-in request, so the email is the name.
// With AUTH_DISABLED (development only, never in production) there is no user: the name is dev@localhost.
const authOff = () => process.env.AUTH_DISABLED === 'true' && process.env.NODE_ENV !== 'production';
function actorOf(req) {
  const u = req && req.user;
  if (u && typeof u === 'object') return String(u.email || u.username || u.name || u.id || 'unknown').slice(0, 120);
  return authOff() ? 'dev@localhost' : 'unknown';
}

// Body is either the bare spec, or { spec, note?, version? }.
function takeBody(body) {
  if (isObj(body) && isObj(body.spec)) return { spec: body.spec, note: String(body.note == null ? '' : body.note).slice(0, LIMITS.maxNote), version: body.version };
  return { spec: body, note: '', version: undefined };
}

// Until the review flow (chunk 8) exists, every pattern is a draft and the status cannot be set through these routes.
function statusErrors(spec, allowed) {
  if (isObj(spec) && own(spec, 'status') && spec.status !== allowed) {
    return [{ path: 'status', message: 'status cannot be set here (it is "' + allowed + '"); status changes go through review' }];
  }
  return [];
}

// ---------- run endpoint and seed patterns (chunk 4) ----------
const RUN_INSERT_SQL = `INSERT INTO pattern_runs (pattern_id, spec_version, run_by, scope, result)
  VALUES ($1, $2, $3, $4::jsonb, $5::jsonb) RETURNING id, run_at`;
const RUN_LIST_SQL = 'SELECT id, pattern_id, spec_version, run_at, run_by, scope, result FROM pattern_runs WHERE pattern_id = $1 ORDER BY id DESC LIMIT 20';
const RUN_TIMEOUT = '60s';
const MAX_MATCHES = 500;

// Small-number protection: same rule as care pathways (PATHWAY_MIN_CELL, default 5).
function minCellOf(helpers) {
  const v = helpers && helpers.minCell !== undefined ? helpers.minCell : parseInt(process.env.PATHWAY_MIN_CELL, 10);
  return Number.isInteger(v) && v >= 1 ? v : 5;
}
const isoDay = (d) => {
  if (d instanceof Date && !isNaN(d)) return d.toISOString().slice(0, 10);
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null;
};
const ASOF_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * summarize(rows, opts) -> { counts, reasons, matches, truncated, suppressed, min_cell, evaluable, match_rate }
 * rows are the buildSql rows. A count between 1 and min_cell - 1 is hidden (null). When any outcome count is hidden
 * the eligible total is hidden too, so a hidden count cannot be worked out by subtraction. Reason counts are per reason
 * (a patient can appear under more than one) and are hidden by the same rule. Matches are listed only when the matched
 * count is shown, at most opts.limit of them, sorted by patient_id.
 */
function summarize(rows, opts) {
  const min = opts.minCell, limit = Math.max(1, Math.min(MAX_MATCHES, opts.limit || 50));
  const hide = (n) => n > 0 && n < min;
  const raw = { matched: 0, not_matched: 0, cannot_evaluate: 0 }, rc = new Map(), matched = [];
  for (const r of rows) {
    if (!own(raw, r.outcome)) continue;
    raw[r.outcome]++;
    if (r.outcome === 'cannot_evaluate') for (const x of (r.reasons || [])) rc.set(x, (rc.get(x) || 0) + 1);
    if (r.outcome === 'matched') matched.push(r);
  }
  const eligible = raw.matched + raw.not_matched + raw.cannot_evaluate;
  const anyHidden = hide(raw.matched) || hide(raw.not_matched) || hide(raw.cannot_evaluate);
  const show = (n) => (hide(n) ? null : n);
  const counts = { eligible: anyHidden || hide(eligible) ? null : eligible, matched: show(raw.matched), not_matched: show(raw.not_matched), cannot_evaluate: show(raw.cannot_evaluate) };
  const reasons = Array.from(rc.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([reason, n]) => ({ reason, count: show(n), hidden: hide(n) }));
  const shownMatches = counts.matched === null ? [] : matched.sort((a, b) => (a.patient_id < b.patient_id ? -1 : 1)).slice(0, limit)
    .map((r) => ({ patient_id: r.patient_id, records: r.records || {}, codes: r.codes || {} }));
  const both = counts.matched !== null && counts.not_matched !== null;
  const evaluable = both ? raw.matched + raw.not_matched : null;
  return {
    counts, reasons, matches: shownMatches,
    truncated: counts.matched !== null && raw.matched > shownMatches.length,
    suppressed: anyHidden || hide(eligible) || reasons.some((x) => x.hidden),
    min_cell: min, evaluable,
    match_rate: both && evaluable > 0 ? Math.round((raw.matched / evaluable) * 10000) / 10000 : null,
  };
}

// What the run says about its scope. Only labels and counts, never patient lists.
function describeScope(ctx, opts) {
  const c = ctx.cohort;
  const cohort = c && typeof c === 'object' ? (c.name || c.id || c.cohortId || true) : (c || null);
  const n = Array.isArray(ctx.patients) ? ctx.patients.length : (typeof ctx.patients === 'number' ? ctx.patients : null);
  return { population: ctx.population === undefined ? null : ctx.population, cohort, patients: n, as_of: isoDay(ctx.asOf), require_follow_up: opts.requireFollowUp !== false };
}

// Run one statement on the read-only pool inside a read-only transaction with a time limit.
async function readQuery(db, sql, params) {
  if (typeof db.connect !== 'function') return db.query(sql, params);
  const c = await db.connect();
  try {
    await c.query('BEGIN READ ONLY');
    await c.query("SET LOCAL statement_timeout = '" + RUN_TIMEOUT + "'");
    const r = await c.query(sql, params);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* keep the original error */ }
    if (e && e.code === '57014') throw apiError(504, 'The run took longer than ' + RUN_TIMEOUT + ' and was stopped; narrow the value sets or the cohort');
    throw e;
  } finally { c.release(); }
}

// ---------- run labels (chunk 5) ----------
// Settings: helpers.settings or environment. Defaults: thin below 20 evaluable patients, gappy above 30% cannot-evaluate,
// hierarchy counts as demo-only at 47 is-a links or fewer (the demo set has 47).
function labelSettings(helpers) {
  const given = (helpers && helpers.settings) || {};
  const num = (v, env, def, lo, hi) => { const x = v !== undefined ? v : parseFloat(process.env[env]); return Number.isFinite(x) && x >= lo && x <= hi ? x : def; };
  return {
    thin_n: num(given.thin_n, 'PATTERN_THIN_N', 20, 1, 100000),
    gappy_pct: num(given.gappy_pct, 'PATTERN_GAPPY_PCT', 30, 1, 100),
    demo_links: num(given.demo_links, 'PATTERN_DEMO_LINKS', 47, 0, 10000000),
  };
}

const CERT_TEXT = {
  established: 'Established: backed by a named source.',
  supported: 'Supported: some evidence, recorded in the note.',
  hypothesis: 'Hypothesis: not yet confirmed by a source.',
  contested: 'Contested: sources disagree.',
};
const CLAIM_TEXT = {
  descriptive: 'It describes what is in the records.',
  association: 'It shows an association, not a cause.',
  causal: 'It makes a causal claim.',
};

/**
 * runLabels(spec, rows, resolved, settings) -> { reliability: [{ id, detail }], evidence_mix, epistemic_text }
 * thin: fewer than thin_n patients could be judged (matched + not matched).
 * gappy: more than gappy_pct percent of eligible patients are cannot_evaluate.
 * weak_hierarchy: a value set uses descendants but the loaded is-a links are demo-sized or absent.
 * evidence_mix: documented always; derived when a rule infers a fact (no_refill infers a stop date).
 */
function runLabels(spec, rows, resolved, settings) {
  const c = { matched: 0, not_matched: 0, cannot_evaluate: 0 };
  for (const r of rows) if (own(c, r.outcome)) c[r.outcome]++;
  const eligible = c.matched + c.not_matched + c.cannot_evaluate, evaluable = c.matched + c.not_matched;
  const reliability = [];
  if (evaluable < settings.thin_n) reliability.push({ id: 'thin', detail: 'Fewer than ' + settings.thin_n + ' patients could be judged.' });
  if (eligible > 0 && (c.cannot_evaluate * 100) / eligible > settings.gappy_pct) reliability.push({ id: 'gappy', detail: 'More than ' + settings.gappy_pct + '% of eligible patients could not be judged (missing dates or open follow-up).' });
  const usesDesc = Object.keys(spec.valuesets).some((k) => spec.valuesets[k].mode === 'descendants');
  if (usesDesc && (!resolved || !resolved.links || resolved.links <= settings.demo_links)) reliability.push({ id: 'weak_hierarchy', detail: 'Descendant codes rely on ' + ((resolved && resolved.links) || 0) + ' is-a links, which is demo-sized. Load a real hierarchy before trusting descendants.' });
  const evidence_mix = { documented: true, derived: spec.when.some((w) => w.rel === 'no_refill'), inferred: false };
  const e = spec.epistemic || {};
  const epistemic_text = (CERT_TEXT[e.certainty] || '') + ' ' + (CLAIM_TEXT[e.claim] || '') + (e.note ? ' Note: ' + e.note : '');
  return { reliability, evidence_mix, epistemic_text: epistemic_text.trim() };
}

// Three library patterns, stored as drafts by POST /api/patterns/seed. Codes are examples:
// check them against the codes in your data before relying on a result.
const SEEDS = [
  {
    id: 'drug_within_90d_of_dx',
    plain: 'A medication is prescribed within 90 days after a diagnosis.',
    source: { kind: 'library' },
    valuesets: {
      condition: { domain: 'dx', codes: ['44054006'], mode: 'descendants' },
      drug: { domain: 'rx', codes: ['A10BA02'], mode: 'exact' },
    },
    events: [{ as: 'dx', valueset: 'condition', pick: 'first' }, { as: 'rx', valueset: 'drug', pick: 'first_on_or_after:dx' }],
    when: [{ rel: 'within_days', a: 'rx.date', of: 'dx.date', range: [0, 90] }],
    epistemic: { certainty: 'hypothesis', basis: 'expert', claim: 'descriptive', note: 'Example codes (type 2 diabetes, metformin). Replace with the codes in your data.', tags: ['seed', 'prescribing'] },
  },
  {
    id: 'readmit_30d_after_discharge',
    plain: 'A patient is admitted again within 30 days after the first inpatient stay ends (measured from discharge).',
    source: { kind: 'library' },
    valuesets: { stay: { domain: 'en', codes: ['IMP'], mode: 'exact' } },
    events: [{ as: 'adm', valueset: 'stay', pick: 'first' }],
    when: [{ rel: 'return_within_days', event: 'adm', of: 'adm.date', days: 30, from: 'end' }],
    epistemic: { certainty: 'hypothesis', basis: 'expert', claim: 'descriptive', note: 'Index stay is each patient\'s first inpatient stay. Compare with the existing readmission analytic before relying on it.', tags: ['seed', 'readmission'] },
  },
  {
    id: 'viral_abx_short_course',
    plain: 'Viral illness treated with an antibiotic within 3 days, no further record of the illness 7 to 30 days later, antibiotic not refilled.',
    source: { kind: 'library' },
    valuesets: {
      viral: { domain: 'dx', codes: ['34014006'], mode: 'descendants' },
      antibac: { domain: 'rx', codes: ['J01CA04'], mode: 'exact' },
    },
    events: [{ as: 'dx', valueset: 'viral', pick: 'first' }, { as: 'abx', valueset: 'antibac', pick: 'first_on_or_after:dx' }],
    when: [
      { rel: 'within_days', a: 'abx.date', of: 'dx.date', range: [0, 3] },
      { rel: 'none_in_window', event: 'dx', after: 'dx.date', range: [7, 30] },
      { rel: 'no_refill', event: 'abx', supply_days: 5, grace_days: 45 },
    ],
    epistemic: { certainty: 'hypothesis', basis: 'expert', claim: 'association', note: 'Illustrative. Describes an association between a short course and no return of the illness, not a cause. Stop date is inferred from supply plus grace.', tags: ['seed', 'antibiotics'] },
  },
];

// ---------- create from one case (chunk 9) ----------
// Pure functions first (no database, no network), then the route inside register().
// The abstraction copies only a fixed list of fields. Anything else on a record (id, name, address, free text) is never read,
// so it cannot leak by accident. Codes must look like codes (CODE_RE); a value that looks like text is dropped and counted.
const CASE_DOMAINS = ['dx', 'rx', 'pr', 'en', 'im', 'ob'];   // al has no date, so it cannot be ordered
const CASE_LABEL = { dx: 'diagnosis', rx: 'medication', pr: 'procedure', en: 'encounter class', im: 'immunization', ob: 'observation' };
const CASE_MAX_RECORDS = 5000;
const CASE_WORDING_SETTING = 'PATTERN_CASE_MODEL_WORDING';

function ageBand(birth, asOf) {
  const b = isoDay(birth), a = isoDay(asOf);
  if (!b || !a) return null;
  const by = +b.slice(0, 4), bm = +b.slice(5, 7), bd = +b.slice(8, 10), ay = +a.slice(0, 4), am = +a.slice(5, 7), ad = +a.slice(8, 10);
  let age = ay - by - ((am < bm || (am === bm && ad < bd)) ? 1 : 0);
  if (!Number.isFinite(age) || age < 0 || age > 130) return null;
  return age >= 80 ? '80+' : (Math.floor(age / 10) * 10) + '-' + (Math.floor(age / 10) * 10 + 9);
}

/**
 * abstractCase(input) -> { age_band, n_records, events: [{ domain, code, day, end_day }], undated, dropped, span_days }
 * input: { birth_date, as_of, records: [{ domain, code, date, end }] }. Nothing else is read.
 * day is the number of days after the first dated record (the first one is 0). end_day is set for encounters with a discharge date.
 * No identifier, name, birth date, address, calendar date or text survives: only domain, code, day offsets and an age band.
 */
function abstractCase(input) {
  const src = isObj(input) ? input : {};
  const recs = Array.isArray(src.records) ? src.records : [];
  const kept = []; let dropped = 0; const undated = new Set();
  for (const r of recs) {
    const dom = isObj(r) ? r.domain : null, code = isObj(r) && typeof r.code === 'string' ? r.code.trim() : '';
    if (!CASE_DOMAINS.includes(dom) || !CODE_RE.test(code)) { dropped++; continue; }
    const d = isoDay(r.date);
    if (!d) { undated.add(dom + ':' + code); continue; }
    kept.push({ domain: dom, code, ms: Date.parse(d + 'T00:00:00Z'), endMs: isoDay(r.end) ? Date.parse(isoDay(r.end) + 'T00:00:00Z') : null });
  }
  kept.sort((a, b) => a.ms - b.ms || CASE_DOMAINS.indexOf(a.domain) - CASE_DOMAINS.indexOf(b.domain) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const t0 = kept.length ? kept[0].ms : 0, DAY = 86400000, seen = new Set(), events = [];
  for (const k of kept) {
    const day = Math.round((k.ms - t0) / DAY), end = k.endMs === null ? null : Math.round((k.endMs - t0) / DAY);
    const key = k.domain + ':' + k.code + ':' + day;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ domain: k.domain, code: k.code, day, end_day: end !== null && end >= day ? end : null });
  }
  return {
    age_band: ageBand(src.birth_date, src.as_of), n_records: recs.length, events,
    undated: Array.from(undated).sort().map((x) => ({ domain: x.split(':')[0], code: x.slice(x.indexOf(':') + 1) })),
    dropped, span_days: events.length ? events[events.length - 1].day : 0,
  };
}

/**
 * draftFromCase(abs, opts) -> { spec, used, left_out }
 * One event per distinct (domain, code), in the order each first appears, at most LIMITS.maxEvents of them. Each later event is
 * "the first one on or after the previous event", and the gap seen in this one case becomes the window [0, gap].
 * Value sets are exact (no descendants): one case does not tell which parent code was meant. The draft is a hypothesis
 * drafted from observed data. It never carries identifiers, dates or text from the case.
 */
function draftFromCase(abs, opts) {
  opts = opts || {};
  const firsts = []; const seen = new Set();
  for (const e of (abs && abs.events) || []) {
    const k = e.domain + ':' + e.code;
    if (seen.has(k)) continue;
    seen.add(k); firsts.push(e);
  }
  const used = []; let leftOut = 0, prevDay = null;
  for (const e of firsts) {
    if (used.length >= LIMITS.maxEvents || (prevDay !== null && e.day - prevDay > LIMITS.maxDays)) { leftOut++; continue; }
    used.push(e); prevDay = e.day;
  }
  if (!used.length) throw apiError(422, 'This patient has no dated records that can be turned into a pattern');
  const count = {}, valuesets = {}, events = [], when = [];
  used.forEach((e, i) => {
    count[e.domain] = (count[e.domain] || 0) + 1;
    const alias = e.domain + count[e.domain];
    e.alias = alias;
    valuesets[alias + '_codes'] = { domain: e.domain, codes: [e.code], mode: 'exact' };
    events.push({ as: alias, valueset: alias + '_codes', pick: i === 0 ? 'first' : 'first_on_or_after:' + used[i - 1].alias });
    if (i > 0) when.push({ rel: 'within_days', a: alias + '.date', of: used[i - 1].alias + '.date', range: [0, e.day - used[i - 1].day] });
  });
  const parts = used.map((e, i) => (i === 0 ? 'a ' : 'then a ') + CASE_LABEL[e.domain] + ' ' + e.code + (i > 0 ? ' within ' + (e.day - used[i - 1].day) + ' day' + (e.day - used[i - 1].day === 1 ? '' : 's') : ''));
  let plain = 'Drafted from one case: ' + parts.join(', ') + '. Names were not added; check the codes before use.';
  if (plain.length > LIMITS.maxPlain) plain = plain.slice(0, LIMITS.maxPlain - 1) + '…';
  const noteParts = ['Drafted from one abstracted case' + (abs.age_band ? ' (age band ' + abs.age_band + ')' : '') + ': ' + used.length + ' events over ' + used[used.length - 1].day + ' days. One case cannot show how common or how reliable this sequence is.'];
  if (leftOut) noteParts.push(leftOut + ' later or distant event' + (leftOut === 1 ? ' was' : 's were') + ' left out.');
  const id = opts.id || 'case_draft_' + require('crypto').randomBytes(4).toString('hex');   // random: never derived from the patient
  const input = {
    id, plain, status: 'draft', source: { kind: 'one_case', n: 1 }, valuesets, events, when,
    epistemic: { certainty: 'hypothesis', basis: 'observed_in_data', claim: 'descriptive', note: noteParts.join(' '), tags: ['from_case'] },
  };
  const v = validate(input, { reviewer: false });
  if (!v.ok) throw apiError(500, 'The case draft is not a valid pattern: ' + JSON.stringify(v.errors));
  return { spec: v.spec, used: used.length, left_out: leftOut };
}

// Dates leave the database as plain YYYY-MM-DD text, so the server's time zone cannot shift a day.
const CASE_SQL = (withSql) => withSql + ` SELECT 'p' AS dom, NULL::text AS cd, to_char((birth_date)::date, 'YYYY-MM-DD') AS d, NULL::text AS e FROM p WHERE patient_id::text = $1::text
UNION ALL SELECT 'dx', code::text, to_char((onset_date)::date, 'YYYY-MM-DD'), NULL::text FROM dx WHERE patient_id::text = $1::text
UNION ALL SELECT 'rx', code::text, to_char((prescribed_date)::date, 'YYYY-MM-DD'), NULL::text FROM rx WHERE patient_id::text = $1::text
UNION ALL SELECT 'ob', code::text, to_char((effective_date)::date, 'YYYY-MM-DD'), NULL::text FROM ob WHERE patient_id::text = $1::text
UNION ALL SELECT 'pr', code::text, to_char((performed_date)::date, 'YYYY-MM-DD'), NULL::text FROM pr WHERE patient_id::text = $1::text
UNION ALL SELECT 'im', code::text, to_char((occurrence_date)::date, 'YYYY-MM-DD'), NULL::text FROM im WHERE patient_id::text = $1::text
UNION ALL SELECT 'en', cls::text, to_char((start_date)::date, 'YYYY-MM-DD'), to_char((end_date)::date, 'YYYY-MM-DD') FROM en WHERE patient_id::text = $1::text
LIMIT ${CASE_MAX_RECORDS + 2}`;
const PATIENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,63}$/;

// ---------- import and export (chunk 11) ----------
// A file is { format, spec_version, exported_at, count, patterns: [spec...], checksum }. The checksum is SHA-256 of the sorted-key JSON of
// "patterns": it catches a file that was edited or damaged after export. It is NOT a signature (anyone can recompute it), so every imported
// pattern is validated again and arrives as a draft with certainty hypothesis; a reviewer decides what happens next.
const BUNDLE_FORMAT = 'vibe-rounds-patterns', BUNDLE_MAX = 200;
const EXPORT_SQL = 'SELECT spec FROM patterns WHERE status = ANY($1::text[]) ORDER BY id';
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
const sumOf = (patterns) => require('crypto').createHash('sha256').update(stable(patterns)).digest('hex');

function makeBundle(specs, now) {
  const patterns = specs.map((x) => JSON.parse(JSON.stringify(x)));
  return { format: BUNDLE_FORMAT, spec_version: SPEC_VERSION, exported_at: (now || new Date()).toISOString(), count: patterns.length, patterns, checksum: sumOf(patterns) };
}

/** checkBundle(file) -> list of problems (empty when the file is intact). Structure and checksum only; patterns are validated one by one later. */
function checkBundle(b) {
  const bad = (m) => [{ path: '', message: m }];
  if (!isObj(b)) return bad('the file must be a JSON object');
  if (b.format !== BUNDLE_FORMAT) return bad('this is not a Vibe Rounds pattern file (format must be "' + BUNDLE_FORMAT + '")');
  if (b.spec_version !== SPEC_VERSION) return bad('unsupported spec_version (expected ' + SPEC_VERSION + ')');
  if (!Array.isArray(b.patterns) || !b.patterns.length) return bad('the file holds no patterns');
  if (b.patterns.length > BUNDLE_MAX) return bad('at most ' + BUNDLE_MAX + ' patterns per file');
  if (b.count !== b.patterns.length) return bad('the count in the file does not match the patterns it holds: the file was changed');
  if (typeof b.checksum !== 'string' || b.checksum !== sumOf(b.patterns)) return bad('the checksum does not match: the file was changed or damaged after export');
  return [];
}

/**
 * asImportedDraft(spec) -> { ok, errors, spec }
 * Whatever the file says, the pattern comes in as a draft from the library with certainty hypothesis (a causal claim becomes an association),
 * validated as a non-reviewer. The original certainty is kept in the note so a reviewer can see what the sender claimed.
 */
function asImportedDraft(spec) {
  if (!isObj(spec)) return { ok: false, errors: [{ path: '', message: 'pattern must be an object' }], spec: null };
  const e = isObj(spec.epistemic) ? spec.epistemic : {};
  const was = CERTAINTY.includes(e.certainty) ? e.certainty : 'hypothesis';
  const lead = 'Imported from a file (sender said ' + was + (RAISED.includes(was) ? '; not carried over' : '') + '). ';
  const tags = Array.from(new Set((Array.isArray(e.tags) ? e.tags.filter((t) => typeof t === 'string') : []).concat('imported'))).slice(0, LIMITS.maxTags);
  const copy = Object.assign({}, spec, {
    status: 'draft', source: { kind: 'library' },
    epistemic: Object.assign({}, e, { certainty: was === 'contested' ? 'contested' : 'hypothesis', claim: e.claim === 'causal' ? 'association' : e.claim,
      note: (lead + (typeof e.note === 'string' ? e.note : '')).slice(0, LIMITS.maxNote), tags }),
  });
  if (copy.epistemic.claim === undefined) delete copy.epistemic.claim;
  const v = validate(copy, { reviewer: false });
  return v.ok ? { ok: true, errors: [], spec: v.spec } : { ok: false, errors: v.errors, spec: null };
}

// ---------- create from a few cases (chunk 10) ----------
// Aggregates only. Each selected patient is abstracted with abstractCase (chunk 9); then code keeps the codes that a clear share of the
// patients have, puts them in their usual order (median first day) and takes the gap between neighbours from the patients that have both.
// A code, an order or a gap is used only when at least min-cell patients stand behind it, so a small group is never summarized.
const FEW_MIN = 2, FEW_MAX = 200, FEW_SHARE = 0.5, FEW_MAX_ROWS = 200000;
const FEW_VIEWS = [['dx', 'code', 'onset_date', null], ['rx', 'code', 'prescribed_date', null], ['ob', 'code', 'effective_date', null],
  ['pr', 'code', 'performed_date', null], ['im', 'code', 'occurrence_date', null], ['en', 'cls', 'start_date', 'end_date']];
const FEW_SQL = (withSql) => withSql + ` SELECT patient_id::text AS pid, 'p' AS dom, NULL::text AS cd, to_char((birth_date)::date, 'YYYY-MM-DD') AS d, NULL::text AS e FROM p WHERE patient_id::text = ANY($1::text[])` +
  FEW_VIEWS.map((v) => `\nUNION ALL SELECT patient_id::text, '${v[0]}', ${v[1]}::text, to_char((${v[2]})::date, 'YYYY-MM-DD'), ${v[3] ? `to_char((${v[3]})::date, 'YYYY-MM-DD')` : 'NULL::text'} FROM ${v[0]} WHERE patient_id::text = ANY($1::text[])`).join('') +
  `\nLIMIT ${FEW_MAX_ROWS + 1}`;

function medianOf(sorted) { const n = sorted.length, m = n >> 1; return n % 2 ? sorted[m] : Math.round((sorted[m - 1] + sorted[m]) / 2); }

/**
 * mineCases(abstracts, opts) -> { spec, summary: { n, need, events: [{ domain, code, count, median_day, gap }], left_out } }
 * abstracts: abstractCase() results, one per patient. opts: { minCell = 5, share = 0.5, id }.
 * need = max(minCell, ceil(share * n)): a code is kept when that many patients have it. At most LIMITS.maxEvents codes (the most shared).
 * Order = median first day, ties by domain and code. Each later event is first_on_or_after the previous one, with the window [0, longest gap];
 * the gap is read only from patients that have both codes in that order, and needs at least minCell of them, otherwise the event is left out.
 * Value sets are exact. The draft is a hypothesis from observed data and carries no patient data, only codes and counts of at least minCell.
 */
function mineCases(abstracts, opts) {
  opts = opts || {};
  const minCell = Number.isInteger(opts.minCell) && opts.minCell >= 1 ? opts.minCell : 5;
  const share = typeof opts.share === 'number' && opts.share > 0 && opts.share <= 1 ? opts.share : FEW_SHARE;
  const cases = (Array.isArray(abstracts) ? abstracts : []).map((a) => {
    const m = new Map();
    for (const e of (a && a.events) || []) { const k = e.domain + ':' + e.code; if (!m.has(k) || e.day < m.get(k).day) m.set(k, { domain: e.domain, code: e.code, day: e.day }); }
    return m;
  });
  const n = cases.length;
  if (n < FEW_MIN) throw apiError(422, 'Give at least ' + FEW_MIN + ' patients');
  if (n < minCell) throw apiError(422, 'Fewer than ' + minCell + ' patients could be read. A group this small is not summarized (it could identify a person).');
  const need = Math.max(minCell, Math.ceil(share * n));
  const tally = new Map();
  for (const m of cases) for (const [k, e] of m) { let t = tally.get(k); if (!t) { t = { key: k, domain: e.domain, code: e.code, days: [] }; tally.set(k, t); } t.days.push(e.day); }
  const shared = [];
  for (const t of tally.values()) if (t.days.length >= need) { t.days.sort((a, b) => a - b); shared.push({ key: t.key, domain: t.domain, code: t.code, count: t.days.length, median_day: medianOf(t.days) }); }
  if (!shared.length) throw apiError(422, 'No code is shared by at least ' + need + ' of the ' + n + ' patients, so there is no common shape to draft from');
  const top = shared.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1)).slice(0, LIMITS.maxEvents);
  let leftOut = shared.length - top.length;
  const ordered = top.sort((a, b) => a.median_day - b.median_day || (a.key < b.key ? -1 : 1));
  const used = [];
  for (const e of ordered) {
    if (!used.length) { used.push(Object.assign({}, e, { gap: null })); continue; }
    const prev = used[used.length - 1], g = [];
    for (const m of cases) { const a = m.get(prev.key), b = m.get(e.key); if (a && b && b.day >= a.day) g.push(b.day - a.day); }
    g.sort((x, y) => x - y);
    if (g.length < minCell || g[g.length - 1] > LIMITS.maxDays) { leftOut++; continue; }
    used.push(Object.assign({}, e, { gap: { n: g.length, min: g[0], median: medianOf(g), max: g[g.length - 1] } }));
  }
  const count = {}, valuesets = {}, events = [], when = [];
  used.forEach((e, i) => {
    count[e.domain] = (count[e.domain] || 0) + 1;
    e.alias = e.domain + count[e.domain];
    valuesets[e.alias + '_codes'] = { domain: e.domain, codes: [e.code], mode: 'exact' };
    events.push({ as: e.alias, valueset: e.alias + '_codes', pick: i === 0 ? 'first' : 'first_on_or_after:' + used[i - 1].alias });
    if (i > 0) when.push({ rel: 'within_days', a: e.alias + '.date', of: used[i - 1].alias + '.date', range: [0, e.gap.max] });
  });
  const parts = used.map((e, i) => (i === 0 ? 'a ' : 'then a ') + CASE_LABEL[e.domain] + ' ' + e.code + (i > 0 ? ' within ' + e.gap.max + ' day' + (e.gap.max === 1 ? '' : 's') : ''));
  let plain = 'Drafted from ' + n + ' cases: ' + parts.join(', ') + '. Names were not added; check the codes before use.';
  if (plain.length > LIMITS.maxPlain) plain = plain.slice(0, LIMITS.maxPlain - 1) + '…';
  const note = ['Drafted from ' + n + ' abstracted cases. Each code is in at least ' + need + ' of them; the order is the usual order and each window runs from 0 to the longest gap seen. It shows what is common in these cases, not that it is confirmed or causal.'];
  if (leftOut) note.push(leftOut + ' code' + (leftOut === 1 ? ' was' : 's were') + ' left out (too few patients, no clear order, or more than ' + LIMITS.maxEvents + ' events).');
  const id = opts.id || 'cases_draft_' + require('crypto').randomBytes(4).toString('hex');   // random, never derived from a patient
  const v = validate({
    id, plain, status: 'draft', source: { kind: 'few_cases', n }, valuesets, events, when,
    epistemic: { certainty: 'hypothesis', basis: 'observed_in_data', claim: 'descriptive', note: note.join(' ').slice(0, LIMITS.maxNote), tags: ['from_cases'] },
  }, { reviewer: false });
  if (!v.ok) throw apiError(500, 'The cases draft is not a valid pattern: ' + JSON.stringify(v.errors));
  return { spec: v.spec, summary: { n, need, events: used.map((e) => ({ domain: e.domain, code: e.code, count: e.count, median_day: e.median_day, gap: e.gap })), left_out: leftOut } };
}

// How many patients of the active cohort match a drafted spec (counts only, hidden under the min-cell).
async function cohortShare(spec, ctx, db, min) {
  const out = { min_cell: min, checked: false, matched_in_cohort: null, rare_combination: false };
  try {
    const resolved = await resolveValueSets(spec, db);
    const built = buildSql(spec, { with: ctx.with }, resolved, { requireFollowUp: false });
    const sum = summarize((await readQuery(db, built.sql, built.params)).rows, { minCell: min, limit: 1 });
    out.checked = true; out.matched_in_cohort = sum.counts.matched; out.rare_combination = sum.counts.matched === null;
  } catch (e) { out.error = 'The cohort check could not run: ' + (e && e.message ? String(e.message).slice(0, 120) : 'error'); }
  return out;
}

function register(app, pool, helpers) {
  helpers = helpers || {};
  const fail = helpers.fail || ((res, label, err) => {
    console.error(label + ':', err);
    res.status(err.status || 500).json({ success: false, error: err.status ? err.message : label + ' failed', details: err.message });
  });
  const json = require('express').json({ limit: '1mb' });   // per route; harmless if the app already parses JSON
  let ready = null;
  const ensure = () => ready || (ready = pool.query(PATTERN_TABLES_SQL).catch((e) => { ready = null; throw e; }));
  const reject422 = (res, errors) => res.status(422).json({ success: false, error: 'Invalid pattern spec', errors });
  // Reviewer rights come from the role table in security.js (permission patterns:review). A test or another host may pass helpers.can.
  let secCan = null;
  const canDo = (user, perm) => {
    if (typeof helpers.can === 'function') return !!helpers.can(user, perm);
    if (!secCan) { try { secCan = require('./security').auth.can; } catch (e) { secCan = () => false; } }
    return !!secCan(user, perm);
  };
  const isReviewer = (req) => (req.user ? canDo(req.user, REVIEW_PERMISSION) : authOff());
  const needReviewer = (req) => {
    if (!isReviewer(req) || actorOf(req) === 'unknown') throw apiError(403, 'Only a reviewer can change the status or the certainty of a pattern');
  };
  const secondReviewer = () => helpers.secondReviewer !== undefined ? !!helpers.secondReviewer : process.env.PATTERN_SECOND_REVIEWER === 'true';
  const reason = (v) => {
    const t = typeof v === 'string' ? clean(v) : '';
    if (t.length < MIN_REASON) throw apiError(422, 'Invalid request', { errors: [{ path: 'note', message: 'a note saying why is required' }] });
    if (t.length > LIMITS.maxNote) throw apiError(422, 'Invalid request', { errors: [{ path: 'note', message: 'note longer than ' + LIMITS.maxNote }] });
    return t;
  };
  const needVersion = (v) => { if (!isInt(v)) throw apiError(400, 'version is required (the version you looked at)'); return v; };
  const idOf = (req) => {
    const id = String(req.params.id);
    if (!ID_RE.test(id)) throw apiError(400, 'Invalid pattern id');
    return id;
  };

  // NOTE for later chunks: fixed GET paths such as /api/patterns/export must be registered BEFORE GET /api/patterns/:id.

  app.get('/api/patterns', async (req, res) => {
    try {
      const st = Array.isArray(req.query.status) ? req.query.status[0] : req.query.status;
      if (st !== undefined && !STATUSES.includes(st)) throw apiError(400, 'status must be one of ' + STATUSES.join(', '));
      await ensure();
      const r = st === undefined
        ? await pool.query(LIST_SQL + ' ORDER BY updated_at DESC, id')
        : await pool.query(LIST_SQL + ' WHERE status = $1 ORDER BY updated_at DESC, id', [st]);
      res.json({ success: true, patterns: r.rows });
    } catch (err) { fail(res, 'Pattern list', err); }
  });

  // Fixed paths first: GET /api/patterns/export must stay ahead of GET /api/patterns/:id.
  // ?status=draft|reviewed|active|retired selects one status; the default is reviewed and active (what is safe to share).
  app.get('/api/patterns/export', async (req, res) => {
    try {
      const st = Array.isArray(req.query.status) ? req.query.status[0] : req.query.status;
      if (st !== undefined && !STATUSES.includes(st)) throw apiError(400, 'status must be one of ' + STATUSES.join(', '));
      await ensure();
      const r = await pool.query(EXPORT_SQL, [st === undefined ? ['reviewed', 'active'] : [st]]);
      const bundle = makeBundle(r.rows.map((x) => (typeof x.spec === 'string' ? JSON.parse(x.spec) : x.spec)));
      req.auditDetails = { count: bundle.count, status: st || 'reviewed,active' };
      res.set('Content-Disposition', 'attachment; filename="vibe-rounds-patterns-' + new Date().toISOString().slice(0, 10) + '.json"');
      res.json(bundle);
    } catch (err) { fail(res, 'Pattern export', err); }
  });

  // Body: { bundle: <the exported file>, note?: 'why' }. A damaged file is refused whole (422). A pattern that fails validation is skipped and reported;
  // an id that already exists is left alone. Every new pattern is a draft at hypothesis; the history row says it was imported.
  app.post('/api/patterns/import', json, async (req, res) => {
    try {
      const b = isObj(req.body) ? req.body : {};
      const file = isObj(b.bundle) ? b.bundle : null;
      if (!file) throw apiError(400, 'bundle is required (the exported file)');
      const note = String(b.note == null ? '' : b.note).slice(0, LIMITS.maxNote);
      const problems = checkBundle(file);
      if (problems.length) return reject422(res, problems);
      await ensure();
      const actor = actorOf(req), created = [], existing = [], invalid = [];
      for (let i = 0; i < file.patterns.length; i++) {
        const d = asImportedDraft(file.patterns[i]);
        if (!d.ok) { invalid.push({ index: i, id: isObj(file.patterns[i]) && typeof file.patterns[i].id === 'string' ? file.patterns[i].id.slice(0, 64) : null, errors: d.errors.slice(0, 5) }); continue; }
        const s = d.spec, e = s.epistemic;
        const made = await tx(pool, async (c) => {
          const r = await c.query(INSERT_SQL, [s.id, s.plain, JSON.stringify(s), e.certainty, e.basis, e.claim, s.source.kind, actor]);
          if (!r.rows.length) return false;
          await c.query(HISTORY_INSERT_SQL, [s.id, 'import', actor, null, e.certainty, ('imported from a file' + (note ? ': ' + note : '')).slice(0, LIMITS.maxNote), JSON.stringify(s), null, 'draft']);
          return true;
        });
        (made ? created : existing).push(s.id);
      }
      req.auditDetails = { count: file.patterns.length, created: created.length, existing: existing.length, invalid: invalid.length };
      res.json({ success: true, created, existing, invalid });
    } catch (err) { fail(res, 'Pattern import', err); }
  });

  app.get('/api/patterns/:id', async (req, res) => {
    try {
      const id = idOf(req);
      await ensure();
      const r = await pool.query('SELECT * FROM patterns WHERE id = $1', [id]);
      if (!r.rows.length) throw apiError(404, "Pattern '" + id + "' not found");
      const h = await pool.query(HISTORY_LIST_SQL, [id]);
      res.json({ success: true, pattern: r.rows[0], history: h.rows, review: { can_review: isReviewer(req), transitions: TRANSITIONS[r.rows[0].status] || [], second_reviewer: secondReviewer() } });
    } catch (err) { fail(res, 'Pattern read', err); }
  });

  app.post('/api/patterns', json, async (req, res) => {
    try {
      const { spec, note } = takeBody(req.body);
      const v = validate(spec, { reviewer: false });
      const errs = (v.ok ? [] : v.errors).concat(statusErrors(spec, 'draft'));
      if (errs.length) return reject422(res, errs);
      await ensure();
      const s = v.spec, e = s.epistemic, actor = actorOf(req);
      const row = await tx(pool, async (c) => {
        const r = await c.query(INSERT_SQL, [s.id, s.plain, JSON.stringify(s), e.certainty, e.basis, e.claim, s.source.kind, actor]);
        if (!r.rows.length) throw apiError(409, "A pattern with id '" + s.id + "' already exists");
        await c.query(HISTORY_INSERT_SQL, [s.id, 'create', actor, null, e.certainty, note, JSON.stringify(s), null, 'draft']);
        return r.rows[0];
      });
      req.auditTarget = s.id; req.auditDetails = { to_status: 'draft', to_certainty: e.certainty };
      res.status(201).json({ success: true, pattern: row });
    } catch (err) { fail(res, 'Pattern create', err); }
  });

  app.put('/api/patterns/:id', json, async (req, res) => {
    try {
      const id = idOf(req);
      const { spec: raw, note, version } = takeBody(req.body);
      if (version !== undefined && !isInt(version)) throw apiError(400, 'version must be a whole number');
      if (isObj(raw) && own(raw, 'id') && raw.id !== id) throw apiError(400, 'The id in the body must match the id in the URL');
      const spec = isObj(raw) ? Object.assign({}, raw, { id }) : raw;
      const v = validate(spec, { reviewer: false });
      if (!v.ok) return reject422(res, v.errors);
      await ensure();
      const s = v.spec, e = s.epistemic, actor = actorOf(req);
      let cur0 = {};
      const row = await tx(pool, async (c) => {
        const cur = (await c.query('SELECT * FROM patterns WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!cur) throw apiError(404, "Pattern '" + id + "' not found");
        cur0 = cur;
        if (cur.status !== 'draft') throw apiError(409, 'Only drafts can be edited (this pattern is ' + cur.status + '). A reviewer can send it back to draft first.');
        const se = statusErrors(spec, cur.status);
        if (se.length) throw apiError(422, 'Invalid pattern spec', { errors: se });
        if (version !== undefined && version !== cur.version) throw apiError(409, 'This pattern changed since you loaded it (now version ' + cur.version + ')');
        const r = await c.query(UPDATE_SQL, [id, s.plain, JSON.stringify(s), e.certainty, e.basis, e.claim, s.source.kind, actor]);
        await c.query(HISTORY_INSERT_SQL, [id, 'update', actor, cur.certainty, e.certainty, note, JSON.stringify(s), 'draft', 'draft']);
        return r.rows[0];
      });
      req.auditDetails = { from_certainty: cur0.certainty, to_certainty: e.certainty, version: row.version };
      res.json({ success: true, pattern: row });
    } catch (err) {
      if (err && err.status === 422 && err.errors) return reject422(res, err.errors);
      fail(res, 'Pattern update', err);
    }
  });
  // Fixed paths first: POST /api/patterns/seed does not clash with /:id/run, but keep it ahead of any /:id route.
  app.post('/api/patterns/seed', async (req, res) => {
    try {
      await ensure();
      const actor = actorOf(req), created = [], existing = [];
      for (const seed of SEEDS) {
        const v = validate(seed, { reviewer: false });
        if (!v.ok) throw apiError(500, 'Seed pattern ' + seed.id + ' is invalid: ' + JSON.stringify(v.errors));
        const s = v.spec, e = s.epistemic;
        const made = await tx(pool, async (c) => {
          const r = await c.query(INSERT_SQL, [s.id, s.plain, JSON.stringify(s), e.certainty, e.basis, e.claim, s.source.kind, actor]);
          if (!r.rows.length) return false;
          await c.query(HISTORY_INSERT_SQL, [s.id, 'create', actor, null, e.certainty, 'seed pattern', JSON.stringify(s), null, 'draft']);
          return true;
        });
        (made ? created : existing).push(s.id);
      }
      res.json({ success: true, created, existing });
    } catch (err) { fail(res, 'Pattern seed', err); }
  });

  // ---- create from one case (chunk 9). Reads one patient of the active cohort, abstracts the case, returns a DRAFT spec. Nothing is saved:
  // the tab loads the draft into the form and the person saves it with POST /api/patterns like any draft.
  // Body: { patient_id: '...', wording?: true, id?: 'my_pattern_id' }. Model wording is off unless PATTERN_CASE_MODEL_WORDING=true
  // (or helpers.caseWording) AND helpers.wordCase(abstractCase) -> { text, model, prompt_version } is wired (chunk 12).
  app.post('/api/patterns/from-case', json, async (req, res) => {
    try {
      const body = isObj(req.body) ? req.body : {};
      const pid = typeof body.patient_id === 'number' && Number.isSafeInteger(body.patient_id) ? String(body.patient_id) : (typeof body.patient_id === 'string' ? body.patient_id.trim() : '');
      if (!PATIENT_ID_RE.test(pid)) throw apiError(400, 'patient_id is required (letters, digits and . _ : - only)');
      if (own(body, 'id') && !(typeof body.id === 'string' && ID_RE.test(body.id))) throw apiError(400, 'id must match ' + ID_RE);
      if (own(body, 'wording') && typeof body.wording !== 'boolean') throw apiError(400, 'wording must be true or false');
      const wording = body.wording === true;
      if (wording) {   // refuse before any patient data is read
        const on = helpers.caseWording !== undefined ? !!helpers.caseWording : process.env[CASE_WORDING_SETTING] === 'true';
        if (!on) throw apiError(403, 'Model wording for single cases is switched off (setting ' + CASE_WORDING_SETTING + '). The draft can be made without it.');
        if (typeof helpers.wordCase !== 'function') throw apiError(501, 'No model connector is wired for case wording yet (chunk 12)');
      }

      if (!helpers.engine || typeof helpers.engine.resolveScope !== 'function') throw apiError(500, 'No scope engine is wired to the pattern module');
      const given = typeof helpers.scopeOf === 'function' ? ((await helpers.scopeOf(req)) || {}) : {};
      const ctx = await helpers.engine.resolveScope(Object.assign({}, given, { useCohort: true }));
      if (!ctx || typeof ctx.with !== 'string' || !ctx.with.trim()) throw apiError(409, 'No usable scope. Create or activate a cohort in the Analytics tab.');
      if (!ctx.cohort) throw apiError(409, 'No active cohort. Create or activate a cohort in the Analytics tab.');

      const db = helpers.readPool || pool;
      const got = (await readQuery(db, CASE_SQL(ctx.with), [pid])).rows;
      const prow = got.find((r) => r.dom === 'p');
      if (!prow) throw apiError(404, 'That patient is not in the active cohort');
      const recs = got.filter((r) => r.dom !== 'p');
      if (recs.length > CASE_MAX_RECORDS) throw apiError(422, 'This patient has more than ' + CASE_MAX_RECORDS + ' records; too many to abstract');
      const abs = abstractCase({ birth_date: prow.d, as_of: ctx.asOf || new Date(), records: recs.map((r) => ({ domain: r.dom, code: r.cd, date: r.d, end: r.e })) });
      const drafted = draftFromCase(abs, { id: body.id });
      let spec = drafted.spec;

      // How many patients in the cohort share this sequence? Fewer than the min-cell: the combination is rare and may identify the person.
      let privacy = { min_cell: minCellOf(helpers), checked: false, matched_in_cohort: null, rare_combination: false };
      try {
        const resolved = await resolveValueSets(spec, db);
        const built = buildSql(spec, { with: ctx.with }, resolved, { requireFollowUp: false });
        const sum = summarize((await readQuery(db, built.sql, built.params)).rows, { minCell: privacy.min_cell, limit: 1 });
        privacy = { min_cell: privacy.min_cell, checked: true, matched_in_cohort: sum.counts.matched, rare_combination: sum.counts.matched === null };
      } catch (e) { privacy.error = 'The cohort check could not run: ' + (e && e.message ? String(e.message).slice(0, 120) : 'error'); }
      privacy.note = privacy.rare_combination ? 'Fewer than ' + privacy.min_cell + ' patients in this cohort share this sequence. A rare sequence can identify a person: treat the draft and the case summary as patient data, and no model wording is allowed.'
        : (privacy.checked ? '' : 'Not checked against the cohort.');

      let usedModel = false;
      if (wording) {
        if (privacy.rare_combination || !privacy.checked) throw apiError(409, 'Model wording is not allowed for this case: ' + (privacy.rare_combination ? 'the sequence is rare in the cohort' : 'the rarity check did not run'));
        const w = await helpers.wordCase({ age_band: abs.age_band, events: abs.events.map((e) => ({ domain: e.domain, code: e.code, day: e.day })), span_days: abs.span_days });
        const text = w && typeof w.text === 'string' ? clean(w.text) : '';
        if (!text || text.length > LIMITS.maxPlain) throw apiError(502, 'The model wording was empty or too long');
        const again = validate(Object.assign({}, spec, { plain: text, source: Object.assign({}, spec.source, { model: String(w.model || 'unknown').slice(0, 80), prompt_version: String(w.prompt_version || 'unknown').slice(0, 80) }), epistemic: Object.assign({}, spec.epistemic, { basis: 'model_suggested' }) }), { reviewer: false });
        if (!again.ok) throw apiError(502, 'The model wording could not be used: ' + JSON.stringify(again.errors));
        spec = again.spec; usedModel = true;
      }

      req.auditTarget = pid;   // the audit log shows who looked at whose case; the pattern itself never holds it
      req.auditDetails = { action: 'pattern.from_case', events: drafted.used, external_ai: usedModel, rare_combination: privacy.rare_combination };
      res.json({
        success: true, draft: spec,
        case: { age_band: abs.age_band, n_records: abs.n_records, events: abs.events.map((e) => ({ domain: e.domain, code: e.code, day: e.day })), span_days: abs.span_days, undated_codes: abs.undated.length, dropped: abs.dropped, left_out: drafted.left_out },
        privacy, wording: { used: usedModel },
      });
    } catch (err) { fail(res, 'Pattern from case', err); }
  });


  // ---- create from a few cases (chunk 10). Body: { patient_ids: ['..', '..'], id?: 'my_pattern_id' }. Patients must be in the active cohort.
  // Only aggregates leave the mining step: codes shared by at least max(min-cell, half) of the patients, their usual order and the longest gap.
  // Fewer patients than the min-cell: refused, nothing is summarized. Returns a DRAFT (nothing saved); no model is involved.
  app.post('/api/patterns/from-cases', json, async (req, res) => {
    try {
      const body = isObj(req.body) ? req.body : {};
      if (!Array.isArray(body.patient_ids)) throw apiError(400, 'patient_ids must be a list of patient ids');
      const ids = Array.from(new Set(body.patient_ids.map((x) => (typeof x === 'number' && Number.isSafeInteger(x) ? String(x) : (typeof x === 'string' ? x.trim() : '')))));
      if (ids.some((x) => !PATIENT_ID_RE.test(x))) throw apiError(400, 'Every patient id must use letters, digits and . _ : - only');
      if (ids.length < FEW_MIN || ids.length > FEW_MAX) throw apiError(400, 'Give between ' + FEW_MIN + ' and ' + FEW_MAX + ' patient ids');
      if (own(body, 'id') && !(typeof body.id === 'string' && ID_RE.test(body.id))) throw apiError(400, 'id must match ' + ID_RE);
      const min = minCellOf(helpers);
      if (ids.length < min) throw apiError(422, 'Select at least ' + min + ' patients: a group smaller than the minimum cell is not summarized (it could identify a person).');

      if (!helpers.engine || typeof helpers.engine.resolveScope !== 'function') throw apiError(500, 'No scope engine is wired to the pattern module');
      const given = typeof helpers.scopeOf === 'function' ? ((await helpers.scopeOf(req)) || {}) : {};
      const ctx = await helpers.engine.resolveScope(Object.assign({}, given, { useCohort: true }));
      if (!ctx || typeof ctx.with !== 'string' || !ctx.with.trim()) throw apiError(409, 'No usable scope. Create or activate a cohort in the Analytics tab.');
      if (!ctx.cohort) throw apiError(409, 'No active cohort. Create or activate a cohort in the Analytics tab.');

      const db = helpers.readPool || pool;
      const rows = (await readQuery(db, FEW_SQL(ctx.with), [ids])).rows;
      if (rows.length > FEW_MAX_ROWS) throw apiError(422, 'These patients have too many records to abstract; select fewer');
      const by = new Map();
      for (const r of rows) { let g = by.get(r.pid); if (!g) { g = { birth: null, inCohort: false, recs: [] }; by.set(r.pid, g); } if (r.dom === 'p') { g.inCohort = true; g.birth = r.d; } else g.recs.push({ domain: r.dom, code: r.cd, date: r.d, end: r.e }); }
      const found = Array.from(by.values()).filter((g) => g.inCohort);
      const missing = ids.length - found.length;
      const abstracts = found.map((g) => abstractCase({ birth_date: g.birth, as_of: ctx.asOf || new Date(), records: g.recs }));
      const mined = mineCases(abstracts, { minCell: min, id: body.id });
      const privacy = await cohortShare(mined.spec, ctx, db, min);
      privacy.note = privacy.rare_combination ? 'Fewer than ' + min + ' patients in this cohort match the drafted sequence. Treat the draft as patient data.' : (privacy.checked ? '' : 'Not checked against the cohort.');

      req.auditTarget = 'n=' + found.length;   // who looked at a group of cases; the ids are not stored
      req.auditDetails = { action: 'pattern.from_cases', patients: found.length, events: mined.summary.events.length, external_ai: false, rare_combination: privacy.rare_combination };
      res.json({ success: true, draft: mined.spec, cases: Object.assign({ not_in_cohort: missing }, mined.summary), privacy, wording: { used: false } });
    } catch (err) { fail(res, 'Pattern from cases', err); }
  });

  // ---- review (chunk 8): status flow and certainty control. Reviewer only; every change goes to pattern_history and the audit log. ----
  // Body: { to: 'reviewed', note: 'why', version: 3 }
  // Delete: drafts and retired patterns only (a reviewed or active pattern is retired first, which keeps the decision in its history).
  // POST with a body, like the review routes: { note, version }. The reason is required; a retired pattern needs a reviewer.
  // History and saved runs go with the pattern (ON DELETE CASCADE). The audit log keeps who, why, the status and how many rows went.
  app.post('/api/patterns/:id/delete', json, async (req, res) => {
    try {
      const id = idOf(req); req.auditTarget = id;
      if (actorOf(req) === 'unknown') throw apiError(403, 'Sign in to delete a pattern');
      const b = isObj(req.body) ? req.body : {};
      const note = reason(b.note), version = needVersion(b.version);
      await ensure();
      const gone = await tx(pool, async (c) => {
        const cur = (await c.query('SELECT * FROM patterns WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!cur) throw apiError(404, "Pattern '" + id + "' not found");
        if (version !== cur.version) throw apiError(409, 'This pattern changed since you loaded it (now version ' + cur.version + ')');
        if (cur.status === 'retired') {
          if (!isReviewer(req)) throw apiError(403, 'Only a reviewer can delete a retired pattern');
        } else if (cur.status !== 'draft') {
          throw apiError(409, 'A ' + cur.status + ' pattern cannot be deleted. Retire it first.');
        }
        const n = (await c.query('SELECT (SELECT count(*) FROM pattern_history WHERE pattern_id = $1)::int AS history, (SELECT count(*) FROM pattern_runs WHERE pattern_id = $1)::int AS runs', [id])).rows[0] || {};
        await c.query('DELETE FROM patterns WHERE id = $1', [id]);
        return { status: cur.status, version: cur.version, history: Number(n.history) || 0, runs: Number(n.runs) || 0 };
      });
      req.auditDetails = Object.assign({}, gone, { note });
      res.json({ success: true, deleted: id, removed: { history: gone.history, runs: gone.runs } });
    } catch (err) {
      if (err && err.status === 422 && err.errors) return reject422(res, err.errors);
      fail(res, 'Pattern delete', err);
    }
  });

  app.post('/api/patterns/:id/status', json, async (req, res) => {
    try {
      const id = idOf(req); req.auditTarget = id;
      needReviewer(req);
      const b = isObj(req.body) ? req.body : {};
      if (!STATUSES.includes(b.to)) throw apiError(400, 'to must be one of ' + STATUSES.join(', '));
      const note = reason(b.note), version = needVersion(b.version), to = b.to, actor = actorOf(req);
      await ensure();
      let from = null, reset = false;
      const row = await tx(pool, async (c) => {
        const cur = (await c.query('SELECT * FROM patterns WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!cur) throw apiError(404, "Pattern '" + id + "' not found");
        if (version !== cur.version) throw apiError(409, 'This pattern changed since you loaded it (now version ' + cur.version + ')');
        from = cur.status;
        if (!canTransition(from, to)) throw apiError(409, 'A pattern that is ' + from + ' cannot become ' + to + (TRANSITIONS[from].length ? ' (allowed: ' + TRANSITIONS[from].join(', ') + ')' : ''));
        if (to === 'reviewed' && secondReviewer() && (actor === cur.created_by || actor === cur.updated_by)) {
          throw apiError(409, 'A second reviewer is required: the person who wrote or last edited this pattern cannot review it');
        }
        const spec = JSON.parse(JSON.stringify(cur.spec));
        spec.status = to;
        let certainty = cur.certainty, claim = cur.claim, bump = 0;
        // Back to draft means the logic may change, so a certainty that a reviewer raised no longer applies to it.
        if (to === 'draft' && RAISED.includes(cur.certainty)) {
          certainty = 'hypothesis'; reset = true; bump = 1;
          spec.epistemic = Object.assign({}, spec.epistemic, { certainty: 'hypothesis' });
          if (claim === 'causal') { claim = 'association'; spec.epistemic.claim = 'association'; }
        }
        const v = validate(spec, { reviewer: to !== 'draft' });
        if (!v.ok) throw apiError(422, 'Invalid pattern spec', { errors: v.errors });
        const r = await c.query(STATUS_UPDATE_SQL, [id, to, JSON.stringify(v.spec), certainty, claim, actor, bump]);
        await c.query(HISTORY_INSERT_SQL, [id, 'status', actor, cur.certainty, certainty, note + (reset ? ' [certainty reset to hypothesis: ' + cur.certainty + ' no longer applies once the logic can change]' : ''), JSON.stringify(v.spec), from, to]);
        return r.rows[0];
      });
      req.auditDetails = { from_status: from, to_status: to, to_certainty: row.certainty, certainty_reset: reset, version: row.version, note };
      res.json({ success: true, pattern: row });
    } catch (err) {
      if (err && err.status === 422 && err.errors) return reject422(res, err.errors);
      fail(res, 'Pattern status', err);
    }
  });

  // Body: { certainty, basis?, claim?, source_note?, note: 'why', version }. A reviewer records the real basis and the source.
  app.post('/api/patterns/:id/certainty', json, async (req, res) => {
    try {
      const id = idOf(req); req.auditTarget = id;
      needReviewer(req);
      const b = isObj(req.body) ? req.body : {};
      if (!CERTAINTY.includes(b.certainty)) throw apiError(400, 'certainty must be one of ' + CERTAINTY.join(', '));
      if (b.basis !== undefined && !BASIS.includes(b.basis)) throw apiError(400, 'basis must be one of ' + BASIS.join(', '));
      if (b.claim !== undefined && !CLAIM.includes(b.claim)) throw apiError(400, 'claim must be one of ' + CLAIM.join(', '));
      if (b.source_note !== undefined && typeof b.source_note !== 'string') throw apiError(400, 'source_note must be text');
      const note = reason(b.note), version = needVersion(b.version), actor = actorOf(req);
      if (RAISED.includes(b.certainty) && !(typeof b.source_note === 'string' && clean(b.source_note).length >= MIN_REASON)) {
        throw apiError(422, 'Invalid request', { errors: [{ path: 'source_note', message: 'name the guideline or citation that supports ' + b.certainty }] });
      }
      await ensure();
      let before = null;
      const row = await tx(pool, async (c) => {
        const cur = (await c.query('SELECT * FROM patterns WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!cur) throw apiError(404, "Pattern '" + id + "' not found");
        if (version !== cur.version) throw apiError(409, 'This pattern changed since you loaded it (now version ' + cur.version + ')');
        before = cur;
        if (cur.status === 'retired') throw apiError(409, 'A retired pattern keeps the certainty it had when it was retired');
        // Raising above "contested" is only for a pattern that has been reviewed; a draft stays at hypothesis or contested.
        if (RAISED.includes(b.certainty) && cur.status === 'draft') throw apiError(409, 'Review the pattern first: a draft cannot be raised above hypothesis');
        const spec = JSON.parse(JSON.stringify(cur.spec));
        const ep = Object.assign({}, spec.epistemic, { certainty: b.certainty });
        if (b.basis !== undefined) ep.basis = b.basis;
        if (b.claim !== undefined) ep.claim = b.claim;
        if (b.source_note !== undefined) ep.note = b.source_note;
        spec.epistemic = ep;
        // The same rules as every save, with reviewer rights: basis not model_suggested, a source note, causal needs support.
        const v = validate(spec, { reviewer: true });
        if (!v.ok) throw apiError(422, 'Invalid pattern spec', { errors: v.errors });
        const e = v.spec.epistemic;
        if (e.certainty === cur.certainty && e.basis === cur.basis && e.claim === cur.claim && e.note === (cur.spec.epistemic || {}).note) throw apiError(409, 'Nothing changed');
        const r = await c.query(UPDATE_SQL, [id, v.spec.plain, JSON.stringify(v.spec), e.certainty, e.basis, e.claim, v.spec.source.kind, actor]);
        await c.query(HISTORY_INSERT_SQL, [id, 'certainty', actor, cur.certainty, e.certainty, note, JSON.stringify(v.spec), cur.status, cur.status]);
        return r.rows[0];
      });
      req.auditDetails = { from_certainty: before.certainty, to_certainty: row.certainty, from_basis: before.basis, to_basis: row.basis, version: row.version, note };
      res.json({ success: true, pattern: row });
    } catch (err) {
      if (err && err.status === 422 && err.errors) return reject422(res, err.errors);
      fail(res, 'Pattern certainty', err);
    }
  });

  // Run a pattern on the ACTIVE cohort (same rule as care pathways). Body (all optional):
  //   { requireFollowUp: false, asOf: 'YYYY-MM-DD', limit: 50 }
  // Drafts, reviewed and active patterns may run on the active cohort; retired patterns may not.
  app.post('/api/patterns/:id/run', json, async (req, res) => {
    try {
      const id = idOf(req);
      const body = isObj(req.body) ? req.body : {};
      if (own(body, 'requireFollowUp') && typeof body.requireFollowUp !== 'boolean') throw apiError(400, 'requireFollowUp must be true or false');
      if (own(body, 'asOf') && !(typeof body.asOf === 'string' && ASOF_RE.test(body.asOf) && isoDay(new Date(body.asOf + 'T00:00:00Z')) === body.asOf)) throw apiError(400, 'asOf must be a date like 2024-12-31');
      if (own(body, 'limit') && !(isInt(body.limit) && body.limit >= 1 && body.limit <= MAX_MATCHES)) throw apiError(400, 'limit must be a whole number from 1 to ' + MAX_MATCHES);
      const opts = { requireFollowUp: body.requireFollowUp !== false };

      await ensure();
      const row = (await pool.query('SELECT * FROM patterns WHERE id = $1', [id])).rows[0];
      if (!row) throw apiError(404, "Pattern '" + id + "' not found");
      if (row.status === 'retired') throw apiError(409, 'Retired patterns cannot be run');
      // Runs exist only on the active cohort today, so a draft may run (to try it out); it is marked as not reviewed in the answer.
      // A run on a full scope, if one is ever added, must require status reviewed or active.
      const spec = row.spec;

      if (!helpers.engine || typeof helpers.engine.resolveScope !== 'function') throw apiError(500, 'No scope engine is wired to the pattern module');
      const given = typeof helpers.scopeOf === 'function' ? ((await helpers.scopeOf(req)) || {}) : {};
      const asked = Object.assign({}, given, { useCohort: true }, body.asOf ? { asOf: body.asOf } : {});
      const ctx = await helpers.engine.resolveScope(asked);
      if (!ctx || typeof ctx.with !== 'string' || !ctx.with.trim()) throw apiError(409, 'No usable scope. Create or activate a cohort in the Analytics tab.');
      if (!ctx.cohort) throw apiError(409, 'No active cohort. Create or activate a cohort in the Analytics tab.');

      const db = helpers.readPool || pool;
      const resolved = await resolveValueSets(spec, db);
      const built = buildSql(spec, { with: ctx.with }, resolved, { requireFollowUp: opts.requireFollowUp });
      const rows = (await readQuery(db, built.sql, built.params)).rows;

      const out = summarize(rows, { minCell: minCellOf(helpers), limit: body.limit });
      const labels = runLabels(spec, rows, resolved, labelSettings(helpers));
      const scope = describeScope(ctx, opts);
      const stored = {
        pattern_version: row.version, pattern_status: row.status, counts: out.counts, reasons: out.reasons, suppressed: out.suppressed, min_cell: out.min_cell,
        evaluable: out.evaluable, match_rate: out.match_rate, possible_reasons: explainReasons(spec, opts),
        links: resolved.links, codes_added: resolved.added, reliability: labels.reliability, evidence_mix: labels.evidence_mix,
      };
      const saved = (await pool.query(RUN_INSERT_SQL, [id, spec.spec_version || SPEC_VERSION, actorOf(req), JSON.stringify(scope), JSON.stringify(stored)])).rows[0];

      req.auditTarget = id; req.auditDetails = { status: row.status, version: row.version, run: saved && saved.id };
      res.json({
        success: true,
        run: { id: saved && saved.id, run_at: saved && saved.run_at },
        pattern: { id, status: row.status, reviewed: row.status === 'reviewed' || row.status === 'active', version: row.version, plain: row.plain, certainty: row.certainty, basis: row.basis, claim: row.claim },
        scope,
        result: Object.assign({}, stored, { matches: out.matches, truncated: out.truncated }),
        epistemic: Object.assign({}, spec.epistemic, { text: labels.epistemic_text }),
      });
    } catch (err) { fail(res, 'Pattern run', err); }
  });

  app.get('/api/patterns/:id/runs', async (req, res) => {
    try {
      const id = idOf(req);
      await ensure();
      const r = await pool.query(RUN_LIST_SQL, [id]);
      res.json({ success: true, runs: r.rows });
    } catch (err) { fail(res, 'Pattern runs', err); }
  });
}

// ---------- value sets and SQL builder (chunk 3) ----------
// Pure functions. resolveValueSets() reads only snomed_isa (through the db object you pass in);
// buildSql() makes one parameterized statement and never touches a database.
// No spec text is put into SQL: the only literals are event aliases (checked against ALIAS_RE),
// reason names made from them, fixed column names and fixed operators. Every code and number is a $n parameter.

const MAX_EXPANDED = 5000;   // most codes one value set may expand to
const COLS = {               // view -> code column, date column (see the views in analytics.js)
  dx: { code: 'code', date: 'onset_date' },
  rx: { code: 'code', date: 'prescribed_date' },
  ob: { code: 'code', date: 'effective_date' },
  pr: { code: 'code', date: 'performed_date' },
  en: { code: 'cls', date: 'start_date', end: 'end_date' },
  im: { code: 'code', date: 'occurrence_date' },
  al: { code: 'code', date: null },     // allergy date column not known: never used as a date
};
const OPS = { lt: '<', lte: '<=', gt: '>', gte: '>=', eq: '=' };

/**
 * resolveValueSets(spec, db) -> { codes: { name: [code,...] }, added: { name: n }, links: n | null }
 * mode "exact" keeps the listed codes. mode "descendants" adds every code below them in snomed_isa
 * (child_code -> parent_code), cycle safe. links is the number of is-a links loaded (null if no value set
 * asked for descendants). A missing snomed_isa table counts as "no links", so descendants then equal exact.
 * A value set that expands past MAX_EXPANDED codes is an error (422): narrow it.
 * db is anything with query(sql, params) -> { rows }, for example readPool.
 */
async function resolveValueSets(spec, db) {
  const codes = {}, added = {};
  let links = null;
  for (const name of Object.keys(spec.valuesets)) {
    const vs = spec.valuesets[name];
    const roots = Array.from(new Set(vs.codes));
    if (vs.mode !== 'descendants') { codes[name] = roots; added[name] = 0; continue; }
    if (links === null) {
      try { links = (await db.query('SELECT count(*)::int AS n FROM snomed_isa')).rows[0].n; }
      catch (e) { if (e && e.code === '42P01') links = 0; else throw e; }
    }
    if (links === 0) { codes[name] = roots; added[name] = 0; continue; }
    const r = await db.query(
      `WITH RECURSIVE d(code) AS (
         SELECT unnest($1::text[])
         UNION
         SELECT i.child_code FROM snomed_isa i JOIN d ON i.parent_code = d.code
       ) SELECT code FROM d LIMIT $2::int`, [roots, MAX_EXPANDED + 1]);
    if (r.rows.length > MAX_EXPANDED) throw apiError(422, "Value set '" + name + "' expands to more than " + MAX_EXPANDED + ' codes; use a narrower parent concept or exact codes');
    const out = r.rows.map((x) => x.code);
    for (const c of roots) if (!out.includes(c)) out.push(c);   // keep the listed codes even if the link table does not know them
    codes[name] = out; added[name] = out.length - roots.length;
  }
  return { codes, added, links };
}

/**
 * explainReasons(spec, opts) -> sorted list of the "cannot evaluate" reasons this spec can produce.
 *   <alias>_date_missing   a record was found but has no date (so the time relation cannot be judged)
 *   <alias>_value_missing  the latest result in the window has no numeric value
 *   <alias>_end_missing    the anchor encounter has no discharge (end) date, for return_within_days with from "end"
 *   followup_incomplete    the window is not over at the as-of date, so absence cannot be asserted yet
 */
function explainReasons(spec, opts) {
  const followUp = !(opts && opts.requireFollowUp === false);
  const out = new Set();
  const anchor = {};
  spec.events.forEach((ev) => { const m = PICK_AFTER.exec(ev.pick); anchor[ev.as] = m ? m[1] : null; });
  const dated = (x) => { for (let a = x; a; a = anchor[a]) out.add(a + '_date_missing'); };
  const refAlias = (r) => REF_RE.exec(r)[1];
  for (const w of spec.when) {
    for (const f of ['a', 'b', 'of', 'after']) if (w[f]) dated(refAlias(w[f]));
    if (w.rel === 'no_refill') { dated(w.event); out.add(w.event + '_date_missing'); if (followUp) out.add('followup_incomplete'); }
    if (w.rel === 'return_within_days' && w.from === 'end') out.add(refAlias(w.of) + '_end_missing');
    if (w.rel === 'none_in_window' || w.rel === 'return_within_days') { out.add(w.event + '_date_missing'); if (followUp) out.add('followup_incomplete'); }
    if (w.rel === 'latest_value_in_window') { out.add(w.event + '_date_missing'); out.add(w.event + '_value_missing'); }
    if (w.rel === 'count_at_least' && w.of) { out.add(w.event + '_date_missing'); if (followUp) out.add('followup_incomplete'); }
  }
  return Array.from(out).sort();
}

/**
 * buildSql(spec, scope, resolved, opts) -> { sql, params, columns }
 *   spec      a stored, validated spec
 *   scope     { with } from engine.resolveScope(): a WITH clause that defines the views p, dx, ob, rx, pr, en, al, im and ref(d)
 *   resolved  the result of resolveValueSets()
 *   opts      { requireFollowUp = true, paramOffset = 0 }
 * One row per eligible patient (a patient with at least one record of the first event's value set):
 *   patient_id, outcome ('matched' | 'not_matched' | 'cannot_evaluate'), reasons text[] (only for cannot_evaluate),
 *   records jsonb { alias: FHIR resource id }, codes jsonb { alias: matched code }.
 *
 * Rules. Every relation gives true, false or "cannot evaluate". One false makes the patient not_matched; otherwise
 * one cannot-evaluate makes them cannot_evaluate; otherwise matched. A record without a date is never guessed:
 *  - an event with records but none dated is <alias>_date_missing; an event with no records at all is false;
 *  - an absence rule (none_in_window, no_refill, a failed return_within_days or windowed count_at_least) says
 *    cannot-evaluate while the window runs past the as-of date (followup_incomplete) or while undated records exist;
 *  - before / after are strict (same day is neither); within_days is (a - of) days, so a before "of" is negative;
 *  - return_within_days counts records starting strictly after the anchor date (the start date, or the discharge date with from "end"), up to anchor + days; windows run from anchor + min to anchor + max, both ends included;
 *  - no_refill: no later record of the same value set within supply_days + grace_days after the picked fill.
 *  - Only the first reason that blocks a relation is reported for it.
 */
function buildSql(spec, scope, resolved, opts) {
  opts = opts || {};
  const followUp = opts.requireFollowUp !== false;
  if (!scope || typeof scope.with !== 'string' || !scope.with.trim()) throw apiError(400, 'buildSql needs the scope WITH clause');
  const chk = validate(spec, { reviewer: true });
  if (!chk.ok) throw apiError(422, 'Invalid pattern spec', { errors: chk.errors });
  spec = chk.spec;

  const params = [], base = opts.paramOffset || 0, memo = new Map();
  const P = (value, cast) => { params.push(value); return '$' + (base + params.length) + '::' + cast; };
  const codesP = (name) => {
    if (!memo.has(name)) {
      const list = resolved && resolved.codes && resolved.codes[name];
      if (!Array.isArray(list) || !list.length) throw apiError(400, "Value set '" + name + "' has no resolved codes");
      memo.set(name, P(list, 'text[]'));
    }
    return memo.get(name);
  };
  const safeAlias = (a) => { if (!ALIAS_RE.test(a)) throw apiError(400, 'bad alias'); return a; };

  const evs = spec.events.map((ev) => ({ as: safeAlias(ev.as), vs: ev.valueset, dom: spec.valuesets[ev.valueset].domain, pick: ev.pick,
    anchor: (PICK_AFTER.exec(ev.pick) || [])[1] || null }));
  const byAlias = {}; evs.forEach((e) => { byAlias[e.as] = e; });
  const ctes = [];

  // candidates (all records of the value set), undated/total counts, and the one picked record per patient
  for (const e of evs) {
    const col = COLS[e.dom];
    const dateSql = col.date ? '(' + col.date + ')::date' : 'NULL::date';
    const endSql = col.end ? '(' + col.end + ')::date' : 'NULL::date';
    const val = e.dom === 'ob' ? ", CASE WHEN value::text ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN value::text::numeric END AS v" : '';
    ctes.push(`pat_c_${e.as} AS (SELECT patient_id, ${dateSql} AS d, ${endSql} AS e, j->>'id' AS rid, ${col.code} AS cd${val} FROM ${e.dom} WHERE ${col.code} = ANY(${codesP(e.vs)}))`);
    ctes.push(`pat_u_${e.as} AS (SELECT patient_id, count(*) AS n, count(*) FILTER (WHERE d IS NULL) AS n_undated FROM pat_c_${e.as} GROUP BY patient_id)`);
    if (e.pick === 'any') continue;
    if (e.anchor) {
      ctes.push(`pat_e_${e.as} AS (SELECT DISTINCT ON (c.patient_id) c.patient_id, c.d, c.e, c.rid, c.cd FROM pat_c_${e.as} c JOIN pat_e_${e.anchor} x ON x.patient_id = c.patient_id WHERE c.d IS NOT NULL AND c.d >= x.d ORDER BY c.patient_id, c.d, c.rid)`);
    } else {
      const dir = e.pick === 'last' ? 'DESC' : 'ASC';
      ctes.push(`pat_e_${e.as} AS (SELECT DISTINCT ON (patient_id) patient_id, d, e, rid, cd FROM pat_c_${e.as} WHERE d IS NOT NULL ORDER BY patient_id, d ${dir}, rid)`);
    }
  }

  // status of a single-date event: have / missing (records exist, none dated) / absent
  const have = (x) => `pat_e_${x}.d IS NOT NULL`;
  const undated = (x) => `COALESCE(pat_u_${x}.n_undated, 0) > 0`;
  const miss = (x) => { const a = byAlias[x].anchor; return `(NOT (${have(x)}) AND (${undated(x)}${a ? ' OR ' + miss(a) : ''}))`; };
  const reasonOf = (x) => { const a = byAlias[x].anchor; return a ? `(CASE WHEN ${undated(x)} THEN '${x}_date_missing' ELSE ${reasonOf(a)} END)` : `'${x}_date_missing'`; };
  const absent = (x) => `(NOT (${have(x)}) AND NOT ${miss(x)})`;
  const aliasOf = (ref) => safeAlias(REF_RE.exec(ref)[1]);
  const asOf = '(SELECT d FROM ref)';

  // CASE with the guard arms for the single-date events a relation reads, then its own arms
  const guarded = (refs, arms, last) => {
    const set = Array.from(new Set(refs)), out = ['CASE'];
    if (set.length) out.push(`WHEN ${set.map(absent).join(' OR ')} THEN 'f'`);
    for (const x of set) out.push(`WHEN ${miss(x)} THEN 'u:' || ${reasonOf(x)}`);
    return out.concat(arms).concat([`ELSE '${last}' END`]).join(' ');
  };
  const dm = (x) => `WHEN ${undated(x)} THEN 'u:${x}_date_missing'`;
  const fu = (dateSql) => (followUp ? [`WHEN ${dateSql()} > ${asOf} THEN 'u:followup_incomplete'`] : []);   // dateSql is a function so no parameter is bound when the check is off

  const rels = [], joins = [];
  spec.when.forEach((w, i) => {
    const W = 'pat_w' + i;
    const win = (r) => `c.d IS NOT NULL AND c.d BETWEEN a.d + ${P(r[0], 'int')} AND a.d + ${P(r[1], 'int')}`;
    switch (w.rel) {
      case 'within_days': {
        const a = aliasOf(w.a), o = aliasOf(w.of);
        rels.push(guarded([a, o], [`WHEN (pat_e_${a}.d - pat_e_${o}.d) BETWEEN ${P(w.range[0], 'int')} AND ${P(w.range[1], 'int')} THEN 't'`], 'f'));
        break;
      }
      case 'before': case 'after': {
        const a = aliasOf(w.a), b = aliasOf(w.b);
        rels.push(guarded([a, b], [`WHEN pat_e_${a}.d ${w.rel === 'before' ? '<' : '>'} pat_e_${b}.d THEN 't'`], 'f'));
        break;
      }
      case 'none_in_window': {
        const E = safeAlias(w.event), R = aliasOf(w.after);
        ctes.push(`${W} AS (SELECT a.patient_id, count(*) AS n FROM pat_c_${E} c JOIN pat_e_${R} a ON a.patient_id = c.patient_id WHERE ${win(w.range)} GROUP BY a.patient_id)`);
        joins.push(W);
        rels.push(guarded([R], [`WHEN COALESCE(${W}.n, 0) > 0 THEN 'f'`, dm(E)].concat(fu(() => `pat_e_${R}.d + ${P(w.range[1], 'int')}`)), 't'));
        break;
      }
      case 'no_refill': {
        const E = safeAlias(w.event), len = `(${P(w.supply_days, 'int')} + ${P(w.grace_days, 'int')})`;
        ctes.push(`${W} AS (SELECT a.patient_id, count(*) AS n FROM pat_c_${E} c JOIN pat_e_${E} a ON a.patient_id = c.patient_id WHERE c.d IS NOT NULL AND c.d > a.d AND c.d <= a.d + ${len} GROUP BY a.patient_id)`);
        joins.push(W);
        rels.push(guarded([E], [`WHEN COALESCE(${W}.n, 0) > 0 THEN 'f'`, dm(E)].concat(fu(() => `pat_e_${E}.d + ${len}`)), 't'));
        break;
      }
      case 'return_within_days': {
        const E = safeAlias(w.event), R = aliasOf(w.of), fromEnd = w.from === 'end', col = fromEnd ? 'e' : 'd';
        ctes.push(`${W} AS (SELECT a.patient_id, count(*) AS n FROM pat_c_${E} c JOIN pat_e_${R} a ON a.patient_id = c.patient_id WHERE c.d IS NOT NULL AND c.d > a.${col} AND c.d <= a.${col} + ${P(w.days, 'int')} GROUP BY a.patient_id)`);
        joins.push(W);
        const arms = [`WHEN COALESCE(${W}.n, 0) > 0 THEN 't'`, dm(E)];
        if (fromEnd) arms.unshift(`WHEN pat_e_${R}.e IS NULL THEN 'u:${R}_end_missing'`);
        rels.push(guarded([R], arms.concat(fu(() => `pat_e_${R}.${col} + ${P(w.days, 'int')}`)), 'f'));
        break;
      }
      case 'latest_value_in_window': {
        const E = safeAlias(w.event), R = aliasOf(w.of);
        ctes.push(`${W} AS (SELECT DISTINCT ON (a.patient_id) a.patient_id, c.v FROM pat_c_${E} c JOIN pat_e_${R} a ON a.patient_id = c.patient_id WHERE ${win(w.range)} ORDER BY a.patient_id, c.d DESC, c.rid DESC)`);
        joins.push(W);
        rels.push(guarded([R], [`WHEN ${W}.patient_id IS NULL AND ${undated(E)} THEN 'u:${E}_date_missing'`, `WHEN ${W}.patient_id IS NULL THEN 'f'`,
          `WHEN ${W}.v IS NULL THEN 'u:${E}_value_missing'`, `WHEN ${W}.v ${OPS[w.op]} ${P(w.value, 'numeric')} THEN 't'`], 'f'));
        break;
      }
      case 'count_at_least': {
        const E = safeAlias(w.event);
        if (!w.of) { rels.push(`CASE WHEN COALESCE(pat_u_${E}.n, 0) >= ${P(w.count, 'int')} THEN 't' ELSE 'f' END`); break; }
        const R = aliasOf(w.of);
        ctes.push(`${W} AS (SELECT a.patient_id, count(*) AS n FROM pat_c_${E} c JOIN pat_e_${R} a ON a.patient_id = c.patient_id WHERE ${win(w.range)} GROUP BY a.patient_id)`);
        joins.push(W);
        const k = P(w.count, 'int');
        rels.push(guarded([R], [`WHEN COALESCE(${W}.n, 0) >= ${k} THEN 't'`, `WHEN COALESCE(${W}.n, 0) + COALESCE(pat_u_${E}.n_undated, 0) >= ${k} THEN 'u:${E}_date_missing'`]
          .concat(fu(() => `pat_e_${R}.d + ${P(w.range[1], 'int')}`)), 'f'));
        break;
      }
      default: throw apiError(400, 'unknown relation');
    }
  });

  const single = evs.filter((e) => e.pick !== 'any');
  const joinSql = []
    .concat(single.map((e) => `LEFT JOIN pat_e_${e.as} ON pat_e_${e.as}.patient_id = b.patient_id`))
    .concat(evs.map((e) => `LEFT JOIN pat_u_${e.as} ON pat_u_${e.as}.patient_id = b.patient_id`))
    .concat(joins.map((w) => `LEFT JOIN ${w} ON ${w}.patient_id = b.patient_id`)).join('\n    ');
  const keys = (col) => (single.length ? 'jsonb_strip_nulls(jsonb_build_object(' + single.map((e) => `'${e.as}', pat_e_${e.as}.${col}`).join(', ') + '))' : "'{}'::jsonb");

  ctes.push(`pat_base AS (SELECT DISTINCT c.patient_id FROM pat_c_${evs[0].as} c JOIN p ON p.patient_id = c.patient_id)`);
  ctes.push(`pat_res AS (SELECT b.patient_id, ARRAY[${rels.join(',\n      ')}]::text[] AS rs, ${keys('rid')} AS records, ${keys('cd')} AS codes
    FROM pat_base b
    ${joinSql})`);
  ctes.push(`pat_fin AS (SELECT patient_id, records, codes, rs,
      CASE WHEN 'f' = ANY(rs) THEN 'not_matched' WHEN EXISTS (SELECT 1 FROM unnest(rs) AS x WHERE x <> 't') THEN 'cannot_evaluate' ELSE 'matched' END AS outcome
    FROM pat_res)`);

  const sql = scope.with + ',\n' + ctes.join(',\n') + `
SELECT patient_id, outcome,
       CASE WHEN outcome = 'cannot_evaluate' THEN ARRAY(SELECT DISTINCT substr(x, 3) FROM unnest(rs) AS x WHERE x LIKE 'u:%' ORDER BY 1) ELSE ARRAY[]::text[] END AS reasons,
       records, codes
FROM pat_fin`;
  return { sql, params, columns: ['patient_id', 'outcome', 'reasons', 'records', 'codes'] };
}

// In-memory stand-in for the owner pool: just enough SQL for the routes above.
function fakePool() {
  const st = { patterns: new Map(), history: [], ensures: 0, runs: [] };
  let hid = 0;
  const run = async (sql, p) => {
    p = p || [];
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
    if (/CREATE TABLE IF NOT EXISTS patterns/.test(sql)) { st.ensures++; return { rows: [] }; }
    if (/^\s*INSERT INTO patterns/.test(sql)) {
      if (st.patterns.has(p[0])) return { rows: [] };
      const row = { id: p[0], status: 'draft', plain: p[1], spec: JSON.parse(p[2]), certainty: p[3], basis: p[4], claim: p[5], source_kind: p[6], version: 1,
        created_by: p[7], created_at: new Date(), updated_by: p[7], updated_at: new Date() };
      st.patterns.set(p[0], row); return { rows: [row] };
    }
    if (/^\s*INSERT INTO pattern_history/.test(sql)) {
      st.history.push({ id: ++hid, pattern_id: p[0], action: p[1], changed_by: p[2], from_certainty: p[3], to_certainty: p[4], note: p[5], from_status: p[7], to_status: p[8], changed_at: new Date() });
      return { rows: [] };
    }
    if (/^\s*SELECT \* FROM patterns WHERE id = \$1/.test(sql)) { const r = st.patterns.get(p[0]); return { rows: r ? [JSON.parse(JSON.stringify(r))] : [] }; }   // a copy, like a real row
    if (/^\s*UPDATE patterns SET status/.test(sql)) {
      const r = st.patterns.get(p[0]);
      Object.assign(r, { status: p[1], spec: JSON.parse(p[2]), certainty: p[3], claim: p[4], updated_by: p[5], version: r.version + p[6], updated_at: new Date() });
      return { rows: [r] };
    }
    if (/^\s*UPDATE patterns SET/.test(sql)) {
      const r = st.patterns.get(p[0]);
      Object.assign(r, { plain: p[1], spec: JSON.parse(p[2]), certainty: p[3], basis: p[4], claim: p[5], source_kind: p[6], updated_by: p[7], version: r.version + 1, updated_at: new Date() });
      return { rows: [r] };
    }
    if (/^\s*INSERT INTO pattern_runs/.test(sql)) {
      const row = { id: st.runs.length + 1, pattern_id: p[0], spec_version: p[1], run_by: p[2], scope: JSON.parse(p[3]), result: JSON.parse(p[4]), run_at: new Date() };
      st.runs.push(row); return { rows: [{ id: row.id, run_at: row.run_at }] };
    }
    if (/^\s*SELECT \(SELECT count\(\*\) FROM pattern_history/.test(sql)) return { rows: [{ history: st.history.filter((h) => h.pattern_id === p[0]).length, runs: st.runs.filter((r) => r.pattern_id === p[0]).length }] };
    if (/^\s*DELETE FROM patterns WHERE id/.test(sql)) {
      const had = st.patterns.delete(p[0]);
      st.history = st.history.filter((h) => h.pattern_id !== p[0]); st.runs = st.runs.filter((r) => r.pattern_id !== p[0]);   // ON DELETE CASCADE
      return { rows: [], rowCount: had ? 1 : 0 };
    }
    if (/FROM pattern_runs WHERE pattern_id/.test(sql)) return { rows: st.runs.filter((r) => r.pattern_id === p[0]).reverse() };
    if (/FROM pattern_history WHERE pattern_id/.test(sql)) return { rows: st.history.filter((h) => h.pattern_id === p[0]).reverse() };
    if (/^\s*SELECT spec FROM patterns WHERE status = ANY/.test(sql)) return { rows: Array.from(st.patterns.values()).filter((r) => p[0].includes(r.status)).sort((a, b) => (a.id < b.id ? -1 : 1)).map((r) => ({ spec: JSON.parse(JSON.stringify(r.spec)) })) };
    if (/^\s*SELECT id, plain, status/.test(sql)) {
      let rows = Array.from(st.patterns.values());
      if (/WHERE status = \$1/.test(sql)) rows = rows.filter((r) => r.status === p[0]);
      return { rows: rows.map((r) => { const o = Object.assign({}, r); delete o.spec; return o; }) };   // the real query lists columns without spec
    }
    throw new Error('fake pool: unexpected SQL ' + String(sql).slice(0, 60));
  };
  return { st, query: run, connect: async () => ({ query: run, release() {} }) };
}

async function builderSelftest(good, n) {
  const assert = require('assert');
  const t = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const SCOPE = { with: "WITH p AS (SELECT 1 AS patient_id), dx AS (SELECT 1), ref AS (SELECT DATE '2024-12-31' AS d)" };
  const resolved = { codes: { viral: ['34014006', '111', '222'], antibac: ['J01CA04'] } };
  const tail = (b) => b.sql.slice(SCOPE.with.length);
  // stand-in for snomed_isa: answers the two queries resolveValueSets asks
  const isa = (links, noTable) => ({ query: async (sql, p) => {
    if (/count\(\*\)/.test(sql)) { if (noTable) throw Object.assign(new Error('relation does not exist'), { code: '42P01' }); return { rows: [{ n: links.length }] }; }
    if (/WITH RECURSIVE/.test(sql)) {
      const seen = new Set(p[0]); let grew = true;
      while (grew) { grew = false; for (const [c, par] of links) if (seen.has(par) && !seen.has(c)) { seen.add(c); grew = true; } }
      return { rows: Array.from(seen).slice(0, p[1]).map((code) => ({ code })) };
    }
    throw new Error('unexpected SQL');
  } });
  const rooted = () => { const s = clone(good); s.valuesets.viral.codes = ['V']; return validate(s).spec; };

  console.log('value sets and SQL builder');
  await t('exact value sets are returned as listed, without touching the database', async () => {
    const s = clone(good); s.valuesets.viral.mode = 'exact';
    const out = await resolveValueSets(validate(s).spec, { query: async () => { throw new Error('db touched'); } });
    assert.deepStrictEqual(out.codes.viral, ['34014006']); assert.strictEqual(out.links, null);
  });
  await t('descendants expand through levels and survive a cycle in the links', async () => {
    const out = await resolveValueSets(rooted(), isa([['V1', 'V'], ['V2', 'V1'], ['V', 'V2'], ['X9', 'Z']]));
    assert.deepStrictEqual(out.codes.viral.sort(), ['V', 'V1', 'V2']);
    assert.strictEqual(out.added.viral, 2); assert.strictEqual(out.links, 4);
    assert.deepStrictEqual(out.codes.antibac, ['J01CA04']);
  });
  await t('descendants with no links, or no snomed_isa table, fall back to the listed codes', async () => {
    for (const db of [isa([]), isa([], true)]) {
      const out = await resolveValueSets(rooted(), db);
      assert.deepStrictEqual(out.codes.viral, ['V']); assert.strictEqual(out.links, 0); assert.strictEqual(out.added.viral, 0);
    }
  });
  await t('an expansion past the limit is a 422', async () => {
    const links = []; for (let i = 0; i < MAX_EXPANDED + 1; i++) links.push(['C' + i, 'V']);
    await assert.rejects(resolveValueSets(rooted(), isa(links)), (e) => e.status === 422 && /more than/.test(e.message));
  });
  await t('other database errors are not swallowed', async () => {
    await assert.rejects(resolveValueSets(rooted(), { query: async () => { throw new Error('connection lost'); } }), /connection lost/);
  });

  await t('buildSql binds every code and number as a $n parameter, and no code reaches the SQL text', async () => {
    const b = buildSql(validate(good).spec, SCOPE, resolved);
    const body = tail(b);
    for (const c of ['34014006', '111', '222', 'J01CA04']) assert.ok(!body.includes(c), 'code in SQL: ' + c);
    assert.deepStrictEqual(b.params[0], resolved.codes.viral);
    assert.deepStrictEqual(b.params[1], resolved.codes.antibac);
    for (let i = 1; i <= b.params.length; i++) assert.ok(body.includes('$' + i + '::'), 'parameter $' + i + ' unused or untyped');
    assert.ok(!/\$[0-9]+(?!::)/.test(body.replace(/\$[0-9]+::/g, '')), 'a parameter without a cast');
    assert.ok(b.params.includes(0) && b.params.includes(3) && b.params.includes(45) && b.params.includes(5));
    assert.ok(body.startsWith(',\npat_c_dx') && /FROM pat_fin$/.test(body));
  });
  await t('the only literals in the SQL are fixed words and event aliases', async () => {
    const body = tail(buildSql(validate(good).spec, SCOPE, resolved));
    const lits = body.match(/'[^']*'/g) || [];
    assert.ok(lits.length > 0);
    for (const l of lits) assert.ok(/^'(t|f|u:|u:%|matched|not_matched|cannot_evaluate|u:[a-z][a-z0-9_]*|[a-z][a-z0-9_]*)'$/.test(l), 'unexpected literal ' + l);
  });
  await t('text fields (plain, note, tags, source) never reach the SQL', async () => {
    const s = clone(good); s.plain = "x'; DROP TABLE patterns; --"; s.epistemic.note = "'; DELETE FROM dx; --"; s.epistemic.tags = ['sneaky'];
    const b = buildSql(validate(s).spec, SCOPE, resolved);
    for (const bad of ['DROP', 'DELETE', 'sneaky', 'patterns;']) assert.ok(!tail(b).includes(bad), bad);
  });
  await t('two events on one value set share one code parameter', async () => {
    const s = clone(good); s.events.push({ as: 'dx2', valueset: 'viral', pick: 'last' });
    const b = buildSql(validate(s).spec, SCOPE, resolved);
    assert.strictEqual(b.params.filter((p) => Array.isArray(p) && p[0] === '34014006').length, 1);
  });
  await t('paramOffset shifts the numbering', async () => {
    const b = buildSql(validate(good).spec, SCOPE, resolved, { paramOffset: 3 });
    assert.ok(tail(b).includes('$4::text[]') && !tail(b).includes('$1::'));
  });
  await t('cannot-evaluate reasons: each one explainReasons lists is in the SQL (missing dates land in cannot evaluate)', async () => {
    const spec = validate(good).spec;
    const why = explainReasons(spec);
    assert.deepStrictEqual(why, ['abx_date_missing', 'dx_date_missing', 'followup_incomplete']);
    const body = tail(buildSql(spec, SCOPE, resolved));
    for (const r of why) assert.ok(body.includes("'" + r + "'") || body.includes("'u:" + r + "'"), 'reason not in SQL: ' + r);
    assert.ok(body.includes("'u:' ||") && body.includes("'cannot_evaluate'"));
    assert.deepStrictEqual(explainReasons(spec, { requireFollowUp: false }), ['abx_date_missing', 'dx_date_missing']);
    assert.ok(!tail(buildSql(spec, SCOPE, resolved, { requireFollowUp: false })).includes('followup_incomplete'));
  });
  await t('a first_on_or_after event passes its anchor\'s missing date on as the reason', async () => {
    const s = clone(good); s.when = [{ rel: 'within_days', a: 'abx.date', of: 'abx.date', range: [0, 1] }];
    assert.ok(explainReasons(validate(s).spec).includes('dx_date_missing'));
  });
  await t('every relation builds, and value comparisons are typed parameters', async () => {
    const s = clone(good);
    s.valuesets.lab = { domain: 'ob', codes: ['HBA1C'], mode: 'exact' }; s.valuesets.stay = { domain: 'en', codes: ['IMP'], mode: 'exact' };
    s.events.push({ as: 'hb', valueset: 'lab', pick: 'any' }, { as: 'adm', valueset: 'stay', pick: 'first' });
    s.when = [
      { rel: 'within_days', a: 'abx.date', of: 'dx.date', range: [0, 3] }, { rel: 'before', a: 'dx.date', b: 'abx.date' }, { rel: 'after', a: 'abx.date', b: 'dx.date' },
      { rel: 'none_in_window', event: 'dx', after: 'dx.date', range: [7, 30] }, { rel: 'no_refill', event: 'abx', supply_days: 5, grace_days: 45 },
      { rel: 'return_within_days', event: 'adm', of: 'adm.date', days: 30 },
      { rel: 'latest_value_in_window', event: 'hb', of: 'dx.date', range: [0, 365], op: 'gte', value: 6.5 },
      { rel: 'count_at_least', event: 'adm', count: 2 }, { rel: 'count_at_least', event: 'adm', count: 2, of: 'dx.date', range: [0, 365] }];
    const sp = validate(s); assert.ok(sp.ok, JSON.stringify(sp.errors));
    const b = buildSql(sp.spec, SCOPE, { codes: Object.assign({ lab: ['HBA1C'], stay: ['IMP'] }, resolved.codes) });
    assert.ok(b.params.includes(6.5) && tail(b).includes('::numeric'));
    assert.ok(explainReasons(sp.spec).includes('hb_value_missing'));
    for (let i = 1; i <= b.params.length; i++) assert.ok(tail(b).includes('$' + i + '::'));
  });
  await t('buildSql refuses an invalid spec (422), a missing scope (400) and an unresolved value set (400)', async () => {
    const bad = clone(good); bad.when.push({ rel: 'sql_where' });
    assert.throws(() => buildSql(bad, SCOPE, resolved), (e) => e.status === 422 && e.errors.length > 0);
    assert.throws(() => buildSql(validate(good).spec, {}, resolved), (e) => e.status === 400);
    assert.throws(() => buildSql(validate(good).spec, SCOPE, { codes: { viral: ['1'] } }), (e) => e.status === 400);
  });
  return n;
}

async function routeSelftest(good, n) {
  const assert = require('assert');
  const express = require('express');
  const t = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const pool = fakePool();
  const app = express();
  register(app, pool, { fail: (res, label, err) => res.status(err.status || 500).json({ success: false, error: err.message }) });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  try {
    console.log('routes (in-memory store)');
    await t('POST creates a draft, version 1, with history', async () => {
      const r = await call('POST', '/api/patterns', good);
      assert.strictEqual(r.status, 201, JSON.stringify(r.json));
      assert.strictEqual(r.json.pattern.status, 'draft');
      assert.strictEqual(r.json.pattern.version, 1);
      assert.strictEqual(pool.st.history.length, 1);
      assert.strictEqual(pool.st.ensures, 1);
    });
    await t('POST with the same id is 409', async () => {
      assert.strictEqual((await call('POST', '/api/patterns', good)).status, 409);
    });
    await t('POST with an invalid spec is 422 and stores nothing', async () => {
      const bad = clone(good); bad.id = 'other_one'; bad.when.push({ rel: 'sql_where' });
      const r = await call('POST', '/api/patterns', bad);
      assert.strictEqual(r.status, 422);
      assert.ok(r.json.errors.length > 0);
      assert.strictEqual(pool.st.patterns.size, 1);
    });
    await t('POST with no body or a non-object is 422', async () => {
      assert.strictEqual((await call('POST', '/api/patterns')).status, 422);
      assert.strictEqual((await call('POST', '/api/patterns', [1, 2])).status, 422);
    });
    await t('POST cannot set a status, or a certainty above hypothesis', async () => {
      const a = clone(good); a.id = 'sneaky_status'; a.status = 'active';
      assert.strictEqual((await call('POST', '/api/patterns', a)).status, 422);
      const b = clone(good); b.id = 'sneaky_cert'; b.source = { kind: 'library' };
      b.epistemic = { certainty: 'established', basis: 'guideline', claim: 'descriptive', note: 'WHO 2020' };
      assert.strictEqual((await call('POST', '/api/patterns', b)).status, 422);
      assert.strictEqual(pool.st.patterns.size, 1);
    });
    await t('POST accepts the { spec, note } form', async () => {
      const c = clone(good); c.id = 'wrapped_form';
      const r = await call('POST', '/api/patterns', { spec: c, note: 'first draft' });
      assert.strictEqual(r.status, 201, JSON.stringify(r.json));
      assert.strictEqual(pool.st.history[pool.st.history.length - 1].note, 'first draft');
    });
    await t('GET list returns summaries and filters by status', async () => {
      const r = await call('GET', '/api/patterns');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.patterns.length, 2);
      assert.strictEqual(r.json.patterns[0].spec, undefined);
      assert.strictEqual((await call('GET', '/api/patterns?status=active')).json.patterns.length, 0);
      assert.strictEqual((await call('GET', '/api/patterns?status=bogus')).status, 400);
    });
    await t('GET one returns the spec and history; unknown is 404; bad id is 400', async () => {
      const r = await call('GET', '/api/patterns/' + good.id);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.pattern.spec.id, good.id);
      assert.strictEqual(r.json.history.length, 1);
      assert.strictEqual((await call('GET', '/api/patterns/not_there')).status, 404);
      assert.strictEqual((await call('GET', '/api/patterns/Bad%20Id')).status, 400);
    });
    await t('PUT edits a draft, bumps the version and writes history', async () => {
      const u = clone(good); u.plain = 'Edited wording.';
      const r = await call('PUT', '/api/patterns/' + good.id, { spec: u, note: 'reworded', version: 1 });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(r.json.pattern.version, 2);
      assert.strictEqual(r.json.pattern.plain, 'Edited wording.');
      assert.strictEqual((await call('GET', '/api/patterns/' + good.id)).json.history.length, 2);
    });
    await t('PUT with a stale version is 409', async () => {
      const r = await call('PUT', '/api/patterns/' + good.id, { spec: clone(good), version: 1 });
      assert.strictEqual(r.status, 409);
    });
    await t('PUT with an id that differs from the URL is 400; an invalid spec is 422; unknown is 404', async () => {
      const m = clone(good); m.id = 'someone_else';
      assert.strictEqual((await call('PUT', '/api/patterns/' + good.id, m)).status, 400);
      const bad = clone(good); bad.when[0].range = [9, 1];
      assert.strictEqual((await call('PUT', '/api/patterns/' + good.id, bad)).status, 422);
      const nf = clone(good); nf.id = 'not_there';
      assert.strictEqual((await call('PUT', '/api/patterns/not_there', nf)).status, 404);
    });
    await t('PUT cannot change the status, and only drafts are editable', async () => {
      const u = clone(good); u.status = 'active';
      assert.strictEqual((await call('PUT', '/api/patterns/' + good.id, u)).status, 422);
      pool.st.patterns.get(good.id).status = 'reviewed';   // simulate a later review step
      const r = await call('PUT', '/api/patterns/' + good.id, clone(good));
      assert.strictEqual(r.status, 409);
      pool.st.patterns.get(good.id).status = 'draft';
    });
    await t('a failed table setup is retried on the next request', async () => {
      const p2 = fakePool(); let first = true;
      const orig = p2.query; p2.query = async (sql, p) => { if (/CREATE TABLE IF NOT EXISTS patterns/.test(sql) && first) { first = false; throw new Error('db down'); } return orig(sql, p); };
      const a2 = express(); register(a2, p2, { fail: (res, l, e) => res.status(500).json({ success: false, error: e.message }) });
      const s2 = await new Promise((resolve) => { const s = a2.listen(0, '127.0.0.1', () => resolve(s)); });
      try {
        const u = 'http://127.0.0.1:' + s2.address().port + '/api/patterns';
        assert.strictEqual((await fetch(u)).status, 500);
        assert.strictEqual((await fetch(u)).status, 200);
      } finally { s2.close(); }
    });
  } finally { server.close(); }
  return n;
}

async function runSelftest(good, n) {
  const assert = require('assert');
  const express = require('express');
  const t = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const pool = fakePool();
  const calls = { scope: [], sql: [], tx: [] };
  let scopeCtx = { with: "WITH p AS (SELECT 1 AS patient_id), ref AS (SELECT DATE '2024-12-31' AS d)", cohort: { id: 7, name: 'Admitted 2024' }, population: 'synthetic batch', asOf: '2024-12-31', patients: [1, 2, 3] };
  let rows = [];
  const readPool = {
    query: async () => { throw Object.assign(new Error('relation "snomed_isa" does not exist'), { code: '42P01' }); },   // no link table: descendants equal the listed codes
    connect: async () => ({ query: async (sql, p) => { calls.tx.push(String(sql).split(' ').slice(0, 2).join(' ')); if (/^\s*(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] }; calls.sql.push({ sql, p }); return { rows }; }, release() {} }),
  };
  const engine = { resolveScope: async (o) => { calls.scope.push(o); return scopeCtx; } };
  const app = express();
  register(app, pool, { fail: (res, label, err) => res.status(err.status || 500).json({ success: false, error: err.message }), readPool, engine, scopeOf: () => ({ batchId: 'b1', cohortId: 7 }), minCell: 5 });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  try {
    console.log('run endpoint (in-memory store, fake scope and read pool)');
    await t('seed stores three drafts once and is safe to repeat', async () => {
      const a = await call('POST', '/api/patterns/seed');
      assert.strictEqual(a.status, 200); assert.strictEqual(a.json.created.length, 3); assert.deepStrictEqual(a.json.existing, []);
      const b = await call('POST', '/api/patterns/seed');
      assert.strictEqual(b.json.created.length, 0); assert.strictEqual(b.json.existing.length, 3);
      assert.ok(Array.from(pool.st.patterns.values()).every((p) => p.status === 'draft'));
    });
    await t('run uses the active cohort scope, a read-only transaction, only $n parameters, and saves a run', async () => {
      rows = [];
      for (let i = 0; i < 8; i++) rows.push({ patient_id: 'm' + i, outcome: 'matched', reasons: [], records: { adm: 'enc' + i }, codes: { adm: 'IMP' } });
      for (let i = 0; i < 20; i++) rows.push({ patient_id: 'n' + i, outcome: 'not_matched', reasons: [], records: {}, codes: {} });
      for (let i = 0; i < 2; i++) rows.push({ patient_id: 'c' + i, outcome: 'cannot_evaluate', reasons: ['adm_end_missing'], records: {}, codes: {} });
      const r = await call('POST', '/api/patterns/readmit_30d_after_discharge/run', {});
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.deepStrictEqual(calls.scope[0], { batchId: 'b1', cohortId: 7, useCohort: true });
      assert.deepStrictEqual(calls.tx.slice(0, 3), ['BEGIN READ', 'SET LOCAL', 'WITH p']);
      const q = calls.sql[0]; assert.ok(/e\) AS e|end_date\)::date AS e/.test(q.sql)); assert.ok(!/IMP/.test(q.sql)); assert.deepStrictEqual(q.p[0], ['IMP']);
      assert.ok(/c\.d > a\.e AND c\.d <= a\.e \+ \$\d+::int/.test(q.sql), 'measured from the discharge date');
      assert.deepStrictEqual(r.json.result.counts, { eligible: null, matched: 8, not_matched: 20, cannot_evaluate: null });
      assert.deepStrictEqual(r.json.result.reasons, [{ reason: 'adm_end_missing', count: null, hidden: true }]);
      assert.strictEqual(r.json.result.matches.length, 8); assert.strictEqual(r.json.result.matches[0].records.adm, 'enc0');
      assert.deepStrictEqual(r.json.scope, { population: 'synthetic batch', cohort: 'Admitted 2024', patients: 3, as_of: '2024-12-31', require_follow_up: true });
      assert.ok(r.json.result.possible_reasons.includes('adm_end_missing'));
      assert.strictEqual(pool.st.runs.length, 1); assert.strictEqual(pool.st.runs[0].pattern_id, 'readmit_30d_after_discharge');
      assert.ok(!('matches' in pool.st.runs[0].result), 'the saved run holds counts only, no patient list');
      assert.strictEqual(pool.st.runs[0].result.counts.matched, 8);
      const list = await call('GET', '/api/patterns/readmit_30d_after_discharge/runs');
      assert.strictEqual(list.json.runs.length, 1);
    });
    await t('run passes asOf and requireFollowUp, and limits the match list', async () => {
      const r = await call('POST', '/api/patterns/viral_abx_short_course/run', { asOf: '2024-06-30', requireFollowUp: false, limit: 3 });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(calls.scope[1].asOf, '2024-06-30'); assert.strictEqual(r.json.result.matches.length, 3); assert.strictEqual(r.json.result.truncated, true);
      assert.strictEqual(r.json.scope.require_follow_up, false); assert.ok(!r.json.result.possible_reasons.includes('followup_incomplete'));
    });
    await t('run without an active cohort is 409 and nothing is queried or saved', async () => {
      const before = calls.sql.length, saved = pool.st.runs.length;
      scopeCtx = Object.assign({}, scopeCtx, { cohort: null });
      const r = await call('POST', '/api/patterns/readmit_30d_after_discharge/run', {});
      assert.strictEqual(r.status, 409); assert.ok(/cohort/i.test(r.json.error));
      assert.strictEqual(calls.sql.length, before); assert.strictEqual(pool.st.runs.length, saved);
      scopeCtx = Object.assign({}, scopeCtx, { cohort: { id: 7, name: 'Admitted 2024' } });
    });
    await t('run: unknown pattern 404, retired 409, bad id or body 400', async () => {
      assert.strictEqual((await call('POST', '/api/patterns/nope_nope/run', {})).status, 404);
      pool.st.patterns.get('drug_within_90d_of_dx').status = 'retired';
      assert.strictEqual((await call('POST', '/api/patterns/drug_within_90d_of_dx/run', {})).status, 409);
      pool.st.patterns.get('drug_within_90d_of_dx').status = 'draft';
      assert.strictEqual((await call('POST', '/api/patterns/Bad-Id/run', {})).status, 400);
      for (const b of [{ asOf: '31/12/2024' }, { asOf: '2024-02-31' }, { limit: 0 }, { limit: 9999 }, { requireFollowUp: 'no' }]) {
        assert.strictEqual((await call('POST', '/api/patterns/viral_abx_short_course/run', b)).status, 400, JSON.stringify(b));
      }
    });
    await t('a query that times out is reported as 504 and the transaction is rolled back', async () => {
      const slow = { query: readPool.query, connect: async () => ({ query: async (sql) => { calls.tx.push(String(sql).split(' ')[0]); if (/^\s*WITH/.test(sql)) throw Object.assign(new Error('canceling statement'), { code: '57014' }); return { rows: [] }; }, release() {} }) };
      const a2 = express(); register(a2, pool, { fail: (res, l, e) => res.status(e.status || 500).json({ success: false, error: e.message }), readPool: slow, engine, scopeOf: () => ({}) });
      const s2 = await new Promise((resolve) => { const s = a2.listen(0, '127.0.0.1', () => resolve(s)); });
      try {
        const r = await fetch('http://127.0.0.1:' + s2.address().port + '/api/patterns/viral_abx_short_course/run', { method: 'POST' });
        assert.strictEqual(r.status, 504); assert.strictEqual(calls.tx[calls.tx.length - 1], 'ROLLBACK');
      } finally { s2.close(); }
    });
    await t('the discharge anchor SQL has no spec text in it: codes and numbers are parameters', async () => {
      const spec = validate(SEEDS[1]).spec;
      const b = buildSql(spec, { with: 'WITH p AS (SELECT 1 AS patient_id), en AS (SELECT 1), ref AS (SELECT 1)' }, { codes: { stay: ['IMP'] } });
      assert.ok(!/IMP|\b30\b/.test(b.sql.replace(/\$\d+::[a-z\[\]]+/g, ''))); assert.ok(/adm_end_missing/.test(b.sql));
    });

    await t('labels: thin, gappy, weak_hierarchy, evidence_mix and epistemic text in every run result', async () => {
      rows = [];
      for (let i = 0; i < 4; i++) rows.push({ patient_id: 'm' + i, outcome: 'matched', reasons: [], records: {}, codes: {} });
      for (let i = 0; i < 6; i++) rows.push({ patient_id: 'c' + i, outcome: 'cannot_evaluate', reasons: ['followup_incomplete'], records: {}, codes: {} });
      const r = await call('POST', '/api/patterns/viral_abx_short_course/run', {});
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.deepStrictEqual(r.json.result.reliability.map((x) => x.id), ['thin', 'gappy', 'weak_hierarchy']);
      assert.deepStrictEqual(r.json.result.evidence_mix, { documented: true, derived: true, inferred: false });
      assert.ok(/Hypothesis/.test(r.json.epistemic.text) && /association, not a cause/.test(r.json.epistemic.text));
      assert.deepStrictEqual(pool.st.runs[pool.st.runs.length - 1].result.reliability.length, 3);
      rows = [];
      for (let i = 0; i < 40; i++) rows.push({ patient_id: 'm' + i, outcome: 'matched', reasons: [], records: {}, codes: {} });
      const ok2 = await call('POST', '/api/patterns/readmit_30d_after_discharge/run', {});
      assert.deepStrictEqual(ok2.json.result.reliability, []); assert.strictEqual(ok2.json.result.evidence_mix.derived, false);
    });
    await t('label thresholds are settings; hierarchy above the demo size is not weak', async () => {
      const spec = validate(SEEDS[2]).spec, mk = (k, o) => Array.from({ length: k }, (_, i) => ({ outcome: o, patient_id: o + i }));
      const rows2 = mk(10, 'matched');
      const ids = (st, links) => runLabels(spec, rows2, { links }, Object.assign(labelSettings({}), st)).reliability.map((x) => x.id);
      assert.deepStrictEqual(ids({}, 5000), ['thin']);
      assert.deepStrictEqual(ids({ thin_n: 5 }, 5000), []);
      assert.deepStrictEqual(ids({ thin_n: 5 }, 47), ['weak_hierarchy']);
      assert.deepStrictEqual(ids({ thin_n: 5, demo_links: 10 }, 47), []);
      const gap = rows2.concat(mk(5, 'cannot_evaluate'));
      assert.deepStrictEqual(runLabels(spec, gap, { links: 5000 }, { thin_n: 5, gappy_pct: 30, demo_links: 47 }).reliability.map((x) => x.id), ['gappy']);
      assert.deepStrictEqual(labelSettings({ settings: { thin_n: 'x' } }), { thin_n: 20, gappy_pct: 30, demo_links: 47 });
    });
  } finally { server.close(); }
  return n;
}

// Chunk 8: review flow, certainty control, who may do what, history and audit details.
async function reviewSelftest(good, n) {
  const assert = require('assert');
  const express = require('express');
  const t = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const pool = fakePool();
  const app = express();
  let audit = null;
  app.use((req, res, next) => {           // test stand-in for the sign-in layer: header "email|role"
    const h = req.get('x-user');
    if (h) { const [email, role] = h.split('|'); req.user = { email: email || undefined, role }; }
    res.on('finish', () => { audit = { target: req.auditTarget, details: req.auditDetails, status: res.statusCode }; });
    next();
  });
  const helpers = { fail: (res, label, err) => res.status(err.status || 500).json({ success: false, error: err.message }),
    can: (u, perm) => perm === 'patterns:review' && (u.role === 'reviewer' || u.role === 'admin'), secondReviewer: false };
  register(app, pool, helpers);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const ANN = 'ann@example.org|analyst', REV = 'rae@example.org|reviewer', ADM = 'admin@example.org|admin';
  const call = async (method, path, body, who) => {
    const r = await fetch(base + path, { method, headers: Object.assign({ 'content-type': 'application/json' }, who ? { 'x-user': who } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  const row = (id) => pool.st.patterns.get(id);
  const hist = (id) => pool.st.history.filter((h) => h.pattern_id === id);
  const setStatus = (id, to, who, note) => call('POST', '/api/patterns/' + id + '/status', { to, note: note || 'checked', version: row(id).version }, who || REV);
  try {
    console.log('review flow (in-memory store)');
    const g = clone(good); g.id = 'rev_one';
    await t('the signed-in email is the changed-by name', async () => {
      const r = await call('POST', '/api/patterns', g, ANN);
      assert.strictEqual(r.status, 201, JSON.stringify(r.json));
      assert.strictEqual(r.json.pattern.created_by, 'ann@example.org');
      assert.deepStrictEqual(hist('rev_one').map((h) => [h.action, h.changed_by, h.from_status, h.to_status]), [['create', 'ann@example.org', null, 'draft']]);
      assert.deepStrictEqual(audit.details, { to_status: 'draft', to_certainty: 'hypothesis' }); assert.strictEqual(audit.target, 'rev_one');
    });
    await t('only a reviewer can change status or certainty: analysts, anonymous users and users without a name are refused', async () => {
      const st = { to: 'reviewed', note: 'looks right', version: 1 };
      for (const who of [ANN, undefined, '|reviewer']) {
        assert.strictEqual((await call('POST', '/api/patterns/rev_one/status', st, who)).status, 403);
        assert.strictEqual((await call('POST', '/api/patterns/rev_one/certainty', { certainty: 'contested', note: 'x y z', version: 1 }, who)).status, 403);
      }
      assert.strictEqual(row('rev_one').status, 'draft'); assert.strictEqual(hist('rev_one').length, 1);
    });
    await t('a status change needs a note, the version you saw, a real status and an allowed step', async () => {
      const post = (b, who) => call('POST', '/api/patterns/rev_one/status', b, who || REV);
      let r = await post({ to: 'reviewed', version: 1 }); assert.strictEqual(r.status, 422); assert.strictEqual(r.json.errors[0].path, 'note');
      r = await post({ to: 'reviewed', note: ' ', version: 1 }); assert.strictEqual(r.status, 422);
      assert.strictEqual((await post({ to: 'reviewed', note: 'ok ok' })).status, 400);
      assert.strictEqual((await post({ to: 'published', note: 'ok ok', version: 1 })).status, 400);
      r = await post({ to: 'active', note: 'skip review', version: 1 }); assert.strictEqual(r.status, 409); assert.ok(/draft cannot become active/.test(r.json.error));
      assert.strictEqual((await post({ to: 'reviewed', note: 'ok ok', version: 7 })).status, 409);
      assert.strictEqual((await call('POST', '/api/patterns/nope_nope/status', { to: 'reviewed', note: 'ok ok', version: 1 }, REV)).status, 404);
      assert.strictEqual(row('rev_one').status, 'draft');
    });
    await t('draft to reviewed: same version, spec status kept in step, history and audit record who, from, to and why', async () => {
      const r = await setStatus('rev_one', 'reviewed', REV, 'Logic checked against the guideline');
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(r.json.pattern.status, 'reviewed'); assert.strictEqual(r.json.pattern.version, 1);
      assert.strictEqual(row('rev_one').spec.status, 'reviewed'); assert.strictEqual(row('rev_one').updated_by, 'rae@example.org');
      const h = hist('rev_one').pop();
      assert.deepStrictEqual([h.action, h.changed_by, h.from_status, h.to_status, h.note], ['status', 'rae@example.org', 'draft', 'reviewed', 'Logic checked against the guideline']);
      assert.deepStrictEqual(audit.details, { from_status: 'draft', to_status: 'reviewed', to_certainty: 'hypothesis', certainty_reset: false, version: 1, note: 'Logic checked against the guideline' });
      assert.strictEqual(audit.target, 'rev_one');
    });
    await t('GET shows the history with statuses, and tells each user what they may do', async () => {
      let r = await call('GET', '/api/patterns/rev_one', undefined, REV);
      assert.strictEqual(r.json.review.can_review, true); assert.deepStrictEqual(r.json.review.transitions, ['active', 'draft', 'retired']);
      assert.deepStrictEqual(r.json.history.map((h) => h.to_status), ['reviewed', 'draft']);
      r = await call('GET', '/api/patterns/rev_one', undefined, ANN); assert.strictEqual(r.json.review.can_review, false);
    });
    await t('a reviewed pattern cannot be edited, and a refused change leaves no trace in the history', async () => {
      const u = clone(row('rev_one').spec); u.plain = 'changed';
      assert.strictEqual((await call('PUT', '/api/patterns/rev_one', u, ANN)).status, 409);
      const before = hist('rev_one').length;
      await setStatus('rev_one', 'draft', ANN);
      assert.strictEqual(hist('rev_one').length, before);
    });
    await t('certainty: a draft cannot be raised; a raise needs a basis that is not model_suggested, a source, a reason and a reviewer', async () => {
      const d = clone(good); d.id = 'rev_draft'; await call('POST', '/api/patterns', d, ANN);
      const up = (id, b, who) => call('POST', '/api/patterns/' + id + '/certainty', Object.assign({ version: row(id).version }, b), who || REV);
      let r = await up('rev_draft', { certainty: 'supported', basis: 'literature', source_note: 'Smith 2019', note: 'raise' });
      assert.strictEqual(r.status, 409); assert.ok(/Review the pattern first/.test(r.json.error));
      const m = clone(good); m.id = 'rev_model'; m.source = { kind: 'few_cases', n: 12, model: 'model-x' }; delete m.epistemic;
      r = await call('POST', '/api/patterns', m, ANN); assert.strictEqual(r.status, 201, JSON.stringify(r.json)); assert.strictEqual(r.json.pattern.basis, 'model_suggested');
      await setStatus('rev_model', 'reviewed');
      r = await up('rev_model', { certainty: 'supported', source_note: 'Smith 2019', note: 'raise' });
      assert.strictEqual(r.status, 422); assert.ok(r.json.errors.some((e) => e.path === 'epistemic.basis'), 'a model draft stays at hypothesis until a reviewer records the real basis');
      assert.strictEqual(row('rev_model').certainty, 'hypothesis');
      assert.strictEqual((await up('rev_model', { certainty: 'supported', basis: 'model_suggested', source_note: 'Smith 2019', note: 'raise' })).status, 422);
      r = await up('rev_one', { certainty: 'supported', basis: 'literature', note: 'raise' }); assert.strictEqual(r.status, 422); assert.strictEqual(r.json.errors[0].path, 'source_note');
      r = await up('rev_one', { certainty: 'supported', basis: 'literature', source_note: 'Smith 2019' }); assert.strictEqual(r.status, 422); assert.strictEqual(r.json.errors[0].path, 'note');
      assert.strictEqual((await up('rev_one', { certainty: 'supported', basis: 'literature', source_note: 'Smith 2019', note: 'raise' }, ANN)).status, 403);
      assert.strictEqual((await up('rev_one', { certainty: 'certain', note: 'raise' })).status, 400);
      assert.strictEqual((await up('rev_one', { certainty: 'supported', claim: 'causal', basis: 'literature', source_note: 'Smith 2019', note: 'raise' })).status, 200, 'causal is fine once certainty is supported');
    });
    await t('a raise changes version, certainty, basis, source note and spec together; history and audit say from and to', async () => {
      const p = row('rev_one'), e = p.spec.epistemic;
      assert.deepStrictEqual([p.certainty, p.basis, p.claim, p.version, e.certainty, e.basis, e.note, p.status], ['supported', 'literature', 'causal', 2, 'supported', 'literature', 'Smith 2019', 'reviewed']);
      const h = hist('rev_one').pop();
      assert.deepStrictEqual([h.action, h.from_certainty, h.to_certainty, h.from_status, h.to_status, h.note, h.changed_by], ['certainty', 'hypothesis', 'supported', 'reviewed', 'reviewed', 'raise', 'rae@example.org']);
      assert.deepStrictEqual(audit.details, { from_certainty: 'hypothesis', to_certainty: 'supported', from_basis: 'observed_in_data', to_basis: 'literature', version: 2, note: 'raise' });
      const r = await call('POST', '/api/patterns/rev_one/certainty', { certainty: 'supported', basis: 'literature', claim: 'causal', source_note: 'Smith 2019', note: 'again', version: 2 }, REV);
      assert.strictEqual(r.status, 409); assert.ok(/Nothing changed/.test(r.json.error));
    });
    await t('reviewed to active to retired; a retired pattern keeps its certainty and cannot run or change', async () => {
      assert.strictEqual((await setStatus('rev_one', 'active', ADM)).status, 200);
      assert.strictEqual((await setStatus('rev_one', 'retired', REV, 'replaced by a newer pattern')).status, 200);
      assert.strictEqual(row('rev_one').status, 'retired'); assert.strictEqual(row('rev_one').certainty, 'supported');
      const r = await call('POST', '/api/patterns/rev_one/certainty', { certainty: 'contested', note: 'doubt', version: row('rev_one').version }, REV);
      assert.strictEqual(r.status, 409);
      assert.deepStrictEqual(hist('rev_one').filter((h) => h.action === 'status').map((h) => h.to_status), ['reviewed', 'active', 'retired']);
    });
    await t('back to draft resets a raised certainty (and a causal claim) and says so in the history; the draft can be edited again', async () => {
      const r = await setStatus('rev_one', 'draft', REV, 'logic needs a change');
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      const p = row('rev_one');
      assert.deepStrictEqual([p.status, p.certainty, p.claim, p.spec.epistemic.certainty, p.spec.epistemic.claim, p.version], ['draft', 'hypothesis', 'association', 'hypothesis', 'association', 3]);
      const h = hist('rev_one').pop(); assert.ok(/certainty reset to hypothesis: supported/.test(h.note)); assert.strictEqual(h.from_certainty, 'supported'); assert.strictEqual(h.to_certainty, 'hypothesis');
      assert.strictEqual(audit.details.certainty_reset, true);
      const u = clone(p.spec); u.plain = 'Edited after review.';
      assert.strictEqual((await call('PUT', '/api/patterns/rev_one', { spec: u, version: 3, note: 'edit' }, ANN)).status, 200);
    });
    await t('contested can be set by a reviewer on a reviewed pattern, and needs the note the validator asks for', async () => {
      await setStatus('rev_draft', 'reviewed');
      const r = await call('POST', '/api/patterns/rev_draft/certainty', { certainty: 'contested', note: 'two guidelines disagree', version: row('rev_draft').version }, REV);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json)); assert.strictEqual(row('rev_draft').certainty, 'contested');
      const down = await call('POST', '/api/patterns/rev_draft/certainty', { certainty: 'hypothesis', source_note: '', note: 'back down', version: row('rev_draft').version }, REV);
      assert.strictEqual(down.status, 200, 'hypothesis needs no source note');
    });
    await t('second reviewer rule (optional): the author or last editor cannot approve their own pattern', async () => {
      helpers.secondReviewer = true;
      const x = clone(good); x.id = 'rev_four_eyes';
      await call('POST', '/api/patterns', x, REV);
      let r = await setStatus('rev_four_eyes', 'reviewed', REV); assert.strictEqual(r.status, 409); assert.ok(/second reviewer/.test(r.json.error));
      r = await setStatus('rev_four_eyes', 'reviewed', ADM); assert.strictEqual(r.status, 200);
      helpers.secondReviewer = false;
      const y = clone(good); y.id = 'rev_self'; await call('POST', '/api/patterns', y, REV);
      assert.strictEqual((await setStatus('rev_self', 'reviewed', REV)).status, 200, 'off by default');
    });
    await t('delete: drafts and retired patterns only; a name, a reason and the version you saw are required; reviewers delete retired ones; history and runs go too', async () => {
      const d = clone(good); d.id = 'del_draft'; await call('POST', '/api/patterns', d, ANN);
      pool.st.runs.push({ id: 99, pattern_id: 'del_draft', spec_version: 1, run_by: 'x', scope: {}, result: {}, run_at: new Date() });
      const del = (id, b, who) => call('POST', '/api/patterns/' + id + '/delete', b, who);
      assert.strictEqual((await del('del_draft', { note: 'not needed', version: 1 })).status, 403);
      let r = await del('del_draft', { version: 1 }, ANN); assert.strictEqual(r.status, 422); assert.strictEqual(r.json.errors[0].path, 'note');
      assert.strictEqual((await del('del_draft', { note: 'not needed' }, ANN)).status, 400);
      assert.strictEqual((await del('del_draft', { note: 'not needed', version: 9 }, ANN)).status, 409);
      assert.strictEqual((await del('nope_nope', { note: 'not needed', version: 1 }, ANN)).status, 404);
      assert.strictEqual((await call('POST', '/api/patterns/bad%20id/delete', { note: 'not needed', version: 1 }, ANN)).status, 400);
      assert.ok(row('del_draft'));
      r = await del('del_draft', { note: 'duplicate of another', version: 1 }, ANN);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json)); assert.strictEqual(r.json.deleted, 'del_draft'); assert.deepStrictEqual(r.json.removed, { history: 1, runs: 1 });
      assert.strictEqual(row('del_draft'), undefined); assert.strictEqual(hist('del_draft').length, 0); assert.strictEqual(pool.st.runs.filter((x) => x.pattern_id === 'del_draft').length, 0);
      assert.deepStrictEqual(audit.details, { status: 'draft', version: 1, history: 1, runs: 1, note: 'duplicate of another' }); assert.strictEqual(audit.target, 'del_draft');
      const rr = clone(good); rr.id = 'del_rev'; await call('POST', '/api/patterns', rr, ANN); await setStatus('del_rev', 'reviewed');
      r = await del('del_rev', { note: 'not needed', version: row('del_rev').version }, REV);
      assert.strictEqual(r.status, 409); assert.ok(/Retire it first/.test(r.json.error)); assert.ok(row('del_rev'));
      await setStatus('del_rev', 'retired');
      assert.strictEqual((await del('del_rev', { note: 'not needed', version: row('del_rev').version }, ANN)).status, 403); assert.ok(row('del_rev'));
      assert.strictEqual((await del('del_rev', { note: 'retired and replaced', version: row('del_rev').version }, REV)).status, 200);
      assert.strictEqual(audit.details.status, 'retired');
      assert.strictEqual((await call('GET', '/api/patterns/del_rev', undefined, REV)).status, 404);
    });
    await t('the status table is closed: every arrow leads to a real status, none to itself, every status can be reached', async () => {
      const keys = Object.keys(TRANSITIONS); assert.deepStrictEqual(keys.sort(), STATUSES.slice().sort());
      const reach = new Set(['draft']); let grew = true;
      while (grew) { grew = false; for (const k of Array.from(reach)) for (const to of TRANSITIONS[k]) if (!reach.has(to)) { reach.add(to); grew = true; } }
      assert.strictEqual(reach.size, STATUSES.length);
      for (const [from, tos] of Object.entries(TRANSITIONS)) for (const to of tos) { assert.ok(STATUSES.includes(to)); assert.notStrictEqual(from, to); }
      assert.ok(!canTransition('draft', 'active') && canTransition('reviewed', 'active') && !canTransition('nope', 'draft'));
    });
    await t('actorOf: email first; dev name only when auth is off and not in production; otherwise unknown', async () => {
      const keep = { a: process.env.AUTH_DISABLED, n: process.env.NODE_ENV };
      try {
        process.env.AUTH_DISABLED = 'false'; delete process.env.NODE_ENV;
        assert.strictEqual(actorOf({ user: { id: 3, email: 'a@b.org', role: 'admin' } }), 'a@b.org'); assert.strictEqual(actorOf({}), 'unknown');
        process.env.AUTH_DISABLED = 'true'; assert.strictEqual(actorOf({}), 'dev@localhost');
        process.env.NODE_ENV = 'production'; assert.strictEqual(actorOf({}), 'unknown');
      } finally { for (const [k, v] of [['AUTH_DISABLED', keep.a], ['NODE_ENV', keep.n]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
    });
  } finally { server.close(); }
  console.log(n + ' tests passed');
}

// ---------- chunk 9 self-test: create from one case ----------
async function caseSelftest(good, n) {
  const assert = require('assert');
  const express = require('express');
  const t = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };
  console.log('create from one case (abstraction, draft, route)');
  const PLANTED = ['pt-12345', 'Jane Doe', '221B Baker Street', '1980-04-02', 'crushing chest pain', '2024-03-05', '2024-03-19', '2024-06-01', 'Springfield'];
  const planted = {
    birth_date: '1980-04-02', as_of: '2024-12-31', name: 'Jane Doe', address: '221B Baker Street, Springfield', patient_id: 'pt-12345',
    records: [
      { domain: 'rx', code: 'A10BA02', date: '2024-03-19', id: 'rx-1', note: 'Jane Doe prefers mornings' },
      { domain: 'dx', code: '44054006', date: '2024-03-05', id: 'dx-1', narrative: 'crushing chest pain since Monday' },
      { domain: 'dx', code: '44054006', date: '2024-03-05', id: 'dx-2' },                       // same code, same day: one event
      { domain: 'dx', code: 'crushing chest pain', date: '2024-03-05' },                       // free text where a code belongs: dropped
      { domain: 'en', code: 'IMP', date: '2024-06-01', end: '2024-06-04' },
      { domain: 'ob', code: '4548-4', date: null },                                            // no date: cannot be ordered
      { domain: 'al', code: '91935009', date: '2024-03-05' },                                   // allergies have no date column: dropped
    ],
  };
  const hasNone = (obj, label) => { const s = JSON.stringify(obj); for (const p of PLANTED) assert.ok(!s.includes(p), label + ' still holds ' + p); };

  await t('abstractCase keeps only domain, code, day offsets and an age band; no identifier, name, address, date or text survives', () => {
    const a = abstractCase(planted);
    hasNone(a, 'abstraction');
    assert.strictEqual(a.age_band, '40-49'); assert.strictEqual(a.span_days, 88); assert.strictEqual(a.dropped, 2);
    assert.deepStrictEqual(a.events, [
      { domain: 'dx', code: '44054006', day: 0, end_day: null }, { domain: 'rx', code: 'A10BA02', day: 14, end_day: null }, { domain: 'en', code: 'IMP', day: 88, end_day: 91 }]);
    assert.deepStrictEqual(a.undated, [{ domain: 'ob', code: '4548-4' }]);
    assert.deepStrictEqual(Object.keys(a).sort(), ['age_band', 'dropped', 'events', 'n_records', 'span_days', 'undated']);
  });
  await t('age band: ten-year bands, 80+ at the top, birthday not yet reached counts one year less, unknown stays null', () => {
    assert.strictEqual(ageBand('2000-06-01', '2024-05-31'), '20-29'); assert.strictEqual(ageBand('2000-06-01', '2024-06-01'), '20-29');
    assert.strictEqual(ageBand('2000-06-01', '2020-05-31'), '10-19'); assert.strictEqual(ageBand('1930-01-01', '2024-12-31'), '80+');
    assert.strictEqual(ageBand(null, '2024-12-31'), null); assert.strictEqual(ageBand('2030-01-01', '2024-12-31'), null);
    assert.strictEqual(abstractCase({ records: [] }).age_band, null);
  });
  await t('abstractCase ignores anything outside its fixed field list, even if it is hostile', () => {
    const a = abstractCase({ records: [{ domain: 'dx', code: '1', date: '2024-01-01', __proto__: { evil: 1 }, toString: 'x', extra: 'John' }, 'text', null, { domain: 'zz', code: '1', date: '2024-01-01' }] });
    assert.strictEqual(a.events.length, 1); assert.strictEqual(a.dropped, 3); hasNone(a, 'abstraction'); assert.ok(!JSON.stringify(a).includes('John'));
  });
  await t('draftFromCase: a valid draft, hypothesis from observed data, chained events with the gap as the window, exact value sets, no case data', () => {
    const d = draftFromCase(abstractCase(planted));
    const v = validate(d.spec, { reviewer: false }); assert.ok(v.ok, JSON.stringify(v.errors)); assert.deepStrictEqual(v.spec, d.spec);
    assert.strictEqual(d.spec.status, 'draft'); assert.deepStrictEqual(d.spec.source, { kind: 'one_case', n: 1 });
    assert.strictEqual(d.spec.epistemic.certainty, 'hypothesis'); assert.strictEqual(d.spec.epistemic.basis, 'observed_in_data'); assert.strictEqual(d.spec.epistemic.claim, 'descriptive');
    assert.deepStrictEqual(d.spec.events.map((e) => e.pick), ['first', 'first_on_or_after:dx1', 'first_on_or_after:rx1']);
    assert.deepStrictEqual(d.spec.when.map((w) => [w.a, w.of, w.range]), [['rx1.date', 'dx1.date', [0, 14]], ['en1.date', 'rx1.date', [0, 74]]]);
    assert.ok(Object.values(d.spec.valuesets).every((x) => x.mode === 'exact' && x.codes.length === 1));
    assert.ok(/^case_draft_[0-9a-f]{8}$/.test(d.spec.id)); assert.ok(d.spec.plain.length <= LIMITS.maxPlain);
    hasNone(d.spec, 'draft');
    assert.strictEqual(draftFromCase(abstractCase(planted), { id: 'mine' }).spec.id, 'mine');
  });
  await t('draftFromCase: one event gives a draft with no time relation; ten events at most; distant events are left out; no dated record is an error', () => {
    const one = draftFromCase(abstractCase({ records: [{ domain: 'dx', code: '1', date: '2024-01-01' }] }));
    assert.deepStrictEqual(one.spec.when, []); assert.strictEqual(one.used, 1);
    const recs = []; for (let i = 0; i < 14; i++) recs.push({ domain: i % 2 ? 'rx' : 'dx', code: 'C' + i, date: '2024-01-' + String(i + 1).padStart(2, '0') });
    const many = draftFromCase(abstractCase({ records: recs })); assert.strictEqual(many.used, 10); assert.strictEqual(many.left_out, 4); assert.ok(validate(many.spec).ok);
    const far = draftFromCase(abstractCase({ records: [{ domain: 'dx', code: '1', date: '2000-01-01' }, { domain: 'dx', code: '2', date: '2024-01-01' }] }));
    assert.strictEqual(far.used, 1); assert.strictEqual(far.left_out, 1);
    assert.throws(() => draftFromCase(abstractCase({ records: [{ domain: 'dx', code: '1', date: null }] })), (e) => e.status === 422);
    assert.deepStrictEqual(draftFromCase(abstractCase({ records: [{ domain: 'dx', code: '1', date: '2024-01-01' }, { domain: 'rx', code: '2', date: '2024-01-01' }] })).spec.when[0].range, [0, 0]);
  });

  // ---- route, with a fake scope and a fake read pool ----
  const calls = { sql: [], scope: [], model: [] };
  let caseRows = [], runRows = [], wordOn = false, wordFn = null;
  const readPool = {
    query: async () => { throw Object.assign(new Error('relation "snomed_isa" does not exist'), { code: '42P01' }); },
    connect: async () => ({
      query: async (sql, p) => {
        if (/^\s*(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
        calls.sql.push({ sql, p }); return { rows: /pat_c_/.test(sql) ? runRows : caseRows };
      }, release() {} }),
  };
  let scopeCtx = { with: "WITH p AS (SELECT 1 AS patient_id), ref AS (SELECT DATE '2024-12-31' AS d)", cohort: { id: 7, name: 'Admitted 2024' }, asOf: '2024-12-31', patients: [1] };
  const app = express();
  register(app, fakePool(), { fail: (res, label, err) => res.status(err.status || 500).json({ success: false, error: err.message }), readPool, minCell: 5,
    engine: { resolveScope: async (o) => { calls.scope.push(o); return scopeCtx; } }, scopeOf: () => ({ batchId: 'b1', cohortId: 7 }),
    get caseWording() { return wordOn; }, wordCase: (x) => (wordFn ? wordFn(x) : Promise.reject(new Error('no model'))) });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  const rowsFor = () => [{ dom: 'p', cd: null, d: '1980-04-02', e: null }].concat(planted.records.filter((r) => r.domain !== 'al').map((r) => ({ dom: r.domain, cd: r.code, d: r.date, e: r.end || null })));
  const matchRows = (k) => { const r = []; for (let i = 0; i < k; i++) r.push({ patient_id: 'm' + i, outcome: 'matched', reasons: [], records: {}, codes: {} }); for (let i = 0; i < 30; i++) r.push({ patient_id: 'n' + i, outcome: 'not_matched', reasons: [], records: {}, codes: {} }); return r; };
  try {
    await t('route: bad patient id, bad id, bad wording flag are 400 and read nothing', async () => {
      calls.sql.length = 0;
      for (const body of [{}, { patient_id: '' }, { patient_id: "1'; DROP TABLE p;--" }, { patient_id: { a: 1 } }, { patient_id: 'ok1', id: 'Bad Id' }, { patient_id: 'ok1', wording: 'yes' }]) {
        const r = await call('/api/patterns/from-case', body); assert.strictEqual(r.status, 400, JSON.stringify(body));
      }
      assert.strictEqual(calls.sql.length, 0);
    });
    await t('route: a patient outside the active cohort is 404; no cohort is 409', async () => {
      caseRows = [];
      assert.strictEqual((await call('/api/patterns/from-case', { patient_id: 'pt-12345' })).status, 404);
      const keep = scopeCtx; scopeCtx = Object.assign({}, keep, { cohort: null });
      assert.strictEqual((await call('/api/patterns/from-case', { patient_id: 'pt-12345' })).status, 409); scopeCtx = keep;
    });
    await t('route: returns a draft and an abstracted summary; the patient id is only a parameter; read-only transaction; nothing identifying in the answer; nothing saved', async () => {
      caseRows = rowsFor(); runRows = matchRows(9); calls.sql.length = 0; calls.scope.length = 0;
      const r = await call('/api/patterns/from-case', { patient_id: 'pt-12345' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.deepStrictEqual(calls.scope[0], { batchId: 'b1', cohortId: 7, useCohort: true });
      assert.ok(calls.sql.every((q) => !q.sql.includes('pt-12345')));
      assert.deepStrictEqual(calls.sql[0].p, ['pt-12345']); assert.ok(/patient_id::text = \$1::text/.test(calls.sql[0].sql));
      assert.ok(validate(r.json.draft, { reviewer: false }).ok);
      assert.strictEqual(r.json.case.age_band, '40-49'); assert.strictEqual(r.json.case.n_records, 6); assert.strictEqual(r.json.case.dropped, 1); assert.strictEqual(r.json.case.undated_codes, 1);
      assert.deepStrictEqual(r.json.case.events.map((e) => e.day), [0, 14, 88]);
      assert.deepStrictEqual(r.json.privacy, { min_cell: 5, checked: true, matched_in_cohort: 9, rare_combination: false, note: '' });
      assert.deepStrictEqual(r.json.wording, { used: false });
      hasNone(r.json, 'answer'); assert.ok(!JSON.stringify(r.json).includes('pt-12345'));
      assert.ok(!('matches' in r.json.privacy), 'no patient list');
    });
    await t('route: a sequence shared by fewer patients than the min-cell is flagged rare and the count is hidden', async () => {
      runRows = matchRows(2);
      const r = await call('/api/patterns/from-case', { patient_id: 'pt-12345' });
      assert.strictEqual(r.status, 200); assert.strictEqual(r.json.privacy.rare_combination, true); assert.strictEqual(r.json.privacy.matched_in_cohort, null); assert.ok(/identify/.test(r.json.privacy.note));
    });
    await t('route: if the cohort check fails the draft still comes back, marked as not checked', async () => {
      runRows = null;   // makes summarize throw
      const r = await call('/api/patterns/from-case', { patient_id: 'pt-12345' });
      assert.strictEqual(r.status, 200); assert.strictEqual(r.json.privacy.checked, false); assert.strictEqual(r.json.privacy.rare_combination, false); assert.ok(r.json.privacy.error);
      runRows = matchRows(9);
    });
    await t('model wording: off by default (403) and refused before any patient data is read', async () => {
      calls.sql.length = 0; wordOn = false;
      assert.strictEqual((await call('/api/patterns/from-case', { patient_id: 'pt-12345', wording: true })).status, 403);
      assert.strictEqual(calls.sql.length, 0);
    });
    await t('model wording: only the abstracted case reaches the model; the model text and model name are stored; basis becomes model_suggested; audit says external AI', async () => {
      wordOn = true; calls.model.length = 0; runRows = matchRows(9);
      wordFn = async (x) => { calls.model.push(x); return { text: 'A diagnosis followed by a medication within two weeks.', model: 'test-model', prompt_version: 'case-v1' }; };
      const r = await call('/api/patterns/from-case', { patient_id: 'pt-12345', wording: true });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(calls.model.length, 1); hasNone(calls.model[0], 'model input'); assert.ok(!JSON.stringify(calls.model[0]).includes('pt-12345'));
      assert.deepStrictEqual(Object.keys(calls.model[0]).sort(), ['age_band', 'events', 'span_days']);
      assert.strictEqual(r.json.draft.plain, 'A diagnosis followed by a medication within two weeks.');
      assert.strictEqual(r.json.draft.source.model, 'test-model'); assert.strictEqual(r.json.draft.source.prompt_version, 'case-v1');
      assert.strictEqual(r.json.draft.epistemic.basis, 'model_suggested'); assert.strictEqual(r.json.draft.epistemic.certainty, 'hypothesis'); assert.deepStrictEqual(r.json.wording, { used: true });
    });
    await t('model wording: refused for a rare sequence (the model is not called); an empty model answer is 502', async () => {
      calls.model.length = 0; runRows = matchRows(2);
      const r = await call('/api/patterns/from-case', { patient_id: 'pt-12345', wording: true });
      assert.strictEqual(r.status, 409); assert.strictEqual(calls.model.length, 0);
      runRows = matchRows(9); wordFn = async () => ({ text: '   ' });
      assert.strictEqual((await call('/api/patterns/from-case', { patient_id: 'pt-12345', wording: true })).status, 502);
      wordOn = false;
    });
  } finally { server.close(); }

  await t('model wording: with the setting on but no connector, the answer is 501', async () => {
    const app2 = express();
    register(app2, fakePool(), { fail: (res, label, err) => res.status(err.status || 500).json({ success: false, error: err.message }), readPool, caseWording: true,
      engine: { resolveScope: async () => scopeCtx }, scopeOf: () => ({}) });
    const s2 = await new Promise((resolve) => { const s = app2.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const r = await fetch('http://127.0.0.1:' + s2.address().port + '/api/patterns/from-case', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patient_id: 'p1', wording: true }) });
      assert.strictEqual(r.status, 501);
    } finally { s2.close(); }
  });
  return n;
}


// ---------- chunk 10 self-test: create from a few cases ----------
async function fewSelftest(good, n) {
  const assert = require('assert');
  const express = require('express');
  const t = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };
  console.log('create from a few cases (mining, route)');
  // planted rule: dx 'D1' then rx 'R1' 2 to 6 days later in 8 of 10 patients; noise code N-x in one patient each
  const mk = (i) => {
    const recs = [{ domain: 'dx', code: 'D1', date: '2024-03-01' }, { domain: 'dx', code: 'N' + i, date: '2024-03-02' }];
    if (i < 8) recs.push({ domain: 'rx', code: 'R1', date: '2024-03-0' + (3 + (i % 5)) });
    return { birth_date: '1980-01-01', as_of: '2024-12-31', records: recs, name: 'Jane Doe ' + i };
  };
  const abs = Array.from({ length: 10 }, (_, i) => abstractCase(mk(i)));
  await t('mineCases recovers the planted rule, ignores one-patient noise, and the draft is a valid hypothesis from observed data', () => {
    const m = mineCases(abs, { minCell: 5 });
    assert.ok(validate(m.spec, { reviewer: false }).ok);
    assert.deepStrictEqual(m.spec.events.map((e) => e.pick), ['first', 'first_on_or_after:dx1']);
    assert.deepStrictEqual(m.spec.when[0].range, [0, 6]); assert.strictEqual(m.spec.source.kind, 'few_cases'); assert.strictEqual(m.spec.source.n, 10);
    assert.deepStrictEqual(Object.values(m.spec.valuesets).map((v) => v.codes[0]), ['D1', 'R1']);
    assert.strictEqual(m.spec.epistemic.certainty, 'hypothesis'); assert.strictEqual(m.spec.epistemic.basis, 'observed_in_data');
    assert.ok(!JSON.stringify(m).includes('Jane') && !JSON.stringify(m.spec).includes('N3'));
    assert.deepStrictEqual(m.summary.events.map((e) => e.count), [10, 8]); assert.strictEqual(m.summary.events[1].gap.n, 8);
  });
  await t('a group smaller than the min-cell is refused, and a gap seen in fewer than min-cell patients is left out', () => {
    assert.throws(() => mineCases(abs.slice(0, 4), { minCell: 5 }), (e) => e.status === 422 && /not summarized/.test(e.message));
    assert.throws(() => mineCases(abs.slice(0, 1), { minCell: 1 }), (e) => e.status === 422);
    const few = abs.slice(0, 5).concat(abs.slice(8)); // 7 patients, only 5 have R1 with D1... need = max(5, 4) = 5
    const m = mineCases(abs.slice(0, 6), { minCell: 5 });
    assert.ok(m.spec.events.length >= 1);
    const sparse = abs.map((a, i) => (i < 4 ? a : abstractCase({ records: [{ domain: 'dx', code: 'D1', date: '2024-03-01' }, { domain: 'rx', code: 'R1', date: '2024-03-03' }] })));
    assert.strictEqual(mineCases(sparse, { minCell: 5, share: 0.1 }).spec.events.length >= 1, true);
    assert.throws(() => mineCases(abs.map((a, i) => abstractCase({ records: [{ domain: 'dx', code: 'X' + i, date: '2024-03-01' }] })), { minCell: 5 }), (e) => e.status === 422 && /No code is shared/.test(e.message));
  });
  const calls = { sql: [] };
  let rowsOut = [];
  const readPool = { query: async () => { throw Object.assign(new Error('no snomed_isa'), { code: '42P01' }); },
    connect: async () => ({ query: async (sql, p) => { if (/^\s*(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] }; calls.sql.push({ sql, p }); return { rows: /pat_c_/.test(sql) ? matchRows(9) : rowsOut }; }, release() {} }) };
  const matchRows = (k) => { const r = []; for (let i = 0; i < k; i++) r.push({ patient_id: 'm' + i, outcome: 'matched', reasons: [], records: {}, codes: {} }); for (let i = 0; i < 20; i++) r.push({ patient_id: 'n' + i, outcome: 'not_matched', reasons: [], records: {}, codes: {} }); return r; };
  const app = express();
  register(app, fakePool(), { fail: (res, l, e) => res.status(e.status || 500).json({ success: false, error: e.message }), readPool, minCell: 5,
    engine: { resolveScope: async () => ({ with: "WITH p AS (SELECT 1 AS patient_id), ref AS (SELECT DATE '2024-12-31' AS d)", cohort: { id: 1 }, asOf: '2024-12-31' }) }, scopeOf: () => ({}) });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const call = async (body) => { const r = await fetch('http://127.0.0.1:' + server.address().port + '/api/patterns/from-cases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  try {
    await t('route: bad bodies are 400, a group under the min-cell is 422, and nothing is read for them', async () => {
      calls.sql.length = 0;
      for (const b of [{}, { patient_ids: 'a' }, { patient_ids: ['a'] }, { patient_ids: ['a', "b'; DROP"] }, { patient_ids: ['a', 'b'], id: 'Bad Id' }]) assert.strictEqual((await call(b)).status, 400, JSON.stringify(b));
      assert.strictEqual((await call({ patient_ids: ['a', 'b', 'c'] })).status, 422);
      assert.strictEqual(calls.sql.length, 0);
    });
    await t('route: ids are one array parameter, patients outside the cohort are skipped, the answer holds aggregates and a draft only', async () => {
      const ids = Array.from({ length: 10 }, (_, i) => 'pt-' + i);
      rowsOut = [];
      abs.forEach((a, i) => { const src = mk(i); rowsOut.push({ pid: ids[i], dom: 'p', cd: null, d: '1980-01-01', e: null }); src.records.forEach((r) => rowsOut.push({ pid: ids[i], dom: r.domain, cd: r.code, d: r.date, e: null })); });
      const r = await call({ patient_ids: ids.concat(['outsider']) });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.deepStrictEqual(calls.sql[0].p, [ids.concat(['outsider'])]); assert.ok(calls.sql.every((q) => !q.sql.includes('pt-0')));
      assert.strictEqual(r.json.cases.n, 10); assert.strictEqual(r.json.cases.not_in_cohort, 1);
      assert.ok(validate(r.json.draft, { reviewer: false }).ok); assert.deepStrictEqual(r.json.draft.when[0].range, [0, 6]);
      assert.ok(!JSON.stringify(r.json).includes('pt-') && !JSON.stringify(r.json).includes('Jane'));
      assert.strictEqual(r.json.privacy.matched_in_cohort, 9); assert.strictEqual(r.json.privacy.rare_combination, false);
    });
    await t('route: if too few listed patients are in the cohort, nothing is summarized (422)', async () => {
      rowsOut = [{ pid: 'a', dom: 'p', cd: null, d: '1980-01-01', e: null }, { pid: 'a', dom: 'dx', cd: 'D1', d: '2024-03-01', e: null }];
      assert.strictEqual((await call({ patient_ids: ['a', 'b', 'c', 'd', 'e', 'f'] })).status, 422);
    });
  } finally { server.close(); }
  return n;
}

// ---------- chunk 11 self-test: import and export ----------
async function bundleSelftest(good, n) {
  const assert = require('assert');
  const express = require('express');
  const t = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  console.log('import and export (file, route)');
  const pool = fakePool();
  const app = express();
  app.use((req, res, next) => { const h = req.get('x-user'); if (h) { const [email, role] = h.split('|'); req.user = { email, role }; } next(); });
  register(app, pool, { fail: (res, l, e) => res.status(e.status || 500).json({ success: false, error: e.message }), can: (u, p) => u.role === 'reviewer' && p === 'patterns:review' });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, path, body, who) => { const r = await fetch(base + path, { method, headers: Object.assign({ 'content-type': 'application/json' }, who ? { 'x-user': who } : {}), body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json(), headers: r.headers }; };
  const REV = 'rae@example.org|reviewer', ANN = 'ann@example.org|analyst';
  try {
    // two patterns: one reviewed and raised to supported (library, with a source), one plain draft
    const a = clone(good); a.id = 'exp_one'; a.source = { kind: 'library' }; a.epistemic = { certainty: 'hypothesis', basis: 'expert', claim: 'association', note: 'x', tags: ['t1'] };
    const d = clone(good); d.id = 'exp_draft';
    await call('POST', '/api/patterns', a, ANN); await call('POST', '/api/patterns', d, ANN);
    await call('POST', '/api/patterns/exp_one/status', { to: 'reviewed', note: 'checked', version: 1 }, REV);
    await call('POST', '/api/patterns/exp_one/certainty', { certainty: 'supported', basis: 'literature', claim: 'causal', source_note: 'Smith 2019', note: 'raise', version: 1 }, REV);
    let file;
    await t('export: GET /api/patterns/export is not taken for an id; default is reviewed and active only; the file names its format, count and checksum', async () => {
      const r = await call('GET', '/api/patterns/export', undefined, ANN);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json)); file = r.json;
      assert.strictEqual(file.format, BUNDLE_FORMAT); assert.strictEqual(file.count, 1); assert.deepStrictEqual(file.patterns.map((x) => x.id), ['exp_one']);
      assert.ok(/attachment/.test(r.headers.get('content-disposition'))); assert.strictEqual(checkBundle(file).length, 0);
      assert.deepStrictEqual((await call('GET', '/api/patterns/export?status=draft')).json.patterns.map((x) => x.id), ['exp_draft']);
      assert.strictEqual((await call('GET', '/api/patterns/export?status=nope')).status, 400);
    });
    await t('checkBundle refuses an edited, miscounted, foreign, empty or oversized file', () => {
      const e1 = clone(file); e1.patterns[0].plain = 'tampered'; assert.ok(/checksum/.test(checkBundle(e1)[0].message));
      const e2 = clone(file); e2.count = 5; assert.ok(/count/.test(checkBundle(e2)[0].message));
      const e3 = clone(file); e3.format = 'other'; assert.ok(checkBundle(e3).length);
      assert.ok(checkBundle({}).length && checkBundle(null).length && checkBundle(Object.assign(clone(file), { patterns: [], count: 0 })).length);
      const big = makeBundle(Array.from({ length: BUNDLE_MAX + 1 }, () => file.patterns[0])); assert.ok(/at most/.test(checkBundle(big)[0].message));
    });
    await t('asImportedDraft: arrives as a draft library pattern at hypothesis, causal becomes association, the sender\'s certainty is only recorded in the note', () => {
      const r = asImportedDraft(file.patterns[0]);
      assert.ok(r.ok, JSON.stringify(r.errors));
      assert.deepStrictEqual([r.spec.status, r.spec.source.kind, r.spec.epistemic.certainty, r.spec.epistemic.claim], ['draft', 'library', 'hypothesis', 'association']);
      assert.ok(/sender said supported; not carried over/.test(r.spec.epistemic.note)); assert.ok(r.spec.epistemic.tags.includes('imported') && r.spec.epistemic.tags.includes('t1'));
      assert.ok(!asImportedDraft({ id: 'Bad Id' }).ok && !asImportedDraft(null).ok);
    });
    await t('round trip: the logic and statement are identical after export and import; only status, certainty and source are reset', async () => {
      const keep = pool.st.patterns.get('exp_one'); pool.st.patterns.delete('exp_one'); pool.st.history = pool.st.history.filter((h) => h.pattern_id !== 'exp_one');
      const r = await call('POST', '/api/patterns/import', { bundle: file, note: 'from site B' }, ANN);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json)); assert.deepStrictEqual([r.json.created, r.json.existing, r.json.invalid], [['exp_one'], [], []]);
      const got = pool.st.patterns.get('exp_one');
      for (const k of ['plain', 'valuesets', 'events', 'when', 'needs']) assert.deepStrictEqual(got.spec[k], keep.spec[k], k);
      assert.deepStrictEqual([got.status, got.certainty, got.created_by], ['draft', 'hypothesis', 'ann@example.org']);
      const h = pool.st.history.filter((x) => x.pattern_id === 'exp_one'); assert.deepStrictEqual([h[0].action, h[0].to_status, h[0].note], ['import', 'draft', 'imported from a file: from site B']);
      const again = await call('POST', '/api/patterns/import', { bundle: file }, ANN); assert.deepStrictEqual([again.json.created, again.json.existing], [[], ['exp_one']]);
    });
    await t('import: a tampered file is 422 and stores nothing; bad bodies are 400; one invalid pattern is skipped and reported, the rest still import', async () => {
      const before = pool.st.patterns.size;
      const e1 = clone(file); e1.patterns[0].id = 'sneaky_swap'; assert.strictEqual((await call('POST', '/api/patterns/import', { bundle: e1 }, ANN)).status, 422);
      assert.strictEqual((await call('POST', '/api/patterns/import', {}, ANN)).status, 400);
      assert.strictEqual(pool.st.patterns.size, before);
      const ok2 = clone(file.patterns[0]); ok2.id = 'exp_two'; const bad = clone(file.patterns[0]); bad.id = 'exp_bad'; bad.when.push({ rel: 'sql_where' });
      const mixed = makeBundle([ok2, bad]);
      const r = await call('POST', '/api/patterns/import', { bundle: mixed }, ANN);
      assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.json.created, ['exp_two']); assert.strictEqual(r.json.invalid.length, 1); assert.strictEqual(r.json.invalid[0].id, 'exp_bad');
      assert.ok(!pool.st.patterns.has('exp_bad'));
    });
    await t('import: a recomputed checksum does not skip validation, and a file cannot smuggle in a status or a raised certainty', async () => {
      const sneaky = clone(file.patterns[0]); sneaky.id = 'exp_three'; sneaky.status = 'active'; sneaky.epistemic.certainty = 'established'; sneaky.source = { kind: 'library', model: 'm' };
      const r = await call('POST', '/api/patterns/import', { bundle: makeBundle([sneaky]) }, ANN);
      assert.strictEqual(r.status, 200); const got = pool.st.patterns.get('exp_three');
      assert.deepStrictEqual([got.status, got.certainty, got.spec.status], ['draft', 'hypothesis', 'draft']);
    });
  } finally { server.close(); }
  return n;
}

// ---------- self-test ----------
function selftest() {
  const assert = require('assert');
  let n = 0;
  const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
  const clone = (o) => JSON.parse(JSON.stringify(o));

  const good = {
    id: 'viral_abx_short_course',
    plain: 'Viral illness treated with antibiotics; no further record of the illness soon after, antibiotic not refilled.',
    source: { kind: 'few_cases', n: 12 },
    status: 'draft',
    valuesets: {
      viral: { domain: 'dx', codes: ['34014006'], mode: 'descendants' },
      antibac: { domain: 'rx', codes: ['J01CA04'], mode: 'exact' },
    },
    events: [
      { as: 'dx', valueset: 'viral', pick: 'first' },
      { as: 'abx', valueset: 'antibac', pick: 'first_on_or_after:dx' },
    ],
    when: [
      { rel: 'within_days', a: 'abx.date', of: 'dx.date', range: [0, 3] },
      { rel: 'none_in_window', event: 'dx', after: 'dx.date', range: [7, 30] },
      { rel: 'no_refill', event: 'abx', supply_days: 5, grace_days: 45 },
    ],
    epistemic: { certainty: 'hypothesis', basis: 'observed_in_data', claim: 'association', note: 'Seen in 12 synthetic cases; no source yet.', tags: [] },
    needs: ['dx.date', 'rx.date'.replace('rx', 'abx')],
    min_evidence: 'documented',
    spec_version: 1,
  };
  const bad = (mut, opts, pathPart) => {
    const s = clone(good); mut(s);
    const r = validate(s, opts);
    assert.strictEqual(r.ok, false, 'expected rejection');
    if (pathPart) assert.ok(r.errors.some((e) => e.path.includes(pathPart)), 'expected error at ' + pathPart + ', got ' + JSON.stringify(r.errors));
    return r;
  };

  console.log('patterns.js self-test');

  // valid specs
  t('example spec from the plan is valid', () => {
    const r = validate(good);
    assert.ok(r.ok, JSON.stringify(r.errors));
    assert.strictEqual(r.spec.spec_version, 1);
  });
  t('minimal spec gets defaults', () => {
    const r = validate({ id: 'min_one', plain: 'x', source: { kind: 'library' },
      valuesets: { a: { domain: 'dx', codes: ['1'], mode: 'exact' } },
      events: [{ as: 'dx', valueset: 'a', pick: 'first' }], when: [] });
    assert.ok(r.ok, JSON.stringify(r.errors));
    assert.strictEqual(r.spec.status, 'draft');
    assert.strictEqual(r.spec.epistemic.certainty, 'hypothesis');
    assert.strictEqual(r.spec.epistemic.basis, 'expert');
    assert.strictEqual(r.spec.min_evidence, 'documented');
    assert.deepStrictEqual(r.spec.needs, ['dx.date']);
  });
  t('every relation can be written and validates', () => {
    const s = clone(good);
    s.valuesets.lab = { domain: 'ob', codes: ['4548-4'], mode: 'exact' };
    s.valuesets.stay = { domain: 'en', codes: ['IMP'], mode: 'exact' };
    s.events.push({ as: 'hba1c', valueset: 'lab', pick: 'last' }, { as: 'adm', valueset: 'stay', pick: 'first' });
    s.when = [
      { rel: 'within_days', a: 'abx.date', of: 'dx.date', range: [0, 3] },
      { rel: 'before', a: 'dx.date', b: 'abx.date' },
      { rel: 'after', a: 'abx.date', b: 'dx.date' },
      { rel: 'none_in_window', event: 'dx', after: 'dx.date', range: [7, 30] },
      { rel: 'no_refill', event: 'abx', supply_days: 5, grace_days: 45 },
      { rel: 'return_within_days', event: 'adm', of: 'adm.date', days: 30 },
      { rel: 'latest_value_in_window', event: 'hba1c', of: 'dx.date', range: [0, 365], op: 'gte', value: 6.5 },
      { rel: 'count_at_least', event: 'adm', count: 2 },
      { rel: 'count_at_least', event: 'adm', count: 2, of: 'dx.date', range: [0, 365] },
    ];
    const r = validate(s);
    assert.ok(r.ok, JSON.stringify(r.errors));
    assert.ok(r.spec.needs.includes('hba1c.value'));
  });
  t('normalize is idempotent and does not change the input', () => {
    const s = clone(good); const before = JSON.stringify(s);
    const a = validate(s).spec; const b = normalize(a);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(JSON.stringify(s), before);
  });
  t('normalize dedupes codes and lowercases tags', () => {
    const s = clone(good); s.valuesets.viral.codes = ['1', '1', ' 2 '.trim()]; s.epistemic.tags = ['A', 'a'];
    const r = validate(s); assert.ok(r.ok, JSON.stringify(r.errors));
    assert.deepStrictEqual(r.spec.valuesets.viral.codes, ['1', '2']);
    assert.deepStrictEqual(r.spec.epistemic.tags, ['a']);
  });

  // structure rejections
  t('rejects non-object and unknown top-level field', () => {
    assert.strictEqual(validate(null).ok, false);
    assert.strictEqual(validate([]).ok, false);
    bad((s) => { s.sql = 'select 1'; }, {}, 'sql');
  });
  t('rejects bad id and missing plain text', () => {
    bad((s) => { s.id = 'Bad Id; drop'; }, {}, 'id');
    bad((s) => { s.plain = '   '; }, {}, 'plain');
  });
  t('rejects unknown relation, extra relation field and missing field', () => {
    bad((s) => { s.when.push({ rel: 'sql_where', clause: 'true' }); }, {}, 'rel');
    bad((s) => { s.when[0].extra = 1; }, {}, 'extra');
    bad((s) => { delete s.when[0].range; }, {}, 'range');
  });
  t('rejects unknown domain, mode and event references', () => {
    bad((s) => { s.valuesets.viral.domain = 'zz'; }, {}, 'domain');
    bad((s) => { s.valuesets.viral.mode = 'ancestors'; }, {}, 'mode');
    bad((s) => { s.events[0].valueset = 'nope'; }, {}, 'valueset');
    bad((s) => { s.when[0].a = 'ghost.date'; }, {}, 'when[0].a');
    bad((s) => { s.events[1].pick = 'first_on_or_after:later'; }, {}, 'pick');
  });
  t('rejects duplicate alias and descendants on encounter classes', () => {
    bad((s) => { s.events[1].as = 'dx'; }, {}, 'events[1].as');
    bad((s) => { s.valuesets.st = { domain: 'en', codes: ['IMP'], mode: 'descendants' }; }, {}, 'valuesets.st.mode');
  });
  t('rejects out-of-range numbers', () => {
    bad((s) => { s.when[0].range = [5, 2]; }, {}, 'range');
    bad((s) => { s.when[0].range = [0, 99999]; }, {}, 'range');
    bad((s) => { s.when[0].range = [0.5, 2]; }, {}, 'range');
    bad((s) => { s.when[2].supply_days = 0; }, {}, 'supply_days');
    bad((s) => { s.when[2].grace_days = 1e6; }, {}, 'grace_days');
    bad((s) => { s.when[2].supply_days = '5'; }, {}, 'supply_days');
  });
  t('rejects code strings that could carry SQL or markup', () => {
    bad((s) => { s.valuesets.viral.codes = ["1' OR '1'='1"]; }, {}, 'codes[0]');
    bad((s) => { s.valuesets.viral.codes = ['1;--']; }, {}, 'codes[0]');
    bad((s) => { s.valuesets.viral.codes = []; }, {}, 'codes');
  });
  t('rejects type misuse for events (no_refill on non-drug, value on non-ob)', () => {
    bad((s) => { s.when[2].event = 'dx'; }, {}, 'when[2].event');
    bad((s) => { s.when[0].a = 'dx.value'; }, {}, 'when[0].a');
  });
  t('rejects a reference to a pick:any event, and no_refill on one', () => {
    const s = clone(good); s.valuesets.stay = { domain: 'en', codes: ['IMP'], mode: 'exact' };
    s.events.push({ as: 'adm', valueset: 'stay', pick: 'any' });
    s.when = [{ rel: 'return_within_days', event: 'adm', of: 'adm.date', days: 30 }];
    const r = validate(s); assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => e.path === 'when[0].of'));
    s.when = [{ rel: 'count_at_least', event: 'adm', count: 2 }];
    const r2 = validate(s); assert.ok(r2.ok, JSON.stringify(r2.errors));
    assert.ok(!r2.spec.needs.includes('adm.date'));
    const s3 = clone(good); s3.events[1].pick = 'any';
    s3.when = [{ rel: 'no_refill', event: 'abx', supply_days: 5, grace_days: 45 }];
    assert.ok(validate(s3).errors.some((e) => e.path === 'when[0].event'));
  });
  t('rejects prototype-style keys without crashing', () => {
    const s = JSON.parse('{"__proto__":{"x":1},"id":"abc_def","plain":"x","source":{"kind":"library"},"valuesets":{"constructor":{"domain":"dx","codes":["1"],"mode":"exact"}},"events":[{"as":"toString","valueset":"constructor","pick":"first"}],"when":[]}');
    const r = validate(s);
    assert.ok(typeof r.ok === 'boolean');
    const s2 = clone(good); s2.when[0].a = 'toString.date';
    assert.strictEqual(validate(s2).ok, false);
  });

  // epistemic rules, one test each
  t('rule: only a reviewer can raise certainty above hypothesis', () => {
    const s = clone(good); s.source = { kind: 'library' }; s.epistemic = { certainty: 'supported', basis: 'literature', claim: 'association', note: 'Smith 2019' };
    assert.strictEqual(validate(s).ok, false);
    assert.ok(validate(s, { reviewer: true }).ok);
  });
  t('rule: model drafts start at hypothesis (model_suggested cannot be established or supported)', () => {
    const s = clone(good); s.source = { kind: 'few_cases', model: 'some-model', prompt_version: 'v1' };
    s.epistemic = { certainty: 'supported', basis: 'model_suggested', claim: 'association', note: 'n' };
    const r = validate(s, { reviewer: true });
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => e.path === 'epistemic.basis'));
    s.epistemic.basis = 'literature'; // reviewer records the real basis
    assert.ok(validate(s, { reviewer: true }).ok);
  });
  t('rule: model source defaults basis to model_suggested and certainty to hypothesis', () => {
    const s = clone(good); s.source = { kind: 'few_cases', model: 'm' }; delete s.epistemic;
    const r = validate(s); assert.ok(r.ok, JSON.stringify(r.errors));
    assert.strictEqual(r.spec.epistemic.basis, 'model_suggested');
    assert.strictEqual(r.spec.epistemic.certainty, 'hypothesis');
  });
  t('rule: established and supported need a source note', () => {
    for (const c of ['established', 'supported']) {
      const s = clone(good); s.source = { kind: 'library' };
      s.epistemic = { certainty: c, basis: 'guideline', claim: 'descriptive', note: '  ' };
      const r = validate(s, { reviewer: true });
      assert.strictEqual(r.ok, false); assert.ok(r.errors.some((e) => e.path === 'epistemic.note'));
    }
  });
  t('rule: contested needs a note on the disagreement', () => {
    const s = clone(good); s.epistemic = { certainty: 'contested', basis: 'expert', claim: 'association', note: '' };
    assert.strictEqual(validate(s).ok, false);
    s.epistemic.note = 'Guideline A and trial B disagree on duration.';
    assert.ok(validate(s).ok);
  });
  t('rule: causal claim needs at least supported', () => {
    const s = clone(good); s.epistemic.claim = 'causal';
    const r = validate(s); assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => e.path === 'epistemic.claim'));
    s.source = { kind: 'library' }; s.epistemic = { certainty: 'supported', basis: 'literature', claim: 'causal', note: 'RCT, Smith 2019' };
    assert.ok(validate(s, { reviewer: true }).ok);
    s.epistemic.certainty = 'hypothesis';
    assert.strictEqual(validate(s, { reviewer: true }).ok, false);
  });
  t('rule: tags limited to 10 short lowercase labels', () => {
    const s = clone(good); s.epistemic.tags = Array.from({ length: 11 }, (_, i) => 't' + i);
    assert.strictEqual(validate(s).ok, false);
    s.epistemic.tags = ['has space'];
    assert.strictEqual(validate(s).ok, false);
    s.epistemic.tags = ['pediatrics', 'site-a'];
    assert.ok(validate(s).ok);
  });
  t('rule: unknown epistemic labels are rejected', () => {
    bad((s) => { s.epistemic.certainty = 'certain'; }, {}, 'certainty');
    bad((s) => { s.epistemic.basis = 'gut'; }, {}, 'basis');
    bad((s) => { s.epistemic.claim = 'proves'; }, {}, 'claim');
  });

  // chunk 4: discharge anchor and seeds
  t('discharge anchor: from "end" needs an encounter anchor; from must be start or end', () => {
    const adm = { id: 'readmit_x', plain: 'x', source: { kind: 'library' }, valuesets: { stay: { domain: 'en', codes: ['IMP'], mode: 'exact' } },
      events: [{ as: 'adm', valueset: 'stay', pick: 'first' }], when: [{ rel: 'return_within_days', event: 'adm', of: 'adm.date', days: 30, from: 'end' }] };
    const ok = validate(adm); assert.ok(ok.ok, JSON.stringify(ok.errors));
    assert.strictEqual(ok.spec.when[0].from, 'end');
    const a = clone(adm); a.when[0].from = 'discharge'; assert.strictEqual(validate(a).ok, false);
    const b = clone(adm); b.valuesets.stay = { domain: 'dx', codes: ['V'], mode: 'exact' };
    const rb = validate(b); assert.strictEqual(rb.ok, false); assert.ok(rb.errors.some((e) => e.path === 'when[0].from'));
    const c = clone(adm); delete c.when[0].from; assert.ok(validate(c).ok);
  });
  t('seed patterns are valid drafts at hypothesis and a second validate is identical', () => {
    assert.strictEqual(SEEDS.length, 3);
    for (const sd of SEEDS) {
      const r = validate(sd); assert.ok(r.ok, sd.id + ' ' + JSON.stringify(r.errors));
      assert.strictEqual(r.spec.epistemic.certainty, 'hypothesis'); assert.strictEqual(r.spec.status, 'draft');
      assert.deepStrictEqual(validate(r.spec).spec, r.spec);
    }
    assert.ok(SEEDS.some((x) => x.when.some((w) => w.rel === 'return_within_days' && w.from === 'end')));
  });
  t('summarize: counts under the min-cell are hidden, and the total goes with them', () => {
    const rows = [];
    const add = (outcome, k, reasons) => { for (let i = 0; i < k; i++) rows.push({ patient_id: outcome[0] + i, outcome, reasons: reasons || [], records: { dx: 'r' + i }, codes: { dx: 'C' } }); };
    add('matched', 12); add('not_matched', 3); add('cannot_evaluate', 7, ['dx_date_missing']);
    const r = summarize(rows, { minCell: 5 });
    assert.deepStrictEqual(r.counts, { eligible: null, matched: 12, not_matched: null, cannot_evaluate: 7 });
    assert.strictEqual(r.suppressed, true); assert.strictEqual(r.match_rate, null); assert.strictEqual(r.evaluable, null);
    assert.deepStrictEqual(r.reasons, [{ reason: 'dx_date_missing', count: 7, hidden: false }]);
    assert.strictEqual(r.matches.length, 12);
    const r2 = summarize(rows.filter((x) => x.outcome !== 'not_matched'), { minCell: 5 });
    assert.deepStrictEqual(r2.counts, { eligible: 19, matched: 12, not_matched: 0, cannot_evaluate: 7 }); assert.strictEqual(r2.suppressed, false);
  });
  t('summarize: matches are listed only when the matched count is shown, sorted, capped, and reasons are hidden per reason', () => {
    const rows = [];
    for (let i = 0; i < 30; i++) rows.push({ patient_id: 'p' + String(30 - i).padStart(3, '0'), outcome: 'matched', reasons: [], records: {}, codes: {} });
    for (let i = 0; i < 9; i++) rows.push({ patient_id: 'n' + i, outcome: 'not_matched', reasons: [], records: {}, codes: {} });
    for (let i = 0; i < 6; i++) rows.push({ patient_id: 'c' + i, outcome: 'cannot_evaluate', reasons: i < 2 ? ['a_date_missing', 'followup_incomplete'] : ['followup_incomplete'], records: {}, codes: {} });
    const r = summarize(rows, { minCell: 5, limit: 10 });
    assert.strictEqual(r.matches.length, 10); assert.strictEqual(r.matches[0].patient_id, 'p001'); assert.strictEqual(r.truncated, true);
    assert.deepStrictEqual(r.reasons.map((x) => [x.reason, x.count]), [['followup_incomplete', 6], ['a_date_missing', null]]);
    assert.strictEqual(r.suppressed, true); assert.strictEqual(r.counts.eligible, 45); assert.strictEqual(r.match_rate, Math.round(30 / 39 * 10000) / 10000);
    const few = summarize(rows.slice(0, 3), { minCell: 5 });
    assert.deepStrictEqual(few.matches, []); assert.strictEqual(few.counts.matched, null);
  });

  return builderSelftest(good, n).then((m) => routeSelftest(good, m)).then((m) => runSelftest(good, m)).then((m) => caseSelftest(good, m)).then((m) => fewSelftest(good, m)).then((m) => bundleSelftest(good, m)).then((m) => reviewSelftest(good, m));
}

module.exports = register;
Object.assign(register, {
  register, validate, normalize, selftest, resolveValueSets, buildSql, explainReasons, summarize, runLabels, labelSettings, SEEDS, fakePool,
  abstractCase, draftFromCase, ageBand, mineCases, makeBundle, checkBundle, asImportedDraft,
  TRANSITIONS, canTransition, actorOf,
  constants: { SPEC_VERSION, STATUSES, SOURCE_KINDS, CERTAINTY, BASIS, CLAIM, EVIDENCE, MODES, DOMAINS, RELATIONS, VALUE_OPS, LIMITS, MAX_EXPANDED },
});

if (require.main === module && process.argv.includes('--selftest')) {
  (async () => {
    try { await selftest(); } catch (e) { console.error('SELFTEST FAILED:', e && e.stack || e); process.exit(1); }
  })();
}
