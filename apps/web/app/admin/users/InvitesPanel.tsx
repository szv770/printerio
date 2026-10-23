import { KeyRound, Ticket } from "lucide-react";
import { Collapsible, EmptyState } from "@/components/ui";
import { inviteStatus } from "@/lib/auth/invite-link";
import { InviteForm } from "./InviteForm";
import { InvitationsList, type OpenInvitation } from "./InvitationsList";

/** The two sections of the Invites tab, both closed until opened. */
export function InvitesPanel({ invitations, orgName }: { invitations: OpenInvitation[]; orgName: string }) {
  const active = invitations.filter((i) => inviteStatus(i) === "active").length;
  return (
    <div className="flex flex-col gap-4">
      <Collapsible
        id="new-invite"
        title="Invite someone"
        icon={<KeyRound className="h-4 w-4" />}
        summary="Make an invite link that lets a person join"
      >
        <InviteForm orgName={orgName} />
      </Collapsible>
      <Collapsible
        id="open-invites"
        title="Your invites"
        icon={<Ticket className="h-4 w-4" />}
        summary={
          invitations.length === 0
            ? "No invites yet"
            : `${active} ${active === 1 ? "invite works" : "invites work"} right now`
        }
      >
        {invitations.length === 0 ? (
          <EmptyState message="No invites yet. Make one above." icon={Ticket} />
        ) : (
          <InvitationsList invitations={invitations} orgName={orgName} />
        )}
      </Collapsible>
    </div>
  );
}
