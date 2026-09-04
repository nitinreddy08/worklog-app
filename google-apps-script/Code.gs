/**
 * Worklog PWA backend.
 *
 * Stores worklog entries in a Google Sheet organised into calendar-month
 * sections. Each row is exactly one Jira "Log work" entry — a ticket, the
 * date and time it started, and the time spent in Jira's own format — so
 * the month-end CSV export can be fed straight into Jira:
 *
 *   SEPTEMBER 2026
 *   Date       | Ticket   | Start Time | Time Spent
 *   2026-09-02 | PROJ-7   | 08:00 AM   | 1d
 *   2026-09-04 | PROJ-123 | 08:00 AM   | 5h
 *   2026-09-04 | PROJ-123 | 02:00 PM   | 5h
 *   ...
 *   (3 blank rows)
 *   OCTOBER 2026
 *   Date       | Ticket   | Start Time | Time Spent
 *   ...
 *
 * Rows within a month are kept in ascending (date, start time) order.
 * Every cell we write is forced to plain-text format, because Sheets
 * otherwise silently turns "SEPTEMBER 2026" into a date (which breaks
 * section detection) and dates/times into locale-formatted values.
 *
 * API (all responses are JSON):
 *
 *   GET  ?action=list&page=1&pageSize=5[&key=API_SECRET]
 *        -> one page of entries, newest first, with paging flags.
 *
 *   POST { entries:[{ticket, duration}], date, submissionId[, apiSecret] }
 *        -> create (the PWA's Save). duration is a preset key.
 *
 *   POST { action:"update", target:{row,date,ticket,start,spent},
 *          changes:{date,ticket,start,spent}[, apiSecret] }
 *        -> edit one entry. The row is re-inserted in sorted position.
 *
 *   POST { action:"merge", targets:[{row,date,ticket,start,spent}, ...] }
 *        -> combine 2+ entries of the SAME ticket into one: earliest
 *           date/start kept, time spent summed in Jira notation.
 *
 *   POST { action:"delete", target:{row,date,ticket,start,spent} }
 *
 * A target is addressed by its sheet row number PLUS its current values;
 * the script re-reads the row and refuses (code "stale") if the values no
 * longer match, so a row that shifted is never edited by mistake. This
 * avoids adding an ID column to the sheet.
 *
 * Configuration comes from Script Properties (SPREADSHEET_ID, optional
 * SHEET_NAME and API_SECRET), falling back to DEFAULT_SPREADSHEET_ID.
 * See README.md in this folder.
 */

var DEFAULT_SPREADSHEET_ID = "1004yO9edlMlXGR5owYCGcdVfFYR3h33GokAVEUnlSfs";

var HEADER_ROW = ["Date", "Ticket", "Start Time", "Time Spent"];
var NUM_COLUMNS = HEADER_ROW.length;
var COL_DATE = 0;
var COL_TICKET = 1;
var COL_START = 2;
var COL_SPENT = 3;

var MONTH_NAMES = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"
];

var BLANK_ROWS_BETWEEN_MONTHS = 3;
var MAX_TRACKED_SUBMISSION_IDS = 300;
var DEFAULT_PAGE_SIZE = 5;
var MAX_PAGE_SIZE = 50;

// The three fixed choices offered in the app. "start" is when the block
// begins (24h); "timeSpent" is written verbatim in Jira's duration format.
// Jira treats 1d as 8h by default — deliberately left alone; half days
// are logged as 5h.
var DURATION_PRESETS = {
  "1d":       { start: "08:00", timeSpent: "1d" },
  "1st-half": { start: "08:00", timeSpent: "5h" },
  "2nd-half": { start: "14:00", timeSpent: "5h" },
};

// Cosmetic formatting applied automatically to every month section.
var HEADER_BG_COLOR = "#37474F";
var HEADER_FONT_COLOR = "#FFFFFF";
var MONTH_HEADING_BG_COLOR = "#E8EAF6";
var ALT_ROW_BG_COLOR = "#F5F5F5";
var BORDER_COLOR = "#D9D9D9";
var COLUMN_WIDTHS = [110, 150, 110, 100]; // Date, Ticket, Start Time, Time Spent

