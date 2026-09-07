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
python -m patch_install install --finalize
echo.
echo ============================================
echo 收尾完成！现在可以启动 ZCode，窗口右下角会出现 🌳 按钮。
echo ============================================
pause
