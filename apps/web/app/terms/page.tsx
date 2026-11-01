import type { Metadata } from "next";
import { Card } from "@/components/ui";
import { routes } from "@/lib/routes";

export const metadata: Metadata = { title: "Terms" };

export default function TermsPage() {
  return (
    <main className="flex min-h-dvh items-start justify-center bg-[var(--color-bg)] px-4 py-10">
      <Card className="w-full max-w-2xl space-y-4 p-6 text-sm leading-6 sm:p-8">
        <h1 className="text-2xl font-semibold">Terms of use</h1>
        <p>Printio is a print management service for organizations. By signing in you agree to these terms.</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>Use Printio only for printing you are allowed to do. Your organization may set limits (pages, size, approvals) and may refuse or cancel jobs.</li>
          <li>Do not upload documents you have no right to print, and do not try to get around limits, other people&apos;s access or the service itself.</li>
          <li>Signing in does not by itself give access to an organization. Access comes from an invitation or your organization&apos;s rules.</li>
          <li>Printio tells you when the printer has received a job. It cannot promise that paper came out, so check the printer for important jobs.</li>
          <li>The service is provided as is, and may change or be unavailable at times.</li>
        </ul>
        <p>See also the <a className="text-[var(--color-primary)] underline" href={routes.privacy}>privacy page</a>.</p>
        <p>
          <a className="text-[var(--color-primary)] underline" href={routes.login}>Back to sign in</a>
        </p>
      </Card>
    </main>
  );
}
