/**
 * Plain-data content for the first-login onboarding tour and the always-
 * available Help menu (components/help/HelpMenu.tsx, rendered by
 * components/help/SpotlightTour.tsx). Kept separate from the component so
 * the actual words are easy to find and edit without touching any UI logic
 * - this is the kind of content a non-engineer administrator might
 * reasonably want to tweak later.
 */

/**
 * The guided walkthrough has two switches (owner decision 2026-11-19: show screenshots before it starts for anyone).
 *
 * TOUR_REPLAY_ENABLED: the Walkthrough tab in the Help window can start it and replay it.
 * TOUR_AUTOSTART: it starts by itself the first time someone signs in. Keep this false until the owner has seen the
 * rebuilt walkthrough on real pages (every anchor, phone width included).
 */
export const TOUR_REPLAY_ENABLED = true;
export const TOUR_AUTOSTART = false;

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

/** Shown to staff and student roles: the people sending print jobs. */
export const STUDENT_TOUR: TourSlide[] = [
  {
    title: "Welcome to Printio",
    body: "Send a document to the printer from your phone or computer, choose how it comes out, and see where it is. This takes about a minute. You can leave at any time.",
    route: "/home",
  },
  {
    title: "Your monthly limit",
    body: "If your organization sets a monthly limit, you can see how much you have left right here.",
    anchor: "home-quota",
    route: "/home",
  },
  {
    title: "Start a print",
    body: "Press this button whenever you want to print something.",
    anchor: "home-print-cta",
    route: "/home",
    clickToAdvance: true,
  },
  {
    title: "Choose your file",
    body: "Pick your PDF here. Nothing is sent yet. Printio just reads it in your browser so you can check it.",
    anchor: "print-file-picker",
    route: "/print",
  },
  {
    title: "Check the preview",
    body: "You will see a small preview and the page count, so you know you picked the right document.",
    anchor: "print-preview",
    route: "/print",
  },
  {
    title: "Your printer",
    body: "This is where your job will print. If there is more than one printer, you choose here.",
    anchor: "print-printer-fieldset",
    route: "/print",
  },
  {
    title: "Choose how it prints",
    body: "Pick one-sided or two-sided, a staple, or a booklet, and set how many copies. Anything that cannot go together is greyed out, with a note saying why. Printio remembers your choices for next time.",
    anchor: "print-options",
    route: "/print",
  },
  {
    title: "Send it",
    body: "The panel at the bottom shows how many sheets this will use. Some jobs need an approver to say yes first. You will see that on the job. When you are ready, press Print.",
    anchor: "print-submit-button",
    route: "/print",
  },
  {
    title: "Follow your job",
    body: "Open My jobs to see everything you have sent.",
    anchor: "nav-my-jobs",
    route: "/print",
    clickToAdvance: true,
  },
  {
    title: "Every job, live",
    body: "This list updates by itself as each job goes from waiting, to printing, to printed.",
    anchor: "jobs-list-container",
    route: "/jobs",
  },
  {
    title: "Need a reminder?",
    body: "Open Help at any time. It explains the page you are on, replays this walkthrough, and has a glossary.",
    anchor: "help-button",
    route: "/jobs",
  },
];

