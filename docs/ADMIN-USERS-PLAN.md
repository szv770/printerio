# Admin "People" plan: Users, Groups, Invites at school and company scale

Written 2026-11-19 by a designer-analyst (read-only pass, no code changed). Goal: when the owner shows Printio to a school or
company with hundreds or thousands of staff, the People area stays neat, fast and safe.
Read first: `apps/web/app/admin/users/**`, `groups/**`, `invites/**`, `lib/admin/*`. Not read in depth: `InviteForm` internals,
`domain-join.ts`, `Settings` panel, the quota editor UI (only its page query). Those are marked "not checked".

---------------------------------------------------------------------------------------------------

## 1. Current state (what exists today)

| Page / file | What it does | Queries and rows loaded |
|---|---|---|
| `app/admin/users/page.tsx` | The Users list. Admins and approvers can open it. | 1 query: `organization_members` + `profiles` join, ordered by join date, **`.limit(1000)`**. Then 1 service-role write per member who has no print code (in parallel). Admin also runs `findUnmatchedSignups`. |
| `app/admin/users/MembersTable.tsx` (360 lines, client) | Every row has an editable print-code box, role dropdown, department box, on/off switch and a trash button. One "Save" bar saves all edited rows, one person and one action at a time. Search and the two filters (role, active/off) run **in the browser** over the loaded list. | All rows are rendered at once (no paging). Each row = 3 form controls + switch. |
| `lib/admin/members.ts` | Pure helpers: which fields changed, which action saves each, `filterMembers` (substring match on name, email, department, code). | none |
| `app/admin/users/actions.ts` | One server action per field: role, department, print code, on/off, early tools, cancel queue, remove, create invite, revoke invite, remove sign-up. All are org_admin only. Role, on/off, early tools, queue cancel, remove and invite revoke write an `audit_logs` row. | 2 to 4 queries per call. A bulk save of 50 edits = up to 200 round trips, one after another (the client awaits each). |
| `app/admin/users/[userId]/page.tsx` | One person: role/department/on-off, "what can they use" (runs the real policy engine once per printer), early tools, cancel their queue, joined date, jobs and pages in the last 30 days. | About 8 queries. The 30-day jobs query fetches **every job row** and adds the pages up in the page (fine for one person, heavy for a very heavy printer). |
| `app/admin/groups/page.tsx` + `GroupsPanel.tsx` | One fold-away card per group. Inside: member list with remove button, an "Add a user" dropdown, delete group. Kinds: department / class / custom. | `groups` limit 500, **all members limit 2000** (just for the dropdown), `group_members` limit 5000. Everything filtered in the browser (`groupMembers.filter` per group card). |
| `app/admin/groups/actions.ts` | create, delete, add one member, remove one member. No audit rows. | 1 to 2 queries each. |
| `app/admin/invites/page.tsx` + `InvitesPanel`, `InviteForm`, `InvitationsList` | Make a link/code: role, optional group, max uses, expiry. List of the latest 100 invites with copy/share/turn-off. | 3 queries (invites limit 100, groups, org name). |
| `lib/auth/invitations.ts` | Redeems a code. The schema also supports an invite for one email (`organization_invitations.email`), but **`createInvitationAction` never sets it**: there is no screen for "invite these 40 emails". | n/a |
| Domain join (migration `0039_join_policy.sql`, Settings > "Who can join") | `organizations.join_mode` + `allowed_domains` + `domain_join_role` (staff or student only). Not checked in depth. | n/a |
| `lib/admin/tabs.ts` | Tabs Users / Groups / Invites (Invites admin only). | n/a |

Data model (from `supabase/migrations`):
- `organization_members(user_id, organization_id, role, department text, status, created_at, user_code, early_tools)`; indexes only on
  `organization_id` and `user_id` (0001), unique `user_code` per org (0033). Department is **free text**.
- `groups(id, organization_id, name unique per org, kind in department|class|custom)`; `group_members(group_id, user_id)`, index on `user_id` (0001). Groups are flat (no parent).
- `audit_logs(organization_id, actor_id, action, target_type, target_id, metadata, created_at)`, index `(organization_id, created_at)`.
- Policy rules and monthly limits read `role`, `department` (exact text match) and `groupIds` (`lib/policy/build-facts.ts`, `lib/quota.ts`, `packages/shared/src/policy-engine.ts`).
- No "last signed in" or "last printed" column on members. Last activity would have to come from `print_jobs` (index `(created_by, created_at)` exists, 0048).
- Search extension: no `pg_trgm` found in the migrations (I grepped; may exist outside them).

