// MyRA — paste this whole file into Extensions > Apps Script (replacing what's there), save, then run "setup".
// It loads MyRA's actual code from your Google Drive (MyRA folder > myra_code.js), so Claude can
// update the app later without you pasting anything again.
var MYRA_FOLDER = 'YOUR_MYRA_FOLDER_ID';

function loadMyRA_() {
  if (globalThis.MyRA) return globalThis.MyRA;
  var it = DriveApp.getFolderById(MYRA_FOLDER).getFilesByName('myra_code.js'), best = null;
  while (it.hasNext()) { var f = it.next(); if (!best || f.getDateCreated() > best.getDateCreated()) best = f; }
  if (!best) throw new Error('myra_code.js is missing from the MyRA folder in Drive.');
  (0, eval)(best.getBlob().getDataAsString());
  return globalThis.MyRA;
}
function setup() { loadMyRA_().setup(); }
function tick() { loadMyRA_().tick(); }
function checkNow() { loadMyRA_().checkNow(); }
function onOpen() {
  SpreadsheetApp.getUi().createMenu('MyRA').addItem('Run a check now', 'checkNow').addItem('Re-run setup', 'setup').addToUi();
}
// Never called. It tells Google which permissions MyRA needs (read/write its Drive files and the Sheet,
// fetch PSC data, run on a timer).
function permissions_() {
  var f = DriveApp.getFileById('x'); f.setContent(''); f.setTrashed(true); DriveApp.createFile('x', 'x');
  DriveApp.getFolderById('x').createFile('x', 'x', 'text/plain');
  UrlFetchApp.fetch('https://documents.dps.ny.gov'); UrlFetchApp.fetchAll([]);
  SpreadsheetApp.openById('x').insertSheet('x');
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(30).create(); ScriptApp.getProjectTriggers();
  PropertiesService.getScriptProperties(); LockService.getScriptLock();
}