// Set when the spreadsheet is opened; used to read back any legacy cells
// that Sheets already auto-converted into Date values.
var SHEET_TZ = "Asia/Kolkata";

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    if (params.action !== "list") {
      return jsonResponse_({ status: "ok", message: "Worklog Apps Script endpoint is running." });
    }
    var config = getConfig_();
    if (config.apiSecret && params.key !== config.apiSecret) {
      return jsonResponse_({ success: false, message: "Unauthorized." });
    }
    var sheet = getSheet_(config);
    return jsonResponse_(listEntries_(sheet, Number(params.page) || 1, Number(params.pageSize) || DEFAULT_PAGE_SIZE));
  } catch (err) {
    return jsonResponse_({ success: false, message: "Server error: " + err.message });
  }
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse_({ success: false, message: "Missing request body." });
    }

    var payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return jsonResponse_({ success: false, message: "Request body is not valid JSON." });
    }

    var config = getConfig_();
    if (config.apiSecret) {
      if (!payload.apiSecret || payload.apiSecret !== config.apiSecret) {
        return jsonResponse_({ success: false, message: "Unauthorized." });
      }
    }

    var action = payload.action || "create";
    if (action === "create") return handleCreate_(config, payload);
    if (action === "update") return handleUpdate_(config, payload);
    if (action === "merge") return handleMerge_(config, payload);
    if (action === "delete") return handleDelete_(config, payload);
    return jsonResponse_({ success: false, message: "Unknown action: " + action });
  } catch (err) {
    return jsonResponse_({ success: false, message: "Server error: " + err.message });
  }
}

/* ------------------------------------------------------------------ */
/* Action handlers                                                     */
/* ------------------------------------------------------------------ */

function handleCreate_(config, payload) {
  var validation = validateCreatePayload_(payload);
  if (!validation.valid) {
    return jsonResponse_({ success: false, message: validation.message });
  }

  if (payload.submissionId && isDuplicateSubmission_(payload.submissionId)) {
    return jsonResponse_({ success: true, duplicate: true, message: "This worklog was already saved." });
  }

  var sheet = getSheet_(config);
  var entries = payload.entries.map(function (entry) {
    var preset = DURATION_PRESETS[entry.duration];
    return {
      dateIso: payload.date,
      ticket: normalizeTicket_(entry.ticket),
      startMinutes: timeToMinutes_(preset.start),
      timeSpent: preset.timeSpent,
    };
  });
  entries.forEach(function (entry) { insertEntry_(sheet, entry); });

  if (payload.submissionId) {
    recordSubmission_(payload.submissionId);
  }

  return jsonResponse_({ success: true, message: "Worklog saved successfully", rowsAdded: entries.length });
}

function handleUpdate_(config, payload) {
  var changes = payload.changes || {};
  var entry = {
    dateIso: String(changes.date || ""),
    ticket: normalizeTicket_(changes.ticket),
    startMinutes: parseStartMinutes_(changes.start),
    timeSpent: normalizeDuration_(changes.spent),
  };
  var problem = validateEntry_(entry, changes.start, changes.spent);
  if (problem) return jsonResponse_({ success: false, message: problem });

  var sheet = getSheet_(config);
  var located = locateTarget_(sheet, payload.target);
  if (!located.ok) return jsonResponse_(located.error);

  deleteDataRow_(sheet, located.rowNumber);
  var newRow = insertEntry_(sheet, entry);
  return jsonResponse_({ success: true, message: "Entry updated", row: newRow });
}

