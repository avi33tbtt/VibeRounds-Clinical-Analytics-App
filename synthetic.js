// Synthetic FHIR R4 data generator for Vibe Rounds.
//
// Produces a FHIR Bundle (type "collection") that the existing /api/import-fhir
// endpoint can ingest directly. The data is *clinically correlated* rather than
// random so every analytics mode has something real to find:
//   V1 (text)        every resource carries a narrative (text.div) with synonyms,
//                    abbreviations, negations ("denies ...") and a few un-coded
//                    "suspected" mentions, so text matching differs from coded results.
//   V2 (codes)       SNOMED CT / LOINC / RxNorm codes on every clinical resource (V3 / V5 add reviewed
//                    enrichment codes; the `uncoded` option leaves records with text only so there is something to enrich).
//   V4 (code + time) onsets, follow-up labs that respond to treatment, medication
//                    renewals, admissions with 30-day readmissions, screenings, etc.
//
// Deterministic: the same seed + options always yields the same bundle.

const T = require('./knowledge').terminology;
const DAY = 86400000, YEAR = 365.25 * DAY;

function hashSeed(s) { let h = 1779033703 ^ String(s).length; for (const c of String(s)) { h = Math.imul(h ^ c.charCodeAt(0), 3432918353); h = (h << 13) | (h >>> 19); } return h >>> 0; }
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

const CITIES = [['Boston', 'MA', '02108'], ['Austin', 'TX', '73301'], ['Denver', 'CO', '80202'], ['Seattle', 'WA', '98101'], ['Atlanta', 'GA', '30303'], ['Chicago', 'IL', '60601'], ['Phoenix', 'AZ', '85001'], ['Miami', 'FL', '33101']];
const RACES = [['2106-3', 'White', 0.60], ['2054-5', 'Black or African American', 0.14], ['2028-9', 'Asian', 0.07], ['1002-5', 'American Indian or Alaska Native', 0.02], ['2076-8', 'Native Hawaiian or Other Pacific Islander', 0.01], ['2131-1', 'Other Race', 0.16]];
const COMPLAINTS = ['Routine check-up', 'Follow-up visit', 'Cough', 'Back pain', 'Headache', 'Fatigue', 'Medication review', 'Joint pain', 'Dizziness'];
const SNOMED = T.SYSTEMS.snomed, LOINC = T.SYSTEMS.loinc, RXNORM = T.SYSTEMS.rxnorm;

// ---------------------------------------------------------------------------------------------
// Messy-data mode (Step 3.10). A post-processing pass over the finished bundle, driven by its own random stream
// (rng2('messy')), so the clinical story and the default output never change: with `messy` off the bundle is
// identical to before. It adds the kinds of defects Phase 6B has to cope with: other code systems for the same
// concept, local codes missing from terminology.js, mixed units, missing/impossible dates, duplicates, missing or
// misspelled narratives and incomplete patients. ICD-10-CM codes are representative demo codes (verify before real use).
// ---------------------------------------------------------------------------------------------
const ICD10 = { diabetes: 'E11.9', hypertension: 'I10', hyperlipidemia: 'E78.5', obesity: 'E66.9', ckd: 'N18.9', asthma: 'J45.909', copd: 'J44.9', cad: 'I25.10', heart_failure: 'I50.9', afib: 'I48.91', stroke: 'I63.9', depression: 'F32.A', osteoporosis: 'M81.0', anemia: 'D64.9', breast_cancer: 'C50.919', colorectal_cancer: 'C18.9', pneumonia: 'J18.9', uti: 'N39.0' };
const ICD10_SYSTEM = 'http://hl7.org/fhir/sid/icd-10-cm', LOCAL_SYSTEM = 'http://hospital.example/local-codes';
const INTERP = 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation';
const MESS = { icd10: 0.10, localCondition: 0.05, localMed: 0.08, localProc: 0.05, localLab: 0.06, lowerDisplay: 0.10, unitSwap: 0.08, noUnit: 0.04,
  noDateCondition: 0.03, noDateObs: 0.03, noDateMed: 0.02, preBirthCondition: 0.005, futureObs: 0.005, dupObs: 0.02, dupCondition: 0.015,
  noText: 0.05, typo: 0.04, noGender: 0.02, unknownGender: 0.01, noBirth: 0.01 };

function applyMess(entries, r, ctx) {
  const rev = dict => Object.fromEntries(Object.entries(dict).map(([k, d]) => [d.code, k]));
  const condKey = rev(T.CONDITIONS), medKey = rev(T.MEDICATIONS), procKey = rev(T.PROCEDURES), labKey = rev(T.LABS);
  const birthOf = {};
  for (const e of entries) if (e.resource.resourceType === 'Patient' && e.resource.birthDate) birthOf[e.resource.id] = Date.parse(e.resource.birthDate);
  const n = { icd10_conditions: 0, local_codes: 0, unit_changes: 0, units_removed: 0, dates_removed: 0, impossible_dates: 0, duplicates: 0, narratives_removed: 0, typos: 0, patient_fields_removed: 0, lowercase_displays: 0 };
  const hit = p => r() < p;
  const setCoding = (res, field, system, code) => { const c = res[field].coding[0]; c.system = system; c.code = code; };
  const typo = txt => {   // swap two middle letters of one longer word inside the narrative
    const m = /^(<div[^>]*>)([\s\S]*)(<\/div>)$/.exec(txt); if (!m) return null;
    const words = m[2].split(' '), ok = words.map((w, i) => (/^[A-Za-z]{6,}$/.test(w) ? i : -1)).filter(i => i >= 0);
    if (!ok.length) return null;
    const i = ok[Math.floor(r() * ok.length)], w = words[i], k = 1 + Math.floor(r() * (w.length - 3));
    words[i] = w.slice(0, k) + w[k + 1] + w[k] + w.slice(k + 2);
    return m[1] + words.join(' ') + m[3];
  };
  const labMode = code => hashSeed(`${ctx.seed}:range:${code}`) % 3;   // per lab code: 0 = referenceRange, 1 = interpretation flag, 2 = neither
  const out = [];
  for (const e of entries) {
    const x = e.resource, t = x.resourceType, copies = [];
    if (t === 'Condition') {
      const key = condKey[x.code.coding[0].code];
      if (key && hit(MESS.icd10)) { setCoding(x, 'code', ICD10_SYSTEM, ICD10[key]); n.icd10_conditions++; }
      else if (key && hit(MESS.localCondition)) { setCoding(x, 'code', LOCAL_SYSTEM, `L-${key.toUpperCase()}`); n.local_codes++; }
      if (hit(MESS.noDateCondition)) { delete x.onsetDateTime; delete x.recordedDate; n.dates_removed++; }
      else if (hit(MESS.preBirthCondition) && birthOf[x.subject.reference.slice(8)]) { x.onsetDateTime = x.recordedDate = new Date(birthOf[x.subject.reference.slice(8)] - 5 * YEAR).toISOString().replace(/\.\d+Z$/, 'Z'); n.impossible_dates++; }
      if (hit(MESS.dupCondition)) copies.push('c');
    } else if (t === 'MedicationStatement') {
      const key = medKey[x.medicationCodeableConcept.coding[0].code];
      if (key && hit(MESS.localMed)) { setCoding(x, 'medicationCodeableConcept', LOCAL_SYSTEM, `RX-${key.toUpperCase()}`); n.local_codes++; }
      if (hit(MESS.noDateMed)) { delete x.effectiveDateTime; n.dates_removed++; }
    } else if (t === 'Procedure') {
      const key = procKey[x.code.coding[0].code];
      if (key && hit(MESS.localProc)) { setCoding(x, 'code', LOCAL_SYSTEM, `PROC-${key.toUpperCase()}`); n.local_codes++; }
    } else if (t === 'Observation') {
      const code = x.code.coding[0].code, key = labKey[code], d = key && T.LABS[key], q = x.valueQuantity;
      if (d && q) {
        if (key === 'glucose' && hit(MESS.unitSwap)) { q.value = Math.round(q.value / 18.016 * 10) / 10; q.unit = q.code = 'mmol/L'; n.unit_changes++; }
        else if (key === 'creatinine' && hit(MESS.unitSwap)) { q.value = Math.round(q.value * 88.4); q.unit = q.code = 'umol/L'; n.unit_changes++; }
        if (d.dir && q.unit === d.unit) {   // reference range / interpretation flag only where the unit is the original one
          const mode = labMode(code);
          if (mode === 0) x.referenceRange = [d.dir === 'high' ? { high: { value: d.thr, unit: d.unit } } : { low: { value: d.thr, unit: d.unit } }];
          else if (mode === 1) { const flag = d.dir === 'high' ? (q.value >= d.thr ? 'H' : 'N') : (q.value < d.thr ? 'L' : 'N'); x.interpretation = [{ coding: [{ system: INTERP, code: flag }] }]; }
        }
        if (hit(MESS.noUnit)) { delete q.unit; delete q.system; delete q.code; n.units_removed++; }
      }
      if (key && hit(MESS.localLab)) { setCoding(x, 'code', LOCAL_SYSTEM, `LAB-${key.toUpperCase()}`); n.local_codes++; }
      if (hit(MESS.noDateObs)) { delete x.effectiveDateTime; n.dates_removed++; }
      else if (hit(MESS.futureObs)) { x.effectiveDateTime = new Date(ctx.end + 400 * DAY).toISOString().replace(/\.\d+Z$/, 'Z'); n.impossible_dates++; }
      if (hit(MESS.dupObs)) copies.push('o');
    } else if (t === 'Patient') {
      if (hit(MESS.noGender)) { delete x.gender; n.patient_fields_removed++; } else if (hit(MESS.unknownGender)) { x.gender = 'unknown'; n.patient_fields_removed++; }
      if (hit(MESS.noBirth)) { delete x.birthDate; n.patient_fields_removed++; }
    }
    // coding display noise and narrative defects (any resource type)
    const cod = (x.code || x.medicationCodeableConcept || {}).coding;
    if (cod && cod[0] && cod[0].display && hit(MESS.lowerDisplay)) { cod[0].display = cod[0].display.toLowerCase(); n.lowercase_displays++; }
    if (x.text && hit(MESS.noText)) { delete x.text; n.narratives_removed++; }
    else if (x.text && hit(MESS.typo)) { const tt = typo(x.text.div); if (tt) { x.text.div = tt; n.typos++; } }
    out.push(e);
    for (const c of copies) { const d = JSON.parse(JSON.stringify(x)); d.id = `${x.id}-dup`; out.push({ fullUrl: `urn:uuid:${d.id}`, resource: d }); n.duplicates++; }
  }
  entries.length = 0;
  for (const e of out) entries.push(e);   // loop, not push(...out): a 5,000-patient bundle has too many items to spread
  return n;
}

