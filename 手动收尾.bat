@echo off
chcp 65001 >nul
cd /d %~dp0

echo ============================================
echo   ZCode 任务树 - 手动收尾（完成安装的最后一步）
echo ============================================
echo.
echo 第 1 步：请先【完全退出 ZCode】
echo   - 右下角托盘图标右键 - 退出
echo   - 或任务管理器里结束所有 ZCode 进程
echo   （只关窗口不行，后台服务会留在内存里）
echo.
echo 退出之后，按任意键开始收尾…
pause >nul
echo.

where python >nul 2>&1
if %errorlevel%==0 (
    python -m patch_install install --finalize
    goto ok
)

where py >nul 2>&1
if %errorlevel%==0 (
    py -3 -m patch_install install --finalize
    goto ok
)

echo [!] 在 cmd 里找不到 python（常见：安装 Python 时没勾选 Add to PATH）。
echo 请改用下面任一方式：
echo   1. 打开 PowerShell 执行：  py -3 -m patch_install install --finalize
echo      （先 cd 到本仓库目录）
echo   2. 双击数据目录里的个性化脚本：
echo      %%USERPROFILE%%\.zcode\zcode-branch-tree\收尾-双击我.bat
echo      （由 install.py 生成，已写入你机器的 Python 绝对路径）
goto end

:ok
echo.
echo ============================================
echo 收尾完成！现在可以启动 ZCode，窗口右下角会出现 🌳 按钮。
echo ============================================

:end
echo.
pause
