// Shows where the operator is and the agent's availability with lightweight global controls.
// On small screens the primary navigation moves here as a horizontal strip.
"use client";

import { ChevronRight, LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { signOut } from "@/app/login/actions";
import { cn } from "@/lib/utils";

import { DoctoLogo } from "./docto-logo";
import { isActive, navigation } from "./sidebar";
import { ThemeToggle } from "./theme-toggle";
import { Button } from "./ui/button";

export function Topbar({
  canSignOut,
  voiceConnected,
}: {
  canSignOut: boolean;
  voiceConnected: boolean;
}) {
  const pathname = usePathname();
  const current =
    navigation.find((item) => isActive(pathname, item.href)) ?? navigation[0];
  const currentTitle = current?.label ?? "Front desk";
  return (
    <header className="shrink-0 border-b border-border">
      <div className="flex h-14 items-center justify-between px-4 md:px-6">
        <div className="flex items-center gap-3">
          <div className="lg:hidden">
            <DoctoLogo />
          </div>
          <nav
            aria-label="Breadcrumb"
            className="hidden items-center gap-1.5 text-[13px] sm:flex"
          >
            <span className="text-muted-foreground">Front desk</span>
            <ChevronRight
              aria-hidden="true"
              className="size-3.5 text-muted-foreground/60"
            />
            <span className="font-medium">{currentTitle}</span>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-2 rounded-full border border-border bg-surface px-2.5 py-1 text-xs font-medium shadow-card sm:flex">
            <span className="relative flex size-1.5">
              {voiceConnected ? (
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60 motion-reduce:hidden" />
              ) : null}
              <span
                className={cn(
                  "relative size-1.5 rounded-full",
                  voiceConnected ? "bg-accent" : "bg-warning-foreground",
                )}
              />
            </span>
            {voiceConnected ? "Agent online" : "Agent not set up"}
          </span>
          <ThemeToggle />
          {canSignOut ? (
            <form action={signOut}>
              <Button
                aria-label="Sign out"
                size="icon"
                title="Sign out"
                type="submit"
                variant="ghost"
              >
                <LogOut className="size-4" />
              </Button>
            </form>
          ) : null}
        </div>
      </div>
      <nav
        aria-label="Primary navigation"
        className="flex gap-1 overflow-x-auto px-3 pb-2 lg:hidden"
      >
        {navigation.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 text-[13px]",
                active
                  ? "bg-surface font-medium shadow-card ring-1 ring-border"
                  : "text-muted-foreground",
              )}
              href={item.href}
              key={item.href}
            >
              <item.icon aria-hidden="true" className="size-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
