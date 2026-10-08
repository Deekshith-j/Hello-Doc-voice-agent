// Replaces a failed dashboard page with a plain explanation and a retry, keeping navigation usable.
// The most common cause in development is the database not running, so the hint says so.
"use client";

import { RotateCw } from "lucide-react";
import { useEffect } from "react";

import { PageContainer } from "@/components/page-header";
import { Button } from "@/components/ui/button";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[DashboardError]", error);
  }, [error]);

  return (
    <PageContainer>
      <div className="enter mx-auto max-w-md rounded-xl border border-border bg-surface p-6 text-center shadow-card">
        <h1 className="text-lg font-semibold tracking-[-0.02em]">
          This page couldn&apos;t load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {error.message ||
            "The clinic database didn't answer. Check that DATABASE_URL is set and reachable."}
        </p>
        {error.digest ? (
          <p className="mt-2 font-mono text-[11px] text-muted-foreground">
            Reference {error.digest}
          </p>
        ) : null}
        <Button className="mt-5" onClick={() => reset()} variant="secondary">
          <RotateCw className="size-4" />
          Try again
        </Button>
      </div>
    </PageContainer>
  );
}
