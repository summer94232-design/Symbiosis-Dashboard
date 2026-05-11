import os
import json
import requests
from bs4 import BeautifulSoup
from datetime import datetime
import firebase_admin
from firebase_admin import credentials, firestore

# ── Firebase 初始化 ──
service_account = json.loads(os.environ["FIREBASE_SERVICE_ACCOUNT"])
cred = credentials.Certificate(service_account)
firebase_admin.initialize_app(cred)
db = firestore.client()

# ── 爬取 Yahoo 法說會行事曆 ──
def fetch_yahoo_earnings_calendar() -> list:
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-TW,zh;q=0.9",
    }

    res = requests.get(
        "https://tw.stock.yahoo.com/calendar/earnings-call",
        headers=headers,
        timeout=15,
    )
    res.raise_for_status()

    soup = BeautifulSoup(res.text, "html.parser")
    meetings = []

    for li in soup.select("li"):
        name_el = li.select_one("div.Fw\\(600\\)")
        code_el = li.select_one("span.Fz\\(14px\\).C\\(\\#979ba7\\)")
        if not name_el or not code_el:
            continue

        divs = li.select("div.Ta\\(start\\).Py\\(12px\\)")
        texts = [d.get_text(strip=True) for d in divs]
        if len(texts) < 5:
            continue

        raw_code = code_el.get_text(strip=True)
        code = raw_code.replace(".TWO", "").replace(".TW", "")
        name = name_el.get_text(strip=True)
        dt_str = texts[1]
        meeting_type = texts[2]
        location = texts[3]
        description = texts[4]

        try:
            dt = datetime.strptime(dt_str, "%Y/%m/%d %H:%M")
            date = dt.strftime("%Y-%m-%d")
            year_month = dt.strftime("%Y-%m")
            time = dt.strftime("%H:%M")
        except ValueError:
            continue

        meetings.append({
            "code": code,
            "name": name,
            "date": date,
            "yearMonth": year_month,
            "time": time,
            "type": meeting_type,
            "location": location,
            "description": description,
        })

    return meetings

# ── 寫入 Firebase ──
def sync_to_firebase(meetings: list):
    if not meetings:
        print("沒有抓到任何資料")
        return

    # 依 stockCode-yearMonth 分組
    grouped = {}
    for m in meetings:
        key = f"{m['code']}-{m['yearMonth']}"
        if key not in grouped:
            grouped[key] = {
                "stockCode": m["code"],
                "stockName": m["name"],
                "yearMonth": m["yearMonth"],
                "dates": [],
                "updatedAt": datetime.utcnow().isoformat(),
            }
        if m["date"] not in grouped[key]["dates"]:
            grouped[key]["dates"].append(m["date"])

    # 批次寫入
    batch = db.batch()
    col = db.collection("investorMeetings")
    for key, data in grouped.items():
        ref = col.document(key)
        batch.set(ref, data, merge=True)

    batch.commit()
    print(f"✅ 成功寫入 {len(grouped)} 筆到 Firebase investorMeetings")

# ── 執行 ──
if __name__ == "__main__":
    print("開始爬取 Yahoo 法說會行事曆...")
    meetings = fetch_yahoo_earnings_calendar()
    print(f"共抓到 {len(meetings)} 筆法說會")
    sync_to_firebase(meetings)