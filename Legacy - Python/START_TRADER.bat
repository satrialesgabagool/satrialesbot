@echo off
title Satriales Snipe Trader v3
cd /d "%~dp0"
echo =====================================================
echo   SATRIALES SNIPE TRADER v3
echo   Bonereaper-inspired: no ML, 3-stage sniping
echo   Launching desktop dashboard...
echo =====================================================
echo.
python -u snipe_gui.py
echo.
echo =====================================================
echo   Snipe trader window closed.
echo =====================================================
pause
