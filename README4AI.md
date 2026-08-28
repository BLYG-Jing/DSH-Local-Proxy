# README4AI.md — DSH Local Proxy 技术说明

本文档面向参与维护、排查或扩展本项目的 AI agent。面向普通用户的简介位于 [`README.md`](README.md)。

## 项目边界

DSH Local Proxy 是一个 Node.js 本地反向代理，用于把浏览器对代理入口的 HTTP 与 WebSocket 请求转发到本机运行的 DeepSeek Harness Web。

它不修改 Harness 或已安装插件文件。兼容处理只发生在代理响应阶段。代理通过登录密码保护入口，并将代理访问重新表达为上游所需的本机访问语义。

项目只使用 Node.js 内置模块，没有第三方 npm 依赖。要求 Node.js 18 或更高版本。

## 请求路径

```text
浏览器
  │ HTTP / WebSocket
  ▼
代理入口（默认监听地址 127.0.0.1，端口由 start.sh 启动时输入）
  ├─ 未认证：登录页；不连接上游
  ├─ 已认证：转发请求
  └─ 代理层兼容处理
  ▼
Harness Web 上游（默认地址 127.0.0.1，端口由 start.sh 启动时输入）
```

认证成功后，代理签发仅在当前进程有效的 `HttpOnly`、`SameSite=Strict` 会话 Cookie。进程重启后，旧会话失效。

## 启动方式

### 交互式脚本

```bash
./start.sh
```

`start.sh` 的行为：

1. 切换到脚本所在目录，因此可以从其他当前目录调用。
2. 检查 `node` 是否存在以及主版本是否至少为 18。
3. 要求用户输入代理监听端口。
4. 要求用户输入 Harness Web 上游端口。
5. 以隐藏输入方式要求用户输入代理登录密码。
6. 将配置写入 `.env`，并设置权限为 `600`。
7. 通过环境变量启动 `node server.js`。

脚本不会自动生成密码，也不会通过 TCP 连接判断某个端口上的服务是否是 Harness。端口是否对应正确的 Harness Web 服务由用户负责确认。

配置文件路径可以通过 `DSH_ENV_FILE` 覆盖：

```bash
DSH_ENV_FILE=/absolute/path/to/config ./start.sh
```

当前脚本启动时会覆盖该配置文件中的本项目配置。不要把真实配置文件放进 Git 仓库。

### 手动启动

```bash
LISTEN_HOST=127.0.0.1 \
LISTEN_PORT=18082 \
UPSTREAM_HOST=127.0.0.1 \
UPSTREAM_PORT=18080 \
AUTH_PASSWORD='replace-with-a-long-password' \
npm start
```

手动启动时，`server.js` 不会自动读取 `.env`。它只读取进程环境变量。

## 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `LISTEN_HOST` | `127.0.0.1` | 代理监听地址 |
| `LISTEN_PORT` | `18082` | 代理监听端口 |
| `UPSTREAM_HOST` | `127.0.0.1` | Harness Web 上游地址 |
| `UPSTREAM_PORT` | `18080` | Harness Web 上游端口；必须是数字端口 |
| `HISTORY_READ_TIMEOUT_MS` | `120000` | 历史会话列表和内容读取超时 |
| `RESPONSE_COMPRESSION` | `1` | 是否协商 Brotli/gzip |
| `COMPRESSION_THRESHOLD_BYTES` | `1024` | 小于此大小的响应不压缩 |
| `MAX_PATCHED_RESPONSE_BYTES` | `2097152` | 允许缓冲的 HTML/连接插件响应上限 |
| `IMMUTABLE_STATIC_CACHE` | `1` | 是否启用可信静态资源长期缓存 |
| `AUTH_PASSWORD` | 无 | 必须提供的代理登录密码 |

## 认证边界

认证检查发生在任何上游连接之前：

