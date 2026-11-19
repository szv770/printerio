# Printio as a bigger SaaS, and the printer-leasing partnership

Written 2026-11-19 as thinking material for the owner. Nothing here is built or decided. Read-only research: I read
`CLAUDE.md`, `docs/FEATURES.md`, `docs/ROADMAP.md`, `docs/SAAS-LAUNCH-PLAN.md`, `docs/TARGET-ARCHITECTURE.md` and
`docs/REQUEST-BUDGET.md`, plus two light web searches. Web facts are marked **(public sources, verify)**. Estimates are
marked **(estimate)**. I did not invent prices or market sizes.

---

## 1. Where we are vs the market

- **Strength: the normal Print button, no driver.** Printing from the OS print dialog on Windows and Android is proven
  (FEATURES.md). Many competitors need a client app, a driver or a per-device queue. That is a real selling point to a
  school office.
- **Strength: school-shaped features.** Booklets with left/right binding (Hebrew), stapling and punch, sender code on
  every page, "whose pile is this". Big vendors treat these as edge cases.
- **Strength: per-school isolation.** One schema for many orgs, isolation tests in CI, per-server credentials being built (phase D).
- **Strength: cloud + on-site server.** The printer never faces the internet; the website still works if the school's
  server is off.
- **Strength: plain-language admin and honest labels** ("Proven / Built, testing"). Rare, and builds trust.
- **Gap: one printer family.** Only the Kyocera TASKalfa class is proven. Competitors support nearly every brand.
- **Gap: no pull printing / secure release, no accounting or billing, no SSO sync, no fleet monitoring.** These are what
  buyers compare in a checklist (PaperCut, Printix, uniFLOW, YSoft, Pharos, PrinterLogic all lead with them).
- **Gap: Windows-only server, always-on PC, one-person company.** Install, updates and support do not yet scale.
- **Gap: iPhone and Mac.** FEATURES.md says iPhone is Proven, SAAS-LAUNCH-PLAN.md says AirPrint is "not working";
  the docs disagree. Settle this before any pitch.
- **Competitor pricing, for orientation only (public sources, verify):** Printix lists about $1.99 per user per month for
  small plans, partner/MSP pricing not published; PaperCut shows a one-time per-user licence on review sites (figures
  seen: $400-$435 per user, one time, unverified; I found no clean subscription price). I did not find dealer bundle prices.

---

## 2. Scale features

Impact = how much it helps get and keep customers. Effort: S = days, M = weeks, L = months (estimates, one developer
with an AI helper). Rank is my recommendation, best value for effort first.

### 2a. Ranked list