function handleMerge_(config, payload) {
  var targets = payload.targets;
  if (!Array.isArray(targets) || targets.length < 2) {
    return jsonResponse_({ success: false, message: "Select at least two entries to merge." });
  }

  var sheet = getSheet_(config);
  var located = [];
  var seenRows = {};
  for (var i = 0; i < targets.length; i++) {
    var result = locateTarget_(sheet, targets[i]);
    if (!result.ok) return jsonResponse_(result.error);
    // The same row listed twice would otherwise be deleted twice, taking
    // an unrelated row with it.
    if (seenRows[result.rowNumber]) continue;
    seenRows[result.rowNumber] = true;
    located.push(result);
  }
  if (located.length < 2) {
    return jsonResponse_({ success: false, message: "Select at least two different entries to merge." });
  }

  var ticket = located[0].values.ticket;
  for (var j = 1; j < located.length; j++) {
    if (located[j].values.ticket !== ticket) {
      return jsonResponse_({ success: false, code: "different-tickets", message: "Only entries for the same ticket can be merged." });
    }
  }

  // Keep the earliest date/start; add up every time spent. Refuse rather
  // than silently drop a duration we can't read (e.g. a legacy "1:00").
  var earliest = located[0].values;
  var total = emptyDuration_();
  for (var k = 0; k < located.length; k++) {
    var item = located[k];
    var parsed = parseDuration_(item.values.timeSpent);
    if (!parsed) {
      return jsonResponse_({ success: false, message: "Entry on " + item.values.dateIso + " has time spent \"" + item.values.timeSpent + "\", which isn't in Jira format. Edit it first, then merge." });
    }
    if (sortKey_(item.values.dateKey, item.values.startMinutes) < sortKey_(earliest.dateKey, earliest.startMinutes)) {
      earliest = item.values;
    }
    addDuration_(total, parsed);
  }

  // Delete bottom-up so earlier row numbers stay valid.
  located.sort(function (a, b) { return b.rowNumber - a.rowNumber; });
  located.forEach(function (item) { deleteDataRow_(sheet, item.rowNumber); });

  var merged = {
    dateIso: earliest.dateIso,
    ticket: ticket,
    startMinutes: earliest.startMinutes,
    timeSpent: formatDuration_(total),
  };
  var newRow = insertEntry_(sheet, merged);
  return jsonResponse_({ success: true, message: "Entries merged", row: newRow, timeSpent: merged.timeSpent });
}

function handleDelete_(config, payload) {
  var sheet = getSheet_(config);
  var located = locateTarget_(sheet, payload.target);
  if (!located.ok) return jsonResponse_(located.error);
  deleteDataRow_(sheet, located.rowNumber);
  return jsonResponse_({ success: true, message: "Entry deleted" });
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

function getConfig_() {
  var props = PropertiesService.getScriptProperties();
  var spreadsheetId = props.getProperty("SPREADSHEET_ID") || DEFAULT_SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error("SPREADSHEET_ID is not configured. Set it in Script Properties, or set DEFAULT_SPREADSHEET_ID at the top of Code.gs.");
  }
  return {
    spreadsheetId: spreadsheetId,
    sheetName: props.getProperty("SHEET_NAME") || "Worklog",
    apiSecret: props.getProperty("API_SECRET") || "",
  };
}

function getSheet_(config) {
  var ss = SpreadsheetApp.openById(config.spreadsheetId);
  SHEET_TZ = ss.getSpreadsheetTimeZone() || SHEET_TZ;
  var sheet = ss.getSheetByName(config.sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(config.sheetName);
    applyColumnWidths_(sheet);
  }
  return sheet;
}

/* ------------------------------------------------------------------ */
/* Validation                                                           */
/* ------------------------------------------------------------------ */

function validateCreatePayload_(payload) {
  if (!payload || typeof payload !== "object") {
    return { valid: false, message: "Invalid payload." };
  }
  if (!isIsoDate_(payload.date)) {
    return { valid: false, message: "A valid date (YYYY-MM-DD) is required." };
  }
  if (!Array.isArray(payload.entries) || payload.entries.length === 0) {
    return { valid: false, message: "At least one worklog entry is required." };
  }
  for (var i = 0; i < payload.entries.length; i++) {
    var entry = payload.entries[i];
    var label = "Entry " + (i + 1);
    if (!entry || typeof entry !== "object") {
      return { valid: false, message: label + " is invalid." };
    }
    if (!normalizeTicket_(entry.ticket)) {
      return { valid: false, message: label + ": ticket is required." };
    }
    if (!DURATION_PRESETS[entry.duration]) {
      return { valid: false, message: label + ": duration must be one of 1d, 1st-half, 2nd-half." };
    }
  }
  return { valid: true };
}

