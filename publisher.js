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

const MAX_CHANNEL_ID = env("MAX_CHANNEL_ID");
const { publishMax } = require("./max");
const { loadTokens, saveToken, ageDays } = require("./tokens");
let TOKENS = {};

// Если работает зеркало TG → Max, посты с TG = да попадут в Max через зеркало.
// Чтобы не было дублей, таблица в этом случае в Max их не отправляет.
const MIRROR_ON = Boolean(env("TG_MIRROR_BOT_TOKEN"));

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

/** Публичная ссылка на картинку для Meta (Threads/Instagram забирают файл сами) */
function toPublicImageUrl(url) {
  if (!url) return null;
  const m =
    url.match(/drive\.google\.com\/file\/d\/([^/?#]+)/) ||
    url.match(/drive\.google\.com\/open\?id=([^&#]+)/) ||
    url.match(/drive\.google\.com\/uc\?.*id=([^&#]+)/);
  return m ? `https://lh3.googleusercontent.com/d/${m[1]}=w1440` : url;
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

// ─── Threads ─────────────────────────────────────────────────────────────────
// Токены лежат на скрытом листе «Служебное» (подключение — workflow «Connect Threads»).
// Токен живёт 60 дней; раз в несколько дней продлеваем его автоматически.

const TH_API = "https://graph.threads.net";

async function refreshThreadsTokens(sheets) {
  for (const key of ["anna", "prosto"]) {
    const t = TOKENS[`threads_${key}`];
    if (!t || !t.token || ageDays(t.updated) < 3) continue;
    try {
      const r = await (await fetch(
        `${TH_API}/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(t.token)}`
      )).json();
      if (!r.access_token) throw new Error(JSON.stringify(r.error || r).slice(0, 150));
      await saveToken(sheets, SPREADSHEET_ID, `threads_${key}`, { token: r.access_token, userId: t.userId, note: t.note });
      t.token = r.access_token;
      console.log(`[Threads] токен ${key} продлён`);
    } catch (e) {
      console.log(`[Threads] ⚠️ не удалось продлить токен ${key}: ${shortErr(e)}`);
    }
  }
}

async function publishThreads(text, mediaUrl, target) {
  const keys = target === "оба" || target === "both" ? ["anna", "prosto"] : [target];
  if (!keys.every((k) => THREADS[k])) throw new Error(`неизвестный аккаунт "${target}" (anna / prosto / оба)`);

  const errors = [];
  for (const k of keys) {
    const acc = THREADS[k];
    const t = TOKENS[`threads_${k}`] || {};
    const token = t.token || acc.token;
    const userId = t.userId || acc.userId;
    try {
      if (!token || !userId) throw new Error("аккаунт не подключён");
      const c = await (await fetch(`${TH_API}/v1.0/${userId}/threads`, {
        method: "POST",
        body: new URLSearchParams({
          media_type: mediaUrl ? "IMAGE" : "TEXT",
          text: text.slice(0, 500), // лимит Threads — 500 символов
          access_token: token,
          ...(mediaUrl && { image_url: mediaUrl }),
        }),
      })).json();
      if (!c.id) throw new Error(c.error ? c.error.message : "нет id контейнера");

      // Ждём, пока Meta обработает пост (обычно 5–30 сек)
      for (let i = 0; i < 12; i++) {
        await sleep(5000);
        const st = await (await fetch(`${TH_API}/v1.0/${c.id}?fields=status,error_message&access_token=${encodeURIComponent(token)}`)).json();
        if (st.status === "FINISHED") break;
        if (st.status === "ERROR" || st.status === "EXPIRED") throw new Error(st.error_message || st.status);
      }

      const p = await (await fetch(`${TH_API}/v1.0/${userId}/threads_publish`, {
        method: "POST",
        body: new URLSearchParams({ creation_id: c.id, access_token: token }),
      })).json();
      if (!p.id) throw new Error(p.error ? p.error.message : "публикация не удалась");
      console.log(`[Threads] ${acc.name}: ${p.id}`);
    } catch (e) {
      errors.push(`${acc.name}: ${shortErr(e)}`);
    }
  }
  if (errors.length) throw new Error(errors.join("; "));
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

  TOKENS = await loadTokens(sheets, SPREADSHEET_ID);
  await refreshThreadsTokens(sheets);
  console.log(`[${now.toISOString()}] Лист "${SHEET_NAME}": ${rows.length} строк`);
  // Куда публикуем (без раскрытия токенов) — для проверки настроек
  const mask = (v) => (v ? `${v.slice(0, 5)}…${v.slice(-3)}` : "не задан");
  console.log(`TG канал: ${mask(TG_CHANNEL_ID)} | Max канал: ${mask(MAX_CHANNEL_ID)} | VK: ${mask(VK_OWNER_ID)}`);
  console.log(`Threads: anna ${TOKENS.threads_anna ? TOKENS.threads_anna.note || "подключён" : "не подключён"}, prosto ${TOKENS.threads_prosto ? TOKENS.threads_prosto.note || "подключён" : "не подключён"}`);

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
    if (yes(row[COL.MAX])) {
      if (MIRROR_ON && yes(row[COL.TG])) done.push("Max (через зеркало)");
      else await run("Max", () => publishMax(text, media ? [media] : []));
    }
    if (threadsTarget && threadsTarget !== "нет") await run("Threads", () => publishThreads(textThreads, toPublicImageUrl(cell(COL.MEDIA)), threadsTarget));

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
