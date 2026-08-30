# systemd 用户服务

该方式让 DSH Local Proxy 拥有独立于 Harness 的进程生命周期。

## 生命周期边界

代理只连接配置的 HTTP/WebSocket 上游，**不会启动、停止、重启、探测 PID、发送信号或监督 Harness**。服务单元没有与 Harness 关联的 `Requires=`、`BindsTo=` 或 `PartOf=`。Harness 未启动或重启时，代理继续监听；Harness 恢复后，新请求会自然恢复。

## 安装

```bash
bash packaging/systemd/install.sh
```

安装器会把运行文件复制到用户数据目录，把配置放到用户配置目录，并执行 `systemctl --user daemon-reload`。它不会自动启动服务，避免示例密码直接生效。

编辑配置：

```bash
${EDITOR:-vi} ~/.config/dsh-local-proxy/proxy.env
```

`AUTH_PASSWORD_B64` 是密码 UTF-8 字节的 base64 表示，可交互生成：

```bash
printf 'Password: ' >&2
read -rs P
echo >&2
printf %s "$P" | base64 | tr -d '\n'
unset P
```

然后仅启动代理服务：

```bash
systemctl --user enable --now dsh-local-proxy.service
systemctl --user status dsh-local-proxy.service
journalctl --user -u dsh-local-proxy.service -n 50 --no-pager
```

用户服务通常随登录会话启动。若需要无登录运行，应由用户自行决定是否配置 lingering；安装器不会改变这项系统策略。

## 健康与恢复

```bash
curl -i http://127.0.0.1:18082/__health/live
curl -i http://127.0.0.1:18082/__health/ready
```

- `live` 仅表示代理进程能处理请求，绝不连接 Harness。
- `ready` 使用真实代理流量产生的被动状态，不主动探测 Harness。
- 尚无观察、观察过期或上游不可用时，`ready` 返回 `503`。
- 收到新的上游响应后，`ready` 返回 `200`。
- 两个接口仅返回最少状态，不暴露主机、端口或底层网络错误。

Harness 不可用时，已认证的页面导航收到不缓存的本地 `503` 页面，API 收到稳定 JSON `503`。代理保持运行，也不会尝试干预 Harness。WebSocket 已建立后若上游消失会断开，使浏览器能够重连；连接前失败则返回有效的 HTTP `503` 握手响应。

## 验证独立性

把 `UPSTREAM_PORT` 临时设置为一个未使用端口并重启**代理自身**：

```bash
systemctl --user restart dsh-local-proxy.service
systemctl --user is-active dsh-local-proxy.service
curl -i http://127.0.0.1:18082/__health/live
curl -i http://127.0.0.1:18082/__health/ready
```

预期代理保持 `active`，`live` 为 `200`，`ready` 为 `503`。恢复正确上游配置后再次重启代理即可；整个测试不需要执行任何 Harness 生命周期命令。

静态检查：

```bash
systemd-analyze --user verify ~/.config/systemd/user/dsh-local-proxy.service
systemctl --user show dsh-local-proxy.service -p Requires -p BindsTo -p PartOf -p After
```

输出中不应出现 Harness 服务依赖。

## 升级与卸载

再次运行安装器会更新代理运行文件，但不会覆盖现有 `proxy.env`。

```bash
bash packaging/systemd/uninstall.sh
```

默认停止并删除的只有 `dsh-local-proxy.service`，并保留配置。明确需要删除代理凭据时使用：

```bash
bash packaging/systemd/uninstall.sh --purge
```

卸载脚本不会检查、停止或重启 Harness，也不会使用宽泛的 `pkill`/`killall` 命令。
