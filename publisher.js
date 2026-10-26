/**
 * publisher.js — Автопубликатор для "Гомеопатия просто"
 * Читает Google Sheets, публикует в TG / VK / Max / Threads
 *
 * Запускается через GitHub Actions по cron каждые 5 минут.
 * Публикует строки, у которых:
 *   - Дата + Время <= сейчас (по МСК)
 *   - Статус = "⏳" (ожидание)
 * После публикации ставит статус "✅" или "❌ <ошибка>"
 */

const { google } = require("googleapis");
const https = require("https");

// ─── Конфигурация ────────────────────────────────────────────────────────────

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "10-11.2026"; // текущий месяц

// Telegram
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHANNEL_ID = process.env.TG_CHANNEL_ID; // например: @homeopathy_prosto

// VK
const VK_TOKEN = process.env.VK_TOKEN;
const VK_OWNER_ID = process.env.VK_OWNER_ID; // отрицательное число: ID сообщества

// Max (max.ru)
const MAX_TOKEN = process.env.MAX_TOKEN;
const MAX_CHANNEL_ID = process.env.MAX_CHANNEL_ID;

// Threads (через Meta Graph API)
const THREADS_TOKEN_ANNA = process.env.THREADS_TOKEN_ANNA;
const THREADS_USER_ID_ANNA = process.env.THREADS_USER_ID_ANNA;
const THREADS_TOKEN_PROSTO = process.env.THREADS_TOKEN_PROSTO;
const THREADS_USER_ID_PROSTO = process.env.THREADS_USER_ID_PROSTO;

// Google Service Account JSON (из секрета GitHub)
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS);

// ─── Колонки таблицы (0-based) ───────────────────────────────────────────────
const COL = {
  NUM: 0,          // A — №
  DATE: 1,         // B — Дата (дд.мм.гггг)
  TIME: 2,         // C — Время (чч:мм)
  TEXT: 3,         // D — Текст (основной)
  TEXT_THREADS: 4, // E — Текст для Threads
  MEDIA: 5,        // F — Медиа (ссылка Drive)
  TG: 6,           // G — TG (да/нет)
  VK: 7,           // H — VK (да/нет)
  MAX: 8,          // I — Max (да/нет)
  THREADS: 9,      // J — Threads (anna/prosto/оба/нет)
  INSTA: 10,       // K — Insta (да/нет)
  STATUS: 11,      // L — Статус
};

// ─── Утилиты ─────────────────────────────────────────────────────────────────

/** Парсит дату из формата дд.мм.гггг чч:мм в московское время */
function parseMoscowDateTime(dateStr, timeStr) {
  const [day, month, year] = dateStr.split(".").map(Number);
  const [hours, minutes] = timeStr.split(":").map(Number);
  // МСК = UTC+3
  return new Date(Date.UTC(year, month - 1, day, hours - 3, minutes));
}

/** Простой HTTP POST (возвращает Promise<string>) */
function httpPost(url, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve(raw));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** HTTP POST multipart/form-data для медиа (упрощённо — только URL-файлы) */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve(raw));
    }).on("error", reject);
  });
}

// ─── Публикаторы ─────────────────────────────────────────────────────────────

async function publishTelegram(text, mediaUrl) {
  const base = `https://api.telegram.org/bot${TG_BOT_TOKEN}`;
  if (mediaUrl) {
    // Фото
    const res = await httpPost(`${base}/sendPhoto`, {
      chat_id: TG_CHANNEL_ID,
      photo: mediaUrl,
      caption: text,
      parse_mode: "HTML",
    });
    const data = JSON.parse(res);
    if (!data.ok) throw new Error(`TG: ${data.description}`);
  } else {
    const res = await httpPost(`${base}/sendMessage`, {
      chat_id: TG_CHANNEL_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    });
    const data = JSON.parse(res);
    if (!data.ok) throw new Error(`TG: ${data.description}`);
  }
}

async function publishVK(text, mediaUrl) {
  // VK Wall Post
  let attachments = "";
  if (mediaUrl) {
    // Загрузка фото через upload server (упрощённо)
    // В полной версии: getWallUploadServer → upload → saveWallPhoto → attachments
    attachments = `&attachments=${encodeURIComponent(mediaUrl)}`;
  }
  const url =
    `https://api.vk.com/method/wall.post` +
    `?owner_id=${VK_OWNER_ID}` +
    `&from_group=1` +
    `&message=${encodeURIComponent(text)}` +
    `${attachments}` +
    `&access_token=${VK_TOKEN}` +
    `&v=5.199`;
  const res = await httpGet(url);
  const data = JSON.parse(res);
  if (data.error) throw new Error(`VK: ${data.error.error_msg}`);
}

