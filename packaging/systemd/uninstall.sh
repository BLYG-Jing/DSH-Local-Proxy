#!/usr/bin/env bash
# Remove only DSH Local Proxy. Harness is never inspected or managed.
set -Eeuo pipefail

purge=0
case "${1:-}" in
  '') ;;
  --purge) purge=1 ;;
  *) printf '用法：%s [--purge]\n' "$0" >&2; exit 2 ;;
esac

app_dir="${XDG_DATA_HOME:-$HOME/.local/share}/dsh-local-proxy"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/dsh-local-proxy"
unit_file="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/dsh-local-proxy.service"

systemctl --user disable --now dsh-local-proxy.service 2>/dev/null || true
rm -f -- "$unit_file"
systemctl --user daemon-reload
systemctl --user reset-failed dsh-local-proxy.service 2>/dev/null || true
rm -rf -- "$app_dir"
if (( purge )); then
  rm -rf -- "$config_dir"
  printf '代理配置和凭据已清除。\n'
else
  printf '已保留代理配置：%s\n' "$config_dir/proxy.env"
fi
printf '仅卸载了 DSH Local Proxy；未检查或操作 Harness。\n'