// Validates a fully-specified entry (used by update). Returns a message
// or null.
function validateEntry_(entry, rawStart, rawSpent) {
  if (!isIsoDate_(entry.dateIso)) return "A valid date (YYYY-MM-DD) is required.";
  if (!entry.ticket) return "Ticket is required.";
  if (parseStartMinutes_(rawStart) === null) return "Start time must look like 08:00 AM or 14:00.";
  if (!entry.timeSpent) return "Time spent must be in Jira format, e.g. 1d, 5h, 1d 5h, 30m.";
  return null;
}

function isIsoDate_(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeTicket_(value) {
  return String(value === null || value === undefined ? "" : value).trim().toUpperCase();
}

/* ------------------------------------------------------------------ */
/* Duplicate submission protection (create only)                       */
/* ------------------------------------------------------------------ */

function isDuplicateSubmission_(submissionId) {
  return getTrackedSubmissionIds_().indexOf(submissionId) !== -1;
}

function recordSubmission_(submissionId) {
  var ids = getTrackedSubmissionIds_();
  ids.push(submissionId);
  if (ids.length > MAX_TRACKED_SUBMISSION_IDS) {
    ids = ids.slice(ids.length - MAX_TRACKED_SUBMISSION_IDS);
  }
  PropertiesService.getScriptProperties().setProperty("PROCESSED_SUBMISSION_IDS", JSON.stringify(ids));
}

function getTrackedSubmissionIds_() {
  var raw = PropertiesService.getScriptProperties().getProperty("PROCESSED_SUBMISSION_IDS");
  if (!raw) return [];
  try {
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Jira durations ("1d 5h")                                            */
/* ------------------------------------------------------------------ */

var DURATION_UNITS = ["w", "d", "h", "m"];

function emptyDuration_() {
  return { w: 0, d: 0, h: 0, m: 0 };
}

// "1d 5h" -> {w:0,d:1,h:5,m:0}; null if not a valid Jira duration.
function parseDuration_(text) {
  var s = String(text === null || text === undefined ? "" : text).trim().toLowerCase();
  if (!s) return null;
  var total = emptyDuration_();
  var re = /(\d+)\s*([wdhm])/g;
  var consumed = 0;
  var match;
  while ((match = re.exec(s)) !== null) {
    total[match[2]] += Number(match[1]);
    consumed += match[0].length;
  }
  if (consumed === 0) return null;
  if (s.replace(/(\d+)\s*([wdhm])/g, "").replace(/\s+/g, "") !== "") return null;
  return total;
}

function addDuration_(into, other) {
  if (!other) return into;
  DURATION_UNITS.forEach(function (u) { into[u] += other[u]; });
  return into;
}

// Units are kept separate on purpose: Jira's 1d is 8h, so hours are never
// folded into days here — "5h" + "5h" is "10h", not "1d 2h".
function formatDuration_(d) {
  var parts = [];
  DURATION_UNITS.forEach(function (u) { if (d[u]) parts.push(d[u] + u); });
  return parts.length ? parts.join(" ") : "0m";
}

// Canonical spelling of a user-typed duration, or "" if invalid.
function normalizeDuration_(text) {
  var parsed = parseDuration_(text);
  return parsed ? formatDuration_(parsed) : "";
}

/* ------------------------------------------------------------------ */
/* Reading the sheet                                                    */
/* ------------------------------------------------------------------ */

function isDateValue_(value) {
  return Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime());
}

// A month heading is a row with something in column A and nothing in
// column B: either our plain-text "SEPTEMBER 2026" or, on a sheet Sheets
// already tampered with, a Date value it auto-converted the text into.
function parseMonthHeading_(cellA, cellB) {
  if (cellB !== "" && cellB !== null && cellB !== undefined) return null;
  if (isDateValue_(cellA)) {
    return {
      year: Number(Utilities.formatDate(cellA, SHEET_TZ, "yyyy")),
      month: Number(Utilities.formatDate(cellA, SHEET_TZ, "M")),
    };
  }
  var text = String(cellA === null || cellA === undefined ? "" : cellA).trim();
  var match = text.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (!match) return null;
  var monthIndex = MONTH_NAMES.indexOf(match[1].toUpperCase());
  if (monthIndex === -1) return null;
  return { year: Number(match[2]), month: monthIndex + 1 };
}

// Every month section in sheet order: heading row, header row, and the
// contiguous data block beneath (dataEndRow < dataStartRow = no data).
function findMonthSections_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow === 0) return [];

  var values = sheet.getRange(1, 1, lastRow, 2).getValues();
  var sections = [];

  for (var r = 0; r < values.length; r++) {
    var ym = parseMonthHeading_(values[r][0], values[r][1]);
    if (!ym) continue;

    var headingRow = r + 1;
    var dataStartRow = headingRow + 2;
    var dataEndRow = dataStartRow - 1;
    for (var d = dataStartRow; d <= lastRow; d++) {
      var row = values[d - 1];
      if (row[0] === "" || row[0] === null) break;
      if (parseMonthHeading_(row[0], row[1])) break;
      dataEndRow = d;
    }

    sections.push({
      year: ym.year,
      month: ym.month,
      headingRow: headingRow,
      headerRow: headingRow + 1,
      dataStartRow: dataStartRow,
      dataEndRow: dataEndRow,
    });
  }

  return sections;
}

