@echo off
set MYCHATAPP_UPDATE_URL=http://localhost:3999/mychatapp
cd /d "E:\mychatapp-run-b"
start "" "E:\mychatapp-run-b\mychatapp.exe" --user-data-dir="E:\mychatapp-run-b\ud" --remote-debugging-port=9230
