/**
 * Worklog PWA backend.
 *
 * Receives a JSON worklog submission from the PWA, validates it, and
 * appends it to a Google Sheet organised into calendar-month sections:
 *
 *   SEPTEMBER 2026
 *   Date | Start Time | End Time | Duration | Ticket
 *   04-09-2026 | 08:00 AM | 06:00 PM | 1d | PROJ-123
 *   ...
 *   (3 blank rows)
 *   OCTOBER 2026
 *   Date | Start Time | End Time | Duration | Ticket
 *   ...
 *
 * Each entry picks one of three fixed presets instead of typing times —
 * this mirrors Jira's own "Log work" dialog, which only needs a start
 * date and a time-spent duration (never an end time). The Duration
 * column is written in Jira's own format ("1d", "5h") so it can be
 * pasted straight into Jira later; Start/End Time are only a
 * human-readable record of roughly when that block was.
 *
 * Configuration is read from Script Properties (Project Settings >
 * Script properties) first:
 *   SPREADSHEET_ID  - required, the target spreadsheet's ID
 *   SHEET_NAME      - optional, defaults to "Worklog"
 *   API_SECRET      - optional, see the security note in the README
 *
 * If SPREADSHEET_ID isn't found there, DEFAULT_SPREADSHEET_ID below is
 * used instead. Script Properties are the recommended place to keep it,
 * but this fallback exists so a fresh setup still works if that step
 * gets missed or the wrong key name is typed.
 *
 * See README.md in this folder for full setup instructions.
 */

var DEFAULT_SPREADSHEET_ID = "1004yO9edlMlXGR5owYCGcdVfFYR3h33GokAVEUnlSfs";

var HEADER_ROW = ["Date", "Start Time", "End Time", "Duration", "Ticket"];
var NUM_COLUMNS = HEADER_ROW.length;

var MONTH_NAMES = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"
];

var BLANK_ROWS_BETWEEN_MONTHS = 3;
var MAX_TRACKED_SUBMISSION_IDS = 300;
var TIMEZONE = "Asia/Kolkata";

// A "day" in this app's own bookkeeping is the 1-Day preset's own
// 8:00 AM-6:00 PM window (10 clock-hours) — used only to fold a
// merged duration back into "Nd" when it divides evenly.
var DAY_MINUTES = 600;

// The three fixed choices offered in the app, mirrored from app.js's
// DURATION_PRESETS (that copy only needs the display text; this one is
// authoritative for the actual times and minutes).
var DURATION_PRESETS = {
  "1d": { start: "08:00", end: "18:00", minutes: DAY_MINUTES },
  "1st-half": { start: "08:00", end: "13:00", minutes: 300 },
  "2nd-half": { start: "14:00", end: "19:00", minutes: 300 },
};

// Cosmetic formatting applied automatically to every month section.
var HEADER_BG_COLOR = "#37474F";
var HEADER_FONT_COLOR = "#FFFFFF";
var MONTH_HEADING_BG_COLOR = "#E8EAF6";
var ALT_ROW_BG_COLOR = "#F5F5F5";
var BORDER_COLOR = "#D9D9D9";
var COLUMN_WIDTHS = [110, 100, 100, 80, 150]; // Date, Start, End, Duration, Ticket

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

function timeToMinutes_(hhmm) {
  var parts = hhmm.split(":");
  return Number(parts[0]) * 60 + Number(parts[1]);
}

function minutesToHHMM_(totalMinutes) {
  var h = Math.floor(totalMinutes / 60);
  var m = totalMinutes % 60;
  return pad2_(h) + ":" + pad2_(m);
}

// "08:00 AM" -> minutes since midnight
function parseTime12ToMinutes_(str) {
  var match = String(str).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  var h = Number(match[1]) % 12;
  if (match[3].toUpperCase() === "PM") h += 12;
  return h * 60 + Number(match[2]);
}

// Our own "1d" / "5h" strings -> minutes, for merging into an existing row.
function parseDurationMinutes_(str) {
  var match = String(str).trim().match(/^(\d+)(d|h)$/i);
  if (!match) return 0;
  var n = Number(match[1]);
  return match[2].toLowerCase() === "d" ? n * DAY_MINUTES : n * 60;
}

function formatMergedDuration_(totalMinutes) {
  if (totalMinutes % DAY_MINUTES === 0) {
    return (totalMinutes / DAY_MINUTES) + "d";
  }
  return (totalMinutes / 60) + "h";
}

