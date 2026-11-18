"use client";

import { useState } from "react";
import { Check, Loader2, RefreshCw, TriangleAlert, Wifi } from "lucide-react";
import { Button } from "@/components/ui";
import { probeHostFor, summarizeConnectionTest, type ConnectionReport, type ConnectionSummary, type ProbeResult } from "@/lib/devices/connection-test";
import { saveConnectionTestAction } from "./actions";

const TIMEOUT_MS = 8000;

/** Can this browser reach `url`? A no-cors fetch gives an opaque answer when something responds, and throws when the name
 *  does not resolve, the connection is blocked, or TLS fails - which is all we need to know. */
async function probe(url: string): Promise<ProbeResult> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    await fetch(url, { mode: "no-cors", cache: "no-store", credentials: "omit", signal: controller.signal });
    return { ok: true, ms: performance.now() - started };
  } catch {
    return { ok: false, ms: performance.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** "Test my connection": runs in the browser on the device being set up (so it tests THAT device's network), then
 *  saves only yes/no + timings so an admin can see the result. The address itself is never sent anywhere new:
 *  the browser contacts it directly, exactly as the print dialog will. */
export function ConnectionTest({ deviceId, hostname }: { deviceId: string; hostname: string }) {
  const [phase, setPhase] = useState<"idle" | "running" | "done">("idle");
  const [summary, setSummary] = useState<ConnectionSummary | null>(null);
  const [saved, setSaved] = useState<"yes" | "no" | null>(null);

  async function run() {
    setPhase("running");
    setSummary(null);
    setSaved(null);
    const probeHost = probeHostFor(hostname);
    const [control, short, real] = await Promise.all([
      probe(`${window.location.origin}/manifest.webmanifest`),
      probeHost ? probe(`https://${probeHost}/healthz`) : Promise.resolve<ProbeResult>({ ok: false, ms: 0 }),
      probe(`https://${hostname}/healthz`),
    ]);
    const report: ConnectionReport = { control, probe: short, real };
    setSummary(summarizeConnectionTest(report));
    setPhase("done");
    const res = await saveConnectionTestAction(deviceId, report).catch(() => ({ error: "x" }));
    setSaved(res.error ? "no" : "yes");
  }

  return (
    <div className="rounded-xl border-2 border-[var(--color-border)] p-3.5">
      <div className="flex items-start gap-3">
        <Wifi className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-primary)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Test my connection</p>
          <p className="mt-0.5 text-[13px] leading-5 text-[var(--color-muted)]">
            Run this on the device you are setting up. It checks that this network can reach your print address, before you
            try the steps. If anything is off, your admin can see the result and help.
          </p>
        </div>
      </div>
      <div className="mt-3" aria-live="polite">
        {phase === "running" && (
          <p className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Checking... this takes up to 10 seconds.
          </p>
        )}
        {summary && (
          <div
            role={summary.tone === "success" ? "status" : "alert"}
            className={`mb-3 rounded-xl p-3 text-sm ${summary.tone === "success" ? "bg-[var(--color-success-soft)]" : "bg-[var(--color-warning-soft)] text-[var(--color-warning-ink)]"}`}
          >
            <p className="flex items-center gap-2 font-semibold">
              {summary.tone === "success" ? <Check className="h-4 w-4" aria-hidden="true" /> : <TriangleAlert className="h-4 w-4" aria-hidden="true" />}
              {summary.title}
            </p>
            <p className="mt-1 leading-6">{summary.advice}</p>
            {saved === "yes" && <p className="mt-2 text-[13px] opacity-80">Your admin can see this result.</p>}
            {saved === "no" && <p className="mt-2 text-[13px] opacity-80">The result could not be saved, but what you see above is still right.</p>}
          </div>
        )}
        <Button type="button" variant="secondary" onClick={run} disabled={phase === "running"}>
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
          {phase === "idle" ? "Test my connection" : "Test again"}
        </Button>
      </div>
    </div>
  );
}