### What happens as the school grows

| People | Users page | Groups page | Verdict |
|---|---|---|---|
| **50** | Fine. 50 rows, 150 form controls. | Fine. | Works. Phone is long (each person is a tall card with 4 fields). |
| **500** | One query, 500 rows shipped to the browser and rendered at once; the page is a very long scroll, search is the only way to find someone. Page also fires up to 500 code-writes the first time after an import. | Roster dropdown lists 500 names in a plain `<select>`; per-group `filter` over all links, slow-ish but works. | Usable but not neat. Saving 30 edits is 30 to 120 sequential calls. |
| **1,000+** | **Silently cuts off at 1,000.** Person 1,001 never shows up in Users, search cannot find them, and the header count says "1000 users". | Roster is cut at 2,000, group links at 5,000 (a school with 1,500 students in 3 groups each = 4,500, near the cut). Same silent cut-off. | **Broken for the target customer.** |
| **5,000** | Cut-off hides 4,000 people. If the limit were raised, a 5,000-row client render would freeze phones. | A 5,000-option dropdown. Unusable. Group member lists are cut. | Not workable without server-side paging. |

Two further facts: the audit page and Unmatched sign-ups also use fixed limits (sign-ups: 5 pages x 200 auth users, then shows 100).
`findUnmatchedSignups` pulls auth users across the whole platform, not the org, which will not scale as more organizations join.

---------------------------------------------------------------------------------------------------

## 2. Problems for an enterprise

| # | Problem | Where | Why it hurts at 1,000+ |
|---|---|---|---|
| P1 | **Hard cut-offs, silently** (1000 members, 2000 roster, 5000 links) | `users/page.tsx:20`, `groups/page.tsx:17,26` | Some people simply do not exist in the admin screens. Worst kind of bug: it looks fine. |
| P2 | **Search and filters are browser-only** over what was loaded | `lib/admin/members.ts` `filterMembers` | Cannot find person 1,001. Only role and active/off filters; none for department, group, last activity, "never printed". |
| P3 | **Editable boxes on every row** (print code, role, department, switch) | `MembersTable.tsx` | A table of 1,000 inputs is easy to mis-click (a stray keystroke in Department changes who a print rule applies to). Rows are tall; on phone one person fills a screen. |
| P4 | **No bulk work.** No select, no "move these 40 to Science", no "switch off all leavers" | `MembersTable.tsx`, `actions.ts` | Start-of-year and end-of-year changes become hundreds of manual edits. |
| P5 | **Department is free text, groups are separate, neither nests** | `organization_members.department`, `groups.kind` | "Science" vs "science " vs "Sci" are three departments, and print rules/limits that match the text silently stop applying. A person has one department but many groups; the screens give no hint which to use. No "Year 9 inside Science". |
| P6 | **Groups page cannot scale:** no search inside a group, add one person at a time from a dropdown, no counts without opening the card, no summary of the group's rules or limits | `GroupsPanel.tsx` | A class of 120 means 120 clicks. The admin cannot see "what does this group get" without visiting Rules and Monthly limits (also flagged in `docs/ADMIN-DASHBOARD-PLAN.md` item 7). |
| P7 | **Roles are four fixed levels**, approver edit rights unclear | `roleChoices()`, `requireOrgRole` | Fine for small schools. A company wants "help-desk can reset codes but not make admins", "department head approves for their department". The dashboard plan already asks this (owner question 3). Not solved by this plan; noted. |
| P8 | **Onboarding many people is manual.** Only link/code invites exist (one code, many people, max uses). No email-list invite, no CSV, no "send again". The one-email invite exists in the schema and redeem code but has no screen. | `InviteForm.tsx`, `actions.ts` `createInvitationAction` | A school with 800 staff wants to paste a list and be done. Link sharing also cannot assign department per person. |
| P9 | **Audit is partial.** Role, on/off, early tools, remove, invite revoke are logged. **Department change, print-code change, group create/delete/add/remove, invite create are not.** Detail page has no activity history, only 30-day totals. | `actions.ts` (lines for department and code have no `audit_logs` insert), `groups/actions.ts` | "Who moved her to Admin office?" is unanswerable for department and group changes. Enterprises ask this first. |
| P10 | **Slow, chatty saves.** Save walks people and actions one by one from the browser. 5 failures out of 200 show only a count. | `MembersTable.tsx` `save()` | At bulk sizes a network blip leaves half-applied work with a vague error. |
| P11 | **Phone:** each person is a stacked form card with 4 controls and a delete icon; no sticky search; the 5-user screenshot (`after-users-phone.png`) already needs two screens for 2 people. | `MembersTable.tsx` `ResponsiveTable` | Approvers use phones; at 1,000 people this is unusable. |
| P12 | **Print codes are auto-created on page view** (writes during a GET render, up to N parallel writes) | `users/page.tsx:27-47` | After a 1,000-person import, the first admin to open Users triggers 1,000 writes. Should happen at join/import time. |

