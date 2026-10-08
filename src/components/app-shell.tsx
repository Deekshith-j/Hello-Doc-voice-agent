// Defines the persistent clinic workspace around the current operational page.
// Configuration flags are read on the server so secrets never reach the browser.
import type { ReactNode } from "react";

import { getDashboardAuthConfig, getRetellConfig } from "@/config/environment";

import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

export function AppShell({ children }: { children: ReactNode }) {
  const voiceConnected = Boolean(getRetellConfig()?.agentId);
  const canSignOut = getDashboardAuthConfig() !== null;
  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar voiceConnected={voiceConnected} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar canSignOut={canSignOut} voiceConnected={voiceConnected} />
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
