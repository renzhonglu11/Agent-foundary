# Agent Foundry

个人投资组合仪表板 &mdash; 一个集持仓跟踪、市场数据、结构化产品风险评估、宏观经济分析和定时任务监控于一体的全栈应用。

## 技术栈

| 层 | 技术 |
|------|-----------|
| **后端** | Rust + Axum 0.8 + SQLx (SQLite) + Tokio |
| **Python 脚本** | 结构化产品富化（爬取 GS.de / Onvista / Finanzen.net / Börse Frankfurt）、PDF 解析、宏观分析 |
| **前端** | React 19 + Vite + MUI 7 + Recharts + MUI X Charts |
| **数据** | SQLite（多表迁移: 交易记录、外汇汇率、市场数据缓存、FRED 宏观数据、结构化产品实时数据） |
| **部署** | systemd 单元、shell 部署脚本 |

## 项目结构

```text
backend/            Rust Axum API + SQLx SQLite + 领域逻辑
├── migrations/     SQLite 迁移（7 个文件）
├── python/         Python 侧车 — PDF 提取、宏观分析、结构化产品爬虫
└── src/
    ├── api/        路由 + 处理器
    ├── application/ 端口（traits）+ 服务（portfolio、FX、upload）
    ├── config/     环境驱动配置
    ├── domain/     领域类型（Transaction、Portfolio、Money）
    ├── infrastructure/ SQLite DAO、Migrations
    └── services/   外部集成（Alpaca、FRED、ApeWisdom、Hermes Cron、结构化产品）

web/                React + Vite 前端
├── src/
│   ├── components/ UI 组件（DashboardShell、PortfolioTabs、StockAnalysisTab、
│   │               PositionsTable、DividendTab、EventsTab、HermesCronTab …）
│   ├── hooks/      React Query 风格 hooks（usePortfolioData、useRiskData、
│   │               useStructuredProducts、useFredMacroData …）
│   └── utils/      格式化工具、自选股分组逻辑
└── scripts/        dev-with-backend.sh（同时启动后端 + Vite 开发服务器）

data/               SQLite 数据库 + 导出的 JSON/CSV（git 忽略）
deploy/             systemd 单元 + 部署脚本
tools/              实用工具（预留）
```

## 功能

### 仪表板标签页
- **概览** — 投资组合汇总卡片、历史市值图表、持仓细分、近期活动
- **持仓** — 可排序表格，包含成本价、数量、当日盈亏、总盈亏 %，以及操作面板
- **分红** — 已收分红时间线 + 年度预测
- **股票分析** — 自选股表格，含 Alpaca 实时报价、FRED 宏观数据、Reddit 情绪（ApeWisdom）、结构化产品风险热力图
- **事件** — 交易日历事件
- **Hermes Cron** — 定时作业状态监控仪表板

### 后端 API
- `GET /health` — 健康检查
- `GET /api/portfolio/summary` — 完整投资组合快照（持仓、分红、历史）
- `GET /data/portfolio-summary.json` — 兼容旧前端路径（开发中由 Vite 代理）
- `POST /api/upload-data` — 多部分上传：CSV 交易文件、PDF 资产摘要、结构化产品 Excel（最大 50 MB）
- `GET /api/stock-analysis/alpaca-quotes` — 批量股票报价（Alpaca Markets）
- `GET /api/fred/macro-data` — 选定投资组合代码的美国宏观指标（FRED）
- `GET /data/macro-analysis.json` — 宏观分析缓存
- `POST /api/macro-analysis/refresh` — 从 Python 侧车触发宏观分析
- `GET /api/structured-products-enrichment` — 结构化产品详情（ISIN、基础资产、障碍、票息），读取 SQLite 持久化数据
- `GET /api/structured-products-risk` — 每个产品汇总的风险评估，读取 SQLite 持久化数据
- `POST /api/structured-products-enrichment/refresh` — 触发富化 + 风险重新计算
- `GET /api/structured-products-enrichment/status` — 检查富化流水线状态
- `GET /data/hermes-cron-status.json` — Hermes Cron 作业状态快照

### 外部集成
| 服务 | 用途 |
|---------|-------|
| **Alpaca Markets** | 美股实时报价（EUR 换算） |
| **FRED** (圣路易斯联储) | 宏观数据：GDP、CPI、失业率、联邦基金利率、收益率曲线 |
| **Frankfurter API** | USD → EUR 汇率，含回退 |
| **ApeWisdom** | Reddit 热门股票情绪（后台轮询） |
| **Hermes Cron** | 监控外部 cron 作业状态 |

### Python 侧车 (`backend/python/`)
- **结构化产品富化** — 多提供商爬虫：GS.de、Onvista、Finanzen.net、Börse Frankfurt。提取 ISIN 详情、基础资产映射、障碍等级、票息、估值。支持分批和速率限制。
- **风险评估** — 计算每个结构化产品的 VaR、最大回撤、压力测试场景
- **PDF 提取** — 从 PDF 资产报表中提取文本，用于导入交易
- **宏观分析** — 宏观指标趋势分析，含信号生成

## 快速开始

