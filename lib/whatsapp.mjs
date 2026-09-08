import makeWASocket, { DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, downloadMediaMessage } from 'baileys';
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

// Numeros novos do WhatsApp podem chegar como "<id-opaco>@lid" (sistema de privacidade "Linked ID")
// em vez de "<numero>@s.whatsapp.net". Nesse caso precisa resolver o numero de telefone de verdade
// via o mapeamento interno do Baileys antes de comparar com o numero configurado.
async function resolveRemoteNumber(sock, jid) {
  if (!jid) return null;
  if (jid.endsWith('@lid')) {
    try {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
      return pn ? normalizeJid(pn) : null;
    } catch (err) {
      console.error('[WhatsApp] Erro ao resolver LID para número de telefone:', err.message);
      return null;
    }
  }
  return normalizeJid(jid);
}

const AUDIO_MIME_TO_EXT = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/webm': 'webm'
};

async function transcribeWhatsappAudio(sock, msg) {
  const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
    logger,
    reuploadRequest: sock.updateMediaMessage
  });

  const mimetype = msg.message.audioMessage?.mimetype || 'audio/ogg';
  const baseMime = mimetype.split(';')[0].trim();
  const ext = AUDIO_MIME_TO_EXT[baseMime] || 'ogg';

  const formData = new FormData();
  formData.append('file', new Blob([buffer], { type: baseMime }), `audio.${ext}`);
  formData.append('model', 'whisper-large-v3-turbo');
  formData.append('language', 'pt');
  formData.append('response_format', 'json');

  const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.GROQ_API_KEY },
    body: formData
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`[WhatsApp][WHISPER ERROR ${resp.status}]:`, errText);
    throw new Error('Groq Whisper error ' + resp.status);
  }

  const result = await resp.json();
  const transcript = (result.text || '').trim();
  console.log('[WhatsApp][WHISPER] Transcrição:', transcript);
  return transcript;
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

      const remoteNumber = await resolveRemoteNumber(sock, msg.key.remoteJid);
      if (remoteNumber !== allowedNumber) continue;

      let text = msg.message.conversation || msg.message.extendedTextMessage?.text;
      let isAudio = false;

      if (!text && msg.message.audioMessage) {
        try {
          text = await transcribeWhatsappAudio(sock, msg);
          isAudio = true;
        } catch (err) {
          console.error('[WhatsApp] Erro na transcrição:', err);
          await sock.sendMessage(msg.key.remoteJid, { text: 'Recebi seu áudio mas não consegui transcrever, pode mandar por texto?' });
          continue;
        }
        if (!text) {
          await sock.sendMessage(msg.key.remoteJid, { text: '🎙️ Não consegui entender nada no áudio, pode tentar de novo ou mandar por texto?' });
          continue;
        }
      }

      if (!text) continue;

      try {
        const reply = await processMessage(text, `whatsapp_${remoteNumber}`);
        const finalReply = isAudio ? `🎙️ _Ouvi:_ "${text}"\n\n${reply}` : reply;
        await sock.sendMessage(msg.key.remoteJid, { text: finalReply });
      } catch (err) {
        console.error('[WhatsApp] Erro ao processar mensagem:', err);
      }
    }
  });
}
