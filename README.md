# AiWeb 智知知识库

本项目是一个可在本机运行的 Vue + Express + MySQL + Ollama 知识库系统，支持账号、文档上传与 OCR、知识库、混合检索、AI 对话与引用、收藏、点赞、评论、共享和后台管理。

## Windows 一键启动（推荐）

### 前置条件

- Windows 10/11（64 位，建议至少 16 GB 内存）
- [Git](https://git-scm.com/download/win)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)（使用 WSL 2 后端）
- 首次启动需联网下载容器和 `qwen3:8b`、`qwen3-embedding:0.6b` 模型，需预留约 15 GB 磁盘空间

### 下载并运行

```powershell
git clone https://github.com/zAtray/AiWeb.git
Set-Location .\AiWeb
.\start-docker.ps1
```

浏览器打开 <http://127.0.0.1:8000>。初始管理员账号是 `admin`，随机密码保存在本机 `.env.docker` 的 `ADMIN_PASSWORD` 中。

停止服务：

```powershell
.\stop-docker.ps1
```

再次执行 `start-docker.ps1` 会复用已有数据库、上传文件和模型。普通停止不会删除数据。若确实要清空全部 Docker 数据，先自行备份，再显式执行 `docker compose --env-file .env.docker down -v`。

> Ollama 容器默认可使用 CPU，因此没有 NVIDIA GPU 也能启动，但 AI 回答会明显更慢。Docker Desktop 的 GPU 支持可按本机环境另行启用。

## 原生开发启动

原生模式需要 Node.js 22、MySQL 8.4、Ollama、Poppler 和带 `chi_sim+eng` 语言包的 Tesseract。复制 `.env.example` 为 `.env`，填写数据库密码和管理员密码，并确保两个 Ollama 模型已下载：

```powershell
Copy-Item .env.example .env
ollama pull qwen3:8b
ollama pull qwen3-embedding:0.6b
npm ci
npm run build
npm start
```

开发模式：`npm run dev`。完整的脚本清单见 `package.json`。

## 数据与安全

- `.env`、`.env.docker`、数据库、上传文件、日志、模型和 `node_modules` 均被 Git 忽略。
- GitHub 仓库只包含源码、锁文件、容器配置和测试，不包含任何现有业务账号、文档或密码。
- 应用只把 Web 端口绑定到 `127.0.0.1`；MySQL 和 Ollama 不直接暴露到宿主机网络。
- 对外网开放前，请更换安全策略并配置 HTTPS、反向代理和访问控制。

## 常用验证

```powershell
npm ci
npm run typecheck
npm run build
npm run test:unit
```

`test:non-ai` 还会连接由 `TEST_BASE_URL` 指定的已启动隔离服务。破坏性验收和压力脚本仅允许连接数据库名以 `zhizhi_acceptance_` 开头的隔离环境。
