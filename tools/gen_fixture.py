# -*- coding: utf-8 -*-
"""从 ZCode 真实任务库生成 demo/测试 fixture（调用 taskq.tree，只读）。
输出：demo/fixture.json（纯 JSON，测试用）与 demo/fixture.js（demo 页用）。
用法：python tools/gen_fixture.py [max_sessions]
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
import taskq  # noqa: E402


def main():
    mx = int(sys.argv[1]) if len(sys.argv) > 1 else 300
    data = taskq.tree(mx)
    out_dir = Path(__file__).parent.parent / "demo"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "fixture.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    (out_dir / "fixture.js").write_text(
        "window.__BTREE_FIXTURE = " + json.dumps(data, ensure_ascii=False) + ";\n", encoding="utf-8")
    print(f"OK projects={len(data['projects'])} sessions={len(data['sessions'])} -> demo/fixture.json demo/fixture.js")


if __name__ == "__main__":
    main()
