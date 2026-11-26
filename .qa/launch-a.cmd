@echo off
set MYCHATAPP_UPDATE_URL=http://localhost:3999/mychatapp
start "" "E:\MyChatApp\dist\win-unpacked\mychatapp.exe" --user-data-dir="E:\MyChatApp\.qa\userA" --remote-debugging-port=9222
