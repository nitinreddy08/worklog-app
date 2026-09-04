"use strict";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const CONFIG = {
  // Paste the Web App URL you get after deploying the Apps Script
  // (see google-apps-script/README.md). Leaving this unset lets you load
  // the app to look around, but Save will fail until it's configured.
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbxGT1o6Y19on0Xua1ovmjRBghsTqBV5tvi1zQa0xLgL74Sb3VmDcSkf0uqtmhkYrt2h/exec",
  // Optional. Only needed if you set API_SECRET in the Apps Script's
  // Script Properties. See google-apps-script/README.md for why this is
  // a weak, best-effort filter rather than real authentication.
  API_SECRET: "nitinreddyworklog",
  REQUEST_TIMEOUT_MS: 15000,
  LOG_PAGE_SIZE: 5,
};

const STORAGE_KEYS = {
  pendingQueue: "worklog_pending_queue",
  draftPrefix: "worklog_draft_",
};

/* ------------------------------------------------------------------ */
/* Date / time helpers (always local time, never UTC-shifted)          */
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

function formatShortDate(iso) {
  const d = parseISODateLocal(iso);
  return `${pad2(d.getDate())} ${MONTHS[d.getMonth()].slice(0, 3)}`;
}

// "02:00 PM" -> "14:00" (for <input type="time">); "14:00" passes through.
function to24h(text) {
  const m = String(text || "").trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return "";
  let h = Number(m[1]);
  if (m[3]) {
    h = h % 12;
    if (m[3].toUpperCase() === "PM") h += 12;
  }
  return `${pad2(h)}:${m[2]}`;
}

