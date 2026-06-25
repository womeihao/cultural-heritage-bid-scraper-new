#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""数据整理器 — heritage-analysis 分支
将爬取的原始CSV按省份/博物馆分组, 生成层级化JSON前端数据文件。

流程:
  1. 读取原始CSV → 按省份分组
  2. 每省内按采购人(博物馆)分组 → 生成 data/{省}/{博物馆}/projects.json
  3. 计算每省汇总 → 生成 data/{省}/summary.json + data/{省}/charts.json
  4. 计算全国汇总 → 生成 summary/all_provinces.json
  5. 调用 name_matcher 生成 data/{省}/gap.json
  6. 更新 data/version.json

用法:
  python scraper/build_data_files.py --input output/raw/
  python scraper/build_data_files.py --input output/raw/ --provinces 陕西,四川,江苏
  python scraper/build_data_files.py --input output/raw/陕西/陕西_all.csv --single-province 陕西
"""

import os, re, json, csv, time, argparse, hashlib, sys
from collections import defaultdict
from datetime import datetime

_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
sys.path.insert(0, _root)

from scraper.config import (
    PROVINCE_ZONE, PROVINCE_ALIAS, TAG_DEFINITIONS,
    RADAR_DIMENSIONS, DEFAULT_PROVINCES
)


def log(*a):
    print(*a, flush=True)


def load_museums(museums_path="data/museums.json"):
    """加载博物馆名录"""
    full_path = os.path.join(_root, museums_path)
    if not os.path.exists(full_path):
        log(f"[!] 博物馆名录未找到: {full_path}, 将跳过Gap分析")
        return {}
    with open(full_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("provinces", {})


def normalize_province(raw_region):
    """将CSV中的地区字段标准化为省份名"""
    if not raw_region:
        return ""
    r = raw_region.strip()
    # 先查别名映射
    for alias, std in PROVINCE_ALIAS.items():
        if alias in r or r in alias:
            return std
    # 直接查zoneId映射
    for prov in PROVINCE_ZONE:
        if prov in r or r in prov:
            return prov
    # 以"省"/"市"/"自治区"结尾的取前两个字
    m = re.match(r"^(.{2,4})(?:省|市|自治区|特别行政区)", r)
    if m:
        candidate = m.group(1)
        if candidate in PROVINCE_ZONE:
            return candidate
    return ""


def normalize_museum_name(buyer_name):
    """标准化采购人名称, 用于匹配博物馆名录"""
    if not buyer_name:
        return ""
    n = buyer_name.strip()
    # 去括号内容
    n = re.sub(r"[（(][^)）]*[)）]", "", n)
    # 去空格
    n = re.sub(r"\s+", "", n)
    return n


def load_csv_items(input_path):
    """加载输入CSV, 支持单文件或目录批量加载"""
    items = []
    if os.path.isfile(input_path) and input_path.endswith(".csv"):
        with open(input_path, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            items = list(reader)
    elif os.path.isdir(input_path):
        for root_dir, dirs, files in os.walk(input_path):
            for fname in files:
                if fname.endswith(".csv") and not fname.startswith("."):
                    fp = os.path.join(root_dir, fname)
                    try:
                        with open(fp, "r", encoding="utf-8-sig") as f:
                            reader = csv.DictReader(f)
                            for row in reader:
                                items.append(row)
                    except Exception as e:
                        log(f"  [SKIP] {fp}: {e}")
    else:
        log(f"[ERROR] 输入路径无效: {input_path}")
    return items


def build_projects(items, province_name):
    """按博物馆(采购人)分组, 生成 projects.json"""
    museum_map = defaultdict(list)
    for item in items:
        buyer = item.get("采购人", "").strip()
        if not buyer:
            buyer = item.get("标题", "")[:20].strip()
        museum_map[buyer].append(item)

    data_dir = os.path.join(_root, "data", province_name)
    os.makedirs(data_dir, exist_ok=True)

    for buyer, projs in museum_map.items():
        safe_name = re.sub(r'[\\/:*?"<>|]', "_", buyer)[:80]
        museum_dir = os.path.join(data_dir, safe_name)
        os.makedirs(museum_dir, exist_ok=True)

        # 合并省份信息
        city = ""
        for p in projs:
            if p.get("地区", ""):
                city = p["地区"]
                break

        # 解析tags字段(可能是JSON字符串)
        formatted_projects = []
        for p in projs:
            tags_raw = p.get("tags", "")
            if isinstance(tags_raw, str) and tags_raw.startswith("["):
                try:
                    tags = json.loads(tags_raw)
                except json.JSONDecodeError:
                    tags = [t.strip() for t in tags_raw.replace("[","").replace("]","").split(",") if t.strip()]
            else:
                tags = []

            amount_str = p.get("中标金额(万)", "")
            try:
                amount = float(amount_str) if amount_str else 0
            except (ValueError, TypeError):
                amount = 0

            formatted_projects.append({
                "title": p.get("标题", ""),
                "url": p.get("原文链接", ""),
                "date": p.get("发布时间", ""),
                "amount": amount,
                "supplier": p.get("供应商", ""),
                "supplier_addr": p.get("供应商地址", ""),
                "agent": p.get("代理机构", ""),
                "bid_type": p.get("公告类型", ""),
                "source": p.get("数据来源", "中国政府采购网"),
                "tags": tags,
                "tag_confidence": p.get("tag_confidence", p.get("tag_confidence", "")),
                "classified_by": p.get("classified_by", p.get("classified_by", "")),
            })

        projects_data = {
            "museum": buyer,
            "province": province_name,
            "city": city,
            "projects": formatted_projects,
        }
        projects_path = os.path.join(museum_dir, "projects.json")
        with open(projects_path, "w", encoding="utf-8") as f:
            json.dump(projects_data, f, ensure_ascii=False, indent=2)

    return museum_map


def build_summary(items, province_name):
    """生成省份汇总 summary.json"""
    museum_set = set()
    total_amount = 0
    tag_counter = defaultdict(int)
    year_data = defaultdict(lambda: {"count": 0, "amount": 0})
    supplier_set = set()

    for item in items:
        buyer = item.get("采购人", "").strip()
        if buyer:
            museum_set.add(buyer)

        amount_str = item.get("中标金额(万)", "")
        try:
            amount = float(amount_str) if amount_str else 0
        except (ValueError, TypeError):
            amount = 0
        total_amount += amount

        supplier = item.get("供应商", "").strip()
        if supplier:
            supplier_set.add(supplier)

        # 年份提取
        date_str = item.get("发布时间", "")
        year_match = re.search(r"(\d{4})", date_str)
        if year_match:
            y = int(year_match.group(1))
            year_data[y]["count"] += 1
            year_data[y]["amount"] += amount

        # 标签统计
        tags_raw = item.get("tags", "")
        if isinstance(tags_raw, str) and tags_raw.startswith("["):
            try:
                tags = json.loads(tags_raw)
            except json.JSONDecodeError:
                tags = []
        else:
            tags = []
        for t in tags:
            tag_counter[t] += 1

    summary = {
        "province": province_name,
        "total_projects": len(items),
        "total_amount": round(total_amount, 2),
        "total_museums": len(museum_set),
        "total_suppliers": len(supplier_set),
        "museums": sorted(list(museum_set)),
        "year_data": dict(year_data),
        "tag_distribution": dict(tag_counter),
    }

    summary_path = os.path.join(_root, "data", province_name, "summary.json")
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    return summary


def build_charts(summary, items, province_name):
    """生成ECharts预计算数据 charts.json"""
    charts = {
        "province": province_name,
        "generated_at": datetime.now().isoformat(),
    }

    # 1. 环形饼图: 标签分布
    tag_dist = summary.get("tag_distribution", {})
    pie_data = [{"name": tag, "value": count} for tag, count in sorted(tag_dist.items(), key=lambda x: -x[1])]
    charts["pie"] = pie_data

    # 2. 雷达图: 六维能力覆盖
    radar_data = []
    for dim in RADAR_DIMENSIONS:
        dim_value = sum(tag_dist.get(t, 0) for t in dim["tags"])
        radar_data.append({"name": dim["label"], "value": dim_value})
    charts["radar"] = radar_data

    # 3. 年度柱状图
    year_data = summary.get("year_data", {})
    bar_data = {
        "years": sorted(year_data.keys()),
        "counts": [year_data[y]["count"] for y in sorted(year_data.keys())],
        "amounts": [round(year_data[y]["amount"], 2) for y in sorted(year_data.keys())],
    }
    charts["bar"] = bar_data

    # 4. Top10横向条形图
    museum_counter = defaultdict(int)
    supplier_amount = defaultdict(float)
    for item in items:
        buyer = item.get("采购人", "").strip()
        if buyer:
            museum_counter[buyer] += 1
        supplier = item.get("供应商", "").strip()
        if supplier:
            amount_str = item.get("中标金额(万)", "")
            try:
                amt = float(amount_str) if amount_str else 0
            except (ValueError, TypeError):
                amt = 0
            supplier_amount[supplier] += amt

    top_museums = sorted(museum_counter.items(), key=lambda x: -x[1])[:10]
    top_suppliers = sorted(supplier_amount.items(), key=lambda x: -x[1])[:10]
    charts["top_museums"] = [{"name": m, "count": c} for m, c in top_museums]
    charts["top_suppliers"] = [{"name": s, "amount": round(a, 2)} for s, a in top_suppliers]

    charts_path = os.path.join(_root, "data", province_name, "charts.json")
    with open(charts_path, "w", encoding="utf-8") as f:
        json.dump(charts, f, ensure_ascii=False, indent=2)

    return charts


def build_gap(province_name, buyer_names):
    """Gap分析: 调用 name_matcher 匹配博物馆名录与采购人"""
    museums_data = load_museums()
    province_museums = museums_data.get(province_name, [])

    if not province_museums:
        log(f"  [!] 未找到 {province_name} 的博物馆名录, 跳过Gap分析")
        # 写空gap文件
        gap_path = os.path.join(_root, "data", province_name, "gap.json")
        empty_gap = {"province": province_name, "matched": [], "gap": [], "uncertain": [], "note": "无博物馆名录数据"}
        with open(gap_path, "w", encoding="utf-8") as f:
            json.dump(empty_gap, f, ensure_ascii=False, indent=2)
        return empty_gap

    try:
        from scraper.name_matcher import match_museums
        result = match_museums(province_museums, buyer_names)

        gap_path = os.path.join(_root, "data", province_name, "gap.json")
        with open(gap_path, "w", encoding="utf-8") as f:
            json.dump({
                "province": province_name,
                "generated_at": datetime.now().isoformat(),
                "matched": result["matched"],
                "gap": result["gap"],
                "uncertain": result["uncertain"],
            }, f, ensure_ascii=False, indent=2)

        from scraper.name_matcher import print_match_report
        print_match_report(result)
        return result

    except ImportError as e:
        log(f"  [!] name_matcher 导入失败: {e}, 跳过Gap分析")
        return None


def build_all_provinces(all_summaries):
    """生成全国汇总 all_provinces.json"""
    provinces_data = []
    for prov, summary in sorted(all_summaries.items()):
        provinces_data.append({
            "province": prov,
            "total_projects": summary["total_projects"],
            "total_amount": summary["total_amount"],
            "total_museums": summary["total_museums"],
            "total_suppliers": summary["total_suppliers"],
        })

    all_data = {
        "generated_at": datetime.now().isoformat(),
        "provinces": provinces_data,
        "total_provinces": len(provinces_data),
    }

    summary_dir = os.path.join(_root, "data", "summary")
    os.makedirs(summary_dir, exist_ok=True)
    summary_path = os.path.join(summary_dir, "all_provinces.json")
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(all_data, f, ensure_ascii=False, indent=2)


def build_version():
    """生成/更新 version.json"""
    version_path = os.path.join(_root, "data", "version.json")
    version = {
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "timestamp": int(time.time()),
    }
    # 尝试获取git commit hash
    try:
        import subprocess
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, cwd=_root
        )
        version["commit_hash"] = result.stdout.strip()
    except Exception:
        version["commit_hash"] = "unknown"

    with open(version_path, "w", encoding="utf-8") as f:
        json.dump(version, f, ensure_ascii=False, indent=2)


def run(input_path, target_provinces=None):
    """主函数"""
    log(f"[*] 数据整理器启动")
    log(f"    输入: {input_path}")

    items = load_csv_items(input_path)
    log(f"    加载 {len(items)} 条项目")

    # 按省份分组
    province_map = defaultdict(list)
    for item in items:
        region = item.get("地区", "")
        prov = normalize_province(region)
        if prov:
            province_map[prov].append(item)
        else:
            # 尝试从标题推断
            title = item.get("标题", "")
            for p in PROVINCE_ZONE:
                if p in title:
                    province_map[p].append(item)
                    break

    log(f"    覆盖省份: {list(province_map.keys())}")
    for prov, projs in province_map.items():
        log(f"      {prov}: {len(projs)} 条")

    # 过滤目标省份
    if target_provinces:
        province_map = {p: items for p, items in province_map.items() if p in target_provinces}

    all_summaries = {}

    for prov, projs in sorted(province_map.items()):
        log(f"\n  [{prov}] 处理中 ({len(projs)} 条)...")

        # 1. 生成 projects.json
        museum_map = build_projects(projs, prov)
        log(f"    博物馆: {len(museum_map)} 个")

        # 2. 生成 summary.json
        summary = build_summary(projs, prov)
        all_summaries[prov] = summary
        log(f"    汇总: {summary['total_projects']}项目, {summary['total_amount']:.0f}万元, {summary['total_museums']}博物馆")

        # 3. 生成 charts.json
        build_charts(summary, projs, prov)
        log(f"    图表数据已生成")

        # 4. 生成 gap.json
        buyer_names = list(set(
            normalize_museum_name(item.get("采购人", "")) for item in projs if item.get("采购人")
        ))
        build_gap(prov, buyer_names)

    # 5. 生成全国汇总
    if all_summaries:
        build_all_provinces(all_summaries)
        log(f"\n[*] 全国汇总已生成: {len(all_summaries)} 省")

    # 6. 更新版本
    build_version()
    log(f"[*] version.json 已更新")

    log(f"\n[*] 数据整理完成")


def main():
    p = argparse.ArgumentParser(description="数据整理器 — heritage-analysis")
    p.add_argument("--input", required=True, help="输入路径 (CSV文件或目录)")
    p.add_argument("--provinces", default=None, help="逗号分隔的目标省份 (如 陕西,四川,江苏)")
    args = p.parse_args()

    target = None
    if args.provinces:
        target = [p.strip() for p in args.provinces.split(",")]

    run(args.input, target)


if __name__ == "__main__":
    main()