---------------------------------------------------------------------------------------------------

## 3. Proposed design: one "People" area

Keep the three tabs, but rebuild them as one coherent area: **People** (list + drawer), **Groups & sections**, **Invites & import**.
Principle: the list is read-only and compact; editing happens in a drawer or through bulk actions; the server does the finding and counting.

Legend: EXISTS / PARTIAL / NEW. Effort S (a day or less) / M (a few days) / L (about a week or more). Migration: none / index / table.

### 3.1 People list (desktop wireframe)

```
People                                                          [ + Invite ]  [ Import CSV ]  [ Export ]
Everyone who can print here.
[People]  Groups & sections   Invites

View: [ All people v ]  [Save this view]
[ Search name, email, code ............ ]  Role v  Section v  Group v  Status v  Last printed v  [ Has printed v ]
Showing 1-50 of 1,284 people  (3 filters on: Science, Staff, Active)   [Clear filters]

[ ] Name / email            Section     Role      Groups          Last printed   Status
-----------------------------------------------------------------------------------------
[ ] Moshe Levi              Science     Staff     Yr 9, Lab       2 days ago     Active   >
    moshe.levi@school.org
[ ] Rivka Stein             Science     Approver  Yr 10           today          Active   >
[ ] substitute.teacher@..   (none)      User      -               never          Off      >
-----------------------------------------------------------------------------------------
< Prev   Page 1 of 26   Next >                                    Rows per page: 50 v

When 1+ rows ticked, a bar replaces the filter row:
[ 12 selected ]  Change role v | Set section v | Add to group v | Remove from group v | Switch off | Switch on | Send invite again | Remove | [Clear]
( ) Select these 12   ( ) Select all 214 people that match the filters
```

### 3.2 People list (phone wireframe)

```
People                [Invite]
[ Search ................ ] [Filters (3)]
1,284 people
+--------------------------------+
| ML  Moshe Levi          Active |
|     Science . Staff        >   |
+--------------------------------+
| RS  Rivka Stein         Active |
|     Science . Approver     >   |
+--------------------------------+
  (long-press or the checkbox mode button = select)
< Prev    1 / 26    Next >
```
Two lines per person (name, then section and role), a tap opens the drawer as a full-screen sheet. No inputs in the list.
Filters open as a bottom sheet with an "Apply" button and a count of the people that match.

### 3.3 Person drawer (side panel on desktop, full sheet on phone)

```
+-------------------------------------------+
| ML  Moshe Levi                       [x]  |
|     moshe.levi@school.org                 |
|     Staff . Science . Active              |
+-------------------------------------------+
| Details                          [Edit]   |
|  Role       Staff                         |
|  Section    Science                       |
|  Print code ML2                           |
|  Joined     3 Sep 2026                    |
|  Early tools: off                         |
+-------------------------------------------+
| Groups                      [+ Add]       |
|  Yr 9 (x)   Lab (x)                       |
+-------------------------------------------+
| What they can use                         |
|  Main copier   allowed                    |
|  Colour copier needs approval (rule: ...) |
|  Monthly limit: 400 sheets (group Yr 9)   |
+-------------------------------------------+
| Activity (last 30 days)  jobs 41 pages 312|
|  Last printed: 2 days ago                 |
|  Changes made to this person:             |
|   12 Nov  Dana K. changed role Staff>Appr.|
|   03 Sep  Joined with invite link         |
|  [See full history]                       |
+-------------------------------------------+
| [Switch off]  [Cancel their queue] [Remove]|
+-------------------------------------------+
```
Edit mode shows the same fields as inputs with one Save for the drawer (reusing the existing four actions).
The standalone page `/admin/users/[userId]` stays as the shareable full view of the same content.

