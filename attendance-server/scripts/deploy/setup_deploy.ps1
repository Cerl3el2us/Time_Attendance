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
  $py = (Get-Command python -ErrorAction SilentlyContinue)
  if (-not $py) {
    Write-Host 'python not found on PATH - skipping the test. Install Python, then re-run this file.' -ForegroundColor Yellow
  } else {
    $env:NAS_USER = $nasUser
    $env:NAS_PASSWORD = $plain
    $probe = Join-Path $PSScriptRoot 'check_nas_account.py'
    if (Test-Path $probe) { & python $probe } else { Write-Host "Missing $probe - skipping." -ForegroundColor Yellow }
  }
}

Write-Host ''
Write-Host 'Close any open terminal and open a new one before deploying' -ForegroundColor Yellow
Write-Host '(an already-open window still holds the old environment).'
Write-Host ''
Read-Host 'Press Enter to close'