// "14:00" -> "2:00 PM" for display.
function to12h(text) {
  const hhmm = to24h(text);
  if (!hhmm) return String(text || "");
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad2(m)} ${period}`;
}

/* ------------------------------------------------------------------ */
/* Jira durations ("1d 5h") — mirrors Code.gs                          */
/* ------------------------------------------------------------------ */

const DURATION_UNITS = ["w", "d", "h", "m"];

function parseDuration(text) {
  const s = String(text || "").trim().toLowerCase();
  if (!s) return null;
  const total = { w: 0, d: 0, h: 0, m: 0 };
  const re = /(\d+)\s*([wdhm])/g;
  let match;
  let consumed = 0;
  while ((match = re.exec(s)) !== null) {
    total[match[2]] += Number(match[1]);
    consumed += match[0].length;
  }
  if (consumed === 0) return null;
  if (s.replace(/(\d+)\s*([wdhm])/g, "").replace(/\s+/g, "") !== "") return null;
  return total;
}

// Units stay separate on purpose: Jira's 1d is 8h, so hours are never
// folded into days — "5h" + "5h" is "10h", not "1d 2h".
function formatDuration(d) {
  const parts = DURATION_UNITS.filter((u) => d[u]).map((u) => `${d[u]}${u}`);
  return parts.length ? parts.join(" ") : "0m";
}

function sumDurations(texts) {
  const total = { w: 0, d: 0, h: 0, m: 0 };
  for (const t of texts) {
    const parsed = parseDuration(t);
    if (parsed) DURATION_UNITS.forEach((u) => { total[u] += parsed[u]; });
  }
  return formatDuration(total);
}

/* ------------------------------------------------------------------ */
/* Duration presets                                                     */
/* ------------------------------------------------------------------ */

// Mirrors DURATION_PRESETS in google-apps-script/Code.gs, which is the
// authority for what gets written to the sheet.
const DURATION_PRESETS = {
  "1d": { hint: "Starts 8:00 AM · logs 1d in Jira", start: "08:00", spent: "1d" },
  "1st-half": { hint: "Starts 8:00 AM · logs 5h in Jira", start: "08:00", spent: "5h" },
  "2nd-half": { hint: "Starts 2:00 PM · logs 5h in Jira", start: "14:00", spent: "5h" },
};

function formatJiraTotal(entries) {
  return sumDurations(entries.map((e) => (DURATION_PRESETS[e.duration] || {}).spent || ""))
    .replace(/^0m$/, "—");
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
  tab: "home",
  date: todayISO(),
  entries: [blankTask()],
  log: {
    page: 1,
    rows: [],
    total: 0,
    hasOlder: false,
    hasNewer: false,
    loading: false,
    loaded: false,
    stale: true,
    selected: new Set(),
  },
  editing: null,
};

/* ------------------------------------------------------------------ */
/* DOM references                                                      */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const el = {
  weekday: $("weekday"),
  fullDate: $("full-date"),
  dateBadge: $("date-badge"),
  changeDateBtn: $("change-date-btn"),
  logRefreshBtn: $("log-refresh-btn"),
  datePickerWrap: $("date-picker-wrap"),
  dateInput: $("date-input"),
  dateConfirmBtn: $("date-confirm-btn"),
  dateCancelBtn: $("date-cancel-btn"),
  offlineBanner: $("offline-banner"),
  syncBanner: $("sync-banner"),
  homePanel: $("home-panel"),
  formView: $("form-view"),
  entryCount: $("entry-count"),
  taskList: $("task-list"),
  addTaskBtn: $("add-task-btn"),
  formError: $("form-error"),
  totalDisplay: $("total-display"),
  saveBtn: $("save-btn"),
  saveBtnLabel: document.querySelector("#save-btn .btn-label"),
  taskTemplate: $("task-template"),
  confirmationView: $("confirmation-view"),
  confirmHeading: $("confirm-heading"),
  confirmDate: $("confirm-date"),
  confirmCount: $("confirm-count"),
  confirmTotal: $("confirm-total"),
  confirmNote: $("confirm-note"),
  doneBtn: $("done-btn"),
  tabs: Array.from(document.querySelectorAll(".tab")),
  logView: $("log-view"),
  logTotal: $("log-total"),
  logOffline: $("log-offline"),
  logError: $("log-error"),
  logBody: $("log-body"),
  logLoading: $("log-loading"),
  logEmpty: $("log-empty"),
  logOlder: $("log-older"),
  logNewer: $("log-newer"),
  logPageInfo: $("log-page-info"),
  logRowTemplate: $("log-row-template"),
  mergeBar: $("merge-bar"),
  mergeCount: $("merge-count"),
  mergeHint: $("merge-hint"),
  mergeBtn: $("merge-btn"),
  mergeClearBtn: $("merge-clear-btn"),
  editModal: $("edit-modal"),
  editTicket: $("edit-ticket"),
  editDate: $("edit-date"),
  editStart: $("edit-start"),
  editSpent: $("edit-spent"),
  editError: $("edit-error"),
  editSaveBtn: $("edit-save-btn"),
  editSaveLabel: document.querySelector("#edit-save-btn .btn-label"),
  editDeleteBtn: $("edit-delete-btn"),
  confirmModal: $("confirm-modal"),
  confirmModalText: $("confirm-modal-text"),
  confirmModalOk: $("confirm-modal-ok"),
  confirmModalOkLabel: document.querySelector("#confirm-modal-ok .btn-label"),
  toast: $("toast"),
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

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

let toastTimer = null;

function showToast(message, isError) {
  el.toast.textContent = message;
  el.toast.classList.toggle("is-error", !!isError);
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, isError ? 4200 : 2600);
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

function switchTab(tab) {
  state.tab = tab;
  const isHome = tab === "home";
  el.homePanel.hidden = !isHome;
  el.logView.hidden = isHome;
  el.changeDateBtn.hidden = !isHome;
  el.logRefreshBtn.hidden = isHome;
  el.tabs.forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", String(active));
  });
  if (!isHome && (state.log.stale || !state.log.loaded)) {
    loadLogPage(state.log.stale ? 1 : state.log.page);
  }
}

el.tabs.forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));
el.logRefreshBtn.addEventListener("click", () => loadLogPage(state.log.page));

/* ------------------------------------------------------------------ */
/* Home: rendering                                                     */
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

  state.entries.forEach((entry, index) => {
    const node = el.taskTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = entry.id;
    node.querySelector(".task-number").textContent = `Entry ${index + 1}`;

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
/* Home: task list actions                                             */
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
/* Home: date switching                                                */
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
  setDatePickerOpen(el.changeDateBtn.getAttribute("aria-expanded") !== "true");
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
    if (!normalizeTicket(entry.ticket)) errors.push(`${label}: ticket is required.`);
    if (!DURATION_PRESETS[entry.duration]) errors.push(`${label}: pick 1 Day, 1st Half, or 2nd Half.`);
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

function isConfigured() {
  return CONFIG.APPS_SCRIPT_URL && !CONFIG.APPS_SCRIPT_URL.startsWith("PASTE_");
}

function withTimeout(run) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
  return run(controller.signal).finally(() => clearTimeout(timer));
}

// Apps Script answers with JSON on success but can answer with an HTML
// page when the deployment is misconfigured; surface that clearly instead
// of a raw "Unexpected token <".
async function readJSONResponse(res) {
  if (!res.ok) throw new Error(`Server responded with ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error("The sheet script sent an unexpected response — check the Apps Script deployment (Execute as: Me, Access: Anyone).");
    err.name = "BadResponse";
    throw err;
  }
}

