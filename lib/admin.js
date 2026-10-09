'use strict';

/**
 * ACP 设置页
 *
 * GET  /admin/plugins/ai-assistant      — 渲染（Key 永不回显，只显示是否已设置）
 * POST /api/admin/plugins/ai-assistant/save — 保存（applyCSRF）
 */

const settings = require('./settings');

function toBool(v, d) {
	if (v === undefined || v === null || v === '') {
		return d;
	}
	return v === true || v === 1 || v === '1' || v === 'true';
}

async function render(req, res) {
	const cfg = await settings.get();
	res.render('admin/plugins/ai-assistant', {
		title: 'AI 助手',
		apiKeySet: !!cfg.apiKey,
		envKeySet: !!process.env.AI_ASSISTANT_API_KEY,
		baseUrl: cfg.baseUrl,
		model: cfg.model,
		enableCjkBoost: cfg.enableCjkBoost,
		enableChat: cfg.enableChat,
		enableAiSearch: cfg.enableAiSearch,
		aiRerank: cfg.aiRerank,
		rateLimit: cfg.rateLimit,
		topK: cfg.topK,
		systemPrompt: cfg.systemPrompt,
		// 自动回帖
		enableAutoReply: cfg.enableAutoReply,
		autoReplyBotUid: cfg.autoReplyBotUid,
		autoReplyCategories: cfg.autoReplyCategories.join(','),
		autoReplyOnNewTopic: cfg.autoReplyOnNewTopic,
		autoReplyOnReply: cfg.autoReplyOnReply,
		autoReplyDelayMin: cfg.autoReplyDelayMin,
		autoReplyDelayMax: cfg.autoReplyDelayMax,
		autoReplyDailyLimit: cfg.autoReplyDailyLimit,
		autoReplyPrompt: cfg.autoReplyPrompt,
	});
}

async function save(req, res) {
	try {
		const body = req.body || {};
		const current = await settings.get();
		// 空 Key = 不修改已保存的值
		const apiKey = String(body.apiKey || '').trim();
		const data = {
			baseUrl: String(body.baseUrl || '').trim() || current.baseUrl,
			model: String(body.model || '').trim() || current.model,
			enableCjkBoost: toBool(body.enableCjkBoost, current.enableCjkBoost),
			enableChat: toBool(body.enableChat, current.enableChat),
			enableAiSearch: toBool(body.enableAiSearch, current.enableAiSearch),
			aiRerank: toBool(body.aiRerank, current.aiRerank),
			rateLimit: body.rateLimit || current.rateLimit,
			topK: body.topK || current.topK,
			systemPrompt: String(body.systemPrompt || '').trim() || current.systemPrompt,
			// 自动回帖
			enableAutoReply: toBool(body.enableAutoReply, current.enableAutoReply),
			autoReplyBotUid: body.autoReplyBotUid || current.autoReplyBotUid,
			autoReplyCategories: String(body.autoReplyCategories || '').trim(),
			autoReplyOnNewTopic: toBool(body.autoReplyOnNewTopic, current.autoReplyOnNewTopic),
			autoReplyOnReply: toBool(body.autoReplyOnReply, current.autoReplyOnReply),
			autoReplyDelayMin: body.autoReplyDelayMin || current.autoReplyDelayMin,
			autoReplyDelayMax: body.autoReplyDelayMax || current.autoReplyDelayMax,
			autoReplyDailyLimit: body.autoReplyDailyLimit || current.autoReplyDailyLimit,
			autoReplyPrompt: String(body.autoReplyPrompt || '').trim(),
		};
		if (apiKey) {
			data.apiKey = apiKey;
		} else if (current.apiKey && !process.env.AI_ASSISTANT_API_KEY) {
			// 保留数据库里的旧值（环境变量优先时不需要写库）
			data.apiKey = current.apiKey;
		}
		await settings.set(data);
		return res.json({ message: '已保存' });
	} catch (err) {
		return res.status(500).json({ error: err.message || '保存失败' });
	}
}

module.exports = { render, save };
