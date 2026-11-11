# 通用数据源访问保护

实现分支：`feat/shared-provider-protection`，基于已发布的 `e9cc29d`。

## 模块边界

`backend/src/services/provider_access.rs` 是 Rust 的统一出站 HTTP 入口。它负责请求间隔、状态码、`Retry-After`、超时和无效 JSON、失败冷却、404 缓存，以及可供前端读取的状态。各业务服务继续负责成功数据的缓存、字段校验和降级展示，因为报价、日线、汇率和宏观数据具有不同的有效期。

`App::build` 创建一个 `ProviderAccess`，通过构造函数传给所有服务。状态沿用 `STRUCTURED_PRODUCTS_ENRICHMENT_DB` 中的 `provider_access` / `provider_missing_products` 表，无需新增数据库或修改已有迁移。不同进程通过 SQLite 原子更新领取请求时隙；重启不会清除冷却。

Python 衍生品 worker 使用 `structured_products/providers/refusal.py` 中的 `SourceGuard`，读取同一数据库和策略文件。Rust 将同一策略文件编译进二进制，Python wheel 携带该文件；部署必须同时更新二进制和 wheel。

## 唯一策略配置

修改 `backend/python/src/agent_foundry_python/structured_products/provider_policy.json` 后重新构建发布。

| 来源标识 | 请求启动最小间隔 | 覆盖入口 |
| --- | --- | --- |
| `api.boerse-frankfurt.de` | 2 秒 | Python 报价、条款、Greeks |
| `api.onvista.de` | 2 秒 | Python 持仓、Rust 候选搜索、换仓和观察列表 |
| `alpaca` | 0.5 秒 | 报价、每一页日线、交易日历；两个 API 主机共用预算 |
| `api.stlouisfed.org` | 0.5 秒 | 所有 FRED 序列；原 `FRED_REQUEST_DELAY_MS` 可额外延长间隔 |
| `api.frankfurter.dev` | 2 秒 | 配置的汇率入口及兼容入口，共用同一预算 |
| `apewisdom.io` | 2 秒 | stocks、wallstreetbets，后台轮询和手动分析共用 |
| `fincalapi.com` | 2 秒 | XETRA 交易日历 |

未登记来源使用默认 2 秒。间隔是应用的保守配置，不代表供应商授权额度；它是共享数据库的请求启动间隔，并非对其他服务器或无关程序的 IP 总额度控制。

所有来源使用以下默认失败策略，连续失败按倍数延长：

| 情况 | 首次暂停 | 默认上限 |
| --- | --- | --- |
| 401 / 403 | 24 小时 | 7 天 |
| 429 | 1 小时 | 24 小时 |
| 网络错误、超时、5xx | 5 分钟 | 1 小时 |

Rust 入口也将重定向、损坏或不完整的 JSON 当作不可用响应暂停。禁用自动重定向和传输层自动重试。`Retry-After` 支持秒数和 HTTP 日期；如果服务端要求更久，优先于默认上限。404 只缓存具体资源 24 小时，不暂停整个来源。403/429 等拒绝会立即记录，不等待读取错误正文。已经在途的请求可能完成，但其成功不能清除其他请求刚写入的冷却。

冷却结束仅表示允许下次任务尝试，不会自动发起补抓。手动刷新同样受保护。FRED 不再使用 `FRED_MAX_RETRIES` / `FRED_RETRY_BASE_DELAY_MS` 的立即重试循环；旧环境变量可以保留，但不再生效。

## 缓存与失败行为

- 汇率：用异步锁合并并发缓存未命中；失败后优先返回上次真实汇率，保留原时间并标记 `frankfurter_stale`。无旧值时才用配置回退值。兼容入口只在主入口 404/410 时尝试，不会在限流、鉴权失败或超时后切换入口继续请求。
- FRED：保留成功缓存和失败后的短期降级缓存。配置了 API Key 也不能跳过请求失败形成的缓存；只有“未配置 Key”生成的模拟缓存，会在新增 Key 后失效。降级数据保持 `sandbox_mock` 标识，不冒充实时数据。
- Alpaca：保留报价、日线缓存和原始市场时间。保留 SDK 的请求/响应模型，由 `alpaca_http.rs` 通过通用 HTTP 层发送，从而读取状态码与 `Retry-After`。各日线分页也受同一预算保护，失败不发布半份历史。IEX 和复权参数不变。
- ApeWisdom：同一实例的手动与后台请求合并，五分钟内复用成功缓存；启动时加载已有缓存。失败不覆盖旧文件。
- FinCal：合并同日查询，失败继续使用本地节假日表；重启后的失败冷却仍受共享数据库限制。
- 成功缓存可以在来源冷却期间读取；数据库保护状态读取或写入失败时，不放行新的网络请求。

## 新增来源

1. 在策略文件登记稳定的来源标识、展示名称、用途和间隔。共享同一额度的多个主机/入口必须使用同一标识。
2. 构造函数接收已有的 `ProviderAccess`，不要新建绕过保护的 HTTP 客户端。
3. 使用 `access.json(source, public_resource_key, |client| client.get(url).query(...))`。资源键只包含公开的产品/序列标识，不得包含 API Key、令牌或带凭据的 URL。凭据仅通过请求参数或请求头传入。
4. 在业务层定义成功缓存的有效期、并发请求合并和降级行为。不要把抓取时间当作市场时间，也不要把降级结果标记为新数据。
5. 通过本地模拟服务测试正常响应、403/429、`Retry-After`、超时、重启后继续暂停和缓存保留；不要对真实供应商压测。

## 状态与部署验证

`GET /api/structured-products-enrichment/status` 保留原任务字段，`providers` 扩展为全部已尝试来源，并新增 `label` / `scope`。没有请求记录的来源暂不列出。前端顶部“后台更新”中的“数据源访问保护”独立展示全局状态；FRED/汇率冷却不会把产品抓取任务误标为失败。

发布后检查接口中的各来源、`retryAt`、服务重启次数和任务最近完成时间。不要通过清空访问保护表来验证恢复；使用本地模拟测试，生产等待冷却和下一轮调度。现有数据库备份、原子切换和回滚流程保持兼容。

这些机制减少重复请求和限流升级的风险，不保证数据源始终可用或服务器 IP 永不受限。
