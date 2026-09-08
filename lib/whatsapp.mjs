import makeWASocket, { DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } from 'baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { useTursoAuthState } from './whatsapp-auth.mjs';
import { processMessage } from './brain.mjs';

const ALLOWED_NUMBER = process.env.WHATSAPP_ALLOWED_NUMBER;
const logger = pino({ level: 'silent' });

let latestQrDataUrl = null;
let connectionStatus = 'desligado';

export function getWhatsappStatus() {
  return { status: connectionStatus, qr: latestQrDataUrl };
}

function normalizeJid(jid) {
  return jid?.split('@')[0]?.split(':')[0];
}

export async function connectWhatsapp() {
  if (!ALLOWED_NUMBER) {
    console.log('[WhatsApp] WHATSAPP_ALLOWED_NUMBER não configurado no .env — integração desativada.');
    return;
  }

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
      console.log('[WhatsApp] Novo QR Code gerado. Acesse /whatsapp/qr no navegador para escanear.');
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

      const remoteNumber = normalizeJid(msg.key.remoteJid);
      if (remoteNumber !== ALLOWED_NUMBER) continue;

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
