# Design review of the multi-school plan (2026-11-15)

Written by an independent reviewer (a read-only pass over `docs/TARGET-ARCHITECTURE.md` and the code, no services run). **All Cloudflare and Supabase limits and prices in it are from memory, not checked on the day**; each has a named test in the text. Checked afterwards against the code and confirmed: device identity is the Host header `u-<token>.<BASE_DOMAIN>` (`apps/gateway/src/server.ts`); one `GATEWAY_SHARED_SECRET` plus the master Supabase key in the gateway (`apps/gateway/src/config.ts`); the agent makes three separate calls per cycle (`apps/agent/src/orchestrator.ts`); the limited service account exists only because the hardening script was run by hand (`docs/SECURITY.md`).

**Owner decisions on it (2026-11-15):** tunnels stay automatic (built last, in a separate Cloudflare account); Pro before the second school; a school server being off means nobody there can submit (accepted); pre-built booklets for other schools dropped completely (each school builds its own). The revised phases are in `docs/TARGET-ARCHITECTURE.md` section 6.

---

# Design review: Printio from one school to a multi-school service (2026-11-15)

Read-only review. Sources: `docs/TARGET-ARCHITECTURE.md`, `docs/PHASE0-FINDINGS.md`, `docs/SECURITY.md`, `docs/agent-api.md`,
`docs/architecture.md` (sec 3, 4, 12, 13), `docs/phase0-code-inventory.md`, `docs/ipp-printing.md`, `docs/STATE-2026-11-01.md`,
`supabase/migrations/0006_rls_policies.sql`, `apps/gateway/src/config.ts`, `apps/gateway/src/server.ts`, `apps/agent/src/orchestrator.ts`.

**Vendor numbers below (Cloudflare and Supabase limits, prices) are from memory, not looked up today. Each one marked "verify" must be
checked on the vendor's page before it is relied on.** Nothing was run; no code claim here was tested.

## Verdict in five lines
1. The direction is right: light website, per-school servers, no master key on school PCs, signed updates.
2. The plan is too big for 5-15 schools. Three pieces carry most of the risk and are not needed yet: automatic tunnel creation,
   pushing pre-built booklets, and moving every server call to row-level security in one step.
3. One design gap is not solved at all: per-school print-dialog addresses do not fit Cloudflare's free certificate (item 2 below).
4. The free tiers are being asked to do things they are bad at: Supabase free has no backups, and the Realtime free quota is
   tighter than the plan assumes.
5. Nothing in phases 1-3 needs the owner's Cloudflare account. Do not connect it until the gates in section 5 are met.

---

## 1. Pre-mortem: 12 ways this fails, ranked by likelihood x damage

### 1. The Cloudflare key that creates tunnels and addresses leaks or is misused
- **What goes wrong.** Tunnel permission in Cloudflare is account-wide, not per zone (verify: "Account > Cloudflare Tunnel > Edit").
  A holder can list, delete or re-point every tunnel in the account, including `printio-gateway` that serves the live site
  (`docs/STATE-2026-11-01.md` sec 1), and can fetch any tunnel's token and run a fake connector that receives a school's traffic.
  "DNS edit" on a zone covers every record in it. If the zone is `szvtech.org` and that domain also carries email or anything
  else, the key can redirect it. The plan keeps this key in a cloud function reachable from the internet
  (`TARGET-ARCHITECTURE.md` sec 5), triggered by any school admin's click.
- **Notice.** Cloudflare audit log; unknown tunnels or DNS records; a school's printing silently goes elsewhere.
- **Cheapest prevention.** Do not build automatic creation. At 5-15 schools onboarding happens at most 15 times: the owner
  creates each tunnel by hand in the dashboard (about 5 minutes) and pastes the tunnel token into the enrolment record. No
  standing key exists. Put school servers on a **separate domain bought for that purpose**, not `printio.app` and not
  `szvtech.org`. If automation is ever wanted, it becomes a manually approved GitHub workflow, not a live endpoint.
