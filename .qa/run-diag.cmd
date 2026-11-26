@echo off
cd /d "E:\MyChatApp\dist\win-unpacked"
mychatapp.exe --version > "E:\MyChatApp\.qa\d1.log" 2>&1
echo EXIT=%%ERRORLEVEL%% >> "E:\MyChatApp\.qa\d1.log"
mychatapp.exe --disable-gpu --no-sandbox --enable-logging=file --log-file="E:\MyChatApp\.qa\chrome.log" > "E:\MyChatApp\.qa\d2.log" 2>&1
echo EXIT=%%ERRORLEVEL%% >> "E:\MyChatApp\.qa\d2.log"
