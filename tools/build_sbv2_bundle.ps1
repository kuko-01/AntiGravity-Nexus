# build_sbv2_bundle.ps1
# Automates creation of the SBV2 offline bundle for AntiGravity

param(
    [string]$OutDir = "resources/tts/sbv2_bundle",
    [string]$WorkDir = ".tmp/sbv2_bundle_work",
    [string]$BundleVersion = "$(Get-Date -Format 'yyyy.MM.dd')-sbv2-cpu-v1",
    [string]$Sbv2RepoUrl = "https://github.com/litagin02/Style-Bert-VITS2/archive/refs/heads/master.zip",
    [string]$PythonUrl = "https://www.python.org/ftp/python/3.10.11/python-3.10.11-embed-amd64.zip"
)

$ErrorActionPreference = "Stop"

function Write-Log {
    param([string]$Message)
    Write-Host "[BundleBuilder] $Message" -ForegroundColor Cyan
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

# 1. Setup Directories
Write-Log "Cleaning workspaces..."
if (Test-Path $WorkDir) { Remove-Item -Recurse -Force $WorkDir }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
New-Item -ItemType Directory -Force -Path "$WorkDir/download" | Out-Null
New-Item -ItemType Directory -Force -Path "$WorkDir/build" | Out-Null

# 2. Download Python Portable
Write-Log "Downloading Python Portable..."
$PythonZip = "$WorkDir/download/python_portable.zip"
Invoke-WebRequest -Uri $PythonUrl -OutFile $PythonZip

# 3. Download SBV2 Source
Write-Log "Downloading Style-Bert-VITS2 Source..."
$Sbv2Zip = "$WorkDir/download/sbv2_source.zip"
Invoke-WebRequest -Uri $Sbv2RepoUrl -OutFile $Sbv2Zip

# 2.5 Setup Python with pip (Embeddable needs manual setup)
Write-Log "Setting up Python with pip..."
$PythonSetupDir = "$WorkDir/python_setup"
if (Test-Path $PythonSetupDir) { Remove-Item -Recurse -Force $PythonSetupDir }
New-Item -ItemType Directory -Force -Path $PythonSetupDir | Out-Null

# Extract Python
Expand-Archive -Path $PythonZip -DestinationPath $PythonSetupDir

# Enable 'import site' in ._pth file to allow pip
# Enable 'import site' in ._pth file to allow pip
# Search for python*._pth file
$PthFile = Get-ChildItem -Path "$PythonSetupDir" -Filter "*._pth" | Select-Object -First 1

if ($PthFile) {
    Write-Log "Modifying $($PthFile.Name) to enable 'import site'..."
    $Content = Get-Content $PthFile.FullName
    if ($Content -match "#import site") {
        $Content = $Content -replace "#import site", "import site"
        Set-Content -Path $PthFile.FullName -Value $Content
        Write-Log "Enabled 'import site' in $($PthFile.Name)"
    }
    else {
        Write-Warning "'#import site' not found in $($PthFile.Name). Start-content: $($Content[0..3])"
    }
}
else {
    Write-Error "Could not find ._pth file in $PythonSetupDir. pip installation will likely fail at runtime."
}

# Download get-pip.py
$GetPipUrl = "https://bootstrap.pypa.io/get-pip.py"
$GetPipPath = "$PythonSetupDir/get-pip.py"
Invoke-WebRequest -Uri $GetPipUrl -OutFile $GetPipPath

# Install pip
Write-Log "Installing pip into portable python..."
# Using Start-Process to run in the extracted environment
$PythonExe = "$PythonSetupDir/python.exe"
$Proc = Start-Process -FilePath $PythonExe -ArgumentList "$GetPipPath --no-warn-script-location" -Wait -NoNewWindow -PassThru

if ($Proc.ExitCode -ne 0) {
    Write-Error "Failed to install pip. Exit code: $($Proc.ExitCode)"
}

# Remove get-pip.py to save space
Remove-Item $GetPipPath

# Re-zip Python
Write-Log "Re-packaging Python with pip..."
Remove-Item $PythonZip # Remove original
Compress-Archive -Path "$PythonSetupDir/*" -DestinationPath $PythonZip -Force

# 4. Extract and Patch SBV2
Write-Log "Extracting and Patching SBV2..."
Expand-Archive -Path $Sbv2Zip -DestinationPath "$WorkDir/build"
$SourceDir = Get-ChildItem "$WorkDir/build" | Where-Object { $_.PSIsContainer } | Select-Object -First 1
$ServerPy = "$($SourceDir.FullName)/server_fastapi.py"

if (Test-Path $ServerPy) {
    Write-Log "Patching server_fastapi.py with /health endpoint..."
    # Force UTF-8 reading/writing to avoid encoding issues (cp932 vs utf-8)
    $Content = Get-Content $ServerPy -Raw -Encoding UTF8
    # Add health endpoint if not exists
    if ($Content -notmatch "/health") {
        $Patch = @"

@app.get("/health")
def health_check():
    return {"status": "ok"}

"@
        # Insert before the last line or append
        $Content += $Patch
        Set-Content -Path $ServerPy -Value $Content -Encoding UTF8
    }
}
else {
    Write-Warning "server_fastapi.py not found using default zip structure. Skipping patch."
}

# 5. Create sbv2_app.zip
Write-Log "Packaging sbv2_app.zip..."
$AppZip = "$WorkDir/download/sbv2_app.zip"
Compress-Archive -Path "$($SourceDir.FullName)/*" -DestinationPath $AppZip -Force

# 6. Download Wheels
Write-Log "Downloading Wheels (this may take a while)..."
$WheelsDir = "$OutDir/wheels"
if (-not (Test-Path $WheelsDir)) { New-Item -ItemType Directory -Force -Path $WheelsDir | Out-Null }

$ReqFile = "tools/requirements.lock"
if (-not (Test-Path $ReqFile)) {
    Write-Error "tools/requirements.lock not found!"
}

# Check if pip is available
try {
    pip --version | Out-Null
}
catch {
    Write-Error "pip command not found. Please verify Python is installed and in PATH."
}

Write-Log "Running pip download (platform-specific packages)..."
# Step 1: Download platform-specific packages with --only-binary=:all:
$PipProcess = Start-Process -FilePath "pip" -ArgumentList "download -r $ReqFile -d $WheelsDir --python-version 3.10 --platform win_amd64 --only-binary=:all: --ignore-requires-python" -Wait -NoNewWindow -PassThru

if ($PipProcess.ExitCode -ne 0) {
    Write-Warning "Some packages may have failed. Attempting pure-python fallback for GPUtil..."
}

# Step 2: Download pure-python packages separately (no platform constraints)
# These are needed for building source distributions like GPUtil
# Also includes packages that may fail with platform constraints
Write-Log "Downloading additional packages..."
$PurePythonPackages = @(
    "setuptools", 
    "wheel", 
    "GPUtil", 
    "onnxruntime",
    "cmudict",
    "g2p_en",
    "nltk",
    "jieba",
    "pypinyin",
    "num2words",
    "cn2an",
    "pyworld-prebuilt",
    "pyopenjtalk-dict"
)
foreach ($pkg in $PurePythonPackages) {
    Write-Log "  Downloading $pkg..."
    $result = Start-Process -FilePath "pip" -ArgumentList "download $pkg -d $WheelsDir" -Wait -NoNewWindow -PassThru
    if ($result.ExitCode -ne 0) {
        Write-Warning "Failed to download $pkg"
    }
}

# 7. Collect and Hash Files
Write-Log "Generating Manifest..."
Copy-Item $PythonZip -Destination "$OutDir/python_portable.zip"
Copy-Item $AppZip -Destination "$OutDir/sbv2_app.zip"
Copy-Item $ReqFile -Destination "$OutDir/requirements.lock"

# Models (Download default jvnv-F1-jp)
$ModelsDir = "$OutDir/models"
if (-not (Test-Path $ModelsDir)) { New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null }

Write-Log "Downloading default model (jvnv-F1-jp)..."
$ModelName = "jvnv-F1-jp"
$ModelDestDir = "$ModelsDir/$ModelName"
if (-not (Test-Path $ModelDestDir)) { New-Item -ItemType Directory -Force -Path $ModelDestDir | Out-Null }

$BaseUrl = "https://huggingface.co/litagin/style_bert_vits2_jvnv/resolve/main/jvnv-F1-jp"
$ModelFiles = @(
    "jvnv-F1-jp.safetensors",
    "config.json",
    "style_vectors.npy"
)

foreach ($File in $ModelFiles) {
    $DestPath = "$ModelDestDir/$File"
    if (-not (Test-Path $DestPath)) {
        Write-Log "Downloading $File..."
        try {
            Invoke-WebRequest -Uri "$BaseUrl/$File" -OutFile $DestPath
        }
        catch {
            Write-Warning "Failed to download $File from $BaseUrl/$File"
        }
    }
    else {
        Write-Log "$File already exists."
    }
}

# Generate JSON
$Manifest = @{
    bundleVersion = $BundleVersion
    builtAt       = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssZ")
    files         = @()
    dirs          = @(
        @{ path = "wheels"; required = $true }
        @{ path = "models"; required = $true }
    )
    meta          = @{
        sbv2Revision = "master"
    }
}

$FilesToHash = @("python_portable.zip", "sbv2_app.zip", "requirements.lock")
foreach ($File in $FilesToHash) {
    $FilePath = "$OutDir/$File"
    if (Test-Path $FilePath) {
        $Hash = Calculate-Hash $FilePath
        $Size = (Get-Item $FilePath).Length
        $Manifest.files += @{
            path   = $File
            sha256 = $Hash
            size   = $Size
        }
    }
}

$ManifestJson = $Manifest | ConvertTo-Json -Depth 5
Set-Content -Path "$OutDir/manifest_bundle.json" -Value $ManifestJson

Write-Log "Bundle generation complete at $OutDir"
Write-Log "Manifest Written."
