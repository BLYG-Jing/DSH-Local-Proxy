#!/usr/bin/env bash
# Install only DSH Local Proxy as an independent systemd user service.
set -Eeuo pipefail

fail() { printf '错误：%s\n' "$*" >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || fail '未找到 systemctl。'
command -v node >/dev/null 2>&1 || fail '未找到 Node.js。'
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" =~ ^[0-9]+$ ]] && (( node_major >= 18 )) || fail '需要 Node.js 18 或更高版本。'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$script_dir/../.." && pwd)"
app_dir="${XDG_DATA_HOME:-$HOME/.local/share}/dsh-local-proxy"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/dsh-local-proxy"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit_file="$unit_dir/dsh-local-proxy.service"

install -d -m 700 "$app_dir" "$config_dir" "$unit_dir"
install -m 755 "$project_dir/server.js" "$app_dir/server.js"
install -m 644 "$project_dir/index.html" "$app_dir/index.html"
install -m 644 "$project_dir/package.json" "$app_dir/package.json"
install -d -m 755 "$app_dir/lib" "$app_dir/adapters" "$app_dir/docs"
install -m 644 "$project_dir"/lib/*.js "$app_dir/lib/"
install -m 644 "$project_dir"/adapters/*.js "$app_dir/adapters/"
install -m 644 "$project_dir/docs/systemd-user.md" "$app_dir/docs/systemd-user.md"
install -m 644 "$project_dir/docs/harness-adapter.md" "$app_dir/docs/harness-adapter.md"

node_path="$(command -v node)"
sed \
  -e "s|%h/.local/lib/dsh-local-proxy|$app_dir|g" \
  -e "s|%h/.config/dsh-local-proxy|$config_dir|g" \
  -e "s|ExecStart=/usr/bin/env node server.js|ExecStart=$node_path server.js|" \
  "$script_dir/dsh-local-proxy.service" > "$unit_file"
chmod 644 "$unit_file"

if [[ ! -e "$config_dir/proxy.env" ]]; then
  install -m 600 "$script_dir/proxy.env.example" "$config_dir/proxy.env"
  config_created=1
else
  config_created=0
fi

systemctl --user daemon-reload
printf '代理程序已安装到 %s\n' "$app_dir"
printf '代理服务单元已安装到 %s\n' "$unit_file"
if (( config_created )); then
  printf '请先编辑 %s 并替换示例密码。\n' "$config_dir/proxy.env"
fi
printf '然后运行：systemctl --user enable --now dsh-local-proxy.service\n'
printf '本安装器和服务只管理代理，绝不启动、停止或重启 Harness。\n'
