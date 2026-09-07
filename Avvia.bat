@echo off
title Rinascita
cd /d "%~dp0"

where py >nul 2>nul && (py -u server.py & goto :fine)
where python >nul 2>nul && (python -u server.py & goto :fine)

echo.
echo   Python non risulta installato.
echo   Scaricalo da https://www.python.org/downloads/
echo   (spunta "Add python.exe to PATH" durante l'installazione)
echo.
pause

:fine
