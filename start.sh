#!/usr/bin/env bash
# Linux-only interactive launcher for DSH Local Proxy.
set -Eeuo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

fail() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail '未找到 Node.js。请安装 Node.js 18 或更高版本后重试。'
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" =~ ^[0-9]+$ ]] && (( node_major >= 18 )) || \
  fail "Node.js 版本过低（当前 $(node --version)，需要 >= 18）。"

[[ -t 0 ]] || fail 'start.sh 需要在交互式终端中运行。'

read_port() {
  local prompt="$1" value
  while true; do
    read -r -p "$prompt" value || fail '读取端口失败。'
    if [[ "$value" =~ ^[0-9]+$ ]] && (( value >= 1 && value <= 65535 )); then
      printf '%s' "$value"
      return
    fi
    printf '错误：请输入 1 到 65535 之间的端口号。\n' >&2
  done
}

read -r -p '代理监听端口（例如 18082）：' listen_port || fail '读取代理端口失败。'
[[ "$listen_port" =~ ^[0-9]+$ ]] && (( listen_port >= 1 && listen_port <= 65535 )) || \
  fail '代理监听端口必须是 1 到 65535 之间的端口号。'
upstream_port="$(read_port 'Harness Web 上游端口：')"
read -r -s -p '代理登录密码：' auth_password || fail '读取密码失败。'
printf '\n'
[[ -n "$auth_password" ]] || fail '密码不能为空。'
auth_password_b64="$(printf '%s' "$auth_password" | base64 | tr -d '\n')"

config_file="${DSH_ENV_FILE:-.env}"
umask 077
cat > "$config_file" <<EOF
# 本地配置：此文件包含凭据，已被 .gitignore 忽略。
LISTEN_HOST=127.0.0.1
LISTEN_PORT=$listen_port
UPSTREAM_HOST=127.0.0.1
UPSTREAM_PORT=$upstream_port
HISTORY_READ_TIMEOUT_MS=120000
WEBSOCKET_HANDSHAKE_TIMEOUT_MS=10000
UPSTREAM_STATE_TTL_MS=60000
AUTH_PASSWORD_B64=$auth_password_b64
EOF
chmod 600 "$config_file"

printf '配置已保存到 %s。\n' "$config_file"
printf '启动代理：http://127.0.0.1:%s/\n' "$listen_port"
printf 'Harness 可以尚未启动；代理不会启动、停止或重启 Harness。\n'
exec env \
  LISTEN_HOST=127.0.0.1 \
  LISTEN_PORT="$listen_port" \
  UPSTREAM_HOST=127.0.0.1 \
  UPSTREAM_PORT="$upstream_port" \
  HISTORY_READ_TIMEOUT_MS=120000 \
  WEBSOCKET_HANDSHAKE_TIMEOUT_MS=10000 \
  UPSTREAM_STATE_TTL_MS=60000 \
  AUTH_PASSWORD_B64="$auth_password_b64" \
  node server.js
