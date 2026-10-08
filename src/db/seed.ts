// Seeds DATABASE_URL with synthetic clinic data from the command line.
// The seeding logic lives in seed-database.ts so local tooling can reuse it.
import { seedDatabase } from "./seed-database";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error("DATABASE_URL is required to seed the database.");

console.log(await seedDatabase(databaseUrl));
