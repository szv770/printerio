# Admin dashboard plan: how it should look and what it should offer

Written 2026-11-19. A design plan only: nothing here is built. Sources read: `apps/web/lib/nav.ts`, `components/shell/AdminNav.tsx`,
`app/admin/layout.tsx`, `app/platform/layout.tsx`, every `app/admin/*/page.tsx`, `lib/admin-setup-checklist.ts`, `lib/admin/tabs.ts`,
`docs/FEATURES.md`, `ROADMAP.md`, `SAAS-LAUNCH-PLAN.md`, `TARGET-ARCHITECTURE.md`, `REQUEST-BUDGET.md`.
Where a claim is about behaviour I did not read in code, it says "not checked".

The goal in the owner's words: the most options possible, kept neat; plain language; good enough to show other schools and companies;
the site keeps working when every print server is down.

---

## 1. What exists today

### 1a. Pages

Roles: **Admin** = `org_admin`. **Approver** = `approver`. The admin layout (`app/admin/layout.tsx`) lets both in; each page then
narrows it. **Platform owner** = super admin (`requirePlatformRole`).

| Route | What it does (one line) | Who |
|---|---|---|
| `/admin` | Overview: "Hi, name", setup card until done, problems first (approvals, offline servers, printers in error), recent jobs. Refreshes itself every 30 s | Admin, approver |
| `/admin/approvals` | Yes/no on jobs that a rule held | Admin, approver |
| `/admin/jobs` | All jobs in the school; status filter pills and a search box (user or file) | Admin, approver |
| `/admin/users` | Everyone in the school: change role, department, print code | Admin, approver (edit rights: not checked) |
| `/admin/users/[userId]` | One person's page (opened from the table; no menu entry) | Admin, approver |
| `/admin/groups` | Departments or classes, used by rules and limits | Admin, approver |
| `/admin/invites` | Create and switch off invite links | Admin only |
| `/admin/printers` | Printers and their finishing profiles (queues) | Admin, approver (manage = admin) |
| `/admin/printers/setup` | Guided printer setup wizard (no menu entry; reached from Printers) | Admin only |
| `/admin/agents` and `/admin/agents/[agentId]` | "Print servers": the Windows computers; poll speed, update button, detail page | Admin, approver (manage = admin) |
| `/admin/devices` | Every phone and laptop set up to print; setup-status panel | Admin only |
| `/admin/policies` | Print rules: needs approval / not allowed | Admin, approver (manage = admin) |
| `/admin/quotas` | Monthly limits per person or group | Admin, approver (manage: not checked) |
| `/admin/reports` | Usage by user, department, printer, month; CSV export buttons | Admin, approver |
| `/admin/audit` | Activity log ("what happened") | Admin only |
| `/admin/settings` | Four sections: Who can join, Printing defaults, Print stamp, Admin exceptions | Admin, approver (save rights: not checked) |
| `/admin/storage` | How long files are kept (retention days) and what is stored | Admin in the menu; page itself allows approver too |
| `/admin/fonts` | Upload Hebrew/English fonts for booklets | Admin in the menu; page itself allows approver too |
| `/platform` | Platform overview: totals, every school with member/printer/server/job counts, "Join as admin" button | Platform owner |
| `/platform/organizations/new` | Create a school | Platform owner |
| `/platform/super-admins` | Add or remove platform owners | Platform owner |

Related pages an admin also uses but that are not "admin": `/print`, `/jobs` (My jobs), `/usage`, `/devices` (My devices), `/profile`.

### 1b. How an admin moves around today

- One shell for admins and approvers (`AppShell` -> `AdminNav`). The shell is chosen by role, not by URL (`resolveShell` in `lib/nav.ts`),
  so an admin keeps the same menu on `/print` and `/jobs`.
- **Desktop (md and up):** a sticky 240 px left sidebar. **Phone:** a slim top bar (menu button, logo, "N to approve" badge, "+ Print")
  and a slide-over drawer with the same menu. Escape, backdrop and any navigation close it.
