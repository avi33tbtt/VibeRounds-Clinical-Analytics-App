// Connect to any FHIR R4 server and import its data as a batch (backend of the "Connect to a FHIR server" card, Analytics tab).
//
// Works with open servers (HAPI, SMART Health IT, Oracle Health open sandbox) and with servers that need a login:
//   auth types   none | bearer (paste a token) | basic | client_secret (OAuth2 client credentials, e.g. Oracle Health system accounts)
//                | private_key_jwt (SMART Backend Services, e.g. Epic on FHIR "Backend Systems") | headers (custom headers / API keys)
//   patient sources
//                list   Patient?_count=N (+ optional search params, e.g. family=Smith or _lastUpdated=gt2024-01-01)
//                ids    explicit Patient ids (Epic and Oracle Health do not allow an unfiltered patient list)
//                group  members of Group/{id}
//                bulk   FHIR Bulk Data $export (system or Group), the supported route for large pulls from Epic / Oracle Health
//
// Everything goes through the existing POST /api/import-fhir, so a fetch becomes a normal batch for cohorts and analytics.
//
//   GET  /api/ehr/info            presets, resource list, auth types, limits
//   POST /api/ehr/test            { connection }                       check the server (and the login) work
//   POST /api/ehr/fetch           { connection, source, batchId, maxPatients, resources?, queryProfile?, queryOverrides? } -> { jobId }
//   GET  /api/ehr/jobs/:id        progress
//   POST /api/ehr/jobs/:id/cancel
//
//   connection = { baseUrl, auth: { type, token, username, password, clientId, clientSecret, clientAuth: 'basic'|'post',
//                  tokenUrl, scope, alg, kid, privateKey, headers: {Name: value} } }
//   source     = { type, ids, groupId, patientQuery }
//
// Secrets are used only in memory for the duration of the request / job. They are never written to the database,
// logged, or returned by the API.
//
// SAFETY: a production EHR returns REAL patient data that will be stored in your database. Only do that with authorization
// (data use agreement / IRB / BAA) and a properly secured deployment. For demos use the sandboxes (synthetic data).
// Environment: EHR_BASE_URL (default server), EHR_ALLOW_HTTP=1 (allow plain http on a trusted network),
//              EHR_ALLOWED_HOSTS=host1,host2 (restrict outbound hosts), EHR_BULK_TIMEOUT_MIN (default 30).
// Self-test (mock servers, no network): node fhir-connect.js --selftest

const crypto = require('crypto');

const DEFAULT_BASE = String(process.env.EHR_BASE_URL || 'https://hapi.fhir.org/baseR4').replace(/\/+$/, '');
const ALLOW_HTTP = process.env.EHR_ALLOW_HTTP === '1';
const ALLOWED_HOSTS = (process.env.EHR_ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const BULK_TIMEOUT_MS = (Number(process.env.EHR_BULK_TIMEOUT_MIN) || 30) * 60000;

// Per-patient searches. "strict" is for servers that refuse an Observation search without a category (Epic, Oracle Health).
const DEFAULT_Q = {
  Condition: [{}], Observation: [{}], MedicationRequest: [{ _include: 'MedicationRequest:medication' }],
  Encounter: [{}], Procedure: [{}], AllergyIntolerance: [{}], Immunization: [{}]
};
const STRICT_Q = Object.assign({}, DEFAULT_Q, { Observation: [{ category: 'laboratory' }, { category: 'vital-signs' }], MedicationRequest: [{}] });
const RESOURCES = DEFAULT_Q;
const DEFAULT_RESOURCES = Object.keys(RESOURCES);
const CHUNK = 5000, PAGE_LIMIT = 200, CONCURRENCY = 4, MAX_PATIENTS = 2000;
const ID_RE = /^[A-Za-z0-9\-.]{1,64}$/;
const AUTH_TYPES = ['none', 'bearer', 'basic', 'client_secret', 'private_key_jwt', 'headers'];
const JWT_ALGS = { RS256: 'sha256', RS384: 'sha384', RS512: 'sha512', ES256: 'sha256', ES384: 'sha384', ES512: 'sha512' };

// Starting points for the form. URLs and tenant ids change: check the vendor documentation. The form lets you edit everything.
const PRESETS = [
  { id: 'hapi', name: 'HAPI public test server (open)', baseUrl: 'https://hapi.fhir.org/baseR4', auth: 'none', source: 'list', queryProfile: 'default',
    note: 'Shared synthetic test data. No login.' },
  { id: 'smart-open', name: 'SMART Health IT sandbox (open)', baseUrl: 'https://r4.smarthealthit.org', auth: 'none', source: 'list', queryProfile: 'default',
    note: 'Synthetic (Synthea) patients. No login.' },
  { id: 'oracle-open', name: 'Oracle Health (Cerner) open sandbox', baseUrl: 'https://fhir-open.cerner.com/r4/ec2458f2-1e24-41c8-b71b-0e701af7583d', auth: 'none', source: 'ids',
    queryProfile: 'strict', ids: '12724066', note: 'Open sandbox tenant, read-only, no login. It does not list patients: enter patient ids (12724066 is a documented sandbox patient).' },
  { id: 'oracle-secure', name: 'Oracle Health (Cerner) secured / production tenant', baseUrl: 'https://fhir-ehr.cerner.com/r4/<tenant-id>', auth: 'client_secret', source: 'bulk', queryProfile: 'strict',
    note: 'Register a system account in the Oracle Health developer console, replace <tenant-id>, then enter client id and secret. Token URL is discovered from the server if left empty.' },
  { id: 'epic', name: 'Epic on FHIR (Backend Systems app)', baseUrl: 'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4', auth: 'private_key_jwt', alg: 'RS384', source: 'ids', queryProfile: 'strict',
    note: 'Register a Backend Systems app on fhir.epic.com, upload your public key there, then paste the client id, key id and your PRIVATE key here. Epic does not list all patients: use patient ids, a Group, or Bulk export. Use each customer\'s own FHIR base URL in production.' },
  { id: 'bearer', name: 'Any server with an access token (Medplum, Azure, AWS HealthLake, Google...)', baseUrl: '', auth: 'bearer', source: 'list', queryProfile: 'default',
    note: 'Paste a valid access token. For cloud FHIR stores you can also use "OAuth2 client credentials" with the provider\'s token URL.' },
  { id: 'custom', name: 'Custom server', baseUrl: '', auth: 'none', source: 'list', queryProfile: 'default', note: '' }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
const noteErr = (j, msg) => { if (j.errors.length < 20) j.errors.push(msg); };

// ---- outbound URL guard (this server fetches whatever URL the form contains) -----------------------------------
function guardUrl(raw, what = 'URL') {
  let u; try { u = new URL(raw); } catch (e) { throw httpErr(400, `${what} is not a valid URL`); }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (loopback || ALLOW_HTTP))) throw httpErr(400, `${what} must use https (set EHR_ALLOW_HTTP=1 to allow plain http on a trusted network)`);
  if (/^169\.254\./.test(host) || host === 'metadata.google.internal' || host.startsWith('fe80:')) throw httpErr(400, `${what} points to a blocked address`);
  if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.includes(host)) throw httpErr(403, `${host} is not in EHR_ALLOWED_HOSTS`);
  return u;
}

