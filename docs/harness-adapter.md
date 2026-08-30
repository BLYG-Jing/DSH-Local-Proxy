# Harness 适配器维护指南

目标是让代理传输核心保持稳定。当 Harness 的路径、启动图或客户端 bundle 改变时，优先只修改 `adapters/harness.js` 及其适配器测试。

## 依赖方向

```text
server.js（组合根）
  ├─ adapters/harness.js
  ├─ lib/config.js
  ├─ lib/auth.js
  ├─ lib/upstream-state.js
  ├─ lib/proxy-http.js
  └─ lib/proxy-websocket.js
```

`lib/` 中的核心模块不得导入 `adapters/harness.js`。`server.js` 创建适配器实例，再把它注入 HTTP 和 WebSocket 核心。这样核心只依赖适配器接口，不知道 Harness 路径和负载特征。

## 适配器拥有的内容

`adapters/harness.js` 集中维护：

- Harness 路径：Manifest、SSE、慢速历史 API、连接插件；
- 请求分类：SSE、长超时、需要缓冲补丁、可压缩资源；
- 本机语义请求头：`Host`、`Origin`、`Referer` 和来源头清理；
- Harness loopback 重定向地址改写；
- `__DSH_BOOT__` 解析和可信插件 URL；
- 版本化插件及哈希资源缓存判定；
- 入口 HTML 与连接插件源码补丁；
- Harness 专用的不可用页面、错误 JSON 和 Manifest 未认证响应；
- 动态补丁资源的默认 Content-Type 和错误文字。

每个代理服务器创建独立适配器实例，因此从启动图发现的可信插件集合不会跨实例泄漏。

## 核心模块拥有的内容

- `lib/config.js`：环境读取、base64 密码和通用数值校验；
- `lib/auth.js`：密码登录、代理 Cookie、认证路由和 Cookie 隔离；
- `lib/upstream-state.js`：不理解产品语义的被动可用状态；
- `lib/http-utils.js`：HTTP 头、响应、压缩协商工具；
- `lib/proxy-http.js`：HTTP/SSE 连接、超时、流错误、缓冲上限、压缩和断连清理；
- `lib/proxy-websocket.js`：TCP 连接、RFC WebSocket 握手验证、隧道和对称关闭；
- `server.js`：组合模块、健康/认证/诊断路由和 CLI 启动。

这些核心模块不得出现 Harness API 路径、`__DSH_BOOT__`、`WebApiClient` 或连接插件包名。

## 适配器接口

`createHarnessAdapter({ upstreamPort, historyReadTimeoutMs, auth })` 返回：

| 方法/字段 | 核心用途 |
| --- | --- |
| `constants.manifestPath` | 未认证 Manifest 特例 |
| `classify(req, pathname)` | 返回 SSE、补丁、超时和压缩策略 |
| `requestHeaders(headers, policy)` | 构造 Harness 本机语义请求头 |
| `responseHeaders(headers)` | 清理并改写 Harness 响应头 |
| `transform(kind, body)` | 更新启动图信任状态并修改 HTML/插件 |
| `isImmutableRequest(url, pathname)` | 判断可信长期缓存资源 |
| `sendUnavailable(...)` | 输出 Harness 专用 HTTP 503 |
| `sendManifestUnavailable(...)` | 输出未认证 Manifest JSON |
| `websocketUnavailableBody()` | WebSocket 建连失败响应体 |
| `patchContentType(kind)` | 补丁响应默认类型 |
| `encodedPatchError` / `failedPatchError` | 补丁失败文字 |

如果未来要支持多个 Harness 协议版本，应增加新的适配器实现或在该适配器内部按可验证特征分派，不要把版本判断重新散布到 `lib/`。

## Harness 更新时的操作顺序

1. 保存新版本入口 HTML 和连接插件的无凭据测试夹具。
2. 检查路径和 `__DSH_BOOT__` 表达式是否变化。
3. 检查 `isLoopbackHostname` 和 `new WebApiClient()` 源码锚点是否变化。
4. 只调整 `adapters/harness.js` 的常量、分类器、解析器或补丁函数。
5. 为新旧兼容形态增加适配器单元测试。
6. 运行 `npm test`，确认通用 HTTP/SSE/WebSocket 生命周期测试不需改变。
7. 如果必须修改 `lib/`，先证明变化属于通用传输协议而不是某一 Harness 版本。

## 不可突破的边界

适配器只能解释和转换网络请求/响应，不得：

- 启动、停止、重启或监督 Harness；
- 查找 Harness PID 或端口所有者；
- 调用 `child_process`、`process.kill`、`systemctl` 或 `dsh`；
- 修改 Harness 安装目录或插件文件。

恢复仅表示用户独立恢复 Harness 后，代理的新网络请求重新连接成功。