- **Test before connecting.** On a throwaway free Cloudflare account, create the narrowest token the plan describes and try to
  delete an unrelated tunnel and edit an unrelated DNS record with it. If either works, the scoping claim in sec 5 is false.

### 2. Per-school print-dialog addresses do not work on the free certificate
- **What goes wrong.** Identity is the hostname: `u-<code>.szvtech.org`, read from the Host header
  (`apps/gateway/src/server.ts:1`, `docs/ipp-printing.md` "Consequence for identity"). The free certificate covers only one level
  (`*.szvtech.org`). One wildcard can point at one tunnel only, so 15 schools with 15 tunnels cannot share it. The options are
  all unpleasant: (a) `u-<code>.<school>.<domain>` needs Cloudflare's paid certificate add-on (about $10/month, verify) and a card
  on the account; (b) one DNS record per device needs the DNS key at runtime and hits the record cap on a free zone (200 for newer
  zones, verify) with 1,000 people at up to 15 devices each; (c) a router Worker in front spends the 100,000 daily requests on
  print-dialog chatter. The plan lists this only as "names of the per-school addresses" (sec 7).
- **Notice.** Phase 4: the second school's phones cannot add the printer, or get certificate errors.
- **Cheapest prevention.** Decide now. My recommendation: option (a), one wildcard record per school created by hand at
  onboarding, and accept $10/month as the first deliberate paid item. The owner's school stays on `*.szvtech.org` untouched.
- **Test.** On the throwaway account and a spare domain: one two-level wildcard, one tunnel, add the printer on the Pixel 8,
  Windows 11 and the Chromebook. Also confirm the price and whether a card is required.

### 3. No backups, with other schools' data in the database
- **What goes wrong.** Supabase free has no automatic backups (verify) and pauses after a week idle. A bad migration, a
  mistaken delete, or a compromised key loses every school's users, rules, quotas and audit log. `docs/ROADMAP.md:25` lists a
  backup download as not built. There is also one project for live and test, so migrations are first tried on live.
- **Notice.** Only when something is already gone.
- **Cheapest prevention.** Move to Pro ($25/month, daily backups, no pause, spend cap on by default: verify) **before the second
  school connects**, not at the first paying school. Until then: a weekly `pg_dump` to the owner's PC, and a second free project
  as the migration test bed.
- **Test.** Restore a dump into the second free project and log in. A backup that has never been restored is not a backup.

### 4. A school server is a foothold into that school's network
- **What goes wrong.** `docs/SECURITY.md` says the gateway and agent install as LocalSystem by default; the limited account
  (`printio-svc`) and firewall rule are separate manual scripts run on the owner's PC only. In the new plan that same machine
  also accepts browser uploads from the internet and parses hostile PDFs. A parsing bug on another school's PC, running as the
  most powerful account, on a school network, is the worst outcome in this whole plan and it lands on the owner's name.
- **Notice.** Probably not at all.
- **Cheapest prevention.** The installer for other schools creates the limited account and the firewall rule by default, no
  opt-in. PDF work runs in a child process with a memory and time limit. Check the upload token before reading the body (the
  gateway already does this for device tokens, `server.ts:112`).
- **Test.** Fresh Windows VM, run the installer, check both services' account with `sc qc`. I could not find an installer
  script that sets the account, so assume it does not.

### 5. Signed updates: one bad release stops every school, or the signing key is as exposed as the repo
- **What goes wrong.** (a) A release with a bug in start-up or in the updater itself goes to all schools; the updater cannot
  fix itself. (b) The plan signs in CI, so the key is a GitHub secret: anyone who can change a workflow, or a build dependency
  running in the same job, can sign. That is barely better than today's `git pull` (`architecture.md` sec 12.1). (c) "Public-read"
  bundles make the private repo's code public anyway. (d) An old signed release can be replayed to downgrade a server.