// ---------------------------------------------------------------------------------------------
// Inpatient detail (Step T.1). A post-processing pass over the finished bundle with its own random stream
// (rng2('inp:' + encounter id)), so the clinical story never changes: with `inpatient` off the bundle is identical to before.
// It only ADDS fields to existing IMP encounters (and, in later steps, new resources whose ids end in -inp-<n>).
//   T.1a  hospitalization.admitSource, and the SNOMED coding of the matching condition inside reasonCode (text kept).
//   T.1d  hospitalization.dischargeDisposition on every IMP encounter (drawn after escalation is known), counted in summary.inpatient.
//   T.1c  escalation: child Encounters (class ACUTE, never IMP) for ICU transfers and rapid-response calls, partOf the stay.
//   T.1b  timestamped in-stay orders: Procedure and MedicationStatement resources (ids ...-inp-<n>) with times inside the stay.
// The admit-source and condition mix is the generator's own assumption, not observed data.
// ---------------------------------------------------------------------------------------------
const ADMIT_SYSTEM = 'http://terminology.hl7.org/CodeSystem/admit-source';
const ADMIT_SOURCES = [['emd', 'From accident/emergency department'], ['gp', 'General Practitioner referral'], ['hosp-trans', 'Transferred from other hospital'], ['nursing', 'From nursing home']];
// [code, weight] lists in the order of ADMIT_SOURCES: usual mix, and the mix for patients aged 75 and over (more nursing-home admissions)
const ADMIT_MIX = { usual: [0.60, 0.25, 0.07, 0.08], old: [0.50, 0.18, 0.07, 0.25] };
// Core orders per reason (dictionary keys). first 48 h = the 'initial plan'. `extra` = one possible later item (after 48 h).
const INP_ORDERS = {
  pneumonia: { proc: 'chest_xray', med: 'amoxicillin', extra: { proc: 'ecg' } },
  heart_failure: { proc: 'ecg', med: 'furosemide', extra: { proc: 'chest_xray' } },
  copd: { proc: 'chest_xray', med: 'albuterol', extra: { proc: 'ecg' } },
  uti: { proc: null, med: 'amoxicillin', extra: { med: 'amoxicillin' } }
};
// Escalation rule constants (logit scale): intercept and step per risk feature. Tuned for about 12% ICU and 6% rapid response overall.
const ICU_B0 = -2.8, ICU_B = 0.5, RR_B0 = -3.55, RR_B = 0.4;
const DISPO_SYSTEM = 'http://terminology.hl7.org/CodeSystem/discharge-disposition';
const DISPO = { home: 'Home', snf: 'Skilled nursing facility', rehab: 'Rehabilitation', aadvice: 'Left against advice', exp: 'Expired', oth: 'Other' };
const INP_REASONS = [['pneumonia', /^Pneumonia/i], ['uti', /^Urinary tract infection/i], ['heart_failure', /heart failure/i], ['copd', /COPD/i]];

