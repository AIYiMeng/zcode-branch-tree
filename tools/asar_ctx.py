# -*- coding: utf-8 -*-
r"""只读 asar 片段查看：定位模式命中，打印前后 ±N 字节的上下文到 stdout（不落盘）。
用法：python tools/asar_ctx.py <pattern> [file_filter] [span]
例：python tools/asar_ctx.py 'exposeInMainWorld\("zcode",' 'preload/index' 2600
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
    pat = re.compile(sys.argv[1].encode())
    filt = sys.argv[2] if len(sys.argv) > 2 else ""
    span = int(sys.argv[3]) if len(sys.argv) > 3 else 1200
    shown = 0
    with open(ASAR, "rb") as f:
        header, base = read_header(f)
        for p, node in iter_files(header):
            if node.get("unpacked") or not p.endswith((".js", ".cjs", ".mjs", ".html")):
                continue
            if filt and filt not in p:
                continue
            size = node["size"]
            if size > 60 * 1024 * 1024:
                continue
            f.seek(base + int(node["offset"]))
            data = f.read(size)
            m = pat.search(data)
            if not m:
                continue
            s = max(0, m.start() - span // 3)
            print(f"===== [{p}] @{m.start()} =====")
            print(data[s:s + span].decode("utf-8", "replace"))
            shown += 1
            if shown >= 3:
                break
    if not shown:
        print("(no hit)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
