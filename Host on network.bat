@echo off
rem Serves the emulator library on your network as http://videopoker.local:8960/
rem (phones and other PCs on the same Wi-Fi can open it). Close this window to stop.
cd /d "%~dp0emu"
node serve.js .. 8960
pause