### 3.4 Feature table

| # | Item | Status today | Effort | Migration? |
|---|---|---|---|---|
| 1 | Server-side search (name, email, section, code), sort (name, joined, last printed), pagination with total count | NEW (client-only filter today) | M | Index only (see 4) |
| 2 | Filters: role, status | PARTIAL (client-side, loaded rows only) | S | none |
| 3 | Filters: group, section, last activity, has printed / never printed | NEW | M | Index (+ small view/function for "last printed", see 4) |
| 4 | Total counts and "showing 1-50 of N", filtered-count chips | PARTIAL (count of loaded rows) | S | none |
| 5 | Compact read-only row (avatar, name, email, section, role, groups, last printed, status) | NEW (rows are editable boxes) | M | none |
| 6 | Person drawer, edit in one place with one Save | PARTIAL (a full detail page exists, with the same controls) | M | none |
| 7 | Remove the page-render code-writes; assign print code when someone joins or imports | NEW (today in `users/page.tsx`) | S | none (reuse `ensureMemberUserCode`) |
| 8 | Bulk select (page, or "all N matching") and bulk change role / section / switch off-on / remove | NEW | M | none (one new server action takes `userIds[]` or a filter; one audit row per batch plus count) |
| 9 | Bulk add to / remove from group | NEW | S | none (`group_members` insert/delete many) |
| 10 | Bulk "send invite again" | NEW (needs email invites, see 3.7) | M | none if row (13) exists |
| 11 | Safety on bulk: last-admin guard, cannot remove yourself, confirm with count, undo note | PARTIAL (single-person guards exist: `assertCanRemoveMember`, last-admin counts) | S | none |
| 12 | Saved views (named filter sets: "Science staff", "Never printed") | NEW | M | **Yes: new table `admin_saved_views`** (see 3.8). Phase 1 variant with no table: shareable URLs plus 4 built-in views. |
| 13 | CSV import with dry run, error report | NEW | L | none for the import itself; temp batch table optional (see 3.6) |
| 14 | CSV export of the (filtered) list | NEW (Reports has CSV for usage, not for people) | S | none |
| 15 | Activity strip in drawer: last printed, 30-day totals, changes made to this person | PARTIAL (30-day totals exist, no history) | M | none (reads `audit_logs` where `target_id = userId`; needs index, see 4) |
| 16 | Audit rows for department, print code, group and invite changes | NEW (gaps listed in P9) | S | none |
| 17 | Groups & sections: search groups, member counts on the list, member table with search and paging, add many (paste emails or pick from filter), remove many | PARTIAL (cards, one-at-a-time) | M | none |
| 18 | Group "rules and limits summary" line (e.g. "2 print rules, limit 400 sheets/month") | NEW | M | none (counts from `policy_rules` conditions and `quotas` with scope group; read-only; admin only because of RLS) |
| 19 | Section as a pick-list (no typos) | NEW | S (phase 1 pick-list of existing values) | none |
| 20 | Invite links: role, group, uses, expiry | EXISTS | - | - |
| 21 | Invite links also carry a section | NEW | S | **Yes: one column `organization_invitations.department text`** (nullable); redeem sets it. |
| 22 | Domain join | EXISTS (Settings; not checked in depth). Add: show on the Invites tab as a card ("Anyone at @school.org joins as Student") with a link to change it | S | none |
| 23 | Invite by email list (paste or CSV): one targeted invite per email, optional role, section, group; emails sent (or a copy-link per person) | NEW (schema supports `email` invites, no screen; email sending not checked) | L | none for schema (column exists); an outbox/status needs care |
| 24 | Invites list at scale: search, status filter, paging (today a fixed 100) | PARTIAL | S | none |
| 25 | Mobile list, filter sheet, drawer as full sheet | NEW | M | none |

