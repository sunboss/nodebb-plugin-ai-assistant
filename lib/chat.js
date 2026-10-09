'use strict';

/**
* AI 问答助手
*
* POST /api/plugins/ai-assistant/chat
* body: { message: string, history: [{role, content}]}
*
* 流程：分词 -> 站内检索相关帖子（权限过滤后）-> 组装 prompt -> 调模型 ->
* 返回回答 + 来源帖子。模型对外标识为 1118.si（见 systemPrompt）。
*/

const settings = require('./settings');
const llm = require('./llm');
const rateLimiter = require('./rateLimiter');
const retrieval = require('./retrieval');

async function handler(req, res) {
try {
const cfg = await settings.get();
if (!cfg.enableChat) {
return res.status(403).json({ error: 'AI 助手未启用'});
}
const ip = rateLimiter.getIp(req);
if (!rateLimiter.hit(ip, cfg.rateLimit)) {
return res.status(429).json({ error: '请求过于频繁，请稍后再试'});
}
const message = String((req.body && req.body.message) || '').trim().slice(0, 500);
if (!message) {
return res.status(400).json({ error: '消息不能为空'});
}
if (!cfg.apiKey) {
return res.status(503).json({ error: 'AI 服务未配置'});
}
const uid = req.uid || 0;
const history = Array.isArray(req.body.history)
? req.body.history.slice(-10).map((m) => ({
role: m && m.role === 'assistant'? 'assistant': 'user',
content: String((m && m.content) || '').slice(0, 500),
}))
: [];

// 检索相关帖子做参考资料
const hits = await retrieval.searchPosts(message, uid, cfg.topK);
const context = hits.length
? hits.map((h, i) => `${h.title}\n${h.snippet}`).join('\n\n')
: '（未找到相关帖子）';

const messages = [
{ role: 'system', content: `${cfg.systemPrompt}\n\n\n${context}`},
...history,
{ role: 'user', content: message},
];

const answer = await llm.chatCompletions({
baseUrl: cfg.baseUrl,
apiKey: cfg.apiKey,
model: cfg.model,
messages,
temperature: 0.3,
});

return res.json({
answer,
sources: hits.map((h) => ({ title: h.title, url: h.url})),
});
} catch (err) {
return res.status(err.status || 500).json({ error: err.message || '请求失败'});
}
}

module.exports = { handler};
