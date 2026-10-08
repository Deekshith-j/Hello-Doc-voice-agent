// Runs a persistent embedded PostgreSQL for local development, migrated and seeded on start.
// It speaks the real wire protocol, so the app connects with the same client as production.
import { mkdir } from "node:fs/promises";

import { startEmbeddedDatabase } from "./embedded-database";
import { seedDatabase } from "./seed-database";

const DATA_DIRECTORY = ".pglite";

await mkdir(DATA_DIRECTORY, { recursive: true });
const database = await startEmbeddedDatabase({
  dataDirectory: DATA_DIRECTORY,
  port: Number(process.env.LOCAL_DATABASE_PORT ?? 54329),
});
console.log(await seedDatabase(database.url));
console.log(
  `\nLocal PostgreSQL is ready. Put this in .env.local:\n\nDATABASE_URL=${database.url}\n`,
);
console.log("Press Ctrl+C to stop. Data persists in .pglite/.");

async function shutdown(): Promise<void> {
  await database.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
