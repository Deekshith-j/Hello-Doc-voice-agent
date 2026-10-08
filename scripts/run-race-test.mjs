// Runs tests/appointment-constraints.test.ts against real Postgres (TEST_DATABASE_URL).
// Prints ONLY the connection host name to ensure zero secret leakage.
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const envLocal = fs.readFileSync(".env.local", "utf8");
const match = envLocal.match(/^DIRECT_URL=(.+)$/m);
if (!match) {
  console.error("DIRECT_URL not found in .env.local");
  process.exit(1);
}

const testUrl = match[1].trim();
const host = new URL(testUrl).host;
console.log(`[TEST_DATABASE_URL host]: ${host}`);

const dbMatch = envLocal.match(/^DATABASE_URL=(.+)$/m);
const mainUrl = dbMatch ? dbMatch[1].trim() : process.env.DATABASE_URL;

const env = {
  ...process.env,
  DATABASE_URL: mainUrl,
  TEST_DATABASE_URL: testUrl,
};
const result = spawnSync("npx", ["vitest", "run", "tests/appointment-constraints.test.ts"], {
  env,
  encoding: "utf8",
  shell: true,
});

if (result.stdout) console.log(result.stdout);
if (result.stderr) console.error(result.stderr);

process.exit(result.status ?? 0);