- **Notice.** Servers go offline after "Update now".
- **Cheapest prevention.** Sign in a separate job that only receives the finished file and needs the owner's manual approval
  (GitHub environment), so no dependency code runs near the key. Build two public keys into the agent (one in use, one spare kept
  offline) so a lost key does not strand the fleet. Signed manifest carries version, minimum previous version and an expiry;
  the agent refuses downgrades. Keep the previous version on disk; a watchdog reverts if the new one has not reported healthy in
  5 minutes. The owner's server always updates first and runs 48 hours before any other school is offered the version. No
  automatic fleet-wide updates, ever.
- **Test.** On a VM: install version A, publish a deliberately broken B (crashes at start), press Update, confirm it comes back
  on A by itself. Then try to install a signed older version and a bundle with one byte changed.

### 6. The row-level-security rewrite lets one school see or change another's jobs
- **What goes wrong.** Phase 2 re-implements about 950 lines of proven routes (auth, leasing, quota) as database rules
  (`PHASE0-FINDINGS.md` "Too coupled"). All 60-odd existing policies are written for people (`to authenticated`,
  `private.user_org_ids()`), not servers. A policy that trusts an `org_id` written inside the token, a function that forgets
  the org check, or Realtime delivering another school's row is a cross-school leak. Today the website also uses the master key
  in 53 files, each one relying on a hand-written organisation filter.
- **Notice.** You would not, without a test.
- **Cheapest prevention.** Servers get **no table access at all**: a separate database role with permission to call about six
  functions (`claim_job`, `report_status`, `release_job`, `heartbeat`, `ack_command`, `resolve_device`). Each function looks the
  server up in `agents`, checks `status = 'active'`, and takes the organisation from that row, never from the token. Details in
  section 2.
- **Test.** A two-school test file against a local Supabase: school B's server credential calls every function and every
  table with school A's ids and must get nothing. Same for a school B admin in the browser. This needs no Cloudflare and should
  exist before phase 2 starts.

### 7. Realtime free limits are tighter than assumed
- **What goes wrong.** Free Realtime is about 200 connections and 2 million messages a month (verify). `agents` is in the
  Realtime publication (migration 0011). If 15 servers heartbeat every 30 s into `agents` and each listens to its own row, that
  is 15 x 2,880 x 30 = about 1.3 million messages a month from heartbeats alone, before any admin has a page open. Every open
  browser tab is one connection; 1,000 people at the morning rush can pass 200. Separately, Realtime sockets drop silently and
  a server token that expires on an open socket stops delivery without an error: jobs sit unprinted.
- **Notice.** Supabase usage page; "my job is stuck at waiting for a printer".
- **Cheapest prevention.** Heartbeats go to a table that is not published. Servers treat Realtime as a nudge only and still ask
  "anything for me?" every 60 s. Browsers connect only on pages with a live job.
- **Test.** Local script: 15 fake servers for an hour, count messages. Kill a socket mid-run and confirm the job still prints
  within 60 s.

### 8. The cutover breaks sign-in or printing
- **What goes wrong.** `NEXT_PUBLIC_APP_URL` is baked in at build time; Supabase redirect addresses and login cookies are per
  hostname; the Next and React upgrade ships at the same moment and has no logged-in test coverage (`PHASE0-FINDINGS.md`
  "Decision"); vinext and its tools are betas; logged-out pages already measure 11-15 ms against a 10 ms limit. If
  the DNS record for `beta.printio.app` is replaced, rollback waits on DNS.
- **Cheapest prevention.** Never move `beta.printio.app`. Launch the Cloudflare site on a **new** name and leave beta on the PC
  as the working fallback for a month. If the same name must be used later, lay a Worker route over the existing record:
  removing the route is an instant rollback with no DNS change (verify on the throwaway account). Ship the framework upgrade to
  the PC site first, weeks earlier, so it is not part of cutover.
- **Test.** A written click-through list (sign in by emailed link, print, approve, booklet, phone print) run on the new name by
  two real staff for a week.

