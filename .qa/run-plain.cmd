@echo off
cd /d "E:\MyChatApp\dist-nosar\win-unpacked"
plain-electron.exe --user-data-dir="E:\MyChatApp\.qa\userB" --remote-debugging-port=9224 > "E:\MyChatApp\.qa\plain.log" 2>&1
echo EXIT=%ERRORLEVEL% >> "E:\MyChatApp\.qa\plain.log"
