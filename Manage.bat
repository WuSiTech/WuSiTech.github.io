@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM ============================================================
REM  Hugo 发布管理脚本（站点根目录运行）
REM  发布流程：[4] 构建自检 -> 只暂存文章和图片 -> 提交 -> 拉取 -> 代理推送
REM  与 docs\obsidian-push.bat 行为一致，区别是这里多了完整的菜单功能。
REM ============================================================

REM ---------- 工具定位：优先 PATH，其次常见安装路径 ----------
set "HUGO=hugo"
where hugo >nul 2>nul
if errorlevel 1 (
  if exist "%LOCALAPPDATA%\Microsoft\WinGet\Packages\Hugo.Hugo.Extended_Microsoft.Winget.Source_8wekyb3d8bbwe\hugo.exe" (
    set "HUGO=%LOCALAPPDATA%\Microsoft\WinGet\Packages\Hugo.Hugo.Extended_Microsoft.Winget.Source_8wekyb3d8bbwe\hugo.exe"
  )
)
set "PY=python"
where python >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" (
    set "PY=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
  ) else (
    set "PY="
  )
)

REM ---------- 代理：git 本地配置 -> 注册表 -> 默认 7890 ----------
set "PROXY="
for /f "delims=" %%a in ('git config --local --get http.proxy 2^>nul') do set "PROXY=%%a"
if not defined PROXY set "PROXY=http://127.0.0.1:7890"

:menu
cls
echo.
echo ============================================
echo             Hugo 发布管理
echo ============================================
echo.
echo   [1] 新建文章
echo   [2] 本地预览 (hugo server -D)
echo   [3] 只构建静态文件 (hugo --minify)
echo   [4] 发布到 GitHub（构建自检 + 提交 + 推送）
echo   [5] 一键写作（新建 + 预览）
echo   [6] 清理构建产物 (public/)
echo   [7] 更新主题子模块
echo   [8] 查看仓库状态
echo   [9] 从远端拉取更新 (git pull --rebase)
echo.
echo   [0] 退出
echo.
echo ============================================
set /p choice=请选择操作: 

if "%choice%"=="1" goto newpost
if "%choice%"=="2" goto preview
if "%choice%"=="3" goto build
if "%choice%"=="4" goto publish
if "%choice%"=="5" goto newpreview
if "%choice%"=="6" goto clean
if "%choice%"=="7" goto updatetheme
if "%choice%"=="8" goto status
if "%choice%"=="9" goto pull
if "%choice%"=="0" goto end
echo.
echo 无效选项，请重新输入。
pause
goto menu

REM ============================================================
REM [1] 新建文章
REM ============================================================
:newpost
cls
echo.
echo ============ 新建文章 ============
echo.
set /p postname=请输入文章文件名（英文/拼音，不要带 .md）: 
if "%postname%"=="" (
    echo 文件名不能为空。
    pause
    goto menu
)
echo.
echo 正在创建：content/posts/%postname%.md
"%HUGO%" new content "content/posts/%postname%.md"
if errorlevel 1 (
    echo.
    echo 创建失败，请确认 Hugo 是否安装、路径是否正确。
) else (
    echo.
    echo 创建成功。把 front matter 里的 draft 改成 false 再发布。
    echo 文件路径：content\posts\%postname%.md
)
echo.
pause
goto menu

REM ============================================================
REM [2] 本地预览
REM ============================================================
:preview
cls
echo.
echo ============ 本地预览 ============
echo.
echo 在浏览器打开 http://localhost:1313 ，按 Ctrl+C 停止。
echo.
"%HUGO%" server -D
pause
goto menu

REM ============================================================
REM [3] 构建静态文件
REM ============================================================
:build
cls
echo.
echo ============ 构建静态文件 ============
echo.
"%HUGO%" --minify --cleanDestinationDir
if errorlevel 1 (
    echo.
    echo 构建失败，上面有报错。
) else (
    echo.
    echo 构建成功，产物在 public\ 目录。
)
echo.
pause
goto menu

REM ============================================================
REM [4] 发布到 GitHub（构建自检 + 提交 + 推送）
REM ============================================================
:publish
cls
echo.
echo ============ 发布到 GitHub ============
echo.
echo [代理] !PROXY!
echo        （端口不对就执行：git config --local http.proxy http://127.0.0.1:新端口）
echo.

