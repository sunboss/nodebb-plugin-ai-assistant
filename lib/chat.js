'use strict';

/**
* AI 问答助手
*
* POST /api/plugins/ai-assistant/chat
* body: { message: string, history: [{role, content}], stream?: boolean }
*
* 流程：查缓存 -> 分词 -> 站内检索相关帖子（权限过滤后）-> 组装 prompt ->
* 调模型（支持流式 SSE）-> 返回回答 + 来源帖子。
* 模型对外标识为 1118.si（见 systemPrompt）。
*
* 流式模式：body.stream=true 时返回 SSE 流：
*   data: {"token": "..."}  增量 token
*   data: {"done": true, "answer": "...", "sources": [...], "cached": false}
*/

const settings = require('./settings');
const llm = require('./llm');
const rateLimiter = require('./rateLimiter');
const retrieval = require('./retrieval');
const cache = require('./cache');

async function buildMessages(message, history, uid, cfg) {
	// 检索相关帖子做参考资料
	const hits = await retrieval.searchPosts(message, uid, cfg.topK);
	const context = hits.length
		? hits.map((h, i) => `${h.title}\n${h.snippet}`).join('\n\n')
		: '（未找到相关帖子）';

	const messages = [
		{ role: 'system', content: `${cfg.systemPrompt}\n\n\n${context}` },
		...history,
		{ role: 'user', content: message },
	];
	const sources = hits.map((h) => ({ title: h.title, url: h.url }));
	return { messages, sources };
}

function sanitizeHistory(raw) {
	return Array.isArray(raw)
		? raw.slice(-10).map((m) => ({
			role: m && m.role === 'assistant' ? 'assistant' : 'user',
			content: String((m && m.content) || '').slice(0, 500),
		}))
		: [];
}

async function handler(req, res) {
	try {
		const cfg = await settings.get();
		if (!cfg.enableChat) {
			return res.status(403).json({ error: 'AI 助手未启用' });
		}
		const ip = rateLimiter.getIp(req);
		if (!rateLimiter.hit(ip, cfg.rateLimit)) {
			return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
		}
		const message = String((req.body && req.body.message) || '').trim().slice(0, 500);
		if (!message) {
			return res.status(400).json({ error: '消息不能为空' });
		}
		if (!cfg.apiKey) {
			return res.status(503).json({ error: 'AI 服务未配置' });
		}
		const uid = req.uid || 0;
		const history = sanitizeHistory(req.body.history);
		const wantStream = !!(req.body && req.body.stream);

		// 1. 查缓存（常见问题直接返回，零成本零延迟）
		const cacheKey = `${cfg.model}::${message}`;
		if (cache.shouldCache(message)) {
			const cached = cache.get(cacheKey);
			if (cached) {
				if (wantStream) {
					// 流式下也走 SSE，但一次性发完
					res.writeHead(200, {
						'Content-Type': 'text/event-stream',
						'Cache-Control': 'no-cache',
						Connection: 'keep-alive',
					});
					res.write(`data: ${JSON.stringify({ token: cached.answer })}\n\n`);
					res.write(`data: ${JSON.stringify({
						done: true, answer: cached.answer, sources: cached.sources, cached: true,
					})}\n\n`);
					return res.end();
				}
				return res.json({ answer: cached.answer, sources: cached.sources, cached: true });
			}
		}

		const { messages, sources } = await buildMessages(message, history, uid, cfg);

		if (wantStream) {
			// 2a. 流式 SSE 模式
			res.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
				'X-Accel-Buffering': 'no', // 禁用 nginx 缓冲
			});
			try {
				const answer = await llm.chatCompletionsStream({
					baseUrl: cfg.baseUrl,
					apiKey: cfg.apiKey,
					model: cfg.model,
					messages,
					temperature: 0.3,
					onToken: (token) => {
						res.write(`data: ${JSON.stringify({ token })}\n\n`);
					},
				});
				// 写缓存
				if (cache.shouldCache(message)) {
					cache.set(cacheKey, { answer, sources });
				}
				res.write(`data: ${JSON.stringify({
					done: true, answer, sources, cached: false,
				})}\n\n`);
			} catch (err) {
				res.write(`data: ${JSON.stringify({
					error: err.message || '请求失败',
				})}\n\n`);
			}
			return res.end();
		}

		// 2b. 普通一次性返回模式（兼容旧前端）
		const answer = await llm.chatCompletions({
			baseUrl: cfg.baseUrl,
			apiKey: cfg.apiKey,
			model: cfg.model,
			messages,
			temperature: 0.3,
		});
		if (cache.shouldCache(message)) {
			cache.set(cacheKey, { answer, sources });
		}
		return res.json({ answer, sources, cached: false });
	} catch (err) {
		return res.status(err.status || 500).json({ error: err.message || '请求失败' });
	}
}

module.exports = { handler };
