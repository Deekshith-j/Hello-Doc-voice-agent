import { PageContainer } from "@/components/page-header";

export default function DashboardLoading() {
  return (
    <PageContainer>
      <div className="animate-pulse space-y-6">
        <div className="space-y-2">
          <div className="h-7 w-48 rounded-md bg-surface-muted" />
          <div className="h-4 w-96 rounded-md bg-surface-muted/70" />
        </div>

        <div className="rounded-xl border border-border bg-surface p-6 shadow-card">
          <div className="flex items-center justify-between border-b border-border pb-4">
            <div className="space-y-1.5">
              <div className="h-5 w-32 rounded bg-surface-muted" />
              <div className="h-3.5 w-64 rounded bg-surface-muted/60" />
            </div>
            <div className="h-6 w-20 rounded bg-surface-muted/60" />
          </div>

          <div className="mt-4 space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                className="flex items-center justify-between border-b border-border/50 py-2 last:border-0"
                key={i}
              >
                <div className="h-4 w-40 rounded bg-surface-muted" />
                <div className="h-4 w-28 rounded bg-surface-muted/60" />
                <div className="h-4 w-20 rounded bg-surface-muted/60" />
                <div className="h-4 w-16 rounded bg-surface-muted" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
