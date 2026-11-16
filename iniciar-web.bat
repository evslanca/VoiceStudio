@echo off
cd /d "%~dp0"
echo Iniciando VoiceStudio (Web + API)...
bun run dev:web
if %errorlevel% neq 0 pause