### 9. Uploads straight to the school server fail in ordinary situations
- **What goes wrong.** A teacher at home in the evening: the school PC is asleep, so nothing can be uploaded (today it queues
  in the cloud). Cloudflare free cuts request bodies at 100 MB (verify) and the plan's limit is 100 MB. Responses slower than
  about 100 s are cut. A token copied from the browser can be replayed. A PDF address without `no-store` can be cached by
  Cloudflare.
- **Cheapest prevention.** Always-on PC as a written onboarding requirement; the print page shows "server offline" before a file
  is chosen. Limit 50 MB (what the gateway already uses, `config.ts:12`). Token: one school, one user, one job, 5 minutes, single
  use, checked before the body is read. Every response `Cache-Control: private, no-store`. Never do the PDF work inside the
  upload request: accept, answer, then process.
- **Test.** Without Cloudflare: a local fake school server and a browser page on another origin; check wrong-origin, expired,
  reused and oversize uploads are refused. With the throwaway account: a 99 MB and a 101 MB file through a tunnel.

### 10. School servers on the same domain as the website
- **What goes wrong.** If servers are `school.printio.app` and the site is `printio.app`, a compromised server can plant
  cookies for the whole domain and is treated as "same site" by browsers, weakening the login protections. One school server
  serving something abusive can also get the shared domain flagged by browsers for everyone.
- **Cheapest prevention.** A separate registered domain for servers (about $10 a year). Bot Fight Mode off on that zone (print
  clients and server-to-server calls are not browsers).
- **Test.** None needed; it is a naming decision. Make it before phase 3.

### 11. A free limit is hit and everything stops until midnight UTC
- **What goes wrong.** As far as I know, Workers free fails closed with an error page when 100,000 is reached and does not
  charge (verify). That honours "no surprise bills" but takes the website down for every school. Sources of a blow-out: a tab
  left open with the 30 s refresh (2,880 a day each, `phase0-code-inventory.md` sec 2), a bot crawling, a retry loop.
- **Cheapest prevention.** Because servers no longer go through the website, printing already queued keeps working. Add a daily
  usage email at 50% and 70%. Keep no card on the Cloudflare account until a paid item is chosen on purpose; note Workers Paid
  has no hard spend cap that I know of.
- **Test.** On the throwaway account, exhaust the quota with a script and see exactly what a visitor gets.

### 12. Sign-in email does not scale
- **What goes wrong.** Supabase's built-in email sender allows only a handful of messages an hour (verify). I found no custom
  mail sender in `docs/deployment.md` or `docs/STATE-2026-11-01.md`. A school onboarding 80 staff on one morning by emailed link
  would mostly fail.
- **Cheapest prevention.** A mail service with a free tier and the owner's domain (SPF/DKIM set up).
- **Test.** Check Supabase > Authentication > SMTP today. If empty, this is real.

---

## 2. Multi-school safety and sharing

**What a compromised school server could do, and the bound.**
| It could try | Bound |
|---|---|
| Read or claim another school's jobs | No table access; functions derive the school from the `agents` row (item 6) |
| Flood the database | Per-server rate limits inside the functions; heartbeat no faster than 30 s enforced server-side |
| Report fake printing, fake page counts, burn quotas | Only for its own school; audit log records the server id |
| Serve bad files to its own users | Unavoidable; it is their machine. Keep it off the website's domain (item 10) |
| Reach other schools' servers | No server-to-server tokens exist except the owner's push (remove it: section 4) |
| Poison shared daily text | Shared tables stay write-only for the owner's publisher identity |

**Credential design (my recommendation; resolves the open item in sec 7).**
- Keep today's `agentId.deviceSecret` (`docs/agent-api.md`), stored hashed. The server swaps it at one tiny endpoint for a
  1-hour Supabase token. Rotation and revocation stay exactly as built; a revoked server loses access at once because every
  function checks `agents.status`, and cannot renew.
