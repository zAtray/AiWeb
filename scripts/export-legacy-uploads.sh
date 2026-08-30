#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target_directory="$project_root/data/uploads"
legacy_volume="aiweb_app-data"

if ! docker volume inspect "$legacy_volume" >/dev/null 2>&1; then
  echo "未找到旧上传卷 $legacy_volume；无需导出。"
  exit 0
fi

mkdir -p "$target_directory"
before_count=$(find "$target_directory" -type f | wc -l | tr -d ' ')
docker run --rm --entrypoint sh \
  --mount "type=volume,src=$legacy_volume,dst=/source,readonly" \
  --mount "type=bind,src=$target_directory,dst=/target" \
  mysql:8.4 -c '
    if [ ! -d /source/uploads ]; then exit 0; fi
    find /source/uploads -type f -exec sh -c '\''
      for source do
        relative=${source#/source/uploads/}
        target=/target/$relative
        mkdir -p "$(dirname "$target")"
        if [ ! -e "$target" ]; then cp -p "$source" "$target"; fi
      done
    '\'' sh {} +
  '
after_count=$(find "$target_directory" -type f | wc -l | tr -d ' ')
copied_count=$((after_count - before_count))

echo "旧上传导出完成：新增 $copied_count 个文件，目标现有 $after_count 个文件。"
echo "卷 $legacy_volume 保持原样，未删除、未写入。"

