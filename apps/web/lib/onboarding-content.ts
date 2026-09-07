/**
 * Plain-data content for the first-login onboarding tour and the always-
 * available Help menu (components/help/HelpMenu.tsx, rendered by
 * components/help/SpotlightTour.tsx). Kept separate from the component so
 * the actual words are easy to find and edit without touching any UI logic
 * - this is the kind of content a non-engineer administrator might
 * reasonably want to tweak later.
 */

export interface TourSlide {
  title: string;
  body: string;
  /**
   * Stable key matching a `data-tour="<anchor>"` attribute on the real
   * element this step is talking about, somewhere in the app. Omitted for a
   * purely informational step (the welcome/closing slides) - SpotlightTour
   * renders those as a centered callout with no highlight. Also used as the
   * fallback rendering whenever an anchored element can't be found on the
   * page (not present for this role, an empty state, or still loading) -
   * SpotlightTour never points at nothing, it just centers instead.
   */
  anchor?: string;
  /**
   * The app route this step's anchor lives on (e.g. "/admin/printers").
   * When the tour advances into a step whose route differs from the
   * current page, SpotlightTour navigates there itself via next/navigation's
   * useRouter before it goes looking for the anchor. Omitted means "wherever
   * the tour already is" - true for the anchor-less welcome/closing slides,
   * which read fine on any page.
   */
  route?: string;
  /**
   * When true, this step doesn't advance on its own Next button - it waits
   * for the user to actually click the anchored element (a real click,
   * never intercepted or prevented - it still does whatever it normally
   * does) and advances right after. If the anchor can't be found for this
   * user (see `anchor` above), SpotlightTour falls back to a normal Next
   * button instead of waiting on a click that might never be possible.
   */
  clickToAdvance?: boolean;
}

/** Shown to student/staff roles - the people submitting print jobs. */
export const STUDENT_TOUR: TourSlide[] = [
  {
    title: "Welcome to Printio",
    body: "This replaces walking up to a shared printer and hoping for the best. Upload a PDF, choose how it should print, and Printio routes it to the right printer for you - with a record of every job. This tour will walk you through the actual screen elements as you go - click along where it asks you to.",
    route: "/home",
  },
  {
    title: "Your quota",
    body: "If your organization sets a monthly print quota, you'll always see how much you have left right here on Home.",
    anchor: "home-quota",
    route: "/home",
  },
  {
    title: "Print a document",
    body: "Click here to start a new print job.",
    anchor: "home-print-cta",
    route: "/home",
    clickToAdvance: true,
  },
  {
    title: "Choose your file",
    body: "Pick your PDF here. Nothing uploads yet - this just reads the file in your own browser so the rest of the form can show you what you're about to print.",
    anchor: "print-file-picker",
    route: "/print",
  },
  {
    title: "Instant preview",
    body: "As soon as you choose a file, you'll see a quick preview and page count right here - no upload required just to check you picked the right document.",
    anchor: "print-preview",
    route: "/print",
  },
  {
    title: "Choose how it prints",
    body: "Click a printer above to select it. Then choose color/double-sided/staple/booklet options below it - anything greyed out isn't supported by that printer. Booklet printing here is smarter than a normal print driver: each page is scaled to fill its own space, so one oddly-sized page doesn't force huge margins onto the rest of the booklet.",
    anchor: "print-printer-fieldset",
    route: "/print",
    clickToAdvance: true,
  },
  {
    title: "Submit your job",
    body: "Some jobs need an approver's OK first (large jobs, color, etc. - your organization sets the rules), which you'll see reflected on the job's status right after you submit. When you're ready, click Submit Job here.",
    anchor: "print-submit-button",
    route: "/print",
  },
  {
    title: "Track your job",
    body: "Click My Jobs to see everything you've ever submitted.",
    anchor: "nav-my-jobs",
    route: "/print",
    clickToAdvance: true,
  },
  {
    title: "Every job, live",
    body: "This list updates live as each job moves from approved, to sent to the printer, to printing, right up to completed.",
    anchor: "jobs-list-container",
    route: "/jobs",
  },
  {
    title: "Need a reminder?",
    body: "Click Help any time to replay this tour or look up what a term means.",
    anchor: "help-button",
    route: "/jobs",
  },
];

