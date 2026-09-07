# -*- coding: utf-8 -*-
"""zcode-branch-tree 的 app.asar 注入/卸载工具。

asar 读写/重打包/自检机制借自 xhwxt/zcode-token-usage-statusbar（MIT），改为独立
注入标记（inject-branchtree.cjs），与用量状态条（inject-main.cjs）互不干扰、可共存：
各自的安装器只识别并替换自己的注入行，卸载也只剥离自己的行。

用法：
  python patch_install.py install   # 安装/重定向（幂等；自动替换本工具的旧注入行；
                                    # 客户端运行中则生成 .tmp 待退出后替换）
  python patch_install.py install --finalize  # 客户端退出后完成替换
  python patch_install.py remove    # 卸载（优先从 .bak 恢复）
  python patch_install.py check     # 检查当前注入状态与入口语法

原理：asar 主入口 out/main/index.js 尾部追加一行 dynamic import(loader)。
依赖 Electron fuses EmbeddedAsarIntegrityValidation=0。

安全设计：
- 所有 subprocess 均为固定参数列表（shell=False），无字符串拼接命令。
- 目标 asar 路径必须经 _validate_target()：拒绝上跳段（路径穿越），规范化为绝对
  真实路径后必须真实存在、且形如 <安装目录>/resources/app.asar。
- 本工具全部落盘文件（BAK/TMP/语法检查临时文件）均由已校验路径或 HERE 派生；
  _repack() 只读取全局 ASAR、只写全局 TMP（Path.write_bytes 单点落盘）。
"""
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
from pathlib import Path, PurePath

ASAR_DEFAULT = Path(r"D:\ZCode\resources\app.asar")
ASAR = None             # 经 _validate_target 校验后设置
BAK = None
TMP = None
HERE = Path(__file__).parent.resolve()
RUNTIME = None          # 经 _validate_runtime 校验后设置
LOADER = None
ENTRY = "out/main/index.js"
INJECT_LINE_TMPL = (
    '\n;import("{url}").then(() => null, (e) => console.error("[btree] load failed", e));'
)
INJECT_LINE = None
# 只匹配本工具的注入行（不限目录）——重装/迁移时剥离旧行用
BTREE_LINE_RE = re.compile(
    rb'\n;import\("[^"]*inject-branchtree\.cjs"\)\.then\(\(\) => null, '
    rb'\(e\) => console\.error\("\[btree\] load failed", e\)\);'
)
ZCODE_EXE = None
ALIGN = 4
BLOCK = 4194304


def _has_parent_ref(p) -> bool:
    """路径中是否含上跳段（路径穿越特征）。"""
    return any(part in (os.pardir, ".") for part in PurePath(str(p)).parts)


def _validate_target(raw) -> Path:
    """校验目标 asar 路径：拒绝上跳段；规范化为绝对真实路径后必须真实存在、
    且形如 <安装目录>/resources/app.asar。返回规范化 Path，非法抛 ValueError。"""
    if _has_parent_ref(raw):
        raise ValueError(f"拒绝含上跳段的路径: {raw}")
    p = Path(str(raw)).resolve()
    if not p.is_file():
        raise ValueError(f"目标不存在或不是文件: {p}")
    if p.name.lower() != "app.asar" or p.parent.name.lower() != "resources":
        raise ValueError(f"目标必须是 <安装目录>/resources/app.asar: {p}")
    return p


def _validate_runtime(raw) -> Path:
    """校验运行时目录：拒绝上跳段；必须是已存在的本机目录。"""
    if _has_parent_ref(raw):
        raise ValueError(f"拒绝含上跳段的路径: {raw}")
    p = Path(str(raw)).resolve()
    if not p.is_dir():
        raise ValueError(f"运行时目录不存在: {p}")
    return p


def set_target(asar_path):
    """设置并校验目标安装位置（BAK/TMP/ZCODE_EXE 由校验后的路径派生）。"""
    global ASAR, BAK, TMP, ZCODE_EXE
    ASAR = _validate_target(asar_path)
    BAK = ASAR.with_name("app.asar.btree.bak")
    TMP = ASAR.with_name("app.asar.btree.tmp")
    ZCODE_EXE = ASAR.parent.parent / "ZCode.exe"


def set_runtime(path):
    """设置并校验运行时目录（LOADER/INJECT_LINE 随动；loader 基于 __dirname 自洽运行）。"""
    global RUNTIME, LOADER, INJECT_LINE
    RUNTIME = _validate_runtime(path)
    LOADER = RUNTIME / "inject-branchtree.cjs"
    INJECT_LINE = INJECT_LINE_TMPL.format(url=LOADER.as_uri())


def _ensure_target():
    """未显式设置时用默认路径与默认运行时（同样过校验）。"""
    if ASAR is None:
        set_target(ASAR_DEFAULT)
    if RUNTIME is None:
        set_runtime(HERE)


