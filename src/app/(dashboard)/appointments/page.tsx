// Displays scheduled clinic appointments across all providers.
// Shows patient, doctor, appointment status, and calendar sync status.
import {
  EmptyState,
  PageContainer,
  PageHeader,
} from "@/components/page-header";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { getClinicSettings } from "@/config/environment";
import { formatDateTime, formatTime, humanize } from "@/lib/format";
import { getToolRuntime } from "@/server/tool-runtime";

export const metadata = {
  title: "Appointments · Docto",
  description: "Upcoming clinic bookings and external calendar sync status.",
};

const statusTones: Record<string, BadgeTone> = {
  booked: "accent",
  cancelled: "danger",
  completed: "neutral",
  no_show: "warning",
};

const syncTones: Record<string, BadgeTone> = {
  synced: "accent",
  pending: "warning",
  failed: "danger",
  not_configured: "neutral",
};

export default async function AppointmentsPage() {
  const { timeZone } = getClinicSettings();
  const dashboard = getToolRuntime().dashboard;

  const now = new Date();
  const rangeStart = new Date(now.getTime() - 24 * 60 * 60 * 1000); // from yesterday
  const rangeEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // 14 days ahead

  const appointments = await dashboard.listAgenda(rangeStart, rangeEnd);

  return (
    <PageContainer>
      <PageHeader
        description="Bookings managed by the voice agent and synced to provider schedules."
        title="Appointment agenda"
      />

      <div className="mt-6">
        <Panel
          description={`Appointments scheduled over the next 14 days (${appointments.length} total)`}
          title="Scheduled appointments"
        >
          {appointments.length === 0 ? (
            <EmptyState title="No appointments scheduled">
              When the voice agent books appointments for patients, they will be
              listed here.
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border bg-surface-muted text-[11px] font-medium text-muted-foreground">
                    <th className="px-4 py-2.5">Date & Time</th>
                    <th className="px-4 py-2.5">Patient</th>
                    <th className="px-4 py-2.5">Doctor</th>
                    <th className="px-4 py-2.5">Reason</th>
                    <th className="px-4 py-2.5">Status</th>
                    <th className="px-4 py-2.5">Calendar Sync</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {appointments.map((appt) => (
                    <tr
                      className="transition-colors hover:bg-surface-muted/50"
                      key={appt.id}
                    >
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="font-medium">
                          {formatDateTime(appt.startAt, timeZone)}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          until {formatTime(appt.endAt, timeZone)}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-medium whitespace-nowrap">
                        {appt.patientName}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="font-medium">{appt.doctorName}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {appt.doctorTimezone}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {appt.reason}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <Badge tone={statusTones[appt.status] ?? "neutral"}>
                          {humanize(appt.status)}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <Badge
                          tone={syncTones[appt.calendarSyncStatus] ?? "neutral"}
                        >
                          {humanize(appt.calendarSyncStatus)}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </PageContainer>
  );
}
