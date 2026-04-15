@echo off
title Satriales Snipe Trader v3
cd /d "%~dp0"
echo =====================================================
echo   SATRIALES SNIPE TRADER v3
echo   Bonereaper-inspired: no ML, 3-stage sniping
echo   Legacy ML version lives on the legacy-ml branch
echo =====================================================
echo.
python -u snipe_trader.py
echo.
echo =====================================================
echo   Snipe trader stopped. Press any key to close.
echo =====================================================
pause
