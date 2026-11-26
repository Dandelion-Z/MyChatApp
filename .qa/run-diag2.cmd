@echo off
cd /d "E:\MyChatApp\dist\win-unpacked"
mychatapp.exe --user-data-dir="E:\MyChatApp\.qa\userA" --remote-debugging-port=9222 --enable-logging=file --log-file="E:\MyChatApp\.qa\chrome-a.log" > "E:\MyChatApp\.qa\d3.log" 2>&1
echo EXIT=%ERRORLEVEL% >> "E:\MyChatApp\.qa\d3.log"
