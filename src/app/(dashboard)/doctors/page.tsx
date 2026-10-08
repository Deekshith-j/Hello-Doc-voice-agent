// Displays active clinic providers, their weekly working schedules, and calendar sync integration status.
import {
  EmptyState,
  PageContainer,
  PageHeader,
} from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { formatDay, weekdayNames } from "@/lib/format";
import { getToolRuntime } from "@/server/tool-runtime";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Doctors · Docto",
  description:
    "Clinic providers, weekly availability rules, and calendar integration.",
};

export default async function DoctorsPage() {
  const dashboard = getToolRuntime().dashboard;
  const now = new Date();
  const doctors = await dashboard.listDoctorSchedules(now);

  return (
    <PageContainer>
      <PageHeader
        description="Configure provider specialties, weekly shift hours, and external calendar integrations."
        title="Providers & schedules"
      />

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {doctors.length === 0 ? (
          <div className="col-span-full">
            <Panel title="Providers">
              <EmptyState title="No active doctors found">
                Seed data or database records for doctors are empty. Run{" "}
                <code>npm run db:seed</code> to populate doctors.
              </EmptyState>
            </Panel>
          </div>
        ) : (
          doctors.map((doctor) => (
            <Panel
              action={
                <Badge tone={doctor.calendarConnected ? "accent" : "neutral"}>
                  {doctor.calendarConnected
                    ? "Calendar connected"
                    : "Local calendar only"}
                </Badge>
              }
              description={`${doctor.specialty} · ${doctor.timezone}`}
              key={doctor.id}
              title={doctor.fullName}
            >
              <div className="space-y-4 px-4 pt-4 pb-4 text-xs">
                <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-surface-muted p-2.5">
                  <div>
                    <span className="text-[11px] text-muted-foreground">
                      Booked next 7 days
                    </span>
                    <p className="mt-0.5 font-medium tabular-nums">
                      {doctor.bookedNextWeek} slots
                    </p>
                  </div>
                  <div>
                    <span className="text-[11px] text-muted-foreground">
                      Slot length
                    </span>
                    <p className="mt-0.5 font-medium tabular-nums">
                      {doctor.slotMinutes ?? 30} mins
                    </p>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-foreground">
                    Weekly availability
                  </h3>
                  {doctor.rules.length === 0 ? (
                    <p className="mt-1 text-muted-foreground">
                      No recurring weekly rules defined.
                    </p>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {doctor.rules.map((rule, idx) => (
                        <span
                          className="inline-flex items-center gap-1 rounded border border-border bg-surface px-2 py-1 font-mono text-[11px]"
                          key={idx}
                        >
                          <span className="font-medium text-foreground">
                            {weekdayNames[rule.dayOfWeek]}
                          </span>
                          <span className="text-muted-foreground">
                            {rule.startTime}–{rule.endTime}
                          </span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {doctor.timeOff.length > 0 ? (
                  <div>
                    <h3 className="font-semibold text-foreground">
                      Upcoming time off
                    </h3>
                    <ul className="mt-1 space-y-1">
                      {doctor.timeOff.map((off, idx) => (
                        <li
                          className="text-[11px] text-muted-foreground"
                          key={idx}
                        >
                          • {formatDay(off.startAt, doctor.timezone)} –{" "}
                          {formatDay(off.endAt, doctor.timezone)}
                          {off.reason ? ` (${off.reason})` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </Panel>
          ))
        )}
      </div>
    </PageContainer>
  );
}