function decideInsertion_(sections, year, month) {
  var targetKey = year * 12 + month;
  for (var i = 0; i < sections.length; i++) {
    if (sections[i].year === year && sections[i].month === month) {
      return { mode: "match", section: sections[i] };
    }
  }
  for (var j = 0; j < sections.length; j++) {
    if (sections[j].year * 12 + sections[j].month > targetKey) {
      return { mode: "before", section: sections[j] };
    }
  }
  return { mode: "append-end", section: sections.length ? sections[sections.length - 1] : null };
}

// yyyyMMdd number from "yyyy-MM-dd", legacy "dd-MM-yyyy", or a Date value.
function parseDateKey_(cell) {
  if (isDateValue_(cell)) {
    return Number(Utilities.formatDate(cell, SHEET_TZ, "yyyyMMdd"));
  }
  var text = String(cell === null || cell === undefined ? "" : cell).trim();
  var iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return Number(iso[1] + iso[2] + iso[3]);
  var legacy = text.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (legacy) return Number(legacy[3] + legacy[2] + legacy[1]);
  return null;
}

function dateKeyToIso_(key) {
  var s = String(key);
  return s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8);
}

// Minutes since midnight from "08:00 AM", "14:00", or a Date/time value;
// null if unparseable.
function parseStartMinutes_(cell) {
  if (isDateValue_(cell)) {
    var parts = Utilities.formatDate(cell, SHEET_TZ, "HH:mm").split(":");
    return Number(parts[0]) * 60 + Number(parts[1]);
  }
  var text = String(cell === null || cell === undefined ? "" : cell).trim();
  var twelve = text.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (twelve) {
    var h = Number(twelve[1]) % 12;
    if (twelve[3].toUpperCase() === "PM") h += 12;
    return h * 60 + Number(twelve[2]);
  }
  var twentyFour = text.match(/^(\d{1,2}):(\d{2})$/);
  if (twentyFour && Number(twentyFour[1]) < 24 && Number(twentyFour[2]) < 60) {
    return Number(twentyFour[1]) * 60 + Number(twentyFour[2]);
  }
  return null;
}

function sortKey_(dateKey, startMinutes) {
  return (dateKey || 0) * 10000 + (startMinutes || 0);
}

