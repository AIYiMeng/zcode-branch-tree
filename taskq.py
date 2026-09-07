# -*- coding: utf-8 -*-
"""zcode-branch-tree 任务查询层：只读 ~/.zcode/cli/db/db.sqlite，输出任务/项目数据。

模式：
  serve   常驻进程，stdin 每行一个请求 {"op":"tree"}，stdout 单行 JSON 应答
          （照抄 zcode-token-usage-statusbar 的常驻行协议模式，MIT）。
  dump    把 tree 数据以 JSON 写到 stdout（生成 demo fixture 用）。

数据口径：
- session 表：id / parent_id（任务分叉父子）/ project_id / directory（项目目录）/
  title / task_type（interactive=主线、fork=分叉）/ time_created / time_updated /
  summary_additions / summary_deletions / summary_files（代码变更统计）。
- model_usage 按会话聚合请求数与 token；turn_usage 按会话聚合轮数。
- 已归档（time_archived 非空）的任务不计入。

全程只读（mode=ro），不联网。
"""
import json
import re
import sqlite3
import sys
from pathlib import Path

DB = Path.home() / ".zcode" / "cli" / "db" / "db.sqlite"
V2_TASKS = Path.home() / ".zcode" / "v2" / "tasks-index.sqlite"   # 桌面端任务索引（状态/未读/置顶）

_TEXT_RE = re.compile(r'"text"\s*:\s*"((?:[^"\\]|\\.)*)"')


def _unquote(s, limit=160):
    """把 JSON 字符串字面量（可能被 substr 截断）安全解出文本。"""
    if not s:
        return ""
    for cut in (len(s), len(s) - 2, len(s) - 6):
        if cut <= 0:
            return ""
        try:
            v = json.loads('"' + s[:cut] + '"')
            if isinstance(v, str):
                v = " ".join(v.split())   # 压掉换行与多余空白
                return v[:limit]
        except ValueError:
            continue
    return ""


def first_user_texts(con, sids, limit=160):
    """每个会话第一条用户消息的文本（分支语句/任务最初输入）。
    message.data 开头即 role，substr 头部即可判别；正文在 part 表（type:text）。"""
    if not sids:
        return {}
    qm = ",".join("?" * len(sids))
    first_user_mid = {}
    for r in con.execute(
        f"select session_id sid, id mid, substr(data,1,60) head from message"
        f" where session_id in ({qm}) order by session_id, sequence", sids
    ):
        if r["sid"] in first_user_mid:
            continue
        if '"role":"user"' in (r["head"] or ""):
            first_user_mid[r["sid"]] = r["mid"]
    if not first_user_mid:
        return {}
    mids = list(first_user_mid.values())
    qm2 = ",".join("?" * len(mids))
    sid_by_mid = {v: k for k, v in first_user_mid.items()}
    out = {}
    for r in con.execute(
        f"select message_id mid, substr(data,1,800) head from part"
        f" where message_id in ({qm2}) order by message_id, sequence", mids
    ):
        sid = sid_by_mid.get(r["mid"])
        if sid is None or sid in out:
            continue
        m = _TEXT_RE.search(r["head"] or "")
        if not m:
            continue
        t = _unquote(m.group(1), limit)
        if t:
            out[sid] = t
    return out


def connect():
    if not DB.is_file():
        raise FileNotFoundError(f"未找到 {DB}")
    # 只读打开；确认文件存在再连，避免 sqlite 新建空库
    return sqlite3.connect(f"file:{DB.as_posix()}?mode=ro", uri=True, timeout=3)


def task_status_map():
    """桌面端任务索引：task_id → {st(运行态), unread, pin, arch}。库缺失时返回空。"""
    out = {}
    if not V2_TASKS.is_file():
        return out
    try:
        con = sqlite3.connect(f"file:{V2_TASKS.as_posix()}?mode=ro", uri=True, timeout=3)
        con.row_factory = sqlite3.Row
        try:
            for r in con.execute(
                "select task_id, task_status, unread_at, pinned, archived from tasks"
            ):
                out[r["task_id"]] = {
                    "st": r["task_status"] or "",
                    "unread": 1 if r["unread_at"] else 0,
                    "pin": 1 if r["pinned"] else 0,
                    "arch": 1 if r["archived"] else 0,
                }
        finally:
            con.close()
    except sqlite3.Error:
        pass
    return out