- The token carries a dedicated role, not `authenticated`, so none of the 60 existing people-policies can apply to a server by
  accident. Unsure whether Realtime honours a custom role on the free plan: test it locally first; if not, fall back to
  `authenticated` plus a claim that every people-policy explicitly excludes.
- Custom claims versus a thin API: claims plus functions, because a thin API on the Worker puts printing back behind the
  100,000 limit. The one thing that stays an endpoint is the token swap and enrolment.
- The gateway uses the same per-server credential. `GATEWAY_SHARED_SECRET` (one value for every school,
  `apps/gateway/src/config.ts:5`) and the service-role key (`config.ts:7`) both go.
- The agent must refresh the token on the open Realtime socket before it expires.

**Onboarding.** Owner approves each new school by hand (no self-serve sign-up of organisations). Checklist: organisation
created, tunnel and address made by hand, enrolment code (30 minutes, single use), installer with limited account, test page,
data agreement signed.

**Offboarding.** One written runbook, tested once: disable the server credential; delete the tunnel and DNS record; delete or
export the organisation's rows (check every table has `on delete cascade` from `organizations`: I did not verify); remove auth
users who belong to no other school; uninstall script wipes the files folder on the PC; record the date in the audit log.

**Noisy neighbour and quotas.** Per-school caps in the database, not only per person: jobs per day, servers (start with 2),
devices, members. The existing per-member limits (15 devices, 10 waiting jobs, 300 sheets, `docs/SECURITY.md`) stay.

**Audit.** Server actions logged with server id. Super-admin reads of another school's data logged where the school's admin
can see them. `docs/STATE-2026-11-01.md:39` says a super admin gets no file access by default: keep that.

**Support access.** No standing access. A school admin grants the owner a time-limited (24 h) support role for their
organisation; it appears in their audit log and expires by itself.

**Student and staff data: questions for a lawyer or the schools (not legal advice).**
1. Do students, or only staff, get accounts? Are any users under 13 or under 18?
2. Which laws apply in each school's location (in the US: FERPA, COPPA, state student-privacy laws)?
3. Does each school need a written data agreement naming Printio as a service provider and Supabase and Cloudflare as
   subprocessors?
4. File names, job titles and document contents can contain student names and grades. Who is responsible for them, how long
   are they kept, and may the owner ever view them?
5. What must happen, and how fast, if a school server is stolen or an account is breached? Who notifies parents?
6. Where is the Supabase project hosted, and does any school require a particular country?
7. On leaving, what must be deleted and by when, and does the school need proof?
8. Do the font licences and the daily-study text sources allow distribution to other organisations, paid or unpaid?

**Backups and recovery.** Database: item 3. School files: short-lived by design; say plainly in onboarding that Printio does
not back them up. Server re-install: a new enrolment code restores everything except stored files.

**Incident: "a school server was stolen".** Disable that server in Admin (kills its credential at once); delete its tunnel;
revoke its device addresses if the token hashes were cached on disk; tell the school the files folder was on the disk (turn on
BitLocker at install so this is a non-event); check the audit log for the hour before. The current guide in `docs/SECURITY.md`
("rotate the service role key") must be rewritten once servers no longer hold it.

**Secrets.** After phase 2 the list should be: Supabase service-role key (Worker secret only), token-signing private key
(Worker secret), release-signing key (GitHub environment with approval, spare offline), deploy key for Cloudflare (GitHub,
Workers-only scope). Nothing on any school PC except its own device secret and tunnel token. Write the list in
`docs/SECURITY.md` with a rotation date for each.

**Observability without personal data.** Servers report counts, versions, error codes and durations only; no file names,
emails or job titles in logs sent off the machine. A daily owner email: servers offline over 24 h, version per school, free-tier
usage.

**Version skew.** Database changes only add (already a rule in `PHASE0-FINDINGS.md`). Server functions are versioned
(`claim_job_v1`); old ones stay until every server has moved. Each server reports its version; the database holds a minimum
supported version and the website tells the admin plainly when to update.

---

## 3. Challenge the decisions

