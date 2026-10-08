// Applies Next.js and TypeScript lint rules to every production and test file.
// Generated artifacts are excluded because they are owned by tools, not developers.
import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextCoreWebVitals,
  ...nextTypeScript,
  globalIgnores([".next/**", "coverage/**", "drizzle/**"]),
]);
