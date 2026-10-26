/**
 * tokens.js — хранение ключей площадок (Threads, Instagram, VK) на скрытом листе «Служебное».
 * Ключи с ограниченным сроком (60 дней, 1 час) обновляются автоматически и сохраняются сюда,
 * потому что GitHub Secrets нельзя перезаписать из самого скрипта.
 *
 * Формат листа: A — ключ (threads_anna …), B — токен, C — ID пользователя, D — обновлён (ISO), E — заметка
 */

const SHEET = "Служебное";

async function ensureSheet(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties" });
  const exists = meta.data.sheets.some((s) => s.properties.title === SHEET);
  if (exists) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: SHEET, hidden: true } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET}!A1:E1`,
    valueInputOption: "RAW",
    requestBody: { values: [["ключ", "токен (не трогать)", "ID пользователя", "обновлён", "заметка"]] },
  });
}

async function loadTokens(sheets, spreadsheetId) {
  try {
    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET}!A2:E100` });
    const out = {};
    (data.values || []).forEach((r, i) => {
      if (r[0]) out[r[0]] = { token: r[1] || "", userId: r[2] || "", updated: r[3] || "", note: r[4] || "", row: i + 2 };
    });
    return out;
  } catch (e) {
    if (/Unable to parse range/i.test(e.message)) return {}; // листа ещё нет
    throw e;
  }
}

async function saveToken(sheets, spreadsheetId, key, { token, userId = "", note = "" }) {
  await ensureSheet(sheets, spreadsheetId);
  const all = await loadTokens(sheets, spreadsheetId);
  const values = [[key, token, userId || (all[key] && all[key].userId) || "", new Date().toISOString(), note]];
  if (all[key]) {
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `${SHEET}!A${all[key].row}:E${all[key].row}`,
      valueInputOption: "RAW", requestBody: { values },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId, range: `${SHEET}!A:E`, valueInputOption: "RAW", requestBody: { values },
    });
  }
}

const ageDays = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 86400e3 : Infinity);

module.exports = { loadTokens, saveToken, ensureSheet, ageDays };
