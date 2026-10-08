// Frames a titled section of the workspace with consistent spacing and hairline borders.
// One primitive keeps every panel's header hierarchy identical across the dashboard.
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface PanelProps {
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  description?: string;
  title: string;
}

export function Panel({
  action,
  children,
  className,
  description,
  title,
}: PanelProps) {
  return (
    <section
      className={cn(
        "rounded-xl border border-border bg-surface shadow-card",
        className,
      )}
    >
      <header className="flex items-start justify-between gap-3 px-4 pt-4">
        <div>
          <h2 className="text-[13px] font-semibold tracking-[-0.01em]">
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
