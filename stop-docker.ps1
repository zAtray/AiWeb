$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$environmentFile = Join-Path $projectRoot ".env.docker"
if (-not (Test-Path -LiteralPath $environmentFile)) {
  throw "缺少 .env.docker；此目录尚未执行过 start-docker.ps1。"
}

Push-Location $projectRoot
try {
  & docker compose --env-file $environmentFile down
  if ($LASTEXITCODE -ne 0) { throw "docker compose 停止失败。" }
  Write-Host "AiWeb 已停止。数据库、上传文件和模型仍保留在 Docker volumes 中。"
} finally {
  Pop-Location
}

