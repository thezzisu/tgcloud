---
name: tgcloud
description: Use when the user wants to read, search, query, export, or troubleshoot WeChat chat history via tgcloud's REST API. Requires TGCLOUD_BASE_URL and TGCLOUD_PAT environment variables.
when_to_use: Trigger for requests mentioning WeChat chat, 微信聊天记录, 微信消息, WeChat messages, reading WeChat group history, searching WeChat conversations, or exporting WeChat data via tgcloud.
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
and treat exports as sensitive. Use `--anonymous` patterns when exposing group chats.

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

1. List instances → pick one with `runtime=running` and `wechat.installed=true`
2. If data seems stale: POST `/refresh`
3. Use `/sessions` to find the target chat
4. Use `/messages` or `/search` or `/query` for data retrieval

## Troubleshooting

- 401: PAT invalid or expired
- 403: PAT does not have access to this instance
- 502 with "tg ... failed": WeChat may not be running, or key extraction needs ptrace.
  Check `/status` first; if running, try POST `/refresh`.
- Empty results: the decrypted cache may be stale — POST `/refresh` then retry.

## Time Filters

`since` supports: dates (`2026-04-28`), relative (`5min`, `1h`, `30d`, `1y`), keywords (`today`, `yesterday`).
