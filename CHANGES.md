# Changes: Chunk 1 (remove disease module)

Deleted:
- diseases.js (disease profile validator and its /api/diseases routes; it was not loaded by server.js)

Edited:
- analytics.js: removed the "Disease module" analytic (id disease_module), its DISEASES list and all dm*/DM_* helpers; fixed two comments
- evidence.js: removed the 3 Disease module value checks from the smoke run
- index.html: removed disease_module from the Dashboard groups; removed its mention in the Capabilities text
- README.md: removed the Disease module section and mentions; value checks now "five"

Kept on purpose:
- drop-disease-tables.sql (lets users drop old disease_profiles / department_profiles tables)
- "By disease" plan tab in Custom analytics (replaced in Chunk 5)

Tests passed: knowledge, analytics, evidence, synthetic, research (node <file>.js --selftest)
Not run: smoke test (needs a running server and a database)

---

# Changes: Chunk 2 (save and open sessions in the database)

## 2A: sessions table and API
Edited:
- server.js: new table saved_sessions (id, name, owner_id, owner, payload JSONB, created_at, updated_at) in SCHEMA_SQL, so startup and /api/init-schema both create it; new routes GET/POST /api/sessions and GET/PUT/DELETE /api/sessions/:id, owner-only; payload capped at 100 MB in the handler
- security.js: 'saved_sessions' added to the SQL guard forbidden list so custom SQL cannot read other users' sessions

The table is named saved_sessions because `sessions` already holds sign-in tokens.
Tests: node security.js --selftest passes; routes checked with an in-memory Postgres emulator. Not run against real PostgreSQL.

## 2B: frontend saves to the API
Edited:
- index.html: "Save session" (anSessionSave) now reads existing names from GET /api/sessions, then POSTs a new session or PUTs over a same-named one. The saved payload has the same shape as before (runs, steps, decisions, cohort, population, counts). New helper ansApi(). Status text now says "to the database". Also the Capabilities sentence no longer mentions the disease module (Chunk 1).
Note: "Open saved session" and Delete still read IndexedDB until 2C, so sessions saved from 2B on will not appear in the Open panel until 2C is done.
Tests: all inline scripts in index.html pass a syntax check; re-running the patch is refused. Not tested in a browser.

## 2C: open, list, delete from the database; IndexedDB removed
Edited:
- index.html: the Open saved session panel lists from GET /api/sessions, opens through new anSessionOpenById() (GET /api/sessions/:id, then the existing anSessionOpen), and deletes with DELETE /api/sessions/:id. Removed all IndexedDB code (ANS, ansDb, ansTx, ansAll). Button tooltips and panel text now say the database.
- server.js: GET /api/sessions also returns run_count, step_count, cohort and population (read from the payload) so the list rows look as before.
Not done: the optional "import my old browser sessions" button (sessions saved in the old IndexedDB are not migrated).
Tests: node --check server.js; all inline scripts in index.html pass a syntax check; routes re-checked with the in-memory Postgres emulator. Not tested in a browser or real PostgreSQL.

New database table: saved_sessions (created automatically at startup)
New environment variables: none
Deleted files: none (see Chunk 1 above)

# Chunk 3A (drilldown data from custom run)

Edited:
- analytics.js: POST /api/analytics/custom/run accepts optional `drilldown: true`. The response then has a top-level `drilldown` field with the patient_ids behind each count (capped at 500 per group, `truncated` flag, max 200 groups). Runs a read-only companion query through the same SQL guard, inside the same read-only transaction (savepoint, so a failure never breaks the main result). Selftest extended.
- PROGRESS.md: added.

# Chunk 3B (drilldown toggle and copy for custom results)

Edited:
- index.html: "Drill-down mode" checkbox at the top of the Output section (default off). When on, custom-query runs send `drilldown: true`; each result gets an expandable list of case IDs per group with "Copy (one per line)" and "Copy (comma separated)". Off = output unchanged.
