"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { FOLD_MS, PHASE_AT_MS, STAPLE_STROKE_MS, STITCH_AT_MS, STITCH_POP_MS, finishMs, stapleHitMs, type Finish } from "@/lib/landing-timing";
import { audioReady, playFold, playStaple } from "./sound";
import styles from "./landing.module.css";

type DeviceId = "windows" | "iphone" | "android";

const DEVICES: { id: DeviceId; label: string; dialog: string }[] = [
  { id: "windows", label: "Windows", dialog: "Print" },
  { id: "iphone", label: "iPhone", dialog: "Printer Options" },
  { id: "android", label: "Android", dialog: "Print" },
];

/** 0 idle, 1 sending, 2 checking, 3 printing, 4 finishing (staple or booklet only), 5 done. */
const DONE = 5;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function statusText(phase: number, finish: Finish): string {
  if (phase === 0) return "Pick a finish, then press Print.";
  if (phase === 1) return "Sending to Printio...";
  if (phase === 2) return "Printio is checking the job...";
  if (phase === 3) return finish === "booklet" ? "Arranging the pages and printing..." : "Printing...";
  if (phase === 4) return finish === "staple" ? "Stapling..." : "Folding and stitching...";
  if (finish === "staple") return "Printed and stapled. The page carries the sender's code.";
  if (finish === "booklet") return "Printed, folded and stitched into a booklet.";
  return "Printed. The page carries the sender's code.";
}

/**
 * The home page's one big moment: pick a device and a finish, press Print, and watch the page go through Printio and
 * come out of the printer. A staple really gets stapled (the arm comes down, the page jolts, the staple appears on
 * that same beat); a booklet really gets folded behind its cover and stitched along the spine. It plays once by itself
 * after load (silent), then whenever someone presses Print. Sound is off until the visitor switches it on, and every
 * sound is scheduled from the same numbers as the animation (lib/landing-timing.ts). On a phone it shows one stage at a
 * time under a stepper, so the whole journey fits on the screen. Reduced motion shows the finished state straight away.
 */
