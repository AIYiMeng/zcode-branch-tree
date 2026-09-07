# -*- coding: utf-8 -*-
"""只读 asar 内存检索：不落盘，在 app.asar 内的 JS/HTML 里找字符串。
用法：python tools/asar_grep.py <pattern1> [pattern2 ...]
（asar 读取机制借自 zcode-token-usage-statusbar patch_install.py，MIT。仅只读检索。）
"""
import json as _json
import os
import re
import struct
import sys
from pathlib import Path

ASAR = Path(os.environ.get("ZCODE_ASAR", r"D:\ZCode\resources\app.asar"))


def read_header(f):
    f.seek(0)
    a, b, c, d = struct.unpack("<4I", f.read(16))
    assert a == 4, f"unexpected pickle prefix {a}"
    return _json.loads(f.read(d)), 8 + b


def iter_files(node, path=""):
    for name, ch in node.get("files", {}).items():
        p = f"{path}/{name}"
        if "files" in ch:
            yield from iter_files(ch, p)
        else:
            yield p, ch


def main():
    pats = [re.compile(p.encode()) for p in sys.argv[1:]]
    if not pats:
        print(__doc__)
        return 2
    total = 0
    with open(ASAR, "rb") as f:
        header, base = read_header(f)
        for p, node in iter_files(header):
            if node.get("unpacked"):
                continue
            if not re.search(r"\.(js|cjs|mjs|html|json)$", p):
                continue
            size = node["size"]
            if size > 60 * 1024 * 1024:
                continue
            f.seek(base + int(node["offset"]))
            data = f.read(size)
            for pat in pats:
                hits = list(pat.finditer(data))[:6]
                for m in hits:
                    s = max(0, m.start() - 90)
                    ctx = data[s:m.end() + 90].decode("utf-8", "replace").replace("\n", "\\n")
                    print(f"[{p}] {pat.pattern.decode()}: …{ctx}…")
                    total += 1
                    if total > 120:
                        print("…（截断）")
                        return 0
    print(f"--- 共 {total} 处命中 ---")
    return 0


if __name__ == "__main__":
    sys.exit(main())
