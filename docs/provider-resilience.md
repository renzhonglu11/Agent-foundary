# 结构化产品数据源与访问保护

核查日期：2026-11-11。分支：`feat/provider-resilience`，基于 `release/2026-11-11`。

## 可用渠道和取舍

在 cx33 以正常 HTTP 请求、少量公开产品样本核查，结果只表示当时可访问，不是全市场覆盖或稳定性保证。

| 渠道 | 核查结果 | 本次处理 |
| --- | --- | --- |
| Börse Frankfurt 网站 JSON | VY42C9 主数据和价格返回 200；UG3NHT 主数据返回 404 | 保留主渠道；单产品缺失不视为全站封禁 |
| Onvista 网站 JSON | UG3NHT snapshot 返回 200，含条款、希腊值、价格和市场时间 | 保留条款补全；新增报价备用渠道；报价与条款共用一次快照 |
| Onvista 网页 | 2026-11-11 15:17（柏林）返回 429 / Vercel Security Checkpoint，`Retry-After: 30`；同一服务器同一分钟 JSON 返回 200 | 网页入口已被防护拦截，不恢复网页抓取；不能据此证明整个 IP 永久被所有接口封禁 |
| gs.de | 之前已因生产环境 403 移除 | 不恢复反复请求 |
| Börse Stuttgart 网站 | 产品页返回 403 | 不加入抓取链 |
| Comdirect 网站 | 产品页返回 401 | 不加入抓取链 |
| ARIVA 网站 | 产品页返回 200，但 robots 明确禁止 `/hebelprodukte/*` | 不启用自动抓取 |
| Finanzen.net | 已有未启用的解析器；使用条款要求自动查询先取得明确许可 | 不直接启用 |

Onvista 网页与 `api.onvista.de` 是不同入口，网页拒绝访问不能直接推断 JSON 入口不可用。两家当前使用的 JSON 接口都是网站内部接口，未获得公开 API 的稳定性承诺。限速降低重复请求和限流升级的风险，不能保证不被屏蔽；也不能仅凭 HTTP 403 判定之前封禁是请求频率造成的。

参考：[ARIVA robots](https://www.ariva.de/robots.txt)、[Finanzen.net 使用条款第 9(3) 条](https://www.finanzen.net/nutzungsbedingungen)、[Stuttgart 官方市场数据服务](https://www.boerse-stuttgart.de/en/business-solutions/market-data/)、[ARIVA 官方 API 服务](https://ariva.ag/en/)、[financial.com REST/Streaming APIs](https://www.financial.com/rest-streaming-apis.html)。官方服务是否覆盖所需 ISIN、希腊值、实时权限和价格，需要供应商确认。本次不订购，也不假定免费的股票 API 能覆盖德国发行权证。

## 请求策略

Python 持仓刷新与 Rust 机会搜索/观察列表刷新，使用同一个 enrichment SQLite 文件中的 `provider_access` 和 `provider_missing_products` 表；部署沿用已有 `STRUCTURED_PRODUCTS_ENRICHMENT_DB`。不另建需要单独备份的运行数据库。新增表兼容旧版本回滚。

- 每个来源主机至少间隔 2 秒启动一次请求；Frankfurt 报价与条款共享额度，Onvista 持仓与机会搜索共享额度。SQLite 原子操作保证进程间不能领取同一时隙。网络请求期间不持有数据库事务。
- 401/403：至少暂停 24 小时，连续失败倍增，默认上限 7 天。
- 429：至少暂停 1 小时，连续失败倍增，默认上限 24 小时。
- 连接/超时和 5xx：至少暂停 5 分钟，连续失败倍增，默认上限 1 小时。
- `Retry-After` 的秒数和 HTTP 日期均受尊重；若它要求等待更久，优先于上述默认上限。
- 冷却跨刷新任务和服务重启保留。成功返回的旧在途请求不能清除后来发生的拒绝。
- 404 仅按来源和具体 URL 缓存 24 小时，其余产品正常处理。到期后才再尝试；过期记录清理。
- 不执行立即重试、代理/IP 轮换、验证码处理或客户端伪装轮换。
- 未改变现有交易窗口和定时刷新间隔。手动刷新也不能绕过上述保护。

机会搜索继续复用五分钟内的成功缓存。Onvista 报价与产品条款在 Python 中共用五分钟内的 snapshot，最多缓存 256 个产品。Frankfurt 返回有效报价时不额外请求 Onvista 报价；其失败时尝试 Onvista，并在 `quote_source` 中标明真实来源。两家均失败时保留原始持仓值，不伪造新行情。

报价必须有匹配的 ISIN、有限非负价格及带时区的市场时间。Frankfurt 使用 `timestampLastPrice`，Onvista 使用 `quote.datetimeLast`；不将抓取时间冒充市场时间。这里使用来源的 `last` 价格，不把卖价或买卖中间价冒充成交价。

产品补全按类型判断：开放式敲出产品不再因没有到期日/希腊值而遍历所有渠道；仍会刷新一次移动的行权价和障碍。因子产品补固定倍数和 reset barrier；普通权证继续补行权价、比率、到期日及希腊值。

## 可见状态与后续接口

`GET /api/structured-products-enrichment/status` 新增 `providers`，包含来源、是否冷却、最早重试时间、最近 HTTP 状态和响应时间。读取失败用 `providerStatusError` 表示，保留原任务状态。顶部“后台更新”展示这些字段，冷却期间显示“需关注”，即使其他渠道仍在刷新也不掩盖它。

这里的“最近请求成功”只说明最近一次 HTTP 请求成功，不代表该渠道覆盖所有产品或其全部数据都新鲜；具体产品缺失/过期仍查看完整数据监控。冷却结束并不立即发起网络请求，要等下次定时任务或用户搜索。

`QuoteProvider`、`ProductDataProvider` 和报价备用列表继续作为付费提供方的接入点。后续选择获得授权、覆盖德国权证的接口时，可替换适配器并给它独立的额度；无需更改风险模型。

## 验证

测试覆盖：多个 worker 共用冷却和时隙、重建客户端后继续暂停、Retry-After 两种格式、等待中的请求遇拒绝停止、404 单产品隔离与过期、超时/5xx、缓存搜索在冷却期间仍可用、报价自动切换及时间保留、同一 Onvista 快照只请求一次，以及开放式产品避免无效字段查询。HTTP 测试使用本地模拟服务，不对真实来源压测。