// Normalised view of one data row's cells.
function readRowValues_(cells) {
  var dateKey = parseDateKey_(cells[COL_DATE]);
  var startMinutes = parseStartMinutes_(cells[COL_START]);
  return {
    dateKey: dateKey,
    dateIso: dateKey ? dateKeyToIso_(dateKey) : String(cells[COL_DATE]),
    ticket: normalizeTicket_(cells[COL_TICKET]),
    startMinutes: startMinutes === null ? 0 : startMinutes,
    startText: startMinutes === null ? String(cells[COL_START]) : formatTime12_(minutesToHHMM_(startMinutes)),
    timeSpent: normalizeDuration_(cells[COL_SPENT]) || String(cells[COL_SPENT]).trim(),
  };
}

// All data rows across all sections, each with its sheet row number.
function readAllEntries_(sheet) {
  var sections = findMonthSections_(sheet);
  var entries = [];
  sections.forEach(function (section) {
    var count = section.dataEndRow - section.dataStartRow + 1;
    if (count <= 0) return;
    var values = sheet.getRange(section.dataStartRow, 1, count, NUM_COLUMNS).getValues();
    for (var i = 0; i < values.length; i++) {
      var v = readRowValues_(values[i]);
      v.rowNumber = section.dataStartRow + i;
      entries.push(v);
    }
  });
  return entries;
}

function listEntries_(sheet, page, pageSize) {
  pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, pageSize));
  page = Math.max(1, page);

  var entries = readAllEntries_(sheet);
  // Newest first; ties broken by sheet position (later row = newer).
  entries.sort(function (a, b) {
    var diff = sortKey_(b.dateKey, b.startMinutes) - sortKey_(a.dateKey, a.startMinutes);
    return diff !== 0 ? diff : b.rowNumber - a.rowNumber;
  });

  var total = entries.length;
  var start = (page - 1) * pageSize;
  var slice = entries.slice(start, start + pageSize).map(function (v) {
    return { row: v.rowNumber, date: v.dateIso, ticket: v.ticket, start: v.startText, spent: v.timeSpent };
  });

  return {
    success: true,
    page: page,
    pageSize: pageSize,
    total: total,
    hasNewer: page > 1,
    hasOlder: start + pageSize < total,
    rows: slice,
  };
}

// Finds the target row and confirms it still holds the values the client
// saw. Returns { ok, rowNumber, values } or { ok:false, error }.
function locateTarget_(sheet, target) {
  if (!target || typeof target !== "object") {
    return { ok: false, error: { success: false, message: "Missing target entry." } };
  }
  var rowNumber = Number(target.row);
  var stale = { ok: false, error: { success: false, code: "stale", message: "That entry changed in the sheet. Refresh and try again." } };
  if (!rowNumber || rowNumber < 1 || rowNumber > sheet.getLastRow()) return stale;

  var cells = sheet.getRange(rowNumber, 1, 1, NUM_COLUMNS).getValues()[0];
  var values = readRowValues_(cells);
  var expected = {
    dateKey: parseDateKey_(target.date),
    ticket: normalizeTicket_(target.ticket),
    startMinutes: parseStartMinutes_(target.start),
    timeSpent: normalizeDuration_(target.spent) || String(target.spent || "").trim(),
  };
  if (values.dateKey !== expected.dateKey) return stale;
  if (values.ticket !== expected.ticket) return stale;
  if (values.startMinutes !== (expected.startMinutes === null ? 0 : expected.startMinutes)) return stale;
  if (values.timeSpent !== expected.timeSpent) return stale;

  return { ok: true, rowNumber: rowNumber, values: values };
}

/* ------------------------------------------------------------------ */
/* Writing                                                              */
/* ------------------------------------------------------------------ */

