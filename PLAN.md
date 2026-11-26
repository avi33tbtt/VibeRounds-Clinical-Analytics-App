# VibeRounds Clinical Analytics App: Implementation Plan (small chunks)

Repo: https://github.com/avi33tbtt/VibeRounds-Clinical-Analytics-App

Each chunk below is sized to fit in **one short Claude session** so you do not hit free-plan limits. Do them **in order**, one per session.

---

## What the repo looks like (so you don't waste tokens exploring)

Plain Node/Express app, PostgreSQL via `pg`, no build step. 28 files, about 31k lines.

| File | Size | What it does |
|---|---|---|
| `index.html` | ~11,000 lines | Entire frontend (HTML + JS). **Never open it whole.** Use `grep -n` and `sed -n 'START,ENDp'` on small ranges. |
| `analytics.js` | ~3,700 lines | Catalog analytics + custom analytics endpoints (`/api/analytics/custom/generate`, `/plan`, `/examples`, `/run`) |
| `server.js` | ~1,460 lines | Express server, DB pools, cohorts API, FHIR import |
| `diseases.js` | ~1,800 lines | Disease profile validator (pure functions, requires `knowledge.js`) |
| `knowledge.js`, `evidence.js`, `research.js`, `terminology.js`, `synthetic.js` | | Mention diseases in places |
| `drop-disease-tables.sql` | | SQL related to disease tables |
| `security.js` | ~1,100 lines | Auth, audit log, SQL guard |

Useful landmarks found in the code:
- Disease analytic in catalog: `analytics.js` around line 2099 (`const DISEASES = {`) and the `disease` select around line 2348.
- "By disease" tab in Custom analytics: `index.html` around line 2978 (`data-tab="disease"`); handlers around lines 8105 to 8210 (`CUSTOM_EX`, `customLoadExamples`, `customExample`).
- Examples and plan ideas come from `GET /api/analytics/custom/examples` (`analytics.js` ~line 304: `EXAMPLES`, `DISEASE_IDEAS`, `DEPARTMENT_IDEAS`), and plans from `POST /api/analytics/custom/plan` (~line 280).
- Browser-saved sessions: `index.html` around lines 7819 to 7900 (`const ANS = { DB: 'vibe-rounds-sessions' ...}`, IndexedDB).
- Output section: `index.html` around line 3552 (`id="outputSection"`); several `renderOutput` functions around lines 9997, 10336, 10564, 10626, plus `renderPaginatedResults` ~4775.
- Query tables available to custom SQL: `p`, `dx`, `ob`, `rx`, `pr`, `en`, `al`, `im`, each with `patient_id` (this is the "case id" for drill-down).
- Tests: `npm test` runs the `--selftest` of several files. Run only the relevant one after a small change, for example `node analytics.js --selftest`.

---

## Rules to save your free limit

1. **One chunk per chat.** Start a new chat for each chunk and paste the "Prompt" line for it.
2. Upload or paste only what the chunk needs. Do not paste whole files.
3. Ask Claude to **show a diff or only changed functions**, not rewritten files.
4. After each chunk: run the quick test given, then commit.
5. If a chunk is still too big, stop at a natural point, commit, write what's left in `PROGRESS.md`, and continue in a new chat.
6. Keep a `PROGRESS.md` in the repo root (see template at the end) so every new chat can start from it.

---

## Step 0: Setup (about 5 minutes, no coding)

```bash
git clone https://github.com/avi33tbtt/VibeRounds-Clinical-Analytics-App.git
cd VibeRounds-Clinical-Analytics-App
git checkout -b feature/analytics-improvements
git rev-parse HEAD > ../base_commit.txt      # used for the final zip
npm install
```
Create `PROGRESS.md` from the template at the bottom. Confirm the app starts (`npm start`, needs PostgreSQL and a `.env`).

---

## Chunk 1: Remove the disease module (3 small parts)

> **Confirm first:** this plan assumes "disease module" means `diseases.js` plus the "Disease" analytic in the catalog (`analytics.js`). It does **not** remove the "By disease" plan tab yet, because Chunk 5 replaces it with runnable examples. If you meant something else, adjust 1A before starting.

### 1A. Find references only (no edits)
Prompt: *"List every reference to diseases.js, the DISEASES object, the Disease analytic, and drop-disease-tables.sql across the repo with file and line numbers. Do not change anything. Tell me what is safe to delete and what other code depends on it."*
Output: a short list saved into `PROGRESS.md`.

