# nodebb-plugin-ai-assistant

NodeBB AI 插件：AI 语义搜索 + 站内问答助手（含中文分词搜索增强）。
对标 Discourse 官方 `discourse-ai` 插件的核心能力。模型由 **1118.si** 提供。

## 功能

| 功能 | 说明 |
|------|------|
| AI 问答 | 右下角悬浮按钮，基于站内帖子内容回答，附来源帖子链接 |
| AI 搜索 | 面板内「AI 搜索」tab：自然语言提问 → LLM 提取关键词 → 站内检索（可选 LLM 重排） |
| 中文分词增强 | `filter:search.query` hook：中文查询做二元分词展开，补充召回（纯加法，不影响原有搜索） |

- 只返回当前用户有权限查看的帖子（走 NodeBB 官方权限过滤）。
- 限流：默认每 IP 每分钟 20 次，可配置。
- 零第三方依赖（Node 18+ 原生 fetch）。

## 安装（meta.1234r.com，Docker 部署）

```bash
# 1. 把插件目录复制到容器内
docker cp /data/sunboss/nodebb/plugin-src/nodebb-plugin-ai-assistant/. \
  nodebb-nodebb-1:/usr/src/app/node_modules/nodebb-plugin-ai-assistant/

# 2. 构建前端资源（scripts/css/templates 生效需要）
docker exec nodebb-nodebb-1 ./nodebb build

# 3. 重启
docker exec nodebb-nodebb-1 ./nodebb restart
# 或
cd /data/sunboss/nodebb && docker compose restart nodebb
```

然后 ACP → 扩展 → 插件 → 启用 `nodebb-plugin-ai-assistant`。

> 容器重建（镜像更新）后需重新执行步骤 1-3。建议把插件源码放在宿主机
> `/data/sunboss/nodebb/plugin-src/` 做持久化。

## 配置

ACP → 插件 → AI 助手：

| 项 | 说明 |
|----|------|
| API Key | 算力中转站 Key（密码框，不回显；留空=不修改） |
| 接口地址 | 默认 `https://api.1234r.com/v1`（OpenAI 兼容） |
| 模型 | 默认 `gpt-4o-mini` |
| 开关 | AI 问答 / AI 搜索 / 中文分词增强 / LLM 重排 |
| 限流 | 每 IP 每分钟请求数，默认 20 |
| 参考帖子数 | 问答时取回的帖子数，默认 6 |

**推荐**：用环境变量注入 Key（重启生效，优先于页面配置）：

```yaml
# /data/sunboss/nodebb/docker-compose.yml 的 nodebb 服务下
environment:
  - AI_ASSISTANT_API_KEY=sk-xxxx
```

## API

- `POST /api/plugins/ai-assistant/chat` — `{message, history[]} → {answer, sources:[{title,url}]}`
- `POST /api/plugins/ai-assistant/search` — `{q} → {results:[{title,url,snippet}]}`

错误码：400 参数缺失 / 403 功能未启用 / 429 限流 / 503 未配置 Key。

## 升级

1. 备份旧目录（或 git 打 tag）。
2. 用新版本覆盖 `/data/sunboss/nodebb/plugin-src/nodebb-plugin-ai-assistant/`。
3. 重复安装步骤 1-3（`docker cp` → `./nodebb build` → 重启）。
4. 对照 CHANGELOG 看是否有配置项变更。

## 故障排查

| 现象 | 排查 |
|------|------|
| 悬浮按钮不出现 | `./nodebb build` 是否执行；浏览器硬刷新 |
| 对话报"AI 服务未配置" | 检查环境变量/API Key 是否生效（`docker exec nodebb-nodebb-1 env \| grep AI_ASSISTANT`） |
| 搜索无结果 | 确认 dbsearch 插件正常；看 NodeBB 日志 `docker logs nodebb-nodebb-1` |
| 429 频繁 | ACP 里调高限流值 |

## 许可证

MIT
