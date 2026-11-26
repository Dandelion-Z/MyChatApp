@echo off
set MYCHATAPP_UPDATE_URL=http://localhost:3999/mychatapp
"E:\MyChatApp\dist-noedit\win-unpacked\mychatapp.exe" --user-data-dir="E:\MyChatApp\.qa\userD" --remote-debugging-port=9225 > "E:\MyChatApp\.qa\exe-noedit.log" 2>&1
echo EXIT=%ERRORLEVEL% >> "E:\MyChatApp\.qa\exe-noedit.log"
