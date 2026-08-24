$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$environmentFile = Join-Path $projectRoot ".env.docker"
$templateFile = Join-Path $projectRoot ".env.docker.example"
$script:appPort = 8000

function New-HexSecret([int]$Bytes = 24) {
  $buffer = New-Object byte[] $Bytes
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($buffer)
  } finally {
    $generator.Dispose()
  }
  return ([BitConverter]::ToString($buffer) -replace "-", "").ToLowerInvariant()
}

function Test-AiWebHealth {
  try {
    $request = [Net.HttpWebRequest]::Create(
      "http://127.0.0.1:$script:appPort/api/health"
    )
    $request.Method = "GET"
    $request.Timeout = 5000
    $request.Proxy = $null
    $response = $request.GetResponse()
    try {
      $reader = New-Object IO.StreamReader(
        $response.GetResponseStream(),
        [Text.Encoding]::UTF8
      )
      try {
        $health = $reader.ReadToEnd() | ConvertFrom-Json
        return $health.status -eq "ok"
      } finally {
        $reader.Dispose()
      }
    } finally {
      $response.Dispose()
    }
  } catch {
    return $false
  }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "未找到 Docker。请先安装并启动 Docker Desktop：https://www.docker.com/products/docker-desktop/"
}
& docker info *> $null
if ($LASTEXITCODE -ne 0) {
  throw "Docker Desktop 尚未启动，启动后请重新运行本脚本。"
}
& docker compose version *> $null
if ($LASTEXITCODE -ne 0) {
  throw "当前 Docker 缺少 Compose v2。请更新 Docker Desktop。"
}

if (-not (Test-Path -LiteralPath $environmentFile)) {
  $content = Get-Content -LiteralPath $templateFile -Raw -Encoding UTF8
  $dbPassword = New-HexSecret
  $content = $content.Replace("CHANGE_ME_ADMIN_PASSWORD", (New-HexSecret 16))
  $content = $content.Replace("CHANGE_ME_MYSQL_ROOT_PASSWORD", (New-HexSecret))
  $content = $content.Replace("CHANGE_ME_DB_PASSWORD", $dbPassword)
  [IO.File]::WriteAllText(
    $environmentFile,
    $content,
    (New-Object Text.UTF8Encoding($false))
  )
  Write-Host "已生成仅供本机使用的 .env.docker（不会提交到 GitHub）。"
}

$configuredPort = Get-Content -LiteralPath $environmentFile -Encoding UTF8 |
  Where-Object { $_ -match '^APP_PORT=(\d+)$' } |
  Select-Object -First 1
if ($configuredPort -and $configuredPort -match '^APP_PORT=(\d+)$') {
  $script:appPort = [int]$matches[1]
}
if ($script:appPort -lt 1 -or $script:appPort -gt 65535) {
  throw ".env.docker 中 APP_PORT 必须是 1 到 65535 的端口号。"
}

Push-Location $projectRoot
try {
  Write-Host "正在构建并启动 AiWeb。首次运行会下载 MySQL、Ollama 和约数 GB 的模型。"
  & docker compose --env-file $environmentFile up -d --build
  if ($LASTEXITCODE -ne 0) { throw "docker compose 启动失败。" }

  $deadline = [DateTime]::UtcNow.AddMinutes(45)
  $nextStatus = [DateTime]::UtcNow
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-AiWebHealth) {
      Write-Host "AiWeb 已启动：http://127.0.0.1:$script:appPort"
      Write-Host "初始管理员账号：admin；密码位于 .env.docker 的 ADMIN_PASSWORD。"
      exit 0
    }
    if ([DateTime]::UtcNow -ge $nextStatus) {
      & docker compose --env-file $environmentFile ps
      $nextStatus = [DateTime]::UtcNow.AddSeconds(20)
    }
    Start-Sleep -Seconds 2
  }
  throw "45 分钟内未通过健康检查。请运行 docker compose --env-file .env.docker logs --tail 200。"
} finally {
  Pop-Location
}
