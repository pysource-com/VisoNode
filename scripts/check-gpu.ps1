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
  Write-Warning ".venv was not found. Run the normal install or scripts\install-gpu.ps1 first."
  exit 1
}

if ($NvidiaSmiPath) {
  Write-Host "NVIDIA driver:"
  & $NvidiaSmiPath --query-gpu=name,driver_version,memory.total --format=csv,noheader
} else {
  Write-Warning "nvidia-smi was not found. PyTorch CUDA will not work until the NVIDIA driver is installed."
}

Write-Host ""
Write-Host "PyTorch CUDA:"
& $Python -c "import sys; import importlib.util; spec = importlib.util.find_spec('torch'); print('python', sys.version.split()[0]); print('torch installed', bool(spec)); exit(0 if spec else 2)"
if ($LASTEXITCODE -ne 0) {
  Write-Host "Install GPU support with: .\scripts\install-gpu.ps1"
  exit $LASTEXITCODE
}

& $Python -c "import torch; print('torch', torch.__version__); print('torch cuda build', torch.version.cuda); print('cuda available', torch.cuda.is_available()); print('device count', torch.cuda.device_count()); [print(f'cuda:{i} {torch.cuda.get_device_name(i)}') for i in range(torch.cuda.device_count())]"
