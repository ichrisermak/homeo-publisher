"""
Расшифровщик подкастов.

Берёт подкасты из листа «Наличие материалов»:
  1) строки с типом «Подкаст», где бот записал номер аудиофайла Telegram (до 20 МБ);
  2) файлы из папки на Google Диске (для записей больше 20 МБ). Имя файла –
     номер строки (№), например «12.mp3» или «12 Миазмы.m4a». Без номера – добавится новая строка.
Расшифровывает бесплатной открытой моделью Whisper (faster-whisper) и пишет текст
в колонку «Расшифровка» (длинный текст продолжается в «Расшифровка (2)», «(3)» …),
состояние – в «Статус расшифровки».
"""
import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone

import gspread
import requests
from google.oauth2.service_account import Credentials
from google.auth.transport.requests import AuthorizedSession

MSK = timezone(timedelta(hours=3))
START = time.time()
TIME_BUDGET = float(os.environ.get("TIME_BUDGET_MIN", "240")) * 60  # после этого новые файлы не берём

SPREADSHEET_ID = os.environ.get("MATERIALS_SPREADSHEET_ID", "").strip()
SHEET_NAME = os.environ.get("MATERIALS_SHEET", "Наличие материалов").strip() or "Наличие материалов"
BOT_TOKEN = os.environ.get("TG_MATERIALS_BOT_TOKEN", "").strip()
DRIVE_FOLDER_ID = os.environ.get("DRIVE_FOLDER_ID", "").strip()
MODEL = os.environ.get("WHISPER_MODEL", "medium").strip() or "medium"
LANG = os.environ.get("WHISPER_LANG", "ru").strip() or None
PROMPT = os.environ.get("WHISPER_PROMPT", "").strip() or None
FOLDER_NAME = os.environ.get("DRIVE_FOLDER_NAME", "Подкасты на расшифровку")

COL_NUM, COL_DATE, COL_TYPE, COL_TITLE, COL_STATUS = "№", "Дата", "Тип", "Название / Тема", "Статус"
COL_ADDED, COL_FILE, COL_SIZE = "Добавлено", "Аудио (file_id)", "Размер, МБ"
COL_TR, COL_TR_STATUS = "Расшифровка", "Статус расшифровки"
CHUNK = 45000          # в одну ячейку Google Таблиц помещается до 50 000 знаков
TG_LIMIT_MB = 20       # Telegram отдаёт ботам файлы только до 20 МБ
PODCAST = "Подкаст"


def log(*a):
    print(*a, flush=True)


def now_txt():
    return datetime.now(MSK).strftime("%d.%m %H:%M")


def creds():
    info = json.loads(os.environ["GOOGLE_CREDENTIALS"])
    scopes = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"]
    return Credentials.from_service_account_info(info, scopes=scopes)


# ─── Таблица ──────────────────────────────────────────────────────
class Sheet:
    def __init__(self, c):
        gc = gspread.authorize(c)
        self.ws = gc.open_by_key(SPREADSHEET_ID).worksheet(SHEET_NAME)
        self.reload()

    def reload(self):
        vals = self.ws.get_all_values()
        self.headers = [h.strip() for h in (vals[0] if vals else [])]
        self.rows = vals[1:]

    def ensure(self, name):
        if name in self.headers:
            return self.headers.index(name)
        col = len(self.headers) + 1
        if self.ws.col_count < col:
            self.ws.add_cols(col - self.ws.col_count)
        self.ws.update_cell(1, col, name)
        self.headers.append(name)
        return col - 1

    def get(self, r, name):
        if name not in self.headers:
            return ""
        i = self.headers.index(name)
        row = self.rows[r - 2] if 0 <= r - 2 < len(self.rows) else []
        return row[i].strip() if i < len(row) else ""

    def set(self, r, name, value):
        i = self.ensure(name)
        self.ws.update_cell(r, i + 1, value)

    def set_status(self, r, text):
        self.set(r, COL_TR_STATUS, text)
        log(f"  строка {r}: {text}")

    def write_text(self, r, text):
        parts = [text[i:i + CHUNK] for i in range(0, len(text), CHUNK)] or [""]
        for k, part in enumerate(parts):
            name = COL_TR if k == 0 else f"{COL_TR} ({k + 1})"
            # апостроф защищает текст, начинающийся с = + - @, от превращения в формулу
            self.set(r, name, ("'" + part) if part[:1] in "=+-@" else part)

    def find_by_num(self, num):
        for r in range(2, len(self.rows) + 2):
            if self.get(r, COL_NUM) == str(num):
                return r
        return None

    def add_podcast_row(self, title):
        nums = [int(x) for x in (self.get(r, COL_NUM) for r in range(2, len(self.rows) + 2)) if x.isdigit()]
        now = datetime.now(MSK)
        data = {COL_NUM: (max(nums) + 1) if nums else 1, COL_DATE: now.strftime("%d.%m.%Y"), COL_TYPE: PODCAST,
                COL_TITLE: title, COL_STATUS: "Готово, не опубликовано", COL_ADDED: now.strftime("%d.%m.%Y %H:%M")}
        row = [""] * len(self.headers)
        for k, v in data.items():
            if k in self.headers:
                row[self.headers.index(k)] = v
        self.ws.append_row(row, value_input_option="USER_ENTERED", table_range="A1")
        self.reload()
        return len(self.rows) + 1


