import Link from "next/link";
import { Check, FlaskConical } from "lucide-react";
import { landingDevices } from "@/lib/landing-content";
import { routes } from "@/lib/routes";
import { BookletDemo } from "./BookletDemo";
import { FeatureTabs } from "./FeatureTabs";
import { HeroDemo } from "./HeroDemo";
import { displayFont } from "./landing-font";
import styles from "./landing.module.css";

const btnBase = "inline-flex min-h-12 items-center justify-center rounded-full px-6 text-[0.9375rem] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2";

/**
 * The public home page, for everyone (signed in or not). Deliberately short: a hero you can use, the devices that are
 * proven, a booklet you can flip through, what is inside, and a way in. Everything it claims comes from
 * lib/landing-content.ts.
 */
export function Landing({ signedIn = false }: { signedIn?: boolean }) {
  const devices = landingDevices();
  // Signed-in people see the same page; their main button takes them to their own home instead of the sign-in page.
  const primary = signedIn ? { href: routes.start, label: "Open Printio" } : { href: routes.login, label: "Sign in" };
  return (
    <div className={`${styles.root} ${displayFont.variable} min-h-dvh`}>
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <Link href="/" className={`${styles.display} text-xl font-extrabold`} aria-label="Printio home">
          Printio
        </Link>
        <nav aria-label="Sections" className="hidden items-center gap-6 text-sm font-medium text-[var(--ink-2)] md:flex">
          <a href="#booklets" className="hover:text-[var(--ink)]">Booklets</a>
          <a href="#inside" className="hover:text-[var(--ink)]">What&apos;s inside</a>
        </nav>
        <Link href={primary.href} className={`${btnBase} bg-[var(--ink)] text-white hover:bg-[#1c3358] focus-visible:outline-[var(--blue)]`}>
          {primary.label}
        </Link>
      </header>

      <main id="main">
        <section className="relative overflow-hidden">
          <div className={styles.halftone} aria-hidden="true" />
          <div className="relative mx-auto grid max-w-6xl gap-6 px-4 pt-6 pb-14 sm:px-6 lg:grid-cols-[1.25fr_1fr] lg:gap-x-12 lg:gap-y-10 lg:pt-10 lg:pb-20">
            <h1 className={`${styles.display} text-[clamp(2.3rem,6vw,4.25rem)] font-extrabold leading-[1.02] lg:col-start-1 lg:row-start-1 lg:self-end`}>
              Press Print. It comes out of the right printer.
            </h1>
            {/* On a phone the demo comes straight after the headline, so the page is visible without scrolling. */}
            <div className="order-2 lg:order-none lg:col-span-2 lg:row-start-2">
              <HeroDemo />
            </div>
            <div className="order-3 lg:order-none lg:col-start-2 lg:row-start-1 lg:self-end">
              <p className="max-w-md text-[1.0625rem] leading-7 text-[var(--ink-2)]">
                Your school or office printer, in everyone&apos;s normal Print menu. With rules, approvals and real booklets.
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <Link href={primary.href} className={`${btnBase} bg-[var(--blue)] text-white hover:bg-[#0752b3] focus-visible:outline-[var(--blue)]`}>
                  {primary.label}
                </Link>
                {!signedIn && (
                  <Link href="/join" className={`${btnBase} border border-[var(--line)] bg-white text-[var(--ink)] hover:border-[var(--ink)] focus-visible:outline-[var(--blue)]`}>
                    I have an invite
                  </Link>
                )}
              </div>
            </div>
          </div>
        </section>

        <section id="devices" className="border-y border-[var(--line)] bg-white">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-5 sm:px-6">
            <p className="text-sm font-semibold">Works on</p>
            <ul className="flex flex-wrap gap-2 p-0">
              {devices.map((d) => (
                <li key={d.name} className="inline-flex list-none items-center gap-1.5 rounded-full border border-[var(--line)] px-3 py-1.5 text-sm">
                  {d.confirmed ? (
                    <Check className="h-4 w-4 text-[var(--color-success)]" aria-hidden="true" />
                  ) : (
                    <FlaskConical className="h-4 w-4 text-[var(--color-warning)]" aria-hidden="true" />
                  )}
                  <span className="font-medium">{d.name}</span>
                  <span className="text-[var(--ink-2)]">{d.confirmed ? "confirmed on a real device" : "still testing"}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="booklets" className="mx-auto grid max-w-6xl items-center gap-8 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:gap-14 lg:py-24">
          <div>
            <h2 className={`${styles.display} text-[clamp(1.75rem,4vw,2.75rem)] font-extrabold leading-tight`}>Booklets that read the right way.</h2>
            <p className="mt-4 max-w-md text-[1.0625rem] leading-7 text-[var(--ink-2)]">
              English opens from the left, Hebrew from the right. Printio lays out every sheet for you. Flip through it.
            </p>
          </div>
          <BookletDemo />
        </section>

        <section id="inside" className="border-t border-[var(--line)] bg-white">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
            <h2 className={`${styles.display} mb-6 text-[clamp(1.75rem,4vw,2.75rem)] font-extrabold leading-tight`}>What&apos;s inside</h2>
            <FeatureTabs />
          </div>
        </section>

        <section className="bg-[var(--ink)] text-white">
          <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 py-14 sm:px-6 md:flex-row md:items-center md:justify-between">
            <h2 className={`${styles.display} max-w-xl text-[clamp(1.6rem,4vw,2.25rem)] font-extrabold leading-tight`}>
              {signedIn ? "You are signed in." : "Printio is invite-only for now."}
            </h2>
            <div className="flex flex-wrap gap-3">
              <Link href={primary.href} className={`${btnBase} bg-white text-[var(--ink)] hover:bg-[#e8eef9] focus-visible:outline-white`}>
                {primary.label}
              </Link>
              {!signedIn && (
                <Link href="/join" className={`${btnBase} border border-[#5b6f94] text-white hover:border-white focus-visible:outline-white`}>
                  I have an invite
                </Link>
              )}
            </div>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-sm text-[var(--ink-2)] sm:px-6">
        <span>Printio</span>
        <span>Made by TachTach Screens</span>
      </footer>
    </div>
  );
}
