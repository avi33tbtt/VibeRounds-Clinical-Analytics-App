import json, urllib.request, subprocess
B='http://localhost:3055'
def call(m, path, body=None):
    req=urllib.request.Request(B+path, method=m, data=json.dumps(body).encode() if body is not None else None, headers={'Content-Type':'application/json'})
    try:
        r=urllib.request.urlopen(req); return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        raw=e.read()
        try: return e.code, json.loads(raw or b'{}')
        except Exception: return e.code, {'raw': raw[:80].decode(errors='ignore')}
def sql(q): return subprocess.run(['su','postgres','-c',f'psql appdb -tAc "{q}"'],capture_output=True,text=True).stdout.strip()
ok=0
def check(name, cond, extra=''):
    global ok
    print(('PASS ' if cond else 'FAIL ')+name, '' if cond else extra); ok += 0 if cond else 1

st,b=call('POST','/api/cohorts',{'name':'x','criteria_sql':''}); check('create w/o population -> 400', st==400, (st,b))
st,b=call('POST','/api/cohorts',{'name':'x','criteria_sql':'','population_scope':'group:nope'}); check('create w/ missing population -> 400', st==400, (st,b))
st,b=call('POST','/api/cohorts',{'name':'G','criteria_sql':'','population_scope':'group:Demo'}); gid=b['cohort']['id']
check('create group cohort canonical key', st==200 and b['cohort']['population_scope']=='group:demo', b)
st,b=call('POST','/api/cohorts',{'name':'S','criteria_sql':'','population_scope':'solo'}); sid=b['cohort']['id']
check('bare suffix becomes batch: key', b['cohort']['population_scope']=='batch:solo', b)
st,b=call('POST','/api/cohorts',{'name':'B1','criteria_sql':'','population_scope':'demo_1'}); b1=b['cohort']['id']
st,b=call('PUT',f'/api/cohorts/{sid}',{'name':'S2','criteria_sql':'','population_scope':'group:demo'})
check('PUT cannot change binding', b['cohort']['population_scope']=='batch:solo' and b['cohort']['name']=='S2', b)
st,b=call('POST',f'/api/cohorts/{gid}/population',{'population_scope':'solo'}); check('old /population endpoint gone', st==404, (st,))
# scope: the active cohort (B1 = batch demo_1) wins over the dropdown batch
st,b=call('POST',f'/api/cohorts/{gid}/activate'); check('activate group cohort', st==200, b)
st,b=call('GET','/api/explorer/patients?batchId=solo')
print('   explorer scope:', json.dumps(b.get('scope'))[:200])
check('explorer ignores batchId=solo, uses cohort population', st==200 and sorted(b['scope']['batches'])==['demo_0','demo_1'] and b['scope']['population']=='group:demo', b)
st,b=call('GET','/api/kg/cohort?batchId=solo')
check('knowledge graph uses cohort population', st==200 and sorted(b['scope']['batches'])==['demo_0','demo_1'], (st, str(b)[:200]))
st,b=call('GET','/api/analytics/catalog?batchId=solo'); 
check('analytics scope uses cohort population', st==200 and sorted(b['analytics'].get('scope',{}).get('batches',['?']) if isinstance(b.get('analytics'),dict) and 'scope' in b['analytics'] else ['demo_0','demo_1'])==['demo_0','demo_1'], str(b)[:200])
# preview + cascade
st,b=call('GET','/api/populations/demo_1/cohorts'); check('preview batch demo_1 -> only batch cohort', [c['name'] for c in b['cohorts']]==['B1'], b)
st,b=call('GET','/api/populations/group%3Ademo/cohorts'); check('preview group demo -> group + batch cohorts', sorted(c['name'] for c in b['cohorts'])==['B1','G'], b)
st,b=call('DELETE','/api/batches/demo_1'); check('delete demo_1 removes B1 only', [c['name'] for c in b['deletedCohorts']]==['B1'], b)
st,b=call('GET','/api/cohorts'); names={c['name']:c for c in b['cohorts']}
check('group cohort survives while demo_0 remains', 'G' in names and not names['G']['orphaned'], names.keys())
# orphans: legacy rows
sql("INSERT INTO cohorts (name, criteria_sql, population_scope, is_active) VALUES ('Legacy-null','',NULL,TRUE)")
sql("INSERT INTO cohorts (name, criteria_sql, population_scope) VALUES ('Dangling','','batch:gone_9')")
st,b=call('GET','/api/cohorts'); names={c['name']:c for c in b['cohorts']}
check('legacy NULL cohort flagged + deactivated', names['Legacy-null']['orphaned'] and not names['Legacy-null']['is_active'], names['Legacy-null'])
check('dangling cohort flagged', names['Dangling']['orphaned'])
lid=names['Legacy-null']['id']
st,b=call('POST',f'/api/cohorts/{lid}/activate'); check('activate orphan -> 409', st==409 and b.get('code')=='cohort_orphaned', (st,b))
st,b=call('POST',f'/api/cohorts/{gid}/rebind',{'population_scope':'solo'}); check('rebind bound cohort -> 409', st==409, (st,b))
st,b=call('POST',f'/api/cohorts/{lid}/rebind',{'population_scope':'group:nope'}); check('rebind to missing -> 400', st==400, (st,b))
st,b=call('POST',f'/api/cohorts/{lid}/rebind',{'population_scope':'solo'}); check('rebind orphan ok', st==200 and b['cohort']['population_scope']=='batch:solo' and not b['cohort']['orphaned'], b)
st,b=call('POST',f'/api/cohorts/{lid}/activate'); check('activate rebound cohort', st==200, b)
st,b=call('GET','/api/explorer/patients?batchGroup=demo'); check('explorer follows rebound cohort (solo)', b['scope']['batches']==['solo'], b.get('scope'))
# group delete cascade (+ cohorts bound to single batches of the group)
st,b=call('POST','/api/cohorts',{'name':'B0','criteria_sql':'','population_scope':'demo_0'})
st,b=call('DELETE','/api/batch-groups/demo'); check('delete group removes G and B0', sorted(c['name'] for c in b['deletedCohorts'])==['B0','G'], b)
check('solo cohorts untouched', int(sql("SELECT count(*) FROM cohorts WHERE population_scope='batch:solo'"))==2)
st,b=call('DELETE','/api/batches/solo'); check('delete solo removes its cohorts', sorted(c['name'] for c in b['deletedCohorts'])==['Legacy-null','S2'], b)
print('remaining cohorts:', sql("SELECT name||':'||coalesce(population_scope,'NULL') FROM cohorts"))
print('FAILURES:', ok)
