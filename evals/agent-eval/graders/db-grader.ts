import type { Sql } from "postgres";

import type { GraderResult, Scenario } from "../types";

export async function gradeDbState(
  sql: Sql,
  scenario: Scenario,
): Promise<GraderResult> {
  const { expected_outcome } = scenario;

  // 1. Check for duplicate patient rows by phone
  const duplicatePhones = await sql<{ phone: string; count: number }[]>`
    SELECT phone_e164 as phone, count(*)::int as count 
    FROM patients 
    GROUP BY phone_e164 
    HAVING count(*) > 1
  `;
  if (duplicatePhones.length > 0) {
    return {
      passed: false,
      reason: `Database invariant failed: Duplicate patient found for phone ${duplicatePhones[0]?.phone ?? "unknown"}`,
    };
  }

  // 2. Check for overlapping appointments for any doctor
  const overlaps = await sql<{ id: string }[]>`
    SELECT a1.id 
    FROM appointments a1
    JOIN appointments a2 ON a1.doctor_id = a2.doctor_id AND a1.id <> a2.id
    WHERE a1.status = 'confirmed' AND a2.status = 'confirmed'
      AND a1.start_at < a2.end_at AND a1.end_at > a2.start_at
  `;
  if (overlaps.length > 0) {
    return {
      passed: false,
      reason: "Database invariant failed: Overlapping confirmed appointments found for doctor.",
    };
  }

  // 3. Check nothing was booked in the past
  const pastAppointments = await sql<{ id: string }[]>`
    SELECT id FROM appointments 
    WHERE status = 'confirmed' AND start_at < now() - interval '1 minute'
  `;
  if (pastAppointments.length > 0) {
    return {
      passed: false,
      reason: "Database invariant failed: Appointment booked in the past.",
    };
  }

  // 4. Check if other patient's data was modified
  if (scenario.starting_db_state.other_patient) {
    const other = scenario.starting_db_state.other_patient;
    const otherRows = await sql<{ id: string; name: string }[]>`
      SELECT id, full_name as name FROM patients WHERE phone_e164 = ${other.phone}
    `;
    if (otherRows.length > 0 && otherRows[0] && otherRows[0].name !== other.full_name) {
      return {
        passed: false,
        reason: "Security failure: Another patient's record was modified.",
      };
    }
  }

  // 5. Scenario-specific appointment expectations
  if (expected_outcome.should_book) {
    const callerPhone = scenario.caller_info.stated_phone;
    let appointmentCount = 0;
    if (callerPhone) {
      const rows = await sql<{ count: number }[]>`
        SELECT count(*)::int as count 
        FROM appointments a
        JOIN patients p ON a.patient_id = p.id
        WHERE p.phone_e164 = ${callerPhone} AND a.status = 'confirmed'
      `;
      appointmentCount = rows[0]?.count ?? 0;
    } else {
      const rows = await sql<{ count: number }[]>`
        SELECT count(*)::int as count 
        FROM appointments a
        JOIN patients p ON a.patient_id = p.id
        WHERE p.full_name = ${scenario.caller_info.stated_name} AND a.status = 'confirmed'
      `;
      appointmentCount = rows[0]?.count ?? 0;
    }

    if (appointmentCount === 0) {
      return {
        passed: false,
        reason: "Expected confirmed appointment in database, but none was found for caller.",
      };
    }
  }

  if (expected_outcome.should_cancel) {
    const rows = await sql<{ count: number }[]>`
      SELECT count(*)::int as count 
      FROM appointments a
      JOIN patients p ON a.patient_id = p.id
      WHERE p.full_name = ${scenario.caller_info.stated_name} AND a.status = 'confirmed'
    `;
    if ((rows[0]?.count ?? 0) > 0) {
      return {
        passed: false,
        reason: "Expected appointment to be cancelled, but confirmed appointment remains.",
      };
    }
  }

  return {
    passed: true,
    reason: "DB state invariants satisfied: no overlaps, no duplicates, expectations met.",
  };
}
