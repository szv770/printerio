import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/auth/session";
import { JobsList } from "./JobsList";

export default async function JobsPage() {
  const session = await requireSession();
  if (!session.membership) redirect("/no-access");

  const supabase = await createClient();
  const { data: jobs } = await supabase
    .from("print_jobs")
    .select("id, job_number, original_file_name, status, source_pdf_pages, color_mode, duplex, copies, created_at")
    .eq("created_by", session.userId)
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">My jobs</h1>
        <Link href="/print" className="text-sm font-medium text-[var(--color-primary)]">
          + New print job
        </Link>
      </div>
      <JobsList initialJobs={jobs ?? []} userId={session.userId} />
    </main>
  );
}
