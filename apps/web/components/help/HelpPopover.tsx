"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { HelpCircle } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { helpForPath } from "@/lib/help-content";
import { PageHelp } from "./PageHelp";
import { openHelp } from "./open-help";

/**
 * The small "?" next to a page title. It opens this page's help in the same Modal as the Help window, and renders
 * nothing on a page that has no help entry. PageHeader mounts it automatically.
 */
export function HelpPopover({ pathname: pathnameProp }: { pathname?: string }) {
  const realPathname = usePathname();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  useEffect(() => {
    // The developer preview picks its page from the address bar; real pages ignore this.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSearch(window.location.search);
  }, []);
  const page = helpForPath(pathnameProp ?? realPathname, search);
  if (!page) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Help with ${page.title}`}
        title="Help with this page"
        className="ml-2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--color-faint)] transition-colors hover:bg-[var(--color-primary-soft)] hover:text-[var(--color-primary)] focus-visible:outline-none focus-visible:shadow-[var(--ring)] [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
      >
        <HelpCircle className="h-5 w-5" aria-hidden="true" />
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={page.title}
        description="Help for this page"
        footer={
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              openHelp("page");
            }}
            className="min-h-11 text-sm font-medium text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:shadow-[var(--ring)]"
          >
            More help, glossary and walkthrough
          </button>
        }
      >
        <PageHelp page={page} />
      </Modal>
    </>
  );
}
