# 通用数据源访问保护

通用模块最初由 `feat/shared-provider-protection` 实现；请求预算、Tier 1 优先和可选 Tier 2 调度由 `feat/provider-budgets-priority` 扩展，基于 `b9f9b04`。

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

## 滚动请求预算与优先级

同一策略文件的 `budget` 定义最近 **1 小时 / 24 小时**的上限，不在整点或零点清零。预算不是供应商公布的额度，而是本应用的初始负载上限，需要根据成功率、缓存命中和供应商约定维护。

| 来源 | 1 小时上限 | 24 小时上限 | Tier 1 保留（小时 / 24 小时） |
| --- | ---: | ---: | ---: |
| Börse Frankfurt | 360 | 5000 | 240 / 3400 |
| Onvista | 180 | 1800 | 120 / 1200 |
| Alpaca | 600 | 6000 | 0 / 0 |
| FRED | 120 | 500 | 0 / 0 |
| Frankfurter | 12 | 48 | 0 / 0 |
| ApeWisdom | 60 | 800 | 0 / 0 |
| FinCal | 12 | 48 | 0 / 0 |
| 未登记来源 | 120 | 1000 | 0 / 0 |

`provider_request_events` 只存来源、领取时间和优先级，不存 URL、密钥或产品清单。Python 与 Rust 在同一 SQLite `BEGIN IMMEDIATE` 事务内检查预算、预留请求间隔并记账。网络发生在事务提交之后。缓存命中、404 负缓存、间隔等待、冷却或预算拒绝不重复计数；领取后崩溃也保留计数，因此显示的是保守的请求配额占用量，不保证每次都已发出 HTTP。24 小时外的明细在后续成功预留时清理。

所有请求必须满足总预算；后台请求还必须满足 `总上限 - Tier 1 保留` 的子预算。后台包含 Tier 2 实时报价、每日条款、候选搜索和观察列表请求。Tier 1 可以使用剩余总额度，但不能突破总上限。报价和元数据共用同一来源预算，HTTP 拒绝仍使该来源的所有优先级冷却。

一次抓取中先完成 Tier 1，再执行其他工作；Tier 1 内按持仓市值优先。保留额度限制其他进程抢占预算，不会中断已发出的后台请求。冷却与预算是独立状态：预算用完不伪造 HTTP 429、不清空缓存、不在任务中等待数小时补抓；滚动窗口恢复额度后，由后续正常任务重试。降低上限时，恢复时间按需要过期的记录数计算。

## 可选 Tier 2 两小时刷新

`STRUCTURED_PRODUCTS_TIER2_SOURCES` 是扩展实时抓取的显式来源列表，支持 `boerse_frankfurt`、`onvista`，逗号分隔。默认空值继续原有 Tier 2 每日条款处理；不自动增加 Onvista 的访问范围。启用来源前应确认该来源允许所需自动访问。[Onvista 官方说明](https://hilfe.onvista.de/migration/de/verstoss-gegen-nutzungsbedingungen)要求自动查询取得书面许可，可访问的网站 JSON 不代表公开 API 授权。

确认来源可用后，在服务器已有的 `shared/.env` 单独配置来源，`STRUCTURED_PRODUCTS_TIER2_INTERVAL_MINS=120` 控制最小间隔（允许 120–1440 分钟），重启服务生效。现有 Tier 1 的 30 分钟服务器配置保留，不修改发布目录或从本地覆盖 `.env`。

- Tier 2 的报价、条款、Greeks 和备用来源全部受来源列表限制；不能借备用请求绕过列表。
- `product_refresh_schedule` 在请求前记录每个 ISIN 的尝试时间，失败、进程中断、重启和手动刷新都不会跳过间隔。每次到期时，先取临近到期产品，再按持仓市值排序；未到期继续使用缓存。实际执行时间由主刷新周期和交易窗口决定。
- 报价缓存只保存报价字段和原始市场时间，不保存旧持仓数量、成本或 Tier。当前数量变化仍生效；失败保留已有报价，缺失不伪装成新数据。
- 导出层不再把缓存元数据和 Greeks 以当前时间重新入库。真实数据在 enrichment 阶段入库；缓存导出不会延长其有效期。重复的同一市场时间、价格、币种报价也不会重复入库。
- Tier 2 获取数据并不自动改变风险模型或组合比较的 Tier 1 筛选条件。`enrichment_refresh_state=attempted` 只表示尝试过，不表示所有字段都成功更新。
- 冷却、404 负缓存、小时/日预算和 Tier 1 保护同时适用；两小时是最小尝试间隔，不是每只产品成功获取新报价的保证。

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

每个来源的 `budget` 返回 `hour` / `day` 的 `used`、`limit`、`tier1Reserved`、`backgroundUsed`、`remaining`、`backgroundRemaining`，以及 `limited`、`backgroundLimited` 和对应 `retryAt` / `backgroundRetryAt`。前端区分“来源冷却”“全部预算用完”“后台额度用完、Tier 1 可继续”。顶层 `tier2Enabled`、`tier2IntervalMinutes`、`tier2Sources` 表示实际启用配置。

新增 `0003_provider_budgets.sql` 为幂等、增量建表，同时被 Rust 与 Python 包携带；无需清除旧冷却表。新预算从部署后的请求开始记账，没有旧版请求的历史计数。发布必须同步 Rust 二进制与 Python wheel，回滚到不认识预算的旧程序会停止执行预算保护（原限速/冷却仍在），不能把回滚视为保留新保护机制。

发布后检查接口中的各来源、`retryAt`、服务重启次数和任务最近完成时间。不要通过清空访问保护表来验证恢复；使用本地模拟测试，生产等待冷却和下一轮调度。现有数据库备份、原子切换和回滚流程保持兼容。

这些机制减少重复请求和限流升级的风险，不保证数据源始终可用或服务器 IP 永不受限。
