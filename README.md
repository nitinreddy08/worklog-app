# Worklog

A mobile-first Progressive Web App for logging your daily work and
sending it straight to a Google Sheet — no app store, no login, no
database. Open it from your Android home screen, fill in today's tasks,
tap Save, done.

```
Android Home Screen → Worklog PWA → Google Apps Script → Google Sheet
```

## Quick start

1. **Set up the Google Sheet backend** — follow
   [`google-apps-script/README.md`](./google-apps-script/README.md)
   step by step. At the end you'll have a Web App URL.
2. **Configure the PWA** — open [`app.js`](./app.js) and set:
   ```js
   const CONFIG = {
     APPS_SCRIPT_URL: "https://script.google.com/macros/s/XXXXXXXX/exec",
     API_SECRET: "", // only if you set one in Script Properties
     ...
   };
   ```
3. **Deploy the static site** — follow [`DEPLOYMENT.md`](./DEPLOYMENT.md)
   (GitHub Pages or Cloudflare Pages, both free).
4. **Install on your phone** — open the deployed HTTPS URL in Chrome on
   Android, then **⋮ menu → Add to Home screen**.
5. **Test it** — walk through [`TESTING.md`](./TESTING.md).

## File structure

```
worklog-app/
  index.html                 the single screen (form + confirmation view)
  styles.css                 mobile-first styling, light/dark aware
  app.js                     all client logic + CONFIG (Apps Script URL)
  manifest.webmanifest       installable PWA metadata
  service-worker.js          app-shell caching for offline load
  icons/
    icon-192.png
    icon-512.png
  google-apps-script/
    Code.gs                  backend: validation, sheet writes, dedup
    README.md                Apps Script setup, deploy & troubleshooting
  DEPLOYMENT.md               static hosting + Android install guide
  TESTING.md                  manual test checklist
```

## How data flows

