'use strict';

/**
 * AI 自动跟帖（v2）
 *
 * 触发：action:post.save（真人发的新主题 / 真人回应机器人）→ 判定 → 写入持久化队列（MongoDB）
 *       → 主进程每分钟轮询到期任务 → 执行前复查 → 生成回复 → topics.reply 发出
 *
 * 相比 v1 的修正：
 *  - v1 读 post.isMainPost（不存在，NodeBB 字段是 isMain），新主题被当成回复处理，逻辑整体失效
 *  - v1 调 posts.reply（NodeBB 没有这个函数），即使开启也必然报错
 *  - v1 用 setTimeout 排队，容器重启即丢；现在队列存数据库
 *  - v1 用服务器时区判断深夜（容器是 UTC）；现在按 autoReplyTimezone（默认 Asia/Shanghai）
 *  - v1 一个账号轮换 5 种人格；现在每个机器人账号固定一种人格，口吻前后一致，可配置多个账号
 *  - v1 只看主帖开头 1000 字；现在带上主帖、楼内已有回复和站内相关帖子
 *  - v1 后台保存按钮不提交自动回帖字段；现在可在后台完整配置
 *  - 新增：每帖机器人回复上限、机器人之间不互相接话、测试/站务帖跳过、套话/机器腔拦截、每日上限持久化
 */

const nconf = require.main.require('nconf');
const db = require.main.require('./src/database');
const settings = require('./settings');
const llm = require('./llm');
const tokenizer = require('./tokenizer');

const QUEUE_KEY = 'ai-assistant:autoreply:queue'; // zset: score=dueAt, value=jobId
const JOB_PREFIX = 'ai-assistant:autoreply:job:'; // hash
const DONE_PREFIX = 'ai-assistant:autoreply:done:'; // 同一触发帖只处理一次
const COUNT_PREFIX = 'ai-assistant:autoreply:count:'; // 每日计数
const POLL_MS = 60 * 1000;
const MAX_ATTEMPTS = 3;

const PERSONAS = [
	{ name: '实战派', style: '做过不少项目，喜欢讲自己踩过的坑和具体做法，语气直接', len: '2-4 句' },
	{ name: '技术控', style: '关注参数、协议、兼容性和原理，说话简洁，偶尔给一个具体的配置思路', len: '1-3 句' },
	{ name: '追问型', style: '先抓住帖子里一个关键点表态，再追问一个具体细节（预算、户型、版本、场景）', len: '2-3 句' },
	{ name: '理性派', style: '会指出帖子观点的适用前提或反面情况，补充另一种思路，不抬杠', len: '2-4 句' },
	{ name: '入门用户', style: '刚开始折腾，结合自己的情况说读后感，并提一个新手会关心的问题', len: '1-3 句' },
];

const BANNED_PHRASES = ['写得不错', '学习了', '感谢分享', '干货满满', 'mark', '蹲个后续', '受教了', '支持楼主', '好文', '顶一下'];
const AI_TELLS = /(作为(一个)?\s*(AI|人工智能|语言模型)|我是\s*(AI|人工智能|语言模型)|根据您提供的|以下是|希望(以上|这些)?(内容|回答|信息)?对你有(所)?帮助)/i;
const SKIP_TITLE = /(测试|test|调试|demo|勿回|站务)/i;

let timer = null;
let polling = false;

/* ---------------- 时间 ---------------- */

function hourAt(tz, ts) {
	try {
		return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date(ts)), 10) % 24;
	} catch (err) {
		return new Date(ts).getUTCHours();
	}
}

function dayKey(tz) {
	try {
		return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()).replace(/-/g, '');
	} catch (err) {
		return new Date().toISOString().slice(0, 10).replace(/-/g, '');
	}
}

function isQuietHour(cfg, h) {
	const s = cfg.autoReplyQuietStart;
	const e = cfg.autoReplyQuietEnd;
	if (s === e) {
		return false;
	}
	return s < e ? (h >= s && h < e) : (h >= s || h < e);
}

