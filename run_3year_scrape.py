# -*- coding: utf-8 -*-
"""3年历史数据爬取脚本 — 按月搜索CCGP，详情页解析，逐步累积
用法: $env:PYTHONPATH="pip_packages"; python run_3year_scrape.py
时间范围: 2023-06-24 ~ 2026-06-24 (3年)
"""

import os, sys, json, csv, time, re, urllib.request, urllib.parse
from datetime import datetime, timedelta

# 添加 pip_packages 到路径
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "pip_packages"))

from bs4 import BeautifulSoup
from ccgp_fast_scraper import (
    Item, BID_KEYWORDS, ABORT_KEYWORDS, http_get, parse_ccgp_detail,
    norm_date, parse_date_obj, Pipe
)
from keywords import KEYWORDS_20, DOMAIN_FILTER

OUT_DIR = os.path.join("output", "3year")
os.makedirs(OUT_DIR, exist_ok=True)

START_DATE = datetime(2023, 6, 24)
END_DATE = datetime(2026, 6, 24)

PROGRESS_PATH = os.path.join(OUT_DIR, "progress.json")
ACCUM_JSON = os.path.join(OUT_DIR, "all_accumulated.json")
FINAL_CSV = os.path.join(OUT_DIR, "文物数字化_3年汇总.csv")
FINAL_JSON = os.path.join(OUT_DIR, "文物数字化_3年汇总.json")

REF = "https://www.ccgp.gov.cn/"
BASE = "https://search.ccgp.gov.cn/bxsearch"

def load_progress():
    if os.path.exists(PROGRESS_PATH):
        with open(PROGRESS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"completed_months": [], "total_raw": 0}

def save_progress(prog):
    with open(PROGRESS_PATH, "w", encoding="utf-8") as f:
        json.dump(prog, f, ensure_ascii=False, indent=2)

def load_accumulated():
    if os.path.exists(ACCUM_JSON):
        with open(ACCUM_JSON, "r", encoding="utf-8") as f:
            raw = json.load(f)
        items = []
        for d in raw:
            it = Item()
            # Map Chinese dict keys back to English Item attributes
            key_map = {
                "\u6807\u9898": "title", "\u539f\u6587\u94fe\u63a5": "url", "\u53d1\u5e03\u65f6\u95f4": "date",
                "\u516c\u544a\u7c7b\u578b": "bid_type", "\u5730\u533a": "region",
                "\u91c7\u8d2d\u4eba": "buyer", "\u4ee3\u7406\u673a\u6784": "agent",
                "\u4f9b\u5e94\u5546": "supplier", "\u4f9b\u5e94\u5546\u5730\u5740": "supplier_addr",
                "\u4e2d\u6807\u91d1\u989d(\u4e07)": "amount", "\u6570\u636e\u6765\u6e90": "source",
            }
            for cn_key, en_key in key_map.items():
                setattr(it, en_key, d.get(cn_key, ""))
            items.append(it)
        return items
    return []

def save_accumulated(items):
    dicts = [it.to_dict() for it in items]
    with open(ACCUM_JSON, "w", encoding="utf-8") as f:
        json.dump(dicts, f, ensure_ascii=False, indent=2)

def build_month_ranges():
    ranges = []
    cur = START_DATE
    while cur < END_DATE:
        if cur.month == 12:
            nxt = datetime(cur.year + 1, 1, 1) - timedelta(days=1)
        else:
            nxt = datetime(cur.year, cur.month + 1, 1) - timedelta(days=1)
        if nxt > END_DATE:
            nxt = END_DATE
        ranges.append((cur, nxt))
        cur = nxt + timedelta(days=1)
    return ranges

def search_ccgp(kw, start_d, end_d):
    """搜索CCGP指定日期范围, 返回 Item 列表"""
    params = {
        "searchtype": "2", "bidType": "0", "kw": kw,
        "timeType": "6",
        "start_time": start_d.strftime("%Y:%m:%d"),
        "end_time": end_d.strftime("%Y:%m:%d"),
        "page": "1",
    }
    url = BASE + "?" + urllib.parse.urlencode(params)

    html = ""
    for attempt in range(4):
        html = http_get(url, referer=REF, retries=1, delay=1)
        if not html or ("频繁" in html and len(html) < 3000):
            wt = 8 + attempt * 5
            print(f"    频率限制,等待{wt}s (尝试{attempt+1}/4)")
            time.sleep(wt)
            continue
        break

    if not html or "频繁" in html:
        print("    搜索失败(频率限制)")
        return []

    soup = BeautifulSoup(html, "html.parser")
    items = []
    for li in soup.select("ul li"):
        a = li.find("a")
        if not a:
            continue
        href = a.get("href", "")
        if "ccgp.gov.cn" not in href:
            continue
        if not href.startswith("http"):
            href = "https:" + href if href.startswith("//") else REF.rstrip("/") + "/" + href.lstrip("/")
        title = a.get_text(strip=True)
        if not title or len(title) < 5:
            continue

        item = Item()
        item.title = title
        item.url = href
        item.source = "中国政府采购网"

        text = li.get_text(" ", strip=True)
        m = re.search(r"(\d{4})[/.年-](\d{1,2})[/.月-](\d{1,2})", text)
        if m:
            item.date = norm_date(f"{m.group(1)}-{m.group(2)}-{m.group(3)}")

        d = parse_date_obj(item.date)
        if d and not (start_d - timedelta(days=1) <= d <= end_d + timedelta(days=2)):
            continue

        for kw_val in BID_KEYWORDS:
            if kw_val in title or kw_val in text:
                item.bid_type = kw_val + "公告" if not kw_val.endswith("公告") else kw_val
                break
        items.append(item)
    return items

