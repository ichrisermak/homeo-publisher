/**
 * mirror.js — зеркало Telegram → Max для "Гомеопатия просто".
 *
 * Отдельный бот (TG_MIRROR_BOT_TOKEN) — админ канала TG_CHANNEL_ID.
 * Каждый запуск забирает новые посты канала (getUpdates) и публикует их в Max:
 * текст с форматированием, фото, альбомы, видео до 20 МБ.
 * Результат пишется на лист «Зеркало TG→Max» в таблице автопубликаций.
 */

const { google } = require("googleapis");
const { publishMax } = require("./max");

const env = (k) => (process.env[k] || "").trim();
const BOT = env("TG_MIRROR_BOT_TOKEN");
const CHANNEL = env("TG_CHANNEL_ID"); // @username или -100…
const SPREADSHEET_ID = env("SPREADSHEET_ID");
const LOG_SHEET = "Зеркало TG→Max";
const TG_FILE_LIMIT = 20 * 1024 * 1024; // Bot API отдаёт файлы до 20 МБ

// ─── Telegram ────────────────────────────────────────────────────────────────

async function tg(method, params = {}) {
  const res = await fetch(`https://api.telegram.org/bot${BOT}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`TG ${method}: ${data.description}`);
  return data.result;
}

async function downloadTgFile(fileId, kind, fallbackName) {
  const f = await tg("getFile", { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${BOT}/${f.file_path}`);
  if (!res.ok) throw new Error(`не удалось скачать файл из TG (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const name = (f.file_path || fallbackName).split("/").pop();
  const type = res.headers.get("content-type") || (kind === "video" ? "video/mp4" : "image/jpeg");
  return { buf, type, filename: name, kind };
}

function isOurChannel(chat) {
  if (!chat) return false;
  if (CHANNEL.startsWith("@")) return chat.username && `@${chat.username}`.toLowerCase() === CHANNEL.toLowerCase();
  return String(chat.id) === CHANNEL;
}

// ─── Форматирование: entities Telegram → HTML ───────────────────────────────

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function toHtml(text, entities = []) {
  if (!entities.length) return null;
  const tags = {
    bold: ["<b>", "</b>"], italic: ["<i>", "</i>"], underline: ["<u>", "</u>"],
    strikethrough: ["<s>", "</s>"], code: ["<code>", "</code>"], pre: ["<pre>", "</pre>"],
  };
  const opens = {}; const closes = {};
  for (const e of entities) {
    let pair = tags[e.type];
    if (e.type === "text_link") pair = [`<a href="${esc(e.url)}">`, "</a>"];
    if (!pair) continue;
    (opens[e.offset] ||= []).push({ tag: pair[0], len: e.length });
    (closes[e.offset + e.length] ||= []).unshift(pair[1]);
  }
  let out = "";
  for (let i = 0; i <= text.length; i++) {
    if (closes[i]) out += closes[i].join("");
    if (opens[i]) out += opens[i].sort((a, b) => b.len - a.len).map((o) => o.tag).join("");
    if (i < text.length) out += esc(text[i]);
  }
  return out;
}

// ─── Лог в таблицу ───────────────────────────────────────────────────────────

let sheets = null;
async function logRow(values) {
  try {
    if (!sheets) {
      const auth = new google.auth.GoogleAuth({
        credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });
      sheets = google.sheets({ version: "v4", auth });
    }
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${LOG_SHEET}!A:D`,
      valueInputOption: "RAW",
      requestBody: { values: [values] },
    });
  } catch (e) {
    console.log(`[лог] не записан: ${e.message}`);
  }
}

const moscowNow = () =>
  new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 16).replace("T", " ");

// ─── Основная логика ─────────────────────────────────────────────────────────

async function main() {
  if (!BOT) { console.log("[Зеркало] TG_MIRROR_BOT_TOKEN не задан — пропускаю"); return; }

  const updates = await tg("getUpdates", { timeout: 0, limit: 100, allowed_updates: ["channel_post"] });
  if (!updates.length) { console.log("[Зеркало] новых постов нет"); return; }

  const posts = updates.map((u) => u.channel_post).filter((p) => p && isOurChannel(p.chat));
  console.log(`[Зеркало] обновлений: ${updates.length}, постов канала: ${posts.length}`);

  // Альбом приходит несколькими сообщениями с общим media_group_id — собираем в один пост
  const groups = [];
  const byAlbum = new Map();
  for (const p of posts.sort((a, b) => a.message_id - b.message_id)) {
    if (p.media_group_id) {
      if (!byAlbum.has(p.media_group_id)) { const g = []; byAlbum.set(p.media_group_id, g); groups.push(g); }
      byAlbum.get(p.media_group_id).push(p);
    } else groups.push([p]);
  }

  for (const group of groups) {
    const first = group[0];
    const withText = group.find((p) => p.text || p.caption) || first;
    const text = withText.text || withText.caption || "";
    const html = toHtml(text, withText.entities || withText.caption_entities);
    const link = first.chat.username ? `https://t.me/${first.chat.username}/${first.message_id}` : `id ${first.message_id}`;

    const medias = [];
    const skipped = [];
    try {
      for (const p of group) {
        if (p.photo) {
          const big = p.photo[p.photo.length - 1];
          medias.push(await downloadTgFile(big.file_id, "image", "photo.jpg"));
        } else if (p.video) {
          if (p.video.file_size > TG_FILE_LIMIT) skipped.push("видео > 20 МБ");
          else medias.push(await downloadTgFile(p.video.file_id, "video", "video.mp4"));
        } else if (p.video_note) skipped.push("кружочек");
        else if (p.voice || p.audio) skipped.push("аудио");
        else if (p.document) skipped.push("файл");
        else if (p.poll) skipped.push("опрос");
      }

      if (!text && !medias.length) {
        console.log(`[Зеркало] ${link}: нечего переносить (${skipped.join(", ") || "служебное"})`);
        await logRow([moscowNow(), link, "", `⏭ пропущено: ${skipped.join(", ") || "служебное"}`]);
        continue;
      }

      await publishMax(text, medias, { html });
      const note = skipped.length ? ` (не перенесено: ${skipped.join(", ")})` : "";
      console.log(`[Зеркало] ✅ ${link}${note}`);
      await logRow([moscowNow(), link, text.slice(0, 80), `✅${note}`]);
    } catch (e) {
      console.log(`[Зеркало] ❌ ${link}: ${e.message}`);
      await logRow([moscowNow(), link, text.slice(0, 80), `❌ ${String(e.message).slice(0, 200)}`]);
    }
  }

  // Подтверждаем получение, чтобы Telegram не прислал эти посты снова
  await tg("getUpdates", { offset: updates[updates.length - 1].update_id + 1, timeout: 0, limit: 1 });
}

main().catch((e) => {
  console.error("[Зеркало] критическая ошибка:", e.message);
  process.exit(1);
});