// Inserts one entry into its month section, in ascending (date, start)
// order, creating the section if needed. Returns the new row number.
function insertEntry_(sheet, entry) {
  var dateParts = entry.dateIso.split("-");
  var year = Number(dateParts[0]);
  var month = Number(dateParts[1]);
  var dateKey = Number(dateParts[0] + dateParts[1] + dateParts[2]);
  var key = sortKey_(dateKey, entry.startMinutes);
  var values = [entry.dateIso, entry.ticket, formatTime12_(minutesToHHMM_(entry.startMinutes)), entry.timeSpent];
  var monthLabel = MONTH_NAMES[month - 1] + " " + year;

  var sections = findMonthSections_(sheet);
  var decision = decideInsertion_(sections, year, month);

  if (decision.mode === "match") {
    var section = decision.section;
    refreshSectionChrome_(sheet, section);

    var insertAt = section.dataEndRow + 1;
    var count = section.dataEndRow - section.dataStartRow + 1;
    if (count > 0) {
      var existing = sheet.getRange(section.dataStartRow, 1, count, NUM_COLUMNS).getValues();
      for (var i = 0; i < existing.length; i++) {
        var v = readRowValues_(existing[i]);
        if (sortKey_(v.dateKey, v.startMinutes) > key) {
          insertAt = section.dataStartRow + i;
          break;
        }
      }
    }
    insertRowAt_(sheet, insertAt, values);
    styleDataRows_(sheet, section.dataStartRow, count + 1);
    return insertAt;
  }

  if (decision.mode === "before") {
    var beforeRow = decision.section.headingRow;
    sheet.insertRowsBefore(beforeRow, 2 + 1 + BLANK_ROWS_BETWEEN_MONTHS);
    writeMonthBlock_(sheet, beforeRow, monthLabel, [values]);
    return beforeRow + 2;
  }

  var startRow = decision.section
    ? decision.section.dataEndRow + 1 + BLANK_ROWS_BETWEEN_MONTHS
    : 1;
  writeMonthBlock_(sheet, startRow, monthLabel, [values]);
  return startRow + 2;
}

// Deletes one data row, then removes its month section entirely if that
// left the section with no data rows.
function deleteDataRow_(sheet, rowNumber) {
  // Remember which month this row belonged to so its alternating shading
  // can be re-applied once the row is gone.
  var owner = null;
  findMonthSections_(sheet).forEach(function (s) {
    if (rowNumber >= s.dataStartRow && rowNumber <= s.dataEndRow) owner = { year: s.year, month: s.month };
  });

  sheet.deleteRow(rowNumber);
  removeEmptySections_(sheet);

  if (owner) {
    findMonthSections_(sheet).forEach(function (s) {
      if (s.year === owner.year && s.month === owner.month && s.dataEndRow >= s.dataStartRow) {
        styleDataRows_(sheet, s.dataStartRow, s.dataEndRow - s.dataStartRow + 1);
      }
    });
  }
}

function removeEmptySections_(sheet) {
  var sections = findMonthSections_(sheet);
  // Bottom-up so earlier row numbers stay valid while deleting.
  for (var i = sections.length - 1; i >= 0; i--) {
    var section = sections[i];
    if (section.dataEndRow >= section.dataStartRow) continue;

    var from = section.headingRow;
    var to = section.headerRow;
    if (i > 0) {
      // Take the separator blanks above the heading with it.
      from = Math.max(sections[i - 1].dataEndRow + 1, section.headingRow - BLANK_ROWS_BETWEEN_MONTHS);
    } else if (sections.length > 1) {
      // First section: take the separator blanks below the header instead.
      to = Math.min(sections[1].headingRow - 1, section.headerRow + BLANK_ROWS_BETWEEN_MONTHS);
    }
    sheet.deleteRows(from, to - from + 1);
  }
}

// Inserts a single data row at exactly rowNumber, shifting anything below
// it down. When rowNumber is past the last used row there is nothing to
// shift, so the row is simply written in place.
function insertRowAt_(sheet, rowNumber, values) {
  if (rowNumber <= sheet.getLastRow()) {
    sheet.insertRowsBefore(rowNumber, 1);
  }
  var range = sheet.getRange(rowNumber, 1, 1, NUM_COLUMNS);
  range.setNumberFormat("@");
  range.setValues([values]);
}

function writeMonthBlock_(sheet, startRow, monthLabel, dataRows) {
  var heading = sheet.getRange(startRow, 1, 1, NUM_COLUMNS);
  heading.setNumberFormat("@");
  heading.merge();
  sheet.getRange(startRow, 1).setValue(monthLabel);
  styleMonthHeading_(sheet, startRow);

  var header = sheet.getRange(startRow + 1, 1, 1, NUM_COLUMNS);
  header.setNumberFormat("@");
  header.setValues([HEADER_ROW]);
  styleHeaderRow_(sheet, startRow + 1);

  if (dataRows.length) {
    var data = sheet.getRange(startRow + 2, 1, dataRows.length, NUM_COLUMNS);
    data.setNumberFormat("@");
    data.setValues(dataRows);
    styleDataRows_(sheet, startRow + 2, dataRows.length);
  }
}

