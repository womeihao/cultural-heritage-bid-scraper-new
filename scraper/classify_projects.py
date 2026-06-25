#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AI分类器 + 规则兜底 — heritage-analysis 分支
对中标项目进行12类数字化业务分类标签打标，支持AI分类和规则分类双路径。

用法:
  python scraper/classify_projects.py --input output/raw/陕西/陕西_all.csv --output output/raw/陕西/陕西_classified.csv
  python scraper/classify_projects.py --input output/raw/陕西/陕西_all.csv --rules-only  # 仅规则分类(免费)
"""

import os, re, json, csv, time, argparse, sys
import urllib.request, urllib.error

# 导入根目录keywords
_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
sys.path.insert(0, _root)

from keywords import PROMPT_AWARD_INSIGHT
from scraper.config import TAG_DEFINITIONS, TAG_KEYWORDS, HIGH_VALUE_THRESHOLD

# ═══ Config ═══
API_URL = "https://api.siliconflow.cn/v1/chat/completions"
MODEL = "deepseek-ai/DeepSeek-V4-Flash"
TIMEOUT = 60
MAX_RETRIES = 3
RETRY_DELAY = 5
MAX_INPUT_CHARS = 2000


def log(*a):
    print(*a, flush=True)


def rule_classify(title):
    """规则分类: 基于关键词匹配打标签 (免费, 无AI)"""
    tags = []
    for tag_name, keywords in TAG_KEYWORDS.items():
        for kw in keywords:
            if kw in title:
                tags.append(tag_name)
                break
    return tags


def ai_classify(item, api_key):
    """AI分类: 调用SiliconFlow API进行精确标签分类"""
    title = item.get("标题", "")
    buyer = item.get("采购人", "")
    amount = item.get("中标金额(万)", "")
    supplier = item.get("供应商", "")

    input_text = f"""
项目标题: {title}
采购人: {buyer}
供应商: {supplier}
中标金额: {amount}万元

请对上述中标项目进行分类。从以下12个类别中选择所有匹配的标签:
三维扫描, 摄影测量, 数字归档, GIS制图, 数字孪生, 虚拟展陈,
AR/VR/MR, AI应用, 藏品管理, 文化遗产数据库, 智慧博物馆, 数字保护

返回JSON格式:
{{
  "tags": ["标签1", "标签2"],
  "confidence": "high/medium/low",
  "reason": "分类依据(简短)"
}}

只返回JSON, 不要任何其他文字。
"""
    if len(input_text) > MAX_INPUT_CHARS:
        input_text = input_text[:MAX_INPUT_CHARS]

    for attempt in range(MAX_RETRIES):
        try:
            payload = json.dumps({
                "model": MODEL,
                "messages": [
                    {"role": "system", "content": "你是文物数字化领域的专业分类助手。只返回JSON。"},
                    {"role": "user", "content": input_text}
                ],
                "max_tokens": 400,
                "temperature": 0.1
            }).encode("utf-8")

            req = urllib.request.Request(API_URL, data=payload, method="POST")
            req.add_header("Authorization", f"Bearer {api_key}")
            req.add_header("Content-Type", "application/json")

            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                content = result.get("choices", [{}])[0].get("message", {}).get("content", "{}")

            # 尝试从AI回复中提取JSON
            json_start = content.find("{")
            json_end = content.rfind("}") + 1
            if json_start >= 0 and json_end > json_start:
                parsed = json.loads(content[json_start:json_end])
                tags = parsed.get("tags", [])
                confidence = parsed.get("confidence", "medium")
                reason = parsed.get("reason", "")
                # 验证标签有效性
                valid_tags = [t for t in tags if t in TAG_DEFINITIONS]
                return valid_tags, confidence, reason
        except Exception as e:
            err = str(e)[:80]
            if attempt < MAX_RETRIES - 1:
                wait = RETRY_DELAY * (attempt + 1)
                log(f"    AI重试({attempt+1}/{MAX_RETRIES}): {err}, 等待{wait}s...")
                time.sleep(wait)
            else:
                log(f"    AI失败: {err}")
    return [], "", ""


def classify_items(items, api_key="", rules_only=False, high_value_only=False):
    """分类主函数"""
    classified = []
    ai_count = 0
    rule_count = 0

    for i, item in enumerate(items, 1):
        title = item.get("标题", "")
        amount_str = item.get("中标金额(万)", "")
        try:
            amount_val = float(amount_str) if amount_str else 0
        except (ValueError, TypeError):
            amount_val = 0

        # 决策: AI分类 vs 规则分类
        use_ai = False
        if not rules_only:
            if high_value_only:
                use_ai = amount_val >= HIGH_VALUE_THRESHOLD
            else:
                use_ai = True  # 全量AI

        if use_ai and api_key:
            tags, confidence, reason = ai_classify(item, api_key)
            classified_by = "ai"
            ai_count += 1
        else:
            tags = rule_classify(title)
            confidence = "medium" if tags else "low"
            reason = "规则关键词匹配" if tags else ""
            classified_by = "rule"
            rule_count += 1

        new_item = dict(item)
        new_item["tags"] = tags
        new_item["tag_confidence"] = confidence if tags else ""
        new_item["tag_reason"] = reason
        new_item["classified_by"] = classified_by
        classified.append(new_item)

        if i % 20 == 0 or i == len(items):
            log(f"  [{i}/{len(items)}] 分类完成 (AI:{ai_count}, 规则:{rule_count})")

    return classified


def run(input_path, output_path, api_key="", rules_only=False, high_value_only=False):
    """CLI入口"""
    if not os.path.exists(input_path):
        log(f"[ERROR] 输入文件不存在: {input_path}")
        return

    with open(input_path, "r", encoding="utf-8-sig") as f:
        items = list(csv.DictReader(f))

    log(f"[*] 分类: {len(items)} 条项目")
    log(f"    模式: {'仅规则' if rules_only else ('高价值AI+(≥{HIGH_VALUE_THRESHOLD}万)' if high_value_only else '全量AI+规则兜底')}")

    t0 = time.time()
    classified = classify_items(items, api_key, rules_only, high_value_only)

    # 确保tags字段存在
    fieldnames = list(items[0].keys()) if items else []
    for f in ["tags", "tag_confidence", "tag_reason", "classified_by"]:
        if f not in fieldnames:
            fieldnames.append(f)

    with open(output_path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(classified)

    ai_count = sum(1 for c in classified if c.get("classified_by") == "ai")
    rule_count = sum(1 for c in classified if c.get("classified_by") == "rule")
    tagged = sum(1 for c in classified if c.get("tags"))
    log(f"\n[*] 分类完成: {len(classified)} 条 (AI:{ai_count}, 规则:{rule_count}, 有标签:{tagged}) 耗时{time.time()-t0:.0f}s")
    log(f"    输出: {output_path}")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="AI分类器 — heritage-analysis")
    p.add_argument("--input", required=True, help="输入CSV路径")
    p.add_argument("--output", required=True, help="输出CSV路径")
    p.add_argument("--rules-only", action="store_true", help="仅规则分类(无AI,免费)")
    p.add_argument("--high-value-only", action="store_true", help="仅高价值项目(≥50万)用AI")
    args = p.parse_args()

    api_key = os.environ.get("SILICONFLOW_API_KEY", "")
    if not args.rules_only and not api_key:
        log("[!] SILICONFLOW_API_KEY 未设置, 将使用规则分类")

    run(args.input, args.output, api_key, args.rules_only, args.high_value_only)
