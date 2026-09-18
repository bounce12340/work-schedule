# Work Schedule

**English** ・ [繁體中文](./README.zh-TW.md) ・ [日本語](./README.ja.md) ・ [한국어](./README.ko.md)

A work-scheduling tool that lives in a single HTML file: tasks, meetings, recurring items, a month calendar and a Gantt chart, all in one file. Download it, open it in a browser, and it works.

> Pure front end. No dependencies, no install. No Node.js, no server, no database required.

## Getting started

### Option 1: standalone (nothing to install) — **retired**: since 2026-09-16 you must sign in; double-clicking the file only shows a sign-in gate

1. Download [`public/index.html`](./public/index.html)
2. Open it in any modern browser

Data is stored in that browser's `localStorage` and survives a refresh.

### Option 2: deploy to Cloudflare (multi-user + cross-device sync)

```bash
npm install
npx wrangler d1 create work-schedule-db   # skip if already created; put the id in wrangler.jsonc
npm run db:init                            # create tables
```

Create a Turnstile widget (bot protection):

```bash
npx wrangler turnstile widget create "work-schedule" --domain <your-domain> --domain localhost --domain 127.0.0.1 --mode managed
```

The command prints a **sitekey** (public, goes into `SITEKEY` in `public/login.html`) and a **secret** (confidential).
Then set two secrets:

```bash
npx wrangler secret put TURNSTILE_SECRET
```

```bash
npx wrangler secret put ADMIN_EMAILS
```

`ADMIN_EMAILS` is a comma-separated list of administrator emails. Accounts on that list **become approved administrators automatically on registration**.
Without it nobody can approve the first account and the system deadlocks.

> These two are secrets rather than `vars`: `vars` get committed to version control (in a public repo that means publishing your email),
> and `vars` edited in the Dashboard are overwritten by the next `deploy`.

**(Optional) overdue reminder emails.** To have the system email you when items are overdue, set two more secrets:

```bash
npx wrangler secret put AGENTMAIL_API_KEY    # account-level credential, looks like am_us_inbox_b1e2…
npx wrangler secret put AGENTMAIL_INBOX_ID   # the sending inbox, an email address such as you@agentmail.to
npx wrangler secret put APP_URL              # optional, used for the link inside the email
```

> These two are **very easy to mix up**: the API key's prefix says `inbox`, but it is the key, not the inbox id;
> the inbox id is the one that looks like an email address. When in doubt, ask the API:
>
> ```bash
> curl -H "Authorization: Bearer <the value you think is the key>" https://api.agentmail.to/v0/inboxes
> ```
>
> A 200 means that value is the API key, and `inboxes[].inbox_id` in the response is your `AGENTMAIL_INBOX_ID`.
>
> Without these, reminders simply do not run; nothing else is affected.

**Existing databases need the newest migration before deploying** (`schema.sql` cannot add columns to tables that already exist):

```bash
npx wrangler d1 execute work-schedule-db --remote --file=./migrations/010-mail-log.sql
```

Finally, deploy:

```bash
npm run deploy
```

**When `TURNSTILE_SECRET` is unset, all registration and login is rejected** rather than allowed through. Allowing it through would make bot protection meaningless.

### `.dev.vars` for local development

`wrangler dev` reads `.dev.vars` in the project root. **That file is gitignored and never enters version control.** Production values always go through `wrangler secret put`.

```
TURNSTILE_SECRET=<Cloudflare's official test key is fine; you don't need a real one locally>
ADMIN_EMAILS=<comma-separated, for local testing>
AGENTMAIL_API_KEY=<optional, only if you want to test email locally>
AGENTMAIL_INBOX_ID=<optional>
APP_URL=<optional>
```

> **Fully restart the dev server after editing `.dev.vars`.** `wrangler dev` reads that file once at startup,
> and its child process tree is hard to kill cleanly. An orphaned `workerd` keeps the port,
> which produces the confusing "source code hot-reloaded, but environment variables are stale" situation. Make sure the port is really free before restarting.

