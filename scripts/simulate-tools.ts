/**
 * Simulates calling clinic voice tool routes against the deployed or local endpoint
 * using signed Retell requests.
 *
 * Extended flow:
 * 1. Register fake patient (create-patient)
 * 2. Find registered patient (find-patient)
 * 3. Check availability (check-availability)
 * 4. Book appointment (book-appointment)
 * 5. Cancel appointment (cancel-appointment)
 * 6. Clean up fake database rows (appointments, patients)
 */

import process from "node:process";
process.loadEnvFile?.(".env.local");
import postgres from "postgres";

import { signRetellPayload } from "../src/integrations/retell/signature";

const BASE_URL =
  process.env.BASE_URL ||
  process.env.PUBLIC_BASE_URL ||
  "https://docto-agent.vercel.app";
const RETELL_API_KEY = process.env.RETELL_API_KEY || null;
const DATABASE_URL = process.env.DATABASE_URL || null;

interface ToolApiResponse {
  code?: string;
  data?: {
    alternatives?: Array<{ end_at: string; start_at: string }>;
    appointment_id?: string;
    patient_id?: string;
    slots?: Array<{
      doctor_id: string;
      doctor_name?: string;
      end_at: string;
      start_at: string;
    }>;
  };
  message?: string;
  ok?: boolean;
}

async function callTool(
  endpoint: string,
  payload: unknown,
  callId = "sim_call_001",
): Promise<{ json: ToolApiResponse; status: number }> {
  const url = `${BASE_URL}/api/tools/${endpoint}`;
  const body = JSON.stringify({
    args: payload,
    call: { call_id: callId },
  });

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (RETELL_API_KEY) {
    headers["x-retell-signature"] = signRetellPayload(
      body,
      RETELL_API_KEY,
      Date.now(),
    );
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
  });

  const status = response.status;
  const json = (await response.json()) as ToolApiResponse;
  return { status, json };
}

async function runSimulation() {
  console.log(`Starting tool simulation against ${BASE_URL}...\n`);

  let createdPatientId: string | null = null;
  let createdAppointmentId: string | null = null;
  // Deterministic fake phone number in fictional 555-01xx range
  const fakePhone = `+15555550198`;
  const fakeName = "Fake Simpatient";
  const fakeDob = "1995-04-18";

  try {
    // 1. Register fake patient
    console.log("=== STEP 1: register fake patient (create-patient) ===");
    const createRes = await callTool(
      "create-patient",
      {
        full_name: fakeName,
        date_of_birth: fakeDob,
        phone: fakePhone,
      },
      "sim_call_reg_01",
    );
    console.log(
      `Status: ${createRes.status}, Code: ${createRes.json.code}, Message: "${createRes.json.message}"`,
    );
    if (!createRes.json.ok) {
      console.error("Failed to create patient:", createRes.json);
      throw new Error(`create_patient failed with status ${createRes.status}`);
    }
    createdPatientId = createRes.json.data.patient_id;
    console.log(`Registered Patient ID: ${createdPatientId}\n`);

    // 2. Find that patient
    console.log("=== STEP 2: find registered patient (find-patient) ===");
    const findRes = await callTool(
      "find-patient",
      {
        full_name: fakeName,
        date_of_birth: fakeDob,
      },
      "sim_call_reg_01",
    );
    console.log(
      `Status: ${findRes.status}, Code: ${findRes.json.code}, Message: "${findRes.json.message}"`,
    );
    if (!findRes.json.ok) {
      console.error("Failed to find registered patient:", findRes.json);
      throw new Error(`find_patient failed with status ${findRes.status}`);
    }
    console.log(`Verified Patient ID: ${findRes.json.data.patient_id}\n`);

    // 3. Check availability
    console.log("=== STEP 3: check availability (check-availability) ===");
    // Window on next weekday (Tuesday Oct 13 14:00-17:00 UTC = 10:00-13:00 EDT)
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const startWindow = new Date(
      Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 14, 0, 0),
    ).toISOString();
    const endWindow = new Date(
      Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 17, 0, 0),
    ).toISOString();

    const availRes = await callTool("check-availability", {
      specialty: "Family Medicine",
      start_at: startWindow,
      end_at: endWindow,
    });
    console.log(
      `Status: ${availRes.status}, Code: ${availRes.json.code}, Slots found: ${availRes.json.data?.slots?.length ?? 0}`,
    );
    const slots = availRes.json.data?.slots || [];
    if (slots.length === 0) {
      throw new Error("No slots available for test booking");
    }
    const chosenSlot = slots[0];
    console.log(`Selected Slot: ${chosenSlot.start_at} - ${chosenSlot.end_at} (Dr ID: ${chosenSlot.doctor_id})\n`);

    // 4. Book appointment
    console.log("=== STEP 4: book appointment (book-appointment) ===");
    const bookRes = await callTool(
      "book-appointment",
      {
        patient_id: createdPatientId,
        doctor_id: chosenSlot.doctor_id,
        start_at: chosenSlot.start_at,
        end_at: chosenSlot.end_at,
        reason: "Routine synthetic checkup",
      },
      "sim_call_reg_01",
    );
    console.log(
      `Status: ${bookRes.status}, Code: ${bookRes.json.code}, Message: "${bookRes.json.message}"`,
    );
    if (!bookRes.json.ok) {
      console.error("Booking failed:", bookRes.json);
      throw new Error(`book_appointment failed with status ${bookRes.status}`);
    }
    createdAppointmentId = bookRes.json.data.appointment_id;
    console.log(`Booked Appointment ID: ${createdAppointmentId}\n`);

    // 5. Cancel appointment
    console.log("=== STEP 5: cancel appointment (cancel-appointment) ===");
    const cancelRes = await callTool(
      "cancel-appointment",
      {
        patient_id: createdPatientId,
        appointment_id: createdAppointmentId,
      },
      "sim_call_reg_01",
    );
    console.log(
      `Status: ${cancelRes.status}, Code: ${cancelRes.json.code}, Message: "${cancelRes.json.message}"\n`,
    );
    if (!cancelRes.json.ok) {
      console.error("Cancellation failed:", cancelRes.json);
      throw new Error(`cancel_appointment failed with status ${cancelRes.status}`);
    }
  } finally {
    // 6. Delete fake rows
    if (DATABASE_URL) {
      console.log("=== STEP 6: Clean up database ===");
      const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
      try {
        const leftoverIds = [createdPatientId, "55560800-9702-4b56-a6d8-78750f250182"].filter(Boolean) as string[];
        for (const pId of leftoverIds) {
          await sql`DELETE FROM appointments WHERE patient_id = ${pId}`;
          await sql`UPDATE calls SET patient_id = NULL WHERE patient_id = ${pId}`;
          await sql`DELETE FROM patients WHERE id = ${pId}`;
          console.log(`Cleaned up fake patient and related records: ${pId}`);
        }
        await sql`DELETE FROM calls WHERE retell_call_id = 'sim_call_reg_01'`;
      } catch (err) {
        console.warn("Error cleaning up fake rows:", err);
      } finally {
        await sql.end();
      }
    }
  }

  console.log("\nAll simulation steps completed!");
}

runSimulation().catch((err) => {
  console.error("Simulation failed:", err);
  process.exit(1);
});