echo [1/4] 构建自检：hugo --minify
"%HUGO%" --minify --cleanDestinationDir
if errorlevel 1 (
    echo.
    echo [停止] 构建失败，没有提交任何东西。
    pause
    goto menu
)

if "!PY!"=="" (
    echo.
    echo [跳过] 没找到 python，跳过产物校验。
    goto stage
)
echo.
echo [2/4] 产物校验：tools\check_site.py
"!PY!" tools\check_site.py
if errorlevel 1 (
    echo.
    echo [停止] 站点产物校验没通过（上面有明细），没有提交任何东西。
    pause
    goto menu
)

:stage
echo.
echo [3/4] 暂存改动（只碰文章和图片，不用 git add .）
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
    echo 没有需要提交的改动，直接尝试推送。
    goto dopush
)

set "msg="
set /p msg=提交说明（直接回车 = 「更新文章」）:
if not defined msg set "msg=更新文章"
echo.
echo [4/4] 提交...
git commit -m "!msg!"
if errorlevel 1 (
    echo.
    echo [停止] 提交失败，没有推送。
    pause
    goto menu
)

:dopush
echo.
echo 先拉取远端（rebase，避免覆盖别人的改动）...
git pull --rebase origin main

echo.
echo 正在推送（走代理）...
git -c http.proxy=!PROXY! -c https.proxy=!PROXY! push origin HEAD
if errorlevel 1 (
    echo.
    echo 代理推送失败，尝试直连...
    git push origin HEAD
)
if errorlevel 1 (
    echo.
    echo [失败] 推送没成功。请检查：
    echo        1. 代理软件是否在运行，端口是不是 !PROXY!
    echo        2. GitHub 凭据是否失效
    echo        3. 有冲突：先在终端执行 git pull --rebase origin main 并解决冲突
) else (
    echo.
    echo [成功] 已推送。1~2 分钟后 GitHub Actions 自动构建上线：
    echo        https://github.com/WuSiTech/WuSiTech.github.io/actions
)
echo.
pause
goto menu

REM ============================================================
REM [5] 一键写作（新建 + 预览）
REM ============================================================
:newpreview
cls
echo.
echo ============ 一键写作 ============
echo.
set /p postname=请输入文章文件名（英文/拼音，不要带 .md）: 
if "%postname%"=="" (
    echo 文件名不能为空。
    pause
    goto menu
)
"%HUGO%" new content "content/posts/%postname%.md"
if errorlevel 1 (
    echo 创建失败。
    pause
    goto menu
)
echo.
echo 创建成功，正在打开本地预览...
"%HUGO%" server -D
pause
goto menu

REM ============================================================
REM [6] 清理构建产物
REM ============================================================
:clean
cls
echo.
echo ============ 清理构建产物 ============
echo.
if exist "public" (
    echo 正在删除 public\ ...
    rmdir /s /q "public"
    echo 已删除。
) else (
    echo public\ 不存在，无需清理。
)
echo.
pause
goto menu

REM ============================================================
REM [7] 更新主题子模块
REM ============================================================
:updatetheme
cls
echo.
echo ============ 更新主题子模块 ============
echo.
echo 注意：本站在 layouts\ 下有主题覆盖文件，升级后可能需要对一下。
echo 详见 docs\站点定制说明.md
echo.
set /p ok=确认继续？(y/N): 
if /i not "!ok!"=="y" goto menu
git submodule update --remote --merge
if errorlevel 1 (
    echo.
    echo 更新失败。
) else (
    echo.
    echo 更新完成。用 [2] 预览确认没问题再用 [4] 发布。
)
echo.
pause
goto menu

REM ============================================================
REM [8] 查看仓库状态
REM ============================================================
:status
cls
echo.
echo ============ 仓库状态 ============
echo.
echo --- Git 状态 ---
git status
echo.
echo --- 最近 5 次提交 ---
git log --oneline -5
echo.
echo --- 当前分支 ---
git branch
echo.
pause
goto menu

REM ============================================================
REM [9] 从远端拉取
REM ============================================================
:pull
cls
echo.
echo ============ 从远端拉取 ============
echo.
git -c http.proxy=!PROXY! -c https.proxy=!PROXY! pull --rebase origin main
if errorlevel 1 (
    echo.
    echo [失败] 拉取没成功。可能是代理问题，或存在冲突需要手动解决。
) else (
    echo.
    echo 拉取完成。
)
echo.
pause
goto menu

:end
cls
echo.
echo 再见。
echo.
exit /b 0