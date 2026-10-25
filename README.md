# Vibe Rounds

One README for the whole project (it replaces README_FEATURES.md, README_ANALYTICS.md and README_CLINICAL_ANALYTICS.md).

## Files
| File | Role |
|---|---|
| `server.js` | Express app, FHIR import, schema, cohorts; registers `analytics.js`, `evidence.js` (`registerAi`), `knowledge.js`, `security.js` |
| `security.js` | Sign-in, audit log and the read-only SQL guard in one file (sections `sqlGuard`, `auth`, `audit`; replaces `sql-guard.js`, `auth.js`, `audit.js`) |
| `analytics.js` | The analytics engine and everything it registers (sections `customAnalytic`, `readiness`, `analyticsExt`, then the engine; replaces `analytics-ext.js`, `custom-analytic.js`, `readiness.js`). `register(app, pool)` is the file's export |
| `knowledge.js` | Terminology and data-source sections (`terminology`, `snomedQuery`, `kgCohort`, `fhirConnect`; replaces `terminology.js`, `snomed-query.js`, `kg-cohort.js`, `fhir-connect.js`) |
| `evidence.js` | Phase 4 tools in one file: OpenRouter settings and test, plain-English question parser, suggested PICO/PECO studies (`POST /api/pico/suggest`) and result explainer, saved PICO/PECO templates, A vs B comparison. Self-test: `node evidence.js --selftest`; smoke test: `node evidence.js --smoke`; also holds the Patient data explorer (`patientExplorer`) and the Notebook generator (`notebook`, routes off unless `ENABLE_NOTEBOOK=true`) |
| `synthetic.js` | Deterministic FHIR R4 generator (`generateBundle`) |
| `index.html` | The whole UI. Tabs: Database, Import data, Analytics (cohorts, catalog, generator, HAPI fetch, readiness, patient data explorer, PICO/PECO tools, AI settings, cohort knowledge graph), Dashboard, and the guide tabs Architecture, Capabilities and About |
| `login.html` | Sign-in page. Public on purpose: the gate in `security.js` redirects every other page to it, so the app itself is never sent to someone who is not signed in. Do not merge it into `index.html` |

Shortcuts: `npm test` runs the self-tests of every section in `security.js`, `knowledge.js`, `analytics.js` and `evidence.js` (each file also runs alone: `node security.js --selftest`); `npm run smoke` runs the smoke test (server must be running, data imported).

## Part 1: Preprocessing tab

### Overview
The **Preprocessing** tab turns FHIR files into structured data you can inspect, download or import into the database as a named batch. Codes are taken exactly as they appear in the files: there is no manual mapping-review or correction step (an earlier version had one; it was removed).

### Workflow
1. **Choose files**: JSON Bundles, NDJSON or CSV, several files at once or a whole folder.
2. **Extract & Normalize FHIR Data**: each file is parsed (Patient, Condition, Observation, MedicationStatement / MedicationRequest, Encounter, Procedure, AllergyIntolerance), resources are counted by type, and up to 1,000 sample records per type are kept with their code, code system and display text. The results are shown in paginated tables.
3. **Patient Data Explorer**: switch between patients, conditions, observations, medications, encounters, procedures, allergies and a per-patient timeline; click a patient for the full clinical timeline.
4. **Download Results / Download Summary JSON**: exports the counts, the resource-type breakdown and the sample tables.
5. **Import to Database**: asks for a batch name, then sends the original bundles to `POST /api/import-fhir` in chunks of 5,000 entries. Each batch gets its own set of `fhir_*_<batch>` tables, so batches sharing a base name can be analysed together as a group.



## Part 2: Database, cohorts and the Analytics tab

### Where things are
- **DB Connect tab**: *Start/Initialize DB* creates the tables, *Fetch Message from Database* tests a query, *Show Database Connection Details* shows the version, tables and pool statistics.
- **Preprocessing tab**: imports your own FHIR files (Part 1).
- **Analytics tab**: synthetic data generator, **Population / Batch** selection (view details, use the full population, or delete a population / batch), **Cohort Management**, the Clinical Analytics catalog, Review suggestions and the knowledge graph.
- **Dashboard tab**: runs every analytic for the active cohort and shows the results as one page.

