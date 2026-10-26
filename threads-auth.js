/**
 * threads-auth.js — подключение аккаунта Threads (запускается вручную из GitHub Actions).
 *
 * Вход: ACCOUNT (anna | prosto), AUTH_CODE (код из адресной строки после «Разрешить»).
 * Обменивает код на долгий токен (60 дней) и сохраняет его на лист «Служебное».
 * Дальше publisher.js сам продлевает токен.
 */

const { google } = require("googleapis");
const { saveToken } = require("./tokens");

const env = (k) => (process.env[k] || "").trim();
const APP_ID = env("THREADS_APP_ID");
const APP_SECRET = env("THREADS_APP_SECRET");
const REDIRECT_URI = env("THREADS_REDIRECT_URI") || "https://homeopathy-prosto.ru/";
const ACCOUNT = env("ACCOUNT");
// Код иногда копируют вместе с адресом или хвостом "#_"
const rawCode = env("AUTH_CODE");
const CODE = (rawCode.match(/[?&]code=([^&#]+)/) || [null, rawCode])[1].replace(/#_?$/, "");

async function main() {
  if (!["anna", "prosto"].includes(ACCOUNT)) throw new Error("ACCOUNT должен быть anna или prosto");
  if (!APP_ID || !APP_SECRET) throw new Error("нет THREADS_APP_ID / THREADS_APP_SECRET в секретах");
  if (!CODE) throw new Error("пустой код авторизации");

  // 1. Код → короткий токен (1 час)
  const r1 = await fetch("https://graph.threads.net/oauth/access_token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: APP_ID, client_secret: APP_SECRET, code: CODE,
      grant_type: "authorization_code", redirect_uri: REDIRECT_URI,
    }),
  });
  const short = await r1.json();
  if (!short.access_token) throw new Error(`обмен кода: ${JSON.stringify(short.error || short)}`);

  // 2. Короткий → долгий токен (60 дней)
  const r2 = await fetch(
    `https://graph.threads.net/access_token?grant_type=th_exchange_token` +
      `&client_secret=${encodeURIComponent(APP_SECRET)}&access_token=${encodeURIComponent(short.access_token)}`
  );
  const long = await r2.json();
  if (!long.access_token) throw new Error(`долгий токен: ${JSON.stringify(long.error || long)}`);

  // 3. Проверяем, чей это аккаунт
  const me = await (await fetch(
    `https://graph.threads.net/v1.0/me?fields=id,username&access_token=${encodeURIComponent(long.access_token)}`
  )).json();
  if (!me.id) throw new Error(`проверка аккаунта: ${JSON.stringify(me.error || me)}`);

  // 4. Сохраняем
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  await saveToken(sheets, env("SPREADSHEET_ID"), `threads_${ACCOUNT}`, {
    token: long.access_token, userId: me.id, note: `@${me.username}`,
  });

  const days = Math.round((long.expires_in || 0) / 86400);
  console.log(`✅ Threads ${ACCOUNT} подключён: @${me.username} (id ${me.id}), токен на ${days} дн., продлевается автоматически`);
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
