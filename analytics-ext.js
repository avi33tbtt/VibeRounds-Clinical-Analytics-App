// New analytics. Receives the helper kit exported by analytics.js.
// Add one def({...}) block per roadmap step inside extend().
module.exports = function extend(k) {
  const { def, P, S, T, pct, num, codesOf, bandCase, RACE, ETHN, TXT } = k; // eslint-disable-line no-unused-vars

  // ---- Step 1.1: High utilizers (encounter tiers) ---------------------------------
  const tiers = (c, where) => `${c.with},
    n AS (SELECT p.patient_id, count(en.patient_id)::int AS enc FROM p LEFT JOIN en ON en.patient_id = p.patient_id ${where} GROUP BY p.patient_id),
    r AS (SELECT *, percent_rank() OVER (ORDER BY enc) AS pr FROM n)
    SELECT CASE WHEN pr >= 0.95 THEN '1 Top 5%' WHEN pr >= 0.90 THEN '2 Top 5-10%' WHEN pr >= 0.50 THEN '3 Middle 40%' ELSE '4 Bottom 50%' END AS tier,
      count(*)::int AS patients, sum(enc)::int AS encounters,
      ${pct('sum(enc)', '(SELECT sum(enc) FROM n)')} AS pct_of_all_encounters, round(avg(enc), 1)::float8 AS avg_encounters
    FROM r GROUP BY 1 ORDER BY 1`;

  def({
    id: 'high_utilizers', category: 'Utilization', title: 'High utilizers (encounter tiers)',
    description: 'V3: patients bucketed by lifetime encounter count (top 5%, 5-10%, middle 40%, bottom 50%) with each tier\'s share of all encounters. V4: same, using only the last 12 months before the as-of date. Many patients share the same count, so tier sizes are approximate.',
    params: [],
    v3: (a, c) => [S('tiers', 'Encounter tiers (all time)', () => tiers(c, ''))],
    v4: (a, c) => [S('tiers', 'Encounter tiers (last 12 months)', () => tiers(c, `AND en.start_date > (SELECT d FROM ref) - interval '12 months'`))]
  });

  // ---- Step 1.2: Equity check (disparity ratios) -------------------------------------
  // Only server-defined strings below are put into SQL (never user input).
  const STRAT = { race: RACE, ethnicity: ETHN, gender: `COALESCE(gender, 'Unknown')` };
  // Patient extensions written by synthetic.js (demo data). Server-defined strings only; `name` is never user input.
  const ext = (name, v = 'valueString') => `jsonb_path_query_first(pj, '$.extension[*] ? (@.url == "http://vibe-rounds/fhir/ext/${name}").${v}') #>> '{}'`;
  STRAT.payer = `COALESCE(${ext('payer')}, 'Unknown')`;
  STRAT.income = `COALESCE(${ext('income-band')}, 'Unknown')`;
  STRAT.housing = `COALESCE(${ext('housing-instability', 'valueBoolean')}, 'Unknown')`;
  STRAT.food = `COALESCE(${ext('food-insecurity', 'valueBoolean')}, 'Unknown')`;
  const EVENT = { ed: `en.cls = 'EMER'`, imp: `en.cls = 'IMP'` };
  const equity = (a, c, extra) => {
    const g = STRAT[a.by] || STRAT.race, ev = EVENT[a.event] || EVENT.ed;
    return `${c.with},
      b AS (SELECT p.patient_id, ${g} AS grp, EXISTS (SELECT 1 FROM en WHERE en.patient_id = p.patient_id AND ${ev} ${extra}) AS hit FROM p),
      g AS (SELECT grp, count(*)::int AS patients, count(*) FILTER (WHERE hit)::int AS with_event FROM b GROUP BY grp),
      rf AS (SELECT with_event::numeric / patients AS rate FROM g ORDER BY patients DESC LIMIT 1)
      SELECT grp AS "group", patients, with_event, ${pct('with_event', 'patients')} AS rate_pct,
        round(((with_event::numeric / patients) / NULLIF((SELECT rate FROM rf), 0))::numeric, 2)::float8 AS rate_ratio_vs_largest,
        CASE WHEN patients < 30 THEN 'small group - unstable' END AS note
      FROM g ORDER BY patients DESC`;
  };

  def({
    id: 'equity_check', category: 'Equity', title: 'Equity check (disparity ratios)',
    description: 'Share of patients with at least one ED visit or inpatient stay, by group, with the rate ratio versus the largest group (ratio 1.00). V3: all time. V4: only the last 12 months before the as-of date. Groups under 30 patients are flagged as unstable.',
    params: [
      { name: 'by', label: 'Stratify by', type: 'select', default: 'race', options: [{ value: 'race', label: 'Race' }, { value: 'ethnicity', label: 'Ethnicity' }, { value: 'gender', label: 'Gender' }, { value: 'payer', label: 'Payer' }, { value: 'income', label: 'Income band' }, { value: 'housing', label: 'Housing instability' }, { value: 'food', label: 'Food insecurity' }] },
      { name: 'event', label: 'Event', type: 'select', default: 'ed', options: [{ value: 'ed', label: 'ED visit' }, { value: 'imp', label: 'Inpatient stay' }] }
    ],
    v3: (a, c) => [S('disparity', 'Rate by group (all time)', () => equity(a, c, ''))],
    v4: (a, c) => [S('disparity', 'Rate by group (last 12 months)', () => equity(a, c, `AND en.start_date > (SELECT d FROM ref) - interval '12 months'`))]
  });

  // ---- Step D.4: chronic candidates from recurrence (V4) ---------------------------------------
  // Evidence per diagnosis code, among patients with an onset date and at least 2 years of follow-up before the as-of date:
  //   dx recurrence        : the code is recorded on 3+ distinct dates or in 2+ calendar years for the same patient
  //   treatment recurrence : a drug whose FIRST fill falls 0-90 days after the diagnosis is filled again on 3+ distinct dates or in 2+ calendar years
  // score = share of those patients with either kind of evidence. Output is a ranked list with the evidence, not a hard flag.
  const CHRONIC_START_DAYS = 90;
  def({
    id: 'chronic_candidates', category: 'Conditions', title: 'Chronic condition candidates (from recurrence)',
    description: 'Ranks diagnosis codes by how often they behave like chronic conditions, using only the data (no dictionary). Patients counted: onset date known and 2+ years of follow-up. Evidence 1: the code is recorded on 3+ distinct dates or in 2+ calendar years for the patient. Evidence 2: a drug first filled within 90 days after the diagnosis is filled again on 3+ dates or in 2+ calendar years (ongoing treatment). Score = share of patients with either. A candidate needs a score of at least minPct (default 50) and at least minPatients (default 10) patients; this is a suggestion for review, not a clinical classification. Limits: conditions without drug treatment (for example obesity) can only show evidence 1; a patient with several conditions started in the same 90 days shares the drug evidence; a source that records each diagnosis once (as the synthetic generator does) shows no evidence 1. The dictionary flag is shown only for comparison.',
    params: [
      { name: 'minPct', label: 'Minimum score (%)', type: 'number', default: 50, modes: ['v4'] },
      { name: 'minPatients', label: 'Minimum patients with 2+ years follow-up', type: 'number', default: 10, modes: ['v4'] }
    ],
    v4: (a, c) => [S('candidates', 'Chronic candidates ranked by recurrence evidence', q => {
      const minPct = Math.min(100, Math.max(1, num(a.minPct, 50))), minN = Math.min(1000, Math.max(1, Math.floor(num(a.minPatients, 10))));
      return `${c.with},
      pu AS (SELECT patient_id, code, min(onset_date) AS idx, count(DISTINCT onset_date)::int AS dx_dates, count(DISTINCT EXTRACT(YEAR FROM onset_date))::int AS dx_years,
               max(j->'code'->'coding'->0->>'display') AS disp
             FROM dx WHERE onset_date IS NOT NULL AND code IS NOT NULL GROUP BY patient_id, code),
      el AS (SELECT * FROM pu WHERE idx + 730 <= (SELECT d FROM ref)),
      fl AS (SELECT patient_id, code AS drug, min(prescribed_date::date) AS first_fill, count(DISTINCT prescribed_date::date)::int AS fills, count(DISTINCT EXTRACT(YEAR FROM prescribed_date))::int AS yrs
             FROM rx WHERE prescribed_date IS NOT NULL AND code IS NOT NULL GROUP BY patient_id, code),
      tr AS (SELECT DISTINCT e.patient_id, e.code FROM el e JOIN fl f ON f.patient_id = e.patient_id AND f.first_fill BETWEEN e.idx AND e.idx + ${CHRONIC_START_DAYS} AND (f.fills >= 3 OR f.yrs >= 2)),
      dict(code, chronic) AS (VALUES ${(() => { const rl = (c && c.chronic) || null, seen = new Set(), rows = Object.values(T.CONDITIONS).map(x => { seen.add(x.code); return [x.code, rl ? rl.includes(x.code) : !!x.chronic]; }); if (rl) for (const code of rl) if (!seen.has(code)) rows.push([code, true]); return rows.map(r => `(${q.add(r[0], 'text')}, ${r[1] ? 'true' : 'false'})`).join(', '); })()}),
      agg AS (SELECT p.code, max(p.disp) AS disp, count(DISTINCT p.patient_id)::int AS patients,
                count(*) FILTER (WHERE e.patient_id IS NOT NULL)::int AS followup_patients,
                count(*) FILTER (WHERE e.patient_id IS NOT NULL AND (e.dx_dates >= 3 OR e.dx_years >= 2))::int AS dx_recurring,
                count(*) FILTER (WHERE e.patient_id IS NOT NULL AND t.patient_id IS NOT NULL)::int AS treatment_recurring,
                count(*) FILTER (WHERE e.patient_id IS NOT NULL AND ((e.dx_dates >= 3 OR e.dx_years >= 2) OR t.patient_id IS NOT NULL))::int AS any_recurring
              FROM pu p LEFT JOIN el e ON e.patient_id = p.patient_id AND e.code = p.code LEFT JOIN tr t ON t.patient_id = p.patient_id AND t.code = p.code GROUP BY p.code)
      SELECT a.code, COALESCE(a.disp, a.code) AS condition, a.patients, a.followup_patients AS patients_2y_followup,
        ${pct('a.dx_recurring', 'NULLIF(a.followup_patients, 0)')} AS pct_dx_recurring, ${pct('a.treatment_recurring', 'NULLIF(a.followup_patients, 0)')} AS pct_treatment_recurring,
        ${pct('a.any_recurring', 'NULLIF(a.followup_patients, 0)')} AS score_pct,
        CASE WHEN a.followup_patients < ${minN} THEN 'too few patients' WHEN 100.0 * a.any_recurring / a.followup_patients >= ${minPct} THEN 'chronic candidate' ELSE 'not chronic by this rule' END AS verdict,
        CASE d.chronic WHEN true THEN 'chronic' WHEN false THEN 'acute' END AS dictionary_flag
      FROM agg a LEFT JOIN dict d ON d.code = a.code
      ORDER BY (a.followup_patients >= ${minN}) DESC, 100.0 * a.any_recurring / NULLIF(a.followup_patients, 0) DESC NULLS LAST, a.patients DESC, a.code LIMIT 200`;
    })]
  });

  // ---- Step D.5: treatment links from temporal association (V4) -------------------------------
  // For every (diagnosis code, drug code): patients whose FIRST fill of the drug is 0..window days after their first dated diagnosis of the code.
  // lift = (patients started in the window / patients with the diagnosis) / (patients who ever had the drug / all patients in scope).
  // Kept when patients >= minPatients and lift > minLift. A SUGGESTED map to review, not a treatment guideline; replaces T.TREATMENT_MAP only as a suggestion.
  const mapPairs = c => { const MAP_PAIRS = [], fl = (c && c.firstLine) || T.TREATMENT_MAP;
  for (const [ck, meds] of Object.entries(fl)) for (const mk of meds) if (T.CONDITIONS[ck] && T.MEDICATIONS[mk]) MAP_PAIRS.push({ dx: T.CONDITIONS[ck].code, drug: T.MEDICATIONS[mk].code, cond: T.CONDITIONS[ck].display, med: T.MEDICATIONS[mk].display });
  return MAP_PAIRS; };
  const linkParse = a => ({ minN: Math.min(1000, Math.max(1, Math.floor(num(a.minPatients, 20)))), minLift: Math.min(100, Math.max(0, num(a.minLift, 2))), win: Math.min(365, Math.max(7, Math.floor(num(a.windowDays, 90)))), top: Math.min(500, Math.max(1, Math.floor(num(a.topN, 50)))) });
  const linkCtes = (c, lp) => `${c.with},
      pu AS (SELECT patient_id, code, min(onset_date) AS idx, max(j->'code'->'coding'->0->>'display') AS dxdisp FROM dx WHERE onset_date IS NOT NULL AND code IS NOT NULL GROUP BY patient_id, code),
      fl AS (SELECT patient_id, code AS drug, min(prescribed_date::date) AS d, max(j->'medicationCodeableConcept'->'coding'->0->>'display') AS disp FROM rx WHERE prescribed_date IS NOT NULL AND code IS NOT NULL GROUP BY patient_id, code),
      nd AS (SELECT code, count(*)::int AS n FROM pu GROUP BY code),
      ng AS (SELECT drug, count(*)::int AS n FROM fl GROUP BY drug),
      lk AS (SELECT pu.code AS dx, fl.drug, max(pu.dxdisp) AS dxdisp, max(fl.disp) AS disp, count(*)::int AS a FROM pu JOIN fl ON fl.patient_id = pu.patient_id AND fl.d BETWEEN pu.idx AND pu.idx + ${lp.win} GROUP BY pu.code, fl.drug),
      pairs AS (SELECT lk.*, nd.n AS dx_n, ng.n AS drug_n, ((lk.a::numeric / nd.n) / (ng.n::numeric / NULLIF((SELECT count(*) FROM p), 0)))::float8 AS lift FROM lk JOIN nd ON nd.code = lk.dx JOIN ng ON ng.drug = lk.drug)`;
  def({
    id: 'treatment_links', category: 'Medications', title: 'Treatment links (suggested, from the data)',
    description: 'Suggests which drug treats which diagnosis from timing alone: patients whose first fill of a drug falls 0 to 90 days after their first dated diagnosis of a code, and lift = that share of the condition\'s patients divided by the share of all patients who ever had the drug (the window is shorter than "ever", so lift is conservative). Kept when at least minPatients (default 20) patients and lift above minLift (default 2). Section 2 checks every pair of the dictionary treatment map against the same numbers. Timing is not causation: a drug started with a diagnosis can belong to another condition diagnosed the same week, and drugs for conditions that are never coded show no link. Treat the list as suggestions for clinical review.',
    params: [
      { name: 'minPatients', label: 'Minimum patients per pair', type: 'number', default: 20, modes: ['v4'] },
      { name: 'minLift', label: 'Minimum lift (above)', type: 'number', default: 2, modes: ['v4'] },
      { name: 'windowDays', label: 'Window after diagnosis (days)', type: 'number', default: 90, modes: ['v4'] },
      { name: 'topN', label: 'Top N pairs', type: 'number', default: 50, modes: ['v4'] }
    ],
    v4: (a, c) => {
      const lp = linkParse(a), MAP_PAIRS = mapPairs(c);
      return [
        S('links', 'Suggested diagnosis-drug links (ranked by lift)', q => `${linkCtes(c, lp)},
      dm(dx, drug) AS (VALUES ${MAP_PAIRS.length ? MAP_PAIRS.map(m => `(${q.add(m.dx, 'text')}, ${q.add(m.drug, 'text')})`).join(', ') : `(NULL::text, NULL::text)`})
      SELECT pairs.dx AS condition_code, COALESCE(pairs.dxdisp, pairs.dx) AS condition, pairs.drug AS drug_code, COALESCE(pairs.disp, pairs.drug) AS drug, pairs.a AS patients,
        ${pct('pairs.a', 'pairs.dx_n')} AS pct_of_condition_patients, pairs.dx_n AS condition_patients, pairs.drug_n AS drug_patients, round(pairs.lift::numeric, 2)::float8 AS lift,
        CASE WHEN EXISTS (SELECT 1 FROM dm WHERE dm.dx = pairs.dx AND dm.drug = pairs.drug) THEN 'yes' ELSE 'no' END AS in_dictionary_map
      FROM pairs WHERE pairs.a >= ${lp.minN} AND pairs.lift > ${lp.minLift} ORDER BY pairs.lift DESC, pairs.a DESC, pairs.dx, pairs.drug LIMIT ${lp.top}`),
        S('dictionary_pairs', 'The dictionary treatment map checked against the data', q => `${linkCtes(c, lp)},
      dm(dx, drug, cond, med) AS (VALUES ${MAP_PAIRS.length ? MAP_PAIRS.map(m => `(${q.add(m.dx, 'text')}, ${q.add(m.drug, 'text')}, ${q.add(m.cond, 'text')}, ${q.add(m.med, 'text')})`).join(', ') : `(NULL::text, NULL::text, NULL::text, NULL::text)`})
      SELECT dm.cond AS condition, dm.med AS drug, COALESCE(pairs.a, 0) AS patients, COALESCE(nd.n, 0) AS condition_patients, COALESCE(pairs.drug_n, 0) AS drug_patients, round(pairs.lift::numeric, 2)::float8 AS lift,
        CASE WHEN COALESCE(pairs.a, 0) >= ${lp.minN} AND pairs.lift > ${lp.minLift} THEN 'yes' ELSE 'no' END AS suggested_by_data
      FROM dm LEFT JOIN pairs ON pairs.dx = dm.dx AND pairs.drug = dm.drug LEFT JOIN nd ON nd.code = dm.dx WHERE dm.dx IS NOT NULL ORDER BY dm.cond, dm.med`)
      ];
    }
  });

  // ---- Step D.6: co-prescription candidates (frequent overlap, NOT "risky") ----------------------
  // Two drugs overlap when a fill of one and a fill of the other are less than `supply` days apart (each fill covers `supply` days, as in Step 3.8).
  // lift = (patients with an overlap / all patients) / ((patients ever on A / all) * (patients ever on B / all)). The data cannot say a pair is dangerous.
  const RISKY_DATA = T.RISKY_PAIRS.filter(r => T.MEDICATIONS[r.a] && T.MEDICATIONS[r.b]).map(r => {
    const x = T.MEDICATIONS[r.a], y = T.MEDICATIONS[r.b], sw = x.code > y.code;
    return { a: sw ? y.code : x.code, b: sw ? x.code : y.code, da: sw ? y.display : x.display, db: sw ? x.display : y.display, note: r.note };
  });
  const coParse = a => ({ minN: Math.min(1000, Math.max(1, Math.floor(num(a.minPatients, 20)))), minLift: Math.min(100, Math.max(0, num(a.minLift, 1.5))), supply: Math.min(180, Math.max(7, Math.floor(num(a.supply, 30)))), top: Math.min(500, Math.max(1, Math.floor(num(a.topN, 50)))) });
  const coCtes = (c, cp) => `${c.with},
      fl AS (SELECT patient_id, code, prescribed_date::date AS d, max(j->'medicationCodeableConcept'->'coding'->0->>'display') AS disp FROM rx WHERE code IS NOT NULL AND prescribed_date IS NOT NULL AND prescribed_date::date <= (SELECT d FROM ref) GROUP BY patient_id, code, prescribed_date::date),
      nm AS (SELECT code, count(DISTINCT patient_id)::int AS n, max(disp) AS disp FROM fl GROUP BY code),
      ov AS (SELECT a.code AS ca, b.code AS cb, count(DISTINCT a.patient_id)::int AS both_n FROM fl a JOIN fl b ON b.patient_id = a.patient_id AND a.code < b.code AND abs(a.d - b.d) < ${cp.supply} GROUP BY a.code, b.code),
      pairs AS (SELECT ov.ca, ov.cb, ov.both_n, na.n AS na, nb.n AS nb, na.disp AS da, nb.disp AS db, (ov.both_n::numeric * (SELECT count(*) FROM p) / (na.n::numeric * nb.n))::float8 AS lift FROM ov JOIN nm na ON na.code = ov.ca JOIN nm nb ON nb.code = ov.cb)`;
  // Step D.8c: the pair list comes from the run context (c.risky: dictionary seed plus reviewer decisions); RISKY_DATA is the fallback.
  const riskyOf = c => (c && Array.isArray(c.risky)) ? c.risky.map(r => { const sw = r.a > r.b; return { a: sw ? r.b : r.a, b: sw ? r.a : r.b, da: sw ? r.db : r.da, db: sw ? r.da : r.db, note: r.note }; }) : RISKY_DATA;
  const RISKY_VALS = (q, c) => { const L = riskyOf(c); return `rk(a_code, b_code, da, db, note) AS (VALUES ${L.length ? L.map(r => `(${q.add(r.a, 'text')}, ${q.add(r.b, 'text')}, ${q.add(r.da, 'text')}, ${q.add(r.db, 'text')}, ${q.add(r.note, 'text')})`).join(', ') : `(NULL::text, NULL::text, NULL::text, NULL::text, NULL::text)`})` };
  def({
    id: 'coprescription_candidates', category: 'Medications', title: 'Co-prescription candidates (frequent overlap, needs clinical review)',
    description: 'Lists drug pairs that are filled at overlapping times more often than chance. A pair overlaps for a patient when a fill of one drug and a fill of the other are less than `supply` days apart (default 30; each fill is taken to cover that many days). lift = (patients with an overlap / all patients) / ((patients ever on drug A / all) x (patients ever on drug B / all)); 1 means no more often than chance. Kept when at least minPatients (default 20) patients and lift above minLift (default 1.5). Every row is labelled "frequent co-prescription, needs clinical review": the data cannot tell that a pair is dangerous, and pairs often co-occur only because the patient has several conditions (e.g. two blood-pressure drugs). Section 2 shows the dictionary risky pairs (Polypharmacy analytic) with the same numbers, for comparison only. Counts only, no patient ids; fills with no date are ignored; same-day fills of different drugs count as overlapping.',
    params: [
      { name: 'minPatients', label: 'Minimum patients per pair', type: 'number', default: 20, modes: ['v4'] },
      { name: 'minLift', label: 'Minimum lift (above)', type: 'number', default: 1.5, modes: ['v4'] },
      { name: 'supply', label: 'Days covered by one fill', type: 'number', default: 30, modes: ['v4'] },
      { name: 'topN', label: 'Top N pairs', type: 'number', default: 50, modes: ['v4'] }
    ],
    v4: (a, c) => {
      const cp = coParse(a);
      return [
        S('candidates', 'Frequent co-prescription candidates (ranked by lift)', q => `${coCtes(c, cp)},
      ${RISKY_VALS(q, c)}
      SELECT pairs.ca AS drug_a_code, COALESCE(pairs.da, pairs.ca) AS drug_a, pairs.cb AS drug_b_code, COALESCE(pairs.db, pairs.cb) AS drug_b, pairs.both_n AS patients_overlapping,
        ${pct('pairs.both_n', 'least(pairs.na, pairs.nb)')} AS pct_of_less_used_drug, pairs.na AS patients_drug_a, pairs.nb AS patients_drug_b, round(pairs.lift::numeric, 2)::float8 AS lift,
        CASE WHEN EXISTS (SELECT 1 FROM rk WHERE rk.a_code = pairs.ca AND rk.b_code = pairs.cb) THEN 'yes' ELSE 'no' END AS in_dictionary_risky_pairs,
        'frequent co-prescription, needs clinical review' AS review_status
      FROM pairs WHERE pairs.both_n >= ${cp.minN} AND pairs.lift > ${cp.minLift} ORDER BY pairs.lift DESC, pairs.both_n DESC, pairs.ca, pairs.cb LIMIT ${cp.top}`),
        S('dictionary_risky_pairs', 'The dictionary risky pairs checked against the data (for comparison only)', q => `${coCtes(c, cp)},
      ${RISKY_VALS(q, c)}
      SELECT rk.da AS drug_a, rk.db AS drug_b, rk.note AS dictionary_note, COALESCE(pairs.both_n, 0) AS patients_overlapping, COALESCE(pairs.na, (SELECT n FROM nm WHERE code = rk.a_code), 0) AS patients_drug_a,
        COALESCE(pairs.nb, (SELECT n FROM nm WHERE code = rk.b_code), 0) AS patients_drug_b, round(pairs.lift::numeric, 2)::float8 AS lift,
        CASE WHEN COALESCE(pairs.both_n, 0) >= ${cp.minN} AND pairs.lift > ${cp.minLift} THEN 'yes' ELSE 'no' END AS listed_as_candidate
      FROM rk LEFT JOIN pairs ON pairs.ca = rk.a_code AND pairs.cb = rk.b_code WHERE rk.a_code IS NOT NULL ORDER BY rk.da, rk.db`)
      ];
    }
  });

  // ---- Step D.7a: learned terms, section `displays` (V3) -------------------------------------------
  // For each diagnosis code: the distinct display strings its records carry (lower-cased, trimmed). D.7b-D.7e add phrases, suggested terms and the V1 use.
  // Circularity: terms learned from the records of a code are not independent of that code (see description). Only clamped numbers and dictionary constants go into the SQL.
  const ltParse = a => ({ minR: Math.min(1000, Math.max(1, Math.floor(num(a.minRecords, 5)))), top: Math.min(500, Math.max(1, Math.floor(num(a.topN, 50)))),
    minShare: Math.min(100, Math.max(1, num(a.minShare, 20))), minSpec: Math.min(100, Math.max(1, num(a.minSpecificity, 3))), topPhr: Math.min(100, Math.max(1, Math.floor(num(a.topPhrases, 10)))) });
  // Step D.7b: fixed stop-word list (server-side constant; never user input). Words are lowercase letters and digits, at least 3 characters.
  const LT_STOP = ['the', 'and', 'for', 'with', 'without', 'from', 'that', 'this', 'there', 'their', 'has', 'have', 'had', 'was', 'were', 'are', 'not', 'none', 'but', 'her', 'his', 'she', 'him', 'who', 'whom', 'which', 'when', 'what', 'will', 'been', 'being', 'also', 'any', 'all', 'per', 'via', 'due', 'patient', 'patients', 'pt', 'history', 'hx', 'follow', 'followup', 'visit', 'note', 'notes', 'noted', 'status', 'unspecified', 'diagnosis', 'diagnosed', 'problem', 'finding', 'findings', 'condition', 'seen', 'see', 'new', 'old', 'year', 'years', 'today', 'plan', 'continue', 'continues', 'currently'];
  const COND_DISPLAY = Object.values(T.CONDITIONS).filter(x => x && x.code && x.display);
  const LT_MAX_TERMS = 8, LT_MAX_DISP = 4;
  const HAND_TERMS = []; for (const x of Object.values(T.CONDITIONS)) if (x && x.code) for (const t of (x.terms || [])) { const w = String(t).toLowerCase().replace(/[^a-z0-9 -]+/g, ' ').replace(/ +/g, ' ').trim(); if (w) HAND_TERMS.push({ code: x.code, term: w }); }
  // Shared CTEs of the learned-terms sections (no WITH, no leading comma): rec, cr, tk, kp, ph, pa, cp, tot, sc. Needs c.with before it. `sr` = specificity rounded to 9 places (ranking key, so near-equal ties break the same way every time).
  const ltCtes = (q, lp) => `rec AS (SELECT (row_number() OVER ())::int AS rid, code, raw, ${TXT.dx} AS t FROM (SELECT code, j->'code'->'coding'->0->>'display' AS raw, j FROM dx WHERE code IS NOT NULL) x),
      cr AS (SELECT code, count(*)::int AS records, mode() WITHIN GROUP (ORDER BY raw) AS disp FROM rec ${lp.only ? `WHERE code = ${q.add(lp.only, 'text')}` : ''} GROUP BY code HAVING count(*) >= ${lp.minR} ORDER BY count(*) DESC, code LIMIT ${lp.top}),
      tk AS (SELECT r.rid, r.code, w.word, w.n FROM rec r, LATERAL unnest(regexp_split_to_array(regexp_replace(r.t, '[^a-z0-9]+', ' ', 'g'), ' ')) WITH ORDINALITY AS w(word, n)),
      kp AS (SELECT rid, code, word, (row_number() OVER (PARTITION BY rid ORDER BY n))::int AS k FROM tk WHERE length(word) >= 3 AND word <> ALL(${q.add(LT_STOP, 'text[]')})),
      ph AS (SELECT rid, code, word AS phrase FROM kp UNION SELECT a.rid, a.code, a.word || ' ' || b.word FROM kp a JOIN kp b ON b.rid = a.rid AND b.k = a.k + 1),
      pa AS (SELECT phrase, count(*)::int AS n FROM ph GROUP BY phrase),
      cp AS (SELECT ph.code, ph.phrase, count(*)::int AS n FROM ph JOIN cr ON cr.code = ph.code GROUP BY ph.code, ph.phrase),
      tot AS (SELECT count(*)::numeric AS n FROM rec),
      sc AS (SELECT cp.code, cp.phrase, cp.n AS records_with, cr.records AS code_records, pa.n AS all_with, ((cp.n::numeric / cr.records) / (pa.n::numeric / (SELECT n FROM tot)))::float8 AS spec,
          round(((cp.n::numeric / cr.records) / (pa.n::numeric / (SELECT n FROM tot))), 9) AS sr
        FROM cp JOIN cr ON cr.code = cp.code JOIN pa ON pa.phrase = cp.phrase WHERE cp.n >= ${lp.minR} AND 100.0 * cp.n / cr.records >= ${lp.minShare})`;
  // Step D.7d: term selection shared by `suggested_terms` (strict = false) and the engine (strict = true, one code via lp.only).
  // strict also drops a single-word phrase that is a word of another code's display strings in the scope (so a generic word such as 'type' is never used to search).
  const ltSelCtes = (lp, q, strict) => `ds AS (SELECT code, btrim(regexp_replace(regexp_replace(lower(raw), '[^a-z0-9 -]+', ' ', 'g'), ' +', ' ', 'g')) AS term, count(*)::int AS n FROM rec WHERE raw IS NOT NULL GROUP BY 1, 2),
      dsel AS (SELECT ds.code, ds.term, 0 AS grp, (row_number() OVER (PARTITION BY ds.code ORDER BY ds.n DESC, ds.term))::int AS rn FROM ds JOIN cr ON cr.code = ds.code WHERE ds.term <> ''),
      dsel4 AS (SELECT * FROM dsel WHERE rn <= ${LT_MAX_DISP}),
      dn AS (SELECT code, count(*)::int AS n FROM dsel4 GROUP BY code),
      ${strict ? `ods AS (SELECT DISTINCT w AS word FROM rec r, LATERAL unnest(string_to_array(btrim(regexp_replace(lower(r.raw), '[^a-z0-9]+', ' ', 'g')), ' ')) AS w WHERE r.raw IS NOT NULL AND r.code <> ${q.add(lp.only, 'text')} AND w <> ''),
      ` : ''}pc AS (SELECT sc.*, (row_number() OVER (PARTITION BY sc.code ORDER BY sc.sr DESC, sc.records_with DESC, sc.phrase))::int AS rn FROM sc
        WHERE sc.spec >= ${lp.minSpec} AND sc.phrase !~ '^([a-z0-9]+) \\1$' AND NOT EXISTS (SELECT 1 FROM dsel4 d WHERE d.code = sc.code AND d.term = sc.phrase)${strict ? ` AND (sc.phrase LIKE '% %' OR sc.phrase NOT IN (SELECT word FROM ods))` : ''}),
      sel AS (SELECT code, term, grp, rn FROM dsel4 UNION ALL SELECT pc.code, pc.phrase, 1, pc.rn FROM pc WHERE pc.rn <= ${LT_MAX_TERMS} - COALESCE((SELECT n FROM dn WHERE dn.code = pc.code), 0))`;
  def({
    id: 'learned_terms', category: 'Conditions', title: 'Learned terms (display strings and phrases per diagnosis code)',
    description: 'V3: for each diagnosis code, the distinct display strings its records carry (lower-cased, trimmed; a record with no display shows as "(no display)"), with records, patients and the share of that code\'s records. Codes with fewer than minRecords records (default 5) are left out; the topN codes (default 50) with the most records are shown. The condition name is the dictionary display when terminology.js knows the code, otherwise the most common display in the data. Records are counted per code, so a code recorded under two code systems is one code here. These strings are the start of the search terms the V1 (text) analytics can learn for codes that are not in the dictionary (Steps D.7b to D.7d add narrative phrases and the V1 use). Circularity: terms learned from the records of a code are not independent of that code, so V1 with learned terms will agree with V3 more than it honestly should; keep the hand-written synonyms in terminology.js for any V1 versus V3 comparison you publish. Section 2 (phrases) takes the narrative text of the code\'s own diagnosis records (the same text V1 searches, HTML removed), keeps words of 3 or more letters or digits that are not in a fixed stop-word list, builds one-word phrases and two-word phrases of adjacent kept words, and counts each phrase once per record. A phrase is kept when it is in at least minShare percent (default 20) of the code\'s records and at least minRecords records. specificity = share of the code\'s records with the phrase divided by the share of all diagnosis records with it (about 1 means a generic phrase; large means typical for this code). The topPhrases (default 10) phrases per code with the highest specificity are shown. Section 3 (suggested_terms) gives one row per code with up to 8 search terms: up to 4 display strings (the most common first, reduced to lowercase letters, digits, spaces and hyphens), then the phrases of section 2 with specificity of at least minSpecificity (default 3), most specific first, leaving out phrases that equal a chosen display string and pairs of one repeated word. dictionary_terms_found counts how many hand-written terms of a dictionary condition (terminology.js) the learned list would find: a hand-written term counts when a learned term occurs in it as whole words (or is equal to it); it is empty for codes the dictionary does not know. Counts only, no patient ids.',
    params: [
      { name: 'minRecords', label: 'Minimum records per code', type: 'number', default: 5, modes: ['v3'] },
      { name: 'topN', label: 'Top N codes', type: 'number', default: 50, modes: ['v3'] },
      { name: 'minShare', label: 'Phrase: minimum % of the code\'s records', type: 'number', default: 20, modes: ['v3'] },
      { name: 'topPhrases', label: 'Phrases shown per code', type: 'number', default: 10, modes: ['v3'] },
      { name: 'minSpecificity', label: 'Suggested terms: minimum specificity', type: 'number', default: 3, modes: ['v3'] }
    ],
    v3: (a, c) => {
      const lp = ltParse(a);
      return [
        S('displays', 'Display strings per diagnosis code', q => `${c.with},
      d AS (SELECT code, patient_id, j->'code'->'coding'->0->>'display' AS raw, COALESCE(NULLIF(lower(trim(j->'code'->'coding'->0->>'display')), ''), '(no display)') AS s FROM dx WHERE code IS NOT NULL),
      cr AS (SELECT code, count(*)::int AS records, mode() WITHIN GROUP (ORDER BY raw) AS disp FROM d GROUP BY code HAVING count(*) >= ${lp.minR} ORDER BY count(*) DESC, code LIMIT ${lp.top}),
      dm(code, display) AS (VALUES ${COND_DISPLAY.length ? COND_DISPLAY.map(x => `(${q.add(x.code, 'text')}, ${q.add(x.display, 'text')})`).join(', ') : `(NULL::text, NULL::text)`})
      SELECT d.code, COALESCE(dm.display, cr.disp, d.code) AS condition, d.s AS display_string, count(*)::int AS records, count(DISTINCT d.patient_id)::int AS patients,
        ${pct('count(*)', 'cr.records')} AS pct_of_code_records
      FROM d JOIN cr ON cr.code = d.code LEFT JOIN dm ON dm.code = d.code
      GROUP BY d.code, dm.display, cr.disp, cr.records, d.s ORDER BY cr.records DESC, d.code, count(*) DESC, d.s`),
        S('phrases', 'Words and two-word phrases in the narrative text of each code', q => `${c.with},
      ${ltCtes(q, lp)},
      dm(code, display) AS (VALUES ${COND_DISPLAY.length ? COND_DISPLAY.map(x => `(${q.add(x.code, 'text')}, ${q.add(x.display, 'text')})`).join(', ') : `(NULL::text, NULL::text)`}),
      rk AS (SELECT sc.*, row_number() OVER (PARTITION BY code ORDER BY sr DESC, records_with DESC, phrase) AS rn FROM sc)
      SELECT rk.code, COALESCE(dm.display, cr.disp, rk.code) AS condition, rk.phrase, rk.records_with, ${pct('rk.records_with', 'rk.code_records')} AS pct_of_code_records,
        ${pct('rk.all_with', '(SELECT n FROM tot)')} AS pct_of_all_records, round(rk.spec::numeric, 2)::float8 AS specificity
      FROM rk JOIN cr ON cr.code = rk.code LEFT JOIN dm ON dm.code = rk.code WHERE rk.rn <= ${lp.topPhr}
      ORDER BY cr.records DESC, rk.code, rk.sr DESC, rk.records_with DESC, rk.phrase`),
        S('suggested_terms', 'Suggested V1 search terms per code (display strings first, then the most specific phrases)', q => `${c.with},
      ${ltCtes(q, lp)},
      dm(code, display) AS (VALUES ${COND_DISPLAY.length ? COND_DISPLAY.map(x => `(${q.add(x.code, 'text')}, ${q.add(x.display, 'text')})`).join(', ') : `(NULL::text, NULL::text)`}),
      hv(code, term) AS (VALUES ${HAND_TERMS.length ? HAND_TERMS.map(x => `(${q.add(x.code, 'text')}, ${q.add(x.term, 'text')})`).join(', ') : `(NULL::text, NULL::text)`}),
      ${ltSelCtes(lp, q, false)},
      tl AS (SELECT code, string_agg(term, ' | ' ORDER BY grp, rn) AS terms, count(*)::int AS n_terms, count(*) FILTER (WHERE grp = 0)::int AS n_disp, count(*) FILTER (WHERE grp = 1)::int AS n_phr FROM sel GROUP BY code),
      hf AS (SELECT hv.code, count(*)::int AS n, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM sel WHERE sel.code = hv.code AND hv.term ~ ('\\m' || sel.term || '\\M')))::int AS found FROM hv GROUP BY hv.code)
      SELECT cr.code, COALESCE(dm.display, cr.disp, cr.code) AS condition, COALESCE(tl.terms, '(none)') AS terms, COALESCE(tl.n_terms, 0) AS n_terms,
        COALESCE(tl.n_disp, 0) AS from_display, COALESCE(tl.n_phr, 0) AS from_phrases, hf.n AS dictionary_terms, hf.found AS dictionary_terms_found
      FROM cr LEFT JOIN dm ON dm.code = cr.code LEFT JOIN tl ON tl.code = cr.code LEFT JOIN hf ON hf.code = cr.code ORDER BY cr.records DESC, cr.code`)
      ];
    }
  });

  // ---- Step 1.3: Risk stratification (V3 and V4) ---------------------------------------
  // V3 points: 1 per distinct chronic condition code + 1 if 5 or more distinct drug codes.
  // V4 adds: 1 per abnormal lab (latest result per lab in the last 12 months) + 1 per inpatient stay in the last 12 months.
  // Tiers: 0-2 Low, 3-5 Medium, 6+ High. A transparent point score, not a validated predictor.
  const CHRONIC = Object.values(T.CONDITIONS).filter(x => x.chronic).map(x => x.code);
  const chronicOf = c => (c && c.chronic) || CHRONIC; // Step D.8d: reviewed list from the run context, else the seed
  const ABN_LABS = Object.values(T.LABS).filter(l => l.dir);

  // ---- Step D.3: lab ranges and abnormal flags from the data (no dictionary needed) ----------------
  // labFlagCtes() returns CTE definitions (no WITH, no leading comma):  labx, lg, lf  ->  use as  `${c.with}, ${labFlagCtes()}, ...`
  // Per (LOINC code, unit) group, in priority order:
  //   1. 'reference range'     : the most common referenceRange low / high found on the group's results; abnormal = below low or above high
  //   2. 'interpretation flag' : the result's own interpretation code (H, HH, L, LL, A, AA = abnormal, anything else = normal); results with no flag are not judged
  //   3. 'statistical'         : fewer-than-95%-central rule: below the 2.5th or above the 97.5th percentile of the group (needs 30+ results). NOT a clinical range.
  //   otherwise 'none'         : fewer than 30 results and no range or flag; abn stays NULL.
  // lf columns: patient_id, code, unit ('' when missing), v, effective_date, src, lo, hi, abn (boolean or NULL). Only constants go into the SQL.
  const LAB_MIN_N = 30;
  const jnum = path => `(CASE WHEN ${path} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (${path})::float8 END)`;
  const labFlagCtes = (q, c) => { const LL = (c && c.labLimits) || []; return `labx AS (SELECT o.patient_id, o.code, COALESCE(o.unit, '') AS unit, o.value::float8 AS v, o.effective_date,
        ${jnum(`o.j->'referenceRange'->0->'low'->>'value'`)} AS rlo, ${jnum(`o.j->'referenceRange'->0->'high'->>'value'`)} AS rhi,
        upper(o.j->'interpretation'->0->'coding'->0->>'code') AS flag, o.j->'code'->'coding'->0->>'display' AS disp
      FROM ob o WHERE o.value IS NOT NULL AND o.code IS NOT NULL),
    lg AS (SELECT code, unit, count(*)::int AS n, count(*) FILTER (WHERE rlo IS NOT NULL OR rhi IS NOT NULL)::int AS n_range, count(*) FILTER (WHERE flag IS NOT NULL)::int AS n_flag,
        mode() WITHIN GROUP (ORDER BY rlo) AS mlo, mode() WITHIN GROUP (ORDER BY rhi) AS mhi,
        percentile_cont(0.025) WITHIN GROUP (ORDER BY v) AS plo, percentile_cont(0.975) WITHIN GROUP (ORDER BY v) AS phi, mode() WITHIN GROUP (ORDER BY disp) AS disp
      FROM labx GROUP BY code, unit),
    ov(code, unit, lo, hi) AS (VALUES ${LL.length ? LL.map(l => `(${q.add(l.code, 'text')}, ${l.unit ? q.add(l.unit, 'text') : 'NULL::text'}, ${l.lo === null ? 'NULL::float8' : Number(l.lo) + '::float8'}, ${l.hi === null ? 'NULL::float8' : Number(l.hi) + '::float8'})`).join(', ') : '(NULL::text, NULL::text, NULL::float8, NULL::float8)'}),
    lgs AS (SELECT lg.*, ov.lo AS olo, ov.hi AS ohi, CASE WHEN ov.code IS NOT NULL THEN 'reviewer limit' WHEN n_range > 0 THEN 'reference range' WHEN n_flag > 0 THEN 'interpretation flag' WHEN n >= ${LAB_MIN_N} THEN 'statistical' ELSE 'none' END AS src FROM lg LEFT JOIN ov ON ov.code = lg.code AND (ov.unit IS NULL OR lower(ov.unit) = lower(lg.unit))),
    lf AS (SELECT x.patient_id, x.code, x.unit, x.v, x.effective_date, g.src,
        CASE g.src WHEN 'reviewer limit' THEN g.olo WHEN 'reference range' THEN g.mlo WHEN 'statistical' THEN g.plo END AS lo, CASE g.src WHEN 'reviewer limit' THEN g.ohi WHEN 'reference range' THEN g.mhi WHEN 'statistical' THEN g.phi END AS hi,
        CASE g.src WHEN 'reviewer limit' THEN ((g.ohi IS NOT NULL AND x.v > g.ohi) OR (g.olo IS NOT NULL AND x.v < g.olo)) WHEN 'reference range' THEN (CASE WHEN g.mlo IS NULL AND g.mhi IS NULL THEN NULL ELSE (g.mhi IS NOT NULL AND x.v > g.mhi) OR (g.mlo IS NOT NULL AND x.v < g.mlo) END)
                   WHEN 'interpretation flag' THEN (CASE WHEN x.flag IS NULL THEN NULL ELSE x.flag IN ('H', 'HH', 'L', 'LL', 'A', 'AA') END)
                   WHEN 'statistical' THEN (x.v < g.plo OR x.v > g.phi) END AS abn
      FROM labx x JOIN lgs g ON g.code = x.code AND g.unit = x.unit)`; };

  def({
    id: 'lab_ranges', category: 'Labs & vitals', title: 'Lab ranges from the data',
    description: 'For every lab code (and unit) in the data: where its normal range comes from and the share of results outside it. Priority: a reviewer limit from the review table (source \'reviewer limit\', Step D.8e), then the reference range written on the results, then the results\' own interpretation flags (H/L/A), then, only with 30+ results, the 2.5th to 97.5th percentile of the data (statistical, NOT clinical: about 5% of results are abnormal by construction). Compared with the dictionary threshold of terminology.js where one exists in the same unit (dictionary: high is v >= threshold; here: v > upper limit, the FHIR meaning). Ranges are the most common range per code and unit; results without a flag are not judged.',
    params: [{ name: 'topN', label: 'Top N (by results)', type: 'number', default: 40 }],
    v3: (a, c) => [S('ranges', 'Range source and abnormal rate per lab code and unit', q => `${c.with}, ${labFlagCtes(q, c)},
      dict(code, display, dir, thr, unit) AS (VALUES ${Object.values(T.LABS).map(l => `(${q.add(l.code, 'text')}, ${q.add(l.display, 'text')}, ${q.add(l.dir || '', 'text')}, ${l.dir ? Number(l.thr) : 'NULL'}::numeric, ${q.add(l.unit || '', 'text')})`).join(', ')}),
      agg AS (SELECT code, unit, max(src) AS src, max(lo) AS lo, max(hi) AS hi, count(*)::int AS judged_n, count(*) FILTER (WHERE abn)::int AS abn_n, count(*) FILTER (WHERE abn IS NOT NULL)::int AS judged FROM lf GROUP BY code, unit)
      SELECT g.code, COALESCE(d.display, g.disp, g.code) AS test, g.unit, g.n AS results, g.src AS range_source,
        round(a.lo::numeric, 2)::float8 AS lower_limit, round(a.hi::numeric, 2)::float8 AS upper_limit,
        CASE WHEN g.src = 'reference range' THEN g.n_range WHEN g.src = 'interpretation flag' THEN g.n_flag ELSE g.n END AS results_with_basis,
        a.judged AS results_judged, ${pct('a.abn_n', 'NULLIF(a.judged, 0)')} AS pct_abnormal_data,
        CASE WHEN d.dir <> '' AND lower(g.unit) = lower(d.unit) THEN ${pct(`(SELECT count(*) FROM labx x WHERE x.code = g.code AND x.unit = g.unit AND ((d.dir = 'high' AND x.v >= d.thr) OR (d.dir = 'low' AND x.v < d.thr)))`, 'g.n')} END AS pct_abnormal_dictionary
      FROM lgs g JOIN agg a ON a.code = g.code AND a.unit = g.unit LEFT JOIN dict d ON d.code = g.code
      ORDER BY g.n DESC, g.code, g.unit LIMIT ${Math.min(500, Math.max(1, Math.floor(num(a.topN, 40))))}`)]
  });
  const riskSql = (c, q, timed, fromData) => `${c.with}${timed && fromData ? `, ${labFlagCtes(q, c)}` : ''},
    ch AS (SELECT patient_id, count(DISTINCT code)::int AS n FROM dx WHERE code = ANY(${q.add(chronicOf(c), 'text[]')}) GROUP BY 1),
    dr AS (SELECT patient_id, count(DISTINCT code)::int AS n FROM rx GROUP BY 1)${timed ? `,
    ${fromData ? `ll AS (SELECT DISTINCT ON (patient_id, code) patient_id, code, abn FROM lf
           WHERE src IN ('reviewer limit', 'reference range', 'interpretation flag') AND abn IS NOT NULL AND effective_date > (SELECT d FROM ref) - interval '12 months'
           ORDER BY patient_id, code, effective_date DESC),
    ab AS (SELECT patient_id, count(*) FILTER (WHERE abn)::int AS n FROM ll GROUP BY 1)` : `thr(code, dir, thr) AS (VALUES ${ABN_LABS.map(l => `(${q.add(l.code, 'text')}, ${q.add(l.dir, 'text')}, ${Number(l.thr)}::numeric)`).join(', ')}),
    ll AS (SELECT DISTINCT ON (o.patient_id, o.code) o.patient_id, o.code, o.value FROM ob o JOIN thr t ON t.code = o.code
           WHERE o.value IS NOT NULL AND o.effective_date > (SELECT d FROM ref) - interval '12 months'
           ORDER BY o.patient_id, o.code, o.effective_date DESC),
    ab AS (SELECT l.patient_id, count(*)::int AS n FROM ll l JOIN thr t ON t.code = l.code
           WHERE (t.dir = 'high' AND l.value >= t.thr) OR (t.dir = 'low' AND l.value < t.thr) GROUP BY 1)`},
    ip AS (SELECT patient_id, count(*)::int AS n FROM en WHERE cls = 'IMP' AND start_date > (SELECT d FROM ref) - interval '12 months' GROUP BY 1)` : ''},
    s AS (SELECT p.patient_id, COALESCE(ch.n, 0) AS chronic, COALESCE(dr.n, 0) AS drugs,
            ${timed ? 'COALESCE(ab.n, 0)' : '0'} AS abn, ${timed ? 'COALESCE(ip.n, 0)' : '0'} AS imp,
            COALESCE(ch.n, 0) + (COALESCE(dr.n, 0) >= 5)::int ${timed ? '+ COALESCE(ab.n, 0) + COALESCE(ip.n, 0)' : ''} AS score
          FROM p LEFT JOIN ch ON ch.patient_id = p.patient_id LEFT JOIN dr ON dr.patient_id = p.patient_id
          ${timed ? 'LEFT JOIN ab ON ab.patient_id = p.patient_id LEFT JOIN ip ON ip.patient_id = p.patient_id' : ''})
    SELECT CASE WHEN score >= 6 THEN '3 High (6+)' WHEN score >= 3 THEN '2 Medium (3-5)' ELSE '1 Low (0-2)' END AS tier,
      count(*)::int AS patients, ${pct('count(*)', '(SELECT count(*) FROM s)')} AS pct_of_patients,
      round(avg(chronic), 1)::float8 AS avg_chronic_conditions, round(avg(drugs), 1)::float8 AS avg_distinct_drugs${timed ? `,
      round(avg(abn), 1)::float8 AS avg_abnormal_labs, round(avg(imp), 2)::float8 AS avg_admissions_12m` : ''}
    FROM s GROUP BY 1 ORDER BY 1`;

  def({
    id: 'risk_stratification', category: 'Risk', title: 'Risk stratification (points score)',
    description: 'Simple point score per patient. V3: 1 point per distinct chronic condition code, plus 1 if on 5 or more distinct drugs. V4: also 1 point per abnormal lab (latest result per lab, last 12 months) and 1 per inpatient stay in the last 12 months. Tiers: Low 0-2, Medium 3-5, High 6+. A transparent score for case-finding, not a validated predictor.',
    params: [{ name: 'ranges', label: 'Abnormal lab ranges (V4)', type: 'select', default: 'dictionary', modes: ['v4'], options: [{ value: 'dictionary', label: 'Dictionary thresholds (terminology.js)' }, { value: 'data', label: 'From the data (reference range or flag; statistical ranges not used)' }] }],
    v3: (a, c) => [S('tiers', 'Risk tiers (codes only)', q => riskSql(c, q, false, false))],
    v4: (a, c) => [S('tiers', a.ranges === 'data' ? 'Risk tiers (codes + last 12 months, lab ranges from the data)' : 'Risk tiers (codes + last 12 months)', q => riskSql(c, q, true, a.ranges === 'data'))]
  });

  // ---- Step 5.1: Event stream helper (used by every Phase 5 pathway analytic) ----------
  // eventStreamCte(q) returns ONE CTE definition (no leading comma, no WITH):  ev AS (...)
  // Use it like:  `${c.with}, ${eventStreamCte(q)}, next_cte AS (... FROM ev ...) SELECT ...`
  // Columns: patient_id, kind, code, d (date). Nothing is stored; undated rows are left out.
  //   kind 'dx'  code = SNOMED code,   d = onset date
  //   kind 'rx'  code = RxNorm code,   d = prescribed date
  //   kind 'pr'  code = SNOMED code,   d = performed date
  //   kind 'lab' code = LOINC code,    d = result date  (ABNORMAL results only, same rule as Risk stratification)
  //   kind 'ed'  code = 'EMER',        d = encounter start (emergency visit)
  //   kind 'imp' code = 'IMP',         d = admission start (inpatient; child ACUTE encounters are not included)
  // Step D.3b: eventStreamCte(q, c, true) judges 'lab' events by the data ranges (reviewer limit, reference range, interpretation flag; never the statistical rule,
  //   same as Risk stratification) instead of the dictionary thresholds. It then returns TWO CTE definitions (labx..lf, then ev). Default (no 3rd argument) is unchanged.
  // Only server-defined strings go into the SQL; lab thresholds come from T.LABS and go through q.add().
  const eventStreamCte = (q, c, fromData) => `${fromData ? labFlagCtes(q, c) + ',\n    ' : ''}ev AS (
      SELECT patient_id, 'dx'::text AS kind, code, onset_date AS d FROM dx WHERE onset_date IS NOT NULL AND code IS NOT NULL
      UNION ALL SELECT patient_id, 'rx', code, prescribed_date::date FROM rx WHERE prescribed_date IS NOT NULL AND code IS NOT NULL
      UNION ALL SELECT patient_id, 'pr', code, performed_date::date FROM pr WHERE performed_date IS NOT NULL AND code IS NOT NULL
      ${fromData ? `UNION ALL SELECT patient_id, 'lab', code, effective_date::date FROM lf
        WHERE abn AND effective_date IS NOT NULL AND src IN ('reviewer limit', 'reference range', 'interpretation flag')` : `UNION ALL SELECT o.patient_id, 'lab', o.code, o.effective_date::date
        FROM ob o JOIN (VALUES ${ABN_LABS.map(l => `(${q.add(l.code, 'text')}, ${q.add(l.dir, 'text')}, ${Number(l.thr)}::numeric)`).join(', ')}) AS abn_thr(code, dir, thr) ON abn_thr.code = o.code
        WHERE o.value IS NOT NULL AND o.effective_date IS NOT NULL
          AND ((abn_thr.dir = 'high' AND o.value >= abn_thr.thr) OR (abn_thr.dir = 'low' AND o.value < abn_thr.thr))`}
      UNION ALL SELECT patient_id, CASE cls WHEN 'EMER' THEN 'ed' ELSE 'imp' END, cls, start_date::date FROM en WHERE cls IN ('EMER', 'IMP') AND start_date IS NOT NULL
    )`;

  // ---- Step 1.4: Guideline adherence (V4) ---------------------------------------------
  // One row per measure in T.CONTROL_MEASURES: of patients with the condition, how many had the
  // latest result in the last 12 months at goal, not at goal, or no test at all (a care gap).
  const MEASURES = Object.values(T.CONTROL_MEASURES).map(m => ({ label: m.label, cond: T.CONDITIONS[m.condition].code, lab: T.LABS[m.lab].code, goal: Number(m.goalBelow), poor: Number(m.poorAtOrAbove) }));
  const adherence = (c, q) => `${c.with},
    m(label, cond_code, lab_code, goal, poor) AS (VALUES ${MEASURES.map(x => `(${q.add(x.label, 'text')}, ${q.add(x.cond, 'text')}, ${q.add(x.lab, 'text')}, ${x.goal}::numeric, ${x.poor}::numeric)`).join(', ')}),
    elig AS (SELECT m.label, m.lab_code, m.goal, m.poor, d.patient_id FROM m JOIN (SELECT DISTINCT patient_id, code FROM dx) d ON d.code = m.cond_code),
    lastv AS (SELECT DISTINCT ON (o.patient_id, o.code) o.patient_id, o.code, o.value FROM ob o
              WHERE o.value IS NOT NULL AND o.effective_date > (SELECT d FROM ref) - interval '12 months'
              ORDER BY o.patient_id, o.code, o.effective_date DESC),
    r AS (SELECT e.label, e.goal, e.poor, l.value FROM elig e LEFT JOIN lastv l ON l.patient_id = e.patient_id AND l.code = e.lab_code)
    SELECT label AS measure, count(*)::int AS patients_with_condition, count(value)::int AS tested_last_12m,
      count(*) FILTER (WHERE value < goal)::int AS at_goal,
      ${pct('count(*) FILTER (WHERE value < goal)', 'count(*)')} AS pct_at_goal,
      ${pct('count(*) FILTER (WHERE value >= goal)', 'count(*)')} AS pct_not_at_goal,
      ${pct('count(*) FILTER (WHERE value IS NULL)', 'count(*)')} AS pct_not_tested_gap,
      ${pct('count(*) FILTER (WHERE value >= poor)', 'count(*)')} AS pct_poor_control
    FROM r GROUP BY label ORDER BY label`;

  def({
    id: 'guideline_adherence', category: 'Quality', title: 'Guideline adherence (control measures)',
    description: 'V4: for diabetes (HbA1c < 7), hypertension (systolic < 140) and hyperlipidemia (LDL < 100), the share of patients whose latest result in the last 12 months is at goal, not at goal, or untested (care gap). at goal + not at goal + not tested = 100%. pct_poor_control is the part of "not at goal" that is far above goal.',
    params: [],
    v4: (a, c) => [S('measures', 'Control measures (last 12 months)', q => adherence(c, q))]
  });

  // ---- Step 1.5: Test-ordering intensity (V3, V4) -------------------------------------
  // V3 (no dates): results per patient for each lab/vital code.
  // V4: results per patient-year. Follow-up years per patient = first to last observation of any kind
  //     (minimum 1 year, so one-day patients do not inflate rates); only patients who have that test are counted.
  def({
    id: 'test_ordering', category: 'Laboratory', title: 'Test-ordering intensity',
    description: 'V3: results per patient for each LOINC code. V4: results per patient-year of follow-up (follow-up = first to last observation, minimum 1 year, among patients who have the test) and a quarterly trend for the most-used tests. Optional filter: LOINC code(s).',
    params: [P.code, P.topN],
    v3: (a, c) => [S('by_code', 'Results per patient by LOINC code', q => {
      const f = a.code ? `AND code = ANY(${q.add(codesOf(a), 'text[]')})` : '';
      return `${c.with}
        SELECT code, max(j->'code'->'coding'->0->>'display') AS display, count(DISTINCT patient_id)::int AS patients, count(*)::int AS results,
          round(count(*)::numeric / count(DISTINCT patient_id), 1)::float8 AS results_per_patient
        FROM ob WHERE code IS NOT NULL ${f} GROUP BY code ORDER BY results DESC LIMIT ${num(a.topN, 10)}`;
    })],
    v4: (a, c) => [
      S('by_code', 'Results per patient-year by LOINC code', q => {
        const f = a.code ? `AND code = ANY(${q.add(codesOf(a), 'text[]')})` : '';
        return `${c.with},
          fu AS (SELECT patient_id, GREATEST(1.0, (max(effective_date::date) - min(effective_date::date)) / 365.25) AS yrs FROM ob WHERE effective_date IS NOT NULL GROUP BY 1),
          r AS (SELECT patient_id, code, j FROM ob WHERE effective_date IS NOT NULL AND code IS NOT NULL ${f}),
          t AS (SELECT code, max(j->'code'->'coding'->0->>'display') AS display, count(*)::int AS results, count(DISTINCT patient_id)::int AS patients FROM r GROUP BY code),
          py AS (SELECT x.code, sum(fu.yrs) AS yrs FROM (SELECT DISTINCT patient_id, code FROM r) x JOIN fu ON fu.patient_id = x.patient_id GROUP BY x.code)
          SELECT t.code, t.display, t.patients, t.results, round(py.yrs, 1)::float8 AS patient_years,
            round(t.results / NULLIF(py.yrs, 0), 2)::float8 AS results_per_patient_year
          FROM t JOIN py ON py.code = t.code ORDER BY t.results DESC LIMIT ${num(a.topN, 10)}`;
      }),
      S('by_quarter', 'Quarterly trend for the most-used tests', q => {
        const f = a.code ? `AND code = ANY(${q.add(codesOf(a), 'text[]')})` : '';
        return `${c.with},
          top AS (SELECT code FROM ob WHERE effective_date IS NOT NULL AND code IS NOT NULL ${f} GROUP BY code ORDER BY count(*) DESC LIMIT ${num(a.topN, 10)})
          SELECT code, EXTRACT(YEAR FROM effective_date)::int AS year, EXTRACT(QUARTER FROM effective_date)::int AS quarter,
            count(*)::int AS results, count(DISTINCT patient_id)::int AS patients_tested,
            round(count(*)::numeric / count(DISTINCT patient_id), 2)::float8 AS results_per_tested_patient
          FROM ob WHERE effective_date IS NOT NULL AND code IN (SELECT code FROM top) GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
      })
    ]
  });

  // ---- Step 1.6: Lab co-occurrence (V4) ------------------------------------------------
  // Which tests are ordered together: pairs of LOINC codes on the same patient on the same day.
  // Unit = patient-day. lift = pair_days * total_patient_days / (days_a * days_b); above 1 means ordered together more than chance.
  // (Needs dates, so it is V4. A V3 version would be meaningless: nearly every pair of tests occurs "ever" in a patient.)
  def({
    id: 'lab_cooccurrence', category: 'Laboratory', title: 'Lab co-occurrence (tests ordered together)',
    description: 'V4: pairs of lab/vital codes recorded for the same patient on the same day, ranked by lift (how much more often they occur together than by chance). Pairs with fewer than the minimum number of shared patient-days are hidden.',
    params: [
      { name: 'minPairs', label: 'Minimum shared patient-days', type: 'number', default: 20, modes: ['v4'] },
      P.topN
    ],
    v4: (a, c) => [S('pairs', 'Test pairs ordered together (same patient, same day)', () => `${c.with},
      pd AS (SELECT DISTINCT patient_id, effective_date::date AS d, code FROM ob WHERE effective_date IS NOT NULL AND code IS NOT NULL),
      tot AS (SELECT count(*)::numeric AS n FROM (SELECT DISTINCT patient_id, d FROM pd) x),
      cnt AS (SELECT code, count(*)::numeric AS c FROM pd GROUP BY code),
      disp AS (SELECT code, max(j->'code'->'coding'->0->>'display') AS display FROM ob WHERE code IS NOT NULL GROUP BY code),
      prs AS (SELECT a.code AS code_a, b.code AS code_b, count(*)::int AS pair_days FROM pd a JOIN pd b ON b.patient_id = a.patient_id AND b.d = a.d AND a.code < b.code GROUP BY 1, 2)
      SELECT COALESCE(da.display, prs.code_a) AS test_a, COALESCE(db.display, prs.code_b) AS test_b, prs.code_a, prs.code_b, prs.pair_days,
        ca.c::int AS days_with_a, cb.c::int AS days_with_b,
        ${pct('prs.pair_days', 'ca.c')} AS pct_of_a_days_with_b,
        round(prs.pair_days * tot.n / (ca.c * cb.c), 2)::float8 AS lift
      FROM prs JOIN cnt ca ON ca.code = prs.code_a JOIN cnt cb ON cb.code = prs.code_b CROSS JOIN tot
        LEFT JOIN disp da ON da.code = prs.code_a LEFT JOIN disp db ON db.code = prs.code_b
      WHERE prs.pair_days >= ${num(a.minPairs, 20)}
      ORDER BY lift DESC, prs.pair_days DESC LIMIT ${num(a.topN, 25)}`)]
  });

  // ---- Step 1.7a: Readmission drivers (V4) ---------------------------------------------
  // One row per inpatient discharge (idx). readm = another inpatient stay starts within 30 days after discharge
  // (same rule as the readmission section of "Encounter utilization & readmissions").
  // Drivers are evaluated as of the discharge date. Unknown birth date / gender count as "without".
  // 1.7b added chronic3 and diabetes (diagnosed on or before the discharge date). 1.7c added drugs5 (5+ distinct drug codes prescribed in the 12 months up to discharge).
  const rdBase = c => `${c.with},
    idx AS (SELECT e.patient_id, e.end_date,
        EXISTS (SELECT 1 FROM en b WHERE b.patient_id = e.patient_id AND b.cls = 'IMP' AND b.start_date > e.end_date AND b.start_date <= e.end_date + interval '30 days') AS readm
      FROM en e WHERE e.cls = 'IMP' AND e.end_date IS NOT NULL)`;
  const rdDrivers = (c, q) => {
    const chP = q.add(chronicOf(c), 'text[]'), dmP = q.add([T.CONDITIONS.diabetes.code], 'text[]');
    return `${rdBase(c)},
    f AS (SELECT i.readm,
        COALESCE(p.birth_date IS NOT NULL AND EXTRACT(YEAR FROM age(i.end_date, p.birth_date)) >= 65, false) AS age65,
        COALESCE(lower(p.gender) = 'male', false) AS male,
        (SELECT count(DISTINCT x.code) FROM dx x WHERE x.patient_id = i.patient_id AND x.code = ANY(${chP}) AND x.onset_date <= i.end_date) >= 3 AS chronic3,
        EXISTS (SELECT 1 FROM dx x WHERE x.patient_id = i.patient_id AND x.code = ANY(${dmP}) AND x.onset_date <= i.end_date) AS diabetes,
        (SELECT count(DISTINCT x.code) FROM rx x WHERE x.patient_id = i.patient_id AND x.code IS NOT NULL AND x.prescribed_date <= i.end_date AND x.prescribed_date > i.end_date - interval '12 months') >= 5 AS drugs5
      FROM idx i JOIN p ON p.patient_id = i.patient_id),
    d(ord, driver, has, readm) AS (
      SELECT 1, 'Age 65 or older', age65, readm FROM f
      UNION ALL SELECT 2, 'Male', male, readm FROM f
      UNION ALL SELECT 3, '3 or more chronic conditions', chronic3, readm FROM f
      UNION ALL SELECT 4, 'Diabetes', diabetes, readm FROM f
      UNION ALL SELECT 5, '5 or more distinct drugs (prior 12 months)', drugs5, readm FROM f),
    g AS (SELECT ord, driver,
        count(*) FILTER (WHERE has)::numeric AS n_with, count(*) FILTER (WHERE has AND readm)::numeric AS r_with,
        count(*) FILTER (WHERE NOT has)::numeric AS n_wo, count(*) FILTER (WHERE NOT has AND readm)::numeric AS r_wo
      FROM d GROUP BY ord, driver)
    SELECT driver, n_with::int AS discharges_with, ${pct('r_with', 'n_with')} AS readmit_pct_with,
      n_wo::int AS discharges_without, ${pct('r_wo', 'n_wo')} AS readmit_pct_without,
      round((100 * (r_with / NULLIF(n_with, 0) - r_wo / NULLIF(n_wo, 0)))::numeric, 1)::float8 AS diff_pct_points,
      round(((r_with / NULLIF(n_with, 0)) / NULLIF(r_wo / NULLIF(n_wo, 0), 0))::numeric, 2)::float8 AS risk_ratio
    FROM g ORDER BY ord`;
  };

  def({
    id: 'readmission_drivers', category: 'Utilization', title: 'Readmission drivers (30-day)',
    description: 'V4: for every inpatient discharge, whether another inpatient stay began within 30 days, compared between discharges with and without each driver (age 65+, male, 3+ chronic conditions, diabetes, 5+ distinct drugs in the 12 months before discharge). Unadjusted, one row per discharge (a patient with several discharges counts several times), small groups are unstable. risk_ratio = readmission rate with the driver / without it. The reconcile section should match the readmission section of Encounter utilization.',
    params: [],
    v4: (a, c) => [
      S('drivers', 'Readmission rate by driver', q => rdDrivers(c, q)),
      S('reconcile', 'Reconciliation: all discharges', () => `${rdBase(c)}
        SELECT count(*)::int AS discharges, count(*) FILTER (WHERE readm)::int AS readmissions_30d,
          ${pct('count(*) FILTER (WHERE readm)', 'count(*)')} AS readmission_rate_pct FROM idx`)
    ]
  });

  // ---- Step 1.8: Seasonal pattern (V4) --------------------------------------------------
  // Counts by calendar month (all years pooled). expected = total / 12, ratio = observed / expected (about 1.0 = no seasonality).
  // Only server-defined strings go into SQL (SRC / CLS maps); the LOINC filter goes through q.add().
  const SRC = { en: { col: 'start_date', from: 'en' }, ob: { col: 'effective_date', from: 'ob' } };
  const CLS = { AMB: 'AMB', EMER: 'EMER', IMP: 'IMP' };
  const seasonSrc = (a, q) => {
    const s = SRC[a.source] || SRC.en;
    let where = `${s.col} IS NOT NULL`;
    if (s.from === 'en' && CLS[a.cls]) where += ` AND cls = ${q.add(CLS[a.cls], 'text')}`;
    if (s.from === 'ob' && a.code) where += ` AND code = ANY(${q.add(codesOf(a), 'text[]')})`;
    return { s, where };
  };

  def({
    id: 'seasonal_pattern', category: 'Utilization', title: 'Seasonal pattern (by calendar month)',
    description: 'V4: events per calendar month with all years pooled, the expected count (total / 12) and the ratio observed / expected; a ratio near 1.0 means no seasonality. Source is encounters (optionally one class) or lab/vital results (optionally LOINC code(s)). If the data does not cover whole years, months covered more often will look busier; check the data span section.',
    params: [
      { name: 'source', label: 'Count', type: 'select', default: 'en', modes: ['v4'], options: [{ value: 'en', label: 'Encounters' }, { value: 'ob', label: 'Lab / vital results' }] },
      { name: 'cls', label: 'Encounter class (encounters only)', type: 'select', default: '', modes: ['v4'], options: [{ value: '', label: 'All classes' }, { value: 'AMB', label: 'Ambulatory' }, { value: 'EMER', label: 'Emergency' }, { value: 'IMP', label: 'Inpatient' }] },
      { name: 'code', label: 'LOINC code(s) (results only)', type: 'text', modes: ['v4'] }
    ],
    v4: (a, c) => [
      S('months', 'Observed vs expected by month', q => {
        const { s, where } = seasonSrc(a, q);
        return `${c.with},
          ev AS (SELECT EXTRACT(MONTH FROM ${s.col})::int AS m FROM ${s.from} WHERE ${where}),
          cnt AS (SELECT m, count(*)::int AS n FROM ev GROUP BY m),
          tot AS (SELECT count(*)::numeric AS t FROM ev)
          SELECT mo.m AS month, to_char(make_date(2000, mo.m, 1), 'Mon') AS month_name, COALESCE(cnt.n, 0) AS observed,
            round(tot.t / 12, 1)::float8 AS expected,
            round(COALESCE(cnt.n, 0) / NULLIF(tot.t / 12, 0), 2)::float8 AS ratio
          FROM generate_series(1, 12) AS mo(m) LEFT JOIN cnt ON cnt.m = mo.m CROSS JOIN tot ORDER BY mo.m`;
      }),
      S('span', 'Data span used', q => {
        const { s, where } = seasonSrc(a, q);
        return `${c.with}
          SELECT min(${s.col})::date AS first_date, max(${s.col})::date AS last_date, count(*)::int AS events,
            round(((max(${s.col})::date - min(${s.col})::date) / 365.25)::numeric, 1)::float8 AS years_covered
          FROM ${s.from} WHERE ${where}`;
      })
    ]
  });

  // ---- Step 3.3: Region x payer (V3) ----------------------------------------------------
  // State comes from the Patient address (no new data needed); payer from the extension added in Step 3.2.
  // V3 only: no dates are used. Patients without an address or payer show as "Unknown".
  def({
    id: 'region_payer', category: 'Equity', title: 'Region x payer mix',
    description: 'V3: patients by state and payer, with each payer\'s share inside the state (pct_of_state, adds to 100 per state) and share of all patients. State is read from the first Patient address; payer from the payer extension (demo data from the synthetic generator). Batches without payer data show "Unknown".',
    params: [],
    v3: (a, c) => [S('mix', 'Patients by state and payer', () => `${c.with},
      b AS (SELECT COALESCE(pj->'address'->0->>'state', 'Unknown') AS state, ${STRAT.payer} AS payer FROM p),
      g AS (SELECT state, payer, count(*)::int AS patients FROM b GROUP BY 1, 2)
      SELECT state, payer, patients, ${pct('patients', 'sum(patients) OVER (PARTITION BY state)')} AS pct_of_state,
        ${pct('patients', 'sum(patients) OVER ()')} AS pct_of_all_patients
      FROM g ORDER BY state, patients DESC, payer`)]
  });

  // ---- Step 3.7: Vaccination coverage (V3 and V4) ---------------------------------------
  // Uses the `im` CTE (Step 3.6). Eligibility is by age at the as-of date; the minimum ages below match the demo generator.
  // Patients without a birth date are never counted as eligible. Only server-defined strings go into SQL; codes and ages go through q.add().
  const VAX_MIN_AGE = { influenza: 0.5, tdap: 11, covid19: 5 };
  const VAX_GROUP = {
    none: `'All patients'`,
    age: bandCase('floor(age)'),
    gender: STRAT.gender,
    payer: STRAT.payer,
    income: STRAT.income
  };
  const vaxList = (a, q) => Object.entries(T.IMMUNIZATIONS).filter(([key]) => !Object.hasOwn(T.IMMUNIZATIONS, a.vaccine) || key === a.vaccine)
    .map(([key, d]) => `(${q.add(key, 'text')}, ${q.add(d.code, 'text')}, ${q.add(VAX_MIN_AGE[key] != null ? VAX_MIN_AGE[key] : 0, 'numeric')})`).join(', ');
  // Shared frame: pp = one row per patient with age and group; vx = vaccines; cnt = doses per patient and vaccine (optionally date-limited).
  const vaxFrame = (a, c, q, doseWhere) => {
    const by = Object.hasOwn(VAX_GROUP, a.by) ? a.by : 'none';
    return { by, sql: `${c.with},
      pa AS (SELECT p.*, ((SELECT d FROM ref) - p.birth_date) / 365.25 AS age FROM p),
      pp AS (SELECT patient_id, age, ${VAX_GROUP[by]} AS grp FROM pa),
      vx(vaccine, code, min_age) AS (VALUES ${vaxList(a, q)}),
      cnt AS (SELECT patient_id, code, count(*)::int AS doses FROM im ${doseWhere} GROUP BY 1, 2),
      e AS (SELECT vx.vaccine, pp.grp, pp.age, COALESCE(cnt.doses, 0) AS doses
            FROM vx JOIN pp ON pp.age >= vx.min_age LEFT JOIN cnt ON cnt.patient_id = pp.patient_id AND cnt.code = vx.code)` };
  };
  const vaxCoverage = (a, c, q, doseWhere) => {
    const f = vaxFrame(a, c, q, doseWhere);
    return `${f.sql}
      SELECT vaccine, grp AS "group", count(*)::int AS eligible, count(*) FILTER (WHERE doses > 0)::int AS vaccinated,
        ${pct('count(*) FILTER (WHERE doses > 0)', 'count(*)')} AS coverage_pct,
        round(avg(doses) FILTER (WHERE doses > 0), 1)::float8 AS avg_doses_if_vaccinated,
        CASE WHEN count(*) < 30 THEN 'small group - unstable' END AS note
      FROM e GROUP BY vaccine, grp ORDER BY vaccine, ${f.by === 'age' ? 'min(age)' : 'grp'}`;
  };
  const vaxParams = [
    { name: 'vaccine', label: 'Vaccine', type: 'select', default: 'all', options: [{ value: 'all', label: 'All vaccines' }, ...Object.entries(T.IMMUNIZATIONS).map(([key, d]) => ({ value: key, label: d.terms[0] }))] },
    { name: 'by', label: 'Group by', type: 'select', default: 'none', options: [{ value: 'none', label: 'No grouping' }, { value: 'age', label: 'Age band' }, { value: 'gender', label: 'Gender' }, { value: 'payer', label: 'Payer' }, { value: 'income', label: 'Income band' }] },
    { name: 'months', label: 'Recent window (months)', type: 'number', default: 12, modes: ['v4'] }
  ];

  def({
    id: 'vaccination_coverage', category: 'Prevention', title: 'Vaccination coverage',
    description: 'Share of eligible patients vaccinated, per vaccine, optionally by age band, gender, payer or income (payer and income are demo data). Eligible = age at the as-of date at least 6 months (influenza), 5 years (COVID-19) or 11 years (Tdap); patients with no birth date are excluded. V3: ever vaccinated (codes only, no dates). V4: vaccinated within the recent window (default 12 months before the as-of date), plus COVID-19 series completion (started, 2 or more doses = primary series complete, 3 or more = with booster). Groups under 30 are flagged as unstable. Batches without immunization data show 0%.',
    params: vaxParams,
    v3: (a, c) => [S('coverage', 'Ever vaccinated (by CVX code)', q => vaxCoverage(a, c, q, ''))],
    v4: (a, c) => {
      const m = Math.min(Math.max(Math.round(num(a.months, 12)), 1), 120);
      const upTo = `occurrence_date::date <= (SELECT d FROM ref)`;
      return [
        S('recent', `Vaccinated in the last ${m} months`, q => vaxCoverage(a, c, q, `WHERE ${upTo} AND occurrence_date::date > (SELECT d FROM ref) - interval '${m} months'`)),
        S('series', 'COVID-19 series completion (doses on or before the as-of date)', q => {
          const f = vaxFrame({ ...a, vaccine: 'covid19' }, c, q, `WHERE ${upTo}`);
          return `${f.sql}
            SELECT grp AS "group", count(*)::int AS eligible, count(*) FILTER (WHERE doses >= 1)::int AS started,
              count(*) FILTER (WHERE doses >= 2)::int AS primary_series_complete, count(*) FILTER (WHERE doses >= 3)::int AS with_booster,
              ${pct('count(*) FILTER (WHERE doses >= 2)', 'count(*)')} AS complete_pct_of_eligible,
              ${pct('count(*) FILTER (WHERE doses >= 2)', 'count(*) FILTER (WHERE doses >= 1)')} AS complete_pct_of_started,
              CASE WHEN count(*) < 30 THEN 'small group - unstable' END AS note
            FROM e GROUP BY grp ORDER BY ${f.by === 'age' ? 'min(age)' : 'grp'}`;
        })
      ];
    }
  });

  // ---- Step 3.8a: Medication adherence, fill intervals (V4) ------------------------------
  // Each fill (MedicationStatement date) is assumed to cover `supply` days: [d, d + supply). Overlapping or touching
  // fills are merged per patient (gaps-and-islands) so no day is counted twice. Span = first fill to the as-of date.
  // Patients whose span is shorter than one supply period are "not evaluable". Later steps (3.8b-e) build on adhFrame().
  const AGE_ORDER = ['0-1 years', '2-4 years', '5-17 years', '18-34 years', '35-44 years', '45-54 years', '55-64 years', '65-74 years', '75-84 years', '85+ years', 'Unknown'];
  // Step M.6: the fills, merged-interval and PDC pieces, shared by medication_adherence (adhFrame) and the disease module's adherence pass.
  // pdcFrom(c, q, drugCode, supply) returns { supply, sql }: CTE text (no WITH, no leading comma) defining
  //   f (distinct fill dates up to the as-of date), g (fills with the previous coverage end), isl (islands), iv (merged coverage intervals),
  //   fl (fills and last fill per patient) and pd (one row per patient on the drug: first_fill, last_fill, fills, covered_days, span_days).
  // `supply` is clamped to 7-180 days. The caller adds its own CTEs after it (it needs c.with before it) and decides who is evaluable (span_days >= supply).
  const pdcFrom = (c, q, drugCode, supplyDays) => {
    const supply = Math.min(Math.max(Math.round(num(supplyDays, 30)), 7), 180);
    const code = q.add(drugCode, 'text'), sp = q.add(supply, 'int');
    return { supply, sql: `f AS (SELECT DISTINCT patient_id, prescribed_date::date AS d FROM rx
            WHERE code = ${code} AND prescribed_date IS NOT NULL AND prescribed_date::date <= (SELECT d FROM ref)),
      g AS (SELECT patient_id, d, d + ${sp} AS e,
              max(d + ${sp}) OVER (PARTITION BY patient_id ORDER BY d ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_end FROM f),
      isl AS (SELECT patient_id, d, e, sum(CASE WHEN prev_end IS NULL OR d > prev_end THEN 1 ELSE 0 END) OVER (PARTITION BY patient_id ORDER BY d) AS island FROM g),
      iv AS (SELECT patient_id, island, min(d) AS s, LEAST(max(e), (SELECT d FROM ref)) AS e FROM isl GROUP BY 1, 2),
      fl AS (SELECT patient_id, count(*)::int AS fills, max(d) AS last_fill FROM f GROUP BY 1),
      pd AS (SELECT iv.patient_id, min(iv.s) AS first_fill, fl.last_fill, fl.fills, sum(iv.e - iv.s)::int AS covered_days,
               ((SELECT d FROM ref) - min(iv.s))::int AS span_days
             FROM iv JOIN fl ON fl.patient_id = iv.patient_id GROUP BY iv.patient_id, fl.last_fill, fl.fills)` };
  };
  const adhFrame = (a, c, q) => {
    if (!Object.hasOwn(T.MEDICATIONS, a.drug)) throw new Error('Pick a medication');
    const pf = pdcFrom(c, q, T.MEDICATIONS[a.drug].code, a.supply), supply = pf.supply;
    const by = Object.hasOwn(VAX_GROUP, a.by) ? a.by : 'none';   // server-defined group expressions only (see VAX_GROUP, Step 3.7)
    return { supply, by, ord: by === 'age' ? `array_position(ARRAY[${AGE_ORDER.map(b => `'${b}'`).join(',')}], grp)` : 'grp', sql: `${c.with},
      ${pf.sql},
      pa AS (SELECT p.*, ((SELECT d FROM ref) - p.birth_date) / 365.25 AS age FROM p),
      gp AS (SELECT patient_id, ${VAX_GROUP[by]} AS grp FROM pa),
      pm AS (SELECT pd.*, gp.grp, LEAST(pd.covered_days::numeric / NULLIF(pd.span_days, 0), 1) AS pdc, LEAST(pd.covered_days::numeric / NULLIF(pd.span_days, 0), 1) >= 0.8 AS adherent
             FROM pd JOIN gp ON gp.patient_id = pd.patient_id WHERE pd.span_days >= ${supply})` };
  };

  // Persistence CTEs (x = break/last coverage end per patient, ps = persistence days and stopped flag per evaluable patient). Needs the adhFrame() CTEs before it.
  const adhPersist = grace => `x AS (SELECT patient_id, min(prev_end) FILTER (WHERE d - prev_end > ${grace}) AS break_end, max(e) AS last_end FROM g GROUP BY 1),
      ps AS (SELECT pm.patient_id, pm.grp, pm.span_days,
               (CASE WHEN x.break_end IS NOT NULL THEN x.break_end WHEN (SELECT d FROM ref) - x.last_end > ${grace} THEN x.last_end ELSE (SELECT d FROM ref) END - pm.first_fill)::int AS days,
               (x.break_end IS NOT NULL OR (SELECT d FROM ref) - x.last_end > ${grace}) AS stopped
             FROM pm JOIN x ON x.patient_id = pm.patient_id)`;
  const adhGrace = a => Math.min(Math.max(Math.round(num(a.grace, 45)), 1), 365);

  def({
    id: 'medication_adherence', category: 'Medications', title: 'Medication adherence (PDC proxy)',
    description: 'V4: for one drug, assumes each prescription/statement date covers a fixed supply (default 30 days), merges overlapping fills and measures covered days from the first fill to the as-of date. Shows a scope check, the PDC summary (mean, median, % adherent with PDC of 0.8 or more), PDC bands and persistence among evaluable patients, optionally grouped by age band, gender, payer or income (payer and income are demo data; groups under 30 evaluable patients are flagged as unstable; the scope check is never grouped). A last section lists the 5 lowest and 5 highest PDC patients so one can be checked by hand against the raw statements (it shows patient ids; use on synthetic or de-identified data). Persistence: a patient stops at the end of the last covered day before the first gap longer than the allowed gap (default 45 days), including a gap that runs up to the as-of date; patients with no such gap are still on the drug and count as observed to the as-of date. The 180/365-day rates use only patients with at least that much follow-up. A proxy built from statement dates, not pharmacy claims. Patients whose first fill is less than one supply period before the as-of date are not evaluable.',
    params: [
      { name: 'drug', label: 'Medication', type: 'select', default: 'metformin', modes: ['v4'], options: Object.entries(T.MEDICATIONS).map(([key, d]) => ({ value: key, label: d.terms[0] })) },
      { name: 'supply', label: 'Days supplied per fill', type: 'number', default: 30, modes: ['v4'] },
      { name: 'grace', label: 'Allowed gap before stopping (days)', type: 'number', default: 45, modes: ['v4'] },
      { name: 'by', label: 'Group by', type: 'select', default: 'none', modes: ['v4'], options: [{ value: 'none', label: 'No grouping' }, { value: 'age', label: 'Age band (at as-of date)' }, { value: 'gender', label: 'Gender' }, { value: 'payer', label: 'Payer' }, { value: 'income', label: 'Income band' }] }
    ],
    v4: (a, c) => [S('scope', 'Scope check', q => {
      const f = adhFrame(a, c, q);
      return `${f.sql}
        SELECT count(*)::int AS patients_on_drug, count(*) FILTER (WHERE span_days >= ${f.supply})::int AS patients_evaluable,
          sum(fills)::int AS fills, round(avg(fills), 1)::float8 AS avg_fills_per_patient,
          round(avg(span_days) FILTER (WHERE span_days >= ${f.supply}), 0)::float8 AS avg_span_days,
          count(*) FILTER (WHERE covered_days > span_days)::int AS covered_exceeds_span
        FROM pd`;
    }),
    S('summary', 'PDC summary (evaluable patients)', q => { const f = adhFrame(a, c, q); return `${f.sql}
      SELECT grp AS "group", count(*)::int AS patients, round(avg(pdc), 3)::float8 AS mean_pdc,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY pdc))::numeric, 3)::float8 AS median_pdc,
        count(*) FILTER (WHERE adherent)::int AS adherent, ${pct('count(*) FILTER (WHERE adherent)', 'count(*)')} AS adherent_pct,
        CASE WHEN count(*) < 30 THEN 'small group - unstable' END AS note
      FROM pm GROUP BY grp ORDER BY ${f.ord}`; }),
    S('bands', 'PDC bands (evaluable patients)', q => { const f = adhFrame(a, c, q); return `${f.sql},
      b AS (SELECT grp, CASE WHEN pdc >= 1 THEN '4 PDC 1.0' WHEN pdc >= 0.8 THEN '3 PDC 0.8-0.99' WHEN pdc >= 0.5 THEN '2 PDC 0.5-0.79' ELSE '1 PDC under 0.5' END AS band FROM pm)
      SELECT grp AS "group", band, count(*)::int AS patients, ${pct('count(*)', 'sum(count(*)) OVER (PARTITION BY grp)')} AS pct_of_group
      FROM b GROUP BY grp, band ORDER BY ${f.ord}, band`; }),
    S('persistence', 'Persistence (evaluable patients)', q => {
      const grace = adhGrace(a), f = adhFrame(a, c, q);
      return `${f.sql},
      ${adhPersist(grace)}
      SELECT grp AS "group", count(*)::int AS patients, round((percentile_cont(0.5) WITHIN GROUP (ORDER BY days))::numeric, 0)::float8 AS median_persistence_days,
        count(*) FILTER (WHERE span_days >= 180)::int AS patients_with_180d_followup,
        ${pct('count(*) FILTER (WHERE span_days >= 180 AND days >= 180)', 'count(*) FILTER (WHERE span_days >= 180)')} AS pct_persistent_180d,
        count(*) FILTER (WHERE span_days >= 365)::int AS patients_with_365d_followup,
        ${pct('count(*) FILTER (WHERE span_days >= 365 AND days >= 365)', 'count(*) FILTER (WHERE span_days >= 365)')} AS pct_persistent_365d,
        ${pct('count(*) FILTER (WHERE NOT stopped)', 'count(*)')} AS still_on_drug_pct,
        CASE WHEN count(*) < 30 THEN 'small group - unstable' END AS note
      FROM ps GROUP BY grp ORDER BY ${f.ord}`;
    }),
    S('sample', 'Validation sample: 5 lowest and 5 highest PDC (check one by hand)', q => {
      const f = adhFrame(a, c, q);
      return `${f.sql},
      ${adhPersist(adhGrace(a))},
      r AS (SELECT pm.patient_id, pm.fills, pm.first_fill, pm.last_fill, pm.covered_days, pm.span_days, pm.pdc, ps.days AS persistence_days, ps.stopped,
              row_number() OVER (ORDER BY pm.pdc, pm.patient_id) AS lo, row_number() OVER (ORDER BY pm.pdc DESC, pm.patient_id) AS hi
            FROM pm JOIN ps ON ps.patient_id = pm.patient_id)
      SELECT CASE WHEN lo <= 5 THEN 'lowest' ELSE 'highest' END AS sample, patient_id, fills, first_fill, last_fill, covered_days, span_days,
        round(pdc, 3)::float8 AS pdc, persistence_days, stopped
      FROM r WHERE lo <= 5 OR hi <= 5 ORDER BY pdc, patient_id`;
    })]
  });

  // ---- Step 3.9: Derived clinical values at query time (nothing is stored) ----------------
  // eGFR: CKD-EPI 2021 creatinine equation (race-free, adults 18+), checked against the published NKF/NIDDK formula:
  //   142 x min(Scr/k,1)^a x max(Scr/k,1)^-1.200 x 0.9938^age x 1.012 [female]; k = 0.7 F / 0.9 M; a = -0.241 F / -0.302 M; Scr in mg/dL.
  // CHA2DS2-VASc (AF patients): heart failure 1, hypertension 1, age 75+ 2 / 65-74 1, diabetes 1, stroke 2, vascular disease 1 (coronary
  // artery disease code only here), female 1. Only server-defined strings and constants go into SQL; codes go through q.add().
  // Step M.8: egfrCtes(q, m) is the CTE text (cr, m, e; no WITH, no leading comma); egfrSql adds c.with in front. Shared with the disease module's CKD pass.
  const egfrCtes = (q, m) => `cr AS (SELECT DISTINCT ON (o.patient_id) o.patient_id, o.value AS scr, o.effective_date::date AS d FROM ob o
           WHERE o.code = ${q.add(T.LABS.creatinine.code, 'text')} AND o.value > 0 AND o.effective_date IS NOT NULL AND (o.unit IS NULL OR lower(o.unit) = 'mg/dl')
             AND o.effective_date::date <= (SELECT d FROM ref) AND o.effective_date::date > (SELECT d FROM ref) - interval '${m} months'
           ORDER BY o.patient_id, o.effective_date DESC),
    m AS (SELECT cr.patient_id, cr.scr, EXTRACT(YEAR FROM age(cr.d, p.birth_date))::int AS age_y, (lower(p.gender) = 'female') AS fem
          FROM cr JOIN p ON p.patient_id = cr.patient_id WHERE p.birth_date IS NOT NULL AND lower(p.gender) IN ('female', 'male')),
    e AS (SELECT patient_id, 142 * power(LEAST(scr / (CASE WHEN fem THEN 0.7 ELSE 0.9 END), 1)::float8, (CASE WHEN fem THEN -0.241 ELSE -0.302 END)::float8)
            * power(GREATEST(scr / (CASE WHEN fem THEN 0.7 ELSE 0.9 END), 1)::float8, -1.2) * power(0.9938::float8, age_y) * (CASE WHEN fem THEN 1.012 ELSE 1 END) AS egfr
          FROM m WHERE age_y >= 18)`;
  const egfrSql = (c, q, m) => `${c.with},
    ${egfrCtes(q, m)}`;
  const VASC_CODES = { chf: 'heart_failure', htn: 'hypertension', dm: 'diabetes', stroke: 'stroke', vasc: 'cad' };
  const vascSql = (c, q, timed) => {
    const has = key => `(EXISTS (SELECT 1 FROM dx WHERE dx.patient_id = af.patient_id AND dx.code = ${q.add(T.CONDITIONS[VASC_CODES[key]].code, 'text')} ${timed ? 'AND dx.onset_date <= af.idx' : ''}))::int`;
    return `${c.with},
      af AS (SELECT patient_id ${timed ? ', min(onset_date) AS idx' : ''} FROM dx WHERE code = ${q.add(T.CONDITIONS.afib.code, 'text')} ${timed ? 'AND onset_date IS NOT NULL' : ''} GROUP BY patient_id),
      b AS (SELECT af.patient_id, ${has('chf')} AS chf, ${has('htn')} AS htn, ${has('dm')} AS dm, ${has('stroke')} AS stroke, ${has('vasc')} AS vasc,
              CASE WHEN p.birth_date IS NULL THEN NULL ELSE EXTRACT(YEAR FROM age(${timed ? 'af.idx' : '(SELECT d FROM ref)'}, p.birth_date))::int END AS age_y,
              (lower(p.gender) = 'female')::int AS fem
            FROM af JOIN p ON p.patient_id = af.patient_id),
      sc AS (SELECT *, chf + htn + dm + 2 * stroke + vasc + CASE WHEN age_y >= 75 THEN 2 WHEN age_y >= 65 THEN 1 ELSE 0 END + fem AS score FROM b)`;
  };
  const vascSections = (c, timed) => [
    S('vasc_score', `CHA2DS2-VASc score distribution (AF patients; ${timed ? 'conditions and age as of first AF diagnosis' : 'conditions ever coded, age at the as-of date'})`, q => `${vascSql(c, q, timed)}
      SELECT score, count(*)::int AS patients, ${pct('count(*)', 'sum(count(*)) OVER ()')} AS pct_of_af_patients FROM sc GROUP BY score ORDER BY score`),
    S('vasc_components', 'CHA2DS2-VASc components', q => `${vascSql(c, q, timed)}
      SELECT count(*)::int AS af_patients, round(avg(score), 2)::float8 AS mean_score, ${pct('count(*) FILTER (WHERE score >= 2)', 'count(*)')} AS pct_score_2_plus,
        ${pct('sum(chf)', 'count(*)')} AS pct_heart_failure, ${pct('sum(htn)', 'count(*)')} AS pct_hypertension, ${pct('sum(dm)', 'count(*)')} AS pct_diabetes,
        ${pct('sum(stroke)', 'count(*)')} AS pct_stroke, ${pct('sum(vasc)', 'count(*)')} AS pct_vascular, ${pct('sum(fem)', 'count(*)')} AS pct_female,
        count(*) FILTER (WHERE age_y IS NULL)::int AS age_unknown
      FROM sc`)
  ];

  def({
    id: 'derived_values', category: 'Derived values', title: 'Derived values (eGFR, CHA2DS2-VASc)',
    description: 'Values computed at query time, never stored. CHA2DS2-VASc for patients with an atrial fibrillation code: heart failure, hypertension, diabetes, stroke, coronary artery disease, age and sex (a transparent point score from coded diagnoses only; TIA and other vascular disease are not included). V3: conditions ever coded and age at the as-of date. V4: conditions recorded on or before the first AF diagnosis and age at that date, plus eGFR (CKD-EPI 2021, creatinine in mg/dL, adults 18+ with a known sex and birth date) from each patient\'s latest creatinine in the chosen window, with CKD stages G1-G5 (stage only, no albuminuria category). Estimates for exploration, not for clinical decisions.',
    params: [{ name: 'months', label: 'Creatinine window (months)', type: 'number', default: 12, modes: ['v4'] }],
    v3: (a, c) => vascSections(c, false),
    v4: (a, c) => {
      const m = Math.min(Math.max(Math.round(num(a.months, 12)), 1), 120);
      return [
        S('egfr_summary', `eGFR from the latest creatinine in the last ${m} months`, q => `${egfrSql(c, q, m)}
          SELECT (SELECT count(*) FROM cr)::int AS patients_with_creatinine, count(*)::int AS egfr_computed, round(avg(egfr)::numeric, 1)::float8 AS mean_egfr,
            round((percentile_cont(0.5) WITHIN GROUP (ORDER BY egfr))::numeric, 1)::float8 AS median_egfr,
            ${pct('count(*) FILTER (WHERE egfr < 60)', 'count(*)')} AS pct_below_60
          FROM e`),
        S('egfr_stages', 'CKD stage by eGFR (G1 90+, G2 60-89, G3a 45-59, G3b 30-44, G4 15-29, G5 under 15)', q => `${egfrSql(c, q, m)},
          st AS (SELECT CASE WHEN egfr >= 90 THEN 'G1 (90+)' WHEN egfr >= 60 THEN 'G2 (60-89)' WHEN egfr >= 45 THEN 'G3a (45-59)' WHEN egfr >= 30 THEN 'G3b (30-44)' WHEN egfr >= 15 THEN 'G4 (15-29)' ELSE 'G5 (under 15)' END AS stage FROM e)
          SELECT stage, count(*)::int AS patients, ${pct('count(*)', 'sum(count(*)) OVER ()')} AS pct_of_patients FROM st GROUP BY stage ORDER BY stage`),
        ...vascSections(c, true)
      ];
    }
  });

  // ---- Steps 4.1 and 4.2: PICO / PECO study (V4 only) -----------------------------------
  // Landmark design: index = first dated diagnosis of the condition. Exposure is decided in days 0-90 after the index date.
  // Arm I = exposed: started an exposure code in days 0-90 (new users only: none before the index date).
  //   PICO: exposure = drug (RxNorm). PECO: exposure = drug or a diagnosis code (`etype`).
  // Arm C = comparison group: with `cmp` set, a comparison code in days 0-90 and no exposure code in days 0-90;
  //         with `cmp` blank, no exposure code in days 0-90. Anyone on both is in neither arm (keeps the arms separate).
  // Patients with prior exposure are excluded. Only patients with 90 + `days` of follow-up before the as-of date are eligible.
  // Outcome (counted from day 91 to day 90 + days, after removing patients who already had it by day 90):
  //   ED visit (EMER), inpatient admission (IMP), or (PECO only) a new diagnosis code (`ocode`; any earlier record of it excludes the patient).
  // Builders are plain functions returning SQL text, shared by both analytics. Codes always go through q.add().
  const PICO_CODE = /^[0-9A-Za-z.\-]{1,20}$/;
  const picoCodes = (v, label) => {
    const list = String(v ?? '').split(',').map(x => x.trim()).filter(Boolean);
    if (list.length > 20) throw new Error(`${label}: at most 20 codes`);
    for (const x of list) if (!PICO_CODE.test(x)) throw new Error(`${label}: "${x.slice(0, 30)}" is not a valid code (letters, digits, dot or dash, up to 20 characters)`);
    return list;
  };
  const PICO_OUT = { ed: 'EMER', imp: 'IMP' }; // outcome -> encounter class (server-defined, never user text)
  const picoParse = (a, peco) => {
    const concept = a.concept === undefined ? 'diabetes' : String(a.concept); // undefined = default (smoke test); '' = the user picked nothing
    if (!Object.hasOwn(T.CONDITIONS, concept)) throw new Error('Pick a condition from the list');
    const cond = T.CONDITIONS[concept];
    const etype = peco ? (a.etype === undefined || a.etype === '' ? 'drug' : String(a.etype)) : 'drug';
    if (etype !== 'drug' && etype !== 'dx') throw new Error('Exposure type must be drug or diagnosis');
    const what = peco ? 'Exposure' : 'Intervention';
    const iv = picoCodes(a.iv === undefined ? (etype === 'drug' ? '861007' : T.CONDITIONS.hypertension.code) : a.iv, `${what} code(s)`);
    if (!iv.length) throw new Error(`Enter at least one ${peco ? 'exposure' : 'intervention RxNorm'} code`);
    const cmpList = picoCodes(a.cmp, 'Comparison code(s)'), cmp = cmpList.length ? cmpList : null;
    if (cmp && cmp.some(x => iv.includes(x))) throw new Error(`A code cannot be in both the ${what.toLowerCase()} and the comparison list`);
    if (etype === 'dx' && [...iv, ...(cmp || [])].includes(cond.code)) throw new Error('The exposure or comparison code cannot be the index condition itself');
    const days = Math.round(Math.min(Math.max(num(a.days, 365), 30), 1825));
    const outcome = a.outcome === undefined || a.outcome === '' ? (peco ? 'dx' : 'ed') : String(a.outcome);
    if (!(Object.hasOwn(PICO_OUT, outcome) || (peco && outcome === 'dx'))) throw new Error(peco ? 'Outcome must be ED visit, inpatient admission or new diagnosis' : 'Outcome must be ED visit or Inpatient admission');
    let ocode = null;
    if (outcome === 'dx') {
      ocode = picoCodes(a.ocode === undefined ? '709044004' : a.ocode, 'Outcome diagnosis code(s)');
      if (!ocode.length) throw new Error('Enter at least one outcome diagnosis code');
      if (ocode.includes(cond.code)) throw new Error('The outcome code cannot be the index condition itself');
    }
    return { peco: !!peco, concept, cond, etype, iv, cmp, days, outcome, cls: PICO_OUT[outcome] || null, ocode, word: peco ? 'exposure' : 'intervention' };
  };
  // Returns "<scope CTEs>, pu, el, fl, arms" (no SELECT). arms.arm: I, C, N (neither) or P (prior exposure, excluded).
  const picoArms = (pp, c, q) => {
    const dxP = q.add([pp.cond.code], 'text[]'), ivP = q.add(pp.iv, 'text[]'), cmpP = pp.cmp ? q.add(pp.cmp, 'text[]') : null;
    const tbl = pp.etype === 'dx' ? 'dx' : 'rx', dt = pp.etype === 'dx' ? 'x.onset_date' : 'x.prescribed_date::date';
    const has = (P, inWin) => `EXISTS (SELECT 1 FROM ${tbl} x WHERE x.patient_id = el.patient_id AND x.code = ANY(${P}) AND ${dt} ${inWin ? 'BETWEEN el.idx AND el.idx + 90' : '< el.idx'})`;
    return `${c.with},
    pu AS (SELECT patient_id, min(onset_date) AS idx FROM dx WHERE code = ANY(${dxP}) AND onset_date IS NOT NULL GROUP BY 1),
    el AS (SELECT patient_id, idx FROM pu WHERE idx + ${90 + pp.days} <= (SELECT d FROM ref)),
    fl AS (SELECT el.patient_id, el.idx, ${has(ivP, false)} AS prior, ${has(ivP, true)} AS iv_w, ${cmpP ? has(cmpP, true) : 'false'} AS cmp_w FROM el),
    arms AS (SELECT patient_id, idx, CASE WHEN prior THEN 'P' WHEN iv_w AND NOT cmp_w THEN 'I'
        WHEN ${pp.cmp ? 'cmp_w AND NOT iv_w' : 'NOT iv_w'} THEN 'C' ELSE 'N' END AS arm FROM fl)`;
  };
  // Adds "ev" (arms I and C with early = outcome by day 90, y = outcome in days 91 to 90 + days) and "o" (event-free at the landmark only).
  const picoOutcome = (pp, c, q) => {
    const W = pp.days;
    let early, late;
    if (pp.outcome === 'dx') {
      const oP = q.add(pp.ocode, 'text[]'), dxIn = cond => `EXISTS (SELECT 1 FROM dx x WHERE x.patient_id = a.patient_id AND x.code = ANY(${oP}) AND x.onset_date IS NOT NULL AND ${cond})`;
      early = dxIn('x.onset_date <= a.idx + 90');
      late = dxIn(`x.onset_date > a.idx + 90 AND x.onset_date <= a.idx + ${90 + W}`);
    } else {
      const clsP = q.add(pp.cls, 'text'), evIn = cond => `EXISTS (SELECT 1 FROM en WHERE en.patient_id = a.patient_id AND en.cls = ${clsP} AND ${cond})`;
      early = evIn('en.start_date::date >= a.idx AND en.start_date::date <= a.idx + 90');
      late = evIn(`en.start_date::date > a.idx + 90 AND en.start_date::date <= a.idx + ${90 + W}`);
    }
    return `${picoArms(pp, c, q)},
    ev AS (SELECT a.patient_id, a.arm, ${early} AS early, ${late} AS y FROM arms a WHERE a.arm IN ('I', 'C')),
    o AS (SELECT * FROM ev WHERE NOT early)`;
  };
  const picoAttrition = (pp, c, q) => `${picoOutcome(pp, c, q)}
    SELECT step, patients FROM (
      SELECT '1 Patients with the condition (dated diagnosis)' AS step, (SELECT count(*) FROM pu)::int AS patients
      UNION ALL SELECT '2 Excluded: less than 90 + ${pp.days} days of follow-up', ((SELECT count(*) FROM pu) - (SELECT count(*) FROM el))::int
      UNION ALL SELECT '3 Excluded: ${pp.etype === 'dx' ? 'exposure diagnosis recorded' : pp.peco ? 'exposure drug filled' : 'intervention drug filled'} before the index date', (SELECT count(*) FROM arms WHERE arm = 'P')::int
      UNION ALL SELECT '4 Eligible', (SELECT count(*) FROM arms WHERE arm <> 'P')::int
      UNION ALL SELECT '5 In arm I (${pp.word} started in days 0-90)', (SELECT count(*) FROM arms WHERE arm = 'I')::int
      UNION ALL SELECT '6 In arm C (comparison)', (SELECT count(*) FROM arms WHERE arm = 'C')::int
      UNION ALL SELECT '7 In neither arm', (SELECT count(*) FROM arms WHERE arm = 'N')::int
      UNION ALL SELECT '8 Excluded from arm I: already had the outcome ${pp.outcome === 'dx' ? 'diagnosis by day 90' : 'in days 0-90'}', (SELECT count(*) FROM ev WHERE arm = 'I' AND early)::int
      UNION ALL SELECT '9 Excluded from arm C: already had the outcome ${pp.outcome === 'dx' ? 'diagnosis by day 90' : 'in days 0-90'}', (SELECT count(*) FROM ev WHERE arm = 'C' AND early)::int
    ) t ORDER BY step`;
  const picoCounts = (pp, c, q) => `${picoOutcome(pp, c, q)}
    SELECT g.label AS arm, count(o.patient_id)::int AS n, count(o.patient_id) FILTER (WHERE o.y)::int AS events,
      ${pct('count(o.patient_id) FILTER (WHERE o.y)', 'count(o.patient_id)')} AS risk_pct
    FROM (VALUES ('I', 'I: ${pp.word}'), ('C', 'C: comparison')) g(arm, label) LEFT JOIN o ON o.arm = g.arm
    GROUP BY g.arm, g.label ORDER BY g.arm DESC`;
  // 2x2: a/b = arm I with/without the outcome, c/d = arm C with/without. Log-method 95% CIs (z = 1.96):
  //   RR = (a/(a+b)) / (c/(c+d)), SE = sqrt(1/a - 1/(a+b) + 1/c - 1/(c+d)); OR = ad/bc, SE = sqrt(1/a + 1/b + 1/c + 1/d).
  // A CI needs every cell it uses to be above zero; otherwise it is left empty and the note says so.
  const picoEffect = (pp, c, q) => `${picoOutcome(pp, c, q)},
    t AS (SELECT count(*) FILTER (WHERE arm = 'I' AND y)::numeric AS a, count(*) FILTER (WHERE arm = 'I' AND NOT y)::numeric AS b,
                 count(*) FILTER (WHERE arm = 'C' AND y)::numeric AS c, count(*) FILTER (WHERE arm = 'C' AND NOT y)::numeric AS d FROM o),
    e AS (SELECT a, b, c, d,
        CASE WHEN a > 0 AND c > 0 THEN ln((a / (a + b)) / (c / (c + d))) END AS lnrr,
        CASE WHEN a > 0 AND c > 0 THEN sqrt(1 / a - 1 / (a + b) + 1 / c - 1 / (c + d)) END AS serr,
        CASE WHEN a > 0 AND b > 0 AND c > 0 AND d > 0 THEN ln((a * d) / (b * c)) END AS lnor,
        CASE WHEN a > 0 AND b > 0 AND c > 0 AND d > 0 THEN sqrt(1 / a + 1 / b + 1 / c + 1 / d) END AS seor FROM t)
    SELECT a::int AS exposed_events, (a + b)::int AS exposed_n, c::int AS comparison_events, (c + d)::int AS comparison_n,
      round(100 * a / NULLIF(a + b, 0), 1)::float8 AS risk_exposed_pct, round(100 * c / NULLIF(c + d, 0), 1)::float8 AS risk_comparison_pct,
      round(100 * (a / NULLIF(a + b, 0) - c / NULLIF(c + d, 0)), 1)::float8 AS abs_risk_diff_pct,
      round((a / NULLIF(a + b, 0)) / NULLIF(c / NULLIF(c + d, 0), 0), 2)::float8 AS risk_ratio,
      round(exp(lnrr - 1.96 * serr), 2)::float8 AS rr_ci_low, round(exp(lnrr + 1.96 * serr), 2)::float8 AS rr_ci_high,
      round((a * d) / NULLIF(b * c, 0), 2)::float8 AS odds_ratio,
      round(exp(lnor - 1.96 * seor), 2)::float8 AS or_ci_low, round(exp(lnor + 1.96 * seor), 2)::float8 AS or_ci_high,
      round(1 / NULLIF(abs(a / NULLIF(a + b, 0) - c / NULLIF(c + d, 0)), 0), 0)::float8 AS nnt_or_nnh,
      concat_ws('; ',
        CASE WHEN a + b = 0 OR c + d = 0 THEN 'an arm is empty - no estimate' END,
        CASE WHEN (a + b > 0 AND c + d > 0) AND (a = 0 OR c = 0) THEN 'no events in an arm - confidence interval not shown' END,
        CASE WHEN a > 0 AND c > 0 AND (b = 0 OR d = 0) THEN 'everyone in an arm had the event - odds ratio interval not shown' END,
        CASE WHEN a + b < 20 OR c + d < 20 THEN 'small arm - interval is wide and unstable' END,
        CASE WHEN a / NULLIF(a + b, 0) < c / NULLIF(c + d, 0) THEN 'nnt_or_nnh is an NNT (fewer events in arm I)'
             WHEN a / NULLIF(a + b, 0) > c / NULLIF(c + d, 0) THEN 'nnt_or_nnh is an NNH (more events in arm I)' END,
        'unadjusted, observational; confounding by indication is likely') AS note
    FROM e`;

  const OUT_LABEL = { ed: 'ED visit', imp: 'inpatient admission', dx: 'new diagnosis' };
  const picoSections = (pp, c) => [
    S('attrition', `Attrition: ${pp.cond.display}, ${pp.word} ${pp.iv.join(', ')} vs ${pp.cmp ? pp.cmp.join(', ') : `not on the ${pp.word}`}`, q => picoAttrition(pp, c, q)),
    S('counts', `Outcome counts: ${OUT_LABEL[pp.outcome]} in days 91-${90 + pp.days}`, q => picoCounts(pp, c, q)),
    S('effect', `Effect estimate (${pp.word} vs comparison, unadjusted)`, q => picoEffect(pp, c, q))
  ];
  const CONDITION_PARAM = { name: 'concept', label: 'Condition', type: 'select', default: 'diabetes', modes: ['v4'], options: () => Object.entries(T.CONDITIONS).map(([k, v]) => ({ value: k, label: v.display })) };
  const DAYS_PARAM = { name: 'days', label: 'Follow-up days after day 90 (30-1825)', type: 'number', default: 365, modes: ['v4'] };

  def({
    id: 'pico_study', category: 'Evidence (PICO/PECO)', title: 'PICO study: intervention vs comparison',
    description: 'V4 only. In patients with the chosen condition (index = first dated diagnosis), compares people who started the intervention drug within 90 days of the index date (new users only) with a comparison group, using a landmark design: exposure is fixed in days 0-90 and outcomes are counted from day 91 (patients who already had the outcome by day 90 are removed). Returns the attrition table, outcome counts per arm, and the risk ratio and odds ratio with 95% intervals, absolute risk difference and NNT/NNH. Observational and unadjusted, so for hypotheses only.',
    params: [
      CONDITION_PARAM,
      { name: 'iv', label: 'Intervention RxNorm code(s), comma separated', type: 'text', default: '861007', modes: ['v4'] },
      { name: 'cmp', label: 'Comparison code(s) (blank = not on the intervention)', type: 'text', modes: ['v4'] },
      { name: 'outcome', label: 'Outcome', type: 'select', default: 'ed', modes: ['v4'], options: [{ value: 'ed', label: 'ED visit' }, { value: 'imp', label: 'Inpatient admission' }] },
      DAYS_PARAM
    ],
    v4: (a, c) => picoSections(picoParse(a, false), c)
  });

  // ---- Step 4.2: PECO variant. Same engine; the exposure can be a drug or a diagnosis, and the outcome can be a new diagnosis. ----
  def({
    id: 'peco_study', category: 'Evidence (PICO/PECO)', title: 'PECO study: exposure vs comparison',
    description: 'V4 only. Same landmark design as the PICO study, but the exposure can be a drug (RxNorm) or another diagnosis (SNOMED CT) recorded within 90 days of the index diagnosis (new exposure only), and the outcome can also be a new diagnosis code first recorded in days 91 onward (anyone with that diagnosis by day 90 is removed). Returns attrition, outcome counts and unadjusted risk and odds ratios. Observational; confounding is likely, so for hypotheses only.',
    params: [
      CONDITION_PARAM,
      { name: 'etype', label: 'Exposure type', type: 'select', default: 'drug', modes: ['v4'], options: [{ value: 'drug', label: 'Drug (RxNorm code)' }, { value: 'dx', label: 'Diagnosis (SNOMED CT code)' }] },
      { name: 'iv', label: 'Exposure code(s), comma separated', type: 'text', default: '861007', modes: ['v4'] },
      { name: 'cmp', label: 'Comparison code(s) (blank = not exposed)', type: 'text', modes: ['v4'] },
      { name: 'outcome', label: 'Outcome', type: 'select', default: 'dx', modes: ['v4'], options: [{ value: 'dx', label: 'New diagnosis' }, { value: 'ed', label: 'ED visit' }, { value: 'imp', label: 'Inpatient admission' }] },
      { name: 'ocode', label: 'Outcome diagnosis code(s) (when outcome = new diagnosis)', type: 'text', default: '709044004', modes: ['v4'] },
      DAYS_PARAM
    ],
    v4: (a, c) => picoSections(picoParse(a, true), c)
  });
  // ---- Step 5.2a: Pathway frequencies (V4). Chain per patient: step 1 -> step 2 -> step 3 (escalation / outcome). ----
  // Only the fixed kind strings below go into SQL; the pathway key is checked with Object.hasOwn; window is a clamped number.
  const PATHWAYS = {
    drug_dx_esc: { label: 'Drug -> diagnosis -> escalation',  kinds: ['rx', 'dx'] },
    drug_pr_out: { label: 'Drug -> procedure -> outcome',     kinds: ['rx', 'pr'] },
    dx_pr_out:   { label: 'Diagnosis -> procedure -> outcome', kinds: ['dx', 'pr'] }
  };
  const clampInt = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Math.round(num(v, d))));
  const pathParse = (a) => {
    const key = a.pathway === undefined || a.pathway === null || a.pathway === '' ? 'drug_dx_esc' : String(a.pathway);
    if (!Object.hasOwn(PATHWAYS, key)) throw new Error('Pick one of the listed pathways');
    return { key, kinds: PATHWAYS[key].kinds, window: clampInt(a.window, 365, 7, 1825), minN: clampInt(a.minN, 10, 1, 1000) };
  };
  // Returns the CTE list (no leading comma): ev, s1, s2, chain. chain columns: patient_id, c1, d1, c2, d2, k3, d3.
  // Step 2 = first event of kind 2 strictly after d1 within window days; step 3 = first ED/inpatient strictly after d2 within window days.
  const pathChainCtes = (pp, q) => `${eventStreamCte(q)},
    s1 AS (SELECT patient_id, code AS c1, min(d) AS d1 FROM ev WHERE kind = '${pp.kinds[0]}' GROUP BY patient_id, code),
    s2 AS (SELECT s1.patient_id, s1.c1, s1.d1, x.code AS c2, x.d AS d2 FROM s1
           LEFT JOIN LATERAL (SELECT e.code, e.d FROM ev e WHERE e.patient_id = s1.patient_id AND e.kind = '${pp.kinds[1]}'
                              AND e.d > s1.d1 AND e.d <= s1.d1 + ${pp.window} ORDER BY e.d, e.code LIMIT 1) x ON true),
    chain AS (SELECT s2.*, y.kind AS k3, y.d AS d3 FROM s2
              LEFT JOIN LATERAL (SELECT e.kind, e.d FROM ev e WHERE s2.d2 IS NOT NULL AND e.patient_id = s2.patient_id AND e.kind IN ('ed', 'imp')
                                 AND e.d > s2.d2 AND e.d <= s2.d2 + ${pp.window} ORDER BY e.d LIMIT 1) y ON true)`;

  // Step 5.2b: code -> label lists per kind (dictionaries are server-side; labels and codes go through q.add()).
  const KIND_DICT = { rx: T.MEDICATIONS, dx: T.CONDITIONS, pr: T.PROCEDURES };
  const kindLabels = (kind, q) => `(VALUES ${Object.values(KIND_DICT[kind]).map(d => `(${q.add(d.code, 'text')}, ${q.add(d.display, 'text')})`).join(', ')})`;
  const patternsSql = (c, pp, q) => `${c.with}, ${pathChainCtes(pp, q)},
    pat AS (SELECT c1, c2, (d3 IS NOT NULL) AS reached, count(*)::int AS n FROM chain GROUP BY c1, c2, (d3 IS NOT NULL)),
    tot AS (SELECT count(*)::numeric AS t FROM chain),
    l1(code, label) AS ${kindLabels(pp.kinds[0], q)},
    l2(code, label) AS ${kindLabels(pp.kinds[1], q)},
    lab AS (SELECT COALESCE(l1.label, p.c1) AS step1, CASE WHEN p.c2 IS NULL THEN '(none within window)' ELSE COALESCE(l2.label, p.c2) END AS step2,
                   CASE WHEN p.reached THEN 'yes' ELSE 'no' END AS reached_step3, p.n
            FROM pat p LEFT JOIN l1 ON l1.code = p.c1 LEFT JOIN l2 ON l2.code = p.c2),
    big AS (SELECT * FROM lab WHERE n >= ${pp.minN} ORDER BY n DESC, step1, step2, reached_step3 LIMIT 40),
    oth AS (SELECT 'Other patterns (under ${pp.minN} patients each)'::text AS step1, ''::text AS step2, ''::text AS reached_step3, sum(n)::int AS n FROM lab WHERE n < ${pp.minN} HAVING count(*) > 0)
    SELECT step1, step2, reached_step3, n AS patients, ${pct('n', '(SELECT t FROM tot)')} AS pct_of_step1_chains
    FROM (SELECT *, 0 AS o FROM big UNION ALL SELECT *, 1 AS o FROM oth) u ORDER BY o, patients DESC, step1, step2`;

  // Step 5.2c: day-lags per hop. Lags are date differences (d2 - d1, d3 - d2), at least 1 because of the "strictly after" rule.
  const KIND_NAME = { rx: 'Drug', dx: 'Diagnosis', pr: 'Procedure' };
  const lagsSql = (c, pp, q) => {
    const one = (o, label, from, to, where) => `SELECT ${o} AS o, ${q.add(label, 'text')}::text AS hop, count(*)::int AS attempted, count(${to})::int AS pairs,
        round(avg(${to} - ${from})::numeric, 1)::float8 AS mean_days,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY (${to} - ${from})))::numeric, 1)::float8 AS median_days,
        round((percentile_cont(0.25) WITHIN GROUP (ORDER BY (${to} - ${from})))::numeric, 1)::float8 AS p25_days,
        round((percentile_cont(0.75) WITHIN GROUP (ORDER BY (${to} - ${from})))::numeric, 1)::float8 AS p75_days,
        min(${to} - ${from})::int AS min_days, max(${to} - ${from})::int AS max_days
      FROM chain ${where}`;
    return `${c.with}, ${pathChainCtes(pp, q)}
      SELECT hop, attempted, pairs, ${pct('pairs', 'attempted')} AS pct_of_attempted_hops, mean_days, median_days, p25_days, p75_days, min_days, max_days
      FROM (${one(1, `Step 1 -> 2: ${KIND_NAME[pp.kinds[0]]} -> ${KIND_NAME[pp.kinds[1]].toLowerCase()}`, 'd1', 'd2', '')}
            UNION ALL ${one(2, `Step 2 -> 3: ${KIND_NAME[pp.kinds[1]]} -> ED visit or admission`, 'd2', 'd3', 'WHERE d2 IS NOT NULL')}) u ORDER BY o`;
  };

  def({
    id: 'pathway_frequencies', category: 'Pathways', title: 'Pathway frequencies (event sequences with day-lags)',
    description: 'V4 only. Follows each patient through three steps: drug -> diagnosis -> escalation, drug -> procedure -> outcome, or diagnosis -> procedure -> outcome. Step 1 is the first date of a code. Step 2 is the first event of the next kind strictly after it (same-day events do not count) within the chosen number of days. Step 3 is the first ED visit or inpatient admission strictly after step 2 within the same window; escalation and outcome use this one definition. Partial chains are kept and counted. Counts are chains (one per patient and first code), so a patient can appear under several codes. First occurrence only (a restarted drug is not counted again) and ordering is by date, not causation. Patterns under the minimum are grouped as Other. Lags are whole days. Aggregates only, no patient ids. Synthetic data links drugs, diagnoses and visits by design, so pathways partly restate the generator\'s assumptions.',
    params: [
      { name: 'pathway', label: 'Pathway', type: 'select', default: 'drug_dx_esc', modes: ['v4'], options: Object.entries(PATHWAYS).map(([value, p]) => ({ value, label: p.label })) },
      { name: 'window', label: 'Max days between steps (7-1825)', type: 'number', default: 365, modes: ['v4'] },
      { name: 'minN', label: 'Minimum patients per pattern (1-1000)', type: 'number', default: 10, modes: ['v4'] }
    ],
    v4: (a, c) => {
      const pp = pathParse(a);
      return [
        S('scope', `Chains found: ${PATHWAYS[pp.key].label} (within ${pp.window} days)`, q => `${c.with}, ${pathChainCtes(pp, q)}
          SELECT count(DISTINCT patient_id)::int AS patients, count(*)::int AS with_step1,
            count(*) FILTER (WHERE d2 IS NOT NULL)::int AS with_step2, count(*) FILTER (WHERE d3 IS NOT NULL)::int AS with_step3,
            ${pct('count(*) FILTER (WHERE d3 IS NOT NULL)', 'count(*)')} AS complete_chain_pct
          FROM chain`),
        S('patterns', `Most common patterns (top 40; patterns under ${pp.minN} patients are grouped)`, q => patternsSql(c, pp, q)),
        S('lags', 'Days between steps (per hop)', q => lagsSql(c, pp, q))
      ];
    }
  });
  // ---- Step 5.3: Checkpoint timing bands (V4). Days from first diagnosis to first ED visit or admission. ----
  // Escalation = first ED/inpatient event strictly after the index date (same rule as Step 5.2). Only server-defined strings go into SQL.
  const checkpointSql = (c, a, q) => {
    if (!Object.hasOwn(T.CONDITIONS, a.concept)) throw new Error('Pick a condition from the list');
    const W = clampInt(a.window, 90, 7, 1825), dxP = q.add(T.CONDITIONS[a.concept].code, 'text');
    const base = `${c.with}, ${eventStreamCte(q)},
      idx AS (SELECT patient_id, min(d) AS idx FROM ev WHERE kind = 'dx' AND code = ${dxP} GROUP BY patient_id),
      esc AS (SELECT e.patient_id, min(e.d) AS d FROM ev e JOIN idx i ON i.patient_id = e.patient_id
              WHERE e.kind IN ('ed', 'imp') AND e.d > i.idx AND e.d <= i.idx + ${W} GROUP BY e.patient_id),
      t AS (SELECT i.patient_id, (x.d - i.idx) AS lag FROM idx i LEFT JOIN esc x ON x.patient_id = i.patient_id WHERE i.idx + ${W} <= (SELECT d FROM ref))`;
    return { base, W };
  };

  def({
    id: 'checkpoint_timing', category: 'Pathways', title: 'Checkpoint timing (days from diagnosis to first escalation)',
    description: 'V4 only. For patients with the chosen condition (index = first dated diagnosis), counts how soon the first ED visit or inpatient admission follows: early (1-3 days), mid (4-9 days), late (10 days or more, up to the window) or never within the window. Same-day events do not count. Only patients with a full window of follow-up before the as-of date are included (the rest are counted as excluded, because a short follow-up would inflate "never"). Counts only, no patient ids.',
    params: [
      CONDITION_PARAM,
      { name: 'window', label: 'Days to look for escalation (7-1825)', type: 'number', default: 90, modes: ['v4'] }
    ],
    v4: (a, c) => [
      S('scope', 'Patients and follow-up', q => `${checkpointSql(c, a, q).base}
        SELECT (SELECT count(*) FROM idx)::int AS patients_with_condition,
          ((SELECT count(*) FROM idx) - count(*))::int AS excluded_short_followup, count(*)::int AS eligible,
          count(lag)::int AS escalated, ${pct('count(lag)', 'count(*)')} AS escalated_pct,
          round((percentile_cont(0.5) WITHIN GROUP (ORDER BY lag))::numeric, 1)::float8 AS median_days_to_escalation
        FROM t`),
      S('bands', 'Timing bands', q => `${checkpointSql(c, a, q).base},
        b(o, band) AS (VALUES (1, 'Early (1-3 days)'), (2, 'Mid (4-9 days)'), (3, 'Late (10+ days)'), (4, 'Never within window')),
        k AS (SELECT patient_id, CASE WHEN lag IS NULL THEN 4 WHEN lag <= 3 THEN 1 WHEN lag <= 9 THEN 2 ELSE 3 END AS o FROM t)
        SELECT b.band, count(k.patient_id)::int AS patients, ${pct('count(k.patient_id)', '(SELECT count(*) FROM t)')} AS pct_of_eligible
        FROM b LEFT JOIN k ON k.o = b.o GROUP BY b.o, b.band ORDER BY b.o`)
    ]
  });
  // ---- Step 5.4a: Kaplan-Meier (V4). Frame per patient: km(patient_id, t, ev). Death only for now (readmission comes in 5.4b). ----
  // Only fixed strings and clamped numbers go into SQL; the condition key is checked with Object.hasOwn.
  const KM_EVENTS = ['death', 'readmission'];
  const kmParse = (a) => {
    if (!Object.hasOwn(T.CONDITIONS, a.concept)) throw new Error('Pick a condition from the list');
    const event = a.event === undefined || a.event === null || a.event === '' ? 'death' : String(a.event);
    if (!KM_EVENTS.includes(event)) throw new Error('Event must be death or readmission');
    const b = Math.round(num(a.bucket, 7));
    return { concept: a.concept, event, maxDays: clampInt(a.maxDays, 365, 30, 1825), bucket: [1, 7, 30].includes(b) ? b : 7 };
  };
  // Returns the CTE list (no WITH, no leading comma). km(patient_id, t, ev) is the frame every KM section reads.
  //   death:       origin = first dated diagnosis (not after the as-of date); event = death date on or after the origin and inside the limit.
  //   readmission: origin = first inpatient discharge (IMP with an end date) on or after the first diagnosis; event = first IMP start strictly
  //                after that discharge date, inside the limit and not after a death; a death before readmission censors the patient.
  //   limit = min(origin + maxDays, as-of date); anyone without the event is censored at the limit (or at death for readmission).
  //   Patients who died before their origin are left out.
  const kmCtes = (kp, q) => {
    const first = `idx AS (SELECT patient_id, min(onset_date) AS o FROM dx WHERE code = ${q.add(T.CONDITIONS[kp.concept].code, 'text')} AND onset_date IS NOT NULL GROUP BY patient_id),
      dd AS (SELECT patient_id, CASE WHEN pj->>'deceasedDateTime' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])' THEN left(pj->>'deceasedDateTime', 10)::date END AS dd FROM p)`;
    const lim = (src) => `lim AS (SELECT i.patient_id, i.o, d.dd, LEAST(i.o + ${kp.maxDays}, (SELECT d FROM ref)) AS lim FROM ${src} i JOIN dd d ON d.patient_id = i.patient_id
              WHERE i.o <= (SELECT d FROM ref) AND (d.dd IS NULL OR d.dd >= i.o))`;
    if (kp.event === 'readmission') return `${first},
      dis AS (SELECT i.patient_id, min(e.end_date::date) AS o FROM idx i JOIN en e ON e.patient_id = i.patient_id
              WHERE e.cls = 'IMP' AND e.end_date IS NOT NULL AND e.end_date::date >= i.o GROUP BY i.patient_id),
      ${lim('dis')},
      ra AS (SELECT l.patient_id, min(e.start_date::date) AS r FROM lim l JOIN en e ON e.patient_id = l.patient_id
             WHERE e.cls = 'IMP' AND e.start_date IS NOT NULL AND e.start_date::date > l.o GROUP BY l.patient_id),
      km AS (SELECT l.patient_id, CASE WHEN a.r IS NOT NULL AND a.r <= l.lim AND (l.dd IS NULL OR a.r <= l.dd) THEN 1 ELSE 0 END AS ev,
                    (CASE WHEN a.r IS NOT NULL AND a.r <= l.lim AND (l.dd IS NULL OR a.r <= l.dd) THEN a.r ELSE LEAST(l.lim, COALESCE(l.dd, l.lim)) END) - l.o AS t
             FROM lim l LEFT JOIN ra a ON a.patient_id = l.patient_id)`;
    return `${first},
      ${lim('idx')},
      km AS (SELECT patient_id, CASE WHEN dd IS NOT NULL AND dd <= lim THEN 1 ELSE 0 END AS ev,
                    (CASE WHEN dd IS NOT NULL AND dd <= lim THEN dd ELSE lim END) - o AS t FROM lim)`;
  };

  // Step 5.4c/5.4d: life table. Row = one bucket of days; at_risk = patients still under observation at the start of the bucket;
  // events are counted before censoring inside a bucket (usual tie rule); survival = running product of (1 - events/at_risk).
  // A bucket where everyone at risk has the event gives survival 0 (no ln(0)); the table stops where nobody is at risk.
  // gws = running sum of events / (at_risk * (at_risk - events)) for the Greenwood interval.
  // kmLifeCtes returns CTEs g, kb, r, a, f, s (after kmCtes); the summary and check sections call it with bucket 1 (exact days).
  const kmLifeCtes = (kp, q, b) => `${kmCtes(kp, q)},
      g AS (SELECT s AS day_from FROM generate_series(0, ${kp.maxDays}, ${b}) s),
      kb AS (SELECT (t / ${b}) * ${b} AS day_from, count(*) FILTER (WHERE ev = 1)::int AS events, count(*) FILTER (WHERE ev = 0)::int AS censored FROM km GROUP BY 1),
      r AS (SELECT g.day_from, COALESCE(kb.events, 0) AS events, COALESCE(kb.censored, 0) AS censored FROM g LEFT JOIN kb ON kb.day_from = g.day_from),
      a AS (SELECT r.*, ((SELECT count(*) FROM km) - COALESCE(sum(events + censored) OVER (ORDER BY day_from ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0))::int AS at_risk FROM r),
      f AS (SELECT a.*, CASE WHEN at_risk > 0 AND events < at_risk THEN ln(1 - events::float8 / at_risk) ELSE 0 END AS lf,
                   CASE WHEN at_risk > 0 AND events >= at_risk THEN 1 ELSE 0 END AS z,
                   CASE WHEN at_risk > events THEN events::float8 / (at_risk::float8 * (at_risk - events)) ELSE 0 END AS gwt FROM a),
      s AS (SELECT f.*, CASE WHEN max(z) OVER w = 1 THEN 0 ELSE exp(sum(lf) OVER w) END AS surv, sum(gwt) OVER w AS gws FROM f WINDOW w AS (ORDER BY day_from))`;
  const kmCurveSql = (c, kp, q) => `${c.with}, ${kmLifeCtes(kp, q, kp.bucket)}
      SELECT day_from, LEAST(day_from + ${kp.bucket} - 1, ${kp.maxDays})::int AS day_to, at_risk, events, censored,
        round(surv::numeric, 4)::float8 AS survival, round((100 * surv)::numeric, 1)::float8 AS survival_pct,
        round(GREATEST(0, surv - 1.96 * surv * sqrt(gws))::numeric, 4)::float8 AS ci_low, round(LEAST(1, surv + 1.96 * surv * sqrt(gws))::numeric, 4)::float8 AS ci_high
      FROM s WHERE at_risk > 0 ORDER BY day_from`;
  // Median, survival at 30/90/365 days (exact days, from a 1-day table). A checkpoint is empty when it lies beyond the horizon
  // or beyond the last day anyone was still under observation (unless survival had already reached 0).
  const kmSummarySql = (c, kp, q) => {
    const at = D => D <= kp.maxDays ? `(SELECT round((100 * surv)::numeric, 1)::float8 FROM L WHERE day_from <= ${D} AND (${D} <= (SELECT m FROM mx) OR surv = 0) ORDER BY day_from DESC LIMIT 1)` : 'NULL::float8';
    return `${c.with}, ${kmLifeCtes(kp, q, 1)},
      L AS (SELECT * FROM s WHERE at_risk > 0), mx AS (SELECT max(day_from) AS m FROM L)
      SELECT (SELECT min(day_from) FROM L WHERE surv <= 0.5)::int AS median_survival_days,
        ${at(30)} AS survival_pct_30d, ${at(90)} AS survival_pct_90d, ${at(365)} AS survival_pct_365d`;
  };
  // Identity check: with nobody censored before the horizon, KM survival must equal 1 - (events so far / patients).
  const kmCheckSql = (c, kp, q) => `${c.with}, ${kmLifeCtes(kp, q, 1)},
      n AS (SELECT count(*)::numeric AS n, count(*) FILTER (WHERE ev = 0 AND t < ${kp.maxDays})::int AS early FROM km),
      cmp AS (SELECT abs(surv - (1 - (sum(events) OVER (ORDER BY day_from))::float8 / NULLIF((SELECT n FROM n), 0))) AS d FROM s WHERE at_risk > 0)
      SELECT (SELECT early FROM n) AS censored_before_horizon,
        CASE WHEN (SELECT early FROM n) = 0 THEN (SELECT count(*) FROM cmp)::int END AS rows_compared,
        CASE WHEN (SELECT early FROM n) = 0 THEN (SELECT round(max(d)::numeric, 9)::float8 FROM cmp) END AS max_abs_difference,
        CASE WHEN (SELECT early FROM n) = 0 THEN 'Nobody censored before the horizon: KM should equal 1 minus the cumulative share with the event (difference 0).'
             ELSE 'Censoring before the horizon is present, so the identity does not apply.' END AS note`;

  def({
    id: 'kaplan_meier', category: 'Survival', title: 'Kaplan-Meier survival (time to event)',
    description: 'V4 only. Time to death (from the first dated diagnosis of the chosen condition; uses the death date on the Patient record, Step 3.1, so on data without death dates every patient is censored) or to first inpatient readmission (from the first inpatient discharge on or after that diagnosis; the next admission starting after the discharge date; a death before readmission censors the patient). Patients are censored at the as-of date or after the chosen number of days, whichever comes first; patients who died before their first diagnosis are left out. Unadjusted, one origin per patient. Counts only, no patient ids. In synthetic data deaths follow the generator\'s assumptions, not real mortality.',
    params: [
      CONDITION_PARAM,
      { name: 'event', label: 'Event', type: 'select', default: 'death', modes: ['v4'], options: [{ value: 'death', label: 'Death' }, { value: 'readmission', label: 'First readmission after discharge' }] },
      { name: 'maxDays', label: 'Follow-up horizon, days (30-1825)', type: 'number', default: 365, modes: ['v4'] },
      { name: 'bucket', label: 'Days per table row', type: 'select', default: '7', modes: ['v4'], options: [{ value: '1', label: '1 day' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' }] }
    ],
    v4: (a, c) => {
      const kp = kmParse(a);
      return [
        S('scope', 'Patients, events and censoring', q => `${c.with}, ${kmCtes(kp, q)}
          SELECT (SELECT count(*) FROM idx)::int AS patients_with_condition, count(*)::int AS in_analysis,
            count(*) FILTER (WHERE ev = 1)::int AS events, count(*) FILTER (WHERE ev = 0)::int AS censored,
            round((percentile_cont(0.5) WITHIN GROUP (ORDER BY t))::numeric, 1)::float8 AS median_followup_days
          FROM km`),
        S('curve', `Life table (${kp.bucket}-day rows, up to ${kp.maxDays} days)`, q => kmCurveSql(c, kp, q)),
        S('summary', 'Median survival and survival at 30, 90 and 365 days', q => kmSummarySql(c, kp, q)),
        S('check', 'Check: no censoring means KM = 1 - cumulative proportion', q => kmCheckSql(c, kp, q))
      ];
    }
  });
  // ---- Step 5.5: Medication sequence (V4). First-line -> next-line drug order from T.TREATMENT_MAP. ----
  // For every condition in the map, every pair of its drugs (earlier line, later line): among patients with the condition code who had the
  // earlier-line drug, how many started the later-line drug strictly after it, and the gap in days between the two first fills.
  // Only the dictionary (server-side) feeds the VALUES list, through q.add(); the condition param is checked with Object.hasOwn.
  const seqPairs = (only, map = T.TREATMENT_MAP) => { // Step D.8d: map = reviewed first-line map from the run context
    const out = []; let o = 0;
    for (const [key, drugs] of Object.entries(map)) {
      if (only && key !== only) continue;
      if (!Object.hasOwn(T.CONDITIONS, key)) continue;
      for (let i = 0; i < drugs.length; i++) for (let j = i + 1; j < drugs.length; j++) {
        if (!Object.hasOwn(T.MEDICATIONS, drugs[i]) || !Object.hasOwn(T.MEDICATIONS, drugs[j])) continue;
        out.push({ o: ++o, cond: T.CONDITIONS[key], a: T.MEDICATIONS[drugs[i]], b: T.MEDICATIONS[drugs[j]] });
      }
    }
    return out;
  };
  const sequenceSql = (c, a, q) => {
    const only = a.concept === undefined || a.concept === null || a.concept === '' || a.concept === 'all' ? null : String(a.concept);
    const fl = (c && c.firstLine) || T.TREATMENT_MAP;
    if (only && !Object.hasOwn(fl, only)) throw new Error('Pick a condition from the list');
    const pairs = seqPairs(only, fl);
    if (!pairs.length) throw new Error('That condition has no pair of drugs in the treatment map');
    return `${c.with},
      pairs(o, cond, a, b, cond_label, a_label, b_label) AS (VALUES ${pairs.map(x => `(${x.o}, ${q.add(x.cond.code, 'text')}, ${q.add(x.a.code, 'text')}, ${q.add(x.b.code, 'text')}, ${q.add(x.cond.display, 'text')}, ${q.add(x.a.display, 'text')}, ${q.add(x.b.display, 'text')})`).join(', ')}),
      fa AS (SELECT patient_id, code, min(prescribed_date::date) AS d FROM rx WHERE prescribed_date IS NOT NULL AND code IS NOT NULL GROUP BY patient_id, code),
      cd AS (SELECT DISTINCT patient_id, code FROM dx),
      j AS (SELECT pr.*, c2.patient_id, x.d AS da, y.d AS db FROM pairs pr JOIN cd c2 ON c2.code = pr.cond
            LEFT JOIN fa x ON x.patient_id = c2.patient_id AND x.code = pr.a LEFT JOIN fa y ON y.patient_id = c2.patient_id AND y.code = pr.b)
      SELECT cond_label AS condition, a_label AS earlier_line_drug, b_label AS later_line_drug, count(*)::int AS patients_with_condition,
        count(da)::int AS on_earlier_line, count(db)::int AS on_later_line,
        count(*) FILTER (WHERE da IS NOT NULL AND db > da)::int AS later_started_after,
        count(*) FILTER (WHERE da IS NOT NULL AND db = da)::int AS started_same_day,
        count(*) FILTER (WHERE da IS NOT NULL AND db < da)::int AS later_started_first,
        ${pct('count(*) FILTER (WHERE da IS NOT NULL AND db > da)', 'count(da)')} AS pct_of_earlier_line_moving_on,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY (db - da)) FILTER (WHERE db > da))::numeric, 1)::float8 AS median_gap_days,
        round((percentile_cont(0.25) WITHIN GROUP (ORDER BY (db - da)) FILTER (WHERE db > da))::numeric, 1)::float8 AS p25_gap_days,
        round((percentile_cont(0.75) WITHIN GROUP (ORDER BY (db - da)) FILTER (WHERE db > da))::numeric, 1)::float8 AS p75_gap_days
      FROM j GROUP BY o, cond_label, a_label, b_label ORDER BY o`;
  };

  def({
    id: 'medication_sequence', category: 'Pathways', title: 'Medication sequence (earlier-line to later-line drug)',
    description: 'V4 only. Uses the order of drugs in the treatment map (first-line first). For each condition and each pair of its drugs, among patients with the condition who had the earlier-line drug, shows how many started the later-line drug strictly after it, how many on the same day and how many had the later-line drug first, with the median gap in days between the two first fills. First fill per drug only; the table cannot tell a switch from an add-on. Counts only, no patient ids. In synthetic data prescribing follows the generator\'s rules.',
    params: [
      { name: 'concept', label: 'Condition', type: 'select', default: 'all', modes: ['v4'], options: () => [{ value: 'all', label: 'All conditions in the treatment map' }].concat(Object.keys(T.TREATMENT_MAP).filter(k => seqPairs(k).length).map(k => ({ value: k, label: T.CONDITIONS[k].display }))) }
    ],
    v4: (a, c) => [S('sequence', 'Earlier-line to later-line drug', q => sequenceSql(c, a, q))]
  });

  // ---- Step T.2: Inpatient trajectory, episode frame and scope check (V4) ---------------------
  // One episode = one inpatient discharge (cls IMP with an end date), the same frame as Readmission drivers (1.7).
  // `eid` is the Encounter resource id; the detail below exists only in batches generated with "Inpatient detail" (T.1).
  // Later steps (T.3-T.8) add the stages, nodes, ribbons and trace to this def() on top of `trajEp`.
  // Step T.8: node_stage '' = no trace. node is free text (never put into the SQL string; it goes through q.add).
  const trajParse = a => {
    const tp = { longStay: clampInt(a.longStay, 7, 3, 60), traceStage: null, node: '', dir: 'forward' };
    const ns = a.node_stage == null ? '' : String(a.node_stage).trim();
    const dir = a.direction == null || String(a.direction).trim() === '' ? 'forward' : String(a.direction).trim();
    if (dir !== 'forward' && dir !== 'backward') throw new Error('Direction must be forward or backward');
    tp.dir = dir;
    if (ns === '') return tp;
    if (!/^[1-9]$/.test(ns)) throw new Error('Trace stage must be a number from 1 to 9 (or blank for no trace)');
    const node = String(a.node == null ? '' : a.node).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (!node) throw new Error('Type the node value to trace (for example "ICU transfer")');
    if (node.length > 100) throw new Error('The node value is too long (100 characters at most)');
    tp.traceStage = Number(ns); tp.node = node;
    return tp;
  };
  const trajEp = c => `${c.with},
    ep AS (SELECT e.patient_id, e.j->>'id' AS eid, e.j AS j, e.start_date AS admit, e.end_date AS disch
      FROM en e WHERE e.cls = 'IMP' AND e.end_date IS NOT NULL)`;
  const trajScope = c => `${trajEp(c)}
    SELECT count(*)::int AS episodes, count(DISTINCT patient_id)::int AS patients,
      count(*) FILTER (WHERE NULLIF(j->'hospitalization'->'admitSource'->'coding'->0->>'code', '') IS NOT NULL)::int AS with_admit_source,
      count(*) FILTER (WHERE NULLIF(j->'reasonCode'->0->'coding'->0->>'code', '') IS NOT NULL)::int AS with_principal_dx,
      count(*) FILTER (WHERE NULLIF(j->'hospitalization'->'dischargeDisposition'->'coding'->0->>'code', '') IS NOT NULL)::int AS with_disposition,
      count(*) FILTER (WHERE eid IS NOT NULL AND EXISTS (SELECT 1 FROM en k WHERE k.cls = 'ACUTE' AND k.patient_id = ep.patient_id
          AND k.j->'partOf'->>'reference' = 'Encounter/' || ep.eid))::int AS with_escalation_stay,
      count(*) FILTER (WHERE eid IS NOT NULL AND (EXISTS (SELECT 1 FROM rx x WHERE x.patient_id = ep.patient_id AND left(x.j->>'id', length(ep.eid) + 5) = ep.eid || '-inp-')
          OR EXISTS (SELECT 1 FROM pr x WHERE x.patient_id = ep.patient_id AND left(x.j->>'id', length(ep.eid) + 5) = ep.eid || '-inp-')))::int AS with_in_stay_orders
    FROM ep`;

  // Step T.3: st(eid, stage_no, value), one row per episode, stage and value. Later steps add UNION ALL parts (T.4: stages 4-6, T.5: stages 7-9).
  // Stage 1 comorbidities (many per episode), 2 principal diagnosis, 3 presentation (admit source). A missing value is '(none)', so no episode is dropped.
  const ADMIT_LABEL = { emd: 'Emergency department', gp: 'Physician referral', 'hosp-trans': 'Transfer from hospital', nursing: 'From nursing home' };
  const DISP_LABEL = { home: 'Home', snf: 'Skilled nursing', rehab: 'Rehabilitation', aadvice: 'Left against advice', exp: 'Died' };
  const trajStages = (c, q, tp) => {
    const chP = q.add(chronicOf(c), 'text[]');
    const dxLab = `(VALUES ${Object.values(T.CONDITIONS).filter(x => x && x.code).map(x => `(${q.add(x.code, 'text')}, ${q.add(x.display, 'text')})`).join(', ')})`;
    const lab = d => `(VALUES ${Object.values(d).filter(x => x && x.code).map(x => `(${q.add(x.code, 'text')}, ${q.add(x.display, 'text')})`).join(', ')})`;
    const adLab = `(VALUES ${Object.entries(ADMIT_LABEL).map(([k, v]) => `(${q.add(k, 'text')}, ${q.add(v, 'text')})`).join(', ')})`;
    return `${trajEp(c)},
    dl(code, label) AS ${dxLab},
    al3(code, label) AS ${adLab},
    ml(code, label) AS ${lab(T.MEDICATIONS)},
    pl(code, label) AS ${lab(T.PROCEDURES)},
    dp(code, label) AS (VALUES ${Object.entries(DISP_LABEL).map(([k, v]) => `(${q.add(k, 'text')}, ${q.add(v, 'text')})`).join(', ')}),
    st1 AS (SELECT DISTINCT ep.eid, 1 AS stage_no, COALESCE(dl.label, d.code) AS value
      FROM ep JOIN dx d ON d.patient_id = ep.patient_id AND d.code = ANY(${chP}) AND d.onset_date <= ep.admit::date
      LEFT JOIN dl ON dl.code = d.code),
    st2 AS (SELECT ep.eid, 2 AS stage_no, COALESCE(dl.label, NULLIF(ep.j->'reasonCode'->0->'coding'->0->>'code', ''), '(none)') AS value
      FROM ep LEFT JOIN dl ON dl.code = ep.j->'reasonCode'->0->'coding'->0->>'code'),
    st3 AS (SELECT ep.eid, 3 AS stage_no, COALESCE(a.label, NULLIF(ep.j->'hospitalization'->'admitSource'->'coding'->0->>'code', ''), '(none)') AS value
      FROM ep LEFT JOIN al3 a ON a.code = ep.j->'hospitalization'->'admitSource'->'coding'->0->>'code'),
    ip AS (SELECT ep.eid,
        EXISTS (SELECT 1 FROM pr x WHERE x.patient_id = ep.patient_id AND x.performed_date >= ep.admit AND x.performed_date <= LEAST(ep.admit + interval '48 hours', ep.disch)) AS has_pr,
        EXISTS (SELECT 1 FROM rx x WHERE x.patient_id = ep.patient_id AND x.prescribed_date >= ep.admit AND x.prescribed_date <= LEAST(ep.admit + interval '48 hours', ep.disch)) AS has_rx
      FROM ep),
    st4 AS (SELECT eid, 4 AS stage_no, CASE WHEN has_pr AND has_rx THEN 'Procedure + medication' WHEN has_pr THEN 'Procedure only' WHEN has_rx THEN 'Medication only' ELSE 'Observation only' END AS value FROM ip),
    st5 AS (SELECT DISTINCT ep.eid, 5 AS stage_no, COALESCE(ml.label, x.code) AS value
      FROM ep JOIN rx x ON x.patient_id = ep.patient_id AND x.code IS NOT NULL AND x.prescribed_date >= ep.admit AND x.prescribed_date <= ep.disch
      LEFT JOIN ml ON ml.code = x.code),
    st6 AS (SELECT DISTINCT ep.eid, 6 AS stage_no, COALESCE(pl.label, x.code) AS value
      FROM ep JOIN pr x ON x.patient_id = ep.patient_id AND x.code IS NOT NULL AND x.performed_date >= ep.admit AND x.performed_date <= ep.disch
      LEFT JOIN pl ON pl.code = x.code),
    st7 AS (SELECT ep.eid, 7 AS stage_no, CASE
        WHEN EXISTS (SELECT 1 FROM en k WHERE k.cls = 'ACUTE' AND k.patient_id = ep.patient_id AND k.j->'partOf'->>'reference' = 'Encounter/' || ep.eid
          AND k.j->'type'->0->>'text' = 'Intensive care unit stay') THEN 'ICU transfer'
        WHEN EXISTS (SELECT 1 FROM en k WHERE k.cls = 'ACUTE' AND k.patient_id = ep.patient_id AND k.j->'partOf'->>'reference' = 'Encounter/' || ep.eid
          AND k.j->'type'->0->>'text' = 'Rapid response') THEN 'Rapid response call'
        ELSE 'None' END AS value FROM ep),
    st8 AS (SELECT eid, 8 AS stage_no, CASE WHEN rd AND ls THEN 'Both' WHEN rd THEN 'Readmitted within 30 days' WHEN ls THEN 'Prolonged stay' ELSE 'Neither' END AS value
      FROM (SELECT ep.eid,
          EXISTS (SELECT 1 FROM en b WHERE b.patient_id = ep.patient_id AND b.cls = 'IMP' AND b.start_date > ep.disch AND b.start_date <= ep.disch + interval '30 days') AS rd,
          ep.disch >= ep.admit + (${q.add(tp.longStay, 'int')} * interval '1 day') AS ls FROM ep) z),
    st9 AS (SELECT ep.eid, 9 AS stage_no, COALESCE(dp.label, CASE WHEN dc.code IS NULL THEN '(none)' WHEN dc.code IN ('exp') THEN 'Died' ELSE 'Other' END) AS value
      FROM (SELECT eid, NULLIF(j->'hospitalization'->'dischargeDisposition'->'coding'->0->>'code', '') AS code FROM ep) dc
      JOIN ep ON ep.eid = dc.eid LEFT JOIN dp ON dp.code = dc.code),
    st AS (SELECT eid, stage_no, value FROM st1
      UNION ALL SELECT eid, 1, '(none)' FROM ep WHERE NOT EXISTS (SELECT 1 FROM st1 WHERE st1.eid = ep.eid)
      UNION ALL SELECT eid, stage_no, value FROM st2
      UNION ALL SELECT eid, stage_no, value FROM st3
      UNION ALL SELECT eid, stage_no, value FROM st4
      UNION ALL SELECT eid, stage_no, value FROM st5
      UNION ALL SELECT eid, 5, '(none)' FROM ep WHERE NOT EXISTS (SELECT 1 FROM st5 WHERE st5.eid = ep.eid)
      UNION ALL SELECT eid, stage_no, value FROM st6
      UNION ALL SELECT eid, 6, '(none)' FROM ep WHERE NOT EXISTS (SELECT 1 FROM st6 WHERE st6.eid = ep.eid)
      UNION ALL SELECT eid, stage_no, value FROM st7
      UNION ALL SELECT eid, stage_no, value FROM st8
      UNION ALL SELECT eid, stage_no, value FROM st9)`;
  };
  const TRAJ_STAGES = [[1, 'Comorbidities'], [2, 'Diagnosis'], [3, 'Presentation'], [4, 'Initial plan'], [5, 'Medications'], [6, 'Procedures'], [7, 'Escalation'], [8, 'Advanced/recurrent'], [9, 'Disposition']];
  const trajStageCheck = (c, q, tp) => `${trajStages(c, q, tp)},
    sn(stage_no, stage) AS (VALUES ${TRAJ_STAGES.map(([n, l]) => `(${n}, ${q.add(l, 'text')})`).join(', ')})
    SELECT sn.stage_no, sn.stage,
      (SELECT count(DISTINCT eid) FROM st WHERE st.stage_no = sn.stage_no AND value <> '(none)')::int AS episodes_with_value,
      (SELECT count(DISTINCT eid) FROM st WHERE st.stage_no = sn.stage_no)::int AS episodes_covered,
      (SELECT count(*) FROM ep)::int AS episodes,
      (SELECT count(*) FROM st WHERE st.stage_no = sn.stage_no)::int AS value_rows,
      (SELECT count(DISTINCT value) FROM st WHERE st.stage_no = sn.stage_no)::int AS distinct_values
    FROM sn ORDER BY sn.stage_no`;

  // Step T.6: one row per (stage, value) with the number of distinct episodes carrying it, as a share of ALL episodes.
  const trajNodes = (c, q, tp) => `${trajStages(c, q, tp)},
    sn(stage_no, stage) AS (VALUES ${TRAJ_STAGES.map(([n, l]) => `(${n}, ${q.add(l, 'text')})`).join(', ')}),
    nd AS (SELECT stage_no, value, count(DISTINCT eid)::int AS episodes FROM st GROUP BY stage_no, value)
    SELECT nd.stage_no, sn.stage, nd.value, nd.episodes,
      ${pct('nd.episodes', '(SELECT count(*) FROM ep)')} AS pct_of_episodes
    FROM nd JOIN sn ON sn.stage_no = nd.stage_no ORDER BY nd.stage_no, nd.episodes DESC, nd.value`;

  // Step T.7: ribbons = episodes going from one value of stage k to one value of stage k+1 (distinct episodes per pair).
  // Multi-valued stages (1, 5, 6) fan out, so an episode can sit in several ribbons. Top TRAJ_RIBBON_CAP pairs per transition.
  const TRAJ_RIBBON_CAP = 40;
  const trajRibbons = (c, q, tp) => `${trajStages(c, q, tp)},
    sn(stage_no, stage) AS (VALUES ${TRAJ_STAGES.map(([n, l]) => `(${n}, ${q.add(l, 'text')})`).join(', ')}),
    nd AS (SELECT stage_no, value, count(DISTINCT eid)::int AS episodes FROM st GROUP BY stage_no, value),
    rb AS (SELECT a.stage_no AS fs, a.value AS fv, b.value AS tv, count(DISTINCT a.eid)::int AS n
      FROM st a JOIN st b ON b.eid = a.eid AND b.stage_no = a.stage_no + 1 GROUP BY a.stage_no, a.value, b.value),
    rk AS (SELECT rb.*, row_number() OVER (PARTITION BY fs ORDER BY n DESC, fv, tv) AS rn FROM rb)
    SELECT sf.stage AS from_stage, rk.fv AS from_value, st2.stage AS to_stage, rk.tv AS to_value, rk.n AS episodes,
      ${pct('rk.n', 'nd.episodes')} AS pct_of_from
    FROM rk JOIN nd ON nd.stage_no = rk.fs AND nd.value = rk.fv
      JOIN sn sf ON sf.stage_no = rk.fs JOIN sn st2 ON st2.stage_no = rk.fs + 1
    WHERE rk.rn <= ${TRAJ_RIBBON_CAP}
    ORDER BY rk.fs, rk.n DESC, rk.fv, rk.tv`;

  // Step T.8: among episodes that carry `node` at stage `traceStage`, the distribution of values at every later (forward) or earlier (backward) stage.
  const trajTrace = (c, q, tp) => `${trajStages(c, q, tp)},
    sn(stage_no, stage) AS (VALUES ${TRAJ_STAGES.map(([n, l]) => `(${n}, ${q.add(l, 'text')})`).join(', ')}),
    tr AS (SELECT DISTINCT eid FROM st WHERE stage_no = ${q.add(tp.traceStage, 'int')} AND lower(value) = lower(${q.add(tp.node, 'text')})),
    tn AS (SELECT count(*)::int AS n FROM tr)
    SELECT s.stage_no, sn.stage, s.value, count(DISTINCT s.eid)::int AS episodes, (SELECT n FROM tn) AS traced_episodes,
      ${pct('count(DISTINCT s.eid)', '(SELECT n FROM tn)')} AS pct_of_traced
    FROM st s JOIN tr ON tr.eid = s.eid JOIN sn ON sn.stage_no = s.stage_no
    WHERE s.stage_no ${tp.dir === 'backward' ? '<' : '>'} ${q.add(tp.traceStage, 'int')}
    GROUP BY s.stage_no, sn.stage, s.value ORDER BY s.stage_no, episodes DESC, s.value`;

  def({
    id: 'inpatient_trajectory', category: 'Utilization', title: 'Inpatient trajectory (9 stages)',
    description: 'V4: one episode per inpatient discharge (the same frame as Readmission drivers). Section scope counts episodes and how many carry the detail the stages need (admit source, coded principal diagnosis, discharge disposition, an escalation child stay, in-stay orders). Section nodes lists every value of every stage with its episode count and share of all episodes (stage 1 shares can add up to more than 100 because an episode can have several comorbidities). Section ribbons counts distinct episodes for each pair of values in consecutive stages (top 40 pairs per transition; pct_of_from is the share of the episodes carrying the from value; with a multi-valued stage 1, 5 or 6 an episode can appear in several ribbons, so shares can add up to more than 100). Optional section trace (set the trace stage and node value) shows, among the episodes carrying that value, the distribution at every later (forward) or earlier (backward) stage; a value nobody carries gives an empty table. Section stage_check builds the nine stages (comorbidities, diagnosis, presentation, initial plan in the first 48 hours, medications, procedures, escalation, advanced/recurrent, disposition) as a long table of episode, stage and value; a missing value is shown as (none). Escalation is ICU transfer (an ICU child stay), Rapid response call, or None; stage 8 is readmitted within 30 days, prolonged stay (longStay days or more) or both; disposition is Home, Skilled nursing, Rehabilitation, Left against advice, Died, Other. The initial plan and stages 5 and 6 count every dated medication and procedure record in the window, not only the generator\'s in-stay orders. The detail exists only in batches generated with "Inpatient detail (for trajectory analytics)" ticked; on any other batch the detail counts are 0, so regenerate with the option ticked. Parameter longStay (days, 3-60, default 7) sets the prolonged-stay limit of stage 8. Aggregates only; disposition and escalation are drawn from age, comorbidity and diagnosis in the generator, so later ribbons show the generator\'s assumptions, not observed flow.',
    params: [
      { name: 'longStay', label: 'Prolonged stay from (days, 3-60)', type: 'number', default: 7, modes: ['v4'] },
      { name: 'node_stage', label: 'Trace: stage of the node', type: 'select', default: '', modes: ['v4'], options: [{ value: '', label: '(no trace)' }].concat(TRAJ_STAGES.map(([n, l]) => ({ value: String(n), label: n + ' ' + l }))) },
      { name: 'node', label: 'Trace: node value (for example ICU transfer)', type: 'text', modes: ['v4'] },
      { name: 'direction', label: 'Trace direction', type: 'select', default: 'forward', modes: ['v4'], options: [{ value: 'forward', label: 'Forward (later stages)' }, { value: 'backward', label: 'Backward (earlier stages)' }] }
    ],
    v4: (a, c) => { const tp = trajParse(a); const out = [
      S('scope', 'Episode scope and available detail', () => trajScope(c)),
      S('nodes', 'Nodes: episodes per stage and value', q => trajNodes(c, q, tp)),
      S('ribbons', 'Ribbons: episodes between consecutive stages (top 40 per transition)', q => trajRibbons(c, q, tp)),
      S('stage_check', 'Stage check: episodes with a value per stage (all nine stages)', q => trajStageCheck(c, q, tp))
    ];
      if (tp.traceStage) out.push(S('trace', `Trace ${tp.dir} from stage ${tp.traceStage}: ${tp.node} (no rows = no episode carries this value)`, q => trajTrace(c, q, tp)));
      return out; }
  });

  // ---- Phase 7B, Step M.1: Disease module (V4). One generic engine, diabetes first. Later steps (M.2-M.14) add sections and passes. ----------
  // Only server-defined strings go into the SQL: the disease key is checked with Object.hasOwn; codes and the goal go through q.add() / Number().
  // Cohort = patients with the condition code (any date, the same rule as Guideline adherence). Controlled = latest result of the control lab
  // in the 12 months before the as-of date is below the goal (the same rule as Guideline adherence); no result in those 12 months = untested.
  const DISEASES = {
    diabetes: { label: 'Type 2 diabetes (HbA1c below goal)', condCode: T.CONDITIONS.diabetes.code, labCode: T.LABS.hba1c.code, goalBelow: Number(T.CONTROL_MEASURES.diabetes_hba1c.goalBelow), firstLine: T.TREATMENT_MAP.diabetes },
    // Step M.13: second disease. Control = latest systolic BP in the 12 months below the goal (the htn_bp measure of Guideline adherence). Passes and sections that need a
    // diabetes-specific regimen (insulin / metformin) are marked appliesTo ['diabetes'] and skipped for other diseases.
    hypertension: { label: 'Hypertension (systolic BP below goal)', condCode: T.CONDITIONS.hypertension.code, labCode: T.LABS.sbp.code, goalBelow: Number(T.CONTROL_MEASURES.htn_bp.goalBelow), firstLine: T.TREATMENT_MAP.hypertension }
  };
  const dmParse = a => {
    const key = a.disease == null || String(a.disease).trim() === '' ? 'diabetes' : String(a.disease).trim();
    if (!Object.hasOwn(DISEASES, key)) throw new Error(`Unknown disease "${key.slice(0, 40)}"; choose one of: ${Object.keys(DISEASES).join(', ')}`);
    const pick = (v, list, what) => { const t = v == null ? '' : String(v).trim(); if (t === '' || t === 'any') return null; if (!list.includes(t)) throw new Error(`Unknown ${what} "${t.slice(0, 40)}"; choose any or one of: ${list.join(', ')}`); return t; };   // Step M.11 (fixed server-side lists)
    return { key, dz: DISEASES[key], supply: Math.min(Math.max(Math.round(num(a.adhSupply, DM_ADH.supply)), 7), 180),   // supply days per fill for the adherence pass (Step M.7)
      ageBand: pick(a.age_band, DM_AGE_BANDS, 'age band'), burden: pick(a.burden, DM_BURDENS, 'burden'),
      threshold: (() => { const t = Number(a.threshold == null || String(a.threshold).trim() === '' ? 8 : a.threshold); return Number.isFinite(t) ? Math.min(Math.max(t, 6.5), 14) : 8; })() };   // Step M.12: clamped 6.5-14, junk = 8
  };
  // CTE text (no leading comma, no WITH): dc = cohort with first dated onset (idx); ctl = one row per cohort patient with the latest control value and status.
  const dmCtes = (q, dz) => `dc AS (SELECT patient_id, min(onset_date) AS idx FROM dx WHERE code = ${q.add(dz.condCode, 'text')} GROUP BY patient_id),
    lastv AS (SELECT DISTINCT ON (patient_id) patient_id, value FROM ob
              WHERE code = ${q.add(dz.labCode, 'text')} AND value IS NOT NULL AND effective_date > (SELECT d FROM ref) - interval '12 months'
              ORDER BY patient_id, effective_date DESC),
    ctl AS (SELECT dc.patient_id, dc.idx, l.value,
              CASE WHEN l.value IS NULL THEN 'untested' WHEN l.value < ${dz.goalBelow}::numeric THEN 'controlled' ELSE 'uncontrolled' END AS status
            FROM dc LEFT JOIN lastv l ON l.patient_id = dc.patient_id)`;
  const dmCohort = (c, q, dm) => `${c.with},
    ${dmCtes(q, dm.dz)}
    SELECT count(*)::int AS patients,
      count(*) FILTER (WHERE status <> 'untested')::int AS tested,
      count(*) FILTER (WHERE status = 'untested')::int AS untested,
      count(*) FILTER (WHERE status = 'controlled')::int AS controlled,
      count(*) FILTER (WHERE status = 'uncontrolled')::int AS uncontrolled,
      ${pct(`count(*) FILTER (WHERE status = 'uncontrolled')`, `count(*) FILTER (WHERE status <> 'untested')`)} AS uncontrolled_pct
    FROM ctl`;

  // Step M.2: one-row overview of the cohort. "12m" = the 12 months before the as-of date (same window as the control rule).
  // Means count patients with none as 0 (chronic conditions, drugs); mean_age and female_pct use the cohort as denominator (a missing birth date is left out of mean_age only).
  const dmOverview = (c, q, dm) => `${c.with},
    ${dmCtes(q, dm.dz)},
    base AS (SELECT ctl.patient_id, ctl.status, p.gender,
        CASE WHEN p.birth_date IS NULL THEN NULL ELSE EXTRACT(YEAR FROM age((SELECT d FROM ref), p.birth_date)) END AS age,
        (SELECT count(DISTINCT code) FROM dx WHERE dx.patient_id = ctl.patient_id AND code = ANY(${q.add(chronicOf(c), 'text[]')})) AS chronic,
        (SELECT count(DISTINCT code) FROM rx WHERE rx.patient_id = ctl.patient_id AND code IS NOT NULL AND prescribed_date > (SELECT d FROM ref) - interval '12 months') AS drugs,
        (SELECT count(*) FROM en WHERE en.patient_id = ctl.patient_id AND cls = 'EMER' AND start_date > (SELECT d FROM ref) - interval '12 months') AS ed,
        (SELECT count(*) FROM en WHERE en.patient_id = ctl.patient_id AND cls = 'IMP' AND start_date > (SELECT d FROM ref) - interval '12 months') AS imp
      FROM ctl LEFT JOIN p ON p.patient_id = ctl.patient_id)
    SELECT count(*)::int AS patients,
      round(avg(age), 1)::float8 AS mean_age,
      ${pct(`count(*) FILTER (WHERE gender = 'female')`, 'count(*)')} AS female_pct,
      round(avg(chronic), 2)::float8 AS mean_chronic_conditions,
      round(avg(drugs), 2)::float8 AS mean_distinct_drugs_12m,
      round(100.0 * sum(ed) / NULLIF(count(*), 0), 1)::float8 AS ed_visits_per_100_12m,
      round(100.0 * sum(imp) / NULLIF(count(*), 0), 1)::float8 AS admissions_per_100_12m,
      ${pct(`count(*) FILTER (WHERE status <> 'untested')`, 'count(*)')} AS tested_pct
    FROM base`;

  // Step M.3: the pass engine. A pass groups the cohort by ONE server-defined expression and reports the uncontrolled rate per group as a lift over the
  // disease baseline. groupSql(c, q, dm) returns an SQL expression over `p` (patient row), `ctl` (cohort row) and `age` (age at the as-of date);
  // it may add parameters with q.add. Only server-defined strings go into the SQL (the pass id is checked with Object.hasOwn).
  // Step M.7: the drug and supply of the adherence pass, and its group labels (server-defined strings written into the SQL as quoted literals; no quote characters in them).
  const DM_ADH = { drug: 'metformin', supply: 30,   // supply = default days covered per fill (parameter adhSupply, clamped 7-180)
     labels: { good: `'Good (PDC 0.8 or more)'`, partial: `'Partial (PDC 0.5 to 0.79)'`, poor: `'Poor (PDC below 0.5)'`, none: `'No fills'`, notEval: `'Not evaluable (first fill under one supply period before the as-of date)'` } };
  const DM_CKD = { good: `'eGFR 60 or more'`, mid: `'eGFR 30 to 59'`, low: `'eGFR below 30'`, none: `'No eGFR (no creatinine in 12 months, or not computable)'` };   // Step M.8 labels (server-defined)
  const DM_MIN_TESTED = 30;   // groups with fewer tested patients are flagged low_n (same limit as Step 3.8d)
  const DM_PASSES = {
    age_band: { title: 'Age band', groupSql: () => bandCase('age'), orderSql: 'min(age) NULLS LAST' },
    sex: { title: 'Sex', groupSql: () => `COALESCE(p.gender, 'unknown')` },
    comorbidity_burden: { title: 'Comorbidity burden (other chronic conditions)', groupSql: (c, q, dm) => `(SELECT CASE WHEN count(DISTINCT code) >= 3 THEN '3+' ELSE count(DISTINCT code)::text END FROM dx WHERE dx.patient_id = ctl.patient_id AND code = ANY(${q.add(chronicOf(c).filter(x => x !== dm.dz.condCode), 'text[]')}))` },
    // Step M.4. All three look at the 12 months before the as-of date (the same window as the control rule).
    regimen: { title: 'Regimen (drugs prescribed in the last 12 months)', orderSql: `CASE g WHEN 'Metformin only' THEN 1 WHEN 'Insulin (with or without metformin)' THEN 2 ELSE 3 END`,
      groupSql: (c, q) => `(SELECT CASE WHEN bool_or(code = ${q.add(T.MEDICATIONS.insulin_glargine.code, 'text')}) THEN 'Insulin (with or without metformin)' WHEN bool_or(code = ${q.add(T.MEDICATIONS.metformin.code, 'text')}) THEN 'Metformin only' ELSE 'Other or none' END
        FROM (SELECT code FROM rx WHERE rx.patient_id = ctl.patient_id AND prescribed_date > (SELECT d FROM ref) - interval '12 months' UNION ALL SELECT NULL) r)` },
    testing_frequency: { title: 'Testing frequency (control-lab results in the last 12 months)',
      groupSql: (c, q, dm) => `(SELECT CASE WHEN n = 0 THEN '0 (untested)' WHEN n >= 3 THEN '3+' ELSE n::text END FROM (SELECT count(*) AS n FROM ob WHERE ob.patient_id = ctl.patient_id AND code = ${q.add(dm.dz.labCode, 'text')} AND value IS NOT NULL AND effective_date > (SELECT d FROM ref) - interval '12 months') t)` },
    guideline_concordance: { title: 'Guideline concordance (on a first-line drug in the last 12 months)',
      groupSql: (c, q, dm) => `(CASE WHEN EXISTS (SELECT 1 FROM rx WHERE rx.patient_id = ctl.patient_id AND code = ANY(${q.add(dm.dz.firstLine.map(k => T.MEDICATIONS[k].code), 'text[]')}) AND prescribed_date > (SELECT d FROM ref) - interval '12 months') THEN 'On a first-line drug' ELSE 'Not on a first-line drug' END)` },
    // Step M.5: payer, income band and social needs from the patient extensions written by the generator (the `ext` reader and STRAT keys of Step 1.2/3.2).
    payer: { title: 'Payer', groupSql: () => STRAT.payer },
    income: { title: 'Income band', groupSql: () => STRAT.income, orderSql: `CASE g WHEN 'Low' THEN 1 WHEN 'Middle' THEN 2 WHEN 'High' THEN 3 ELSE 4 END` },
    social_needs: { title: 'Social needs (food insecurity or housing instability)',
      groupSql: () => `(CASE WHEN ${ext('food-insecurity', 'valueBoolean')} = 'true' OR ${ext('housing-instability', 'valueBoolean')} = 'true' THEN 'Food or housing need' WHEN ${ext('food-insecurity', 'valueBoolean')} IS NULL AND ${ext('housing-instability', 'valueBoolean')} IS NULL THEN 'Unknown' ELSE 'No need recorded' END)`,
      orderSql: `CASE g WHEN 'Food or housing need' THEN 1 WHEN 'No need recorded' THEN 2 ELSE 3 END` },
    // Step M.7: adherence to the default drug (metformin, 30-day supply per fill; fixed for now) as PDC tiers, using pdcFrom (Step M.6).
    // `ctes(c, q, dm)` is an optional hook: CTE text (no leading comma) that passSql places before the grouping CTEs. Its names must not clash with
    // p, dx, ob, rx, pr, en, al, im, ref, dc, lastv, ctl, pb, pg, base (pdcFrom defines f, g, isl, iv, fl, pd).
    // Tiers use all fills up to the as-of date (not only the last 12 months): No fills = no dated fill of the drug; Not evaluable = first fill less than
    // `supply` days before the as-of date; otherwise PDC = covered days / days from first fill to the as-of date (capped at 1).
    adherence: { title: `Adherence (PDC of ${DM_ADH.drug}; days covered per fill = parameter Adherence supply days, default ${DM_ADH.supply})`,
      orderSql: `CASE g WHEN ${DM_ADH.labels.good} THEN 1 WHEN ${DM_ADH.labels.partial} THEN 2 WHEN ${DM_ADH.labels.poor} THEN 3 WHEN ${DM_ADH.labels.none} THEN 4 ELSE 5 END`,
      ctes: (c, q, dm) => pdcFrom(c, q, T.MEDICATIONS[DM_ADH.drug].code, dm.supply).sql,
      groupSql: (c, q, dm) => `(SELECT CASE WHEN t.patient_id IS NULL THEN ${DM_ADH.labels.none}
          WHEN t.span_days < ${dm.supply} THEN ${DM_ADH.labels.notEval}
          WHEN LEAST(t.covered_days::numeric / t.span_days, 1) >= 0.8 THEN ${DM_ADH.labels.good}
          WHEN LEAST(t.covered_days::numeric / t.span_days, 1) >= 0.5 THEN ${DM_ADH.labels.partial}
          ELSE ${DM_ADH.labels.poor} END
        FROM (SELECT 1) one LEFT JOIN pd t ON t.patient_id = ctl.patient_id)` },
    // Step M.8: eGFR group from the latest creatinine in the 12 months before the as-of date (egfrCtes, Step 3.9: CKD-EPI 2021, mg/dL only, adults 18+ with known sex and birth date).
    // A patient with no such creatinine, or one whose eGFR cannot be computed (unit other than mg/dL, no birth date, unknown sex, under 18), is in the No eGFR group.
    ckd_stage: { title: 'CKD stage (eGFR from the latest creatinine in the last 12 months)',
      orderSql: `CASE g WHEN ${DM_CKD.good} THEN 1 WHEN ${DM_CKD.mid} THEN 2 WHEN ${DM_CKD.low} THEN 3 ELSE 4 END`,
      ctes: (c, q) => egfrCtes(q, 12),
      groupSql: () => `(SELECT CASE WHEN x.egfr IS NULL THEN ${DM_CKD.none} WHEN x.egfr >= 60 THEN ${DM_CKD.good} WHEN x.egfr >= 30 THEN ${DM_CKD.mid} ELSE ${DM_CKD.low} END
        FROM (SELECT 1) one LEFT JOIN e x ON x.patient_id = ctl.patient_id)` }
  };
  const passSql = (id, c, q, dm) => {
    const ps = DM_PASSES[id];
    return `${c.with},
    ${dmCtes(q, dm.dz)},
    ${ps.ctes ? ps.ctes(c, q, dm) + ',\n    ' : ''}pb AS (SELECT ctl.patient_id, ctl.status,
        CASE WHEN p.birth_date IS NULL THEN NULL ELSE EXTRACT(YEAR FROM age((SELECT d FROM ref), p.birth_date)) END AS age,
        p.gender, p.pj, ctl.idx
      FROM ctl LEFT JOIN p ON p.patient_id = ctl.patient_id),
    pg AS (SELECT status, age, (${ps.groupSql(c, q, dm).replace(/\bctl\.patient_id\b/g, 'pb.patient_id').replace(/\bp\.gender\b/g, 'pb.gender')}) AS g FROM pb),
    base AS (SELECT count(*) FILTER (WHERE status = 'uncontrolled')::numeric / NULLIF(count(*) FILTER (WHERE status <> 'untested'), 0) AS rate FROM pg)
    SELECT g AS group_value, count(*)::int AS patients,
      count(*) FILTER (WHERE status <> 'untested')::int AS tested,
      count(*) FILTER (WHERE status = 'uncontrolled')::int AS uncontrolled,
      ${pct(`count(*) FILTER (WHERE status = 'uncontrolled')`, `count(*) FILTER (WHERE status <> 'untested')`)} AS uncontrolled_pct,
      round(((count(*) FILTER (WHERE status = 'uncontrolled')::numeric / NULLIF(count(*) FILTER (WHERE status <> 'untested'), 0)) / NULLIF((SELECT rate FROM base), 0))::numeric, 2)::float8 AS lift,
      (count(*) FILTER (WHERE status <> 'untested') < ${DM_MIN_TESTED}) AS low_n
    FROM pg GROUP BY g ORDER BY ${ps.orderSql || 'g'}, g`;
  };
  // Step M.9: variation drivers. One row per driver (a yes/no characteristic of the patient), single-factor and overlapping: the same patient can carry several drivers,
  // and nothing is adjusted, so contributions do not add up. Each driver reuses the group expression of the pass it comes from (so the numbers equal that pass's rows):
  // n = cohort patients with the driver, tested = of them with a control result, rate_with_pct = uncontrolled share of tested, lift = that rate / cohort rate,
  // contribution = n x (lift - 1) (patients' worth of excess, negative when the driver goes with better control; empty when nobody with the driver is tested).
  // Poor adherence uses the adherence pass (parameter adhSupply). Only server-defined labels go into the SQL.
  const DM_DRIVERS = [
    { label: 'Age 65+', sql: () => `COALESCE(pb.age >= 65, false)` },
    { label: 'Female', pass: 'sex', is: `'female'` },
    { label: '3+ other chronic conditions', pass: 'comorbidity_burden', is: `'3+'` },
    { label: 'CKD G3 or worse (eGFR below 60)', pass: 'ckd_stage', is: `${DM_CKD.mid}, ${DM_CKD.low}` },
    { label: 'On insulin', pass: 'regimen', is: `'Insulin (with or without metformin)'` },
    { label: 'Poor adherence', pass: 'adherence', is: DM_ADH.labels.poor },
    { label: 'Social need (food or housing)', pass: 'social_needs', is: `'Food or housing need'` },
    { label: 'Medicaid or uninsured', pass: 'payer', is: `'Medicaid', 'Uninsured'` },
    { label: 'Not on a first-line drug', pass: 'guideline_concordance', is: `'Not on a first-line drug'` }
  ];
  const dmDrivers = (c, q, dm) => {
    const drv = DM_DRIVERS.filter(d => !d.pass || dmApplies(d.pass, dm.key)), adh = drv.some(d => d.pass === 'adherence');
    const cols = drv.map((d, i) => `COALESCE(${d.sql ? d.sql() : `(${DM_PASSES[d.pass].groupSql(c, q, dm).replace(/\bctl\.patient_id\b/g, 'pb.patient_id').replace(/\bp\.gender\b/g, 'pb.gender')}) IN (${d.is})`}, false) AS d${i}`).join(',\n        ');
    return `${c.with},
    ${dmCtes(q, dm.dz)},
    ${adh ? pdcFrom(c, q, T.MEDICATIONS[DM_ADH.drug].code, dm.supply).sql + ',\n    ' : ''}${egfrCtes(q, 12)},
    pb AS (SELECT ctl.patient_id, ctl.status,
        CASE WHEN p.birth_date IS NULL THEN NULL ELSE EXTRACT(YEAR FROM age((SELECT d FROM ref), p.birth_date)) END AS age,
        p.gender, p.pj, ctl.idx
      FROM ctl LEFT JOIN p ON p.patient_id = ctl.patient_id),
    pg AS (SELECT status,
        ${cols}
      FROM pb),
    base AS (SELECT count(*) FILTER (WHERE status = 'uncontrolled')::numeric / NULLIF(count(*) FILTER (WHERE status <> 'untested'), 0) AS rate FROM pg),
    dv AS (SELECT v.driver, v.hit, pg.status FROM pg CROSS JOIN LATERAL (VALUES ${drv.map((d, i) => `('${d.label}', pg.d${i})`).join(', ')}) v(driver, hit)),
    rv AS (SELECT driver, count(*) FILTER (WHERE hit)::int AS n,
        count(*) FILTER (WHERE hit AND status <> 'untested')::int AS tested,
        count(*) FILTER (WHERE hit AND status = 'uncontrolled')::int AS unc FROM dv GROUP BY driver)
    SELECT driver, n, tested, ${pct('unc', 'tested')} AS rate_with_pct,
      round(((unc::numeric / NULLIF(tested, 0)) / NULLIF((SELECT rate FROM base), 0))::numeric, 2)::float8 AS lift,
      round((n * ((unc::numeric / NULLIF(tested, 0)) / NULLIF((SELECT rate FROM base), 0) - 1))::numeric, 2)::float8 AS contribution,
      (tested < ${DM_MIN_TESTED}) AS low_n
    FROM rv ORDER BY contribution DESC NULLS LAST, driver`;
  };
  // Step M.10: regimen comparison with direct standardization. Strata = age band x comorbidity burden (the age_band and comorbidity_burden passes).
  // Standard population = the whole disease cohort (every cohort patient, tested or not): weight of a stratum = its cohort patients / all cohort patients, so the weights add up to 1.
  // For each regimen (the regimen pass groups) a stratum is USED when that regimen has at least DM_STRATUM_MIN tested patients in it, otherwise it is DROPPED
  // (a stratum where the regimen has no patient at all is dropped too). adjusted = sum(weight x stratum rate) / sum(weight) over the used strata (the weights are
  // renormalised over the used strata), so with one stratum adjusted = crude. crude = the regimen's uncontrolled share of tested. Empty adjusted when no stratum is used.
  const DM_STRATUM_MIN = 5;
  const dmRegimenAdjusted = (c, q, dm) => {
    const ex = id => `(${DM_PASSES[id].groupSql(c, q, dm).replace(/\bctl\.patient_id\b/g, 'pb.patient_id').replace(/\bp\.gender\b/g, 'pb.gender')})`;
    return `${c.with},
    ${dmCtes(q, dm.dz)},
    pb AS (SELECT ctl.patient_id, ctl.status,
        CASE WHEN p.birth_date IS NULL THEN NULL ELSE EXTRACT(YEAR FROM age((SELECT d FROM ref), p.birth_date)) END AS age,
        p.gender, p.pj, ctl.idx
      FROM ctl LEFT JOIN p ON p.patient_id = ctl.patient_id),
    pg AS (SELECT status, ${ex('age_band')} AS ab, ${ex('comorbidity_burden')} AS bb, ${ex('regimen')} AS rg FROM pb),
    std AS (SELECT ab, bb, count(*)::numeric / (SELECT count(*) FROM pg) AS w FROM pg GROUP BY ab, bb),
    cell AS (SELECT rg, ab, bb, count(*) FILTER (WHERE status <> 'untested') AS tested, count(*) FILTER (WHERE status = 'uncontrolled') AS unc FROM pg GROUP BY rg, ab, bb),
    reg AS (SELECT rg, count(*)::int AS n, count(*) FILTER (WHERE status <> 'untested') AS tested, count(*) FILTER (WHERE status = 'uncontrolled') AS unc FROM pg GROUP BY rg),
    grid AS (SELECT r.rg, std.w, COALESCE(cell.tested, 0) AS tested, COALESCE(cell.unc, 0) AS unc
             FROM (SELECT DISTINCT rg FROM pg) r CROSS JOIN std LEFT JOIN cell ON cell.rg = r.rg AND cell.ab IS NOT DISTINCT FROM std.ab AND cell.bb IS NOT DISTINCT FROM std.bb),
    adj AS (SELECT rg, count(*) FILTER (WHERE tested >= ${DM_STRATUM_MIN})::int AS strata_used, count(*) FILTER (WHERE tested < ${DM_STRATUM_MIN})::int AS strata_dropped,
              sum(w * unc / NULLIF(tested, 0)) FILTER (WHERE tested >= ${DM_STRATUM_MIN}) AS wr, sum(w) FILTER (WHERE tested >= ${DM_STRATUM_MIN}) AS ws FROM grid GROUP BY rg)
    SELECT reg.rg AS regimen, reg.n, ${pct('reg.unc', 'reg.tested')} AS crude_pct, round((100 * adj.wr / NULLIF(adj.ws, 0))::numeric, 1)::float8 AS adjusted_pct,
      adj.strata_used, adj.strata_dropped
    FROM reg JOIN adj ON adj.rg = reg.rg
    ORDER BY CASE reg.rg WHEN 'Metformin only' THEN 1 WHEN 'Insulin (with or without metformin)' THEN 2 ELSE 3 END`;
  };
  // Step M.11: matched projection. Among the cohort patients who match the chosen profile (age band and/or comorbidity burden, same groups as the age_band and
  // comorbidity_burden passes; "any" = no filter), per regimen (the regimen pass groups, all three always shown): n, tested, uncontrolled, uncontrolled share of tested
  // with a Wilson 95% interval (z = 1.96). A regimen with fewer than DM_PROJ_MIN tested matched patients shows no rate or interval, only the note "too few matched".
  // An association among matched patients, NOT a treatment recommendation (confounding by indication). The two filter values are checked against the fixed lists below
  // and go in through q.add.
  const DM_AGE_BANDS = ['0-1 years', '2-4 years', '5-17 years', '18-34 years', '35-44 years', '45-54 years', '55-64 years', '65-74 years', '75-84 years', '85+ years', 'Unknown'];
  const DM_BURDENS = ['0', '1', '2', '3+'];
  const DM_REGIMENS = ['Metformin only', 'Insulin (with or without metformin)', 'Other or none'];
  const DM_PROJ_MIN = 30;
  const dmProjection = (c, q, dm) => {
    const ex = id => `(${DM_PASSES[id].groupSql(c, q, dm).replace(/\bctl\.patient_id\b/g, 'pb.patient_id').replace(/\bp\.gender\b/g, 'pb.gender')})`;
    const z = 1.96, ok = `tested >= ${DM_PROJ_MIN}`, ph = '(unc::numeric / NULLIF(tested, 0))';
    const den = `(1 + ${z * z} / tested)`;
    return `${c.with},
    ${dmCtes(q, dm.dz)},
    pb AS (SELECT ctl.patient_id, ctl.status,
        CASE WHEN p.birth_date IS NULL THEN NULL ELSE EXTRACT(YEAR FROM age((SELECT d FROM ref), p.birth_date)) END AS age,
        p.gender, p.pj, ctl.idx
      FROM ctl LEFT JOIN p ON p.patient_id = ctl.patient_id),
    pg AS (SELECT status, ${ex('age_band')} AS ab, ${ex('comorbidity_burden')} AS bb, ${ex('regimen')} AS rg FROM pb),
    m AS (SELECT * FROM pg WHERE true ${dm.ageBand ? `AND ab = ${q.add(dm.ageBand, 'text')}` : ''} ${dm.burden ? `AND bb = ${q.add(dm.burden, 'text')}` : ''}),
    r AS (SELECT v.rg, v.o, count(m.rg)::int AS n, (count(*) FILTER (WHERE m.status <> 'untested'))::int AS tested, (count(*) FILTER (WHERE m.status = 'uncontrolled'))::int AS unc
          FROM (VALUES ${DM_REGIMENS.map((x, i) => `('${x}', ${i + 1})`).join(', ')}) v(rg, o) LEFT JOIN m ON m.rg = v.rg GROUP BY v.rg, v.o)
    SELECT rg AS regimen, n, tested, unc AS uncontrolled,
      CASE WHEN ${ok} THEN round((100 * ${ph})::numeric, 1)::float8 END AS uncontrolled_pct,
      CASE WHEN ${ok} THEN round((100 * GREATEST(0, (${ph} + ${z * z} / (2 * tested) - ${z} * sqrt(${ph} * (1 - ${ph}) / tested + ${z * z} / (4.0 * tested * tested))) / ${den}))::numeric, 1)::float8 END AS ci_low_pct,
      CASE WHEN ${ok} THEN round((100 * LEAST(1, (${ph} + ${z * z} / (2 * tested) + ${z} * sqrt(${ph} * (1 - ${ph}) / tested + ${z * z} / (4.0 * tested * tested))) / ${den}))::numeric, 1)::float8 END AS ci_high_pct,
      CASE WHEN ${ok} THEN NULL ELSE 'too few matched (under ${DM_PROJ_MIN} tested)' END AS note
    FROM r ORDER BY o`;
  };
  // Step M.12: intensification candidates, counts only. Candidate = tested cohort patient whose latest control result (12 months) is at or above `threshold`
  // (default 8, clamped 6.5-14) AND whose regimen is Metformin only (the regimen pass group). Counts by age band plus an "All ages" row, with `tested` and
  // `uncontrolled` of the same group for comparison and pct_of_tested = candidates / tested. No patient ids. A threshold below the control goal (7) can give
  // more candidates than `uncontrolled`, because a result between the threshold and the goal is still controlled. Not a treatment recommendation.
  const dmCandidates = (c, q, dm) => {
    const ex = id => `(${DM_PASSES[id].groupSql(c, q, dm).replace(/\bctl\.patient_id\b/g, 'pb.patient_id').replace(/\bp\.gender\b/g, 'pb.gender')})`;
    const cand = `count(*) FILTER (WHERE rg = 'Metformin only' AND status <> 'untested' AND value >= ${dm.threshold}::numeric)`;
    return `${c.with},
    ${dmCtes(q, dm.dz)},
    pb AS (SELECT ctl.patient_id, ctl.status, ctl.value,
        CASE WHEN p.birth_date IS NULL THEN NULL ELSE EXTRACT(YEAR FROM age((SELECT d FROM ref), p.birth_date)) END AS age,
        p.gender, p.pj, ctl.idx
      FROM ctl LEFT JOIN p ON p.patient_id = ctl.patient_id),
    pg AS (SELECT status, value, age, ${ex('age_band')} AS ab, ${ex('regimen')} AS rg FROM pb)
    SELECT COALESCE(ab, 'All ages') AS age_band, ${cand}::int AS candidates,
      (count(*) FILTER (WHERE status <> 'untested'))::int AS tested,
      (count(*) FILTER (WHERE status = 'uncontrolled'))::int AS uncontrolled,
      ${pct(cand, `count(*) FILTER (WHERE status <> 'untested')`)} AS pct_of_tested
    FROM pg GROUP BY GROUPING SETS ((ab), ()) ORDER BY GROUPING(ab), min(age) NULLS LAST, 1`;
  };
  DM_PASSES.regimen.appliesTo = ['diabetes']; DM_PASSES.adherence.appliesTo = ['diabetes'];   // Step M.13 (insulin / metformin logic)
  const dmApplies = (id, key) => !DM_PASSES[id].appliesTo || DM_PASSES[id].appliesTo.includes(key);
  const dmPasses = (a, dm) => {
    const v = a.pass == null || String(a.pass).trim() === '' ? 'all' : String(a.pass).trim();
    if (v === 'all') return Object.keys(DM_PASSES).filter(id => dmApplies(id, dm.key));
    if (!Object.hasOwn(DM_PASSES, v)) throw new Error(`Unknown pass "${v.slice(0, 40)}"; choose all or one of: ${Object.keys(DM_PASSES).join(', ')}`);
    if (!dmApplies(v, dm.key)) throw new Error(`Pass "${v}" does not apply to ${dm.key} (it applies to: ${DM_PASSES[v].appliesTo.join(', ')})`);
    return [v];
  };

  def({
    id: 'disease_module', category: 'Disease modules', title: 'Disease module (diabetes, hypertension)',
    description: 'V4: one disease at a time (type 2 diabetes for now). Section cohort: patients with the diagnosis code; tested = a control result (HbA1c) in the 12 months before the as-of date; controlled = the latest such result is below the goal (7); uncontrolled = at or above it; untested = no result in those 12 months (a care gap, left out of the uncontrolled rate). The counts equal the diabetes row of Guideline adherence (at goal, not at goal, not tested). Section overview: one row for the cohort with mean age, share female, mean distinct chronic conditions, mean distinct drugs in the last 12 months, emergency visits and inpatient admissions per 100 patients in the last 12 months, and the share tested. One section per pass (parameter pass: all or one): the cohort grouped by age band, sex, comorbidity burden, regimen (metformin only, insulin, other or none), testing frequency (control-lab results in 12 months; the 0 group is the untested one) guideline concordance (on a first-line drug or not), payer, income band, social needs (food insecurity or housing instability; the generator plants no link between these and HbA1c) CKD stage (eGFR from the latest creatinine in the last 12 months, CKD-EPI 2021, mg/dL only: 60 or more, 30 to 59, below 30, No eGFR) or adherence (PDC of metformin, from the first fill to the as-of date, each fill covering the supply days of parameter Adherence supply days, default 30, clamped 7-180: Good 0.8 or more, Partial 0.5 to 0.79, Poor below 0.5, No fills, and Not evaluable when the first fill is less than one supply period old; the generator renews statements about every 6 months, so a short supply puts almost everyone in Poor, and the generator ties HbA1c to adherence, so this pass is circular), with patients, tested, uncontrolled, the uncontrolled share of tested, lift (group rate divided by the cohort rate) and low_n (fewer than 30 tested). Caution: the synthetic generator links HbA1c to adherence and treatment, so later comparisons of adherence or regimen against control restate the generator\'s own coefficients; regimen comparisons are also confounded by indication. Results show that the pipeline works, not real-world epidemiology. Section regimen_adjusted (always shown): per regimen, n, the crude uncontrolled share of tested and the share directly standardized to the whole cohort over age band x comorbidity burden strata (strata with fewer than 5 tested patients for that regimen are dropped and counted; the weights are renormalised over the used strata); standardization removes only age and burden, so confounding by indication (sicker patients are put on insulin) remains. Section drivers (always shown): one row per yes/no driver (age 65+, female, 3+ other chronic conditions, CKD G3 or worse, on insulin, poor adherence, social need, Medicaid or uninsured, not on a first-line drug) with n, tested, the uncontrolled share among those with the driver, lift and contribution = n x (lift - 1), sorted by contribution; each driver is one group of the matching pass, single-factor and overlapping, not adjusted, so contributions do not add up and are not causal effects. Aggregates only. Section projection (Step M.11): choose an age band and/or a number of other chronic conditions (or Any) and see, per regimen, how many matching cohort patients are on it, how many are tested, and their uncontrolled rate with a Wilson 95% interval; a regimen with fewer than 30 tested matched patients shows only the counts and the note too few matched. With both filters on Any the rows equal the regimen pass. It is an association among matched patients, not a treatment recommendation: only age band and burden are matched, so confounding by indication remains. Section candidates (Step M.12): counts only, by age band and for all ages, of tested patients on Metformin only whose latest result is at or above the threshold parameter (default 8, 6.5 to 14), next to the tested and uncontrolled counts of the same group; no patient ids, not a treatment recommendation. A threshold under the goal (7) can give more candidates than uncontrolled. Disease parameter (Step M.13): hypertension is the second disease (controlled = latest systolic BP in the 12 months below 140; the cohort equals the hypertension row of Guideline adherence). The regimen and adherence passes, the regimen comparison, projection and candidates sections and the insulin and poor-adherence drivers are diabetes-only and are left out for hypertension; choosing one of those passes by name gives a clear error. The generator plants no strong hypertension drivers either.',
    params: [
      { name: 'disease', label: 'Disease (hypertension skips the diabetes-only passes and sections)', type: 'select', default: 'diabetes', modes: ['v4'], options: Object.entries(DISEASES).map(([value, d]) => ({ value, label: d.label })) },
      { name: 'adhSupply', label: 'Adherence supply days per fill (adherence pass)', type: 'number', default: 30, modes: ['v4'] },
      { name: 'age_band', label: 'Projection: age band', type: 'select', default: 'any', modes: ['v4'], options: [{ value: 'any', label: 'Any age' }].concat(DM_AGE_BANDS.map(value => ({ value, label: value }))) },
      { name: 'burden', label: 'Projection: other chronic conditions', type: 'select', default: 'any', modes: ['v4'], options: [{ value: 'any', label: 'Any number' }].concat(DM_BURDENS.map(value => ({ value, label: value }))) },
      { name: 'threshold', label: 'Intensification threshold (latest HbA1c at or above; 6.5-14)', type: 'number', default: 8, modes: ['v4'] },
      { name: 'pass', label: 'Pass (grouping of the cohort)', type: 'select', default: 'all', modes: ['v4'], options: [{ value: 'all', label: 'All passes' }].concat(Object.entries(DM_PASSES).map(([value, d]) => ({ value, label: d.title }))) }
    ],
    v4: (a, c) => { const dm = dmParse(a); return [
      S('cohort', `Cohort and control status (${dm.dz.label}; latest result in the last 12 months)`, q => dmCohort(c, q, dm)),
      S('overview', 'Overview of the cohort (age at the as-of date; drugs, ED visits and admissions in the last 12 months)', q => dmOverview(c, q, dm))
    ].concat(dmPasses(a, dm).map(id => S(id, `Pass: ${DM_PASSES[id].title} (uncontrolled rate among tested; lift = group rate / cohort rate; low_n = fewer than ${DM_MIN_TESTED} tested)`, q => passSql(id, c, q, dm))))
      .concat((dm.key === 'diabetes' ? [S('regimen_adjusted', `Regimen comparison, standardized by age band x comorbidity burden (direct standardization to the whole cohort; strata with fewer than ${DM_STRATUM_MIN} tested patients for a regimen are dropped; confounded by indication)`, q => dmRegimenAdjusted(c, q, dm)),
        S('projection', `Matched projection: uncontrolled rate per regimen among cohort patients matching the chosen age band and comorbidity burden (Wilson 95% interval; fewer than ${DM_PROJ_MIN} tested matched patients = too few matched; an association, NOT a treatment recommendation)`, q => dmProjection(c, q, dm)),
        S('candidates', `Intensification candidates (counts only: tested patients on Metformin only whose latest result is at or above the threshold, ${dm.threshold}; by age band; no patient ids; not a treatment recommendation)`, q => dmCandidates(c, q, dm))] : []).concat([
        S('drivers', `Variation drivers (single-factor and overlapping, not adjusted: contributions do not add up; contribution = n x (lift - 1); low_n = fewer than ${DM_MIN_TESTED} tested)`, q => dmDrivers(c, q, dm))])); }
  });

  // Step D.7d: the V1 search terms the engine learns for ONE data code that terminology.js does not know.
  // Returns { sql, params }: rows `term` (display strings first, then the most specific phrases, at most 8). `withSql` is ctx.with of the run.
  // Fixed rules: 5+ records of the code, phrases in 20%+ of them, specificity 3+, strict single-word rule. Only the code goes in as a parameter.
  const learnedTermsQuery = (code, withSql) => {
    const q = new k.Q();
    const lp = { minR: 5, top: 1, minShare: 20, minSpec: 3, only: String(code) };
    const sql = `${withSql},
      ${ltCtes(q, lp)},
      ${ltSelCtes(lp, q, true)}
      SELECT term FROM sel ORDER BY grp, rn`;
    return { sql, params: q.params };
  };
  return { learnedTermsQuery, labFlagCtes, eventStreamCte };
};