| # | Feature | Impact | Effort | Why it matters | Hardest part |
|---|---|---|---|---|---|
| 1 | **Fleet monitoring + supplies alerts** (toner, paper, jam, page counter, email/WhatsApp alert) | High | M | Admins and dealers both want it; the agent already reads printer status and the page counter (built, testing). | Each model words status differently; needs a real low-toner and a real jam to prove. |
| 2 | **Reports and cost recovery (chargeback)**: pages per person/group/class, cost per page, CSV export | High | M | The first thing a school business office or company finance asks for; it also feeds dealer billing. | Agreeing what counts as a page (duplex, colour, booklet sheets vs pages). |
| 3 | **Billing + self-service onboarding** (trial, plan, invoice, "add my first printer" checklist) | High | M-L | Without it every customer costs the owner hours. Launch plan already has the checklist and Stripe/Square later. | The server install (Windows, tunnel, printer) is the real blocker, not the website. |
| 4 | **SSO and automatic user sync** (Google Workspace, Microsoft Entra; classes/groups import) | High | M | Schools will not type 500 emails. Google sign-in exists but is switched off. | Student accounts raise legal questions (FERPA/COPPA); needs a data agreement first. |
| 5 | **Secure release / pull printing** (print, then tap or enter a code at the printer) | High | L | The most requested feature in print management; stops forgotten piles. | Kyocera panel integration (HyPAS-type apps) is vendor-specific; a code on the website or phone is the cheap first version (M). |
| 6 | **Printer test-pack system per model** (the "Test Lab" in ROADMAP) | High | M | Lets customers or the dealer add new models safely; protects reputation. | Needs people with the physical printer to run and report. |
| 7 | **Webhooks and a small API** | Medium | S-M | Lets a dealer's billing/service system pull meter reads and events without custom work. | Keeping the API stable and per-org secure. |
| 8 | **Multi-site / multi-server per org** (one district, several buildings) | Medium | M | Natural growth path for schools with several campuses. | Routing a job to the right building's server; permissions per site. |
| 9 | **Templates for school workflows** (Hebrew booklet, test pack, class set, daily study) | Medium | S-M | Strong differentiator, already half built (booklet builder, daily study). | Needs the real paper test the owner has not done yet. |
| 10 | **Guest printing** (visitor prints with a one-time code, auto-expires) | Medium | M | Offices and schools with parents/visitors. | Abuse and cost control; no accounts to trace. |
| 11 | **White-label for partners** (name, logo, colours, sub-domain) | Medium now, High if a partner signs | M | Needed for a reseller deal (section 3). | Branding every email, page and install screen consistently. |
| 12 | **Compliance pack** (audit log export, retention settings, data-processing agreement, FERPA/COPPA statement, delete-on-request) | High for schools | M | Schools and companies ask for it in procurement. | Needs a lawyer's view; do not self-certify. |
| 13 | **Admin analytics / eco stats** (trees, CO2, waste, "jobs never collected") | Low-Medium | S | Cheap, looks good in a sales demo. | Honest numbers; do not overclaim. |
| 14 | **Document security** (watermark, hold sensitive jobs, block classified files) | Low-Medium | M | Offices with confidential files. | False positives annoy people. |
| 15 | **Scan-to-cloud / scan-to-email** | Medium | L | Kyocera MFPs scan; customers ask for it. | Printer-side setup per model; different product surface. |
| 16 | **Native mobile apps** | Low now | L | The Print dialog and the installed web app already cover the need. | App store reviews and upkeep for one person. Skip. |

### 2b. Build first (top 5) and why

1. **Fleet monitoring + supplies alerts.** Needed by customers, and it is the most useful thing to offer a leasing company.
   Most of the plumbing (printer status, page counter) already exists.
2. **Reports + chargeback export.** Small to build on existing job data; unlocks finance buyers and dealer billing.
3. **Test-pack system per printer model.** Every new customer or partner brings new models. This protects you from
   "works on one printer only" and is the gate for growth.
4. **Self-service onboarding (checklist, org creation, installer).** Support load is the real limit for one person. Mostly
   already in the launch plan (tracks 2 and 4).
5. **Webhooks + small API (meter reads, device list, events).** Cheap (S-M), and it is what makes a dealer partnership
   possible without custom work for each dealer.

Why not secure release first: it is the most requested but the largest (L) and printer-specific. Offer the cheap version
(release with a code from the phone) later. Why not SSO first: valuable, but it pulls in student-data legal work.

### 2c. Five things that hurt at scale if left alone

| Risk | What happens | What to do |
|---|---|---|
| **Support load on one person** | Every install, "my phone cannot find the printer", and printer quirk lands on the owner. | Docs + copy-for-AI text, "report a problem" with logs, status page (launch plan track 3 and 5); a paid support tier for partners. |
| **Per-model printer testing** | Staples, punch, booklets and paper type differ by model; a wrong paper size makes the printer wait and blocks everyone (launch plan risk 10). | Test pack per model, unproven options hidden, an "approved models" list. Never promise a model before it passes. |
| **Update rollouts** | A bad update breaks every school at once; the update button was untested for weeks; installs fail on odd Windows machines. | Staged releases, rollback, signed installer (phase G, track 4). Drill with a deliberately broken release. |
| **Data privacy** | Student data, per-org isolation, a stolen server. | Data agreement before student data, lawyer's view, per-server revocable credentials (phase D), offboarding runbook. |
| **Request budget and hosting limits** | Cloudflare free allows about 100,000 requests a day total; each extra school at 10 s polling costs about 11,500 (REQUEST-BUDGET.md); Supabase needs Pro before the second org. | Pay the $5 Workers plan beyond about 5 schools, Supabase Pro at school 2, watch usage, move to Realtime instead of polling. Cheap compared to a customer outage. |

A sixth, quieter risk: **Windows-only, always-on PC at each customer.** Many small offices do not have one. A tiny
box (mini-PC) shipped by the dealer could solve this (see section 3).

