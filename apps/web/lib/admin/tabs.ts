import type { TabItem } from "@/components/ui/Tabs";
import { routes } from "@/lib/routes";

export type PeopleTab = "users" | "groups" | "invites";
export type PrinterTab = "printers" | "agents" | "devices";

/** Users | Groups | Invites. Invites is for admins only (approvers cannot create codes). */
export function peopleTabs(active: PeopleTab, isOrgAdmin: boolean): TabItem[] {
  const tabs: TabItem[] = [
    { href: routes.adminUsers, label: "Users", active: active === "users" },
    { href: routes.adminGroups, label: "Groups", active: active === "groups" },
  ];
  if (isOrgAdmin) tabs.push({ href: routes.adminInvites, label: "Invites", active: active === "invites" });
  return tabs;
}

/** Printers | Print servers | User devices (the last is admin only, like the page). */
export function printerTabs(active: PrinterTab, isOrgAdmin: boolean): TabItem[] {
  const tabs: TabItem[] = [
    { href: routes.adminPrinters, label: "Printers", active: active === "printers" },
    { href: routes.adminAgents, label: "Print servers", active: active === "agents" },
  ];
  if (isOrgAdmin) tabs.push({ href: routes.adminDevices, label: "User devices", active: active === "devices" });
  return tabs;
}

export type RulesTab = "rules" | "quotas";
export type ReportsTab = "usage" | "audit";

/** Print rules | Monthly limits. */
export function rulesTabs(active: RulesTab): TabItem[] {
  return [
    { href: routes.adminPolicies, label: "Print rules", active: active === "rules" },
    { href: routes.adminQuotas, label: "Monthly limits", active: active === "quotas" },
  ];
}

/** Usage | Activity log (the log is for admins only, like the page). */
export function reportTabs(active: ReportsTab, isOrgAdmin: boolean): TabItem[] {
  const tabs: TabItem[] = [{ href: routes.adminReports, label: "Usage", active: active === "usage" }];
  if (isOrgAdmin) tabs.push({ href: routes.adminAudit, label: "Activity log", active: active === "audit" });
  return tabs;
}