### Cohorts
- **Create Custom Cohort**: name (required), description (optional) and criteria SQL (optional `WHERE` clause, for example `gender = 'female' AND birth_date > '1980-01-01'`). **Build SNOMED CT Query** writes the clause for you (see below).
- **Cohort list**: name, description, Active/Inactive badge, criteria SQL, and Activate / Deactivate / Delete buttons. **Refresh List** reloads it, **Download Cohorts** exports it.
- **One cohort is active at a time.** Activating or creating a cohort switches the previously active one off. Deactivate it to run on all patients in the selected population.
- **Analytics use the active cohort.** *Run*, *Run all*, *Population Health* and the custom analytic all run once, on the active cohort (or on all patients when none is active).
- **Custom analytic in plain English** (Run analytics, below the buttons): type a question, press *Generate query*; the AI writes one read-only `SELECT` over the scoped views (`p, dx, ob, rx, pr, en, al, im, ref`) for the mode selected above, you review / edit it and press *Run this query*; the result goes to the Output like any analytic (table and chart, *Show as* switches between them, "Query used" shows the SQL). The mode is enforced: **V1** text matching only (no code columns, code-like numbers or dates), **V3** codes but no event dates, **V4** codes and dates; a refused query is repaired once automatically, otherwise you are told which rule it broke. It runs on the active cohort. Only the question is sent to the model (audit action `ai.request`), never patient data. Queries run in a `READ ONLY` transaction with a 60 s timeout and a 1000-row cap; keep `REQUIRE_READONLY=true` with the SELECT-only role (`db-readonly.sql`) so the database, not only the checker, enforces read-only.
- **API:** `POST /api/analytics/catalog/run` and `/run-all` run on the active cohort, or on `cohortId` when it is sent, and answer with the usual single-run body.

### Build SNOMED CT Query
Opens from **Create Custom Cohort** (Analytics tab). Three steps in one window:

1. **Prepare dictionary.** Pick the population (the one selected on the page, all batches, or one batch) and tick only the code types you need: Conditions, Procedures, Medications, Allergies, Observations, Immunizations. *Prepare dictionary* reads the distinct codes from the imported batches (code, most common display text, patients, records) and stores them in `snomed_dictionary`. It is built once and reused until you refresh it. Allergy codes come from the stored FHIR JSON because `fhir_allergy` only keeps the display text. Preparing Observations scans every observation row, so it takes longest.
2. **Build the query.** Each rule has *Include* or *Exclude*, a code type, one or more concepts (search by name or code) and a match type: **Exact match**, **Include descendants** (picked concepts and everything more specific) or **Include ancestors** (picked concepts and everything more general). Rules after the first join with **AND** or **OR**, strictly top to bottom: `A AND B OR C` means `(A AND B) OR C`. Each rule shows how many codes it matches in your data before you generate anything.
3. **SQL.** *Generate SQL* gives (a) the **cohort criteria**, a `WHERE` clause for the cohort form (*Apply to cohort criteria* pastes it in, wrapping any existing criteria in parentheses), and (b) a **full query** with one `SELECT ... FROM fhir_patient_<batch>` per batch joined by `UNION ALL`, ready to run in psql. It also reports how many patients match. Descendants and ancestors are expanded to explicit code lists, limited to codes that exist in your data, so the SQL needs no hierarchy table at run time. Excluded sets use `NOT IN (... AND patient_id IS NOT NULL)` so a null id cannot make the exclusion match nobody.

**Hierarchy.** Your FHIR data holds codes but no is-a links, so descendants and ancestors need a source (the *Hierarchy* panel in step 1): the bundled **demo hierarchy** (simplified links for the demo codes only), a SNOMED CT **RF2 relationships** snapshot (active `116680003` is-a rows are kept), an RF2 **descriptions** snapshot for concept names (fully specified names, semantic tag removed), or a **CSV** `child_code,parent_code[,child_name,parent_name]`. Large releases: put the file on the server and use the path box. After loading, prepare the dictionary again: parent concepts that are not coded in the data (for example *Diabetes mellitus*) then appear in search with the patients rolled up from their children. Without links only exact match returns anything, and the preview says so. The links work for any code system, so a CSV can also group RxNorm or LOINC codes.

Routes (`knowledge.js` (snomedQuery)): `GET /api/snomed/status`, `POST /api/snomed/dictionary/build`, `GET /api/snomed/search`, `POST /api/snomed/expand`, `POST /api/snomed/query/build`, `POST /api/snomed/hierarchy/load`, `DELETE /api/snomed/hierarchy`. Tables created on first use: `snomed_isa`, `snomed_concept`, `snomed_dictionary`, `snomed_dictionary_meta`, `snomed_hier_meta` (code links and aggregate counts only, no patient data). The hierarchy path option reads a file on the server, so, like cohort `criteria_sql`, do not expose the app without authentication.

### Technical implementation

#### Backend endpoints (`server.js`)
- `POST /api/init-schema` - create the tables (the SQL lives in one constant, `SCHEMA_SQL`, also used at startup)
- `GET /api/hello`, `GET /api/db-info` - test query and connection details
- `POST /api/import-fhir` - import a bundle into batch-specific tables
- `GET /api/db-overview` - batches, batch groups and record counts
- `DELETE /api/batches/:batchId`, `DELETE /api/batch-groups/:baseName` - remove a batch or a whole group
- `GET /api/cohorts`, `GET /api/cohorts/:id`, `POST /api/cohorts`, `PUT /api/cohorts/:id`, `DELETE /api/cohorts/:id`
- `POST /api/cohorts/:id/activate`, `POST /api/cohorts/:id/deactivate`
- `GET /api/demographics/population-details` - patient count, gender, age, race coverage, record counts and top codes for the active cohort (used by the Python templates)

