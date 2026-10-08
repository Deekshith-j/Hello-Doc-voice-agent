// Renders the live-call operations workspace at the application's primary route.
// Operators can initiate real web calls with the Retell agent and observe actions live.
import { LiveCall } from "@/components/live-call";
import { PageContainer, PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { getRetellConfig } from "@/config/environment";

export default function HomePage() {
  const voiceConnected = Boolean(getRetellConfig()?.agentId);

  return (
    <PageContainer>
      <PageHeader
        description="Follow the conversation in real-time and observe every tool execution."
        eyebrow={
          <Badge tone={voiceConnected ? "accent" : "warning"}>
            {voiceConnected ? "Voice active" : "Voice agent unconfigured"}
          </Badge>
        }
        title="Live call workspace"
      />
      <LiveCall voiceConnected={voiceConnected} />
    </PageContainer>
  );
}
