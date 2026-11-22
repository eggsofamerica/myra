// End-to-end test of the MyRA collector against live DMM and DPS data. Run: node test/run.js
const H = require('./harness.js');
const { MyRA, files, sheets, props, setNow, mkFile, CFGIDS } = H;
let fails = 0;
function ok(cond, msg) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; }
const db = () => JSON.parse(files[props.DB_ID].content);
const setDb = d => { files[props.DB_ID].content = JSON.stringify(d); };
const events = () => JSON.parse(files[CFGIDS.EVENTS].content).events;
const data = () => JSON.parse(files[CFGIDS.DATA].content);
let opSeq = 0;
function send(ops) { mkFile('ops-' + (++opSeq) + '.json', JSON.stringify({ ops }), CFGIDS.INBOX); }
function ack() { const ev = events(); if (ev.length) send([{ op: 'ack', upTo: ev[ev.length - 1].id }]); }

// 1. Setup on Wednesday Nov 18, 2026, 7:00 ET
setNow('2026-11-18T12:00:00Z');
MyRA.setup();
let d = db(), ev = events();
ok(d.dockets['26-G-0384'] && d.dockets['26-G-0384'].seq === '89100', '26-G-0384 added with matter id 89100');
ok(d.dockets['22-M-0149'] && /Climate Leadership/i.test(d.dockets['22-M-0149'].title), '22-M-0149 added with its title: ' + (d.dockets['22-M-0149'] || {}).title);
const f384 = Object.values(d.filings).filter(f => f.c === '26-G-0384');
ok(f384.length === 26, '26-G-0384 grouped into 26 filings (got ' + f384.length + ')');
ok(f384.every(f => f.st === 'listed' && f.bf), 'backfilled filings are listed, not queued for summaries');
ok(ev.some(e => e.type === 'docket_added' && e.c === '26-G-0384' && e.commission.length > 0), 'docket_added event carries Commission issuances');
ok(ev.some(e => e.type === 'setup_complete'), 'setup_complete event: ' + (ev.find(e => e.type === 'setup_complete') || {}).detail);
ok(d.next && d.next.date >= '2026-11-18', 'next session found: ' + JSON.stringify(d.next));
ok(Object.keys(d.pubSeen).length > 5, 'existing publications seeded without alerts (' + Object.keys(d.pubSeen).length + ')');
ok(!ev.some(e => e.type === 'new_cases' || e.type === 'agenda'), 'no backlog alerts at setup');
const pr = Object.values(d.filings).find(f => /PRESS RELEASE/i.test(f.t));
ok(pr && pr.cls === 'commission', 'press release classed as Commission: ' + (pr && pr.t));
const grid = Object.values(d.filings).find(f => f.c === '26-G-0384' && /National Grid|KeySpan|Brooklyn Union/i.test(f.filer));
ok(grid && grid.cls === 'priority' && /National Grid/.test(grid.ent), 'National Grid filing classed as priority');
const nycp = Object.values(d.filings).find(f => /New Yorkers for Clean Power/.test(f.filer));
ok(nycp && nycp.cls === 'other', 'New Yorkers for Clean Power filing classed as other');
const multi = Object.values(d.filings).find(f => f.docs.length >= 3);
ok(multi && multi.t && !/^cover/i.test(multi.t), 'multi-document filing titled by its main document: ' + (multi && multi.t));
ack();

// Pretend the Nov 19-20 filings had not been filed yet at setup, so the daily sweep finds them.
d = db();
let removed = 0;
Object.keys(d.filings).forEach(k => { if (d.filings[k].d >= '2026-11-19') { delete d.filings[k]; removed++; } });
setDb(d);
console.log('  (removed ' + removed + ' filing(s) dated Nov 19 or later)');

// 2. Friday Nov 20, 6:05 ET: daily check
setNow('2026-11-20T11:05:00Z');
MyRA.tick();
d = db(); ev = events();
const fe = ev.filter(e => e.type === 'filings');
ok(fe.length >= 1, 'daily sweep emitted filings event(s): ' + fe.map(e => e.c + ' x' + e.filings.length).join(', '));
const order = fe.flatMap(e => e.filings).find(f => /Order Stabilizing Rates/i.test(f.t));
ok(order && order.cls === 'commission' && order.st === 'queued' && order.docs && order.docs[0].url.includes('ViewDoc.aspx'), 'Order Stabilizing Rates queued for summary with a document link');
ok(ev.some(e => e.type === 'new_cases'), 'new-case alert: ' + ((ev.find(e => e.type === 'new_cases') || {}).cases || []).map(c => c.c).join(', '));
ok(((ev.find(e => e.type === 'new_cases') || {}).cases || []).every(c => /^\d\d-[EGM]-\d{4}$/.test(c.c)), 'new cases are E/G/M only');
ok(d.lastSweep === '2026-11-20', 'lastSweep advanced');
ack();

