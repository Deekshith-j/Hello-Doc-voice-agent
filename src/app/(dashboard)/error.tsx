// Replaces a failed dashboard page with a plain explanation and a retry, keeping navigation usable.
// The most common cause in development is the database not running, so the hint says so.
"use client";

import { RotateCw } from "lucide-react";
import { useEffect } from "react";

import { PageContainer } from "@/components/page-header";
import { Button } from "@/components/ui/button";

export default function DashboardError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <PageContainer>
      <div className="enter mx-auto max-w-md rounded-xl border border-border bg-surface p-6 text-center shadow-card">
        <h1 className="text-lg font-semibold tracking-[-0.02em]">
          This page couldn&apos;t load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The clinic database didn&apos;t answer. Check that DATABASE_URL is set
          and reachable (locally, run <code>npm run db:local</code>).
        </p>
        {error.digest ? (
          <p className="mt-2 font-mono text-[11px] text-muted-foreground">
            Reference {error.digest}
          </p>
        ) : null}
        <Button className="mt-5" onClick={retry} variant="secondary">
          <RotateCw className="size-4" />
          Try again
        </Button>
      </div>
    </PageContainer>
  );
}