async function publishMax(text, mediaUrl) {
  // Max (max.ru) API — пока placeholder, уточним после проверки документации
  // TODO: подставить реальный endpoint когда подтвердим API
  console.log("[Max] Публикация пока не реализована — API уточняется");
  // throw new Error("Max API не настроен");
}

async function publishThreads(text, mediaUrl, account) {
  // Meta Threads API v1
  // Шаг 1: создать media container
  // Шаг 2: опубликовать

  const accounts = [];
  if (account === "anna" || account === "оба") {
    accounts.push({ token: THREADS_TOKEN_ANNA, userId: THREADS_USER_ID_ANNA, name: "@anna" });
  }
  if (account === "prosto" || account === "оба") {
    accounts.push({ token: THREADS_TOKEN_PROSTO, userId: THREADS_USER_ID_PROSTO, name: "@prosto" });
  }

  for (const acc of accounts) {
    // Создание контейнера
    const containerUrl =
      `https://graph.threads.net/v1.0/${acc.userId}/threads` +
      `?media_type=${mediaUrl ? "IMAGE" : "TEXT"}` +
      `&text=${encodeURIComponent(text)}` +
      (mediaUrl ? `&image_url=${encodeURIComponent(mediaUrl)}` : "") +
      `&access_token=${acc.token}`;

    const containerRes = JSON.parse(await httpGet(containerUrl));
    if (!containerRes.id) throw new Error(`Threads ${acc.name}: нет id контейнера`);

    // Пауза 30 секунд (требование Meta API)
    await new Promise((r) => setTimeout(r, 30000));

    // Публикация
    const publishUrl =
      `https://graph.threads.net/v1.0/${acc.userId}/threads_publish` +
      `?creation_id=${containerRes.id}` +
      `&access_token=${acc.token}`;

    const pubRes = JSON.parse(await httpGet(publishUrl));
    if (!pubRes.id) throw new Error(`Threads ${acc.name}: публикация не удалась`);

    console.log(`[Threads] Опубликовано в ${acc.name}: ${pubRes.id}`);
  }
}

// ─── Основная логика ─────────────────────────────────────────────────────────

async function main() {
  // Авторизация Google
  const auth = new google.auth.GoogleAuth({
    credentials: GOOGLE_CREDENTIALS,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  // Читаем все строки начиная с 4-й (1-3 — заголовки и примеры)
  const range = `${SHEET_NAME}!A4:L1000`;
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });

  const rows = response.data.values || [];
  const now = new Date();

  console.log(`[${now.toISOString()}] Проверяю ${rows.length} строк...`);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 4; // реальный номер строки в таблице

    const dateStr = (row[COL.DATE] || "").trim();
    const timeStr = (row[COL.TIME] || "").trim();
    const status = (row[COL.STATUS] || "").trim();

    // Пропускаем пустые строки и уже обработанные
    if (!dateStr || !timeStr || status !== "⏳") continue;

    // Парсим время публикации
    let publishAt;
    try {
      publishAt = parseMoscowDateTime(dateStr, timeStr);
    } catch {
      continue;
    }

    // Ещё не время
    if (publishAt > now) continue;

    const text = (row[COL.TEXT] || "").trim();
    const textThreads = (row[COL.TEXT_THREADS] || text).trim();
    const mediaUrl = (row[COL.MEDIA] || "").trim() || null;
    const doTG = (row[COL.TG] || "").toLowerCase() === "да";
    const doVK = (row[COL.VK] || "").toLowerCase() === "да";
    const doMax = (row[COL.MAX] || "").toLowerCase() === "да";
    const threadsVal = (row[COL.THREADS] || "нет").toLowerCase().trim();
    const doThreads = threadsVal !== "нет" && threadsVal !== "";

    if (!text) {
      await updateStatus(sheets, rowNum, "❌ нет текста");
      continue;
    }

    const errors = [];

    if (doTG) {
      try {
        await publishTelegram(text, mediaUrl);
        console.log(`[TG] ✅ строка ${rowNum}`);
      } catch (e) {
        errors.push(`TG: ${e.message}`);
      }
    }

    if (doVK) {
      try {
        await publishVK(text, mediaUrl);
        console.log(`[VK] ✅ строка ${rowNum}`);
      } catch (e) {
        errors.push(`VK: ${e.message}`);
      }
    }

    if (doMax) {
      try {
        await publishMax(text, mediaUrl);
        console.log(`[Max] ✅ строка ${rowNum}`);
      } catch (e) {
        errors.push(`Max: ${e.message}`);
      }
    }

    if (doThreads) {
      try {
        await publishThreads(textThreads, mediaUrl, threadsVal);
        console.log(`[Threads] ✅ строка ${rowNum}`);
      } catch (e) {
        errors.push(`Threads: ${e.message}`);
      }
    }

    const newStatus = errors.length === 0 ? "✅" : `❌ ${errors.join("; ")}`;
    await updateStatus(sheets, rowNum, newStatus);
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