### 前置条件
- Rust 1.88+（参见 `rust-toolchain.toml`）
- Node.js 20+
- Python 3.12+（用于结构化产品 + 宏观脚本）
- [uv](https://github.com/astral-sh/uv)（Python 包管理器）
- （可选）[Alpaca Markets API 密钥](https://alpaca.markets/) 和 [FRED API 密钥](https://fred.stlouisfed.org/docs/api/fred/)

### 1. 配置环境

```bash
cp .env.example .env
# 编辑 .env — 至少设置 DATABASE_URL。添加 ALPACA 和 FRED 密钥以获得完整功能。
```

关键环境变量：

| 变量 | 默认值 | 说明 |
|-----------|---------|-------------|
| `APP_ENV` | `local` | `local`（美观日志）或 `production`（JSON 日志） |
| `HOST` / `PORT` | `127.0.0.1:8080` | HTTP 监听地址 |
| `DATABASE_URL` | `sqlite://data/agent_foundry.db` | SQLite 数据库路径 |
| `ALPACA_MARKET_DATA_ENABLED` | `true` | 启用实时股票报价 |
| `FRED_API_KEY` | — | FRED API 密钥（宏观数据） |
| `STRUCTURED_PRODUCTS_ENRICHMENT_ENABLED` | `true` | 启用结构化产品爬虫 |

查看 [`.env.example`](.env.example) 了解完整列表。

### 2. 安装 Python 依赖

```bash
cd backend/python
uv sync
cd ../..
```

### 3. 运行开发服务器

**仅后端：**

```bash
cargo run -p agent-foundry-backend
```

**仅前端：**

```bash
cd web
npm install
npm run dev
```

**同时启动两者（推荐）：**

```bash
cd web
npm run dev
# 运行 scripts/dev-with-backend.sh — 在端口 8080 启动后端，前端 Vite 在端口 5173 并代理 API 调用
```

### 4. 检查

```bash
cargo fmt --all
cargo clippy --all-targets -- -D warnings
cargo test
```

## 生产构建

```bash
# 后端
cargo build --release
# 二进制文件位于 target/release/agent-foundry-backend

# 前端
cd web && npm run build
# 输出位于 web/dist/
```

## VPS 部署

### 使用部署脚本（推荐）

```bash
# 构建并 rsync 到 VPS，重启 systemd 服务
./deploy/deploy-backend.sh
```

### 手动步骤

**本地构建：**

```bash
cargo build --release
```

**上传到 VPS：**

```bash
ssh user@vps 'mkdir -p /home/rz/Agent-Foundry/bin /home/rz/Agent-Foundry/data'
scp target/release/agent-foundry-backend user@vps:/tmp/agent-foundry-backend
scp .env.example user@vps:/tmp/agent-foundry.env
scp deploy/agent-foundry-backend.service user@vps:/tmp/agent-foundry-backend.service
scp data/portfolio-transactions.csv user@vps:/tmp/portfolio-transactions.csv
```

**在 VPS 上安装：**

```bash
sudo mv /tmp/agent-foundry-backend /home/rz/Agent-Foundry/bin/agent-foundry-backend
sudo mv /tmp/agent-foundry.env /home/rz/Agent-Foundry/.env
# 重要：编辑 .env 设置 APP_ENV=production 并配置密钥
sudo mv /tmp/portfolio-transactions.csv /home/rz/Agent-Foundry/data/portfolio-transactions.csv
sudo mv /tmp/agent-foundry-backend.service /etc/systemd/system/agent-foundry-backend.service
sudo chown -R rz:rz /home/rz/Agent-Foundry
sudo chmod +x /home/rz/Agent-Foundry/bin/agent-foundry-backend
sudo systemctl daemon-reload
sudo systemctl enable --now agent-foundry-backend
sudo systemctl status agent-foundry-backend
```

### Hermes Cron 同步服务（VPS）

将本地 cron 作业同步到 VPS 以进行集中监控：

```bash
# 一次性安装
./deploy/install-hermes-cron-sync-local.sh
```

有关更多部署细节，请参见 [`deploy/`](deploy/) 及其中包含的脚本。

## 架构说明

### 设计模式
后端使用**六边形（端口和适配器）架构**：

- **领域层** (`domain/`) — 纯数据结构、`Money` 值对象、没有外部依赖
- **应用层** (`application/`) — 端口（traits）+ 编排服务。领域逻辑与 I/O 分离。
- **基础设施层** (`infrastructure/`) — SQLite 驱动的端口实现
- **服务层** (`services/`) — 外部 API 集成（Alpaca、FRED、ApeWisdom、结构化产品）
- **API 层** (`api/`) — Axum 路由和处理程序，薄的 HTTP 关注点

### 数据流
```
CSV/PDF 上传 → 后台导入 → SQLite（交易、持仓、历史）
                              ↓
外部 API → 市场数据仓库 → 投资组合服务 → JSON 缓存
                              ↓
Python 侧车 → 结构化产品 DB → 风险 JSON → 前端
```

### 缓存策略
- **投资组合摘要** — 启动时计算，上传新数据时失效
- **Alpaca 报价** — TTL 可配置（默认 60 秒），内存缓存
- **FRED 宏观数据** — TTL 可配置（默认 24 小时），SQLite 支持
- **外汇汇率** — TTL 可配置（默认 1 小时），含回退，SQLite 存储
- **结构化产品** — 启动时从 Python 侧车刷新，手动触发重新运行

## 技术说明

- `unsafe_code = "forbid"` — 整个 Rust 代码库零 unsafe 块
- `unwrap_used = "deny"` / `expect_used = "deny"` — 禁止恐慌快捷方式；所有错误都是显式的 `anyhow::Result` 或 `thiserror`
- Edition 2024，最低 Rust 1.88
- Python 代码使用 `uv` 管理依赖，带有 `pyproject.toml` 和锁文件
- 前端开发服务器默认代理 `/data` 和 `/api` 到 `localhost:8080`

## 许可证

无许可证（目前为私有）。
