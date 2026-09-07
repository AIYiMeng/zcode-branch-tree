# -*- coding: utf-8 -*-
"""生成合成（非真实）任务数据 fixture，用于 README 配图与公开演示。
内容全部为虚构，不含任何真实任务信息。
用法：python tools/gen_demo_fixture.py   （写 demo/fixture.js / demo/fixture.json）
"""
import json
import time
from pathlib import Path

NOW = int(time.time() * 1000)
H = 3600 * 1000
D = 24 * H


def t(hours_ago):
    return NOW - int(hours_ago * H)


def mk(sid, proj, directory, title, tt, tc, tu, pid=None, st="completed",
       unread=0, first="", add=None, dele=None, files=None, turns=3, reqs=8, tok=52340, pin=0):
    return {
        "id": sid, "pid": pid, "proj": proj, "dir": directory, "title": title, "tt": tt,
        "tc": tc, "tu": tu, "add": add, "del": dele, "files": files,
        "st": st, "unread": unread, "pin": pin, "arch": 0,
        "first": first, "turns": turns, "reqs": reqs, "tok": tok,
    }


P1 = "proj_e-demo-mall"
P2 = "proj_e-demo-blog"
P3 = "proj_e-demo-spider"

sessions = [
    # 示例商城：主线 + 两个分叉（其中一个又分叉）
    mk("sess_demo_mall_root", P1, "E:\\demo\\mall", "修复登录超时问题", "interactive", t(50), t(48),
       first="线上登录接口偶尔超时 30 秒，帮我排查一下原因并修复。", add=142, dele=36, files=6, turns=9, reqs=24, tok=386000),
    mk("sess_demo_mall_f1", P1, "E:\\demo\\mall", "优化登录接口性能", "fork", t(47), t(46), pid="sess_demo_mall_root",
       unread=1, first="从这里分叉：把登录接口的数据库查询改成缓存，压测对比性能。", add=210, dele=12, files=4, turns=6, reqs=15, tok=264000),
    mk("sess_demo_mall_f1a", P1, "E:\\demo\\mall", "缓存雪崩防护", "fork", t(44), t(43), pid="sess_demo_mall_f1",
       first="从这里分叉：给缓存加上随机过期和互斥重建，防止雪崩。", add=88, dele=5, files=2, turns=4, reqs=9, tok=121000),
    mk("sess_demo_mall_f2", P1, "E:\\demo\\mall", "排查验证码发送失败", "fork", t(40), t(38), pid="sess_demo_mall_root",
       first="从这里分叉：用户反馈收不到验证码，查一下短信通道日志。", add=64, dele=21, files=3, turns=5, reqs=11, tok=178000),
    mk("sess_demo_mall_root2", P1, "E:\\demo\\mall", "重构订单结算流程", "interactive", t(30), t(28),
       first="订单结算代码太乱了，按策略模式重构一下，保持行为不变。", add=512, dele=298, files=14, turns=12, reqs=31, tok=690000),
    mk("sess_demo_mall_running", P1, "E:\\demo\\mall", "给结算加上优惠券分摊", "fork", t(1.2), t(0.1), pid="sess_demo_mall_root2",
       st="running", first="从这里分叉：结算时把优惠金额按商品行分摊，写完补测试。", turns=2, reqs=5, tok=81000),
    # 个人博客
    mk("sess_demo_blog_root", P2, "E:\\demo\\blog", "写一键部署脚本", "interactive", t(26), t(25),
       first="帮我把博客部署写成一条命令：构建、上传、刷新 CDN。", add=120, dele=8, files=2, turns=3, reqs=7, tok=95000),
    mk("sess_demo_blog_f1", P2, "E:\\demo\\blog", "改成 Docker 部署", "fork", t(24), t(20), pid="sess_demo_blog_root",
       unread=1, first="从这里分叉：部署脚本改成 docker compose，数据库也容器化。", add=180, dele=40, files=5, turns=7, reqs=16, tok=230000),
    mk("sess_demo_blog_root2", P2, "E:\\demo\\blog", "评论系统接入", "interactive", t(9), t(8), pin=1,
       first="接一个评论系统，支持 GitHub 登录评论，垃圾评论自动过滤。", add=96, dele=4, files=4, turns=5, reqs=12, tok=140000),
    # 爬虫工具
    mk("sess_demo_sp_root", P3, "E:\\demo\\spider", "商品价格监控爬虫", "interactive", t(72), t(70),
       first="写个爬虫每天抓一次价格，变动超过 5% 就发通知。", add=260, dele=15, files=3, turns=8, reqs=19, tok=310000),
    mk("sess_demo_sp_f1", P3, "E:\\demo\\spider", "反爬对抗：IP 池", "fork", t(68), t(60), pid="sess_demo_sp_root",
       first="从这里分叉：目标站上了反爬，加代理 IP 池和随机 UA。", add=140, dele=22, files=3, turns=6, reqs=13, tok=202000),
    mk("sess_demo_sp_f2", P3, "E:\\demo\\spider", "失败重试与告警", "fork", t(66), t(65), pid="sess_demo_sp_root",
       first="从这里分叉：抓取失败自动重试三次，连续失败发告警。", add=75, dele=10, files=2, turns=4, reqs=8, tok=118000),
]

projects = []
for pid, d, n in ((P1, "E:\\demo\\mall", "mall"), (P2, "E:\\demo\\blog", "blog"), (P3, "E:\\demo\\spider", "spider")):
    ss = [s for s in sessions if s["proj"] == pid]
    projects.append({"proj": pid, "dir": d, "name": n, "n": len(ss),
                     "latest": max(s["tu"] for s in ss)})
projects.sort(key=lambda p: -p["latest"])

data = {"projects": projects, "sessions": sessions, "truncated": False}


def main():
    out = Path(__file__).parent.parent / "demo"
    out.mkdir(parents=True, exist_ok=True)
    (out / "fixture.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "fixture.js").write_text(
        "window.__BTREE_FIXTURE = " + json.dumps(data, ensure_ascii=False) + ";\n", encoding="utf-8")
    print(f"OK 合成数据 projects={len(projects)} sessions={len(sessions)}")


if __name__ == "__main__":
    main()