- 未认证 HTTP 请求跳转到登录页。
- 未认证 WebSocket Upgrade 返回 `401`。
- 登录页、登录接口和登出接口属于代理本地路由。
- 认证 Cookie 不会转发给 Harness。
- 密码使用定时安全比较。
- 会话令牌随机生成并只保存在当前进程内。

代理会删除 hop-by-hop 请求头、外部来源头、转发头和常见客户端 IP 头，然后重写 `Host`、`Origin`、`Referer` 为上游本机地址。这样做是为了让上游看到本机访问语义，而不是为了修改上游文件或关闭上游内部安全机制。

## 响应兼容处理

代理对入口 HTML 和特定连接插件执行响应阶段补丁：

1. `/` 和 `/index.html` 注入 `crypto.randomUUID` 兼容实现及本机语义标记。
2. `/plugins/@deepseek-ai/dsh-client-connection/client.js` 动态修补 loopback 判断。
3. 同步浏览器 API 客户端超时与弱网历史读取超时，避免前端先于代理中止历史读取。
4. `/api/session.list` 和 `/api/session.history` 使用较长读取超时；普通 API 保持快速失败。
5. `/manifest.webmanifest` 在未认证时返回合法 JSON 认证响应，避免浏览器把重定向误当 Manifest 内容。
6. `/plugins/events` 作为 SSE 长连接处理：禁用普通上游超时，设置禁止转换/缓冲的响应语义，并定期发送注释心跳。
7. `/api/events.mux` 和 `/api/events.host` WebSocket 不设置应用层空闲超时，仅使用 TCP keepalive；任一侧断开时关闭另一侧。
8. 对入口 HTML 和连接插件强制向上游请求 `identity`，以便安全执行文本补丁。

代理不应对用户个性化 API、错误响应、Range/206、SSE、WebSocket、二进制内容或已经编码的内容执行普通压缩。

## 压缩与缓存

成功的文本静态响应会根据浏览器的 `Accept-Encoding` 协商 Brotli 或 gzip。Brotli 质量为 4，gzip 级别为 6。压缩响应追加 `Vary: Accept-Encoding`。

只有以下资源可以获得浏览器私有长期缓存：

- 文件名包含哈希、没有查询参数的 `/assets/` 资源；
- 非动态补丁插件 bundle，且只有一个规范的 12 位十六进制 `rev` 查询参数。

缓存策略为 `private, max-age=31536000, immutable`。入口 HTML、错误响应和动态连接插件不应进入长期缓存。不得把用户响应放入共享代理缓存。

## 安全约束

- 不要提交 `.env`、密码、Cookie、私钥或其他凭据。
- 默认只监听 `127.0.0.1`。只有在用户明确理解风险并自行配置防火墙、HTTPS 和访问控制时，才考虑监听其他地址。
- 纯 HTTP 连接不会加密密码和会话 Cookie，不应直接暴露到不可信网络或公网。
- 不要把“端口可建立 TCP 连接”解释为“端口上运行着 Harness”。启动脚本只接受用户明确输入的上游端口，不负责识别服务类型。
- 不要修改 `/home/blyg/deepseek-harness/` 或已安装插件树；本项目的兼容逻辑必须保持在代理响应层。

## 项目文件

```text
.
├── .env.example       # 无真实凭据的配置参考
├── .gitignore         # 忽略凭据、依赖和生成文件
├── README.md          # 面向普通用户的简介和启动说明
├── README4AI.md       # 本技术维护说明
├── package.json       # npm 元数据、启动和测试命令
├── server.js          # 认证、HTTP/WebSocket 转发和兼容处理
├── server.test.js     # 自动化测试
├── index.html         # /__local/ 诊断页
└── start.sh           # Linux 交互式配置和启动脚本
```

## 验证命令

```bash
bash -n start.sh
node --check server.js
npm test
```

未认证入口的基本检查：

```bash
curl -i http://127.0.0.1:18082/
curl -i http://127.0.0.1:18082/__auth/login
```

不要把包含真实密码的命令保存到仓库；命令行参数也可能进入 shell 历史记录。
