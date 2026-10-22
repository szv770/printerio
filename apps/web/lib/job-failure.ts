/**
 * Plain-words explanation of why a print failed.
 *
 * `print_jobs.error_message` is whatever the print agent (or the sweep) recorded: spooler status text, a socket
 * error, sometimes a stack trace. That is useful to an administrator reading the agent log, and useless - or
 * alarming - to the teacher whose document it is, so the website never prints it raw. This maps the failures the
 * agent and the sweep are known to report onto short sentences, and falls back to a generic sentence for anything
 * it does not recognise (the full text stays in the job's event history for admins).
 *
 * Pure and dependency-free so the job page, the job list and the progress model can all share it.
 */

const FALLBACK = "This job did not print. The printer or the print computer reported a problem.";

interface Rule {
  test: RegExp;
  say: (match: RegExpMatchArray) => string;
}

const RULES: readonly Rule[] = [
  {
    test: /queue ['"]([^'"\r\n]{1,80})['"] not found/i,
    say: (m) => `The printer queue "${m[1]}" was not found on the print computer. Ask an administrator to check the printer setup.`,
  },
  {
    test: /lease expired|agent likely disconnected|disconnected or crashed/i,
    say: () => "The print computer stopped responding while this job was printing, so it may not have finished.",
  },
  {
    test: /agent restarted|could not be resumed|restarted mid/i,
    say: () => "The print computer restarted while this job was printing, so it did not finish.",
  },
  {
    test: /timed out|timeout/i,
    say: () => "The printer took too long to accept this job. It may be busy, offline or out of paper.",
  },
  {
    test: /never observed on queue|could not confirm spooler|could not identify the resulting windows spooler|could_not_identify_spooler_job/i,
    say: () => "The print computer sent the job but could not confirm that the printer accepted it. Check the printer, then try again.",
  },
  {
    test: /spooler reported a failure|spooler.*(error|offline|paused|paper|jam)|printer.*(offline|error)/i,
    say: () => "The printer reported a problem (it may be offline, jammed or out of paper).",
  },
  {
    test: /econnrefused|ehostunreach|enetunreach|etimedout|enotfound|raw print|port 9100|socket|connect(ion)? (refused|failed)/i,
    say: () => "The print computer could not reach the printer. Check that the printer is on and connected to the network.",
  },
  {
    test: /download|fetch failed|signed url|403|404|file not found|no such file/i,
    say: () => "The print computer could not get your document. Try again; if it keeps happening, upload the file again.",
  },
  {
    test: /sumatra|exit code|exited with|print execution|failed to start/i,
    say: () => "The print computer could not send this document to the printer.",
  },
];

export function friendlyFailureMessage(raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  if (!text) return FALLBACK;
  for (const rule of RULES) {
    const m = text.match(rule.test);
    if (m) return rule.say(m);
  }
  return FALLBACK;
}
