#!/usr/bin/env python3
"""HoneyComb v0.1 · 演示数据种子（全是编的，跟任何人的真实安排无关）。

用法（先把栈起起来）：

    docker compose up -d
    python3 seed/seed_demo.py                       # 默认打 http://127.0.0.1:8800
    python3 seed/seed_demo.py --base http://其他地址  # 换入口

做三件事：
  1. 建 4 个分区、9 个项目、若干任务；
  2. 用 /api/core/timer/backfill 给过去 14 天补一批"已经干过"的时间段，
     这样蜂巢的热度、分区规划面板的投入统计、计时档案一打开就有东西看；
  3. 幂等：同名的分区/项目/任务已存在就跳过，重复跑不会翻倍。

只用标准库，不装任何依赖。
"""
from __future__ import annotations

import argparse
import json
import random
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

ZONES = ["生活", "工作", "学习", "健康"]

# (项目, 分区, [任务…])
PROJECTS = [
    ("做家务",     "生活", ["洗碗", "收拾屋子", "扔垃圾"]),
    ("做饭",       "生活", ["备菜", "煮晚饭"]),
    ("做报表",     "工作", ["拉上月数据", "对账", "写结论"]),
    ("客户跟进",   "工作", ["回邮件", "整理需求"]),
    ("周会准备",   "工作", ["写提纲"]),
    ("读书",       "学习", ["读《深度工作》", "做读书笔记"]),
    ("学吉他",     "学习", ["练音阶", "练一首完整的"]),
    ("跑步",       "健康", ["热身", "五公里"]),
    ("睡眠调整",   "健康", ["十一点前上床"]),
]

# 补登用：(项目, 任务, 大致每次分钟数, 过去 14 天里做几次)
SESSIONS = [
    ("做家务", "收拾屋子", 35, 5),
    ("做家务", "洗碗",     12, 9),
    ("做报表", "对账",     50, 4),
    ("做报表", "拉上月数据", 25, 3),
    ("读书",   "读《深度工作》", 40, 6),
    ("学吉他", "练音阶",   20, 4),
    ("跑步",   "五公里",   30, 5),
    ("做饭",   "煮晚饭",   45, 7),
]


# 直连，不走环境里的 http_proxy：入口通常是 127.0.0.1，代理会把它变成 502。
# （踩过：机器上设了全局代理，种子脚本第一跑就 502。）
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(base: str, path: str, method: str = "GET", body: dict | None = None):
    url = base.rstrip("/") + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with _OPENER.open(req, timeout=15) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:200]
        raise SystemExit(f"[{method} {path}] HTTP {e.code}: {detail}") from None
    except urllib.error.URLError as e:
        raise SystemExit(f"连不上 {url}：{e.reason}\n先确认 `docker compose up -d` 起来了。") from None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8800", help="入口地址")
    ap.add_argument("--seed", type=int, default=20260914, help="随机种子，保证可复现")
    args = ap.parse_args()
    rnd = random.Random(args.seed)

    tree = api(args.base, "/api/core/views/tree")
    zone_id = {z["name"]: z["id"] for z in tree.get("zones", [])}
    proj_id = {p["name"]: p["id"] for p in tree.get("projects", [])}

    for name in ZONES:
        if name in zone_id:
            continue
        zone_id[name] = api(args.base, "/api/core/planner/zones", "POST", {"name": name})["id"]
        print("建分区", name)

    task_id: dict[tuple[str, str], str] = {}
    for pname, zname, tasks in PROJECTS:
        if pname not in proj_id:
            proj_id[pname] = api(args.base, "/api/core/planner/projects", "POST",
                                 {"zoneId": zone_id[zname], "name": pname})["id"]
            print("  建项目", pname)
        existing = {t["name"]: t["id"]
                    for p in api(args.base, "/api/core/views/tree").get("projects", [])
                    if p["id"] == proj_id[pname] for t in p.get("tasks", [])}
        for tname in tasks:
            if tname in existing:
                task_id[(pname, tname)] = existing[tname]
                continue
            tid = api(args.base, "/api/core/planner/tasks", "POST",
                      {"projectId": proj_id[pname], "name": tname})["id"]
            task_id[(pname, tname)] = tid
            print("    建任务", tname)

    # 过去 14 天的"已经干过"。补登是契约里的正式入口，写进的是真事件，
    # 和手动计时出来的段落同一种东西 —— 演示数据也就不会是"假的一层皮"。
    now = datetime.now(timezone.utc).astimezone()
    made = 0
    for pname, tname, minutes, times in SESSIONS:
        tid = task_id.get((pname, tname))
        if not tid:
            continue
        for _ in range(times):
            day = rnd.randint(0, 13)
            start = (now - timedelta(days=day)).replace(
                hour=rnd.randint(8, 21), minute=rnd.choice([0, 10, 20, 30, 40, 50]),
                second=0, microsecond=0)
            dur = int(minutes * rnd.uniform(0.6, 1.4)) * 60
            api(args.base, "/api/core/timer/backfill", "POST",
                {"taskId": tid, "startAt": start.isoformat(), "durationSeconds": dur})
            made += 1
    print(f"补登 {made} 段历史记录")
    print("完成。打开", args.base, "看看。")


if __name__ == "__main__":
    main()