export function HeroDemo() {
  const [device, setDevice] = useState<DeviceId>("iphone");
  const [finish, setFinish] = useState<Finish>("none");
  const [phase, setPhase] = useState(0);
  const [sound, setSound] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clear = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  const play = useCallback(
    (finishNow: Finish, withSound: boolean) => {
      clear();
      if (prefersReducedMotion()) {
        setPhase(DONE);
        return;
      }
      setPhase(1);
      const at = (ms: number, fn: () => void) => timers.current.push(setTimeout(fn, ms));
      at(PHASE_AT_MS.checking, () => setPhase(2));
      at(PHASE_AT_MS.printing, () => setPhase(3));
      if (finishNow === "none") {
        at(PHASE_AT_MS.delivered, () => setPhase(DONE));
        return;
      }
      at(PHASE_AT_MS.delivered, () => {
        setPhase(4);
        // Sound only when the visitor pressed Print themselves with sound switched on (the silent autoplay passes
        // false); scheduled on the audio clock from the animation's own numbers, with one frame of allowance for the
        // browser to start the CSS animation.
        if (withSound) {
          const frame = 16;
          if (finishNow === "staple") playStaple(stapleHitMs() + frame);
          else {
            playFold(frame, FOLD_MS);
            for (const t of STITCH_AT_MS) playStaple(t + frame);
          }
        }
      });
      at(PHASE_AT_MS.delivered + finishMs(finishNow), () => setPhase(DONE));
    },
    [clear],
  );

  useEffect(() => {
    // Plays once after load, silently. No "already played" flag: React runs effects twice in development and a flag
    // would cancel the only run; the cleanup below clears the first timer instead.
    const first = setTimeout(() => play("none", false), 1400);
    return () => {
      clearTimeout(first);
      clear();
    };
  }, [play, clear]);

  const active = DEVICES.find((d) => d.id === device)!;
  const busy = phase > 0 && phase < DONE;
  const current = phase <= 1 ? 0 : phase === 2 ? 1 : phase <= 4 ? 2 : 3;
  const steps = [active.label, "Printio", "Printer"];

  function press() {
    if (sound) audioReady(); // unlocks audio inside the click, which browsers require
    play(finish, sound);
  }

  function chooseFinish(v: Finish) {
    setFinish(v);
    if (!busy) setPhase(0); // a changed option means the finished page is out of date: back to ready
  }

  return (
    <div
      className={styles.stage}
      data-phase={phase}
      data-finish={finish}
      style={
        {
          "--stroke": `${STAPLE_STROKE_MS}ms`,
          "--fold": `${FOLD_MS}ms`,
          "--stitch1": `${STITCH_AT_MS[0]}ms`,
          "--stitch2": `${STITCH_AT_MS[1]}ms`,
          "--pop": `${STITCH_POP_MS}ms`,
        } as React.CSSProperties
      }
    >
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

      {/* Phone only: where the page is right now. */}
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
          <div className={styles.dialogRow} role="group" aria-label="Finish">
            <span className="shrink-0 text-[var(--color-muted)]">Finish</span>
            <span className="flex flex-wrap justify-end gap-1 max-[420px]:gap-0.5">
              {(["none", "staple", "booklet"] as const).map((v) => (
                <button key={v} type="button" className={styles.chip} aria-pressed={finish === v} disabled={busy} onClick={() => chooseFinish(v)}>
                  {v === "none" ? "None" : v === "staple" ? "Staple" : "Booklet"}
                </button>
              ))}
            </span>
          </div>
          <button type="button" className={styles.pressBtn} onClick={press} disabled={busy}>
            {phase === DONE ? "Print again" : busy ? "Printing..." : "Print"}
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
              {phase === DONE ? "Done" : phase === 4 ? "Finishing" : phase === 3 ? "Printing" : "Ready"}
            </span>
          </div>
          <div className={styles.slot} />
          <div className={styles.sheet} data-finish={finish}>
            <div className={styles.sheetInner}>
              {finish === "booklet" ? (
                <div className={styles.fsheet}>
                  <div className={`${styles.fHalf} ${styles.fLeft}`}>
                    <div className={styles.lines} />
                    <span className={styles.fNum}>8</span>
                  </div>
                  <div className={`${styles.fHalf} ${styles.fRight}`}>
                    <div className={styles.lines} />
                    <span className={styles.fNum}>1</span>
                    <span className={styles.stamp}>SZV</span>
                    <span className={`${styles.stitch} ${styles.stitchA}`} />
                    <span className={`${styles.stitch} ${styles.stitchB}`} />
                  </div>
                </div>
              ) : (
                <>
                  <div className={styles.lines} />
                  <span className={styles.stamp}>SZV</span>
                  {finish === "staple" && <span className={styles.staple} />}
                </>
              )}
            </div>
            {finish === "staple" && <span className={styles.stapler} aria-hidden="true" />}
          </div>
        </div>
      </div>

      <div className="mt-4 flex min-h-[2.5rem] flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--color-muted)]" aria-live="polite">
          {statusText(phase, finish)}
        </p>
        <span className="flex flex-wrap items-center gap-2">
          {phase === DONE && (
            <span className={`${styles.mobileOnly} flex flex-wrap gap-2`}>
              <button type="button" className={styles.replay} onClick={() => setPhase(0)}>
                Change options
              </button>
              <button type="button" className={styles.replay} onClick={press}>
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                Print again
              </button>
            </span>
          )}
          <button
            type="button"
            className={styles.replay}
            aria-pressed={sound}
            aria-label={sound ? "Sound on. Press to turn off." : "Sound off. Press to turn on."}
            onClick={() => {
              const next = !sound;
              setSound(next);
              if (next) audioReady();
            }}
          >
            {sound ? <Volume2 className="h-4 w-4" aria-hidden="true" /> : <VolumeX className="h-4 w-4" aria-hidden="true" />}
            Sound {sound ? "on" : "off"}
          </button>
        </span>
      </div>
    </div>
  );
}
