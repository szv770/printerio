/**
 * Page-by-page help, in plain English. One entry per page the Help window and the small "?" button know about.
 * Written for a teacher or office admin who has never read the docs: say "print server" (never "Agent"), no
 * file paths, no developer words. lib/help-content.test.ts enforces that.
 */

export interface HelpProblem {
  question: string;
  answer: string;
}

export interface HelpPage {
  /** Short name of the page, as people see it. */
  title: string;
  /** What this page is, in one or two sentences. */
  what: string;
  /** One to three short steps. */
  first: string[];
  /** One line: how you know you are finished. */
  done: string;
  /** Zero to three questions people really ask. */
  problems: HelpProblem[];
}

export const HELP_PAGES: Record<string, HelpPage> = {
  home: {
    title: "Home",
    what: "Your starting point. It shows how much you can still print this month and your latest jobs.",
    first: ["Press Print a document to send something to the printer.", "Check Recent jobs to see what is waiting or finished."],
    done: "You can see your job in the list, and it says Printed.",
    problems: [
      {
        question: "I do not see a monthly limit.",
        answer: "Your organization has not set one for you. You can print as normal.",
      },
    ],
  },
  print: {
    title: "Print a document",
    what: "Choose a PDF, pick how it should come out, and send it to the printer. Nothing is sent until you press Print.",
    first: [
      "Choose your PDF, or drop it on the page. You will see a preview.",
      "Pick one-sided or two-sided, copies, and a staple or booklet if you want one.",
      "Check the sheet count at the bottom, then press Print.",
    ],
    done: "You land on your job, and it moves from Waiting to Printing to Printed.",
    problems: [
      {
        question: "An option is greyed out.",
        answer: "Some choices cannot go together, for example a booklet with a staple. The note under it says why.",
      },
      {
        question: "It says my job needs approval.",
        answer: "Your organization checks some jobs first, like big ones or colour. An approver will say yes or no, and you will see it on the job.",
      },
      {
        question: "Can I print a Word file?",
        answer: "Save or export it as a PDF first, then choose that PDF here.",
      },
    ],
  },
  library: {
    title: "Library",
    what: "Browse ready-made texts, tick the ones you want, and turn them into one booklet.",
    first: ["Open a section and tap the files you want.", "Press the button to make your booklet.", "Check it on the next screen, then print."],
    done: "Your booklet appears for checking, ready to print.",
    problems: [],
  },
  booklet: {
    title: "Make a booklet",
    what: "Combine several PDFs into one booklet with a cover and a contents page. You check it before anything prints.",
    first: ["Add your PDFs in the order you want them.", "Choose the title and the binding edge.", "Make the booklet, look it over, then print it."],
    done: "You have looked at the finished booklet and sent it to print.",
    problems: [
      {
        question: "Which edge should the booklet open on?",
        answer: "Choose left for English. Choose right for Hebrew, so the pages turn the right way.",
      },
    ],
  },
  jobs: {
    title: "My jobs",
    what: "Everything you have sent to print, newest first, with where each one is right now.",
    first: ["Look at the status next to each job.", "Open a job to see what happened and print it again."],
    done: "Your job says Printed.",
    problems: [
      {
        question: "My job has been Waiting for a while.",
        answer: "It is queued behind other jobs, or it needs an approver. Open the job to see which. If nothing changes after a few minutes, tell your administrator.",
      },
      {
        question: "My job says Failed.",
        answer: "Open it. It gives a plain reason, and you can usually press Print again to retry.",
      },
    ],
  },
  job: {
    title: "A job",
    what: "The full story of one print job: its choices, where it is now, and what happened along the way.",
    first: ["Read the status at the top.", "Use Print again to send it once more with the same choices."],
    done: "The status says Printed, or you know why it stopped.",
    problems: [
      {
        question: "Why was my job denied?",
        answer: "A rule or an approver said no. The reason is shown on this page. Ask the approver if you think it is a mistake.",
      },
      {
        question: "Can I cancel it?",
        answer: "Yes, while it is still waiting. Once it is printing it cannot be stopped from here.",
      },
    ],
  },
  devices: {
    title: "My devices",
    what: "Add your phone, tablet or laptop so you can print from its normal Print button. Each device gets its own private address.",
    first: ["Press Add a device and choose what kind it is.", "Follow the steps shown for that device.", "Press Test my connection to check it worked."],
    done: "Your device shows as connected, and a test page prints.",
    problems: [
      {
        question: "Test my connection does not pass.",
        answer: "Make sure the phone has internet and you copied the whole address. Then try again. If it still fails, use Report a problem.",
      },
      {
        question: "I got a new phone.",
        answer: "Add it as a new device. You can switch off the old one here at any time.",
      },
    ],
  },
  profile: {
    title: "Profile",
    what: "Your name, your print preferences, and your account details.",
    first: ["Check your name is right.", "Choose the print choices you like to start with.", "Press Save."],
    done: "You see a message saying your changes were saved.",
    problems: [
      {
        question: "I cannot change my email.",
        answer: "Your email is how you sign in. Ask your administrator if it needs to change.",
      },
    ],
  },
  usage: {
    title: "My usage",
    what: "How much you have printed this month, and how much of your limit is left.",
    first: ["Look at the bar for this month.", "Scroll down for your recent jobs."],
    done: "You know how much you have left.",
    problems: [
      {
        question: "My limit looks too small.",
        answer: "Limits are set by your organization. If more than one applies to you, the lowest one is used. Ask your administrator.",
      },
    ],
  },

  adminHome: {
    title: "Overview",
    what: "What needs you right now: jobs waiting for a yes or no, print servers that are offline, and printers with a problem.",
    first: ["If you see Finish setting up, work down the list.", "Open anything that is marked as needing attention."],
    done: "Nothing is flagged, and the setup list is gone.",
    problems: [
      {
        question: "Everything shows zero.",
        answer: "That is normal for a new organization. Follow Finish setting up to add a print server, a printer and your people.",
      },
    ],
  },
  adminJobs: {
    title: "All jobs",
    what: "Every job sent by anyone in your organization, so you can see what printed and what did not.",
    first: ["Use the filters to find a person or a status.", "Open a job to see its reason and history."],
    done: "You have found the job and know what happened to it.",
    problems: [
      {
        question: "A job is stuck on Approved.",
        answer: "The print server may be offline. Open Print servers and check it says Online.",
      },
    ],
  },
  adminApprovals: {
    title: "Approvals",
    what: "Jobs that your rules hold back until someone says yes or no.",
    first: ["Open a job to see what was asked for.", "Press Approve, or Deny and give a short reason."],
    done: "The list is empty.",
    problems: [
      {
        question: "Why are some jobs here?",
        answer: "A print rule asked for approval, for example for big or colour jobs. Change this under Print rules.",
      },
      {
        question: "Does the person know I denied it?",
        answer: "Yes. They see your reason on their job.",
      },
    ],
  },
  adminUsers: {
    title: "Users",
    what: "Everyone who can print in your organization. Change a role, a department or a print code.",
    first: ["Find the person.", "Change what you need.", "Press Save."],
    done: "The row shows your change after saving.",
    problems: [
      {
        question: "How do I add someone?",
        answer: "Go to Invites, create a link, and send it to them. There are no shared passwords.",
      },
      {
        question: "What is the role for?",
        answer: "Admins can change settings. Approvers can say yes or no to jobs. Everyone else just prints.",
      },
    ],
  },
  adminUser: {
    title: "One person",
    what: "Everything about one user: their role, groups, print code, devices and recent jobs.",
    first: ["Check their role and groups.", "Press Save if you changed anything."],
    done: "The change shows after saving.",
    problems: [],
  },
  adminInvites: {
    title: "Invites",
    what: "Invite people with a link. Each link can be switched off at any time.",
    first: ["Create an invite and choose what role they get.", "Copy the link and send it to them.", "Turn it off once everyone has joined."],
    done: "The person opens the link and appears in Users.",
    problems: [
      {
        question: "The link does not work for them.",
        answer: "It may be switched off or used up. Create a new one and send that instead.",
      },
    ],
  },
  adminGroups: {
    title: "Groups",
    what: "Put people into departments or classes, so a rule or a monthly limit can apply to the whole group at once.",
    first: ["Create a group and give it a clear name.", "Add the people who belong in it."],
    done: "The group lists the right people.",
    problems: [
      {
        question: "Why use groups?",
        answer: "So you set a limit once for a class instead of person by person.",
      },
    ],
  },
  adminDevices: {
    title: "All devices",
    what: "The phones and laptops people print from. The ones that need a look are at the top.",
    first: ["Look at the top of the list first.", "Open a device to see its status, or switch it off."],
    done: "Nothing is left at the top needing a look.",
    problems: [
      {
        question: "Can I block a lost phone?",
        answer: "Yes. Open the device and switch it off. Its private address stops working at once.",
      },
    ],
  },
  adminPrinters: {
    title: "Printers",
    what: "Your printers, and the print queues people can send jobs to, such as double-sided or booklet.",
    first: ["Open Guided setup the first time.", "Add a queue here whenever you need another way to print."],
    done: "Each printer shows its queues, and a test job prints.",
    problems: [
      {
        question: "A printer shows an error.",
        answer: "Check the printer itself for paper or a jam, then check that its print server is Online.",
      },
    ],
  },
  adminPrintersSetup: {
    title: "Guided printer setup",
    what: "A step-by-step way to set up your printer: choose the ways people can print, check the print server is online, then connect each one.",
    first: ["Choose the print options you want to offer.", "Make sure the print server says Online.", "Match each option to a queue on the printer computer."],
    done: "Each option is connected, and you can send a test job.",
    problems: [
      {
        question: "My queue is not in the list.",
        answer: "Check it exists on the printer computer, then wait a minute for the print server to report it.",
      },
    ],
  },
  adminAgents: {
    title: "Print servers",
    what: "The Windows computers next to your printers. They receive approved jobs and send them to paper.",
    first: ["Create a print server here to get a one-time code.", "Install it on the printer computer and enter the code.", "Wait for it to say Online."],
    done: "The print server says Online.",
    problems: [
      {
        question: "It says Offline.",
        answer: "Check that the computer is on, signed in and connected to the internet. It reports in every few minutes.",
      },
      {
        question: "Where do I get the code?",
        answer: "Creating a print server shows a code that lasts 24 hours. Make a new one if it ran out.",
      },
    ],
  },
  adminAgent: {
    title: "One print server",
    what: "The details of one print server: whether it is online, what printers it found, and its software version.",
    first: ["Check it says Online.", "Use Update if a newer version is offered."],
    done: "It is Online and up to date.",
    problems: [
      {
        question: "It will not update.",
        answer: "The computer must be on and online. Try again in a few minutes.",
      },
    ],
  },
  adminPolicies: {
    title: "Print rules",
    what: "Decide when a job needs approval or is not allowed. Switch a rule off to pause it.",
    first: ["Add a rule, for example: colour jobs need approval.", "Choose who it applies to.", "Save it."],
    done: "The rule is listed and switched on.",
    problems: [
      {
        question: "Two rules disagree.",
        answer: "Not allowed always wins, then needs approval, then allowed. If nothing matches, your organization default applies.",
      },
    ],
  },
  adminQuotas: {
    title: "Monthly limits",
    what: "How much someone can print each month. If a person fits more than one limit, the lowest one applies.",
    first: ["Add a limit for everyone, a role, a group or one person.", "Choose the amount.", "Save it."],
    done: "People see their new limit on Home.",
    problems: [
      {
        question: "Someone ran out.",
        answer: "Raise their limit here, or add a higher limit just for that person.",
      },
    ],
  },
  adminReports: {
    title: "Usage reports",
    what: "How much was printed, by person, department and printer, and which jobs were denied or failed.",
    first: ["Choose the dates you care about.", "Look at the busiest people and printers."],
    done: "You have the numbers you need.",
    problems: [],
  },
  adminAudit: {
    title: "Activity log",
    what: "A record of every change an administrator made, and who made it. Only organization admins can see it.",
    first: ["Scan the newest entries.", "Look for a name or date if you are checking a change."],
    done: "You found who changed what, and when.",
    problems: [],
  },
  adminStorage: {
    title: "Files & storage",
    what: "Files people send to print are kept for a short time and then removed. Job history stays.",
    first: ["Check how long files are kept.", "Remove old files if you need space sooner."],
    done: "The storage figure looks right for you.",
    problems: [
      {
        question: "Where did an old file go?",
        answer: "Files are removed after the keep time. The job record stays, but the file cannot be opened.",
      },
    ],
  },
  adminFonts: {
    title: "Fonts",
    what: "Hebrew and English fonts for your booklets. Add one and it shows in the font lists.",
    first: ["Choose a font file.", "Give it a name people will recognize.", "Add it."],
    done: "The font shows in the booklet form.",
    problems: [],
  },
  adminSettings: {
    title: "Settings",
    what: "Who can join, how printing behaves by default, and the print stamp. Open a section to change it.",
    first: ["Open the section you want.", "Change it.", "Press Save."],
    done: "You see a message saying your changes were saved.",
    problems: [
      {
        question: "What is the print stamp?",
        answer: "A small mark on each page that shows who sent it, so people can find their own pile.",
      },
    ],
  },
};

