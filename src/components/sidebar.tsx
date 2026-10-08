// Provides stable navigation across the clinic's operational surfaces.
// The active item follows the URL, so deep links such as a call's detail page still highlight "Calls".
"use client";

import {
  AudioLines,
  CalendarDays,
  PhoneCall,
  Stethoscope,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

import { DoctoLogo } from "./docto-logo";

export interface NavigationItem {
  href: string;
  icon: LucideIcon;
  label: string;
}

export const navigation: readonly NavigationItem[] = [
  { href: "/", label: "Live call", icon: AudioLines },
  { href: "/calls", label: "Calls", icon: PhoneCall },
  { href: "/appointments", label: "Appointments", icon: CalendarDays },
  { href: "/doctors", label: "Doctors", icon: Stethoscope },
];

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function Sidebar({ voiceConnected }: { voiceConnected: boolean }) {
  const pathname = usePathname();
  return (
    <aside className="hidden w-[232px] shrink-0 flex-col border-r border-border px-3 py-4 lg:flex">
      <div className="px-2">
        <DoctoLogo />
      </div>
      <p className="mt-7 px-2.5 text-[11px] font-medium text-muted-foreground">
        Front desk
      </p>
      <nav aria-label="Primary navigation" className="mt-1.5 space-y-0.5">
        {navigation.map((item) => (
          <NavigationLink
            active={isActive(pathname, item.href)}
            item={item}
            key={item.href}
          />
        ))}
      </nav>
      <div className="mt-auto rounded-lg border border-border bg-surface p-3 shadow-card">
        <div className="flex items-center gap-2 text-xs font-medium">
          <span
            className={cn(
              "size-1.5 rounded-full",
              voiceConnected ? "bg-accent" : "bg-warning-foreground",
            )}
          />
          {voiceConnected ? "Voice agent connected" : "Voice agent not set up"}
        </div>
        <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
          {voiceConnected
            ? "Web calls and phone calls reach the Retell agent."
            : "Add RETELL_API_KEY and RETELL_AGENT_ID to start calls."}
        </p>
      </div>
    </aside>
  );
}

function NavigationLink({
  active,
  item: { href, icon: Icon, label },
}: {
  active: boolean;
  item: NavigationItem;
}) {
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors duration-150",
        active
          ? "bg-surface font-medium shadow-card ring-1 ring-border"
          : "text-muted-foreground hover:bg-surface-muted hover:text-foreground",
      )}
      href={href}
    >
      <Icon
        aria-hidden="true"
        className={cn("size-4", active ? "text-accent" : "opacity-70")}
      />
      {label}
    </Link>
  );
}
