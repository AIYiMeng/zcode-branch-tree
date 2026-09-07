# -*- coding: utf-8 -*-
"""自动收尾监控：等 ZCode 完全退出后，自动完成 .tmp → app.asar 的替换，然后退出。

由 install.py 在"运行中替换失败"时以独立控制台窗口拉起；也可手动运行：
  python finalize_watch.py [--asar <app.asar 路径>]
关闭本窗口 = 取消自动收尾（之后可手动 patch_install.py install --finalize）。
"""
import argparse
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent.resolve()


def zcode_running():
    """tasklist 为主，输出异常时用 PowerShell 计数兜底（个别环境 tasklist 返回空）。"""
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
        return True


def main():
    ap = argparse.ArgumentParser(description="ZCode 任务树 安装收尾监控")
    ap.add_argument("--asar", help="app.asar 完整路径（默认读数据目录 config.json 记住的路径）")
    a = ap.parse_args()
    asar = a.asar
    if not asar:
        try:
            import json
            cfg = Path.home() / ".zcode" / "zcode-branch-tree" / "config.json"
            asar = json.loads(cfg.read_text(encoding="utf-8")).get("asar_path")
        except Exception:
            asar = None
    print("== ZCode 任务树 · 安装收尾监控 ==")
    print("注入包已就绪，等待 ZCode 完全退出（每 5 秒检查一次；关闭本窗口 = 取消）…")
    for i in range(720):   # 最多等 1 小时
        if not zcode_running():
            break
        if i % 12 == 0:
            print("… ZCode 仍在运行")
        time.sleep(5)
    else:
        print("等待超时（1 小时），自动退出。之后可手动执行收尾。")
        time.sleep(8)
        return 1
    time.sleep(2)
    if asar:
        r = subprocess.run(
            [sys.executable, "-m", "patch_install", "install", "--finalize", "--asar", asar],
            cwd=str(HERE), shell=False,
        )
    else:
        r = subprocess.run(
            [sys.executable, "-m", "patch_install", "install", "--finalize"],
            cwd=str(HERE), shell=False,
        )
    print(f"\n收尾 exit={r.returncode}。本窗口 10 秒后自动关闭；现在可以启动 ZCode 了。")
    time.sleep(10)
    return r.returncode


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
