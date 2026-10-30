param([ValidateSet('install','start','stop')][string]$Action='start')
$ErrorActionPreference='Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
function Refresh-Path {
  $env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')
}
function Need-Command($Command,$Package) {
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw "Missing $Command. Install $Package using Windows App Installer (winget), then retry." }
    & winget install --exact --id $Package --source winget
    if ($LASTEXITCODE -ne 0) { throw "Installation failed: $Package ($LASTEXITCODE)" }
    Refresh-Path
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { throw "$Package installed. Close this window and run install again to refresh PATH." }
  }
}
try {
  if ($Action -eq 'install') {
    Need-Command node 'OpenJS.NodeJS.LTS'
    $nodeVersion=& node -p 'process.versions.node'
    if ([int]($nodeVersion -split '\.')[0] -lt 22) { throw 'Node.js 22+ required. Upgrade Node.js at https://nodejs.org/en/download' }
    Need-Command ffmpeg 'Gyan.FFmpeg'
    Need-Command ffprobe 'Gyan.FFmpeg'
    $python=$null
    if (Get-Command py -ErrorAction SilentlyContinue) {
      try { $python=& py -3.12 -c 'import sys; print(sys.executable)' 2>$null; if ($LASTEXITCODE -ne 0) {$python=$null} } catch { $python=$null }
    }
    if (-not $python) {
      Need-Command winget 'Microsoft.AppInstaller'
      & winget install --exact --id Python.Python.3.12 --source winget
      if ($LASTEXITCODE -ne 0) { throw 'Python installation failed. Install Python 3.12 from python.org and retry.' }
      Refresh-Path
      $python=Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
      if (-not (Test-Path $python)) { $python=& py -3.12 -c 'import sys; print(sys.executable)' }
    }
    & $python -m venv .cutpot/subtitle-runtime
    if ($LASTEXITCODE -ne 0) { throw 'Python environment creation failed' }
    & ./.cutpot/subtitle-runtime/Scripts/python.exe -m pip install -r requirements-subtitles.txt
    if ($LASTEXITCODE -ne 0) { throw 'Pillow installation failed' }
    & node scripts/desktop.mjs check
    if ($LASTEXITCODE -ne 0) { throw 'Dependency check failed' }
    Write-Host 'Installed. Run the Windows start entry. CLI: .\cutpot-cli.cmd'
  } elseif ($Action -eq 'stop') {
    & node bin/cutpot-cli.js stop
    if ($LASTEXITCODE -ne 0) { throw 'Service was not stopped. Check running tasks.' }
  } else {
    & node scripts/desktop.mjs start
    if ($LASTEXITCODE -ne 0) { throw 'Startup failed. Run install first.' }
  }
} catch { Write-Host $_ -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }
if ($Action -eq 'install') { Read-Host 'Press Enter to close' }
