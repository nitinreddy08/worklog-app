"use strict";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const CONFIG = {
  // Paste the Web App URL you get after deploying the Apps Script
  // (see google-apps-script/README.md). Leaving this unset lets you load
  // the app to look around, but Save will fail until it's configured.
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbxkbbDFkc6vqI2ANKFn-yOqaSMcuisVccuahltuElU2oKEPMH8HhoN6gLajsZbnw64M/exec",
  // Optional. Only needed if you set API_SECRET in the Apps Script's
  // Script Properties. See google-apps-script/README.md for why this is
  // a weak, best-effort filter rather than real authentication.
  API_SECRET: "nitinreddyworklog",
  REQUEST_TIMEOUT_MS: 15000,
};

const STORAGE_KEYS = {
  pendingQueue: "worklog_pending_queue",
  draftPrefix: "worklog_draft_",
};

/* ------------------------------------------------------------------ */
/* Date helpers (always local time, never UTC-shifted)                 */
/* ------------------------------------------------------------------ */

function pad2(n) {
  return String(n).padStart(2, "0");
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseISODateLocal(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function formatWeekday(iso) {
  return WEEKDAYS[parseISODateLocal(iso).getDay()];
}

function formatFullDate(iso) {
  const d = parseISODateLocal(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/* ------------------------------------------------------------------ */
/* Time / duration helpers                                             */
/* ------------------------------------------------------------------ */

function timeToMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

// Returns minutes, or null if start/end are missing/invalid, or
// undefined if end is not after start (same-day worklog only).
function computeDurationMinutes(start, end) {
  const s = timeToMinutes(start);
  const e = timeToMinutes(end);
  if (s === null || e === null) return null;
  if (e <= s) return undefined;
  return e - s;
}

function formatDuration(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/* ------------------------------------------------------------------ */
/* State                                                                */
/* ------------------------------------------------------------------ */

function blankTask() {
  return { id: uid(), description: "", start: "", end: "" };
}

let state = {
  date: todayISO(),
  entries: [blankTask()],
};

/* ------------------------------------------------------------------ */
/* DOM references                                                      */
/* ------------------------------------------------------------------ */

const el = {
  weekday: document.getElementById("weekday"),
  fullDate: document.getElementById("full-date"),
  changeDateBtn: document.getElementById("change-date-btn"),
  datePickerWrap: document.getElementById("date-picker-wrap"),
  dateInput: document.getElementById("date-input"),
  dateConfirmBtn: document.getElementById("date-confirm-btn"),
  dateCancelBtn: document.getElementById("date-cancel-btn"),
  offlineBanner: document.getElementById("offline-banner"),
  syncBanner: document.getElementById("sync-banner"),
  formView: document.getElementById("form-view"),
  taskList: document.getElementById("task-list"),
  addTaskBtn: document.getElementById("add-task-btn"),
  formError: document.getElementById("form-error"),
  totalDisplay: document.getElementById("total-display"),
  saveBtn: document.getElementById("save-btn"),
  taskTemplate: document.getElementById("task-template"),
  confirmationView: document.getElementById("confirmation-view"),
  confirmHeading: document.getElementById("confirm-heading"),
  confirmDate: document.getElementById("confirm-date"),
  confirmCount: document.getElementById("confirm-count"),
  confirmTotal: document.getElementById("confirm-total"),
  confirmNote: document.getElementById("confirm-note"),
  doneBtn: document.getElementById("done-btn"),
};

/* ------------------------------------------------------------------ */
/* Draft persistence (per date) — protects against a closed tab/browser */
/* ------------------------------------------------------------------ */

function draftKey(dateIso) {
  return STORAGE_KEYS.draftPrefix + dateIso;
}

function saveDraft() {
  try {
    localStorage.setItem(draftKey(state.date), JSON.stringify(state.entries));
  } catch (e) {
    /* storage unavailable — draft persistence is best-effort only */
  }
}

function loadDraft(dateIso) {
  try {
    const raw = localStorage.getItem(draftKey(dateIso));
    if (!raw) return null;
    const entries = JSON.parse(raw);
    if (Array.isArray(entries) && entries.length) return entries;
  } catch (e) {
    /* ignore corrupt draft */
  }
  return null;
}

function clearDraft(dateIso) {
  try {
    localStorage.removeItem(draftKey(dateIso));
  } catch (e) {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                            */
/* ------------------------------------------------------------------ */

function renderHeader() {
  el.weekday.textContent = formatWeekday(state.date);
  el.fullDate.textContent = formatFullDate(state.date);
}

function renderTaskList() {
  el.taskList.innerHTML = "";
  state.entries.forEach((entry, index) => {
    const node = el.taskTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = entry.id;
    node.querySelector(".task-number").textContent = `Task ${index + 1}`;

    const descInput = node.querySelector(".task-description");
    const startInput = node.querySelector(".task-start");
    const endInput = node.querySelector(".task-end");
    const durationValue = node.querySelector(".duration-value");
    const taskError = node.querySelector(".task-error");
    const removeBtn = node.querySelector(".remove-task-btn");

    descInput.value = entry.description;
    startInput.value = entry.start;
    endInput.value = entry.end;

    const duration = computeDurationMinutes(entry.start, entry.end);
    if (duration === undefined) {
      durationValue.textContent = "—";
      taskError.textContent = "End time must be after start time.";
      taskError.hidden = false;
    } else if (duration === null) {
      durationValue.textContent = "—";
      taskError.hidden = true;
    } else {
      durationValue.textContent = formatDuration(duration);
      taskError.hidden = true;
    }

    descInput.addEventListener("input", () => {
      entry.description = descInput.value;
      saveDraft();
    });
    startInput.addEventListener("input", () => {
      entry.start = startInput.value;
      updateSingleTask(node, entry);
      updateTotal();
      saveDraft();
    });
    endInput.addEventListener("input", () => {
      entry.end = endInput.value;
      updateSingleTask(node, entry);
      updateTotal();
      saveDraft();
    });
    removeBtn.addEventListener("click", () => removeTask(entry.id));
    removeBtn.disabled = state.entries.length === 1 && !entry.description && !entry.start && !entry.end;

    el.taskList.appendChild(node);
  });
  updateTotal();
}

function updateSingleTask(node, entry) {
  const durationValue = node.querySelector(".duration-value");
  const taskError = node.querySelector(".task-error");
  const duration = computeDurationMinutes(entry.start, entry.end);
  if (duration === undefined) {
    durationValue.textContent = "—";
    taskError.textContent = "End time must be after start time.";
    taskError.hidden = false;
  } else if (duration === null) {
    durationValue.textContent = "—";
    taskError.hidden = true;
  } else {
    durationValue.textContent = formatDuration(duration);
    taskError.hidden = true;
  }
}

function updateTotal() {
  let total = 0;
  for (const entry of state.entries) {
    const duration = computeDurationMinutes(entry.start, entry.end);
    if (typeof duration === "number") total += duration;
  }
  el.totalDisplay.textContent = formatDuration(total);
}

function render() {
  renderHeader();
  renderTaskList();
}

/* ------------------------------------------------------------------ */
/* Task list actions                                                   */
/* ------------------------------------------------------------------ */

function addTask() {
  state.entries.push(blankTask());
  render();
  saveDraft();
  const lastCard = el.taskList.lastElementChild;
  if (lastCard) lastCard.querySelector(".task-description").focus();
}

function removeTask(id) {
  if (state.entries.length === 1) {
    state.entries = [blankTask()];
  } else {
    state.entries = state.entries.filter((e) => e.id !== id);
  }
  render();
  saveDraft();
}

/* ------------------------------------------------------------------ */
/* Date switching                                                       */
/* ------------------------------------------------------------------ */

function switchToDate(newDate) {
  saveDraft();
  state.date = newDate;
  const draft = loadDraft(newDate);
  state.entries = draft || [blankTask()];
  render();
}

el.changeDateBtn.addEventListener("click", () => {
  const expanded = el.changeDateBtn.getAttribute("aria-expanded") === "true";
  el.changeDateBtn.setAttribute("aria-expanded", String(!expanded));
  el.datePickerWrap.hidden = expanded;
  if (!expanded) el.dateInput.value = state.date;
});

el.dateCancelBtn.addEventListener("click", () => {
  el.datePickerWrap.hidden = true;
  el.changeDateBtn.setAttribute("aria-expanded", "false");
});

el.dateConfirmBtn.addEventListener("click", () => {
  if (!el.dateInput.value) return;
  switchToDate(el.dateInput.value);
  el.datePickerWrap.hidden = true;
  el.changeDateBtn.setAttribute("aria-expanded", "false");
});

el.addTaskBtn.addEventListener("click", addTask);

/* ------------------------------------------------------------------ */
/* Validation                                                           */
/* ------------------------------------------------------------------ */

function validateEntries(entries) {
  const errors = [];
  if (entries.length === 0) {
    errors.push("Add at least one task.");
    return errors;
  }
  entries.forEach((entry, index) => {
    const label = `Task ${index + 1}`;
    if (!entry.description || !entry.description.trim()) {
      errors.push(`${label}: description is required.`);
    }
    if (!entry.start) {
      errors.push(`${label}: start time is required.`);
    }
    if (!entry.end) {
      errors.push(`${label}: end time is required.`);
    }
    if (entry.start && entry.end) {
      const duration = computeDurationMinutes(entry.start, entry.end);
      if (duration === undefined) {
        errors.push(`${label}: end time must be after start time.`);
      }
    }
  });
  return errors;
}

/* ------------------------------------------------------------------ */
/* Pending (offline) queue                                             */
/* ------------------------------------------------------------------ */

function readQueue() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.pendingQueue);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function writeQueue(queue) {
  try {
    localStorage.setItem(STORAGE_KEYS.pendingQueue, JSON.stringify(queue));
  } catch (e) {
    /* ignore */
  }
}

function enqueuePending(payload) {
  const queue = readQueue();
  queue.push(payload);
  writeQueue(queue);
}

function removeFromQueue(submissionId) {
  const queue = readQueue().filter((p) => p.submissionId !== submissionId);
  writeQueue(queue);
}

/* ------------------------------------------------------------------ */
/* Network                                                              */
/* ------------------------------------------------------------------ */

function buildPayload(dateIso, entries, submissionId) {
  const payload = {
    submissionId,
    date: dateIso,
    entries: entries.map((e) => ({
      description: e.description.trim(),
      startTime: e.start,
      endTime: e.end,
    })),
  };
  if (CONFIG.API_SECRET) payload.apiSecret = CONFIG.API_SECRET;
  return payload;
}

async function postWorklog(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
  try {
    // Content-Type text/plain avoids a CORS preflight against the Apps
    // Script Web App (see google-apps-script/README.md troubleshooting).
    const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Server responded with ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function isConfigured() {
  return CONFIG.APPS_SCRIPT_URL && !CONFIG.APPS_SCRIPT_URL.startsWith("PASTE_");
}

/* ------------------------------------------------------------------ */
/* Save flow                                                           */
/* ------------------------------------------------------------------ */

function showFormError(message) {
  el.formError.textContent = message;
  el.formError.hidden = false;
}

function hideFormError() {
  el.formError.hidden = true;
  el.formError.textContent = "";
}

function setSaving(isSaving) {
  el.saveBtn.disabled = isSaving;
  el.saveBtn.textContent = isSaving ? "Saving…" : "Save Worklog";
}

function showConfirmation({ dateIso, count, totalMinutes, offline, duplicate }) {
  el.formView.hidden = true;
  el.confirmationView.hidden = false;
  el.confirmHeading.textContent = offline ? "Worklog queued" : "Worklog saved";
  el.confirmDate.textContent = formatFullDate(dateIso);
  el.confirmCount.textContent = String(count);
  el.confirmTotal.textContent = formatDuration(totalMinutes);
  if (offline) {
    el.confirmNote.hidden = false;
    el.confirmNote.textContent = "You're offline — this worklog is saved on your phone and will sync to the sheet automatically once you're back online.";
  } else if (duplicate) {
    el.confirmNote.hidden = false;
    el.confirmNote.textContent = "This worklog was already saved earlier.";
  } else {
    el.confirmNote.hidden = true;
  }
}

el.doneBtn.addEventListener("click", () => {
  clearDraft(state.date);
  state.date = todayISO();
  state.entries = [blankTask()];
  el.confirmationView.hidden = true;
  el.formView.hidden = false;
  render();
});

async function handleSave() {
  hideFormError();
  const errors = validateEntries(state.entries);
  if (errors.length) {
    showFormError(errors[0]);
    return;
  }
  if (!isConfigured()) {
    showFormError("The app isn't connected to Google Sheets yet. Set CONFIG.APPS_SCRIPT_URL in app.js (see google-apps-script/README.md).");
    return;
  }

  const submissionId = `${state.date}-${uid()}`;
  const totalMinutes = state.entries.reduce((sum, e) => {
    const d = computeDurationMinutes(e.start, e.end);
    return sum + (typeof d === "number" ? d : 0);
  }, 0);
  const payload = buildPayload(state.date, state.entries, submissionId);

  if (!navigator.onLine) {
    enqueuePending(payload);
    clearDraft(state.date);
    showConfirmation({ dateIso: state.date, count: state.entries.length, totalMinutes, offline: true });
    return;
  }

  setSaving(true);
  try {
    const result = await postWorklog(payload);
    if (result && result.success) {
      clearDraft(state.date);
      showConfirmation({
        dateIso: state.date,
        count: state.entries.length,
        totalMinutes,
        duplicate: !!result.duplicate,
      });
    } else {
      showFormError((result && result.message) || "Could not save your worklog.");
    }
  } catch (err) {
    // Network-ish failure: queue it instead of losing the data.
    enqueuePending(payload);
    clearDraft(state.date);
    showConfirmation({ dateIso: state.date, count: state.entries.length, totalMinutes, offline: true });
  } finally {
    setSaving(false);
  }
}

el.saveBtn.addEventListener("click", handleSave);

/* ------------------------------------------------------------------ */
/* Offline / sync banners                                              */
/* ------------------------------------------------------------------ */

function updateOfflineBanner() {
  el.offlineBanner.hidden = navigator.onLine;
}

async function syncPendingQueue() {
  if (!navigator.onLine || !isConfigured()) return;
  const queue = readQueue();
  if (!queue.length) return;

  el.syncBanner.hidden = false;
  el.syncBanner.textContent = `Syncing ${queue.length} saved worklog${queue.length > 1 ? "s" : ""}…`;

  let syncedCount = 0;
  for (const payload of queue) {
    try {
      const result = await postWorklog(payload);
      if (result && (result.success || result.duplicate)) {
        removeFromQueue(payload.submissionId);
        syncedCount++;
      }
    } catch (e) {
      // still offline / server unreachable — leave it queued and stop for now.
      break;
    }
  }

  if (syncedCount > 0) {
    el.syncBanner.textContent = "Worklog saved.";
    setTimeout(() => {
      el.syncBanner.hidden = true;
    }, 3000);
  } else {
    el.syncBanner.hidden = true;
  }
}

window.addEventListener("online", () => {
  updateOfflineBanner();
  syncPendingQueue();
});
window.addEventListener("offline", updateOfflineBanner);

/* ------------------------------------------------------------------ */
/* Service worker registration                                         */
/* ------------------------------------------------------------------ */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {
      /* registration failure shouldn't block the app */
    });
  });
}

/* ------------------------------------------------------------------ */
/* Init                                                                 */
/* ------------------------------------------------------------------ */

(function init() {
  const draft = loadDraft(state.date);
  if (draft) state.entries = draft;
  render();
  updateOfflineBanner();
  syncPendingQueue();
})();
