@echo off
set MYCHATAPP_UPDATE_URL=http://localhost:3999/mychatapp
cd /d "E:\mychatapp-run-c"
start "" "E:\mychatapp-run-c\mychatapp.exe" --user-data-dir="E:\mychatapp-run-c\ud" --remote-debugging-port=9231