def scrape_details(items):
    """为 items 爬取详情页填充字段"""
    for i, it in enumerate(items, 1):
        if it.buyer and it.supplier:
            continue  # 已有详情, 跳过
        html = ""
        for attempt in range(3):
            html = http_get(it.url, referer=REF, retries=1, delay=1)
            if html and not ("频繁" in html and len(html) < 3000):
                break
            time.sleep(4)
        if html:
            d = parse_ccgp_detail(html, it.url)
            for k in ("buyer", "agent", "supplier", "supplier_addr", "amount", "date", "region", "bid_type"):
                if d.get(k):
                    setattr(it, k, d[k])
        if i % 10 == 0:
            print(f"    详情 {i}/{len(items)}")
        time.sleep(0.15)
    return items

def process_month(start_d, end_d):
    """处理一个月的搜索+详情"""
    all_items = []
    for ki, kw in enumerate(KEYWORDS_20, 1):
        results = search_ccgp(kw, start_d, end_d)
        all_items.extend(results)
        if ki % 5 == 0:
            print(f"    [{ki}/{len(KEYWORDS_20)}] 累计 {len(all_items)} 条")
        time.sleep(0.15)

    print(f"  原始: {len(all_items)} 条")
    unique = Pipe.dedup(all_items)
    print(f"  去重: {len(unique)} 条")
    domain = Pipe.domain_filter(unique)
    print(f"  域名: {len(domain)} 条")
    filtered = Pipe.filter(domain)
    print(f"  中标/成交/废标: {len(filtered)} 条")

    if filtered:
        pass  # 跳过详情爬取, 最后统一处理

    return filtered

def run():
    print("=" * 60)
    print(f"  3年历史数据爬取: {START_DATE.strftime('%Y-%m-%d')} ~ {END_DATE.strftime('%Y-%m-%d')}")
    print(f"  关键词: {len(KEYWORDS_20)} 个")
    print(f"  输出目录: {OUT_DIR}")
    print("=" * 60)

    ranges = build_month_ranges()
    print(f"\n  共 {len(ranges)} 个月")

    prog = load_progress()
    print(f"  已完成: {len(prog['completed_months'])} 个月")

    accumulated = load_accumulated()
    print(f"  已累积: {len(accumulated)} 条\n")

    for idx, (start_d, end_d) in enumerate(ranges):
        month_key = start_d.strftime("%Y-%m")
        if month_key in prog["completed_months"]:
            print(f"[{idx+1}/{len(ranges)}] {month_key} - 跳过")
            continue

        print(f"\n{'─'*50}")
        print(f"[{idx+1}/{len(ranges)}] {start_d.strftime('%Y-%m-%d')} ~ {end_d.strftime('%Y-%m-%d')}")
        print(f"{'─'*50}")

        try:
            month_items = process_month(start_d, end_d)
            accumulated.extend(month_items)

            # 重新去重
            accumulated = Pipe.dedup(accumulated)
            save_accumulated(accumulated)

            prog["completed_months"].append(month_key)
            prog["total_raw"] = len(accumulated)
            save_progress(prog)

            print(f"  本月新增 ~{len(month_items)} 条, 累计去重 {len(accumulated)} 条")
        except Exception as e:
            print(f"  ERROR: {e}")
            # 仍然保存进度
            save_accumulated(accumulated)
            prog["completed_months"].append(month_key)
            save_progress(prog)

        if idx < len(ranges) - 1:
            wait = 2
            print(f"  等待 {wait}s...")
            time.sleep(wait)

    # === 最终输出 ===
    print(f"\n{'='*60}")
    print(f"  爬取完成! 最终筛选与排序...")

    print(f"  开始爬取详情页 ({len(accumulated)} 条)...")
    accumulated = scrape_details(accumulated)
    print(f"  详情页完成")

    final = Pipe.domain_filter(accumulated)
    final = Pipe.filter(final)
    final = Pipe.sort(final)

    Pipe.csv(final, FINAL_CSV)
    Pipe.json(final, FINAL_JSON)

    total = len(final)
    print(f"  最终结果: {total} 条")
    print(f"  CSV: {FINAL_CSV}")
    print(f"  JSON: {FINAL_JSON}")

    if total:
        fill = {
            "采购人": sum(1 for r in final if r.buyer),
            "代理机构": sum(1 for r in final if r.agent),
            "供应商": sum(1 for r in final if r.supplier),
            "供应商地址": sum(1 for r in final if r.supplier_addr),
            "中标金额": sum(1 for r in final if r.amount),
        }
        print("\n  字段填充率:")
        for k, v in fill.items():
            print(f"    {k}: {v}/{total} ({v/total*100:.0f}%)")

    print(f"{'='*60}")

if __name__ == "__main__":
    run()

