"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Check, Copy, Mail } from "lucide-react";
import { getBuildInfo, shortSha } from "@/lib/build-info";
import { buttonClass } from "@/components/ui/Button";
import { detailsText, reportMailto, safePagePath, type ReportDetails } from "./report-problem";

function collect(pathname: string | null, digest?: string | null): ReportDetails {
  const info = getBuildInfo();
  const sha = shortSha(info.commitSha);
  const build = [info.version, sha ? `(${sha})` : null].filter(Boolean).join(" ") || "unknown";
  return {
    page: safePagePath(pathname ?? (typeof window === "undefined" ? null : window.location.pathname)),
    digest: digest ?? null,
    build,
    browser: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
  };
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * "Report a problem": opens a prefilled email when NEXT_PUBLIC_SUPPORT_EMAIL is set, otherwise shows a
 * "Copy details" button so the person can paste the details wherever they report problems.
 */
export function ReportProblemLink({
  digest,
  variant = "secondary",
  className = "",
  label = "Report a problem",
}: {
  digest?: string | null;
  variant?: "primary" | "secondary" | "ghost";
  className?: string;
  label?: string;
}) {
  const pathname = usePathname();
  const [copied, setCopied] = useState<"idle" | "yes" | "no">("idle");
  const email = process.env.NEXT_PUBLIC_SUPPORT_EMAIL?.trim();
  const cls = buttonClass(variant, "default", className);

  if (email) {
    return (
      <a
        href={reportMailto(email, collect(pathname, digest))}
        onClick={(e) => {
          // Rebuild at click time so the browser string is the real one, not the server's.
          e.currentTarget.href = reportMailto(email, collect(pathname, digest));
        }}
        className={cls}
      >
        <Mail className="h-4 w-4" aria-hidden="true" />
        {label}
      </a>
    );
  }

  return (
    <span className="inline-flex flex-col items-start gap-1.5">
      <button
        type="button"
        className={cls}
        onClick={async () => setCopied((await copyText(detailsText(collect(pathname, digest)))) ? "yes" : "no")}
      >
        {copied === "yes" ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
        {copied === "yes" ? "Copied" : "Copy details"}
      </button>
      <span role="status" className="text-[13px] leading-5 text-[var(--color-muted)]">
        {copied === "yes"
          ? "Paste them into a message to whoever looks after Printio."
          : copied === "no"
            ? "Could not copy. Please tell us the page you were on."
            : "Copies the page, version and browser so you can send them to whoever looks after Printio."}
      </span>
    </span>
  );
}
