/**
 * publisher.js — Автопубликатор для "Гомеопатия просто"
 * Читает Google Sheets, публикует в TG / VK / Max / Threads.
 *
 * Запускается через GitHub Actions по cron каждые 5 минут.
 * Публикует строки, у которых:
 *   - Дата + Время <= сейчас (по МСК)
 *   - Статус = "⏳"
 * После публикации ставит "✅" или "❌ <ошибка>".
 *
 * Медиа: ссылка на файл в Google Drive (доступ "всем, у кого есть ссылка")
 * или любая прямая ссылка на картинку.
 */

const { google } = require("googleapis");

// ─── Конфигурация ────────────────────────────────────────────────────────────

const env = (k) => (process.env[k] || "").trim();

const SPREADSHEET_ID = env("SPREADSHEET_ID");
const SHEET_NAME = env("SHEET_NAME") || "10-11.2026";

const TG_BOT_TOKEN = env("TG_BOT_TOKEN");
const TG_CHANNEL_ID = env("TG_CHANNEL_ID");

const VK_TOKEN = env("VK_TOKEN"); // ключ пользователя-админа группы (права wall, photos, offline)
const VK_OWNER_ID = env("VK_OWNER_ID"); // ID сообщества со знаком минус, напр. -123456

const MAX_TOKEN = env("MAX_TOKEN");
const MAX_CHANNEL_ID = env("MAX_CHANNEL_ID");
const MAX_API = "https://platform-api2.max.ru";

const THREADS = {
  anna: { token: env("THREADS_TOKEN_ANNA"), userId: env("THREADS_USER_ID_ANNA"), name: "@doc.startseva.anna" },
  prosto: { token: env("THREADS_TOKEN_PROSTO"), userId: env("THREADS_USER_ID_PROSTO"), name: "@homeopathy_prosto" },
};

// ─── Колонки таблицы (0-based) ───────────────────────────────────────────────
const COL = {
  NUM: 0, DATE: 1, TIME: 2, TEXT: 3, TEXT_THREADS: 4, MEDIA: 5,
  TG: 6, VK: 7, MAX: 8, THREADS: 9, INSTA: 10, STATUS: 11,
};
const FIRST_ROW = 4; // строки 1-3 — заголовки и пример

// ─── Утилиты ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yes = (v) => ["да", "yes", "+", "1", "true"].includes(String(v || "").trim().toLowerCase());

/** "дд.мм.гггг" + "чч:мм" по МСК → Date (UTC) */
function parseMoscowDateTime(dateStr, timeStr) {
  const d = dateStr.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  const t = timeStr.match(/^(\d{1,2}):(\d{2})/);
  if (!d || !t) return null;
  const [, day, month, year] = d.map(Number);
  const [, hours, minutes] = t.map(Number);
  return new Date(Date.UTC(year, month - 1, day, hours - 3, minutes));
}

