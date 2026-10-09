'use strict';

/**
 * 站内检索（复用 NodeBB 官方搜索链路）
 *
 * 通过触发官方 `filter:search.query` hook 做检索（走当前启用的
 * 搜索引擎，如 dbsearch + rsjieba），再用 privileges 做权限过滤，
 * 最后取回帖子正文与话题标题。所有返回内容均为当前用户可见范围。
 */

const plugins = require.main.require('./src/plugins');
const privileges = require.main.require('./src/privileges');
const posts = require.main.require('./src/posts');
const topics = require.main.require('./src/topics');
const tokenizer = require('./tokenizer');

/**
 * @param {string} queryText 自然语言或关键词
 * @param {number} uid 当前用户 id（0=游客）
 * @param {number} limit 最多返回条数
 * @returns {Promise<Array<{pid,tid,title,url,snippet}>>}
 */
async function searchPosts(queryText, uid, limit) {
	const terms = tokenizer.tokenize(queryText);
	if (!terms.length) {
		return [];
	}
	uid = uid || 0;
	limit = Math.min(Math.max(parseInt(limit, 10) || 6, 1), 20);

	// 走官方 hook（_aiAssistInternal 防止本插件的 enhanceQuery 重复触发）
	const result = await plugins.hooks.fire('filter:search.query', {
		index: 'post',
		content: terms.join(' '),
		matchWords: 'any',
		ids: [],
		_aiAssistInternal: true,
	});
	let pids = Array.isArray(result) ? result : (result.ids || []);
	pids = [...new Set(pids.map((id) => parseInt(id, 10)).filter(Boolean))];
	if (!pids.length) {
		return [];
	}

	// 权限过滤：只保留当前用户可读的帖子
	pids = await privileges.posts.filter('topics:read', pids, uid);
	pids = pids.slice(0, limit);
	if (!pids.length) {
		return [];
	}

	const postObjs = await posts.getPostsByPids(pids, uid);
	const tids = [...new Set(postObjs.filter(Boolean).map((p) => p.tid).filter(Boolean))];
	const topicMap = {};
	if (tids.length) {
		const topicObjs = await topics.getTopicsFields(tids, ['tid', 'title', 'slug']);
		topicObjs.forEach((t) => {
			if (t && t.tid) {
				topicMap[t.tid] = t;
			}
		});
	}

	return postObjs.filter(Boolean).map((p) => {
		const t = topicMap[p.tid] || {};
		return {
			pid: p.pid,
			tid: p.tid,
			title: t.title || '(无标题)',
			url: t.slug ? `/topic/${t.slug}` : `/post/${p.pid}`,
			snippet: tokenizer.stripHtml(p.content).slice(0, 600),
		};
	});
}

module.exports = { searchPosts };
