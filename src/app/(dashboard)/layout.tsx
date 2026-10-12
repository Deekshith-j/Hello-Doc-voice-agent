// Wraps every operator page in the clinic dashboard with the shared navigation shell.
// Dynamic rendering ensures appointment lists and live call statuses are always fresh.
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
