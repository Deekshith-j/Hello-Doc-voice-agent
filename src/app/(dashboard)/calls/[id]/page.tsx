// Displays full audit trail for a single call: timing, disconnection reason, tools, and transcript.
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  OutcomeBadge,
  ToolActivityList,
  TranscriptList,
} from "@/components/call-parts";
import { PageContainer, PageHeader } from "@/components/page-header";
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
  title: "Call detail · Docto",
  description: "Detailed transcript and tool timeline for a single call.",
};

export default async function CallDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { timeZone } = getClinicSettings();
  const call = await getToolRuntime().dashboard.getCall(id);

  if (!call) notFound();

  const durationSec = callDurationSeconds(call.startedAt, call.endedAt);
  const turns = call.transcript.map((turn, index) => ({
    key: `${index}-${turn.offsetSeconds ?? index}`,
    offsetSeconds: turn.offsetSeconds,
    speaker: turn.speaker,
    text: turn.text,
  }));

  const toolsView = call.tools.map((tool) => ({
    id: tool.id,
    latencyMs: tool.latencyMs,
    result: tool.result
      ? { code: tool.result.code, message: tool.result.message }
      : null,
    succeeded: tool.succeeded,
    toolName: tool.toolName,
  }));

  return (
    <PageContainer>
      <div className="mb-4">
        <Link
          className="text-xs font-medium text-muted-foreground hover:text-foreground"
          href="/calls"
        >
          ← Back to calls
        </Link>
      </div>

      <PageHeader
        actions={<OutcomeBadge outcome={call.outcome} />}
        description={`Retell Call ID: ${call.providerCallId}`}
        eyebrow={
          <Badge tone="neutral">
            {call.callType ? humanize(call.callType) : "Voice call"}
          </Badge>
        }
        title={call.patientName ?? "Unidentified caller"}
      />

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-border bg-surface p-3 shadow-card">
          <p className="text-[11px] text-muted-foreground">Started</p>
          <p className="mt-1 text-xs font-medium">
            {formatDateTime(call.startedAt, timeZone)}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-3 shadow-card">
          <p className="text-[11px] text-muted-foreground">Duration</p>
          <p className="mt-1 text-xs font-medium tabular-nums">
            {durationSec !== null ? formatDuration(durationSec) : "Active"}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-3 shadow-card">
          <p className="text-[11px] text-muted-foreground">P50 Latency</p>
          <p className="mt-1 text-xs font-medium tabular-nums">
            {call.e2eLatencyP50Ms !== null ? `${call.e2eLatencyP50Ms} ms` : "—"}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-3 shadow-card">
          <p className="text-[11px] text-muted-foreground">Disconnection</p>
          <p className="mt-1 truncate text-xs font-medium">
            {call.disconnectionReason
              ? humanize(call.disconnectionReason)
              : "Normal"}
          </p>
        </div>
      </div>

      {call.summary ? (
        <div className="mt-4 rounded-lg border border-border bg-surface-muted p-4 text-xs">
          <p className="font-semibold text-foreground">Call Summary</p>
          <p className="mt-1 leading-relaxed text-muted-foreground">
            {call.summary}
          </p>
        </div>
      ) : null}

      <div className="mt-6 grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel
          description="Audited transcript turns"
          title="Conversation transcript"
        >
          <TranscriptList
            emptyText="No transcript lines were recorded for this call."
            turns={turns}
          />
        </Panel>

        <Panel
          action={
            <Badge tone={call.failedTools > 0 ? "danger" : "neutral"}>
              {call.toolCount} executed
            </Badge>
          }
          description="Tools invoked during call"
          title="Executed tool actions"
        >
          <ToolActivityList
            emptyText="No tools were called during this interaction."
            tools={toolsView}
          />
        </Panel>
      </div>
    </PageContainer>
  );
}
