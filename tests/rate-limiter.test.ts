// Verifies the fixed-window limit against the real Postgres counter and pruning SQL.
// Explicit clocks pin each request to a known window regardless of wall time.
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { PostgresClinicRepository } from "@/db/postgres-clinic-repository";
import { consumeRateLimit } from "@/server/rate-limiter";

import { startTestDatabase, type TestDatabase } from "./support/test-database";

const WINDOW_START = new Date("2027-01-11T12:00:00.000Z");
const MID_WINDOW = new Date("2027-01-11T12:00:45.000Z");
const NEXT_WINDOW = new Date("2027-01-11T12:01:05.000Z");

let database: TestDatabase;
let repository: PostgresClinicRepository;

beforeAll(async () => {
  database = await startTestDatabase();
  repository = new PostgresClinicRepository(database.sql);
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
});

it("allows thirty requests per window and reports when to retry", async () => {
  for (let request = 1; request <= 30; request += 1) {
    const result = await consumeRateLimit(repository, "tool:ip", WINDOW_START);
    expect(result.allowed).toBe(true);
  }
  const blocked = await consumeRateLimit(repository, "tool:ip", MID_WINDOW);
  expect(blocked).toEqual({
    allowed: false,
    remaining: 0,
    retryAfterSeconds: 15,
  });
});

it("counts each caller and tool separately", async () => {
  await consumeRateLimit(repository, "tool:first", WINDOW_START);
  const other = await consumeRateLimit(repository, "tool:second", WINDOW_START);
  expect(other.remaining).toBe(29);
});

it("starts a fresh window and prunes the expired counter", async () => {
  await consumeRateLimit(repository, "tool:ip", WINDOW_START);
  const next = await consumeRateLimit(repository, "tool:ip", NEXT_WINDOW);
  expect(next.remaining).toBe(29);

  const rows = await database.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM rate_limit_buckets WHERE key = 'tool:ip'
  `;
  expect(rows[0]?.count).toBe(1);
});