function addInpatientDetail(entries, rng2, ctx) {
  const birthOf = {};
  for (const e of entries) if (e.resource.resourceType === 'Patient' && e.resource.birthDate) birthOf[e.resource.id] = Date.parse(e.resource.birthDate);
  const iso = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  const div = txt => ({ status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${esc(txt)}</div>` });
  const cc = (system, d) => ({ coding: [{ system, code: d.code, display: d.display }], text: d.display });
  const penicillin = new Set();   // patients with a penicillin allergy: no new amoxicillin for them (creates no allergy conflicts)
  for (const e of entries) { const a = e.resource; if (a.resourceType === 'AllergyIntolerance' && a.code && a.code.coding && a.code.coding[0].code === T.ALLERGENS.penicillin.code) penicillin.add(a.patient.reference.slice(8)); }
  const added = [];
  const deadAt = {}, lastStay = {};   // deceasedDateTime per patient; id of each patient's last IMP stay (latest end)
  for (const e of entries) { const q = e.resource; if (q.resourceType === 'Patient' && q.deceasedDateTime) deadAt[q.id] = Date.parse(q.deceasedDateTime); }
  for (const e of entries) { const q = e.resource; if (q.resourceType === 'Encounter' && q.class && q.class.code === 'IMP' && q.subject && q.period && q.period.end) { const pp = q.subject.reference.slice(8), cur = lastStay[pp]; if (!cur || Date.parse(q.period.end) > cur.end) lastStay[pp] = { id: q.id, end: Date.parse(q.period.end) }; } }
  const chronicCodes = new Set(Object.values(T.CONDITIONS).filter(d => d.chronic).map(d => d.code)), chronicOf = {};   // patient -> distinct chronic condition codes
  for (const e of entries) { const c = e.resource; if (c.resourceType === 'Condition' && c.subject && c.code && c.code.coding && chronicCodes.has(c.code.coding[0].code)) (chronicOf[c.subject.reference.slice(8)] = chronicOf[c.subject.reference.slice(8)] || new Set()).add(c.code.coding[0].code); }
  const sigmoid = z => 1 / (1 + Math.exp(-z));
  const n = { episodes: 0, admit_sources: {}, coded_reasons: 0, escalation: { icu_transfers: 0, rapid_responses: 0, both: 0 }, dispositions: {}, orders: { procedures: 0, medications: 0, initial_plan: { 'Procedure + medication': 0, 'Procedure only': 0, 'Medication only': 0, 'Observation only': 0 }, skipped_for_penicillin_allergy: 0 } };
  for (const e of entries) {
    const x = e.resource;
    if (x.resourceType !== 'Encounter' || !x.class || x.class.code !== 'IMP') continue;
    n.episodes++;
    const r = rng2('inp:' + x.id);
    const pid = x.subject && x.subject.reference ? x.subject.reference.slice(8) : '';
    const start = Date.parse(x.period && x.period.start), age = birthOf[pid] !== undefined && !isNaN(start) ? (start - birthOf[pid]) / YEAR : 0;
    const mix = age >= 75 ? ADMIT_MIX.old : ADMIT_MIX.usual;
    let roll = r(), k = 0, acc = 0;
    for (; k < mix.length - 1; k++) { acc += mix[k]; if (roll < acc) break; }
    const [code, display] = ADMIT_SOURCES[k];
    x.hospitalization = Object.assign({}, x.hospitalization, { admitSource: { coding: [{ system: ADMIT_SYSTEM, code, display }] } });
    n.admit_sources[code] = (n.admit_sources[code] || 0) + 1;
    const text = x.reasonCode && x.reasonCode[0] && x.reasonCode[0].text, hit = text && INP_REASONS.find(([, re]) => re.test(text));
    if (hit && T.CONDITIONS[hit[0]]) {
      const d = T.CONDITIONS[hit[0]];
      x.reasonCode[0].coding = [{ system: SNOMED, code: d.code, display: d.display }];
      n.coded_reasons++;
    }
    // ---- T.1b: in-stay orders. All times lie inside [start, end] of the stay; first 48 h = initial plan.
    const key = hit && hit[0], plan = key && INP_ORDERS[key], endMs = Date.parse(x.period && x.period.end);
    if (isNaN(start) || isNaN(endMs) || endMs <= start) continue;
    let seq = 0;
    if (plan) {
    const within = (from, to) => Math.floor((from + r() * (to - from)) / 1000) * 1000;
    const order = (kind, dictKey, at) => {
      const id = `${x.id}-inp-${++seq}`;
      if (kind === 'proc') { const d = T.PROCEDURES[dictKey]; added.push({ fullUrl: `urn:uuid:${id}`, resource: { resourceType: 'Procedure', id, status: 'completed', code: cc(SNOMED, d), subject: x.subject, performedDateTime: iso(at), text: div(`${d.terms[0]} performed`) } }); n.orders.procedures++; if (ctx.stats) ctx.stats.procedures++; }
      else { const d = T.MEDICATIONS[dictKey]; added.push({ fullUrl: `urn:uuid:${id}`, resource: { resourceType: 'MedicationStatement', id, status: 'active', medicationCodeableConcept: cc(RXNORM, d), subject: x.subject, effectiveDateTime: iso(at), text: div(`${d.display} prescribed`) } }); n.orders.medications++; if (ctx.stats) ctx.stats.medications++; }
    };
    const allergic = penicillin.has(pid), blocked = k2 => k2 === 'amoxicillin' && allergic;
    const first48End = Math.min(endMs, start + 48 * 3600000), roll1 = r();
    // about 70% get the whole core set in the first 48 h, 20% only one of its two items, 10% nothing
    const wantProc = roll1 < 0.70 || (roll1 < 0.80), wantMed = roll1 < 0.70 || (roll1 >= 0.80 && roll1 < 0.90);
    let gotProc = false, gotMed = false;
    if (wantProc && plan.proc) { order('proc', plan.proc, within(start + 600000, first48End)); gotProc = true; }
    if (wantMed && plan.med) { if (blocked(plan.med)) n.orders.skipped_for_penicillin_allergy++; else { order('med', plan.med, within(start + 600000, first48End)); gotMed = true; } }
    n.orders.initial_plan[gotProc && gotMed ? 'Procedure + medication' : gotProc ? 'Procedure only' : gotMed ? 'Medication only' : 'Observation only']++;
    // about 25% get a second item later in the stay (only when the stay lasts longer than 48 h)
    const roll2 = r(), laterFrom = start + 48 * 3600000;
    if (roll2 < 0.25 && plan.extra && endMs - laterFrom > 3600000) {
      const ex = plan.extra;
      if (ex.proc) order('proc', ex.proc, within(laterFrom, endMs));
      else if (blocked(ex.med)) n.orders.skipped_for_penicillin_allergy++; else order('med', ex.med, within(laterFrom, endMs));
    }
    }
    // ---- T.1c: escalation. Own random stream (so T.1a and T.1b output never moves). Logistic-style rule: older than 65, 3+ chronic conditions
    // and heart failure or pneumonia raise the chance; overall about 12% ICU transfers and 6% rapid-response calls, both together under 1%.
    const re = rng2('inp-esc:' + x.id), feat = (age > 65 ? 1 : 0) + ((chronicOf[pid] ? chronicOf[pid].size : 0) >= 3 ? 1 : 0) + (key === 'heart_failure' || key === 'pneumonia' ? 1 : 0);
    const pIcu = sigmoid(ICU_B0 + ICU_B * feat), pRr = sigmoid(RR_B0 + RR_B * feat), u = re(), both = re() < 0.05;
    const dur = endMs - start;
    const child = (text, from, to) => {
      const id = `${x.id}-inp-${++seq}`;
      added.push({ fullUrl: `urn:uuid:${id}`, resource: { resourceType: 'Encounter', id, status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'ACUTE', display: 'inpatient acute' }, type: [{ text }], subject: x.subject, partOf: { reference: 'Encounter/' + x.id }, period: { start: iso(from), end: iso(to) }, text: div(`${text} during inpatient stay.`) } });
      if (ctx.stats) ctx.stats.encounters++;
    };
    const wantIcu = u < pIcu, wantRr = !wantIcu && u < pIcu + pRr;
    const icu = () => { const len = Math.min((1 + re() * 3) * 86400000, dur * 0.8), from = Math.floor((start + re() * (dur - len)) / 1000) * 1000; child('Intensive care unit stay', from, Math.min(endMs, Math.floor((from + len) / 1000) * 1000)); n.escalation.icu_transfers++; };
    const rr = () => { const len = Math.min((1 + re() * 3) * 3600000, dur), from = Math.floor((start + re() * (dur - len)) / 1000) * 1000; child('Rapid response', from, Math.min(endMs, Math.floor((from + len) / 1000) * 1000)); n.escalation.rapid_responses++; };
    if (wantIcu) { icu(); if (both) { rr(); n.escalation.both++; } } else if (wantRr) rr();
    // ---- T.1d: discharge disposition, drawn after escalation is known (own stream). Home by default; skilled nursing, rehabilitation and
    // left-against-advice are more likely with age 75+, an escalation or 3+ chronic conditions. `exp` ONLY for a patient's last stay when the
    // patient already has deceasedDateTime and it falls within 30 days after the discharge. A patient's death is never added or changed.
    const have = x.hospitalization && x.hospitalization.dischargeDisposition;   // chunk 3.4b: a stay that already has a disposition (stayDetail) keeps it
    if (have) { const c0 = have.coding[0].code; n.dispositions[c0] = (n.dispositions[c0] || 0) + 1; continue; }
    const rd = rng2('inp-dis:' + x.id), risk = (age >= 75 ? 1 : 0) + (wantIcu || wantRr ? 1 : 0) + ((chronicOf[pid] ? chronicOf[pid].size : 0) >= 3 ? 1 : 0), dr = rd();
    const dd = deadAt[pid], lastOne = lastStay[pid] && lastStay[pid].id === x.id;
    let dcode;
    if (lastOne && dd !== undefined && dd >= endMs && dd - endMs <= 30 * 86400000) dcode = 'exp';
    else { const pSnf = 0.06 + 0.05 * risk, pRehab = 0.05 + 0.04 * risk, pAma = 0.02 + 0.01 * risk, pOth = 0.02; dcode = dr < pSnf ? 'snf' : dr < pSnf + pRehab ? 'rehab' : dr < pSnf + pRehab + pAma ? 'aadvice' : dr < pSnf + pRehab + pAma + pOth ? 'oth' : 'home'; }
    x.hospitalization = Object.assign({}, x.hospitalization, { dischargeDisposition: { coding: [{ system: DISPO_SYSTEM, code: dcode, display: DISPO[dcode] }] } });
    n.dispositions[dcode] = (n.dispositions[dcode] || 0) + 1;
  }
  for (const e of added) entries.push(e);
  return n;
}

// ---------------------------------------------------------------------------------------------
// Enrichment (option `enrich`, off by default). A post-processing pass over the finished bundle with its own random
// stream per patient (rng2(pid + ':enr')), so with `enrich` off the bundle is identical to before. It only ADDS resources
// (ids end in -enr-<n>) so small batches have enough events for the analytics that need volume:
//   chronic      extra heart-failure (age 55+, with furosemide / lisinopril) and COPD (age 45+, with albuterol) patients
//   admissions   extra heart-failure / COPD / pneumonia / UTI stays, each with a possible 30-day readmission
//   afib         extra atrial fibrillation (age 60+), anticoagulant series (warfarin / apixaban), ECG, some aspirin overlap, some stroke
//   dialysis     a share of CKD patients (age 55+) get a short series of dialysis sessions
//   conflicts    a share of penicillin-allergic patients get amoxicillin after the allergy was recorded
// All rates are the generator's own assumptions, not observed data. Run before the inpatient pass so new stays get detail too.
// ---------------------------------------------------------------------------------------------
const ENR = { hfAdmit: 0.9, copdAdmit: 0.8, pneuAdmit: 0.15, utiAdmit: 0.10, readmit: 0.22, afib: 0.07, stroke: 0.08, aspirinOverlap: 0.3, dialysis: 0.3, penicillinConflict: 0.3, hfAdd: 0.06, copdAdd: 0.05 };
function addEnrichment(entries, rng2, ctx) {
  const { end, years, stats } = ctx;
  const iso = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  const div = txt => ({ status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${esc(txt)}</div>` });
  const cc = (system, d) => ({ coding: [{ system, code: d.code, display: d.display }], text: d.display });
  const keyOf = Object.fromEntries(Object.entries(T.CONDITIONS).map(([k, d]) => [d.code, k]));
  const info = {};   // patient id -> { birth, dead, onset{key:ms}, penicillinAt }
  const P = id => info[id] || (info[id] = { onset: {} });
  for (const e of entries) {
    const x = e.resource;
    if (x.resourceType === 'Patient') { const p = P(x.id); p.birth = Date.parse(x.birthDate); p.dead = x.deceasedDateTime ? Date.parse(x.deceasedDateTime) : null; }
    else if (x.resourceType === 'Condition' && x.subject && x.code && x.code.coding) { const k = keyOf[x.code.coding[0].code], t = Date.parse(x.onsetDateTime); if (k && !isNaN(t)) { const o = P(x.subject.reference.slice(8)).onset; if (o[k] === undefined || t < o[k]) o[k] = t; } }
    else if (x.resourceType === 'AllergyIntolerance' && x.patient && x.code && x.code.coding && x.code.coding[0].code === T.ALLERGENS.penicillin.code) P(x.patient.reference.slice(8)).penicillinAt = Date.parse(x.recordedDate);
  }
  const n = { patients_touched: 0, hf_added: 0, copd_added: 0, admissions: 0, readmissions: 0, afib_added: 0, anticoagulant_patients: 0, strokes_added: 0, dialysis_sessions: 0, allergy_conflicts: 0 };
  const added = [];
  for (const pid of Object.keys(info)) {
    const p = info[pid];
    if (p.birth === undefined || isNaN(p.birth)) continue;
    const r = rng2(pid + ':enr'), between = (a, b) => a + (b - a) * r(), ref = { reference: 'Patient/' + pid };
    const age = (end - p.birth) / YEAR, start = Math.max(p.birth + 30 * DAY, end - years * YEAR), stop = Math.min(end - 40 * DAY, p.dead ? p.dead - DAY : Infinity);
    if (!(stop - start > 120 * DAY)) continue;
    let seq = 0, touched = false;
    const id = () => `${pid}-enr-${++seq}`, push = res => { added.push({ fullUrl: `urn:uuid:${res.id}`, resource: res }); touched = true; };
    const condition = (key, at) => { const d = T.CONDITIONS[key]; push({ resourceType: 'Condition', id: id(), clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] }, code: cc(SNOMED, d), subject: ref, onsetDateTime: iso(at), recordedDate: iso(at), text: div(d.display) }); stats.conditions++; p.onset[key] = p.onset[key] === undefined ? at : Math.min(p.onset[key], at); };
    const stay = (reason, at, los) => { const endAt = at + los * DAY; push({ resourceType: 'Encounter', id: id(), status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'IMP', display: 'inpatient encounter' }, type: [{ text: 'Hospital admission' }], subject: ref, period: { start: iso(at), end: iso(endAt) }, reasonCode: [{ text: reason }], text: div(`Inpatient admission: ${reason}.`) }); stats.encounters++; n.admissions++; return endAt; };
    const admitWithReadmit = (label, from) => {
      const lo = Math.max(start, from + 30 * DAY); if (!(lo < stop)) return;
      const dis = stay(label, between(lo, stop), Math.round(between(3, 9)));
      if (r() < ENR.readmit && dis + 4 * DAY < stop) { stay(`${label} (readmission)`, Math.min(stop, dis + between(4, 28) * DAY), Math.round(between(2, 6))); n.readmissions++; }
    };
    const medSeries = (key, at, renew = true) => {
      const d = T.MEDICATIONS[key]; let t = at;
      do { if (t >= end) break; push({ resourceType: 'MedicationStatement', id: id(), status: 'active', medicationCodeableConcept: cc(RXNORM, d), subject: ref, effectiveDateTime: iso(t), text: div(`${d.display} prescribed`) }); stats.medications++; t += between(160, 200) * DAY; } while (renew && t < end && r() < 0.93);
    };
    const procedure = (key, at) => { const d = T.PROCEDURES[key]; push({ resourceType: 'Procedure', id: id(), status: 'completed', code: cc(SNOMED, d), subject: ref, performedDateTime: iso(at), text: div(`${d.terms[0]} performed`) }); stats.procedures++; };
    // extra chronic patients (so the admission and readmission analytics have volume)
    if (age >= 55 && p.onset.heart_failure === undefined && r() < ENR.hfAdd) { const lo = Math.max(start, p.birth + 50 * YEAR); if (lo < stop - 200 * DAY) { const at = between(lo, stop - 200 * DAY); condition('heart_failure', at); n.hf_added++; if (r() < 0.9) medSeries('furosemide', at + between(0, 60) * DAY); if (r() < 0.5) medSeries('lisinopril', at + between(0, 60) * DAY); } }
    if (age >= 45 && p.onset.copd === undefined && r() < ENR.copdAdd) { const lo = Math.max(start, p.birth + 40 * YEAR); if (lo < stop - 200 * DAY) { const at = between(lo, stop - 200 * DAY); condition('copd', at); n.copd_added++; if (r() < 0.8) medSeries('albuterol', at + between(0, 60) * DAY); } }
    // admissions
    if (p.onset.heart_failure !== undefined && r() < ENR.hfAdmit) for (let i = 1 + Math.floor(r() * 3); i > 0; i--) admitWithReadmit('Acute exacerbation of heart failure', p.onset.heart_failure);
    if (p.onset.copd !== undefined && r() < ENR.copdAdmit) for (let i = 1 + Math.floor(r() * 3); i > 0; i--) admitWithReadmit('Acute exacerbation of COPD', p.onset.copd);
    if ((age >= 65 || p.onset.copd !== undefined) && r() < ENR.pneuAdmit) { const at = between(start, stop); condition('pneumonia', at); stay('Pneumonia', at, Math.round(between(3, 8))); if (r() < ENR.readmit) { stay('Pneumonia (readmission)', at + between(8, 28) * DAY, Math.round(between(2, 6))); n.readmissions++; } }
    if (age >= 75 && r() < ENR.utiAdmit) { const at = between(start, stop); condition('uti', at); stay('Urinary tract infection', at, Math.round(between(3, 6))); }
    // atrial fibrillation and anticoagulation
    if (age >= 60 && p.onset.afib === undefined && r() < ENR.afib) {
      const lo = Math.max(start, p.birth + 55 * YEAR); if (lo < stop) {
        const at = between(lo, stop); condition('afib', at); n.afib_added++;
        const m = r(); if (m < 0.9) { const drug = m < 0.4 ? 'warfarin' : 'apixaban', t0 = at + between(0, 60) * DAY; if (t0 < end) { medSeries(drug, t0); n.anticoagulant_patients++; if (r() < ENR.aspirinOverlap) medSeries('aspirin', Math.min(end - 30 * DAY, t0 + between(30, 400) * DAY)); } }
        if (r() < 0.6) procedure('ecg', at + DAY);
        if (r() < ENR.stroke) { condition('stroke', Math.min(stop, at + between(60, 900) * DAY)); n.strokes_added++; }
      }
    }
    // dialysis
    if (p.onset.ckd !== undefined && age > 55 && r() < ENR.dialysis) {
      let t = between(Math.max(start, p.onset.ckd + 90 * DAY, end - 2 * YEAR), stop); if (t < stop) for (let k = 4 + Math.floor(r() * 13); k > 0 && t < stop; k--) { procedure('dialysis', t); n.dialysis_sessions++; t += between(6, 8) * DAY; }
    }
    // drug-allergy conflicts
    if (p.penicillinAt !== undefined && r() < ENR.penicillinConflict) { const at = p.penicillinAt + between(30, 500) * DAY; if (at < stop) { medSeries('amoxicillin', at, false); n.allergy_conflicts++; } }
    if (touched) n.patients_touched++;
  }
  for (const e of added) entries.push(e);
  return n;
}