function inQuiet(cfg) {
	return isQuietHour(cfg, hourAt(cfg.autoReplyTimezone, Date.now()));
}

/** 延迟：min~max 分钟内随机（偏向较短）；落在静默时段则顺延到静默结束后，再随机错开 0-60 分钟 */
function computeDue(cfg) {
	const min = Math.max(0, cfg.autoReplyDelayMin);
	const max = Math.max(min, cfg.autoReplyDelayMax);
	let due = Date.now() + (min + (max - min) * (Math.random() ** 1.6)) * 60 * 1000;
	let shifted = false;
	for (let i = 0; i < 96 && isQuietHour(cfg, hourAt(cfg.autoReplyTimezone, due)); i++) {
		due += 15 * 60 * 1000;
		shifted = true;
	}
	if (shifted) {
		due += Math.random() * 60 * 60 * 1000;
	}
	return Math.round(due);
}

function personaFor(uid, cfg) {
	const idx = cfg.autoReplyBotUids.indexOf(Number(uid));
	return PERSONAS[(idx >= 0 ? idx : Number(uid)) % PERSONAS.length];
}

async function todayCount(cfg) {
	return parseInt(await db.get(COUNT_PREFIX + dayKey(cfg.autoReplyTimezone)), 10) || 0;
}

async function bumpCount(cfg) {
	const key = COUNT_PREFIX + dayKey(cfg.autoReplyTimezone);
	await db.increment(key);
	await db.pexpire(key, 3 * 24 * 3600 * 1000);
}

/* ---------------- 判定 ---------------- */

/**
 * @returns {Promise<{ok:boolean, reason?:string, kind?:'topic'|'reply', toPid?:number, botUid?:number}>}
 */
async function evaluate(post, cfg) {
	const topics = require.main.require('./src/topics');
	const posts = require.main.require('./src/posts');
	const bots = cfg.autoReplyBotUids;
	const authorUid = parseInt(post.uid, 10);

	if (!cfg.enableAutoReply || !bots.length) {
		return { ok: false, reason: '未启用或未配置机器人账号' };
	}
	if (!authorUid || bots.includes(authorUid)) {
		return { ok: false, reason: '机器人/游客发的帖不触发' };
	}
	if (post._activitypub) {
		return { ok: false, reason: '联邦帖' };
	}
	const topic = await topics.getTopicFields(post.tid, ['tid', 'cid', 'title', 'locked', 'deleted']);
	if (!topic || !topic.tid || Number(topic.deleted) || Number(topic.locked)) {
		return { ok: false, reason: '主题不可回复' };
	}
	if (cfg.autoReplyCategories.length && !cfg.autoReplyCategories.includes(String(topic.cid))) {
		return { ok: false, reason: '不在版块白名单' };
	}
	if (SKIP_TITLE.test(topic.title || '')) {
		return { ok: false, reason: '测试/站务帖' };
	}

	const pids = await db.getSortedSetRange(`tid:${post.tid}:posts`, 0, -1);
	const owners = pids.length ? await posts.getPostsFields(pids, ['pid', 'uid']) : [];
	const botPosts = owners.filter((p) => p && bots.includes(parseInt(p.uid, 10)));
	if (botPosts.length >= cfg.autoReplyMaxPerTopic) {
		return { ok: false, reason: '本帖机器人回复已达上限' };
	}
	const usedBots = new Set(botPosts.map((p) => parseInt(p.uid, 10)));

	let kind;
	let toPid = 0;
	let botUid = 0;
	if (post.isMain) {
		if (!cfg.autoReplyOnNewTopic) {
			return { ok: false, reason: '未开启回复新主题' };
		}
		kind = 'topic';
	} else {
		if (!cfg.autoReplyOnReply) {
			return { ok: false, reason: '未开启接话' };
		}
		// 只在真人回应了机器人时接话，形成对话而不是刷屏
		const parentUid = post.toPid ? parseInt(await posts.getPostField(post.toPid, 'uid'), 10) : 0;
		if (!bots.includes(parentUid)) {
			return { ok: false, reason: '不是回应机器人的回复' };
		}
		kind = 'reply';
		toPid = parseInt(post.pid, 10);
		botUid = parentUid; // 被回应的那个机器人来接话
	}
	if (!botUid) {
		const fresh = bots.filter((u) => !usedBots.has(u));
		const pool = fresh.length ? fresh : bots;
		botUid = pool[Math.floor(Math.random() * pool.length)];
	}
	return { ok: true, kind, toPid, botUid };
}

