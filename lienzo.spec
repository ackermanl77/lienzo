# -*- mode: python ; coding: utf-8 -*-
# Empaquetado de Lienzo con PyInstaller (carpeta, sin consola): build.bat lo usa.

a = Analysis(
    ["lienzo.py"],
    pathex=[],
    binaries=[],
    datas=[("web", "web")],
    hiddenimports=["webview.platforms.winforms", "webview.platforms.edgechromium", "clr"],
    excludes=["tkinter", "unittest", "pydoc", "pytest", "numpy"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Lienzo",
    icon="assets/icon.ico",
    console=False,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="Lienzo")