// ---- auth ---------------------------------------------------------------------------------------------------
function normalizeAuth(a) {
  a = a || {};
  const type = AUTH_TYPES.includes(a.type) ? a.type : 'none', s = k => String(a[k] == null ? '' : a[k]).trim();
  const out = { type, token: s('token').replace(/^Bearer\s+/i, ''), username: s('username'), password: String(a.password || ''), clientId: s('clientId'), clientSecret: String(a.clientSecret || ''),
    clientAuth: a.clientAuth === 'post' ? 'post' : 'basic', tokenUrl: s('tokenUrl'), scope: s('scope'), alg: s('alg') || 'RS384', kid: s('kid'),
    privateKey: String(a.privateKey || '').replace(/\\n/g, '\n').trim(), headers: {} };
  for (const [k, v] of Object.entries(a.headers && typeof a.headers === 'object' ? a.headers : {})) {
    if (!/^[A-Za-z0-9-]{1,60}$/.test(k) || /^(host|content-length|connection|transfer-encoding)$/i.test(k)) throw httpErr(400, `Header name "${k}" is not allowed`);
    out.headers[k] = String(v).replace(/[\r\n]/g, ' ').slice(0, 2000);
  }
  if (type === 'bearer' && !out.token) throw httpErr(400, 'Access token is required');
  if (type === 'basic' && !out.username) throw httpErr(400, 'Username is required');
  if ((type === 'client_secret' || type === 'private_key_jwt') && !out.clientId) throw httpErr(400, 'Client id is required');
  if (type === 'client_secret' && !out.clientSecret) throw httpErr(400, 'Client secret is required');
  if (type === 'private_key_jwt') {
    if (!JWT_ALGS[out.alg]) throw httpErr(400, `Signing algorithm must be one of ${Object.keys(JWT_ALGS).join(', ')}`);
    if (!out.privateKey) throw httpErr(400, 'Private key (PEM) is required');
    try { crypto.createPrivateKey(out.privateKey); } catch (e) { throw httpErr(400, 'Private key is not a valid PEM key (use "-----BEGIN PRIVATE KEY-----" PKCS#8 or RSA / EC PEM)'); }
  }
  if (type === 'headers' && !Object.keys(out.headers).length) throw httpErr(400, 'Add at least one header');
  if (out.tokenUrl) guardUrl(out.tokenUrl, 'Token URL');
  return out;
}

