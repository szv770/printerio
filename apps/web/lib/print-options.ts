/**
 * Reconciling what a user asked for with what the printer profile they picked
 * actually declares it can do.
 *
 * Why this exists as its own testable function rather than a few `disabled=`
 * attributes in the form: an `<input disabled>` is NOT submitted with the
 * form at all (HTML forms omit disabled controls), so a checkbox rendered
 * `checked` *and* `disabled` produces a UI that says "double-sided" and a
 * FormData that says nothing - and `print/actions.ts` reads a missing field as
 * false. The job then prints single-sided while the page the user submitted
 * from showed it ticked, with no error anywhere to explain it.
 *
 * That is reachable in ordinary use: the form's defaults include duplex ON,
 * and a freshly-created booklet/staple-only profile (which an admin may also
 * mark as the default profile, putting it first in the list) declares no
 * duplex. Switching profiles mid-form is the same story for every option.
 *
 * The fix is to make the *displayed* value the clamped one, so what the form
 * shows and what it submits can't disagree. The user's raw choice is still
 * kept in component state, so switching back to a profile that supports the
 * option restores it rather than silently forgetting it.
 *
 * Nothing here is a security or policy boundary: the server re-derives the
 * job's options from the submitted form and the profile row it re-reads
 * itself (docs/architecture.md sec 3.2). This is purely about the page not
 * lying to the person using it.
 */

export interface DeclaredCapabilities {
  duplex: boolean;
  color: boolean;
  staple: boolean;
  booklet: boolean;
  punch: boolean;
}

export interface RequestedPrintOptions {
  colorMode: "bw" | "color";
  duplex: boolean;
  staple: boolean;
  booklet: boolean;
  punch: boolean;
}

/**
 * Returns the options as they will actually be submitted for a profile with
 * these declared capabilities: anything the profile doesn't declare falls
 * back to the "not requested" value (`bw` for color, `false` for the rest).
 *
 * `capabilities` being null means no profile is selected yet (an org with no
 * printer_profiles at all - print/page.tsx still renders the form), in which
 * case nothing can be requested.
 */
export function clampOptionsToCapabilities(
  requested: RequestedPrintOptions,
  capabilities: DeclaredCapabilities | null,
): RequestedPrintOptions {
  return {
    colorMode: capabilities?.color && requested.colorMode === "color" ? "color" : "bw",
    duplex: !!capabilities?.duplex && requested.duplex,
    staple: !!capabilities?.staple && requested.staple,
    booklet: !!capabilities?.booklet && requested.booklet,
    punch: !!capabilities?.punch && requested.punch,
  };
}
