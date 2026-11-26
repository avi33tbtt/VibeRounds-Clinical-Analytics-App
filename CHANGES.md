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
