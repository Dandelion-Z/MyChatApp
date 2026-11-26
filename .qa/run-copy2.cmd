@echo off
set MYCHATAPP_UPDATE_URL=http://localhost:3999/mychatapp
cd /d "E:\mychatapp-run"
start "" "E:\mychatapp-run\mychatapp.exe" --user-data-dir="E:\mychatapp-run\ud" --remote-debugging-port=9229
