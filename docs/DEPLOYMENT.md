# tgcloud 部署指南

最简部署：5 步。

## 0. 前置条件

- 一台能跑 Docker 的 Linux 主机（amd64 或 arm64）
- 安装：`docker` ≥ 24, `docker compose` 插件
- 出口能拉 `git.pku.edu.cn`（如果用预构建镜像）

```bash
docker --version
docker compose version
```

## 1. 主机内核参数

tg 从 WeChat 进程内存中提取密钥需要 ptrace。在宿主机一次性放开：

```bash
echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope
```

持久化（推荐）：

```bash
echo 'kernel.yama.ptrace_scope = 0' | sudo tee /etc/sysctl.d/10-tgcloud.conf
sudo sysctl --system
```

## 2. 取代码 + 配置

```bash
git clone https://github.com/thezzisu/tgcloud.git
cd tgcloud
cp .env.example .env
```

编辑 `.env` 必改项：

```ini
TGCLOUD_PASSWORD=<你的强密码>    # 默认 changeme，必须改
TGCLOUD_USER=admin               # 可改
TGCLOUD_HTTP_PORT=36080          # 面板对外端口
TGCLOUD_TZ=Asia/Shanghai
```

镜像地址保持默认 `git.pku.edu.cn/thezzisu`，使用预构建镜像即可；自己构建见第 6 节。

## 3. 启动

```bash
docker compose up -d
docker compose logs -f panel    # 看启动日志
```

面板就绪后访问：`http://<HOST>:36080`

用 `.env` 里的 `TGCLOUD_USER` / `TGCLOUD_PASSWORD` 登录。

## 4. 创建实例 + 登录 WeChat

- 面板 → **创建实例** → 等容器拉起（首次约 1-2 分钟）
- 点击实例进入 VNC 桌面
- 自动启动 WeChat 后扫码登录（手机扫一次即可）

之后实例会一直保留登录态。

## 5. 创建 PAT（Agent 用）

- 面板 → 右上角设置 → **API 令牌** → 新建 → 复制 `tgcp_...`
- agent 端：

```bash
export TGCLOUD_BASE_URL=http://<HOST>:36080
export TGCLOUD_PAT=tgcp_xxx

curl -H "Authorization: Bearer $TGCLOUD_PAT" \
     $TGCLOUD_BASE_URL/api/agent/instances
```

完整 API 见 `docs/openapi.yaml`。

---

## 常见问题

| 问题 | 解决 |
|------|------|
| 面板登录后实例创建失败 | 确认 docker.sock 已挂载（compose.yml 默认有） |
| 实例创建后 WeChat 进不去 | 进 VNC 看桌面；首次需扫码登录 |
| API 返回 `not_logged_in` | WeChat 还没登录或刚启动；进 VNC 完成扫码 |
| API 返回 `not_initialized` | 首次访问会自动初始化（提取密钥+解密 DB），等几秒重试 |
| API 返回 `media_not_downloaded` (409) | HD 图/文件还没下载到本地。进 VNC 在 WeChat 里手动点开该消息让客户端拉取，重试 |
| API 返回 `ptrace_denied` | 第 1 步内核参数没生效；执行 `cat /proc/sys/kernel/yama/ptrace_scope` 应为 0 |

## 数据 & 备份

| 路径 | 内容 | 备份 |
|------|------|------|
| `./data-panel/accounts.json` | 面板用户 + PAT 哈希 | **要备份** |
| docker volume `wechat-<instance-id>` | WeChat 客户端 + 聊天数据库 | 重要 |
| 容器内 `/config/.tg/` | tg 提取的密钥 + 解密缓存 | 可重建（重新 `POST /refresh`） |

定时备份 `data-panel/` 即可保留账号体系。WeChat 数据建议依实例做 docker volume 快照。

## 升级

```bash
cd tgcloud
git pull
docker compose pull
docker compose up -d
```

实例会保持登录态，无需重新扫码（数据卷不动）。

## 6. 自己构建（可选）

需要 buildx + 镜像 registry 推送权限：

```bash
docker buildx create --name tgcloud-builder --use 2>/dev/null || true
docker login git.pku.edu.cn
./scripts/build-and-push.sh
```

如果只跑 amd64：`TGCLOUD_PLATFORMS=linux/amd64 ./scripts/build-and-push.sh`

自定义 registry：`TGCLOUD_IMAGE_PREFIX=registry.example.com/me ./scripts/build-and-push.sh`

## 卸载

```bash
docker compose down
# 删除所有实例容器/卷（小心，聊天数据会丢）
docker ps -a --filter "name=woc-wx-" --format '{{.Names}}' | xargs -r docker rm -f
docker volume ls --filter "name=wechat-" --format '{{.Name}}' | xargs -r docker volume rm
rm -rf data-panel
```
