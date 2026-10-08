// Starts an embedded PostgreSQL behind the real wire protocol, with every migration applied.
// Local development, the eval harness, and integration tests all share this one setup path.
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

import { createSqlClient } from "./client";
import { runMigrations } from "./migrations";

export interface EmbeddedDatabase {
  close(): Promise<void>;
  url: string;
}

export async function startEmbeddedDatabase(
  options: { dataDirectory?: string; port?: number } = {},
): Promise<EmbeddedDatabase> {
  const pglite = await PGlite.create(options.dataDirectory, {
    extensions: { btree_gist },
  });
  const server = new PGLiteSocketServer({
    db: pglite,
    port: options.port ?? 0,
    maxConnections: 8,
  });
  await server.start();
  const url = `postgresql://postgres@${server.getServerConn()}/postgres`;

  const sql = createSqlClient(url);
  try {
    await runMigrations(sql);
  } finally {
    await sql.end();
  }
  return {
    url,
    close: async () => {
      await server.stop();
      await pglite.close();
    },
  };
}
