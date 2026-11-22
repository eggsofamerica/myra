// Node harness: mocks the Apps Script services; web requests go to the live DMM/DPS sites (cached in test/cache).
const fs = require('fs'), crypto = require('crypto'), path = require('path');
let NOW = new Date('2026-11-23T12:10:00-05:00'); // Monday 7:10am NY? (12:10 UTC = 7:10 NY)
NOW = new Date('2026-11-23T12:10:00Z');
const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW.getTime()); }
  static now() { return NOW.getTime(); }
};
function setNow(iso) { NOW = new RealDate(iso); }

// ---------- Utilities
function partsNY(d) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' });
  const o = {}; f.formatToParts(d).forEach(p => o[p.type] = p.value);
  if (o.hour === '24') o.hour = '00';
  return o;
}
global.Utilities = {
  formatDate(d, tz, pat) {
    const o = partsNY(d), dow = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[o.weekday];
    return pat.replace(/'T'/, 'T').replace('yyyy', o.year).replace('MM', o.month).replace('dd', o.day).replace('HH', o.hour).replace('mm', o.minute).replace('ss', o.second)
      .replace(/(^|-)M(-|$)/, `$1${+o.month}$2`).replace(/-d-/, `-${+o.day}-`).replace(/-H-/, `-${+o.hour}-`).replace(/-u$/, `-${dow}`);
  },
  computeDigest(alg, s) { return [...crypto.createHash('md5').update(s, 'utf8').digest()].map(b => b > 127 ? b - 256 : b); },
  DigestAlgorithm: { MD5: 'md5' }, Charset: { UTF_8: 'utf8' }, sleep() {}
};
// ---------- Drive
let fileSeq = 0;
const files = {};
function mkFile(name, content, parent, id) {
  id = id || 'f' + (++fileSeq);
  const f = { id, name, content, parent, trashed: false, created: new RealDate(NOW.getTime() + fileSeq) };
  files[id] = f; return wrap(f);
}
function wrap(f) {
  return { getId: () => f.id, getName: () => f.name, getBlob: () => ({ getDataAsString: () => f.content }), setContent: c => { f.content = c; }, setTrashed: t => { f.trashed = t; }, getDateCreated: () => f.created, getLastUpdated: () => new RealDate(0) };
}
function folderObj(id) {
  return {
    createFile: (n, c) => mkFile(n, c, id),
    getFiles: () => iter(Object.values(files).filter(f => f.parent === id && !f.trashed)),
    getFilesByName: n => iter(Object.values(files).filter(f => f.parent === id && !f.trashed && f.name === n))
  };
}
function iter(arr) { let i = 0; return { hasNext: () => i < arr.length, next: () => wrap(arr[i++]) }; }
global.DriveApp = { getFileById: id => { if (id === 'YOUR_SHEET_ID') return { getLastUpdated: () => new RealDate(NOW.getTime()) }; if (!files[id]) throw new Error('no file ' + id); return wrap(files[id]); }, getFolderById: folderObj, getRootFolder: () => folderObj('root') };
// ---------- Sheets
const sheets = {};
function colIdx(L) { return L.charCodeAt(0) - 64; }
function sheetObj(name) {
  const data = sheets[name] = sheets[name] || [];
  const self = {
    getRange(a, b, c, d) {
      let r, col, nr = 1, nc = 1;
      if (typeof a === 'string') {
        const m = a.match(/^([A-Z])(\d+)(?::([A-Z])(\d+))?$/);
        r = +m[2]; col = colIdx(m[1]); if (m[3]) { nr = +m[4] - r + 1; nc = colIdx(m[3]) - col + 1; }
      } else { r = a; col = b; nr = c || 1; nc = d || 1; }
      return {
        setValues(v) { if (v.length !== nr || v[0].length !== nc) throw new Error(`setValues dims ${v.length}x${v[0].length} vs ${nr}x${nc}`); v.forEach((row, i) => { data[r - 1 + i] = data[r - 1 + i] || []; row.forEach((x, j) => data[r - 1 + i][col - 1 + j] = x); }); return this; },
        getValues() { const o = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(((data[r - 1 + i] || [])[col - 1 + j]) ?? ''); o.push(row); } return o; },
        getValue() { return ((data[r - 1] || [])[col - 1]) ?? ''; },
        clearContent() { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (data[r - 1 + i]) data[r - 1 + i][col - 1 + j] = ''; return this; },
        insertCheckboxes() { return this; }, setFontWeight() { return this; }
      };
    },
    getLastRow() { let l = 0; data.forEach((row, i) => { if (row && row.some(x => x !== '' && x !== undefined)) l = i + 1; }); return l; },
    setFrozenRows() {}, setColumnWidth() {}
  };
  return self;
}
const ss = {
  getSheetByName: n => sheets[n] ? sheetObj(n) : null, insertSheet: n => sheetObj(n), deleteSheet: () => {}, getSheets: () => Object.keys(sheets).map(sheetObj), setActiveSheet() {}
};
sheets['Sheet1'] = [];
global.SpreadsheetApp = { openById: () => ss, getActive: () => ss };
const props = {};
global.PropertiesService = { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; } }) };
global.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
const triggers = [];
global.ScriptApp = { getProjectTriggers: () => triggers, deleteTrigger() {}, newTrigger: h => ({ timeBased: () => ({ everyMinutes: m => ({ create: () => triggers.push({ h, m, getHandlerFunction: () => h }) }) }) }) };