const b64u = x => Buffer.from(x).toString('base64url');
// SMART Backend Services client assertion (RFC 7523): short-lived JWT signed with the app's private key
function signJwt({ clientId, tokenUrl, privateKey, kid, alg }) {
  const header = { alg, typ: 'JWT' }; if (kid) header.kid = kid;
  const now = Math.floor(Date.now() / 1000), payload = { iss: clientId, sub: clientId, aud: tokenUrl, jti: crypto.randomUUID(), iat: now, exp: now + 240 };
  const data = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`, key = crypto.createPrivateKey(privateKey);
  const sig = alg.startsWith('ES') ? crypto.sign(JWT_ALGS[alg], Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }) : crypto.sign(JWT_ALGS[alg], Buffer.from(data), key);
  return `${data}.${b64u(sig)}`;
}

// ---- HTTP client for one connection ---------------------------------------------------------------------------
function makeClient(raw) {
  const c = raw || {};
  const base = String(c.baseUrl || DEFAULT_BASE).trim().replace(/\/+$/, '');
  const baseUrl = guardUrl(base, 'Server URL'), origin = baseUrl.origin;
  const auth = normalizeAuth(c.auth), needsToken = auth.type === 'client_secret' || auth.type === 'private_key_jwt';
  let tok = null, tokExp = 0, pending = null, tokenUrl = auth.tokenUrl;

  async function discoverTokenUrl(signal) {
    const plain = async p => { const r = await fetch(`${base}${p}`, { headers: { Accept: 'application/json' }, signal }); if (!r.ok) throw new Error(String(r.status)); return r.json(); };
    try { const j = await plain('/.well-known/smart-configuration'); if (j.token_endpoint) return j.token_endpoint; } catch (e) { /* try the capability statement */ }
    try {
      const cs = await plain('/metadata?_summary=true');
      const ext = (((cs.rest || [])[0] || {}).security || {}).extension || [];
      const uris = ext.find(x => /oauth-uris$/.test(x.url || ''));
      const t = uris && (uris.extension || []).find(x => x.url === 'token');
      if (t && t.valueUri) return t.valueUri;
    } catch (e) { /* fall through */ }
    throw httpErr(400, 'Could not find the token URL on the server; enter it in "Token URL"');
  }

  async function requestToken(signal) {
    if (!tokenUrl) tokenUrl = await discoverTokenUrl(signal);
    guardUrl(tokenUrl, 'Token URL');
    const body = new URLSearchParams({ grant_type: 'client_credentials' }), headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (auth.scope) body.set('scope', auth.scope);
    if (auth.type === 'private_key_jwt') {
      body.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      body.set('client_assertion', signJwt({ clientId: auth.clientId, tokenUrl, privateKey: auth.privateKey, kid: auth.kid, alg: auth.alg }));
    } else if (auth.clientAuth === 'post') { body.set('client_id', auth.clientId); body.set('client_secret', auth.clientSecret); }
    else headers.Authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(auth.clientId)}:${encodeURIComponent(auth.clientSecret)}`).toString('base64');
    const r = await fetch(tokenUrl, { method: 'POST', headers, body: body.toString(), signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw httpErr(401, `Token request failed (${r.status}): ${j.error_description || j.error || 'no access_token in the answer'}`);
    tok = j.access_token; tokExp = Date.now() + (Number(j.expires_in) || 300) * 1000;
    return tok;
  }
  const getToken = (force, signal) => {
    if (!force && tok && Date.now() < tokExp - 30000) return Promise.resolve(tok);
    if (!pending) pending = requestToken(signal).finally(() => { pending = null; });
    return pending;
  };
  async function authHeaders(force, signal) {
    const h = Object.assign({}, auth.headers);
    if (auth.type === 'bearer') h.Authorization = `Bearer ${auth.token}`;
    else if (auth.type === 'basic') h.Authorization = 'Basic ' + Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
    else if (needsToken) h.Authorization = `Bearer ${await getToken(force, signal)}`;
    return h;
  }

  // GET (or other) with retry on 429 / 5xx and one token refresh on 401. Credentials are only sent to the configured server.
  async function request(url, { signal, accept = 'application/fhir+json', method = 'GET', headers: extra = {}, auth: useAuth } = {}) {
    const u = guardUrl(url, 'URL'), sendAuth = useAuth !== false && u.origin === origin;
    let refreshed = false, force = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (signal && signal.aborted) throw httpErr(499, 'Cancelled');
      const h = Object.assign({ Accept: accept }, extra, sendAuth ? await authHeaders(force, signal) : {});
      force = false;
      const r = await fetch(url, { method, headers: h, signal });
      if (r.ok) return r;
      const drop = () => r.body && r.body.cancel().catch(() => {});
      if (r.status === 401 && needsToken && sendAuth && !refreshed) { refreshed = true; force = true; await drop(); continue; }
      if (r.status === 429 || r.status >= 500) { const ra = Number(r.headers.get('retry-after')); await drop(); await sleep(ra > 0 ? Math.min(ra, 60) * 1000 : 500 * 2 ** attempt); continue; }
      throw httpErr(r.status, `${r.status} on ${url.replace(/\?.*/, '')}: ${(await r.text()).slice(0, 160)}`);
    }
    throw httpErr(502, `Server kept failing on ${url.replace(/\?.*/, '')}`);
  }
  const getJson = async (url, signal) => (await request(url, { signal })).json();
  return { base, host: baseUrl.host, authType: auth.type, request, getJson, getToken };
}