// One place to turn a thrown error into a sentence a user can act on.
function describeError(err) {
  if (!err) return "Something went wrong.";
  if (err.name === "AbortError") return "The sheet took too long to respond. Try again.";
  if (err.name === "BadResponse") return err.message;
  if (err.name === "TypeError") return "Could not reach the sheet. Check your connection.";
  return err.message || "Something went wrong.";
}

async function postJSON(body) {
  if (CONFIG.API_SECRET) body.apiSecret = CONFIG.API_SECRET;
  return withTimeout(async (signal) => {
    // Content-Type text/plain avoids a CORS preflight against the Apps
    // Script Web App (see google-apps-script/README.md troubleshooting).
    const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
      signal,
    });
    return readJSONResponse(res);
  });
}

async function getJSON(params) {
  const query = new URLSearchParams(params);
  if (CONFIG.API_SECRET) query.set("key", CONFIG.API_SECRET);
  return withTimeout(async (signal) => {
    const res = await fetch(`${CONFIG.APPS_SCRIPT_URL}?${query.toString()}`, { method: "GET", signal });
    return readJSONResponse(res);
  });
}

function buildCreatePayload(dateIso, entries, submissionId) {
  return {
    submissionId,
    date: dateIso,
    entries: entries.map((e) => ({ ticket: normalizeTicket(e.ticket), duration: e.duration })),
  };
}

