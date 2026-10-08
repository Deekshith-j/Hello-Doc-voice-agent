// Wraps every operator page in the clinic workspace after confirming the visitor is signed in.
// Pages re-check the session themselves too, because layouts do not re-render on client navigation.
import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";

export const dynamic = "force-dynamic";

export default function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <AppShell>{children}</AppShell>;
}