// ---------- Live web (cached so reruns are fast and repeatable)
const { execFileSync } = require('child_process');
const CACHE = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE);
const calls = [];
function respond(url) {
  calls.push(url);
  const key = crypto.createHash('sha1').update(url).digest('hex');
  const p = path.join(CACHE, key);
  let body;
  if (fs.existsSync(p)) body = fs.readFileSync(p, 'utf8');
  else {
    body = execFileSync('curl', ['-s', '-L', '--max-time', '90', '-A', 'Mozilla/5.0 (compatible; Google-Apps-Script; beanserver; +https://script.google.com; id: test)', url], { maxBuffer: 64 << 20 }).toString('utf8');
    fs.writeFileSync(p, body);
  }
  return { getResponseCode: () => (body ? 200 : 500), getContentText: () => body, getHeaders: () => ({}) };
}
global.UrlFetchApp = { fetch: (u) => respond(u), fetchAll: reqs => reqs.map(r => respond(r.url || r)) };
Utilities.formatDate = function (d, tz, pat) {
  const o = partsNY(d), dow = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[o.weekday];
  if (pat === 'yyyy-M-d-H-u') return `${+o.year}-${+o.month}-${+o.day}-${+o.hour}-${dow}`;
  return pat.replace("'T'", 'T').replace('yyyy', o.year).replace('MM', o.month).replace('dd', o.day).replace('HH', o.hour).replace('mm', o.minute).replace('ss', o.second);
};

// ---------- Load code with Drive ids
const code = fs.readFileSync(path.join(__dirname, '..', 'collector', 'myra_code.js'), 'utf8');
const CFGIDS = { DATA: 'YOUR_DATA_FILE_ID', EVENTS: 'YOUR_EVENTS_FILE_ID', LOG: 'YOUR_LOG_FILE_ID', INBOX: 'YOUR_INBOX_FOLDER_ID' };
mkFile('myra_data.json', '{}', 'root', CFGIDS.DATA); mkFile('myra_events.json', '{"events":[]}', 'root', CFGIDS.EVENTS); mkFile('myra_log.txt', '', 'root', CFGIDS.LOG);
(0, eval)(code);
module.exports = { MyRA: globalThis.MyRA, files, sheets, props, calls, setNow, mkFile, CFGIDS, triggers };
