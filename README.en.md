# Schedule Control Board

[繁體中文](./README.md) ・ **English** ・ [日本語](./README.ja.md) ・ [한국어](./README.ko.md)

A work-scheduling tool that lives in a single HTML file — tasks, meetings, recurring items, a month calendar and a Gantt chart, all in one file. Download it, open it in a browser, and it works.

> Pure front end. No dependencies, no install. No Node.js, no server, no database required.

## Getting started

### Option 1 — standalone (nothing to install)

1. Download [`public/index.html`](./public/index.html)
2. Open it in any modern browser

Data is stored in that browser's `localStorage` and survives a refresh.

### Option 2 — deploy to Cloudflare (multi-user + cross-device sync)

```bash
npm install
npx wrangler d1 create work-schedule-db   # skip if already created; put the id in wrangler.jsonc
npm run db:init                            # create tables
```

Create a Turnstile widget (bot protection):

```bash
npx wrangler turnstile widget create "work-schedule" --domain <your-domain> --domain localhost --domain 127.0.0.1 --mode managed
```

The command prints a **sitekey** (public — put it in `SITEKEY` in `public/login.html`) and a **secret**.
Then set two secrets:

```bash
npx wrangler secret put TURNSTILE_SECRET
```

```bash
npx wrangler secret put ADMIN_EMAILS
```

`ADMIN_EMAILS` is a comma-separated list of administrator emails. Accounts on that list **become approved administrators automatically on registration**.
Without it nobody can approve the first account and the system deadlocks.

> These two are secrets rather than `vars`: `vars` get committed to version control (a public repo would publish your email),
> and `vars` edited in the Dashboard are overwritten by the next `deploy`.

Finally, deploy:

```bash
npm run deploy
```

**When `TURNSTILE_SECRET` is unset, all registration and login is rejected** rather than allowed through — allowing it through would make bot protection meaningless.

Local development doesn't need real keys; `.dev.vars` already uses Cloudflare's official test keys (that file is gitignored).

### Deployment troubleshooting

**Registration or login returns Error 1101 (Worker threw exception)** — the PBKDF2 iteration cap in Workers production is 100,000; anything higher throws `NotSupportedError`, and **local workerd does not enforce this rule**, so it cannot be reproduced locally. Full symptoms, diagnosis and fix in
[Postmortem: registration always returned Error 1101](docs/postmortems/2026-07-30-register-error-1101.md).

## Features

