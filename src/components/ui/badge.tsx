// Labels short states such as verification or preview mode with restrained color.
// Tones map to semantic tokens so badges stay legible in both themes.
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

const tones = {
  accent: "bg-accent-soft text-accent-foreground",
  danger: "bg-danger/10 text-danger",
  neutral: "border border-border bg-surface-muted text-muted-foreground",
  warning: "bg-warning-soft text-warning-foreground",
} as const;

export type BadgeTone = keyof typeof tones;

export function Badge({
  children,
  className,
  tone = "neutral",
}: {
  children: ReactNode;
  className?: string;
  tone?: keyof typeof tones;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