---

## 3. The leasing-company partnership

The owner's idea: a printer leasing company adds Printio to its monthly lease, so each customer gets a Printio account
when they rent a printer.

### (i) Why it can work, and why it may not

**Why it can work**
- Dealers already bill monthly per device and already visit the customer. Printio can ride the same invoice and the same visit.
- Dealers want to stay "sticky". Software that customers use daily makes switching to another dealer harder.
- A printer that is easy to print to generates fewer "it does not print" support calls for the dealer.
- Customers accept add-ons offered at signing far more often than add-ons sold later (the owner's point, and it is how
  dealers sell service plans in general; I have no figures).
- Kyocera is a first target already; many dealers carry Kyocera (verify with the dealer).

**Why it may not**
- Dealers are conservative and already have tools. Many copier dealers resell PaperCut, uniFLOW or the vendor's own
  fleet software (public sources, verify); they may not see a reason to add a one-person startup.
- Dealers need a product that works on every model they lease. Printio proves one model family.
- Dealers need support they can call. The owner is one person.
- The dealer's field technician installs it. If the installer is not nearly foolproof, it creates dealer headaches.
- Billing and contract work (who is liable when it fails, data protection) takes months with a bigger counterpart.
- Dependence: one large partner can dominate your roadmap or squeeze your price.
- Billing models in this industry vary (public sources, verify): cost per page from meter reads, a base fee plus overage,
  or a flat fee per device; some dealers moved away from customer meter readings. Whichever the dealer uses, Printio's
  fee has to fit in without hurting their margin.

### (ii) Deal models

| Model | What the partner gets | What the owner gets | Main risk |
|---|---|---|---|
| **A. Referral fee** (dealer introduces; customer signs up and pays Printio directly; dealer gets a one-time or yearly fee per customer) | Small extra income, nothing to run or invoice | Customers at low cost, owner keeps the relationship and the price | Dealer has little reason to push it; weak commitment. Easiest to start. |
| **B. White-label / reseller** (dealer sells it under its own name and bills the customer; owner bills the dealer wholesale) | A product with their brand, their margin, their invoice | Fewer, bigger customers, no billing to each customer | Needs partner console and branding (NEW work); dealer owns the customer; support split must be clear. |
| **C. Bundled per-device monthly add-on** (a fixed monthly line per leased printer, inside the lease or next to it) | Predictable extra monthly revenue per device; fits how they already bill | Revenue per printer, tied to the lease life, minimal selling | Needs device registry linked to the lease, and your price per device must cover support. A customer who cancels the lease cancels Printio. |
| **D. Revenue share** (customer pays dealer or Printio; split by an agreed percentage) | Aligned incentives, no upfront cost | Shared upside, dealer motivated to grow it | Hard to audit; disputes about who counts; slow to start. |

My recommendation (an opinion, not a fact): **start with A or C with one dealer, written as a simple pilot agreement**;
move to B only if the dealer proves they sell it and you have a partner console. Avoid D at first.

Price thinking (estimate, not market data): competitors list roughly a couple of dollars per user per month for small
plans (public sources, verify). A per-printer monthly price is what schools in the launch plan already assume
(FEATURES.md "business ideas"). Choose the price only after the dealer tells you their margin and what their customers
already pay for similar software.

### (iii) What a dealer actually needs from the product