The clinical analytics, knowledge-graph, concepts, synthetic-data and AI routes are in `analytics.js`, `analytics.js` (analyticsExt) and `evidence.js` (see Part 3). The old `POST /api/analytics/run` and the `/api/demographics/*-distribution` routes were removed; use `/api/analytics/catalog/run` and `/api/analytics/demographics` instead.

### Database schema
`SCHEMA_SQL` in `server.js` creates:
- The standard FHIR tables `fhir_patient`, `fhir_encounter`, `fhir_observation`, `fhir_diagnosis`, `fhir_procedure`, `fhir_immunization`, `fhir_medication`, `fhir_allergy`, with indexes on patient id, code and batch.
- `cohorts`:
  ```sql
  CREATE TABLE IF NOT EXISTS cohorts (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    criteria_sql TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );
  ```
- `pico_templates` (saved PICO/PECO form values), `app_settings` (OpenRouter key and model) and `concept_overrides` (reviewer decisions). None of these hold patient data.

At startup the server also creates and seeds the small `messages` table used by the hello-world check. Imports create the per-batch tables (`fhir_patient_<batch>` and so on).

### Usage flow
1. Open **DB Connect** and click **Start/Initialize DB**; use **Show Database Connection Details** to verify the connection.
2. Get data in: import files on the **Preprocessing** tab, or generate a synthetic batch on the **Analytics** tab.
3. On the **Analytics** tab, pick the **Population / Batch**.
4. Create a cohort and click **Activate** (optional; without one, runs cover the whole population).
5. Run analytics from the **Clinical Analytics** card, or press **Run Analytics** on the **Dashboard** tab.
6. Use Deactivate / Delete to manage the cohort lifecycle.

### Notes
- Cohort `criteria_sql` should be a valid `WHERE` clause for the `fhir_patient` table (conditions on `patient_id`, `gender`, `birth_date` and so on). It is applied to every batch by rewriting the table name for each batch. To filter on other tables use a subquery with the plain table name, for example `patient_id IN (SELECT patient_id FROM fhir_diagnosis WHERE code = '44054006')`; each `fhir_*` name is rewritten per batch.
- Cohort changes and imports clear the cached condition dropdown, so the next run sees the new data.

## Part 3: Clinical analytics catalog (V1 / V3 / V4) and synthetic data

### The three methods
| | Uses | Does not use |
|---|---|---|
| **V1 Text** | narratives (`text.div`), display text, synonyms/abbreviations, simple negation ("denies", "no history of", "family history of") | codes, dates |
| **V3 Codes** | SNOMED CT / LOINC / RxNorm identifiers | dates |
| **V4 Codes + time** | codes plus onset / effective / prescribed / performed / encounter dates | - |

### The 14 analytics
| # | Analytic | V1 (text) | V3 (codes) | V4 (codes + time) |
|---|---|---|---|---|
| 1 | **Demographic distributions** | Gender, age, race, ethnicity for patients whose notes mention a term | Same, for patients carrying a condition code | Same, for *new cases* of a code inside a date window; age measured at the index date; new cases by year and gender |
| 2 | Condition prevalence and incidence | Patients per condition named in text | Patients per condition code | New cases per year, cumulative prevalence, first/last onset |
| 3 | Medication utilization | Drugs named in medication text | Patients and prescriptions per RxNorm code | Prescriptions, patients and new starts per year; exposure span |
| 4 | Lab and vital summary | Test found by name in text | Test found by LOINC code; mean, median, IQR, % abnormal | Yearly trend; per-patient first-vs-last change and % improved |
| 5 | Comorbidity patterns | Condition pairs co-mentioned (lift) | Code pairs (lift) | Ordered pairs: B within N days after A, median gap |
| 6 | Treatment patterns | % with condition on first-line drug named in text | % on first-line drug codes | Time diagnosis to first prescription, % within 30/90/365 d, treated-before-diagnosis |
| 7 | Encounter utilization | Visit type and reasons inferred from text | Encounters, patients, length of stay by class | Yearly volume, ED visits per 1,000, 30-day readmission rate |
| 8 | Chronic disease control | Mean result per patient (condition and test from text) | Mean result per patient (coded) | Latest result in last 12 months, control rate by year, testing interval |
| 9 | Preventive screening / care gaps | Eligible patients with procedure in text | Ever screened (coded) | Screened inside recommended interval, overdue, never screened |
| 10 | Polypharmacy and risky pairs | Distinct drugs per patient from text | Distinct codes; risky pairs ever | Rolling 12-month windows; pairs within 90 days |
| 11 | Allergy profile and conflicts | Allergens in text; penicillin + amoxicillin | Allergen codes, severity, reactions, conflicts (no dates) | New allergies per year; amoxicillin prescribed *after* allergy recorded |
| 12 | Procedure volume | Procedures in text | Procedures per code | Yearly volume, median age at procedure |
| 13 | Multimorbidity burden | Chronic conditions per patient from text | Distinct chronic codes per patient | Accrual by year; time from 1st to 2nd chronic diagnosis |
| 14 | Data quality and completeness | Narrative coverage | Coding coverage, unrecognised code systems | Date completeness, impossible dates, records per year |

