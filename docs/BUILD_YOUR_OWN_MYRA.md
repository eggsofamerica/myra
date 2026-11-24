# Build your own MyRA: instructions for Claude

**To the person reading this:** give this file (or a link to it) to Claude in a chat and say "Help me set up my own MyRA using this guide." Claude will interview you, do most of the work itself, and tell you exactly when it needs you to click something. Plan on about an hour, with a computer for one step.

**To Claude:** you are helping a person set up their own private instance of MyRA, a tracker for the New York Public Service Commission (PSC). The code is in the public GitHub repo `eggsofamerica/myra`. Everything else (their Google Drive files, the Apps Script collector, the scheduled Claude check and the dashboard) must be created fresh for them, in their accounts. Never reuse IDs from anyone else's instance; the repo holds only placeholders. The person may have no technical background: do the work yourself wherever your tools allow, ask them only for what only they can do, and give them those steps one at a time in plain words.

This guide records what the original build learned the hard way. Follow it in order and verify each step before the next.

---

## 1. What MyRA is

Four parts, all on the person's own accounts:

| Part | Where it runs | What it does |
| --- | --- | --- |
| Collector (`collector/myra_code.js`, loaded by `collector/bootstrap.gs`) | Google Apps Script, attached to a Google Sheet; runs every 5 minutes, exits in seconds when idle | Each weekday morning: reads DMM (the PSC's Document and Matter Management system) for new filings in tracked dockets and newly opened cases, and the DPS website for session agendas, consent summaries and transcripts. Keeps a database in Drive, writes the Sheet, a dashboard data file, and an event queue. Applies requests that arrive as JSON files in a Drive inbox folder. No AI. |
| Scheduled Claude check (`claude-check/prompt.md`, with `claude-check/myra_tools.py`) | A Claude scheduled task, once each weekday morning | Reads the event queue; summarizes Commission issuances and priority-entity filings (Opus subagents); writes and updates a "state of play" narrative per docket; parses agendas; proposes key filings for picked agenda items; reviews transcripts; screens new cases; writes a digest Google Doc when there is news; sends its results back as an inbox file; its final message is the push notification. |
| Dashboard (`dashboard/index.html`) | A claude.ai artifact | Reads the data file through the viewer's Google Drive connector; sends requests (track/untrack dockets, pick agenda items, approve key filings, request summaries, edit priority entities, rebuild a narrative) as small JSON files in the inbox; can start the scheduled check on demand. |
| Google Drive files | The person's Drive | A `MyRA` folder with `inbox`, `work`, `Docket narratives` and `Digests` subfolders, the data/events/log files, the code files, and a `MyRA` Sheet. |

Data flow: collector → event queue → Claude check → inbox ops → collector → data file → dashboard; dashboard → inbox ops → collector.

Useful background: `README.md`, `docs/dmm-access.md` (the DMM JSON requests), and the top of each code file.

## 2. Connect Google Drive first

MyRA cannot be built without the Google Drive connector, and the person may never have connected one. Handle this before anything else.

1. **Check this session.** Look for Google Drive tools (`create_file`, `search_files`, `read_file_content`, `download_file_content`, `trash_file`; their full names usually start with `mcp__Google_Drive__`). If tools are deferred, search for them with your tool search ("google drive create file") before concluding they are missing.
2. **If they are missing,** find out why:
   - Not connected at all: if you have a connector registry search (such as `SearchMcpRegistry` and `SuggestConnectors`), search for "Google Drive" and show the person the connect option. Otherwise tell them: "MyRA keeps its files in your Google Drive, so I need the Google Drive connector. In claude.ai, open Settings, go to Connectors, find Google Drive and connect it. Sign in with the Google account you want MyRA to use and allow the access Google asks for. Then come back to this chat and tell me it's done." Exact labels can differ by app version, so describe the place and don't promise the precise wording.
   - Connected but off in this chat: ask them to turn Google Drive on in this chat's connector or tools menu, then continue.
   - Ask which Google account to use. A personal account works well. A work account may have admin restrictions that block Apps Script or sharing.
3. **Prove it works.** Create a small test file in their Drive (a text file `myra-connection-test.txt` with `disableConversionToGoogleType: true`), read it back, then trash it. If any step fails, fix the connection before going on. Don't start the build on a half-working connector.
4. **Tell them why it matters later.** The scheduled check and the dashboard both reach Google Drive through this same connection. If it ever lapses, MyRA stops updating until they reconnect it in the same place.

## 3. Check what else the person and this session have

Confirm each item and tell the person plainly about anything missing.

- **A Claude plan with scheduled tasks** and the scheduling tools in this session (`create_trigger`, `update_trigger`, `fire_trigger`, `list_triggers`; search for them with your tool search if they are deferred).
- **The scheduling connector for the dashboard.** The dashboard's "Run the check now" button calls `fire_trigger` through the viewer's own connectors. In the original build that connector's display name was "Claude Code Remote". If the person's account shows it under another name, use that name in Step 7. If they don't have it at all, the button won't work, but everything else will, and the check still runs on schedule.
- **An artifact tool** that can publish a page and declare capabilities (`publish_files` or `publish_version`, and `declare_capabilities`).
- **A shell in this session** with Node and Python (for tests and for preparing files), and access to GitHub to clone the repo.
- **Network access to the PSC sites.** Run `curl -s -o /dev/null -w "%{http_code}\n" "https://documents.dps.ny.gov/public/MatterManagement/CaseMaster.aspx?MatterCaseNo=22-M-0149"`. If it is not 200, the person must add `documents.dps.ny.gov` and `dps.ny.gov` to the allowed domains for Claude's code execution (on claude.ai in a web browser, under Settings, in the capabilities or code-execution network settings; let them find the exact control, and do not guess a menu path). This also lets the scheduled check download filings, so it is required, not optional. Retest afterwards.
- **A computer for one step** (pasting a script into Google Apps Script; the phone editor is impractical).

## 4. Interview the person first

Ask these in one or two short rounds (use your multiple-choice question tool if you have one). Write the answers into a private notes file in your working directory, never into a public repo.

1. **Starting dockets** to track (case numbers like `26-G-0384`; matter numbers like `26-01149` also work). One or two is enough; they can add more from the dashboard. Look each one up on DMM to confirm it exists and to show its title.
2. **Priority entities**: parties whose filings should be summarized automatically. Start from `DEFAULT_ENTITIES` in `collector/myra_code.js` (NYSERDA, the major utilities, NYISO, NYPA, UIU, NYC, Multiple Intervenors, ACE NY) and ask what to add or drop. Each entity has a display name and the name fragments DMM uses (for example National Grid matches "Niagara Mohawk", "Brooklyn Union Gas", "KeySpan").
3. **Who the summaries are for**: their role and areas of interest, one or two sentences. This replaces the generic reader line in the check's instructions.
4. **New-proceeding alerts**: default is numbered electric, gas and general cases (`NEW_CASE_RE = /^\d{2}-[EGM]-\d{4}$/`). Offer to add other industries or to turn alerts off.
5. **Schedule and time zone**: default collector at about 6:00 a.m. and check at 6:49 a.m. Eastern, weekdays. The check must run after the collector.
6. **Models**: recommend Sonnet for the scheduled task (cheaper) with Opus subagents for summaries and narratives (already written into the instructions). Only set or change a task's model when the person asks for it in their own words.
7. **Do they want their own GitHub fork?** Not required. If yes, it must stay free of their Drive IDs, names and other identifying details; keep all real IDs only in private copies.

## 5. Build it

### Step 1. Get the code and prove the environment works

```
git clone --depth 1 https://github.com/eggsofamerica/myra /home/claude/myra
cd /home/claude/myra && node test/run.js
```

The test mocks Google's services but sends real requests to DMM and the DPS website (cached in `test/cache/`), then checks grouping, classification, the daily sweep, new cases, agenda picks, summaries, entities and outputs. All checks should pass before you change anything. The test's assertions are written for the default dockets, so run it on the unmodified code. If live PSC data has moved on, a count-based check (such as "26 filings") may drift; read the failure before assuming the code is broken.

### Step 2. Customize the collector

Edit a private copy (for example `/home/claude/myra-private/myra_code.js`), not the clone, unless they have their own fork:

- `CFG.START_DOCKETS`: their starting dockets. The first one is also used by `setup()` as a connection test, so it must exist on DMM.
- `DEFAULT_ENTITIES`: their priority entities.
- `CFG.NEW_CASE_RE`: their new-case filter.
- `CFG.TZ` and `CFG.CHECK_HOUR`: time zone and collection hour.
- `CFG.VERSION`: bump it whenever you change the code (any new string). A version change makes the collector rewrite its outputs on its next run.

Syntax-check with `node -e "new Function(require('fs').readFileSync('<file>','utf8'))"`.

### Step 3. Create the Google Drive files

Use the Google Drive connector's `create_file`. Record every returned `id` in the private notes file.

| Create | How | Placeholder it fills |
| --- | --- | --- |
| Folder `MyRA` | `contentMimeType: application/vnd.google-apps.folder` | `YOUR_MYRA_FOLDER_ID` |
| Folder `inbox` inside `MyRA` | same, `parentId` = MyRA | `YOUR_INBOX_FOLDER_ID` |
| Folder `work` inside `MyRA` | same | `YOUR_WORK_FOLDER_ID` |
| Folder `Docket narratives` inside `MyRA` | same | `YOUR_NARRATIVES_FOLDER_ID` |
| Folder `Digests` inside `MyRA` | same | `YOUR_DIGESTS_FOLDER_ID` |
| Google Sheet `MyRA` inside `MyRA` | `contentMimeType: application/vnd.google-apps.spreadsheet` | `YOUR_SHEET_ID` |
| `myra_data.json` with text `{}` | `contentMimeType: text/plain`, `disableConversionToGoogleType: true` | `YOUR_DATA_FILE_ID` |
| `myra_events.json` with text `{"events":[]}` | same | `YOUR_EVENTS_FILE_ID` |
| `myra_log.txt` with text `MyRA log` | same | `YOUR_LOG_FILE_ID` |

Always set `disableConversionToGoogleType: true` for code and JSON, or Drive turns them into Google Docs and the collector cannot read them.

### Step 4. Fill in IDs and upload the code

1. In the private copy of `collector/myra_code.js`, replace `YOUR_MYRA_FOLDER_ID`, `YOUR_INBOX_FOLDER_ID`, `YOUR_WORK_FOLDER_ID`, `YOUR_SHEET_ID`, `YOUR_DATA_FILE_ID`, `YOUR_EVENTS_FILE_ID`, `YOUR_LOG_FILE_ID`. Confirm no `YOUR_` remains.
2. Upload it to the `MyRA` folder as `myra_code.js` (`text/plain`, no conversion). For a file on disk, the connector accepts `base64Content: "sha256:<hex>:<absolute path>"` (compute the hash with `sha256sum`); if that is refused, send the file's text as `textContent`.
3. Upload `claude-check/myra_tools.py` the same way as `myra_tools.py`. Its ID fills `YOUR_TOOLS_FILE_ID`.
4. In a private copy of `collector/bootstrap.gs`, replace `YOUR_MYRA_FOLDER_ID`.

The bootstrap always loads the newest `myra_code.js` in the folder. When you update the code later, upload the new file, then trash the old copy with `trash_file`.

### Step 5. The person installs the collector (their one hands-on step)

Give them these steps, with the filled-in bootstrap in a code block:

1. On a computer, open their MyRA Sheet (link it) and choose Extensions → Apps Script.
2. Replace everything in the editor with the code block, then save.
3. Choose `setup` in the function menu and press Run. Google warns that the app is unverified, because it is their own script: click Advanced, then "Go to project", then Allow.

`setup()` first checks that Google's servers can reach DMM, then creates a 5-minute timer and seeds MyRA: it adds the starting dockets with their filing history, and records existing agendas and recent cases without alerting on them. Verify by reading `myra_log.txt`. Expect lines like `setup: DMM reachable (...)`, `docket added <case> (<n> filings)`, `new cases ... (seeded, no alert)`, `next session: <date>`, `tick done: setup`. Read `myra_events.json`: it should hold one `docket_added` event per starting docket and a `setup_complete` event. If setup failed, ask the person to paste the error.

### Step 6. Create the scheduled check

1. Copy `claude-check/prompt.md` privately and personalize it:
   - Replace `YOUR_EVENTS_FILE_ID`, `YOUR_INBOX_FOLDER_ID`, `YOUR_NARRATIVES_FOLDER_ID`, `YOUR_DIGESTS_FOLDER_ID`, `YOUR_TOOLS_FILE_ID`.
   - Replace the reader line ("The reader is an expert in New York energy policy ...") with what they told you in the interview, and optionally "the user" with their first name.
2. Create the scheduled task with `create_trigger`: the full personalized text as the prompt, a weekday cron in their time zone after the collector (default `CRON_TZ=America/New_York 49 6 * * 1-5`), push notifications on. Tell them in one sentence what approval setting it got. Then check the new task's connections (in the `create_trigger` result or `list_triggers`): Google Drive must be among them, or the check cannot read its queue. If it is missing, make sure Google Drive is connected and on in this chat, then update or recreate the task.
3. **Expect a possible permission block.** An automatic safety check may refuse to create a task that sends push notifications or acts unattended. Do not work around it. Explain what you were creating and ask the person to say explicitly that you should go ahead, then retry once. If it is still refused, give them the prompt text to paste into a new scheduled task themselves in the Claude app.
4. Run it once now with `fire_trigger`. After about 5 to 10 minutes, verify: a narrative Google Doc per starting docket in `Docket narratives`, a digest in `Digests`, and a new `inbox: applied <n> op(s)` line in `myra_log.txt`. Read one narrative and judge its quality before moving on.

### Step 7. Publish the dashboard

1. In a private copy of `dashboard/index.html`, replace `YOUR_INBOX_FOLDER_ID`, `YOUR_DATA_FILE_ID`, `YOUR_SHEET_ID`, `YOUR_MYRA_FOLDER_ID`, `YOUR_DIGESTS_FOLDER_ID` and `YOUR_TRIGGER_ID` (the scheduled task's `trig_…` ID). If they chose a different schedule, also edit the two sentences that mention 6:49 a.m. and 6 a.m.
2. Publish it as a new artifact titled `MyRA` (publish from the file if your tool allows).
3. Declare its capabilities exactly (publish first, then declare):
   ```json
   {"mcp": {"servers": [
     {"server": "Google Drive", "tools": ["download_file_content", "read_file_content", "create_file", "search_files"]},
     {"server": "Claude Code Remote", "tools": ["fire_trigger"]}]}}
   ```
   Server names are the connectors' display names. If their scheduling connector shows under a different display name, use that name in both the declaration and the page's `RUNNER` constant.
4. Ask them to open it and allow Google Drive when prompted. Every tab should load their data. Have them press "Summarize" on one older filing, then "Run the check now", and confirm the summary appears within about 20 minutes.

### Step 8. Hand-off

Tell the person, briefly:

- **Each morning:** the collector runs, then the check. They get a push alert and a digest only on days with news.
- **In the dashboard:** pick agenda items (picking also tracks the docket), approve key filings, request summaries or sections of long filings, add or untrack dockets, edit priority entities, rebuild a narrative, and "Run the check now" for anything they don't want to wait on.
- **Timing:** requests reach the collector within 5 minutes. The check waits for requests still in the inbox before it starts.
- **The Sheet** mirrors everything for browsing.

## 6. Lessons from the original build

- **DMM blocks one user agent.** A bare `Mozilla/5.0` header gets an empty reply. curl's default and Google Apps Script's own header both work. Don't set a fake browser header.
- **DMM's case pages load their tables by script.** Use the JSON requests in `docs/dmm-access.md`; no browser is needed.
- **A message appended to a run doesn't override an empty queue.** The check stops at "No MyRA updates." when the queue is empty, so text you pass to `fire_trigger` is ignored. To make the check do something, have the collector queue it. Example: to rebuild a narrative, drop `{"ops":[{"op":"renarrate","c":"<case>"}]}` into the inbox (the dashboard's "Rebuild narrative" button does this), wait for the collector, then run the check.
- **Narratives must read the latest order in full.** The instructions say so. An opening-pages-only read misses ordering clauses.
- **Trashing files can be blocked.** A safety check may stop an unattended run from trashing a document. Ask the person before any one-off run that deletes or replaces something.
- **Every inbox file needs an `ops` list.** Any filename works. The collector applies the ops and trashes the file. Dashboard requests are named `dash__…` so the check knows to wait for them.
- **Updating the collector:** upload the new code, bump `CFG.VERSION`, and trash the old `myra_code.js`. Within 5 minutes the log shows `tick done: update to <version>`.
- **Agenda timing:** the preliminary agenda posts about a week before a session and the final one the day before. Transcripts take several weeks. DPS press releases are filed into the dockets themselves, so tracking a docket catches them.
- **Public comments** are counted, not summarized, unless the person asks for one or a priority entity filed it.

## 7. Placeholder reference

| Placeholder | File(s) | Value |
| --- | --- | --- |
| `YOUR_MYRA_FOLDER_ID` | collector, bootstrap, dashboard | MyRA folder |
| `YOUR_INBOX_FOLDER_ID` | collector, check prompt, dashboard | inbox folder |
| `YOUR_WORK_FOLDER_ID` | collector | work folder |
| `YOUR_SHEET_ID` | collector, dashboard | MyRA Sheet |
| `YOUR_DATA_FILE_ID` | collector, dashboard | myra_data.json |
| `YOUR_EVENTS_FILE_ID` | collector, check prompt | myra_events.json |
| `YOUR_LOG_FILE_ID` | collector | myra_log.txt |
| `YOUR_NARRATIVES_FOLDER_ID` | check prompt | Docket narratives folder |
| `YOUR_DIGESTS_FOLDER_ID` | check prompt, dashboard | Digests folder |
| `YOUR_TOOLS_FILE_ID` | check prompt | myra_tools.py in Drive |
| `YOUR_TRIGGER_ID` | dashboard | the scheduled task's `trig_…` ID |

Inbox ops the collector understands (see `applyOp` in `collector/myra_code.js`): `track`/`add_docket`, `untrack`, `renarrate`, `pick`, `agenda`, `key_filings`, `approve`, `summarize`, `summary`, `deadline`, `narrative`, `transcript_summary`, `digest`, `new_case_note`, `entity_add`, `entity_remove`, `ack`.
