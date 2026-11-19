import Link from "next/link";
import { ArrowRight, Check, ClipboardCheck, FlaskConical, LifeBuoy, Printer, ShieldCheck, Gauge } from "lucide-react";
import { landingDevices } from "@/lib/landing-content";
import { routes } from "@/lib/routes";
import { BookletDemo } from "./BookletDemo";
import { FeatureTabs } from "./FeatureTabs";
import { HeroDemo } from "./HeroDemo";
import { HeroPhone } from "./HeroPhone";
import { displayFont } from "./landing-font";
import styles from "./landing.module.css";
import page from "./landing-page.module.css";

const FAQ: { q: string; a: string }[] = [
  {
    q: "Do I need to install a driver or an app?",
    a: "No. On Windows, iPhone and Android you add the school's printer once, then press the normal Print button like always. There is nothing to install on the device itself.",
  },
  {
    q: "Does it work on iPhone?",
    a: "Yes. It has printed from a real iPhone through the normal Print menu. Mac and Chromebook are built and still being tested, so we do not call them confirmed yet.",
  },
  {
    q: "What about booklets and stapling?",
    a: "Printio lays out the sheets for a real folded booklet, with the spine on the left for English or on the right for Hebrew, and can staple or print double-sided for you. Booklets, stapling and double-sided have all printed on the real printer.",
  },
  {
    q: "Who can see my files?",
    a: "Your job goes to your school's own private space in Printio and then to the small print server in your building, which talks to the printer directly. An admin sees the job list, with who sent it and why anything was held. Printio is built so each school's people, printers and jobs stay apart from other schools'.",
  },
  {
    q: "Can I try it?",
    a: "Printio is invite-only and early. If your school has sent you an invite link, open it to join. If not, you can still play with the demo on this page.",
  },
];

/**
 * The public home page, for everyone (signed in or not). Story order: a confident hero, the devices that are proven,
 * three steps, a demo you can press, booklets, what the office gets, how data stays separate, answers, a way in.
 * Everything it claims comes from lib/landing-content.ts and docs/FEATURES.md.
 */
