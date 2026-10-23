"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * A timestamp in the viewer's own locale and time zone. The server (UTC) and the browser format dates differently,
 * so rendering `toLocaleString()` during server rendering makes React's hydration disagree with the HTML. This
 * renders a fixed UTC text on the server and during hydration, then the local text once mounted: no mismatch.
 */
export function LocalTime({ value, fallback = "Never" }: { value: string | null | undefined; fallback?: string }) {
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  if (!value) return <>{fallback}</>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <>{fallback}</>;
  return <time dateTime={date.toISOString()}>{mounted ? date.toLocaleString() : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`}</time>;
}