/** Shown on any page that has no entry above. */
export const GENERIC_HELP: HelpPage = {
  title: "This page",
  what: "This page does not have its own help yet. The menu on the side shows everything you can do in Printio.",
  first: ["Look at the page heading to see where you are.", "Use the menu to go back to Home."],
  done: "You are where you wanted to be.",
  problems: [
    {
      question: "I am stuck.",
      answer: "Open the Walkthrough tab for a quick tour, or use Report a problem and we will help.",
    },
  ],
};

/** Exact paths, then patterns for pages with an id in the address. */
const EXACT: Record<string, string> = {
  "/home": "home",
  "/print": "print",
  "/print/library": "library",
  "/print/booklet": "booklet",
  "/jobs": "jobs",
  "/devices": "devices",
  "/profile": "profile",
  "/usage": "usage",
  "/admin": "adminHome",
  "/admin/jobs": "adminJobs",
  "/admin/approvals": "adminApprovals",
  "/admin/users": "adminUsers",
  "/admin/invites": "adminInvites",
  "/admin/groups": "adminGroups",
  "/admin/devices": "adminDevices",
  "/admin/printers": "adminPrinters",
  "/admin/printers/setup": "adminPrintersSetup",
  "/admin/agents": "adminAgents",
  "/admin/policies": "adminPolicies",
  "/admin/quotas": "adminQuotas",
  "/admin/reports": "adminReports",
  "/admin/audit": "adminAudit",
  "/admin/storage": "adminStorage",
  "/admin/fonts": "adminFonts",
  "/admin/settings": "adminSettings",
};

