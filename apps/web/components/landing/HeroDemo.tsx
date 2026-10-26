"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import styles from "./landing.module.css";

type DeviceId = "windows" | "iphone" | "android";
type Sides = "one" | "two";
type Finish = "none" | "staple" | "booklet";

const DEVICES: { id: DeviceId; label: string; dialog: string }[] = [
  { id: "windows", label: "Windows", dialog: "Print" },
  { id: "iphone", label: "iPhone", dialog: "Printer Options" },
  { id: "android", label: "Android", dialog: "Print" },
];

/** 0 idle, 1 sending, 2 checking, 3 printing, 4 done. Times are when each phase starts after the button is pressed. */
const PHASE_AT_MS = [0, 0, 900, 2600, 4100];

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function statusText(phase: number, sides: Sides, finish: Finish): string {
  if (phase === 0) return "Choose your options, then press Print.";
  if (phase === 1) return "Sending to Printio...";
  if (phase === 2) return "Printio is checking the job...";
  if (phase === 3) return finish === "booklet" ? "Arranging the pages and printing..." : "Printing...";
  const how = [sides === "two" ? "double-sided" : "single-sided", finish === "staple" ? "stapled" : finish === "booklet" ? "folded into a booklet" : null].filter(Boolean).join(", ");
  return `Printed ${how}. The page carries the sender's code.`;
}

function Choice<T extends string>({ label, value, onChange, options, disabled }: { label: string; value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; disabled: boolean }) {
  return (
    <div className={styles.dialogRow} role="group" aria-label={label}>
      <span className="shrink-0 text-[var(--color-muted)]">{label}</span>
      <span className="flex flex-wrap justify-end gap-1 max-[420px]:gap-0.5">
        {options.map((o) => (
          <button key={o.value} type="button" className={styles.chip} aria-pressed={value === o.value} disabled={disabled} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </span>
    </div>
  );
}

/**
 * The home page's one big moment: pick a device and your options, press Print, and watch the page go through Printio
 * and come out of the printer with the sender's code on it, stapled or folded into a booklet if you chose that.
 * It plays once by itself after load, then only when someone presses Print. On a phone it shows one stage at a time
 * under a stepper, so the whole journey fits on the screen. Reduced motion shows the finished state straight away.
 */
export function HeroDemo() {
  const [device, setDevice] = useState<DeviceId>("iphone");
  const [sides, setSides] = useState<Sides>("two");
  const [finish, setFinish] = useState<Finish>("none");
  const [phase, setPhase] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clear = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  const play = useCallback(() => {
    clear();
    if (prefersReducedMotion()) {
      setPhase(4);
      return;
    }
    setPhase(1);
    for (let p = 2; p <= 4; p++) timers.current.push(setTimeout(() => setPhase(p), PHASE_AT_MS[p]));
  }, [clear]);

  useEffect(() => {
    // Plays once after load. No "already played" flag: React runs effects twice in development and a flag would
    // cancel the only run; the cleanup below clears the first timer instead.
    const first = setTimeout(play, 1400);
    return () => {
      clearTimeout(first);
      clear();
    };
  }, [play, clear]);

  const active = DEVICES.find((d) => d.id === device)!;
  const busy = phase > 0 && phase < 4;
  const change = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    if (!busy) setPhase(0); // a changed option means the finished page is out of date: back to ready
  };

  const current = phase <= 1 ? 0 : phase === 2 ? 1 : phase === 3 ? 2 : 3;
  const steps = [active.label, "Printio", "Printer"];

  return (
    <div className={styles.stage} data-phase={phase}>
      <div role="tablist" aria-label="Pick a device" className="mb-4 flex flex-wrap gap-2">
        {DEVICES.map((d) => (
          <button
            key={d.id}
            type="button"
            role="tab"
            aria-selected={device === d.id}
            className={styles.tab}
            onClick={() => {
              setDevice(d.id);
              if (!busy) setPhase(0);
            }}
          >
            {d.label}
          </button>
        ))}
      </div>

      {/* Phone only: where the page is right now, and a way to run it again once it has printed. */}
      <div className={styles.steps} aria-hidden="true">
        {steps.map((label, i) => (
          <div key={label} className={styles.step} data-state={i < current ? "done" : i === current ? "active" : "todo"}>
            <span className={styles.stepDot}>{i < current ? <Check className="h-3 w-3" /> : null}</span>
            <span>{label}</span>
          </div>
        ))}
      </div>

      <div className={styles.flow}>
        <div className={styles.device} aria-label={`${active.label} print dialog`}>
          <p className="text-[0.8125rem] font-semibold">{active.dialog}</p>
          <div className={styles.dialogRow}>
            <span className="text-[var(--color-muted)]">Printer</span>
            <strong>Printio-MLMI-SZV</strong>
          </div>
          <Choice<Sides>
            label="Sides"
            value={sides}
            onChange={change(setSides)}
            disabled={busy}
            options={[
              { value: "one", label: "Single" },
              { value: "two", label: "Double" },
            ]}
          />
          <Choice<Finish>
            label="Finish"
            value={finish}
            onChange={change(setFinish)}
            disabled={busy}
            options={[
              { value: "none", label: "None" },
              { value: "staple", label: "Staple" },
              { value: "booklet", label: "Booklet" },
            ]}
          />
          <button type="button" className={styles.pressBtn} onClick={play} disabled={busy}>
            {phase === 4 ? "Print again" : busy ? "Printing..." : "Print"}
          </button>
        </div>

        <div className={styles.rail} data-on={phase === 1} aria-hidden="true">
          <div className={styles.flyer} />
        </div>

        <div className={styles.node}>
          <p className="text-[0.8125rem] font-semibold">Printio</p>
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">Your print server</p>
          <ul className="mt-2 list-none p-0">
            {["Rules checked", "Pages counted", "Stamped SZV", finish === "booklet" ? "Pages arranged for folding" : finish === "staple" ? "Staple added" : "Sent to the printer"].map((t) => (
              <li key={t} className={styles.check}>
                <Check className="h-3.5 w-3.5 shrink-0 text-[var(--color-success)]" aria-hidden="true" />
                {t}
              </li>
            ))}
          </ul>
        </div>

        <div className={styles.rail} data-on={phase === 3} aria-hidden="true" />

        <div className={styles.printer} aria-label="The printer">
          <div className="flex items-center justify-between">
            <div className={styles.panel} />
            <span className="text-xs text-[var(--color-muted)]">
              <span className={styles.led} />
              {phase === 4 ? "Done" : phase === 3 ? "Printing" : "Ready"}
            </span>
          </div>
          <div className={styles.slot} />
          <div className={styles.sheet} data-finish={finish}>
            <div className={styles.lines} />
            {finish === "booklet" && (
              <>
                <span className={styles.fold} />
                <span className={styles.pnL}>8</span>
                <span className={styles.pnR}>1</span>
              </>
            )}
            {finish === "staple" && <span className={styles.staple} />}
            <span className={styles.stamp}>SZV</span>
          </div>
        </div>
      </div>

      <div className="mt-4 flex min-h-[2.5rem] flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--color-muted)]" aria-live="polite">
          {statusText(phase, sides, finish)}
        </p>
        {phase === 4 && (
          <span className={`${styles.mobileOnly} flex flex-wrap gap-2`}>
            <button type="button" className={styles.replay} onClick={() => setPhase(0)}>
              Change options
            </button>
            <button type="button" className={styles.replay} onClick={play}>
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Print again
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
