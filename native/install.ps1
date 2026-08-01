# Registers the Taildrop bridge as a Chrome native messaging host on Windows.
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 <extension-id> [py|js]
#
# The extension id is shown on the extension card at chrome://extensions with
# developer mode on. For an unpacked extension the id changes if you move the
# folder — re-run this script if that happens.
#
# Windows differs from macOS in two ways that matter here:
#   * hosts are registered in the registry, not in a directory of JSON files;
#   * the registered program must be an .exe/.bat — Chrome will not run a .py or
#     .js file, so this script writes a small launcher next to the helper.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ExtensionId,
  [ValidateSet('py', 'js')][string]$Runtime = 'py'
)

$ErrorActionPreference = 'Stop'
$Name = 'com.triangle.taildrop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($ExtensionId -notmatch '^[a-p]{32}$') {
  Write-Warning "Идентификатор '$ExtensionId' не похож на id расширения (32 буквы a-p). Продолжаю."
}

# --- find the runtime and write the launcher --------------------------------
if ($Runtime -eq 'py') {
  $script = Join-Path $Here 'triangle_taildrop.py'
  $exe = (Get-Command python -ErrorAction SilentlyContinue).Source
  if (-not $exe) { $exe = (Get-Command py -ErrorAction SilentlyContinue).Source }
  if (-not $exe) { throw "Python не найден. Установите его с python.org или запустите скрипт с параметром js." }
} else {
  $script = Join-Path $Here 'triangle_taildrop.js'
  $exe = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $exe) { throw "Node не найден. Установите его с nodejs.org или запустите скрипт с параметром py." }
  Write-Warning "Вариант js рассчитан на macOS: Taildrop и FTP работают, поиск и запись в SMB — нет. Для Windows лучше py."
}
if (-not (Test-Path $script)) { throw "Не найден файл помощника: $script" }

$launcher = Join-Path $Here 'triangle_taildrop.bat'
# @echo off keeps cmd from printing the command into the protocol stream, and
# %* forwards the origin argument Chrome passes to the host. Written as OEM so a
# non-ASCII path still resolves when cmd runs it.
$bat = "@echo off`r`n""$exe"" ""$script"" %*`r`n"
Set-Content -Path $launcher -Value $bat -Encoding oem -NoNewline
Write-Host "Помощник: $script"
Write-Host "Запускатель: $launcher"

# --- manifest ---------------------------------------------------------------
$manifestPath = Join-Path $Here "$Name.json"
$manifest = [ordered]@{
  name            = $Name
  description     = 'Triangle Downloader - Taildrop bridge'
  path            = $launcher
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
# WriteAllText with a BOM-less encoding on purpose: Chrome rejects a manifest
# that starts with a byte-order mark.
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json),
  (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Манифест: $manifestPath"

# --- register for every Chromium-based browser present ----------------------
$browsers = [ordered]@{
  'Chrome'   = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts'
  'Chromium' = 'HKCU:\Software\Chromium\NativeMessagingHosts'
  'Brave'    = 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts'
  'Edge'     = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts'
}
$wrote = 0
foreach ($b in $browsers.GetEnumerator()) {
  $key = Join-Path $b.Value $Name
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath
  Write-Host "-> $($b.Key): $key"
  $wrote++
}
if ($wrote -eq 0) { throw 'Не удалось записать ни одну ветку реестра.' }

# --- Tailscale is optional: SMB and FTP work without it ---------------------
$ts = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $ts) {
  foreach ($p in @("$env:ProgramFiles\Tailscale\tailscale.exe", "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe")) {
    if (Test-Path $p) { $ts = $p; break }
  }
}
if ($ts) { Write-Host "Tailscale CLI найден: $ts" }
else { Write-Warning 'CLI tailscale не найден — Taildrop работать не будет, SMB и FTP будут.' }

Write-Host ''
Write-Host 'Готово. Перезапустите браузер, чтобы он подхватил помощника.'
Write-Host 'Запускать triangle_taildrop.bat вручную не нужно — его вызывает браузер.'

# Скрипт часто открывают двойным щелчком: без паузы окно закроется вместе с
# итогом установки, и останется впечатление, что оно «вылетело».
if ($Host.Name -eq 'ConsoleHost') {
  Write-Host ''
  Write-Host 'Нажмите Enter, чтобы закрыть окно.' -NoNewline
  try { $null = Read-Host } catch { }
}