export function Landing({ signedIn = false }: { signedIn?: boolean }) {
  const devices = landingDevices();
  // Signed-in people see the same page; their main button takes them to their own home instead of the sign-in page.
  const primary = signedIn ? { href: routes.start, label: "Open Printio" } : { href: routes.login, label: "Sign in" };
  return (
    <div className={`${styles.root} ${page.page} ${displayFont.variable} min-h-dvh`}>
      <a href="#main" className={page.skip}>Skip to content</a>
      <header className={page.header}>
        <div className={page.wrap}>
          <div className={page.headerRow}>
            <Link href="/" className={`${styles.display} ${page.logo}`} aria-label="Printio home">
              <span className={page.dots} aria-hidden="true"><i /><i /><i /></span>
              Printio
            </Link>
            <nav aria-label="Sections" className={page.nav}>
              <a href="#how">How it works</a>
              <a href="#booklets">Booklets</a>
              <a href="#office">For offices</a>
              <a href="#faq">Questions</a>
            </nav>
            <Link href={primary.href} className={`${page.btn} ${page.btnDark} ${page.btnSm}`}>
              {primary.label}
            </Link>
          </div>
        </div>
      </header>

      <main id="main">
        {/* HERO */}
        <section className={page.hero}>
          <div className={page.heroGlow} aria-hidden="true" />
          <div className={styles.halftone} aria-hidden="true" />
          <div className={`${page.wrap} ${page.heroGrid}`}>
            <div className={page.heroText}>
              <p className={page.eyebrow}>
                <span className={page.dots} aria-hidden="true"><i /><i /><i /></span>
                Printing for schools and offices
              </p>
              <h1 className={`${styles.display} ${page.h1}`}>Press Print. It comes out of the right printer.</h1>
              <p className={page.lead}>
                Print from the normal Print button on any phone or laptop. No app, no driver. Booklets, stapling and double-sided are handled for you.
              </p>
              <div className={page.ctaRow}>
                <Link href={primary.href} className={`${page.btn} ${page.btnPrimary}`}>
                  {primary.label}
                  <ArrowRight className="h-5 w-5" aria-hidden="true" />
                </Link>
                {!signedIn && (
                  <Link href="/join" className={`${page.btn} ${page.btnGhost}`}>
                    I have an invite
                  </Link>
                )}
              </div>
              <p className={page.fine}>
                <Check className="h-4 w-4" aria-hidden="true" />
                Printed from a real Windows 11 PC, Android phone and iPhone
              </p>
            </div>
            <HeroPhone />
          </div>
        </section>

        {/* DEVICE PROOF */}
        <section id="devices" className={page.proof} aria-labelledby="proof-h">
          <div className={page.wrap}>
            <h2 id="proof-h" className={page.proofTitle}>Works where people already are</h2>
            <ul className={page.deviceList}>
              {devices.map((d) => (
                <li key={d.name} className={page.device} data-confirmed={d.confirmed}>
                  <span className={page.deviceIcon} aria-hidden="true">
                    {d.confirmed ? <Check className="h-5 w-5" /> : <FlaskConical className="h-5 w-5" />}
                  </span>
                  <span className={page.deviceName}>{d.name}</span>
                  <span className={page.deviceNote}>{d.confirmed ? "confirmed on a real device" : "still testing"}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* HOW IT WORKS */}
        <section id="how" className={page.section} aria-labelledby="how-h">
          <div className={page.wrap}>
            <p className={page.kicker}>How it works</p>
            <h2 id="how-h" className={`${styles.display} ${page.h2}`}>Three steps, and only the first one is yours.</h2>
            <ol className={page.steps}>
              <li className={page.stepCard}>
                <span className={page.stepNum} data-ink="c">1</span>
                <h3 className={page.h3}>Press Print</h3>
                <p>Open the normal Print menu in any app and choose the school printer. Pick double-sided, a staple or a booklet if you want one.</p>
              </li>
              <li className={page.stepCard}>
                <span className={page.stepNum} data-ink="m">2</span>
                <h3 className={page.h3}>Printio prepares it</h3>
                <p>It checks the rules, counts the pages, puts the sender&apos;s code on the page and lays out the sheets, all on its own.</p>
              </li>
              <li className={page.stepCard}>
                <span className={page.stepNum} data-ink="y">3</span>
                <h3 className={page.h3}>It comes out finished</h3>
                <p>The pages arrive at the right printer, stapled or folded as asked. You can see whether your job is waiting, printing or printed.</p>
              </li>
            </ol>
          </div>
        </section>

        {/* LIVE DEMO */}
        <section id="demo" className={`${page.section} ${page.tint}`} aria-labelledby="demo-h">
          <div className={page.wrap}>
            <p className={page.kicker}>Try it</p>
            <h2 id="demo-h" className={`${styles.display} ${page.h2}`}>Press the button. Watch it go.</h2>
            <p className={page.sectionLead}>A small demo of the same journey. Pick a device and a finish, then press Print.</p>
            <div className={page.demoBox}>
              <HeroDemo />
            </div>
          </div>
        </section>

        {/* BOOKLETS */}
        <section id="booklets" className={page.section} aria-labelledby="bk-h">
          <div className={`${page.wrap} ${page.split}`}>
            <div>
              <p className={page.kicker}>Booklets</p>
              <h2 id="bk-h" className={`${styles.display} ${page.h2}`}>Booklets that read the right way.</h2>
              <p className={page.sectionLead}>
                English opens from the left, Hebrew from the right. Printio lays out every sheet for you, and each page is printed as big as it fits.
              </p>
              <ul className={page.ticks}>
                <li><Check className="h-5 w-5" aria-hidden="true" />Left or right binding</li>
                <li><Check className="h-5 w-5" aria-hidden="true" />Pages in the right order for folding</li>
                <li><Check className="h-5 w-5" aria-hidden="true" />Every page as big as it fits</li>
              </ul>
            </div>
            <div className={page.bookBox}>
              <BookletDemo />
            </div>
          </div>
        </section>

        {/* FOR OFFICES */}
        <section id="office" className={`${page.section} ${page.tint}`} aria-labelledby="office-h">
          <div className={page.wrap}>
            <p className={page.kicker}>For the school office</p>
            <h2 id="office-h" className={`${styles.display} ${page.h2}`}>You stay in charge, without the headache.</h2>
            <div className={page.cards}>
              <article className={page.card}>
                <span className={page.cardIcon} data-ink="c"><ClipboardCheck className="h-6 w-6" aria-hidden="true" /></span>
                <h3 className={page.h3}>Approvals</h3>
                <p>Add an approval step if you want one, so a job waits for a yes before it prints.</p>
              </article>
              <article className={page.card}>
                <span className={page.cardIcon} data-ink="m"><Gauge className="h-6 w-6" aria-hidden="true" /></span>
                <h3 className={page.h3}>Rules and page limits</h3>
                <p>Set groups and page limits. Invite your staff with one link, with no passwords to hand out.</p>
              </article>
              <article className={page.card}>
                <span className={page.cardIcon} data-ink="y"><LifeBuoy className="h-6 w-6" aria-hidden="true" /></span>
                <h3 className={page.h3}>Plain-language help</h3>
                <p>Every job shows where it is, and if it was held you get a plain reason and a one-tap retry. Setup steps are written per device.</p>
              </article>
            </div>
          </div>
        </section>

        {/* DATA + SERVER */}
        <section id="data" className={page.section} aria-labelledby="data-h">
          <div className={`${page.wrap} ${page.split}`}>
            <div>
              <p className={page.kicker}>Your school&apos;s data</p>
              <h2 id="data-h" className={`${styles.display} ${page.h2}`}>Your school&apos;s files stay your school&apos;s.</h2>
              <p className={page.sectionLead}>
                Printio is built so each school has its own private space, kept apart from every other school. A small print server sits next to your printer and talks to it directly, so the printer never faces the internet.
              </p>
              <p className={page.honest}>
                <ShieldCheck className="h-5 w-5" aria-hidden="true" />
                <span>Printio is early and invite-only. Ask us how it is set up before you rely on it for anything sensitive.</span>
              </p>
            </div>
            <figure className={page.chain} aria-label="A job goes from a phone, through Printio, to the print server in your building, then to the printer">
              <div className={page.node} data-ink="c"><span className={page.nodeIcon}>1</span><div><strong>Your phone or laptop</strong><span>The normal Print button</span></div></div>
              <div className={page.link} aria-hidden="true" />
              <div className={page.node} data-ink="m"><span className={page.nodeIcon}>2</span><div><strong>Your school&apos;s private space</strong><span>Rules, approvals, job list</span></div></div>
              <div className={page.link} aria-hidden="true" />
              <div className={page.node} data-ink="y"><span className={page.nodeIcon}>3</span><div><strong>Print server in your building</strong><span>Talks to the printer directly</span></div></div>
              <div className={page.link} aria-hidden="true" />
              <div className={page.node} data-ink="k"><span className={page.nodeIcon}><Printer className="h-4 w-4" aria-hidden="true" /></span><div><strong>The printer</strong><span>Not open to the internet</span></div></div>
            </figure>
          </div>
        </section>

        {/* WHAT'S INSIDE */}
        <section id="inside" className={`${page.section} ${page.white}`} aria-labelledby="inside-h">
          <div className={page.wrap}>
            <p className={page.kicker}>The full list</p>
            <h2 id="inside-h" className={`${styles.display} ${page.h2}`}>What&apos;s inside</h2>
            <p className={page.sectionLead}>Things marked &ldquo;still testing&rdquo; are built but have not yet been seen working on a real device.</p>
            <div className="mt-6">
              <FeatureTabs />
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className={page.section} aria-labelledby="faq-h">
          <div className={`${page.wrap} ${page.faqWrap}`}>
            <div>
              <p className={page.kicker}>Questions</p>
              <h2 id="faq-h" className={`${styles.display} ${page.h2}`}>Straight answers.</h2>
            </div>
            <div className={page.faqList}>
              {FAQ.map((f) => (
                <details key={f.q} className={page.faq}>
                  <summary>
                    <span>{f.q}</span>
                    <span className={page.plus} aria-hidden="true" />
                  </summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* FINAL CTA */}
        <section className={page.cta} aria-labelledby="cta-h">
          <div className={`${page.wrap} ${page.ctaInner}`}>
            <h2 id="cta-h" className={`${styles.display} ${page.ctaTitle}`}>
              {signedIn ? "You are signed in." : "Printio is invite-only for now."}
            </h2>
            <div className={page.ctaRow}>
              <Link href={primary.href} className={`${page.btn} ${page.btnLight}`}>
                {primary.label}
              </Link>
              {!signedIn && (
                <Link href="/join" className={`${page.btn} ${page.btnOutline}`}>
                  I have an invite
                </Link>
              )}
            </div>
          </div>
        </section>
      </main>

      <footer className={page.footer}>
        <div className={`${page.wrap} ${page.footerRow}`}>
          <span className={`${styles.display} ${page.footLogo}`}>Printio</span>
          <nav aria-label="Legal" className={page.footNav}>
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
          </nav>
          <span>Made by TachTach Screens</span>
        </div>
      </footer>
    </div>
  );
}
