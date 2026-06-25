#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""单省历史爬虫 — heritage-analysis 分支
基于 ccgp_fast_scraper.py 核心解析逻辑扩展: zoneId过滤、日期范围、月份分段、断点续传、多源降级。

用法:
  python scraper/scrape_province.py --province 陕西 --years 2023-2025
  python scraper/scrape_province.py --province 四川 --years 2024-2025 --start-month 3
  python scraper/scrape_province.py --province 江苏 --years 2023-2024 --resume
"""

import re, csv, json, time, argparse, os, sys

# 导入根目录的 ccgp_fast_scraper 核心解析函数
_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
sys.path.insert(0, _root)

from ccgp_fast_scraper import (
    http_get, parse_ccgp_detail, parse_ggzy_detail,
    Item, norm_date, norm_amount, clean_supplier,
    BID_KEYWORDS, ABORT_KEYWORDS, Pipe, get_ua
)
from keywords import KEYWORDS_20, DOMAIN_FILTER
from scraper.config import (
    PROVINCE_ZONE, RATE_LIMIT, DATA_SOURCES, PROVINCE_ALIAS
)

# ═══ Config ═══
TIMEOUT = 30
BASE_URL = "https://search.ccgp.gov.cn/bxsearch"
REFERER = "https://www.ccgp.gov.cn/"
OUTPUT_BASE = "output/raw"


def log(*a):
    print(*a, flush=True)


def build_search_url(keyword, zone_id, start_date, end_date):
    """构建CCGP搜索URL, 带省份zoneId和时间范围"""
    from urllib.parse import urlencode
    params = {
        "searchtype": "2", "page_index": "1", "bidSort": "0",
        "buyerName": "", "projectId": "", "pinMu": "0",
        "bidType": "0", "dbselect": "bidx", "kw": keyword,
        "start_time": start_date.strftime("%Y:%m:%d"),
        "end_time": end_date.strftime("%Y:%m:%d"),
        "timeType": "6",
        "displayZone": "", "zoneId": zone_id or "",
        "pppStatus": "0", "agentName": "",
    }
    return f"{BASE_URL}?{urlencode(params)}"


def search_single_page(keyword, zone_id, start_date, end_date, max_retries=4):
    """搜索单页, 带频率控制"""
    url = build_search_url(keyword, zone_id, start_date, end_date)
    html = ""
    for attempt in range(max_retries):
        html = http_get(url, referer=REFERER, retries=1, delay=1)
        if not html or ("频繁" in html and len(html) < 3000):
            wait = min(RATE_LIMIT["initial_wait"] * (RATE_LIMIT["growth_factor"] ** attempt), RATE_LIMIT["max_wait"])
            log(f"  [限流] 等待 {wait}s (尝试 {attempt+1}/{max_retries})...")
            time.sleep(wait)
            continue
        break
    return html


def parse_search_results(html, keyword, start_date, end_date):
    """解析搜索结果页, 提取公告列表(仅单页)"""
    from bs4 import BeautifulSoup
    if not html or "频繁" in html:
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
            href = "https:" + href if href.startswith("//") else REFERER.rstrip("/") + "/" + href.lstrip("/")
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
        for kw in BID_KEYWORDS:
            if kw in title or kw in text:
                item.bid_type = kw + "公告" if not kw.endswith("公告") else kw
                break
        items.append(item)
    return items


def crawl_month_segment(keyword, zone_id, year, month, province=""):
    """爬取单月数据: 搜索→提取详情→去重"""
    from datetime import datetime
    start = datetime(year, month, 1)
    if month == 12:
        end = datetime(year + 1, 1, 1)
    else:
        end = datetime(year, month + 1, 1)

    log(f"    [{year}-{month:02d}] 搜索 {keyword}...")
    html = search_single_page(keyword, zone_id, start, end)
    results = parse_search_results(html, keyword, start, end)
    log(f"    [{year}-{month:02d}] 搜索到 {len(results)} 条")

    if not results:
        return []

    # 爬取详情
    fetched = []
    for i, item in enumerate(results, 1):
        detail_html = ""
        for attempt in range(3):
            detail_html = http_get(item.url, referer=REFERER, retries=1, delay=1)
            if detail_html and not ("频繁" in detail_html and len(detail_html) < 3000):
                break
            time.sleep(RATE_LIMIT["detail_delay"] * (attempt + 1))
        if detail_html:
            d = parse_ccgp_detail(detail_html, item.url)
            for k in ("buyer", "agent", "supplier", "supplier_addr", "amount", "date", "region", "bid_type"):
                if d.get(k):
                    setattr(item, k, d[k])
        if i % 10 == 0:
            log(f"      详情 {i}/{len(results)}")
        time.sleep(RATE_LIMIT["detail_delay"])

    # 域名+中标过滤
    domain = [it for it in results if any(dk in it.title for dk in DOMAIN_FILTER)]
    bid_only = [it for it in domain if it.bid_type and any(k in it.bid_type for k in BID_KEYWORDS)] + \
               [it for it in domain if it.bid_type == "废标公告"]
    final = Pipe.dedup(bid_only)
    log(f"    [{year}-{month:02d}] 有效: {len(final)} 条 (原始{len(results)} → 域名{len(domain)} → 中标{len(bid_only)} → 去重{len(final)})")
    return final


def save_progress(province, progress, progress_file):
    """保存断点续传进度"""
    os.makedirs(os.path.dirname(progress_file), exist_ok=True)
    with open(progress_file, "w", encoding="utf-8") as f:
        json.dump(progress, f, ensure_ascii=False, indent=2)


def load_progress(province, progress_file):
    """加载进度"""
    if not os.path.exists(progress_file):
        return {"province": province, "status": {}}
    with open(progress_file, "r", encoding="utf-8") as f:
        return json.load(f)


def generate_month_segments(years_str):
    """解析年份范围, 生成 (year, month) 列表"""
    segments = []
    # 支持 "2023-2025" 或 "2023" 格式
    parts = years_str.replace(",", "-").split("-")
    if len(parts) == 1:
        start_year = int(parts[0])
        end_year = start_year
    else:
        start_year, end_year = int(parts[0]), int(parts[1])
    for y in range(start_year, end_year + 1):
        for m in range(1, 13):
            segments.append((y, m))
    return segments


def scrape_province(province, years_str, resume=False, start_month=None, max_keywords=None):
    """主函数: 按省份+年份范围爬取"""
    zone_id = PROVINCE_ZONE.get(province)
    if not zone_id:
        log(f"[ERROR] 未知省份: {province}, 可用: {list(PROVINCE_ZONE.keys())}")
        return

    keywords = KEYWORDS_20[:max_keywords] if max_keywords else KEYWORDS_20
    segments = generate_month_segments(years_str)
    if start_month:
        # 从指定月份开始的segments
        start_key = f"{segments[0][0]:04d}-{start_month:02d}"
        segments = [(y, m) for y, m in segments if f"{y:04d}-{m:02d}" >= start_key]

    output_dir = os.path.join(OUTPUT_BASE, province)
    os.makedirs(output_dir, exist_ok=True)
    progress_file = os.path.join(OUTPUT_BASE, province, "progress.json")
    progress = load_progress(province, progress_file) if resume else {"province": province, "status": {}}

    all_items = []
    total_segments = len(segments)

    log(f"\n{'='*60}")
    log(f"  单省历史爬虫: {province} (zoneId={zone_id})")
    log(f"  年份: {years_str} → {total_segments} 个月段")
    log(f"  关键词: {len(keywords)} 个")
    log(f"  {'断点续传: ON' if resume else '断点续传: OFF'}")
    log(f"{'='*60}\n")

    t0 = time.time()

    for seg_idx, (y, m) in enumerate(segments, 1):
        seg_key = f"{y:04d}-{m:02d}"

        # 跳过已完成
        if progress["status"].get(seg_key) == "done":
            log(f"  [{seg_idx}/{total_segments}] {seg_key} — 已完成, 跳过")
            continue

        log(f"\n  [{seg_idx}/{total_segments}] {seg_key} — 开始...")
        month_items = []

        for ki, kw in enumerate(keywords, 1):
            try:
                items = crawl_month_segment(kw, zone_id, y, m, province)
                month_items.extend(items)
            except Exception as e:
                log(f"    [ERROR] {kw}: {str(e)[:80]}")
            time.sleep(RATE_LIMIT["search_delay"])

        # 去重合并
        unique = Pipe.dedup(month_items)
        all_items.extend(unique)

        # 保存单月CSV
        csv_path = os.path.join(output_dir, f"{seg_key}.csv")
        Pipe.csv(unique, csv_path)

        # 更新进度
        progress["status"][seg_key] = "done"
        progress["total_collected"] = len(all_items)
        save_progress(province, progress, progress_file)

        log(f"    {seg_key} 完成: {len(unique)} 条 → CSV: {csv_path}")

    # 合并全部月份CSV
    all_unique = Pipe.dedup(all_items)
    csv_all = os.path.join(output_dir, f"{province}_all.csv")
    Pipe.csv(all_unique, csv_all)
    json_all = os.path.join(output_dir, f"{province}_all.json")
    Pipe.json(all_unique, json_all)

    log(f"\n{'='*60}")
    log(f"  {province} 完成: {len(all_unique)} 条 (总耗时 {(time.time()-t0)/60:.1f} 分钟)")
    log(f"  输出: {csv_all}")
    log(f"  进度: {progress_file}")
    log(f"{'='*60}")

    return all_unique


def main():
    p = argparse.ArgumentParser(description="单省历史爬虫 — heritage-analysis")
    p.add_argument("--province", required=True, help="省份名称 (如 陕西/四川/江苏)")
    p.add_argument("--years", default="2023-2025", help="年份范围, 如 2023-2025 或 2023")
    p.add_argument("--start-month", type=int, default=None, help="从指定月份开始 (1-12)")
    p.add_argument("--resume", action="store_true", help="断点续传模式")
    p.add_argument("--max-keywords", type=int, default=None, help="限制关键词数量(调试用)")
    args = p.parse_args()

    scrape_province(
        province=args.province,
        years_str=args.years,
        resume=args.resume,
        start_month=args.start_month,
        max_keywords=args.max_keywords,
    )


if __name__ == "__main__":
    main()
