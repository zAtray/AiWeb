# 智知：知识管理与智能检索问答平台

“实验二：知识管理与智能检索问答平台设计与实现”的 TypeScript 全栈项目。

- 前端：Vue 3 + TypeScript + Vite，响应式 PC / 移动端界面
- 服务端：Node.js 24 + Express 5 + TypeScript
- 数据库：Node.js 内置 SQLite，默认文件为 `data/knowledge.db`
- 文档解析：PDF、DOCX、TXT、Markdown，单文件默认上限 20 MB
- 当前答案引擎：本地全文检索摘要，不包含远程连接家中台式机 Qwen 的网络调用

## 已实现功能

- 用户名、邮箱或手机号注册/登录，PBKDF2 密码哈希和限时会话
- 普通用户、部门管理员、系统管理员三级角色与角色维护
- 文档上传、在线预览、下载、元数据修改、删除、分类、标签和历史版本
- 多知识库创建、修改、删除、个人/共享/公共权限、文档加入与移除
- 关键词与全文片段检索、分类/标签/知识库组合筛选、相关文档推荐
- 问答会话、历史记录、继续追问、引用文档和原文片段
- 收藏、点赞、评论、共享申请、管理员通过/驳回
- 热门知识、最新发布、访问/下载/检索/问答统计和图表数据
- 服务端 API 集成测试和前后端严格 TypeScript 类型检查

## 启动

需要 Node.js 24 或更高版本。

```powershell
npm install
npm run build
.\start.ps1
```

浏览器访问 <http://127.0.0.1:8000>。

开发模式：

```powershell
npm run dev
```

前端地址为 <http://127.0.0.1:5173>，API 请求会代理到 8000 端口。

默认验机管理员：

```text
账号：admin
密码：Admin@123
```

正式使用前请通过 `ADMIN_PASSWORD` 环境变量修改默认密码。其他配置见
`.env.example`。

## 验证

```powershell
npm run typecheck
npm test
npm run build
```

测试分为三层：

1. 单元测试：参数校验、标签、密码、分块、中文检索评分和答案引用。
2. 集成测试：注册、知识库、上传解析、检索问答、互动、共享审核和统计。
3. 压力测试：文档列表、全文检索、统计和问答四类接口混合并发。

## 演示数据与压力测试

生成可重复的中等规模数据：

```powershell
npm run seed:demo
```

默认生成 40 个演示用户、18 个知识库、300 份文档、4500 个检索片段、
6000 条检索记录、500 个问答会话及数千条互动数据。演示账号：

```text
账号：demo_001
密码：Demo@123
```

数据规模可通过环境变量调整：

```powershell
$env:DEMO_SCALE = "small"   # small / medium / large
npm run seed:demo
```

执行 HTTP 混合压力测试：

```powershell
npm run test:stress
```

默认发送 2000 个请求，并发数 40。可通过
`STRESS_REQUESTS`、`STRESS_CONCURRENCY` 和 `STRESS_MAX_P95_MS`
调整请求数、并发数及 P95 验收阈值。结果保存到：

- `data/seed-report.json`
- `data/stress-report.json`

2026-07-26 的中等规模实测结果为：2000 请求、40 并发、0 错误，
吞吐量 33.7 RPS，P95 1238.3 ms，通过 2500 ms 阈值。

## 简化后的服务端结构

- `app.ts`：只负责 HTTP 路由和业务流程
- `core.ts`：参数校验和数据序列化
- `services.ts`：权限、文档查询和全文检索
- `db.ts`：SQLite 表结构与事务
- `seed.ts`：可重复演示数据
- `stress.ts`：无额外工具依赖的并发压力测试

## 后续接入家中台式机 Qwen

本版本按要求不实现远程连接代码。现有 `/api/chat/ask` 已把检索结果整理为统一
上下文并保存会话、答案和引用；后续只需把 `server/src/search.ts` 中的
`extractiveAnswer` 替换为一个独立的 Qwen 答案生成适配器，其余接口、数据库和
Vue 页面不需要改动。

最终部署建议：

1. 笔记本运行本项目，家中台式机运行 Qwen 推理服务。
2. 两台设备通过 Tailscale、WireGuard 等私网互通。
3. 推理服务仅监听私网地址，并增加鉴权、超时、请求大小限制和 TLS。
4. 不要把 Ollama 或其他模型服务端口直接暴露到公网。

## 目录

```text
frontend/        Vue 3 + TypeScript 前端
server/src/      Express + TypeScript API、SQLite、文档解析与检索
data/uploads/    上传文件（不会提交到 Git）
start.ps1        生产构建启动脚本
```
