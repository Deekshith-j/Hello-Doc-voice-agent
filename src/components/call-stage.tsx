// Presents the active call and the controls a receptionist needs within reach.
// The dark voice stage is the page's single expressive element; everything else stays quiet.
import { Loader2, Mic, MicOff, PhoneCall, PhoneOff } from "lucide-react";

import { formatDuration } from "@/lib/format";

import { Button } from "./ui/button";

export type CallStatus = "idle" | "connecting" | "live" | "ended";

// Relative bar heights for the voice visualizer; durations are derived per bar.
const voiceLevels = [
  0.35, 0.55, 0.42, 0.78, 0.62, 0.9, 0.48, 1, 0.7, 0.52, 0.84, 0.6, 0.95, 0.44,
  0.72, 0.58, 0.88, 0.4, 0.66, 0.5, 0.3,
];

interface CallStageProps {
  agentTalking: boolean;
  canStart: boolean;
  elapsedSeconds: number;
  muted: boolean;
  onEnd: () => void;
  onStart: () => void;
  onToggleMute: () => void;
  patientName: string | null;
  status: CallStatus;
}

const statusLabels: Record<CallStatus, string> = {
  idle: "Ready",
  connecting: "Connecting",
  live: "Live",
  ended: "Ended",
};

export function CallStage({
  agentTalking,
  canStart,
  elapsedSeconds,
  muted,
  onEnd,
  onStart,
  onToggleMute,
  patientName,
  status,
}: CallStageProps) {
  const active = status === "live" || status === "connecting";
  const animating = status === "live" && agentTalking;
  return (
    <section
      aria-label="Current call"
      className="relative isolate overflow-hidden rounded-2xl bg-[oklch(0.18_0.018_172)] text-white shadow-[0_24px_48px_-24px_oklch(0.2_0.05_170/0.55)] ring-1 ring-white/[0.06]"
      data-voice={animating ? "live" : "idle"}
    >
      <StageBackdrop active={active} />
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 md:px-6">
        <div>
          <p className="flex items-center gap-2 font-mono text-[11px] tracking-wide text-white/60 uppercase">
            <span
              className={`size-1.5 rounded-full ${status === "live" ? "bg-[oklch(0.7_0.19_25)] shadow-[0_0_10px_oklch(0.7_0.19_25)]" : "bg-white/30"}`}
            />
            {statusLabels[status]}
            {status === "live" || status === "ended" ? (
              <>
                <span className="text-white/35">·</span>
                <time className="tabular-nums">
                  {formatDuration(elapsedSeconds)}
                </time>
              </>
            ) : null}
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-[-0.025em]">
            {patientName ??
              (active ? "Unverified caller" : "No call in progress")}
          </h2>
          <p className="mt-0.5 text-[13px] text-white/50">
            {active
              ? agentTalking
                ? "Docto is speaking"
                : "Listening to the caller"
              : "Start a browser call to talk to the agent"}
          </p>
        </div>
        {patientName ? (
          <span className="rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-1 text-[11px] font-medium text-white/75 backdrop-blur-md">
            Identity verified
          </span>
        ) : null}
      </div>

      <VoiceVisualizer active={status === "live"} muted={muted} />

      <div className="flex items-center justify-center gap-2.5 px-5 pb-5">
        <Button
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          aria-pressed={muted}
          disabled={status !== "live"}
          id="toggle-mute"
          onClick={onToggleMute}
          size="iconLarge"
          variant="glass"
        >
          {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
        </Button>
        {active ? (
          <Button id="end-call" onClick={onEnd} size="large" variant="danger">
            {status === "connecting" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <PhoneOff className="size-4" />
            )}
            {status === "connecting" ? "Cancel" : "End call"}
          </Button>
        ) : (
          <Button
            className="bg-white text-[oklch(0.2_0.02_170)] hover:bg-white/90"
            disabled={!canStart}
            id="start-call"
            onClick={onStart}
            size="large"
            variant="primary"
          >
            <PhoneCall className="size-4" />
            {status === "ended" ? "Start another call" : "Start web call"}
          </Button>
        )}
      </div>
    </section>
  );
}

function StageBackdrop({ active }: { active: boolean }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10"
    >
      <div
        className={`voice-orb absolute top-1/2 left-1/2 size-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl transition-opacity duration-500 ${active ? "opacity-60" : "opacity-20"}`}
        style={{
          background:
            "conic-gradient(from 90deg, oklch(0.62 0.13 168 / 0.55), oklch(0.5 0.1 200 / 0.15), oklch(0.7 0.14 150 / 0.45), oklch(0.62 0.13 168 / 0.55))",
        }}
      />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_120%,transparent_40%,oklch(0.14_0.015_172)_100%)]" />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent" />
    </div>
  );
}

function VoiceVisualizer({
  active,
  muted,
}: {
  active: boolean;
  muted: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className={`flex h-28 items-center justify-center gap-[5px] transition-opacity duration-300 ${active ? "" : "opacity-40"}`}
    >
      {voiceLevels.map((level, index) => (
        <span
          className="voice-bar w-[3px] rounded-full bg-gradient-to-b from-[oklch(0.9_0.08_165)] to-[oklch(0.7_0.13_168)]"
          key={index}
          style={{
            height: `${Math.round(level * 64)}px`,
            animationDelay: `${index * -83}ms`,
            animationDuration: `${700 + ((index * 137) % 500)}ms`,
            transform: muted || !active ? "scaleY(0.12)" : undefined,
          }}
        />
      ))}
    </div>
  );
}