### 3.5 Groups and sections: ONE simple model

**Recommendation: keep it flat. One person has ONE section (today's `department`) and any number of groups (today's `groups`). Do not add
nesting.** Make section a managed pick-list and show both in the same filters.

Why:
1. The print path reads exactly two things per person: `department` text and flat `groupIds` (`build-facts.ts`, `quota.ts`). Nesting
   (Science > Year 9 > Class 9B) would need ancestor lookups on every print and every rule. That puts risk on the hot path to solve a display problem.
2. Schools and companies already express hierarchy by name ("Science", "Science - Year 9"). Tags with filters cover 95% of it.
3. A simple rule the owner can say out loud: "Section = where they work. Group = a set of people you give rules or limits to."
4. It keeps limits predictable: the lowest applicable limit wins (already how `quota.ts` works). With nesting, "which limit wins" becomes a support topic.

Concretely:
- **Section** stays `organization_members.department` (display name "Section"; keep the column name, no rename migration). Add a pick-list built
  from the distinct values already in use plus a "New section..." option; bulk "Set section" uses the same list. Typos stop at the UI.
- **Groups** keep `kind` (department / class / custom) as a tag so the group list can be filtered ("Classes", "Departments"). Rename nothing.
- Later option (phase 2, only if customers ask): "section" becomes a group of `kind = department` and rules/limits move to group scope. Not needed now. Record it, do not build it.

### 3.6 CSV import and export

Import (admin only). Columns: `email` (required), `name`, `role`, `section`, `groups` (semicolon list), `status`. Steps:
```
1. Upload CSV (up to 5,000 rows)       -> parsed in the browser, never executed
2. Dry run preview (nothing saved)     -> "412 new people, 38 already here (will update), 6 problems"
     Row 17  bad email        Row 52  unknown role "teachr"   Row 90  group "Yr 9" will be created
   [Download error report CSV]   [Fix and re-upload]
3. Confirm  -> server applies in batches of 200, shows progress, ends with "Done: 412 added, 38 updated, 0 failed"
   (one audit row for the whole import, with counts and the file name)
```
Rules: a person who has not signed up yet gets a targeted email invite (row 23), not a made-up account. Existing members are matched by
email; role changes in an import to or from `org_admin` need an extra confirm. Never import over the last admin. Import is idempotent:
upload the same file twice and nothing breaks.
Export: same columns as import plus code, joined, last printed. Respect current filters; cap rows per request and stream.

### 3.7 Invitations at scale

| Way in | Today | Plan |
|---|---|---|
| Link or code (one code, many uses) | EXISTS | Add section; show uses and expiry in a compact list with search and paging. |
| Domain join (anyone with `@school.org`) | EXISTS (Settings) | Surface on Invites tab. |
| Email list (paste or CSV) | NEW (schema ready) | One targeted invite per email, status column (Sent / Opened / Joined / Expired) and a bulk "Send again". Whether the app can send email today: not checked. If not, first version produces a per-person link list to copy. |
| SSO / directory sync | none | Phase 3 design only (section 5). |

### 3.8 New tables, grants and RLS (only these)

| Table / change | Why | Grants (explicit, per CLAUDE.md) | RLS |
|---|---|---|---|
| `admin_saved_views(id, organization_id, owner_id, name, filters jsonb, shared boolean, created_at)` | Saved views | `grant select, insert, update, delete on public.admin_saved_views to authenticated, service_role;` never `anon` | Org admins and approvers: select rows where `organization_id` is theirs and (`owner_id = auth.uid()` or `shared`); insert/update/delete only own rows. Index `(organization_id, owner_id)`. |
| `organization_invitations.department text null` | Section on invite links and email invites | No new table; existing grants stand. | Unchanged (existing invitation policies). |
| `import_batches(id, organization_id, created_by, file_name, status, counts jsonb, errors jsonb, created_at)` (optional) | Server-side record for a resumable import and the error report. Skip if the first version keeps the import state in the browser. | Admin-only: `grant select, insert, update, delete ... to authenticated, service_role;`; if only the service role writes it, revoke write from `authenticated`. | Org admins only, `organization_id` match. |
| Search/filter indexes and a read-only view | See section 4 | Views: `grant select on ... to authenticated, service_role`; created `with (security_invoker = true)` so existing RLS still applies. | Inherited from base tables. |