- **Menu** (`adminMenu` in `lib/nav.ts`), top to bottom: a "Print a document" button; an always-open block (Overview, My jobs,
  All jobs, Approvals with count); then fold-away groups **People** (Users, Groups), **Printers & devices** (Printers, Print servers,
  All devices*), **Rules & limits** (Print rules, Monthly limits), **Reports** (Usage reports, Activity log*), **Settings**
  (General, Files & storage*, Fonts*), **My account** (My usage, My devices, Profile). `*` = admin only. The group holding the
  current page opens itself.
- Footer: Platform console (super admins), About Printio, Help (glossary, tour switched off), Install app, user chip.
- **Second layer:** pages with siblings show tabs under the title (`lib/admin/tabs.ts`): People = Users / Groups / Invites;
  Printers and devices = Printers / Print servers / All devices; Rules and limits = Print rules / Monthly limits; Usage / Activity log.
  So Invites is in a tab but not in the menu, and Activity log is both a menu item and a tab.
- **Platform console** (`app/platform/layout.tsx`) is a separate, simpler shell: three links in a wrapped row on a phone, a 192 px column
  on desktop, "Back to app", Sign out. Deliberately a sibling of `/admin` so the two guards never mix.
- Heavy admin pages (reports, audit, storage, users, servers, approvals) are excluded from link prefetching to save requests
  (`shouldPrefetchNavHref`).

---

## 2. Problems today

| # | Problem | Where | Why it hurts |
|---|---|---|---|
| 1 | **No way to search for a setting.** Settings are spread over 18 pages plus tabs; a person who wants "how long are files kept?" must guess "Files & storage" | `lib/nav.ts` | Hard to find, and gets worse as options grow |
| 2 | **Same word, two names.** The menu says "Print servers"; the setup checklist, docs and code say "Agent" ("Register the Windows Print Agent"); the printers page talks about "queues" and "profiles" | `lib/admin-setup-checklist.ts` vs `AdminNav` | A non-technical admin meets three words for one thing |
| 3 | **Setup checklist has developer text.** A step tells the admin to run "the Agent's register command" and cites `docs/agent-install.md`, a repo path the school cannot open | `lib/admin-setup-checklist.ts` | First-run fails exactly where the school is least able to help itself |
| 4 | **First run is thin.** A brand-new school sees the checklist (good), but its first step needs a Windows PC and a command-line command, and nothing in the page says "this is the one thing that needs help, press here to ask". Other steps: not blocked while waiting | `lib/admin-setup-checklist.ts`, `app/admin/page.tsx` | The owner hand-holds the first schools; later schools cannot |
| 5 | **Hidden pages.** Invites exists only as a tab; Guided printer setup and a person's detail page have no menu entry; People/Printers/Rules/Reports each show both a menu group and a tab strip with the same items | `lib/nav.ts`, `lib/admin/tabs.ts` | Two ways to navigate the same list; a new admin does not know a tab exists |
| 6 | **Menu vs page rights disagree.** Files & storage and Fonts are hidden from approvers in the menu, but their pages allow `["org_admin","approver"]`; Print rules, Printers, Servers, Quotas, Settings are visible to approvers with "manage" flags on the page | `lib/nav.ts` vs `app/admin/storage/page.tsx`, `fonts/page.tsx` | Approvers can reach pages by URL that the menu says they should not see. Not checked: whether the actions themselves also refuse |
| 7 | **Rules and limits split from People.** A "limit for a group" needs Groups, Quotas and Policies, three places | menu groups People and Rules & limits | Admin builds a rule without seeing who it touches |
| 8 | **Reports and Activity log are two ideas in one group.** "Usage reports" is cost/volume; "Activity log" is security/audit; Activity log is admin-only and appears twice | `lib/nav.ts`, `tabs.ts` | Confusing; no single place to export or search history |
| 9 | **Phone use: the menu is long.** Seven groups and about 18 items in a drawer; pages with tables rely on `ResponsiveTable` (good), but the nav has no search and no "most used" shortcut. The platform console has no drawer and its wrapped link row does not scale past three items | `AdminNav.tsx`, `platform/layout.tsx` | Phone is where approvals actually happen; they are reachable (header badge) but little else is quick |
| 10 | **Overview is "problems first", which reads empty when healthy.** It refreshes every 30 s on any visible tab (a budget cost, see section 3) and has no "what changed since I last looked" | `app/admin/page.tsx` | A calm school sees a page of zeros; a busy admin cannot tell what is new |
| 11 | **No notifications.** Email alerts for offline server / printer problem / new approval are only on the roadmap | `docs/ROADMAP.md` | Admin must open the site to find out |
| 12 | **No in-app "report a problem" or support link for admins.** Help is a glossary; the tour is off. The plan lists "report a problem with logs" as a to-do | `HelpMenu.tsx`, `SAAS-LAUNCH-PLAN.md` risk 12 | Support load lands on the owner by text message |
| 13 | **No branding, no billing/plan page, no data export beyond reports CSV.** Not shown to a school evaluating the product | none exist in `app/admin` | A second school asks "where do I put our logo / see our plan / take our data with us?" |
| 14 | **Print servers down is not framed.** The checklist and print server page report it, but nothing on the Overview says in one banner which actions need the server and which do not | `app/admin/page.tsx` | The owner's rule (the site works with servers off) is true in design but invisible to the admin |
| 15 | **Platform console is thin for many schools:** a list of schools and a create form; no search, no per-school status beyond counts, no way to see which school is behind on setup | `app/platform/page.tsx` | Fine for 1-3 schools; not for 10-15 |

