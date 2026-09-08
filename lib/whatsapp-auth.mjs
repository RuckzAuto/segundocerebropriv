import { initAuthCreds, BufferJSON, proto } from 'baileys';
import { db } from './db.mjs';

async function readData(fileKey) {
  const rs = await db.execute({
    sql: 'SELECT data FROM whatsapp_auth WHERE file_key = ?',
    args: [fileKey]
  });
  if (rs.rows.length === 0) return null;
  return JSON.parse(rs.rows[0].data, BufferJSON.reviver);
}

async function writeData(fileKey, data) {
  const json = JSON.stringify(data, BufferJSON.replacer);
  await db.execute({
    sql: 'INSERT INTO whatsapp_auth (file_key, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(file_key) DO UPDATE SET data=excluded.data, updated_at=CURRENT_TIMESTAMP',
    args: [fileKey, json]
  });
}

async function removeData(fileKey) {
  await db.execute({ sql: 'DELETE FROM whatsapp_auth WHERE file_key = ?', args: [fileKey] });
}

export async function useTursoAuthState() {
  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const fileKey = `${category}-${id}`;
              tasks.push(value ? writeData(fileKey, value) : removeData(fileKey));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => {
      return writeData('creds', creds);
    }
  };
}
