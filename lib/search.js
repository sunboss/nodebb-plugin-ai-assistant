'use strict';

/**
 * AI 语义搜索
 *
 * 1. enhanceQuery(data) — filter:search.query hook：
 *    中文查询做二元分词展开，做一次补充检索，结果合并进 data.ids。
 *    纯加法，不改变原有搜索行为；_aiAssistInternal 防止递归。
 * 2. handler(req,res) — POST /api/plugins/ai-assistant/search：
 *    LLM 从自然语言提取关键词 -> 站内检索 -> 可选 LLM 重排 -> 返回帖子列表。
 */

const plugins = require.main.require('./src/plugins');
const settings = require('./settings');
const tokenizer = require('./tokenizer');
const llm = require('./llm');
const rateLimiter = require('./rateLimiter');
const retrieval = require('./retrieval');

async function enhanceQuery(data) {
	if (!data || data._aiAssistInternal) {
		return data;
	}
	if (!data.content || typeof data.content !== 'string') {
		return data;
	}
	let cfg;
	try {
		cfg = await settings.get();
	} catch (err) {
		return data;
	}
	if (!cfg.enableCjkBoost || !tokenizer.hasCJK(data.content)) {
		return data;
	}
	const terms = tokenizer.tokenize(data.content);
	if (!terms.length) {
		return data;
	}
	try {
		const sub = await plugins.hooks.fire('filter:search.query', {
			index: data.index,
			content: terms.join(' '),
			matchWords: 'any',
			ids: [],
			_aiAssistInternal: true,
		});
		const extra = Array.isArray(sub) ? sub : (sub.ids || []);
		data.ids = data.ids || [];
		const seen = new Set(data.ids.map((id) => Number(id)));
		extra.forEach((id) => {
			id = Number(id);
			if (id && !seen.has(id)) {
				seen.add(id);
				data.ids.push(id);
			}
		});
	} catch (err) {
		// 增强失败不影响主搜索
	}
	return data;
}

async function handler(req, res) {
	try {
		const cfg = await settings.get();
		if (!cfg.enableAiSearch) {
			return res.status(403).json({ error: 'AI 搜索未启用' });
		}
		const ip = rateLimiter.getIp(req);
		if (!rateLimiter.hit(ip, cfg.rateLimit)) {
			return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
		}
		const q = String((req.body && req.body.q) || '').trim().slice(0, 200);
		if (!q) {
			return res.status(400).json({ error: '缺少搜索关键词' });
		}
		if (!cfg.apiKey) {
			return res.status(503).json({ error: 'AI 服务未配置' });
		}
		const uid = req.uid || 0;

		// 1) LLM 提取关键词（失败则回退到本地分词）
		let keywords = tokenizer.tokenize(q).slice(0, 8);
		try {
			const kwText = await llm.chatCompletions({
				baseUrl: cfg.baseUrl,
				apiKey: cfg.apiKey,
				model: cfg.model,
				messages: [
					{
						role: 'system',
						content: '你是一个论坛搜索关键词提取器。用户输入自然语言问题，你提取 3-8 个最适合站内搜索的关键词（保留中文原词）。只返回 JSON 数组，例如 ["智能家居","KNX"]，不要返回其他内容。',
					},
					{ role: 'user', content: q },
				],
				temperature: 0.1,
				maxTokens: 200,
			});
			const parsed = llm.extractJson(kwText);
			if (Array.isArray(parsed) && parsed.length) {
				keywords = parsed.map((k) => String(k)).filter(Boolean).slice(0, 8);
			}
		} catch (err) {
			// 回退：用本地分词结果
		}
		if (!keywords.length) {
			return res.json({ results: [] });
		}

		// 2) 逐关键词检索并合并去重
		const seen = new Map();
		for (const kw of keywords) {
			// eslint-disable-next-line no-await-in-loop
			const hits = await retrieval.searchPosts(kw, uid, 6);
			hits.forEach((h) => {
				if (!seen.has(h.pid)) {
					seen.set(h.pid, h);
				}
			});
			if (seen.size >= 12) {
				break;
			}
		}
		let results = [...seen.values()].slice(0, 12);

		// 3) 可选：LLM 重排（默认关闭，省 token）
		if (cfg.aiRerank && results.length > 1) {
			try {
				const list = results
					.map((r, i) => `${i + 1}. ${r.title}：${r.snippet.slice(0, 120)}`)
					.join('\n');
				const rankText = await llm.chatCompletions({
					baseUrl: cfg.baseUrl,
					apiKey: cfg.apiKey,
					model: cfg.model,
					messages: [
						{
							role: 'system',
							content: '你是搜索结果重排器。根据用户问题，把候选结果按相关度从高到低排序，只返回序号 JSON 数组，如 [3,1,2]，不要返回其他内容。',
						},
						{ role: 'user', content: `问题：${q}\n候选：\n${list}` },
					],
					temperature: 0.1,
					maxTokens: 200,
				});
				const order = llm.extractJson(rankText);
				if (Array.isArray(order)) {
					const ranked = [];
					order.forEach((i) => {
						const r = results[Number(i) - 1];
						if (r && !ranked.includes(r)) {
							ranked.push(r);
						}
					});
					results.forEach((r) => {
						if (!ranked.includes(r)) {
							ranked.push(r);
						}
					});
					results = ranked;
				}
			} catch (err) {
				// 保持原顺序
			}
		}

		return res.json({ results });
	} catch (err) {
		return res.status(err.status || 500).json({ error: err.message || '搜索失败' });
	}
}

module.exports = { enhanceQuery, handler };