### 1B. Remove backend code
- Delete `diseases.js`.
- Remove the Disease analytic and `DISEASES` object from `analytics.js` (around lines 2099 to 2350), and any entries in the catalog list.
- Clean disease-profile references in `knowledge.js`, `evidence.js`, `research.js`, `terminology.js`, `synthetic.js` only if they import the deleted module or break.
- Decide what to do with `drop-disease-tables.sql` (keep if users still need it to drop old tables, otherwise delete).
- Test: `node analytics.js --selftest` and `node knowledge.js --selftest`.
- Commit: `chunk 1B: remove disease module backend`

### 1C. Remove frontend and docs references
- In `index.html`, remove the Disease analytic UI and any leftover calls (grep for `disease`, about 26 hits; leave the "By disease" tab alone).
- Update `README.md` and `about.html` mentions.
- Test: start the app, open each tab, check the browser console for errors.
- Commit: `chunk 1C: remove disease module UI and docs`

---

## Chunk 2: Save and open sessions in the database (3 small parts)

### 2A. Database table and API (backend only)
- Add a `sessions` table created by the existing schema/init code in `server.js` (see `/api/init-schema`). Fields: `id`, `name`, `created_at`, `updated_at`, `owner` (from the sign-in in `security.js`), `payload` (JSONB: output, settings, query).
- Add endpoints in `server.js`, using the read/write `pool`: `GET /api/sessions`, `GET /api/sessions/:id`, `POST /api/sessions`, `PUT /api/sessions/:id`, `DELETE /api/sessions/:id`. Only the owner can access their sessions.
- Raise the JSON size limit only for this route if needed.
- Test with `curl` (or a small selftest).
- Commit: `chunk 2A: sessions table and API`

### 2B. Frontend: save to the API
- In `index.html` (lines ~7819 to 7900), change "Save session" to `POST`/`PUT` to `/api/sessions` instead of writing IndexedDB.
- Keep the saved payload identical in shape, so opening still works.
- Commit: `chunk 2B: save sessions to database`

### 2C. Frontend: open, list, delete, cleanup
- Change "Open saved session" to list from `GET /api/sessions` and restore from `GET /api/sessions/:id`. Add delete.
- Remove the IndexedDB code (`ANS.DB`, `ANS.STORE`).
- Optional: one-time "import my old browser sessions" button.
- Test: save, clear browser data, reopen from another browser.
- Commit: `chunk 2C: open sessions from database, remove IndexedDB`

---

## Chunk 3: Drill-down mode with case IDs (4 small parts)

### 3A. Backend: return case IDs for custom query results
- In `analytics.js`, the `/api/analytics/custom/run` handler (~line 330) returns grouped counts. Add an optional `drilldown: true` flag that also returns, for each group, the list of `patient_id`s (IDs only, capped, with a `truncated` flag).
- Approach: where the SQL is a count by group, run a companion query using `array_agg(DISTINCT patient_id)` per group. Keep it inside the existing SQL guard and read-only pool.
- Test: `node analytics.js --selftest`; add one assertion that the ID count equals the displayed count.
- Commit: `chunk 3A: drilldown data from custom run`

### 3B. Frontend: toggle plus ID list for custom results
- Add an on/off toggle (default off) at the top of `#outputSection` (`index.html` ~line 3552).
- When on, each subgroup count becomes expandable, showing its case IDs and a **Copy** button (copy as newline or comma separated).
- When off, output is unchanged.
- Commit: `chunk 3B: drilldown toggle and copy for custom results`

### 3C. Extend to catalog analytics (do 2 or 3 analytics per session)
- The catalog results render through several `renderOutput` functions (~lines 9997, 10336, 10564, 10626) and `renderPaginatedResults` (~4775).
- Session 1: list which catalog analytics produce grouped counts. Add drilldown support for the first 2 or 3.
- Next sessions: the remaining ones, same pattern.
- Commit after each batch: `chunk 3C-n: drilldown for <analytics names>`

### 3D. Save the toggle with the session
- Include the toggle state (and fetched IDs) in the session payload from Chunk 2.
- Commit: `chunk 3D: keep drilldown state in sessions`

---

## Chunk 4: Chat interface for English Custom analytics (4 small parts)

