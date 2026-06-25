#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""博物馆名称模糊匹配引擎 — heritage-analysis 分支
五级递进匹配: L1精确→L2标准化→L3包含→L4编辑距离→L5Gap
用于Gap分析: 识别某省哪些博物馆在过去3年中没有数字化采购中标记录。

用法:
  from scraper.name_matcher import match_museums
  result = match_museums(museums, buyer_names)
"""

import re
from difflib import SequenceMatcher

# ═══ 标准化规则 ═══
# 去除行政区划前缀后缀
ADMIN_PATTERNS = [
    r"^(全国|国家|中国|中华)",
    r"(省|市|区|县|镇|乡|村|自治州|自治县|地区|盟|旗)$",
]

# 博物院 ↔ 博物馆统一
NAME_NORMALIZE_MAP = {
    "博物院": "博物馆",
    "陈列馆": "博物馆",
    "展览馆": "博物馆",
    "纪念馆": "博物馆",
    "文物管理所": "博物馆",
    "管理局": "博物馆",
}


SIMILARITY_THRESHOLD = 0.85  # L4 编辑距离阈值


def normalize_name(name):
    """标准化博物馆名称: 去除行政区划修饰词, 统一博物院↔博物馆"""
    n = name.strip()
    # 去括号内容 (包括中英文括号)
    n = re.sub(r"[（(][^)）]*[)）]", "", n)
    # 统一名称后缀
    for old, new in NAME_NORMALIZE_MAP.items():
        if n.endswith(old):
            n = n[:-len(old)] + new
    # 去除前导行政区划 (如 "陕西省" → "")
    for pat in ADMIN_PATTERNS:
        n = re.sub(pat, "", n)
    # 去除多余空格
    n = re.sub(r"\s+", "", n)
    return n


def match_single(museum_name, buyer_names):
    """单条匹配: 对1条博物馆名录匹配所有采购人名称, 返回最佳匹配"""
    mn = museum_name.strip()
    mn_norm = normalize_name(mn)

    best_match = None
    best_level = 5  # 越小越好
    best_buyer = ""

    for buyer in buyer_names:
        bn = buyer.strip()
        bn_norm = normalize_name(bn)

        # L1: 精确匹配
        if mn == bn or mn_norm == bn_norm:
            return {"level": 1, "museum": mn, "buyer": bn, "confidence": "high"}

        # L2: 标准化匹配 (已包含在 mn_norm==bn_norm 的L1中)
        # L2额外: 去"市"+"县"后缀差异
        mn_no_suffix = re.sub(r"(市|县)$", "", mn_norm)
        bn_no_suffix = re.sub(r"(市|县)$", "", bn_norm)
        if mn_no_suffix == bn_no_suffix and mn_no_suffix:
            if best_level > 2:
                best_level, best_buyer = 2, bn
                best_match = {"level": 2, "museum": mn, "buyer": bn, "confidence": "high"}
                continue

        # L3: 包含匹配
        if (mn_norm in bn_norm and len(mn_norm) >= 6) or (bn_norm in mn_norm and len(bn_norm) >= 6):
            if best_level > 3:
                best_level, best_buyer = 3, bn
                best_match = {"level": 3, "museum": mn, "buyer": bn, "confidence": "medium"}

        # L4: 编辑距离
        if best_level >= 4:
            ratio = SequenceMatcher(None, mn_norm, bn_norm).ratio()
            if ratio >= SIMILARITY_THRESHOLD:
                if best_level > 4:
                    best_level, best_buyer = 4, bn
                    best_match = {"level": 4, "museum": mn, "buyer": bn, "confidence": "low", "similarity": round(ratio, 2)}

    return best_match


def match_museums(museums, buyer_names):
    """
    批量匹配: 将博物馆名录与采购人列表进行匹配, 返回三组结果。

    Args:
        museums: list of dict, 每条含 name, normalized_name, province, city, level, type
        buyer_names: list of str, 去重的采购人名称列表

    Returns:
        {
            "matched": [...],    # L1-L3 高/中置信度匹配 (已数字化)
            "gap": [...],        # L5 未匹配 (Gap目标)
            "uncertain": [...],  # L4 低置信度 (待人工确认)
        }
    """
    matched = []
    gap = []
    uncertain = []

    for museum in museums:
        mn = museum.get("name", museum.get("normalized_name", ""))
        result = match_single(mn, buyer_names)

        if result is None:
            # L5: 未匹配 → Gap
            gap.append(museum)
        elif result["level"] <= 3:
            # L1-L3: 已匹配 → 已数字化
            matched.append({**museum, "match": result})
        else:
            # L4: 低置信度 → 待确认
            uncertain.append({**museum, "match": result})

    return {
        "matched": matched,
        "gap": gap,
        "uncertain": uncertain,
    }


def print_match_report(result):
    """打印匹配报告"""
    total = len(result["matched"]) + len(result["gap"]) + len(result["uncertain"])
    print(f"\n{'='*50}")
    print(f"  匹配报告")
    print(f"{'='*50}")
    print(f"  总计: {total} 条名录")
    print(f"  已匹配(已数字化): {len(result['matched'])} ({len(result['matched'])/total*100:.1f}%)")
    print(f"  Gap(未数字化):    {len(result['gap'])} ({len(result['gap'])/total*100:.1f}%)")
    print(f"  待确认(低置信度): {len(result['uncertain'])} ({len(result['uncertain'])/total*100:.1f}%)")
    print(f"{'='*50}")

    if result["gap"]:
        print(f"\n  Gap目标 (商务拓展机会):")
        for m in result["gap"][:20]:
            print(f"    - {m['name']} ({m.get('city', '')}, {m.get('level', 'N/A')})")
        if len(result["gap"]) > 20:
            print(f"    ... 还有 {len(result['gap'])-20} 条")


if __name__ == "__main__":
    # 自测用例
    museums = [
        {"name": "陕西历史博物馆", "city": "西安", "level": "一级"},
        {"name": "西安博物院", "city": "西安", "level": "一级"},
        {"name": "宝鸡青铜器博物院", "city": "宝鸡", "level": "一级"},
    ]
    buyers = [
        "陕西历史博物馆",
        "西安博物院（西安市文物交流中心）",
        "宝鸡青铜器博物馆",  # 注意: 博物院≠博物馆
    ]
    
    result = match_museums(museums, buyers)
    print_match_report(result)
