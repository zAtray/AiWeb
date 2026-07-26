$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

if (-not (Test-Path "node_modules")) {
    npm install
}
if (-not (Test-Path "frontend\dist\index.html") -or -not (Test-Path "server\dist\index.js")) {
    npm run build
}

npm start

