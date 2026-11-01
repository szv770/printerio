/**
 * Whether the agent is in the middle of sending a job to a printer right now. A direct-port printer may take only one
 * connection at a time, so the status check (printer-probe.ts) waits until no job is being sent.
 */
let sending = 0;

export async function trackSending<T>(work: () => Promise<T>): Promise<T> {
  sending++;
  try {
    return await work();
  } finally {
    sending--;
  }
}

export const isSending = (): boolean => sending > 0;

/**
 * Marks the printer as busy beyond the send itself (printer feedback: until the verdict is reached). Returns the release
 * function; calling it more than once is harmless.
 */
export function holdSending(): () => void {
  sending++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    sending--;
  };
}
