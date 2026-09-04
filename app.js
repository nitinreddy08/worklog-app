"use strict";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const CONFIG = {
  // Paste the Web App URL you get after deploying the Apps Script
  // (see google-apps-script/README.md). Leaving this unset lets you load
  // the app to look around, but Save will fail until it's configured.
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbx9C81xyrz972udKLhG_9iR_ksGamIO-AEuDYqRu88W9oLYUScqxJ6qOtX41Zayw1j-/exec",
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
/* Duration presets                                                     */
/* ------------------------------------------------------------------ */

// Mirrors DURATION_PRESETS in google-apps-script/Code.gs, which owns the
// actual start time and Jira-format time spent — the client only needs
// the display text for the hint under each preset.
const DURATION_PRESETS = {
  "1d": { label: "1 Day", rangeText: "Starts 8:00 AM · logs 1d in Jira" },
  "1st-half": { label: "1st Half", rangeText: "Starts 8:00 AM · logs 5h in Jira" },
  "2nd-half": { label: "2nd Half", rangeText: "Starts 2:00 PM · logs 5h in Jira" },
};

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/* ------------------------------------------------------------------ */
/* State                                                                */
/* ------------------------------------------------------------------ */

function blankTask() {
  return { id: uid(), ticket: "", duration: "" };
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
  saveBtn: document.getElementById("save-btn"),
  taskTemplate: document.getElementById("task-template"),
  confirmationView: document.getElementById("confirmation-view"),
  confirmHeading: document.getElementById("confirm-heading"),
  confirmDate: document.getElementById("confirm-date"),
  confirmCount: document.getElementById("confirm-count"),
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

    const ticketInput = node.querySelector(".task-ticket");
    const durationInputs = node.querySelectorAll(".task-duration-input");
    const durationHint = node.querySelector(".duration-time-hint");
    const removeBtn = node.querySelector(".remove-task-btn");

    ticketInput.value = entry.ticket;
    ticketInput.addEventListener("input", () => {
      entry.ticket = ticketInput.value;
      saveDraft();
    });

    durationInputs.forEach((input) => {
      input.name = `duration-${entry.id}`;
      input.checked = input.value === entry.duration;
      input.addEventListener("change", () => {
        entry.duration = input.value;
        updateDurationHint(durationHint, entry.duration);
        saveDraft();
      });
    });
    updateDurationHint(durationHint, entry.duration);

    removeBtn.addEventListener("click", () => removeTask(entry.id));
    removeBtn.disabled = state.entries.length === 1 && !entry.ticket && !entry.duration;

    el.taskList.appendChild(node);
  });
}

function updateDurationHint(durationHint, durationKey) {
  const preset = DURATION_PRESETS[durationKey];
  durationHint.textContent = preset ? preset.rangeText : "";
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
  if (lastCard) lastCard.querySelector(".task-ticket").focus();
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
    if (!entry.ticket || !entry.ticket.trim()) {
      errors.push(`${label}: ticket is required.`);
    }
    if (!DURATION_PRESETS[entry.duration]) {
      errors.push(`${label}: pick a duration (1 Day, 1st Half, or 2nd Half).`);
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
      ticket: e.ticket.trim(),
      duration: e.duration,
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

function showConfirmation({ dateIso, count, offline, duplicate }) {
  el.formView.hidden = true;
  el.confirmationView.hidden = false;
  el.confirmHeading.textContent = offline ? "Worklog queued" : "Worklog saved";
  el.confirmDate.textContent = formatFullDate(dateIso);
  el.confirmCount.textContent = String(count);
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
  const payload = buildPayload(state.date, state.entries, submissionId);

  if (!navigator.onLine) {
    enqueuePending(payload);
    clearDraft(state.date);
    showConfirmation({ dateIso: state.date, count: state.entries.length, offline: true });
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
        duplicate: !!result.duplicate,
      });
    } else {
      showFormError((result && result.message) || "Could not save your worklog.");
    }
  } catch (err) {
    // Network-ish failure: queue it instead of losing the data.
    enqueuePending(payload);
    clearDraft(state.date);
    showConfirmation({ dateIso: state.date, count: state.entries.length, offline: true });
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
