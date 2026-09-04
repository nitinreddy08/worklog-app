# Testing checklist

Run through this after setup and after any change to `app.js` or
`Code.gs`. Check items off as you go.

## App shell

- [ ] 1. App opens (via deployed URL or installed icon).
- [ ] 2. Today's date automatically appears (weekday + full date).
- [ ] 3. "+ Add another task" adds a new task card.
- [ ] 4. Removing a task removes it (last remaining task resets to blank
      instead of disappearing entirely).
- [ ] 5. Start/End time pickers open the native Android time picker.
- [ ] 6. Duration is calculated automatically and shown per task.
- [ ] 7. Multiple tasks can be entered and edited independently.
- [ ] 8. The "Total" at the bottom updates live as tasks change.

## Validation

- [ ] 9. Saving with an empty description shows an error and does not
      submit.
- [ ] 10. Saving with a missing start or end time shows an error.
- [ ] 11. Entering an end time before the start time shows "End time must
      be after start time" on that task and blocks save.

## Saving (online)

- [ ] 12. Save button shows "Saving…" and disables while in flight.
- [ ] 13. On success, the confirmation screen shows the correct date,
      entry count, and total.
- [ ] 14. Rows appear correctly in the Google Sheet: one row per task,
      in `Date | Start Time | End Time | Duration | Work Description`
      order.
- [ ] 15. Submitting a second, different worklog appends further rows
      without disturbing earlier ones.
- [ ] 16. A month heading (`SEPTEMBER 2026`, etc.) appears once per
      month, in capitals.
- [ ] 17. Exactly 3 blank rows separate one month's data from the next
      month's heading.
- [ ] 18. Submitting again for a month that already has a heading does
      **not** create a duplicate heading — it appends under the
      existing one.
- [ ] 19. Re-submitting the exact same worklog twice in a row (e.g.
      double-tapping Save, or the app auto-retrying) does not create
      duplicate rows — the second attempt returns "already saved."

## Network failure & offline

- [ ] 20. Turn on Airplane Mode, then Save: the app shows the offline
      queued confirmation and does not lose the entered data.
- [ ] 21. Turn Airplane Mode back off: the queued worklog syncs
      automatically (watch the sheet update, or the brief "Worklog
      saved" banner).
- [ ] 22. Force a bad `APPS_SCRIPT_URL` (or stop the Apps Script
      deployment) and Save while online: the app shows "Could not save
      your worklog" with a way to retry, and the entered data is still
      there.
- [ ] 23. Closing the browser/app mid-entry (before saving) and
      reopening it on the same date restores the in-progress draft.

## Installation (Android/Chrome)

- [ ] 24. Chrome's "Add to Home screen" / "Install app" prompt is
      available for the deployed HTTPS URL.
- [ ] 25. After installing, launching from the home screen icon opens
      in standalone mode (no browser chrome/address bar).
- [ ] 26. The app icon on the home screen matches `icons/icon-192.png`.

## Layout

- [ ] 27. No horizontal scrolling and comfortable touch targets at a
      360px-wide viewport (e.g. Chrome DevTools device toolbar, small
      Android phone).
- [ ] 28. Same check at 430px width (larger phones) — layout should
      still look intentional, not stretched oddly.

## Previous-date entries

- [ ] 29. Tapping "Log another date" and picking yesterday's date lets
      you fill in and save a worklog for that date; the sheet row shows
      yesterday's date, in the correct month section.
