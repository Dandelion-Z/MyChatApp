@echo off
cd /d "E:\MyChatApp\node_modules\electron\dist"
electron.exe "E:\MyChatApp\.qa\minapp" --user-data-dir="E:\MyChatApp\.qa\userC" > "E:\MyChatApp\.qa\min.log" 2>&1
echo EXIT=%ERRORLEVEL% >> "E:\MyChatApp\.qa\min.log"