| Need | Status | Effort | Notes |
|---|---|---|---|
| **Partner console**: one login to see and manage many customer orgs | NEW | M-L | There is a platform super-admin area; a scoped "partner" role and a customers list do not exist. |
| **Create a customer org with its first admin in one step** | PARTIAL | S | Planned in launch plan track 2 item 2; today takes join-then-invite. |
| **Branding** (name, logo, colours, sender email, sub-domain) | NEW | M | See "White-label" in 2a. |
| **Consolidated billing** (one invoice to the dealer, usage per customer) | NEW | M-L | Payments are outside the app now. Start with a monthly CSV and an invoice by hand. |
| **Device registry linked to the lease** (printer serial, model, lease or contract ID, customer, site) | PARTIAL | M | Printers and profiles exist in each org; no serial/contract field or cross-customer view. |
| **Meter reads** (page counter per device, monthly snapshot, export) | PARTIAL | S-M | The agent already reads the printer page counter for job confirmation; a monthly snapshot per device and an export are not built. Colour/duplex counting must be agreed. |
| **Supplies and status alerts** feeding the dealer's service desk (toner low, jam, offline) | PARTIAL | M | Printer status reads exist (built, testing; a real jam or paper-out message has not been seen). Alerts by email and a webhook are not built. |
| **Approved-model list and test pack** | PARTIAL | M | Test Lab idea exists in ROADMAP; process is manual today. |
| **Installer a technician can run** (.exe, pairing code, green check) | NEW | L | Launch plan track 4 stage 2; today a PowerShell script and a remote install by the owner. |
| **Support tiers** (dealer first line, owner second line, response times) | NEW | S (documents), ongoing | Docs, copy-for-AI text and report-a-problem are planned (track 3). |
| **Data agreement and privacy terms** | NEW | S-M | Needs a lawyer's view; see below. |
| **Per-org isolation and per-server credentials** | PARTIAL | M | Isolation tests exist; phase D is in progress. A hard requirement before any outside customer. |

Reading the table honestly: for a **pilot** (model A or C with one dealer) you need only the rows marked S, a manual
process for billing and org creation, and the owner doing installs. A real **reseller** deal needs most of the
NEW rows, which is months of work.

### (iv) How to start small

**Who:** one friendly local dealer who already leases Kyocera, ideally one the owner knows. Not a national chain.

**Shape:** 3 pilot customers (ideally two schools or small offices and one that already has the same TASKalfa model),
a 3-month pilot, a one-page written agreement.

**What to prove first (in this order)**
1. The exact printer model(s) in the dealer's lease catalogue pass a labelled test pack, including print-dialog printing
   from Windows and Android (and iPhone, only if actually proven).
2. A dealer technician (not the owner) can install a customer in a set time, with the written steps, and it works.
3. Meter reads match the printer's own counter for a month (compare with the dealer's own reads).
4. The customer says "this is easier than before" and keeps using it after the novelty.
5. The dealer's support calls go down, not up. Count them.

**What NOT to promise yet**
- **Every model.** Each model must pass the test pack first. Offer an approved list, not "all Kyocera".
- **24/7 support or response times.** The owner is one person. Promise business-hours email, nothing faster.
- **Student data or Chromebook controls** until a data agreement is signed and a lawyer has looked at the student-data
  question (launch plan: "Honest limits").
- **A finished white-label, consolidated billing or partner console.** Say these are planned if the pilot works.
- **Uptime guarantees** while the website hosting move (Cloudflare or alternative) is still in progress.
- **Secure release at the printer panel, scan-to-cloud, other brands.**
- **iPhone/AirPrint**, until the docs agree it works.
- **Exclusivity.** Do not give exclusivity to one dealer in the pilot.

**Owner capacity check:** one person plus AI tooling. Three pilot customers, hand-installed, is realistic; ten is not
without the installer and docs. Keep the pilot small on purpose.

### (v) One-page pitch outline (plain words)

1. **The problem for your customers.** "Customers rent a printer, then phones and laptops cannot find it, staff email
   files to someone who prints them, and nobody knows who printed what. You get the calls."
2. **The answer.** "With Printio, people press the normal Print button on a laptop or phone and it comes out of the right
   printer. No drivers. The admin sees every job and sets rules. Booklets, stapling and hole punch work from the
   dialog."
3. **What you get.** Fewer service calls, a reason for the customer to stay, a monthly line per device, and meter reads
   and low-toner alerts for your own service desk (when built: say what is planned).
4. **What the customer gets.** A Printio account when the printer arrives. Setup steps on one screen.
5. **How it works.** A small program in the customer's building talks to the printer; the website never exposes the printer
   to the internet.
6. **Proof.** "Running now at [school], on a real Kyocera TASKalfa, printing from Windows and Android." Be exact about
   what is proven (FEATURES.md labels) and what is being tested.
7. **The pilot.** Three customers, three months, we install together, you tell me what breaks.
8. **The deal options.** Referral, per-device add-on, or later your own branded version. Price from your margin.
9. **What I need from you.** Two or three customers, one printer to test, and your honest feedback on pricing.
10. **What I am not promising yet.** Every model, 24/7 support, student data. Say it up front; it builds trust.

### (vi) Questions for the dealer's first meeting

