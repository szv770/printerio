"use client";

import { useActionState } from "react";
import { Building2 } from "lucide-react";
import { Button, Input, Textarea, FieldLabel, FormError, FormSuccess, Card } from "@/components/ui";
import { createOrganizationAction, type CreateOrganizationActionState } from "./actions";

// A "use server" file may only export async functions, so this trivial seed
// value for useActionState lives here instead of alongside the action.
const initialCreateOrganizationActionState: CreateOrganizationActionState = {};

export function CreateOrganizationForm() {
  const [state, formAction, pending] = useActionState(createOrganizationAction, initialCreateOrganizationActionState);

  return (
    <Card className="max-w-lg">
      <div className="mb-3 flex items-center gap-2">
        <Building2 className="h-4 w-4 text-[var(--color-muted)]" />
        <h2 className="text-sm font-semibold">New organization</h2>
      </div>
      <form action={formAction} className="flex flex-col gap-4">
        <div>
          <FieldLabel htmlFor="name">Name</FieldLabel>
          <Input id="name" name="name" required maxLength={200} placeholder="Lincoln Elementary" />
        </div>
        <div>
          <FieldLabel htmlFor="slug" hint="optional - derived from the name if left blank">
            Slug
          </FieldLabel>
          <Input id="slug" name="slug" maxLength={100} placeholder="lincoln-elementary" />
        </div>
        <div>
          <FieldLabel htmlFor="allowedDomains" hint="one per line or comma-separated, optional">
            Allowed sign-in domains
          </FieldLabel>
          <Textarea id="allowedDomains" name="allowedDomains" rows={3} placeholder={"lincoln.k12.oh.us"} />
        </div>
        <FormError message={state.error} />
        <FormSuccess message={state.success} />
        <div>
          <Button type="submit" pending={pending} pendingLabel="Creating...">
            Create organization
          </Button>
        </div>
      </form>
    </Card>
  );
}