// ---------------------------------------------------------------------------------------------
// Uncoded mode (option `uncoded`: 'none' (default) | 'partial' | 'all'). A post-processing pass over the finished bundle
// (after messy), with its own random stream per record (rng2(id + ':unc')) and per patient, so with `uncoded` off the bundle
// is identical to before. It removes the coding from the six enrichment domains (dx, rx, ob, pr, al, im) and keeps only the
// free text a clinician would have typed (a synonym such as "sugar diabetes", "htn", "a1c"), so V2 / V4 cannot see those
// records and V3 / V5 (code enrichment) have something to fix. Narratives, values, units and dates are not touched.
//   all      every record in the six domains loses its code (try enrichment from zero)
//   partial  a share of records loses its code: the rates differ by domain (allergies and procedures are coded least often)
//            and by patient (about one patient in five comes from a "non-coding site" with a much higher rate), like real exports.
// The rates are the generator's own assumptions, not observed data.
// ---------------------------------------------------------------------------------------------
const UNCODED_RATE = { dx: 0.35, rx: 0.25, ob: 0.15, pr: 0.40, al: 0.50, im: 0.20 };
function applyUncoded(entries, rng2, mode) {
  const byDisplay = {};
  for (const [dom, dict, field] of [['dx', T.CONDITIONS, 'code'], ['rx', T.MEDICATIONS, 'medicationCodeableConcept'], ['ob', T.LABS, 'code'], ['pr', T.PROCEDURES, 'code'], ['al', T.ALLERGENS, 'code'], ['im', T.IMMUNIZATIONS, 'vaccineCode']])
    for (const d of Object.values(dict)) byDisplay[dom + '|' + String(d.display).toLowerCase()] = d;
  const DOM = { Condition: ['dx', 'code', 'subject'], MedicationStatement: ['rx', 'medicationCodeableConcept', 'subject'], Observation: ['ob', 'code', 'subject'], Procedure: ['pr', 'code', 'subject'], AllergyIntolerance: ['al', 'code', 'patient'], Immunization: ['im', 'vaccineCode', 'patient'] };
  const info = { mode, records: {}, uncoded: {} };
  for (const k of Object.keys(UNCODED_RATE)) { info.records[k] = 0; info.uncoded[k] = 0; }
  const siteOf = {};   // patient id -> rate factor (a few patients come from a site that hardly codes)
  const factor = pid => siteOf[pid] === undefined ? (siteOf[pid] = rng2(pid + ':unc-site')() < 0.2 ? 2.2 : 0.8) : siteOf[pid];
  const variant = (r, term) => { const x = r(); return x < 0.55 ? term : x < 0.75 ? term.charAt(0).toUpperCase() + term.slice(1) : x < 0.9 ? term.toUpperCase() : '  ' + term + ' '; };
  for (const e of entries) {
    const x = e.resource, m = DOM[x.resourceType];
    if (!m) continue;
    const [dom, field, who] = m, cc = x[field];
    if (!cc || !cc.coding || !cc.coding.length) continue;   // already uncoded
    info.records[dom]++;
    const ref = x[who] && x[who].reference ? x[who].reference.slice(8) : '', r = rng2(x.id + ':unc');
    if (mode !== 'all' && !(r() < Math.min(0.95, UNCODED_RATE[dom] * factor(ref)))) continue;
    const disp = String(cc.coding[0].display || cc.text || ''), d = byDisplay[dom + '|' + disp.toLowerCase()];
    // free text: keep a text the generator already wrote when it differs from the official display (a synonym), else draw a synonym
    const keep = cc.text && cc.text.toLowerCase() !== disp.toLowerCase() ? cc.text : null;
    const text = keep || (d && d.terms && d.terms.length ? variant(r, d.terms[Math.floor(r() * d.terms.length)]) : disp.toLowerCase());
    x[field] = { text };
    info.uncoded[dom]++;
  }
  info.total_uncoded = Object.values(info.uncoded).reduce((t, v) => t + v, 0);
  info.share_pct = (() => { const n = Object.values(info.records).reduce((t, v) => t + v, 0); return n ? Math.round(1000 * info.total_uncoded / n) / 10 : 0; })();
  return info;
}

