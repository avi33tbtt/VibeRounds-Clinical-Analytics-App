# Vibe Rounds

One README for the whole project (it replaces README_FEATURES.md, README_ANALYTICS.md and README_CLINICAL_ANALYTICS.md).

## Files
| File | Role |
|---|---|
| `server.js` | Express app, FHIR import, schema, cohorts; registers `analytics.js`, `evidence.js` (`registerAi`), `knowledge.js`, `security.js` |
| `population.js` | Population keys (`batch:<suffix>` / `group:<base>`): which batches a cohort's population covers, shared by every module |
| `security.js` | Sign-in, audit log and the read-only SQL guard in one file (sections `sqlGuard`, `auth`, `audit`; replaces `sql-guard.js`, `auth.js`, `audit.js`) |
| `analytics.js` | The analytics engine and everything it registers (sections `customAnalytic`, `readiness`, `analyticsExt`, then the engine; replaces `analytics-ext.js`, `custom-analytic.js`, `readiness.js`). `register(app, pool)` is the file's export |
| `knowledge.js` | Terminology and data-source sections (`terminology`, `snomedQuery`, `kgCohort`, `fhirConnect`; replaces `knowledge.js` (terminology section), `snomed-query.js`, `kg-cohort.js`, `fhir-connect.js`) |
| `evidence.js` | Phase 4 tools in one file: OpenRouter settings and test, plain-English question parser, suggested PICO/PECO studies (`POST /api/pico/suggest`) and result explainer, saved PICO/PECO templates, A vs B comparison. Self-test: `node evidence.js --selftest`; smoke test: `node evidence.js --smoke`; also holds the Patient data explorer (`patientExplorer`) |
| `pathways.js` | Care pathways (`/api/pathways`) and the whole-cohort Patient trajectory (`/api/trajectory/cohort`): one engine, two starts (a diagnosis, or each patient's first dated record) |
| `synthetic.js` | Deterministic FHIR R4 generator (`generateBundle`) |
| `index.html` | The whole UI. Tabs: Database, Import data, Analytics (cohorts, catalog, generator, HAPI fetch, readiness, patient data explorer, PICO/PECO tools, AI settings, cohort knowledge graph), Dashboard, and the guide tabs Architecture, Capabilities and About |
| `db-readonly.sql` | Creates the SELECT-only database role used for cohort SQL and all analytics (run once as the database owner; see Data-use and read-only safeguards) |
| `e2e-cohort-binding.js` | End-to-end check of cohort-to-population binding: `BASE=http://localhost:3055 DATABASE_URL=postgres://localhost/appdb node e2e-cohort-binding.js` (needs the server running with sign-in off, the same database, and the demo batches; not part of `npm test`) |
| `evidence.js --e2e-enrichment` | End-to-end check of the whole enrichment flow against a running server (coverage, approve / edit / reject / bulk approve, V2 vs V3, compare modes, reviewer-vs-AI agreement): `BASE=http://localhost:3055 DATABASE_URL=postgres://localhost/appdb node evidence.js --e2e-enrichment`. Seeds and removes its own batch `enrflow`. Needs the server running with sign-in off (`AUTH_DISABLED=true`) or `COOKIE=...`, against the same database; not part of `npm test` |
| `e2e-enrichment-dx.js`, `e2e-enrichment-all.js` | Real-database checks of the enrichment join (conditions, then medications, labs, procedures, allergies, immunizations): `DATABASE_URL=postgres://localhost/vr_enrich_test node e2e-enrichment-all.js`. Create their own `*_t1` / `*_t2` tables; not part of `npm test` |
| `login.html` | Sign-in page. Public on purpose: the gate in `security.js` redirects every other page to it, so the app itself is never sent to someone who is not signed in. Do not merge it into `index.html` |

Shortcuts: `npm test` runs the self-tests of `population.js` and of every section in `security.js`, `knowledge.js`, `analytics.js` and `evidence.js` (each file also runs alone: `node security.js --selftest`); `npm run smoke` runs the smoke test (server must be running, data imported).

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
- **A cohort is bound to one population.** Creating a cohort requires a Population / Batch (a batch, or a whole group); it is saved as `batch:<suffix>` or `group:<base>` and cannot be changed afterwards. The explorer, knowledge graph, analytics and dashboard always use the active cohort's own population, whatever the dropdown shows (the dropdown then only chooses the population for a *new* cohort). Deleting a population (or the last batch of one) deletes the cohorts bound to it; the confirmation lists them. A cohort whose population is missing, or that was saved before binding existed, is shown as **orphaned**: it cannot be activated until you press *Assign selected population* or delete it. Matching rules live in `population.js`.
- **One cohort is active at a time.** Activating or creating a cohort switches the previously active one off. Deactivate it to run on all patients in the selected population.
- **Analytics use the active cohort.** *Run*, *Run all*, *Population Health* and the custom analytic all run once, on the active cohort (or on all patients when none is active).
- **Custom analytic in plain English** (Run analytics, below the buttons): type a question, press *Generate query*; the AI writes one read-only `SELECT` over the scoped views (`p, dx, ob, rx, pr, en, al, im, ref`) for the mode selected above, you review / edit it and press *Run this query*; the result goes to the Output like any analytic (table and chart, *Show as* switches between them, "Query used" shows the SQL). The mode is enforced: **V1** text matching only (no code columns, code-like numbers or dates), **V2** codes but no event dates, **V4** codes and dates (V3 and V5 are not offered here: the custom query runs on the plain scoped views, without the enrichment join); a refused query is repaired once automatically, otherwise you are told which rule it broke. It runs on the active cohort. Only the question is sent to the model (audit action `ai.request`), never patient data. Queries run in a `READ ONLY` transaction with a 60 s timeout and a 1000-row cap; keep `REQUIRE_READONLY=true` with the SELECT-only role (`db-readonly.sql`) so the database, not only the checker, enforces read-only.
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
- `GET /api/demographics/population-details` - patient count, gender, age, race coverage, record counts and top codes for the active cohort

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
    population_scope VARCHAR(255),   -- batch:<suffix> or group:<base>
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );
  ```
- `pico_templates` (saved PICO/PECO form values), `app_settings` (OpenRouter key and model) and `concept_overrides` (reviewer decisions). None of these hold patient data.

`security.js` creates `users`, `sessions` and `audit_log` on first start (see Sign-in and Audit log). The SELECT-only role cannot read `users`, `sessions`, `audit_log` or `app_settings`.

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

## Part 3: Clinical analytics catalog (five modes, V1 to V5) and synthetic data

### The five modes
All five are available. V3 and V5 add approved *enrichment* codes for text that has no source code (see "Code enrichment workflow" below). Internally the analytic definitions keep three functions (`v1`, `v3`, `v4`); a map `FN = { v1:'v1', v2:'v3', v3:'v3', v4:'v4', v5:'v4' }` in `analytics.js` picks the one a mode runs, so V3 is the V2 function and V5 the V4 function with enrichment joined into the scoped views.

| | Uses | Does not use |
|---|---|---|
| **V1 Text** | narratives (`text.div`), display text, synonyms/abbreviations, simple negation ("denies", "no history of", "family history of") | codes, dates |
| **V2 Codes** | SNOMED CT / LOINC / RxNorm identifiers from the source data (this was called V3 before the rename; it runs the same code) | dates |
| **V3 Enriched codes** | V2 plus approved enrichment codes for records that have text but no source code | dates |
| **V4 Codes + time** | codes plus onset / effective / prescribed / performed / encounter dates | - |
| **V5 Enriched codes + time** | V4 plus approved enrichment codes; helps only records that already have a date, because enrichment adds codes, never dates | - |

Source codes always win over enriched ones. A run without a `mode` uses V2. Saved values `v3` from before the rename are read as V2 in the interface and the custom query (from version 2 on, `v3` means enriched codes). V3 / V5 take an `enrich` option: a list of domains (`dx`, `rx`, `ob`, `pr`, `al`, `im`) or `'all'`; the default is `['dx']`, and `[]` makes V3 identical to V2 and V5 to V4. V1, V2 and V4 ignore it.

### The 14 analytics
| # | Analytic | V1 (text) | V2 (codes) | V4 (codes + time) |
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
Every run covers the population picked in **Population / Batch** (single batch, batch group, or all batches), restricted to the **active cohort**; with no active cohort the whole population is used. There is no switch to bypass an active cohort, so deactivate it to analyse everyone. Cohort criteria are applied to every batch the same way as in `GET /api/demographics/population-details`. V4 (and later V5) "as-of" date defaults to the latest date in the data (override with `args.asOf`).

### API
- `GET  /api/analytics/catalog[?batchId=&batchGroup=&cohortId=]` - list with parameters; takes the scope, and the Condition dropdown of *Condition prevalence* and *Demographic distributions* is built from the diagnosis codes in that data (dictionary names where `knowledge.js` (terminology) knows the code), so batches with other code systems work without changes; the cache is cleared after every import, delete and cohort change
- `POST /api/analytics/catalog/run` - `{ id, mode: 'v1'|'v2'|'v3'|'v4'|'v5' (default 'v2'), args, enrich?, batchId?, batchGroup?, cohortId? }` (the active cohort is always applied; `cohortId` selects a specific cohort instead). A V3 / V5 result reports `scope.enrich`: the domains joined, the version (latest review time of those domains, part of the cache key) and, per domain, the records coded by source and by approved enrichment and the uncoded strings nobody has reviewed yet; the interface shows this as a banner above the result
- `POST /api/analytics/catalog/compare-modes` - `{ id, pair: 'v2v3'|'v4v5', args?, enrich?, batchId?, batchGroup?, cohortId? }` runs the same analytic without (A) and with (B) approved enrichment on one scope and returns both runs and the row-by-row difference (same shape as the A vs B scope comparison). The *Compare V2 / V3* and *Compare V4 / V5* buttons use it
- `POST /api/analytics/catalog/compare` - the same analytic and mode on scope A versus scope B
- `POST /api/analytics/catalog/run-all` - `{ mode, ... }` runs every analytic with defaults
- *Learned terms* (`learned_terms`, V2 only): for diagnosis codes the dictionary does not know, shows the display strings, narrative phrases and suggested V1 search terms learned from the data, plus an `agreement` check (V1 text matching with those terms versus patients carrying the code); circular by design, so keep the hand-written synonyms for any published V1-versus-V2 comparison
- `GET  /api/analytics/demographics?dim=gender|age|race|ethnicity&mode=v1|v2|v4`
- `GET  /api/kg/cohort[?batchId=|batchGroup=][&cohortId=][&pool=25][&maxPatients=250][&gender=][&ageMin=][&ageMax=]` - knowledge graph **built from the data** of the scope (population + active cohort + optional sex / age lens): nodes with patients, prevalence and % abnormal (labs); links with patients, lift, z, Jaccard, P(b|a), P(a|b), which concept usually comes first and the median gap; a `curated` tag where `knowledge.js` (terminology) knows the same link; reference links never seen in the cohort come back with `n = 0`; plus a deterministic patient sample for the projection view
- `GET  /api/pathways[?batchId=|batchGroup=][&cohortId=][&index=<condition key or code>][&depth=5][&perKind=6][&kinds=condition,encounter,lab,procedure,medication][&loops=1][&gender=][&ageMin=][&ageMax=][&minCell=5][&drugDays=90][&monitorDays=365]` - **observed care pathway** after one diagnosis, built from the data of the scope: boxes and links (patients, median days between steps, drop-off), the most common routes with crude outcomes (died / admitted / admitted twice or more), and expected-versus-observed steps from the reference links in `terminology.js`. Groups under `minCell` patients (never below `PATHWAY_MIN_CELL`, default 5) are hidden
- `GET  /api/pathways/patients?<same parameters>&node=<id>` or `&from=<id>&to=<id>` - the patients (max 200) in one box or on one link of that diagram; only boxes / links the diagram shows can be listed. Audited as a PHI list read
- `GET  /api/kg/neighbors?key=diabetes[&type=...][&direction=out|in|both][&depth=1-6]` - links between conditions, drugs, labs and procedures (static demo relations from `knowledge.js` (terminology), no patient data)
- `GET  /api/concepts?type=dx|ob|rx|pr[&limit=][&batchId=][&batchGroup=][&cohortId=]` - concept inventory built from the imported data: code, code system, most common display, patients, records, first and last seen
- `POST /api/synthetic/generate` - `{ count (1-5000), years (1-20), seed, endDate? }` returns `{ bundle, summary }`; same seed + endDate gives the same bundle

### Reviewer decisions (overrides)
The **Review suggestions** card in the Analytics tab lists what the data suggests (chronic conditions from *Chronic condition candidates*, first-line drugs from *Treatment links*, frequent pairs from *Co-prescription candidates*). **Accept** or **Reject** saves a reviewer decision in the `concept_overrides` table (decisions only, never patient data; the reviewer name is typed in and required, 1 to 60 characters, stored as `reviewed_by`). The **Saved decisions** table below it lets you **Edit** (label, note, chronic flag, lab limits) or **Delete** a decision. Priority everywhere is: reviewer decision, then the value derived from the data, then the dictionary in `knowledge.js` (terminology), which is never changed. Decisions act on the chronic lists (Risk stratification, Multimorbidity burden, Readmission drivers), the first-line map (Treatment patterns, Medication sequence), the risky pairs (Polypharmacy, Co-prescription candidates) and lab abnormal limits (Lab ranges from the data, Risk stratification with data ranges), and are used from the next run without a restart. Routes: `GET/POST /api/overrides[?kind=]` and `DELETE /api/overrides/:id` (in `evidence.js`).

### AI researcher (Analytics tab)
An optional, automated loop in the collapsed **AI researcher** section of the Analytics tab. It needs the OpenRouter key and model set under AI settings.
- **Start:** choose the number of rounds (1 to 20, default 3) and how to start: with the analytic currently selected in *Run analytics*, or with a plain-English question (the AI writes one read-only query for the selected mode, as in *Custom analytic in plain English*). **Activate (start from beginning)** clears the log; **Continue from where it ended** runs further rounds from the AI's last suggestion; **Stop after this step** ends it cleanly.
- **Each round:** run the analytic on the selected *Population / Batch* and the *active cohort* (the cohort's own population wins, as everywhere); ask the model for an insight on the result (`POST /api/ai/insights`); ask for suggested next analytics (`POST /api/ai/next-steps`); write a short summary; run the top suggestion as the next round. A suggestion is either a catalog analytic with its settings or a plain-English question. Suggestions already tried are not repeated.
- **Review of AI-written queries:** *Pause to review (and edit) the query* is on by default for a starting question. For plain-English questions the AI suggests in later rounds the box is off by default, so tick *Pause to review ... as a later round* if you want to see each query before it runs. The query guards of the custom analytic always apply (mode rules, `READ ONLY` transaction, 60 s timeout, 1000-row cap, SELECT-only connection).
- **What is sent to the model:** the same as for the assistant (result tables with patient-id columns removed and large tables cut), and for a plain-English question only the question. Every `/api/ai/*` request is written to the audit log.
- **Output:** each round's analytic result goes to the Output section like a normal run, and the round's insight, suggestions and summary are added below it (text only). Treat the path it followed as leads to check, not findings.

### Care pathways (Analytics tab)

An interactive flow diagram (Sankey) of what the patients of the current scope went through after one diagnosis. Pick the diagnosis (default: the most common one), and the app follows each patient's first drug, lab, procedure, admission / ED visit and other diagnoses in date order for up to 8 steps.

- **Band width** = patients, **days on a band** = median time between two steps, **red bands** = patients with no further recorded care (drop-off).
- **Click a box or a band** to see its patients' outcomes compared with everyone, where they came from, what happens next, and to **list the patients**; a row opens the patient in the Patient data explorer.
- **Most common routes** with crude outcomes; hovering a row lights the route in the diagram.
- **Expected versus observed**: treatment drugs, monitoring labs and screening that `terminology.js` links to the diagnosis (`treated_by`, `monitored_by`, `screened_by`) with the share of patients who had them within a window you set. These links are demo reference data, not a clinical guideline: check them before relying on the gaps.
- Computed on the read-only connection from the cohort's own population; nothing is stored. Groups under 5 patients are hidden (server-enforced). Outcomes are crude and unadjusted.
- **Add this view to Output** keeps the diagram (still interactive: hover, click to highlight), the routes and the expected-versus-observed table, with the current filters, as a run in the Output section. Only the aggregated numbers already on screen are saved, never patient ids.

### Patient trajectory (Analytics tab)

An interactive flow diagram (Sankey) of the **whole cohort**: every patient of the current scope (Population / Batch + active cohort, optional sex / age lens) from their first dated record onwards. It is the same engine and drawing as *Care pathways*, with a different start: day 0 is each patient's first dated record of any kind (diagnosis, lab, drug, procedure or encounter), so there is no diagnosis to pick. The app then follows the first time each diagnosis, admission / ED visit, lab, procedure and drug happens, in date order, for up to 8 steps.

- **Read it:** band width = patients, days on a band = median time between two steps, grey-red bands = patients with no further recorded care. Hover for numbers.
- **Click a box or a band** to compare its patients with the whole cohort (died, admitted, admitted twice or more; red = higher, green = lower), see where they came from and what happens next, and **list the patients**; a row opens the patient in the Patient data explorer (the single-patient timeline lives there).
- **Include:** diagnoses, admissions / ED visits, procedures and drugs are on by default; labs / vitals are off by default because routine vitals are recorded for almost everyone and would fill the first steps (day 0 still counts them). *Count every admission / ED visit* shows readmission loops.
- **Most common routes** with crude outcomes; hovering a row lights the route in the diagram.
- Computed on the read-only connection; nothing is stored. Groups under 5 patients are hidden (server-enforced, `PATHWAY_MIN_CELL`). Outcomes are crude and unadjusted.
- **Add this view to Output** keeps the diagram (still interactive), the routes and the filters as a run. Only the aggregated numbers already on screen are saved, never patient ids, so the run is included in Download / Upload output.
- Routes (`pathways.js`): `GET /api/trajectory/cohort` (same parameters as `/api/pathways` without `index`, `drugDays` and `monitorDays`; answers with the same shape, `mode: 'cohort'`, no expected-versus-observed) and `GET /api/trajectory/cohort/patients?...&node=<id>` or `&from=<id>&to=<id>`. The patient list is audited as a PHI list read (`phi.pathway_patients`).


### Cohort knowledge graph (Analytics tab)
**Build graph from cohort** reads the patients of the selected *Population / Batch* and the *active cohort* (optionally narrowed by sex and age) and draws what is actually in them: the most frequent conditions, drugs, labs / vitals and procedures as nodes, and a link whenever the same patients have both. Link types are neutral co-occurrence names (condition + condition, condition + drug, ...); lift, z and Jaccard say how far beyond chance, and the order / median gap say which concept is usually recorded first. They are associations in the data, not clinical claims.
- **Manipulate (no refetch):** tick node kinds, link types and evidence (seen here and in the reference graph / seen here only / reference only, drawn dashed); sliders for minimum patients, minimum lift, nodes per kind and strongest links per node; size by patients or % abnormal; colour by kind or community; link width by patients, lift or Jaccard. Click a node for its numbers and strongest links, shift-click to select several, **Focus** for the 1 or 2 link neighbourhood, **Hide**, drag to move and pin nodes, scroll to zoom.
- **Drawing:** the concept graph and the patient projection are drawn on one canvas, so they stay smooth with hundreds of concepts (up to 100 per kind) and thousands of links. Scroll or pinch to zoom, drag the background to pan, double-click empty space to zoom in, **Fit** (or `F`) shows everything, arrow keys pan, `Esc` clears the selection, and the full-screen button gives you the whole screen. A minimap appears once you zoom in; click or drag it to jump. Hover or select a concept and everything not connected to it fades. **Find a concept** (top right of the picture) selects and centres a concept by name. Double-click a node to focus on it. Labels are thinned out so they do not overlap until you zoom in.
- **Views:** *Concept graph*; *Patient projection* (up to 500 sampled patients joined by weighted similarity, rarer concepts weigh more, grouped into clusters with a list of what is typical for each; selected concepts outline the patients who have them); *Matrix* (every concept pair as a heat-map by lift, patients, Jaccard or P(column | row)).
- **Back to cohorts:** a selection becomes a SQL criteria clause (`patient_id IN (SELECT ...)`, joined by AND / OR, labs optionally abnormal-only); **Use as cohort criteria** pastes it into the Create Custom Cohort box (nothing is saved until you create the cohort).
- **Output section:** nothing is added to the Output section automatically. **Add this view to Output** adds the current view with its filters (picture, strongest links, concepts; clusters for the patient projection), like the analytics runs. These runs are included in Download / Upload output.
- **Export:** graph JSON, links CSV, and the picture as a PNG (as it is on screen, concept graph or patient projection). **Add this view to Output** stores the same picture.
- Patients are never shown as names; the projection uses the patient ids already visible in the Preprocessing explorer. Small cohorts (under 30 patients) get a warning because lift is unstable.

#### Care stages view (Patient trajectory)
Switch **View** to **Care stages (9 columns)** to follow one chosen diagnosis instead of the whole cohort. Every patient with that diagnosis (day 0 = first onset date) is placed in nine columns with the same names as the Inpatient trajectory analytic, but counted **per patient**, not per inpatient episode: **Comorbidities** (every other diagnosis of the patient, any date), **Diagnosis** (the chosen one), **Presentation** (first visit or admission within the look-ahead window; admit source when known), **Initial plan** (procedure and / or medication in the first 2 days, else observation only), **Medications** and **Procedures** (each distinct drug / procedure in the look-ahead window), **Escalation** (ICU transfer, rapid response call, or none), **Advanced/recurrent** (readmitted within 30 days, prolonged stay of N days or more, both, or neither) and **Disposition** (discharge disposition of the last completed stay, else Died when the patient is deceased, else none). A missing value is `(none)`, so every column covers every patient.
- Controls: Diagnosis (default: the most common one), Look ahead (90 days to 5 years, default 1 year), Prolonged stay from N days (3-60, default 7), Values kept per stage (the most common comorbidities / drugs / procedures are named, the rest are grouped as *Other (less common)*), sex / age lens and the minimum group size (never below `PATHWAY_MIN_CELL`, default 5).
- Reading it: box height = patients (one scale for all columns); band thickness = patients going from one box to the next (top 40 bands per step). Columns 1, 5 and 6 hold several values per patient, so their shares can add up to more than 100. Click a box to light up the boxes it connects to and list what comes before and after it. **Add this view to Output** stores a static copy (counts only, no patient ids).
- Route (`pathways.js`): `GET /api/trajectory/stages?index=<code or key>&horizon=&longStay=&perKind=&gender=&ageMin=&ageMax=&minCell=` plus the usual scope parameters. It answers `{ scope, index, indexOptions, params, patients, stages, nodes, ribbons, detail, notes }`. Aggregates only; boxes and bands under the minimum are never returned. Access-audited like `/api/trajectory/cohort`.
- Escalation, Advanced/recurrent and Disposition come from inpatient stays, so they are mostly `(none)` / `None` / `Neither` in batches generated without **Inpatient detail (for trajectory analytics)**; the notes under the diagram say so when fewer than a tenth of the patients have a completed stay. No patient list yet (a later step).

### Inpatient trajectory (generator option and analytic)
Tick **Inpatient detail (for trajectory analytics)** in the generator (API option `inpatient`, default off; same seed without it gives the same bundle as before). Hospital stays then carry admit source, a coded principal diagnosis, timestamped in-stay orders, ICU-transfer and rapid-response child encounters and a discharge disposition (`summary.inpatient` counts them). The **Inpatient trajectory** analytic (V4 only, in `analytics.js` (analyticsExt)) follows each stay through nine stages: Comorbidities, Diagnosis, Presentation, Initial plan, Medications, Procedures, Escalation, Advanced/recurrent, Disposition. Sections: `scope`, `nodes` (episodes per value), `ribbons` (episodes moving from one value to the next, top 40 pairs per step), `stage_check`, and `trace` (set `node_stage`, `node`, `direction` to follow one value forward or backward). Batches generated without the option run without error but show mostly `(none)`. In the Analytics tab, **Show trajectory view** draws the nodes and ribbons as a plain SVG: hover for counts, click a node or band to trace it (the form fields are filled and the analytic re-runs), **Clear trace** to reset. Counts only, no patient ids.

### Disease module (diabetes, hypertension)
The **Disease module** analytic (V4 only, in `analytics.js` (analyticsExt)) takes one disease at a time (`disease`: type 2 diabetes or hypertension). *Controlled* = the latest control result in the 12 months before the as-of date is below the goal (HbA1c 7, systolic BP 140); no result in those 12 months = *untested* (a care gap, left out of the rates). The cohort counts equal the matching row of *Guideline adherence*. Sections: `cohort`; `overview` (age, sex, chronic conditions, drugs, ED visits and admissions per 100); one section per **pass** (age band, sex, comorbidity burden, regimen, testing frequency, guideline concordance, payer, income, social needs, adherence tier, CKD stage from eGFR; choose one with `pass`, default all) giving uncontrolled rate, lift over the cohort rate and `low_n` (under 30 tested); `regimen_adjusted` (regimens compared after standardizing by age band x burden); `projection` (pick `age_band` and `burden`: per regimen the matched patients with a Wilson 95% interval, \"too few matched\" under 30 tested); `candidates` (counts by age band of tested Metformin-only patients at or above `threshold`, default 8; no patient ids); `drivers` (single-factor, overlapping, not adjusted). Regimen, adherence, `regimen_adjusted`, `projection` and `candidates` are diabetes-only and left out for hypertension. **Caveats:** the generator links HbA1c to adherence and treatment, so adherence and regimen results restate its assumptions; regimen comparisons are confounded by indication; projection and candidates are associations among matched patients, **not** treatment recommendations. Counts only, no patient ids. A full run rebuilds every pass, so it takes seconds on 400 patients and much longer on thousands.

### Navigation and layout
The tabs follow the workflow: **Connect**, **Import data**, **Analytics**, **Dashboard**, **Research**; the two reference pages (**Architecture**, **Capabilities**) sit after a divider at the end. A badge in the header shows whether the database is reachable (click it to re-check). The Analytics page has a section bar (Cohorts, Data generator, Run analytics, Knowledge graph, Output) that scrolls to each part and follows your position.

The **Research** tab shows a profile of the active cohort's data (`GET /api/demographics/population-details`) and a list of standard study designs; each opens an existing analytic in Analytics (treatment comparison and exposure-outcome studies, time to event, pathways, readmission risk, control of chronic disease). Designs the app cannot run yet are listed as not available. Below them, **AI study plans** (`POST /api/research/plan`, needs the OpenRouter key and model under AI settings; audited as `ai.request`) asks the model for up to three plans of up to five steps built from those templates. The model sees only the allowed condition and drug keys with patient counts, never rows. The server rebuilds every step from the fixed templates (`research.js`), clamps numbers, and drops steps whose codes no patient in the active cohort has; the dropped steps are listed. **Run this plan** then calls `POST /api/research/run-step` once per step (the same checks again, then the normal V4 analytic on the active cohort), shows each result as it arrives, can be stopped, and the collected results download as JSON. Each step has an **Insights (AI)** button and the results have **Insights on all output (AI)**; both call the same `POST /api/ai/insights` as the Analytics tab (tables only, capped rows). The four sections (Your data, Study templates, AI study plans, Results) are collapsible.

### Output charts and hide/show
Every result in the **Output** section is drawn as a chart above its table, on by default (plain SVG, no library, client side only in `index.html`). The chart type follows the shape of the section: a year / month column gives a line chart (one line per group, up to 6), a label column with numbers gives horizontal bars (first 15 rows; the table keeps all of them), and an A vs B comparison gives grouped bars. When a section has several numeric columns a dropdown above the chart switches the measure. Kaplan-Meier and the inpatient trajectory view are drawn by default too. Sections with nothing sensible to plot (a single row, free text, ids) show only the table. Each run has **Hide charts** / **Hide tables** buttons, and the Output toolbar has **Hide all charts** / **Hide all tables**; the two kinds are independent, and a run keeps its own setting when the other global button is used.

### Testing
- **`e2e-cohort-binding.js`** (server running on port 3055 with sign-in off, `DATABASE_URL` pointing at the server's database, demo batches `demo_0`, `demo_1` and `solo` imported): checks that a cohort cannot be created without a population, the binding cannot be changed, the active cohort overrides the dropdown in the explorer, knowledge graph and analytics, orphaned cohorts cannot be activated until rebound, and deleting a batch or group removes exactly the cohorts bound to it. It deletes those batches and cohorts as it runs, so use a throwaway database.
- **`npm test`**: no database needed. Includes the mode-dispatch self-test in `analytics.js` (the five modes and the `FN` map; every analytic offers V3 exactly where it offers V2 and V5 exactly where it offers V4; parameter modes stay consistent; `run()` defaults to V2, runs the old V3 function for V2 and V3 and the V4 function for V4 and V5, refuses unknown modes with 400 before any analytic runs; the enrichment join SQL, the enrichment review and agreement queries and the mode comparison are checked against recording pools). Runs the self-tests of `evidence.js` (OpenRouter settings, question parser and explainer, templates, overrides, A vs B comparison), `knowledge.js` (terminology) (knowledge graph), and `knowledge.js` (snomedQuery).
- **`npm run smoke`** (server running, a batch imported; `BASE=http://host:port` to change the address): runs every analytic in every mode it offers, sending each parameter's catalog default (so analytics that need a drug or condition choice run too), then eight mode checks (the catalog offers V3 exactly where it offers V2 and V5 exactly where it offers V4; V3 and V5 run and report their enrichment scope; an unknown enrich domain and an unknown mode are refused; no mode means V2; the V2 / V3 comparison answers; the agreement report answers) and eight value checks that hold on any batch: tier shares add up to 100 (*High utilizers*, *Risk stratification*), the largest group in *Equity check* has ratio 1, the *Disease module* cohort arithmetic and pass totals, the *Disease module* cohort equals the diabetes row of *Guideline adherence*, every *Inpatient trajectory* stage covers all episodes, and the *Kaplan-Meier* curve never rises. A check whose data is missing (for example no inpatient detail) prints `skip`, not a failure. Exit code 1 on any failure.
- **Same seed, same output:** the generator and every analytic are deterministic; generating the same seed and end date twice and running an analytic on each gives identical results (checked for the *Disease module*). Compare only batches generated with the same options (`messy`, `inpatient`).
- A full smoke run takes several minutes on 400 patients because the *Disease module* and *Inpatient trajectory* rebuild their intermediate tables per section.

### Code enrichment workflow (V3 / V5)
Records that carry only text (a diagnosis "sugar diabetes" with no code) are invisible to the code-based modes. Enrichment gives such text a code, once per distinct string, with a person in the loop. Distinct strings are coded, not records, and a decision is global: one per (domain, text_key) for all batches.
1. **Coverage** (`GET /api/enrichment/coverage`, Enrichment panel *Load strings*): the distinct uncoded strings of a domain, sorted by record count, with the share of records coded by source, by approved enrichment and still uncoded.
2. **Candidates** (`POST /api/enrichment/candidates { domain, strings }`, up to 100 strings): real codes from the reference tables (the bundled dictionary, `snomed_dictionary` and `snomed_concept` for conditions and procedures), up to 8 per string with system, code, display and a match score. A string with no candidate is marked `unverified`. Only strings come in; parameterized queries only.
3. **Proposals** (`POST /api/enrichment/propose { domain, strings | topN }`, *Propose codes with AI*): the model you configured only *chooses* among the candidates, with a confidence, an assertion (`confirmed`, `suspected`, `negated`) and a short reason, about 50 strings per request. A pick that is not among the candidates is ignored; system and display always come from the candidate. Rows are stored as `proposed` with `model` and `prompt_version`; they count nowhere. Only strings and candidate codes are sent (audit action `ai.request`), never patient data, ids or dates.
4. **Review** (Enrichment panel): *Approve* a proposal, *Edit* it with a code you search for, or *Reject* it (`PUT /api/enrichment/:domain/:key`, audit `enrichment.review`). *Bulk approve* (`POST /api/enrichment/bulk-approve`, audit `enrichment.bulk_approve`) approves every still-proposed, `confirmed` row of the domain at or above a confidence of 0.5 to 1; suspected and negated rows always need a person. The reviewer is the signed-in user, the time is the server clock.
5. **Use**: V3 and V5 join approved or edited, `confirmed` rows to records that have **no** source code (`code_source = 'enriched'`; records with a source code keep it, `code_source = 'source'`). The next V3 / V5 run already uses a decision, because the cache is cleared after every change. Suspected and negated rows are stored but never counted.
6. **Compare** (*Compare V2 / V3*, *Compare V4 / V5*): the same analytic without and with enrichment, side by side with the difference. If every difference is zero the interface says so: either nothing was enriched in that scope or the enriched strings do not matter for that analytic.
7. **Check the AI** (*Reviewer vs AI agreement*, `GET /api/enrichment/agreement?domain=dx|...|all[&list=0-200]`): over the strings a person decided one by one, how often the reviewer kept the model's code. Outcomes: *agree* (approved, or edited to the same code), *changed* (edited to another code), *rejected* (the model had a code, the reviewer refused it), *coded by reviewer* (the model had none) and *both none* (the model had none and the reviewer rejected); agreement = (agree + both none) / reviewed. The report is split by the model's confidence (90% or more, 70% to under 90%, under 70%, no pick) and lists the differences, most confident model picks first, so you can choose a sensible bulk-approve confidence. It is a sample of what was reviewed, not of all strings: bulk approvals (a threshold, not a second opinion) and still-waiting proposals are reported separately and not counted, and a high rate on a few strings is a weak guide.

The model's own pick is kept in `llm_pick` (system, code, display, assertion, confidence) the first time a reviewer acts on a `proposed` row, so an edit or a rejection does not erase it; `bulk_approved` marks bulk approvals. Both columns are added at startup (`ADD COLUMN IF NOT EXISTS`); rows decided before that have no recorded pick and are listed as "decided before the AI's pick was recorded".

Rules in one place: source codes always win; each view carries `code_source`; only approved / edited rows with `assertion = 'confirmed'` count; enrichment adds codes, not dates, so V5 helps only records that already have a date; V2 and V4 never read `code_enrichment`; a missing `code_enrichment` table means no enrichment, not an error; the cache key includes the mode, the `enrich` list and the latest review time of the joined domains.

### Code enrichment storage
Table `code_enrichment` is created at startup (`CREATE TABLE IF NOT EXISTS`, so existing databases get it on the next start). One row per (`domain`, `text_key`), unique. Checks: `domain` dx / rx / ob / pr / al / im; `status` proposed / approved / edited / rejected; `assertion` confirmed / suspected / negated; `confidence` 0 to 1; an approved or edited row must have `system`, `code`, `reviewed_by` and `reviewed_at`. The read-only role (`db-readonly.sql`) can SELECT it but not write it; custom-query SQL cannot name it (use the scoped views). Audit actions: `enrichment.review` (PUT one string, target = domain), `enrichment.bulk_approve`, and `ai.request` for `POST /api/enrichment/propose`; `POST /api/enrichment/candidates` is not audited. 
**Coverage endpoint:** `GET /api/enrichment/coverage?domain=dx|rx|ob|pr|al|im[&only=uncoded|all][&limit=200][&offset=0][&batchId=|batchGroup=][&cohortId=]` (same scope rules as the analytics: the active cohort's population wins). It returns `totals` (records, patients, `coded_by_source`, `coded_by_enrichment`, `still_uncoded`, `uncoded_without_text`, the three percentages) and `strings`: one entry per distinct `text_key` with `records`, `patients`, `source_coded_records`, `uncoded_records`, `has_source_code` and the stored `enrichment` (status, assertion, code, confidence) or `null`. By default only strings that still have uncoded records are listed, sorted by uncoded records; `only=all` lists every string. Only strings and counts are returned, never patient ids. Only approved or edited, confirmed rows with a code count as `coded_by_enrichment`. If `code_enrichment` does not exist yet the endpoint still answers, with no enrichment.

**Text key** (shared with the V3 / V5 join, `normText` / `normSql` in `analytics.js`): the record's own name, lower-cased, trimmed, white space collapsed, at most 500 characters. Name per domain: dx / ob / pr `code.text`, else the first coding's display; rx the medication text, else display, else the medication reference; al the `substance`, else `code.text` / display; im `vaccineCode.text`, else display. A record counts as source-coded when it has a non-empty code (for allergies, the first coding's code).

### Uncoded data (generator option, for trying code enrichment)
The **Codes** selector in the generator (API option `uncoded`: `none` (default), `partial` or `all`; the default gives the same bundle as before) removes the codes of the six enrichment domains (conditions, medications, labs, procedures, allergies, immunizations) after everything else, including *Messy data*, and leaves only free text: a synonym such as "sugar diabetes", "htn" or "a1c", sometimes in capitals or with stray spaces. Narratives, values, units and dates are kept, so V1 is unchanged while V2 / V4 lose those records and V3 / V5 can win them back through *Code enrichment*. **Fully uncoded** strips every record. **Partly uncoded** strips a share that depends on the domain (about 35% of conditions, 25% of medications, 15% of labs, 40% of procedures, 50% of allergies, 20% of immunizations) and on the patient: about one patient in five comes from a "non-coding site" with a much higher rate. The rates are the generator's own assumptions, not observed data. The result summary reports the records and uncoded records per domain. Same seed and options give the same bundle.

### Synthetic data design
Clinically correlated, not random: age/sex-dependent chronic disease with comorbidity clustering (obesity -> diabetes, diabetes -> CKD/hypertension), treatment started after diagnosis, HbA1c/BP/LDL that improve after treatment according to a per-patient adherence level, scheduled monitoring, acute episodes with admissions and 30-day readmissions, mammography/colonoscopy screening, penicillin allergies with a small share of prescribing conflicts, deliberate risky drug pairs. Narratives include synonyms, negations ("denies chest pain; no history of ...") and uncoded "probable ..." mentions so V1 visibly differs from V2.

### Verification performed
All 14 analytics x 3 modes (V1, V2, V4) ran without SQL errors on a 400-patient / ~40k-resource batch imported through `/api/import-fhir`; cohort scoping, batch-group scoping, parameter variants, `asOf` override, error responses and injection-style inputs were exercised; the UI was exercised in jsdom with no script errors.

### Caveats
- Codes in `knowledge.js` (terminology) are representative demo codes; validate against a terminology server before real use.
- Cohort `criteria_sql` is executed as raw SQL (existing design); do not expose this app without authentication.
- Import runs one INSERT per resource (about 25 s per 1,000 synthetic patients).

## Fetch from HAPI FHIR server (Analytics tab)
Open **Fetch from HAPI FHIR server**, choose how many patients (default 25, up to 2,000), name the batch and press **Fetch & Import as Batch**. The public HAPI test server (`https://hapi.fhir.org/baseR4`) is open: no client id or access token. The first N patients are read, then for each patient its Conditions, Observations, MedicationRequests (the referenced Medication is folded in so the drug code is kept), Encounters, Procedures, AllergyIntolerances and Immunizations (paged, 4 patients at a time, retries on 429 / 5xx), and imported in chunks of 5,000 resources through `/api/import-fhir`. The result is an ordinary batch: select it in **Population / Batch**. Fetching again into the same batch name updates records by resource id. HAPI is a shared test server: never send real patient data to it, and its patients vary widely in how much data they hold (use **Analytics readiness** to see what you got). Set `EHR_BASE_URL` in `.env` to point at another open FHIR server. Routes: `GET /api/ehr/info`, `POST /api/ehr/test`, `POST /api/ehr/fetch`, `GET /api/ehr/jobs/:id`, `POST /api/ehr/jobs/:id/cancel`.

## Analytics readiness (Analytics tab, before "Run analytics")
**Check data profile** (fast) shows, for the selected Population / Batch and active cohort, records and patients per resource type with the share that is coded, dated and has narrative text, the date range and plain-language insights. **Check all analytics** then runs every analytic in each version it has (V1 text, V2 codes, V3 enriched codes, V4 codes + time, V5 enriched codes + time; V3 / V5 use the domains ticked under *Enrich*, default conditions) once with default settings (3 at a time, 120 s limit each) and labels each cell: *Runnable* (rows returned), *No rows* (ran, nothing found), *Needs a choice* (wants a condition or drug), *Error* or *Too slow*. For every cell that is not runnable the reasons come from the profile (for example no medication records, only 20% of medications dated, few narratives for V1); for V3 / V5 a domain outside the enrichment scope is named ("medications are not in the enrichment scope") and a thinly coded domain says that enrichment adds only approved codes. Insights summarise the best-fitting version, the most common blockers and failures, and the slowest analytics; **Download JSON** saves everything. "Runnable" means rows came back, not that the numbers are meaningful; the which-data-an-analytic-needs guess is based on its name and category. A run that exceeds the time limit is reported as too slow but may keep running in the database until it ends. Routes: `POST /api/readiness/profile`, `POST /api/readiness/check`, `GET /api/readiness/jobs/:id`, `POST /api/readiness/jobs/:id/cancel`.

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

**Recorded** (standard level): sign-in events (success, failure with reason, blocked, sign-out, password change, first-admin creation / reset); every data-changing request (FHIR import, schema init, EHR fetch, batch / batch-group delete, cohort create / update / delete / activate, overrides, templates, LLM settings, synthetic data, terminology load); reads of **patient-level data** (patient explorer list and record, with the patient id from the query string, and the cohort graph's patient sample); every request that sends text or statistics to an **external AI model** (`/api/ai/*`, `/api/pico/*`); refused requests (HTTP 403, and anonymous attempts on the routes above); the audit log's own export and verify; server starts. Analytics runs, readiness checks and previews are not logged one by one. Set `AUDIT_LEVEL=verbose` to record every other `/api/` request too.

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

