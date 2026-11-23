/* MyRA collector — runs inside Google Apps Script, loaded by the bootstrap.
 * Pulls NY PSC data (DMM filings and new cases, DPS session agendas and transcripts),
 * keeps a database in Drive, writes the Sheet, the dashboard data file and the
 * event queue that the scheduled Claude check reads. No AI runs here. */
globalThis.MyRA = (function () {
  'use strict';
  var CFG = {
    VERSION: '2026-11-23.3',
    ROOT: 'YOUR_MYRA_FOLDER_ID',
    INBOX: 'YOUR_INBOX_FOLDER_ID',
    WORK: 'YOUR_WORK_FOLDER_ID',
    SHEET: 'YOUR_SHEET_ID',
    DATA: 'YOUR_DATA_FILE_ID',
    EVENTS: 'YOUR_EVENTS_FILE_ID',
    LOG: 'YOUR_LOG_FILE_ID',
    DMM: 'https://documents.dps.ny.gov/public',
    DPS: 'https://dps.ny.gov',
    TZ: 'America/New_York',
    TIME_BUDGET_MS: 270000,
    CHECK_HOUR: 6,                       // daily collection, weekdays; Sunday adds the weekly reconcile
    START_DOCKETS: ['26-G-0384', '22-M-0149'],
    NEW_CASE_RE: /^\d{2}-[EGM]-\d{4}$/   // new-proceeding alerts: numbered electric, gas and general cases
  };
  // Filers whose documents are Commission or Department issuances.
  var COMMISSION = ['public service commission', 'department of public service'];
  // Starter list of priority entities; edited from the dashboard. "match" = name fragments as DMM spells them.
  var DEFAULT_ENTITIES = [
    { name: 'NYSERDA', match: ['Energy Research and Development Authority', 'NYSERDA'] },
    { name: 'Con Edison', match: ['Consolidated Edison Company of New York'] },
    { name: 'Orange and Rockland', match: ['Orange and Rockland'] },
    { name: 'National Grid', match: ['National Grid', 'Niagara Mohawk', 'Brooklyn Union Gas', 'KeySpan'] },
    { name: 'NYSEG and RG&E', match: ['New York State Electric & Gas', 'Rochester Gas and Electric'] },
    { name: 'Central Hudson', match: ['Central Hudson'] },
    { name: 'NYISO', match: ['New York Independent System Operator', 'NYISO'] },
    { name: 'NYPA', match: ['New York Power Authority'] },
    { name: 'UIU', match: ['Utility Intervention Unit', 'New York State Department of State'] },
    { name: 'NYC', match: ['City of New York'] },
    { name: 'Multiple Intervenors', match: ['Multiple Intervenors'] },
    { name: 'ACE NY', match: ['Alliance for Clean Energy New York'] }
  ];
  var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  var START = Date.now();
  var LOGBUF = [];

  // ------------------------------------------------------------------ basics
  function log(msg) {
    var line = fmt(new Date(), 'yyyy-MM-dd HH:mm:ss') + '  ' + msg;
    LOGBUF.push(line);
    try { console.log(line); } catch (e) {}
  }
  function flushLog() {
    if (!LOGBUF.length) return;
    try {
      var f = DriveApp.getFileById(CFG.LOG);
      var lines = f.getBlob().getDataAsString().split('\n').concat(LOGBUF).filter(function (l) { return l !== ''; });
      if (lines.length > 400) lines = lines.slice(lines.length - 400);
      f.setContent(lines.join('\n') + '\n');
      LOGBUF = [];
    } catch (e) { try { console.log('log flush failed ' + e); } catch (x) {} }
  }
  function fmt(d, pattern) { return Utilities.formatDate(d, CFG.TZ, pattern); }
  function nyNow() {
    var d = new Date();
    var p = fmt(d, 'yyyy-M-d-H-u').split('-').map(Number);
    return { date: d, y: p[0], m: p[1], d: p[2], h: p[3], dow: p[4], iso: fmt(d, "yyyy-MM-dd'T'HH:mm:ss"), day: fmt(d, 'yyyy-MM-dd') };
  }
  function timeLeft() { return CFG.TIME_BUDGET_MS - (Date.now() - START); }
  function pad2(x) { return ('0' + x).slice(-2); }
  function addDays(day, n) { return fmt(new Date(new Date(day + 'T12:00:00Z').getTime() + n * 864e5), 'yyyy-MM-dd'); }
  function usDate(day) { var p = day.split('-'); return p[1] + '%2f' + p[2] + '%2f' + p[0]; }
  function isoFromUs(s) { var m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? m[3] + '-' + pad2(m[1]) + '-' + pad2(m[2]) : ''; }
  function strip(h) {
    return String(h == null ? '' : h).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&#039;/g, "'").replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/¿/g, "'").replace(/\s+/g, ' ').trim();
  }
  function normCase(s) {
    s = strip(s).toUpperCase().replace(/\s+/g, '');
    var m = s.match(/^(\d{2})-([A-Z])-(\d{1,4})$/);
    if (m) return m[1] + '-' + m[2] + '-' + ('0000' + m[3]).slice(-4);
    m = s.match(/^(\d{2})-(\d{5})$/);
    return m ? s : null;
  }
  function caseUrl(c) { return CFG.DMM + '/MatterManagement/CaseMaster.aspx?MatterCaseNo=' + c; }
  function docUrl(ref) { return CFG.DMM + '/Common/ViewDoc.aspx?DocRefId=' + encodeURIComponent(ref); }

  function http(url) {
    var last = '';
    for (var i = 0; i < 3; i++) {
      try {
        var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
        var code = r.getResponseCode();
        if (code >= 200 && code < 300) return r.getContentText();
        last = 'HTTP ' + code;
      } catch (e) { last = String(e); }
      Utilities.sleep(2000 * (i + 1));
    }
    throw new Error('fetch failed (' + last + '): ' + url.slice(0, 160));
  }
  function httpJson(url) { return JSON.parse(http(url)); }

  // ------------------------------------------------------------------ database
  function dbFile() {
    var props = PropertiesService.getScriptProperties();
    var id = props.getProperty('DB_ID');
    if (id) { try { return DriveApp.getFileById(id); } catch (e) {} }
    var f = DriveApp.getFolderById(CFG.WORK).createFile('myra_db.json', '{}', 'text/plain');
    props.setProperty('DB_ID', f.getId());
    return f;
  }
  function loadDb() {
    var db = {};
    try { db = JSON.parse(dbFile().getBlob().getDataAsString() || '{}'); } catch (e) { db = {}; }
    ['dockets', 'filings', 'sessions', 'pubSeen', 'seenCases', 'seenComments', 'narratives'].forEach(function (k) { db[k] = db[k] || {}; });
    ['events', 'errors', 'activity', 'newCases', 'deadlines', 'addFailed', 'digests'].forEach(function (k) { db[k] = db[k] || []; });
    db.entities = db.entities || DEFAULT_ENTITIES.map(function (e) { return { name: e.name, match: e.match.slice() }; });
    db.seq = db.seq || 0;
    db.acked = db.acked || 0;
    return db;
  }
  function saveDb(db) { dbFile().setContent(JSON.stringify(db)); }
  function addEvent(db, ev) {
    db.seq += 1;
    ev.id = db.seq;
    ev.ts = nyNow().iso;
    db.events.push(ev);
  }
  function addActivity(db, c, text) {
    db.activity.unshift({ c: c || '', text: text, ts: nyNow().iso });
    if (db.activity.length > 300) db.activity.length = 300;
  }
  function noteFail(db, what, why) {
    db.addFailed = db.addFailed.filter(function (x) { return x.what !== what; });
    db.addFailed.unshift({ what: String(what || ''), why: why, at: nyNow().iso });
    if (db.addFailed.length > 10) db.addFailed.length = 10;
    log('could not add ' + what + ': ' + why);
  }

  // ------------------------------------------------------------------ dockets and filings
  function lookupDocket(c) {
    var h = http(caseUrl(c));
    var seq = (h.match(/id="GridPlaceHolder_hdnMatterSeq" value="(\d+)"/) || [])[1];
    if (!seq) return null;
    function grab(id, tag) {
      var m = h.match(new RegExp('id="GridPlaceHolder_MatterControl1_' + id + '"[^>]*>([\\s\\S]*?)</' + tag + '>'));
      return m ? strip(m[1]) : '';
    }
    var cos = [], re = /<li>([\s\S]*?)<\/li>/g, block = (h.match(/pnlCompanyValue"[\s\S]*?<\/ul>/) || [''])[0], m;
    while ((m = re.exec(block))) cos.push(strip(m[1]));
    return { seq: seq, title: grab('txtTitleofMatterValue', 'textarea'), ind: grab('lblIndustryAffectedValue', 'span'), type: grab('lblMatterTypeValue', 'span'), co: cos.join('; ') };
  }
  function activeDockets(db) { return Object.keys(db.dockets).filter(function (c) { return db.dockets[c].tr; }); }
  function classify(db, f) {
    var low = String(f.filer || '').toLowerCase();
    if (COMMISSION.some(function (s) { return low.indexOf(s) >= 0; })) { f.cls = 'commission'; f.ent = ''; return; }
    var ents = db.entities.filter(function (e) { return e.match.some(function (s) { return s && low.indexOf(String(s).toLowerCase()) >= 0; }); }).map(function (e) { return e.name; });
    f.cls = ents.length ? 'priority' : 'other';
    f.ent = ents.join(', ');
  }
  var MINOR_DOC = /^(cover|transmittal|filing)\b|cover letter|^sec\.? ?letter|letter to (the )?secretary|certificate of service|affidavit of service|^attachment|^appendix|^exhibit|^errata/i;
  function filingTitle(f) {
    var main = f.docs.filter(function (d) { return !MINOR_DOC.test(d.t); })[0] || f.docs[0];
    return main ? main.t : '';
  }
  function rowDoc(r) {
    return { seq: String(r.DocSeq || ''), fs: String(r.FilingSeq || ''), item: String(r.ItemNo || ''), d: isoFromUs(r.DateFiled), filer: strip(r.FilingCompany),
      type: strip(r.Doctype), t: strip(r.DocTitle), n: strip(r.DocName), r: String(r.DocRefNo || ''), sz: String(r.DocSize || ''), x: String(r.DocExt || '').toLowerCase() };
  }
  // Adds document rows to the database. Returns the filings that are new or gained documents.
  function mergeDocs(db, c, rows, backfill) {
    var touched = {}, n = nyNow();
    rows.forEach(function (r) {
      var d = rowDoc(r);
      if (!d.fs || !d.seq || String(r.SecurityFlag || '0') !== '0') return;
      var f = db.filings[d.fs];
      if (!f) {
        f = db.filings[d.fs] = { fs: d.fs, c: c, item: d.item, d: d.d, filer: d.filer, type: d.type, docs: [], found: n.day };
        classify(db, f);
        if (backfill) { f.bf = 1; f.st = 'listed'; }
        else { f.st = (f.cls === 'commission' || f.cls === 'priority') ? 'queued' : 'listed'; f.isNew = 1; }
      }
      if (f.docs.some(function (x) { return x.seq === d.seq; })) return;
      f.docs.push({ seq: d.seq, t: d.t, n: d.n, r: d.r, sz: d.sz, x: d.x });
      f.t = filingTitle(f);
      if (!backfill) touched[d.fs] = f;
    });
    return Object.keys(touched).map(function (k) { return touched[k]; });
  }
  function evFiling(f, withDocs) {
    var o = { fs: f.fs, c: f.c, d: f.d, filer: f.filer, type: f.type, t: f.t, cls: f.cls, ent: f.ent || '', st: f.st, ndocs: f.docs.length, item: f.item };
    if (withDocs) o.docs = f.docs.map(function (d) { return { t: d.t, n: d.n, sz: d.sz, x: d.x, url: docUrl(d.r) }; });
    return o;
  }
  function filingsOf(db, cases) {
    return Object.keys(db.filings).map(function (k) { return db.filings[k]; })
      .filter(function (f) { return cases.indexOf(f.c) >= 0; })
      .sort(function (a, b) { return String(b.d).localeCompare(String(a.d)) || Number(b.fs) - Number(a.fs); });
  }
  function emitFilings(db, c, list, how) {
    if (!list.length) return;
    var k = db.dockets[c] || {};
    list.sort(function (a, b) { return String(a.d).localeCompare(String(b.d)); });
    var wasNew = list.filter(function (f) { return f.isNew; });
    list.forEach(function (f) { delete f.isNew; });
    addEvent(db, { type: 'filings', c: c, title: k.title || '', how: how, narrative: (db.narratives[c] || {}).id || '',
      filings: list.map(function (f) { return evFiling(f, f.st === 'queued'); }) });
    addActivity(db, c, list.length + ' new or updated filing(s)' + (wasNew.length < list.length ? ' (incl. added attachments)' : ''));
  }
  function fullFetch(db, c, backfill) {
    var k = db.dockets[c];
    var rows = httpJson(CFG.DMM + '/CaseMaster/PublicDocuments/' + k.seq);
    var t = mergeDocs(db, c, rows || [], backfill);
    k.lastFull = nyNow().day;
    k.ndocs = (rows || []).length;
    return t;
  }
  function addDocket(db, raw, via) {
    var c = normCase(raw);
    if (!c) { noteFail(db, raw, 'not a PSC case or matter number (expected like 26-G-0384 or 26-01149)'); return null; }
    var k = db.dockets[c];
    if (k) {
      if (!k.tr) { k.tr = true; k.added = nyNow().day; addActivity(db, c, 'tracking again'); }
      return k;
    }
    var info = lookupDocket(c);
    if (!info) { noteFail(db, c, 'not found in DMM'); return null; }
    k = db.dockets[c] = { c: c, seq: info.seq, title: info.title, ind: info.ind, mt: info.type, co: info.co, tr: true, added: nyNow().day, via: via || 'manual' };
    fullFetch(db, c, true);
    db.addFailed = db.addFailed.filter(function (x) { return x.what !== c; });
    var all = docketEvent(db, c, false);
    addActivity(db, c, 'now tracking (' + all.length + ' filings on record)');
    log('docket added ' + c + ' (' + all.length + ' filings)');
    return k;
  }

  // Queues a docket for a (re)written narrative: the Claude check reads its Commission documents.
  function docketEvent(db, c, rebuild) {
    var k = db.dockets[c], all = filingsOf(db, [c]);
    addEvent(db, { type: 'docket_added', c: c, title: k.title, ind: k.ind, co: k.co, via: rebuild ? 'rebuild' : k.via, url: caseUrl(c), nfilings: all.length,
      narrative: rebuild ? ((db.narratives[c] || {}).id || '') : '',
      commission: all.filter(function (f) { return f.cls === 'commission'; }).slice(0, 25).map(function (f) { return evFiling(f, true); }),
      recent: all.filter(function (f) { return f.cls !== 'commission'; }).slice(0, 40).map(function (f) { return evFiling(f, false); }) });
    return all;
  }

  // ------------------------------------------------------------------ daily DMM checks
  function sweep(db, n) {
    var active = activeDockets(db);
    var to = n.day, from = addDays(db.lastSweep || n.day, -3);
    if (!active.length) { db.lastSweep = to; return; }
    var j = httpJson(CFG.DMM + '/CaseMaster/DocumentExternal/17-02256?MC=0&IA=&MT=&MST=&CN=&C=&M=&CO=0&DFF=' + usDate(from) + '&DFT=' + usDate(to) + '&DT=&CI=0&FC=');
    var docs = (j && j.DocumentList) || [], comments = (j && j.PublicComments) || [];
    var total = docs.length ? Number(docs[0].TotalRecords || docs.length) : 0;
    var byCase = {};
    docs.forEach(function (r) {
      var c = normCase(r.MatterNumber || r.CaseOrMatterNumber);
      if (c && db.dockets[c] && db.dockets[c].tr) (byCase[c] = byCase[c] || []).push(r);
    });
    Object.keys(byCase).forEach(function (c) { emitFilings(db, c, mergeDocs(db, c, byCase[c], false), 'daily'); });
    comments.forEach(function (r) {
      var c = normCase(r.MatterCaseNumber), key = String(r.CommentSeq || '');
      if (!c || !key || db.seenComments[key] || !db.dockets[c] || !db.dockets[c].tr) return;
      db.seenComments[key] = n.day;
      var k = db.dockets[c];
      k.cWeek = (k.cWeek || 0) + 1;
      k.cTotal = (k.cTotal || 0) + 1;
    });
    if (total > docs.length) {
      log('sweep: result capped (' + docs.length + ' of ' + total + '); doing full docket checks');
      reconcile(db, n);
    }
    db.lastSweep = to;
    log('sweep ' + from + '..' + to + ': ' + docs.length + ' docs statewide, ' + Object.keys(byCase).length + ' tracked docket(s) with filings');
  }
  function reconcile(db, n) {
    activeDockets(db).forEach(function (c) {
      if (timeLeft() < 60000) return;
      try { emitFilings(db, c, fullFetch(db, c, false), 'weekly check'); } catch (e) { log('reconcile ' + c + ' failed: ' + e); }
    });
  }
  function weeklyComments(db) {
    var counts = activeDockets(db).map(function (c) { return { c: c, title: db.dockets[c].title, n: db.dockets[c].cWeek || 0 }; }).filter(function (x) { return x.n; });
    if (counts.length) addEvent(db, { type: 'comment_counts', counts: counts });
    activeDockets(db).forEach(function (c) { db.dockets[c].cWeek = 0; });
    var cutoff = addDays(nyNow().day, -21);
    Object.keys(db.seenComments).forEach(function (k) { if (db.seenComments[k] < cutoff) delete db.seenComments[k]; });
  }
  function checkNewCases(db, n, seedOnly) {
    var to = n.day, from = addDays(db.lastNewCases || addDays(n.day, -7), -2);
    var L = httpJson(CFG.DMM + '/CaseMaster/MatterExternal/17-02256?MC=1&IA=&MT=&MST=&CN=&SDF=' + usDate(from) + '&SDT=' + usDate(to) + '&C=&M=&CO=0') || [];
    var fresh = [];
    L.forEach(function (x) {
      var c = normCase(x.CaseOrMatterNumber);
      if (!c || !CFG.NEW_CASE_RE.test(c) || db.seenCases[c]) return;
      db.seenCases[c] = n.day;
      var r = { c: c, title: strip(x.MatterTitle), type: strip(x.MatterType), sub: strip(x.MatterSubType), co: strip(x.MatterCompanies), d: isoFromUs(x.strSubmitDate), url: caseUrl(c), found: n.day };
      fresh.push(r);
      if (!seedOnly) db.newCases.unshift(r);
    });
    if (db.newCases.length > 150) db.newCases.length = 150;
    var cutoff = addDays(n.day, -45);
    Object.keys(db.seenCases).forEach(function (k) { if (db.seenCases[k] < cutoff) delete db.seenCases[k]; });
    if (fresh.length && !seedOnly) addEvent(db, { type: 'new_cases', cases: fresh });
    db.lastNewCases = to;
    log('new cases ' + from + '..' + to + ': ' + L.length + ' items, ' + fresh.length + ' new E/G/M case(s)' + (seedOnly ? ' (seeded, no alert)' : ''));
  }

  // ------------------------------------------------------------------ PSC sessions (DPS website)
  function session(db, date) {
    var s = db.sessions[date];
    if (!s) s = db.sessions[date] = { date: date, items: [], picks: {} };
    return s;
  }
  function sessionForMonth(db, y, m) {
    var key = y + '-' + pad2(m);
    var hit = Object.keys(db.sessions).filter(function (d) { return d.slice(0, 7) === key; }).sort().pop();
    return session(db, hit || key);
  }
  function listPubs(filter, re) {
    var h = http(CFG.DPS + '/publications?f%5B0%5D=filter_term%3A' + filter);
    var out = [], seen = {}, m, rx = /href="(\/[a-z0-9-]+)"/g;
    while ((m = rx.exec(h))) { if (re.test(m[1]) && !seen[m[1]]) { seen[m[1]] = 1; out.push(m[1]); } }
    return out;
  }
  function pubPdf(path) {
    var h = http(CFG.DPS + path);
    var m = h.match(/https:\/\/dps\.ny\.gov\/system\/files\/[^"'\s<>]+\.pdf/i) || h.match(/["'](\/system\/files\/[^"'\s<>]+\.pdf)/i);
    if (!m) return '';
    return m[1] ? CFG.DPS + m[1] : m[0];
  }
  function monthNum(word) { return MONTHS.indexOf(String(word).toLowerCase()) + 1; }
  var AGENDA_RE = /^\/commission-issues-(preliminary|final)-([a-z]+)-(\d{1,2})-(\d{4})-agenda/;
  var TRANSCRIPT_RE = /^\/psc-session-([a-z]+)-(\d{4})-transcript/;
  var CONSENT_RE = /^\/summary-consent-agenda-items-([a-z]+)-(\d{1,2})-(\d{4})-session/;
  function picksList(s, onlyConsent) {
    return (s.items || []).filter(function (it) { var p = s.picks[it.no]; return p && p.on && (!onlyConsent || it.agenda === 'consent'); })
      .map(function (it) { return { no: it.no, title: it.title, cases: it.cases, agenda: it.agenda }; });
  }
  function checkPublications(db, n, seedOnly) {
    var newest = null;
    listPubs(416, AGENDA_RE).forEach(function (p) {
      if (db.pubSeen[p]) return;
      db.pubSeen[p] = n.day;
      var m = p.match(AGENDA_RE), mo = monthNum(m[2]);
      if (!mo) return;
      var date = m[4] + '-' + pad2(mo) + '-' + pad2(m[3]);
      if (seedOnly) { if (!newest || date > newest) newest = date; return; }
      var s = session(db, date), pdf = pubPdf(p);
      s[m[1]] = { page: CFG.DPS + p, pdf: pdf, posted: n.day };
      addEvent(db, { type: 'agenda', kind: m[1], date: date, pdf: pdf, page: CFG.DPS + p,
        prevItems: m[1] === 'final' ? (s.items || []) : undefined, tracked: activeDockets(db) });
      addActivity(db, '', (m[1] === 'final' ? 'Final' : 'Preliminary') + ' agenda posted for the ' + date + ' session');
    });
    listPubs(411, TRANSCRIPT_RE).forEach(function (p) {
      if (db.pubSeen[p]) return;
      db.pubSeen[p] = n.day;
      if (seedOnly) return;
      var m = p.match(TRANSCRIPT_RE), mo = monthNum(m[1]);
      if (!mo) return;
      var s = sessionForMonth(db, m[2], mo), pdf = pubPdf(p);
      s.transcript = { page: CFG.DPS + p, pdf: pdf, posted: n.day };
      var picks = picksList(s, false);
      if (picks.length) addEvent(db, { type: 'transcript', date: s.date, pdf: pdf, page: CFG.DPS + p, picks: picks });
      addActivity(db, '', 'Transcript posted for the ' + s.date + ' session');
    });
    listPubs(16, CONSENT_RE).forEach(function (p) {
      if (db.pubSeen[p]) return;
      db.pubSeen[p] = n.day;
      if (seedOnly) return;
      var m = p.match(CONSENT_RE), mo = monthNum(m[1]);
      if (!mo) return;
      var s = session(db, m[3] + '-' + pad2(mo) + '-' + pad2(m[2])), pdf = pubPdf(p);
      s.consent = { page: CFG.DPS + p, pdf: pdf, posted: n.day };
      var picks = picksList(s, true);
      if (picks.length) addEvent(db, { type: 'consent_summary', date: s.date, pdf: pdf, picks: picks });
    });
    if (seedOnly && newest) log('sessions: seeded; latest agenda on record is for ' + newest);
  }
  function checkNextSession(db, n) {
    var h = http(CFG.DPS + '/public-service-commission-sessions');
    var links = [], m, rx = /href="(\/event\/[a-z]+-(\d{4})-public-service-commission-session)"/g;
    while ((m = rx.exec(h))) if (links.indexOf(m[1]) < 0) links.push(m[1]);
    for (var i = 0; i < Math.min(3, links.length); i++) {
      var e = http(CFG.DPS + links[i]);
      var d = e.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? (\d{1,2}), (\d{4})\s*(\d{1,2}:\d\d ?[AP]M)?/);
      if (!d) continue;
      var mo = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(d[1].toLowerCase()) + 1;
      var date = d[3] + '-' + pad2(mo) + '-' + pad2(d[2]);
      if (date < n.day) continue;
      db.next = { date: date, time: d[4] || '', url: CFG.DPS + links[i], checked: n.day };
      session(db, date).url = CFG.DPS + links[i];
      log('next session: ' + date + ' ' + (d[4] || ''));
      return;
    }
  }

  // ------------------------------------------------------------------ inbox (dashboard and Claude)
  function ingest(db) {
    var it = DriveApp.getFolderById(CFG.INBOX).getFiles(), files = [];
    while (it.hasNext()) files.push(it.next());
    files.sort(function (a, b) { return a.getDateCreated() - b.getDateCreated(); });
    var n = 0;
    files.forEach(function (f) {
      var ops = [];
      try { var j = JSON.parse(f.getBlob().getDataAsString()); ops = j.ops || [j]; }
      catch (e) { log('inbox: could not read ' + f.getName() + ': ' + e); }
      ops.forEach(function (op) {
        if (timeLeft() < 30000) { log('inbox: out of time; op deferred'); return; }
        try { applyOp(db, op); n++; } catch (e) { log('inbox op ' + JSON.stringify(op).slice(0, 140) + ' failed: ' + e); }
      });
      f.setTrashed(true);
    });
    if (n) log('inbox: applied ' + n + ' op(s)');
    return n;
  }
  function requestSummary(db, fsList, why, parts) {
    var list = [];
    fsList.forEach(function (fs) {
      var f = db.filings[String(fs)];
      if (!f) return;
      if (!parts && f.sum) return;            // already summarized; parts requests always go through
      f.st = 'requested';
      list.push(f);
    });
    if (!list.length) return;
    addEvent(db, { type: 'summarize', why: why, parts: parts || null, filings: list.map(function (f) {
      var o = evFiling(f, true);
      if (parts) { o.sum = f.sum || ''; o.sugg = f.sugg || []; }
      o.narrative = (db.narratives[f.c] || {}).id || '';
      return o;
    }) });
  }
  function itemFor(s, no) { return (s.items || []).filter(function (it) { return String(it.no) === String(no); })[0]; }
  function pickItem(db, date, no, on, auto) {
    var s = db.sessions[date];
    if (!s) return;
    var it = itemFor(s, no);
    if (!it) return;
    var p = s.picks[no] = s.picks[no] || {};
    p.on = !!on;
    if (auto) p.auto = 1;
    if (!on) return;
    var cases = (it.cases || []).map(normCase).filter(String);
    cases.forEach(function (c) { if (!db.dockets[c] || !db.dockets[c].tr) { try { addDocket(db, c, 'session ' + date + ' item ' + no); } catch (e) { log('track for pick failed ' + c + ': ' + e); } } });
    if (p.asked) return;
    p.asked = nyNow().day;
    var recent = filingsOf(db, cases).slice(0, 50).map(function (f) { var o = evFiling(f, false); o.summarized = !!f.sum; return o; });
    addEvent(db, { type: 'item_picked', date: date, no: no, title: it.title, agenda: it.agenda, section: it.section || '',
      cases: cases.map(function (c) { var k = db.dockets[c] || {}; return { c: c, title: k.title || '', narrative: (db.narratives[c] || {}).id || '' }; }),
      filings: recent });
  }
  function applyOp(db, op) {
    var n = nyNow();
    switch (op.op) {
      case 'track': case 'add_docket': addDocket(db, op.c, op.via || 'manual'); break;
      case 'renarrate': { var cr = normCase(op.c); if (cr && db.dockets[cr]) { docketEvent(db, cr, true); addActivity(db, cr, 'narrative rebuild requested'); } break; }
      case 'untrack': { var c0 = normCase(op.c); if (c0 && db.dockets[c0]) { db.dockets[c0].tr = false; addActivity(db, c0, 'stopped tracking'); } break; }
      case 'pick': pickItem(db, op.date, op.no, op.on !== false, false); break;
      case 'agenda': {
        var s = session(db, op.date);
        var oldPicks = s.picks || {};
        s.items = (op.items || []).map(function (it) { return { no: String(it.no), cases: (it.cases || []).map(normCase).filter(String), title: String(it.title || ''), section: String(it.section || ''), agenda: it.agenda === 'consent' ? 'consent' : 'regular' }; });
        s.picks = {};
        s.items.forEach(function (it) { if (oldPicks[it.no]) s.picks[it.no] = oldPicks[it.no]; });
        s.agendaKind = op.kind || s.agendaKind || 'preliminary';
        if (op.changes) s.changes = String(op.changes);
        var tracked = activeDockets(db);
        s.items.forEach(function (it) {
          if (!s.picks[it.no] && it.cases.some(function (c) { return tracked.indexOf(c) >= 0; })) pickItem(db, op.date, it.no, true, true);
        });
        break;
      }
      case 'key_filings': {
        var ss = db.sessions[op.date];
        if (!ss) break;
        var p = ss.picks[op.no] = ss.picks[op.no] || { on: true };
        p.key = (op.fs || []).map(String);
        p.note = String(op.note || '');
        break;
      }
      case 'approve': {
        var sa = db.sessions[op.date];
        if (sa && sa.picks[op.no]) sa.picks[op.no].approved = (op.fs || []).map(String);
        requestSummary(db, (op.fs || []).map(String), 'session ' + op.date + ' item ' + op.no);
        break;
      }
      case 'summarize': requestSummary(db, [String(op.fs)], 'requested', op.parts && op.parts.length ? op.parts : null); break;
      case 'summary': {
        var f = db.filings[String(op.fs)];
        if (!f) break;
        if (op.scope === 'parts') {
          f.partSums = (f.partSums || []).concat((op.parts || []).map(function (x) { return { label: String(x.label || ''), text: String(x.text || '') }; }));
        } else {
          f.sum = String(op.text || '');
          f.scope = op.scope || 'full';
          if (op.pages) f.pages = Number(op.pages) || '';
          f.sugg = (op.sugg || []).map(function (x) { return { label: String(x.label || x), where: String(x.where || '') }; });
        }
        f.st = 'summarized';
        f.sumAt = n.day;
        break;
      }
      case 'deadline': {
        var key = [op.c, op.date, op.event].join('|');
        if (!db.deadlines.some(function (d) { return [d.c, d.date, d.event].join('|') === key; }))
          db.deadlines.push({ c: normCase(op.c) || String(op.c || ''), date: String(op.date || ''), event: String(op.event || ''), src: String(op.src || '') });
        db.deadlines.sort(function (a, b) { return a.date.localeCompare(b.date); });
        var cut = addDays(n.day, -30);
        db.deadlines = db.deadlines.filter(function (d) { return d.date >= cut; });
        break;
      }
      case 'narrative': {
        var cn = normCase(op.c);
        if (cn) db.narratives[cn] = { id: String(op.id || ''), url: String(op.url || ''), excerpt: String(op.excerpt || ''), updated: n.day };
        break;
      }
      case 'digest': {
        db.digests.unshift({ date: String(op.date || n.day), url: String(op.url || ''), title: String(op.title || ''), lines: (op.lines || []).map(String).slice(0, 8), at: n.iso });
        if (db.digests.length > 60) db.digests.length = 60;
        break;
      }
      case 'transcript_summary': { var st = session(db, op.date); st.transcriptSum = { url: String(op.url || ''), text: String(op.text || ''), at: n.day }; break; }
      case 'new_case_note': {
        db.newCases.forEach(function (x) { if (x.c === normCase(op.c)) { x.note = String(op.note || ''); x.routine = !!op.routine; } });
        break;
      }
      case 'entity_add': {
        var name = String(op.name || '').trim();
        if (!name) break;
        var match = (op.match && op.match.length ? op.match : [name]).map(function (s) { return String(s).trim(); }).filter(String);
        db.entities = db.entities.filter(function (e) { return e.name.toLowerCase() !== name.toLowerCase(); }).concat([{ name: name, match: match }]);
        reclassify(db);
        addActivity(db, '', 'priority entity added: ' + name);
        break;
      }
      case 'entity_remove': {
        var nm = String(op.name || '').toLowerCase();
        db.entities = db.entities.filter(function (e) { return e.name.toLowerCase() !== nm; });
        reclassify(db);
        addActivity(db, '', 'priority entity removed: ' + op.name);
        break;
      }
      case 'ack': {
        db.acked = Math.max(db.acked, Number(op.upTo) || 0);
        db.events = db.events.filter(function (e) { return e.id > db.acked; });
        Object.keys(db.filings).forEach(function (k) { var x = db.filings[k]; if (x.st === 'queued' || x.st === 'requested') x.waitSince = x.waitSince || n.day; });
        break;
      }
      default: log('inbox: unknown op ' + op.op);
    }
  }
  function reclassify(db) {
    Object.keys(db.filings).forEach(function (k) { var f = db.filings[k]; if (f.cls !== 'commission') classify(db, f); });
  }

  // ------------------------------------------------------------------ outputs
  function compactFiling(f) {
    return { fs: f.fs, c: f.c, d: f.d, filer: f.filer, type: f.type, t: f.t, cls: f.cls, ent: f.ent || '', st: f.st, n: f.docs.length,
      sum: f.sum || '', scope: f.scope || '', pages: f.pages || '', sugg: f.sugg || [], partSums: f.partSums || [], sumAt: f.sumAt || '',
      docs: f.docs.map(function (d) { return { t: d.t, sz: d.sz, url: docUrl(d.r) }; }) };
  }
  function writeOutputs(db, n) {
    var dockets = Object.keys(db.dockets).map(function (c) { return db.dockets[c]; })
      .sort(function (a, b) { return (b.tr ? 1 : 0) - (a.tr ? 1 : 0) || a.c.localeCompare(b.c); });
    var sessions = Object.keys(db.sessions).sort().reverse().slice(0, 4).map(function (d) { return db.sessions[d]; });
    var data = {
      version: CFG.VERSION, asof: n.iso, lastCheck: db.lastCheck || '', next: db.next || null,
      dockets: dockets.map(function (k) {
        var fl = filingsOf(db, [k.c]);
        return { c: k.c, title: k.title, ind: k.ind, co: k.co, tr: !!k.tr, added: k.added, via: k.via, url: caseUrl(k.c), nfilings: fl.length,
          comments: { week: k.cWeek || 0, total: k.cTotal || 0 }, narrative: db.narratives[k.c] || null,
          filings: k.tr ? fl.filter(function (f) { return !f.bf || f.sum || f.st !== 'listed'; }).slice(0, 40).map(compactFiling) : [],
          history: k.tr ? fl.filter(function (f) { return f.bf && !f.sum && f.st === 'listed'; }).slice(0, 60).map(function (f) { return { fs: f.fs, c: f.c, d: f.d, filer: f.filer, type: f.type, t: f.t, cls: f.cls, ent: f.ent || '', n: f.docs.length, docs: f.docs.map(function (x) { return { t: x.t, sz: x.sz, url: docUrl(x.r) }; }) }; }) : [],
          deadlines: db.deadlines.filter(function (d) { return d.c === k.c && d.date >= n.day; }) };
      }),
      sessions: sessions.map(function (s) {
        return { date: s.date, url: s.url || '', agendaKind: s.agendaKind || '', changes: s.changes || '', preliminary: s.preliminary || null, final: s.final || null,
          transcript: s.transcript || null, consent: s.consent || null, transcriptSum: s.transcriptSum || null,
          items: (s.items || []).map(function (it) {
            var p = s.picks[it.no] || {};
            return { no: it.no, cases: it.cases, title: it.title, section: it.section, agenda: it.agenda, on: !!p.on, auto: !!p.auto, note: p.note || '',
              key: (p.key || []).map(function (fs) { var f = db.filings[fs]; return f ? compactFiling(f) : { fs: fs }; }), approved: p.approved || [] };
          }) };
      }),
      digests: db.digests.slice(0, 20),
      newCases: db.newCases.slice(0, 60),
      deadlines: db.deadlines.filter(function (d) { return d.date >= n.day; }),
      entities: db.entities,
      activity: db.activity.slice(0, 120),
      errors: db.errors.slice(0, 5),
      addFailed: db.addFailed.slice(0, 5)
    };
    DriveApp.getFileById(CFG.DATA).setContent(JSON.stringify(data));
    DriveApp.getFileById(CFG.EVENTS).setContent(JSON.stringify({ updated: n.iso, acked: db.acked, events: db.events.filter(function (e) { return e.id > db.acked; }).slice(-150) }, null, 1));
    writeSheet(db, n, dockets);
  }
  function ensureSheet(ss, name, header) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
    return sh;
  }
  function fillSheet(ss, name, header, rows) {
    var sh = ensureSheet(ss, name, header);
    var last = sh.getLastRow();
    if (last > 1) sh.getRange(2, 1, last - 1, header.length).clearContent();
    if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  }
  function writeSheet(db, n, dockets) {
    var ss = SpreadsheetApp.openById(CFG.SHEET);
    fillSheet(ss, 'Dockets', ['Case', 'Title', 'Industry', 'Tracked', 'Added', 'Filings', 'Narrative', 'DMM link'],
      dockets.map(function (k) { return [k.c, k.title, k.ind || '', k.tr ? 'yes' : 'no', k.added || '', filingsOf(db, [k.c]).length, (db.narratives[k.c] || {}).url || '', caseUrl(k.c)]; }));
    var tracked = activeDockets(db);
    var fl = filingsOf(db, tracked).slice(0, 500);
    fillSheet(ss, 'Filings', ['Date', 'Case', 'Filed by', 'Type', 'Title', 'Class', 'Documents', 'Status', 'Summary', 'First document'],
      fl.map(function (f) { return [f.d, f.c, f.filer, f.type, f.t, f.cls + (f.ent ? ' (' + f.ent + ')' : ''), f.docs.length, f.st, String(f.sum || '').slice(0, 45000), f.docs[0] ? docUrl(f.docs[0].r) : '']; }));
    var items = [];
    Object.keys(db.sessions).sort().reverse().slice(0, 3).forEach(function (d) {
      var s = db.sessions[d];
      (s.items || []).forEach(function (it) { items.push([d, it.agenda, it.no, it.cases.join(', '), it.title, (s.picks[it.no] || {}).on ? 'yes' : '']); });
    });
    fillSheet(ss, 'Agenda', ['Session', 'Agenda', 'Item', 'Cases', 'Title', 'Picked'], items);
    fillSheet(ss, 'New cases', ['Opened', 'Case', 'Title', 'Type', 'Companies', 'Note', 'Link'],
      db.newCases.slice(0, 150).map(function (x) { return [x.d, x.c, x.title, x.type + (x.sub ? ' / ' + x.sub : ''), x.co, (x.routine ? '(routine) ' : '') + (x.note || ''), x.url]; }));
    fillSheet(ss, 'Digests', ['Date', 'Digest', 'Highlights'], db.digests.map(function (g) { return [g.date, g.url, g.lines.join(' | ')]; }));
    fillSheet(ss, 'Deadlines', ['Date', 'Case', 'Event', 'Source'], db.deadlines.map(function (d) { return [d.date, d.c, d.event, d.src]; }));
    fillSheet(ss, 'Priority entities', ['Entity', 'Matches filer names containing'], db.entities.map(function (e) { return [e.name, e.match.join('; ')]; }));
    var s1 = ss.getSheetByName('Sheet1'); if (s1 && ss.getSheets().length > 1) ss.deleteSheet(s1);
  }

  // ------------------------------------------------------------------ scheduling
  function slotFor(n) { return n.h >= CFG.CHECK_HOUR ? n.day : null; }
  function needsWork(force) {
    if (force) return true;
    var props = PropertiesService.getScriptProperties(), n = nyNow();
    if (props.getProperty('BUSY') === '1') return true;
    if (props.getProperty('CODE_VERSION') !== CFG.VERSION) return true;
    var slot = slotFor(n);
    if (slot && props.getProperty('LAST_SLOT') !== slot) return true;
    if (DriveApp.getFolderById(CFG.INBOX).getFiles().hasNext()) return true;
    return false;
  }
  function ensureTimer() {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('TIMER') === '5min') return;
    ScriptApp.getProjectTriggers().forEach(function (tr) { if (tr.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(tr); });
    ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
    props.setProperty('TIMER', '5min');
    log('timer: every 5 minutes (quick exit when idle)');
  }
  function firstRun(db, n) {
    log('first run: seeding');
    db.entities = db.entities && db.entities.length ? db.entities : DEFAULT_ENTITIES;
    CFG.START_DOCKETS.forEach(function (c) { try { addDocket(db, c, 'starting list'); } catch (e) { log('add ' + c + ' failed: ' + e); } });
    db.lastSweep = n.day;
    try { checkNewCases(db, n, true); } catch (e) { log('new-case seed failed: ' + e); }
    try { checkPublications(db, n, true); } catch (e) { log('publication seed failed: ' + e); }
    try { checkNextSession(db, n); } catch (e) { log('next session failed: ' + e); }
    db.seeded = n.iso;
    addEvent(db, { type: 'setup_complete', detail: 'MyRA is running. Tracking ' + activeDockets(db).join(' and ') + '.' + (db.next ? ' Next PSC session: ' + db.next.date + '.' : '') });
  }
  function regularCheck(db, n, force) {
    try { sweep(db, n); } catch (e) { log('sweep failed: ' + e); throw e; }
    try { checkNewCases(db, n, false); } catch (e) { log('new cases failed: ' + e); }
    try { checkPublications(db, n, false); } catch (e) { log('publications failed: ' + e); }
    if (!db.next || db.next.date < n.day || n.dow === 7 || force) { try { checkNextSession(db, n); } catch (e) { log('next session failed: ' + e); } }
    if (n.dow === 7) { reconcile(db, n); weeklyComments(db); }
  }
  function tick(force) {
    START = Date.now();
    try { ensureTimer(); } catch (e) { log('timer update failed: ' + e); }
    if (!needsWork(force)) { flushLog(); return; }
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) { log('tick skipped: another run is in progress'); flushLog(); return; }
    var n = nyNow(), db = loadDb(), did = [];
    try {
      if (!db.seeded) { firstRun(db, n); did.push('setup'); db.lastSlot = slotFor(n) || db.lastSlot; }
      else if (PropertiesService.getScriptProperties().getProperty('CODE_VERSION') !== CFG.VERSION) did.push('update to ' + CFG.VERSION);
      if (ingest(db)) did.push('inbox');
      var slot = slotFor(n);
      var weekday = n.dow <= 5 || n.dow === 7;      // Saturday off; Sunday runs the weekly reconcile
      if (did.indexOf('setup') < 0) {
        if (force || (slot && db.lastSlot !== slot && weekday)) {
          regularCheck(db, n, force);
          db.lastCheck = n.iso;
          did.push('check');
        }
        if (slot) db.lastSlot = slot;
      }
      if (did.length) writeOutputs(db, n);
      saveDb(db);
      var props = PropertiesService.getScriptProperties();
      props.setProperty('BUSY', '0');
      if (db.lastSlot) props.setProperty('LAST_SLOT', db.lastSlot);
      props.setProperty('CODE_VERSION', CFG.VERSION);
    } catch (e) {
      log('ERROR ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
      db.errors.unshift({ at: n.iso, msg: String(e).slice(0, 300) });
      db.errors.length = Math.min(db.errors.length, 10);
      if (db.lastErrorEvent !== n.day) { db.lastErrorEvent = n.day; addEvent(db, { type: 'error', detail: String(e).slice(0, 300) }); }
      try { saveDb(db); writeOutputs(db, n); } catch (x) {}
    } finally {
      if (did.length) log('tick done: ' + did.join(', ') + ' in ' + Math.round((Date.now() - START) / 1000) + 's');
      flushLog();
      lock.releaseLock();
    }
  }
  function cleanupCode() {
    var it = DriveApp.getFolderById(CFG.ROOT).getFilesByName('myra_code.js'), files = [];
    while (it.hasNext()) files.push(it.next());
    files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
    files.slice(1).forEach(function (f) { try { f.setTrashed(true); } catch (e) {} });
  }
  function setup() {
    START = Date.now();
    var ss = SpreadsheetApp.openById(CFG.SHEET);
    ensureSheet(ss, 'Dockets', ['Case']);
    // Connection test before anything else, so a blocked site shows up right away.
    var t = lookupDocket(CFG.START_DOCKETS[0]);
    if (!t) throw new Error('Could not read DMM (documents.dps.ny.gov). Try again in a few minutes.');
    log('setup: DMM reachable (' + CFG.START_DOCKETS[0] + ' = matter ' + t.seq + ')');
    ScriptApp.getProjectTriggers().forEach(function (tr) { if (tr.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(tr); });
    ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
    PropertiesService.getScriptProperties().setProperty('TIMER', '5min');
    log('setup: 5-minute timer created; code version ' + CFG.VERSION);
    cleanupCode();
    flushLog();
    tick(false);
  }
  return {
    setup: setup,
    tick: function () { tick(false); },
    checkNow: function () { tick(true); },
    _test: { normCase: normCase, strip: strip, classify: classify, isoFromUs: isoFromUs, filingTitle: filingTitle, AGENDA_RE: AGENDA_RE }
  };
})();
