"use client";

/**
 * A timestamp rendered in the VIEWER's timezone.
 *
 * The job pages used to format timestamps inside a Server Component, which
 * meant `toLocaleString()` ran on Vercel - i.e. in UTC, in the server's
 * locale - so "when did my job actually get approved" was shown in the wrong
 * timezone for every user. Formatting in the browser fixes that, and
 * `suppressHydrationWarning` is the documented escape hatch for exactly this
 * case: markup that is intentionally allowed to differ between the server
 * render and the client one.
 */
export function LocalTime({ iso, mode = "datetime" }: { iso: string; mode?: "datetime" | "time" | "date" }) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const text =
    mode === "time"
      ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : mode === "date"
        ? date.toLocaleDateString()
        : date.toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          });

  return (
    <time dateTime={iso} suppressHydrationWarning>
      {text}
    </time>
  );
}
