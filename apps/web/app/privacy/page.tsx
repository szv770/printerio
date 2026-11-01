import type { Metadata } from "next";
import { Card } from "@/components/ui";
import { routes } from "@/lib/routes";

export const metadata: Metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return (
    <main className="flex min-h-dvh items-start justify-center bg-[var(--color-bg)] px-4 py-10">
      <Card className="w-full max-w-2xl space-y-4 p-6 text-sm leading-6 sm:p-8">
        <h1 className="text-2xl font-semibold">Privacy</h1>
        <p>Printio lets people in an organization send documents to the organization&apos;s printer and track the jobs. This page says what it keeps.</p>

        <h2 className="pt-2 text-lg font-semibold">What Printio stores</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Your email address and display name, so it knows who you are and which organization you belong to.</li>
          <li>The documents you send to print, and details about each job (name, pages, settings, time, result).</li>
          <li>Which devices you connected for printing from the print dialog, and when they were last used.</li>
        </ul>

        <h2 className="pt-2 text-lg font-semibold">Signing in with Google</h2>
        <p>
          When you choose Google, Printio receives only your email address, your name and your profile picture from Google, to sign you in. It
          does not read your Gmail, Drive, contacts or anything else in your Google account, and it does not post anything to it.
        </p>

        <h2 className="pt-2 text-lg font-semibold">Who can see it</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Your organization&apos;s administrators</strong> can see the people and print jobs of that organization, and can open the
            documents sent in it, including documents sent from the print dialog on a computer or phone. Send a private document only if you are
            comfortable with that.
          </li>
          <li>
            <strong>Other organizations</strong> cannot see yours.
          </li>
          <li>
            <strong>The people who run Printio</strong> keep the service running. Their account in Printio does not give them access to an
            organization&apos;s print jobs or documents, and they do not look at your documents as part of running the service. Because they
            operate the servers, they could technically reach stored files, and they will not do so unless you ask them to help with a problem.
          </li>
        </ul>
        <p>Printio does not sell your information and does not show advertising.</p>

        <h2 className="pt-2 text-lg font-semibold">How long documents are kept</h2>
        <p>Documents are removed from storage after the retention period set by your organization&apos;s administrator. Job records can stay longer so usage can be reported.</p>

        <h2 className="pt-2 text-lg font-semibold">Where it is kept</h2>
        <p>Data is stored with Supabase (database and file storage). Printing itself happens on a computer at your organization.</p>

        <h2 className="pt-2 text-lg font-semibold">Questions or removal</h2>
        <p>Ask your organization&apos;s Printio administrator to remove your account or your documents.</p>

        <p className="pt-2">
          <a className="text-[var(--color-primary)] underline" href={routes.login}>Back to sign in</a>
        </p>
      </Card>
    </main>
  );
}
