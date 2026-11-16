@echo off
cd /d "%~dp0"
echo [1/2] Iniciando ACE-Step 1.5 API (porta 8001) em janela separada...
start "ACE-Step 1.5 API" cmd /k "cd /d "%~dp0integrations\ace-step\ACE-Step-1.5" && uv run acestep-api --host 127.0.0.1 --port 8001"
echo [2/2] Iniciando VoiceStudio Desktop...
bun run dev
if %errorlevel% neq 0 pause
