import { KeyRound, Ticket } from "lucide-react";
import { Collapsible, EmptyState } from "@/components/ui";
import { InviteForm } from "./InviteForm";
import { InvitationsList, type OpenInvitation } from "./InvitationsList";

/** The two sections of the Invites tab, both closed until opened. */
export function InvitesPanel({ invitations }: { invitations: OpenInvitation[] }) {
  const count = invitations.length;
  return (
    <div className="flex flex-col gap-4">
      <Collapsible
        id="new-invite"
        title="Invite someone"
        icon={<KeyRound className="h-4 w-4" />}
        summary="Make a code that lets a person join"
      >
        <InviteForm />
      </Collapsible>
      <Collapsible
        id="open-invites"
        title="Codes in use"
        icon={<Ticket className="h-4 w-4" />}
        summary={count === 0 ? "No codes right now" : `${count} ${count === 1 ? "code works" : "codes work"} right now`}
      >
        {count === 0 ? (
          <EmptyState message="No invite codes yet. Make one above." icon={Ticket} />
        ) : (
          <InvitationsList invitations={invitations} />
        )}
      </Collapsible>
    </div>
  );
}
