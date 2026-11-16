@echo off
cd /d "%~dp0"
echo Iniciando VoiceStudio (Desktop)...
bun run dev
if %errorlevel% neq 0 pause
