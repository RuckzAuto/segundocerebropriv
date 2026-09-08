import { createClient } from '@libsql/client';

const url = process.env.TURSO_URL || 'file:local.db';
const authToken = process.env.TURSO_TOKEN || '';

export const db = createClient({ url, authToken });

export async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (parent_id) REFERENCES folders(id)
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      folder_id TEXT,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (folder_id) REFERENCES folders(id)
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS agent_state (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS whatsapp_auth (
      file_key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
  `);

  console.log('[DB] ✅ Tabelas verificadas/criadas com sucesso.');
}