def tree(max_sessions=500):
    con = connect()
    try:
        con.row_factory = sqlite3.Row
        sessions = []
        for r in con.execute(
            "select id, parent_id, project_id, directory, title, task_type,"
            " time_created, time_updated, summary_additions, summary_deletions, summary_files"
            " from session where time_archived is null"
            " order by time_created desc limit ?", (int(max_sessions),)
        ):
            sessions.append({
                "id": r["id"],
                "pid": r["parent_id"],
                "proj": r["project_id"],
                "dir": r["directory"] or "",
                "title": (r["title"] or "").strip() or "(未命名任务)",
                "tt": r["task_type"] or "interactive",
                "tc": r["time_created"],
                "tu": r["time_updated"],
                "add": r["summary_additions"],
                "del": r["summary_deletions"],
                "files": r["summary_files"],
            })
        # 项目目录（按 project_id 取任一行的 directory）
        proj_dir = {}
        for s in sessions:
            proj_dir.setdefault(s["proj"], s["dir"])
        # 用量聚合（只聚合取到的会话，控制体积）
        ids = [s["id"] for s in sessions]
        usage = {}
        if ids:
            qmarks = ",".join("?" * len(ids))
            for r in con.execute(
                f"select session_id sid, count(*) reqs, sum(computed_total_tokens) tok"
                f" from model_usage where session_id in ({qmarks}) group by session_id", ids
            ):
                usage[r["sid"]] = {"reqs": r["reqs"], "tok": r["tok"] or 0}
            for r in con.execute(
                f"select session_id sid, count(*) n from turn_usage"
                f" where session_id in ({qmarks}) group by session_id", ids
            ):
                usage.setdefault(r["sid"], {})
                usage[r["sid"]]["turns"] = r["n"]
        for s in sessions:
            u = usage.get(s["id"]) or {}
            s["reqs"] = u.get("reqs") or 0
            s["tok"] = u.get("tok") or 0
            s["turns"] = u.get("turns") or 0
        firsts = first_user_texts(con, [s["id"] for s in sessions])
        stmap = task_status_map()
        for s in sessions:
            s["first"] = firsts.get(s["id"], "")
            st = stmap.get(s["id"]) or {}
            s["st"] = st.get("st", "")            # running / completed / error（空=未知）
            s["unread"] = st.get("unread", 0)     # 客户端自己的未读标记
            s["pin"] = st.get("pin", 0)
            s["arch"] = st.get("arch", 0)
        projects = []
        for pid, d in proj_dir.items():
            n = sum(1 for s in sessions if s["proj"] == pid)
            latest = max((s["tu"] or 0) for s in sessions if s["proj"] == pid)
            projects.append({"proj": pid, "dir": d, "name": (d or pid).replace("\\", "/").split("/")[-1] or pid,
                             "n": n, "latest": latest})
        projects.sort(key=lambda p: -(p["latest"] or 0))
        return {"projects": projects, "sessions": sessions, "truncated": len(sessions) >= int(max_sessions)}
    finally:
        con.close()


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "dump":
        data = tree(int(sys.argv[2]) if len(sys.argv) > 2 else 500)
        print(json.dumps(data, ensure_ascii=False, indent=1))
        return 0
    # serve：行协议
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            req = {"op": "tree"}
        if req.get("op") == "tree":
            try:
                out = dict(tree(int(req.get("max") or 500)))
                out["ok"] = True
            except Exception as e:  # noqa: BLE001
                out = {"ok": False, "error": str(e)}
        elif req.get("op") == "ping":
            out = {"ok": True, "pong": True}
        else:
            out = {"ok": False, "error": "unknown op"}
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
