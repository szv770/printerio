@echo off
rem Printio Agent - one-click setup launcher.
rem
rem Double-click this file. It runs the PowerShell script sitting next to it
rem (setup-agent.ps1), which does the actual work: checks Node.js/SumatraPDF,
rem installs dependencies, registers the Agent, and lets you either run it as
rem a foreground test or install it as a Windows Service.
rem
rem Why a .bat wrapping a .ps1: double-clicking a .ps1 file directly normally
rem opens it in Notepad (Windows' default file association for .ps1 is "Edit",
rem not "Run"), so it would never execute this way. A .bat file runs
rem immediately when double-clicked, so it exists purely to launch the real
rem script below with the right PowerShell flags.
rem
rem See docs/agent-install.md ("The fast path: one script") and
rem apps/agent/scripts/setup-agent.ps1 for full detail. This .bat file
rem intentionally has no logic of its own beyond that - anything that needs
rem conditionals, JSON/text parsing, or colored output lives in the .ps1.

setlocal
set "SCRIPT_DIR=%~dp0"

where powershell.exe >nul 2>nul
if errorlevel 1 (
    echo.
    echo This script needs Windows PowerShell ^(powershell.exe^), which ships
    echo with every supported version of Windows, but it could not be found
    echo on this machine's PATH. Something unusual about this machine's setup
    echo is blocking that - ask whoever manages this PC for help.
    echo.
    pause
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%setup-agent.ps1" %*

endlocal
