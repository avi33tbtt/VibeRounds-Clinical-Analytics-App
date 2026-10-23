'use strict';
// Notebook generator for the Extended Analytics tab.
//   POST /api/notebook/preview   -> { success, scope, cells:[{type,title,source}] }   (for the copy-cell view)
//   POST /api/notebook/download  -> a .ipynb file for the chosen population / batch, cohort and recipes
// The notebook connects with its own read-only session and rebuilds the same scope as the dashboard
// (batch tables, cohort criteria rewritten per batch). The database password is never written into it.
// Self-test (no database needed): node notebook.js --selftest

const RECIPES = [
  { id: 'encounters', title: 'Encounter volume, ED rate and length of stay by year', extends: 'Encounter utilization & readmissions' },
  { id: 'labs', title: 'Lab trend over time (median, IQR, first-vs-last change)', extends: 'Lab & vital sign summary' },
  { id: 'comorbidity', title: 'Comorbidity network (pairs, lift, graph)', extends: 'Comorbidity patterns' },
  { id: 'survival', title: 'Kaplan-Meier survival with log-rank test by sex', extends: 'Kaplan-Meier survival' },
  { id: 'readmission', title: '30-day readmission risk model (logistic regression)', extends: 'Readmission drivers' }
];
const MAX_SQL = 200000;

