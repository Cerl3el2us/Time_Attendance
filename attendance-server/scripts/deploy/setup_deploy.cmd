@echo off
REM Double-click this file to set up deployment on a new machine.
REM It only calls setup_deploy.ps1 next to it -- all the logic lives there.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_deploy.ps1"