/** Shown to organization admins and approvers. */
export const ADMIN_TOUR: TourSlide[] = [
  {
    title: "Welcome to Printio for admins",
    body: "A quick look at where things live. It will not change anything, and you can replay it any time from Help.",
    route: "/admin",
  },
  {
    title: "Overview",
    body: "This page only shows what needs you: jobs waiting for a yes or no, print servers that are offline, and printers with a problem. A quiet page is a good sign.",
    anchor: "admin-overview-stats",
    route: "/admin",
  },
  {
    title: "Approvals",
    body: "When jobs are waiting for a yes or no, they appear here. Press it to open them.",
    anchor: "admin-stat-pending-approvals",
    route: "/admin",
    clickToAdvance: true,
  },
  {
    title: "Say yes or no",
    body: "Approve or deny each job. If you deny one, add a short reason so the person knows why.",
    anchor: "admin-approvals-queue",
    route: "/admin/approvals",
  },
  {
    title: "Groups",
    body: "Put people into departments or classes. Then a rule or a monthly limit can apply to the whole group at once. Add people from Users and Invites in the menu.",
    anchor: "admin-groups-panel",
    route: "/admin/groups",
  },
  {
    title: "Printers",
    body: "Here are your printers and the print queues people send jobs to, such as double-sided or booklet. Print servers, in the menu, are the Windows computers that pass jobs on to each printer.",
    anchor: "admin-printers-panel",
    route: "/admin/printers",
  },
  {
    title: "Set up a printer",
    body: "The guided setup helps you choose which print options to offer, checks your print server is online, and connects each option to the printer. You can still add a single queue from this page later.",
    anchor: "admin-printers-wizard-link",
    route: "/admin/printers",
    clickToAdvance: true,
  },
  {
    title: "Monthly limits",
    body: "Set how much people can print each month, for everyone, a role, a group or one person. If someone fits more than one limit, the lowest one applies.",
    anchor: "admin-quotas-panel",
    route: "/admin/quotas",
  },
  {
    title: "Print rules",
    body: "Rules decide whether a job is allowed, needs approval, or is not allowed. Not allowed always wins first, then needs approval, then allowed. If nothing matches, your organization default applies.",
    anchor: "admin-policies-panel",
    route: "/admin/policies",
  },
  {
    title: "Usage reports",
    body: "See how much was printed by person, department and printer, and which jobs were denied or failed. The Activity log in the menu keeps a record of every change an admin made.",
    anchor: "admin-reports-stats",
    route: "/admin/reports",
  },
  {
    title: "Need a reminder?",
    body: "Open Help at any time. It explains the page you are on, replays this walkthrough, and has a glossary.",
    anchor: "help-button",
    route: "/admin/reports",
  },
];

export interface GlossaryEntry {
  term: string;
  definition: string;
}

export const GLOSSARY: GlossaryEntry[] = [
  { term: "Approval", definition: "Some jobs need a person to say yes before they print, for example big jobs or colour. Until then the job says Waiting for approval." },
  { term: "Approvals page", definition: "Where an approver or admin sees jobs held back by a rule and says yes or no to each one." },
  { term: "Booklet", definition: "Pages arranged so that, folded in half and stapled, they read like a small book. Choose the left or right edge for the spine." },
  { term: "Device", definition: "A phone, tablet or laptop you added so you can print from its normal Print button." },
  { term: "Duplex", definition: "Two-sided printing: both sides of the sheet are used." },
  { term: "Enrollment", definition: "Connecting a new print server to your organization using a one-time code. You only do it once per computer." },
  { term: "Invite code", definition: "A link or code an admin sends so someone can join. There is no sign-up without one." },
  { term: "Job status", definition: "Where a job is: Waiting, Approved, Sent to printer, Printing, Printed. If something stops it you will see Denied, Failed or Cancelled, with a reason." },
  { term: "Monthly limit", definition: "How much you can print each month. It is shown on Home and on My usage." },
  { term: "Print rule", definition: "A rule that decides if a job is allowed, needs approval, or is not allowed, such as colour jobs need approval." },
  { term: "Print server", definition: "The Windows computer next to your printer. It receives approved jobs from Printio and sends them to the printer." },
  { term: "Printer profile", definition: "One way of printing on a printer, such as Booklet and staple. One printer can have several." },
  { term: "Queue", definition: "A named line of jobs waiting for a printer on the printer computer. Each printer profile is connected to one queue." },
  { term: "Quota", definition: "Another word for a monthly limit: how many pages or sheets someone can print in a month." },
  { term: "Test my connection", definition: "A button that checks your device can reach the printer through Printio, and sends a test page." },
];
