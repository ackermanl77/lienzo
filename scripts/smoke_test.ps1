# Prueba rápida del ejecutable empaquetado: arranca el servidor (--navegador
# --sin-abrir) en un puerto fijo con datos temporales, pide la página y la API,
# y lo cierra. Sale con 1 si algo falla.
param([string]$Exe = "dist\Lienzo\Lienzo.exe", [int]$Port = 8797)

$data = Join-Path $env:TEMP ("lienzo-smoke-" + [guid]::NewGuid().ToString("N"))
$env:LIENZO_DATA_DIR = $data
$proc = Start-Process -FilePath $Exe -ArgumentList "--navegador", "--sin-abrir", "--puerto", "$Port" -PassThru
try {
    $ok = $false
    for ($i = 0; $i -lt 40 -and -not $ok; $i++) {
        Start-Sleep -Milliseconds 500
        try { $ok = (Invoke-WebRequest "http://127.0.0.1:$Port/editor" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { }
    }
    if (-not $ok) { Write-Host "La página no respondió."; exit 1 }
    $js = (Invoke-WebRequest "http://127.0.0.1:$Port/js/editor.js" -UseBasicParsing).StatusCode
    try { Invoke-WebRequest "http://127.0.0.1:$Port/api/disenos" -UseBasicParsing | Out-Null; $api = 200 }
    catch { $api = $_.Exception.Response.StatusCode.value__ }
    if ($js -ne 200 -or $api -ne 401) { Write-Host "Respuestas inesperadas: js=$js api=$api"; exit 1 }
    Write-Host "OK: la página carga y la API pide la clave."
    exit 0
}
finally {
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
    Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue
}
