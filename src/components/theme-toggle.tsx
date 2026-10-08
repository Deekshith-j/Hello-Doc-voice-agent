// Switches between light and dark themes and remembers the choice for the next visit.
// Icons swap through CSS, so server and client markup always match during hydration.
"use client";

import { Moon, Sun } from "lucide-react";

import { Button } from "./ui/button";

export function ThemeToggle() {
  function toggleTheme() {
    const dark = document.documentElement.classList.toggle("dark");
    try {
      localStorage.setItem("docto-theme", dark ? "dark" : "light");
    } catch {
      // Storage can be unavailable in private modes; the toggle still works for this visit.
    }
  }

  return (
    <Button
      aria-label="Toggle color theme"
      onClick={toggleTheme}
      size="icon"
      variant="ghost"
    >
      <Moon className="size-4 dark:hidden" />
      <Sun className="hidden size-4 dark:block" />
    </Button>
  );
}