// ---- paging / helpers -----------------------------------------------------------------------------------------
// follow Bundle.link[next], always on the configured server
function sameServer(u, base) {
  if (!/^https?:\/\//i.test(u)) return `${base}/${u.replace(/^\/+/, '')}`;
  const x = new URL(u), bp = new URL(base).pathname.replace(/\/+$/, '');
  const p = bp && x.pathname.startsWith(bp) ? x.pathname.slice(bp.length) : x.pathname;
  return `${base}${p}${x.search}`;
}
async function* pages(firstUrl, client, signal) {
  let url = firstUrl, n = 0;
  while (url && n++ < PAGE_LIMIT) {
    const b = await client.getJson(url, signal); yield b;
    const nx = (b.link || []).find(l => l.relation === 'next'); url = nx ? sameServer(nx.url, client.base) : null;
  }
}

// MedicationRequest often only points to a Medication resource; copy its code so the importer keeps the drug code
function inlineOne(r, meds) {
  if (r.resourceType !== 'MedicationRequest' || r.medicationCodeableConcept || !r.medicationReference) return;
  const ref = String(r.medicationReference.reference || '').replace(/^#/, '').replace(/^Medication\//, '');
  const m = (meds && meds.get(ref)) || (r.contained || []).find(c => c.id === ref);
  if (m && m.code) r.medicationCodeableConcept = m.code;
  else if (r.medicationReference.display) r.medicationCodeableConcept = { text: r.medicationReference.display, coding: [{ display: r.medicationReference.display }] };
}
function inlineMedications(entries) {
  const meds = new Map(entries.filter(e => e.resource.resourceType === 'Medication').map(e => [e.resource.id, e.resource]));
  for (const e of entries) inlineOne(e.resource, meds);
  return entries.filter(e => e.resource.resourceType !== 'Medication');
}
const patientIdOf = r => { const m = String(((r.subject || r.patient || {}).reference) || '').match(/(?:^|\/)Patient\/([^/]+)$/); return m ? m[1] : null; };

// ---- input normalisation --------------------------------------------------------------------------------------
function normalizeSource(s) {
  s = s || {};
  const type = ['list', 'ids', 'group', 'bulk'].includes(s.type) ? s.type : 'list';
  const ids = [...new Set(String(s.ids || '').split(/[\s,;]+/).filter(Boolean))];
  if (ids.some(x => !ID_RE.test(x))) throw httpErr(400, 'Patient ids may only contain letters, digits, - and .');
  const groupId = String(s.groupId || '').trim();
  if (groupId && !ID_RE.test(groupId)) throw httpErr(400, 'Group id may only contain letters, digits, - and .');
  if (type === 'ids' && !ids.length) throw httpErr(400, 'Enter at least one patient id');
  if (type === 'group' && !groupId) throw httpErr(400, 'Enter a group id');
  const pq = String(s.patientQuery || '').trim().replace(/^\?/, '');
  if (pq.length > 300) throw httpErr(400, 'Patient search parameters are too long');
  return { type, ids, groupId, query: Object.fromEntries(new URLSearchParams(pq)) };
}
function buildQueries(profile, overrides) {
  const q = JSON.parse(JSON.stringify(profile === 'strict' ? STRICT_Q : DEFAULT_Q));
  let o = overrides;
  if (typeof o === 'string') { if (!o.trim()) o = null; else try { o = JSON.parse(o); } catch (e) { throw httpErr(400, 'Search overrides are not valid JSON'); } }
  if (o && typeof o === 'object') for (const [t, list] of Object.entries(o)) {
    if (!q[t]) throw httpErr(400, `Unknown resource type in search overrides: ${t}`);
    if (!Array.isArray(list) || list.some(x => !x || typeof x !== 'object' || Object.values(x).some(v => typeof v !== 'string'))) throw httpErr(400, `Search overrides for ${t} must be a list of {"param": "value"} objects`);
    q[t] = list.length ? list : [{}];
  }
  return q;
}

// ---- jobs ---------------------------------------------------------------------------------------------------
const JOBS = new Map();
function newJob(batchId, meta) {
  const j = Object.assign({ id: crypto.randomUUID(), status: 'running', phase: 'starting', batchId, patientsTotal: 0, patientsDone: 0, resources: {}, imported: 0, errors: [], startedAt: Date.now(), finishedAt: null, ctl: new AbortController() }, meta || {});
  JOBS.set(j.id, j); if (JOBS.size > 30) JOBS.delete(JOBS.keys().next().value); return j;
}
const view = j => ({ id: j.id, status: j.status, phase: j.phase, batchId: j.batchId, batchSuffix: j.batchSuffix || null, server: j.server || null, source: j.sourceType || null,
  patientsTotal: j.patientsTotal, patientsDone: j.patientsDone, resources: j.resources, imported: j.imported, errors: j.errors, message: j.message || null,
  seconds: Math.round(((j.finishedAt || Date.now()) - j.startedAt) / 1000) });

// sends resources to /api/import-fhir in chunks, one at a time
function makeFlusher(job, importUrl) {
  let buf = [], chain = Promise.resolve();
  const send = part => { chain = chain.then(async () => {
    job.phase = 'importing';
    const r = await fetch(importUrl, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, job.importHeaders || {}), body: JSON.stringify({ batchId: job.batchId, bundle: { resourceType: 'Bundle', type: 'collection', entry: part } }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) throw httpErr(502, `Import failed: ${j.details || j.error || r.status}`);
    job.batchSuffix = j.batchSuffix; job.imported += part.length; job.phase = 'fetching';
  }); return chain; };
  return {
    async add(entries) { buf.push(...entries); if (buf.length >= CHUNK) { const part = buf; buf = []; await send(part); } },
    async done() { if (buf.length) { const part = buf; buf = []; await send(part); } await chain; }
  };
}

async function findPatients(client, max, signal, query) {
  const out = new Map(), qs = new URLSearchParams(Object.assign({ _count: String(Math.min(max, 100)) }, query || {}));
  for await (const b of pages(`${client.base}/Patient?${qs}`, client, signal)) {
    for (const e of b.entry || []) if (e.resource && e.resource.resourceType === 'Patient' && e.resource.id && out.size < max) out.set(e.resource.id, e.resource);
    if (out.size >= max) break;
  }
  return [...out.values()];
}
async function resolvePatients(job, client, source, max, signal) {
  if (source.type === 'list') return findPatients(client, max, signal, source.query);
  let ids = source.ids;
  if (source.type === 'group') {
    const g = await client.getJson(`${client.base}/Group/${encodeURIComponent(source.groupId)}`, signal);
    ids = (g.member || []).map(m => String(((m.entity || {}).reference) || '').replace(/^Patient\//, '')).filter(x => ID_RE.test(x));
    if (!ids.length) throw httpErr(404, 'The group has no patient members');
  }
  ids = [...new Set(ids)].slice(0, max);
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, async () => {
    while (i < ids.length) {
      const id = ids[i++];
      try { const p = await client.getJson(`${client.base}/Patient/${encodeURIComponent(id)}`, signal); if (p && p.resourceType === 'Patient') out.push(p); }
      catch (e) { if (signal.aborted) return; noteErr(job, `Patient ${id}: ${e.message}`); }
    }
  }));
  return out;
}

// per patient: one search per resource type
async function runPaged(job, { client, resources, maxPatients, source, queries, importUrl }) {
  const signal = job.ctl.signal;
  job.phase = 'finding patients';
  const patients = await resolvePatients(job, client, source, maxPatients, signal);
  if (!patients.length) throw httpErr(404, 'The server returned no patients');
  job.patientsTotal = patients.length; job.resources.Patient = patients.length;
  const fl = makeFlusher(job, importUrl);
  await fl.add(patients.map(p => ({ fullUrl: `Patient/${p.id}`, resource: p })));
  job.phase = 'fetching';
  let idx = 0;
  const worker = async () => {
    while (idx < patients.length) {
      if (signal.aborted) return;
      const p = patients[idx++], mine = [];
      for (const type of resources) for (const extra of queries[type]) {
        const qs = new URLSearchParams(Object.assign({}, extra, { patient: p.id, _count: '100' }));
        try {
          for await (const b of pages(`${client.base}/${type}?${qs}`, client, signal))
            for (const e of b.entry || []) if (e.resource && e.resource.resourceType !== 'OperationOutcome') mine.push({ fullUrl: `${e.resource.resourceType}/${e.resource.id}`, resource: e.resource });
        } catch (e) { if (signal.aborted) return; noteErr(job, `${type} for patient ${p.id}: ${e.message}`); }
      }
      const fixed = inlineMedications(mine);
      for (const e of fixed) job.resources[e.resource.resourceType] = (job.resources[e.resource.resourceType] || 0) + 1;
      job.patientsDone++;
      await fl.add(fixed);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, patients.length) }, worker));
  if (signal.aborted) return;
  await fl.done();
}

