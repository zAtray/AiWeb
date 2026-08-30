#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
environment_file="$project_root/.env.docker"

if [ ! -f "$environment_file" ]; then
  echo "缺少 .env.docker。" >&2
  exit 1
fi

cd "$project_root"
docker compose --env-file "$environment_file" stop mysql
echo "MySQL 已停止；所有 Docker volumes 均已保留。"
