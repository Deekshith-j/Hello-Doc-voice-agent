// Wraps every operator page in the clinic workspace after confirming the visitor is signed in.
// Pages re-check the session themselves too, because layouts do not re-render on client navigation.
import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import { requireOperator } from "@/server/dashboard-session";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireOperator();
  return <AppShell>{children}</AppShell>;
}
