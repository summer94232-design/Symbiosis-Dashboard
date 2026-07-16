"""
一次性清理腳本：清掉 investorMeetings 集合裡殘留的 HTML 屬性字串
（例如：" target="_self"> 台達電 法說會）

成因：yahoo-calendar-proxy.js 之前有個切片起點的 bug，把 <a ...> 標籤
還沒結束的屬性片段（例如 target="_self">）誤當成正常文字，寫進了
Firestore 的 stockName / description 欄位。proxy 已經修好，但已經
寫進資料庫的舊資料不會自動變乾淨，所以需要這支腳本跑一次性清理。

用法：
  1) 先 dry-run（不會真的寫入，只會印出「會被改成什麼」讓你確認）：
       python clean_investor_meetings.py

  2) 確認印出來的結果沒問題後，加上 --apply 才會真的寫入 Firestore：
       python clean_investor_meetings.py --apply
"""

import os
import json
import re
import argparse
import firebase_admin
from firebase_admin import credentials, firestore


def init_firebase():
    if not firebase_admin._apps:
        service_account = json.loads(os.environ["FIREBASE_SERVICE_ACCOUNT"])
        cred = credentials.Certificate(service_account)
        firebase_admin.initialize_app(cred)
    return firestore.client()


# 殘留的 HTML 屬性片段開頭，例如：  " target="_self">   或   target="_blank">
GARBAGE_PREFIX_RE = re.compile(r'^\s*"?\s*[a-zA-Z-]+\s*=\s*"[^"]*"\s*>\s*')
# 完整的 HTML 標籤，例如：<a href="...">
TAG_RE = re.compile(r'<[^>]+>')


def clean_text(value: str) -> str:
    """反覆清掉開頭殘留的屬性片段與任何完整標籤，直到清不動為止。"""
    if not isinstance(value, str):
        return value
    cleaned = value
    while True:
        new_cleaned = GARBAGE_PREFIX_RE.sub('', cleaned)
        new_cleaned = TAG_RE.sub('', new_cleaned)
        new_cleaned = new_cleaned.strip()
        if new_cleaned == cleaned:
            break
        cleaned = new_cleaned
    return cleaned


def is_dirty(value) -> bool:
    if not isinstance(value, str):
        return False
    return bool(GARBAGE_PREFIX_RE.search(value) or TAG_RE.search(value) or 'target=' in value)


def main():
    parser = argparse.ArgumentParser(description="清理 investorMeetings 集合中殘留的 HTML 屬性字串")
    parser.add_argument("--apply", action="store_true", help="實際寫入 Firestore（預設為 dry-run，只印出會改什麼，不會寫入）")
    args = parser.parse_args()

    db = init_firebase()
    col = db.collection("investorMeetings")
    docs = list(col.stream())
    print(f"共讀到 {len(docs)} 筆文件，開始檢查…")

    dirty = []
    for doc in docs:
        data = doc.to_dict()
        updates = {}
        for field in ("stockName", "description"):
            val = data.get(field)
            if is_dirty(val):
                cleaned = clean_text(val)
                if cleaned and cleaned != val:
                    updates[field] = cleaned
        if updates:
            dirty.append((doc.id, data, updates))

    if not dirty:
        print("✅ 沒有找到髒資料，不需要清理")
        return

    print(f"\n找到 {len(dirty)} 筆需要清理的文件：\n")
    for doc_id, data, updates in dirty:
        print(f"[{doc_id}]")
        for field, new_val in updates.items():
            print(f"  {field}: {data.get(field)!r}")
            print(f"    →  {new_val!r}")
        print()

    if not args.apply:
        print("── 這是 dry-run，尚未寫入任何變更 ──")
        print("確認上面每一筆的「清理後結果」看起來都正確後，加上 --apply 再跑一次即可實際套用：")
        print("  python clean_investor_meetings.py --apply")
        return

    batch = db.batch()
    ops = 0
    for doc_id, _, updates in dirty:
        ref = col.document(doc_id)
        batch.update(ref, updates)
        ops += 1
        if ops >= 450:
            batch.commit()
            batch = db.batch()
            ops = 0
    if ops > 0:
        batch.commit()

    print(f"✅ 已套用清理，共更新 {len(dirty)} 筆文件")


if __name__ == "__main__":
    main()