---

## 3. Proposed information architecture

### 3a. Seven sections (admin menu)

Names are plain words a school secretary would use. Sections hold what the code already has plus what section 4 adds.

| # | Section | Holds | Replaces today |
|---|---|---|---|
| 1 | **Home** | Overview, setup checklist (until done), "needs you" list, what changed, server banner | `/admin` |
| 2 | **Jobs** | All jobs, Approvals (with count), Held jobs, history search and export | All jobs + Approvals |
| 3 | **People** | Users, Groups, Invites and join rules (one tab each, Invites finally in the menu) | People group + `/admin/invites` |
| 4 | **Printers** | Printers, Print servers, Devices, Printer setup wizard, Fonts (for booklets) | Printers & devices + Fonts |
| 5 | **Rules** | Print rules, Monthly limits, Approval settings: shown as one page with "who it affects" beside each rule | Rules & limits |
| 6 | **Reports** | Usage, Cost recovery, Activity log (audit), Exports | Reports group |
| 7 | **Settings** | School profile and branding, Who can join, Printing defaults, Print stamp, Files and privacy, Notifications, Plan and billing, Help and support | Settings group + Files & storage |

Footer (unchanged idea): **Print** button on top, "My account" (profile, my usage, my devices) in the user menu instead of a menu group,
Platform console for platform owners, Help.

Why seven and not eighteen: today's 18 menu items fold into 7 sections with tabs inside; every old route still works (redirect or tab).
"My account" leaves the admin menu because it is the same for every role.

### 3b. Left navigation wireframe

```
+--------------------------+
|  [logo]  Printio         |
|  [ + Print a document ]  |
|  ( Search settings...  / ) |   <- opens search (press / or Ctrl+K)
|--------------------------|
|  Home                    |
|  Jobs              (3)   |   <- 3 jobs need a yes/no
|  People                  |
|  Printers          !     |   <- ! = something needs a look
|  Rules                   |
|  Reports                 |
|  Settings                |
|--------------------------|
|  Platform console        |   <- platform owners only
|  Help & support          |
|  Install app             |
|  [AB] Anna B.  Admin  v  |   <- profile, my usage, my devices, sign out
+--------------------------+
Approver sees: Home, Jobs, People (view), Printers (view), Reports. No Rules/Settings edit.
Staff/student: no admin menu (member header, unchanged).
Phone: same list in the drawer; top bar keeps [menu] [logo] [3 to approve] [+ Print].
```

### 3c. Home / overview wireframe

