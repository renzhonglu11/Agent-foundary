#!/usr/bin/env python3
import os
import sys
import json
from pathlib import Path
import sqlite3
import subprocess
import shutil
from datetime import datetime, timezone

REPOS_DIR = Path(os.environ.get("AGENT_FOUNDRY_ROOT", Path(__file__).resolve().parents[4]))
DB_PATH = REPOS_DIR / "data/agent_foundry.db"
OUTPUT_PATH = REPOS_DIR / "data/macro-analysis.json"
# Use environment variable or default system path for hermes
HERMES_PATH = os.environ.get("HERMES_PATH", os.path.expanduser("~/.local/bin/hermes"))
HERMES_MODEL = os.environ.get("AGENT_FOUNDRY_MACRO_HERMES_MODEL", "gpt-6-luna")

def get_latest_macro_data():
    """Reads FRED data cache from SQLite."""
    if not DB_PATH.exists():
        print(f"Database not found at {DB_PATH}")
        return None

    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT payload_json FROM fred_macro_data_cache WHERE cache_key = 'macro_data'"
        )
        row = cursor.fetchone()
        conn.close()

        if not row:
            print("No 'macro_data' cache found in database.")
            return None

        payload = json.loads(row[0])
        return payload
    except Exception as e:
        print(f"Error querying SQLite database: {e}")
        return None

def hermes_available():
    if os.path.sep in HERMES_PATH:
        return os.path.isfile(HERMES_PATH) and os.access(HERMES_PATH, os.X_OK)
    return shutil.which(HERMES_PATH) is not None

def write_output(final_output):
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    try:
        with OUTPUT_PATH.open("w", encoding="utf-8") as f:
            json.dump(final_output, f, ensure_ascii=False, indent=2)
        print(f"Successfully generated and wrote final payload to: {OUTPUT_PATH}")
    except Exception as e:
        print(f"Error writing output file: {e}")
        sys.exit(1)

def extract_key_indicators(payload):
    """Extracts key FRED macroeconomic observations."""
    if not payload or "series" not in payload:
        return {}

    series_map = {s["id"]: s for s in payload["series"]}
    indicators = {}

    for series_id in ["FEDFUNDS", "T10Y2Y", "CPI_YOY", "DGS10", "UNRATE", "GDPC1", "PAYEMS"]:
        series = series_map.get(series_id)
        if series and series.get("observations"):
            # Sort by date to ensure the latest is last
            sorted_obs = sorted(series["observations"], key=lambda o: o["date"])
            latest = sorted_obs[-1]
            indicators[series_id] = {
                "date": latest["date"],
                "value": latest["value"]
            }
        else:
            indicators[series_id] = None

    return indicators


def run_hermes_analysis(indicators):
    """Assembles prompt and invokes hermes oneshot mode to perform economic reasoning."""
    print("Invoking Hermes CLI oneshot to run AI macroeconomic analysis...")
    
    # Format current macro conditions into the prompt
    cpi = indicators.get("CPI_YOY")
    fedfunds = indicators.get("FEDFUNDS")
    yield_spread = indicators.get("T10Y2Y")
    dgs10 = indicators.get("DGS10")
    unrate = indicators.get("UNRATE")
    gdp = indicators.get("GDPC1")
    payems = indicators.get("PAYEMS")

    macro_text = f"""
- 联邦基金利率 (Fed Funds Rate): {fedfunds['value'] if fedfunds else 'N/A'}% (最新日期: {fedfunds['date'] if fedfunds else 'N/A'})
- CPI 年率 (YoY Inflation): {cpi['value'] if cpi else 'N/A'}% (最新日期: {cpi['date'] if cpi else 'N/A'})
- 10Y-2Y 国债利差 (10Y-2Y Spread): {yield_spread['value'] if yield_spread else 'N/A'}% (最新日期: {yield_spread['date'] if yield_spread else 'N/A'})
- 10年期国债收益率 (10Y Yield): {dgs10['value'] if dgs10 else 'N/A'}% (最新日期: {dgs10['date'] if dgs10 else 'N/A'})
- 失业率 (Unemployment Rate): {unrate['value'] if unrate else 'N/A'}% (最新日期: {unrate['date'] if unrate else 'N/A'})
- 非农就业人数 (Nonfarm Payrolls): {payems['value'] if payems else 'N/A'} 千人 (最新日期: {payems['date'] if payems else 'N/A'})
- 实际GDP (Real GDP Index): {gdp['value'] if gdp else 'N/A'}B (最新日期: {gdp['date'] if gdp else 'N/A'})
"""

    prompt = f"""你会收到以下最新的美国宏观经济指标：
{macro_text}

任务：
作为专业的资深宏观经济策略分析师，请根据当前的利率、通胀、国债收益率、失业率、非农就业人数和实际 GDP 情况，生成：
1. 一段客观、深刻且富含专业洞察力的整体宏观经济点评 (summary_commentary)，字数为 3-5 句自然中文，指明当前市场处于周期的什么阶段、美联储下一步政策导向以及对风险资产的整体影响。
2. 针对以下四个核心板块的价值重估分析与配置建议 (sectors)：
   - 🚀 高科技 & 成长板块 (Tech & Growth)
   - 🏦 银行 & 金融板块 (Financials)
   - 🔌 公用事业 & 房托地产 (Utilities & REITs)
   - 🛢️ 能源 & 大宗商品 (Energy & Materials)
   为每个板块生成对应的“影响”(impact，例如：负面 / 压制估值、中性偏正面、正面抗通胀等)、“原因”(reason) 和“配置建议”(suggestion)。

请严格以一个合法的单体 JSON 对象返回，不要输出任何 MarkDown 格式标记（如不要用 ```json 包裹，也不要有任何行前文字说明），确保可以直接用 json.loads 解析。

JSON 格式要求：
{{
  "summary_commentary": "整体点评文字...",
  "sectors": [
    {{
      "title": "🚀 高科技 & 成长板块 (Tech & Growth)",
      "impact": "影响判定...",
      "reason": "板块估值受当前宏观指标（如折现率、借贷成本）变动影响的具体逻辑...",
      "suggestion": "具体的买入、避险或观望操作建议..."
    }},
    {{
      "title": "🏦 银行 & 金融板块 (Financials)",
      "impact": "影响判定...",
      "reason": "加息/降息利差、收益率曲线倒挂/平缓对金融行业的具体逻辑...",
      "suggestion": "操作建议..."
    }},
    {{
      "title": "🔌 公用事业 & 房托地产 (Utilities & REITs)",
      "impact": "影响判定...",
      "reason": "无风险收益率上升对派息股分流，以及杠杆资金成本的影响...",
      "suggestion": "操作建议..."
    }},
    {{
      "title": "🛢️ 能源 & 大宗商品 (Energy & Materials)",
      "impact": "影响判定...",
      "reason": "通胀对冲属性或经济衰退对其需求侧的逻辑关系...",
      "suggestion": "操作建议..."
    }}
  ]
}}
"""

    try:
        cmd = [HERMES_PATH, "-m", HERMES_MODEL, "-z", prompt]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=True,
            env={**os.environ, "HERMES_REASONING_EFFORT": "high"},
        )
        stdout = result.stdout.strip()
        
        # Robust parsing of JSON response
        # Clean any accidental Markdown block wrapping
        if stdout.startswith("```"):
            lines = stdout.splitlines()
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            stdout = "\n".join(lines).strip()
            
        ai_data = json.loads(stdout)
        
        # Validate keys
        if "summary_commentary" in ai_data and "sectors" in ai_data:
            return ai_data
        else:
            print("Warning: LLM returned JSON missing required keys.")
            return None
    except Exception as e:
        print(f"Error during Hermes LLM invocation or parsing: {e}")
        if 'result' in locals() and result.stderr:
            print(f"Hermes stderr: {result.stderr}")
        return None

