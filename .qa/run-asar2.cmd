@echo off
set ELECTRON_ENABLE_LOGGING=1
set MYCHATAPP_UPDATE_URL=http://localhost:3999/mychatapp
"E:\MyChatApp\node_modules\electron\dist\electron.exe" "E:\MyChatApp\dist\win-unpacked\resources\app.asar" --user-data-dir="E:\MyChatApp\.qa\userF" --remote-debugging-port=9227 > "E:\MyChatApp\.qa\asar2.log" 2>&1
echo EXIT=%ERRORLEVEL% >> "E:\MyChatApp\.qa\asar2.log"