// Combines an existing row's Start/End/Duration with another preset's,
// widening the time span and adding the durations together. The ticket
// (row[4]) is left untouched — it's already correct on both sides.
function mergeRowWithPreset_(row, preset, displayDate) {
  var startMinutes = Math.min(parseTime12ToMinutes_(row[1]), timeToMinutes_(preset.start));
  var endMinutes = Math.max(parseTime12ToMinutes_(row[2]), timeToMinutes_(preset.end));
  var totalMinutes = parseDurationMinutes_(row[3]) + preset.minutes;
  return [
    displayDate,
    formatTime12_(minutesToHHMM_(startMinutes)),
    formatTime12_(minutesToHHMM_(endMinutes)),
    formatMergedDuration_(totalMinutes),
    row[4],
  ];
}

// A cell that looks like a date can get silently auto-converted to a real
// Date value by Sheets depending on spreadsheet locale, even though we
// wrote a plain "dd-MM-yyyy" string — so compare on the formatted string
// either way rather than assuming the cell stayed a string.
function cellMatchesDate_(cellValue, displayDate) {
  if (Object.prototype.toString.call(cellValue) === "[object Date]") {
    return Utilities.formatDate(cellValue, TIMEZONE, "dd-MM-yyyy") === displayDate;
  }
  return String(cellValue).trim() === displayDate;
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
/* Month-section sheet management                                      */
/* ------------------------------------------------------------------ */

// Finds every "MONTH YEAR" heading in column A and, for each, the
// contiguous block of data rows that follows its header row.
function findMonthSections_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow === 0) return [];

  var values = sheet.getRange(1, 1, lastRow, 1).getValues();
  var headingRegex = /^([A-Z]+) (\d{4})$/;
  var sections = [];

  for (var r = 0; r < values.length; r++) {
    var text = String(values[r][0] || "").trim();
    var match = text.match(headingRegex);
    if (!match) continue;
    var monthIndex = MONTH_NAMES.indexOf(match[1]);
    if (monthIndex === -1) continue;

    var headingRow = r + 1; // 1-indexed
    var headerRow = headingRow + 1;
    var dataStartRow = headingRow + 2;

    var dataEndRow = dataStartRow - 1; // no data rows yet, by default
    for (var d = dataStartRow; d <= lastRow; d++) {
      var cell = values[d - 1] ? values[d - 1][0] : "";
      if (cell === "" || cell === null) break;
      dataEndRow = d;
    }

    sections.push({
      label: text,
      year: Number(match[2]),
      month: monthIndex + 1, // 1-12
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

// Appends the payload's entries, merging into an existing row instead of
// creating a duplicate whenever the same ticket already has a row for the
// same date — e.g. logging 1st Half now and 2nd Half later the same day
// becomes one row spanning both, with the durations added together
// ("5h" + "5h" -> "1d"), rather than two separate PROJ-123 rows. A
// different date is unaffected by this (it's simply a separate row, as
// normal) — merging only ever happens within a single date+ticket pair.
function appendWorklog_(sheet, payload) {
  var dateParts = payload.date.split("-"); // YYYY-MM-DD
  var year = Number(dateParts[0]);
  var month = Number(dateParts[1]);
  var day = Number(dateParts[2]);
  var displayDate = pad2_(day) + "-" + pad2_(month) + "-" + year;
  var monthLabel = MONTH_NAMES[month - 1] + " " + year;

  var sections = findMonthSections_(sheet);
  var decision = decideInsertion_(sections, year, month);

  // A month section created under an older schema (e.g. before a column
  // was renamed or added) keeps its original header text forever unless
  // corrected here — appending never rewrites it on its own. Bring it in
  // line with the current HEADER_ROW whenever it doesn't already match.
  if (decision.mode === "match") {
    refreshHeaderIfStale_(sheet, decision.section);
  }

  var existingRows = [];
  if (decision.mode === "match" && decision.section.dataEndRow >= decision.section.dataStartRow) {
    var section = decision.section;
    existingRows = sheet
      .getRange(section.dataStartRow, 1, section.dataEndRow - section.dataStartRow + 1, NUM_COLUMNS)
      .getValues();
  }

  var rowsToInsert = [];
  // Tracks a ticket that this same payload already queued for insertion,
  // so a second entry for it (e.g. 1st Half then 2nd Half in one submit)
  // merges into the queued row instead of becoming a second new row.
  var pendingIndexByTicket = {};
  // Merges into a row that already exists on the sheet, keyed by its
  // index into existingRows, applied once at the end — so multiple
  // entries in one payload matching the same existing row don't each
  // trigger their own (increasingly stale) sheet write.
  var mergedByExistingIndex = {};

  payload.entries.forEach(function (entry) {
    var ticket = String(entry.ticket).trim();
    var preset = DURATION_PRESETS[entry.duration];

    if (Object.prototype.hasOwnProperty.call(pendingIndexByTicket, ticket)) {
      var pendingIndex = pendingIndexByTicket[ticket];
      rowsToInsert[pendingIndex] = mergeRowWithPreset_(rowsToInsert[pendingIndex], preset, displayDate);
      return;
    }

    var matchIndex = -1;
    for (var i = 0; i < existingRows.length; i++) {
      if (cellMatchesDate_(existingRows[i][0], displayDate) && String(existingRows[i][4]).trim() === ticket) {
        matchIndex = i;
        break;
      }
    }

    if (matchIndex !== -1) {
      var base = Object.prototype.hasOwnProperty.call(mergedByExistingIndex, matchIndex)
        ? mergedByExistingIndex[matchIndex]
        : existingRows[matchIndex];
      mergedByExistingIndex[matchIndex] = mergeRowWithPreset_(base, preset, displayDate);
      return;
    }

    var freshValues = [
      displayDate,
      formatTime12_(preset.start),
      formatTime12_(preset.end),
      formatMergedDuration_(preset.minutes),
      ticket,
    ];
    pendingIndexByTicket[ticket] = rowsToInsert.length;
    rowsToInsert.push(freshValues);
  });

  var mergeSection = decision.section;
  Object.keys(mergedByExistingIndex).forEach(function (key) {
    var rowOffset = Number(key);
    var sheetRow = mergeSection.dataStartRow + rowOffset;
    sheet.getRange(sheetRow, 1, 1, NUM_COLUMNS).setValues([mergedByExistingIndex[key]]);
  });

  if (rowsToInsert.length === 0) {
    return 0; // everything merged into rows that already existed
  }

  if (decision.mode === "match") {
    var section = decision.section;
    var existingDataRowCount = Math.max(0, section.dataEndRow - section.dataStartRow + 1);
    sheet.insertRowsAfter(section.dataEndRow, rowsToInsert.length);
    sheet.getRange(section.dataEndRow + 1, 1, rowsToInsert.length, NUM_COLUMNS).setValues(rowsToInsert);
    styleDataRows_(sheet, section.dataEndRow + 1, rowsToInsert.length, existingDataRowCount);
    return rowsToInsert.length;
  }

  if (decision.mode === "before") {
    var beforeRow = decision.section.headingRow;
    var blockSize = 2 + rowsToInsert.length + BLANK_ROWS_BETWEEN_MONTHS;
    sheet.insertRowsBefore(beforeRow, blockSize);
    writeMonthBlock_(sheet, beforeRow, monthLabel, rowsToInsert);
    return rowsToInsert.length;
  }

  // append-end
  var startRow;
  if (!decision.section) {
    startRow = 1; // sheet is empty
  } else {
    startRow = decision.section.dataEndRow + 1 + BLANK_ROWS_BETWEEN_MONTHS;
  }
  writeMonthBlock_(sheet, startRow, monthLabel, rowsToInsert);
  return rowsToInsert.length;
}

function refreshHeaderIfStale_(sheet, section) {
  var current = sheet.getRange(section.headerRow, 1, 1, NUM_COLUMNS).getValues()[0];
  var matches = current.length === HEADER_ROW.length && current.every(function (cell, i) {
    return String(cell).trim() === HEADER_ROW[i];
  });
  if (matches) return;
  sheet.getRange(section.headerRow, 1, 1, NUM_COLUMNS).setValues([HEADER_ROW]);
  styleHeaderRow_(sheet, section.headerRow);
}

function writeMonthBlock_(sheet, startRow, monthLabel, dataRows) {
  sheet.getRange(startRow, 1, 1, NUM_COLUMNS).merge();
  sheet.getRange(startRow, 1).setValue(monthLabel);
  styleMonthHeading_(sheet, startRow);

  sheet.getRange(startRow + 1, 1, 1, NUM_COLUMNS).setValues([HEADER_ROW]);
  styleHeaderRow_(sheet, startRow + 1);

  if (dataRows.length) {
    sheet.getRange(startRow + 2, 1, dataRows.length, NUM_COLUMNS).setValues(dataRows);
    styleDataRows_(sheet, startRow + 2, dataRows.length, 0);
  }
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                   */
/* ------------------------------------------------------------------ */

function pad2_(n) {
  return (n < 10 ? "0" : "") + n;
}

// "21:32" -> "09:32 PM"
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

function styleDataRows_(sheet, startRow, count, bandOffset) {
  for (var i = 0; i < count; i++) {
    var row = startRow + i;
    var isEven = (bandOffset + i) % 2 === 0;
    var bg = isEven ? "#FFFFFF" : ALT_ROW_BG_COLOR;

    sheet.getRange(row, 1, 1, NUM_COLUMNS)
      .setBackground(bg)
      .setBorder(true, true, true, true, true, false, BORDER_COLOR, SpreadsheetApp.BorderStyle.SOLID)
      .setHorizontalAlignment("center");
  }
}