// term list of a medication code in the demo dictionary (for the occasional "<term> daily" wording)
const MED_TERMS = Object.fromEntries(Object.values(T.MEDICATIONS).map(d => [d.code, d.terms || []]));

function generateBundle(opts = {}) {
  const o = { count: 100, seed: 42, years: 8, endDate: new Date(), ...opts };
  o.count = clamp(parseInt(o.count, 10) || 100, 1, 5000);
  o.years = clamp(parseInt(o.years, 10) || 8, 1, 20);
  const end = +new Date(o.endDate);
  const rng = mulberry32(hashSeed(o.seed));
  const rnd = () => rng();
  // Separate random stream for fields added later (death, ...): using it never changes what the main stream produces,
  // so an existing seed still yields the same patients, conditions, labs and encounters.
  const rng2 = id => mulberry32(hashSeed(`${o.seed}:${id}`));
  const randn = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const pick = a => a[Math.floor(rnd() * a.length)];
  const between = (a, b) => a + (b - a) * rnd();
  const prefix = `syn${String(o.seed).replace(/[^a-zA-Z0-9]/g, '')}`;
  const iso = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  const isoDate = ms => new Date(ms).toISOString().slice(0, 10);
  const entries = [];
  let seq = 0;
  const nid = t => `${prefix}-${t}-${++seq}`;
  const div = txt => ({ status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${esc(txt)}</div>` });
  const cc = (system, d, text) => ({ coding: [{ system, code: d.code, display: d.display }], text: text || d.display });
  const push = r => { entries.push({ fullUrl: `urn:uuid:${r.id}`, resource: r }); return r; };

  const stats = { immunizations: 0, deceased: 0, patients: 0, conditions: 0, encounters: 0, observations: 0, medications: 0, procedures: 0, allergies: 0 };

  for (let n = 1; n <= o.count; n++) {
    // ---------- demographics ----------
    const female = rnd() < 0.51;
    const r = rnd();
    const age = r < 0.20 ? between(0, 18) : r < 0.45 ? between(18, 40) : r < 0.80 ? between(40, 65) : r < 0.97 ? between(65, 85) : between(85, 97);
    const birth = end - age * YEAR - rnd() * 30 * DAY;
    const pid = `${prefix}-p${n}`;
    const ref = `Patient/${pid}`;
    const start = Math.max(birth + 30 * DAY, end - o.years * YEAR);
    const adult = age >= 18;
    const adherence = clamp(0.65 + randn() * 0.22, 0.05, 1);   // quality of disease control
    const monitored = rnd() < 0.8;                              // follows monitoring schedule
    const screener = rnd() < 0.7;                               // attends preventive screening
    let rr = rnd(), acc = 0, race = RACES[0];
    for (const x of RACES) { acc += x[2]; if (rr <= acc) { race = x; break; } }
    const hispanic = rnd() < 0.18;
    const [city, state, zip] = pick(CITIES);
    const height = (female ? 1.63 : 1.77) + randn() * 0.06;

    const patientRes = push({
      resourceType: 'Patient', id: pid,
      text: div(`${female ? 'Female' : 'Male'} patient, age ${Math.floor(age)}`),
      extension: [
        { url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-race', extension: [{ url: 'ombCategory', valueCoding: { system: 'urn:oid:2.16.840.1.113883.6.238', code: race[0], display: race[1] } }, { url: 'text', valueString: race[1] }] },
        { url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-ethnicity', extension: [{ url: 'ombCategory', valueCoding: { system: 'urn:oid:2.16.840.1.113883.6.238', code: hispanic ? '2135-2' : '2186-5', display: hispanic ? 'Hispanic or Latino' : 'Not Hispanic or Latino' } }, { url: 'text', valueString: hispanic ? 'Hispanic or Latino' : 'Not Hispanic or Latino' }] }
      ],
      gender: female ? 'female' : 'male', birthDate: isoDate(birth),
      address: [{ city, state, postalCode: zip, country: 'US' }]
    });
    stats.patients++;

    // ---------- resource helpers (closed over this patient) ----------
    const onset = {};           // condition key -> ms
    const firstMed = {};        // med key -> first prescription ms
    const penicillinAllergyAt = [];
    const addCondition = (key, at, note) => {
      const d = T.CONDITIONS[key];
      const term = pick(d.terms);
      const txt = note || pick([d.display, `Patient with ${term}`, `History of ${term}`, `${term} - follow up`, term.toUpperCase()]);
      push({ resourceType: 'Condition', id: nid('c'), clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] }, code: cc(SNOMED, d, rnd() < 0.15 ? term : d.display), subject: { reference: ref }, onsetDateTime: iso(at), recordedDate: iso(at), text: div(txt) });
      stats.conditions++;
      if (onset[key] === undefined) onset[key] = at;
    };
    const mentionNote = () => {   // narrative noise for V1: negations + un-coded "suspected" mentions
      const absent = Object.keys(T.CONDITIONS).filter(k => onset[k] === undefined && T.CONDITIONS[k].chronic);
      const roll = rnd();
      if (roll < 0.06 && absent.length) return `denies chest pain; no history of ${pick(T.CONDITIONS[pick(absent)].terms)}`;
      if (roll < 0.09 && absent.length) return `probable ${pick(T.CONDITIONS[pick(absent)].terms)} noted, work-up ordered`;
      return '';
    };
    const addEncounter = (cls, at, reason, losDays = 0, extra = '') => {
      const endAt = cls === 'IMP' ? at + losDays * DAY : cls === 'EMER' ? at + 4 * 3600000 : at + 30 * 60000;
      const label = { AMB: 'ambulatory', EMER: 'emergency', IMP: 'inpatient encounter' }[cls];
      push({ resourceType: 'Encounter', id: nid('e'), status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: cls, display: label }, type: [{ text: cls === 'AMB' ? 'Office visit' : cls === 'EMER' ? 'Emergency department visit' : 'Hospital admission' }], subject: { reference: ref }, period: { start: iso(at), end: iso(endAt) }, reasonCode: [{ text: reason }], text: div(`${cls === 'AMB' ? 'Ambulatory clinic visit' : cls === 'EMER' ? 'Emergency room visit' : 'Inpatient admission'}: ${reason}. ${extra} ${mentionNote()}`.trim()) });
      stats.encounters++;
      return endAt;
    };
    const addObs = (key, at, value) => {
      const d = T.LABS[key];
      const v = Math.round(value * 10) / 10;
      push({ resourceType: 'Observation', id: nid('o'), status: 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: ['sbp', 'dbp', 'bmi', 'hr', 'weight', 'spo2'].includes(key) ? 'vital-signs' : 'laboratory' }] }], code: cc(LOINC, d), subject: { reference: ref }, effectiveDateTime: iso(at), valueQuantity: { value: v, unit: d.unit, system: 'http://unitsofmeasure.org', code: d.unit }, text: div(`${d.display}: ${v} ${d.unit}`) });
      stats.observations++;
    };
    const addProcedure = (key, at, extra) => {
      const d = T.PROCEDURES[key];
      push({ resourceType: 'Procedure', id: nid('pr'), status: 'completed', code: cc(SNOMED, d), subject: { reference: ref }, performedDateTime: iso(at), text: div(extra || `${pick(d.terms)} performed`) });
      stats.procedures++;
    };
    const addMedSeries = (key, at, renew = true) => {
      const d = T.MEDICATIONS[key];
      if (firstMed[key] === undefined) firstMed[key] = at;
      let t = at;
      do {
        push({ resourceType: 'MedicationStatement', id: nid('m'), status: 'active', medicationCodeableConcept: cc(RXNORM, d, rnd() < 0.2 ? `${pick(d.terms)} daily` : d.display), subject: { reference: ref }, effectiveDateTime: iso(t), text: div(`${d.display} prescribed`) });
        stats.medications++;
        t += between(160, 200) * DAY;
      } while (renew && t < end && rnd() < 0.93);
    };
    const addAllergy = (key, at, severity) => {
      const d = T.ALLERGENS[key];
      const rk = severity === 'severe' ? 'anaphylaxis' : pick(['rash', 'hives', 'nausea']);
      push({ resourceType: 'AllergyIntolerance', id: nid('a'), clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] }, code: cc(SNOMED, d, `Allergy to ${pick(d.terms)}`), patient: { reference: ref }, recordedDate: iso(at), reaction: [{ manifestation: [{ coding: [{ system: SNOMED, code: T.REACTIONS[rk].code, display: T.REACTIONS[rk].display }] }], severity }], text: div(`${d.display} allergy - ${T.REACTIONS[rk].display.toLowerCase()}`) });
      stats.allergies++;
      if (key === 'penicillin') penicillinAllergyAt.push(at);
    };
    const onsetFor = (minAge) => {
      const lo = Math.max(start, birth + minAge * YEAR), hi = end - 45 * DAY;
      return lo >= hi ? null : lo + (hi - lo) * Math.pow(rnd(), 1.3);
    };
    const chance = (key, p, minAge = 18) => { if (rnd() < p) { const at = onsetFor(minAge); if (at) { addCondition(key, at); return at; } } return null; };

    // ---------- chronic disease model ----------
    if (adult) {
      chance('obesity', 0.30);
      const ob = onset.obesity !== undefined;
      chance('diabetes', clamp((age - 30) / 160, 0, 0.3) * (ob ? 1.8 : 1));
      chance('hypertension', clamp((age - 25) / 90, 0, 0.6) * (onset.diabetes ? 1.3 : 1));
      chance('hyperlipidemia', clamp((age - 30) / 100, 0, 0.5) * (onset.diabetes ? 1.3 : 1));
      chance('ckd', clamp(age / 60 * (onset.diabetes ? 0.2 : 0.05), 0, 0.4));
      chance('cad', clamp((age - 45) / 150, 0, 0.3) * (female ? 0.7 : 1.4));
      if (onset.cad !== undefined || age > 60) chance('heart_failure', onset.cad !== undefined ? 0.15 : 0.02);
      chance('afib', clamp((age - 55) / 250, 0, 0.18));
      if (age > 55) chance('stroke', onset.afib !== undefined ? 0.1 : 0.02);
      if (age > 45) chance('copd', 0.08);
      chance('depression', 0.15);
      if (female && age > 55) chance('osteoporosis', 0.15);
      chance('anemia', 0.08);
      if (female && age > 40) chance('breast_cancer', 0.015);
      if (age > 45) chance('colorectal_cancer', 0.01);
    }
    chance('asthma', 0.09, 0);

    // ---------- treatment ----------
    const startFor = (cond, p, medKey, lagMax = 60) => { if (onset[cond] !== undefined && rnd() < p && firstMed[medKey] === undefined) { const at = onset[cond] + rnd() * lagMax * DAY; if (at < end) addMedSeries(medKey, at); } };
    startFor('diabetes', 0.9, 'metformin');
    if (onset.diabetes !== undefined && rnd() < 0.25) { const at = onset.diabetes + between(365, 1100) * DAY; if (at < end) addMedSeries('insulin_glargine', at); }
    if (onset.hypertension !== undefined) { const m = rnd(); startFor('hypertension', 0.85, m < 0.45 ? 'lisinopril' : m < 0.75 ? 'amlodipine' : 'losartan'); if (rnd() < 0.2) startFor('hypertension', 1, 'amlodipine', 200); }
    startFor('hyperlipidemia', 0.8, 'atorvastatin');
    startFor('asthma', 0.9, 'albuterol');
    startFor('depression', 0.6, 'sertraline');
    startFor('heart_failure', 0.9, 'furosemide'); startFor('heart_failure', 0.5, 'lisinopril');
    startFor('cad', 0.85, 'aspirin'); startFor('cad', 0.25, 'clopidogrel'); startFor('cad', 0.6, 'atorvastatin');
    if (onset.afib !== undefined) { const m = rnd(); if (m < 0.4) startFor('afib', 1, 'warfarin'); else if (m < 0.9) startFor('afib', 1, 'apixaban'); }
    startFor('stroke', 0.8, 'aspirin');
    // deliberate risky co-prescriptions so polypharmacy / safety analytics have signal
    if ((firstMed.warfarin !== undefined || firstMed.apixaban !== undefined) && rnd() < 0.3 && firstMed.aspirin === undefined) addMedSeries('aspirin', Math.min(end - 30 * DAY, (firstMed.warfarin ?? firstMed.apixaban) + between(30, 400) * DAY));
    if (firstMed.warfarin !== undefined && firstMed.clopidogrel === undefined && rnd() < 0.1) addMedSeries('clopidogrel', Math.min(end - 30 * DAY, firstMed.warfarin + between(30, 300) * DAY));
    if (firstMed.lisinopril !== undefined && firstMed.losartan === undefined && onset.hypertension !== undefined && rnd() < 0.08) addMedSeries('losartan', Math.min(end - 30 * DAY, firstMed.lisinopril + between(30, 300) * DAY));

    // ---------- control trajectories (used by labs and BP) ----------
    const firstTreat = (keys) => { const ts = keys.map(k => firstMed[k]).filter(x => x !== undefined); return ts.length ? Math.min(...ts) : null; };
    const dmTreat = firstTreat(['metformin', 'insulin_glargine']);
    const htnTreat = firstTreat(['lisinopril', 'amlodipine', 'losartan']);
    const lipTreat = firstTreat(['atorvastatin']);
    const decay = (t0, treatAt, t, initial, target) => treatAt && t >= treatAt ? target + (initial - target) * Math.exp(-(t - treatAt) / (150 * DAY)) : initial;
    const hba1cInit = 8.8 + randn() * 0.8, ldlInit = 165 + randn() * 18, egfr0 = 52 + randn() * 8;
    const bpAt = t => {
      let sbp = 116 + (age - 40) * 0.3 + randn() * 7;
      if (onset.hypertension !== undefined && t >= onset.hypertension) sbp = decay(0, htnTreat, t, 152 + randn() * 8, 122 + (1 - adherence) * 30) + randn() * 7;
      sbp = clamp(sbp, 85, 215);
      return [sbp, clamp(sbp * 0.6 + randn() * 4, 50, 125)];
    };

    // ---------- scheduled chronic monitoring ----------
    const series = (from, every, fn) => { for (let t = from; t < end; t += every * DAY * between(0.85, 1.15)) fn(t); };
    if (onset.diabetes !== undefined) series(onset.diabetes, monitored ? between(90, 150) : between(300, 600), t => {
      const target = 6.2 + (1 - adherence) * 3.2;
      const a1c = clamp(decay(0, dmTreat, t, hba1cInit, target) + randn() * 0.35, 4.6, 14);
      addEncounter('AMB', t, 'Diabetes follow-up', 0, `HbA1c ${a1c.toFixed(1)}`);
      addObs('hba1c', t, a1c); addObs('glucose', t, 100 + (a1c - 5) * 28 + randn() * 15);
    });
    if (onset.hyperlipidemia !== undefined) series(onset.hyperlipidemia, monitored ? 365 : 730, t => {
      const ldl = clamp(decay(0, lipTreat, t, ldlInit, 85 + (1 - adherence) * 60) + randn() * 8, 40, 260);
      const hdl = clamp((female ? 55 : 45) + randn() * 8, 20, 90), tg = clamp(150 + randn() * 40, 60, 450);
      addObs('ldl', t, ldl); addObs('hdl', t, hdl); addObs('tg', t, tg); addObs('tchol', t, ldl + hdl + tg / 5);
    });
    if (onset.ckd !== undefined) series(onset.ckd, 180, t => {
      const egfr = clamp(egfr0 - ((t - onset.ckd) / YEAR) * 2 + randn() * 3, 8, 90);
      addObs('egfr', t, egfr); addObs('creatinine', t, 1 + (75 - egfr) / 45);
    });
    if (onset.copd !== undefined || onset.asthma !== undefined) series(Math.min(onset.copd ?? Infinity, onset.asthma ?? Infinity), 270, t => addObs('spo2', t, clamp((onset.copd ? 91 : 96) + randn() * 2.5, 78, 100)));

    // ---------- routine ambulatory visits with vitals ----------
    const chronicCount = Object.keys(onset).filter(k => T.CONDITIONS[k].chronic).length;
    const visits = Math.round(((end - start) / YEAR) * clamp(1 + chronicCount * 1.2, 1, 6) * between(0.6, 1.2));
    for (let i = 0; i < visits; i++) {
      const t = between(start, end - DAY);
      addEncounter('AMB', t, pick(COMPLAINTS));
      if (rnd() < 0.75) {
        const [s, d] = bpAt(t);
        addObs('sbp', t, s); addObs('dbp', t, d);
        const bmi = (onset.obesity !== undefined && t >= onset.obesity ? 33 : 25) + randn() * 2.5;
        addObs('bmi', t, adult ? bmi : 19 + randn() * 2); addObs('weight', t, bmi * height * height); addObs('hr', t, 74 + randn() * 9);
      }
    }

    // ---------- acute episodes & admissions ----------
    const admit = (reason, at, los) => { const dis = addEncounter('IMP', at, reason, los); return dis; };
    const acute = (key, p, imp, admitReason) => {
      if (rnd() >= p) return;
      const at = between(start, end - 20 * DAY);
      addCondition(key, at);
      const isAdmit = rnd() < imp;
      if (isAdmit) admit(admitReason, at, Math.round(between(3, 8))); else addEncounter(rnd() < 0.4 ? 'EMER' : 'AMB', at, admitReason);
      if (key === 'pneumonia') addProcedure('chest_xray', at);
      const allergic = penicillinAllergyAt.some(a => a < at);
      if (!allergic || rnd() < 0.08) addMedSeries('amoxicillin', at + DAY, false);   // ~8% are allergy conflicts
    };
    acute('pneumonia', 0.06 + (onset.copd ? 0.12 : 0), 0.35, 'Pneumonia');
    acute('uti', female ? 0.12 : 0.03, 0.03, 'Urinary tract infection');
    const exacerbations = (cond, label, prob) => {
      if (onset[cond] === undefined || rnd() > prob) return;
      const k = 1 + Math.floor(rnd() * 3);
      for (let i = 0; i < k; i++) {
        const at = between(onset[cond] + 30 * DAY, end - 40 * DAY);
        if (!(at > onset[cond])) continue;
        const dis = admit(label, at, Math.round(between(3, 9)));
        if (rnd() < 0.18) admit(`${label} (readmission)`, dis + between(4, 28) * DAY, Math.round(between(2, 6)));
      }
    };
    exacerbations('heart_failure', 'Acute exacerbation of heart failure', 0.7);
    exacerbations('copd', 'Acute exacerbation of COPD', 0.45);
    const edVisits = Math.round(((end - start) / YEAR) * 0.08 * (rnd() * 2));
    for (let i = 0; i < edVisits; i++) addEncounter('EMER', between(start, end - DAY), pick(['Minor injury', 'Abdominal pain', 'Chest pain', 'Fever']));

    // ---------- procedures & screening ----------
    if (onset.cad !== undefined && rnd() < 0.6) addProcedure('ecg', onset.cad + DAY);
    if (onset.afib !== undefined && rnd() < 0.6) addProcedure('ecg', onset.afib + DAY);
    if (onset.cad !== undefined && rnd() < 0.3) addProcedure('angiography', onset.cad + between(7, 90) * DAY);
    if (onset.ckd !== undefined && age > 55 && rnd() < 0.03) addProcedure('dialysis', between(Math.max(start, end - 2 * YEAR), end - DAY));
    if (female && screener) {
      for (let t = start + rnd() * 2 * YEAR; t < end; t += 2 * YEAR + between(-60, 60) * DAY) {
        const a = (t - birth) / YEAR;
        if (a >= 50 && a <= 74 && rnd() < 0.9) addProcedure('mammography', t);
      }
    }
    if (screener && age >= 45 && age <= 85 && rnd() < 0.5) {
      const lo = Math.max(start, birth + 45 * YEAR), hi = Math.min(end - DAY, birth + 75 * YEAR);
      if (lo < hi) addProcedure('colonoscopy', between(lo, hi));
    }

    // ---------- allergies ----------
    if (rnd() < 0.25) {
      const keys = Object.keys(T.ALLERGENS).sort(() => rnd() - 0.5).slice(0, rnd() < 0.7 ? 1 : 2);
      for (const k of keys) { const s = rnd(); addAllergy(k, between(start, end - 60 * DAY), s < 0.5 ? 'mild' : s < 0.85 ? 'moderate' : 'severe'); }
    }

    // ---------- death (own random stream; about 3% of patients, older and sicker more likely) ----------
    // deceasedDateTime lies in the last 80% of the patient's observation window and always before `end`.
    // Other resources are NOT truncated (so existing seeds are unchanged): a deceased patient can still have later records.
    {
      const r2 = rng2(pid + ':death');
      const nChronic = Object.keys(onset).filter(k => T.CONDITIONS[k] && T.CONDITIONS[k].chronic).length;
      const severe = ['heart_failure', 'stroke', 'ckd', 'copd'].some(k => onset[k] !== undefined);
      const pDeath = clamp(0.0015 + 0.0007 * Math.max(0, age - 45) + 0.012 * nChronic + (severe ? 0.045 : 0), 0, 0.5);
      const roll = r2(), when = r2();
      if (roll < pDeath) {
        patientRes.deceasedDateTime = iso(start + (0.2 + 0.8 * when) * (end - DAY - start));
        stats.deceased++;
      }
    }

    // ---------- payer + social determinants (DEMO DATA, own random stream) ----------
    // Custom Patient extensions under http://vibe-rounds/fhir/ext/ (not real FHIR/US Core): payer, income-band,
    // food-insecurity, housing-instability. Correlation built in on purpose so equity analytics show something:
    // Medicaid / uninsured patients and those with food or housing insecurity get EXTRA emergency visits
    // (separate resources with ids ...-xed-N; the original resources are untouched).
    {
      const r2 = rng2(pid + ':sdoh');
      const pickW = list => { let x = r2(), acc2 = 0; for (const [v, w] of list) { acc2 += w; if (x < acc2) return v; } return list[list.length - 1][0]; };
      const payer = age >= 65 ? pickW([['Medicare', 0.85], ['Commercial', 0.08], ['Medicaid', 0.05], ['Uninsured', 0.02]])
        : age >= 18 ? pickW([['Commercial', 0.58], ['Medicaid', 0.22], ['Uninsured', 0.14], ['Medicare', 0.06]])
        : pickW([['Commercial', 0.52], ['Medicaid', 0.42], ['Uninsured', 0.06]]);
      const income = payer === 'Medicaid' || payer === 'Uninsured' ? pickW([['Low', 0.7], ['Middle', 0.27], ['High', 0.03]])
        : payer === 'Commercial' ? pickW([['Low', 0.1], ['Middle', 0.55], ['High', 0.35]])
        : pickW([['Low', 0.35], ['Middle', 0.5], ['High', 0.15]]);
      const food = r2() < { Low: 0.25, Middle: 0.08, High: 0.02 }[income];
      const housing = r2() < { Low: 0.15, Middle: 0.04, High: 0.01 }[income];
      const X = 'http://vibe-rounds/fhir/ext/';
      patientRes.extension.push(
        { url: X + 'payer', valueString: payer },
        { url: X + 'income-band', valueString: income },
        { url: X + 'food-insecurity', valueBoolean: food },
        { url: X + 'housing-instability', valueBoolean: housing }
      );
      const expected = ((end - start) / YEAR) * ((payer === 'Medicaid' ? 0.10 : payer === 'Uninsured' ? 0.12 : 0) + (food || housing ? 0.05 : 0));
      const nExtra = Math.floor(expected) + (r2() < expected - Math.floor(expected) ? 1 : 0);
      for (let i = 1; i <= nExtra; i++) {
        const at = start + r2() * (end - DAY - start), reason = ['Minor injury', 'Abdominal pain', 'Chest pain', 'Fever'][Math.floor(r2() * 4)];
        push({ resourceType: 'Encounter', id: `${pid}-xed-${i}`, status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'EMER', display: 'emergency' }, type: [{ text: 'Emergency department visit' }], subject: { reference: ref }, period: { start: iso(at), end: iso(at + 4 * 3600000) }, reasonCode: [{ text: reason }], text: div(`Emergency room visit: ${reason}.`) });
        stats.encounters++;
      }
    }

    // ---------- immunizations (DEMO DATA, own random stream; ids ...-imm-N, original resources untouched) ----------
    // Influenza: one dose per season (Sep 15 - Dec 31), ~55% of patient-seasons, higher for 65+ and for screening attenders.
    // Tdap: adolescent dose at 11-13 years, then about every 10 years. COVID-19: 2-dose series (2021-03 to 2022-06) plus boosters.
    // Only doses inside the patient's observation window [start, end) are written.
    {
      const r2 = rng2(pid + ':imm'), IM = T.IMMUNIZATIONS, CVX = T.SYSTEMS.cvx;
      let k = 0;
      const addImm = (key, at, dose) => {
        if (!(at >= start && at < end)) return false;
        const d = IM[key];
        push({
          resourceType: 'Immunization', id: `${pid}-imm-${++k}`, status: 'completed',
          vaccineCode: cc(CVX, d), patient: { reference: ref }, occurrenceDateTime: iso(at), primarySource: true,
          ...(dose ? { protocolApplied: [{ doseNumberPositiveInt: dose }] } : {}),
          text: div(`Immunization given: ${d.display} (${d.terms[0]}).`)
        });
        stats.immunizations++;
        return true;
      };
      // influenza
      if (age >= 0.5) {
        const p = clamp(0.55 + (age >= 65 ? 0.15 : age < 18 ? 0.05 : -0.05) + (screener ? 0.1 : -0.15), 0.05, 0.95);
        const pp = clamp(p + (r2() - 0.5) * 0.6, 0.05, 0.95);   // patient-level propensity, mean = p
        for (let y = new Date(start).getUTCFullYear(); y <= new Date(end).getUTCFullYear(); y++) {
          const at = Date.UTC(y, 8, 15) + r2() * 107 * DAY, roll = r2();
          if (roll < pp && at - birth > 0.5 * YEAR) addImm('influenza', at);
        }
      }
      // Tdap
      if (age >= 11 && r2() < 0.75) {
        for (let t = birth + (11 + r2() * 2) * YEAR; t < end; t += (10 + (r2() - 0.5)) * YEAR) addImm('tdap', t);
      }
      // COVID-19
      if (age >= 5 && r2() < (age >= 18 ? 0.7 : 0.4)) {
        let t = Date.UTC(2021, 2, 1) + r2() * 480 * DAY, dose = 1;
        addImm('covid19', t, dose++);
        t += (21 + r2() * 21) * DAY;
        addImm('covid19', t, dose++);
        for (const prob of [0.6, 0.4]) {
          if (r2() < prob) { t += (180 + r2() * 120) * DAY; addImm('covid19', t, dose++); }
        }
      }
    }
  }

  // Enrichment (off by default; own random streams per patient, applied before the inpatient pass so new stays get detail too).
  const enrich = o.enrich === true || /^(1|true|on|yes)$/i.test(String(o.enrich));
  const enrichInfo = enrich ? addEnrichment(entries, rng2, { end, years: o.years, stats }) : null;

  // Inpatient detail (off by default; own random streams per encounter, applied before messy so messy can still corrupt it).
  const inpatient = o.inpatient === true || /^(1|true|on|yes)$/i.test(String(o.inpatient));
  const inpatientInfo = inpatient ? addInpatientDetail(entries, rng2, { end, seed: o.seed, stats }) : null;

  // Messy-data mode (off by default): corrupt a copy of the story with realistic defects, using its own random stream.
  const messy = o.messy === true || /^(1|true|on|yes)$/i.test(String(o.messy));
  const messyInfo = messy ? applyMess(entries, rng2('messy'), { end, seed: o.seed }) : null;

  // Uncoded mode (off by default): strip the codes of the enrichment domains after everything else, leaving free text only.
  const uncodedMode = /^(partial|all)$/i.test(String(o.uncoded)) ? String(o.uncoded).toLowerCase() : 'none';
  const uncodedInfo = uncodedMode !== 'none' ? applyUncoded(entries, rng2, uncodedMode) : null;

  return {
    bundle: { resourceType: 'Bundle', type: 'collection', meta: { tag: [{ code: 'synthetic', display: 'Synthetic data - not real patients' }] }, entry: entries },
    summary: { ...stats, resources: entries.length, seed: o.seed, years: o.years, endDate: isoDate(end), ...(enrich ? { enrich: enrichInfo } : {}), ...(inpatient ? { inpatient: inpatientInfo } : {}), ...(messy ? { messy: messyInfo } : {}), ...(uncodedInfo ? { uncoded: uncodedInfo } : {}) },
  };
}

module.exports = { generateBundle };

// ---------- self-test ----------
if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert'), end = new Date('2026-01-01'), base = { count: 150, seed: 7, endDate: end };
  const json = x => JSON.stringify(x.bundle);
  assert.strictEqual(json(generateBundle(base)), json(generateBundle(base)), 'same seed, same bundle');
  assert.notStrictEqual(json(generateBundle(base)), json(generateBundle({ ...base, seed: 8 })), 'another seed, another bundle');
  const r = generateBundle(base);
  assert.strictEqual(r.summary.patients, 150);
  assert.ok(r.bundle.entry.length > 150 && r.bundle.meta.tag[0].code === 'synthetic');
  for (const opt of ['inpatient', 'enrich', 'messy']) { const x = generateBundle({ ...base, [opt]: true }); assert.ok(x.bundle.entry.length >= r.bundle.entry.length, opt + ' only adds or alters records'); }
  assert.ok(generateBundle({ ...base, uncoded: 'all' }).summary.uncoded, 'uncoded summary');
  console.log('synthetic.js self-test: all checks passed');
}
