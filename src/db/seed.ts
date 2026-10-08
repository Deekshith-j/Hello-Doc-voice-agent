// Seeds synthetic clinic data from the command line.
// Requires explicit --target=main or --target=test to prevent accidental writes.
import { seedDatabase } from "./seed-database";

const targetArg = process.argv.find((arg) => arg.startsWith("--target="));
const target = targetArg ? targetArg.slice("--target=".length).trim() : null;

if (target !== "main" && target !== "test") {
  console.error(
    "Error: db:seed requires an explicit target. Use --target=main or --target=test.",
  );
  process.exit(1);
}

const databaseUrl =
  target === "main"
    ? (process.env.DIRECT_URL ?? process.env.DATABASE_URL)
    : process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    `Target '${target}' requires ${target === "main" ? "DIRECT_URL or DATABASE_URL" : "TEST_DATABASE_URL"} to be configured.`,
  );
}

const targetHost = new URL(databaseUrl).host;
console.log(`[db:seed] Target host: ${targetHost}`);

console.log(await seedDatabase(databaseUrl));