// FHIR Bulk Data: kick-off, poll, download NDJSON files, keep the first N patients and only their data
async function* ndjson(res) {
  const dec = new TextDecoder(); let rest = '';
  const parse = line => { try { return JSON.parse(line); } catch (e) { return null; } };
  for await (const chunk of res.body) {
    rest += dec.decode(chunk, { stream: true }); let i;
    while ((i = rest.indexOf('\n')) >= 0) { const line = rest.slice(0, i).trim(); rest = rest.slice(i + 1); const o = line && parse(line); if (o) yield o; }
  }
  const o = rest.trim() && parse(rest.trim()); if (o) yield o;
}
async function runBulk(job, { client, resources, maxPatients, source, importUrl, pollMinMs = 2000 }) {
  const signal = job.ctl.signal;
  const types = ['Patient', ...resources, ...(resources.includes('MedicationRequest') ? ['Medication'] : [])];
  const kick = source.groupId ? `${client.base}/Group/${encodeURIComponent(source.groupId)}/$export` : `${client.base}/Patient/$export`;
  job.phase = 'requesting export';
  const r0 = await client.request(`${kick}?${new URLSearchParams({ _type: types.join(','), _outputFormat: 'application/fhir+ndjson' })}`, { signal, headers: { Prefer: 'respond-async' } });
  const loc = r0.headers.get('content-location'); await (r0.body && r0.body.cancel().catch(() => {}));
  if (!loc) throw httpErr(502, 'The server accepted $export but sent no Content-Location to poll');
  const statusUrl = new URL(loc, client.base + '/').toString();
  let manifest = null;
  try {
    const deadline = Date.now() + BULK_TIMEOUT_MS; let wait = pollMinMs;
    while (!manifest) {
      if (Date.now() > deadline) throw httpErr(504, 'The bulk export did not finish in time (EHR_BULK_TIMEOUT_MIN)');
      await sleep(wait);
      const r = await client.request(statusUrl, { signal, accept: 'application/json' });
      if (r.status === 202) {
        const ra = Number(r.headers.get('retry-after')), pr = r.headers.get('x-progress');
        wait = Math.min(30000, Math.max(pollMinMs, ra > 0 ? ra * 1000 : wait * 1.5)); job.phase = `waiting for the server to prepare the export${pr ? ` (${String(pr).slice(0, 60)})` : ''}`;
        await (r.body && r.body.cancel().catch(() => {}));
      } else manifest = await r.json();
    }
    const rank = t => (t === 'Patient' ? 0 : t === 'Medication' ? 1 : 2);
    const files = (manifest.output || []).filter(o => types.includes(o.type) && o.url).sort((a, b) => rank(a.type) - rank(b.type));
    if (!files.length) throw httpErr(404, 'The export contained no files for the selected resources');
    const keep = new Set(), meds = new Map(), fl = makeFlusher(job, importUrl);
    job.phase = 'downloading';
    for (const f of files) {
      if (signal.aborted) return;
      const res = await client.request(f.url, { signal, accept: 'application/fhir+ndjson' });
      for await (const x of ndjson(res)) {
        if (signal.aborted) return;
        const t = x.resourceType;
        if (t === 'Patient') { if (!x.id || keep.size >= maxPatients) { if (keep.size >= maxPatients) break; continue; } keep.add(x.id); job.patientsTotal = job.patientsDone = keep.size; }
        else if (t === 'Medication') { meds.set(x.id, x); continue; }
        else { const pid = patientIdOf(x); if (!pid || !keep.has(pid)) continue; inlineOne(x, meds); }
        job.resources[t] = (job.resources[t] || 0) + 1;
        await fl.add([{ fullUrl: `${t}/${x.id}`, resource: x }]);
      }
    }
    if (!keep.size) throw httpErr(404, 'The export contained no patients');
    await fl.done();
  } finally {
    client.request(statusUrl, { method: 'DELETE', accept: 'application/json' }).catch(() => {});   // tell the server it can delete the export
  }
}