/* ------------------------------------------------------------------ */
/* Home: save flow                                                     */
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
  const payload = buildCreatePayload(state.date, entries, submissionId);

  const finishLocally = (offline, duplicate) => {
    clearDraft(state.date);
    state.log.stale = true;
    showConfirmation({ dateIso: state.date, entries, offline, duplicate });
  };

  if (!navigator.onLine) {
    enqueuePending(payload);
    finishLocally(true, false);
    return;
  }

  setSaving(true);
  try {
    const result = await postJSON(payload);
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
/* Log tab: loading and rendering                                      */
/* ------------------------------------------------------------------ */

function rowKey(row) {
  return `${row.row}|${row.date}|${row.ticket}|${row.start}|${row.spent}`;
}

function setLogState({ loading, error }) {
  state.log.loading = !!loading;
  el.logLoading.hidden = !loading;
  el.logError.hidden = !error;
  if (error) el.logError.textContent = error;
  el.logRefreshBtn.disabled = !!loading;
}

async function loadLogPage(page) {
  if (!isConfigured()) {
    setLogState({ error: "The app isn't connected to Google Sheets yet." });
    return;
  }
  el.logOffline.hidden = navigator.onLine;
  if (!navigator.onLine) {
    setLogState({ loading: false });
    el.logBody.innerHTML = "";
    el.logEmpty.hidden = true;
    el.logOlder.disabled = true;
    el.logNewer.disabled = true;
    el.logPageInfo.textContent = "Offline";
    return;
  }

  setLogState({ loading: true });
  el.logEmpty.hidden = true;
  el.logBody.innerHTML = "";
  state.log.selected.clear();
  updateMergeBar();

  try {
    const result = await getJSON({ action: "list", page: String(page), pageSize: String(CONFIG.LOG_PAGE_SIZE) });
    if (!result || !result.success) {
      throw new Error((result && result.message) || "Could not load entries.");
    }
    // If the requested page is now past the end (e.g. after deletes), step back.
    if (result.rows.length === 0 && result.total > 0 && page > 1) {
      return loadLogPage(Math.max(1, Math.ceil(result.total / CONFIG.LOG_PAGE_SIZE)));
    }
    Object.assign(state.log, {
      page: result.page,
      rows: result.rows,
      total: result.total,
      hasOlder: result.hasOlder,
      hasNewer: result.hasNewer,
      loaded: true,
      stale: false,
    });
    setLogState({ loading: false });
    renderLog();
  } catch (err) {
    setLogState({ loading: false, error: describeError(err) });
  }
}

function renderLog() {
  const log = state.log;
  el.logTotal.textContent = String(log.total);
  el.logBody.innerHTML = "";
  el.logEmpty.hidden = log.total !== 0;

  log.rows.forEach((row) => {
    const node = el.logRowTemplate.content.firstElementChild.cloneNode(true);
    const key = rowKey(row);
    node.dataset.key = key;
    node.querySelector(".cell-date").textContent = formatShortDate(row.date);
    node.querySelector(".cell-weekday").textContent = formatWeekday(row.date).slice(0, 3);
    node.querySelector(".cell-ticket").textContent = row.ticket;
    node.querySelector(".cell-ticket").title = row.ticket;
    node.querySelector(".cell-start").textContent = to12h(row.start);
    node.querySelector(".cell-spent").textContent = row.spent;

    const check = node.querySelector(".row-check");
    check.checked = log.selected.has(key);
    node.classList.toggle("is-selected", check.checked);
    check.addEventListener("change", () => {
      if (check.checked) log.selected.add(key);
      else log.selected.delete(key);
      node.classList.toggle("is-selected", check.checked);
      updateMergeBar();
    });
    node.addEventListener("click", (event) => {
      if (event.target.closest(".col-check")) return;
      openEditModal(row);
    });
    el.logBody.appendChild(node);
  });

  const start = log.total === 0 ? 0 : (log.page - 1) * CONFIG.LOG_PAGE_SIZE + 1;
  const end = Math.min(log.total, log.page * CONFIG.LOG_PAGE_SIZE);
  el.logPageInfo.textContent = log.total === 0 ? "No entries" : `${start}–${end} of ${log.total}`;
  el.logOlder.disabled = !log.hasOlder || log.loading;
  el.logNewer.disabled = !log.hasNewer || log.loading;
  updateMergeBar();
}

el.logOlder.addEventListener("click", () => loadLogPage(state.log.page + 1));
el.logNewer.addEventListener("click", () => loadLogPage(Math.max(1, state.log.page - 1)));

/* ------------------------------------------------------------------ */
/* Log tab: selection and merge                                        */
/* ------------------------------------------------------------------ */

function selectedRows() {
  return state.log.rows.filter((row) => state.log.selected.has(rowKey(row)));
}

function updateMergeBar() {
  const rows = selectedRows();
  el.mergeBar.hidden = rows.length === 0;
  if (!rows.length) return;

  const tickets = new Set(rows.map((r) => r.ticket));
  const sameTicket = tickets.size === 1;
  el.mergeCount.textContent = `${rows.length} selected`;
  if (rows.length < 2) {
    el.mergeHint.textContent = "Tick one more row of the same ticket to merge.";
    el.mergeBtn.disabled = true;
  } else if (!sameTicket) {
    el.mergeHint.textContent = "Only entries of the same ticket can be merged.";
    el.mergeBtn.disabled = true;
  } else {
    el.mergeHint.textContent = `${rows[0].ticket} → ${sumDurations(rows.map((r) => r.spent))}`;
    el.mergeBtn.disabled = false;
  }
}

el.mergeClearBtn.addEventListener("click", () => {
  state.log.selected.clear();
  renderLog();
});

el.mergeBtn.addEventListener("click", () => {
  const rows = selectedRows();
  if (rows.length < 2) return;
  const total = sumDurations(rows.map((r) => r.spent));
  const earliest = rows.slice().sort((a, b) => (a.date + to24h(a.start)).localeCompare(b.date + to24h(b.start)))[0];
  openConfirm({
    text: `Merge ${rows.length} entries of ${rows[0].ticket} into one entry of ${total}, dated ${formatFullDate(earliest.date)} at ${to12h(earliest.start)}? The other rows will be removed from the sheet.`,
    okLabel: "Merge",
    onOk: async () => {
      const result = await postJSON({ action: "merge", targets: rows.map(toTarget) });
      if (result && result.success) {
        showToast(`Merged into ${result.timeSpent}`);
        await loadLogPage(state.log.page);
      } else {
        handleActionFailure(result);
      }
    },
  });
});

function toTarget(row) {
  return { row: row.row, date: row.date, ticket: row.ticket, start: row.start, spent: row.spent };
}

function handleActionFailure(result) {
  if (result && result.code === "stale") {
    showToast("That entry changed in the sheet — refreshed.", true);
    loadLogPage(state.log.page);
    return;
  }
  showToast((result && result.message) || "Something went wrong.", true);
}

/* ------------------------------------------------------------------ */
/* Modals                                                              */
/* ------------------------------------------------------------------ */

function openModal(modal) {
  el.toast.hidden = true; // don't let a lingering toast cover the sheet's buttons
  modal.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeModal(modal) {
  modal.hidden = true;
  if (el.editModal.hidden && el.confirmModal.hidden) document.body.style.overflow = "";
}

[el.editModal, el.confirmModal].forEach((modal) => {
  modal.querySelectorAll("[data-close]").forEach((btn) => btn.addEventListener("click", () => closeModal(modal)));
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!el.confirmModal.hidden) closeModal(el.confirmModal);
  else if (!el.editModal.hidden) closeModal(el.editModal);
});

let confirmHandler = null;

function openConfirm({ text, okLabel, onOk }) {
  el.confirmModalText.textContent = text;
  el.confirmModalOkLabel.textContent = okLabel || "Confirm";
  confirmHandler = onOk;
  openModal(el.confirmModal);
}

el.confirmModalOk.addEventListener("click", async () => {
  if (!confirmHandler) return;
  const handler = confirmHandler;
  const label = el.confirmModalOkLabel.textContent;
  el.confirmModalOk.disabled = true;
  el.confirmModalOkLabel.textContent = "Working…";
  try {
    await handler();
    confirmHandler = null; // done — only cleared on success so a failed attempt can be retried
    closeModal(el.confirmModal);
  } catch (err) {
    showToast(describeError(err), true);
  } finally {
    el.confirmModalOk.disabled = false;
    el.confirmModalOkLabel.textContent = label;
  }
});

/* Edit entry */

function openEditModal(row) {
  state.editing = row;
  el.editTicket.value = row.ticket;
  el.editDate.value = row.date;
  el.editStart.value = to24h(row.start);
  el.editSpent.value = row.spent;
  el.editError.hidden = true;
  openModal(el.editModal);
  el.editTicket.focus();
}

document.querySelectorAll("#edit-modal .quick-fill .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const preset = DURATION_PRESETS[chip.dataset.preset];
    if (!preset) return;
    el.editStart.value = preset.start;
    el.editSpent.value = preset.spent;
  });
});

