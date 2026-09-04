/**
 * Worklog PWA backend.
 *
 * Receives a JSON worklog submission from the PWA, validates it, and
 * writes it into a Google Sheet organised into calendar-month sections.
 * Each row is exactly one Jira "Log work" entry — a ticket, the date and
 * time it started, and the time spent in Jira's own format — so the
 * month-end CSV export can be fed straight into Jira:
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
 * Rows within a month are kept in ascending date order (then start time),
 * so a backfilled earlier date is inserted in its proper place rather than
 * appended at the bottom. Rows are never merged: working the same ticket
 * morning and afternoon is two rows, because it is two Jira worklogs.
 *
 * Every cell we write is forced to plain-text format. Otherwise Sheets
 * silently turns "SEPTEMBER 2026" into a date (which broke month-section
 * detection and caused duplicate headings) and "2026-09-04" / "08:00 AM"
 * into date/time values that export inconsistently to CSV.
 *
 * Configuration is read from Script Properties (Project Settings >
 * Script properties) first:
 *   SPREADSHEET_ID  - required, the target spreadsheet's ID
 *   SHEET_NAME      - optional, defaults to "Worklog"
 *   API_SECRET      - optional, see the security note in the README
 *
 * If SPREADSHEET_ID isn't found there, DEFAULT_SPREADSHEET_ID below is
 * used instead.
 *
 * See README.md in this folder for full setup instructions.
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

// The three fixed choices offered in the app. "start" is when the block
// begins (24h); "timeSpent" is written verbatim in Jira's duration format.
// Jira treats 1d as 8h by default — we deliberately leave that alone and
// log half days as 5h.
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
  return jsonResponse_({ status: "ok", message: "Worklog Apps Script endpoint is running." });
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

    var validation = validatePayload_(payload);
    if (!validation.valid) {
      return jsonResponse_({ success: false, message: validation.message });
    }

    if (payload.submissionId && isDuplicateSubmission_(payload.submissionId)) {
      return jsonResponse_({
        success: true,
        duplicate: true,
        message: "This worklog was already saved.",
      });
    }

    var sheet = getSheet_(config);
    var rowsAdded = appendWorklog_(sheet, payload);

    if (payload.submissionId) {
      recordSubmission_(payload.submissionId);
    }

    return jsonResponse_({
      success: true,
      message: "Worklog saved successfully",
      rowsAdded: rowsAdded,
    });
  } catch (err) {
    return jsonResponse_({ success: false, message: "Server error: " + err.message });
  }
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

function validatePayload_(payload) {
  if (!payload || typeof payload !== "object") {
    return { valid: false, message: "Invalid payload." };
  }
  if (!payload.date || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) {
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
    if (!entry.ticket || !String(entry.ticket).trim()) {
      return { valid: false, message: label + ": ticket is required." };
    }
    if (!DURATION_PRESETS[entry.duration]) {
      return { valid: false, message: label + ": duration must be one of 1d, 1st-half, 2nd-half." };
    }
  }

  return { valid: true };
}

/* ------------------------------------------------------------------ */
/* Duplicate submission protection                                     */
/* ------------------------------------------------------------------ */

function isDuplicateSubmission_(submissionId) {
  var ids = getTrackedSubmissionIds_();
  return ids.indexOf(submissionId) !== -1;
}

function recordSubmission_(submissionId) {
  var props = PropertiesService.getScriptProperties();
  var ids = getTrackedSubmissionIds_();
  ids.push(submissionId);
  if (ids.length > MAX_TRACKED_SUBMISSION_IDS) {
    ids = ids.slice(ids.length - MAX_TRACKED_SUBMISSION_IDS);
  }
  props.setProperty("PROCESSED_SUBMISSION_IDS", JSON.stringify(ids));
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
/* Reading what's already on the sheet                                 */
/* ------------------------------------------------------------------ */

function isDateValue_(value) {
  return Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime());
}

// A month heading is a row with something in column A and nothing in
// column B. Column A is either our plain-text "SEPTEMBER 2026" or — on a
// sheet Sheets already tampered with — a Date value it auto-converted the
// text into (shown as "September 2026" / 9/1/2026).
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

// Finds every month section: heading row, header row, and the contiguous
// block of data rows beneath (dataEndRow < dataStartRow means no data yet).
function findMonthSections_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow === 0) return [];

  var values = sheet.getRange(1, 1, lastRow, 2).getValues();
  var sections = [];

  for (var r = 0; r < values.length; r++) {
    var ym = parseMonthHeading_(values[r][0], values[r][1]);
    if (!ym) continue;

    var headingRow = r + 1; // 1-indexed
    var headerRow = headingRow + 1;
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
      headerRow: headerRow,
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
    var key = sections[j].year * 12 + sections[j].month;
    if (key > targetKey) {
      return { mode: "before", section: sections[j] };
    }
  }

  return { mode: "append-end", section: sections.length ? sections[sections.length - 1] : null };
}

