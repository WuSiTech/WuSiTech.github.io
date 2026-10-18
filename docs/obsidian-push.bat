@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
pushd "%~dp0.."

REM ============================================================
REM  Obsidian 写作流：一键「提交 + 推送」
REM  为什么不直接在 Obsidian 插件里推：插件用的是系统 git，
REM  不走系统代理；这台机器访问 GitHub 需要代理，所以留了这条路。
REM  本脚本只提交 content/ 和 static/images 下的东西，不用 git add -A。
REM ============================================================

echo.
echo ============================================
echo    Obsidian 文章 一键提交 + 推送
echo ============================================
echo.

REM ---------- 0. 确定代理 ----------
set "PROXY="
for /f "delims=" %%a in ('git config --local --get http.proxy 2^>nul') do set "PROXY=%%a"
if not defined PROXY (
    for /f "tokens=3" %%a in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer 2^>nul ^| findstr /i "ProxyServer"') do set "PROXY=%%a"
)
if not defined PROXY set "PROXY=http://127.0.0.1:7890"
echo [代理] !PROXY!
echo        （改端口：git config --local http.proxy http://127.0.0.1:新端口）
echo.

REM ---------- 1. 构建 + 产物自检（仓库硬要求）----------
where hugo >nul 2>nul
if errorlevel 1 (
    echo [跳过] 没找到 hugo 命令，跳过构建自检。
    goto check_skip
)
echo [1/3] hugo --minify ...
hugo --minify
if errorlevel 1 (
    echo.
    echo [停止] 构建失败，上面有报错。没有提交任何东西。
    goto end
)
where python >nul 2>nul
if errorlevel 1 (
    echo [跳过] 没找到 python，跳过产物校验。
    goto check_skip
)
echo.
echo [2/3] python tools/check_site.py ...
python tools/check_site.py
if errorlevel 1 (
    echo.
    echo [停止] 站点产物校验没通过（上面有明细），没有提交任何东西。
    goto end
)
:check_skip

REM ---------- 2. 暂存（只碰文章和图片）----------
echo.
echo [3/3] 暂存改动：content/ + static/
git add -u content static
if exist "content\posts" git add content\posts
if exist "static\images\obsidian" git add static\images\obsidian
if exist "static\images\posts" git add static\images\posts

echo.
echo ---- 将要提交的内容 ----
git status --short
echo ------------------------
echo.

git diff --cached --quiet
if not errorlevel 1 (
    echo 没有需要提交的改动。
    goto just_push
)

REM ---------- 3. 提交 ----------
set "msg="
set /p msg=提交说明（直接回车 = 「更新文章」）：
if not defined msg set "msg=更新文章"
git commit -m "!msg!"
if errorlevel 1 (
    echo.
    echo [停止] 提交失败，没有推送。
    goto end
)

:just_push
REM ---------- 4. 推送（先走代理，失败再直连）----------
echo.
echo 正在推送（走代理）...
git -c http.proxy=!PROXY! -c https.proxy=!PROXY! push origin HEAD
if errorlevel 1 (
    echo.
    echo 代理推送失败，尝试直连（不需要代理的网络环境）...
    git push origin HEAD
)
if errorlevel 1 (
    echo.
    echo [失败] 推送没成功。请检查：
    echo        1. 代理软件是否在运行、端口是不是 !PROXY!
    echo        2. GitHub 凭据是否失效（换一个 PAT 再试）
    echo        3. 有冲突时先在终端执行：git pull --rebase origin main
) else (
    echo.
    echo [成功] 已推送。1~2 分钟后 GitHub Actions 自动构建上线：
    echo        https://github.com/WuSiTech/WuSiTech.github.io/actions
)

:end
popd
echo.
pause