### Scope
Every run covers the population picked in **Population / Batch** (single batch, batch group, or all batches), restricted to the **active cohort**; with no active cohort the whole population is used. There is no switch to bypass an active cohort, so deactivate it to analyse everyone. Cohort criteria are applied to every batch the same way as in `GET /api/demographics/population-details`. V4 "as-of" date defaults to the latest date in the data (override with `args.asOf`).

### API
- `GET  /api/analytics/catalog[?batchId=&batchGroup=&cohortId=]` - list with parameters; takes the scope, and the Condition dropdown of *Condition prevalence* and *Demographic distributions* is built from the diagnosis codes in that data (dictionary names where `knowledge.js` (terminology) knows the code), so batches with other code systems work without changes; the cache is cleared after every import, delete and cohort change
- `POST /api/analytics/catalog/run` - `{ id, mode: 'v1'|'v3'|'v4', args, batchId?, batchGroup?, cohortId? }` (the active cohort is always applied; `cohortId` selects a specific cohort instead)
- `POST /api/analytics/catalog/run-all` - `{ mode, ... }` runs every analytic with defaults
- *Learned terms* (`learned_terms`, V3): for diagnosis codes the dictionary does not know, shows the display strings, narrative phrases and suggested V1 search terms learned from the data, plus an `agreement` check (V1 text matching with those terms versus patients carrying the code); circular by design, so keep the hand-written synonyms for any published V1-versus-V3 comparison
- `GET  /api/analytics/demographics?dim=gender|age|race|ethnicity&mode=v1|v3|v4`
- `GET  /api/kg/cohort[?batchId=|batchGroup=][&cohortId=][&pool=25][&maxPatients=250][&gender=][&ageMin=][&ageMax=]` - knowledge graph **built from the data** of the scope (population + active cohort + optional sex / age lens): nodes with patients, prevalence and % abnormal (labs); links with patients, lift, z, Jaccard, P(b|a), P(a|b), which concept usually comes first and the median gap; a `curated` tag where `knowledge.js` (terminology) knows the same link; reference links never seen in the cohort come back with `n = 0`; plus a deterministic patient sample for the projection view
- `GET  /api/kg/neighbors?key=diabetes[&type=...][&direction=out|in|both][&depth=1-6]` - links between conditions, drugs, labs and procedures (static demo relations from `knowledge.js` (terminology), no patient data)
- `GET  /api/concepts?type=dx|ob|rx|pr[&limit=][&batchId=][&batchGroup=][&cohortId=]` - concept inventory built from the imported data: code, code system, most common display, patients, records, first and last seen
- `POST /api/synthetic/generate` - `{ count (1-5000), years (1-20), seed, endDate? }` returns `{ bundle, summary }`; same seed + endDate gives the same bundle

### Reviewer decisions (overrides)
The **Review suggestions** card in the Analytics tab lists what the data suggests (chronic conditions from *Chronic condition candidates*, first-line drugs from *Treatment links*, frequent pairs from *Co-prescription candidates*). **Accept** or **Reject** saves a reviewer decision in the `concept_overrides` table (decisions only, never patient data; the reviewer name is free text because the app has no login). The **Saved decisions** table below it lets you **Edit** (label, note, chronic flag, lab limits) or **Delete** a decision. Priority everywhere is: reviewer decision, then the value derived from the data, then the dictionary in `knowledge.js` (terminology), which is never changed. Decisions act on the chronic lists (Risk stratification, Multimorbidity burden, Readmission drivers), the first-line map (Treatment patterns, Medication sequence), the risky pairs (Polypharmacy, Co-prescription candidates) and lab abnormal limits (Lab ranges from the data, Risk stratification with data ranges), and are used from the next run without a restart. Routes: `GET/POST /api/overrides[?kind=]` and `DELETE /api/overrides/:id` (in `evidence.js`).

