# Changelog

## [1.0.0] - 2026-10-09

首个版本，对标 discourse-ai 核心能力。

### Added
- AI 问答助手：右下角悬浮按钮 + 对话面板，基于站内帖子检索生成回答，附来源帖子链接；模型对外标识为 1118.si
- AI 语义搜索：面板内「AI 搜索」tab，LLM 从自然语言提取关键词后站内检索，可选 LLM 重排
- 中文分词增强：`filter:search.query` hook 对中文查询做二元分词展开、补充召回（加法式，不影响原有搜索）
- ACP 设置页：API Key（密码框，不回显）、接口地址、模型、四组功能开关、限流、参考帖子数、系统提示词
- 配置三级优先级：环境变量 `AI_ASSISTANT_API_KEY` > ACP 配置 > 默认值
- 限流：按 IP 滑动窗口（默认 20 次/分钟），兼容 Traefik 的 X-Forwarded-For
- 权限：检索结果经 NodeBB 官方 `privileges.posts.filter` 过滤，只返回当前用户可见帖子
- 零第三方依赖（Node 18+ 原生 fetch）

## [Unreleased]

计划：
- 长帖 AI 摘要（对标 discourse-ai 的 summarization）
- 语义向量检索（embeddings）
- 新帖自动打标签
