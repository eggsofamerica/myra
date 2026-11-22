# DMM data access (tested 2026-11-22)

DMM (documents.dps.ny.gov) pages load their tables with plain JSON GET requests.
No login, cookies, or browser are needed. Root: `https://documents.dps.ny.gov/public`.

## 1. All filed documents in one docket

`GET /CaseMaster/PublicDocuments/{MatterSeq}`

- `MatterSeq` is DMM's internal matter ID. Get it once from the case page
  (`/MatterManagement/CaseMaster.aspx?MatterCaseNo=26-G-0384`), hidden input
  `GridPlaceHolder_hdnMatterSeq` (26-G-0384 = 89100).
- Returns a JSON list, one row per document.
- Useful fields: `FilingSeq` (filing ID), `ItemNo`, `DateFiled` (MM/DD/YYYY),
  `FilingCompany`, `Doctype`, `DocTitle` (HTML link; strip tags), `DocName`,
  `DocRefNo`, `DocSize`, `DocExt`.
- Group documents into filings by `FilingSeq` (26-G-0384: 49 documents -> 26 filings).
- Document download: `/Common/ViewDoc.aspx?DocRefId={DocRefNo}`.
- Sibling endpoints: `/CaseMaster/PublicComments/{MatterSeq}`,
  `/CaseMaster/ActivePartyList/{MatterSeq}`, `/CaseMaster/Calendar/{MatterSeq}`.

## 2. Every document filed statewide in a date range (daily sweep)

`GET /CaseMaster/DocumentExternal/17-02256?MC=0&IA=&MT=&MST=&CN=&C=&M=&CO=0&DFF=MM%2fDD%2fYYYY&DFT=MM%2fDD%2fYYYY&DT=&CI=0&FC=`

- `17-02256` is a fixed placeholder the site always sends.
- Returns `{DocumentList: [...], PublicComments: [...]}`; each row has `CaseOrMatterNumber`.
- Nov 19-20, 2026: 222 documents, 126 public comments. Filter to tracked dockets.

## 3. New cases and matters opened in a date range

`GET /CaseMaster/MatterExternal/17-02256?MC=1&IA=&MT=&MST=&CN=&SDF=MM%2fDD%2fYYYY&SDT=MM%2fDD%2fYYYY&C=&M=&CO=0`

- Returns a JSON list: `CaseOrMatterNumber` (HTML; strip tags), `MatterType`,
  `MatterSubType`, `MatterTitle`, `MatterCompanies`, `strSubmitDate`.
- Nov 1-20, 2026: 154 items; 24 carry a case number (10 E, 1 G, 1 M, 10 V, 1 C, 1 W).
  The rest are matters (tariffs 57, contracts 38, incidents 32, petitions, complaints).

## Not yet tested

- The same requests from Google Apps Script (Google's servers). Confirm when the collector is first deployed.