def client_running():
    """tasklist 为主（快），输出异常时用 PowerShell 计数兜底（个别环境 tasklist 返回空）。"""
    try:
        r = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq ZCode.exe"],
            capture_output=True, text=True, encoding="gbk", errors="replace", shell=False,
        )
        if r.returncode == 0 and r.stdout is not None:
            return "ZCode.exe" in r.stdout
    except Exception:
        pass
    try:
        out = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command",
             "@(Get-Process ZCode -ErrorAction SilentlyContinue).Count"],
            capture_output=True, text=True, timeout=15, shell=False,
        ).stdout.strip()
        return bool(out) and out != "0"
    except Exception:
        return True  # 两种检测都失败：按在跑处理，走安全路径


# ---------- asar 读写（机制借自 zcode-token-usage-statusbar，MIT） ----------

def read_header(f):
    f.seek(0)
    a, b, c, d = struct.unpack("<4I", f.read(16))
    assert a == 4, f"unexpected pickle prefix {a}"
    header = json.loads(f.read(d))
    return header, 8 + b


def iter_files(node, path=""):
    for name, ch in node.get("files", {}).items():
        p = f"{path}/{name}"
        if "files" in ch:
            yield from iter_files(ch, p)
        else:
            yield p, ch


def compute_integrity(data: bytes):
    return {
        "algorithm": "SHA256",
        "hash": hashlib.sha256(data).hexdigest(),
        "blockSize": BLOCK,
        "blocks": [hashlib.sha256(data[i:i + BLOCK]).hexdigest() for i in range(0, len(data), BLOCK)],
    }


def _repack(modify: dict):
    """重建 asar：读取全局 ASAR（已校验），经全局 TMP（由校验后的 ASAR 路径 with_name
    派生）以 write_bytes 单点落盘。modify 的键由本模块内部构造（仅 /out/main/index.js）。
    注：整包在内存拼接后一次写出，安装期峰值内存约为包体积两倍（~600MB，一次性）。"""
    with open(ASAR, "rb") as src:
        header, base = read_header(src)
        header = json.loads(json.dumps(header))  # 深拷贝
        nodes = dict(iter_files(header))
        missing = set(modify) - set(nodes)
        assert not missing, f"paths not in asar: {missing}"

        data_parts = []
        offset = 0
        for p, node in nodes.items():
            if node.get("unpacked"):
                node["offset"] = "0"
                continue
            if p in modify:
                data = modify[p]
                node["size"] = len(data)
                node["integrity"] = compute_integrity(data)
            else:
                src.seek(base + int(node["offset"]))
                data = src.read(node["size"])
            node["offset"] = str(offset)
            data_parts.append(data)
            offset += len(data)

        payload = b"".join(data_parts)
        data_parts.clear()
        header_bytes = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        d = len(header_bytes)
        c = (d + 4 + ALIGN - 1) // ALIGN * ALIGN
        b_total = c + 4
        head = struct.pack("<4I", 4, b_total, c, d) + header_bytes + b"\0" * (c - d - 4)
        assert len(head) == 8 + b_total, f"header pad mismatch: {len(head)} vs {8 + b_total}"
        TMP.write_bytes(head + payload)


def entry_bytes_of(asar_path: Path) -> bytes:
    with open(asar_path, "rb") as f:
        header, base = read_header(f)
        nodes = dict(iter_files(header))
        node = nodes["/" + ENTRY]
        f.seek(base + int(node["offset"]))
        return f.read(node["size"])


def self_check(asar_path: Path):
    """结构自检：header 可解析、文件数、入口含注入行。"""
    with open(asar_path, "rb") as f:
        header, base = read_header(f)
        n = sum(1 for _ in iter_files(header))
    ok = INJECT_LINE.encode() in entry_bytes_of(asar_path)
    print(f"  [check] header ok, 文件数={n}, 注入行已写入={ok}")
    return ok


def syntax_check(asar_path: Path):
    """用 ZCode 自身当 node（ELECTRON_RUN_AS_NODE）对入口做语法检查。
    参数为固定列表（ZCODE_EXE 与 HERE 下的临时文件），shell=False。"""
    if not (ZCODE_EXE and ZCODE_EXE.is_file()):
        print("  [check] 未找到 ZCode.exe，跳过语法检查")
        return True
    src = entry_bytes_of(asar_path)
    tmp_js = HERE / ".entry-check.js"
    tmp_js.write_bytes(src)
    env = dict(os.environ, ELECTRON_RUN_AS_NODE="1")
    r = subprocess.run(
        [str(ZCODE_EXE), "--check", str(tmp_js)],
        capture_output=True, text=True, env=env, shell=False,
    )
    tmp_js.unlink(missing_ok=True)
    print("  [check] 语法检查 exit=" + str(r.returncode) + " " + r.stderr.strip()[:200])
    return r.returncode == 0


# ---------- 安装 / 卸载 ----------

