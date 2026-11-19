# Waiting on you (the owner)

Things only you can do, saved for when you are at your PC or have time. **Claude puts the top 3 at the start of every message to you.** When you finish one, tell Claude and it
moves to "Done" below. Last updated 2026-11-19.

## Do soon (top 3)
| # | What | Why it matters | Where / time |
|---|---|---|---|
| 1 | **Timing run of the PDF steps** on the print server with 4-5 real PDFs | It is the only honest test of "a few seconds, never minutes". Nothing can go live for other schools without it. | At the print server PC, about 10 minutes. Steps: `docs/PREPARE-BENCH.md` |
| 2 | **Gateway key swap (D1):** put the public key in the gateway, test one phone print, then delete the master key line | Removes the all-powerful database key from the customer-site gateway. Required before a second school. | At the print server PC, about 10 minutes. Steps below |
| 3 | **Free Cloudflare account** for the website trial | Needed to prove the website can run on Cloudflare's free plan (the whole "website runs on its own" goal). | Any computer, about 15 minutes. Tell Claude when you are there and it walks you through |

### Steps for #2 (gateway key swap)
1. Supabase dashboard > your project > Project Settings > API: copy the public **anon / publishable** key (not the service role key).
2. On the print server, open `apps\gateway\.env` and add the line `SUPABASE_ANON_KEY=<the key>`.
3. Press **Update this server** (or restart the gateway), then print one test page from a phone. It must still print.
4. Only after that works: delete the `SUPABASE_SERVICE_ROLE_KEY` line from `apps\gateway\.env`. (The website keeps its own key in `apps\web\.env.production.local`; that is separate.)

## Waiting for your answer or a click
- **Database migrations 0054, 0055, 0057, 0058** (live database). Claude checked everything first and is ready. The tool asked for a confirmation click while you were away and timed out; **nothing was applied**. Reply "retry" and press **Allow** when the card appears. 0054 is a security fix; the others add tables and a switch that stays OFF.
- **Admin dashboard plan** (`docs/ADMIN-DASHBOARD-PLAN.md`): read the proposed 7-section menu and the home-screen sketch, then answer these 6 before anything is built:
  1. Is **"Print server"** the one word everywhere, with "Agent" gone from the screen?
  2. What should the first-run **"I'm stuck"** button do (email you, open a help page, start a chat)?
  3. What should **approvers** be able to see and change?
  4. Do schools **charge for printing**, and how (per page, per sheet, by group)?
  5. Which **email alerts** matter most, and who gets them?
  6. What goes on the **billing placeholder** page (payment is outside the app for now)?
- **Ideas for scaling and the printer-leasing partnership** (`docs/SAAS-IDEAS-AND-PARTNERSHIPS.md`): read it, then tell Claude which ideas you like and answer these 6:
  1. Partnership shape: a **referral** or a **per-device monthly add-on** (the document recommends starting with one of these, not revenue share)?
  2. Which **dealer** and which printer models would you approach first?
  3. How many **hand-installs** can you personally support in the first 3 months?
  4. Would you ship a small **mini-PC box** for the print server instead of relying on a school's Windows PC?
  5. Take **student accounts** in year one, or staff only?
  6. Who **owns the customer data** (school, dealer, you)?

## Later (not urgent, but do not forget)
- **Real-device tests** (you test on real devices; Apple only by borrowing): Pi, Pixel 8, Windows 11, Chromebook, an iPhone/Mac. Checklist in `docs/ipp-printing.md`.
- **Switch ONE school on for the print-server path** (only after #1 passes and Claude has compared the outputs on real files). Two things, both for that school only:
  1. On that school's print server, set `PRINTIO_PREPARE_WORKER=1` and press Update.
  2. In the Supabase SQL editor (find the school id with `select id, name from organizations;`):
     ```sql
     update organization_settings set prepare_via_server = true where organization_id = '<the school id>';
     ```
     To switch it back off: the same with `false`. Nothing is lost either way.
- **Supabase Pro ($25/month) before school #2.** It also unlocks "Leaked password protection" (Supabase's own security check shows it as off).
- **Disconnect the old Vercel project** from GitHub (it only adds a red "Account is blocked" mark to pull requests).
- **Data agreement / lawyer review** before any student data from another school.
- **Update button, one-time catch:** if "Update this server" ever says it could not install, run `docs/hardening/fix-update-permissions.ps1` once on that server.
- **Pick a payment method for beta schools** (Zelle or check is fine; Stripe or Square later).

## Done
- Migrations are written, tested in CI, and checked against the live database (nothing applied yet; see above).
