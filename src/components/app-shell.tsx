import type { ReactNode } from "react";

import { getRetellConfig } from "@/config/environment";

import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

export function AppShell({ children }: { children: ReactNode }) {
  const voiceConnected = Boolean(getRetellConfig()?.agentId);
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <div className="border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-center text-xs font-medium text-warning-foreground">
        Use fake details only. Dashboard is public.
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar voiceConnected={voiceConnected} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar voiceConnected={voiceConnected} />
          <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
        </div>
      </div>
      <footer className="shrink-0 border-t border-border bg-surface-muted/50 px-4 py-2 text-center text-xs text-muted-foreground">
        Synthetic data only. Not for real patient information.
      </footer>
    </div>
  );
}