**Their business**
- Which printer brands and models do you lease most? Roughly how many active leases, and how many are schools?
- How do you bill: cost per page from meter reads, a base fee plus overage, or a flat fee per device?
- How do you collect meter reads today (remote software, customer submits, technician)? Which fleet software do you use?
- What do customers call you about most? How many calls a month are "I cannot print"?

**Existing tools and competitors**
- Do you already resell PaperCut, uniFLOW, Printix or a Kyocera tool? Is it included in leases or extra?
- What do customers pay for it today? What do they complain about?

**The deal**
- Would you rather refer, resell under your name, or add a monthly fee per device? What margin do you need?
- Who owns the customer relationship and the customer data?
- Do you need exclusivity? (Answer: not now.)
- Who does first-line support? What response times would you expect from me?

**Practical**
- Who installs at the customer: your technician or the customer's IT? Do customers have an always-on Windows PC, or would
  you supply a small box?
- Can I get one test printer on your lease catalogue for the test pack?
- What do contracts and data protection terms look like on your side? Do you use a standard agreement?
- Which three customers would you try this with, and when?

---

## 4. Short roadmap

Consistent with `docs/SAAS-LAUNCH-PLAN.md` (independence and one-button updates first, then phases A-J, tracks 2-5).
The partnership pilot sits after the first outside school, not before, because the dealer's customers are outside schools
and offices.

### Now (this month)
- Finish the hosting independence work and the reliable "Update this server" button (launch plan priority override).
- Finish per-server credentials (phase D); nothing outside the owner's server before it.
- Settle which devices are really proven (iPhone/Mac statement) and make FEATURES.md, the home page and the app banner agree.
- Write the two-page dealer pitch (section 3v) and the question list; talk to **one** dealer informally. No commitments.
- Ask the dealer which Kyocera models they lease, to start the model list for the test pack.

### Next 3 months
- First 1-2 outside orgs hand-held (phase I): Supabase Pro on, data agreement signed, remote install.
- First-run checklist and one-step org creation (track 2); docs and "report a problem" (track 3).
- Fleet monitoring: status and toner/paper alerts by email; a monthly page-counter snapshot per printer with CSV export.
- Test-pack process for a new model, run on the dealer's model if they lend a printer.
- Start the dealer pilot (model A or C) with up to 3 customers once the installer or the hand-install path is steady and
  the data agreement exists.

### Later
- Signed .exe installer and signed update bundles (track 4, phase G) so a technician can install alone.
- Reports and chargeback, webhooks and API, partner console, branding, consolidated billing (only if the pilot succeeds).
- SSO and user sync, then the student-data and compliance pack with a lawyer.
- Secure release with a code from the phone, then printer-panel integration if customers insist.
- More printer brands, only through the test-pack process.

---

## 5. Open questions for the owner

1. **Which pilot shape do you prefer: referral (dealer introduces, you bill) or a per-device monthly add-on?** The first is
   quicker and safer; the second is closer to your idea.
2. **Is there a dealer you already know, and which Kyocera models do they lease?** That decides the first test pack.
3. **How many hand-installed customers can you really support per month alongside your other work?** (My guess is three;
   confirm.) This sets the size of any pilot.
4. **Would you accept shipping a small always-on box (mini-PC) with the install pre-loaded for customers with no spare
   Windows PC?** It removes the biggest setup risk but adds hardware, cost and returns.
5. **Do you want student accounts at all in the first year?** If not, the pilot can focus on offices and teacher-only
   school use and skip the heaviest legal work.
6. **Who should own the customer's data and the relationship in a dealer deal?** This one choice decides whether the
   reseller or the referral model fits, and what the data agreement must say.

---

### Sources for web facts (verify before relying on them)
- Printix and PaperCut price listings: G2, Capterra, Software Advice and a third-party site (rfp.wiki) turned up in a
  search. Printix about $1.99 per user per month starting price, partner pricing not public; PaperCut one-time per-user
  licence figures vary by listing. No dealer bundle prices found.
- Managed print billing (meter reads, cost per page, base plus overage, per-device flat fees, remote monitoring of toner
  and counters, Marco moving toward device/seat-based billing): trade and vendor pages found by search, for example
  enxmag.com and marconet.com. Marketing material; check with the actual dealer.
