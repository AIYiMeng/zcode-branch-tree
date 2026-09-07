# -*- coding: utf-8 -*-
"""zcode-branch-tree（ZCode 任务树）一键安装（标准库实现，零依赖）。

标准安装形态：仓库只是源码，本脚本把运行时复制到数据目录
  ~/.zcode/zcode-branch-tree/
（inject-branchtree.cjs / overlay.js / taskq.py + config.json），asar 注入行指向
数据目录，之后 clone 目录可以随意搬走或删除，已安装实例照常运行。

用法（仓库根目录）：
  python install.py               # 全量安装：复制运行时 → 注入 asar
  python install.py --asar PATH   # 指定 app.asar（自动探测失败时用）
  python install.py --remove      # 卸载：恢复原版 asar + 删除数据目录
  python install.py --dry-run     # 打印将执行的动作，不写任何文件
  python install.py --dev         # 开发模式：不复制运行时，注入直指本仓库目录

注意：与 zcode-token-usage-statusbar 注入标记不同（inject-branchtree.cjs vs
inject-main.cjs），两者可共存；本工具的卸载只剥离自己的注入行。

升级：git pull（或覆盖源码）后重跑 python install.py 即可；ZCode 官方升级覆盖
app.asar 后也需要重跑一次。
"""
import argparse
import json
import os
import shutil
import sys
from pathlib import Path

import patch_install as pi   # 同目录

HERE = Path(__file__).parent.resolve()
DATA_DIR = Path.home() / ".zcode" / "zcode-branch-tree"
RUNTIME_FILES = ("inject-branchtree.cjs", "overlay.js", "taskq.py")

# ZCode 安装位置候选：resources/app.asar 存在即命中（按序探测）。
# 非默认位置用环境变量 ZCODE_ASAR 或 --asar 指定；安装成功后路径会记住在数据目录。
ASAR_CANDIDATES = [
    r"D:\ZCode\resources\app.asar",
    r"C:\ZCode\resources\app.asar",
    r"%LOCALAPPDATA%\Programs\ZCode\resources\app.asar",
    r"%LOCALAPPDATA%\Programs\zcode\resources\app.asar",
    r"%LOCALAPPDATA%\ZCode\resources\app.asar",
    r"%ProgramFiles%\ZCode\resources\app.asar",
]


def expand(p):
    return Path(os.path.expandvars(os.path.expanduser(p)))


def find_asar():
    env = os.environ.get("ZCODE_ASAR")   # 非默认安装位置：设一次环境变量即可
    if env:
        p = expand(env)
        if p.is_file():
            return p
    for c in ASAR_CANDIDATES:
        p = expand(c)
        if p.is_file():
            return p
    prog = expand(r"%LOCALAPPDATA%\Programs")
    if prog.is_dir():
        for ch in prog.iterdir():
            p = ch / "resources" / "app.asar"
            if p.is_file():
                return p
    return None


def ask_asar():
    if not sys.stdin.isatty():
        return None
    try:
        s = input("未自动找到 ZCode，请输入 app.asar 完整路径（回车取消）: ").strip('" ')
    except (EOFError, KeyboardInterrupt):
        return None
    p = Path(s)
    return p if p.is_file() else None


def copy_runtime(dry):
    for name in RUNTIME_FILES:
        src = HERE / name
        assert src.is_file(), f"缺少运行时文件：{src}"
    print(f"[运行时] 复制 {len(RUNTIME_FILES)} 个文件 -> {DATA_DIR}")
    if not dry:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        for name in RUNTIME_FILES:
            shutil.copy2(HERE / name, DATA_DIR / name)
    return True


def prepare_config(dry):
    """config.json：已存在沿用；缺失时按模板生成（python_path 指向当前解释器）。"""
    cfg = DATA_DIR / "config.json"
    if cfg.exists():
        print(f"[配置] 沿用已有 {cfg}")
        return True
    vals = {"python_path": sys.executable, "max_sessions": 500}
    print(f"[配置] 生成 {cfg}（python_path = {sys.executable}）")
    if not dry:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        cfg.write_text(json.dumps(vals, indent=2, ensure_ascii=False), encoding="utf-8")
    return True


def remove_data_dir(dry):
    if not DATA_DIR.exists():
        return True
    print(f"[数据] 删除数据目录 {DATA_DIR}")
    if not dry:
        shutil.rmtree(DATA_DIR)
    return True


