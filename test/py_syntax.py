# -*- coding: utf-8 -*-
"""只读语法检查：ast.parse 三个 Python 文件，不做任何写操作。"""
import ast
from pathlib import Path

ROOT = Path(__file__).parent.parent
for name in ("install.py", "patch_install.py", "taskq.py", "tools/gen_fixture.py",
             "tools/asar_grep.py", "tools/asar_ctx.py"):
    src = (ROOT / name).read_text(encoding="utf-8")
    ast.parse(src, filename=name)
    print(name, "语法 OK")
