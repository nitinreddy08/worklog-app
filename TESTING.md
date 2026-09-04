# Testing checklist

Run through this after setup and after any change to `app.js` or
`Code.gs`. Check items off as you go.

## App shell

- [ ] 1. App opens (via deployed URL or installed icon).
- [ ] 2. Today's date automatically appears (weekday + full date).
- [ ] 3. "+ Add another task" adds a new task card.
- [ ] 4. Removing a task removes it (last remaining task resets to blank
      instead of disappearing entirely).
- [ ] 5. Tapping a duration option (1 Day / 1st Half / 2nd Half)
      highlights it and shows the matching time range underneath
      (e.g. "8:00 AM – 1:00 PM" for 1st Half).
- [ ] 6. Multiple tasks can be entered and edited independently.

## Validation

- [ ] 7. Saving with an empty ticket field shows an error and does not
      submit.
- [ ] 8. Saving without picking a duration shows an error and does not
      submit.

## Saving (online)

- [ ] 9. Save button shows "Saving…" and disables while in flight.
- [ ] 10. On success, the confirmation screen shows the correct date and
      entry count.
- [ ] 11. Rows appear correctly in the Google Sheet: one row per
      entry, in `Date | Ticket | Start Time | Time Spent` order, date as
      `YYYY-MM-DD`, start time as 12-hour AM/PM (`08:00 AM` for 1 Day
      and 1st Half, `02:00 PM` for 2nd Half), time spent in Jira format
      (`1d` for 1 Day, `5h` for either half).
- [ ] 12. Submitting a second, different ticket appends a further row
      without disturbing earlier ones.
- [ ] 13. A month heading (`SEPTEMBER 2026`, etc.) appears once per
      month, in capitals.
- [ ] 14. Exactly 3 blank rows separate one month's data from the next
      month's heading.
- [ ] 15. Submitting again for a month that already has a heading does
      **not** create a duplicate heading — it appends under the
      existing one.
- [ ] 16. Re-submitting the exact same worklog twice in a row (e.g.
      double-tapping Save, or the app auto-retrying) does not create
      duplicate rows — the second attempt returns "already saved."

## Ordering and one-row-per-worklog

- [ ] 17. Log a ticket as 1st Half today, save, then log the *same*
      ticket as 2nd Half today: the sheet shows **two** rows for it
      (`08:00 AM / 5h` and `02:00 PM / 5h`) — two Jira worklogs, never
      merged into one.
- [ ] 18. With a row for today already present, use "Log another date"
      to save an entry for an *earlier* date this month: it appears
      **above** today's row, not at the bottom of the section.
- [ ] 19. Two entries on the same date: the 8:00 AM one (1 Day or
      1st Half) sits above the 2:00 PM one (2nd Half).
- [ ] 20. Save again for a month that already has a heading, and then
      save once more: still exactly one `MONTH YYYY` heading and one
      header row for that month (no duplicates appearing on each save).

## Network failure & offline

- [ ] 21. Turn on Airplane Mode, then Save: the app shows the offline
      queued confirmation and does not lose the entered data.
- [ ] 22. Turn Airplane Mode back off: the queued worklog syncs
      automatically (watch the sheet update, or the brief "Worklog
      saved" banner).
- [ ] 23. Force a bad `APPS_SCRIPT_URL` (or stop the Apps Script
      deployment) and Save while online: the app shows "Could not save
      your worklog" with a way to retry, and the entered data is still
      there.
- [ ] 24. Closing the browser/app mid-entry (before saving) and
      reopening it on the same date restores the in-progress draft.

## Installation (Android/Chrome)

- [ ] 25. Chrome's "Add to Home screen" / "Install app" prompt is
      available for the deployed HTTPS URL.
- [ ] 26. After installing, launching from the home screen icon opens
      in standalone mode (no browser chrome/address bar).
- [ ] 27. The app icon on the home screen matches `icons/icon-192.png`.
- [ ] 28. The app stays in light mode even when the phone's system
      theme is set to dark.

## Layout

- [ ] 29. No horizontal scrolling and comfortable touch targets at a
      360px-wide viewport (e.g. Chrome DevTools device toolbar, small
      Android phone).
- [ ] 30. Same check at 430px width (larger phones) — layout should
      still look intentional, not stretched oddly.

## Previous-date entries

- [ ] 31. Tapping "Log another date" and picking yesterday's date lets
      you fill in and save a worklog for that date; the sheet row shows
      yesterday's date, in the correct month section.
