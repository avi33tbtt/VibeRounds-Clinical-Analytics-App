-- Optional, run once as the database owner: removes the two tables the disease / department plan created.
-- They hold only profile JSON (no patient data). The app no longer reads or writes them.
DROP TABLE IF EXISTS disease_profiles;
DROP TABLE IF EXISTS department_profiles;
