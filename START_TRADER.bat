@echo off
title Satriales Live Paper Trader
cd /d "%~dp0"
echo ============================================
echo   SATRIALES LIVE PAPER TRADER
echo   Starting up...
echo ============================================
echo.
python -u live_trader.py
echo.
echo ============================================
echo   Trader stopped. Press any key to close.
echo ============================================
pause