| Decision | Verdict | Why |
|---|---|---|
| Scale 5-15 schools, 1,000 people | Keep | But build for 3 first. Several pieces only pay off above 15 |
| Supabase free + keep-alive, Pro at first paying school | **Change** | No backups on free. Go Pro before the second school connects, paying or not. The keep-alive is unnecessary once servers talk to Supabase |
| Deploy only on merge, one limited key in GitHub | Keep | Add: key scoped to Workers deploy only, never DNS or tunnels; deploy job behind manual approval |
| Printio creates tunnels automatically under the owner's account | **Change (riskiest)** | See below |
| Fonts: open fonts shipped, licensed stay with owner | Keep | Get the licence answer in writing before any pre-built booklet with a licensed font leaves the owner's school |
| Files only on school servers, direct upload | Keep, with eyes open | Right for cost and privacy. The price is "server off = cannot submit". Make always-on a requirement |
| Servers talk to Supabase directly | Keep, narrower | Functions only, no table access, polling backstop |
| vinext on the free plan | Keep as the trial, not a commitment | Betas plus a 10 ms limit already exceeded locally. If real numbers fail, $5/month and the older adapter is an acceptable answer; do not bend the app to stay free |
| Private repo | Keep, but know what it buys | Schools receive the code in the bundle anyway. It protects against casual copying, not a determined reader |
| Owner's server pushes pre-built booklets | **Change** | Make schools pull (section 4) or defer |

**The single riskiest decision: automatic tunnel and address creation under the owner's Cloudflare account.** It puts an
account-wide key behind a button that strangers' admins can press, to save about 5 minutes fifteen times. It directly conflicts
with the hard rule "nothing may put the owner's Cloudflare account at risk". **Cheaper alternative:** the owner creates each
tunnel by hand at onboarding. Zero code, zero standing key, and a natural moment to vet each school.

---

## 4. What would make it 10x simpler or safer

**Cut or defer.**
- Automatic tunnel creation: do not build.
- Pushing booklets to schools (phase 5, second half): do not build yet. If wanted later, each school's server **pulls** a signed
  list from the owner's server on a timer. That removes the only cross-school write path, the push tokens and the retry queue.
- The custom role and full row-level-security for servers: build six functions instead.
- "Update now" for the whole fleet: per-school button only, after the owner's canary.
- Self-serve "add your school": owner approves each one.
- Thumbnails, preview and page counting already run in the browser (`PHASE0-FINDINGS.md`): leave them.

**Buy instead of build.** Supabase Pro for backups ($25). The paid certificate for per-school addresses ($10, if item 2 confirms
it). A mail service free tier. A second domain ($10 a year). Total about $35-40 a month, or roughly $3-8 per school at 5-15
schools. That is cheaper than one serious incident.

**Five highest-value improvements.**
1. **Two-school isolation test suite** (M). Catches the leak class that would end trust in the service; needed before any
   second school regardless of hosting.
2. **Fold the agent's three calls into one and slow it to 15 s today** (S). `orchestrator.ts:846-861` makes three calls per
   cycle. One combined call cuts traffic by two thirds now, on the PC, with no architecture change, and makes phase 2 less urgent.
3. **Installer hardened by default** (M). Limited account, firewall rule, BitLocker check. Turns "a bug" from a network
   breach into a contained fault.
4. **Backups plus a tested restore** (S). Item 3.
5. **Canary and automatic revert in the updater** (M). The difference between one school having a bad morning and fifteen.

---

## 5. Revised phase order with gates and rollbacks

**Safe to build with no Cloudflare account at all:** phases A to D below. They all run on the PC site and a local Supabase.

**Before the owner connects any Cloudflare account, all of these must be true:**
- The trial uses a **throwaway** free account with no card and no real domain.
- The real account has two-step sign-in with a hardware key or authenticator, no card on file (until item 2 is decided), and
  an audit-log check has been done once.