// Repairs a section's heading and header if they've drifted: a heading
// Sheets auto-converted to a date goes back to plain "SEPTEMBER 2026"
// text, and a header row from an older column layout is rewritten.
function refreshSectionChrome_(sheet, section) {
  var label = MONTH_NAMES[section.month - 1] + " " + section.year;
  var headingCell = sheet.getRange(section.headingRow, 1);
  if (String(headingCell.getValue()) !== label) {
    headingCell.setNumberFormat("@");
    headingCell.setValue(label);
    styleMonthHeading_(sheet, section.headingRow);
  }

  var header = sheet.getRange(section.headerRow, 1, 1, NUM_COLUMNS);
  var current = header.getValues()[0];
  var matches = current.every(function (cell, i) { return String(cell).trim() === HEADER_ROW[i]; });
  if (!matches) {
    header.setNumberFormat("@");
    header.setValues([HEADER_ROW]);
    styleHeaderRow_(sheet, section.headerRow);
  }
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                   */
/* ------------------------------------------------------------------ */

function pad2_(n) {
  return (n < 10 ? "0" : "") + n;
}

function timeToMinutes_(hhmm) {
  var parts = hhmm.split(":");
  return Number(parts[0]) * 60 + Number(parts[1]);
}

function minutesToHHMM_(totalMinutes) {
  return pad2_(Math.floor(totalMinutes / 60)) + ":" + pad2_(totalMinutes % 60);
}

// "14:00" -> "02:00 PM"
function formatTime12_(hhmm) {
  var parts = hhmm.split(":");
  var h = Number(parts[0]);
  var period = h >= 12 ? "PM" : "AM";
  var h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return pad2_(h12) + ":" + parts[1] + " " + period;
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ */
/* Cosmetic styling                                                     */
/* ------------------------------------------------------------------ */

function applyColumnWidths_(sheet) {
  for (var c = 0; c < COLUMN_WIDTHS.length; c++) {
    sheet.setColumnWidth(c + 1, COLUMN_WIDTHS[c]);
  }
}

function styleMonthHeading_(sheet, row) {
  sheet.getRange(row, 1, 1, NUM_COLUMNS)
    .setBackground(MONTH_HEADING_BG_COLOR)
    .setFontWeight("bold")
    .setFontSize(13)
    .setHorizontalAlignment("left")
    .setVerticalAlignment("middle");
  sheet.setRowHeight(row, 28);
}

function styleHeaderRow_(sheet, row) {
  sheet.getRange(row, 1, 1, NUM_COLUMNS)
    .setBackground(HEADER_BG_COLOR)
    .setFontColor(HEADER_FONT_COLOR)
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setBorder(true, true, true, true, true, false, BORDER_COLOR, SpreadsheetApp.BorderStyle.SOLID);
}

// Styles a block of data rows in a handful of batched calls rather than
// several per row — a month of entries restyles in well under a second.
function styleDataRows_(sheet, startRow, count) {
  if (count <= 0) return;
  var backgrounds = [];
  for (var i = 0; i < count; i++) {
    var bg = i % 2 === 0 ? "#FFFFFF" : ALT_ROW_BG_COLOR;
    var row = [];
    for (var c = 0; c < NUM_COLUMNS; c++) row.push(bg);
    backgrounds.push(row);
  }
  sheet.getRange(startRow, 1, count, NUM_COLUMNS)
    .setBackgrounds(backgrounds)
    .setFontWeight("normal")
    .setFontColor("#000000")
    .setHorizontalAlignment("center")
    .setBorder(true, true, true, true, true, true, BORDER_COLOR, SpreadsheetApp.BorderStyle.SOLID);
}
