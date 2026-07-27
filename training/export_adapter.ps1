param(
  [string]$Python = ".\training\.venv\Scripts\python.exe",
  [string]$LlamaCpp = ".\training\tools\llama.cpp",
  [string]$Adapter = ".\training\output\zhizhi-qwen3-4b-lora\adapter",
  [string]$Output = ".\training\output\zhizhi-qwen3-4b-lora-f16.gguf"
)

$ErrorActionPreference = "Stop"
$pythonPath = (Resolve-Path -LiteralPath $Python).Path
$converterPath = (Resolve-Path -LiteralPath (Join-Path $LlamaCpp "convert_lora_to_gguf.py")).Path
$adapterPath = (Resolve-Path -LiteralPath $Adapter).Path
$outputPath = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Output))
$outputDirectory = Split-Path -Parent $outputPath

if (-not (Test-Path -LiteralPath (Join-Path $adapterPath "adapter_model.safetensors"))) {
  throw "Adapter weights not found in $adapterPath"
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$env:HF_HOME = [System.IO.Path]::GetFullPath(
  (Join-Path (Get-Location) ".\training\cache\huggingface")
)

& $pythonPath $converterPath `
  --base-model-id "Qwen/Qwen3-4B" `
  --outfile $outputPath `
  --outtype f16 `
  $adapterPath

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Get-Item -LiteralPath $outputPath | Select-Object FullName, Length, LastWriteTime
