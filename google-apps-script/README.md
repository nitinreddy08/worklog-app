# Google Apps Script backend setup

This is the one-time setup that turns a Google Sheet into the storage
backend for the Worklog PWA. You only need to do this once.

## 1. Create the Google Sheet

1. Go to [sheets.google.com](https://sheets.google.com) and create a new
   blank spreadsheet.
2. Name it whatever you like, e.g. **"Worklog"**.
3. Rename the first tab (bottom-left) to **`Worklog`** (this is the
   `SHEET_NAME` the script expects by default — you can use a different
   name as long as you set `SHEET_NAME` in step 4 to match).
4. Leave the sheet otherwise empty. The script creates all headings and
   columns itself.
5. Copy the **Spreadsheet ID** from the URL:

   ```
   https://docs.google.com/spreadsheets/d/PASTE_THIS_PART_IS_THE_ID/edit
   ```

## 2. Open the Apps Script editor

1. In the spreadsheet, go to **Extensions → Apps Script**.
2. Delete any placeholder code in the editor.
3. Copy the entire contents of [`Code.gs`](./Code.gs) from this folder
   and paste it into the script editor.
4. Click the save icon (or `Ctrl+S` / `Cmd+S`).
5. Rename the project (top-left, e.g. "Worklog Backend") if you like —
   optional.

## 3. Configure Script Properties

Prefer Script Properties over editing the spreadsheet ID directly into
the script. (If this step is skipped or mistyped, `Code.gs` falls back
to the `DEFAULT_SPREADSHEET_ID` constant near the top of the file — set
that instead if you'd rather not use Script Properties at all.)

1. In the Apps Script editor, click the gear icon **Project Settings** on
   the left sidebar.
2. Scroll to **Script Properties** and click **Add script property**.
3. Add:

   | Property         | Value                                    |
   |------------------|-------------------------------------------|
   | `SPREADSHEET_ID` | the ID you copied in step 1.5              |
   | `SHEET_NAME`     | `Worklog` (or your tab's name, optional)   |
   | `API_SECRET`     | *(optional)* any random string, see below  |

`SHEET_NAME` and `API_SECRET` are optional — if omitted, the sheet name
defaults to `Worklog` and no secret is required.

### About `API_SECRET` (read this)

Because the PWA is a static site with no server of its own, if you set an
`API_SECRET` here the PWA has to embed the same value in its own
JavaScript to send it along with each request. **Anyone who opens your
site's source code can read that value** — so this is *not* real
authentication, it is only a filter against random bots stumbling onto
your Web App URL and posting garbage. If that's an acceptable trade-off
for a personal tool, set it and put the same string in `app.js`'s
`CONFIG` (see the main [README](../README.md)). If you'd rather not
bother, leave `API_SECRET` blank — the endpoint is still an obscure,
unguessable URL, which is the practical protection this simple
architecture can offer for free.

## 4. Deploy as a Web App

1. Click **Deploy → New deployment**.
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Fill in:
   - **Description**: e.g. "Worklog v1"
   - **Execute as**: **Me** (your Google account)
   - **Who has access**: **Anyone** — this is required so the PWA (an
     anonymous client) can call it. This does not give access to your
     Google Drive/Sheets in general, only to what this script chooses to
     expose.
4. Click **Deploy**.
5. The first time, Google will ask you to **authorize** the script:
   - Click **Authorize access**.
   - Choose your Google account.
   - You'll see an "unverified app" warning — this is normal for a
     script you wrote yourself. Click **Advanced → Go to (project
     name) (unsafe)**, then **Allow**.
6. After deployment, copy the **Web app URL** shown (it looks like
   `https://script.google.com/macros/s/XXXXXXXX/exec`).

## 5. Configure the PWA with the Web App URL

Open `app.js` in the project root and set:

```js
const CONFIG = {
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/XXXXXXXX/exec",
  ...
};
```

If you set an `API_SECRET` above, also add it to the payload — see the
`apiSecret` note in the main README's configuration section.

## 6. Test the backend directly

Before testing from the phone, verify the endpoint works on its own:

**Health check (GET):** open the Web App URL in any browser. You should
see:

```json
{"status":"ok","message":"Worklog Apps Script endpoint is running."}
```

**Save test (POST):** run this from a terminal (replace the URL), or use
any HTTP client:

```bash
curl -X POST "https://script.google.com/macros/s/XXXXXXXX/exec" \
  -H "Content-Type: text/plain;charset=utf-8" \
  -d '{
    "submissionId": "test-1",
    "date": "2026-09-04",
    "entries": [
      { "ticket": "PROJ-123", "startTime": "09:00", "endTime": "10:00" }
    ]
  }'
```

Expected response:

```json
{"success":true,"message":"Worklog saved successfully","rowsAdded":1}
```

Open the spreadsheet — you should see a `SEPTEMBER 2026` heading, a
header row, and one data row. Re-running the exact same `curl` command
(same `submissionId`) should return `"duplicate": true` and **not** add
a second row.

## 7. Redeploying after changes

If you edit `Code.gs` later:

1. Paste the updated code into the Apps Script editor and save.
2. Click **Deploy → Manage deployments**.
3. Click the pencil (edit) icon on your existing deployment.
4. Under **Version**, choose **New version**.
5. Click **Deploy**.

This keeps the **same Web App URL**, so you don't need to update the PWA
config again. (Creating a brand-new deployment instead of editing the
existing one would give you a different URL — avoid that unless you
intend to change it.)

## Troubleshooting

- **"Script function not found: doPost"** — make sure you pasted the
  full `Code.gs` content and saved before deploying.
- **CORS / network error from the browser, but `curl` works** — make
  sure the PWA's fetch call uses `Content-Type: text/plain;charset=utf-8`
  (already set in `app.js`). Apps Script Web Apps don't handle CORS
  preflight (`OPTIONS`) requests, and a `Content-Type: application/json`
  header triggers a preflight that will fail. `text/plain` avoids the
  preflight; the script still parses the body as JSON.
- **"Exception: SPREADSHEET_ID is not configured"** — you deployed
  before setting Script Properties, or the deployment is running an old
  version. Set the property and redeploy (see step 7).
- **Response says `{"success":false,"message":"Unauthorized."}`** — you
  set `API_SECRET` in Script Properties but the PWA isn't sending a
  matching `apiSecret` field, or it doesn't match exactly.
- **Rows appear in the wrong place / duplicate month headings** — this
  should not happen; if it does, check that you haven't manually edited
  the sheet's month heading text (it must exactly match `MONTH YYYY` in
  capitals, e.g. `SEPTEMBER 2026`) or removed the required 3 blank rows
  between month sections, since the script uses these to detect section
  boundaries.
- **Authorization prompt reappears after every edit** — this is normal
  Apps Script behavior the first time new permissions are needed (e.g.
  after adding spreadsheet access). Re-authorize once; it won't ask
  again for the same scope.
