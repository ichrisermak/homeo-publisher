/**
 * connect.js — подключение аккаунта Threads или Instagram (запускается вручную из GitHub Actions).
 *
 * Вход: PLATFORM (threads | instagram), ACCOUNT (anna | prosto),
 *       AUTH_CODE (код или вся адресная строка после «Разрешить»).
 * Обменивает код на долгий токен (60 дней) и сохраняет его на лист «Служебное».
 * Дальше publisher.js сам продлевает токены.
 */

const { google } = require("googleapis");
const { saveToken } = require("./tokens");

const env = (k) => (process.env[k] || "").trim();
const PLATFORM = env("PLATFORM") || "threads";
const ACCOUNT = env("ACCOUNT");
const REDIRECT_URI = env("REDIRECT_URI") || "https://homeopathy-prosto.ru/";
const rawCode = env("AUTH_CODE");
const CODE = (rawCode.match(/[?&]code=([^&#]+)/) || [null, rawCode])[1].replace(/#_?$/, "");

const CFG = {
  threads: {
    appId: env("THREADS_APP_ID"),
    secret: env("THREADS_APP_SECRET"),
    codeUrl: "https://graph.threads.net/oauth/access_token",
    longUrl: (s, t) => `https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=${s}&access_token=${t}`,
    meUrl: (t) => `https://graph.threads.net/v1.0/me?fields=id,username&access_token=${t}`,
  },
  instagram: {
    appId: env("IG_APP_ID"),
    secret: env("IG_APP_SECRET"),
    codeUrl: "https://api.instagram.com/oauth/access_token",
    longUrl: (s, t) => `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${s}&access_token=${t}`,
    meUrl: (t) => `https://graph.instagram.com/me?fields=user_id,username,account_type&access_token=${t}`,
  },
};

async function main() {
  const c = CFG[PLATFORM];
  if (!c) throw new Error("PLATFORM должен быть threads или instagram");
  if (!["anna", "prosto"].includes(ACCOUNT)) throw new Error("ACCOUNT должен быть anna или prosto");
  if (!c.appId || !c.secret) throw new Error(`нет ID/секрета приложения ${PLATFORM} в секретах GitHub`);
  if (!CODE) throw new Error("пустой код авторизации");

  // 1. Код → короткий токен
  const short = await (await fetch(c.codeUrl, {
    method: "POST",
    body: new URLSearchParams({
      client_id: c.appId, client_secret: c.secret, code: CODE,
      grant_type: "authorization_code", redirect_uri: REDIRECT_URI,
    }),
  })).json();
  if (!short.access_token) throw new Error(`обмен кода: ${JSON.stringify(short.error || short.error_message || short)}`);

  // 2. Короткий → долгий (60 дней)
  const long = await (await fetch(c.longUrl(encodeURIComponent(c.secret), encodeURIComponent(short.access_token)))).json();
  if (!long.access_token) throw new Error(`долгий токен: ${JSON.stringify(long.error || long)}`);

  // 3. Чей аккаунт
  const me = await (await fetch(c.meUrl(encodeURIComponent(long.access_token)))).json();
  const id = me.user_id || me.id;
  if (!id) throw new Error(`проверка аккаунта: ${JSON.stringify(me.error || me)}`);
  if (PLATFORM === "instagram" && me.account_type && !/BUSINESS|MEDIA_CREATOR|CREATOR/i.test(me.account_type)) {
    console.log(`⚠️ тип аккаунта ${me.account_type} — для публикации нужен профессиональный аккаунт`);
  }

  // 4. Сохраняем
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const key = `${PLATFORM === "instagram" ? "ig" : "threads"}_${ACCOUNT}`;
  await saveToken(sheets, env("SPREADSHEET_ID"), key, { token: long.access_token, userId: id, note: `@${me.username}` });

  const days = Math.round((long.expires_in || 0) / 86400);
  console.log(`✅ ${PLATFORM} ${ACCOUNT} подключён: @${me.username} (id ${id}), токен на ${days} дн., продлевается автоматически`);
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