// 3. Claude returns a parsed agenda for the Dec 17 session (an item in a tracked docket is pre-picked)
setNow('2026-11-23T12:30:00Z');
send([{ op: 'agenda', date: '2026-12-17', kind: 'preliminary', items: [
  { no: '101', cases: ['26-G-0384'], title: 'Brooklyn Union Gas / KEDLI rate matter', section: 'GAS', agenda: 'regular' },
  { no: '301', cases: ['15-E-0302'], title: 'Large-Scale Renewable Program and Clean Energy Standard', section: 'POWER', agenda: 'regular' }] }]);
MyRA.tick();
d = db(); ev = events();
ok(d.sessions['2026-12-17'] && d.sessions['2026-12-17'].picks['101'].on && d.sessions['2026-12-17'].picks['101'].auto, 'item 101 (tracked docket) pre-picked');
ok(!(d.sessions['2026-12-17'].picks['301'] || {}).on, 'item 301 (untracked) not picked');
let ip = ev.find(e => e.type === 'item_picked' && e.no === '101');
ok(ip && ip.filings.length > 10, 'item_picked event lists docket filings for proposals (' + (ip ? ip.filings.length : 0) + ')');

// 4. User picks item 301 on the dashboard: its docket becomes tracked
send([{ op: 'pick', date: '2026-12-17', no: '301', on: true }]);
MyRA.tick();
d = db(); ev = events();
ok(d.dockets['15-E-0302'] && d.dockets['15-E-0302'].tr, '15-E-0302 now tracked after pick (' + Object.values(d.filings).filter(f => f.c === '15-E-0302').length + ' filings)');
ok(ev.some(e => e.type === 'item_picked' && e.no === '301'), 'item_picked event for 301');

// 5. Claude proposes key filings; user approves two; Claude returns a summary
const fsList = ip.filings.slice(0, 3).map(f => f.fs);
send([{ op: 'key_filings', date: '2026-12-17', no: '101', fs: fsList, note: 'Commission is considering the rate freeze.' }]);
MyRA.tick();
send([{ op: 'approve', date: '2026-12-17', no: '101', fs: fsList.slice(0, 2) }]);
MyRA.tick();
ev = events();
const se = ev.filter(e => e.type === 'summarize').pop();
ok(se && se.filings.length >= 1 && se.filings[0].docs[0].url, 'summarize event for approved filings');
send([{ op: 'summary', fs: fsList[0], text: 'Test summary.', pages: 62, scope: 'start', sugg: [{ label: 'Appendix B rate tables', where: 'pp. 40-55' }] },
      { op: 'deadline', c: '26-G-0384', date: '2026-12-10', event: 'Reply comments due', src: fsList[0] },
      { op: 'narrative', c: '26-G-0384', id: 'doc123', url: 'https://docs.google.com/document/d/doc123', excerpt: 'Rate freeze approved Nov 19.' }]);
MyRA.tick();
d = db();
ok(d.filings[fsList[0]].sum === 'Test summary.' && d.filings[fsList[0]].sugg.length === 1, 'summary and suggested sections stored');
send([{ op: 'summarize', fs: fsList[0], parts: ['Appendix B rate tables'] }]);
MyRA.tick();
ok(events().some(e => e.type === 'summarize' && e.parts && e.parts[0] === 'Appendix B rate tables'), 'parts request reaches Claude even after a summary exists');

// 6. Entities, add docket by number, bad number, untrack
send([{ op: 'entity_add', name: 'New Yorkers for Clean Power' }, { op: 'entity_remove', name: 'NYC' }, { op: 'add_docket', c: '25-e-764' }, { op: 'add_docket', c: 'hello' }, { op: 'untrack', c: '15-E-0302' }]);
MyRA.tick();
d = db();
ok(Object.values(d.filings).find(f => /New Yorkers for Clean Power/.test(f.filer)).cls === 'priority', 'added entity reclassifies its filings as priority');
ok(!d.entities.some(e => e.name === 'NYC'), 'entity removed');
ok(d.dockets['25-E-0764'] && d.dockets['25-E-0764'].tr, '"25-e-764" normalized to 25-E-0764 and tracked');
ok(d.addFailed.some(x => x.what === 'hello'), 'bad docket number reported');
ok(!d.dockets['15-E-0302'].tr, '15-E-0302 untracked');

// 7. Outputs
const out = data();
ok(out.dockets.find(k => k.c === '26-G-0384').narrative.excerpt === 'Rate freeze approved Nov 19.', 'dashboard data carries narrative');
ok(out.sessions[0].items.find(i => i.no === '101').key.length === 3, 'dashboard data carries proposed key filings');
ok(out.deadlines.length === 1, 'deadline listed');
ok(sheets['Filings'] && sheets['Filings'].length > 20, 'Sheet Filings tab written (' + (sheets['Filings'] || []).length + ' rows)');
ok(sheets['Priority entities'] && sheets['Priority entities'].length === 13, 'Sheet entities tab written');
console.log('data file size: ' + Math.round(files[CFGIDS.DATA].content.length / 1024) + ' KB; db size: ' + Math.round(files[props.DB_ID].content.length / 1024) + ' KB');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
process.exit(fails ? 1 : 0);
