// Renders when a requested URL or resource does not exist.
import Link from "next/link";

import { DoctoLogo } from "@/components/docto-logo";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="enter w-full max-w-sm text-center">
        <div className="flex justify-center">
          <DoctoLogo />
        </div>
        <div className="mt-6 rounded-xl border border-border bg-surface p-6 shadow-card">
          <h1 className="text-xl font-semibold tracking-[-0.02em]">
            Page not found
          </h1>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            The page or record you requested does not exist or may have been
            moved.
          </p>
          <div className="mt-5">
            <Link href="/">
              <Button className="w-full" variant="primary">
                Return to front desk
              </Button>
            </Link>
          </div>
        </div>
        <footer className="mt-8 text-center text-xs text-muted-foreground">
          Synthetic data only. Not for real patient information.
        </footer>
      </div>
    </main>
  );
}
