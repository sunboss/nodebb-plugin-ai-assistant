'use strict';

/**
 * 轻量中文分词（纯 JS，零依赖）
 *
 * - tokenize(text)    召回用：英文词 + 中文二元切分 + 短连续串（兼容旧调用）
 * - queryTerms(text)  查询用：先去掉“怎么/哪些/帖子/论坛”等无检索价值的词，再切分
 * - docTerms(text)    建索引用：英文词 + 中文二元切分（不含整串，避免长串噪声）
 * - cleanContent(raw) 帖子正文清洗：去 Markdown/HTML/图片/隐藏内容
 */

const CJK = '\\u4e00-\\u9fff\\u3400-\\u4dbf\\uf900-\\ufaff';
const CJK_RE = new RegExp(`[${CJK}]+`, 'g');
const LATIN_RE = /[a-z0-9]+(?:[._+-][a-z0-9]+)*/gi;

// 查询里没有检索价值的词（按长度降序匹配，先替换长词）
const STOP_PHRASES = [
	'有没有', '是不是', '为什么', '怎么样', '怎么办', '哪一些', '什么样',
	'请问', '一下', '怎么', '如何', '什么', '哪些', '哪个', '哪里', '多少',
	'推荐', '介绍', '讨论', '帖子', '论坛', '本站', '站内', '相关', '关于',
	'可以', '应该', '需要', '我们', '你们', '他们', '这个', '那个', '这些', '那些',
	'主要', '一些', '一个', '大家', '现在', '目前', '最近', '还有', '以及', '或者',
	'入门', '新手', '教程', '指南', '内容', '文章', '话题', '东西', '方面', '情况', '问题', '看看', '告诉', '知道',
	'吗', '呢', '吧', '啊', '呀', '的', '了', '和', '与', '及', '在', '是', '有',
	'看', '聊', '讲', '说', '想', '要', '把', '被', '给', '让', '我', '你', '他', '她',
	'它', '都', '也', '就', '还', '又', '很', '更', '最', '能', '会', '对', '从', '到',
].sort((a, b) => b.length - a.length);
const STOP_RE = new RegExp(STOP_PHRASES.join('|'), 'g');
const LATIN_STOP = new Set(['the', 'and', 'for', 'with', 'what', 'how', 'is', 'are', 'of', 'to', 'in', 'on', 'a', 'an']);

function hasCJK(text) {
	return new RegExp(`[${CJK}]`).test(text || '');
}

function latinWords(src) {
	return (String(src || '').toLowerCase().match(LATIN_RE) || [])
		.filter((w) => w.length >= 2 && !LATIN_STOP.has(w));
}

function bigrams(run) {
	const out = [];
	if (run.length === 1) {
		return out;
	}
	for (let i = 0; i < run.length - 1; i++) {
		out.push(run.slice(i, i + 2));
	}
	return out;
}

/** 兼容旧接口：召回优先 */
function tokenize(text) {
	const terms = new Set(latinWords(text));
	(String(text || '').match(CJK_RE) || []).forEach((run) => {
		if (run.length >= 2 && run.length <= 6) {
			terms.add(run);
		}
		bigrams(run).forEach((t) => terms.add(t));
	});
	return [...terms];
}

/** 建索引：返回词条数组（含重复，用于统计词频） */
function docTerms(text) {
	const src = String(text || '').toLowerCase();
	const out = latinWords(src);
	(src.match(CJK_RE) || []).forEach((run) => {
		bigrams(run).forEach((t) => out.push(t));
	});
	return out;
}

/**
 * 查询：返回 { terms: 去重词条, phrases: 用于标题整词加分的短语 }
 */
function queryTerms(text) {
	const src = String(text || '').toLowerCase();
	const latin = latinWords(src);
	const phrases = new Set(latin);
	const terms = new Set(latin);
	const cjkOnly = src.replace(STOP_RE, ' ');
	(cjkOnly.match(CJK_RE) || []).forEach((run) => {
		if (run.length >= 2) {
			phrases.add(run);
		}
		bigrams(run).forEach((t) => terms.add(t));
	});
	return { terms: [...terms], phrases: [...phrases] };
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

/** 帖子原文（Markdown）清洗为纯文本，保留段落换行；隐藏内容不进入 AI 上下文 */
function cleanContent(raw) {
	return String(raw || '')
		.replace(/\[hide\][\s\S]*?\[\/hide\]/gi, ' ')
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/<[^>]*>/g, ' ')
		.replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
		.replace(/[*_~`|]+/g, '')
		.replace(/^-{3,}$/gm, '')
		.replace(/\[图片\]/g, ' ')
		.replace(/[ \t\u00a0]+/g, ' ')
		.replace(/\n\s*\n+/g, '\n')
		.trim();
}

module.exports = { hasCJK, tokenize, docTerms, queryTerms, stripHtml, cleanContent };