### 📋 Schedule
- **Groups**: plain category labels (no dates); create, rename, delete
- **Items**: three types — 🟢 Task, 🟣 Meeting, 🟠 Assignment. All three can carry an optional time and a **link** (meeting URL, document, …) that opens straight from the list
- **Multi-day items**: non-recurring items can have an end date (e.g. a 22–26 Aug trip); every day in that span shows on the calendar, the done state is shared across the span, and an in-progress span is not counted as overdue
- Four range filters: year / quarter / month / specific date
- **Completed items collapse into a “Done” section** below; the top of the list only shows what still needs doing
- **Recurrence**: weekly / fortnightly (multiple weekdays), monthly (fixed day or “Nth weekday”), quarterly, yearly. Holidays can push the occurrence forward, pull it earlier, or be ignored; you can set an end date or a repeat count
- A single occurrence can be rescheduled or skipped without affecting the rest of the series
- Custom holiday list (weekends are already treated as holidays): **load the built-in public holidays in one click** (2026 is bundled, sourced from Taiwan's official government office calendar) or paste many dates at once
- **Search and filter** by keyword (title or group), type, and completion state

### 📅 Calendar
- Month grid with today clearly marked
- Meetings sorted by time; tasks and assignments can be ticked straight from the cell
- **On phones it follows the Google Calendar approach**: cells show only coloured dots for what's on that day, and tapping a date expands the full content below — cramming three or four lines of text into a 50px cell carries no usable information on a phone
- Tapping a date expands full item cards plus a **daily note** field (with formatting, see below)

### 📊 Projects (Gantt)
- Multiple projects; timeline bars with progress percentage and a today marker
- **The timeline scrolls horizontally** with four zoom levels (week / month / quarter / year), so long and cross-year projects stay readable; year boundaries are clearly marked and there's a one-click “Jump to today”
- Edit dates and progress directly in the task table; the chart updates immediately
- Each task can expand into **subtasks**; progress then follows the checklist automatically (the manual progress field becomes read-only)
- Projects are switched from a dropdown
- Project notes save automatically (with formatting, see below)

### ✍️ Formatting (daily notes and project notes)
- Bold, italic, underline, strikethrough; bulleted and numbered lists; highlight, text colour, text size; quote, link, code; and clear formatting
- The toolbar is **collapsed by default** — press `Ctrl+Shift+X` or use the button under the field; the preference is remembered on this device
- Content pasted from the web is cleaned automatically; only supported styles survive

### 🔔 Dashboard and reminders
- Live at the top: due today, due this week, today's meetings, overdue
- Today's outstanding items pop up when the page opens; the bell button carries an unread count
- **Light / dark** appearance toggle in the top right, following the system setting by default
- On phones the navigation is pinned to the bottom of the screen, and forms and dialogs are tuned for touch
- **English / Traditional Chinese** interface toggle in the top right, following the browser language by default

### 👥 Users and permissions (after deployment)
- Users register themselves with email + password; the registration page has Cloudflare Turnstile bot protection
- **Registration requires administrator approval**; unapproved accounts never receive a session
- Two roles: **user** (own schedule only) and **administrator** (can also manage accounts)
- Administrators can approve / reject / suspend / delete accounts and change roles; they **cannot see anybody's schedule content**
- Suspending or deleting an account signs that person out on every device immediately
- Passwords are stored as PBKDF2-SHA256 hashes (100,000 iterations, the Workers platform cap); plaintext is never stored
- Every account starts from a **blank interface** and sees nobody else's data

### 🔗 Sharing (after deployment)

- Press **🔗** on any item, **group (including all its items)** or project, and enter the other person's account email
- Two permissions: **can view** (read only) and **can edit** (tick items and subtasks, change progress)
- Renaming, changing dates and deleting are always owner-only
- What's shared is the same data rather than a copy, so both sides always see the same thing; the owner can revoke at any time
- Incoming shares live on the "Shared" page and never mix into your own schedule or calendar
- **Activity log**: who changed a shared item and when, kept for 90 days; the Shared tab shows an unread count and refreshes every minute while the page is open

### 💾 Autosave and cross-device sync
- Every change is written to `localStorage` immediately and survives a refresh
- Deploying to Cloudflare adds cloud sync: `localStorage` stays the primary store (instant, works offline) and the cloud syncs in the background
- When both sides changed, they are **merged item by item** (for example you are editing while a colleague ticks something you shared with them); you are only asked to choose when the *same* item changed on both sides
- Cloud writes use a database-level compare-and-swap, so simultaneous writes never silently discard somebody's changes
- Falls back automatically when no API is detected (standalone) or local storage is blocked (Claude Artifact sandbox), with no loss of function
- **The reason for falling back is distinguishable**: standalone is silent (there is no back end to begin with), but a back end that is temporarily unreachable says so — "Connection failed — using local data for now". If the two looked alike you would assume you were still syncing while changes stayed on this device
- **An unusable local save is backed up before being overwritten**: if the save is corrupt, or newer than the page you have open (which happens with a browser-cached older version), the original is moved to `workSchedule.v1.unreadable` instead of being replaced by demo data
- **Export / import backups**: dump everything to JSON from the page footer, or restore from a backup file
- **Add to your phone's home screen**: PWA support after deployment, and it opens offline
- **Calendar subscription (ICS)**: generate a private link and subscribe your schedule into Google or Apple Calendar — meetings carry their time, project tasks are date ranges, and it refreshes after every sync; the link can be regenerated or disabled at any time

## Technical notes

- The front end is a zero-dependency single HTML file (HTML + CSS + vanilla JavaScript) that runs on its own
- The only external resource is the Google Fonts CDN (JetBrains Mono + Noto Sans TC), **loaded without blocking rendering**: if the font hasn't arrived — or can't be reached at all — the page is painted with system fonts rather than sitting on a blank screen
- Ticking an item responds immediately; saving and cloud sync happen in the background
- Recurring items use an "occurrence engine": only the anchor date and the rule are stored, occurrences are expanded at render time, and per-occurrence adjustments are recorded on the parent item under an `occKey`
- The back end is a Cloudflare Worker + D1 with self-hosted email/password auth; sessions live in the database (hash only) so they can be revoked instantly

```
public/index.html      main app (single file, opens by double-click)
public/login.html      sign in / register (with Turnstile)
public/admin.html      account management (administrators only)
src/index.js           routing and access control
src/crypto.js          PBKDF2 password hashing, token generation
src/session.js         session create / lookup / destroy
src/turnstile.js       Turnstile siteverify
src/handlers/          auth / state / admin / share APIs
schema.sql             D1 tables
wrangler.jsonc         Worker config and bindings
tests/                 occurrence engine, three-way merge, optimistic locking, rich-text filter, variable shadowing (node:test, zero deps, npm test)
tools/                 smoke test, toggle-equivalence check, rich-text pipeline check (need Playwright, hence outside npm test)
                       + script that parses the official office calendar (yearly holiday updates)
public/sw.js           service worker (home screen / offline)
```

For the full architecture and data model see [`工作排程確認系統_專案說明.md`](./工作排程確認系統_專案說明.md) (Traditional Chinese).

## Known limitations

| Limitation | Detail |
|---|---|
| Standalone storage scope | Without deployment, data lives in *this browser only* and does not follow you across devices; clearing browser data clears it too |
| Sync conflicts | Merged item by item against the last synced content; you only choose a side when the same item changed on both |
| Holidays | Weekends are automatic. Public holidays are bundled only for years that have been officially published (currently 2026); other years can be pasted in bulk |
| Weekend work days | Supported: weekend dates added to the "work days" list count as working days, so recurrences are not pushed past them |
| Gantt | Bars cannot be dragged; dates are changed through the task table |
| Changing recurrence frequency | Switching monthly ↔ quarterly resets the per-occurrence done / override / skip records (you are warned before saving) |