def install(finalize=False):
    """返回 True=已安装/已指向当前目录，False=失败或待收尾。"""
    _ensure_target()
    assert LOADER.exists(), f"loader 缺失：{LOADER}"
    if finalize and TMP.exists():
        # 快路径：.tmp 是上次自检通过的完整包，客户端退出后直接替换即可（免再重打包）
        print("发现待替换 TMP：", TMP)
        print("结构自检：")
        if self_check(TMP):
            os.replace(TMP, ASAR)
            print("收尾完成。启动 ZCode，窗口右下角出现 🌳 按钮。")
            return True
        print("TMP 自检未通过，丢弃并走完整安装流程…")
    entry = entry_bytes_of(ASAR)
    stripped = BTREE_LINE_RE.sub(b"", entry)   # 只剥离本工具的旧注入行
    if stripped + INJECT_LINE.encode() == entry:
        print("已安装，注入行已指向当前目录。如需重装先 remove。")
        return True
    if not BAK.exists():
        print(f"备份 {ASAR} -> {BAK} ...")
        shutil.copy2(ASAR, BAK)

    new_entry = stripped + INJECT_LINE.encode()
    if stripped != entry:
        print("检测到本工具旧注入行（可能指向旧目录），将替换为新路径。")
    print(f"重打包（{ASAR.stat().st_size // (1024 * 1024)}MB，约需十几秒）...")
    _repack({"/" + ENTRY: new_entry})
    print("结构自检：")
    if not (self_check(TMP) and syntax_check(TMP)):
        print("自检失败，未替换。TMP 保留供排查:", TMP)
        return False
    if client_running() and not finalize:
        try:
            os.replace(TMP, ASAR)
            print("\n客户端运行中，但 asar 原子替换成功（运行中进程仍读旧数据）。")
            print("重启 ZCode 后生效。")
            return True
        except OSError as e:
            print(f"\n运行中替换失败（{e}）。请完全退出 ZCode 后执行：python patch_install.py install --finalize")
            return False
    try:
        os.replace(TMP, ASAR)
    except OSError as e:
        print(f"\n替换失败（{e}）。请完全退出 ZCode 后执行：python patch_install.py install --finalize")
        return False
    print("完成。启动 ZCode，窗口右下角出现 🌳 按钮。")
    return True


def remove():
    """返回 True=已卸载/本就未注入，False=需人工处理（运行中/替换失败）。"""
    _ensure_target()
    if BAK.exists():
        if client_running():
            print("ZCode 正在运行，请退出后再卸载。")
            return False
        os.replace(BAK, ASAR)
        print("已从备份恢复原版 asar。")
        return True
    print("无备份，尝试从当前 asar 剥离注入行...")
    old = entry_bytes_of(ASAR)
    stripped = BTREE_LINE_RE.sub(b"", old)
    if stripped == old:
        print("当前 asar 未注入。")
        return True
    _repack({"/" + ENTRY: stripped})
    if client_running():
        print(f"ZCode 正在运行，请退出后手动替换：move /y {TMP} {ASAR}")
        return False
    os.replace(TMP, ASAR)
    print("已剥离。")
    return True


def check():
    _ensure_target()
    injected = bool(BTREE_LINE_RE.search(entry_bytes_of(ASAR)))
    print("asar:", ASAR, ASAR.stat().st_size, "bytes")
    print("注入状态:", "已注入" if injected else "未注入")
    print("备份:", BAK.exists())
    if injected:
        syntax_check(ASAR)
    if TMP.exists():
        print("存在待替换 TMP:", TMP, "（退出 ZCode 后跑 install --finalize）")


def _cli():
    import argparse
    ap = argparse.ArgumentParser(
        description="zcode-branch-tree asar 注入/卸载工具（默认目标 D:\\ZCode；非默认安装位置用 --asar 指定）")
    ap.add_argument("cmd", nargs="?", default="check", choices=["install", "remove", "check"],
                    help="install=安装/重定向, remove=卸载, check=查看状态")
    ap.add_argument("--asar", help="app.asar 完整路径（形如 <安装目录>/resources/app.asar；缺省读数据目录记住的路径）")
    ap.add_argument("--runtime", help="运行时目录（含 inject-branchtree.cjs/overlay.js；缺省优先数据目录）")
    ap.add_argument("--finalize", action="store_true", help="install 专用：客户端退出后完成 .tmp 替换")
    a = ap.parse_args()
    cfg = Path.home() / ".zcode" / "zcode-branch-tree" / "config.json"
    remembered = None
    try:
        remembered = json.loads(cfg.read_text(encoding="utf-8")).get("asar_path")
    except (OSError, ValueError):
        pass
    try:
        if a.asar:
            set_target(a.asar)
        else:
            p = (Path(remembered) if remembered else ASAR_DEFAULT)
            set_target(p)
        if a.runtime:
            set_runtime(a.runtime)
        else:
            dd = Path.home() / ".zcode" / "zcode-branch-tree"
            set_runtime(dd if (dd / "inject-branchtree.cjs").is_file() else HERE)
    except ValueError as e:
        print(f"目标路径无效：{e}")
        print('请用 --asar 指定，例如：python patch_install.py {} --asar "<ZCode安装目录>\\resources\\app.asar"'.format(a.cmd))
        return 2
    if a.cmd == "install":
        ok = install(finalize=a.finalize)
        return 0 if ok else 1
    if a.cmd == "remove":
        ok = remove()
        return 0 if ok else 1
    check()
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
