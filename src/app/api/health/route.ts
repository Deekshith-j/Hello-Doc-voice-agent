// Reports whether the application can reach its PostgreSQL system of record.
// The response reveals no connection details and is safe for deployment probes.
import { getToolRuntime } from "@/server/tool-runtime";

export async function GET(): Promise<Response> {
  const startedAt = performance.now();
  try {
    await getToolRuntime().ping();
    return Response.json({ status: "healthy", database: "reachable" });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "health_check",
        outcome: "failed",
        error: error instanceof Error ? error.name : "unknown",
        latency_ms: Math.round(performance.now() - startedAt),
      }),
    );
    return Response.json(
      { status: "unhealthy", database: "unreachable" },
      { status: 503 },
    );
  }
}
