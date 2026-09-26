# Setup sekali-jalan untuk homeserver Windows. Jalankan sebagai Administrator:
#
#   powershell -ExecutionPolicy Bypass -File D:\Abang\Agent\meridian_au\deploy\homeserver\setup-autostart.ps1
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# so a UTF-8 em-dash decodes to a CP1252 curly quote, which PowerShell accepts
# as a string delimiter and the parse breaks. Keep it that way when editing.
#
# Idempoten - aman dijalankan berulang kali. Yang dilakukan:
#   1. Task Scheduler "meridian-pm2-resurrect" -> `pm2 resurrect` saat PC boot,
#      memulihkan daftar proses dari `pm2 save` terakhir.
#   2. Matikan sleep/hibernate saat tercolok listrik. PC tidur = tunnel mati.
#   3. Upgrade cloudflared (versi lama ditandai "Unsupported" oleh Cloudflare)
#      lalu restart service-nya.

$ErrorActionPreference = "Stop"

# --- 0. Pastikan elevated -----------------------------------------------------
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "BUKAN Administrator." -ForegroundColor Red
  Write-Host "Tutup jendela ini, klik kanan Start, pilih Terminal (Admin), lalu ulangi."
  exit 1
}

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Write-Host "repo: $repoRoot" -ForegroundColor Cyan

# --- 1. Auto-start pm2 saat boot ---------------------------------------------
$node = Join-Path $env:ProgramFiles "nodejs\node.exe"
$pm2 = Join-Path $env:APPDATA "npm\node_modules\pm2\bin\pm2"

if (-not (Test-Path $node)) { throw "node.exe tidak ditemukan di $node" }
if (-not (Test-Path $pm2)) { throw "pm2 tidak ditemukan di $pm2 . Jalankan: npm i -g pm2" }

# Argument pm2 dikutip: path APPDATA bisa mengandung spasi.
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$pm2`" resurrect" -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0

# LogonType HARUS S4U, bukan Interactive (itu default kalau pakai -User).
# Task Interactive butuh sesi user yang sudah login; saat trigger AtStartup
# belum ada sesi sama sekali, jadi Windows melewatinya diam-diam - task
# terbaca "Ready" selamanya tapi LastRunTime tetap kosong dan pm2 tidak pernah
# bangkit setelah reboot. S4U jalan sebagai user tsb tanpa perlu login, jadi
# PM2_HOME tetap di profil user itu dan `pm2 resurrect` baca dump yang benar.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType S4U -RunLevel Highest
Register-ScheduledTask -TaskName "meridian-pm2-resurrect" -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null

$registered = Get-ScheduledTask -TaskName "meridian-pm2-resurrect"
if ($registered.Principal.LogonType -ne "S4U") {
  throw "Task terdaftar sebagai $($registered.Principal.LogonType), bukan S4U - tidak akan jalan saat boot."
}
Write-Host "[1/3] Task 'meridian-pm2-resurrect' terdaftar (S4U, AtStartup)." -ForegroundColor Green

# --- 2. Jangan tidur saat tercolok listrik -----------------------------------
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
Write-Host "[2/3] Sleep + hibernate (AC) dimatikan." -ForegroundColor Green

# --- 3. Upgrade cloudflared ---------------------------------------------------
# winget keluar dengan kode bukan-0 kalau tidak ada update. Itu bukan kegagalan.
$ErrorActionPreference = "Continue"
winget upgrade --id Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements
Restart-Service cloudflared
Start-Sleep -Seconds 5
$ErrorActionPreference = "Stop"
Write-Host "[3/3] cloudflared di-upgrade + restart." -ForegroundColor Green

# --- Verifikasi ---------------------------------------------------------------
Write-Host ""
Write-Host "=== VERIFIKASI ===" -ForegroundColor Cyan
Get-ScheduledTask -TaskName "meridian-pm2-resurrect" | Select-Object TaskName, State | Format-Table -AutoSize
Get-Service cloudflared | Select-Object Name, Status, StartType | Format-Table -AutoSize
& "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe" --version
(Get-ScheduledTask -TaskName "meridian-pm2-resurrect").Principal | Select-Object UserId, LogonType, RunLevel | Format-Table -AutoSize
Write-Host "Harus terbaca: State=Ready, LogonType=S4U, Status=Running, StartType=Automatic." -ForegroundColor Yellow
Write-Host "Ingat: jalankan 'pm2 save' di terminal biasa tiap kali daftar proses berubah."
