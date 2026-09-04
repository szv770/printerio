import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/auth/session";
import { routes } from "@/lib/routes";
import { PageHeader } from "@/components/ui";
import { JobsList } from "./JobsList";

export default async function JobsPage() {
  const session = await requireSession();
  if (!session.membership) redirect(routes.noAccess);

  const supabase = await createClient();
  const { data: jobs } = await supabase
    .from("print_jobs")
    .select("id, job_number, original_file_name, status, source_pdf_pages, color_mode, duplex, copies, created_at")
    .eq("created_by", session.userId)
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <PageHeader
        title="My jobs"
        action={
          <Link href={routes.print} className="text-sm font-medium text-[var(--color-primary)]">
            + New print job
          </Link>
        }
      />
      <JobsList initialJobs={jobs ?? []} userId={session.userId} />
    </main>
  );
}
