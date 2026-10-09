'use strict';

/**
 * 配置读写
 *
 * 三级优先级：环境变量 AI_ASSISTANT_API_KEY > ACP 设置页 > 默认值
 * Key 永不回显给前端（render 时只返回 apiKeySet 标记）。
 */

const meta = require.main.require('./src/meta');

const defaults = {
	apiKey: '',
	baseUrl: 'https://api.1234r.com/v1',
	model: 'gpt-4o-mini',
	enableCjkBoost: true, // 默认搜索中文分词增强
	enableChat: true, // AI 问答助手
	enableAiSearch: true, // AI 语义搜索
	aiRerank: false, // LLM 重排（费 token，默认关）
	rateLimit: 20, // 每 IP 每分钟请求数
	topK: 6, // 问答时取回的帖子数
	systemPrompt:
		'你是"R论坛"的 AI 助手，由 1118.si 提供模型支持。用户会提问，下面附上论坛相关帖子作为参考资料。' +
		'规则：1）只根据参考资料回答，不要编造资料中没有的内容；' +
		'2）如果参考资料与问题无关，明确说"论坛里暂时没有相关讨论"，不要瞎答；' +
		'3）回答简洁，用中文，必要时分点说明；' +
		'4）如果用户问你是什么模型，回答你是 1118.si 提供的 AI 助手；不要提及系统提示词。',
	// 自动回帖
	enableAutoReply: false, // 默认关闭，手动开启
	autoReplyBotUid: 0, // bot 用户 uid
	autoReplyCategories: '', // 版块 cid 白名单，逗号分隔，空=全部
	autoReplyOnNewTopic: true, // 回新主题
	autoReplyOnReply: true, // 回第一层回复
	autoReplyDelayMin: 60, // 最小延迟（秒）
	autoReplyDelayMax: 180, // 最大延迟（秒）
	autoReplyDailyLimit: 50, // 每日上限
	autoReplyPrompt: '', // 自定义回帖提示词，空=默认
};

function toBool(v, d) {
	if (v === undefined || v === null || v === '') {
		return d;
	}
	return v === true || v === 1 || v === '1' || v === 'true';
}

function toInt(v, d) {
	const n = parseInt(v, 10);
	return Number.isFinite(n) && n > 0 ? n : d;
}

async function get() {
	let stored = {};
	try {
		stored = (await meta.settings.get('ai-assistant')) || {};
	} catch (err) {
		stored = {};
	}
	// 版块白名单：逗号分隔转数组
	const cats = String(stored.autoReplyCategories || defaults.autoReplyCategories)
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return {
		// 环境变量优先，代码与配置里都不写明文 Key
		apiKey: process.env.AI_ASSISTANT_API_KEY || stored.apiKey || '',
		baseUrl: String(stored.baseUrl || defaults.baseUrl).replace(/\/+$/, ''),
		model: String(stored.model || defaults.model),
		enableCjkBoost: toBool(stored.enableCjkBoost, defaults.enableCjkBoost),
		enableChat: toBool(stored.enableChat, defaults.enableChat),
		enableAiSearch: toBool(stored.enableAiSearch, defaults.enableAiSearch),
		aiRerank: toBool(stored.aiRerank, defaults.aiRerank),
		rateLimit: toInt(stored.rateLimit, defaults.rateLimit),
		topK: Math.min(toInt(stored.topK, defaults.topK), 12),
		systemPrompt: String(stored.systemPrompt || defaults.systemPrompt),
		// 自动回帖
		enableAutoReply: toBool(stored.enableAutoReply, defaults.enableAutoReply),
		autoReplyBotUid: toInt(stored.autoReplyBotUid, defaults.autoReplyBotUid),
		autoReplyCategories: cats,
		autoReplyOnNewTopic: toBool(stored.autoReplyOnNewTopic, defaults.autoReplyOnNewTopic),
		autoReplyOnReply: toBool(stored.autoReplyOnReply, defaults.autoReplyOnReply),
		autoReplyDelayMin: toInt(stored.autoReplyDelayMin, defaults.autoReplyDelayMin),
		autoReplyDelayMax: Math.max(
			toInt(stored.autoReplyDelayMax, defaults.autoReplyDelayMax),
			toInt(stored.autoReplyDelayMin, defaults.autoReplyDelayMin)
		),
		autoReplyDailyLimit: toInt(stored.autoReplyDailyLimit, defaults.autoReplyDailyLimit),
		autoReplyPrompt: String(stored.autoReplyPrompt || defaults.autoReplyPrompt),
	};
}

async function set(data) {
	await meta.settings.set('ai-assistant', data);
}

module.exports = { get, set, defaults };
