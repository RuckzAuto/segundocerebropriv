import makeWASocket, { DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } from 'baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { db } from './db.mjs';
import { useTursoAuthState } from './whatsapp-auth.mjs';
import { processMessage } from './brain.mjs';

const logger = pino({ level: 'silent' });

let latestQrDataUrl = null;
let connectionStatus = 'desligado';
let allowedNumber = null;

export function getWhatsappStatus() {
  return { status: connectionStatus, qr: latestQrDataUrl, allowedNumber };
}

export async function getAllowedNumber() {
  const rs = await db.execute({ sql: "SELECT value FROM app_settings WHERE key = 'whatsapp_allowed_number'", args: [] });
  return rs.rows.length > 0 ? rs.rows[0].value : null;
}

export async function setAllowedNumber(number) {
  await db.execute({
    sql: "INSERT INTO app_settings (key, value, updated_at) VALUES ('whatsapp_allowed_number', ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP",
    args: [number]
  });
  allowedNumber = number;
}

function normalizeJid(jid) {
  return jid?.split('@')[0]?.split(':')[0];
}

export async function connectWhatsapp() {
  allowedNumber = await getAllowedNumber();

  const { state, saveCreds } = await useTursoAuthState();
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    logger
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQrDataUrl = await QRCode.toDataURL(qr);
      connectionStatus = 'aguardando_qr';
      console.log('[WhatsApp] Novo QR Code gerado. Escaneie pelo painel WhatsApp no dashboard.');
    }

    if (connection === 'open') {
      connectionStatus = 'conectado';
      latestQrDataUrl = null;
      console.log('[WhatsApp] ✅ Conectado com sucesso.');
    }

    if (connection === 'close') {
      connectionStatus = 'desconectado';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('[WhatsApp] Conexão fechada.', shouldReconnect ? 'Reconectando...' : 'Sessão desconectada (logout) — escaneie um novo QR Code.');
      if (shouldReconnect) {
        connectWhatsapp();
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      if (!allowedNumber) continue;

      const remoteNumber = normalizeJid(msg.key.remoteJid);
      if (remoteNumber !== allowedNumber) continue;

      const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!text) continue;

      try {
        const reply = await processMessage(text, `whatsapp_${remoteNumber}`);
        await sock.sendMessage(msg.key.remoteJid, { text: reply });
      } catch (err) {
        console.error('[WhatsApp] Erro ao processar mensagem:', err);
      }
    }
  });
}
