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
const SHEET_NAME = env("SHEET_NAME"); // необязательно: скрипт сам находит все листы-месяцы

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
function toPublicImageUrl(url, jpeg = false) {
  if (!url) return null;
  const m =
    url.match(/drive\.google\.com\/file\/d\/([^/?#]+)/) ||
    url.match(/drive\.google\.com\/open\?id=([^&#]+)/) ||
    url.match(/drive\.google\.com\/uc\?.*id=([^&#]+)/);
  // =w1440 — ширина до 1440px (требование Meta), -rj — отдать как JPEG (Instagram принимает только JPEG)
  return m ? `https://lh3.googleusercontent.com/d/${m[1]}=w1440${jpeg ? "-rj" : ""}` : url;
}

/** Ячейка «Медиа» может содержать несколько ссылок — каждая с новой строки (до 10) */
const splitLinks = (v) => String(v || "").split(/[\s,]+/).map((x) => x.trim()).filter((x) => /^https?:\/\//.test(x)).slice(0, 10);

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

async function publishTelegram(text, medias) {
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

  if (!medias.length) return sendText(text);

  // Подпись к фото — максимум 1024 символа. Длинный текст отправляем вторым сообщением.
  const fits = text.length <= 1024;
  const form = new FormData();
  form.append("chat_id", TG_CHANNEL_ID);
  if (medias.length === 1) {
    form.append("photo", new Blob([medias[0].buf], { type: medias[0].type }), medias[0].filename);
    if (fits) form.append("caption", text);
    await tgCall("sendPhoto", form);
  } else {
    // Альбом: до 10 фото, подпись у первого
    const group = medias.map((m, i) => ({ type: "photo", media: `attach://f${i}`, ...(i === 0 && fits && { caption: text }) }));
    medias.forEach((m, i) => form.append(`f${i}`, new Blob([m.buf], { type: m.type }), m.filename));
    form.append("media", JSON.stringify(group));
    await tgCall("sendMediaGroup", form);
  }
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

async function publishVK(text, medias) {
  if (!VK_TOKEN || !VK_OWNER_ID) throw new Error("нет VK_TOKEN / VK_OWNER_ID");
  const groupId = String(VK_OWNER_ID).replace("-", "");
  const att = [];
  for (const media of medias) {
    const server = await vkCall("photos.getWallUploadServer", { group_id: groupId });
    const form = new FormData();
    form.append("photo", new Blob([media.buf], { type: media.type }), media.filename);
    const up = await (await fetch(server.upload_url, { method: "POST", body: form })).json();
    if (!up.photo || up.photo === "[]") throw new Error("VK не принял картинку");
    const saved = await vkCall("photos.saveWallPhoto", {
      group_id: groupId, photo: up.photo, server: up.server, hash: up.hash,
    });
    att.push(`photo${saved[0].owner_id}_${saved[0].id}`);
  }
  const attachments = att.join(",");

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

// ─── Instagram ───────────────────────────────────────────────────────────────
// Подключение — workflow «Connect account» (platform: instagram). Токены на листе «Служебное».
// Публикует фото (1) или карусель (2–10). Instagram забирает картинки сам по публичной ссылке.

const IG_API = "https://graph.instagram.com";
const IG_ACCOUNTS = { anna: "@doc.startseva.anna", prosto: "@homeopathy_prosto" };

async function igCall(path, params, token, method = "POST") {
  const q = new URLSearchParams({ ...params, access_token: token });
  const res = method === "GET"
    ? await fetch(`${IG_API}${path}?${q}`)
    : await fetch(`${IG_API}${path}`, { method: "POST", body: q });
  const data = await res.json();
  if (data.error) throw new Error(data.error.error_user_msg || data.error.message);
  return data;
}

async function igWaitReady(id, token) {
  for (let i = 0; i < 20; i++) {
    const st = await igCall(`/${id}`, { fields: "status_code,status" }, token, "GET");
    if (st.status_code === "FINISHED") return;
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") throw new Error(`обработка: ${st.status || st.status_code}`);
    await sleep(3000);
  }
  throw new Error("Instagram слишком долго обрабатывает медиа");
}

async function refreshIgTokens(sheets) {
  for (const key of Object.keys(IG_ACCOUNTS)) {
    const t = TOKENS[`ig_${key}`];
    if (!t || !t.token || ageDays(t.updated) < 3) continue;
    try {
      const r = await (await fetch(`${IG_API}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(t.token)}`)).json();
      if (!r.access_token) throw new Error(JSON.stringify(r.error || r).slice(0, 150));
      await saveToken(sheets, SPREADSHEET_ID, `ig_${key}`, { token: r.access_token, userId: t.userId, note: t.note });
      t.token = r.access_token;
      console.log(`[Instagram] токен ${key} продлён`);
    } catch (e) {
      console.log(`[Instagram] ⚠️ не удалось продлить токен ${key}: ${shortErr(e)}`);
    }
  }
}

async function publishInstagram(caption, links, target) {
  const keys = target === "оба" || target === "both" ? ["anna", "prosto"] : [target === "да" ? "prosto" : target];
  if (!keys.every((k) => IG_ACCOUNTS[k])) throw new Error(`неизвестный аккаунт "${target}" (anna / prosto / оба)`);
  if (!links.length) throw new Error("для Instagram нужна картинка — добавьте ссылку в «Медиа»");
  const urls = links.map((l) => toPublicImageUrl(l, true));
  caption = caption.slice(0, 2200); // лимит подписи Instagram

  const errors = [];
  for (const k of keys) {
    const t = TOKENS[`ig_${k}`] || {};
    try {
      if (!t.token || !t.userId) throw new Error("аккаунт не подключён");
      let containerId;
      if (urls.length === 1) {
        containerId = (await igCall(`/${t.userId}/media`, { image_url: urls[0], caption }, t.token)).id;
      } else {
        const children = [];
        for (const u of urls) {
          const ch = await igCall(`/${t.userId}/media`, { image_url: u, is_carousel_item: "true" }, t.token);
          children.push(ch.id);
        }
        for (const ch of children) await igWaitReady(ch, t.token);
        containerId = (await igCall(`/${t.userId}/media`, { media_type: "CAROUSEL", children: children.join(","), caption }, t.token)).id;
      }
      await igWaitReady(containerId, t.token);
      const p = await igCall(`/${t.userId}/media_publish`, { creation_id: containerId }, t.token);
      console.log(`[Instagram] ${IG_ACCOUNTS[k]}: ${p.id}`);
    } catch (e) {
      errors.push(`${IG_ACCOUNTS[k]}: ${shortErr(e)}`);
    }
  }
  if (errors.length) throw new Error(errors.join("; "));
}

// ─── Основная логика ─────────────────────────────────────────────────────────

/** Лист-месяц: название начинается с цифры («10-11.2026», «12.2026») и в A1 стоит «№» */
const isMonthSheet = (title) => /^\d/.test(title);

/** Убирает HTML-разметку Telegram для площадок, где она не поддерживается */
const plain = (html) => String(html || "")
  .replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

async function main() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const now = new Date();

  TOKENS = await loadTokens(sheets, SPREADSHEET_ID);
  await refreshThreadsTokens(sheets);
  await refreshIgTokens(sheets);

  // Все листы-месяцы таблицы — менять настройки в GitHub при смене месяца не нужно
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: "sheets.properties.title" });
  const titles = meta.data.sheets.map((x) => x.properties.title).filter(isMonthSheet);
  if (SHEET_NAME && !titles.includes(SHEET_NAME) && meta.data.sheets.some((x) => x.properties.title === SHEET_NAME)) titles.push(SHEET_NAME);

  const mask = (v) => (v ? `${v.slice(0, 5)}…${v.slice(-3)}` : "не задан");
  console.log(`[${now.toISOString()}] Листы: ${titles.join(", ") || "нет"}`);
  console.log(`TG канал: ${mask(TG_CHANNEL_ID)} | Max канал: ${mask(MAX_CHANNEL_ID)} | VK: ${mask(VK_OWNER_ID)}`);
  console.log(`Threads: anna ${TOKENS.threads_anna ? TOKENS.threads_anna.note || "подключён" : "не подключён"}, prosto ${TOKENS.threads_prosto ? TOKENS.threads_prosto.note || "подключён" : "не подключён"}`);
  console.log(`Instagram: anna ${TOKENS.ig_anna ? TOKENS.ig_anna.note : "не подключён"}, prosto ${TOKENS.ig_prosto ? TOKENS.ig_prosto.note : "не подключён"}`);

  for (const title of titles) {
    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${title}'!A1:L1000` });
    const all = data.values || [];
    if (String((all[0] || [])[0] || "").trim() !== "№") continue; // не наш формат
    const rows = all.slice(FIRST_ROW - 1);
    const due = rows.filter((r) => String(r[COL.STATUS] || "").trim() === "⏳").length;
    console.log(`Лист "${title}": ${rows.filter((r) => r.some(Boolean)).length} строк, ждут публикации: ${due}`);
    for (let i = 0; i < rows.length; i++) await processRow(sheets, title, rows[i], i + FIRST_ROW, now);
  }
  console.log("Готово.");
}

async function processRow(sheets, title, row, rowNum, now) {
  const cell = (c) => String(row[c] || "").trim();
  const setStatus = (s) => updateStatus(sheets, title, rowNum, s);

  if (cell(COL.STATUS) !== "⏳") return;
  const publishAt = parseMoscowDateTime(cell(COL.DATE), cell(COL.TIME));
  if (!publishAt) { await setStatus("❌ дата дд.мм.гггг, время чч:мм"); return; }
  if (publishAt > now) return;

  const text = cell(COL.TEXT);
  if (!text) { await setStatus("❌ нет текста"); return; }

  // Сразу помечаем строку, чтобы параллельный запуск не опубликовал её второй раз
  await setStatus("🔄 публикуется");

  const hasHtml = /<\/?(b|i|u|s|a|code|pre)\b/i.test(text);
  const textPlain = plain(text);
  const shortText = plain(cell(COL.TEXT_THREADS)) || textPlain; // Threads и подпись Instagram — без разметки
  const links = splitLinks(cell(COL.MEDIA));
  const threadsTarget = cell(COL.THREADS).toLowerCase();
  const igTarget = cell(COL.INSTA).toLowerCase();

  const done = [];
  const errors = [];
  const run = async (name, fn) => {
    try { await fn(); done.push(name); console.log(`[${name}] ✅ ${title}, строка ${rowNum}`); }
    catch (e) { errors.push(`${name}: ${shortErr(e)}`); console.log(`[${name}] ❌ ${title}, строка ${rowNum}: ${shortErr(e)}`); }
  };

  // Скачиваем картинки один раз для TG / VK / Max (Threads и Instagram забирают их по ссылке сами)
  const medias = [];
  try {
    for (const l of links) medias.push(await downloadMedia(toDirectUrl(l)));
  } catch (e) { await setStatus(`❌ ${shortErr(e)}`); return; }

  if (yes(row[COL.TG])) await run("TG", () => publishTelegram(text, medias));
  if (yes(row[COL.VK])) await run("VK", () => publishVK(textPlain, medias));
  if (yes(row[COL.MAX])) {
    if (MIRROR_ON && yes(row[COL.TG])) done.push("Max (через зеркало)");
    else await run("Max", () => publishMax(textPlain, medias, hasHtml ? { html: text } : {}));
  }
  // Threads: одна картинка (первая), карусели в Threads — позже
  if (threadsTarget && threadsTarget !== "нет") await run("Threads", () => publishThreads(shortText, toPublicImageUrl(links[0]), threadsTarget));
  if (igTarget && igTarget !== "нет") await run("Instagram", () => publishInstagram(cell(COL.TEXT_THREADS) ? shortText : textPlain, links, igTarget));

  let status;
  if (!errors.length) status = "✅";
  else if (done.length) status = `⚠️ ок: ${done.join(", ")} | ${errors.join("; ")}`;
  else status = `❌ ${errors.join("; ")}`;
  await setStatus(status);
}

async function updateStatus(sheets, title, rowNum, status) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${title}'!L${rowNum}`,
    valueInputOption: "RAW",
    requestBody: { values: [[status]] },
  });
}

main().catch((e) => {
  console.error("Критическая ошибка:", e.message);
  process.exit(1);
});
