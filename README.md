# tgcloud

tgcloud 把 [tg](https://github.com/xiaotianxt/tg) 包装成一个自托管云服务：用户通过浏览器操作 GUI 桌面端，AI/自动化通过 REST API 读取聊天记录、搜索、结构化检索和导出媒体。

核心组件：

- **panel** — 管理面板 + Agent REST API（PAT 鉴权）
- **instance** — 带 KasmVNC 的桌面容器，内置 tg CLI

## 部署

### 0. 前置

- Linux 主机（amd64 或 arm64），`docker` ≥ 24，`docker compose` 插件
- 出口能拉 `git.pku.edu.cn`（用预构建镜像；自构建见末尾）

### 1. 内核参数

tg 从 WeChat 进程内存提取密钥需要 ptrace。在宿主机一次性放开：

```bash
echo 'kernel.yama.ptrace_scope = 0' | sudo tee /etc/sysctl.d/10-tgcloud.conf
sudo sysctl --system
```

### 2. 取代码 + 配置

```bash
git clone https://github.com/thezzisu/tgcloud.git
cd tgcloud
cp .env.example .env
```

必改项：

```ini
TGCLOUD_PASSWORD=<你的强密码>   # 必改
TGCLOUD_HTTP_PORT=36080         # 面板对外端口
TGCLOUD_TZ=Asia/Shanghai
```

### 3. 启动

```bash
docker compose up -d
docker compose logs -f panel
```

浏览器打开 `http://<HOST>:36080`，用 `TGCLOUD_USER` / `TGCLOUD_PASSWORD` 登录。

### 4. 创建实例 + 登录 WeChat

面板 → **创建实例** → 进入 VNC → WeChat 自动启动后扫码登录一次。

### 5. 创建 PAT

面板右上角设置 → **API 令牌** → 新建 → 复制 `tgcp_...`。

```bash
export TGCLOUD_BASE_URL=http://<HOST>:36080
export TGCLOUD_PAT=tgcp_xxx
curl -H "Authorization: Bearer $TGCLOUD_PAT" $TGCLOUD_BASE_URL/api/agent/instances
```

### 升级

```bash
git pull && docker compose pull && docker compose up -d
```

### 自构建（可选）

```bash
docker buildx create --name tgcloud-builder --use 2>/dev/null || true
docker login git.pku.edu.cn
./scripts/build-and-push.sh
# 单架构：TGCLOUD_PLATFORMS=linux/amd64 ./scripts/build-and-push.sh
# 自定义 registry：TGCLOUD_IMAGE_PREFIX=registry.example.com/me ./scripts/build-and-push.sh
```

## Agent API

所有 `/api/agent/` 端点使用 PAT 鉴权：

```
Authorization: Bearer tgcp_...
```

主要端点：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/agent/instances` | 列出实例 |
| GET | `/api/agent/instances/:id/status` | 实例状态 |
| POST | `/api/agent/instances/:id/refresh` | 刷新密钥和解密缓存 |
| GET | `/api/agent/instances/:id/sessions` | 会话列表 |
| GET | `/api/agent/instances/:id/messages?session=...` | 读取消息 |
| GET | `/api/agent/instances/:id/search?q=...` | 全局搜索 |
| POST | `/api/agent/instances/:id/query` | 结构化检索（JSON） |
| GET | `/api/agent/instances/:id/media/:type/list?session=...` | 媒体列表（含 `cached`/`missing` 状态） |
| GET | `/api/agent/instances/:id/media/:type/export?session=...` | 导出媒体（二进制流） |
| GET | `/api/agent/instances/:id/forwarded-images/list?session=...` | 转发记录里的图片列表 |
| GET | `/api/agent/instances/:id/forwarded-images/export?session=...` | 导出转发记录里的图片 |
| GET | `/api/agent/instances/:id/file?path=...` | 读取容器内文件 |

首次请求数据端点时会自动初始化（提取密钥 + 解密数据库）。后台刷新中 API 自动等待锁释放。

完整规范：[`docs/openapi.yaml`](docs/openapi.yaml)。

## 错误码

| 状态 | `error` | 含义 / 处理 |
|------|---------|------------|
| 401 | `not_logged_in` | WeChat 未登录；进 VNC 扫码 |
| 404 | `session_not_found` | 会话名不存在 |
| 409 | `media_not_downloaded` | HD 原图 / 文件还没下载到本地。进 VNC 在 WeChat 里手动点开消息让客户端拉取，重试即可 |
| 500 | `ptrace_denied` | 第 1 步内核参数没生效 |
| 503 | `not_initialized` / `wechat_not_running` / `refresh_locked` | 等几秒重试 |
| 504 | `timeout` | tg 命令超时 |

## Agent Skill

```bash
npx -y github:xiaotianxt/skills tgcloud
```

设置 `TGCLOUD_BASE_URL` 和 `TGCLOUD_PAT`，Agent 即可直接调用 API。

## 备份 & 数据

| 路径 | 内容 |
|------|------|
| `./data-panel/accounts.json` | 面板用户 + PAT 哈希（**必须备份**） |
| docker volume `wechat-<instance-id>` | WeChat 客户端 + 聊天数据库（重要） |
| 容器内 `/config/.tg/` | tg 提取的密钥 + 解密缓存（可重建，`POST /refresh`） |

## 故障排查

| 现象 | 解决 |
|------|------|
| `connect EACCES /var/run/docker.sock` | SELinux 系统：compose 已带 `security_opt: [label=disable]`。非 SELinux 系统请检查 docker.sock 权限、rootless docker、userns-remap |
| API 返回 `ptrace_denied` | `cat /proc/sys/kernel/yama/ptrace_scope` 应为 0；不是请按第 1 步设置 |
| 实例创建后 WeChat 进不去 | 进 VNC 看桌面；首次需扫码登录 |
| 数据看起来旧 | `POST /api/agent/instances/:id/refresh` |

## 卸载

```bash
docker compose down
docker ps -a --filter "name=woc-wx-" --format '{{.Names}}' | xargs -r docker rm -f
docker volume ls --filter "name=wechat-" --format '{{.Name}}' | xargs -r docker volume rm
rm -rf data-panel
```

## 隐私

聊天数据属于敏感信息。`data-panel/`、容器内的 `/config/.tg/` 和导出文件请妥善保管。
