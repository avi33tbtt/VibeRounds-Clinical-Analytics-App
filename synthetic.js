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

// ---------------------------------------------------------------------------------------------
// Disease profiles (plan chunk 1.1). generateBundle({ profiles: [...] }) adds the Condition of every enabled profile (see diseases.js) to each patient:
// prevalence from the profile's age / sex bands times the multipliers and links of diseases the patient already has, onset from the profile's onset shape,
// the record coded, left as free text or coded with a local code as the profile's mess shares say. Every draw uses its own stream rng2('dz:' + key + ':' + patient id)
// and the resources get their own ids, so the main stream, the ids of other resources and every other field stay as they are; with no profile nothing is added and
// the bundle is byte-identical to before. A profile whose disease the built-in model already generates (diabetes, hypertension, ...) is skipped and listed in
// summary.diseaseProfiles.skipped. Treatment lines (chunk 1.2, see below) use their own stream rng2('dz-rx:' + key + ':' + patient id) and ids
// <prefix>-dz-rx-...; the control series and monitoring (chunk 1.3, see below) use rng2('dz-ob:' + ...) / rng2('dz-mon:' + ...) and ids <prefix>-dz-ob-..., -dz-mon-...;
// events, severity, unit-swap mess and the ground truth follow in chunk 1.4 (see dzEvents / dzSeverity / DZ_UNIT_SWAPS below): own streams rng2('dz-sev:' + ...),
// rng2('dz-ev:' + ...), rng2('dz-mess:' + ...), ids <prefix>-dz-ev-...; with profiles, generateBundle also returns groundTruth next to the bundle.
const DZ_LOCAL_SYSTEM = 'urn:vibe-rounds:local-code';
function planProfiles(profiles) {
  if (profiles === undefined || profiles === null) return null;
  const DZ = require('./diseases');
  const builtinCodes = new Set(Object.values(T.CONDITIONS).map(d => d.code));
  const prep = DZ.prepareProfiles(profiles, { builtinKeys: Object.keys(T.CONDITIONS) });
  if (prep.problems.length) {
    const first = prep.problems[0], e = first.errors[0];
    throw Object.assign(new Error(`Disease profile "${first.key}" is not valid: ${e.path} ${e.message}` + (prep.problems.length > 1 ? ` (and ${prep.problems.length - 1} more profile(s))` : '')), { status: 400, problems: prep.problems });
  }
  const run = [], skipped = [];
  for (const p of prep.profiles) {
    if (Object.hasOwn(T.CONDITIONS, p.key) || builtinCodes.has(p.dx.code)) skipped.push({ key: p.key, reason: 'the built-in condition model already generates this disease' });
    else run.push(p);
  }
  return { run, skipped, systemUri: DZ.SYSTEM_URI };
}
// rate for this patient: the band holding the age (the same for both sexes unless the profile says otherwise), times the multipliers of diseases the patient has
function dzRate(p, age, female, has) {
  if (age < p.prevalence.minAge) return 0;
  const band = p.prevalence.ageBands.find(b => age >= b.from && age < b.to);
  if (!band) return 0;
  let rate = female ? band.female : band.male;
  for (const m of p.prevalence.multipliers) if (m.multiplier !== null && has(m.disease)) rate *= m.multiplier;
  for (const l of p.links) if (l.multiplier && has(l.disease)) rate *= l.direction === 'lowers' ? 1 / l.multiplier : l.multiplier;
  return clamp(rate, 0, 1);
}
// onset time inside [lo, hi] (ms): uniform, late (skewed to the end of the window) or normal in age (a draw outside the window is repeated, then falls back to uniform)
function dzOnset(p, rz, birth, lo, hi) {
  const o = p.prevalence.onset, u = lo + (hi - lo) * rz(), z = () => Math.sqrt(-2 * Math.log(1 - rz())) * Math.cos(2 * Math.PI * rz());
  if (o.shape === 'late') return lo + (hi - lo) * Math.sqrt(rz());
  if (o.shape === 'normal') { for (let i = 0; i < 8; i++) { const at = birth + (o.mean + o.sd * z()) * YEAR; if (at >= lo && at <= hi) return at; } }
  return u;
}

