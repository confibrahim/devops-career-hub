import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const APP_URL = process.env.APP_URL || `http://${HOST}:${PORT}`;
const STATUSES = ['Interested', 'To Apply', 'Applied', 'Follow-up Required', 'Interview', 'Technical Assessment', 'Offer', 'Rejected', 'Withdrawn'];
const CLOSED = ['Rejected', 'Withdrawn'];
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
const db = new DatabaseSync(path.join(ROOT, 'data', 'career-hub.sqlite'));
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company TEXT NOT NULL,
    job_title TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    salary_range TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    advert_url TEXT NOT NULL DEFAULT '',
    date_applied TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    contact_name TEXT NOT NULL DEFAULT '',
    contact_details TEXT NOT NULL DEFAULT '',
    follow_up_date TEXT NOT NULL DEFAULT '',
    interview_date TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    cv_version TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS followups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    contact_date TEXT NOT NULL,
    outcome TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    next_follow_up_date TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    csrf_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    session_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS github_tokens (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    encrypted_token TEXT NOT NULL,
    iv TEXT NOT NULL,
    auth_tag TEXT NOT NULL,
    login TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS github_settings (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    project_id TEXT NOT NULL DEFAULT '',
    repository_ids TEXT NOT NULL DEFAULT '[]'
  );
  INSERT OR IGNORE INTO github_settings(singleton, project_id, repository_ids) VALUES (1, '', '[]');
`);

const isDateOnly = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
const nowISO = () => new Date().toISOString();
const dayISO = () => new Date().toISOString().slice(0, 10);
const seed = db.prepare('SELECT COUNT(*) AS n FROM applications').get().n;
if (!seed) {
  const insert = db.prepare(`INSERT INTO applications
    (company,job_title,location,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?)`);
  const now = nowISO();
  insert.run('Helion Managed Services', 'DevOps Support Engineer', 'Reading', 'Applied', now, now);
  insert.run('Zinc', 'DevOps Engineer', '', 'Applied', now, now);
  insert.run('Natabox', 'Junior DevOps Engineer', '', 'Applied', now, now);
}

const APP_FIELDS = {
  company: 'company', jobTitle: 'job_title', location: 'location', salaryRange: 'salary_range',
  description: 'description', advertUrl: 'advert_url', dateApplied: 'date_applied', status: 'status',
  contactName: 'contact_name', contactDetails: 'contact_details', followUpDate: 'follow_up_date',
  interviewDate: 'interview_date', notes: 'notes', cvVersion: 'cv_version'
};
const allowed = new Set(Object.keys(APP_FIELDS));
const maxLengths = { company: 160, jobTitle: 160, location: 160, salaryRange: 100, description: 8000, advertUrl: 1000, contactName: 160, contactDetails: 320, notes: 8000, cvVersion: 160 };
function validateApplication(input, partial = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('Send application fields as a JSON object.'), { status: 400 });
  const out = {};
  for (const [field, val] of Object.entries(input)) {
    if (!allowed.has(field)) continue;
    if (val == null) { out[field] = ''; continue; }
    if (typeof val !== 'string') throw Object.assign(new Error(`${field} must be text.`), { status: 400 });
    const value = val.trim();
    const max = maxLengths[field];
    if (max && value.length > max) throw Object.assign(new Error(`${field} must be ${max} characters or fewer.`), { status: 400 });
    if (['dateApplied','followUpDate','interviewDate'].includes(field) && value && !isDateOnly(value)) throw Object.assign(new Error(`${field} must be a valid calendar date.`), { status: 400 });
    if (field === 'status' && !STATUSES.includes(value)) throw Object.assign(new Error('Choose one of the supported application statuses.'), { status: 400 });
    if (field === 'advertUrl' && value) { try { const u = new URL(value); if (!['http:','https:'].includes(u.protocol)) throw new Error(); } catch { throw Object.assign(new Error('Job advert URL must start with http:// or https://.'), { status: 400 }); } }
    out[field] = value;
  }
  if (!partial) {
    if (!out.company) throw Object.assign(new Error('Company name is required.'), { status: 400 });
    if (!out.jobTitle) throw Object.assign(new Error('Job title is required.'), { status: 400 });
    if (!out.status) throw Object.assign(new Error('Application status is required.'), { status: 400 });
  }
  return out;
}
function appFromRow(row) {
  return { id: row.id, company: row.company, jobTitle: row.job_title, location: row.location, salaryRange: row.salary_range, description: row.description, advertUrl: row.advert_url, dateApplied: row.date_applied, status: row.status, contactName: row.contact_name, contactDetails: row.contact_details, followUpDate: row.follow_up_date, interviewDate: row.interview_date, notes: row.notes, cvVersion: row.cv_version, createdAt: row.created_at, updatedAt: row.updated_at };
}
function getApp(id) { const row = db.prepare('SELECT * FROM applications WHERE id=?').get(id); return row ? appFromRow(row) : null; }
function getApps() { return db.prepare('SELECT * FROM applications ORDER BY CASE WHEN date_applied = \'\' THEN 1 ELSE 0 END, date_applied DESC, id DESC').all().map(appFromRow); }
function isOpen(app) { return !CLOSED.includes(app.status); }
function dueClass(app, today = dayISO()) {
  if (!app.followUpDate || !isOpen(app)) return '';
  if (app.followUpDate < today) return 'overdue';
  if (app.followUpDate === today) return 'today';
  return '';
}
function dashboardData() {
  const apps = getApps(); const today = dayISO(); const edge = new Date(`${today}T00:00:00Z`); edge.setUTCDate(edge.getUTCDate() + 7); const nextWeek = edge.toISOString().slice(0, 10);
  const counts = Object.fromEntries(STATUSES.map(s => [s, apps.filter(a => a.status === s).length]));
  const awaiting = apps.filter(a => ['Applied','Follow-up Required'].includes(a.status)).length;
  const due = apps.filter(a => a.followUpDate && isOpen(a) && a.followUpDate <= today).length;
  const upcoming = apps.filter(a => a.followUpDate && isOpen(a) && a.followUpDate >= today && a.followUpDate <= nextWeek).sort((a,b) => a.followUpDate.localeCompare(b.followUpDate)).slice(0,6);
  const recent = [...apps].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0,6);
  const interviews = apps.filter(a => a.interviewDate && a.interviewDate >= today && !CLOSED.includes(a.status)).length;
  return { stats: { total: apps.filter(a => !['Interested','To Apply'].includes(a.status)).length, awaiting, interviews, followUpsDue: due, rejections: counts.Rejected, offers: counts.Offer }, counts, recent, upcoming, today };
}
function parseCookies(header = '') { return Object.fromEntries(header.split(';').map(s => s.trim()).filter(Boolean).map(s => { const i=s.indexOf('='); return [decodeURIComponent(s.slice(0,i)), decodeURIComponent(s.slice(i+1))]; })); }
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function createSession(res) {
  const token = crypto.randomBytes(32).toString('base64url'); const csrf = crypto.randomBytes(24).toString('base64url');
  const tokenHash = hash(token); db.prepare('INSERT OR REPLACE INTO sessions(token_hash,csrf_token,expires_at) VALUES(?,?,?)').run(tokenHash, csrf, Date.now() + 30*24*60*60*1000);
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `dch_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);
  return { hash: tokenHash, csrf };
}
function sessionFor(req,res) {
  const token = parseCookies(req.headers.cookie).dch_session;
  if (token) {
    const s = db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(token), Date.now());
    if (s) return { hash: s.token_hash, csrf: s.csrf_token };
  }
  return createSession(res);
}
function checkCsrf(req, session) {
  const csrf = req.headers['x-csrf-token'];
  if (!csrf || csrf !== session.csrf) throw Object.assign(new Error('Session expired. Refresh the page and try again.'), { status: 403 });
}
function send(res, status, body, headers = {}) { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...headers }); res.end(JSON.stringify(body)); }
function redirect(res, location) { res.writeHead(302, { Location: location, 'Cache-Control':'no-store' }); res.end(); }
async function readJSON(req) {
  let data = ''; for await (const chunk of req) { data += chunk; if (data.length > 1_000_000) throw Object.assign(new Error('Request body is too large.'), {status:413}); }
  try { return data ? JSON.parse(data) : {}; } catch { throw Object.assign(new Error('Request body must be valid JSON.'), {status:400}); }
}
function requireEncryptionKey() {
  const key = process.env.APP_ENCRYPTION_KEY || '';
  if (!/^[a-fA-F0-9]{64}$/.test(key)) throw Object.assign(new Error('Set APP_ENCRYPTION_KEY to a 64-character hex string in .env before connecting GitHub.'), {status:503});
  return Buffer.from(key, 'hex');
}
function encryptToken(token) {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', requireEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token,'utf8'), cipher.final()]);
  return { encrypted: encrypted.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
function decryptToken(row) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', requireEncryptionKey(), Buffer.from(row.iv,'base64'));
  decipher.setAuthTag(Buffer.from(row.auth_tag,'base64'));
  return Buffer.concat([decipher.update(Buffer.from(row.encrypted_token,'base64')), decipher.final()]).toString('utf8');
}
function githubConfigured() { return Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET); }
function githubToken() { const row = db.prepare('SELECT * FROM github_tokens WHERE singleton=1').get(); return row ? decryptToken(row) : null; }
async function githubFetch(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version':'2022-11-28', 'User-Agent':'DevOps-Career-Hub' } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.message || `GitHub returned ${response.status}.`), {status:502});
  return data;
}
async function githubGraphql(query, variables, token) {
  const response = await fetch('https://api.github.com/graphql', { method:'POST', headers:{ Authorization:`Bearer ${token}`, Accept:'application/vnd.github+json', 'Content-Type':'application/json', 'User-Agent':'DevOps-Career-Hub' }, body:JSON.stringify({query,variables}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.errors?.length) throw Object.assign(new Error(data.errors?.[0]?.message || `GitHub GraphQL returned ${response.status}.`), {status:502});
  return data.data;
}
function statusToken() { const row = db.prepare('SELECT login,name,updated_at FROM github_tokens WHERE singleton=1').get(); return row; }
const projectListQuery = `query { viewer { projectsV2(first:30, orderBy:{field:UPDATED_AT,direction:DESC}) { nodes { id number title url updatedAt closed } } } }`;
const projectDetailQuery = `query($id:ID!) { node(id:$id) { ... on ProjectV2 { id number title url updatedAt closed fields(first:30) { nodes { __typename ... on ProjectV2FieldCommon { name } } } items(first:100) { nodes { id isArchived content { __typename ... on Issue { title number url state updatedAt repository { nameWithOwner url } } ... on PullRequest { title number url state updatedAt repository { nameWithOwner url } } ... on DraftIssue { title } } fieldValues(first:30) { nodes { __typename ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } } } } } } } } }`;
function mapProject(project) {
  const fields = (project.fields?.nodes || []).map(f => f.name).filter(Boolean);
  const items = (project.items?.nodes || []).filter(i => !i.isArchived && i.content).map(i => {
    const content=i.content; const values={};
    for (const v of i.fieldValues?.nodes || []) { const name=v.field?.name; if(!name) continue; values[name] = v.name ?? v.date ?? v.number ?? v.text ?? ''; }
    const status = Object.entries(values).find(([k]) => /status/i.test(k))?.[1] || '';
    const priority = Object.entries(values).find(([k]) => /priority/i.test(k))?.[1] || '';
    const deadline = Object.entries(values).find(([k]) => /due|deadline|target date/i.test(k))?.[1] || '';
    return { title:content.title || '(Untitled item)', type:content.__typename, url:content.url || project.url, state:content.state || '', updatedAt:content.updatedAt || '', repository:content.repository?.nameWithOwner || '', status, priority, deadline, fieldValues:values };
  });
  return { id:project.id,number:project.number,title:project.title,url:project.url,updatedAt:project.updatedAt,closed:project.closed,fields,items };
}
async function handleApi(req,res,url,session) {
  const method=req.method; const pathname=url.pathname;
  if (pathname==='/api/session' && method==='GET') return send(res,200,{csrfToken:session.csrf});
  if (pathname==='/api/dashboard' && method==='GET') return send(res,200,dashboardData());
  if (pathname==='/api/apps' && method==='GET') return send(res,200,{applications:getApps(),statuses:STATUSES});
  if (pathname==='/api/apps' && method==='POST') {
    checkCsrf(req,session); const values=validateApplication(await readJSON(req)); const columns=Object.values(APP_FIELDS); const placeholders=columns.map(()=>'?').join(','); const now=nowISO();
    const result=db.prepare(`INSERT INTO applications(${columns.join(',')},created_at,updated_at) VALUES(${placeholders},?,?)`).run(...Object.keys(APP_FIELDS).map(k=>values[k] || ''),now,now);
    return send(res,201,{application:getApp(Number(result.lastInsertRowid))});
  }
  const appMatch=pathname.match(/^\/api\/apps\/(\d+)$/);
  if (appMatch && method==='PUT') {
    checkCsrf(req,session); const id=Number(appMatch[1]); if(!getApp(id)) return send(res,404,{error:'Application not found.'});
    const values=validateApplication(await readJSON(req),true); const keys=Object.keys(values); if(!keys.length) return send(res,400,{error:'No editable fields were provided.'});
    db.prepare(`UPDATE applications SET ${keys.map(k=>`${APP_FIELDS[k]}=?`).join(',')},updated_at=? WHERE id=?`).run(...keys.map(k=>values[k]),nowISO(),id);
    return send(res,200,{application:getApp(id)});
  }
  if (appMatch && method==='DELETE') {
    checkCsrf(req,session); const id=Number(appMatch[1]); const result=db.prepare('DELETE FROM applications WHERE id=?').run(id); if(!result.changes) return send(res,404,{error:'Application not found.'}); return send(res,200,{ok:true});
  }
  const logsMatch=pathname.match(/^\/api\/apps\/(\d+)\/followups$/);
  if (logsMatch && method==='GET') {
    const id=Number(logsMatch[1]); if(!getApp(id)) return send(res,404,{error:'Application not found.'});
    const logs=db.prepare('SELECT * FROM followups WHERE application_id=? ORDER BY contact_date DESC,id DESC').all(id).map(r=>({id:r.id,applicationId:r.application_id,contactDate:r.contact_date,outcome:r.outcome,notes:r.notes,nextFollowUpDate:r.next_follow_up_date,createdAt:r.created_at}));
    return send(res,200,{followups:logs});
  }
  if (logsMatch && method==='POST') {
    checkCsrf(req,session); const id=Number(logsMatch[1]); if(!getApp(id)) return send(res,404,{error:'Application not found.'}); const body=await readJSON(req);
    const contactDate=String(body.contactDate||'').trim(); const outcome=String(body.outcome||'').trim().slice(0,240); const notes=String(body.notes||'').trim().slice(0,4000); const next=String(body.nextFollowUpDate||'').trim();
    if(!isDateOnly(contactDate)) return send(res,400,{error:'Contact date is required and must be a valid calendar date.'});
    if(next && !isDateOnly(next)) return send(res,400,{error:'Next follow-up date must be a valid calendar date.'});
    db.prepare('INSERT INTO followups(application_id,contact_date,outcome,notes,next_follow_up_date,created_at) VALUES(?,?,?,?,?,?)').run(id,contactDate,outcome,notes,next,nowISO());
    db.prepare('UPDATE applications SET follow_up_date=?,updated_at=? WHERE id=?').run(next,nowISO(),id);
    return send(res,201,{ok:true});
  }
  if(pathname==='/api/export.csv' && method==='GET') {
    const headers=['Company','Job title','Location','Salary range','Job description','Job advert URL','Date applied','Application status','Recruiter/contact name','Recruiter email or LinkedIn','Follow-up date','Interview date','Notes','CV version'];
    const apps=getApps(); const rows=[headers,...apps.map(a=>[a.company,a.jobTitle,a.location,a.salaryRange,a.description,a.advertUrl,a.dateApplied,a.status,a.contactName,a.contactDetails,a.followUpDate,a.interviewDate,a.notes,a.cvVersion])];
    const csv=rows.map(row=>row.map(value=>`"${String(value ?? '').replaceAll('"','""')}"`).join(',')).join('\r\n');
    res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="devops-career-hub-applications.csv"','Cache-Control':'no-store'}); return res.end('\ufeff'+csv);
  }
  if(pathname==='/api/github/status' && method==='GET') return send(res,200,{configured:githubConfigured(),connected:Boolean(statusToken()),profile:statusToken(),encryptionReady:/^[a-fA-F0-9]{64}$/.test(process.env.APP_ENCRYPTION_KEY||''),selected:(()=>{const s=db.prepare('SELECT project_id,repository_ids FROM github_settings WHERE singleton=1').get();return {projectId:s.project_id,repositoryIds:JSON.parse(s.repository_ids||'[]')}})()});
  if(pathname==='/api/github/overview' && method==='GET') {
    const token=githubToken(); if(!token) return send(res,401,{error:'Connect GitHub first.'});
    const [projects,repositories]=await Promise.all([
      githubGraphql(projectListQuery,{},token),
      githubFetch('https://api.github.com/user/repos?sort=updated&per_page=100&type=all',token)
    ]);
    const settings=db.prepare('SELECT project_id,repository_ids FROM github_settings WHERE singleton=1').get();
    return send(res,200,{projects:projects.viewer.projectsV2.nodes,repositories:repositories.map(r=>({id:r.id,name:r.name,fullName:r.full_name,url:r.html_url,updatedAt:r.updated_at,description:r.description,openIssues:r.open_issues_count,stars:r.stargazers_count})),selected:{projectId:settings.project_id,repositoryIds:JSON.parse(settings.repository_ids||'[]')}});
  }
  if(pathname==='/api/github/project' && method==='GET') {
    const token=githubToken(); if(!token) return send(res,401,{error:'Connect GitHub first.'}); const settings=db.prepare('SELECT project_id,repository_ids FROM github_settings WHERE singleton=1').get(); const id=url.searchParams.get('id')||settings.project_id; if(!id) return send(res,400,{error:'Choose a project board first.'});
    const data=await githubGraphql(projectDetailQuery,{id},token); if(!data.node) return send(res,404,{error:'Project board not found or not accessible.'});
    const project=mapProject(data.node); const repoIds=JSON.parse(settings.repository_ids||'[]');
    if(repoIds.length) project.items=project.items.filter(item=>!item.repository || repoIds.some(repo=>item.repository.toLowerCase()===repo.toLowerCase()));
    return send(res,200,{project,repositoryIds:repoIds});
  }
  if(pathname==='/api/github/disconnect' && method==='POST') {
    checkCsrf(req,session); const token=githubToken(); let revoked=!token;
    if(token && githubConfigured()) {
      try { const response=await fetch(`https://api.github.com/applications/${encodeURIComponent(process.env.GITHUB_CLIENT_ID)}/grant`, {method:'DELETE',headers:{Authorization:`Basic ${Buffer.from(`${process.env.GITHUB_CLIENT_ID}:${process.env.GITHUB_CLIENT_SECRET}`).toString('base64')}`,Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'DevOps-Career-Hub'},body:JSON.stringify({access_token:token})}); revoked=response.ok; } catch(error) { console.warn('GitHub token revocation request failed:',error.message); }
    }
    db.prepare('DELETE FROM github_tokens WHERE singleton=1').run(); db.prepare("UPDATE github_settings SET project_id='',repository_ids='[]' WHERE singleton=1").run();
    return send(res,200,{ok:true,revoked});
  }
  if(pathname==='/api/github/selection' && method==='POST') {
    checkCsrf(req,session); const body=await readJSON(req); const projectId=String(body.projectId||'').trim(); const repositoryIds=Array.isArray(body.repositoryIds)?body.repositoryIds.map(x=>String(x).slice(0,160)).slice(0,50):[];
    db.prepare('UPDATE github_settings SET project_id=?,repository_ids=? WHERE singleton=1').run(projectId,JSON.stringify(repositoryIds)); return send(res,200,{ok:true});
  }
  return send(res,404,{error:'Not found.'});
}
function staticFile(res, pathname) {
  const relative=pathname==='/'?'index.html':pathname.slice(1); const file=path.resolve(ROOT,'public',relative);
  if(!file.startsWith(path.resolve(ROOT,'public')+path.sep) && file!==path.resolve(ROOT,'public','index.html')) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file,(err,content)=>{ if(err){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Not found');}
    const ext=path.extname(file); const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'};
    res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':ext==='.html'?'no-cache':'public, max-age=3600','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin'});res.end(content);
  });
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,APP_URL);
  try {
    if(url.pathname==='/auth/github' && req.method==='GET') {
      if(!githubConfigured()) {res.writeHead(503,{'Content-Type':'text/html; charset=utf-8'});return res.end('<h1>GitHub OAuth is not configured</h1><p>Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to your .env file.</p><p><a href="/">Return to DevOps Career Hub</a></p>');}
      requireEncryptionKey(); const s=sessionFor(req,res); const state=crypto.randomBytes(24).toString('hex'); db.prepare('INSERT INTO oauth_states(state,session_hash,expires_at) VALUES(?,?,?)').run(state,s.hash,Date.now()+10*60*1000);
      const authorize=new URL('https://github.com/login/oauth/authorize'); authorize.searchParams.set('client_id',process.env.GITHUB_CLIENT_ID); authorize.searchParams.set('redirect_uri',`${APP_URL}/auth/github/callback`); authorize.searchParams.set('scope','read:user,repo,read:project'); authorize.searchParams.set('state',state); return redirect(res,authorize.toString());
    }
    if(url.pathname==='/auth/github/callback' && req.method==='GET') {
      const state=url.searchParams.get('state'),code=url.searchParams.get('code'); const pending=state&&db.prepare('SELECT * FROM oauth_states WHERE state=? AND expires_at>?').get(state,Date.now());
      const session=sessionFor(req,res);
      if(!pending||pending.session_hash!==session.hash||!code) return redirect(res,'/?page=github&error=oauth_state');
      db.prepare('DELETE FROM oauth_states WHERE state=?').run(state);
      const exchange=await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({client_id:process.env.GITHUB_CLIENT_ID,client_secret:process.env.GITHUB_CLIENT_SECRET,code,redirect_uri:`${APP_URL}/auth/github/callback`,state})});
      const tokenData=await exchange.json(); if(!exchange.ok||!tokenData.access_token) throw new Error(tokenData.error_description||'GitHub authorization failed.');
      const profile=await githubFetch('https://api.github.com/user',tokenData.access_token); const enc=encryptToken(tokenData.access_token);
      db.prepare(`INSERT INTO github_tokens(singleton,encrypted_token,iv,auth_tag,login,name,updated_at) VALUES(1,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET encrypted_token=excluded.encrypted_token,iv=excluded.iv,auth_tag=excluded.auth_tag,login=excluded.login,name=excluded.name,updated_at=excluded.updated_at`).run(enc.encrypted,enc.iv,enc.tag,profile.login,profile.name||'',nowISO());
      return redirect(res,'/?page=github&connected=1');
    }
    if(url.pathname.startsWith('/api/')) { const session=sessionFor(req,res); return await handleApi(req,res,url,session); }
    if(req.method==='GET') return staticFile(res,url.pathname);
    res.writeHead(405);res.end('Method not allowed');
  } catch(error) { console.error(error); if(!res.headersSent) send(res,error.status||500,{error:error.message||'Unexpected server error.'}); else res.end(); }
});
server.listen(PORT,HOST,()=>console.log(`DevOps Career Hub running at ${APP_URL}`));
process.on('SIGINT',()=>{server.close(()=>{db.close();process.exit(0);});});
process.on('SIGTERM',()=>{server.close(()=>{db.close();process.exit(0);});});
