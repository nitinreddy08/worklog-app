/**
 * Worklog PWA backend.
 *
 * Receives a JSON worklog submission from the PWA, validates it, and
 * appends it to a Google Sheet organised into calendar-month sections:
 *
 *   SEPTEMBER 2026
 *   Date | Start Time | End Time | Duration | Work Description
 *   04-09-2026 | 09:30 AM | 11:00 AM | 1:30 | Fixed login bug
 *   ...
 *   (3 blank rows)
 *   OCTOBER 2026
 *   Date | Start Time | End Time | Duration | Work Description
 *   ...
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

var HEADER_ROW = ["Date", "Start Time", "End Time", "Duration", "Work Description"];

var MONTH_NAMES = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"
];

var BLANK_ROWS_BETWEEN_MONTHS = 3;
var MAX_TRACKED_SUBMISSION_IDS = 300;
var TIMEZONE = "Asia/Kolkata";

// Cosmetic formatting applied automatically to every month section.
var HEADER_BG_COLOR = "#37474F";
var HEADER_FONT_COLOR = "#FFFFFF";
var MONTH_HEADING_BG_COLOR = "#E8EAF6";
var ALT_ROW_BG_COLOR = "#F5F5F5";
var BORDER_COLOR = "#D9D9D9";
var COLUMN_WIDTHS = [110, 90, 90, 80, 350]; // Date, Start, End, Duration, Description

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
    if (!entry.description || !String(entry.description).trim()) {
      return { valid: false, message: label + ": description is required." };
    }
    if (!isValidTime_(entry.startTime)) {
      return { valid: false, message: label + ": a valid start time (HH:MM) is required." };
    }
    if (!isValidTime_(entry.endTime)) {
      return { valid: false, message: label + ": a valid end time (HH:MM) is required." };
    }
    if (timeToMinutes_(entry.endTime) <= timeToMinutes_(entry.startTime)) {
      return { valid: false, message: label + ": end time must be after start time." };
    }
  }

  return { valid: true };
}

function isValidTime_(value) {
  return typeof value === "string" && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

function timeToMinutes_(hhmm) {
  var parts = hhmm.split(":");
  return Number(parts[0]) * 60 + Number(parts[1]);
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

function appendWorklog_(sheet, payload) {
  var dateParts = payload.date.split("-"); // YYYY-MM-DD
  var year = Number(dateParts[0]);
  var month = Number(dateParts[1]);
  var day = Number(dateParts[2]);
  var displayDate = pad2_(day) + "-" + pad2_(month) + "-" + year;
  var monthLabel = MONTH_NAMES[month - 1] + " " + year;

  var dataRows = payload.entries.map(function (entry) {
    var durationMinutes = timeToMinutes_(entry.endTime) - timeToMinutes_(entry.startTime);
    return [
      displayDate,
      formatTime12_(entry.startTime),
      formatTime12_(entry.endTime),
      formatDurationString_(durationMinutes),
      String(entry.description).trim(),
    ];
  });

  var sections = findMonthSections_(sheet);
  var decision = decideInsertion_(sections, year, month);

  if (decision.mode === "match") {
    var section = decision.section;
    var existingDataRows = Math.max(0, section.dataEndRow - section.dataStartRow + 1);
    sheet.insertRowsAfter(section.dataEndRow, dataRows.length);
    sheet.getRange(section.dataEndRow + 1, 1, dataRows.length, 5).setValues(dataRows);
    styleDataRows_(sheet, section.dataEndRow + 1, dataRows.length, existingDataRows);
    return dataRows.length;
  }

  if (decision.mode === "before") {
    var beforeRow = decision.section.headingRow;
    var blockSize = 2 + dataRows.length + BLANK_ROWS_BETWEEN_MONTHS;
    sheet.insertRowsBefore(beforeRow, blockSize);
    writeMonthBlock_(sheet, beforeRow, monthLabel, dataRows);
    return dataRows.length;
  }

  // append-end
  var startRow;
  if (!decision.section) {
    startRow = 1; // sheet is empty
  } else {
    startRow = decision.section.dataEndRow + 1 + BLANK_ROWS_BETWEEN_MONTHS;
  }
  writeMonthBlock_(sheet, startRow, monthLabel, dataRows);
  return dataRows.length;
}

function writeMonthBlock_(sheet, startRow, monthLabel, dataRows) {
  sheet.getRange(startRow, 1, 1, 5).merge();
  sheet.getRange(startRow, 1).setValue(monthLabel);
  styleMonthHeading_(sheet, startRow);

  sheet.getRange(startRow + 1, 1, 1, 5).setValues([HEADER_ROW]);
  styleHeaderRow_(sheet, startRow + 1);

  if (dataRows.length) {
    sheet.getRange(startRow + 2, 1, dataRows.length, 5).setValues(dataRows);
    styleDataRows_(sheet, startRow + 2, dataRows.length, 0);
  }
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                   */
/* ------------------------------------------------------------------ */

function pad2_(n) {
  return (n < 10 ? "0" : "") + n;
}

function formatDurationString_(totalMinutes) {
  var h = Math.floor(totalMinutes / 60);
  var m = totalMinutes % 60;
  return h + ":" + pad2_(m);
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
  sheet.getRange(row, 1, 1, 5)
    .setBackground(MONTH_HEADING_BG_COLOR)
    .setFontWeight("bold")
    .setFontSize(13)
    .setHorizontalAlignment("left")
    .setVerticalAlignment("middle");
  sheet.setRowHeight(row, 28);
}

function styleHeaderRow_(sheet, row) {
  sheet.getRange(row, 1, 1, 5)
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

    sheet.getRange(row, 1, 1, 5)
      .setBackground(bg)
      .setBorder(true, true, true, true, true, false, BORDER_COLOR, SpreadsheetApp.BorderStyle.SOLID);
    sheet.getRange(row, 1, 1, 4).setHorizontalAlignment("center");
    sheet.getRange(row, 5, 1, 1).setHorizontalAlignment("left");
  }
}