1. You fill in one or more tasks — a ticket and one of three durations
   (**1 Day**, **1st Half**, **2nd Half**) — for a date (defaults to
   today, using your phone's local date/time). This mirrors Jira's own
   "Log work" dialog, which only needs a start date and a time-spent
   duration, never an end time.
2. On Save, the entries are POSTed as one JSON payload (with a unique
   `submissionId`) to the Apps Script Web App.
3. The script validates everything again server-side (never trusts the
   client), maps each preset to its start time and Jira-format time
   spent (`1d`, `5h`), and writes **one row per entry** into the correct
   month section — `Date | Ticket | Start Time | Time Spent`. Rows are
   kept in ascending date order (then start time), so a backfilled
   earlier date is inserted in its proper place, not appended at the
   bottom. A new month gets its own `MONTH YYYY` heading with exactly 3
   blank rows before it; prior months are never touched. Rows are never
   merged: the same ticket morning and afternoon is two rows, because
   it is two Jira worklogs (and `1d` is 8h in Jira, so two 5h halves
   must not collapse into it).
4. If you're offline, the payload is queued in the browser's storage and
   retried automatically once you're back online — nothing is lost, and
   duplicate delivery is prevented by the same `submissionId` check on
   the backend.

## Design notes / deliberate trade-offs

- **No database, no backend server** — Google Sheets is the store and
  Apps Script is the only backend, per the brief. This keeps the whole
  thing free and simple, at the cost of Apps Script's execution quotas
  (irrelevant at personal-use volume) and the CORS workaround below.
- **`text/plain` request Content-Type** — Apps Script Web Apps don't
  handle CORS preflight (`OPTIONS`) requests. Sending
  `Content-Type: text/plain` avoids the browser triggering a preflight,
  while the script still parses the body as JSON. This is a
  well-known, standard workaround for this platform, not a hack
  specific to this app.
- **`API_SECRET` is not real security** — it's documented plainly in
  `google-apps-script/README.md`: a secret embedded in frontend
  JavaScript is visible to anyone who views source. It only filters out
  bots that stumble onto the endpoint, not a targeted attacker. The
  practical protection here is simply that the Web App URL is
  long and unguessable.
- **Offline queue uses `localStorage`, not IndexedDB** — the data
  volume for a personal daily worklog (a handful of small JSON objects)
  doesn't warrant IndexedDB's extra complexity; `localStorage` meets the
  "don't lose data offline" requirement with much simpler code. If you
  outgrow this (hundreds of queued offline entries), swap the
  `readQueue`/`writeQueue` functions in `app.js` for an IndexedDB-backed
  version.
- **One row = one Jira worklog** — the sheet is shaped for Jira's "Log
  work" dialog, which takes exactly a ticket, a "Date started" (date +
  time) and a "Time spent" duration; there is no end time in Jira, so
  there is none here either. Presets map server-side (so the client
  can't spoof them): 1 Day → starts 8:00 AM, `1d`; 1st Half → starts
  8:00 AM, `5h`; 2nd Half → starts 2:00 PM, `5h`. Jira treats `1d` as
  8h by default and that is deliberately left alone.
- **Never merged, always sorted** — logging the same ticket morning and
  afternoon is two rows (two worklogs), never one. Rows within a month
  are kept in ascending (date, start time) order, so backfilling an
  earlier day lands in the right place.
- **Dates are `YYYY-MM-DD`** — the month-end CSV goes to a Claude chat
  to log into Jira, and `04-09-2026` is ambiguous (April 9 or Sept 4?)
  while ISO isn't.
- **Every cell is written as plain text** — Sheets otherwise silently
  turns `SEPTEMBER 2026` into a date (which broke month detection and
  produced duplicate headings) and dates/times into locale-formatted
  values that export inconsistently. Detection also recognises a
  heading Sheets already converted, and rewrites it back to text.
- **Historical/backfilled dates** — "Log another date" lets you submit
  for any date. The backend places new rows into the correct month
  section regardless of submission order: if that month's heading
  already exists, rows are appended under it; if the month is new, a
  heading is created in the correct chronological position (including
  inserting an entire new month block ahead of a later month that's
  already present), while never disturbing other months' existing rows.

## Final requirements checklist

### BUILT

- Mobile-first single-screen PWA (`index.html`, `styles.css`, `app.js`)
- Auto-populated local date (weekday + full date), device-local (not
  UTC-shifted)
- Discreet "Log another date" for backfilling a previous day
- Multiple tasks per day: add / edit / remove
- Fixed duration presets (1 Day / 1st Half / 2nd Half) instead of manual
  time entry, each mapped server-side to a real time window and a
  Jira-format duration string
- Client-side validation: required ticket, required duration selection
- One-tap **recent ticket chips** (last 6 tickets you saved, stored on
  the device) and a running **total in Jira notation** (e.g. `1d 5h`,
  days and hours kept separate since Jira's `1d` is 8h)
- Ticket IDs normalised to uppercase (`proj-123` → `PROJ-123`) so the
  same ticket never appears in two spellings
- App-like shell that reads as a phone app on mobile and a centred card
  on desktop; light theme only; inline SVG icons, no JS dependencies
- Google Sheet layout: `Date | Ticket | Start Time | Time Spent`, dates
  as `YYYY-MM-DD`, times as 12-hour AM/PM (e.g. `08:00 AM`), time spent
  in Jira's own format (`1d`, `5h`); one row per entry, kept in
  ascending date order
- Sheet formatting applied automatically on every save: bold header row,
  accent month heading, alternating row shading, borders, sensible
  column widths
- Month-section organization with `MONTH YYYY` headings and exactly 3
  blank rows between months, maintained authoritatively server-side
  (no duplicate headings, no blank rows inside a month, historical
  months inserted in correct order)
- Google Apps Script Web App: payload validation (never trusts the
  client), month-section writes, JSON success/failure responses
- Configuration via Script Properties (`SPREADSHEET_ID`, `SHEET_NAME`,
  `API_SECRET`) — nothing sensitive hard-coded in source
- Duplicate-submission protection: disabled Save button + "Saving…"
  state on the client; server-side `submissionId` dedup via
  `PropertiesService`, returning `duplicate: true` instead of a second
  row
- Offline-friendly: app shell cached by a service worker, unsent
  worklogs queued in `localStorage` and auto-synced on reconnect,
  "Offline — will save when back online" messaging, no silent data loss
- Installable PWA: `manifest.webmanifest`, service worker, home-screen
  icons (192px/512px), standalone display mode
- Responsive mobile layout, 360–430px, large touch targets, no
  horizontal scroll
- Editing before submission (ticket and duration are both editable
  until Save)
- Submission confirmation screen (date, entry count) with a "Done"
  button; no auto-navigation away
- Explicit error states: offline, server error, invalid payload,
  timeout, duplicate — all shown to the user, data never silently lost
  or falsely marked "saved"
- Basic accessibility: semantic HTML, `<label>`s on every input, visible
  focus outlines, `role="alert"`/`aria-live` on error and confirmation
  regions, descriptive button labels
- Draft autosave per date in `localStorage`, so closing the tab/app
  mid-entry doesn't lose in-progress (unsaved) work
- Google Apps Script README (create sheet, paste code, configure
  properties, deploy, authorize, test, redeploy, troubleshoot)
- Deployment README (GitHub Pages + Cloudflare Pages options, Android
  install & standalone verification)
- Manual testing checklist (`TESTING.md`)

### NOT BUILT (out of scope per the brief, section 30)

- User accounts / authentication / social login
- Traditional database
- Notifications, chat, subscriptions, ads, analytics tracking
- Calendar integration, AI chatbot, complex dashboard
- True secret-based backend authentication (not achievable in a
  frontend-only architecture — documented above and in the Apps Script
  README instead of falsely claimed)
- Manual/custom time entry — intentionally replaced by the three fixed
  duration presets to match the Jira workflow this data feeds into

### NEEDS MY ACTION

1. **Create the Google Sheet** and copy its Spreadsheet ID —
   [`google-apps-script/README.md`](./google-apps-script/README.md) §1.
2. **Paste `Code.gs` into the Apps Script editor** for that sheet — §2.
3. **Set Script Properties** (`SPREADSHEET_ID` required; `SHEET_NAME`,
   `API_SECRET` optional) — §3.
4. **Deploy as a Web App** (Execute as: Me, Access: Anyone) and
   authorize it — §4. Copy the resulting Web App URL.
5. **Paste that URL into `app.js`'s `CONFIG.APPS_SCRIPT_URL`** (and
   `CONFIG.API_SECRET` if you set one) — commit this change.
6. **Deploy the static site** to GitHub Pages or Cloudflare Pages —
   [`DEPLOYMENT.md`](./DEPLOYMENT.md).
7. **Open the deployed URL on Android Chrome** and **Add to Home
   screen**.
8. **Replace the generated icons** in `icons/` with your own artwork if
   you want something other than the placeholder clock icon (optional —
   the placeholders are fully functional).
9. **Run through `TESTING.md`** end-to-end, including one real save to
   confirm the sheet updates correctly, and one offline test.

## Configuration values you'll need to enter

| Where             | Value                                              |
|-------------------|-----------------------------------------------------|
| Script Properties | `SPREADSHEET_ID` — your sheet's ID                  |
| Script Properties | `SHEET_NAME` — optional, defaults to `Worklog`      |
| Script Properties | `API_SECRET` — optional                             |
| `app.js`          | `CONFIG.APPS_SCRIPT_URL` — your deployed Web App URL |
| `app.js`          | `CONFIG.API_SECRET` — only if you set one above      |

## URLs you'll need to copy

- The **Spreadsheet ID** from your Google Sheet's URL (step 1 above).
- The **Apps Script Web App URL** after deployment (step 4 above) —
  goes into `app.js`.
- The **deployed site's HTTPS URL** (GitHub Pages / Cloudflare Pages) —
  this is what you open on your phone to install the app.