// ------------------------------------------------------------------ notebook building blocks
const lines = s => { const a = String(s).replace(/^\n/, '').replace(/\s+$/, '').split('\n'); return a.map((l, i) => (i < a.length - 1 ? l + '\n' : l)); };
const md = (title, text) => ({ cell_type: 'markdown', metadata: { title }, source: lines(String(text).replace(/\\`/g, '`')) });   // String.raw keeps the backslash of an escaped backtick; drop it
const code = (title, text) => ({ cell_type: 'code', metadata: { title }, execution_count: null, outputs: [], source: lines(text) });
const py = v => JSON.stringify(v);   // a JSON string / list is a valid Python literal, so no user text can break out of a code cell

function header(o) {
  return md('Read me first', String.raw`
# Vibe Rounds: analysis notebook

**Scope:** ${o.scopeText}
**Generated:** ${o.generated}

This notebook rebuilds the scope you chose in the app (same batches, same cohort) and loads it into pandas so you can do what the UI cannot. It is read-only: it never changes the database.

## How to run it
1. **Install the Python packages** (once): \`pip install pandas sqlalchemy psycopg2-binary matplotlib jupyterlab\`. The recipes at the end also need \`lifelines scikit-learn networkx\`.
2. **Make sure the database is reachable** from the machine running Jupyter (same host and port as the app).
3. **Set the password as an environment variable** before starting Jupyter, so it is never stored in the notebook:
   \`export DB_PASSWORD=...\` (macOS/Linux) or \`$env:DB_PASSWORD="..."\` (PowerShell). If it is not set, the connection cell asks for it. Host, port, database and user default to the app's settings; override them with \`DB_HOST\`, \`DB_PORT\`, \`DB_NAME\`, \`DB_USER\`.
4. **Run the cells from top to bottom** (Run > Run All Cells). Cells 1 to 4 set up and load the data; the orientation section then shows what the data looks like; the recipes are independent, so run only the ones you want.

## What is where
| Section | Purpose |
|---|---|
| Connection and scope | Connects read-only and defines \`BATCHES\` and \`CRITERIA_SQL\`, the only two things that decide which patients you see |
| Load the data | One DataFrame per resource: \`patients, encounters, observations, diagnoses, medications, procedures, allergies, immunizations\` |
| Get to know the data | Counts, code systems, date ranges, missing values, demographics, top codes |
| SNOMED builder query | Use a query made with **Build SNOMED CT Query** in the app |
| Recipes | Analyses the UI does not offer; change the parameters at the top of each cell |

## Things to know
- **Patient data.** The notebook and its saved outputs can contain patient-level data. Do not share it or commit it with outputs; use *Kernel > Restart & Clear Outputs* first.
- **V1, V3, V4 in code.** V1 is text (the narrative in \`json_content\`), V3 is codes only, V4 is codes plus dates. Everything here uses codes and dates (V4) unless a cell says otherwise.
- **Codes are demo codes** unless you imported your own data; validate against a terminology server before drawing real conclusions.
- **Same patient in several batches** is counted once, exactly like the app.
`);
}

function connectionCells(o) {
  return [
    md('1. Connection', String.raw`
## 1. Connection and scope
The session is opened **read-only** with a 5-minute statement timeout.`),
    code('Connect', String.raw`
import os, re, getpass, json, warnings
from datetime import datetime
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL
from IPython.display import display

warnings.filterwarnings("ignore", category=FutureWarning)
pd.set_option("display.max_columns", 50, "display.width", 160)

DB = dict(
    host=os.getenv("DB_HOST", ${py(o.db.host)}),
    port=int(os.getenv("DB_PORT", ${py(String(o.db.port))})),
    database=os.getenv("DB_NAME", ${py(o.db.name)}),
    username=os.getenv("DB_USER", ${py(o.db.user)}),
)
password = os.getenv("DB_PASSWORD") or getpass.getpass("Database password: ")
engine = create_engine(
    URL.create("postgresql+psycopg2", password=password, **DB),
    connect_args={"options": "-c default_transaction_read_only=on -c statement_timeout=300000"},
)
with engine.connect() as conn:
    print("Connected to", DB["database"], "on", DB["host"], "(read-only)")
`),
    code('Scope', String.raw`
# ---- The scope. These two values decide which patients you see. -------------------------------------
# BATCHES: the batch tables to read (fhir_patient_<batch>, ...). "" means the older un-suffixed tables.
# CRITERIA_SQL: the cohort, a WHERE clause on fhir_patient. Empty = every patient in BATCHES.
#   It is rewritten for each batch, exactly like the app does. Paste a clause from the SNOMED builder here to change cohort.
SCOPE_LABEL  = ${py(o.scopeText)}
BATCHES      = ${py(o.batches)}
CRITERIA_SQL = ${py(o.criteria)}

_REF = re.compile(r"\bfhir_(patient|encounter|observation|diagnosis|procedure|medication|allergy|immunization)\b(?!_)")
def _tbl(kind, batch):
    if batch and not re.fullmatch(r"[A-Za-z0-9_]+", batch):
        raise ValueError("unsafe batch name: " + batch)
    return f"fhir_{kind}_{batch}" if batch else f"fhir_{kind}"

def patient_sql():
    """One SELECT over every batch, filtered by the cohort criteria."""
    crit = CRITERIA_SQL.strip()
    parts = []
    for b in BATCHES:
        where = " WHERE " + _REF.sub(lambda m: _tbl(m.group(1), b), crit) if crit else ""
        parts.append(f"SELECT patient_id, gender, birth_date, json_content FROM {_tbl('patient', b)}{where}")
    return " UNION ALL ".join(parts)

def q(sql, **params):
    """Run SQL and return a DataFrame."""
    with engine.connect() as conn:
        return pd.read_sql(text(sql), conn, params=params or None)

print("Scope:", SCOPE_LABEL)
print("Batches:", BATCHES, "| cohort criteria:", CRITERIA_SQL or "(none: all patients)")
`),
    md('2. Load', String.raw`
## 2. Load the data
One DataFrame per resource, limited to the patients in the scope. \`json_content\` holds the original FHIR resource as a Python dict, so anything the tables do not break out (narrative text, extensions) is still reachable.`),
    code('Load', String.raw`
COHORT_IDS = "SELECT patient_id FROM (" + patient_sql() + ") c"

def load(kind, cols):
    parts = [f"SELECT {cols} FROM {_tbl(kind, b)}" for b in BATCHES]
    return q(f"SELECT * FROM ({' UNION ALL '.join(parts)}) t WHERE patient_id IN ({COHORT_IDS})")

def as_dt(df, *cols):
    for c in cols:
        df[c] = pd.to_datetime(df[c], errors="coerce", utc=True).dt.tz_convert(None)
    return df

def concept_name(j, *keys):
    """Display text of the coded concept in a FHIR resource (code, medicationCodeableConcept, vaccineCode)."""
    j = j or {}
    for k in keys or ("code", "medicationCodeableConcept", "vaccineCode"):
        c = j.get(k)
        if isinstance(c, dict):
            for cod in c.get("coding") or []:
                if cod.get("display"):
                    return cod["display"]
            if c.get("text"):
                return c["text"]
    return None

# one row per patient even if the id sits in several batches (the app does the same)
patients = q(patient_sql()).drop_duplicates("patient_id").reset_index(drop=True)
patients["deceased"] = patients["json_content"].map(lambda j: (j or {}).get("deceasedDateTime"))
as_dt(patients, "birth_date", "deceased")

encounters   = as_dt(load("encounter",    "patient_id, encounter_type, start_date, end_date, json_content"), "start_date", "end_date")
observations = as_dt(load("observation",  "patient_id, code, code_system, value, unit, effective_date, json_content"), "effective_date")
diagnoses    = as_dt(load("diagnosis",    "patient_id, code, code_system, onset_date, json_content"), "onset_date")
medications  = as_dt(load("medication",   "patient_id, medication_code AS code, prescribed_date, json_content"), "prescribed_date")
procedures   = as_dt(load("procedure",    "patient_id, code, performed_date, json_content"), "performed_date")
allergies    = load("allergy",            "patient_id, substance, reaction, severity, json_content")
immunizations = as_dt(load("immunization", "patient_id, vaccine_code AS code, occurrence_date, json_content"), "occurrence_date")

for df, col in [(diagnoses, "code"), (observations, "code"), (medications, "code"), (procedures, "code")]:
    names = df["json_content"].map(concept_name)
    df["name"] = names

# "today" for age and follow-up: the latest date anywhere in the data, like the app's as-of date
AS_OF = max(s.max() for s in [encounters.start_date, observations.effective_date, diagnoses.onset_date,
                              medications.prescribed_date, procedures.performed_date] if s.notna().any())
patients["age"] = ((AS_OF - patients["birth_date"]).dt.days / 365.25).round(1)

print(f"{len(patients):,} patients as of {AS_OF:%Y-%m-%d}")
for name, df in [("encounters", encounters), ("observations", observations), ("diagnoses", diagnoses), ("medications", medications),
                 ("procedures", procedures), ("allergies", allergies), ("immunizations", immunizations)]:
    print(f"  {name:<14}{len(df):>9,} rows")
`)
  ];
}

function orientationCells() {
  return [
    md('3. Orientation', String.raw`
## 3. Get to know the data
Look at these before analysing anything. They answer: how much is there, what codes are in it, over which dates, and how complete is it.`),
    code('Inventory and code systems', String.raw`
inventory = pd.DataFrame({
    "rows": [len(patients), len(encounters), len(observations), len(diagnoses), len(medications), len(procedures), len(allergies), len(immunizations)],
    "patients": [patients.patient_id.nunique()] + [d.patient_id.nunique() for d in
                [encounters, observations, diagnoses, medications, procedures, allergies, immunizations]],
}, index=["patients", "encounters", "observations", "diagnoses", "medications", "procedures", "allergies", "immunizations"])
display(inventory)

print("Code systems in diagnoses:")
display(diagnoses["code_system"].value_counts(dropna=False).to_frame("rows"))
print("Code systems in observations:")
display(observations["code_system"].value_counts(dropna=False).to_frame("rows"))
`),
    code('Dates and completeness', String.raw`
dates = pd.DataFrame({
    "first": [encounters.start_date.min(), observations.effective_date.min(), diagnoses.onset_date.min(), medications.prescribed_date.min(), procedures.performed_date.min()],
    "last":  [encounters.start_date.max(), observations.effective_date.max(), diagnoses.onset_date.max(), medications.prescribed_date.max(), procedures.performed_date.max()],
    "missing_date_%": [encounters.start_date.isna().mean(), observations.effective_date.isna().mean(), diagnoses.onset_date.isna().mean(),
                       medications.prescribed_date.isna().mean(), procedures.performed_date.isna().mean()],
}, index=["encounters", "observations", "diagnoses", "medications", "procedures"])
dates["missing_date_%"] = (dates["missing_date_%"] * 100).round(1)
display(dates)

# V3/V4 depend on codes: how many rows have none, and how many observations have no numeric value?
print("Diagnoses without code:    ", f"{diagnoses.code.isna().mean():.1%}")
print("Medications without code:  ", f"{medications.code.isna().mean():.1%}")
print("Observations without value:", f"{observations.value.isna().mean():.1%}")
`),
    code('Who is in the scope', String.raw`
fig, ax = plt.subplots(1, 2, figsize=(11, 3.2))
patients["age"].dropna().plot.hist(bins=20, ax=ax[0], color="#1a7a54"); ax[0].set_title("Age (years, as of last date in data)")
patients["gender"].fillna("Unknown").value_counts().plot.bar(ax=ax[1], color="#2563a8"); ax[1].set_title("Gender"); ax[1].tick_params(axis="x", rotation=0)
plt.tight_layout(); plt.show()
print(f"Deceased: {patients.deceased.notna().sum():,} of {len(patients):,}")
`),
    code('Top codes with names', String.raw`
def top(df, n=10):
    g = df.groupby("code").agg(name=("name", lambda s: s.dropna().mode().iat[0] if s.notna().any() else None),
                              patients=("patient_id", "nunique"), rows=("patient_id", "size"))
    return g.sort_values("patients", ascending=False).head(n)

for label, df in [("Diagnoses", diagnoses), ("Medications", medications), ("Observations (labs, vitals)", observations), ("Procedures", procedures)]:
    print(label); display(top(df))
`),
    md('Methods in code', String.raw`
### How the app's methods look in code
- **V3 (codes only)**: count patients per code, as in the tables above. No dates are used, so it cannot say what came first.
- **V4 (codes + time)**: add the date column. For example, the first time a patient had a diagnosis:

\`\`\`python
first_dx = diagnoses.groupby(["patient_id", "code"])["onset_date"].min()
\`\`\`
- **V1 (text)**: search the narrative stored in \`json_content["text"]["div"]\`. Simple, but it misses codes and cannot tell dates apart.`)
  ];
}

function snomedCells(o) {
  const has = o.snomedQuery && o.snomedQuery.trim();
  return [
    md('SNOMED builder', String.raw`
## 4. Using a query from **Build SNOMED CT Query**
In the app: *Analytics tab > Create Custom Cohort > Build SNOMED CT Query*, add your rules, press **Generate SQL**. It gives two pieces:
- **Cohort criteria** (a \`WHERE\` clause). Paste it into \`CRITERIA_SQL\` in the *Scope* cell above (or generate this notebook again from the **Use in Python** button), then re-run from the *Scope* cell down. Every DataFrame is then limited to that cohort.
- **Full query** (one \`SELECT\` per batch joined with \`UNION ALL\`). Paste it below to get the matching patients as a DataFrame without changing the scope.

Descendants and ancestors are already expanded into explicit code lists, so the SQL needs no hierarchy table.`),
    code('SNOMED full query', String.raw`
SNOMED_FULL_QUERY = ${py(has ? o.snomedQuery : '')}

if SNOMED_FULL_QUERY.strip():
    snomed_patients = q(SNOMED_FULL_QUERY)
    print(f"{len(snomed_patients):,} patients match the SNOMED query")
    display(snomed_patients.head())
else:
    print("No SNOMED query set. Paste the full query from the builder between the triple quotes above, or use the 'Use in Python' button in the app.")
`)
  ];
}

const RECIPE_CELLS = {
  encounters: () => [
    md('Recipe: encounters', String.raw`
### Recipe: encounter volume, ED rate and length of stay by year
**Extends:** *Encounter utilization & readmissions* (adds a by-class plot and length-of-stay spread). Class codes in the data: \`AMB\` ambulatory, \`EMER\` emergency, \`IMP\` inpatient. Change \`CLASSES\` to focus on one.`),
    code('Recipe: encounters', String.raw`
CLASSES = None   # e.g. ["EMER", "IMP"]; None = all classes

e = encounters.dropna(subset=["start_date"]).copy()
e["year"] = e.start_date.dt.year
if CLASSES: e = e[e.encounter_type.isin(CLASSES)]
e["los_days"] = (e.end_date - e.start_date).dt.total_seconds() / 86400

vol = e.pivot_table(index="year", columns="encounter_type", values="patient_id", aggfunc="size", fill_value=0)
active = e.groupby("year").patient_id.nunique()
ed_per_1000 = (1000 * vol.get("EMER", 0) / active).round(1)
display(vol.assign(ED_per_1000_patients=ed_per_1000))

vol.plot.bar(stacked=True, figsize=(10, 3.5), title="Encounters per year by class"); plt.tight_layout(); plt.show()
los = e[e.encounter_type.eq("IMP") & e.los_days.notna()]
if len(los):
    los.boxplot(column="los_days", by="year", figsize=(10, 3.5)); plt.suptitle(""); plt.title("Inpatient length of stay (days) by year"); plt.show()
`)
  ],
  labs: () => [
    md('Recipe: labs', String.raw`
### Recipe: lab trend over time
**Extends:** *Lab & vital sign summary* (adds per-year spread and per-patient change). Set \`LAB_CODE\` to any LOINC code from the *Top codes* table (default HbA1c).`),
    code('Recipe: labs', String.raw`
LAB_CODE = "4548-4"      # HbA1c; look at the observations table above for other codes

lab = observations[(observations.code == LAB_CODE) & observations.value.notna() & observations.effective_date.notna()].copy()
lab["value"] = lab["value"].astype(float)
if lab.empty:
    print("No numeric results for", LAB_CODE)
else:
    lab["year"] = lab.effective_date.dt.year
    by_year = lab.groupby("year")["value"].describe(percentiles=[.25, .5, .75])[["count", "25%", "50%", "75%"]]
    display(by_year)
    ax = by_year["50%"].plot(marker="o", figsize=(9, 3.5), title=f"{LAB_CODE}: median per year with IQR", color="#1a7a54")
    ax.fill_between(by_year.index, by_year["25%"], by_year["75%"], alpha=.2, color="#1a7a54"); plt.show()

    s = lab.sort_values("effective_date").groupby("patient_id")["value"].agg(["first", "last", "count"])
    s = s[s["count"] >= 2]
    s["change"] = s["last"] - s["first"]
    print(f"{len(s):,} patients with 2+ results: mean change {s.change.mean():.2f}, median {s.change.median():.2f}")
    s["change"].plot.hist(bins=20, figsize=(8, 3), title="First-to-last change per patient", color="#2563a8"); plt.show()
`)
  ],
  comorbidity: () => [
    md('Recipe: comorbidity', String.raw`
### Recipe: comorbidity network
**Extends:** *Comorbidity patterns* (adds the graph). Lift above 1 means two conditions occur together more than chance would predict. Raise \`MIN_PAIR\` to remove thin links.`),
    code('Recipe: comorbidity', String.raw`
TOP_N, MIN_PAIR, MIN_LIFT = 15, 5, 1.2     # most common conditions to use, minimum shared patients, minimum lift

import networkx as nx
dx = diagnoses.dropna(subset=["code"])
top_codes = dx.groupby("code").patient_id.nunique().nlargest(TOP_N).index
M = pd.crosstab(dx[dx.code.isin(top_codes)].patient_id, dx[dx.code.isin(top_codes)].code).clip(upper=1)
N = len(patients)
co = M.T.dot(M)                                   # patients having both conditions
n = np.diag(co).copy()
names = dx.groupby("code")["name"].agg(lambda s: s.dropna().mode().iat[0] if s.notna().any() else None).reindex(co.index).fillna(pd.Series(co.index, index=co.index))

pairs = [(a, b, int(co.loc[a, b]), N * co.loc[a, b] / (n[i] * n[j]))
         for i, a in enumerate(co.index) for j, b in enumerate(co.index) if i < j and co.loc[a, b] >= MIN_PAIR]
pairs = pd.DataFrame(pairs, columns=["a", "b", "patients", "lift"]).query("lift >= @MIN_LIFT").sort_values("lift", ascending=False)
pairs["condition_a"] = pairs.a.map(names); pairs["condition_b"] = pairs.b.map(names)
display(pairs[["condition_a", "condition_b", "patients", "lift"]].round(2).head(20))

if len(pairs):
    G = nx.Graph()
    for c in co.index: G.add_node(c, size=n[list(co.index).index(c)])
    for r in pairs.itertuples(): G.add_edge(r.a, r.b, weight=r.lift)
    pos = nx.spring_layout(G, seed=1, k=1.2)
    plt.figure(figsize=(9, 6))
    nx.draw_networkx_nodes(G, pos, node_size=[40 + 12 * G.nodes[c]["size"] for c in G], node_color="#1a7a54", alpha=.8)
    nx.draw_networkx_edges(G, pos, width=[max(.5, d["weight"]) for _, _, d in G.edges(data=True)], alpha=.4)
    nx.draw_networkx_labels(G, pos, labels={c: str(names[c])[:22] for c in G}, font_size=8)
    plt.title("Comorbidity network (node size = patients, edge width = lift)"); plt.axis("off"); plt.show()
else:
    print("No pairs pass the thresholds; lower MIN_PAIR or MIN_LIFT.")
`)
  ],
  survival: () => [
    md('Recipe: survival', String.raw`
### Recipe: Kaplan-Meier survival
**Extends:** *Kaplan-Meier survival* (adds comparison by sex with a log-rank test). Time starts at the **first dated diagnosis** of \`COND_CODE\`; the event is the death date on the Patient record; everyone else is censored at the last date in the data. If your data has no death dates there are no events and the cell says so. Associations only, not causal effects.`),
    code('Recipe: survival', String.raw`
COND_CODE = "44054006"     # diabetes mellitus type 2 (SNOMED CT demo code); use a code from the diagnoses table above
MAX_DAYS  = 1825

from lifelines import KaplanMeierFitter
from lifelines.statistics import logrank_test

start = diagnoses[diagnoses.code == COND_CODE].groupby("patient_id")["onset_date"].min().dropna().rename("start")
km = patients.set_index("patient_id").join(start, how="inner")
km["event"] = (km.deceased.notna() & (km.deceased >= km.start)).astype(int)
km["end"] = km.deceased.where(km.event == 1, AS_OF)
km["days"] = ((km.end - km.start).dt.days).clip(lower=0).clip(upper=MAX_DAYS)
km.loc[km.days >= MAX_DAYS, "event"] = 0
print(f"{len(km):,} patients with {COND_CODE}; {int(km.event.sum())} deaths")

if km.event.sum() < 2:
    print("Too few events for a survival curve (the data may have no death dates).")
else:
    ax = plt.figure(figsize=(8, 4)).gca()
    for g, d in km.groupby(km.gender.fillna("Unknown")):
        if len(d) >= 5:
            KaplanMeierFitter().fit(d.days, d.event, label=f"{g} (n={len(d)})").plot_survival_function(ax=ax, ci_show=True)
    ax.set_xlabel("Days since first diagnosis"); ax.set_ylabel("Survival probability"); ax.set_title("Kaplan-Meier by sex"); plt.show()
    f, m = km[km.gender == "female"], km[km.gender == "male"]
    if len(f) >= 5 and len(m) >= 5 and (f.event.sum() + m.event.sum()) >= 2:
        r = logrank_test(f.days, m.days, f.event, m.event)
        print(f"Log-rank test female vs male: p = {r.p_value:.3f}")
`)
  ],
  readmission: () => [
    md('Recipe: readmission', String.raw`
### Recipe: 30-day readmission risk model
**Extends:** *Readmission drivers* (adds a fitted model). One row per inpatient discharge; the label is "another inpatient stay starts within 30 days". Features: age, sex, length of stay, prior admissions, chronic conditions already diagnosed. It needs a few hundred discharges to be meaningful: generate synthetic data with the *Readmission and inpatient* generator options, or use real data. The cell stops with a message when there are too few. This is a teaching example, **not a validated clinical risk score**.`),
    code('Recipe: readmission', String.raw`
WINDOW_DAYS, MIN_EPISODES, MIN_MINORITY = 30, 100, 15

from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score

imp = encounters[(encounters.encounter_type == "IMP") & encounters.end_date.notna() & encounters.start_date.notna()].sort_values(["patient_id", "start_date"]).copy()
imp["next_start"] = imp.groupby("patient_id")["start_date"].shift(-1)
gap = imp.next_start - imp.end_date
imp["readmit"] = ((gap > pd.Timedelta(0)) & (gap <= pd.Timedelta(days=WINDOW_DAYS))).astype(int)
imp["los_days"] = (imp.end_date - imp.start_date).dt.total_seconds() / 86400
imp["prior_admits"] = imp.groupby("patient_id").cumcount()
imp = imp.merge(patients[["patient_id", "gender", "birth_date"]], on="patient_id", how="left")
imp["age"] = (imp.start_date - imp.birth_date).dt.days / 365.25
imp["male"] = (imp.gender == "male").astype(int)
dxu = diagnoses.dropna(subset=["onset_date", "code"])[["patient_id", "code", "onset_date"]].drop_duplicates()
m = imp[["patient_id", "start_date"]].reset_index().merge(dxu, on="patient_id")
imp["n_conditions"] = m[m.onset_date <= m.start_date].groupby("index").code.nunique().reindex(imp.index).fillna(0)

print(f"{len(imp):,} discharges; {imp.readmit.sum():,} followed by an inpatient stay within {WINDOW_DAYS} days ({imp.readmit.mean():.1%})")
FEATURES = ["age", "male", "los_days", "prior_admits", "n_conditions"]
X, y = imp[FEATURES].fillna(imp[FEATURES].median()), imp.readmit
if len(imp) < MIN_EPISODES or min(y.sum(), len(y) - y.sum()) < MIN_MINORITY:
    print(f"Not enough discharges for a stable model (need {MIN_EPISODES}+ with at least {MIN_MINORITY} in each outcome group). Showing the table instead.")
    display(imp[["patient_id", "start_date", "end_date", "los_days", "prior_admits", "readmit"]].head(20))
else:
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=.3, random_state=0, stratify=y)
    model = make_pipeline(StandardScaler(), LogisticRegression(max_iter=1000, class_weight="balanced")).fit(Xtr, ytr)
    print(f"AUC on held-out discharges: {roc_auc_score(yte, model.predict_proba(Xte)[:, 1]):.2f}")
    display(pd.Series(model[-1].coef_[0], index=FEATURES, name="standardized coefficient").sort_values().to_frame())
`)
  ]
};

function buildNotebook(o) {
  const recipes = (o.recipes || []).filter(r => RECIPE_CELLS[r]);
  const cells = [header(o), ...connectionCells(o), ...orientationCells(), ...snomedCells(o)];
  if (recipes.length) {
    cells.push(md('Recipes', '## 5. Recipes\nEach recipe is independent. Change the parameters on the first lines of its cell and run it. They add to the app\'s analytics rather than repeat them.'));
    recipes.forEach(r => cells.push(...RECIPE_CELLS[r]()));
  }
  cells.push(md('Next steps', String.raw`
## Where to go from here
- Change \`CRITERIA_SQL\` (or use the SNOMED builder) and re-run from the *Scope* cell to analyse a different cohort.
- The tables are plain pandas DataFrames: \`diagnoses.merge(medications, on="patient_id")\`, \`groupby\`, \`pivot_table\`, plotting, statsmodels and so on all work.
- Save results you want to keep as CSV without patient ids, not as notebook outputs.`));
  return { cells, metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 4 };
}

// ------------------------------------------------------------------ scope resolution
const httpErr = (status, msg) => { const e = new Error(msg); e.status = status; return e; };

async function resolve(pool, sanitize, body) {
  const b = body || {};
  const txt = (v, n) => { if (v == null || v === '') return ''; if (typeof v !== 'string') throw httpErr(400, `${n} must be text`); if (v.length > MAX_SQL) throw httpErr(400, `${n} is too long`); return v; };
  const names = new Set((await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name LIKE 'fhir\\_patient%'`)).rows.map(r => r.table_name));
  const all = [...names].map(n => (n.match(/^fhir_patient_(.+)$/) || [])[1]).filter(Boolean).sort();
  let batches, popText;
  if (b.batchId) { const s = sanitize(String(b.batchId)); if (!names.has('fhir_patient_' + s)) throw httpErr(404, 'Batch not found: ' + s); batches = [s]; popText = `batch ${s}`; }
  else if (b.batchGroup) { const g = sanitize(String(b.batchGroup)); batches = all.filter(s => s.startsWith(g)); popText = `batch group ${g} (${batches.length} batches)`; }
  else { batches = all; popText = all.length ? `all batches (${all.length})` : 'all data'; }
  if (!batches.length) {
    if (!b.batchId && !b.batchGroup && names.has('fhir_patient')) { batches = ['']; popText = 'legacy un-suffixed tables'; }
    else throw httpErr(404, 'No imported FHIR data found. Import a batch or generate synthetic data first.');
  }
  let criteria = '', cohortText = 'all patients (no cohort)';
  const mode = b.cohortMode || 'active';
  if (mode === 'active' || mode === 'id') {
    const r = mode === 'id'
      ? await pool.query('SELECT id, name, criteria_sql FROM cohorts WHERE id = $1', [parseInt(b.cohortId, 10) || 0])
      : await pool.query('SELECT id, name, criteria_sql FROM cohorts WHERE is_active = TRUE ORDER BY updated_at DESC LIMIT 1').catch(() => ({ rows: [] }));
    if (mode === 'id' && !r.rows.length) throw httpErr(404, 'Cohort not found');
    if (r.rows.length) { criteria = (r.rows[0].criteria_sql || '').trim(); cohortText = `cohort "${r.rows[0].name}"`; }
  } else if (mode === 'custom' || mode === 'snomed') {
    criteria = txt(b.criteriaSql, 'criteriaSql').trim(); cohortText = mode === 'snomed' ? 'SNOMED builder cohort' : 'custom cohort criteria';
    if (!criteria) cohortText = 'all patients (no cohort)';
  } else if (mode !== 'none') throw httpErr(400, 'Unknown cohortMode');
  const recipes = Array.isArray(b.recipes) ? b.recipes.map(String).filter(x => RECIPES.some(r => r.id === x)) : [];
  return { batches, criteria, scopeText: `${popText}; ${cohortText}`, recipes, snomedQuery: txt(b.snomedQuery, 'snomedQuery') };
}

function register(app, pool, { sanitizeBatchId = s => String(s).replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '') } = {}) {
  const express = require('express');
  const json = express.json({ limit: '2mb' });
  const make = async body => {
    const s = await resolve(pool, sanitizeBatchId, body);
    const db = { host: process.env.DB_HOST || 'localhost', port: parseInt(process.env.DB_PORT || '5433', 10), name: process.env.DB_NAME || 'testdb', user: process.env.DB_USER || 'user' };
    return { s, nb: buildNotebook({ ...s, db, generated: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC' }) };
  };
  const fail = (res, e) => res.status(e.status || 500).json({ success: false, error: e.message });
  app.get('/api/notebook/recipes', (req, res) => res.json({ success: true, recipes: RECIPES }));
  app.post('/api/notebook/preview', json, async (req, res) => {
    try { const { s, nb } = await make(req.body); res.json({ success: true, scope: { text: s.scopeText, batches: s.batches, criteria: s.criteria }, cells: nb.cells.map(c => ({ type: c.cell_type, title: c.metadata.title, source: c.source.join('') })) }); } catch (e) { fail(res, e); }
  });
  app.post('/api/notebook/download', json, async (req, res) => {
    try {
      const { nb } = await make(req.body);
      res.setHeader('Content-Type', 'application/x-ipynb+json');
      res.setHeader('Content-Disposition', `attachment; filename="vibe-rounds-analysis-${new Date().toISOString().slice(0, 10)}.ipynb"`);
      res.send(JSON.stringify(nb, null, 1));
    } catch (e) { fail(res, e); }
  });
}

module.exports = register;
module.exports.buildNotebook = buildNotebook;
module.exports.resolve = resolve;
module.exports.RECIPES = RECIPES;

// ------------------------------------------------------------------ self-test (no database)
if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert');
  const { spawnSync } = require('child_process');
  (async () => {
    const fakePool = rows => ({ query: async sql => (/information_schema/.test(sql) ? { rows } : /FROM cohorts WHERE id/.test(sql) ? { rows: [{ id: 3, name: 'Diabetics', criteria_sql: "gender = 'female'" }] } : /FROM cohorts/.test(sql) ? { rows: [] } : { rows: [] }) });
    const tn = ['fhir_patient_a_1', 'fhir_patient_a_2', 'fhir_patient_b'].map(table_name => ({ table_name }));
    const san = s => String(s).replace(/[^a-zA-Z0-9]/g, '_');
    // scope resolution
    let s = await resolve(fakePool(tn), san, {});
    assert.deepStrictEqual(s.batches, ['a_1', 'a_2', 'b']);
    s = await resolve(fakePool(tn), san, { batchGroup: 'a_' }); assert.deepStrictEqual(s.batches, ['a_1', 'a_2']);
    s = await resolve(fakePool(tn), san, { batchId: 'b', cohortMode: 'id', cohortId: 3 }); assert.strictEqual(s.criteria, "gender = 'female'");
    await assert.rejects(() => resolve(fakePool(tn), san, { batchId: 'zz' }), /Batch not found/);
    await assert.rejects(() => resolve(fakePool([]), san, {}), /No imported FHIR data/);
    await assert.rejects(() => resolve(fakePool(tn), san, { cohortMode: 'bogus' }), /Unknown cohortMode/);
    await assert.rejects(() => resolve(fakePool(tn), san, { cohortMode: 'custom', criteriaSql: 5 }), /must be text/);
    // hostile text never leaves its Python string literal
    const evil = "x'); import os; os.system('rm -rf /') #\"\"\"\n";
    s = await resolve(fakePool(tn), san, { cohortMode: 'custom', criteriaSql: evil, snomedQuery: evil, recipes: RECIPES.map(r => r.id).concat(['nope']) });
    assert.strictEqual(s.recipes.length, RECIPES.length);
    const nb = buildNotebook({ ...s, db: { host: 'localhost', port: 5433, name: 'testdb', user: 'user' }, generated: 'now' });
    assert.strictEqual(nb.nbformat, 4);
    assert.ok(nb.cells.length > 15 && nb.cells.every(c => Array.isArray(c.source) && c.metadata && c.metadata.title));
    const all = JSON.stringify(nb);
    assert.ok(!/DB_PASSWORD\s*=\s*['"]\w/.test(all) && !/password['"]?\s*[:=]\s*['"]password/.test(all), 'no password written');
    assert.ok(all.includes('default_transaction_read_only=on'), 'read-only session');
    // every code cell must be valid Python (checked when python3 exists), and the hostile text must stay one literal
    const probe = spawnSync('python3', ['-c', 'import ast,sys,json;nb=json.load(sys.stdin);[ast.parse("".join(c["source"])) for c in nb["cells"] if c["cell_type"]=="code"];print("ok")'], { input: JSON.stringify(nb), encoding: 'utf8' });
    if (probe.error) console.log('notebook self-test: python3 not found, Python syntax check skipped');
    else assert.strictEqual(probe.stdout.trim(), 'ok', 'Python syntax: ' + probe.stderr);
    if (!probe.error) {
      const lit = spawnSync('python3', ['-c', 'import ast,sys,json;nb=json.load(sys.stdin);src="".join([c for c in nb["cells"] if c["metadata"]["title"]=="Scope"][0]["source"]);t=ast.parse(src);v={n.targets[0].id:ast.literal_eval(n.value) for n in t.body if isinstance(n,ast.Assign) and n.targets[0].id in("BATCHES","CRITERIA_SQL")};print(json.dumps(v))'], { input: JSON.stringify(nb), encoding: 'utf8' });
      const v = JSON.parse(lit.stdout);
      assert.strictEqual(v.CRITERIA_SQL, evil.trim()); assert.deepStrictEqual(v.BATCHES, ['a_1', 'a_2', 'b']);
    }
    console.log('notebook.js self-test passed');
  })().catch(e => { console.error('notebook.js self-test FAILED:', e.message); process.exit(1); });
}