Current flow: `index.html` Custom analytics has tabs `ask`, `disease`, `department`, `examples` (~line 2978), calling `/api/analytics/custom/generate` and `/api/analytics/custom/plan`.

### 4A. Backend: chat endpoint
- Add `POST /api/analytics/custom/chat` in `analytics.js`, taking `{ messages, mode, intent }` where `intent` is `query` or `plan`. Reuse the same LLM client and settings that `generate` and `plan` use. Keep keys server-side.
- `query` intent returns the same `{ title, explanation, sql }` as `generate`.
- `plan` intent returns a conversational reply plus an optional proposed question or SQL.
- Give the model the table list (`p, dx, ob, rx, pr, en, al, im`) so suggestions use real fields.
- Test with `curl`; add a selftest case.
- Commit: `chunk 4A: custom analytics chat endpoint`

### 4B. Frontend: chat shell and "run query" mode
- Replace the `ask` panel input with a chat view: message list, input box, Enter to send, loading indicator.
- In query mode, a message calls the chat endpoint, shows the generated SQL for review (as today), and the existing run button runs it.
- Commit: `chunk 4B: chat UI for custom analytics query`

### 4C. Frontend: "help me plan" mode
- Add a mode switch (Run query / Help me plan) above the input.
- In plan mode, show assistant suggestions and a **Use this query** button that moves the proposed query into the query editor.
- Commit: `chunk 4C: planning assistant in chat`

### 4D. Keep chat history
- Keep history for the current page session and save it in the session payload (Chunk 2).
- Commit: `chunk 4D: chat history in sessions`

---

## Chunk 5: Runnable disease example queries (4 small parts)

Problem today: the "By disease" tab only creates a plan, then the user must click again. Goal: ready-to-run queries.

### 5A. Audit current examples (no edits)
Prompt: *"Show me the structure of EXAMPLES, DISEASE_IDEAS and DEPARTMENT_IDEAS in analytics.js, and how customExample() in index.html loads a query. Do not change anything."*
Decide the disease list (suggested: diabetes, hypertension, asthma, COPD, chronic kidney disease, heart failure) and check which exist in the data.

### 5B. Add runnable SQL examples, first half of the diseases
- Add entries to `EXAMPLES` in `analytics.js`. Each needs `mode`, title, a ready-made read-only `sql`, and an English question. Follow the existing entry shape and the table list above.
- For each disease, 3 queries: patient count by age group and sex; common comorbidities; new cases over time.
- Test: `node analytics.js --selftest` (the SQL guard must accept each query).
- Commit: `chunk 5B: runnable examples for <diseases>`

### 5C. Add runnable examples, second half
- Same as 5B for the remaining diseases.
- Commit: `chunk 5C: runnable examples for <diseases>`

### 5D. UI: group by disease and run directly
- In the Examples panel (`customLoadExamples` ~line 8121), group examples by disease.
- Change the "By disease" tab so picking a disease lists these queries. Each has a **Run** button that loads the SQL and runs it immediately (reuse `customExample` and the run call near line 8095). No plan-only step.
- Results should open in the output section with drill-down available (Chunk 3).
- Commit: `chunk 5D: disease examples run directly`

---

## Final step: zip of changed files

Run from the repo root once everything is committed:

```bash
BASE=$(cat ../base_commit.txt)
git diff --name-only --diff-filter=ACMR $BASE HEAD | zip ../changed_files.zip -@
git diff --name-only --diff-filter=D $BASE HEAD > deleted_files.txt
zip ../changed_files.zip deleted_files.txt PROGRESS.md
```
Add a short `CHANGES.md` (what changed per chunk, new database table, new environment variables, deleted files) and include it in the zip. Do not include `node_modules` or `.env`.

---

## PROGRESS.md template

```
# Progress
Base commit: <hash>
Done: (list chunk ids, e.g. 1A, 1B)
Next: (next chunk id)
Notes: (anything the next chat needs, such as line numbers that moved or decisions made)
```

## Checklist

- [ ] Step 0 setup
- [ ] 1A, 1B, 1C disease module removed
- [ ] 2A, 2B, 2C sessions in database
- [ ] 3A, 3B, 3C (repeat), 3D drill-down
- [ ] 4A, 4B, 4C, 4D chat interface
- [ ] 5A, 5B, 5C, 5D runnable disease examples
- [ ] Final zip delivered
