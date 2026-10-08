/**
 * Simulates calling each clinic voice tool route in sequence against http://localhost:3000
 * without needing Retell, live telephony, or paid APIs.
 *
 * Sequence:
 * 1. find_patient (Alex Morgan, 1988-04-12)
 * 2. check_availability (Family Medicine)
 * 3. book_appointment (slot 1)
 * 4. rebook same slot (expects rejection: slot_unavailable)
 * 5. reschedule_appointment (move to slot 2)
 * 6. cancel_appointment
 */

import { signRetellPayload } from "../src/integrations/retell/signature";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const RETELL_API_KEY = process.env.RETELL_API_KEY || null;

async function callTool(endpoint: string, payload: unknown, callId = "sim_call_001") {
  const url = `${BASE_URL}/api/tools/${endpoint}`;
  const body = JSON.stringify({
    args: payload,
    call: { call_id: callId },
  });

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (RETELL_API_KEY) {
    headers["x-retell-signature"] = signRetellPayload(body, RETELL_API_KEY, Date.now());
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
  });

  const status = response.status;
  const json = await response.json();
  return { status, json };
}

async function runSimulation() {
  console.log(`Starting tool simulation against ${BASE_URL}...\n`);

  // Step 1: Find Patient
  console.log("1. Finding patient 'Alex Morgan' (DOB: 1988-04-12)...");
  const findRes = await callTool("find-patient", {
    full_name: "Alex Morgan",
    date_of_birth: "1988-04-12",
  });
  console.log(`   Status: ${findRes.status}, Code: ${findRes.json.code}`);
  if (!findRes.json.ok) {
    console.error("   Failed to find patient:", findRes.json);
    process.exit(1);
  }
  const patientId = findRes.json.data.patient_id;
  console.log(`   Found Patient ID: ${patientId}\n`);

  // Step 2: Check Availability
  // Tuesday morning window in UTC
  const startWindow = "2027-01-12T14:00:00.000Z";
  const endWindow = "2027-01-12T17:00:00.000Z";
  console.log(`2. Checking availability for Family Medicine between ${startWindow} and ${endWindow}...`);
  const availRes = await callTool("check-availability", {
    specialty: "Family Medicine",
    start_at: startWindow,
    end_at: endWindow,
  });
  console.log(`   Status: ${availRes.status}, Code: ${availRes.json.code}`);
  const slots = availRes.json.data?.slots || [];
  console.log(`   Available slots: ${slots.length}`);
  if (slots.length < 2) {
    console.error("   Need at least 2 available slots to run simulation.");
    process.exit(1);
  }
  const slot1 = slots[0];
  const slot2 = slots[1];
  console.log(`   Slot 1: ${slot1.start_at} - ${slot1.end_at} (Dr: ${slot1.doctor_name})`);
  console.log(`   Slot 2: ${slot2.start_at} - ${slot2.end_at} (Dr: ${slot2.doctor_name})\n`);

  // Step 3: Book Appointment
  console.log(`3. Booking Slot 1 with Doctor ${slot1.doctor_id}...`);
  const bookRes = await callTool("book-appointment", {
    patient_id: patientId,
    doctor_id: slot1.doctor_id,
    start_at: slot1.start_at,
    end_at: slot1.end_at,
    reason: "Annual health checkup",
  }, "sim_call_001");
  console.log(`   Status: ${bookRes.status}, Code: ${bookRes.json.code}, Message: "${bookRes.json.message}"`);
  if (!bookRes.json.ok) {
    console.error("   Booking failed:", bookRes.json);
    process.exit(1);
  }
  const appointmentId = bookRes.json.data.appointment_id;
  console.log(`   Booked Appointment ID: ${appointmentId}\n`);

  // Step 4: Rebook the Same Slot (Different call attempt -> should be rejected with slot_unavailable)
  console.log("4. Attempting to rebook the SAME slot from a new call (expecting slot_unavailable)...");
  const rebookRes = await callTool("book-appointment", {
    patient_id: patientId,
    doctor_id: slot1.doctor_id,
    start_at: slot1.start_at,
    end_at: slot1.end_at,
    reason: "Conflicting checkup",
  }, "sim_call_002");
  console.log(`   Status: ${rebookRes.status}, Code: ${rebookRes.json.code}`);
  console.log(`   Message: "${rebookRes.json.message}"`);
  console.log(`   Has alternatives: ${Boolean(rebookRes.json.data?.alternatives?.length)}\n`);

  // Step 5: Reschedule Appointment to Slot 2
  console.log(`5. Rescheduling appointment to Slot 2 (${slot2.start_at})...`);
  const reschedRes = await callTool("reschedule-appointment", {
    patient_id: patientId,
    appointment_id: appointmentId,
    start_at: slot2.start_at,
    end_at: slot2.end_at,
  });
  console.log(`   Status: ${reschedRes.status}, Code: ${reschedRes.json.code}`);
  console.log(`   Message: "${reschedRes.json.message}"\n`);

  // Step 6: Cancel Appointment
  console.log(`6. Cancelling appointment ${appointmentId}...`);
  const cancelRes = await callTool("cancel-appointment", {
    patient_id: patientId,
    appointment_id: appointmentId,
  });
  console.log(`   Status: ${cancelRes.status}, Code: ${cancelRes.json.code}`);
  console.log(`   Message: "${cancelRes.json.message}"\n`);

  console.log("All tool simulation steps completed successfully!");
}

runSimulation().catch((err) => {
  console.error("Simulation error:", err);
  process.exit(1);
});