def find_installed_asar(explicit):
    """卸载/检查时定位 asar：显式参数 > 数据目录 config 记住的安装路径 > 候选探测 > 询问。"""
    if explicit:
        return Path(explicit)
    cfg = DATA_DIR / "config.json"
    try:
        p = json.loads(cfg.read_text(encoding="utf-8")).get("asar_path")
        if p and Path(p).is_file():
            return Path(p)
    except (OSError, ValueError):
        pass
    return find_asar() or ask_asar()


def remember_asar(asar, dry):
    """把安装位置写进数据目录 config.json（loader 忽略未知字段），卸载时免 --asar。"""
    cfg = DATA_DIR / "config.json"
    try:
        data = json.loads(cfg.read_text(encoding="utf-8")) if cfg.exists() else {}
    except (OSError, ValueError):
        data = {}
    if data.get("asar_path") == str(asar):
        return
    data["asar_path"] = str(asar)
    if not dry:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        cfg.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def write_finish_bat(dry):
    """在数据目录生成个性化收尾脚本：内置本机 Python 与仓库绝对路径，
    双击即可完成收尾（cmd 的 PATH 里没有 python 也能用）。CRLF 行尾。"""
    bat = DATA_DIR / "收尾-双击我.bat"
    lines = [
        "@echo off",
        "chcp 65001 >nul",
        f'cd /d "{HERE}"',
        f'"{sys.executable}" -m patch_install install --finalize',
        "echo.",
        "echo 收尾完成后即可启动 ZCode（窗口右下角 🌳）。",
        "pause",
    ]
    print(f"[收尾脚本] {bat}（已内置本机 Python 路径，双击即用）")
    if not dry:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        bat.write_text("\r\n".join(lines) + "\r\n", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description="zcode-branch-tree 一键安装")
    ap.add_argument("--asar", help="app.asar 路径（默认自动探测）")
    ap.add_argument("--remove", action="store_true", help="卸载")
    ap.add_argument("--dry-run", action="store_true", help="只打印动作不落盘")
    ap.add_argument("--dev", action="store_true", help="开发模式：不复制运行时，注入直指本仓库目录")
    args = ap.parse_args()

    if args.remove:
        if args.dry_run:
            print("[卸载] （dry-run）python patch_install.py remove + 删除数据目录")
            return 0
        asar = find_installed_asar(args.asar)
        ok = True
        if asar and asar.is_file():
            pi.set_target(asar)
            ok = pi.remove()
        else:
            print("[卸载] 未找到 app.asar（ZCode 可能已卸载），跳过 asar 恢复，仅清理数据。")
        remove_data_dir(args.dry_run)
        print("卸载完成。" if ok else "卸载未完成（见上方提示）。")
        return 0 if ok else 1

    asar = Path(args.asar) if args.asar else (find_asar() or ask_asar())
    if not asar or not asar.is_file():
        print("找不到 app.asar。用 --asar 指定，例如：python install.py --asar D:\\tool\\AI\\Zcode\\resources\\app.asar")
        return 1
    print(f"[目标] {asar}")
    if not args.dev:
        copy_runtime(args.dry_run)      # 先建数据目录并复制运行时
        prepare_config(args.dry_run)
        write_finish_bat(args.dry_run)
    if not args.dry_run:
        pi.set_target(asar)
        if not args.dev:
            pi.set_runtime(DATA_DIR)    # 注入行指向数据目录副本（此时目录已存在）
    if args.dry_run:
        print("[注入] （dry-run）python patch_install.py install")
        ok = True
    else:
        ok = pi.install()
        if not args.dev:
            remember_asar(asar, args.dry_run)   # 无论是否收尾成功都记住安装位置（finalize/卸载要用）
        if not ok and pi.TMP.exists():
            # 运行中替换失败：弹独立监控窗口，等 ZCode 退出后自动收尾
            import subprocess as _sp
            try:
                _sp.Popen([sys.executable, "-m", "finalize_watch", "--asar", str(asar)],
                          cwd=str(HERE), creationflags=_sp.CREATE_NEW_CONSOLE)
                print("\n已弹出「安装收尾监控」窗口：**完全退出 ZCode** 后它会自动完成替换，"
                      "之后重新启动 ZCode 即生效（无需其它操作，别关那个监控窗口）。")
            except OSError as e:
                print(f"\n监控窗口启动失败（{e}）：请完全退出 ZCode 后手动执行 "
                      f"python patch_install.py install --finalize")
    print("\n全部完成。重启 ZCode，窗口右下角出现 🌳 按钮；点击打开任务树面板，"
          "按项目查看任务分叉，点节点可查看与切换。")
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
