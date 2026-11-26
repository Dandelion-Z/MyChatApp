@echo off
set MYCHATAPP_UPDATE_URL=http://localhost:3999/mychatapp
cd /d "E:\mychatapp-run-e"
start "" "E:\mychatapp-run-e\mychatapp.exe" --user-data-dir="E:\mychatapp-run-e\ud" --remote-debugging-port=9231