async function runJob(job, opts) {
  try {
    if (opts.source.type === 'bulk') await runBulk(job, opts); else await runPaged(job, opts);
    if (job.ctl.signal.aborted) { job.status = 'cancelled'; job.message = 'Cancelled. Anything already imported stays in the batch; delete the batch to remove it.'; return; }
    job.status = 'done'; job.phase = 'done';
    job.message = `Imported ${job.imported.toLocaleString()} resources for ${job.patientsDone} patients into batch "${job.batchId}".`;
  } catch (err) {
    job.status = job.ctl.signal.aborted ? 'cancelled' : 'error'; job.message = err.message; noteErr(job, err.message);
  } finally { job.finishedAt = Date.now(); }
}

// ---- Express wiring -----------------------------------------------------------------------------------------
function register(app, pool, { port, importToken }) {
  const json = require('express').json({ limit: '1mb' });
  const fail = (res, err) => res.status(err.status >= 400 && err.status < 600 ? err.status : 500).json({ success: false, error: err.message });

  app.get('/api/ehr/info', (req, res) => res.json({ success: true, baseUrl: DEFAULT_BASE, resources: DEFAULT_RESOURCES, maxPatients: MAX_PATIENTS, presets: PRESETS,
    authTypes: AUTH_TYPES, jwtAlgs: Object.keys(JWT_ALGS), allowHttp: ALLOW_HTTP, allowedHosts: ALLOWED_HOSTS }));

  app.post('/api/ehr/test', json, async (req, res) => {
    try {
      const client = makeClient((req.body || {}).connection);
      if (client.authType === 'client_secret' || client.authType === 'private_key_jwt') await client.getToken(true);
      const cs = await client.getJson(`${client.base}/metadata?_summary=true`);
      let listPatients = true;
      try { await client.getJson(`${client.base}/Patient?_count=1`); } catch (e) { listPatients = false; }
      res.json({ success: true, host: client.host, fhirVersion: cs.fhirVersion || null, software: (cs.software || {}).name || null, authenticated: client.authType !== 'none', listPatients });
    } catch (err) { fail(res, err); }
  });

  app.post('/api/ehr/fetch', json, async (req, res) => {
    try {
      const b = req.body || {}, batchId = String(b.batchId || '').trim();
      if (!/^[A-Za-z0-9_ .-]{1,60}$/.test(batchId)) throw httpErr(400, 'Batch name is required (letters, digits, space, _ . -, up to 60)');
      const resources = (Array.isArray(b.resources) && b.resources.length ? b.resources : DEFAULT_RESOURCES).filter(r => RESOURCES[r]);
      if (!resources.length) throw httpErr(400, 'Pick at least one resource type');
      const maxPatients = Math.min(MAX_PATIENTS, Math.max(1, Math.floor(Number(b.maxPatients) || 25)));
      const client = makeClient(b.connection), source = normalizeSource(b.source), queries = buildQueries(b.queryProfile, b.queryOverrides);
      if ([...JOBS.values()].some(j => j.status === 'running')) throw httpErr(409, 'Another fetch is still running');
      const job = newJob(batchId, { server: client.host, sourceType: source.type });
      if (importToken) Object.defineProperty(job, 'importHeaders', { value: { 'X-Import-Token': importToken }, enumerable: false });   // loopback import passes the server's lock
      runJob(job, { client, resources, maxPatients, source, queries, importUrl: `http://127.0.0.1:${port}/api/import-fhir` });
      res.json({ success: true, jobId: job.id });
    } catch (err) { fail(res, err); }
  });

  app.get('/api/ehr/jobs/:id', (req, res) => { const j = JOBS.get(req.params.id); if (!j) return res.status(404).json({ success: false, error: 'Unknown job' }); res.json({ success: true, job: view(j) }); });
  app.post('/api/ehr/jobs/:id/cancel', (req, res) => { const j = JOBS.get(req.params.id); if (!j) return res.status(404).json({ success: false, error: 'Unknown job' }); j.ctl.abort(); res.json({ success: true }); });
}

module.exports = register;
module.exports.pure = { inlineMedications, sameServer, runJob, newJob, makeClient, normalizeAuth, normalizeSource, buildQueries, signJwt, guardUrl, RESOURCES, DEFAULT_Q, STRICT_Q };