Mirror each migration into `schema.sql` (CLAUDE.md rule). Keep the features doc honest: update `docs/FEATURES.md` when any of this ships.

---------------------------------------------------------------------------------------------------

## 4. Data and query changes

### 4.1 Load the list a page at a time

Never fetch everyone. One round trip returns a page plus the matching count:

```ts
// server component or action; org id comes from the session, never from the URL
let q = supabase
  .from("organization_members")
  .select("user_id, role, status, department, created_at, user_code, profiles!inner(email, display_name)", { count: "exact" })
  .eq("organization_id", orgId);
if (role) q = q.eq("role", role);
if (status) q = q.eq("status", status);
if (section) q = q.eq("department", section);
if (group) q = q.in("user_id", groupMemberIds)   // see 4.3: prefer a view/RPC for big groups
q = q.order(sortCol, { ascending }).order("user_id").range(from, from + pageSize - 1);   // stable tie-break
```
Page size 50 (25 on phone, choices 25/50/100). Keep the total in the header ("1,284 people"). Page number lives in the URL (`?page=3&q=...&role=staff`), so back button, sharing and "saved view" all work and the page stays a Server Component.

### 4.2 Search

`.or()` cannot span `organization_members` and `profiles` in one PostgREST filter. Two options:
- **Recommended: a view `member_directory`** (security_invoker) joining members and profiles with columns `organization_id, user_id, email, display_name, role, status, department, user_code, created_at`, plus `last_printed_at` (a subselect `max(created_at)` from `print_jobs where created_by = user_id and organization_id = ...` and not test prints). Search and all filters then run against one relation: `.or("email.ilike.%x%,display_name.ilike.%x%,department.ilike.%x%,user_code.ilike.x%")`.
- Simpler first step, no view: search `profiles` for ids (`ilike` on email/display_name, limit 200) and then `organization_members.in("user_id", ids)`. Works to a few thousand people, two round trips.

Escape `%`, `_` and commas in the typed text before building the filter string (do not paste user input into `.or()`).

### 4.3 Indexes (migration, `create index if not exists`)

| Index | For |
|---|---|
| `organization_members (organization_id, created_at, user_id)` | default sort and paging within an org |
| `organization_members (organization_id, role)` and `(organization_id, status)` and `(organization_id, department)` | filters and counts. Skip if the org-first composite is enough at the pilot size; measure first. |
| `group_members (group_id, user_id)` is already the primary key; add `group_members (user_id)` already exists | group filter and "who is in this group" |
| `profiles` trigram GIN on `lower(email)` and `lower(display_name)` (`create extension if not exists pg_trgm`, Supabase puts it in `extensions`) | `ilike '%text%'` stays fast beyond about 10,000 profiles. At 1,000-5,000 people a plain scan is acceptable, so this can wait. |
| `audit_logs (organization_id, target_id, created_at desc)` | "changes made to this person" strip; the current index is `(organization_id, created_at)` only |
| `print_jobs (created_by, created_at)` | exists (0048); makes `last_printed_at` and 30-day totals cheap |

### 4.4 Counts, last activity, detail page

- Header counts: use `count: "exact"` on the filtered query. For the unfiltered org total at 50k+, `estimated` is fine; not needed now.
- "Last printed" per row: from the view's `last_printed_at`. Only compute it for the page's 50 rows (a view with a lateral subselect does this, because the page range is applied after the join filter). If it proves slow, add `organization_members.last_printed_at` kept by the print path (migration + write on job create) as phase 2.
- Detail page: replace "fetch all jobs and sum in JS" with a count/sum query (RPC `member_activity(user, days)`), or at minimum `.select("source_pdf_pages")` through a helper that sums; the 30-day window caps it, so low priority.
- Groups page: load groups with member counts (`group_members(count)` embed, or a grouped view), and fetch a group's members only when its card is opened, paged and searchable. Remove the all-members roster and the 5,000-link fetch.
- Add-to-group at scale: a combobox that searches on the server (type-ahead, 20 results), plus "add everyone matching this filter" through a bulk action.

### 4.5 Writes: bulk actions

