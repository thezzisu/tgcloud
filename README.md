# tgcloud

tgcloud 把 [tg](https://github.com/xiaotianxt/tg) 包装成一个自托管云服务：用户通过浏览器操作 GUI 桌面端，AI/自动化通过 REST API 读取聊天记录、搜索、结构化检索和导出媒体。

核心组件：

- **panel** — 管理面板 + Agent REST API（PAT 鉴权）
- **instance** — 带 KasmVNC 的桌面容器，内置 tg CLI

## 快速开始

```bash
cp .env.example .env
# 编辑 .env，至少改掉 TGCLOUD_PASSWORD
docker compose up -d
```

浏览器打开 `http://HOST:36080`，用 `.env` 中的账号登录面板，创建实例后通过 VNC 完成客户端登录。

详细部署步骤：见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

## Agent API

所有 `/api/agent/` 端点使用 PAT 鉴权：

```
Authorization: Bearer tgcp_...
```

在面板 Settings 页创建 token。主要端点：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/agent/instances` | 列出实例 |
| GET | `/api/agent/instances/:id/status` | 实例状态 |
| POST | `/api/agent/instances/:id/refresh` | 刷新密钥和解密缓存 |
| GET | `/api/agent/instances/:id/sessions` | 会话列表 |
| GET | `/api/agent/instances/:id/messages?session=...` | 读取消息 |
| GET | `/api/agent/instances/:id/search?q=...` | 全局搜索 |
| POST | `/api/agent/instances/:id/query` | 结构化检索（JSON） |
| GET | `/api/agent/instances/:id/media/:type/list?session=...` | 媒体列表 |
| GET | `/api/agent/instances/:id/media/:type/export?session=...` | 导出媒体 |
| GET | `/api/agent/instances/:id/file?path=...` | 读取容器内文件 |

首次请求数据端点时会自动初始化（提取密钥 + 解密数据库）。如果后台正在刷新，API 会自动等待直到锁释放。

## Agent Skill

```bash
# 安装 skill 到 Claude Code
npx -y github:xiaotianxt/skills tgcloud
```

安装后设置环境变量 `TGCLOUD_BASE_URL` 和 `TGCLOUD_PAT`，Agent 即可直接调用 API。

## 构建

```bash
# 构建并推送镜像
./scripts/build-and-push.sh
```

## 隐私

聊天数据属于敏感信息。`data-panel/`、容器内的 `/config/.tg/` 和导出文件请妥善保管。
