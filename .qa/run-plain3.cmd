@echo off
cd /d "E:\MyChatApp\dist\win-unpacked"
plain2.exe "E:\MyChatApp\dist\win-unpacked\resources\app.asar" --user-data-dir="E:\MyChatApp\.qa\userE" --remote-debugging-port=9226 --enable-logging=file --log-file="E:\MyChatApp\.qa\chrome-e.log" > "E:\MyChatApp\.qa\p3.log" 2>&1
echo EXIT=%ERRORLEVEL% >> "E:\MyChatApp\.qa\p3.log"
