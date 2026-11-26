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

# Chunk 3C-4 (drill-down for equity check, region x payer mix, treatment patterns)

Catalog drill-down (3C) finds case IDs by rewriting a section's top-level `count(...)` SQL. Sections that count inside a CTE or a UNION could not be rewritten and showed "not available". 3C-4 adds a per-section hook for those.

Edited:
- analytics.js:
  - `S(name, title, sql, drill)` takes an optional 4th argument `{ keys, sql }`: the columns that identify a row, and a companion query (own parameter list) returning those columns plus `__dd_ids` and `__dd_n`. `DD_AGG()` builds the ID aggregate (capped at 500, same as custom runs).
  - `runSections` uses the hook when a section has one; a hook that throws only makes that section "not available". `drilldownMatch` matches on `keys` when given.
  - Drill-down added to: Equity check (V2 and V4: patients per group), Region x payer mix (V2: patients per state and payer), Treatment patterns (V1, V2 and V4 "by drug": patients per drug, plus the "ANY first-line drug" row in V1 and V2).
  - Selftest extended: hook ID count equals the displayed count, empty group, failing hook.
- No change to index.html: it already renders any section that reports drill-down.

Result (mock-pool audit of all 38 catalog analytics, 250 sections): 191 sections now have case IDs (was 182).
Left without case IDs on purpose (they are not counts of patients per group): 48 V4/V5 statistical tables (rates, curves, rankings, ratios), 8 summary tables with no FROM-level grouping, and 3 record-level coverage tables in Data quality (counts of records, not patients).
Tests: node analytics.js --selftest, knowledge, evidence, security selftests pass. Not run against real PostgreSQL or in a browser.
New database tables: none. New environment variables: none. Deleted files: none.

# Chunk 3D (keep drill-down state in sessions)

Edited:
- index.html:
  - A saved session now records the Drill-down toggle (`payload.drilldown.on`). Opening a session sets the toggle (and its checkbox) back; sessions saved before 3D have no such field and open with it off.
  - The case IDs themselves were already stored inside each saved run (the run result carries them), so nothing extra is fetched or stored for them. When a saved session or an uploaded output file is opened, the "Drill-down: case IDs by group" box (expandable groups, Copy buttons) is now drawn again for every result that has IDs.
Not changed: no server or database change (the payload is JSONB). Output JSON downloads do not store the toggle; their case IDs still show when the file is uploaded.
Tests: all 19 inline scripts in index.html pass a syntax check; the import path was checked with a small harness (re-attach called only for results). Not tested in a browser. Please try: turn drill-down on, run a custom query and one catalog analytic, Save session, clear the page, Open the session: the toggle is on and the case ID lists are back.
New database tables: none. New environment variables: none. Deleted files: none.

# Chunk 4A (custom analytics chat endpoint)

New route: `POST /api/analytics/custom/chat  { messages: [{ role: 'user' | 'assistant', content }], mode, intent: 'query' | 'plan' }`
- Uses the same model settings and key as generate/plan (`getConfig`, `askModel`); the key stays on the server. The server keeps no chat: the client sends the whole conversation each time (max 20 messages, 600 characters per user message, 12,000 in all; the last message must be from the user).
- `intent: 'query'` returns the same `{ title, explanation, sql, model }` as `/generate`, using the conversation as context. The query is checked exactly like a free-hand query, with one automatic repair, else HTTP 422.
- `intent: 'plan'` returns `{ reply, proposal: { title, explanation, sql } | null, note }`. A proposed query is only passed on if it passes the same checks (one repair); otherwise it is dropped, `proposal` is null and `note` says why, and the reply is still returned.
- The model is told the views (p, dx, ob, rx, pr, en, al, im, ref) with their columns, the rules of the chosen mode, and (V2/V4) the known codes. User turns are passed to the model as quoted data.
Edited:
- analytics.js: system prompt split into `querySystem(mode, format)` (generate unchanged); new `cleanChat`, `buildChatMessages`, `parsePlanReply`; the new route; selftests (validation, both intents, repair, dropped proposal, bad input never reaches the model).
- security.js: the chat route is audit-logged as `ai.request` (external), like generate.
Not changed: index.html (the chat screen is 4B), database, environment variables.
Tests: node analytics.js --selftest and node security.js --selftest pass. Not run against a real model or server. Try with curl once signed in, for example:
  curl -b cookies.txt -H 'content-type: application/json' -d '{"mode":"v1","intent":"plan","messages":[{"role":"user","content":"What can I ask about asthma?"}]}' http://localhost:PORT/api/analytics/custom/chat
Note: /custom/plan is not in the ai.request audit rule (only generate was); worth adding later.
