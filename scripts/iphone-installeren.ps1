# Zet alles op de pc klaar om TV op je iPhone te zetten:
#  1. iTunes (nodig zodat de pc je iPhone herkent)
#  2. iloader (zet SideStore op je iPhone)
#  3. opent iloader en de uitlegpagina met QR-codes
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path $PSScriptRoot -Parent

Write-Host ''
Write-Host '  TV op je iPhone zetten' -ForegroundColor Cyan
Write-Host ''

# 1. iTunes
$itunes = (Test-Path "$env:ProgramFiles\iTunes\iTunes.exe") -or (Get-AppxPackage -Name *iTunes* -ErrorAction SilentlyContinue)
if ($itunes) { Write-Host 'iTunes staat er al.' -ForegroundColor Green }
else {
    Write-Host 'iTunes installeren (van Apple, via winget)... dit kan een paar minuten duren.'
    winget install --id Apple.iTunes -e --accept-source-agreements --accept-package-agreements --silent
    if (-not (Test-Path "$env:ProgramFiles\iTunes\iTunes.exe")) {
        Write-Host 'Lukt niet automatisch. De downloadpagina van Apple gaat open: installeer iTunes en start dit bestand opnieuw.' -ForegroundColor Yellow
        Start-Process 'https://www.apple.com/itunes/download/win64'
        Read-Host 'Druk op Enter om te stoppen'
        exit 1
    }
    Write-Host 'iTunes geinstalleerd.' -ForegroundColor Green
}

# 2. iloader (officiele download, zoals de SideStore-handleiding aanwijst)
function Find-ILoader {
    foreach ($p in "$env:ProgramFiles\iloader\iloader.exe", "${env:ProgramFiles(x86)}\iloader\iloader.exe", "$env:LOCALAPPDATA\Programs\iloader\iloader.exe", "$env:LOCALAPPDATA\iloader\iloader.exe") {
        if (Test-Path $p) { return $p }
    }
    $lnk = Get-ChildItem "$env:ProgramData\Microsoft\Windows\Start Menu\Programs", "$env:APPDATA\Microsoft\Windows\Start Menu\Programs" -Recurse -Filter 'iloader*.lnk' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($lnk) { return $lnk.FullName }
    return $null
}
$il = Find-ILoader
if ($il) { Write-Host 'iloader staat er al.' -ForegroundColor Green }
else {
    Write-Host 'iloader downloaden en installeren...'
    $msi = Join-Path $env:TEMP 'iloader-windows-x64.msi'
    Invoke-WebRequest -UseBasicParsing 'https://github.com/nab138/iloader/releases/latest/download/iloader-windows-x64.msi' -OutFile $msi
    Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/passive' -Wait
    $il = Find-ILoader
    if ($il) { Write-Host 'iloader geinstalleerd.' -ForegroundColor Green }
    else { Write-Host 'iloader is geinstalleerd; open het via het Startmenu.' -ForegroundColor Yellow }
}

# 3. Openen
if ($il) { Start-Process $il }
Start-Process (Join-Path $root 'iphone.html')
Write-Host ''
Write-Host 'Klaar op de pc. Volg nu de stappen op de pagina die net openging.' -ForegroundColor Green
