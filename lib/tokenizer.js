'use strict';

/**
 * 轻量中文分词（纯 JS，零依赖）
 *
 * 思路与 nodebb-plugin-dbsearch-rsjieba 一致：中文按词切分。
 * 这里用二元切分（bigram）+ 完整词 + 英文单词，召回优先，
 * 由下游的 dbsearch/rsjieba 做精确匹配。
 */

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g;
const LATIN_RE = /[a-z0-9]+(?:[._-][a-z0-9]+)*/gi;

function hasCJK(text) {
	return /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(text || '');
}

/**
 * @returns {string[]} 去重后的词条数组
 */
function tokenize(text) {
	const terms = new Set();
	const src = String(text || '');

	// 英文/数字词
	const latin = src.toLowerCase().match(LATIN_RE) || [];
	latin.forEach((w) => {
		if (w.length >= 2) {
			terms.add(w);
		}
	});

	// 中文：二元切分 + 完整连续串（2-6 字）
	const runs = src.match(CJK_RE) || [];
	runs.forEach((run) => {
		if (run.length >= 2 && run.length <= 6) {
			terms.add(run);
		}
		for (let i = 0; i < run.length - 1; i++) {
			terms.add(run.slice(i, i + 2));
		}
	});

	return [...terms];
}

function stripHtml(html) {
	return String(html || '')
		.replace(/<[^>]*>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/\s+/g, ' ')
		.trim();
}

module.exports = { hasCJK, tokenize, stripHtml };
