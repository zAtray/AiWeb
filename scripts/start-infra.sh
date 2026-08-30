#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
environment_file="$project_root/.env.docker"

if ! command -v docker >/dev/null 2>&1; then
  echo "未找到 docker，请先安装并启动 Docker Desktop 或 Docker Engine。" >&2
  exit 1
fi
if [ ! -f "$environment_file" ]; then
  echo "缺少 .env.docker；请先从 .env.docker.example 创建并填写现有数据库密码。" >&2
  exit 1
fi

cd "$project_root"
mkdir -p data/uploads data/ocr-temp
docker compose --env-file "$environment_file" up -d mysql
docker compose --env-file "$environment_file" ps mysql
