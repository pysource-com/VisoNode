param(
  [ValidateSet("cu128", "cu126", "cu118")]
  [string]$CudaWheel = "cu128"
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Python = Join-Path $Root ".venv\Scripts\python.exe"
$NvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if (-not $NvidiaSmi -and (Test-Path "C:\Windows\Sysnative\nvidia-smi.exe")) {
  $NvidiaSmiPath = "C:\Windows\Sysnative\nvidia-smi.exe"
} elseif ($NvidiaSmi) {
  $NvidiaSmiPath = $NvidiaSmi.Source
} else {
  $NvidiaSmiPath = $null
}

if (-not (Test-Path $Python)) {
  Write-Host "Creating .venv..."
  py -3 -m venv (Join-Path $Root ".venv")
}

if ($NvidiaSmiPath) {
  & $NvidiaSmiPath
} else {
  Write-Warning "nvidia-smi was not found. Install or update the NVIDIA driver before expecting CUDA acceleration."
}

$IndexUrl = "https://download.pytorch.org/whl/$CudaWheel"

Write-Host "Installing CUDA-enabled PyTorch from $IndexUrl"
& $Python -m pip install --upgrade pip
& $Python -m pip install --upgrade torch torchvision torchaudio --index-url $IndexUrl
& $Python -m pip install -r (Join-Path $Root "requirements.txt")

Write-Host "Running CUDA smoke test..."
& $Python -c "import torch; print('torch', torch.__version__); print('torch cuda', torch.version.cuda); print('cuda available', torch.cuda.is_available()); print('device count', torch.cuda.device_count()); print('device 0', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'none')"