// ---- self-test (mock FHIR servers + token endpoint + import endpoint) -------------------------------------------
if (require.main === module && process.argv.includes('--selftest')) {
  (async () => {
    const assert = require('assert'), http = require('http'), imported = [];
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const mk = (type, id, pid, extra) => Object.assign({ resourceType: type, id, subject: { reference: `Patient/${pid}` } }, extra);
    const state = { tokens: 0, deleted: 0, polls: 0, jwtOk: false, secretOk: false };
    let origin = '', dataOrigin = '';
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x'), send = (o, c = 200, h = {}) => { res.writeHead(c, Object.assign({ 'Content-Type': 'application/json' }, h)); res.end(typeof o === 'string' ? o : JSON.stringify(o)); };
      let body = ''; req.on('data', d => body += d); req.on('end', () => {
        if (u.pathname === '/api/import-fhir') { const j = JSON.parse(body); imported.push(...j.bundle.entry); return send({ success: true, batchSuffix: 'b1', batchId: j.batchId }); }
        if (u.pathname === '/token') {
          const f = new URLSearchParams(body);
          if (f.get('client_assertion')) {
            const [h, p, s] = f.get('client_assertion').split('.'), pl = JSON.parse(Buffer.from(p, 'base64url')), hd = JSON.parse(Buffer.from(h, 'base64url'));
            state.jwtOk = crypto.verify('sha384', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')) && pl.iss === 'app1' && pl.sub === 'app1' && pl.aud === `${origin}/token` && hd.kid === 'k1' && hd.alg === 'RS384';
            if (!state.jwtOk) return send({ error: 'invalid_client' }, 401);
          } else { state.secretOk = req.headers.authorization === 'Basic ' + Buffer.from('cid:sec').toString('base64'); if (!state.secretOk) return send({ error: 'invalid_client' }, 401); }
          state.tokens++; return send({ access_token: `tok${state.tokens}`, expires_in: 300 });
        }
        if (u.pathname === '/fhir/.well-known/smart-configuration') return send({ token_endpoint: `${origin}/token` });
        if (!u.pathname.startsWith('/fhir/') && !u.pathname.startsWith('/status/')) return send({}, 404);
        const authz = req.headers.authorization || '';
        if (!/^Bearer tok\d+$/.test(authz) || (state.tokens > 1 && authz !== `Bearer tok${state.tokens}`)) return send({ resourceType: 'OperationOutcome' }, 401);
        if (u.pathname === '/status/1') {
          if (req.method === 'DELETE') { state.deleted++; return send({}, 202); }
          if (++state.polls < 2) return send({}, 202, { 'Retry-After': '0', 'X-Progress': '50%' });
          return send({ output: [{ type: 'Condition', url: `${dataOrigin}/data/condition.ndjson` }, { type: 'MedicationRequest', url: `${dataOrigin}/data/medreq.ndjson` },
            { type: 'Medication', url: `${dataOrigin}/data/med.ndjson` }, { type: 'Patient', url: `${dataOrigin}/data/patient.ndjson` }] });
        }
        if (u.pathname === '/fhir/Patient/$export') return send({}, 202, { 'Content-Location': `${origin}/status/1` });
        if (u.pathname === '/fhir/Group/g1') return send({ resourceType: 'Group', member: [{ entity: { reference: 'Patient/p2' } }, { entity: { reference: 'Patient/p1' } }] });
        const rd = u.pathname.match(/^\/fhir\/Patient\/([^/]+)$/); if (rd) return send({ resourceType: 'Patient', id: rd[1] });
        if (u.pathname === '/fhir/Patient') { const p = u.searchParams.get('page'); return send({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Patient', id: p ? 'p2' : 'p1' } }],
          link: p ? [] : [{ relation: 'next', url: `http://${req.headers.host}/fhir/Patient?page=2` }] }); }
        const pid = u.searchParams.get('patient'), t = u.pathname.replace('/fhir/', '');
        if (t === 'Condition') return send({ resourceType: 'Bundle', entry: [{ resource: mk('Condition', `c-${pid}`, pid, { code: { coding: [{ code: '44054006' }] } }) }] });
        if (t === 'MedicationRequest') return send({ resourceType: 'Bundle', entry: [{ resource: mk('MedicationRequest', `m-${pid}`, pid, { medicationReference: { reference: 'Medication/rx1' } }) },
          { resource: { resourceType: 'Medication', id: 'rx1', code: { coding: [{ code: '860975' }] } } }] });
        if (t === 'Observation') return pid === 'p2' ? send({ resourceType: 'OperationOutcome' }, 400) : send({ resourceType: 'Bundle', entry: [{ resource: mk('Observation', `o-${pid}`, pid) }] });
        return send({ resourceType: 'Bundle', entry: [] });
      });
    });
    const data = {
      'patient.ndjson': ['p1', 'p2', 'p3'].map(id => ({ resourceType: 'Patient', id })),
      'condition.ndjson': ['p1', 'p2', 'p3'].map(id => mk('Condition', `c-${id}`, id, { code: { coding: [{ code: '44054006' }] } })),
      'med.ndjson': [{ resourceType: 'Medication', id: 'rx1', code: { coding: [{ code: '860975' }] } }],
      'medreq.ndjson': ['p1', 'p3'].map(id => mk('MedicationRequest', `m-${id}`, id, { medicationReference: { reference: 'Medication/rx1' } }))
    };
    const seenAuth = [];
    const dataSrv = http.createServer((req, res) => { seenAuth.push(req.headers.authorization || ''); const f = data[req.url.replace('/data/', '')]; if (!f) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': 'application/fhir+ndjson' }); res.end(f.map(o => JSON.stringify(o)).join('\n') + '\n'); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r)); await new Promise(r => dataSrv.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${srv.address().port}`;
    dataOrigin = `http://127.0.0.1:${dataSrv.address().port}`;   // bulk files live on another origin

    // --- pure helpers
    const { sameServer: ss } = module.exports.pure;
    assert.strictEqual(ss('http://other/fhir/Patient?page=2', `${origin}/fhir`), `${origin}/fhir/Patient?page=2`, 'next link stays on the configured server');
    assert.strictEqual(ss('https://r4.example.org/Patient?page=2', 'https://r4.example.org'), 'https://r4.example.org/Patient?page=2', 'server without a path prefix');
    assert.throws(() => guardUrl('http://example.org/fhir'), /https/); assert.throws(() => guardUrl('https://169.254.169.254/x'), /blocked/); guardUrl('http://127.0.0.1:1/x');
    assert.throws(() => normalizeAuth({ type: 'bearer' }), /token/); assert.throws(() => normalizeAuth({ type: 'private_key_jwt', clientId: 'a', privateKey: 'nope' }), /PEM/);
    assert.throws(() => normalizeSource({ type: 'ids', ids: '../x' }), /ids may only/); assert.deepStrictEqual(normalizeSource({ type: 'list', patientQuery: '?family=Smith' }).query, { family: 'Smith' });
    assert.deepStrictEqual(buildQueries('strict').Observation.map(o => o.category), ['laboratory', 'vital-signs']);
    assert.deepStrictEqual(buildQueries('default', '{"Observation":[{"code":"4548-4"}]}').Observation, [{ code: '4548-4' }]); assert.throws(() => buildQueries('default', '{"Nope":[]}'), /Unknown/);

    // --- no credentials -> 401 from the server
    await assert.rejects(makeClient({ baseUrl: `${origin}/fhir` }).getJson(`${origin}/fhir/Patient`), e => e.status === 401);

    // --- private_key_jwt (Epic style) + paged list
    const mkConn = () => ({ baseUrl: `${origin}/fhir`, auth: { type: 'private_key_jwt', clientId: 'app1', kid: 'k1', alg: 'RS384', privateKey: pem } });   // token URL discovered
    let client = makeClient(mkConn()); const list = { type: 'list', ids: [], query: {} }, queries = buildQueries('default');
    let job = newJob('mock batch');
    await runJob(job, { client, resources: ['Condition', 'Observation', 'MedicationRequest'], maxPatients: 10, source: list, queries, importUrl: `${origin}/api/import-fhir` });
    assert.strictEqual(job.status, 'done', job.message); assert.ok(state.jwtOk, 'signed client assertion verified with the public key');
    assert.strictEqual(job.patientsTotal, 2, 'paged patient search followed the next link');
    let types = imported.map(e => e.resource.resourceType);
    assert.strictEqual(types.filter(t => t === 'Patient').length, 2); assert.strictEqual(types.filter(t => t === 'Condition').length, 2);
    assert.strictEqual(types.filter(t => t === 'Observation').length, 1, 'a failing resource search is skipped, not fatal');
    assert.ok(job.errors.some(e => /Observation for patient p2/.test(e)), 'and reported as a warning');
    assert.ok(!types.includes('Medication')); assert.strictEqual(imported.find(e => e.resource.resourceType === 'MedicationRequest').resource.medicationCodeableConcept.coding[0].code, '860975');
    assert.strictEqual(job.batchSuffix, 'b1'); assert.ok(!JSON.stringify(view(job)).includes('BEGIN'), 'job view carries no secrets');

    // --- token refresh on 401 (server rotated its token)
    state.tokens += 1; const before = state.tokens;
    client = makeClient(mkConn()); await client.getJson(`${origin}/fhir/Patient/p1`);
    assert.ok(state.tokens > before, 'token fetched');

    // --- client_secret (Oracle Health style) + ids and group sources
    client = makeClient({ baseUrl: `${origin}/fhir`, auth: { type: 'client_secret', clientId: 'cid', clientSecret: 'sec', tokenUrl: `${origin}/token`, scope: 'system/*.read' } });
    imported.length = 0; job = newJob('ids');
    await runJob(job, { client, resources: ['Condition'], maxPatients: 10, source: normalizeSource({ type: 'ids', ids: 'p1, p2' }), queries, importUrl: `${origin}/api/import-fhir` });
    assert.ok(state.secretOk && job.status === 'done', job.message); assert.strictEqual(job.patientsTotal, 2);
    imported.length = 0; job = newJob('group');
    await runJob(job, { client, resources: ['Condition'], maxPatients: 1, source: normalizeSource({ type: 'group', groupId: 'g1' }), queries, importUrl: `${origin}/api/import-fhir` });
    assert.strictEqual(job.patientsTotal, 1, 'group members limited by maxPatients');

    // --- bulk export: files on another origin (no credentials sent there), patients limited to 2, medications inlined, export deleted afterwards
    imported.length = 0; job = newJob('bulk');
    await runJob(job, { client, resources: ['Condition', 'MedicationRequest'], maxPatients: 2, source: normalizeSource({ type: 'bulk' }), queries, pollMinMs: 5, importUrl: `${origin}/api/import-fhir` });
    assert.strictEqual(job.status, 'done', job.message); assert.strictEqual(job.patientsTotal, 2);
    types = imported.map(e => e.resource.resourceType);
    assert.strictEqual(types.filter(t => t === 'Patient').length, 2); assert.strictEqual(types.filter(t => t === 'Condition').length, 2, 'only the kept patients\' data');
    assert.strictEqual(types.filter(t => t === 'MedicationRequest').length, 1, 'p3 was cut off, p1 kept'); assert.ok(!types.includes('Medication'));
    assert.strictEqual(imported.find(e => e.resource.resourceType === 'MedicationRequest').resource.medicationCodeableConcept.coding[0].code, '860975', 'Medication file inlined');
    assert.ok(seenAuth.length >= 4 && seenAuth.every(a => a === ''), 'credentials are not sent to the other origin');
    await sleep(50); assert.strictEqual(state.deleted, 1, 'export deleted on the server');
    srv.close(); dataSrv.close();
    console.log('fhir-connect.js self-test: all checks passed');
  })().catch(e => { console.error(e); process.exit(1); });
}
