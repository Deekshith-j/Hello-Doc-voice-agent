// Runs a real browser web call with the Retell agent and shows what the agent does as it happens.
// The server creates the call and hands back a one-time access token; the API key never reaches here.
"use client";

import type { RetellWebClient } from "retell-client-js-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import type { CallOutcome } from "@/db/postgres-dashboard-repository";

import {
  OutcomeBadge,
  ToolActivityList,
  type ToolActivityView,
  TranscriptList,
  type TranscriptTurnView,
} from "./call-parts";
import { CallStage, type CallStatus } from "./call-stage";
import { Panel } from "./ui/panel";

const POLL_INTERVAL_MS = 2_500;

interface LiveActivity {
  outcome: CallOutcome;
  patientName: string | null;
  tools: ToolActivityView[];
}

const errorMessages: Record<string, string> = {
  retell_not_configured:
    "The voice agent isn't configured. Add RETELL_API_KEY and RETELL_AGENT_ID.",
  rate_limited:
    "Too many calls were started just now. Wait a minute and retry.",
  retell_unavailable: "Retell didn't accept the call. Try again shortly.",
  unauthorized: "Your session expired. Sign in again to start a call.",
};

export function LiveCall({ voiceConnected }: { voiceConnected: boolean }) {
  const clientRef = useRef<RetellWebClient | null>(null);
  const [status, setStatus] = useState<CallStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [turns, setTurns] = useState<TranscriptTurnView[]>([]);
  const [activity, setActivity] = useState<LiveActivity | null>(null);
  const [agentTalking, setAgentTalking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The timer only ticks while a call is live; the display derives elapsed time from startedAt.
  useEffect(() => {
    if (status !== "live") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [status]);

  // Tool activity is recorded server-side by the tool routes; poll it while the call runs,
  // and once more after it ends so the final booking result is visible.
  useEffect(() => {
    if (!callId || (status !== "live" && status !== "ended")) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(
          `/api/calls/${encodeURIComponent(callId)}/activity`,
          { cache: "no-store" },
        );
        if (!response.ok) return;
        const body = (await response.json()) as {
          activity: LiveActivity | null;
        };
        if (!cancelled && body.activity) setActivity(body.activity);
      } catch {
        // A missed poll is harmless; the next one catches up.
      }
    };
    void load();
    if (status === "ended") return () => void (cancelled = true);
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [callId, status]);

  // Leaving the page must hang up, or the microphone stays open in the background.
  useEffect(() => () => clientRef.current?.stopCall(), []);

  const isStartingRef = useRef(false);

  const start = useCallback(async () => {
    if (isStartingRef.current || status === "connecting" || status === "live") {
      return;
    }
    isStartingRef.current = true;
    setError(null);
    setTurns([]);
    setActivity(null);
    setMuted(false);
    setAgentTalking(false);
    setStatus("connecting");
    try {
      const response = await fetch("/api/retell/web-call", { method: "POST" });
      const body = (await response.json()) as {
        access_token?: string;
        call_id?: string;
        code?: string;
        created_at?: number;
        ice_servers?: RTCIceServer[];
        message?: string;
        ok: boolean;
        transport?: "gateway" | "livekit";
      };
      if (!body.ok || !body.access_token || !body.call_id) {
        setError(
          body.message ??
            errorMessages[body.code ?? ""] ??
            "The call couldn't be started.",
        );
        setStatus("idle");
        return;
      }

      const tokenReceivedAt = performance.now();

      const { RetellWebClient } = await import("retell-client-js-sdk");
      const client = new RetellWebClient();
      clientRef.current = client;
      client.on("call_started", () => {
        setStartedAt(Date.now());
        setNow(Date.now());
        setStatus("live");
      });
      client.on("call_ended", () => {
        clientRef.current = null;
        setAgentTalking(false);
        setStatus("ended");
      });
      client.on("agent_start_talking", () => setAgentTalking(true));
      client.on("agent_stop_talking", () => setAgentTalking(false));
      client.on(
        "update",
        (update: { transcript?: { content: string; role: string }[] }) => {
          if (update.transcript) setTurns(toTurns(update.transcript));
        },
      );
      client.on("error", (err: unknown) => {
        console.error("[RetellWebClient error]", {
          callId: body.call_id,
          error: err,
        });
        let detail = "Connection interrupted";
        if (typeof err === "string") {
          detail = err;
        } else if (err instanceof Error) {
          detail = err.message;
        } else if (typeof err === "object" && err !== null) {
          if (
            "message" in err &&
            typeof (err as { message: unknown }).message === "string"
          ) {
            detail = (err as { message: string }).message;
          } else if (
            "error" in err &&
            typeof (err as { error: unknown }).error === "string"
          ) {
            detail = (err as { error: string }).error;
          } else {
            try {
              detail = JSON.stringify(err);
            } catch {
              detail = String(err);
            }
          }
        }
        setError(`Call interrupted: ${detail}. Check your connection and retry.`);
        client.stopCall();
      });

      setCallId(body.call_id);

      const timeBeforeStartCallMs = Math.round(
        performance.now() - tokenReceivedAt,
      );
      const timeSinceCreationMs = body.created_at
        ? Date.now() - body.created_at
        : null;
      console.info("[WebCall start timing]", {
        callId: body.call_id,
        transport: body.transport,
        timeBetweenTokenReceiptAndStartCallMs: timeBeforeStartCallMs,
        timeSinceServerTokenCreationMs: timeSinceCreationMs,
      });

      await client.startCall({
        accessToken: body.access_token,
        callId: body.call_id,
        transport: body.transport ?? "gateway",
        ...(body.ice_servers ? { iceServers: body.ice_servers } : {}),
      });
    } catch (caught) {
      console.error("[startCall exception]", {
        error: caught,
      });
      clientRef.current?.stopCall();
      clientRef.current = null;
      setError(
        caught instanceof DOMException && caught.name === "NotAllowedError"
          ? "Microphone access was blocked. Allow it in the browser and retry."
          : caught instanceof Error
            ? `Failed to start call: ${caught.message}`
            : "The call couldn't be started.",
      );
      setStatus("idle");
    } finally {
      isStartingRef.current = false;
    }
  }, [status]);

  const end = useCallback(() => {
    const client = clientRef.current;
    if (client) client.stopCall();
    else setStatus("idle");
  }, []);

  const toggleMute = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;
    setMuted((current) => {
      if (current) client.unmute();
      else client.mute();
      return !current;
    });
  }, []);

  const elapsedSeconds = startedAt ? (now - startedAt) / 1_000 : 0;

  return (
    <div className="mt-6 grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0">
        <CallStage
          agentTalking={agentTalking}
          canStart={voiceConnected}
          elapsedSeconds={elapsedSeconds}
          muted={muted}
          onEnd={end}
          onStart={() => void start()}
          onToggleMute={toggleMute}
          patientName={activity?.patientName ?? null}
          status={status}
        />
        {error ? (
          <p
            className="mt-3 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        <Panel
          className="mt-4"
          description="Speaker-separated, updated as the call happens"
          title="Transcript"
        >
          <TranscriptList
            emptyText={
              voiceConnected
                ? "Start a web call and speak to the agent. The conversation appears here."
                : "Set up the Retell agent to place calls from this page."
            }
            listening={status === "live" && !agentTalking}
            turns={turns}
          />
        </Panel>
      </div>
      <Panel
        action={activity ? <OutcomeBadge outcome={activity.outcome} /> : null}
        description="Every tool the agent ran, in order"
        title="Agent actions"
      >
        <ToolActivityList
          emptyText="No actions yet. Lookups, availability checks, and bookings show up here."
          tools={activity?.tools ?? []}
        />
      </Panel>
    </div>
  );
}

function toTurns(
  transcript: readonly { content: string; role: string }[],
): TranscriptTurnView[] {
  return transcript
    .filter((turn) => turn.role === "agent" || turn.role === "user")
    .map((turn, index) => ({
      key: String(index),
      offsetSeconds: null,
      speaker: turn.role === "agent" ? "agent" : "caller",
      text: turn.content,
    }));
}