### Deployment troubleshooting

**Registration or login returns Error 1101 (Worker threw exception).** The PBKDF2 iteration cap in Workers production is 100,000; anything higher throws `NotSupportedError`, and **local workerd does not enforce this rule**, so it cannot be reproduced locally. Full symptoms, diagnosis and fix in
[Postmortem: registration always returned Error 1101](docs/postmortems/2026-07-30-register-error-1101.md) (Traditional Chinese).

## Features

### 📋 Schedule
- **Groups**: plain category labels (no dates); create, rename, delete
- **Items**: three types, 🟢 Task, 🟣 Meeting, 🟠 Assignment. All three can carry an optional time and a **link** (meeting URL, document, and so on) that opens straight from the list
- **Multi-day items**: non-recurring items can have an end date (for example a business trip from 22 to 26 Aug). The calendar draws them as one continuous colour bar across the span, like Google Calendar; the done state is shared across the span, and an in-progress span is not counted as overdue
- Four range filters: year / quarter / month / specific date
- **Completed items collapse into a "Done" section** below (expandable); the top of the list only shows what still needs doing
- **Recurrence**: weekly / fortnightly (multiple weekdays), monthly (fixed day or "Nth weekday"), quarterly, yearly. Holidays can push the occurrence forward, pull it earlier, or be ignored; you can set an end date or a repeat count
- A single occurrence can be rescheduled or skipped without affecting the rest of the series
- Custom holiday list (weekends are already treated as holidays): **load the built-in public holidays in one click** (2026 and 2027 are bundled, one button each, sourced from Taiwan's official government office calendar), or paste many dates at once
- **Tags**: an item can carry several (for example `#controlled-drugs` `#tender`); click one to see only that tag. Existing tags are offered as you create an item
- **Checklists**: to-do steps under an item. The row shows only `☑ 2/5`; open it to expand. Recurring items **share one checklist, but each occurrence is ticked separately**
- **Prerequisites**: mark "this has to be done first". While a prerequisite is unfinished the row shows `⛓ waiting`, and hovering tells you which item and which occurrence. **It only displays the state**: it never moves a date and never blocks you from ticking
- **Search and filter**: instant filtering by keyword (title, group or tag), type, tag, and completion state

### 📅 Calendar
- Month grid with today clearly marked
- Meetings sorted by time; tasks and assignments can be ticked straight from the cell
- **On phones it follows the Google Calendar approach**: cells show only coloured dots for what's on that day, and tapping a date expands the full content below. Cramming three or four lines of text into a 50px cell carries no usable information on a phone
- **Tapping a date** expands the full item cards plus a **daily note** field (with formatting, see below); nothing hangs below the grid until you select a date. Days that have a note carry a small `✎` mark in the top-right corner of the cell
- **Press and drag across several days** to select a range and create a multi-day item directly (trip, leave, project phase); the start and end dates are filled into the form
- **🌴 Away / 🏖️ Leave**: select a day or a range and press the button — a small panel opens where you pick the kind, the hours (leave both blank for the whole day), and, for leave, an icon. Away days get a faint hatch pattern and a 🌴; leave days get a tinted overlay across the whole cell. Time off no longer has to pretend to be a to-do item waiting to be ticked. **Overdue stays overdue, though**: the work was scheduled for that day, and your absence does not change its consequences. The one extra thing leave does is **stay quiet that day** — no reminder email, no push (away days still get both; you are still working)

### 📊 Projects (Gantt)
- Multiple projects; timeline bars with progress percentage and a today marker
- **The timeline scrolls horizontally** with four zoom levels (week / month / quarter / year), so long and cross-year projects stay readable; year boundaries are clearly marked and there's a one-click "Jump to today"
- Edit dates and progress directly in the task table; the chart updates immediately
- Each task can expand into **subtasks**; progress then follows the checklist automatically (the manual progress field becomes read-only)
- Projects are switched from a dropdown
- Project notes save automatically (with formatting, see below)

### ✍️ Formatting (daily notes and project notes)
- Bold, italic, underline, strikethrough; bulleted and numbered lists; highlight, text colour, text size; quote, link, code; and clear formatting
- The toolbar is **collapsed by default**; press `Ctrl+Shift+X` or use the button under the field to toggle it. The preference is remembered on this device
- Content pasted from the web is cleaned automatically; only supported styles survive

### 🔔 Dashboard and reminders
- Live at the top: due today, due this week, today's meetings
- Today's outstanding items pop up when the page opens; the bell button carries an unread count
- **Light / dark** appearance is switched on the "My account" page and follows the system setting by default
- **Two voices**: where a person is speaking (greeting, empty states, daily notes) the interface uses a serif face; where the machine reports numbers (dates, counts, **overdue**) it uses monospace. Overdue therefore stands out **more**, not less. The mood may be soft; the warning may not
- The backdrop is three soft halos over a paper grain that drift very slowly **and change colour with the time of day** (mossy green in the morning, golden in the afternoon, rose and indigo in the evening). Drifting stops when the system asks for reduced motion
- The daily-note prompt changes every day; ticking a box gives a small pop; **on Mondays a single line says "Last week you finished N things"**, and it only counts what got done
- On phones the navigation is pinned to the bottom of the screen, and forms and dialogs are tuned for touch

### 👥 Users and permissions (after deployment)
- Users register themselves with email + password; the registration page has Cloudflare Turnstile bot protection
- **Registration requires administrator approval**; unapproved accounts never receive a session
- Two roles: **user** (own schedule only) and **administrator** (can also manage accounts)
- Administrators can approve / reject / suspend / delete accounts and change roles; they **cannot see anybody's schedule content**
- Suspending or deleting an account signs that person out on every device immediately, without waiting for their next login
- Passwords are stored as PBKDF2-SHA256 hashes (100,000 iterations, the Workers platform cap); plaintext is never stored
- **Forgot password**: press "Forgot password?" on the sign-in page and the system emails a one-time link (valid for one hour, usable once); setting a new password signs out every device
- Repeated failed logins are throttled (sliding window, recovers on its own, no manual unlock needed)
- Every administrator action (approve / suspend / change role / reset password / delete) is logged, and every administrator can see the log
- Administrators can also reset a password from `/admin`, producing a temporary password shown exactly once
- Every account starts from a **blank interface** and sees nobody else's data

### 👤 My account
- The fifth tab on the main screen gathers account info, password change, overdue reminders, calendar subscription, signed-in devices, display preferences and backups
- **Signed-in devices**: see which devices you are signed in on and when each was last used, with one-click "Sign out all other devices" (keeps the current one); IP addresses are not recorded
- **Delete my account**: at the bottom of the tab; confirm with your password and the account, every schedule in the cloud, shares, calendar feed and reminder settings are gone (daily backups expire after 14 days). Works on the web and in the iOS app
- A device that has never signed in only sees the sign-in gate; a device that has signed in keeps working offline on local data
- **Free and Pro**: Free has no time limit but caps: up to 3 major projects and 3 projects, 5 AI requests a day. Pro lifts the caps (20 AI requests a day). When Pro lapses nothing is deleted; you just can't add more. Subscriptions are bought inside the iPhone app (not yet released) and the web shares the same one
- **Gamification**: a cherry tree that grows as your character (new shoot → branching → in bud → in bloom → petals falling → new shoot again, with a thicker trunk each round). On boot it plays a short growth animation up to your current stage — an overlay, not a gate: the page underneath stays clickable, it clears itself after about a second, and it never appears under `prefers-reduced-motion`. +10 XP per on-time completion, +30 for a perfect day (everything scheduled that day done on time), +100 per badge; streaks, 7→14→30-day challenges and a badge wall under "My account". Days with nothing scheduled neither count nor break the streak. Same for Free and Pro
- **Every password field has a show/hide eye**: sign-in, sign-up, forgot password, reset, the app's login screen, change password and delete account. The toggle is deliberately not remembered — it is back to hidden next time
- **The morning after a streak breaks, the tree writes to you** (switchable off under "My account"). Only on the day it breaks, at most once a day, and never for a streak under two days

### 📱 iOS app (free download, Pro subscription in-app)
- The same `index.html` is bundled into a native app (`mobile/`, Capacitor). Works offline; signs in with a token kept in the Keychain; the web version and the app share one account and one set of data
- Registering inside the app attaches Apple's purchase proof (StoreKit `AppTransaction`), verified offline by the Worker: no administrator approval, one purchase = one account. A 6-digit email code replaces Turnstile, which cannot run inside the app
- Building and uploading happen on GitHub's Mac runners (`.github/workflows/ios.yml`, manual trigger); no Mac required. Four repository secrets: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_API_KEY_P8`, `APPLE_TEAM_ID`. Set `APP_PURCHASE_ALLOW_SANDBOX=1` on the Worker while testing through TestFlight
- **Pro is an auto-renewing subscription bought inside the app** (StoreKit 2). Prices always come from StoreKit, never hard-coded. The subscription screen carries the price, the renewal terms, a Restore purchase button and links to the terms and privacy policy — all four are App Review requirements
- Entitlements are written by two paths: the app pushes its transactions (at launch, on purchase, on restore) and Apple's **server notifications** keep the expiry current for people who renew but only ever use the web. Expiry only moves forward, except refunds
- **Push notifications** (APNs): overdue/upcoming, the tree's message when a streak breaks, and an optional "you have N things today". Each has its own switch, independent of the emails. Nothing is sent on quiet days. Three Worker secrets: `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_P8`
- A public [privacy policy](./public/privacy.html) is served at `/privacy.html`

### 💾 Automatic backups and reminders (after deployment)
- Every day all schedules are backed up to Cloudflare R2, keeping the latest 14 copies (**password hashes excluded**; after a restore everyone resets through "Forgot password")
- Overdue reminder emails are **on by default**, with a configurable **lead time** (default 3 days; can also be set to overdue-only or turned off)
- The admin page lists the backups (date, size, number of schedules) and has a button to run one right now
- The admin page also lists **every email the system sent in the last 30 days**, grouped by kind, with the provider's error text on the failures. Password resets and verification codes are marked as transactional — those are the ones a user is actively waiting for
- When nothing is overdue and nothing is coming due, no email is sent at all — and the same rule applies to push notifications

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
- Falls back automatically when no API is detected (standalone) or local storage is blocked (Claude Artifact sandbox), with no loss of function
- **The reason for falling back is distinguishable**: standalone is silent (there is no back end to begin with), but a back end that is temporarily unreachable says so: "Connection failed, using local data for now". If the two looked alike you would assume you were still syncing while changes stayed on this device
- **An unusable local save is backed up before being overwritten**: if the save is corrupt, or newer than the page you have open (which happens with a browser-cached older version), the original is moved to `workSchedule.v1.unreadable` instead of being replaced by demo data
- **Export / import backups**: dump everything to JSON from the page footer, or restore from a backup file
- **Add to your phone's home screen**: PWA support after deployment; it opens from the home-screen icon and works offline
- **Overdue reminder emails**: when enabled, an email goes to your registered address whenever unfinished items are overdue; **nothing is sent when nothing is overdue** (a daily "you have nothing overdue" only teaches people to ignore the sender). Never twice in one day, and items due today are not overdue
- **Calendar subscription (ICS)**: generate a private link and subscribe your schedule into Google or Apple Calendar. Meetings carry their time, project tasks are date ranges, and it refreshes after every sync; the link can be regenerated or disabled at any time

## Technical notes

- The front end is a zero-dependency single HTML file (HTML + CSS + vanilla JavaScript) that runs on its own
- The only external resource is the Google Fonts CDN (JetBrains Mono + Noto Sans TC + Noto Serif TC), **loaded without blocking rendering**: if the font hasn't arrived, or can't be reached at all, the page is painted with system fonts rather than sitting on a blank screen
- Ticking an item responds immediately; saving and cloud sync happen in the background. Ticking also **does not rebuild the whole list**, it only moves that one row. The year view routinely holds thousands of rows, and rebuilding them all froze the page for seconds (measured: 300 items, 5.5 s → 0.08 s)
- Cloud writes use a database-level compare-and-swap as an optimistic lock, so simultaneous writes never silently discard somebody's changes
- Recurring items use an "occurrence engine": only the anchor date and the rule are stored, occurrences are expanded at render time, and per-occurrence adjustments are recorded on the parent item under an `occKey`
- The back end is a Cloudflare Worker + D1 with self-hosted email/password auth; sessions live in the database (token hash only) so they can be revoked instantly

```
public/index.html      main app (single file, zero dependencies; shows the sign-in gate when not signed in)
public/login.html      sign in / register (with Turnstile)
public/admin.html      account management (administrators only)
src/index.js           routing and access control
src/crypto.js          PBKDF2 password hashing, token generation
src/session.js         session create / lookup / destroy
src/turnstile.js       Turnstile siteverify
src/handlers/          auth / state / admin / share APIs
schema.sql             D1 tables
wrangler.jsonc         Worker config and bindings
tests/                 occurrence engine, three-way merge, optimistic locking, rich-text filter, variable shadowing,
                       prerequisites and away/leave (node:test, zero deps, npm test)
tools/                 smoke test, toggle-equivalence check, rich-text pipeline check, calendar / notes / contrast /
                       prerequisites/away/leave checks (need Playwright, hence outside npm test)
                       + script that parses the official office calendar (yearly holiday updates)
public/sw.js           service worker (home screen / offline)
```

For the full architecture and data model see [`工作排程確認系統_專案說明.md`](./工作排程確認系統_專案說明.md) (Traditional Chinese).

## Known limitations

| Limitation | Detail |
|---|---|
| Sign-in required | A device that has never signed in only sees the gate; a signed-in device works offline on local data |
| Free plan caps | Up to 3 major projects and 3 projects, 5 AI requests a day; Pro is unlimited. Lapsing deletes nothing, you just can't add more |
| Standalone storage scope | Without deployment, data lives in *this browser only* and does not follow you across devices; clearing browser data clears it too |
| Sync conflicts | Merged item by item against the last synced content; you only choose a side when the same item changed on both |
| Holidays | Weekends are automatic. Public holidays are bundled only for years that have been officially published (currently 2026 and 2027); other years can be pasted in bulk |
| Prerequisites | Display only: they never move a date and never block ticking. At most five prerequisites per item |
| FYI-only items | A `noticeOnly` item is just a placeholder: no checkbox, **never overdue**, and excluded from the four metric cards, the done section, the scope counts and your tree. It still shows up in the calendar feed; no reminder email and no push |
| "Away" and "Leave" | Only a mark on the calendar and the row: they move no dates and **do not affect overdue** or the calendar subscription. The single difference: **on a leave day no email and no push go out at all**, while the red overdue text on screen stays exactly as it is |
| Weekend work days | Supported: weekend dates added to the "work days" list count as working days, so recurrences are not pushed past them |
| Gantt | Bars cannot be dragged; dates are changed through the task table |
| iOS app | Free download, Pro is an in-app auto-renewing subscription; one Apple ID = one account. Every front-end release needs a new build submitted to the App Store. Public registration happens only inside the app |
| Changing recurrence frequency | Switching monthly ↔ quarterly resets the per-occurrence done / override / skip records (you are warned before saving) |