// yyyyMMdd as a number, from our "yyyy-MM-dd" text, a legacy "dd-MM-yyyy"
// text, or a Date value Sheets auto-converted. Null if unrecognisable.
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

// Minutes since midnight from "08:00 AM", "14:00", or a Date/time value.
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
  if (twentyFour) return Number(twentyFour[1]) * 60 + Number(twentyFour[2]);
  return 0;
}

function sortKey_(dateKey, startMinutes) {
  return (dateKey || 0) * 10000 + startMinutes;
}

// The existing data rows of a section as [{ rowNumber, key }], in sheet order.
function readSectionRows_(sheet, section) {
  var count = section.dataEndRow - section.dataStartRow + 1;
  if (count <= 0) return [];
  var values = sheet.getRange(section.dataStartRow, 1, count, NUM_COLUMNS).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    rows.push({
      rowNumber: section.dataStartRow + i,
      key: sortKey_(parseDateKey_(values[i][COL_DATE]), parseStartMinutes_(values[i][COL_START])),
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Writing                                                              */
/* ------------------------------------------------------------------ */

function appendWorklog_(sheet, payload) {
  var dateParts = payload.date.split("-"); // YYYY-MM-DD
  var year = Number(dateParts[0]);
  var month = Number(dateParts[1]);
  var isoDate = payload.date;
  var dateKey = Number(dateParts[0] + dateParts[1] + dateParts[2]);
  var monthLabel = MONTH_NAMES[month - 1] + " " + year;

  var newRows = payload.entries.map(function (entry) {
    var preset = DURATION_PRESETS[entry.duration];
    var startMinutes = timeToMinutes_(preset.start);
    return {
      key: sortKey_(dateKey, startMinutes),
      values: [isoDate, String(entry.ticket).trim(), formatTime12_(preset.start), preset.timeSpent],
    };
  });
  newRows.sort(function (a, b) { return a.key - b.key; });

  var sections = findMonthSections_(sheet);
  var decision = decideInsertion_(sections, year, month);

  if (decision.mode === "match") {
    var section = decision.section;
    refreshSectionChrome_(sheet, section);

    var existing = readSectionRows_(sheet, section);
    newRows.forEach(function (newRow) {
      // Insert before the first existing row that sorts after this one, so
      // the section stays in ascending (date, start time) order; if none
      // does, it goes at the end of the section.
      var insertAt = section.dataEndRow + 1;
      for (var i = 0; i < existing.length; i++) {
        if (existing[i].key > newRow.key) {
          insertAt = existing[i].rowNumber;
          break;
        }
      }
      insertRowAt_(sheet, insertAt, newRow.values);
      for (var j = 0; j < existing.length; j++) {
        if (existing[j].rowNumber >= insertAt) existing[j].rowNumber += 1;
      }
      existing.push({ rowNumber: insertAt, key: newRow.key });
      existing.sort(function (a, b) { return a.rowNumber - b.rowNumber; });
      section.dataEndRow += 1;
    });

    // Re-band the whole section so alternating colours stay consistent
    // after inserting in the middle.
    styleDataRows_(sheet, section.dataStartRow, section.dataEndRow - section.dataStartRow + 1);
    return newRows.length;
  }

  var values = newRows.map(function (r) { return r.values; });

  if (decision.mode === "before") {
    var beforeRow = decision.section.headingRow;
    var blockSize = 2 + values.length + BLANK_ROWS_BETWEEN_MONTHS;
    sheet.insertRowsBefore(beforeRow, blockSize);
    writeMonthBlock_(sheet, beforeRow, monthLabel, values);
    return values.length;
  }

  // append-end
  var startRow = decision.section
    ? decision.section.dataEndRow + 1 + BLANK_ROWS_BETWEEN_MONTHS
    : 1;
  writeMonthBlock_(sheet, startRow, monthLabel, values);
  return values.length;
}

// Inserts a single data row at exactly rowNumber, shifting anything below
// it down. When rowNumber is past the last used row there is nothing to
// shift, so the row is simply written in place.
function insertRowAt_(sheet, rowNumber, values) {
  if (rowNumber <= sheet.getLastRow()) {
    sheet.insertRowsBefore(rowNumber, 1);
  }
  writeTextRow_(sheet, rowNumber, values);
}

function writeTextRow_(sheet, rowNumber, values) {
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
// Sheets auto-converted to a date goes back to plain "SEPTEMBER 2026" text,
// and a header row from an older column layout is rewritten to the
// current one.
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

function styleDataRows_(sheet, startRow, count) {
  for (var i = 0; i < count; i++) {
    var bg = i % 2 === 0 ? "#FFFFFF" : ALT_ROW_BG_COLOR;
    sheet.getRange(startRow + i, 1, 1, NUM_COLUMNS)
      .setBackground(bg)
      .setFontWeight("normal")
      .setFontColor("#000000")
      .setBorder(true, true, true, true, true, false, BORDER_COLOR, SpreadsheetApp.BorderStyle.SOLID)
      .setHorizontalAlignment("center");
  }
}
