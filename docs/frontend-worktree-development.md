# 前端 Worktree 开发指南

当任务只涉及前端时，在独立 Git worktree 中开发，同时复用主工作区的后端、`.env` 和本地数据。这样前端分支保持隔离，不会因为启动前端而重新编译 Rust 后端，也不会复制或提交环境变量。

本文假定目录如下：

```text
~/rust_projects/
├── Agent-foundary/                         # 主工作区，main 分支
└── Agent-foundary.worktrees/
    └── frontend_Positions/                  # 前端功能分支 worktree
```

## 首次准备

每个 worktree 都有独立的 `web/node_modules`。在前端 worktree 中安装锁定版本的依赖一次：

```bash
cd ~/rust_projects/Agent-foundary.worktrees/frontend_Positions/web
npm ci
```

不要复制或软链接 `node_modules`；它是 Git 忽略的本地构建产物。

## 日常开发

使用两个终端。

### 终端 1：主工作区后端

从主工作区启动后端：

```bash
cd ~/rust_projects/Agent-foundary
cargo run -p agent-foundry-backend
```

后端会从主工作区加载 `.env`，并使用主工作区的数据目录。启动后确认它监听在 `http://127.0.0.1:8080`。

### 终端 2：前端 worktree 的 Vite

只启动 Vite，**不要**运行 `npm run dev`，因为该命令会执行
`scripts/dev-with-backend.sh` 并再次编译、启动一个后端。

```bash
cd ~/rust_projects/Agent-foundary.worktrees/frontend_Positions/web
./node_modules/.bin/vite --host 0.0.0.0
```

默认访问地址为 `http://127.0.0.1:5173`。`web/vite.config.js` 会把 `/api` 和相关 `/data/*` 请求代理到主后端的 `http://127.0.0.1:8080`，因此前端 worktree 的代码能够使用真实配置和本地数据。

## 代码与提交边界

- 在前端 worktree 修改、测试和提交 `web/` 下的前端改动。
- 后端、数据库迁移、`.env` 或数据文件的改动应在主工作区进行，除非该任务明确需要独立的全栈分支。
- 完成前运行：

  ```bash
  cd ~/rust_projects/Agent-foundary.worktrees/frontend_Positions
  npm --prefix web test
  npm --prefix web run build
  ```

- 提交后，先在前端 worktree 通过 `git rebase main` 同步主分支，解决冲突后再回主工作区合并：

  ```bash
  cd ~/rust_projects/Agent-foundary.worktrees/frontend_Positions
  git rebase main

  cd ~/rust_projects/Agent-foundary
  git merge frontend_Positions
  ```

## 常见问题

### `vite: not found`

该 worktree 尚未安装前端依赖。进入其 `web/` 目录运行 `npm ci`。

### 后端重新编译或提示缺少 `.env`

通常是因为在前端 worktree 执行了 `npm run dev`；它会自动启动后端。停止该进程，在主工作区运行后端，并在 worktree 中直接运行 `./node_modules/.bin/vite --host 0.0.0.0`。

`.env` 被 Git 忽略，worktree 不会自动带上它。这是预期行为；纯前端开发不需要在 worktree 复制 `.env`。

### worktree 中出现 `target/`、`data/` 或 Python `__pycache__/`

这些是误启动 worktree 后端后留下的未跟踪运行产物。`target/` 可以通过在该 worktree 根目录运行 `cargo clean` 删除。删除 `data/` 前先确认它不包含需要保留的数据。
