'use strict';

/**
 * 站内检索（插件自带内存索引）
 *
 * 为什么不用官方 filter:search.query：dbsearch 在 MongoDB 上用 $text 索引，
 * 不会切分中文，中文查询几乎召回为 0。论坛体量不大（数百主题），
 * 这里直接在内存里建“主题级”倒排索引：
 *  - 中文二元切分 + 英文词，BM25 打分；标题/版块/标签加权，整词命中标题额外加分
 *  - 返回前用官方 privileges 过滤，只给当前用户可见的主题
 *  - 每个主题挑出与问题最相关的段落作为摘录（而不是帖子开头）
 *  - 索引 5 分钟过期；发帖/编辑时标记失效，下次查询时重建
 */

const nconf = require.main.require('nconf');
const db = require.main.require('./src/database');
const topics = require.main.require('./src/topics');
const posts = require.main.require('./src/posts');
const categories = require.main.require('./src/categories');
const privileges = require.main.require('./src/privileges');
const tokenizer = require('./tokenizer');

const TTL_MS = 5 * 60 * 1000;
const K1 = 1.2;
const B = 0.75;
const W_TITLE = 4;
const W_META = 2;

let index = null; // { builtAt, docs: Map<tid, doc>, df: Map<term, n>, N, avgLen, cats: Map<cid, cat> }
let building = null;
let dirty = false;

function rp() {
	return nconf.get('relative_path') || '';
}

function countTerms(arr) {
	const m = new Map();
	arr.forEach((t) => m.set(t, (m.get(t) || 0) + 1));
	return m;
}

async function build() {
	const tids = (await db.getSortedSetRange('topics:tid', 0, -1)).map(Number).filter(Boolean);
	const cids = (await db.getSortedSetRange('categories:cid', 0, -1)).map(Number).filter(Boolean);
	const catList = await categories.getCategoriesFields(cids, ['cid', 'name', 'description', 'topic_count', 'disabled', 'parentCid']);
	const cats = new Map();
	catList.forEach((c) => {
		if (c && c.cid && !Number(c.disabled)) {
			cats.set(Number(c.cid), c);
		}
	});

	const docs = new Map();
	const df = new Map();
	let totalLen = 0;
	const BATCH = 100;
	for (let i = 0; i < tids.length; i += BATCH) {
		const slice = tids.slice(i, i + BATCH);
		// eslint-disable-next-line no-await-in-loop
		const tData = await topics.getTopicsFields(slice, ['tid', 'cid', 'title', 'slug', 'mainPid', 'deleted', 'timestamp', 'postcount', 'viewcount', 'tags']);
		const live = tData.filter((t) => t && t.tid && !Number(t.deleted) && cats.has(Number(t.cid)));
		// eslint-disable-next-line no-await-in-loop
		const postKeys = await db.getSortedSetsMembers(live.map((t) => `tid:${t.tid}:posts`));
		const pidLists = live.map((t, k) => [Number(t.mainPid), ...(postKeys[k] || []).map(Number)].filter(Boolean));
		const allPids = [...new Set(pidLists.flat())];
		// eslint-disable-next-line no-await-in-loop
		const pData = await posts.getPostsFields(allPids, ['pid', 'content', 'deleted']);
		const pMap = new Map();
		pData.forEach((p) => {
			if (p && p.pid && !Number(p.deleted)) {
				pMap.set(Number(p.pid), tokenizer.cleanContent(p.content));
			}
		});

		live.forEach((t, k) => {
			const seen = new Set();
			const parts = [];
			pidLists[k].forEach((pid) => {
				if (!seen.has(pid) && pMap.has(pid)) {
					seen.add(pid);
					parts.push(pMap.get(pid));
				}
			});
			const body = parts.join('\n');
			const cat = cats.get(Number(t.cid));
			const tags = (t.tags || []).map((x) => (typeof x === 'string' ? x : x.value)).filter(Boolean);
			const titleTf = countTerms(tokenizer.docTerms(t.title));
			const metaTf = countTerms(tokenizer.docTerms(`${cat.name} ${tags.join(' ')}`));
			const bodyTerms = tokenizer.docTerms(body);
			const bodyTf = countTerms(bodyTerms);
			const len = bodyTerms.length + 10;
			totalLen += len;
			const terms = new Set([...titleTf.keys(), ...metaTf.keys(), ...bodyTf.keys()]);
			terms.forEach((term) => df.set(term, (df.get(term) || 0) + 1));
			docs.set(Number(t.tid), {
				tid: Number(t.tid),
				cid: Number(t.cid),
				pid: Number(t.mainPid),
				title: t.title,
				titleLower: String(t.title || '').toLowerCase(),
				slug: t.slug,
				category: cat.name,
				tags,
				timestamp: Number(t.timestamp) || 0,
				postcount: Number(t.postcount) || 0,
				viewcount: Number(t.viewcount) || 0,
				body,
				len,
				titleTf,
				metaTf,
				bodyTf,
			});
		});
	}
	index = {
		builtAt: Date.now(),
		docs,
		df,
		N: docs.size || 1,
		avgLen: docs.size ? totalLen / docs.size : 1,
		cats,
	};
	dirty = false;
	return index;
}

