// Renders the pieces of a call that operators audit: outcome, transcript turns, and tool actions.
// These are plain presentational components, so live (client) and history (server) views share them.
import { Check, CornerDownRight, X } from "lucide-react";

import type { CallOutcome } from "@/db/postgres-dashboard-repository";
import { formatDuration, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";

import { Badge, type BadgeTone } from "./ui/badge";

const outcomeTones: Record<CallOutcome, BadgeTone> = {
  in_progress: "warning",
  booked: "accent",
  rescheduled: "accent",
  cancelled: "neutral",
  no_action: "neutral",
  failed: "danger",
};

export function OutcomeBadge({ outcome }: { outcome: CallOutcome }) {
  return (
    <Badge tone={outcomeTones[outcome]}>
      {outcome === "in_progress" ? "In progress" : humanize(outcome)}
    </Badge>
  );
}

export interface ToolActivityView {
  id: string;
  latencyMs: number;
  result: { code: string; message: string } | null;
  succeeded: boolean;
  toolName: string;
}

export function ToolActivityList({
  emptyText,
  tools,
}: {
  emptyText: string;
  tools: readonly ToolActivityView[];
}) {
  if (tools.length === 0)
    return (
      <p className="px-4 py-6 text-xs text-muted-foreground">{emptyText}</p>
    );
  return (
    <ol className="space-y-2 px-4 pt-4 pb-4">
      {tools.map((tool) => (
        <li className="enter" key={tool.id}>
          <ToolChip tool={tool} />
          {tool.result?.message ? (
            <p className="mt-1 pl-6 text-[12px] leading-relaxed text-muted-foreground">
              {tool.result.message}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function ToolChip({ tool }: { tool: ToolActivityView }) {
  const Icon = tool.succeeded ? Check : X;
  return (
    <div className="flex items-center gap-2">
      <CornerDownRight
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground/60"
      />
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-surface-muted px-2 py-1 font-mono text-[11px]">
        <span
          className={cn(
            "flex items-center gap-1",
            tool.succeeded ? "text-accent-foreground" : "text-danger",
          )}
        >
          <Icon aria-hidden="true" className="size-3" />
          {tool.toolName}
        </span>
        {tool.result ? (
          <span className="text-muted-foreground">→ {tool.result.code}</span>
        ) : null}
        <span className="text-muted-foreground/70 tabular-nums">
          {tool.latencyMs} ms
        </span>
      </span>
    </div>
  );
}

export interface TranscriptTurnView {
  key: string;
  offsetSeconds: number | null;
  speaker: "agent" | "caller";
  text: string;
}

export function TranscriptList({
  agentTalking = false,
  emptyText,
  listening = false,
  turns,
}: {
  agentTalking?: boolean;
  emptyText: string;
  listening?: boolean;
  turns: readonly TranscriptTurnView[];
}) {
  if (turns.length === 0 && !listening && !agentTalking)
    return (
      <p className="px-4 py-6 text-xs text-muted-foreground">{emptyText}</p>
    );
  return (
    <ol className="space-y-4 px-4 pt-5 pb-4">
      {turns.map((turn) => (
        <li key={turn.key}>
          <TranscriptMessage turn={turn} />
        </li>
      ))}
      {listening ? (
        <li
          aria-live="polite"
          className="flex items-center gap-2 pl-10 text-xs text-muted-foreground"
        >
          <span aria-hidden="true" className="flex gap-1">
            {[0, 150, 300].map((delay) => (
              <span
                className="listening-dot size-1 rounded-full bg-current"
                key={delay}
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </span>
          Listening
        </li>
      ) : agentTalking && turns.length === 0 ? (
        <li
          aria-live="polite"
          className="flex items-center gap-2 pl-10 text-xs text-accent"
        >
          Docto speaking...
        </li>
      ) : null}
    </ol>
  );
}

function TranscriptMessage({ turn }: { turn: TranscriptTurnView }) {
  const isAgent = turn.speaker === "agent";
  return (
    <div className="grid grid-cols-[28px_1fr] gap-3">
      <span
        aria-hidden="true"
        className={cn(
          "grid size-7 place-items-center rounded-full text-[10px] font-semibold",
          isAgent
            ? "bg-foreground text-background"
            : "bg-surface-muted text-muted-foreground ring-1 ring-border",
        )}
      >
        {isAgent ? "D" : "C"}
      </span>
      <div className="min-w-0">
        <p className="flex items-baseline gap-2 text-xs">
          <span className="font-medium">{isAgent ? "Docto" : "Caller"}</span>
          {turn.offsetSeconds !== null ? (
            <span className="font-mono text-[10px] text-muted-foreground">
              {formatDuration(turn.offsetSeconds)}
            </span>
          ) : null}
        </p>
        <p className="mt-1 max-w-[65ch] text-[13.5px] leading-relaxed text-pretty text-foreground/85">
          {turn.text}
        </p>
      </div>
    </div>
  );
}
