import { db } from './db.mjs';
import { processMessage } from './brain.mjs';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import https from 'https';

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_MESSAGE_LIMIT = 4096;

export async function telegramRequest(token, method, body = {}) {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram API error in ${method}: ${JSON.stringify(data)}`);
  }
  return data.result;
}

export async function sendMessage(token, chatId, text, extra = {}) {
  for (const chunk of splitMessage(text)) {
    try {
      await telegramRequest(token, "sendMessage", {
        chat_id: chatId,
        text: chunk,
        parse_mode: "Markdown",
        ...extra,
      });
    } catch {
      await telegramRequest(token, "sendMessage", {
        chat_id: chatId,
        text: chunk,
        ...extra,
      });
    }
  }
}

export async function sendChatAction(token, chatId, action = "typing") {
  try {
    await telegramRequest(token, "sendChatAction", { chat_id: chatId, action });
  } catch {}
}

function splitMessage(text) {
  if (!text) return ["..."];
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    let cut = remaining.lastIndexOf("\n", TELEGRAM_MESSAGE_LIMIT);
    if (cut < 1000) cut = remaining.lastIndexOf(" ", TELEGRAM_MESSAGE_LIMIT);
    if (cut < 1000) cut = TELEGRAM_MESSAGE_LIMIT;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const client = url.startsWith("https") ? https : http;
    client.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error("Download falhou: " + res.statusCode));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (err) => {
      fs.unlink(destPath, () => { });
      reject(err);
    });
  });
}

async function transcribeAudio(groqApiKey, token, fileId) {
  let filePath;
  try {
    const fileInfo = await telegramRequest(token, "getFile", { file_id: fileId });
    filePath = fileInfo.file_path;
  } catch (err) {
    throw new Error("Não consegui obter o arquivo de áudio do Telegram: " + err.message);
  }

  const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const ext = path.extname(filePath) || ".oga";
  const tmpPath = path.join(os.tmpdir(), `tg_audio_${Date.now()}${ext}`);

  try {
    await downloadFile(fileUrl, tmpPath);
  } catch (err) {
    throw new Error("Falha ao baixar áudio: " + err.message);
  }

  let transcript = "";
  try {
    const audioBuffer = fs.readFileSync(tmpPath);
    const extName = path.extname(tmpPath).replace(".", "") || "ogg";
    const mimeMap = { oga: "audio/ogg", ogg: "audio/ogg", mp3: "audio/mpeg", mp4: "audio/mp4", m4a: "audio/mp4", wav: "audio/wav", webm: "audio/webm" };
    const mimeType = mimeMap[extName] || "audio/ogg";
    const groqExt = extName === "oga" ? "ogg" : extName;
    const filename = "audio." + groqExt;

    const formData = new FormData();
    formData.append("file", new Blob([audioBuffer], { type: mimeType }), filename);
    formData.append("model", "whisper-large-v3-turbo");
    formData.append("language", "pt");
    formData.append("response_format", "json");

    const resp = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + groqApiKey,
      },
      body: formData,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("[WHISPER ERROR " + resp.status + "]:", errText);
      throw new Error("Groq Whisper error " + resp.status + ": " + errText);
    }

    const result = await resp.json();
    transcript = (result.text || "").trim();
    console.log("[WHISPER] Transcrição:", transcript);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { }
  }

  return transcript;
}

export async function handleUpdate(update, token) {
  const message = update.message;
  if (!message || !message.chat || !message.from) return;

  const chatId = message.chat.id;
  let text = message.text;
  let isAudio = false;

  if (message.voice || message.audio) {
    const fileId = message.voice ? message.voice.file_id : message.audio.file_id;
    await sendChatAction(token, chatId, "typing");
    try {
      text = await transcribeAudio(process.env.GROQ_API_KEY, token, fileId);
      isAudio = true;
    } catch (err) {
      console.error("Erro na transcricao:", err);
      await sendMessage(token, chatId, "Recebi seu áudio mas não consegui transcrever, pode mandar por texto?");
      return;
    }
    if (!text.trim()) {
      await sendMessage(token, chatId, "🎙️ Não consegui entender nada no áudio, pode tentar de novo ou mandar por texto?");
      return;
    }
  }

  const reply = async (msg) => sendMessage(token, chatId, isAudio ? `🎙️ _Ouvi:_ "${text}"\n\n${msg}` : msg);

  if (!text) return;

  if (text === '/start') {
    await reply("Bot ativo! Pronto para integrar com o Segundo Cérebro.");
    return;
  }

  if (text === '/reset') {
    let state = { chatHistories: {} };
    try {
      const stateRs = await db.execute({
        sql: 'SELECT data FROM agent_state WHERE id = ?',
        args: ['main_brain_state']
      });
      if (stateRs.rows.length > 0) {
        state = JSON.parse(stateRs.rows[0].data);
        if (!state.chatHistories) state.chatHistories = {};
      }
    } catch(e) {
      console.error("Erro ao ler state:", e);
    }
    
    if (state.chatHistories[String(chatId)]) {
      delete state.chatHistories[String(chatId)];
    }
    
    await db.execute({
      sql: 'INSERT INTO agent_state (id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=CURRENT_TIMESTAMP',
      args: ['main_brain_state', JSON.stringify(state)]
    });
    
    await reply("Histórico reiniciado! ✅");
    return;
  }

  await sendChatAction(token, chatId, "typing");

  try {
    const brainReply = await processMessage(text, chatId);
    await reply(brainReply);
  } catch (err) {
    console.error(err);
    await reply("Erro ao processar mensagem.");
  }
}