### Cohort knowledge graph (Analytics tab)
**Build graph from cohort** reads the patients of the selected *Population / Batch* and the *active cohort* (optionally narrowed by sex and age) and draws what is actually in them: the most frequent conditions, drugs, labs / vitals and procedures as nodes, and a link whenever the same patients have both. Link types are neutral co-occurrence names (condition + condition, condition + drug, ...); lift, z and Jaccard say how far beyond chance, and the order / median gap say which concept is usually recorded first. They are associations in the data, not clinical claims.
- **Manipulate (no refetch):** tick node kinds, link types and evidence (seen here and in the reference graph / seen here only / reference only, drawn dashed); sliders for minimum patients, minimum lift, nodes per kind and strongest links per node; size by patients or % abnormal; colour by kind or community; link width by patients, lift or Jaccard. Click a node for its numbers and strongest links, shift-click to select several, **Focus** for the 1 or 2 link neighbourhood, **Hide**, drag to move and pin nodes, scroll to zoom.
- **Drawing:** the concept graph and the patient projection are drawn on one canvas, so they stay smooth with hundreds of concepts (up to 100 per kind) and thousands of links. Scroll or pinch to zoom, drag the background to pan, double-click empty space to zoom in, **Fit** (or `F`) shows everything, arrow keys pan, `Esc` clears the selection, and the full-screen button gives you the whole screen. A minimap appears once you zoom in; click or drag it to jump. Hover or select a concept and everything not connected to it fades. **Find a concept** (top right of the picture) selects and centres a concept by name. Double-click a node to focus on it. Labels are thinned out so they do not overlap until you zoom in.
- **Views:** *Concept graph*; *Patient projection* (up to 500 sampled patients joined by weighted similarity, rarer concepts weigh more, grouped into clusters with a list of what is typical for each; selected concepts outline the patients who have them); *Matrix* (every concept pair as a heat-map by lift, patients, Jaccard or P(column | row)).
- **Back to cohorts:** a selection becomes a SQL criteria clause (`patient_id IN (SELECT ...)`, joined by AND / OR, labs optionally abnormal-only); **Use as cohort criteria** pastes it into the Create Custom Cohort box (nothing is saved until you create the cohort).
- **Output section:** nothing is added to the Output section automatically. **Add this view to Output** adds the current view with its filters (picture, strongest links, concepts; clusters for the patient projection), like the analytics runs. These runs are included in Download / Upload output.
- **Export:** graph JSON, links CSV, and the picture as a PNG (as it is on screen, concept graph or patient projection). **Add this view to Output** stores the same picture.
- Patients are never shown as names; the projection uses the patient ids already visible in the Preprocessing explorer. Small cohorts (under 30 patients) get a warning because lift is unstable.

### Inpatient trajectory (generator option and analytic)
Tick **Inpatient detail (for trajectory analytics)** in the generator (API option `inpatient`, default off; same seed without it gives the same bundle as before). Hospital stays then carry admit source, a coded principal diagnosis, timestamped in-stay orders, ICU-transfer and rapid-response child encounters and a discharge disposition (`summary.inpatient` counts them). The **Inpatient trajectory** analytic (V4 only, in `analytics.js` (analyticsExt)) follows each stay through nine stages: Comorbidities, Diagnosis, Presentation, Initial plan, Medications, Procedures, Escalation, Advanced/recurrent, Disposition. Sections: `scope`, `nodes` (episodes per value), `ribbons` (episodes moving from one value to the next, top 40 pairs per step), `stage_check`, and `trace` (set `node_stage`, `node`, `direction` to follow one value forward or backward). Batches generated without the option run without error but show mostly `(none)`. In the Analytics tab, **Show trajectory view** draws the nodes and ribbons as a plain SVG: hover for counts, click a node or band to trace it (the form fields are filled and the analytic re-runs), **Clear trace** to reset. Counts only, no patient ids.

