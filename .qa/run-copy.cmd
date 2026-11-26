@echo off
set MYCHATAPP_UPDATE_URL=http://localhost:3999/mychatapp
cd /d "E:\mychatapp-run"
mychatapp.exe --user-data-dir="E:\mychatapp-run\ud" --remote-debugging-port=9229 --enable-logging=file --log-file="E:\mychatapp-run\chrome.log" > "E:\mychatapp-run\run.log" 2>&1
echo EXIT=%ERRORLEVEL% >> "E:\mychatapp-run\run.log"