One server action per bulk operation: `bulkUpdateMembers({ ids | filter, patch })`. Server resolves ids (never trusts a client list across orgs: `.eq("organization_id", orgId).in("user_id", ids)`), applies the same safety checks as single edits (last active admin, not yourself), updates in one statement, then writes one `audit_logs` row with `{count, patch, sample ids}`. Chunk at 500 ids. This replaces the browser looping over person x action.

### 4.6 Risk to the policy engine and quotas

| Change | Risk | Mitigation |
|---|---|---|
| Section pick-list / bulk "Set section" | Rules and monthly limits match `department` by **exact text** (`quota.ts` line 49, policy engine fact `department`). Renaming "Science" to "Sci" on 200 people silently drops them out of the Science rule and limit. | Pick-list stops typos. On a bulk section change show "This affects 2 print rules and 1 monthly limit that use section Science" before confirm. Never rename a section value without offering to update the rules. |
| Bulk group add/remove | Group membership drives rules and group limits immediately (read on every print by `build-facts.ts`). | Same confirm message with rule/limit counts; audit row. |
| Switch off / remove in bulk | Print path should refuse non-active members (existing behaviour; not re-verified here). Jobs already queued stay. | Offer "also cancel their waiting jobs" (uses the existing cancel-queue action logic). |
| Role change to approver/admin in bulk | Gives approval rights and admin screens. | Extra confirm, hard cap (e.g. 25 at a time), cannot bulk-demote the last admin. |
| Import | Could create or move many people at once. | Dry run first, one audit row, import never touches `org_admin` rows without a separate confirm. |
| Dropping the full roster from the Groups page | None for printing (page-only). | n/a |
| Quota history | Group/section change mid-month changes which limit applies but not usage already counted (not re-verified; quota usage tables not read in depth). | State it in the confirm text only after verifying with the quota owner file. |

---------------------------------------------------------------------------------------------------

## 5. Build order

**Phase 1: no migration (get rid of the cut-offs and the mess)**
1. Server-side list: URL params, `range` + `count: exact`, search (two-step profiles lookup), role/status/section filters, sort, paging. Remove `.limit(1000)`. (M)
2. Compact read-only rows, desktop and phone layouts; section pick-list from distinct values. (M)
3. Person drawer (reuse the four existing actions and `describeMemberAccess`); keep the full detail page. (M)
4. Move print-code creation out of the page render. (S)
5. Bulk bar: change role, set section, switch off/on, remove, with count confirm and last-admin guard; one audit row each. (M)
6. Audit gaps: department, print code, group, invite create. (S)
7. Groups page: counts without loading members, per-group paged member list with search, type-ahead add, remove the roster fetch. (M)
8. Phone check on every screen with 5, 60 and 1,500 sample people (seed a test org; do not use the real one).

**Phase 2: migrations and bigger tools**
1. Indexes (4.3) and the `member_directory` view (adds group, last printed, last activity filters). (index + view)
2. Bulk group add/remove, "add everyone matching this filter". (S)
3. CSV export, then CSV import with dry run and error report. (S then L)
4. Saved views table. (M, table)
5. Email-list invites with status, invite `department` column, "send again". (L)
6. Group rules and limits summary line; audit strip in the drawer. (M)

**Phase 3: design only, do not build yet**
SSO and directory sync (Google Workspace, Microsoft Entra) as listed in `docs/SAAS-IDEAS-AND-PARTNERSHIPS.md` (row 4: "schools will not type 500 emails", with student-data legal work first).
Design notes: add `external_id`, `source` (`manual|csv|sync`) on `organization_members`; a sync only creates, updates or switches off rows with `source = 'sync'`; groups from the directory map to Printio groups; a nightly job plus a "Sync now" button; a sync dry run reuses the CSV preview screen; SCIM or Google Admin SDK are the two integrations to evaluate. Needs a data-protection agreement before any student data is pulled. Google sign-in code exists but is switched off (per that doc).

---------------------------------------------------------------------------------------------------

## 6. Questions for the owner

