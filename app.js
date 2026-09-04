"use strict";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const CONFIG = {
  // Paste the Web App URL you get after deploying the Apps Script
  // (see google-apps-script/README.md). Leaving this unset lets you load
  // the app to look around, but Save will fail until it's configured.
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbzEYltvkBywIVWwkG-RnrYGNEze1cLkWIGRP3hlMNVA8sm3OwsyHNyycE7afxVR8ill/exec",
  // Optional. Only needed if you set API_SECRET in the Apps Script's
  // Script Properties. See google-apps-script/README.md for why this is
  // a weak, best-effort filter rather than real authentication.
  API_SECRET: "nitinreddyworklog",
  REQUEST_TIMEOUT_MS: 15000,
  MAX_RECENT_TICKETS: 6,
};

const STORAGE_KEYS = {
  pendingQueue: "worklog_pending_queue",
  draftPrefix: "worklog_draft_",
  recentTickets: "worklog_recent_tickets",
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
// actual start time and Jira-format time spent. The client only needs
// display text plus the day/hour split for the running total.
const DURATION_PRESETS = {
  "1d": { hint: "Starts 8:00 AM · logs 1d in Jira", days: 1, hours: 0 },
  "1st-half": { hint: "Starts 8:00 AM · logs 5h in Jira", days: 0, hours: 5 },
  "2nd-half": { hint: "Starts 2:00 PM · logs 5h in Jira", days: 0, hours: 5 },
};

// Total in Jira notation, e.g. "1d 5h". Days and hours are kept separate
// on purpose: Jira treats 1d as 8h, so folding hours into days here would
// misstate what actually gets logged.
function formatJiraTotal(entries) {
  let days = 0;
  let hours = 0;
  for (const entry of entries) {
    const preset = DURATION_PRESETS[entry.duration];
    if (!preset) continue;
    days += preset.days;
    hours += preset.hours;
  }
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  return parts.length ? parts.join(" ") : "—";
}

function normalizeTicket(value) {
  return String(value || "").trim().toUpperCase();
}

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
  dateBadge: document.getElementById("date-badge"),
  changeDateBtn: document.getElementById("change-date-btn"),
  datePickerWrap: document.getElementById("date-picker-wrap"),
  dateInput: document.getElementById("date-input"),
  dateConfirmBtn: document.getElementById("date-confirm-btn"),
  dateCancelBtn: document.getElementById("date-cancel-btn"),
  offlineBanner: document.getElementById("offline-banner"),
  syncBanner: document.getElementById("sync-banner"),
  formView: document.getElementById("form-view"),
  entryCount: document.getElementById("entry-count"),
  taskList: document.getElementById("task-list"),
  addTaskBtn: document.getElementById("add-task-btn"),
  formError: document.getElementById("form-error"),
  totalDisplay: document.getElementById("total-display"),
  saveBtn: document.getElementById("save-btn"),
  saveBtnLabel: document.querySelector("#save-btn .btn-label"),
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
/* Local storage helpers                                               */
/* ------------------------------------------------------------------ */

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    /* storage unavailable — persistence is best-effort only */
  }
}

function removeKey(key) {
  try {
    localStorage.removeItem(key);
  } catch (e) {
    /* ignore */
  }
}

/* Draft persistence (per date) — protects against a closed tab/browser */

function draftKey(dateIso) {
  return STORAGE_KEYS.draftPrefix + dateIso;
}

function saveDraft() {
  writeJSON(draftKey(state.date), state.entries);
}

function loadDraft(dateIso) {
  const entries = readJSON(draftKey(dateIso), null);
  return Array.isArray(entries) && entries.length ? entries : null;
}

function clearDraft(dateIso) {
  removeKey(draftKey(dateIso));
}

/* Recent tickets — one-tap re-use of what you've logged before */

function getRecentTickets() {
  const list = readJSON(STORAGE_KEYS.recentTickets, []);
  return Array.isArray(list) ? list : [];
}

function rememberTickets(entries) {
  let recent = getRecentTickets();
  for (const entry of entries) {
    const ticket = normalizeTicket(entry.ticket);
    if (!ticket) continue;
    recent = [ticket].concat(recent.filter((t) => t !== ticket));
  }
  writeJSON(STORAGE_KEYS.recentTickets, recent.slice(0, CONFIG.MAX_RECENT_TICKETS));
}

/* ------------------------------------------------------------------ */
/* Rendering                                                            */
/* ------------------------------------------------------------------ */

function renderHeader() {
  el.weekday.textContent = formatWeekday(state.date);
  el.fullDate.textContent = formatFullDate(state.date);
  const isToday = state.date === todayISO();
  el.dateBadge.textContent = isToday ? "Today" : "Backdated";
  el.dateBadge.classList.toggle("is-backdated", !isToday);
}

function renderTaskList() {
  el.taskList.innerHTML = "";
  const recent = getRecentTickets();

  state.entries.forEach((entry, index) => {
    const node = el.taskTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = entry.id;
    node.querySelector(".task-number").textContent = `Entry ${index + 1}`;

    const ticketInput = node.querySelector(".task-ticket");
    const recentWrap = node.querySelector(".recent-tickets");
    const durationInputs = node.querySelectorAll(".task-duration-input");
    const durationHint = node.querySelector(".duration-time-hint");
    const removeBtn = node.querySelector(".remove-task-btn");

    ticketInput.value = entry.ticket;
    ticketInput.addEventListener("input", () => {
      entry.ticket = ticketInput.value;
      renderRecentChips(recentWrap, recent, entry, ticketInput);
      saveDraft();
    });
    renderRecentChips(recentWrap, recent, entry, ticketInput);

    durationInputs.forEach((input) => {
      input.name = `duration-${entry.id}`;
      input.checked = input.value === entry.duration;
      input.addEventListener("change", () => {
        entry.duration = input.value;
        updateDurationHint(durationHint, entry.duration);
        updateTotals();
        saveDraft();
      });
    });
    updateDurationHint(durationHint, entry.duration);

    removeBtn.addEventListener("click", () => removeTask(entry.id));
    removeBtn.disabled = state.entries.length === 1 && !entry.ticket && !entry.duration;

    el.taskList.appendChild(node);
  });

  updateTotals();
}