# ─── Распознавание ───────────────────────────────────────────────
_model = None


def model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        log(f"Загружаю модель {MODEL}…")
        _model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 4)
    return _model


def transcribe(path):
    t0 = time.time()
    segments, info = model().transcribe(path, language=LANG, initial_prompt=PROMPT, beam_size=1,
                                        vad_filter=True, condition_on_previous_text=False)
    paras, cur, cur_len, last_end = [], [], 0, None
    for s in segments:
        txt = s.text.strip()
        if not txt:
            continue
        pause = (s.start - last_end) if last_end is not None else 0
        if cur and (pause > 1.5 or cur_len > 700):
            paras.append(" ".join(cur)); cur, cur_len = [], 0
        cur.append(txt); cur_len += len(txt); last_end = s.end
    if cur:
        paras.append(" ".join(cur))
    text = "\n\n".join(paras).strip()
    log(f"  аудио {info.duration / 60:.1f} мин, расшифровано за {(time.time() - t0) / 60:.1f} мин, {len(text)} знаков")
    return text


def done_status(text):
    return f"✅ готово · {len(text)} знаков · {now_txt()}"


# ─── Telegram ────────────────────────────────────────────────────
def tg_download(file_id, dest):
    r = requests.get(f"https://api.telegram.org/bot{BOT_TOKEN}/getFile", params={"file_id": file_id}, timeout=60).json()
    if not r.get("ok"):
        desc = r.get("description", "")
        if "too big" in desc.lower():
            return "big"
        raise RuntimeError(f"Telegram: {desc}")
    url = f"https://api.telegram.org/file/bot{BOT_TOKEN}/{r['result']['file_path']}"
    with requests.get(url, stream=True, timeout=600) as resp:
        resp.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in resp.iter_content(1 << 20):
                f.write(chunk)
    return "ok"


def big_msg(num):
    n = f"{num}.mp3" if num else "номер строки.mp3"
    return f"📁 Файл больше {TG_LIMIT_MB} МБ – положите его в папку «{FOLDER_NAME}» на Google Диске с именем «{n}»"


def from_telegram(sh):
    if not BOT_TOKEN:
        log("Ключ бота материалов не задан – пропускаю подкасты из Telegram")
        return
    for r in range(2, len(sh.rows) + 2):
        if time.time() - START > TIME_BUDGET:
            return
        if sh.get(r, COL_TYPE) != PODCAST or not sh.get(r, COL_FILE):
            continue
        st = sh.get(r, COL_TR_STATUS)
        if st and not st.startswith("🔁"):      # «🔁» в статусе = расшифровать заново
            continue
        num, title = sh.get(r, COL_NUM), sh.get(r, COL_TITLE)
        log(f"Подкаст №{num}: {title}")
        try:
            size = float((sh.get(r, COL_SIZE) or "0").replace(",", "."))
        except ValueError:
            size = 0
        if size > TG_LIMIT_MB:
            sh.set_status(r, big_msg(num)); continue
        sh.set_status(r, f"⏳ расшифровываю… {now_txt()}")
        try:
            with tempfile.TemporaryDirectory() as d:
                path = os.path.join(d, "audio")
                if tg_download(sh.get(r, COL_FILE), path) == "big":
                    sh.set_status(r, big_msg(num)); continue
                text = transcribe(path)
            sh.write_text(r, text)
            sh.set_status(r, done_status(text))
        except Exception as e:  # noqa: BLE001
            err = str(e).replace(BOT_TOKEN, "***")[:200]   # ключ бота не должен попасть в таблицу
            sh.set_status(r, f"❌ ошибка: {err} – поставьте «🔁», чтобы повторить")