/** Ссылка Google Drive → прямая ссылка на скачивание */
function toDirectUrl(url) {
  if (!url) return null;
  const m =
    url.match(/drive\.google\.com\/file\/d\/([^/?#]+)/) ||
    url.match(/drive\.google\.com\/open\?id=([^&#]+)/) ||
    url.match(/drive\.google\.com\/uc\?.*id=([^&#]+)/);
  return m ? `https://drive.google.com/uc?export=download&id=${m[1]}` : url;
}

/** Скачивает картинку один раз, чтобы отправить её на все площадки */
async function downloadMedia(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`не удалось скачать медиа (${res.status})`);
  const type = res.headers.get("content-type") || "";
  if (!type.startsWith("image/")) {
    throw new Error("медиа не картинка или файл в Drive закрыт — откройте доступ «всем, у кого есть ссылка»");
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (type.split("/")[1] || "jpg").split(";")[0];
  return { buf, type, filename: `image.${ext}` };
}

const shortErr = (e) => String(e && e.message ? e.message : e).slice(0, 200);

// ─── Telegram ────────────────────────────────────────────────────────────────

async function tgCall(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/${method}`, {
    method: "POST",
    body,
    headers: body instanceof FormData ? undefined : { "Content-Type": "application/json" },
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description);
  return data.result;
}

async function publishTelegram(text, media) {
  if (!TG_BOT_TOKEN || !TG_CHANNEL_ID) throw new Error("нет TG_BOT_TOKEN / TG_CHANNEL_ID");

  const sendText = async (t) => {
    try {
      return await tgCall("sendMessage", JSON.stringify({ chat_id: TG_CHANNEL_ID, text: t, parse_mode: "HTML" }));
    } catch (e) {
      // Если в тексте есть символы < > &, которые ломают HTML — отправляем как обычный текст
      if (/parse entities/i.test(e.message)) {
        return tgCall("sendMessage", JSON.stringify({ chat_id: TG_CHANNEL_ID, text: t }));
      }
      throw e;
    }
  };

  if (!media) return sendText(text);

  // Подпись к фото — максимум 1024 символа. Длинный текст отправляем вторым сообщением.
  const fits = text.length <= 1024;
  const form = new FormData();
  form.append("chat_id", TG_CHANNEL_ID);
  form.append("photo", new Blob([media.buf], { type: media.type }), media.filename);
  if (fits) form.append("caption", text);
  await tgCall("sendPhoto", form);
  if (!fits) await sendText(text);
}

// ─── VK ──────────────────────────────────────────────────────────────────────

async function vkCall(method, params) {
  const body = new URLSearchParams({ ...params, access_token: VK_TOKEN, v: "5.199" });
  const res = await fetch(`https://api.vk.com/method/${method}`, { method: "POST", body });
  const data = await res.json();
  if (data.error) throw new Error(`${method}: ${data.error.error_msg}`);
  return data.response;
}

async function publishVK(text, media) {
  if (!VK_TOKEN || !VK_OWNER_ID) throw new Error("нет VK_TOKEN / VK_OWNER_ID");
  const groupId = String(VK_OWNER_ID).replace("-", "");
  let attachments = "";

  if (media) {
    const server = await vkCall("photos.getWallUploadServer", { group_id: groupId });
    const form = new FormData();
    form.append("photo", new Blob([media.buf], { type: media.type }), media.filename);
    const up = await (await fetch(server.upload_url, { method: "POST", body: form })).json();
    if (!up.photo || up.photo === "[]") throw new Error("VK не принял картинку");
    const saved = await vkCall("photos.saveWallPhoto", {
      group_id: groupId, photo: up.photo, server: up.server, hash: up.hash,
    });
    attachments = `photo${saved[0].owner_id}_${saved[0].id}`;
  }

  await vkCall("wall.post", {
    owner_id: `-${groupId}`, from_group: 1, message: text, ...(attachments && { attachments }),
  });
}

// ─── Max ─────────────────────────────────────────────────────────────────────

async function maxCall(path, options = {}) {
  const res = await fetch(`${MAX_API}${path}`, {
    ...options,
    headers: { Authorization: MAX_TOKEN, ...(options.headers || {}) },
  });
  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = { raw }; }
  if (!res.ok) throw new Error(`${res.status} ${data.message || data.code || raw.slice(0, 120)}`);
  return data;
}

async function publishMax(text, media) {
  if (!MAX_TOKEN || !MAX_CHANNEL_ID) throw new Error("нет MAX_TOKEN / MAX_CHANNEL_ID");
  const attachments = [];

  if (media) {
    // 1) получаем адрес для загрузки, 2) загружаем файл, 3) прикладываем полученный токен
    const { url } = await maxCall("/uploads?type=image", { method: "POST" });
    const form = new FormData();
    form.append("data", new Blob([media.buf], { type: media.type }), media.filename);
    const upRes = await fetch(url, { method: "POST", body: form, headers: { Authorization: MAX_TOKEN } });
    const payload = await upRes.json();
    if (!upRes.ok) throw new Error(`загрузка картинки: ${JSON.stringify(payload).slice(0, 120)}`);
    attachments.push({ type: "image", payload });
  }

  // Лимит Max — 4000 символов на сообщение
  const first = text.slice(0, 4000);
  const body = { text: first, ...(attachments.length && { attachments }) };

  // Картинка может обрабатываться пару секунд — повторяем при attachment.not.ready
  for (let attempt = 1; ; attempt++) {
    try {
      await maxCall(`/messages?chat_id=${MAX_CHANNEL_ID}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      break;
    } catch (e) {
      if (/not\.ready/i.test(e.message) && attempt < 5) { await sleep(2000 * attempt); continue; }
      throw e;
    }
  }

  if (text.length > 4000) {
    await maxCall(`/messages?chat_id=${MAX_CHANNEL_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.slice(4000) }),
    });
  }
}

// ─── Threads ─────────────────────────────────────────────────────────────────

async function publishThreads(text, mediaUrl, target) {
  const keys = target === "оба" || target === "both" ? ["anna", "prosto"] : [target];
  const accounts = keys.map((k) => THREADS[k]).filter(Boolean);
  if (!accounts.length) throw new Error(`неизвестный аккаунт "${target}" (anna / prosto / оба)`);

  for (const acc of accounts) {
    if (!acc.token || !acc.userId) throw new Error(`${acc.name}: нет токена`);
    const params = new URLSearchParams({
      media_type: mediaUrl ? "IMAGE" : "TEXT",
      text: text.slice(0, 500), // лимит Threads — 500 символов
      access_token: acc.token,
      ...(mediaUrl && { image_url: mediaUrl }),
    });
    const c = await (await fetch(`https://graph.threads.net/v1.0/${acc.userId}/threads`, { method: "POST", body: params })).json();
    if (!c.id) throw new Error(`${acc.name}: ${c.error ? c.error.message : "нет id контейнера"}`);

    await sleep(30000); // Meta рекомендует подождать перед публикацией

    const p = await (await fetch(`https://graph.threads.net/v1.0/${acc.userId}/threads_publish`, {
      method: "POST",
      body: new URLSearchParams({ creation_id: c.id, access_token: acc.token }),
    })).json();
    if (!p.id) throw new Error(`${acc.name}: ${p.error ? p.error.message : "публикация не удалась"}`);
    console.log(`[Threads] ${acc.name}: ${p.id}`);
  }
}

// ─── Основная логика ─────────────────────────────────────────────────────────

async function main() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A${FIRST_ROW}:L1000`,
  });
  const rows = data.values || [];
  const now = new Date();
  console.log(`[${now.toISOString()}] Лист "${SHEET_NAME}": ${rows.length} строк`);
  // Куда публикуем (без раскрытия токенов) — для проверки настроек
  const mask = (v) => (v ? `${v.slice(0, 5)}…${v.slice(-3)}` : "не задан");
  console.log(`TG канал: ${mask(TG_CHANNEL_ID)} | Max канал: ${mask(MAX_CHANNEL_ID)} | VK: ${mask(VK_OWNER_ID)}`);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + FIRST_ROW;
    const cell = (c) => String(row[c] || "").trim();

    if (cell(COL.STATUS) !== "⏳") continue;

    const publishAt = parseMoscowDateTime(cell(COL.DATE), cell(COL.TIME));
    if (!publishAt) { await updateStatus(sheets, rowNum, "❌ дата дд.мм.гггг, время чч:мм"); continue; }
    if (publishAt > now) continue;

    const text = cell(COL.TEXT);
    if (!text) { await updateStatus(sheets, rowNum, "❌ нет текста"); continue; }

    // Сразу помечаем строку, чтобы параллельный запуск не опубликовал её второй раз
    await updateStatus(sheets, rowNum, "🔄 публикуется");

    const textThreads = cell(COL.TEXT_THREADS) || text;
    const mediaUrl = toDirectUrl(cell(COL.MEDIA));
    const threadsTarget = cell(COL.THREADS).toLowerCase();

    const done = [];
    const errors = [];
    const run = async (name, fn) => {
      try { await fn(); done.push(name); console.log(`[${name}] ✅ строка ${rowNum}`); }
      catch (e) { errors.push(`${name}: ${shortErr(e)}`); console.log(`[${name}] ❌ строка ${rowNum}: ${shortErr(e)}`); }
    };

    let media = null;
    if (mediaUrl) {
      try { media = await downloadMedia(mediaUrl); }
      catch (e) { await updateStatus(sheets, rowNum, `❌ ${shortErr(e)}`); continue; }
    }

    if (yes(row[COL.TG])) await run("TG", () => publishTelegram(text, media));
    if (yes(row[COL.VK])) await run("VK", () => publishVK(text, media));
    if (yes(row[COL.MAX])) await run("Max", () => publishMax(text, media));
    if (threadsTarget && threadsTarget !== "нет") await run("Threads", () => publishThreads(textThreads, mediaUrl, threadsTarget));

    let status;
    if (!errors.length) status = "✅";
    else if (done.length) status = `⚠️ ок: ${done.join(", ")} | ${errors.join("; ")}`;
    else status = `❌ ${errors.join("; ")}`;
    await updateStatus(sheets, rowNum, status);
  }

  console.log("Готово.");
}

async function updateStatus(sheets, rowNum, status) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!L${rowNum}`,
    valueInputOption: "RAW",
    requestBody: { values: [[status]] },
  });
}

main().catch((e) => {
  console.error("Критическая ошибка:", e.message);
  process.exit(1);
});