async function getIndex() {
	if (index && !dirty && Date.now() - index.builtAt < TTL_MS) {
		return index;
	}
	if (!building) {
		building = build().finally(() => { building = null; });
	}
	// 已有旧索引时先用旧的，避免请求卡在重建上
	if (index) {
		building.catch(() => {});
		return index;
	}
	return building;
}

function markDirty() {
	dirty = true;
}

function idf(idx, term) {
	const n = idx.df.get(term) || 0;
	return Math.log(1 + (idx.N - n + 0.5) / (n + 0.5));
}

function scoreDoc(idx, doc, q) {
	let score = 0;
	const catHit = q.catIds && q.catIds.has(doc.cid);
	q.terms.forEach((term) => {
		const tf = (doc.titleTf.get(term) || 0) * W_TITLE +
			(doc.metaTf.get(term) || 0) * W_META +
			(doc.bodyTf.get(term) || 0);
		if (!tf) {
			return;
		}
		const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * doc.len / idx.avgLen));
		score += idf(idx, term) * norm;
	});
	if (!score) {
		return 0;
	}
	if (catHit) {
		score += 4;
	}
	// 整词命中标题 / 正文
	q.phrases.forEach((p) => {
		if (p.length >= 2) {
			if (doc.titleLower.includes(p)) {
				score += 3 + p.length * 0.5;
			} else if (doc.body.toLowerCase().includes(p)) {
				score += 1;
			}
		}
	});
	// 覆盖率：命中的查询词越多越好
	const hit = q.terms.filter((t) => doc.titleTf.has(t) || doc.bodyTf.has(t) || doc.metaTf.has(t) || (catHit && q.catTerms.has(t))).length;
	score *= 0.6 + 0.4 * (hit / q.terms.length);
	return score;
}

/** 解析查询，并识别其中提到的版块名（如“智能家居”“智能影院”） */
function prepareQuery(idx, queryText) {
	const q = tokenizer.queryTerms(queryText);
	const lower = String(queryText || '').toLowerCase();
	q.catIds = new Set();
	q.catTerms = new Set();
	idx.cats.forEach((c) => {
		const name = String(c.name || '').toLowerCase();
		if (name.length >= 2 && lower.includes(name)) {
			q.catIds.add(Number(c.cid));
			tokenizer.docTerms(name).forEach((t) => q.catTerms.add(t));
		}
	});
	return q;
}

/** 从正文中挑与问题最相关的段落，拼成不超过 maxLen 的摘录 */
function bestPassages(doc, q, maxLen) {
	maxLen = maxLen || 700;
	const chunks = [];
	doc.body.split('\n').forEach((para) => {
		const p = para.trim();
		if (!p) {
			return;
		}
		for (let i = 0; i < p.length; i += 260) {
			chunks.push(p.slice(i, i + 300));
		}
	});
	if (!chunks.length) {
		return '';
	}
	const termSet = new Set(q.terms);
	const scored = chunks.map((c, i) => {
		const ts = tokenizer.docTerms(c);
		let s = 0;
		const seen = new Set();
		ts.forEach((t) => {
			if (termSet.has(t) && !seen.has(t)) {
				seen.add(t);
				s += 1;
			}
		});
		return { i, c, s };
	});
	const picked = new Set([0]); // 保留开头一段交代背景
	scored.slice().sort((a, b) => b.s - a.s).forEach((x) => {
		if (x.s > 0) {
			picked.add(x.i);
		}
	});
	let out = '';
	[...picked].sort((a, b) => a - b).forEach((i, k, arr) => {
		if (out.length >= maxLen) {
			return;
		}
		const gap = k > 0 && i !== arr[k - 1] + 1 ? '……' : '';
		out += gap + chunks[i];
	});
	return out.slice(0, maxLen);
}

