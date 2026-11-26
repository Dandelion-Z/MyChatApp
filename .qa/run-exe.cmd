@echo off
set ELECTRON_ENABLE_LOGGING=1
set MYCHATAPP_UPDATE_URL=http://localhost:3999/mychatapp
"E:\MyChatApp\dist\win-unpacked\mychatapp.exe" --user-data-dir="E:\MyChatApp\.qa\userA" --remote-debugging-port=9222 > "E:\MyChatApp\.qa\exe-run.log" 2>&1
echo EXIT=%ERRORLEVEL% >> "E:\MyChatApp\.qa\exe-run.log"