### Disease module (diabetes, hypertension)
The **Disease module** analytic (V4 only, in `analytics.js` (analyticsExt)) takes one disease at a time (`disease`: type 2 diabetes or hypertension). *Controlled* = the latest control result in the 12 months before the as-of date is below the goal (HbA1c 7, systolic BP 140); no result in those 12 months = *untested* (a care gap, left out of the rates). The cohort counts equal the matching row of *Guideline adherence*. Sections: `cohort`; `overview` (age, sex, chronic conditions, drugs, ED visits and admissions per 100); one section per **pass** (age band, sex, comorbidity burden, regimen, testing frequency, guideline concordance, payer, income, social needs, adherence tier, CKD stage from eGFR; choose one with `pass`, default all) giving uncontrolled rate, lift over the cohort rate and `low_n` (under 30 tested); `regimen_adjusted` (regimens compared after standardizing by age band x burden); `projection` (pick `age_band` and `burden`: per regimen the matched patients with a Wilson 95% interval, \"too few matched\" under 30 tested); `candidates` (counts by age band of tested Metformin-only patients at or above `threshold`, default 8; no patient ids); `drivers` (single-factor, overlapping, not adjusted). Regimen, adherence, `regimen_adjusted`, `projection` and `candidates` are diabetes-only and left out for hypertension. **Caveats:** the generator links HbA1c to adherence and treatment, so adherence and regimen results restate its assumptions; regimen comparisons are confounded by indication; projection and candidates are associations among matched patients, **not** treatment recommendations. Counts only, no patient ids. A full run rebuilds every pass, so it takes seconds on 400 patients and much longer on thousands.

### Navigation and layout
The tabs follow the workflow: **Connect**, **Import data**, **Analytics**, **Dashboard**, **Notebook**; the two reference pages (**Architecture**, **Capabilities**) sit after a divider at the end. A badge in the header shows whether the database is reachable (click it to re-check). The Analytics page has a section bar (Cohorts, Data generator, Run analytics, Knowledge graph, Output) that scrolls to each part and follows your position.

### Output charts and hide/show
Every result in the **Output** section is drawn as a chart above its table, on by default (plain SVG, no library, client side only in `index.html`). The chart type follows the shape of the section: a year / month column gives a line chart (one line per group, up to 6), a label column with numbers gives horizontal bars (first 15 rows; the table keeps all of them), and an A vs B comparison gives grouped bars. When a section has several numeric columns a dropdown above the chart switches the measure. Kaplan-Meier and the inpatient trajectory view are drawn by default too. Sections with nothing sensible to plot (a single row, free text, ids) show only the table. Each run has **Hide charts** / **Hide tables** buttons, and the Output toolbar has **Hide all charts** / **Hide all tables**; the two kinds are independent, and a run keeps its own setting when the other global button is used.

### Testing
- **`npm test`**: no database needed. Runs the self-tests of `evidence.js` (OpenRouter settings, question parser and explainer, templates, overrides, A vs B comparison), `knowledge.js` (terminology) (knowledge graph), `knowledge.js` (snomedQuery) and `evidence.js` (notebook) (scope resolution, hostile text stays inside its Python string, every code cell parses as Python).
- **`npm run smoke`** (server running, a batch imported; `BASE=http://host:port` to change the address): runs every analytic in every mode it offers, sending each parameter's catalog default (so analytics that need a drug or condition choice run too), then eight value checks that hold on any batch: tier shares add up to 100 (*High utilizers*, *Risk stratification*), the largest group in *Equity check* has ratio 1, the *Disease module* cohort arithmetic and pass totals, the *Disease module* cohort equals the diabetes row of *Guideline adherence*, every *Inpatient trajectory* stage covers all episodes, and the *Kaplan-Meier* curve never rises. A check whose data is missing (for example no inpatient detail) prints `skip`, not a failure. Exit code 1 on any failure.
- **Same seed, same output:** the generator and every analytic are deterministic; generating the same seed and end date twice and running an analytic on each gives identical results (checked for the *Disease module*). Compare only batches generated with the same options (`messy`, `inpatient`).
- A full smoke run takes several minutes on 400 patients because the *Disease module* and *Inpatient trajectory* rebuild their intermediate tables per section.

### Synthetic data design
Clinically correlated, not random: age/sex-dependent chronic disease with comorbidity clustering (obesity -> diabetes, diabetes -> CKD/hypertension), treatment started after diagnosis, HbA1c/BP/LDL that improve after treatment according to a per-patient adherence level, scheduled monitoring, acute episodes with admissions and 30-day readmissions, mammography/colonoscopy screening, penicillin allergies with a small share of prescribing conflicts, deliberate risky drug pairs. Narratives include synonyms, negations ("denies chest pain; no history of ...") and uncoded "probable ..." mentions so V1 visibly differs from V3.

### Verification performed
All 14 analytics x 3 modes ran without SQL errors on a 400-patient / ~40k-resource batch imported through `/api/import-fhir`; cohort scoping, batch-group scoping, parameter variants, `asOf` override, error responses and injection-style inputs were exercised; the UI was exercised in jsdom with no script errors.

### Caveats
- Codes in `knowledge.js` (terminology) are representative demo codes; validate against a terminology server before real use.
- Cohort `criteria_sql` is executed as raw SQL (existing design); do not expose this app without authentication.
- Import runs one INSERT per resource (about 25 s per 1,000 synthetic patients).

## Part 4: Extended Analytics (Python / Jupyter) - hidden

**This feature is hidden in the app.** For free-hand analysis use **Run analytics > Custom analytic in plain English**: an LLM writes one read-only query for the selected mode, you review it, and it runs as fixed SQL (deterministic once written, with the SQL shown in the Output). The notes below apply only if you re-enable the notebook feature (`ENABLE_NOTEBOOK=true` and remove the hiding CSS rule).

The **Extended Analytics** tab generates a notebook for the data you are looking at, so anything the UI does not offer can be done in code.

### Using it
1. **Choose what to analyse**: population / batch, cohort (active, none, a saved one, **from the SNOMED builder**, or custom `WHERE` criteria) and the recipes to include. In **Build SNOMED CT Query**, press **Use in Python** to send the query here.
2. **Download notebook (.ipynb)**, or **Preview cells to copy** one by one.
3. Install once: `pip install pandas sqlalchemy psycopg2-binary matplotlib jupyterlab` (recipes also need `lifelines scikit-learn networkx`).
4. Set the password in the terminal, then start Jupyter where the notebook is: `export DB_PASSWORD=...` (PowerShell: `$env:DB_PASSWORD="..."`), `jupyter lab`. Without it the notebook asks. `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` override the defaults taken from the app.
5. **Run All Cells.** Change `CRITERIA_SQL` in the *Scope* cell and re-run from there to switch cohort.

### What the notebook contains
- **Read me first**, **Connection** (read-only session, 5-minute statement timeout, password never stored), **Scope** (`BATCHES`, `CRITERIA_SQL`; the cohort clause is rewritten per batch exactly like the app) and **Load** (`patients, encounters, observations, diagnoses, medications, procedures, allergies, immunizations`; a patient present in several batches counts once).
- **Get to know the data**: inventory, code systems, date ranges and completeness, demographics, top codes with names, and how V1 / V3 / V4 look in code.
- **SNOMED builder query**: `SNOMED_FULL_QUERY` loads the builder's full query as a DataFrame; the builder's cohort criteria can be used as `CRITERIA_SQL`.
- **Recipes** (each independent, parameters on its first lines): encounter volume / ED rate / length of stay, lab trend, comorbidity network, Kaplan-Meier with log-rank by sex, 30-day readmission model. The model recipe is a teaching example, not a validated risk score, and stops with a message when there are too few discharges.

### Routes (`evidence.js` (notebook))
`GET /api/notebook/recipes`; `POST /api/notebook/preview` and `POST /api/notebook/download` with `{ batchId | batchGroup, cohortMode: 'active'|'none'|'id'|'snomed'|'custom', cohortId, criteriaSql, snomedQuery, recipes[] }`. User text (criteria, queries, batch names) is written into the notebook only as JSON-escaped Python string literals.

### Caveats
- Notebooks read patient-level data and saved outputs can contain it; clear outputs before sharing. Cohort criteria are raw SQL (existing design), so keep the database behind authentication.
- A notebook is a snapshot of the scope at generation time: if a batch is deleted or renamed, generate it again.
- Checked on synthetic data: the generated notebook runs without errors, and its patient count matches the app for a cohort with a sub-query across two batches and for a SNOMED builder query.

## Fetch from HAPI FHIR server (Analytics tab)
Open **Fetch from HAPI FHIR server**, choose how many patients (default 25, up to 2,000), name the batch and press **Fetch & Import as Batch**. The public HAPI test server (`https://hapi.fhir.org/baseR4`) is open: no client id or access token. The first N patients are read, then for each patient its Conditions, Observations, MedicationRequests (the referenced Medication is folded in so the drug code is kept), Encounters, Procedures, AllergyIntolerances and Immunizations (paged, 4 patients at a time, retries on 429 / 5xx), and imported in chunks of 5,000 resources through `/api/import-fhir`. The result is an ordinary batch: select it in **Population / Batch**. Fetching again into the same batch name updates records by resource id. HAPI is a shared test server: never send real patient data to it, and its patients vary widely in how much data they hold (use **Analytics readiness** to see what you got). Set `EHR_BASE_URL` in `.env` to point at another open FHIR server. Routes: `GET /api/ehr/info`, `POST /api/ehr/test`, `POST /api/ehr/fetch`, `GET /api/ehr/jobs/:id`, `POST /api/ehr/jobs/:id/cancel`.

## Analytics readiness (Analytics tab, before "Run analytics")
**Check data profile** (fast) shows, for the selected Population / Batch and active cohort, records and patients per resource type with the share that is coded, dated and has narrative text, the date range and plain-language insights. **Check all analytics** then runs every analytic in each version it has (V1 text, V3 codes, V4 codes + time) once with default settings (3 at a time, 120 s limit each) and labels each cell: *Runnable* (rows returned), *No rows* (ran, nothing found), *Needs a choice* (wants a condition or drug), *Error* or *Too slow*. For every cell that is not runnable the reasons come from the profile (for example no medication records, only 20% of medications dated, few narratives for V1). Insights summarise the best-fitting version, the most common blockers and failures, and the slowest analytics; **Download JSON** saves everything. "Runnable" means rows came back, not that the numbers are meaningful; the which-data-an-analytic-needs guess is based on its name and category. A run that exceeds the time limit is reported as too slow but may keep running in the database until it ends. Routes: `POST /api/readiness/profile`, `POST /api/readiness/check`, `GET /api/readiness/jobs/:id`, `POST /api/readiness/jobs/:id/cancel`.

## Import password

Anything that adds data to the database (`POST /api/import-fhir`, `/api/init-schema`, `/api/ehr/fetch`, `/api/snomed/hierarchy/load`) is locked. Set `IMPORT_PASSWORD` in `.env` (on Render: an environment variable) and restart. Without it every import is refused with HTTP 503. The browser asks for the password once per tab and sends it in the `X-Import-Password` header; 10 wrong attempts from one address lock it for 5 minutes. Reading and analytics are not affected.

## Sign-in and roles

The whole app is behind a login. Anonymous visitors are sent to `/login`, and every `/api/*` call without a session is answered with HTTP 401 before its body is read.

**First admin.** Add to `.env` (on Render: environment variables) and restart:

```
ADMIN_EMAIL=you@example.org
ADMIN_PASSWORD=at-least-12-characters
```

The account is created on start if that email has none. Without any user, nobody can sign in (a warning is logged). **Locked out?** Set `ADMIN_RESET_PASSWORD=true` together with the two variables above, restart once, then remove it: the password is reset and all sessions of that admin are ended.

**How it works.** Passwords are stored as scrypt hashes in the `users` table. A sign-in creates a row in `sessions` (only the SHA-256 of the token is stored) and an `HttpOnly`, `SameSite=Lax` cookie (`Secure` over HTTPS; on Render it is detected). Sessions last 12 hours (`SESSION_HOURS`). 8 wrong passwords from one address for one email block that pair for 15 minutes. State-changing requests whose `Origin` is another site are refused. The FHIR connector's loopback import still works (it uses its per-process token for `/api/import-fhir` only). The import password (above) stays as a second lock on imports.

Routes: `GET /login`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/change-password`.

**Roles.** Today there is one role, `admin`, with every permission. Roles live in the `ROLES` table at the top of `security.js` (auth); `users.role` holds the name, and a user whose role is not in the table has no access. To add a role later: add an entry to `ROLES` with its permissions, and (optionally) list the routes it may not use in `ROUTE_PERMISSIONS`, for example `['POST', /^\/api\/import-fhir$/, 'data:import']`. Routes not listed need only `app:access`. User management (creating more users from the UI) is not built yet.

`AUTH_DISABLED=true` turns the gate off for local development only; it is ignored when `NODE_ENV=production`.

## Audit log

Admin-only **Audit log** tab (and `GET /api/audit`) showing who did what, when, from which IP, and whether it worked.

**Recorded** (standard level): sign-in events (success, failure with reason, blocked, sign-out, password change, first-admin creation / reset); every data-changing request (FHIR import, schema init, EHR fetch, batch / batch-group delete, cohort create / update / delete / activate, overrides, templates, LLM settings, synthetic data, terminology load, notebook download); reads of **patient-level data** (patient explorer list and record, with the patient id from the query string, and the cohort graph's patient sample); every request that sends text or statistics to an **external AI model** (`/api/ai/*`, `/api/pico/*`); refused requests (HTTP 403, and anonymous attempts on the routes above); the audit log's own export and verify; server starts. Analytics runs, readiness checks and previews are not logged one by one. Set `AUDIT_LEVEL=verbose` to record every other `/api/` request too.

**Never stored:** request bodies, passwords, API keys, tokens, cookies. Only a short whitelist of fields (batch id, batch group, cohort id, name, counts, number of resources in an import) and, for patient-data reads, the query string.

**Tamper evidence.** The `audit_log` table is append-only: a database trigger refuses `UPDATE`, `DELETE` and `TRUNCATE`. Each row also stores the SHA-256 of the previous row's hash plus its own fields, so **Verify integrity** (`GET /api/audit/verify`) finds an edited or removed row and names the first bad entry. A database superuser can disable the trigger and rewrite the whole chain, so this makes tampering visible, not impossible. Verify returns the newest entry's hash: write it down somewhere outside the database (or ship the CSV export to separate storage) if you also need to detect deletion of the newest entries. There is no retention purge; the table only grows (about one row per write action).

**Reliability.** Events are queued and written in order after the response is sent, so a slow database does not slow requests. If the database is down an event is lost and an error is logged; the queue holds 2,000 events. On SIGTERM / SIGINT the queue is flushed first (5 seconds at most).

**Viewing.** Filters: date range, person, action (prefix, e.g. `phi.`), outcome, free-text search. Newest first, 100 per page. **Export CSV** applies the same filters (up to 100,000 rows; cells starting with `=`, `+`, `-` or `@` are prefixed so spreadsheets do not run them as formulas). Routes: `GET /api/audit`, `/api/audit/facets`, `/api/audit/export.csv`, `/api/audit/verify`. They need the permission `audit:read` (admin has every permission; for a future role, grant it explicitly in `ROLES`).


## Data-use and read-only safeguards

**Data-use notice.** Only import data that is consented, de-identified and ethically approved (IRB / ethics committee or equivalent). The Import data tab shows this notice and keeps "Extract and normalize" disabled until the confirmation box is ticked; the EHR "Fetch & Import" button checks the same box.

**Read-only SQL.** Cohort criteria are raw SQL, so they are protected twice:

1. `security.js` (sqlGuard) accepts only a single read-only WHERE expression (no `;`, comments, DDL / writes, file or sleep functions, or the `users` / `sessions` / `audit_log` / `app_settings` tables). It runs when a cohort is saved and again every time stored criteria are used.
2. Cohort SQL, analytics, the knowledge graph, readiness and the patient explorer run on a separate **SELECT-only database connection**. Create the role with `db-readonly.sql`, then set:

```
DATABASE_READONLY_URL=postgres://vibe_readonly:<password>@<host>:5432/<db>
REQUIRE_READONLY=true      # refuse to start if that connection could write
```

Without `DATABASE_READONLY_URL` the app falls back to the read/write connection and logs `READ-ONLY CHECK FAILED` at start-up. Imports, schema set-up, cohort bookkeeping, sign-in and the audit log still use the normal `DATABASE_URL`.

**Notebook (hidden).** The Notebook tab, its panel and the "Use in Python" shortcut of the SNOMED builder are hidden, and `/api/notebook/*` is not registered unless `ENABLE_NOTEBOOK=true` is set. The code is still in `index.html` and `evidence.js` (notebook); to bring the feature back, set that variable and delete the one CSS rule marked "Notebook feature is hidden" in `index.html`.
