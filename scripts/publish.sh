#!/bin/bash
# 构建 vsix 并把改动同步到 GitHub（本机网络下 git push 会被代理拦截，故走 Git Data API）
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
npx vsce package --no-dependencies --allow-missing-repository
python3 scripts/sync_remote.py
git fetch --tags origin >/dev/null 2>&1 || true
git reset --soft origin/main 2>/dev/null || true
echo "完成。"
