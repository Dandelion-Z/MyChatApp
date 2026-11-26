@echo off
cd /d "E:\MyChatApp\dist-nosar\win-unpacked"
plain-electron.exe "E:\MyChatApp\dist-nosar\win-unpacked\resources\app" --user-data-dir="E:\MyChatApp\.qa\userB" --remote-debugging-port=9224 > "E:\MyChatApp\.qa\plain2.log" 2>&1
echo EXIT=%ERRORLEVEL% >> "E:\MyChatApp\.qa\plain2.log"
