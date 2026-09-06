/**
 * Plain-data content for the first-login onboarding tour and the always-
 * available Help menu (components/help/HelpMenu.tsx). Kept separate from the
 * component so the actual words are easy to find and edit without touching
 * any UI logic - this is the kind of content a non-engineer administrator
 * might reasonably want to tweak later.
 */

export interface TourSlide {
  title: string;
  body: string;
}

/** Shown to student/staff roles - the people submitting print jobs. */
export const STUDENT_TOUR: TourSlide[] = [
  {
    title: "Welcome to PrintOS",
    body: "This replaces walking up to a shared printer and hoping for the best. Upload a PDF, choose how it should print, and PrintOS routes it to the right printer for you - with a record of every job.",
  },
  {
    title: "Print a document",
    body: "From Home, choose \"Print a document.\" Pick your PDF and you'll see a quick preview and page count immediately, right in your browser - nothing uploads until you submit.",
  },
  {
    title: "Choose how it prints",
    body: "Pick a printer, then color/double-sided/staple/booklet options - anything greyed out isn't supported by that printer. Booklet printing here is smarter than a normal print driver: each page is scaled to fill its own space, so one oddly-sized page doesn't force huge margins onto the rest of the booklet.",
  },
  {
    title: "Approval & quota",
    body: "Some jobs need an approver's OK first (large jobs, color, etc. - your organization sets the rules). If you have a monthly print quota, you'll see it on Home and on the Usage page.",
  },
  {
    title: "Track your job",
    body: "After you submit, you're taken straight to that job's status page, which updates live as it moves from approved, to sent to the printer, to printing. \"My Jobs\" lists everything you've ever submitted.",
  },
  {
    title: "Need a reminder?",
    body: "Click Help any time (top right) to replay this tour or look up what a term means.",
  },
];

/** Shown to org_admin/approver roles. */
export const ADMIN_TOUR: TourSlide[] = [
  {
    title: "Welcome to PrintOS Admin",
    body: "You're set up as an administrator or approver. This is a quick tour of where things live - it won't touch anything, and you can replay it any time from Help.",
  },
  {
    title: "Overview & Approvals",
    body: "Overview is your at-a-glance dashboard - it only calls out things that need attention (pending approvals, offline agents, printers in error), not a wall of healthy stats. Approvals is where jobs held for review show up, with a live count badge in the nav.",
  },
  {
    title: "People, infrastructure, governance",
    body: "The nav below is grouped: People (Users, Groups) for who can print; Print infrastructure (Printers, Agents) for the physical setup; Governance (Policies, Quotas) for the rules about who can print what and how much.",
  },
  {
    title: "Insights",
    body: "Reports shows usage by user/department/printer and recently denied/failed jobs. Audit log (admins only) is a full record of every administrative action.",
  },
  {
    title: "Need a reminder?",
    body: "Click Help any time (in the sidebar) to replay this tour or look up what a term means.",
  },
];

export interface GlossaryEntry {
  term: string;
  definition: string;
}

export const GLOSSARY: GlossaryEntry[] = [
  { term: "Quota", definition: "A monthly limit on how much you (or your role, department, or group) can print, measured in pages, sides, sheets, or color-weighted sheets depending on how your organization configured it. Shown on Home and Usage." },
  { term: "Approval", definition: "Some jobs need a human OK before they print - based on rules your organization set (e.g. color jobs, large jobs, certain roles always require approval). You'll see \"Awaiting approval\" as the job's status until an approver decides." },
  { term: "Policy / rule", definition: "The configured rules that decide whether a job is automatically allowed, denied, or held for approval - things like page count, color, or role can each have their own rule." },
  { term: "Booklet", definition: "Pages arranged and folded like a small book (2 pages per sheet side, saddle-stitched). PrintOS scales each page independently to best fill its own space, rather than shrinking every page to match whichever one needs the most room." },
  { term: "Duplex", definition: "Double-sided printing - both sides of the physical sheet are used." },
  { term: "Printer profile", definition: "A specific set of finishing options (e.g. \"Booklet + Staple\") configured for a printer - a single physical printer can have several profiles for different jobs." },
  { term: "Agent", definition: "The small program running on-site that receives approved jobs from PrintOS and actually sends them to the printer over the local network." },
  { term: "Job status", definition: "The stage a job is at: Draft → Awaiting approval → Approved → Sent to printer → Preparing → Printing → Completed (or Denied/Failed/Expired/Cancelled if something stops it early)." },
  { term: "Enrollment code", definition: "A one-time code an administrator generates to connect a new Agent (or a new user, via an invitation code) to your organization." },
];