/** Shown to org_admin/approver roles. */
export const ADMIN_TOUR: TourSlide[] = [
  {
    title: "Welcome to Printio Admin",
    body: "You're set up as an administrator or approver. This is a quick tour of where things live and how they connect - it won't change anything, and you can replay it any time from Help. Click along where it asks you to.",
    route: "/admin",
  },
  {
    title: "Overview",
    body: "This dashboard only calls out things that need attention (pending approvals, offline agents, printers in error), not a wall of healthy stats - a quiet Overview page is a good sign.",
    anchor: "admin-overview-stats",
    route: "/admin",
  },
  {
    title: "Approvals",
    body: "Click here to open the approvals queue - jobs held for review show up here, with a live count badge in the sidebar.",
    anchor: "admin-stat-pending-approvals",
    route: "/admin",
    clickToAdvance: true,
  },
  {
    title: "Reviewing a job",
    body: "Approve or deny each job here - denying asks for a short reason, so the person who submitted it knows why.",
    anchor: "admin-approvals-queue",
    route: "/admin/approvals",
  },
  {
    title: "People",
    body: "Users (in the sidebar) and Groups (here) are where you manage who can print - groups are the departments/classes/cohorts that policies and quotas can target as a whole instead of one user at a time.",
    anchor: "admin-groups-panel",
    route: "/admin/groups",
  },
  {
    title: "Print infrastructure",
    body: "Printers lists every configured printer and its finishing profiles (duplex, booklet, staple, etc.); Agents (in the sidebar) shows the on-site program that actually sends approved jobs to each one.",
    anchor: "admin-printers-panel",
    route: "/admin/printers",
  },
  {
    title: "Setting up printers for the first time",
    body: "Click here for the guided setup wizard - it walks through a first-time full setup: plan which finishing profiles you need, confirm the Agent is online, then map each profile to a real discovered print queue. (You can still add a single profile directly from this page any time.)",
    anchor: "admin-printers-wizard-link",
    route: "/admin/printers",
    clickToAdvance: true,
  },
  {
    title: "Governance: Quotas",
    body: "Monthly print limits, scoped to the whole organization, a role, a department, a group, or a single user - when someone matches more than one, the lowest limit wins.",
    anchor: "admin-quotas-panel",
    route: "/admin/quotas",
  },
  {
    title: "Governance: Policies",
    body: "The rules that decide whether a job is automatically allowed, denied, or held for approval - a DENY rule always wins first, then REQUIRE_APPROVAL, then ALLOW, then your organization's default.",
    anchor: "admin-policies-panel",
    route: "/admin/policies",
  },
  {
    title: "Insights",
    body: "Reports shows usage by user/department/printer and recently denied/failed jobs. Audit log (org admins only, in the sidebar) is a full record of every administrative action.",
    anchor: "admin-reports-stats",
    route: "/admin/reports",
  },
  {
    title: "Need a reminder?",
    body: "Click Help any time to replay this tour or look up what a term means.",
    anchor: "help-button",
    route: "/admin/reports",
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
  { term: "Booklet", definition: "Pages arranged and folded like a small book (2 pages per sheet side, saddle-stitched). Printio scales each page independently to best fill its own space, rather than shrinking every page to match whichever one needs the most room." },
  { term: "Duplex", definition: "Double-sided printing - both sides of the physical sheet are used." },
  { term: "Printer profile", definition: "A specific set of finishing options (e.g. \"Booklet + Staple\") configured for a printer - a single physical printer can have several profiles for different jobs." },
  { term: "Agent", definition: "The small program running on-site that receives approved jobs from Printio and actually sends them to the printer over the local network." },
  { term: "Job status", definition: "The stage a job is at: Draft → Awaiting approval → Approved → Sent to printer → Preparing → Printing → Completed (or Denied/Failed/Expired/Cancelled if something stops it early)." },
  { term: "Enrollment code", definition: "A one-time code an administrator generates to connect a new Agent (or a new user, via an invitation code) to your organization." },
];
