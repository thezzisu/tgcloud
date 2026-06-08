---
name: tgcloud
description: Use when the user wants to read, search, query, export, or troubleshoot WeChat chat history via tgcloud's REST API. Requires TGCLOUD_BASE_URL and TGCLOUD_PAT environment variables.
when_to_use: Trigger for requests mentioning WeChat chat, 微信聊天记录, 微信消息, WeChat messages, reading WeChat group history, searching WeChat conversations, or exporting WeChat data/images via tgcloud.
---

# tgcloud Agent Skill

tgcloud provides a REST API to access WeChat data from cloud-hosted WeChat instances.
Each instance runs WeChat-Linux + the `tg` CLI for encrypted DB extraction.

## Prerequisites

Set these environment variables:
- `TGCLOUD_BASE_URL` — e.g. `https://your-server:36080`
- `TGCLOUD_PAT` — Personal Access Token (format: `tgcp_...`)

All requests use:
```
Authorization: Bearer $TGCLOUD_PAT
```

## Privacy

Chat data is private. Keep results local, avoid printing more content than requested,
and treat exports as sensitive. Use anonymous patterns when surfacing group chats.

## API Endpoints

### List Instances
```bash
curl -H "Authorization: Bearer $TGCLOUD_PAT" "$TGCLOUD_BASE_URL/api/agent/instances"
```

### Instance Status
```bash
curl -H "Authorization: Bearer $TGCLOUD_PAT" "$TGCLOUD_BASE_URL/api/agent/instances/:id/status"
```

### Sessions (list chats)
```bash
curl -H "Authorization: Bearer $TGCLOUD_PAT" "$TGCLOUD_BASE_URL/api/agent/instances/:id/sessions?top=20"
```

### Messages
```bash
curl -H "Authorization: Bearer $TGCLOUD_PAT" \
  "$TGCLOUD_BASE_URL/api/agent/instances/:id/messages?session=张三&limit=50&since=today"
```
Parameters: `session` (required), `limit`, `since`, `all_time=true`

### Search
```bash
curl -H "Authorization: Bearer $TGCLOUD_PAT" \
  "$TGCLOUD_BASE_URL/api/agent/instances/:id/search?q=关键词&limit=20"
```
Parameters: `q` (required), `limit`, `since`, `all_time=true`

### Query (structured)
```bash
curl -X POST -H "Authorization: Bearer $TGCLOUD_PAT" \
  -H "Content-Type: application/json" \
  -d '{"session":"产品群","contains":"项目","not":"取消","fields":"time,sender,body","limit":50}' \
  "$TGCLOUD_BASE_URL/api/agent/instances/:id/query"
```
Body fields: `session`, `contains`, `not`, `since`, `fields`, `limit`, `all_time`

### Media: list
```bash
curl -H "Authorization: Bearer $TGCLOUD_PAT" \
  "$TGCLOUD_BASE_URL/api/agent/instances/:id/media/image/list?session=张三&limit=20"
```
Path: `image | file | sticker | voice`. Each entry has a `status`:
- `cached` — exportable
- `missing` — user has not opened it in the WeChat UI yet; WeChat will not fetch the HD
  original until the user taps the message. **Do not attempt to export `missing` items.**

### Media: export (binary stream)
```bash
curl -H "Authorization: Bearer $TGCLOUD_PAT" \
  "$TGCLOUD_BASE_URL/api/agent/instances/:id/media/image/export?session=张三&index=1" \
  -o image.jpg
```
Parameters: `session` (required), `index` (1-based, from list endpoint) **or** `id`.

### Forwarded chat-record images
Forwarded messages of "chat history" type embed images (`Rec/<record-id>/Img/*`).
```bash
# list
curl -H "Authorization: Bearer $TGCLOUD_PAT" \
  "$TGCLOUD_BASE_URL/api/agent/instances/:id/forwarded-images/list?session=张三"

# export a single image (by index)
curl -H "Authorization: Bearer $TGCLOUD_PAT" \
  "$TGCLOUD_BASE_URL/api/agent/instances/:id/forwarded-images/export?session=张三&index=1" \
  -o forwarded.jpg

# export all in a record (returns JSON manifest)
curl -H "Authorization: Bearer $TGCLOUD_PAT" \
  "$TGCLOUD_BASE_URL/api/agent/instances/:id/forwarded-images/export?session=张三&recordId=<id>"
```

### Refresh (update decrypted cache)
```bash
curl -X POST -H "Authorization: Bearer $TGCLOUD_PAT" \
  "$TGCLOUD_BASE_URL/api/agent/instances/:id/refresh"
```

### Doctor (diagnostics)
```bash
curl -H "Authorization: Bearer $TGCLOUD_PAT" \
  "$TGCLOUD_BASE_URL/api/agent/instances/:id/doctor?session=张三"
```

## Workflow

1. List instances → pick one with `runtime=running` and `wechat.installed=true`.
2. Use `/sessions` to find the target chat.
3. Use `/messages` / `/search` / `/query` for text retrieval.
4. For images / files: call `/media/<type>/list` first; export only `status=cached` items.
5. If data seems stale: `POST /refresh` then retry.

## Error codes (semantic envelope)

All errors return `{ error: <code>, message: <human-readable>, detail?: <raw> }`.

| HTTP | `error` | Meaning / Action |
|------|---------|------------------|
| 401 | `not_logged_in` | WeChat is not logged in in the instance. Surface a clear message: user must open the VNC desktop on the panel and scan the QR code with their phone. |
| 401 | (no body) | PAT invalid or expired. |
| 403 | — | PAT does not have access to this instance. |
| 404 | `session_not_found` | Session name not found; check `/sessions`. |
| 404 | `not_found` | Specific item (e.g. media index) not present. |
| **409** | **`media_not_downloaded`** | **The HD original of the requested media has not been cached by WeChat yet. Tell the user to open the message in the WeChat UI (via the VNC desktop) — WeChat fetches HD from CDN only on user tap. Retry the export after the user views the message.** |
| 500 | `ptrace_denied` | Host kernel parameter is wrong. Operator must run `echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope` (or persistent sysctl). |
| 503 | `not_initialized` / `wechat_not_running` / `refresh_locked` | Transient; wait briefly and retry. Auto-init handles most cases. |
| 504 | `timeout` | tg command timed out; retry once. |
| 502 | `unknown` | Generic tg failure. Inspect `detail` for raw output. |

## Time filters

`since` supports: dates (`2026-04-28`), relative (`5min`, `1h`, `30d`, `1y`),
keywords (`today`, `yesterday`).

## Tips

- When asked to summarize a chat, prefer `/query` with `fields=time,sender,body` to
  reduce token cost vs full `/messages` output.
- When asked about an image content, list media first, then export specific cached
  ones; never claim a `missing` image is unavailable without surfacing the
  "请在 WeChat 客户端中打开该消息" instruction.
- When the user says "刚才发的图" (the image just sent), it is almost always still
  in `missing` state — WeChat caches the thumbnail automatically but not the HD
  original. Direct the user to open the message in the desktop to trigger CDN fetch.
