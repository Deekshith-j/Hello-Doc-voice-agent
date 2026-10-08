// Lists voice calls handled by the agent, newest first, with outcomes and latencies.
// Attention items (failed calls and broken calendar syncs) are highlighted at the top.
import Link from "next/link";

import { OutcomeBadge } from "@/components/call-parts";
import {
  EmptyState,
  PageContainer,
  PageHeader,
} from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { getClinicSettings } from "@/config/environment";
import {
  callDurationSeconds,
  formatDateTime,
  formatDuration,
  humanize,
} from "@/lib/format";
import { getToolRuntime } from "@/server/tool-runtime";

export const metadata = {
  title: "Calls · Docto",
  description: "Recent patient voice calls and execution logs.",
};

export default async function CallsPage() {
  const { timeZone } = getClinicSettings();
  const dashboard = getToolRuntime().dashboard;

  const [calls, attention] = await Promise.all([
    dashboard.listCalls(50),
    dashboard.listAttentionItems(10),
  ]);

  return (
    <PageContainer>
      <PageHeader
        description="Review recent patient interactions, verification status, and tool calls."
        title="Call history"
      />

      {attention.length > 0 ? (
        <section aria-label="Attention needed" className="mt-6">
          <Panel
            action={<Badge tone="danger">{attention.length} flagged</Badge>}
            description="Items that require manual operator review"
            title="Needs attention"
          >
            <ul className="divide-y divide-border">
              {attention.map((item) => (
                <li
                  className="flex items-center justify-between gap-4 px-4 py-3 text-xs"
                  key={item.id}
                >
                  <div className="min-w-0">
                    <span className="font-medium text-danger">
                      {item.kind === "failed_call"
                        ? "Call failure"
                        : "Calendar sync failure"}
                    </span>
                    <p className="mt-0.5 truncate text-muted-foreground">
                      {item.detail}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <time className="text-muted-foreground">
                      {formatDateTime(item.occurredAt, timeZone)}
                    </time>
                    <Link
                      className="font-medium text-accent hover:underline"
                      href={item.href}
                    >
                      Review
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        </section>
      ) : null}

      <div className="mt-6">
        <Panel
          description={`Showing up to 50 most recent records (${calls.length} recorded)`}
          title="All calls"
        >
          {calls.length === 0 ? (
            <EmptyState title="No calls recorded yet">
              Incoming web and telephony calls will appear here after the voice
              agent runs.
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border bg-surface-muted text-[11px] font-medium text-muted-foreground">
                    <th className="px-4 py-2.5">Date & Time</th>
                    <th className="px-4 py-2.5">Patient / Caller</th>
                    <th className="px-4 py-2.5">Outcome</th>
                    <th className="px-4 py-2.5">Duration</th>
                    <th className="px-4 py-2.5">Latency (p50)</th>
                    <th className="px-4 py-2.5">Tools</th>
                    <th className="px-4 py-2.5 text-right">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {calls.map((call) => {
                    const durationSec = callDurationSeconds(
                      call.startedAt,
                      call.endedAt,
                    );
                    return (
                      <tr
                        className="transition-colors hover:bg-surface-muted/50"
                        key={call.id}
                      >
                        <td className="px-4 py-3 whitespace-nowrap">
                          {formatDateTime(call.startedAt, timeZone)}
                        </td>
                        <td className="px-4 py-3 font-medium">
                          {call.patientName ?? (
                            <span className="text-muted-foreground">
                              Unidentified
                            </span>
                          )}
                          {call.callType ? (
                            <span className="ml-1.5 text-[10px] text-muted-foreground">
                              ({humanize(call.callType)})
                            </span>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <OutcomeBadge outcome={call.outcome} />
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap tabular-nums text-muted-foreground">
                          {durationSec !== null
                            ? formatDuration(durationSec)
                            : "Active"}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap tabular-nums text-muted-foreground">
                          {call.e2eLatencyP50Ms !== null
                            ? `${call.e2eLatencyP50Ms} ms`
                            : "—"}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className="tabular-nums">{call.toolCount}</span>
                          {call.failedTools > 0 ? (
                            <span className="ml-1 text-danger">
                              ({call.failedTools} failed)
                            </span>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          <Link
                            className="font-medium text-accent hover:underline"
                            href={`/calls/${call.id}`}
                          >
                            View
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </PageContainer>
  );
}