def main():
    print(f"--- Macro economic generator run starting at {datetime.now().isoformat()} ---")
    
    # 1. Fetch macro data from database cache
    payload = get_latest_macro_data()
    if not payload:
        print("FRED Macro data cache is completely empty. Aborting.")
        sys.exit(1)

    indicators = extract_key_indicators(payload)
    if not indicators:
        print("Failed to parse essential macroeconomic indicators. Aborting.")
        sys.exit(1)

    if not hermes_available():
        print(f"Hermes executable not available at {HERMES_PATH}. Writing macro payload without AI commentary.")
        write_output({
            "analysis_date": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "ai_commentary_available": False,
            "ai_commentary_unavailable_reason": "Hermes executable is not available in this environment",
            "raw_indicators": indicators
        })
        print("--- Macro economic generator run completed without AI commentary ---")
        return

    # 2. Check for difference against last generated results
    skip_llm = False
    previous_data = None
    if OUTPUT_PATH.exists():
        try:
            with OUTPUT_PATH.open("r", encoding="utf-8") as f:
                previous_data = json.load(f)
            
            # Compare indicator values
            prev_indicators = previous_data.get("raw_indicators", {})
            
            match = True
            for k, v in indicators.items():
                prev_v = prev_indicators.get(k)
                if not prev_v or not v:
                    match = False
                    break
                if abs(float(v["value"]) - float(prev_v["value"])) > 0.0001:
                    match = False
                    break
            
            if match:
                skip_llm = True
                print("FRED Macroeconomic observations match previous values perfectly. Skipping LLM generation.")
        except Exception as e:
            print(f"Could not read previous analysis for smart-check diff: {e}")


    # 4. Generate macro commentary and sectors impact guide
    used_cache = False
    if skip_llm and previous_data and "sectors" in previous_data and "summary_commentary" in previous_data:
        print("Using cached AI analysis...")
        summary_commentary = previous_data["summary_commentary"]
        sectors = previous_data["sectors"]
        analysis_date = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        used_cache = True
    else:
        ai_payload = run_hermes_analysis(indicators)
        if ai_payload:
            summary_commentary = ai_payload["summary_commentary"]
            sectors = ai_payload["sectors"]
            analysis_date = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        elif previous_data and "sectors" in previous_data and "summary_commentary" in previous_data:
            print("Warning: LLM call failed. Falling back to previous cached AI analysis.")
            summary_commentary = previous_data["summary_commentary"]
            sectors = previous_data["sectors"]
            analysis_date = previous_data.get("analysis_date", datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"))
            used_cache = True
        else:
            print("Warning: LLM call failed and no previous cache exists. Writing macro payload without AI commentary.")
            write_output({
                "analysis_date": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "ai_commentary_available": False,
                "ai_commentary_unavailable_reason": "Hermes LLM invocation failed",
                "raw_indicators": indicators,
                "used_cache": False
            })
            print("--- Macro economic generator run completed without AI commentary ---")
            return

    # 5. Build combined JSON output
    final_output = {
        "analysis_date": analysis_date,
        "ai_commentary_available": True,
        "summary_commentary": summary_commentary,
        "sectors": sectors,
        "raw_indicators": indicators,
        "used_cache": used_cache
    }

    write_output(final_output)

    print("--- Macro economic generator run successfully completed ---")

if __name__ == "__main__":
    main()
