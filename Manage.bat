@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM  Hugo 博客管理脚本
REM  把这个 bat 放在 Hugo 项目根目录（和 hugo.toml 同级）
REM ============================================================

title Hugo 博客管理

:menu
cls
echo.
echo ============================================
echo             Hugo 博客管理
echo ============================================
echo.
echo   [1] 新建文章
echo   [2] 本地预览 (hugo server)
echo   [3] 构建静态文件 (hugo --minify)
echo   [4] 推送到 GitHub (自动部署)
echo   [5] 一键发布 (新建 + 预览)
echo   [6] 清理构建产物 (public/)
echo   [7] 更新主题子模块
echo   [8] 查看博客状态 (git status)
echo.
echo   [0] 退出
echo.
echo ============================================
set /p choice=请选择操作: 

if "%choice%"=="1" goto newpost
if "%choice%"=="2" goto preview
if "%choice%"=="3" goto build
if "%choice%"=="4" goto push
if "%choice%"=="5" goto newpreview
if "%choice%"=="6" goto clean
if "%choice%"=="7" goto updatetheme
if "%choice%"=="8" goto status
if "%choice%"=="0" goto end
echo.
echo 无效选择，请重新输入。
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
set /p postname=请输入文章文件名（英文/拼音，不带 .md）: 
if "%postname%"=="" (
    echo 文件名不能为空。
    pause
    goto menu
)
echo.
echo 正在创建文章: content/posts/%postname%.md
hugo new content content/posts/%postname%.md
if errorlevel 1 (
    echo.
    echo 创建失败，请检查 Hugo 是否已安装、路径是否正确。
) else (
    echo.
    echo 创建成功！请打开文件，把 draft = true 改成 false 再发布。
    echo 文件路径: content\posts\%postname%.md
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
echo 启动本地服务器，浏览器打开 http://localhost:1313
echo 按 Ctrl+C 可以停止服务器。
echo.
hugo server -D
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
hugo --minify
if errorlevel 1 (
    echo.
    echo 构建失败。
) else (
    echo.
    echo 构建成功，文件在 public\ 目录。
)
echo.
pause
goto menu

REM ============================================================
REM [4] 推送到 GitHub
REM ============================================================
:push
cls
echo.
echo ============ 推送到 GitHub ============
echo.
echo 当前改动：
git status -s
echo.
set /p commitmsg=请输入本次提交说明（直接回车用默认）: 
if "%commitmsg%"=="" set commitmsg=更新博客

echo.
echo 正在添加文件...
git add .

echo 正在提交...
git commit -m "%commitmsg%"

echo 正在推送...
git push

if errorlevel 1 (
    echo.
    echo 推送失败，请检查网络或远程仓库配置。
) else (
    echo.
    echo 推送成功！GitHub Actions 正在自动部署。
    echo 大约 1~2 分钟后访问你的博客即可看到更新。
)
echo.
pause
goto menu

REM ============================================================
REM [5] 一键发布 (新建 + 预览)
REM ============================================================
:newpreview
cls
echo.
echo ============ 一键发布 ============
echo.
set /p postname=请输入文章文件名（英文/拼音，不带 .md）: 
if "%postname%"=="" (
    echo 文件名不能为空。
    pause
    goto menu
)
echo.
hugo new content content/posts/%postname%.md
if errorlevel 1 (
    echo 创建失败。
    pause
    goto menu
)
echo.
echo 文章创建成功，正在打开本地预览...
echo.
hugo server -D
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
    echo 正在删除 public\ 目录...
    rmdir /s /q "public"
    echo 已删除。
) else (
    echo public\ 目录不存在，无需清理。
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
echo 正在拉取主题最新版本...
git submodule update --remote --merge
if errorlevel 1 (
    echo.
    echo 更新失败。
) else (
    echo.
    echo 更新完成。可以运行 [2] 查看效果，确认无误后 [4] 推送。
)
echo.
pause
goto menu

REM ============================================================
REM [8] 查看博客状态
REM ============================================================
:status
cls
echo.
echo ============ 博客状态 ============
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
:end
cls
echo.
echo 再见！
echo.
exit /b 0