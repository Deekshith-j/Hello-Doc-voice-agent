// Displays historical evaluation test suite results recorded against the clinic database.
// Shows test cases, check breakdowns, and passing percentages.
import { Check, X } from "lucide-react";

import {
  EmptyState,
  PageContainer,
  PageHeader,
} from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { getClinicSettings } from "@/config/environment";
import { formatDateTime } from "@/lib/format";
import { getToolRuntime } from "@/server/tool-runtime";

export const metadata = {
  title: "Evaluations · Docto",
  description: "Automated tool contract evaluation runs and benchmark results.",
};

export default async function EvaluationsPage() {
  const { timeZone } = getClinicSettings();
  const dashboard = getToolRuntime().dashboard;
  const runs = await dashboard.listEvalRuns(20);

  return (
    <PageContainer>
      <PageHeader
        description="Verify tool contracts, invariant adherence, and multi-turn booking accuracy."
        title="Agent evaluations"
      />

      <div className="mt-6 space-y-6">
        {runs.length === 0 ? (
          <Panel title="Evaluation runs">
            <EmptyState title="No evaluation runs recorded yet">
              Run <code>npm run eval</code> to execute the tool test scenarios
              and persist results to the database.
            </EmptyState>
          </Panel>
        ) : (
          runs.map((run) => {
            const total = run.passed + run.failed;
            const passPercent =
              total > 0 ? Math.round((run.passed / total) * 100) : 0;
            const allPassed = run.failed === 0;

            return (
              <Panel
                action={
                  <Badge tone={allPassed ? "accent" : "danger"}>
                    {run.passed}/{total} passed ({passPercent}%)
                  </Badge>
                }
                description={`Run executed at ${formatDateTime(run.startedAt, timeZone)}`}
                key={run.id}
                title={run.suite}
              >
                <div className="divide-y divide-border px-4 py-2 text-xs">
                  {run.results.map((result, idx) => (
                    <div className="py-3" key={idx}>
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-2 font-medium">
                          {result.passed ? (
                            <Check className="size-3.5 text-accent-foreground" />
                          ) : (
                            <X className="size-3.5 text-danger" />
                          )}
                          {result.name}
                        </span>
                        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                          {result.durationMs} ms
                        </span>
                      </div>

                      {result.checks.length > 0 ? (
                        <ul className="mt-2 space-y-1 pl-5 text-[11px]">
                          {result.checks.map((chk, cIdx) => (
                            <li
                              className={
                                chk.passed
                                  ? "text-muted-foreground"
                                  : "text-danger font-medium"
                              }
                              key={cIdx}
                            >
                              {chk.passed ? "✓" : "✗"} {chk.name}
                              {!chk.passed ? `: ${chk.detail}` : ""}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ))}
                </div>
              </Panel>
            );
          })
        )}
      </div>
    </PageContainer>
  );
}
