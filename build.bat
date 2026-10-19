@echo off
REM Empaqueta Lienzo para Windows: dist\Lienzo\Lienzo.exe y el instalador
REM dist\installer\Lienzo-<version>-setup.exe (si Inno Setup 6 esta instalado).
REM El build se hace en un entorno virtual propio y limpio (.build-venv).
REM Uso: build.bat            (Python 3.14 por defecto; set LIENZO_PYVER=3.12 para otro)

setlocal
if not defined LIENZO_PYVER set LIENZO_PYVER=3.14
cd /d "%~dp0"

echo ============================================
echo  Lienzo - build de Windows
echo ============================================

if exist .build-venv rmdir /s /q .build-venv
py -%LIENZO_PYVER% -m venv .build-venv || goto :error
.build-venv\Scripts\python -m pip install --quiet --upgrade pip || goto :error
.build-venv\Scripts\python -m pip install --quiet -r requirements.txt pyinstaller || goto :error

if exist build rmdir /s /q build
if exist dist\Lienzo rmdir /s /q dist\Lienzo
.build-venv\Scripts\python -m PyInstaller --noconfirm --clean lienzo.spec || goto :error

echo.
echo Prueba rapida del ejecutable...
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\smoke_test.ps1 -Exe "dist\Lienzo\Lienzo.exe" || goto :error

for /f "delims=" %%V in ('.build-venv\Scripts\python -c "import app; print(app.__version__)"') do set VERSION=%%V
set ISCC=
for %%I in (ISCC.exe) do if not "%%~$PATH:I"=="" set "ISCC=%%~$PATH:I"
if not defined ISCC if exist "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
if not defined ISCC if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not defined ISCC (
    echo Inno Setup 6 no esta instalado: se omite el instalador.
    goto :done
)
"%ISCC%" /Q /DAppVersion=%VERSION% installer\Lienzo.iss || goto :error
echo Instalador generado en: dist\installer\

:done
echo.
echo Listo. El programa quedo en: dist\Lienzo\Lienzo.exe
pause
exit /b 0

:error
echo.
echo *** El build fallo. Revisa los mensajes de arriba. ***
pause
exit /b 1