function showEditError(message) {
  el.editError.textContent = message;
  el.editError.hidden = false;
}

el.editSaveBtn.addEventListener("click", async () => {
  const row = state.editing;
  if (!row) return;
  const changes = {
    ticket: normalizeTicket(el.editTicket.value),
    date: el.editDate.value,
    start: el.editStart.value,
    spent: el.editSpent.value.trim(),
  };
  if (!changes.ticket) return showEditError("Ticket is required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(changes.date)) return showEditError("Pick a date.");
  if (!to24h(changes.start)) return showEditError("Pick a start time.");
  if (!parseDuration(changes.spent)) return showEditError("Time spent must be in Jira format, e.g. 1d, 5h, 1d 5h, 30m.");
  changes.spent = formatDuration(parseDuration(changes.spent));

  const unchanged = changes.ticket === row.ticket && changes.date === row.date && to24h(changes.start) === to24h(row.start) && changes.spent === row.spent;
  if (unchanged) {
    closeModal(el.editModal);
    return;
  }

  el.editSaveBtn.disabled = true;
  el.editSaveLabel.textContent = "Saving…";
  el.editError.hidden = true;
  try {
    const result = await postJSON({ action: "update", target: toTarget(row), changes });
    if (result && result.success) {
      closeModal(el.editModal);
      showToast("Entry updated");
      await loadLogPage(state.log.page);
    } else if (result && result.code === "stale") {
      closeModal(el.editModal);
      handleActionFailure(result);
    } else {
      showEditError((result && result.message) || "Could not update the entry.");
    }
  } catch (err) {
    showEditError(describeError(err));
  } finally {
    el.editSaveBtn.disabled = false;
    el.editSaveLabel.textContent = "Save changes";
  }
});

// Enter in a text field of the editor saves, like a form would.
[el.editTicket, el.editSpent].forEach((input) => {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      el.editSaveBtn.click();
    }
  });
});

el.editDeleteBtn.addEventListener("click", () => {
  const row = state.editing;
  if (!row) return;
  openConfirm({
    text: `Delete ${row.ticket} on ${formatFullDate(row.date)} (${row.spent})? This removes the row from the sheet.`,
    okLabel: "Delete",
    onOk: async () => {
      const result = await postJSON({ action: "delete", target: toTarget(row) });
      if (result && result.success) {
        closeModal(el.editModal);
        showToast("Entry deleted");
        await loadLogPage(state.log.page);
      } else {
        closeModal(el.editModal);
        handleActionFailure(result);
      }
    },
  });
});

/* ------------------------------------------------------------------ */
/* Offline / sync banners                                              */
/* ------------------------------------------------------------------ */

function updateOfflineBanner() {
  el.offlineBanner.hidden = navigator.onLine;
  el.logOffline.hidden = navigator.onLine || state.tab !== "log";
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
      const result = await postJSON(payload);
      if (result && (result.success || result.duplicate)) {
        removeFromQueue(payload.submissionId);
        syncedCount++;
      }
    } catch (e) {
      break; // still unreachable — leave it queued and stop for now.
    }
  }

  if (syncedCount > 0) {
    state.log.stale = true;
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
  if (state.tab === "log") loadLogPage(state.log.page);
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