const PATTERNS: Array<[RegExp, string]> = [
  [/^\/print\/preparing\/[^/]+$/, "print"],
  [/^\/jobs\/[^/]+$/, "job"],
  [/^\/admin\/users\/[^/]+$/, "adminUser"],
  [/^\/admin\/agents\/[^/]+$/, "adminAgent"],
];

/** Only used by the developer preview page, so every page can be looked at without signing in. */
const PREVIEW_SECTIONS: Record<string, string> = {
  teacher: "/home",
  member: "/jobs",
  adminhome: "/admin",
  admin: "/admin",
  print: "/print",
  job: "/jobs/1",
  joblist: "/jobs",
  devices: "/devices",
  usage: "/usage",
  profile: "/profile",
  users: "/admin/users",
  groups: "/admin/groups",
  invites: "/admin/invites",
  printers: "/admin/printers",
  servers: "/admin/agents",
  rules: "/admin/policies",
  limits: "/admin/quotas",
  reports: "/admin/reports",
  activity: "/admin/audit",
  approvals: "/admin/approvals",
  files: "/admin/storage",
  alljobs: "/admin/jobs",
};

/** Turns the address into the page the person thinks they are on (preview addresses only exist in development). */
export function resolveHelpPath(pathname: string | null | undefined, search = ""): string {
  const path = (pathname ?? "").replace(/\/+$/, "") || "/";
  if (path === "/dev/preview" && process.env.NODE_ENV !== "production") {
    const params = new URLSearchParams(search);
    return params.get("path") ?? PREVIEW_SECTIONS[params.get("section") ?? "admin"] ?? "/admin";
  }
  return path;
}

export function helpPageId(pathname: string | null | undefined, search = ""): string | null {
  const path = resolveHelpPath(pathname, search);
  if (EXACT[path]) return EXACT[path];
  for (const [re, id] of PATTERNS) if (re.test(path)) return id;
  return null;
}

/** The help for this address, or null when the page has none of its own. */
export function helpForPath(pathname: string | null | undefined, search = ""): HelpPage | null {
  const id = helpPageId(pathname, search);
  return id ? (HELP_PAGES[id] ?? null) : null;
}
