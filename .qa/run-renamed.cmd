@echo off
set MYCHATAPP_UPDATE_URL=http://localhost:3999/mychatapp
cd /d "E:\MyChatApp\node_modules\electron\dist"
mychatapp2.exe "E:\MyChatApp\dist\win-unpacked\resources\app.asar" --user-data-dir="E:\MyChatApp\.qa\userG" --remote-debugging-port=9228 --enable-logging=file --log-file="E:\MyChatApp\.qa\chrome-g.log" > "E:\MyChatApp\.qa\renamed.log" 2>&1
echo EXIT=%ERRORLEVEL% >> "E:\MyChatApp\.qa\renamed.log"
