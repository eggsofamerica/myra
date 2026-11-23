# MyRA

A personal tracker for New York Public Service Commission activity: session agendas and transcripts, filings in tracked dockets, and new proceedings.

## How it fits together

- **collector/**: Google Apps Script. `bootstrap.gs` is pasted once into a Google Sheet's script editor. It loads `myra_code.js` from a Drive folder and runs every 5 minutes, exiting within seconds when idle. Once each morning it reads the PSC's Document and Matter Management system (DMM) and the DPS website, keeps a database in Drive, and writes the Sheet, a dashboard data file and an event queue. No AI runs here.
- **claude-check/**: instructions for the scheduled Claude check (`prompt.md`) and `myra_tools.py`, which downloads PSC documents and extracts page-marked text. The check reads the event queue, writes filing summaries, docket narratives, agenda lists and transcript reviews, and a digest when there is news.
- **docs/**: notes on the DMM data requests the collector uses.
- **test/**: a Node harness that mocks the Apps Script services and runs the collector against live DMM and DPS data. Run `node test/run.js`.

Still to come: the dashboard.

## Configuration

Drive file and folder IDs are placeholders (`YOUR_…`) in this copy.
