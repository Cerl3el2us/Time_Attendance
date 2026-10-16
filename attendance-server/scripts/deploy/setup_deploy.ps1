# Interactive one-time setup for deploy_backend.py on a new machine / for a new person.
# Launched by setup_deploy.cmd (double-click). Stores NAS_USER / NAS_PASSWORD in the CURRENT
# WINDOWS USER's environment only -- nothing is written into the repo, and nothing is sent anywhere.
# 2026-09-24: added because the account name used to be hard-coded in deploy_backend.py, so a
# handover meant editing source. See attendance-server/DEVELOPER_HANDOFF.md.

$ErrorActionPreference = 'Stop'

function Write-Head($t) { Write-Host ''; Write-Host $t -ForegroundColor Cyan; Write-Host ('-' * $t.Length) -ForegroundColor Cyan }

Write-Head 'Time Attendance - deploy setup'
Write-Host 'This stores your NAS login for the deploy script, on this computer only.'
Write-Host 'The NAS account must be a DSM administrator (the restart step uses sudo).'

$currentUser = [Environment]::GetEnvironmentVariable('NAS_USER', 'User')
$currentPass = [Environment]::GetEnvironmentVariable('NAS_PASSWORD', 'User')
Write-Host ''
Write-Host ("Currently set: NAS_USER = {0}   NAS_PASSWORD = {1}" -f `
  $(if ($currentUser) { $currentUser } else { '(not set -> defaults to Teerawat)' }),
  $(if ($currentPass) { '(set)' } else { '(NOT set)' }))

# --- account name -----------------------------------------------------------
$defaultUser = if ($currentUser) { $currentUser } else { 'Teerawat' }
Write-Host ''
$nasUser = Read-Host ("NAS account name [{0}]" -f $defaultUser)
if ([string]::IsNullOrWhiteSpace($nasUser)) { $nasUser = $defaultUser }

# --- password (masked; never echoed, never logged) --------------------------
Write-Host ''
Write-Host 'NAS password (typing is hidden). Press Enter alone to keep the stored one.'
$secure = Read-Host 'Password' -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
           [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if ([string]::IsNullOrEmpty($plain)) {
  if (-not $currentPass) { Write-Host 'No password stored yet - you must enter one.' -ForegroundColor Red; exit 1 }
  $plain = $currentPass
  Write-Host 'Keeping the stored password.'
}

[Environment]::SetEnvironmentVariable('NAS_USER', $nasUser, 'User')
[Environment]::SetEnvironmentVariable('NAS_PASSWORD', $plain, 'User')
Write-Host ''
Write-Host ("Saved. NAS_USER = {0}, NAS_PASSWORD = (hidden)" -f $nasUser) -ForegroundColor Green

# --- optional check: can this account log in, and is it an administrator? ----
Write-Host ''
$doTest = Read-Host 'Test the login against the NAS now? (y/N)'
if ($doTest -match '^[Yy]') {
  # 2026-10-16: this used to be `Get-Command python`, which PASSES on a machine where the only
  # `python.exe` on PATH is Windows' Microsoft Store app execution alias (a real file, so
  # Get-Command finds it) -- it then prints "Python was not found" and exits 49, so the login test
  # silently never ran while this script reported nothing wrong. Measured on the office machine
  # (`tairo`): `python`/`python3` = alias, exit 49; `py` = real Python 3.14.4. So resolve the
  # interpreter by RUNNING each candidate, not by asking whether the name exists.
  # The probe runs through `cmd /c ... >NUL 2>NUL` on purpose: redirecting a native command's
  # stderr inside PowerShell 5.1 raises a NativeCommandError, and this script runs with
  # $ErrorActionPreference = 'Stop', so `& $cand -c 'import sys' *> $null` KILLS the script on the
  # very first broken candidate instead of falling through to the next one (measured 2026-10-16 --
  # the first version of this fix had that bug). Letting cmd.exe swallow the output keeps the
  # failure out of PowerShell's error stream entirely; $LASTEXITCODE is then cmd's, i.e. the child's.
  $interpreter = $null
  foreach ($cand in @('py', 'python', 'python3')) {
    if (-not (Get-Command $cand -ErrorAction SilentlyContinue)) { continue }
    & cmd.exe /c "$cand -c ""import sys"" >NUL 2>NUL"
    if ($LASTEXITCODE -eq 0) { $interpreter = $cand; break }
    Write-Host ("'{0}' is on PATH but did not run (exit {1}) - trying the next one." -f $cand, $LASTEXITCODE) -ForegroundColor DarkYellow
  }
  if (-not $interpreter) {
    Write-Host 'No working Python found on PATH - skipping the test.' -ForegroundColor Yellow
    Write-Host 'Install Python (python.org gives you `py`), then re-run this file.' -ForegroundColor Yellow
  } else {
    Write-Host ("Using interpreter: {0}" -f $interpreter) -ForegroundColor Green
    $env:NAS_USER = $nasUser
    $env:NAS_PASSWORD = $plain
    $probe = Join-Path $PSScriptRoot 'check_nas_account.py'
    if (Test-Path $probe) { & $interpreter $probe } else { Write-Host "Missing $probe - skipping." -ForegroundColor Yellow }
  }
}

Write-Host ''
Write-Host 'Close any open terminal and open a new one before deploying' -ForegroundColor Yellow
Write-Host '(an already-open window still holds the old environment).'
Write-Host ''
Read-Host 'Press Enter to close'