- The only key ever issued from the real account is "Workers deploy" scope. No DNS or tunnel key exists.
- Server addresses use a separate domain.
- Item 1's scoping test and item 11's quota test have been run on the throwaway account and written down.

| Phase | What | GO gate | Rollback |
|---|---|---|---|
| A. Safety net | Weekly dump + restore test; second free Supabase project for migrations; two-school isolation tests; mail sender check | Restore works; isolation tests green | Nothing to roll back |
| B. Quick wins on the PC | One combined agent call at 15 s; browser refresh to slow backstop; Next/React upgrade shipped to the PC site | A week of normal printing; request count measured | Revert the PR; admin can already change poll speed |
| C. Heavy work becomes server jobs (plan's phase 1) | In the order in `PHASE0-FINDINGS.md`, each behind a switch | Website builds without PDF/font code; every flow on the click-through list passes on the PC | Flip the switch back per feature |
| D. Per-server credentials (plan's phase 2, narrowed) | Token swap endpoint, six functions, heartbeat table, Realtime nudge with 60 s backstop; gateway loses both shared secrets | Isolation tests cover servers; a second test server on a VM cannot see school one; owner's server ran the new path 2 weeks | Agent keeps the old route as fallback for one release; switch per server |
| E. Throwaway Cloudflare trial | Real CPU per page, quota behaviour, token scoping, two-level wildcard, 100 MB upload | Numbers written in `docs/PHASE0-FINDINGS.md`; free or $5 decided | Delete the throwaway account |
| F. Files on the school server (plan's phase 3) | Upload tokens, 50 MB, no-store, offline message | A month on the owner's school with no lost upload; evening-upload complaints counted | Switch back to Supabase storage per school |
| G. Updates and a second server (plan's phase 4, without auto tunnels) | Signed bundles, canary, auto-revert, hardened installer, hand-made tunnel | Broken-release drill passes on a VM; fresh install with no GitHub key | Previous version kept on disk; git-pull path stays on the owner's PC until two good releases |
| H. Website on Cloudflare, new name | Deploy on merge with approval; beta stays on the PC | Two staff use the new name for a week; usage under 50% of the daily limit | Tell people to use beta; nothing was moved |
| I. First outside school | Supabase Pro on; data agreement; onboarding runbook | Owner's school ran H for a month | Offboarding runbook |
| J. Retire the PC website | Only after I has run a month | No use of beta for two weeks | Start the PC site again (keep the script) |
| Later, if asked for | Shared booklets by pull; automatic tunnels | A real request from three schools | n/a |

The plan's own rule stands and is the most important line in it: nothing about hostnames, tunnels, DNS or the PC without the
owner's explicit yes (`PHASE0-FINDINGS.md` "Rules for every step").

---

## 6. Five questions for the owner

1. **Will you create each school's tunnel yourself (5 minutes per school) instead of Printio doing it automatically?**
   Recommendation: yes. It removes the most dangerous key in the plan.
2. **Will you pay $25 a month for Supabase before the second school joins, so there are backups?**
   Recommendation: yes. Until then, a weekly copy to your PC.
3. **Is it acceptable that nobody can send a print while a school's PC is off, including teachers at home in the evening?**
   Recommendation: accept it, make "the PC stays on" a condition of joining, and count complaints for a month before deciding
   whether a small cloud inbox is worth building.
4. **Per-school phone and laptop printing needs either about $10 a month for a certificate or a redesign of printer addresses.
   Which?** Recommendation: test the $10 route on a throwaway account first; if it works, pay it.
5. **Do the other schools get the pre-built daily booklets in the first version?** Recommendation: no. Ship printing first; add
   booklets by pull once the font licence question is answered in writing.

## What I did not verify
Every Cloudflare and Supabase limit and price (from memory); whether Realtime accepts a custom role; whether a Worker route
over an existing tunnel record gives instant rollback; whether all tables cascade on organisation delete; whether a custom mail
sender is already set in the Supabase dashboard; whether any installer already sets the limited account; how chatty real
print-dialog clients are. Each has a named test above.
