-- Vibe Rounds: SELECT-only database role for every query that runs user-written SQL (cohort criteria) and all analytics.
-- Run ONCE as the database owner / admin (the same user the app uses for imports), after editing the three values below.
-- Then set  DATABASE_READONLY_URL=postgres://vibe_readonly:<password>@<host>:<port>/<db>  on the server (and REQUIRE_READONLY=true).
--
-- What this role can do: read the FHIR tables and the cohort / concept tables, and create TEMP tables (the cohort
-- knowledge graph needs them; they live only for that session). What it cannot do: INSERT / UPDATE / DELETE / TRUNCATE /
-- DROP / ALTER anything permanent, and read users, sessions, audit_log or app_settings (password hashes, API keys).

\set ro_password 'CHANGE_ME_long_random_password'
\set owner_role  'CHANGE_ME_the_role_the_app_imports_with'
\set db_name     'CHANGE_ME_database_name'

CREATE ROLE vibe_readonly LOGIN PASSWORD :'ro_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE vibe_readonly SET default_transaction_read_only = on;     -- belt and braces; temp-table work is unaffected for plain SELECTs
ALTER ROLE vibe_readonly SET statement_timeout = '120s';
ALTER ROLE vibe_readonly SET idle_in_transaction_session_timeout = '60s';
GRANT CONNECT ON DATABASE :"db_name" TO vibe_readonly;
GRANT USAGE ON SCHEMA public TO vibe_readonly;

-- existing tables: FHIR batches (fhir_*_<batch>), cohorts, concept overrides, SNOMED reference tables
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables
           WHERE schemaname = 'public'
             AND (tablename LIKE 'fhir\_%' OR tablename IN ('cohorts', 'concept_overrides', 'pico_templates')
                  OR tablename LIKE 'snomed\_%')
  LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO vibe_readonly', t);
  END LOOP;
END $$;

-- tables the app creates later (every import makes new fhir_*_<batch> tables) are readable automatically.
-- NOTE: default privileges cannot be limited to a name pattern, so any NEW non-FHIR table is readable too:
-- REVOKE SELECT on it if it holds secrets. sql-guard.js also blocks users / sessions / audit_log / app_settings by name.
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public GRANT SELECT ON TABLES TO vibe_readonly;

-- make sure the sensitive tables stay closed even if a broader grant existed
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'sessions', 'audit_log', 'app_settings'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN EXECUTE format('REVOKE ALL ON public.%I FROM vibe_readonly', t); END IF;
  END LOOP;
END $$;

-- check (should return no rows):
-- SELECT table_name, privilege_type FROM information_schema.role_table_grants
--  WHERE grantee = 'vibe_readonly' AND privilege_type <> 'SELECT';