# ─── Google Диск ─────────────────────────────────────────────────
MEDIA = re.compile(r"^(audio|video)/")


def from_drive(sh, c):
    if not DRIVE_FOLDER_ID:
        return
    s = AuthorizedSession(c)
    q = f"'{DRIVE_FOLDER_ID}' in parents and trashed = false"
    files = s.get("https://www.googleapis.com/drive/v3/files",
                  params={"q": q, "fields": "files(id,name,mimeType,size)", "pageSize": 100,
                          "supportsAllDrives": "true", "includeItemsFromAllDrives": "true"}).json().get("files", [])
    for f in files:
        if time.time() - START > TIME_BUDGET:
            return
        name = f["name"]
        if name.startswith("✅") or name.startswith("❌") or not MEDIA.match(f.get("mimeType", "")):
            continue
        log(f"Файл с Диска: {name}")
        m = re.match(r"^\s*(\d+)\b[\s._-]*(.*)$", os.path.splitext(name)[0])
        r = sh.find_by_num(m.group(1)) if m else None
        if r is None:
            title = (m.group(2) if m else os.path.splitext(name)[0]).strip() or os.path.splitext(name)[0]
            r = sh.add_podcast_row(title)
        sh.set_status(r, f"⏳ расшифровываю файл с Диска… {now_txt()}")
        try:
            with tempfile.TemporaryDirectory() as d:
                path = os.path.join(d, "audio")
                with s.get(f"https://www.googleapis.com/drive/v3/files/{f['id']}",
                           params={"alt": "media", "supportsAllDrives": "true"}, stream=True, timeout=1800) as resp:
                    resp.raise_for_status()
                    with open(path, "wb") as out:
                        for chunk in resp.iter_content(1 << 20):
                            out.write(chunk)
                text = transcribe(path)
            sh.write_text(r, text)
            sh.set_status(r, done_status(text))
            mark = "✅ "
        except Exception as e:  # noqa: BLE001
            sh.set_status(r, f"❌ ошибка файла с Диска: {str(e)[:200]}")
            mark = "❌ "
        # помечаем файл, чтобы не брать его повторно (для повтора уберите значок из имени)
        s.patch(f"https://www.googleapis.com/drive/v3/files/{f['id']}", params={"supportsAllDrives": "true"},
                json={"name": mark + name})


def drive_pending(c):
    if not DRIVE_FOLDER_ID:
        return False
    s = AuthorizedSession(c)
    q = f"'{DRIVE_FOLDER_ID}' in parents and trashed = false"
    files = s.get("https://www.googleapis.com/drive/v3/files",
                  params={"q": q, "fields": "files(name,mimeType)", "pageSize": 100,
                          "supportsAllDrives": "true", "includeItemsFromAllDrives": "true"}).json().get("files", [])
    return any(MEDIA.match(f.get("mimeType", "")) and not f["name"][:1] in "✅❌" for f in files)


def check():
    """Быстрая проверка без загрузки модели: есть ли что расшифровывать."""
    c = creds()
    sh = Sheet(c)
    need = any(sh.get(r, COL_TYPE) == PODCAST and sh.get(r, COL_FILE) and
               (not sh.get(r, COL_TR_STATUS) or sh.get(r, COL_TR_STATUS).startswith("🔁"))
               for r in range(2, len(sh.rows) + 2)) or drive_pending(c)
    log("Есть подкасты для расшифровки" if need else "Новых подкастов нет")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f:
            f.write(f"need={'1' if need else '0'}\n")


def main():
    if not SPREADSHEET_ID:
        log("Не задан MATERIALS_SPREADSHEET_ID"); sys.exit(1)
    if "--check" in sys.argv:
        check(); return
    c = creds()
    sh = Sheet(c)
    sh.ensure(COL_TR_STATUS); sh.ensure(COL_TR)
    from_telegram(sh)
    from_drive(sh, c)
    log("Готово")


if __name__ == "__main__":
    main()