```
+--------------------------------------------------------------------+
| Good morning, Anna.                       [ Search settings ]        |
+--------------------------------------------------------------------+
| (Only until finished)  Get set up: 3 of 6 done  [=====>    ]         |
|   [x] Add your school name    [x] Invite your first person           |
|   [ ] Connect a print server  -> [ Ask for help ]  [ Show me how ]   |
|   [ ] Add a printer  [ ] Test print  [ ] Choose your rules           |
+--------------------------------------------------------------------+
| Print server: Online (checked 12 s ago)     <- or, when it is down:  |
| "Your print server is offline. People can still sign in and send    |
|  jobs; they will print when it is back. Needs the server: new       |
|  uploads, viewing files."   [ What to check ]                        |
+----------------------+----------------------+----------------------+
| NEEDS YOU            | THIS MONTH           | WHAT CHANGED         |
| 3 jobs to approve    | 4,210 pages          | Today 9:12 Rule "No  |
| Printer 2: paper out | 61% of school limit  |  colour" turned on   |
| 2 people waiting     | Top printer: Lobby   | Today 8:40 Dan joined|
| for an invite        | [ See reports ]      | [ See activity log ] |
+----------------------+----------------------+----------------------+
| RECENT JOBS   [All jobs]                                             |
|  Dan  Quiz.pdf  Printed   9:20   |  Ruth  Menu.pdf  Held  9:05       |
+--------------------------------------------------------------------+
Empty "Needs you" says: "Nothing needs you. Last checked just now."
```

Refresh rule: Home refreshes on page load and when the tab becomes visible again, plus a **manual "Refresh" button**; the 30 s
auto-refresh drops to 60 s and stops after 10 minutes of the tab being open (see budget note below).

### 3d. Rules that keep many options neat

