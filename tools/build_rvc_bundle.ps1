# build_rvc_bundle.ps1
# Build offline RVC bundle for AntiGravity

param(
    [string]$OutDir = "resources/tts/rvc_bundle",
    [string]$WorkDir = ".tmp/rvc_bundle_work",
    [string]$BundleVersion = "$(Get-Date -Format 'yyyy.MM.dd')-rvc-gpu-v1",
    [string]$PythonUrl = "https://www.python.org/ftp/python/3.10.11/python-3.10.11-embed-amd64.zip",
    [string]$RvcAppDir = "tools/rvc_app",
    [string]$RequirementsFile = "tools/requirements_rvc.lock",
    [string]$TorchIndexUrl = "https://download.pytorch.org/whl/cu121"
)

$ErrorActionPreference = "Stop"

function Write-Log {
    param([string]$Message)
    Write-Host "[RVCBundleBuilder] $Message" -ForegroundColor Cyan
}

function Calculate-Hash {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $null }
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    $hash = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace("-", "").ToLower()
    $stream.Close()
    return $hash
}

Write-Log "Cleaning workspace..."
if (Test-Path $WorkDir) { Remove-Item -Recurse -Force $WorkDir }
New-Item -ItemType Directory -Force -Path "$WorkDir/download" | Out-Null
New-Item -ItemType Directory -Force -Path "$WorkDir/build" | Out-Null
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
New-Item -ItemType Directory -Force -Path "$OutDir/wheels" | Out-Null
New-Item -ItemType Directory -Force -Path "$OutDir/models" | Out-Null

if (-not (Test-Path $RvcAppDir)) {
    throw "RVC app directory not found: $RvcAppDir"
}
if (-not (Test-Path $RequirementsFile)) {
    throw "Requirements file not found: $RequirementsFile"
}

Write-Log "Downloading Python portable..."
$PythonZip = "$WorkDir/download/python_portable.zip"
Invoke-WebRequest -Uri $PythonUrl -OutFile $PythonZip

Write-Log "Setting up embeddable Python with pip..."
$PythonSetupDir = "$WorkDir/python_setup"
New-Item -ItemType Directory -Force -Path $PythonSetupDir | Out-Null
Expand-Archive -Path $PythonZip -DestinationPath $PythonSetupDir

$PthFile = Get-ChildItem -Path $PythonSetupDir -Filter "*._pth" | Select-Object -First 1
if ($PthFile) {
    $content = Get-Content $PthFile.FullName
    if ($content -match "#import site") {
        $content = $content -replace "#import site", "import site"
        Set-Content -Path $PthFile.FullName -Value $content
    }
}

$GetPipPath = "$PythonSetupDir/get-pip.py"
Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $GetPipPath
$PythonExe = "$PythonSetupDir/python.exe"
$pipInstall = Start-Process -FilePath $PythonExe -ArgumentList "$GetPipPath --no-warn-script-location" -Wait -NoNewWindow -PassThru
if ($pipInstall.ExitCode -ne 0) {
    throw "Failed to install pip into portable python"
}
Remove-Item $GetPipPath
Remove-Item $PythonZip
Compress-Archive -Path "$PythonSetupDir/*" -DestinationPath $PythonZip -Force

Write-Log "Packaging rvc_app.zip from $RvcAppDir ..."
$AppZip = "$WorkDir/download/rvc_app.zip"
Compress-Archive -Path "$RvcAppDir/*" -DestinationPath $AppZip -Force

Write-Log "Downloading wheels..."
$downloadCmd = "download -r `"$RequirementsFile`" -d `"$OutDir/wheels`" --extra-index-url $TorchIndexUrl --python-version 3.10 --platform win_amd64 --only-binary=:all: --ignore-requires-python"
$downloadProc = Start-Process -FilePath "pip" -ArgumentList $downloadCmd -Wait -NoNewWindow -PassThru
if ($downloadProc.ExitCode -ne 0) {
    Write-Warning "pip download failed for some packages. Verify torch/cu wheels availability."
}

Write-Log "Copying bundle files..."
Copy-Item $PythonZip -Destination "$OutDir/python_portable.zip" -Force
Copy-Item $AppZip -Destination "$OutDir/rvc_app.zip" -Force
Copy-Item $RequirementsFile -Destination "$OutDir/requirements.lock" -Force

$manifest = @{
    bundleVersion = $BundleVersion
    builtAt       = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssZ")
    files         = @()
    dirs          = @(
        @{ path = "wheels"; required = $true },
        @{ path = "models"; required = $true }
    )
    meta          = @{
        appType = "rvc"
        note    = "rvc_server.py is currently a passthrough stub; replace with real inference"
    }
}

foreach ($file in @("python_portable.zip", "rvc_app.zip", "requirements.lock")) {
    $fp = "$OutDir/$file"
    $manifest.files += @{
        path = $file
        sha256 = (Calculate-Hash $fp)
        size = (Get-Item $fp).Length
    }
}

$manifest | ConvertTo-Json -Depth 6 | Set-Content -Path "$OutDir/manifest_bundle.json"
Write-Log "RVC bundle complete: $OutDir"