/* ---------------- 生成 ---------------- */

async function buildContext(job) {
	const topics = require.main.require('./src/topics');
	const posts = require.main.require('./src/posts');
	const user = require.main.require('./src/user');
	const topic = await topics.getTopicFields(job.tid, ['tid', 'cid', 'title', 'mainPid']);
	const mainPid = Number(topic.mainPid);
	const tail = (await db.getSortedSetRange(`tid:${job.tid}:posts`, -6, -1)).map(Number).filter((p) => p !== mainPid);
	if (job.toPid && !tail.includes(job.toPid)) {
		tail.push(job.toPid);
	}
	const pData = await posts.getPostsFields([mainPid, ...tail], ['pid', 'uid', 'content', 'deleted']);
	const uids = [...new Set(pData.filter(Boolean).map((p) => p.uid))];
	const names = {};
	(await user.getUsersFields(uids, ['uid', 'username'])).forEach((u) => { names[u.uid] = u.username; });
	const main = pData.find((p) => p && Number(p.pid) === mainPid);
	const replies = pData.filter((p) => p && Number(p.pid) !== mainPid && !Number(p.deleted));
	const trigger = (job.kind === 'reply' || job.kind === 'followup') ? replies.find((p) => Number(p.pid) === Number(job.toPid)) : null;
	let related = [];
	try {
		const retrieval = require('./retrieval');
		related = (await retrieval.searchTopics(topic.title, 0, 4, { snippetLen: 80, minRatio: 0.45 }))
			.filter((h) => Number(h.tid) !== Number(job.tid)).slice(0, 2);
	} catch (err) {
		related = [];
	}
	const rawMain = String((main && main.content) || '');
	// 站方转载的资讯：管理员账号发、正文带「阅读全文」外链。楼主不会回复机器人。
	const isRepost = /阅读全文/.test(rawMain) || (main && Number(main.uid) === 1 && /https?:\/\/(www\.)?1234r\.com\/a\//.test(rawMain));
	return {
		isRepost,
		title: topic.title,
		main: tokenizer.cleanContent(main && main.content).slice(0, 1800),
		thread: replies.map((p) => `${names[p.uid] || '网友'}${Number(p.uid) === Number(job.botUid) ? '（你自己）' : ''}：${tokenizer.cleanContent(p.content).slice(0, 220)}`),
		trigger: trigger ? tokenizer.cleanContent(trigger.content).slice(0, 300) : '',
		triggerName: trigger ? (names[trigger.uid] || '有人') : '',
		related,
	};
}

function looksBad(text) {
	const t = String(text || '').trim();
	if (t.length < 12 || t.length > 600) {
		return '长度不合适';
	}
	if (AI_TELLS.test(t)) {
		return '机器腔';
	}
	if (t.length < 40 && BANNED_PHRASES.some((p) => t.toLowerCase().includes(p.toLowerCase()))) {
		return '空洞套话';
	}
	if (/^#{1,6}\s/m.test(t) || /^\s*[-*]\s.+\n\s*[-*]\s/m.test(t)) {
		return '格式化列表';
	}
	return '';
}

async function generate(job, cfg) {
	const ctx = await buildContext(job);
	const persona = personaFor(job.botUid, cfg);
	const custom = String(cfg.autoReplyPrompt || '').trim();
	const relatedText = ctx.related.length
		? `站内相关帖子（可以自然地提一句“之前论坛里有篇讲 xx 的”，不要贴链接；不相关就别提）：\n${ctx.related.map((r) => `- 《${r.title}》：${r.snippet}`).join('\n')}`
		: '';
	let task = '你刚看到这个帖子，写一条跟帖。';
	if (job.kind === 'reply') {
		task = `${ctx.triggerName}回应了你：“${ctx.trigger}”。接着这段对话回一句，针对对方说的具体内容。`;
	} else if (job.kind === 'followup') {
		task = `楼上${ctx.triggerName}刚说：“${ctx.trigger}”。你是另一位网友，可以接他的话（赞同并补充、提出不同看法或追问他一个细节），也可以从帖子里另一个没人提到的点切入。不要重复楼上已经说过的内容。`;
	}

	const system = [
		`你在“R论坛”（智能家居、AI、建筑自动化、家庭影院方向）用论坛账号发帖。你的风格：${persona.name}——${persona.style}。`,
		custom ? `站长补充要求：${custom}` : '',
		'要求：',
		'1. 必须针对帖子里的具体内容（某个观点、数据、产品或做法）回应，不要泛泛夸奖或复述标题。',
		'2. 提供一点增量：经验、补充、反例、注意事项或一个具体问题，任选其一。',
		`3. 口语化中文，${persona.len}，不分点、不加标题、不用 Markdown，不贴链接。`,
		'4. 不要编造具体价格、型号参数或新闻；拿不准就说“印象中”或改成提问。',
		'5. 不要每条都用提问结尾；只有确实想知道答案时才问。不要硬扯 Home Assistant 或“我最近在折腾…”，除非和帖子直接相关。',
		ctx.isRepost ? '6. 这是站方转载的资讯，楼主是站方账号、不会回复你：针对资讯内容本身发表看法或补充；如果要提问，问其他网友（如“有人实际用过吗”），不要追问楼主的个人情况、预算或打算。' : '',
		'7. 内容空洞、广告、或实在没什么可补充时，只输出 SKIP。',
		'只输出跟帖正文。',
	].filter(Boolean).join('\n');

	const userMsg = [
		`帖子标题：${ctx.title}`,
		`主帖：${ctx.main || '（无正文）'}`,
		ctx.thread.length ? `楼内已有回复：\n${ctx.thread.join('\n')}` : '楼内还没有回复。',
		relatedText,
		task,
	].filter(Boolean).join('\n\n');

	let reject = '';
	for (let attempt = 0; attempt < 2; attempt++) {
		// eslint-disable-next-line no-await-in-loop
		const out = await llm.chatCompletions({
			baseUrl: cfg.baseUrl,
			apiKey: cfg.apiKey,
			model: cfg.model,
			messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
			temperature: 0.85,
			maxTokens: 400,
			timeoutMs: 40000,
		});
		const text = String(out || '').replace(/^["“「]|["”」]$/g, '').trim();
		if (/^SKIP\b/i.test(text)) {
			return { skip: true, reason: '模型判断无可补充' };
		}
		reject = looksBad(text);
		if (!reject) {
			return { text };
		}
	}
	return { skip: true, reason: `生成质量不合格（${reject}）` };
}

/* ---------------- 队列 ---------------- */

async function enqueue(job, dueAt) {
	const id = String(job.triggerPid);
	await db.setObject(JOB_PREFIX + id, Object.assign({}, job, { dueAt, attempts: 0 }));
	await db.sortedSetAdd(QUEUE_KEY, dueAt, id);
	return id;
}

async function finish(id) {
	await db.sortedSetRemove(QUEUE_KEY, id);
	await db.delete(JOB_PREFIX + id);
}

async function runJob(id, cfg) {
	const topics = require.main.require('./src/topics');
	const posts = require.main.require('./src/posts');
	const job = await db.getObject(JOB_PREFIX + id);
	if (!job || !job.tid) {
		return finish(id);
	}
	['tid', 'botUid', 'toPid', 'triggerPid', 'attempts'].forEach((k) => { job[k] = parseInt(job[k], 10) || 0; });

	if (!cfg.enableAutoReply) {
		return finish(id);
	}
	if (inQuiet(cfg)) {
		return db.sortedSetAdd(QUEUE_KEY, computeDue(cfg), id);
	}
	if (await todayCount(cfg) >= cfg.autoReplyDailyLimit) {
		return db.sortedSetAdd(QUEUE_KEY, Date.now() + 3 * 3600 * 1000, id);
	}
	// 执行前复查：期间可能被删除/锁定，或机器人已回够
	const trig = await posts.getPostFields(job.triggerPid, ['uid', 'toPid', 'deleted']);
	if (!trig || !trig.uid || Number(trig.deleted)) {
		return finish(id);
	}
	const recheck = job.kind === 'followup' ? await recheckFollowup(job, cfg) : await evaluate({
		pid: job.triggerPid,
		tid: job.tid,
		uid: trig.uid,
		isMain: job.kind === 'topic',
		toPid: trig.toPid,
	}, cfg).catch((err) => ({ ok: false, reason: err.message }));
	if (!recheck.ok) {
		console.log(`[ai-assistant/autoreply] 取消 tid=${job.tid}：${recheck.reason}`);
		return finish(id);
	}
	try {
		const res = await generate(job, cfg);
		if (res.skip) {
			console.log(`[ai-assistant/autoreply] 跳过 tid=${job.tid}：${res.reason}`);
			return finish(id);
		}
		const payload = { tid: job.tid, uid: job.botUid, content: res.text };
		if (job.kind === 'reply' && job.toPid) {
			payload.toPid = job.toPid;
		}
		const postData = await topics.reply(payload);
		await bumpCount(cfg);
		console.log(`[ai-assistant/autoreply] 已回帖 tid=${job.tid} pid=${postData && postData.pid} uid=${job.botUid}`);
		await finish(id);
		if (job.kind === 'topic' && postData && postData.pid) {
			await maybeFollowup(job, postData.pid, cfg);
		}
		return;
	} catch (err) {
		const attempts = job.attempts + 1;
		console.error(`[ai-assistant/autoreply] 失败 tid=${job.tid}（第 ${attempts} 次）：${err.message}`);
		if (attempts >= MAX_ATTEMPTS) {
			return finish(id);
		}
		await db.setObjectField(JOB_PREFIX + id, 'attempts', attempts);
		return db.sortedSetAdd(QUEUE_KEY, Date.now() + attempts * 20 * 60 * 1000, id);
	}
}

/**
 * 首条跟帖发出后，按概率安排另一个人设在 15–120 分钟后接话，让帖子有来有回。
 * 只对新主题的首条跟帖触发；不会连锁（接话后不再安排下一条）。
 */
async function maybeFollowup(job, botPid, cfg) {
	try {
		if (!(Math.random() * 100 < cfg.autoReplyFollowupRate)) {
			return;
		}
		const others = cfg.autoReplyBotUids.filter((u) => u !== job.botUid);
		if (!others.length) {
			return;
		}
		const botUid = others[Math.floor(Math.random() * others.length)];
		let due = Date.now() + (15 + Math.random() * 105) * 60 * 1000;
		for (let i = 0; i < 96 && isQuietHour(cfg, hourAt(cfg.autoReplyTimezone, due)); i++) {
			due += 15 * 60 * 1000;
		}
		const id = `f${botPid}`;
		await db.setObject(JOB_PREFIX + id, { tid: job.tid, triggerPid: botPid, kind: 'followup', toPid: botPid, botUid, dueAt: Math.round(due), attempts: 0 });
		await db.sortedSetAdd(QUEUE_KEY, Math.round(due), id);
		console.log(`[ai-assistant/autoreply] 已安排接话 tid=${job.tid} uid=${botUid}，约 ${Math.round((due - Date.now()) / 60000)} 分钟后`);
	} catch (err) {
		console.error('[ai-assistant/autoreply] 安排接话失败:', err.message);
	}
}

async function recheckFollowup(job, cfg) {
	const topics = require.main.require('./src/topics');
	const posts = require.main.require('./src/posts');
	const topic = await topics.getTopicFields(job.tid, ['tid', 'cid', 'locked', 'deleted']);
	if (!topic || !topic.tid || Number(topic.deleted) || Number(topic.locked)) {
		return { ok: false, reason: '主题不可回复' };
	}
	if (cfg.autoReplyCategories.length && !cfg.autoReplyCategories.includes(String(topic.cid))) {
		return { ok: false, reason: '不在版块白名单' };
	}
	const pids = await db.getSortedSetRange(`tid:${job.tid}:posts`, 0, -1);
	const owners = pids.length ? await posts.getPostsFields(pids, ['uid']) : [];
	const botCount = owners.filter((p) => p && cfg.autoReplyBotUids.includes(parseInt(p.uid, 10))).length;
	if (botCount >= cfg.autoReplyMaxPerTopic) {
		return { ok: false, reason: '本帖机器人回复已达上限' };
	}
	return { ok: true };
}

async function poll() {
	if (polling) {
		return;
	}
	polling = true;
	try {
		const cfg = await settings.get();
		if (!cfg.apiKey) {
			return;
		}
		const due = await db.getSortedSetRangeByScore(QUEUE_KEY, 0, 3, '-inf', Date.now());
		for (const id of due) {
			// eslint-disable-next-line no-await-in-loop
			await runJob(id, cfg);
		}
	} catch (err) {
		console.error('[ai-assistant/autoreply] 轮询异常:', err.message);
	} finally {
		polling = false;
	}
}

/** 只在主进程启动轮询，避免多进程重复发帖 */
function start() {
	const primary = nconf.get('isPrimary');
	if (timer || (primary !== undefined && primary !== true && primary !== 'true')) {
		return;
	}
	timer = setInterval(poll, POLL_MS);
	setTimeout(poll, 20 * 1000);
}

/* ---------------- hook ---------------- */

async function onPostSave(hookData) {
	try {
		const post = (hookData && hookData.post) || hookData;
		if (!post || !post.pid || !post.tid) {
			return;
		}
		const cfg = await settings.get();
		if (!cfg.enableAutoReply || !cfg.apiKey) {
			return;
		}
		const doneKey = DONE_PREFIX + post.pid;
		if (await db.exists(doneKey)) {
			return;
		}
		const verdict = await evaluate(post, cfg);
		if (!verdict.ok) {
			return;
		}
		await db.set(doneKey, '1');
		await db.pexpire(doneKey, 30 * 24 * 3600 * 1000);
		const dueAt = computeDue(cfg);
		await enqueue({
			tid: post.tid,
			triggerPid: post.pid,
			kind: verdict.kind,
			toPid: verdict.toPid || 0,
			botUid: verdict.botUid,
		}, dueAt);
		console.log(`[ai-assistant/autoreply] 已排队 tid=${post.tid} uid=${verdict.botUid}，约 ${Math.round((dueAt - Date.now()) / 60000)} 分钟后`);
	} catch (err) {
		console.error('[ai-assistant/autoreply] hook 异常:', err.message);
	}
}

/** 运维：查看队列与今日计数 */
async function status() {
	const cfg = await settings.get();
	return {
		enabled: cfg.enableAutoReply,
		bots: cfg.autoReplyBotUids,
		today: await todayCount(cfg),
		limit: cfg.autoReplyDailyLimit,
		queue: await db.getSortedSetRangeWithScores(QUEUE_KEY, 0, 50),
	};
}

module.exports = { onPostSave, start, poll, status, evaluate, generate, looksBad, computeDue, inQuiet };