// Treatment lines of one profile for one patient (chunk 1.2). Lines are taken in line order; each drug is drawn with its own probability and starts lagDays after onset
// (plus up to 14 days), so never before onset. It is renewed every renewalDays (+-10%), each further renewal happening with probability 0.93 and never after the end date.
// A line with switchTo and switchProbability may hand over once: its series stops at a random renewal and the other drug starts there (a drug already started is never started
// again, and a switch is skipped when the target is already in use). Returns the fills as [{ drug, at }] in time order plus the number of switches.
function dzTreatment(p, rx, onsetAt, end) {
  const lines = p.treatment.slice().sort((a, b) => a.line - b.line), started = {}, fills = []; let switches = 0;
  const series = (t, from) => {
    const times = [from], gap = Math.max(1, t.renewalDays || 30) * DAY;
    for (let last = from; times.length < 400;) { const next = last + gap * (0.9 + 0.2 * rx()); if (next >= end || rx() >= 0.93) break; times.push(next); last = next; }
    return times;
  };
  for (const t of lines) {
    if (!t.code || started[t.code] !== undefined) continue;
    const u = rx(), lag = rx(), sw = rx(), kk = rx();
    if (!(u < (t.probability === null ? 0 : t.probability))) continue;
    const from = onsetAt + (t.lagDays || 0) * DAY + lag * 14 * DAY;
    if (!(from < end)) continue;
    let times = series(t, from); started[t.code] = from;
    const target = t.switchTo && started[t.switchTo] === undefined ? lines.find(x => x.code === t.switchTo) : null;
    if (target && times.length >= 2 && sw < t.switchProbability) {
      const k = 1 + Math.floor(kk * (times.length - 1)), swAt = times[k];
      times = times.slice(0, k); started[target.code] = swAt; switches++;
      times.forEach(at => fills.push({ drug: t, at })); series(target, swAt).forEach(at => fills.push({ drug: target, at }));
    } else times.forEach(at => fills.push({ drug: t, at }));
  }
  return { fills: fills.sort((a, b) => a.at - b.at), switches };
}
// Control series of one profile for one patient (chunk 1.3). The first value comes within 30 days of onset; the next after the monitoring interval for the patient's current control
// (controlled -> intervalControlledDays, else intervalUncontrolledDays of the monitoring test on the control code, default 180 / 90), times 3.5 for a patient who does not follow the
// schedule, times a random 0.85-1.15. Value = the patient's start value (start.mean + start.sd * z) until the first treatment fill; after it the value decays toward
// target + (1 - adherence) * (start - target) with time constant decayDays, plus noise of 0.4 * start.sd, clamped to the plausible range of the lab. A patient with full adherence
// reaches the profile's target, one with none never improves. Controlled = on the right side of goal (below / above; range uses goal and goalHigh).
const DZ_OFF_SCHEDULE = 3.5;
function dzControlSeries(p, rc, onsetAt, treatAt, adherence, monitored, end) {
  const c = p.control, mon = p.monitoring.find(m => m.kind === 'test' && m.code === c.code);
  const iC = (mon ? mon.intervalControlledDays : null) || 180, iU = (mon ? mon.intervalUncontrolledDays : null) || 90;
  const z = () => Math.sqrt(-2 * Math.log(1 - rc())) * Math.cos(2 * Math.PI * rc());
  const sd = c.start.sd || 0, initial = c.start.mean + sd * z(), eff = c.target + (1 - adherence) * (initial - c.target), tau = Math.max(1, c.decayDays || 150) * DAY;
  const lim = require('./diseases').PLAUSIBLE[c.code] || [0, Infinity];
  const controlled = v => c.direction === 'above' ? v >= c.goal : c.direction === 'range' ? v >= c.goal && v <= (c.goalHigh === null ? Infinity : c.goalHigh) : v < c.goal;
  const pts = []; let t = onsetAt + rc() * 30 * DAY;
  while (t < end && pts.length < 400) {
    const base = treatAt !== null && t >= treatAt ? eff + (initial - eff) * Math.exp(-(t - treatAt) / tau) : initial;
    const v = Math.round(clamp(base + z() * 0.4 * sd, lim[0], lim[1]) * 10) / 10, ok = controlled(v);
    pts.push({ at: t, value: v, controlled: ok });
    t += (ok ? iC : iU) * DAY * (monitored ? 1 : DZ_OFF_SCHEDULE) * (0.85 + 0.3 * rc());
  }
  return pts;
}
// Monitoring entries other than the control lab itself (chunk 1.3): tests (an Observation without a value, "done"), screenings (Procedure) and vaccines (Immunization), repeated
// at the interval for the patient's control at that time (the last control value before it; with no control measure the controlled interval), x3.5 for a patient who does not
// attend (tests: the monitoring flag, screenings and vaccines: the screening flag). Returns [{ m, at }].
function dzMonitoring(p, rm, onsetAt, end, pts, monitored, screener) {
  const out = [], statusAt = t => { let ok = null; for (const q of pts) { if (q.at <= t) ok = q.controlled; else break; } return ok === null ? true : ok; };
  for (const m of p.monitoring) {
    if (!m.code || (m.kind === 'test' && p.control && m.code === p.control.code)) continue;
    const slow = (m.kind === 'test' ? monitored : screener) ? 1 : DZ_OFF_SCHEDULE;
    for (let t = onsetAt + rm() * 60 * DAY, n = 0; t < end && n < 400; n++) {
      out.push({ m, at: t });
      const gap = (statusAt(t) ? m.intervalControlledDays : m.intervalUncontrolledDays) || 365;
      t += Math.max(1, gap) * DAY * slow * (0.85 + 0.3 * rm());
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// Severity of one patient (chunk 1.4): drawn from the profile's course.severity mix (shares are normalized; a missing or empty mix means "moderate"). The multiplier scales the
// event rates (mild x0.7, moderate x1, severe x1.8) and is divided by the mix's own mean multiplier, so the average over all patients stays the rate written in the profile.
const DZ_SEV_MULT = { mild: 0.7, moderate: 1, severe: 1.8 };
function dzSeverity(p, rs) {
  const sv = p.course.severity || {}, w = { mild: Math.max(0, sv.mild || 0), moderate: Math.max(0, sv.moderate || 0), severe: Math.max(0, sv.severe || 0) };
  const tot = w.mild + w.moderate + w.severe, u = rs();
  if (!(tot > 0)) return { name: 'moderate', mult: 1 };
  const mean = (w.mild * DZ_SEV_MULT.mild + w.moderate * DZ_SEV_MULT.moderate + w.severe * DZ_SEV_MULT.severe) / tot;
  const name = u * tot < w.mild ? 'mild' : u * tot < w.mild + w.moderate ? 'moderate' : 'severe';
  return { name, mult: DZ_SEV_MULT[name] / mean };
}
// Events of one profile for one patient (chunk 1.4): ED visits, admissions and procedures. course.events.<kind> holds the expected number per patient-year while the patient is
// controlled and while not (profile rates, 0 to 1), times the severity multiplier. The time from onset to the end date is cut into stretches, each with the control status of the
// latest control value at its start (the first value for the stretch before it); with no control measure the mean of both rates is used. The count in a stretch is Poisson with
// mean rate x years, the times are uniform in the stretch, so events never come before onset or after the end date. An admission lasts 2 days plus up to 3 (mild), 5 (moderate) or
// 7 (severe) more. Returns [{ kind, at, controlled, losDays? }] in time order.
function dzEvents(p, re, onsetAt, pts, sev, end) {
  const ev = p.course.events || {}, segs = [];
  if (pts.length) {
    segs.push({ from: onsetAt, to: pts[0].at, controlled: pts[0].controlled });
    pts.forEach((q, i) => segs.push({ from: q.at, to: i + 1 < pts.length ? pts[i + 1].at : end, controlled: q.controlled }));
  } else segs.push({ from: onsetAt, to: end, controlled: null });
  const out = [], extra = { mild: 3, moderate: 5, severe: 7 }[sev.name];
  for (const kind of EVENT_KEYS_DZ) {
    const e = ev[kind]; if (!e) continue;
    for (const sg of segs) {
      const to = Math.min(sg.to, end), len = to - sg.from; if (!(len > 0)) continue;
      const base = sg.controlled === null ? ((e.controlled || 0) + (e.uncontrolled || 0)) / 2 : sg.controlled ? (e.controlled || 0) : (e.uncontrolled || 0);
      const lambda = base * sev.mult * len / YEAR; let k = 0;
      for (let L = Math.exp(-lambda), t = re(); t > L && k < 50; t *= re()) k++;
      for (let i = 0; i < k; i++) out.push({ kind, at: sg.from + re() * len, controlled: sg.controlled, losDays: kind === 'admission' ? 2 + Math.floor(re() * (extra + 1)) : 0 });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
const EVENT_KEYS_DZ = ['ed', 'admission', 'procedure'];
// Unit swaps (chunk 1.4, mess.unitSwapShare): an observation of the control measure is reported in the other common unit, as the real units mix in practice. Only where a conversion is
// known (LOINC code -> [from unit, to unit, factor or function]); a measure without one is never swapped.
const DZ_UNIT_SWAPS = {
  '2339-0': ['mg/dL', 'mmol/L', v => v / 18.016], '38483-4': ['mg/dL', 'umol/L', v => v * 88.4], '4548-4': ['%', 'mmol/mol', v => (v - 2.15) * 10.929],
  '18262-6': ['mg/dL', 'mmol/L', v => v * 0.02586], '2085-9': ['mg/dL', 'mmol/L', v => v * 0.02586], '2093-3': ['mg/dL', 'mmol/L', v => v * 0.02586], '2571-8': ['mg/dL', 'mmol/L', v => v * 0.01129]
};

// ---------------------------------------------------------------------------------------------
// ED timestamps (plan chunk 3.3a). Off by default. A post-processing pass over the finished bundle with its own random stream per encounter (rng2('ed:' + id)), so the
// clinical story never changes and with `edTimes` off the bundle is identical to before. Every EMER encounter keeps its period.start as the ARRIVAL; the pass sets
// period.end to the departure and adds one extension with the milestones, always in this order:
//   arrival <= triage <= firstPhysician <= dispositionDecision <= departure
// Waits (minutes) are the generator's own assumptions, not observed data: triage 3-25 after arrival, first physician 10-150 after triage, decision 30-240 after the
// physician, departure 10-120 after the decision. About 2% leave without being seen (no physician or decision time; departure 20-180 min after triage).
// The others are discharged 70%, admitted 20%, left against advice 5%, transferred 3% (weights are normalised). The disposition is a code in the same extension.
const ED_EXT = 'http://vibe-rounds.example/fhir/StructureDefinition/ed-milestones';
const ED_DISPOSITIONS = [['discharged', 0.70], ['admitted', 0.20], ['against-advice', 0.05], ['transferred', 0.03]];   // of the patients who were seen; the rest is left-without-being-seen
function addEdTimestamps(entries, rng2, ctx) {
  const MIN = 60000, iso = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  const n = { visits: 0, dispositions: {}, left_without_being_seen: 0, door_to_triage_min: [], door_to_physician_min: [], length_of_stay_min: [] };
  const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
  for (const e of entries) {
    const x = e.resource;
    if (x.resourceType !== 'Encounter' || !x.class || x.class.code !== 'EMER' || !x.period || !x.period.start) continue;
    const r = rng2('ed:' + x.id), span = (lo, hi) => Math.round(lo + (hi - lo) * r());
    const arrival = Date.parse(x.period.start), triage = arrival + span(3, 25) * MIN;
    let physician = null, decision = null, departure, disp;
    if (r() < 0.02) { disp = 'left-without-being-seen'; departure = triage + span(20, 180) * MIN; n.left_without_being_seen++; }
    else {
      physician = triage + span(10, 150) * MIN; decision = physician + span(30, 240) * MIN; departure = decision + span(10, 120) * MIN;
      let u = r() * ED_DISPOSITIONS.reduce((s, d) => s + d[1], 0); disp = ED_DISPOSITIONS[ED_DISPOSITIONS.length - 1][0];
      for (const [k, w] of ED_DISPOSITIONS) { if (u < w) { disp = k; break; } u -= w; }
      n.door_to_physician_min.push((physician - arrival) / MIN);
    }
    const ms = [['arrival', arrival], ['triage', triage], ['firstPhysician', physician], ['dispositionDecision', decision], ['departure', departure]];
    x.period = { ...x.period, end: iso(departure) };
    x.extension = (x.extension || []).concat([{ url: ED_EXT, extension: ms.filter(m => m[1] !== null).map(m => ({ url: m[0], valueDateTime: iso(m[1]) })).concat([{ url: 'disposition', valueCode: disp }]) }]);
    n.visits++; n.dispositions[disp] = (n.dispositions[disp] || 0) + 1; n.door_to_triage_min.push((triage - arrival) / MIN); n.length_of_stay_min.push((departure - arrival) / MIN);
  }
  return { visits: n.visits, dispositions: n.dispositions, left_without_being_seen: n.left_without_being_seen,
    median_door_to_triage_min: med(n.door_to_triage_min), median_door_to_physician_min: med(n.door_to_physician_min), median_length_of_stay_min: med(n.length_of_stay_min) };
}

// ---------------------------------------------------------------------------------------------
// ED triage and frequent attenders (plan chunk 3.3b). Option `edTriage` (off by default; it switches `edTimes` on too). Two post-processing passes with their own random streams:
//  1. addEdFrequent  (runs BEFORE addEdTimestamps so the new visits get milestones): about 3% of the living adults become frequent attenders: 6 to 14 extra low-acuity ED visits
//     in the last two years, as new Encounter resources with ids <patient>-fa-<n> and the extension FA_EXT. Nothing existing is touched.
//  2. addEdTriage    (runs AFTER addEdTimestamps): every ED encounter gets an Emergency Severity Index level 1 (most urgent) to 5 as Encounter.priority and as `triageLevel` in the
//     ed-milestones extension. The level follows the diagnosis severity (mild / moderate / severe from the profile's own severity draw, read from the ground truth), or for other
//     visits the reason text, or the frequent-attender mix. The level then sets the wait (ESI 1-2 are seen sooner, 4-5 later: later milestones shift with it, order kept) and the
//     disposition of those who were seen (more admissions at ESI 1-2). All mixes and waits are the generator's own assumptions, not observed data.
const FA_EXT = 'http://vibe-rounds.example/fhir/StructureDefinition/frequent-attender', ESI_SYSTEM = 'http://vibe-rounds.example/CodeSystem/esi';
const ESI_BY_SEVERITY = { severe: [0.06, 0.40, 0.42, 0.10, 0.02], moderate: [0.01, 0.18, 0.50, 0.25, 0.06], mild: [0, 0.05, 0.30, 0.45, 0.20] };
const ESI_BY_REASON = [[/chest pain/i, [0.04, 0.40, 0.45, 0.10, 0.01]], [/abdominal/i, [0, 0.12, 0.55, 0.28, 0.05]], [/fever/i, [0, 0.05, 0.40, 0.45, 0.10]], [/minor injury/i, [0, 0, 0.10, 0.50, 0.40]]];
const ESI_DEFAULT = [0.02, 0.15, 0.42, 0.30, 0.11], ESI_FREQUENT = [0, 0.03, 0.32, 0.42, 0.23];
const ESI_WAIT = [0.1, 0.35, 1, 1.2, 1.5];                                   // multiplier of the wait from triage to the first physician, by level 1..5
const ESI_ADMIT = [0.70, 0.40, 0.20, 0.05, 0.01];                            // share admitted among those seen, by level 1..5; against advice 4%, transferred 3% (6% at ESI 1-2), rest discharged
const FA_REASONS = ['Back pain', 'Anxiety', 'Headache', 'Minor injury', 'Abdominal pain', 'Cough'];
function addEdFrequent(entries, rng2, ctx) {
  const DAY = 86400000, iso = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z'), end = ctx.end, from = end - 2 * 365 * DAY;
  const added = [], ids = [];
  for (const e of entries) {
    const pt = e.resource; if (pt.resourceType !== 'Patient' || !pt.birthDate) continue;
    const r = rng2('fa:' + pt.id), age = (end - Date.parse(pt.birthDate)) / (365.25 * DAY), dead = pt.deceasedDateTime ? Date.parse(pt.deceasedDateTime) : null;
    if (age < 18 || (dead !== null && dead <= from) || r() >= 0.03) continue;
    const hi = Math.min(end - DAY, dead !== null ? dead - DAY : end), lo = Math.max(from, Date.parse(pt.birthDate) + 18 * 365.25 * DAY); if (hi <= lo) continue;
    const k = 6 + Math.floor(r() * 9), times = Array.from({ length: k }, () => Math.floor(lo + (hi - lo) * r())).sort((a, b) => a - b);
    times.forEach((at, i) => {
      const reason = FA_REASONS[Math.floor(r() * FA_REASONS.length)], div = { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${esc(`Emergency room visit: ${reason}.`)}</div>` };
      added.push({ fullUrl: `urn:uuid:${pt.id}-fa-${i + 1}`, resource: { resourceType: 'Encounter', id: `${pt.id}-fa-${i + 1}`, status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'EMER', display: 'emergency' },
        type: [{ text: 'Emergency department visit' }], subject: { reference: `Patient/${pt.id}` }, period: { start: iso(at), end: iso(at + 4 * 3600000) }, reasonCode: [{ text: reason }], text: div, extension: [{ url: FA_EXT, valueBoolean: true }] } });
    });
    ids.push(pt.id);
  }
  for (const a of added) entries.push(a);
  if (ctx.stats) ctx.stats.encounters += added.length;
  return { patients: ids.length, visits: added.length, patient_ids: ids };
}
function addEdTriage(entries, rng2, ctx) {
  const MIN = 60000, iso = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z'), sev = new Map();
  for (const g of ctx.truth || []) sev.set(g.patient + '|' + g.disease, g.severity);
  const draw = (r, w) => { let u = r() * w.reduce((s, v) => s + v, 0); for (let i = 0; i < w.length; i++) { if (u < w[i]) return i + 1; u -= w[i]; } return w.length; };
  const out = { visits: 0, levels: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, dispositions: {}, from_severity: 0, from_reason: 0, frequent: 0 };
  for (const e of entries) {
    const x = e.resource; if (x.resourceType !== 'Encounter' || !x.class || x.class.code !== 'EMER' || !x.extension) continue;
    const ext = x.extension.find(q => q.url === ED_EXT); if (!ext) continue;
    const r = rng2('edt:' + x.id), pid = x.subject && x.subject.reference ? x.subject.reference.slice(8) : '', fa = x.extension.some(q => q.url === FA_EXT);
    const dz = /-dz-ev-(.+)-\d+-\d+$/.exec(x.id), sv = dz ? sev.get(pid + '|' + dz[1]) : null, reason = ((x.reasonCode || [])[0] || {}).text || '';
    let mix, via;
    if (fa) { mix = ESI_FREQUENT; via = 'frequent'; out.frequent++; }
    else if (sv && ESI_BY_SEVERITY[sv]) { mix = ESI_BY_SEVERITY[sv]; via = 'severity'; out.from_severity++; }
    else { const m = ESI_BY_REASON.find(q => q[0].test(reason)); mix = m ? m[1] : ESI_DEFAULT; via = 'reason'; out.from_reason++; }
    const L = draw(r, mix), get = k => { const m = ext.extension.find(q => q.url === k); return m ? Date.parse(m.valueDateTime) : null; };
    const triage = get('triage'), phys = get('firstPhysician'), setT = (k, ms) => { const m = ext.extension.find(q => q.url === k); if (m) m.valueDateTime = iso(ms); };
    const dispo = ext.extension.find(q => q.url === 'disposition');
    if (phys !== null) {   // seen: the level scales the wait for the physician (later milestones move with it) and decides the admission share
      const shift = Math.round((phys - triage) * (ESI_WAIT[L - 1] - 1) / MIN) * MIN;
      for (const k of ['firstPhysician', 'dispositionDecision', 'departure']) setT(k, get(k) + shift);
      x.period = { ...x.period, end: iso(get('departure')) };   // read after the shift above
      const lowL = L <= 2, w = [['admitted', ESI_ADMIT[L - 1]], ['against-advice', 0.04], ['transferred', lowL ? 0.06 : 0.03]], u = r(); let acc = 0; dispo.valueCode = 'discharged';
      for (const [k, v] of w) { acc += v; if (u < acc) { dispo.valueCode = k; break; } }
    }
    ext.extension.splice(ext.extension.findIndex(q => q.url === 'disposition'), 0, { url: 'triageLevel', valueInteger: L });
    x.priority = { coding: [{ system: ESI_SYSTEM, code: String(L), display: 'ESI ' + L }], text: 'ESI level ' + L + ' (' + via + ')' };
    out.visits++; out.levels[L]++; out.dispositions[dispo.valueCode] = (out.dispositions[dispo.valueCode] || 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Admissions from decompensation (plan chunk 3.4a). Option `decompensation` (off by default). Inside the disease-profile loop: a profile admission that falls in a stretch where the
// control measure is not at goal (or where there is no measure to judge by) is turned into an episode of decompensation; admissions in a controlled stretch stay as they were.
// Each episode has its own random stream (`dz-dec:<key>:<patient>:<n>`, so no other draw moves):
//   - length of stay: log-normal, median 3.5 (mild), 5.5 (moderate) or 8 (severe) days, sigma 0.5, x1.25 from age 75, between 2 and 45 days (the profile's own 2-to-9-day draw is replaced);
//   - an ED visit 10 to 36 hours before the admission in 70% of the episodes (the bounce-back before the stay; id <admission id>-ed), counted as an ED event of the disease;
//   - one control-measure value an hour before the admission, clearly off goal (id <admission id>-dec-ob; only for a profile with a control measure);
//   - the extension EP_EXT (an episode id) on the admission and on its ED visit, and `decompensations` in the ground truth: [{ episode, admission, losDays, edBefore, severity }].
// All of it is the generator's own assumption, not observed data. With the option off nothing changes.
const EP_EXT = 'http://vibe-rounds.example/fhir/StructureDefinition/episode';
const DEC_MEDIAN_LOS = { mild: 3.5, moderate: 5.5, severe: 8 };
function decLos(r, sevName, ageYears) {
  const z = Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()), v = (DEC_MEDIAN_LOS[sevName] || 5.5) * Math.exp(0.5 * z) * (ageYears >= 75 ? 1.25 : 1);
  return Math.round(clamp(v, 2, 45));
}

// ---------------------------------------------------------------------------------------------
// In-stay labs, discharge and readmission (plan chunk 3.4b). Option `stayDetail` (off by default; it switches `decompensation` on). Every decompensation episode (3.4a) gets, from its
// own random stream (`dz-stay:<key>:<patient>:<n>`, so nothing else moves and with the option off the bundle is identical):
//   - in-stay labs, all carrying the episode extension: the control measure every 2 days from the admission value part of the way to the treated target (it may still be off goal at discharge)
//     with a last value 2 hours before discharge (id <admission id>-stay-ob-<k>; only for a profile with a control measure), and creatinine on the admission day and just before
//     discharge (ids -stay-cr-1 / -stay-cr-2): raised on admission by severity, mostly settling by discharge;
//   - hospitalization.dischargeDisposition on the stay: home, skilled nursing, rehabilitation, left against advice or other (risk: age 75+, severe disease, stay of 10 days or more).
//     Death in hospital is not generated here (a patient's death is drawn later and never changed); the inpatient option keeps this disposition;
//   - a 30-day readmission in about 18% of the episodes (12 / 18 / 26% by severity, x1.3 from age 75, x1.8 after leaving against advice, at most 60%), 4 to 28 days after discharge and only
//     when it still fits before the end date: a short admission (id <admission id>-rd, the extension READMIT_EXT = the episode it follows) with its own disposition, counted as an
//     admission event of the disease;
//   - ground truth per episode: `disposition`, `inStayLabs`, `readmission` (null or { admission, losDays, daysAfterDischarge }); summary.stay counts them.
// All of it is the generator's own assumption, not observed data.
const READMIT_EXT = 'http://vibe-rounds.example/fhir/StructureDefinition/readmission-of';
const READMIT_BASE = { mild: 0.12, moderate: 0.18, severe: 0.26 };
function stayDispo(u, risk) {
  const pSnf = 0.06 + 0.05 * risk, pRehab = 0.04 + 0.03 * risk, pAma = 0.02 + 0.01 * risk, pOth = 0.02;
  return u < pSnf ? 'snf' : u < pSnf + pRehab ? 'rehab' : u < pSnf + pRehab + pAma ? 'aadvice' : u < pSnf + pRehab + pAma + pOth ? 'oth' : 'home';
}
const stayDispoOf = code => ({ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/discharge-disposition', code, display: { home: 'Home', snf: 'Skilled nursing facility', rehab: 'Rehabilitation', aadvice: 'Left against advice', oth: 'Other' }[code] }] });
function stayReadmitProb(sevName, ageYears, dcode) { return Math.min(0.6, (READMIT_BASE[sevName] || 0.18) * (ageYears >= 75 ? 1.3 : 1) * (dcode === 'aadvice' ? 1.8 : 1)); }

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

  const stay = o.stayDetail === true || /^(1|true|on|yes)$/i.test(String(o.stayDetail));   // chunk 3.4b: in-stay labs, discharge, readmission (switches decompensation on)
  const stayAgg = { episodes: 0, in_stay_labs: 0, dispositions: {}, readmissions: 0 };
  const decomp = stay || o.decompensation === true || /^(1|true|on|yes)$/i.test(String(o.decompensation));   // chunk 3.4a
  const dzPlan = planProfiles(o.profiles), dzCount = {}, dzTx = {}, dzCtl = {}, dzEv = {}, dzMess = {}, dzTruth = [];
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

    // ---------- disease profiles (chunk 1.1): conditions only, own streams, own ids ----------
    if (dzPlan && dzPlan.run.length) {
      const pOnset = {}, has = k => pOnset[k] !== undefined || onset[k] !== undefined;
      for (const p of dzPlan.run) {
        const rz = rng2(`dz:${p.key}:${pid}`);
        const u = rz(), rate = dzRate(p, age, female, has);
        const terms = p.dx.terms.length ? p.dx.terms : [p.dx.display || p.label.toLowerCase()];
        const term = terms[Math.floor(rz() * terms.length)], form = Math.floor(rz() * 5), uncoded = rz() < p.mess.uncodedShare, local = rz() < p.mess.localCodeShare && !!p.mess.localCode, lowerIt = rz() < p.mess.lowercaseShare;
        if (!(u < rate)) continue;
        const lo = Math.max(start, birth + p.prevalence.minAge * YEAR), hi = end - 45 * DAY;
        if (lo >= hi) continue;
        const at = dzOnset(p, rz, birth, lo, hi), display = p.dx.display || p.label;
        let txt = [display, `Patient with ${term}`, `History of ${term}`, `${term} - follow up`, term.toUpperCase()][form];
        if (lowerIt) txt = txt.toLowerCase();
        const code = uncoded ? { text: txt }
          : local ? { coding: [{ system: DZ_LOCAL_SYSTEM, code: p.mess.localCode, display: txt }], text: txt }
          : { coding: [{ system: dzPlan.systemUri[p.dx.system] || SNOMED, code: p.dx.code, display }], text: display };
        push({ resourceType: 'Condition', id: `${prefix}-dz-${p.key}-${n}`, clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] }, code, subject: { reference: ref }, onsetDateTime: iso(at), recordedDate: iso(at), text: div(txt) });
        stats.conditions++; pOnset[p.key] = at; dzCount[p.key] = (dzCount[p.key] || 0) + 1;
        let treatAt = null;
        if (p.treatment.length) {
          const tx = dzTreatment(p, rng2(`dz-rx:${p.key}:${pid}`), at, end), st = dzTx[p.key] || (dzTx[p.key] = { patients: 0, fills: 0, switches: 0 }), wr = rng2(`dz-rxw:${p.key}:${pid}`);
          if (tx.fills.length) st.patients++;
          st.fills += tx.fills.length; st.switches += tx.switches;
          tx.fills.forEach((f, i) => {
            const d = f.drug, terms = MED_TERMS[d.code] || [], text = wr() < 0.2 && (terms[0] || d.display) ? `${terms.length ? terms[Math.floor(wr() * terms.length)] : d.display} daily` : (d.display || d.code);
            push({ resourceType: 'MedicationStatement', id: `${prefix}-dz-rx-${p.key}-${n}-${i + 1}`, status: 'active', medicationCodeableConcept: { coding: [{ system: dzPlan.systemUri[d.system] || RXNORM, code: d.code, display: d.display || d.code }], text }, subject: { reference: ref }, effectiveDateTime: iso(f.at), text: div(`${d.display || d.code} prescribed`) });
            stats.medications++;
          });
          treatAt = tx.fills.length ? tx.fills[0].at : null;
        }
        const pts = p.control ? dzControlSeries(p, rng2(`dz-ob:${p.key}:${pid}`), at, treatAt, adherence, monitored, end) : [];
        const cs = p.control || p.monitoring.length ? dzCtl[p.key] || (dzCtl[p.key] = { patients: 0, observations: 0, monitoring: 0 }) : { patients: 0, observations: 0, monitoring: 0 };
        if (pts.length) cs.patients++;
        const ms = dzMess[p.key] || (dzMess[p.key] = { uncoded: 0, local: 0, lowercase: 0, unitSwaps: 0 }), rq = rng2(`dz-mess:${p.key}:${pid}`), swap = p.control ? DZ_UNIT_SWAPS[p.control.code] : null;
        if (uncoded) ms.uncoded++; else if (local) ms.local++;
        if (lowerIt) ms.lowercase++;
        pts.forEach((q, i) => {
          const c = p.control, swapped = !!swap && c.unit === swap[0] && rq() < p.mess.unitSwapShare;   // one draw per value, so the stream does not depend on the swap
          const v = swapped ? Math.round(swap[2](q.value) * 100) / 100 : q.value, unit = swapped ? swap[1] : c.unit;
          push({ resourceType: 'Observation', id: `${prefix}-dz-ob-${p.key}-${n}-${i + 1}`, status: 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: c.type === 'vital' ? 'vital-signs' : 'laboratory' }] }], code: { coding: [{ system: dzPlan.systemUri[c.system] || LOINC, code: c.code, display: c.display || c.code }], text: c.display || c.code }, subject: { reference: ref }, effectiveDateTime: iso(q.at), valueQuantity: { value: v, unit, system: 'http://unitsofmeasure.org', code: unit }, text: div(`${c.display || c.code}: ${v} ${unit}`) });
          stats.observations++; cs.observations++; if (swapped) ms.unitSwaps++;
        });
        dzMonitoring(p, rng2(`dz-mon:${p.key}:${pid}`), at, end, pts, monitored, screener).forEach((e, i) => {
          const m = e.m, id = `${prefix}-dz-mon-${p.key}-${n}-${i + 1}`, label = m.display || m.code, coding = [{ system: dzPlan.systemUri[m.system] || SNOMED, code: m.code, display: label }], code = { coding, text: label };
          if (m.kind === 'vaccine') push({ resourceType: 'Immunization', id, status: 'completed', vaccineCode: code, patient: { reference: ref }, occurrenceDateTime: iso(e.at), primarySource: true, text: div(`Immunization given: ${label}.`) });
          else if (m.kind === 'screening') { push({ resourceType: 'Procedure', id, status: 'completed', code, subject: { reference: ref }, performedDateTime: iso(e.at), text: div(`${label} performed`) }); stats.procedures++; }
          else { push({ resourceType: 'Observation', id, status: 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }], code, subject: { reference: ref }, effectiveDateTime: iso(e.at), text: div(`${label} done`) }); stats.observations++; }
          if (m.kind === 'vaccine') stats.immunizations++;
          cs.monitoring++;
        });
        // events by control level and severity (chunk 1.4), then the ground-truth record of this patient and disease
        const sev = dzSeverity(p, rng2(`dz-sev:${p.key}:${pid}`)), evs = dzEvents(p, rng2(`dz-ev:${p.key}:${pid}`), at, pts, sev, end), es = dzEv[p.key] || (dzEv[p.key] = { patients: 0, ed: 0, admission: 0, procedure: 0 }), got = { ed: 0, admission: 0, procedure: 0 };
        const decList = [];
        if (decomp) { got.decompensation = 0; if (es.decompensation === undefined) es.decompensation = 0; }
        if (stay && es.readmission === undefined) es.readmission = 0;
        evs.forEach((e, i) => {
          const id = `${prefix}-dz-ev-${p.key}-${n}-${i + 1}`, label = p.dx.display || p.label, dec = decomp && e.kind === 'admission' && e.controlled !== true, dr = dec ? rng2(`dz-dec:${p.key}:${pid}:${i + 1}`) : null, epId = `${prefix}-dz-ep-${p.key}-${n}-${i + 1}`, rcode = { coding: [{ system: dzPlan.systemUri[p.dx.system] || SNOMED, code: p.dx.code, display: label }], text: label };
          if (e.kind === 'procedure') { push({ resourceType: 'Procedure', id, status: 'completed', code: { text: `Procedure for ${label}` }, subject: { reference: ref }, performedDateTime: iso(e.at), reasonCode: [rcode], text: div(`Procedure for ${label}`) }); stats.procedures++; }
          else {
            const cls = e.kind === 'ed' ? 'EMER' : 'IMP', endAt = e.at + (cls === 'IMP' ? (dec ? decLos(dr, sev.name, (e.at - birth) / YEAR) : e.losDays) * DAY : 4 * 3600000), reason = cls === 'IMP' ? `${label}: admission` : `${label}: emergency visit`;
            const encR = push({ resourceType: 'Encounter', id, status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: cls, display: cls === 'EMER' ? 'emergency' : 'inpatient encounter' }, type: [{ text: cls === 'EMER' ? 'Emergency department visit' : 'Hospital admission' }], subject: { reference: ref }, period: { start: iso(e.at), end: iso(endAt) }, reasonCode: [rcode], text: div(`${cls === 'EMER' ? 'Emergency room visit' : 'Inpatient admission'}: ${reason}.`), ...(dec ? { extension: [{ url: EP_EXT, valueString: epId }] } : {}) });
            stats.encounters++;
            if (dec) {
              const los = Math.round((endAt - e.at) / DAY), edLead = dr() < 0.7 ? Math.round(10 + 26 * dr()) * 3600000 : 0, edAt = e.at - edLead, c = p.control; let admV = null;
              if (edLead && edAt >= at) {
                push({ resourceType: 'Encounter', id: `${id}-ed`, status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'EMER', display: 'emergency' }, type: [{ text: 'Emergency department visit' }], subject: { reference: ref }, period: { start: iso(edAt), end: iso(edAt + 4 * 3600000) }, reasonCode: [{ text: `${label}: decompensation` }], text: div(`Emergency room visit: ${label}: decompensation.`), extension: [{ url: EP_EXT, valueString: epId }] });
                stats.encounters++; got.ed++; es.ed++;
              }
              if (c) {
                const lim = require('./diseases').PLAUSIBLE[c.code] || [0, Infinity], up = c.direction !== 'above', gap = Math.abs((c.goalHigh !== null && c.goalHigh !== undefined && c.direction === 'range' ? c.goalHigh : c.goal) - c.start.mean);
                let v = c.start.mean + (up ? 1 : -1) * (c.start.sd || 0) * (0.3 + 1.2 * dr()); v = up ? Math.max(v, (c.direction === 'range' && c.goalHigh ? c.goalHigh : c.goal) + 0.1 * gap + 0.01) : Math.min(v, c.goal - 0.1 * gap - 0.01);
                v = Math.round(clamp(v, lim[0], lim[1]) * 10) / 10; admV = v;
                push({ resourceType: 'Observation', id: `${id}-dec-ob`, status: 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: c.type === 'vital' ? 'vital-signs' : 'laboratory' }] }], code: { coding: [{ system: dzPlan.systemUri[c.system] || LOINC, code: c.code, display: c.display || c.code }], text: c.display || c.code }, subject: { reference: ref }, effectiveDateTime: iso(Math.max(at, e.at - 3600000)), valueQuantity: { value: v, unit: c.unit }, extension: [{ url: EP_EXT, valueString: epId }], text: div(`${c.display || c.code}: ${v} ${c.unit} on admission`) });
                stats.observations++; cs.observations++;
              }
              let stayTruth = {};
              if (stay) {
                const ds = rng2(`dz-stay:${p.key}:${pid}:${i + 1}`), ageY = (e.at - birth) / YEAR, stayMs = endAt - e.at, lim = require('./diseases').PLAUSIBLE, obsCat = k => [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: k }] }];
                const labObs = (sfx, coding, text, cat, atMs, value, unit) => push({ resourceType: 'Observation', id: `${id}-${sfx}`, status: 'final', category: obsCat(cat), code: { coding, text }, subject: { reference: ref }, effectiveDateTime: iso(atMs), valueQuantity: { value, unit }, extension: [{ url: EP_EXT, valueString: epId }], text: div(`${text}: ${value} ${unit} during the stay`) });
                let nl = 0;
                if (c && admV !== null) {
                  const tgt = c.target !== undefined && c.target !== null ? c.target : c.goal, prog = 0.5 + 0.4 * ds(), bounds = lim[c.code] || [0, Infinity], offs = [];
                  for (let d = 2; d * DAY < stayMs - 3 * 3600000; d += 2) offs.push(d * DAY);
                  offs.push(stayMs - 2 * 3600000);
                  offs.forEach((off, k) => {
                    const val = Math.round(clamp(admV + (tgt - admV) * prog * (off / stayMs) + (c.start.sd || 0) * 0.3 * (ds() - 0.5), bounds[0], bounds[1]) * 10) / 10;
                    labObs(`stay-ob-${k + 1}`, [{ system: dzPlan.systemUri[c.system] || LOINC, code: c.code, display: c.display || c.code }], c.display || c.code, c.type === 'vital' ? 'vital-signs' : 'laboratory', e.at + off, val, c.unit);
                    stats.observations++; cs.observations++; nl++;
                  });
                }
                const cr = T.LABS.creatinine, base = 0.8 + 0.4 * ds(), rise = { mild: 0.15, moderate: 0.35, severe: 0.7 }[sev.name] * (0.5 + ds()), crCoding = [{ system: LOINC, code: cr.code, display: cr.display }];
                labObs('stay-cr-1', crCoding, cr.display, 'laboratory', e.at + 2 * 3600000, Math.round((base + rise) * 100) / 100, cr.unit);
                labObs('stay-cr-2', crCoding, cr.display, 'laboratory', endAt - 2 * 3600000, Math.round((base + rise * (0.15 + 0.35 * ds())) * 100) / 100, cr.unit);
                stats.observations += 2; nl += 2;
                const risk = (ageY >= 75 ? 1 : 0) + (sev.name === 'severe' ? 1 : 0) + (los >= 10 ? 1 : 0), dcode = stayDispo(ds(), risk);
                encR.hospitalization = { dischargeDisposition: stayDispoOf(dcode) };
                let readm = null;
                const wantRe = ds() < stayReadmitProb(sev.name, ageY, dcode), gapD = 4 + 24 * ds(), rLos = Math.max(2, Math.round(decLos(ds, sev.name, ageY) * 0.8)), rAt = Math.floor((endAt + gapD * DAY) / 1000) * 1000, rd0 = ds();
                if (wantRe && rAt + 2 * DAY < end) {
                  const rEnd = rAt + rLos * DAY;
                  push({ resourceType: 'Encounter', id: `${id}-rd`, status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'IMP', display: 'inpatient encounter' }, type: [{ text: 'Hospital admission' }], subject: { reference: ref }, period: { start: iso(rAt), end: iso(rEnd) }, reasonCode: [rcode], hospitalization: { dischargeDisposition: stayDispoOf(stayDispo(rd0, 1)) }, text: div(`Inpatient admission: ${label}: readmission within 30 days.`), extension: [{ url: READMIT_EXT, valueString: epId }] });
                  stats.encounters++; got.admission++; es.admission++; es.readmission++; stayAgg.readmissions++;
                  readm = { admission: iso(rAt), losDays: rLos, daysAfterDischarge: Math.round(gapD * 10) / 10 };
                }
                stayAgg.episodes++; stayAgg.in_stay_labs += nl; stayAgg.dispositions[dcode] = (stayAgg.dispositions[dcode] || 0) + 1;
                stayTruth = { disposition: dcode, inStayLabs: nl, readmission: readm };
              }
              got.decompensation++; es.decompensation++; decList.push({ episode: epId, admission: iso(e.at), losDays: los, edBefore: !!(edLead && edAt >= at), severity: sev.name, ...stayTruth });
            }
          }
          got[e.kind]++; es[e.kind]++;
        });
        if (evs.length) es.patients++;
        // controlled = the latest control value inside the look-back window before the end date is on the right side of the goal; no value in the window = untested (null)
        const win = p.control ? pts.filter(q => q.at >= end - (p.control.lookbackDays || 365) * DAY) : [], lastPt = win.length ? win[win.length - 1] : null;
        dzTruth.push({ patient: pid, disease: p.key, onset: iso(at), severity: sev.name, adherence: Math.round(adherence * 1000) / 1000, monitored, treated: treatAt !== null, firstTreatment: treatAt !== null ? iso(treatAt) : null,
          coding: uncoded ? 'uncoded' : local ? 'local' : 'coded', controlled: lastPt ? lastPt.controlled : null, lastValue: lastPt ? lastPt.value : null, lastValueAt: lastPt ? iso(lastPt.at) : null, events: got, ...(decomp ? { decompensations: decList.slice() } : {}) });
      }
    }

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

  // ED timestamps (off by default; own random stream per encounter, before messy so messy can still corrupt them).
  const edTriage = o.edTriage === true || /^(1|true|on|yes)$/i.test(String(o.edTriage));   // chunk 3.3b: triage levels and frequent attenders (switches edTimes on)
  const edTimes = edTriage || o.edTimes === true || /^(1|true|on|yes)$/i.test(String(o.edTimes));
  const edFreq = edTriage ? addEdFrequent(entries, rng2, { end, stats }) : null;
  const edInfo = edTimes ? addEdTimestamps(entries, rng2, { end }) : null;
  const edTri = edTriage ? addEdTriage(entries, rng2, { truth: dzTruth }) : null;
  if (edTri) { edInfo.dispositions = edTri.dispositions; edInfo.triage = { levels: edTri.levels, from_severity: edTri.from_severity, from_reason: edTri.from_reason, frequent_attender_visits: edTri.frequent }; edInfo.frequent_attenders = edFreq; }

  // Messy-data mode (off by default): corrupt a copy of the story with realistic defects, using its own random stream.
  const messy = o.messy === true || /^(1|true|on|yes)$/i.test(String(o.messy));
  const messyInfo = messy ? applyMess(entries, rng2('messy'), { end, seed: o.seed }) : null;

  // Uncoded mode (off by default): strip the codes of the enrichment domains after everything else, leaving free text only.
  const uncodedMode = /^(partial|all)$/i.test(String(o.uncoded)) ? String(o.uncoded).toLowerCase() : 'none';
  const uncodedInfo = uncodedMode !== 'none' ? applyUncoded(entries, rng2, uncodedMode) : null;

  return {
    bundle: { resourceType: 'Bundle', type: 'collection', meta: { tag: [{ code: 'synthetic', display: 'Synthetic data - not real patients' }] }, entry: entries },
    summary: { ...stats, resources: entries.length, seed: o.seed, years: o.years, endDate: isoDate(end), ...(enrich ? { enrich: enrichInfo } : {}), ...(inpatient ? { inpatient: inpatientInfo } : {}), ...(edTimes ? { ed: edInfo } : {}), ...(stay ? { stay: { ...stayAgg, readmission_rate: stayAgg.episodes ? Math.round(1000 * stayAgg.readmissions / stayAgg.episodes) / 1000 : null } } : {}), ...(messy ? { messy: messyInfo } : {}), ...(dzPlan ? { diseaseProfiles: { generated: Object.fromEntries(dzPlan.run.map(p => [p.key, dzCount[p.key] || 0])), skipped: dzPlan.skipped, ...(Object.keys(dzTx).length ? { treatment: dzTx } : {}), ...(Object.keys(dzCtl).length ? { control: dzCtl } : {}), ...(Object.keys(dzEv).length ? { events: dzEv } : {}), ...(Object.keys(dzMess).length ? { mess: dzMess } : {}) } } : {}), ...(uncodedInfo ? { uncoded: uncodedInfo } : {}) },
    ...(dzPlan ? { groundTruth: dzTruth } : {})   // chunk 1.4: one record per patient and generated disease (profiles only, so a run without profiles returns exactly what it did before)
  };
}

module.exports = { generateBundle, planProfiles, stayReadmitProb, READMIT_EXT, dzRate, dzOnset, dzTreatment, dzControlSeries, dzMonitoring, dzSeverity, dzEvents, DZ_UNIT_SWAPS };

// ---------- self-test (chunk 1.1; chunk 1.5 extends it) ----------
if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert'), end = new Date('2026-01-01'), base = { count: 400, seed: 7, endDate: end };
  const json = x => JSON.stringify(x.bundle);
  // no profile, undefined or an empty list: one and the same bundle; the same seed gives the same bundle
  assert.strictEqual(json(generateBundle(base)), json(generateBundle({ ...base, profiles: undefined })));
  assert.strictEqual(json(generateBundle(base)), json(generateBundle({ ...base, profiles: [] })));
  // the built-in diseases (diabetes, hypertension) are skipped, so their profiles change nothing but the summary
  const seeds = require('./diseases').seedProfiles(), withSeeds = generateBundle({ ...base, profiles: seeds });
  assert.strictEqual(json(withSeeds), json(generateBundle(base)));
  assert.deepStrictEqual(withSeeds.summary.diseaseProfiles.skipped.map(s => s.key), ['diabetes', 'hypertension']);
  // a new disease: conditions appear at the profile's rate, doubled for patients with the multiplier disease; other resources do not move
  const gout = { key: 'gout', label: 'Gout', dx: { system: 'snomed', code: '90560007', display: 'Gout', terms: ['gout', 'podagra'] },
    prevalence: { minAge: 18, ageBands: [{ from: 18, to: 120, male: 0.2, female: 0.2 }], onset: { shape: 'uniform' }, multipliers: [{ disease: 'obesity', multiplier: 2 }] },
    course: { type: 'chronic' }, mess: { uncodedShare: 0.2, localCodeShare: 0.1, localCode: 'GT-1', lowercaseShare: 0.3 } };
  const big = { count: 2500, seed: 11, endDate: end }, a = generateBundle({ ...big, profiles: [gout] }), plain = generateBundle(big);
  const res = a.bundle.entry.map(e => e.resource), dz = res.filter(x => x.resourceType === 'Condition' && x.id.includes('-dz-gout-'));
  assert.strictEqual(a.summary.diseaseProfiles.generated.gout, dz.length);
  assert.strictEqual(json(a), json(generateBundle({ ...big, profiles: [gout] })), 'deterministic');
  const keep = b => b.bundle.entry.filter(e => !e.resource.id.includes('-dz-')).map(e => JSON.stringify(e)).join('\n');
  assert.strictEqual(keep(a), keep(plain), 'the other resources are unchanged');
  const adults = res.filter(x => x.resourceType === 'Patient' && (+end - +new Date(x.birthDate)) / (365.25 * DAY) >= 18);
  const obese = new Set(res.filter(x => x.resourceType === 'Condition' && x.code.coding && x.code.coding[0].code === T.CONDITIONS.obesity.code).map(x => x.subject.reference));
  const has = new Set(dz.map(x => x.subject.reference)), rate = g => g.filter(p => has.has('Patient/' + p.id)).length / g.length;
  const ro = rate(adults.filter(p => obese.has('Patient/' + p.id))), rn = rate(adults.filter(p => !obese.has('Patient/' + p.id)));
  assert.ok(Math.abs(rn - 0.2) < 0.04, 'prevalence without the multiplier disease: ' + rn);
  assert.ok(Math.abs(ro - 0.4) < 0.07, 'prevalence with the multiplier disease: ' + ro);
  assert.ok(dz.every(x => new Date(x.onsetDateTime) < end && new Date(x.onsetDateTime) > end - 8 * YEAR - DAY), 'onset inside the generated window');
  const unc = dz.filter(x => !x.code.coding).length / dz.length, loc = dz.filter(x => x.code.coding && x.code.coding[0].code === 'GT-1').length / dz.length;
  assert.ok(Math.abs(unc - 0.2) < 0.06 && Math.abs(loc - 0.08) < 0.05, `mess shares ${unc} ${loc}`);
  // chunk 1.2: treatment lines. Never before onset, plausible renewal counts, a switch hands over to the other drug, other resources and the conditions do not move
  const M = T.MEDICATIONS, tx = { ...gout, treatment: [
    { system: 'rxnorm', code: M.metformin.code, display: M.metformin.display, line: 1, probability: 0.8, lagDays: 14, renewalDays: 90, switchTo: M.insulin_glargine.code, switchProbability: 0.3 },
    { system: 'rxnorm', code: M.insulin_glargine.code, display: M.insulin_glargine.display, line: 2, probability: 0.1, lagDays: 365, renewalDays: 30 }] };
  const t = generateBundle({ ...big, profiles: [tx] }), tres = t.bundle.entry.map(e => e.resource);
  assert.strictEqual(json(t), json(generateBundle({ ...big, profiles: [tx] })), 'deterministic with treatment');
  assert.deepStrictEqual(tres.filter(x => x.resourceType === 'Condition' && x.id.includes('-dz-gout-')), dz, 'the conditions are the same with or without treatment lines');
  assert.strictEqual(keep(t), keep(plain), 'other resources unchanged by treatment lines');
  const onsetOf = Object.fromEntries(dz.map(x => [x.subject.reference, Date.parse(x.onsetDateTime)])), rx = tres.filter(x => x.id.includes('-dz-rx-'));
  assert.ok(rx.length > 0 && rx.every(x => Date.parse(x.effectiveDateTime) >= onsetOf[x.subject.reference]), 'no treatment before onset');
  assert.ok(rx.every(x => Date.parse(x.effectiveDateTime) < +end), 'no fill after the end date');
  const per = {}; rx.forEach(x => { const k = x.subject.reference + '|' + x.medicationCodeableConcept.coding[0].code; (per[k] = per[k] || []).push(Date.parse(x.effectiveDateTime)); });
  const counts = Object.values(per).map(a => a.length), meanFills = counts.reduce((a, b) => a + b, 0) / counts.length;
  assert.ok(meanFills > 2 && meanFills < 20, 'plausible renewal counts: mean ' + meanFills);
  for (const [k, a] of Object.entries(per)) {   // never more fills than one per (0.9 x renewal interval) over the 8 years, and no two fills closer than that
    const gap = (k.endsWith('|' + M.metformin.code) ? 90 : 30) * 0.9 * DAY;
    assert.ok(a.length <= 8 * 365.25 * DAY / gap + 1, 'too many fills ' + a.length); a.sort((x, y) => x - y).slice(1).forEach((v, i) => assert.ok(v - a[i] >= gap - 1000, 'fills too close'));
  }
  const metShare = new Set(rx.filter(x => x.medicationCodeableConcept.coding[0].code === M.metformin.code).map(x => x.subject.reference)).size / dz.length;
  assert.ok(metShare > 0.55 && metShare < 0.85, 'first-line share ' + metShare);   // 0.8 minus patients whose onset is too close to the end for a fill
  const s = t.summary.diseaseProfiles.treatment.gout; assert.strictEqual(s.fills, rx.length); assert.ok(s.switches > 0 && s.patients <= dz.length);
  // after a switch the first drug is not renewed again once the second has started
  const byPat = {}; rx.forEach(x => { (byPat[x.subject.reference] = byPat[x.subject.reference] || []).push(x); });
  let checked = 0; for (const list of Object.values(byPat)) {
    const ins = list.filter(x => x.medicationCodeableConcept.coding[0].code === M.insulin_glargine.code).map(x => Date.parse(x.effectiveDateTime)), met = list.filter(x => x.medicationCodeableConcept.coding[0].code === M.metformin.code).map(x => Date.parse(x.effectiveDateTime));
    if (ins.length && met.length && Math.min(...ins) - Math.max(...met) > -1 && Math.min(...ins) > Math.min(...met)) checked++;
  }
  assert.ok(checked > 0, 'some patients switched from the first to the second drug');
  // chunk 1.3: control series and monitoring
  const full = { ...tx, control: { type: 'lab', system: 'loinc', code: '4548-4', display: 'HbA1c', unit: '%', goal: 7, direction: 'below', lookbackDays: 365, start: { mean: 8.8, sd: 0.8 }, target: 6.2, decayDays: 150 },
    treatment: [{ system: 'rxnorm', code: M.metformin.code, display: M.metformin.display, line: 1, probability: 0.9, lagDays: 0, renewalDays: 90 }],
    monitoring: [{ kind: 'test', system: 'loinc', code: '4548-4', intervalControlledDays: 180, intervalUncontrolledDays: 90 }, { kind: 'test', system: 'loinc', code: '2160-0', display: 'Creatinine', intervalControlledDays: 365, intervalUncontrolledDays: 180 },
      { kind: 'screening', system: 'snomed', code: T.PROCEDURES.ecg.code, display: 'ECG', intervalControlledDays: 365, intervalUncontrolledDays: 180 }, { kind: 'vaccine', system: 'cvx', code: '140', display: 'Influenza', intervalControlledDays: 365, intervalUncontrolledDays: 365 }] };
  const c3 = generateBundle({ ...big, profiles: [full] }), cres = c3.bundle.entry.map(e => e.resource);
  assert.strictEqual(json(c3), json(generateBundle({ ...big, profiles: [full] })), 'deterministic with control series');
  assert.deepStrictEqual(cres.filter(x => x.resourceType === 'Condition' && x.id.includes('-dz-gout-')), dz, 'the conditions do not move');
  assert.strictEqual(keep(c3), keep(plain), 'other resources unchanged by control series and monitoring');
  const ob = cres.filter(x => x.id.includes('-dz-ob-')), firstRx = {};
  cres.filter(x => x.id.includes('-dz-rx-')).forEach(x => { const k = x.subject.reference, v = Date.parse(x.effectiveDateTime); if (!(k in firstRx) || v < firstRx[k]) firstRx[k] = v; });
  assert.ok(ob.length > 0 && ob.every(x => Date.parse(x.effectiveDateTime) >= onsetOf[x.subject.reference] && Date.parse(x.effectiveDateTime) < +end), 'series inside [onset, end)');
  assert.ok(ob.every(x => x.valueQuantity.value >= 3 && x.valueQuantity.value <= 20 && x.valueQuantity.unit === '%'), 'values inside the plausible range of the lab');
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length, before = [], after = [];
  ob.forEach(x => { const k = x.subject.reference, t0 = Date.parse(x.effectiveDateTime); if (!(k in firstRx) || t0 < firstRx[k]) before.push(x.valueQuantity.value); else if (t0 > firstRx[k] + 450 * DAY) after.push(x.valueQuantity.value); });
  assert.ok(before.length > 50 && after.length > 200, `enough values before ${before.length} and after ${after.length}`);
  assert.ok(Math.abs(mean(before) - 8.8) < 0.3, 'start value ' + mean(before));
  assert.ok(mean(before) - mean(after) > 1.2 && mean(after) > 6.2, `control falls after treatment: ${mean(before)} -> ${mean(after)}`);   // adherence keeps the mean above the best-case target
  const pts = {}; ob.forEach(x => { (pts[x.subject.reference] = pts[x.subject.reference] || []).push(Date.parse(x.effectiveDateTime)); });
  Object.values(pts).forEach(a => a.sort((x, y) => x - y).slice(1).forEach((v, i) => { const g = (v - a[i]) / DAY; assert.ok(g >= 90 * 0.85 - 0.01 && g <= 180 * 3.5 * 1.15 + 0.01, 'control interval ' + g); }));
  const kinds = k => cres.filter(x => x.id.includes('-dz-mon-') && x.resourceType === k).length;
  assert.ok(kinds('Observation') > 0 && kinds('Procedure') > 0 && kinds('Immunization') > 0, 'tests, screenings and vaccines are generated');
  assert.ok(cres.filter(x => x.id.includes('-dz-mon-') && x.resourceType === 'Observation').every(x => x.code.coding[0].code === '2160-0' && !x.valueQuantity), 'the control lab is not repeated as a monitoring test');
  assert.ok(c3.summary.diseaseProfiles.control.gout.observations === ob.length);
  // chunk 1.4: events by control level and severity, unit-swap mess, ground truth
  a.bundle.entry.length = 0; res.length = 0; t.bundle.entry.length = 0; tres.length = 0;   // earlier bundles are not needed any more: keeps the self-test inside the default heap
  const ev4 = { ...full, course: { type: 'chronic', severity: { mild: 0.5, moderate: 0.35, severe: 0.15 }, events: { ed: { controlled: 0.05, uncontrolled: 0.6 }, admission: { controlled: 0.02, uncontrolled: 0.25 }, procedure: { controlled: 0, uncontrolled: 0.1 } } },
    mess: { ...gout.mess, unitSwapShare: 0 } };
  const e4 = generateBundle({ ...big, profiles: [ev4] }), eres = e4.bundle.entry.map(e => e.resource), gt = e4.groundTruth;
  assert.strictEqual(json(e4), json(generateBundle({ ...big, profiles: [ev4] })), 'deterministic with events');
  assert.strictEqual(generateBundle(big).groundTruth, undefined, 'no profile: no ground truth key');
  assert.strictEqual(generateBundle({ ...big, profiles: [full] }).groundTruth.length, dz.length, 'one truth record per patient with the disease');
  assert.deepStrictEqual(eres.filter(x => x.resourceType === 'Condition' && x.id.includes('-dz-gout-')), dz, 'conditions do not move with events');
  for (const k of ['-dz-rx-', '-dz-ob-', '-dz-mon-']) assert.deepStrictEqual(eres.filter(x => x.id.includes(k)), cres.filter(x => x.id.includes(k)), 'resources ' + k + ' do not move with events');
  assert.strictEqual(keep(e4), keep(plain), 'other resources unchanged by events');
  const evr = eres.filter(x => x.id.includes('-dz-ev-')), at = x => Date.parse(x.period ? x.period.start : x.performedDateTime);
  assert.ok(evr.length > 100 && evr.every(x => at(x) >= onsetOf[x.subject.reference] && at(x) < +end), 'events inside [onset, end)');
  const adm = evr.filter(x => x.resourceType === 'Encounter' && x.class.code === 'IMP'), edv = evr.filter(x => x.resourceType === 'Encounter' && x.class.code === 'EMER'), prc = evr.filter(x => x.resourceType === 'Procedure');
  assert.ok(adm.length > 20 && edv.length > adm.length && prc.length > 0, `event mix: ${edv.length} ED, ${adm.length} admissions, ${prc.length} procedures`);
  assert.ok(adm.every(x => { const d = (Date.parse(x.period.end) - Date.parse(x.period.start)) / DAY; return d >= 2 && d <= 9; }), 'length of stay 2 to 9 days');
  assert.ok(evr.every(x => x.resourceType === 'Procedure' || x.reasonCode[0].coding[0].code === gout.dx.code), 'event reason carries the disease code');
  assert.strictEqual(e4.summary.diseaseProfiles.events.gout.ed, edv.length); assert.strictEqual(e4.summary.diseaseProfiles.events.gout.admission, adm.length); assert.strictEqual(e4.summary.diseaseProfiles.events.gout.procedure, prc.length);
  // truth records: complete, consistent with the resources, and what the analytics will be compared against
  assert.strictEqual(gt.length, dz.length); assert.deepStrictEqual(gt.map(x => x.disease), gt.map(() => 'gout'));
  assert.strictEqual(new Set(gt.map(x => x.patient)).size, gt.length, 'one record per patient');
  const cnt = (k) => gt.reduce((t, x) => t + x.events[k], 0); assert.deepStrictEqual([cnt('ed'), cnt('admission'), cnt('procedure')], [edv.length, adm.length, prc.length], 'truth counts equal the events written');
  assert.strictEqual(gt.filter(x => x.coding === 'uncoded').length, dz.filter(x => !x.code.coding).length, 'truth uncoded = conditions without a code');
  assert.strictEqual(gt.filter(x => x.coding === 'local').length, dz.filter(x => x.code.coding && x.code.coding[0].code === 'GT-1').length, 'truth local = conditions with the local code');
  const unc4 = gt.filter(x => x.coding === 'uncoded').length / gt.length; assert.ok(Math.abs(unc4 - 0.2) < 0.06, 'uncoded share in the truth ' + unc4);
  assert.strictEqual(e4.summary.diseaseProfiles.mess.gout.uncoded, gt.filter(x => x.coding === 'uncoded').length);
  const lastOb = {}; eres.filter(x => x.id.includes('-dz-ob-')).forEach(x => { const k = x.subject.reference.slice(8), t0 = Date.parse(x.effectiveDateTime); if (!lastOb[k] || t0 > lastOb[k].t) lastOb[k] = { t: t0, v: x.valueQuantity.value }; });
  for (const g of gt) {
    const L = lastOb[g.patient], inWin = L && L.t >= +end - 365 * DAY;
    assert.strictEqual(g.controlled, inWin ? L.v < 7 : null, 'controlled in the truth = latest value in the look-back window against the goal');
    assert.strictEqual(g.lastValue, inWin ? L.v : null); assert.strictEqual(g.treated, g.firstTreatment !== null); assert.ok(['mild', 'moderate', 'severe'].includes(g.severity));
  }
  assert.ok(gt.some(x => x.controlled === true) && gt.some(x => x.controlled === false) && gt.some(x => x.controlled === null), 'controlled, uncontrolled and untested all occur');
  const perPat = (flag) => { const g = gt.filter(x => x.controlled === flag); return g.reduce((t, x) => t + x.events.ed, 0) / g.length; };
  assert.ok(perPat(false) > perPat(true) * 1.5, `more ED visits when uncontrolled: ${perPat(false)} vs ${perPat(true)}`);
  const sevMean = k => gt.filter(x => x.severity === k).reduce((t, x) => t + x.events.ed + x.events.admission, 0) / gt.filter(x => x.severity === k).length;
  assert.ok(sevMean('severe') > sevMean('mild') * 1.5, `more events when severe: ${sevMean('severe')} vs ${sevMean('mild')}`);
  const sh = k => gt.filter(x => x.severity === k).length / gt.length; assert.ok(Math.abs(sh('mild') - 0.5) < 0.08 && Math.abs(sh('severe') - 0.15) < 0.06, 'severity mix follows the profile');
  const sev = require('./synthetic').dzSeverity;   // no mix: moderate, multiplier 1; the multiplier averages 1 over the mix
  assert.deepStrictEqual(sev({ course: {} }, () => 0.5), { name: 'moderate', mult: 1 });
  { const mix = { course: { severity: { mild: 0.5, moderate: 0.35, severe: 0.15 } } }; let sum = 0; const N = 20000; for (let i = 0; i < N; i++) sum += sev(mix, () => (i + 0.5) / N).mult; assert.ok(Math.abs(sum / N - 1) < 0.01, 'mean severity multiplier ' + sum / N); }
  // the event rates are a calibrated expectation: with no control measure the mean of both rates is used
  { const nc = { ...ev4, control: null, monitoring: [] }, r = generateBundle({ ...big, count: 1200, profiles: [nc] }), tr = r.groundTruth, py = r.bundle.entry.map(e => e.resource).filter(x => x.id.includes('-dz-gout-')).reduce((t, x) => t + (+end - Date.parse(x.onsetDateTime)) / (365.25 * DAY), 0);
    const exp = (0.05 + 0.6) / 2; assert.ok(Math.abs(tr.reduce((t, x) => t + x.events.ed, 0) / py - exp) < 0.05, 'ED visits per patient-year ' + tr.reduce((t, x) => t + x.events.ed, 0) / py + ' vs ' + exp); assert.ok(tr.every(x => x.controlled === null)); }
  // unit swaps: the share of control values in the other unit follows the profile, values are converted, nothing else moves
  {
    const sw = generateBundle({ ...big, count: 1200, profiles: [{ ...ev4, mess: { ...ev4.mess, unitSwapShare: 0.3 } }] }), sres = sw.bundle.entry.map(e => e.resource), sob = sres.filter(x => x.id.includes('-dz-ob-')), pob = Object.fromEntries(eres.filter(x => x.id.includes('-dz-ob-')).map(x => [x.id, x]));
    const swapped = sob.filter(x => x.valueQuantity.unit === 'mmol/mol'); assert.ok(Math.abs(swapped.length / sob.length - 0.3) < 0.04, 'unit swap share ' + swapped.length / sob.length);
    assert.ok(swapped.every(x => x.valueQuantity.code === 'mmol/mol' && Math.abs(x.valueQuantity.value - (pob[x.id].valueQuantity.value - 2.15) * 10.929) < 0.01), 'swapped values are converted');
    assert.ok(sob.filter(x => x.valueQuantity.unit === '%').every(x => x.valueQuantity.value === pob[x.id].valueQuantity.value), 'unswapped values unchanged');
    assert.strictEqual(sw.summary.diseaseProfiles.mess.gout.unitSwaps, swapped.length);
    assert.deepStrictEqual(sw.groundTruth, gt.slice(0, sw.groundTruth.length), 'the truth is the real control status, whatever units were reported');
    assert.ok(sw.groundTruth.length > 100); const rest = r0 => r0.filter(x => !x.id.includes('-dz-ob-')).map(x => JSON.stringify(x)), sr = rest(sres), er = rest(eres).slice(0, sr.length); assert.deepStrictEqual(sr, er, 'only the control observations differ');
  }
  // a measure without a known conversion is never swapped (blood pressure here)
  { const bp = { ...ev4, control: { ...ev4.control, code: '8480-6', display: 'Systolic BP', unit: 'mm[Hg]', goal: 140, start: { mean: 155, sd: 10 }, target: 125 }, monitoring: [], mess: { ...ev4.mess, unitSwapShare: 1 } }, b = generateBundle({ ...big, count: 1200, profiles: [bp] });
    assert.ok(b.bundle.entry.map(e => e.resource).filter(x => x.id.includes('-dz-ob-')).every(x => x.valueQuantity.unit === 'mm[Hg]') && b.summary.diseaseProfiles.mess.gout.unitSwaps === 0); }
  // chunk 1.5: two profiles at once keep separate streams; every shipped seed profile generates data (renamed, so the built-in skip does not hide it)
  {
    const two = { count: 600, seed: 5, endDate: end }, thy = { ...ev4, key: 'thyroid', label: 'Hypothyroidism', dx: { system: 'snomed', code: '40930008', display: 'Hypothyroidism', terms: ['hypothyroidism'] }, prevalence: { ...gout.prevalence, multipliers: [] } };
    const only = { ...ev4, mess: { ...ev4.mess, unitSwapShare: 0.2 } }, g1 = generateBundle({ ...two, profiles: [only] }), g2 = generateBundle({ ...two, profiles: [thy] }), both = generateBundle({ ...two, profiles: [only, thy] });
    const own = (b, k) => b.bundle.entry.filter(e => e.resource.id.includes('-' + k + '-')).map(e => JSON.stringify(e.resource));
    assert.ok(own(g1, 'gout').length > 100 && own(g2, 'thyroid').length > 100, 'both profiles generate');
    assert.deepStrictEqual(own(both, 'gout'), own(g1, 'gout'), 'a second profile does not change the first one');
    assert.deepStrictEqual(own(both, 'thyroid'), own(g2, 'thyroid'), 'the first profile does not change the second one');
    assert.deepStrictEqual(both.groundTruth.filter(x => x.disease === 'gout'), g1.groundTruth); assert.deepStrictEqual(both.groundTruth.filter(x => x.disease === 'thyroid'), g2.groundTruth);
    assert.strictEqual(both.bundle.entry.length, g1.bundle.entry.length + g2.bundle.entry.length - generateBundle(two).bundle.entry.length, 'resources add up');
    // the same profile twice in the list is refused, not generated twice
    assert.throws(() => generateBundle({ ...two, profiles: [only, only] }), e => e.status === 400);
    const used = new Set(Object.values(T.CONDITIONS).map(d => d.code)), lib = require('./diseases').seedProfiles();
    assert.ok(lib.length >= 2);
    for (const [i, p] of lib.entries()) {
      const r = generateBundle({ count: 400, seed: 9, endDate: end, profiles: [{ ...p, key: 'lib' + i, dx: { ...p.dx, code: String(900000 + i) } }] });
      assert.ok(!used.has(String(900000 + i)) && r.summary.diseaseProfiles.generated['lib' + i] > 0 && r.groundTruth.length === r.summary.diseaseProfiles.generated['lib' + i], 'seed profile ' + p.key + ' generates');
      assert.ok(r.groundTruth.some(x => x.treated) && r.groundTruth.some(x => x.controlled !== null), 'seed profile ' + p.key + ' has treatment and control');
    }
  }
  // an invalid profile is a 400 with the reason, not a silent skip
  assert.throws(() => generateBundle({ ...base, profiles: [{ ...gout, prevalence: { ...gout.prevalence, ageBands: [] } }] }), e => e.status === 400 && /ageBands/.test(e.message));
  // ED timestamps (chunk 3.3a): off = identical bundle; on = ordered milestones, own stream, summary matches the records
  {
    const cfg = { count: 400, seed: 11, endDate: end }, off = generateBundle(cfg), on = generateBundle({ ...cfg, edTimes: true });
    assert.strictEqual(JSON.stringify(off.bundle), JSON.stringify(generateBundle({ ...cfg, edTimes: false }).bundle), 'edTimes off = today\'s bundle');
    assert.strictEqual(on.bundle.entry.length, off.bundle.entry.length, 'no resource is added or removed');
    const eds = r => r.bundle.entry.map(e => e.resource).filter(x => x.resourceType === 'Encounter' && x.class.code === 'EMER'), a = eds(off), b = eds(on);
    assert.ok(b.length > 30 && a.length === b.length && on.summary.ed.visits === b.length, 'every ED encounter is covered: ' + b.length);
    a.forEach((x, i) => assert.ok(b[i].id === x.id && b[i].period.start === x.period.start, 'arrival = the old period.start'));
    const names = ['arrival', 'triage', 'firstPhysician', 'dispositionDecision', 'departure'], seen = {};
    for (const x of b) {
      const ext = x.extension.find(q => q.url === ED_EXT), get = k => { const m = ext.extension.find(q => q.url === k); return m ? Date.parse(m.valueDateTime) : null; };
      const times = names.map(get), disp = ext.extension.find(q => q.url === 'disposition').valueCode; seen[disp] = (seen[disp] || 0) + 1;
      const have = times.filter(v => v !== null); assert.ok(have.every((v, i) => i === 0 || v >= have[i - 1]), 'milestones in order for ' + x.id);
      assert.strictEqual(times[0], Date.parse(x.period.start)); assert.strictEqual(times[4], Date.parse(x.period.end), 'period.end = departure');
      if (disp === 'left-without-being-seen') assert.ok(times[2] === null && times[3] === null, 'no physician time when not seen'); else assert.ok(times[2] !== null && times[3] !== null, 'seen patients have physician and decision times');
      assert.ok(times[1] - times[0] >= 3 * 60000 && times[1] - times[0] <= 25 * 60000, 'triage 3 to 25 minutes after arrival');
    }
    assert.deepStrictEqual(on.summary.ed.dispositions, seen, 'summary dispositions = the records');
    assert.ok(seen.discharged > seen.admitted && seen.admitted > 0, 'disposition mix plausible: ' + JSON.stringify(seen));
    // nothing else changes: strip the pass's own fields and compare
    const strip = r => r.bundle.entry.map(e => { const x = JSON.parse(JSON.stringify(e.resource)); if (x.resourceType === 'Encounter' && x.class.code === 'EMER') { delete x.extension; delete x.period.end; } return x; });
    const offS = off.bundle.entry.map(e => { const x = JSON.parse(JSON.stringify(e.resource)); if (x.resourceType === 'Encounter' && x.class.code === 'EMER') delete x.period.end; return x; });
    assert.deepStrictEqual(strip(on), offS, 'only ED period.end and the milestone extension differ');
    assert.deepStrictEqual(generateBundle({ ...cfg, edTimes: 'true' }).bundle, on.bundle, 'deterministic, and "true" as a string works');
  }
  // ED triage and frequent attenders (chunk 3.3b)
  {
    const cfg = { count: 600, seed: 5, endDate: end, profiles: [ev4] }, off = generateBundle(cfg), on = generateBundle({ ...cfg, edTriage: true });
    assert.strictEqual(JSON.stringify(off.bundle).length, JSON.stringify(generateBundle({ ...cfg, edTriage: false }).bundle).length, 'edTriage false = the plain bundle');
    const all = r => r.bundle.entry.map(e => e.resource), eds = r => all(r).filter(x => x.resourceType === 'Encounter' && x.class.code === 'EMER');
    const fa = eds(on).filter(x => x.id.includes('-fa-')), faPts = new Set(fa.map(x => x.subject.reference));
    assert.ok(on.summary.ed && on.summary.ed.visits === eds(on).length, 'edTriage switches edTimes on and covers every ED visit');
    assert.deepStrictEqual([on.summary.ed.frequent_attenders.patients, on.summary.ed.frequent_attenders.visits], [faPts.size, fa.length]);
    assert.ok(faPts.size >= 8 && faPts.size <= 70, 'about 3% frequent attenders: ' + faPts.size);
    for (const pt of faPts) { const n = fa.filter(x => x.subject.reference === pt).length; assert.ok(n >= 6 && n <= 14, 'frequent attender has 6 to 14 extra visits: ' + n); }
    assert.strictEqual(on.summary.encounters, off.summary.encounters + fa.length, 'stats count the new visits');
    // nothing else changes
    const strip = r => all(r).filter(x => !x.id.includes('-fa-')).map(x => { const y = JSON.parse(JSON.stringify(x)); if (y.resourceType === 'Encounter' && y.class.code === 'EMER') { delete y.extension; delete y.priority; delete y.period.end; } return y; });
    assert.ok(JSON.stringify(strip(on)) === JSON.stringify(strip(off)), 'only ED end time, priority and the milestone extension differ');
    // triage level, order of milestones, waits
    const lv = x => x.extension.find(q => q.url === ED_EXT).extension.find(q => q.url === 'triageLevel').valueInteger, byLevel = { 1: [], 2: [], 3: [], 4: [], 5: [] };
    const names = ['arrival', 'triage', 'firstPhysician', 'dispositionDecision', 'departure'];
    for (const x of eds(on)) {
      const L = lv(x); assert.ok(L >= 1 && L <= 5 && x.priority.coding[0].code === String(L) && x.priority.coding[0].system === ESI_SYSTEM);
      const ext = x.extension.find(q => q.url === ED_EXT), ms = names.map(k => { const m = ext.extension.find(q => q.url === k); return m ? Date.parse(m.valueDateTime) : null; }).filter(v => v !== null);
      assert.ok(ms.every((v, i) => i === 0 || v >= ms[i - 1]) && ms[ms.length - 1] === Date.parse(x.period.end), 'milestones in order after the shift: ' + x.id);
      const ph = ext.extension.find(q => q.url === 'firstPhysician'); if (ph) byLevel[L].push((Date.parse(ph.valueDateTime) - ms[0]) / 60000);
    }
    const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
    assert.ok(Object.values(byLevel).every(a => a.length > 3), 'every level occurs: ' + Object.values(byLevel).map(a => a.length));
    assert.ok(mean(byLevel[1].concat(byLevel[2])) < mean(byLevel[4].concat(byLevel[5])), 'urgent patients wait less for the physician');
    assert.deepStrictEqual(on.summary.ed.triage.levels, Object.fromEntries([1, 2, 3, 4, 5].map(k => [k, eds(on).filter(x => lv(x) === k).length])), 'summary levels = records');
    const disp = {}; eds(on).forEach(x => { const d = x.extension.find(q => q.url === ED_EXT).extension.find(q => q.url === 'disposition').valueCode; disp[d] = (disp[d] || 0) + 1; }); assert.deepStrictEqual(on.summary.ed.dispositions, disp, 'summary dispositions = records');
    // severity drives the level: severe diagnosis visits are more urgent than mild ones (ground truth is the reference); frequent attenders are the least urgent
    const sevOf = Object.fromEntries(on.groundTruth.map(g => [g.patient + '|' + g.disease, g.severity])), lvl = { mild: [], moderate: [], severe: [] };
    for (const x of eds(on)) { const m = /-dz-ev-(.+)-\d+-\d+$/.exec(x.id); if (m) lvl[sevOf[x.subject.reference.slice(8) + '|' + m[1]]].push(lv(x)); }
    assert.ok(lvl.severe.length > 10 && lvl.mild.length > 10, 'severity groups have visits: ' + Object.values(lvl).map(a => a.length));
    assert.ok(mean(lvl.severe) < mean(lvl.moderate) && mean(lvl.moderate) < mean(lvl.mild), 'ESI follows severity: ' + Object.entries(lvl).map(([k, a]) => k + ' ' + mean(a).toFixed(2)));
    assert.ok(mean(fa.map(lv)) > mean(eds(on).filter(x => !x.id.includes('-fa-')).map(lv)), 'frequent attenders are less urgent');
    const admitRate = ls => { const v = eds(on).filter(x => ls.includes(lv(x))); return v.filter(x => x.extension.find(q => q.url === ED_EXT).extension.find(q => q.url === 'disposition').valueCode === 'admitted').length / v.length; };
    assert.ok(admitRate([1, 2]) > admitRate([4, 5]) * 3, 'admissions concentrate at ESI 1-2: ' + admitRate([1, 2]).toFixed(2) + ' vs ' + admitRate([4, 5]).toFixed(2));
    assert.ok(JSON.stringify(generateBundle({ ...cfg, edTriage: 'true' }).bundle) === JSON.stringify(on.bundle), 'deterministic');
  }
  // Admissions from decompensation (chunk 3.4a)
  {
    const cfg = { count: 700, seed: 5, endDate: end, profiles: [ev4] }, off = generateBundle(cfg), on = generateBundle({ ...cfg, decompensation: true });
    const all = r => r.bundle.entry.map(e => e.resource), imp = r => all(r).filter(x => x.resourceType === 'Encounter' && x.class.code === 'IMP' && x.id.includes('-dz-ev-'));
    const epOf = x => (x.extension || []).find(q => q.url === EP_EXT), dec = imp(on).filter(epOf), keep = imp(on).filter(x => !epOf(x));
    assert.ok(dec.length >= 15 && keep.length > 0, 'decompensation and ordinary admissions both occur: ' + dec.length + ' / ' + keep.length);
    const truth = on.groundTruth.flatMap(g => g.decompensations), byEp = Object.fromEntries(truth.map(d => [d.episode, d]));
    assert.strictEqual(truth.length, dec.length, 'ground truth lists every episode'); assert.ok(on.groundTruth.every(g => Array.isArray(g.decompensations)) && off.groundTruth.every(g => g.decompensations === undefined), 'decompensations only with the option');
    const los = x => Math.round((Date.parse(x.period.end) - Date.parse(x.period.start)) / 86400000);
    for (const x of dec) { const d = byEp[epOf(x).valueString]; assert.ok(d && d.admission === x.period.start && d.losDays === los(x), 'truth = record for ' + x.id); assert.ok(los(x) >= 2 && los(x) <= 45, 'length of stay 2 to 45 days: ' + los(x)); }
    // the episode's own resources: ED visit 10 to 36 hours before, one off-goal value an hour before
    const ed = all(on).filter(x => x.id.endsWith('-ed') && epOf(x)), obs = all(on).filter(x => x.id.endsWith('-dec-ob')), c = ev4.control;
    assert.strictEqual(ed.length, truth.filter(d => d.edBefore).length); assert.strictEqual(obs.length, dec.length, 'one value per episode (the profile has a control measure)');
    for (const x of ed) { const a = dec.find(y => epOf(y).valueString === epOf(x).valueString), gap = (Date.parse(a.period.start) - Date.parse(x.period.start)) / 3600000; assert.ok(gap >= 10 && gap <= 36, 'ED visit 10 to 36 h before the admission: ' + gap); }
    for (const x of obs) { const v = x.valueQuantity.value, a = dec.find(y => epOf(y).valueString === epOf(x).valueString); assert.ok(c.direction === 'above' ? v < c.goal : v > c.goal, 'value is off goal: ' + v); assert.ok(Date.parse(a.period.start) - Date.parse(x.effectiveDateTime) <= 3600000 + 1000 && x.effectiveDateTime <= a.period.start); }
    // length of stay follows severity; the ground truth counts still equal the records
    const med = a => { const s = [...a].sort((p, q) => p - q); return s[Math.floor((s.length - 1) / 2)]; }, los3 = { mild: [], moderate: [], severe: [] }; truth.forEach(d => los3[d.severity].push(d.losDays));
    assert.ok(los3.severe.length >= 3 && los3.mild.length >= 3, 'severity groups: ' + Object.values(los3).map(a => a.length)); assert.ok(med(los3.severe) > med(los3.mild), 'severe stays are longer: ' + JSON.stringify(Object.fromEntries(Object.entries(los3).map(([k, a]) => [k, med(a)]))));
    const edAll = all(on).filter(x => x.resourceType === 'Encounter' && x.class.code === 'EMER' && x.id.includes('-dz-ev-')), cnt = k => on.groundTruth.reduce((s, g) => s + g.events[k], 0);
    assert.deepStrictEqual([cnt('ed'), cnt('admission'), cnt('decompensation')], [edAll.length, imp(on).length, dec.length], 'events in the truth equal the records');
    assert.strictEqual(on.summary.diseaseProfiles.events.gout.decompensation, dec.length);
    // ordinary admissions and everything else are untouched
    const skip = new Set([...dec.map(x => x.id)]), strip = r => all(r).filter(x => !x.id.endsWith('-ed') && !x.id.endsWith('-dec-ob')).map(x => { const y = JSON.parse(JSON.stringify(x)); if (skip.has(y.id)) { delete y.extension; delete y.period.end; } return y; });
    assert.ok(JSON.stringify(strip(on)) === JSON.stringify(strip(off)), 'only the episodes differ');
    assert.ok(JSON.stringify(generateBundle({ ...cfg, decompensation: 'true' }).bundle) === JSON.stringify(on.bundle), 'deterministic');
  }
  // In-stay labs, discharge disposition and readmission (chunk 3.4b)
  {
    const cfg = { count: 1500, seed: 5, endDate: end, profiles: [ev4] }, base = generateBundle({ ...cfg, decompensation: true }), on = generateBundle({ ...cfg, stayDetail: true });
    const all = r => r.bundle.entry.map(e => e.resource), DAYMS = 86400000, HMS = 3600000;
    const epOf = x => (x.extension || []).find(q => q.url === EP_EXT), rdOf = x => (x.extension || []).find(q => q.url === READMIT_EXT);
    const imp = all(on).filter(x => x.resourceType === 'Encounter' && x.class.code === 'IMP' && x.id.includes('-dz-ev-')), eps = imp.filter(epOf), rds = imp.filter(rdOf);
    const truth = on.groundTruth.flatMap(g => g.decompensations), byEp = Object.fromEntries(truth.map(d => [d.episode, d]));
    assert.ok(eps.length >= 30, 'enough episodes: ' + eps.length); assert.strictEqual(truth.length, eps.length);
    // stayDetail switches decompensation on, and with it off the bundle is the decompensation bundle
    assert.deepStrictEqual(all(base).length < all(on).length, true); assert.ok(base.groundTruth.every(g => g.decompensations.every(d => d.disposition === undefined)), 'no stay fields without stayDetail');
    const strip = r => all(r).filter(x => !/-stay-(ob|cr)-\d+$|-rd$/.test(x.id)).map(x => { const y = JSON.parse(JSON.stringify(x)); delete y.hospitalization; return y; });
    assert.ok(JSON.stringify(strip(on)) === JSON.stringify(strip(base)), 'only the stay details are added');
    assert.ok(JSON.stringify(generateBundle({ ...cfg, stayDetail: false }).bundle) === JSON.stringify(generateBundle({ ...cfg }).bundle), 'stayDetail false = the plain bundle');
    assert.ok(JSON.stringify(generateBundle({ ...cfg, stayDetail: 'true' }).bundle) === JSON.stringify(on.bundle), 'deterministic, and "true" as a string works');
    // discharge disposition on every episode, as in the truth; mostly home
    const dcode = x => x.hospitalization.dischargeDisposition.coding[0].code, mix = {};
    for (const x of eps) { assert.strictEqual(dcode(x), byEp[epOf(x).valueString].disposition); mix[dcode(x)] = (mix[dcode(x)] || 0) + 1; }
    assert.ok(Object.keys(mix).every(k => ['home', 'snf', 'rehab', 'aadvice', 'oth'].includes(k)), 'codes: ' + JSON.stringify(mix)); assert.ok(mix.home > eps.length * 0.6 && mix.home < eps.length, 'mostly home: ' + JSON.stringify(mix));
    assert.deepStrictEqual(on.summary.stay.dispositions, mix, 'summary dispositions = the records');
    // in-stay labs: inside the stay, in time order, creatinine twice, control measure ending nearer the goal on average
    const obsOf = ep => all(on).filter(x => x.resourceType === 'Observation' && epOf(x) && epOf(x).valueString === ep);
    let nLabs = 0, up = 0, down = 0, crDrop = 0; const c = ev4.control;
    for (const x of eps) {
      const ep = epOf(x).valueString, obs = obsOf(ep), cr = obs.filter(o => /-stay-cr-\d$/.test(o.id)), ctl = obs.filter(o => /-stay-ob-\d+$/.test(o.id)).sort((a, b) => a.effectiveDateTime < b.effectiveDateTime ? -1 : 1), adm = obs.find(o => o.id.endsWith('-dec-ob'));
      nLabs += cr.length + ctl.length; assert.strictEqual(byEp[ep].inStayLabs, cr.length + ctl.length, 'truth lab count'); assert.strictEqual(cr.length, 2); assert.ok(ctl.length >= 1, 'control values in the stay');
      for (const o of obs.filter(o => /-stay-/.test(o.id))) assert.ok(o.effectiveDateTime >= x.period.start && o.effectiveDateTime <= x.period.end, 'lab inside the stay: ' + o.id);
      const last = ctl[ctl.length - 1]; assert.ok(Date.parse(x.period.end) - Date.parse(last.effectiveDateTime) <= 2 * HMS + 1000 && Date.parse(x.period.end) - Date.parse(last.effectiveDateTime) >= 2 * HMS - 1000, 'last control value 2 h before discharge');
      const d = (c.direction === 'above' ? -1 : 1) * (adm.valueQuantity.value - last.valueQuantity.value); if (d > 0) down++; else up++;
      const c1 = cr.find(o => o.id.endsWith('cr-1')), c2 = cr.find(o => o.id.endsWith('cr-2')); if (c1.valueQuantity.value > c2.valueQuantity.value) crDrop++;
    }
    assert.strictEqual(on.summary.stay.in_stay_labs, nLabs); assert.ok(down > up * 2, 'control value moves toward goal in most stays: ' + down + ' / ' + up); assert.ok(crDrop > eps.length * 0.9, 'creatinine settles by discharge: ' + crDrop + ' / ' + eps.length);
    // readmissions: 4 to 28 days after the discharge of the stay they follow, counted in the truth, the events and the summary
    assert.ok(rds.length >= 3 && rds.length < eps.length * 0.5, 'readmissions occur at a plausible rate: ' + rds.length + ' / ' + eps.length);
    const rdTruth = truth.filter(d => d.readmission); assert.strictEqual(rdTruth.length, rds.length); assert.strictEqual(on.summary.stay.readmissions, rds.length);
    assert.strictEqual(on.summary.stay.readmission_rate, Math.round(1000 * rds.length / eps.length) / 1000);
    for (const r of rds) {
      const ep = rdOf(r).valueString, idx = eps.find(x => epOf(x).valueString === ep), gap = (Date.parse(r.period.start) - Date.parse(idx.period.end)) / DAYMS, t = byEp[ep].readmission;
      assert.ok(idx && gap >= 3.99 && gap <= 28.01, 'readmission 4 to 28 days after discharge: ' + gap); assert.strictEqual(t.admission, r.period.start); assert.ok(Date.parse(r.period.end) > Date.parse(r.period.start) && t.losDays >= 2 && t.losDays <= 36);
      assert.ok(Date.parse(r.period.start) < +new Date(end), 'inside the data window'); assert.ok(r.hospitalization.dischargeDisposition.coding[0].code);
    }
    const cnt = k => on.groundTruth.reduce((s, g) => s + g.events[k], 0); assert.strictEqual(cnt('admission'), imp.length, 'admission events in the truth include readmissions');
    assert.strictEqual(on.summary.diseaseProfiles.events.gout.readmission, rds.length);
    // readmission is more likely after leaving against advice and for older patients (the helper's own rule), and capped
    assert.ok(stayReadmitProb('mild', 40, 'home') < stayReadmitProb('severe', 40, 'home') && stayReadmitProb('mild', 80, 'home') > stayReadmitProb('mild', 40, 'home') && stayReadmitProb('mild', 40, 'aadvice') > stayReadmitProb('mild', 40, 'home') && stayReadmitProb('severe', 90, 'aadvice') <= 0.6);
    // the inpatient pass keeps the disposition of these stays
    const withInp = generateBundle({ ...cfg, stayDetail: true, inpatient: true }), dOf = r => Object.fromEntries(all(r).filter(x => x.resourceType === 'Encounter' && x.class.code === 'IMP' && epOf(x)).map(x => [x.id, x.hospitalization.dischargeDisposition.coding[0].code]));
    assert.deepStrictEqual(dOf(withInp), dOf(on), 'inpatient pass keeps the stay disposition');
  }
  console.log('synthetic.js self-test: all checks passed');
}
