# Rehearse the Oracle deployment on this PC: Ubuntu in WSL + deploy/setup.sh.
# Run from Windows PowerShell (any folder):
#
#   powershell -ExecutionPolicy Bypass -File <project folder>\deploy\wsl-rehearsal.ps1
#
# 1. Installs Ubuntu 24.04 in WSL if missing (you create a Linux username and
#    password when asked — remember the password, `sudo` asks for it).
# 2. Turns on systemd in it if needed.
# 3. Copies this project to ~/stream-panel inside Ubuntu (code only; re-running
#    updates the code and keeps that copy's data/ and media/).
# 4. Runs deploy/setup.sh there (asks for the panel password, stream key, ...).
# 5. Leaves an Ubuntu window open — WSL stops Ubuntu when its last window closes.

$ErrorActionPreference = 'Stop'
$Distro = 'Ubuntu-24.04'
$Project = Split-Path -Parent $PSScriptRoot

function Get-Distros {
  # wsl.exe prints UTF-16; strip the NULs PowerShell 5.1 leaves behind.
  (wsl.exe -l -q) -replace "`0", '' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
}
function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

Step "Ubuntu ($Distro)"
if (-not (Get-Distros | Where-Object { $_ -eq $Distro })) {
  Write-Host "Installing $Distro. When asked, create a Linux username and password."
  Write-Host "When you see a prompt like  you@PC:~`$  type  exit  and press Enter to continue here." -ForegroundColor Yellow
  wsl.exe --install -d $Distro
  if (-not (Get-Distros | Where-Object { $_ -eq $Distro })) {
    throw "Ubuntu didn't install. Run 'wsl --install -d $Distro' yourself, then run this script again."
  }
} else {
  Write-Host 'already installed'
}

Step 'systemd'
$state = ((wsl.exe -d $Distro -- bash -c 'systemctl is-system-running --wait 2>/dev/null || true') -join '') -replace "`0", ''
if ($state -notmatch 'running|degraded') {
  Write-Host 'turning it on (one-time)...'
  wsl.exe -d $Distro -u root -- bash -c "printf '[boot]\nsystemd=true\n' > /etc/wsl.conf"
  wsl.exe --terminate $Distro | Out-Null
  Start-Sleep -Seconds 3
  $state = ((wsl.exe -d $Distro -- bash -c 'systemctl is-system-running --wait 2>/dev/null || true') -join '') -replace "`0", ''
  if ($state -notmatch 'running|degraded') { throw "systemd still isn't running in $Distro (state: '$state')." }
}
Write-Host "ok ($state)"

Step 'Copying the project into Ubuntu (~/stream-panel)'
if (-not (Test-Path (Join-Path $Project 'deploy\setup.sh'))) { throw "Can't find the project at $Project" }
# --cd lets WSL translate the Windows path itself (passing it as an argument
# goes through a Linux shell that eats backslashes). The copy refuses to run
# unless it really is in the project folder — never copy anything else.
wsl.exe -d $Distro --cd "$Project" -- bash -c "[ -f deploy/setup.sh ] && [ -f server.js ] || { echo 'Not in the project folder - nothing copied.'; exit 1; }; mkdir -p ~/stream-panel; tar --exclude=node_modules --exclude=data --exclude=media --exclude=spike -cf - . | tar -xf - -C ~/stream-panel; echo copied to ~/stream-panel"
if ($LASTEXITCODE -ne 0) { throw 'Copy failed.' }

Step 'Running deploy/setup.sh inside Ubuntu'
Write-Host 'Stop the Windows copy of the panel first (Ctrl+C where npm start runs) — two copies fight over the stream key.' -ForegroundColor Yellow
wsl.exe -d $Distro -- bash -c 'cd ~/stream-panel; bash deploy/setup.sh'
if ($LASTEXITCODE -ne 0) { throw 'setup.sh stopped with an error (see above).' }

Step 'Done'
Write-Host 'The panel link arrives in Discord. Opening an Ubuntu window now — keep it open while testing.'
Write-Host 'Useful in that window:  systemctl status stream-panel   |   journalctl -u stream-panel -f'
wsl.exe -d $Distro --cd ~
