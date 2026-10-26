/**
 * max.js — публикация в канал Max (max.ru) через Bot API.
 * Используется и таблицей (publisher.js), и зеркалом TG → Max (mirror.js).
 */

const MAX_TOKEN = (process.env.MAX_TOKEN || "").trim();
const MAX_CHANNEL_ID = (process.env.MAX_CHANNEL_ID || "").trim();

// Основной адрес использует сертификат Минцифры (workflow подключает его через NODE_EXTRA_CA_CERTS).
// Если не получилось — пробуем запасной адрес.
const HOSTS = ["https://platform-api2.max.ru", "https://platform-api.max.ru"];
let hostIdx = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const causeOf = (e) => (e && e.cause ? `${e.cause.code || ""} ${e.cause.message || ""}`.trim() : String(e && e.message));

async function maxFetch(path, options = {}) {
  const opts = { ...options, headers: { Authorization: MAX_TOKEN, ...(options.headers || {}) } };
  let lastErr;
  for (; hostIdx < HOSTS.length; hostIdx++) {
    try {
      return await fetch(`${HOSTS[hostIdx]}${path}`, opts);
    } catch (e) {
      lastErr = e;
      console.log(`[Max] ${HOSTS[hostIdx]} недоступен (${causeOf(e)})`);
    }
  }
  hostIdx = 0;
  throw new Error(`сеть: ${causeOf(lastErr)}`);
}

async function maxCall(path, options = {}) {
  const res = await maxFetch(path, options);
  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = { raw }; }
  if (!res.ok) {
    const err = new Error(`${res.status} ${data.code || ""} ${data.message || raw.slice(0, 150)}`.trim());
    err.code = data.code;
    throw err;
  }
  return data;
}

/** Загружает файл в Max и возвращает объект вложения */
async function uploadToMax(media) {
  const type = media.kind || "image"; // image | video | file
  const init = await maxCall(`/uploads?type=${type}`, { method: "POST" });
  const form = new FormData();
  form.append("data", new Blob([media.buf], { type: media.type }), media.filename);
  const up = await fetch(init.url, { method: "POST", body: form, headers: { Authorization: MAX_TOKEN } });
  const upRaw = await up.text();
  if (!up.ok) throw new Error(`загрузка ${type}: ${up.status} ${upRaw.slice(0, 120)}`);
  let upData = {};
  try { upData = JSON.parse(upRaw); } catch { /* видео может вернуть не-JSON */ }

  // Для картинок токен приходит в ответе загрузки, для видео/файлов — в первом ответе /uploads
  if (type === "image") return { type: "image", payload: upData };
  return { type, payload: { token: init.token || upData.token } };
}

async function sendMessage(body) {
  for (let attempt = 1; ; attempt++) {
    try {
      const sent = await maxCall(`/messages?chat_id=${MAX_CHANNEL_ID}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return sent.message || sent;
    } catch (e) {
      // Вложение ещё обрабатывается — ждём и повторяем
      if (/not\.ready|not_ready/i.test(e.message) && attempt < 6) { await sleep(2000 * attempt); continue; }
      throw e;
    }
  }
}

/**
 * Публикует пост в канал Max.
 * @param {string} text   текст (до 4000 символов в одном сообщении, остаток уйдёт вторым)
 * @param {Array}  medias [{buf, type, filename, kind}] — картинки/видео
 * @param {Object} opts   { html: строка с HTML-разметкой (необязательно) }
 */
async function publishMax(text, medias = [], opts = {}) {
  if (!MAX_TOKEN || !MAX_CHANNEL_ID) throw new Error("нет MAX_TOKEN / MAX_CHANNEL_ID");
  medias = (medias || []).filter(Boolean);

  const attachments = [];
  for (const m of medias) attachments.push(await uploadToMax(m));

  const LIMIT = 4000;
  const useHtml = opts.html && opts.html.length <= LIMIT;
  const first = useHtml ? opts.html : text.slice(0, LIMIT);
  const body = { text: first, ...(useHtml && { format: "html" }), ...(attachments.length && { attachments }) };

  let msg;
  try {
    msg = await sendMessage(body);
  } catch (e) {
    // Если Max не принял разметку — отправляем обычным текстом
    if (useHtml && /^400/.test(e.message)) {
      console.log(`[Max] разметка не принята (${e.message}), отправляю без неё`);
      msg = await sendMessage({ text: text.slice(0, LIMIT), ...(attachments.length && { attachments }) });
    } else throw e;
  }

  if (!useHtml && text.length > LIMIT) await sendMessage({ text: text.slice(LIMIT) });
  return msg;
}

module.exports = { publishMax };
