'use strict';

/**
 * nodebb-plugin-ai-assistant — 主入口
 *
 * 功能：
 *  1. filter:search.query 中文分词增强（加法式，不破坏原有搜索）
 *  2. POST /api/plugins/ai-assistant/chat   — AI 问答助手（基于站内帖子）
 *  3. POST /api/plugins/ai-assistant/search — AI 语义搜索（LLM 提取关键词再检索）
 *  4. ACP 设置页 /admin/plugins/ai-assistant
 *
 * API Key 永不硬编码：环境变量 AI_ASSISTANT_API_KEY 优先，其次为 ACP 配置。
 */

const plugin = {};

plugin.init = async function (params) {
	const { router, middleware } = params;
	const routeHelpers = require.main.require('./src/routes/helpers');
	const admin = require('./lib/admin');
	const chat = require('./lib/chat');
	const search = require('./lib/search');

	// ACP 设置页
	routeHelpers.setupAdminPageRoute(router, '/admin/plugins/ai-assistant', admin.render);
	router.post('/api/admin/plugins/ai-assistant/save', middleware.applyCSRF, admin.save);

	// 公开 API（限流在 handler 内做）
	router.post('/api/plugins/ai-assistant/chat', chat.handler);
	router.post('/api/plugins/ai-assistant/search', search.handler);
};

plugin.adminMenu = async function (header) {
	header.plugins.push({
		route: '/plugins/ai-assistant',
		icon: 'fa-wand-magic-sparkles',
		name: 'AI 助手',
	});
	return header;
};

plugin.searchQuery = async function (data) {
	const search = require('./lib/search');
	return search.enhanceQuery(data);
};

plugin.onPostSave = async function (postData) {
	const autoreply = require('./lib/autoreply');
	return autoreply.onPostSave(postData);
};

module.exports = plugin;