function toHit(doc, q, snippetLen) {
	return {
		pid: doc.pid,
		tid: doc.tid,
		title: doc.title,
		category: doc.category,
		date: doc.timestamp ? new Date(doc.timestamp).toISOString().slice(0, 10) : '',
		url: `${rp()}/topic/${doc.slug}`,
		snippet: q ? bestPassages(doc, q, snippetLen) : doc.body.slice(0, snippetLen || 300),
	};
}

/**
 * 主题级检索
 * @returns {Promise<Array<{pid,tid,title,category,date,url,snippet,score}>>}
 */
async function searchTopics(queryText, uid, limit, opts) {
	opts = opts || {};
	limit = Math.min(Math.max(parseInt(limit, 10) || 6, 1), 30);
	const idx = await getIndex();
	const q = prepareQuery(idx, queryText);
	if (!q.terms.length) {
		return [];
	}
	const ranked = [];
	idx.docs.forEach((doc) => {
		const s = scoreDoc(idx, doc, q);
		if (s > 0) {
			ranked.push({ doc, s });
		}
	});
	ranked.sort((a, b) => b.s - a.s);
	if (!ranked.length) {
		return [];
	}
	// 相对阈值：明显弱于第一名的结果不要，避免“凑数”的无关帖子
	const minScore = ranked[0].s * (opts.minRatio || 0.3);
	const cand = ranked.filter((r) => r.s >= minScore).slice(0, limit * 3);
	const allowed = new Set((await privileges.topics.filterTids('topics:read', cand.map((r) => r.doc.tid), uid || 0)).map(Number));
	return cand
		.filter((r) => allowed.has(r.doc.tid))
		.slice(0, limit)
		.map((r) => Object.assign(toHit(r.doc, q, opts.snippetLen), { score: Math.round(r.s * 100) / 100 }));
}

/** 兼容旧接口：返回帖子形态的结果 */
async function searchPosts(queryText, uid, limit) {
	return searchTopics(queryText, uid, limit);
}

/** 论坛概况：版块、主题数、最新/热门主题（只含当前用户可见内容） */
async function overview(uid) {
	const idx = await getIndex();
	const readable = new Set((await privileges.categories.filterCids('topics:read', [...idx.cats.keys()], uid || 0)).map(Number));
	const counts = new Map();
	idx.docs.forEach((d) => counts.set(d.cid, (counts.get(d.cid) || 0) + 1));
	const catLines = [...idx.cats.values()]
		.filter((c) => readable.has(Number(c.cid)))
		.map((c) => {
			const desc = tokenizer.stripHtml(c.description || '').slice(0, 40);
			return `- ${c.name}（${counts.get(Number(c.cid)) || 0} 个主题）${desc ? `：${desc}` : ''}`;
		});
	const visible = [...idx.docs.values()].filter((d) => readable.has(d.cid));
	const latest = visible.slice().sort((a, b) => b.timestamp - a.timestamp).slice(0, 6)
		.map((d) => `- ${d.title}（${d.category}）`);
	const hot = visible.slice().sort((a, b) => (b.postcount * 5 + b.viewcount) - (a.postcount * 5 + a.viewcount)).slice(0, 5)
		.map((d) => `- ${d.title}（${d.category}）`);
	return {
		text: `站点：R论坛（${nconf.get('url') || ''}），共 ${visible.length} 个主题。\n版块：\n${catLines.join('\n')}\n最新主题：\n${latest.join('\n')}\n热门主题：\n${hot.join('\n')}`,
		topicCount: visible.length,
	};
}

/** 供站内搜索增强：返回 tid 或主楼 pid 列表 */
async function searchIds(queryText, type, limit) {
	const idx = await getIndex();
	const q = prepareQuery(idx, queryText);
	if (!q.terms.length) {
		return [];
	}
	const ranked = [];
	idx.docs.forEach((doc) => {
		const s = scoreDoc(idx, doc, q);
		if (s > 0) {
			ranked.push({ doc, s });
		}
	});
	ranked.sort((a, b) => b.s - a.s);
	const top = ranked.length ? ranked[0].s * 0.2 : 0;
	return ranked.filter((r) => r.s >= top).slice(0, limit || 50)
		.map((r) => (type === 'topic' ? r.doc.tid : r.doc.pid));
}

module.exports = { searchTopics, searchPosts, searchIds, overview, markDirty, getIndex };
