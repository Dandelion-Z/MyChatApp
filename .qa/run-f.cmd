@echo off
set MYCHATAPP_UPDATE_URL=http://localhost:3999/mychatapp
cd /d "E:\mychatapp-run-f"
start "" "E:\mychatapp-run-f\mychatapp.exe" --user-data-dir="E:\mychatapp-run-f\ud" --remote-debugging-port=9232