function renderRecentChips(wrap, recent, entry, ticketInput) {
  const current = normalizeTicket(entry.ticket);
  const options = recent.filter((t) => t !== current);
  wrap.innerHTML = "";
  if (!options.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  options.forEach((ticket) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = ticket;
    chip.addEventListener("click", () => {
      entry.ticket = ticket;
      ticketInput.value = ticket;
      renderRecentChips(wrap, recent, entry, ticketInput);
      saveDraft();
    });
    wrap.appendChild(chip);
  });
}

function updateDurationHint(durationHint, durationKey) {
  const preset = DURATION_PRESETS[durationKey];
  durationHint.textContent = preset ? preset.hint : "Pick how long you worked on it.";
}

function updateTotals() {
  el.entryCount.textContent = String(state.entries.length);
  el.totalDisplay.textContent = formatJiraTotal(state.entries);
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
  if (lastCard) {
    lastCard.querySelector(".task-ticket").focus();
    lastCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
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

function setDatePickerOpen(open) {
  el.changeDateBtn.setAttribute("aria-expanded", String(open));
  el.datePickerWrap.hidden = !open;
  if (open) {
    el.dateInput.value = state.date;
    el.dateInput.focus();
  }
}

el.changeDateBtn.addEventListener("click", () => {
  const expanded = el.changeDateBtn.getAttribute("aria-expanded") === "true";
  setDatePickerOpen(!expanded);
});

el.dateCancelBtn.addEventListener("click", () => setDatePickerOpen(false));

el.dateConfirmBtn.addEventListener("click", () => {
  if (!el.dateInput.value) return;
  switchToDate(el.dateInput.value);
  setDatePickerOpen(false);
});

el.addTaskBtn.addEventListener("click", addTask);

/* ------------------------------------------------------------------ */
/* Validation                                                           */
/* ------------------------------------------------------------------ */

function validateEntries(entries) {
  const errors = [];
  if (entries.length === 0) {
    errors.push("Add at least one entry.");
    return errors;
  }
  entries.forEach((entry, index) => {
    const label = `Entry ${index + 1}`;
    if (!normalizeTicket(entry.ticket)) {
      errors.push(`${label}: ticket is required.`);
    }
    if (!DURATION_PRESETS[entry.duration]) {
      errors.push(`${label}: pick 1 Day, 1st Half, or 2nd Half.`);
    }
  });
  return errors;
}

/* ------------------------------------------------------------------ */
/* Pending (offline) queue                                             */
/* ------------------------------------------------------------------ */

function readQueue() {
  const queue = readJSON(STORAGE_KEYS.pendingQueue, []);
  return Array.isArray(queue) ? queue : [];
}

function writeQueue(queue) {
  writeJSON(STORAGE_KEYS.pendingQueue, queue);
}

function enqueuePending(payload) {
  const queue = readQueue();
  queue.push(payload);
  writeQueue(queue);
}

function removeFromQueue(submissionId) {
  writeQueue(readQueue().filter((p) => p.submissionId !== submissionId));
}

/* ------------------------------------------------------------------ */
/* Network                                                              */
/* ------------------------------------------------------------------ */

function buildPayload(dateIso, entries, submissionId) {
  const payload = {
    submissionId,
    date: dateIso,
    entries: entries.map((e) => ({
      ticket: normalizeTicket(e.ticket),
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
  el.saveBtnLabel.textContent = isSaving ? "Saving…" : "Save Worklog";
}

function showConfirmation({ dateIso, entries, offline, duplicate }) {
  el.formView.hidden = true;
  el.confirmationView.hidden = false;
  el.confirmHeading.textContent = offline ? "Worklog queued" : "Worklog saved";
  el.confirmDate.textContent = formatFullDate(dateIso);
  el.confirmCount.textContent = String(entries.length);
  el.confirmTotal.textContent = formatJiraTotal(entries);
  if (offline) {
    el.confirmNote.hidden = false;
    el.confirmNote.textContent = "You're offline. This worklog is saved on your phone and will sync to the sheet automatically once you're back online.";
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
  const entries = state.entries.map((e) => ({ ...e, ticket: normalizeTicket(e.ticket) }));
  const payload = buildPayload(state.date, entries, submissionId);

  const finishLocally = (offline, duplicate) => {
    rememberTickets(entries);
    clearDraft(state.date);
    showConfirmation({ dateIso: state.date, entries, offline, duplicate });
  };

  if (!navigator.onLine) {
    enqueuePending(payload);
    finishLocally(true, false);
    return;
  }

  setSaving(true);
  try {
    const result = await postWorklog(payload);
    if (result && result.success) {
      finishLocally(false, !!result.duplicate);
    } else {
      showFormError((result && result.message) || "Could not save your worklog.");
    }
  } catch (err) {
    // Network-ish failure: queue it instead of losing the data.
    enqueuePending(payload);
    finishLocally(true, false);
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
    el.syncBanner.textContent = "Queued worklog saved to the sheet.";
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