1. **How big is the first real customer?** (for example 300 teachers, or 3,000 students too). Students would make the list 10 times bigger and decide how soon Phase 2 imports are needed.
2. **Section and groups:** are you happy with "one section per person, any number of groups, no nesting" (section 3.5), or do real schools you have talked to need "Year 9 inside Science" as a real structure?
3. **Who may manage people?** Today only admins edit and approvers can open the list. Should a department head (approver) be able to see and change only people in their own section?
4. **Getting people in:** is a pasted list of emails (one invite each, with section and role) the most important way, ahead of a CSV file, a shared link, or Google sign-in sync?
5. **Leavers and year-end:** do you want a "switch off everyone who has not printed in 90 days" or "move class 9 to class 10" tool? That would shape the bulk actions and the saved views in Phase 2.

---------------------------------------------------------------------------------------------------

Honesty notes: I did not run the app, did not measure query speed, did not read `domain-join.ts`, the Settings panel, the invite form internals, the quota editor or
the print path's active-member check. Email sending capability was not checked. The numbers in the "at 50 / 500 / 5,000" table follow from the fixed limits in the code, not from a load test.

---------------------------------------------------------------------------------------------------

## 7. Phase 1 as built (2026-11-19) and extension points

Built on branch `claude/members-onboarding`, no migration. Status: Built, testing (dev preview with 5 / 60 / 1,500 made-up people and unit tests; NOT run against the real database or a real phone).
Owner decisions: start flat (one **section** per person = `organization_members.department`, any number of **groups**), admins only manage people, biggest customer unknown so 5,000 people must stay fast.

What is where:
- `lib/admin/people-query.ts`: the filter object (`PeopleFilter`), URL parsing and writing, the database filter strings, the in-memory twin used by the preview. `lib/admin/people-list.ts`: the page query (range + exact count), the two-step name/email search, the section pick-list (read in 1,000-row chunks, only when a list is opened).
- `lib/admin/bulk-members.ts`: every bulk guard (cross-org ids, last admin, not yourself, confirm and cap for approver/admin rights, one audit row). `app/admin/users/bulk-actions.ts` applies it in chunks of 100, max 200 people per action.
- Print codes are no longer written when the page opens. A person gets theirs on first print, or an admin presses "Give print codes now" (200 per press, guarded by `user_code IS NULL` and the unique index, safe if two admins press at once): `lib/jobs/ensure-user-codes.ts`.
- `lib/admin/groups-list.ts`: group counts via `group_members(count)`, per-group paged and searchable members, type-ahead add (20 results). Removing someone from the organization now also takes them out of that organization's groups (no ghost members; older ghosts are still counted).
- Audit rows added: section, print code, group create/delete/add/remove, invite creation, bulk actions, print codes handed out.

Known limits: sort by name uses PostgREST related ordering and falls back to date joined if the database refuses (untested on the real DB). Name search looks at the first 200 matching names. Bulk applies to the ticked rows of the current page (max 100 per page, server cap 200). The section "affects N rules" warning is a general note, not a count. Selecting "all N matching" is not built.

Extension points (do not hard-code around these):
| Later feature | Where it plugs in |
|---|---|
| Nesting (Science > Year 9) | Keep `department` as the stored value. Add a `sections` table or `parent_id` on groups, and resolve a section to its ancestors inside `PeopleFilter` handling (`applyPeopleQuery`) and the policy facts builder only. The UI already says "section", never "department". |
| Bulk add by API or CSV | New `BulkTarget` variants and a server resolver (`lib/admin/bulk-members.ts`); `MemberSource` (`manual` / `csv` / `sync`) is already on `PersonRow`. Import chunks go through `planBulkChange` so the same guards and one audit row apply. |
| Google OU / directory sync | Add `external_id` and `source` columns (Phase 3 notes above); a sync only touches `source = 'sync'` rows. Add `source` to `PeopleFilter` (one field, one line in `applyPeopleQuery`) to filter and bulk-act on synced people. |
| Per-department managers | Add `managedBy` (a section list) to `PeopleFilter`; the page passes the viewer's sections for approvers instead of "everyone". Reads already go through `fetchPeoplePage(db, orgId, query)`; writes through `planBulkChange` (add an "is this person in my sections" check there). Today only `org_admin` can write. |
| Filters on group, last printed | One field each in `PeopleFilter` plus the `member_directory` view (Phase 2, section 4.2). |
| Invites: link/code, domain join, email list | Unchanged tables; invite creation is now audited (`invitation.created`, the secret code is not logged). |