| Rule | What it means in practice |
|---|---|
| **Basic first, Advanced folded** | Every page shows the 3-5 common choices; the rest sit under one "Advanced" fold that remembers if you opened it. The Settings page already folds sections (its description says "Open a section"); make that the pattern everywhere |
| **Settings search** | One box (press `/`) searches a fixed list of setting names and synonyms ("toner", "logo", "file retention", "who can join") and jumps to the exact section with it highlighted. A static list in code, so it costs no database or extra requests |
| **Sensible defaults** | A new school starts with: invite-only, 30-day file retention (today's value to be confirmed in `lib/retention`), one default rule set, notifications on for "printer needs help". A "Restore defaults" link per section |
| **Empty states give the next step** | Every empty list says what it is and has one button: "No groups yet. Groups let one rule cover a whole class. [Create a group]" |
| **Setup checklist** | Six plain steps with progress, "Ask for help" and "Show me how" on the hard one (see section 5). Hides itself when done, reachable again from Help |
| **One page layout** | Title, one sentence of help, tabs (only if the section has siblings), a primary action at top right, filters row, table or cards. The existing `PageHeader`, `Tabs`, `ResponsiveTable`, `EmptyState` components already do most of this |
| **Role-aware menus** | The menu is built from the role; a page the role cannot use is not in the menu and the route refuses it (fix the section-2 problem 6 mismatch). Read-only pages for approvers say "View only" |
| **Safe by default** | Dangerous actions (remove a person, turn off a server, delete a printer, shorten retention, change who can join) ask with a plain sentence about what happens, name the thing, and where possible say "You can undo this for 30 days" or offer "Turn off" instead of "Delete" |
| **Undo** | Soft actions get a toast with Undo for 10 s ("Group renamed. Undo"). Real deletes stay confirm-only; they need no new table if done as "turned off" flags the code already has (invites and rules already have on/off) |
| **What changed** | Every settings save writes to the activity log ("Anna turned off colour printing, 9:12"); Home shows the last 5; each Settings section shows "Last changed by X on date". The activity log exists; section-level display is new |
| **Plain English** | One glossary decides the words: "Print server" (never "Agent" in the UI), "Printer", "Print setup" (not "profile/queue"), "Monthly limit". Applied to the checklist, headings and error messages |
| **Request budget** | No new background polling. Counts come with the page load. Live pieces (server status, job list) reuse what already refreshes or use manual refresh; nothing polls on an interval faster than 60 s, and heavy pages stay out of link prefetch (`shouldPrefetchNavHref`). See `docs/REQUEST-BUDGET.md`: one print server already costs about 11,500 to 31,700 requests a day |
| **Works with servers down** | The admin site never needs a print server to render. Anything that does (viewing a stored file, new uploads) shows the one standard sentence: "Your print server is offline, so I can't do that right now." |

---

## 4. Feature list

Legend. **Status:** EXISTS = in code today, PARTIAL = some of it, NEW = not built. **Effort:** S = days, M = a week or two, L = more.
**Value:** H / M / L. "DB" = needs a migration (new table or column; every new table gets an explicit grant to `authenticated, service_role`,
never `anon`, plus RLS, per CLAUDE.md). "Plain" = pages and menu only.

### Home

| Feature | Status | Effort | Value | DB |
|---|---|---|---|---|
| Overview with problems first (approvals, offline servers, printers in error), recent jobs | EXISTS | - | H | - |
| Setup checklist (5 steps) | EXISTS | - | H | - |
| Setup checklist rewrite: plain words, progress bar, "Ask for help", "Show me how", school-name and branding step | PARTIAL | S | H | Plain |
| Print-server status banner with the "what still works" sentence | NEW | S | H | Plain |
| "What changed" panel (last 5 activity-log rows) | NEW | S | M | Plain |
| Pages and limit use this month (card) | PARTIAL (reports have it) | S | M | Plain |
| Settings search (`/` key) | NEW | M | H | Plain |
| Manual Refresh button; slower auto-refresh | NEW | S | M | Plain |

### Jobs

| Feature | Status | Effort | Value | DB |
|---|---|---|---|---|
| All jobs list with status pills and search by user or file | EXISTS | - | H | - |
| Approvals queue with count in menu and phone badge | EXISTS | - | H | - |
| Date range, printer, group and "held reason" filters | NEW | M | H | Plain |
| Export jobs to CSV (filtered view) | PARTIAL (reports export) | S | M | Plain |
| Bulk approve / reject, bulk cancel | NEW | M | M | Plain |
| Approver comment on a reject ("too many pages") shown to the sender | NEW | M | M | DB (column or table) |
| Saved views ("Held jobs this week") | NEW | M | L | DB |

### People

| Feature | Status | Effort | Value | DB |
|---|---|---|---|---|
| Users table, roles (admin, approver, staff, student), department, print code | EXISTS | - | H | - |
| One person's page | EXISTS | - | H | - |
| Groups for rules and limits | EXISTS | - | H | - |
| Invite links, switch off any time | EXISTS | - | H | - |
| Who can join: invite only, or invite plus allowed email domain | EXISTS | - | H | - |
| Early-tools switch per person | EXISTS | - | L | - |
| Invite by typing email addresses (paste a list) | NEW | M | H | DB (invitations by email) |
| Invite expiry, usage limit and role per link | PARTIAL (not checked how much exists) | S-M | M | maybe |
| Bulk import people from CSV | NEW | M | M | Plain |
| Pending requests to join (approve or decline) | NEW | M | M | DB |
| Disable a person without deleting (keeps their history) | PARTIAL (not checked) | S | H | maybe |
| Per-person view: jobs, pages, devices, limit, last active | PARTIAL | S | M | Plain |
| Student accounts with their own limits | NEW (needs own design and legal review per the launch plan) | L | M | DB |

### Printers

| Feature | Status | Effort | Value | DB |
|---|---|---|---|---|
| Printers and finishing profiles; guided setup wizard | EXISTS | - | H | - |
| Print servers: poll speed, update button, detail page | EXISTS | - | H | - |
| All devices with setup status | EXISTS | - | H | - |
| Printer status in the printer's own words ("Add paper in cassette 2") on printers page and Home | EXISTS (built, testing) | - | H | - |
| Printer health card: online, last seen, last problem | PARTIAL | S | H | Plain |
| Toner / supplies levels | NEW (printer answers; not read today) | M | M | DB |
| Printer on/off ("pause printing here") | NEW (not checked if a switch exists) | S-M | H | maybe |
| Printer groups and "default printer" per group | NEW | M | M | DB |
| Print server health history (uptime) | NEW | M | M | DB |
| Fonts for booklets | EXISTS | - | L | - |
| Test print button | EXISTS (send-test-print present, not checked UI) | - | M | - |

### Rules

| Feature | Status | Effort | Value | DB |
|---|---|---|---|---|
| Print rules (needs approval / not allowed) with on/off | EXISTS | - | H | - |
| Monthly limits per person or group (pages or sheets) | EXISTS | - | H | - |
| Admin exceptions (admins bypass; approvers auto-approved) | EXISTS | - | M | - |
| Rule templates ("No colour for students", "Approve over 50 pages") | NEW | M | H | Plain (data in code) |
| "Who does this affect?" count beside each rule; test a rule against a sample job | NEW | M | H | Plain |
| Colour and size rules, time-of-day rules | PARTIAL (not checked which conditions exist) | M | M | maybe |
| Limit warning to the person at 80% | NEW | M | M | DB (sent log) |
| Extra pages for one person this month | NEW | S-M | M | DB |
| Quota reset day (school year, semester) | NEW | M | M | DB |

### Reports

| Feature | Status | Effort | Value | DB |
|---|---|---|---|---|
| Usage by user, department, printer, month | EXISTS | - | H | - |
| CSV export from reports | EXISTS | - | H | - |
| Activity log with plain labels | EXISTS | - | H | - |
| Activity log search and filter (who, what, date), CSV export | PARTIAL | M | H | Plain |
| Cost recovery: price per page (black and white, colour, per printer), cost per person or department, invoice-style export | NEW | M | H | DB (price settings) |
| Savings view (double-sided and booklet sheets saved) | NEW | S | L | Plain |
| Scheduled report by email (monthly to the principal) | NEW | L | M | DB |

### Settings

| Feature | Status | Effort | Value | DB |
|---|---|---|---|---|
| Printing defaults, print stamp (sender code on pages) | EXISTS | - | H | - |
| Files and retention (days kept for done, rejected, failed) | EXISTS | - | H | - |
| School profile: name, time zone, contact, language | PARTIAL (name only; not checked) | S | H | maybe |
| Branding: logo and accent colour on the sign-in page, header and job stamp | NEW | M | M | DB (+ file storage) |
| Privacy: how long job history is kept, delete a person's data, export everything about a school | PARTIAL (file retention exists; no history retention or export) | M-L | H | maybe |
| Notifications: choose who gets email for approvals, printer needs help, server offline | NEW (planned in ROADMAP) | L | H | DB (settings and sent log); needs an email sender |
| Phone print dialog and device types allowed (Windows, Android, iPhone, Mac, Chromebook), shown with proven/testing labels | PARTIAL (devices page shows status) | S | M | Plain |
| Sign-in methods (email link, Google when ready) | PARTIAL | S | M | - |
| Plan and billing (placeholder): plan name, printers allowed, "paid outside the app, contact us", renewal date set by the platform owner | NEW | S (placeholder) | M | DB (plan columns) |
| Help and support: guides, "Report a problem" with the last 20 activity rows and server status attached, status page link | NEW (listed in launch plan) | M | H | DB (reports) |
| Backup download (people, settings, rules) | NEW (ROADMAP "backup download") | M | M | Plain |
| Danger zone: transfer ownership, close school | NEW | M | L | maybe |

### Platform owner console

| Feature | Status | Effort | Value | DB |
|---|---|---|---|---|
| School list with member, printer, server, job counts; join as admin | EXISTS | - | H | - |
| Create a school; add super admins | EXISTS | - | H | - |
| Search, sort and filter schools; "setup stuck" and "server offline" flags | NEW | M | H | Plain |
| School detail: plan, notes, owner contact, last active | NEW | M | H | DB |
| Plan and billing per school (manual: paid / trial / overdue, dates) | NEW | M | M | DB |
| Usage vs the request budget (which schools cost the most) | NEW | M | M | Plain (read what the budget doc models) |
| Suspend a school (read-only) | NEW | M | M | DB |
| Broadcast notice to all schools ("maintenance Sunday") | NEW | M | M | DB |
| Support inbox (reports sent from schools) | NEW | M | H | DB |
| Phone-friendly shell with the same search and drawer as admin | NEW | S-M | M | Plain |

---

## 5. Build order

### Phase 1: quick wins, no new database tables (this fixes first run)

Goal: a new school can find things, understand them and get unstuck without the owner.

1. Rewrite the **setup checklist** in plain words (remove "Agent", `docs/agent-install.md`), add progress, "Ask for help" (opens a mailto
   or a prefilled message to the owner for now), school-name step, and a "this one needs a Windows PC" explanation. **Fixes first-run.**
2. **Rename and regroup the menu** to the seven sections; keep old routes working; Invites gets a tab visible in the menu.
3. **One vocabulary** pass: Print server, Printer, Print setup, Monthly limit.
4. **Print-server banner** on Home with the "what still works" sentence.
5. **Settings search** (static list), `/` shortcut, phone search button.
6. **Role fix:** make menu and page checks agree (Files, Fonts, Activity log); approvers get "View only" labels. Add a test next to `lib/nav.test.ts`.
7. **Empty states** that name the next step on Users, Groups, Rules, Limits, Printers, Devices, Reports.
8. **Home**: "What changed" panel, month usage card, manual refresh, slower auto-refresh.
9. Filters and CSV export on All jobs; filter and CSV on Activity log.
10. Printer health card from data that already arrives (server heartbeat, printer's own status words).
11. Platform console: search/sort and "setup stuck / server offline" flags using the counts it already loads.

No migration needed for any of the above.

### Phase 2: structural (needs migrations)

Each new table: explicit `grant select, insert, update, delete ... to authenticated, service_role;` (never `anon`), RLS by
`organization_id`, mirrored into `schema.sql`, and added to the tenant-isolation tests.

| Item | Migration |
|---|---|
| Notifications (settings per person and school, sent log) + email sender | Yes |
| Branding and school profile (logo, colour, time zone) | Yes (columns on org settings, file storage) |
| Invite by email list; pending join requests | Yes |
| Cost recovery: price per page settings and the cost report | Yes |
| Report a problem and platform support inbox | Yes |
| Plan and billing placeholder (plan, dates, status) | Yes |
| Rule templates and "who does this affect?" | No (templates in code) |
| Approver comment on reject | Yes |
| Privacy: history retention, export my school's data | Maybe |
| Undo for soft changes | No (toast only) |

### Phase 3: nice to have

Toner and supplies levels; printer groups and defaults; saved views; scheduled email reports; quota reset day and extra pages;
limit warnings at 80%; student accounts (needs its own design and legal review); server uptime history; suspend a school;
broadcast notices; backup download; transfer ownership and close school; platform usage-vs-budget view.

---

## 6. Open questions for the owner

1. **Names.** Is "Print server" the one word we use everywhere (and "Agent" disappears from the screen)? And "Print setup" instead of "profile" or "queue"?
2. **First run.** When a new school gets stuck on "connect a print server", what should the button do: email you, open a chat, or book a call? (For beta, I suggest an email button that includes the school name and what step they are on.)
3. **Approvers.** What should an approver be able to see and change: only approvals and jobs, or also people and printers (view only)? Today they can open most pages by link.
4. **Cost recovery.** Do schools charge families or departments for printing? If yes: one price per page, or different for colour and for 11x17?
5. **Email.** Which alerts matter most for the first schools (printer needs paper, print server offline, jobs waiting for approval)? Who should get them: all admins, or one chosen person?
6. **Plan and billing page.** For now, should it show only "Beta: paid outside the app" and the school's renewal date, or also a price and printer limit per plan?
