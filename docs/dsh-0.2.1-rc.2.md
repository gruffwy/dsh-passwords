# DSH 0.2.1-rc.2 兼容适配

本适配基于 dsh-passwords 2.7.8，处理 DSH 0.2.1-rc.2 原生设置实现被旧补丁检查误判的问题。依赖锁和版本范围保持不变；本地验证不代表生产部署或多用户验收完成。

## 原因与改动

旧版客户端通过 `connection.isLoopback` 或 `ctx.remote.$host.isLoopback` 选择 `host`、`memory` 持久化模式。rc.2 使用 `SettingsDescribeMirror` 直接调用 `settings.describe()`，不再包含旧三元表达式，也不包含旧的 `const persistence = "host"` 声明。

`patchStatus()` 保留 `settingsHostMode` 布尔字段，另提供 `settingsMode`：

| 值 | 含义 |
|---|---|
| `patched` | 所有设置副本均为已修复的旧版持久化实现 |
| `native` | 至少一份副本为已识别的 rc.2 原生实现，其余副本均满足兼容条件 |
| `unsupported` | 设置包缺失、不可读取，或存在未识别的实现 |

原生识别同时检查 DSH 与设置包的 `0.2.1-rc.2` 版本身份，以及描述读取、服务注入和更新订阅的代码契约。其他版本不会仅凭旧锚点消失而被视为原生支持。旧版仍按原有路径应用补丁；无关的 `"host"` 字符串不再作为成功证据。

## 启动检查

原生模式在创建数据库和监听端口前，通过已有的上游认证 Cookie 发送一次只读 `POST /api/settings/describe`。检查 HTTP 状态、RPC 关联 ID、成功状态及 `writable`、`hasDocument`、`namespaces` 的结构。只读设置提供器也可以通过检查，客户端继续遵循其 `writable` 状态。

检查不输出配置值或 Cookie，不跟随重定向。响应上限为 4 MiB，总时限为 3 秒。认证缺失、读取失败、响应截断或格式不符时，网关以退出码 `35` 终止。

原生设置客户端不会被重写，也不会为此生成补丁备份。Cookie 桥接沿用现有补丁和哈希回滚机制。首次注入桥接后，需要重启 DSH，让宿主进程加载新方法。插件通过现有的内存通道向网关子进程提供认证 Cookie；不要把 Cookie 写入部署文件。

## 本地验证证据

- 新增回归覆盖原生识别、包版本不匹配、契约缺失、重复设置副本、启动检查及失败时不创建数据库。
- 保留旧版补丁、版本边界、Cookie 桥接和回滚测试。
- 使用完整的官方 `@deepseek-ai/dsh-client-ui-settings@0.2.1-rc.2` 与 `@deepseek-ai/dsh-client-connection@0.2.1-rc.2` 发布包，验证设置文件保持不变、桥接注入后语法有效、重复执行无改动，以及回滚恢复原文件。
- rc.2 设置客户端 `lib/client.js` 的 SHA-256 为 `0555eec2df1ca392a1167e637f287ac9963dbd2b0a230089c2a41be079c490e3`。

## 部署验收边界

先使用独立的 DSH 安装目录和数据目录验证。只创建独立 profile 仍可能共用被补丁修改的安装文件。

正式切换前，验证 HTTPS 反向代理、登录与退出、WebSocket 和流式回复、两个账号共用目录且隔离未授权会话、授权撤销、沙箱目录外写入拒绝，以及第三方侧栏和归档插件的访问边界。安装阶段的静态 `patch status` 不能代替运行时认证读取，也不能证明这些流程已经通过。
