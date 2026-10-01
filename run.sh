#!/usr/bin/env bash
# 一条本地启动命令：重建样例数据（含缺货替换与临时追加）并启动服务。
set -e
cd "$(dirname "$0")"

PORT="${PORT:-8000}"

python3 -m app.seed
echo "------------------------------------------------"
python3 -m app.server 127.0.0.1 "$PORT"
