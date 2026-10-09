'use strict';

/**
 * AI 自动回帖（拟人化版）
 *
 * 目标：让回帖完全看不出是机器人。
 *
 * 拟人策略：
 *  1. 选择性回复：不是每帖都回，AI 先判断"感不感兴趣"（概率 40-70%）
 *  2. 多人格轮换：5 种不同性格，随机切换，避免千篇一律
 *  3. 时间感知：深夜（0-6点）大幅降低回复概率，符合真人作息
 *  4. 延迟自然化：有时秒回（看到就回），有时几小时后（忙完才看）
 *  5. 回复长度随机：短则一句话，长则分段讨论
 *  6. 已有热帖不掺和：回帖数 >5 的帖子大概率跳过
 *  7. 偶尔追问：不只给答案，也会反问楼主，形成对话
 *  8. 口语化：用"哈哈"、"确实"、"我之前也遇到过"等人话
 *  9. 绝不暴露：不用列表式回答，不说"作为AI"，不用过于工整的结构
 */

const settings = require('./settings');
const llm = require('./llm');

// 每日计数
let dailyCount = 0;
let dailyDate = new Date().toDateString();

// 人格库：5 种性格轮换
const PERSONAS = [
	{
		name: '热心老哥',
		style: '说话直接，喜欢分享经验，常用"我之前..."开头，偶尔用"哈哈"',
		example: '我之前也遇到过这个问题，折腾了一下午，最后发现是驱动没装对。你先看看设备管理器有没有黄色感叹号。',
	},
	{
		name: '技术宅',
		style: '说话简洁，喜欢一针见血，偶尔丢个命令行或配置片段，不说废话',
		example: '试试这个：sudo apt update && sudo apt install -y xxx，应该能解决。',
	},
	{
		name: '好奇宝宝',
		style: '喜欢追问细节，"具体是什么报错？"、"你用的是哪个版本？"，通过提问推进讨论',
		example: '具体是什么报错呀？贴一下日志看看，还有你用的是哪个版本？',
	},
	{
		name: '潜水党',
		style: '话少，偶尔冒泡，回复很短但有用，不说客套话',
		example: '+1，我也是这么解决的。',
	},
	{
		name: '话痨',
		style: '话多，喜欢展开讲，会分段，有自己的观点，偶尔跑题但会拉回来',
		example: '这个我太有感触了！之前我们公司也搞过类似的，当时踩了好多坑。首先你得确认需求，其次是选型...\n\n不过话说回来，你这个场景可能更简单，先试试基础方案。',
	},
];

function resetDailyIfNeeded() {
	const today = new Date().toDateString();
	if (today !== dailyDate) {
		dailyDate = today;
		dailyCount = 0;
	}
}

function stripHtml(html) {
	return String(html || '')
		.replace(/<[^>]*>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function pickPersona() {
	return PERSONAS[Math.floor(Math.random() * PERSONAS.length)];
}

function isDeepNight() {
	const hour = new Date().getHours();
	return hour >= 0 && hour < 6;
}

/**
 * AI 判断：这帖子值得回吗？
 * 返回 { should: boolean, reason: string }
 */
async function assessInterest(title, text, cfg) {
	// 快速规则先过滤
	if (text.length < 10) {
		return { should: false, reason: '内容太短' };
	}
	// 广告/灌水关键词
	const spamWords = ['加微信', '兼职', '刷单', '代购', '贷款', '办证'];
	if (spamWords.some((w) => text.includes(w) || title.includes(w))) {
		return { should: false, reason: '疑似广告' };
	}

	// AI 判断兴趣度
	try {
		const answer = await llm.chatCompletions({
			baseUrl: cfg.baseUrl,
			apiKey: cfg.apiKey,
			model: cfg.model,
			messages: [
				{
					role: 'system',
					content:
						'你是一个论坛老用户，判断要不要回复一个帖子。' +
						'只返回 JSON：{"interest": 0-100, "reason": "一句话理由"}。' +
						'interest > 50 才值得回。' +
						'有实质讨论价值的给高分，纯水帖、重复问题、广告给低分。',
				},
				{ role: 'user', content: `标题：${title}\n内容：${text.slice(0, 500)}` },
			],
			temperature: 0.5,
		});
		const parsed = JSON.parse(answer.match(/\{[^}]+\}/)?.[0] || '{}');
		const interest = parseInt(parsed.interest, 10) || 0;
		// 深夜降权
		const threshold = isDeepNight() ? 75 : 50;
		return { should: interest > threshold, reason: parsed.reason || '' };
	} catch (err) {
		// AI 判断失败时，50% 概率回（保守策略）
		return { should: Math.random() < 0.5, reason: '判断失败，随机' };
	}
}

async function shouldReply(postData, cfg) {
	if (!cfg.enableAutoReply || !cfg.autoReplyBotUid) {
		return false;
	}
	if (postData.uid === cfg.autoReplyBotUid) {
		return false; // 自己不回自己
	}
	resetDailyIfNeeded();
	if (dailyCount >= cfg.autoReplyDailyLimit) {
		return false;
	}
	// 版块白名单
	if (cfg.autoReplyCategories.length > 0) {
		const topics = require.main.require('./src/topics');
		try {
			const cid = await topics.getTopicField(postData.tid, 'cid');
			if (!cfg.autoReplyCategories.includes(String(cid))) {
				return false;
			}
		} catch (err) {
			return false;
		}
	}
	// 只回主帖和第一层
	if (postData.isMainPost) {
		if (!cfg.autoReplyOnNewTopic) return false;
	} else {
		if (!cfg.autoReplyOnReply) return false;
		const posts = require.main.require('./src/posts');
		try {
			const parent = await posts.getPostData(postData.toPid || 0);
			if (!parent || !parent.isMainPost) return false;
		} catch (err) {
			return false;
		}
	}
	// 热帖不掺和：已有回帖 >5 跳过（70% 概率）
	if (postData.isMainPost) {
		const topics = require.main.require('./src/topics');
		try {
			const replyCount = await topics.getTopicField(postData.tid, 'postcount');
			if (parseInt(replyCount, 10) > 6 && Math.random() < 0.7) {
				return false;
			}
		} catch (err) {
			// 忽略
		}
	}
	return true;
}

async function generateReply(postData, cfg) {
	const text = stripHtml(postData.content).slice(0, 1000);
	const topics = require.main.require('./src/topics');
	let title = '';
	try {
		title = await topics.getTopicField(postData.tid, 'title');
	} catch (err) {
		title = '';
	}

	// 1. 先判断兴趣
	const { should, reason } = await assessInterest(title, text, cfg);
	if (!should) {
		console.log(`[ai-assistant] 跳过回帖（${reason}）: ${title.slice(0, 30)}`);
		return null;
	}

	// 2. 随机选人格
	const persona = pickPersona();

	// 3. 随机决定回复风格
	const styles = [
		'简短回复，一两句话',
		'中等长度，分 2-3 句说清楚',
		'详细回复，可以分段，分享经验',
		'追问式回复，先问清楚细节再给建议',
	];
	const style = styles[Math.floor(Math.random() * styles.length)];

	// 4. 随机决定是否带表情（30% 概率）
	const useEmoji = Math.random() < 0.3;

	const systemPrompt =
		`你是论坛里的"${persona.name}"，${persona.style}。\n` +
		`说话风格参考：${persona.example}\n\n` +
		`本次回复要求：${style}。${useEmoji ? '可以适当用 1-2 个表情。' : '不要用表情。'}\n\n` +
		`铁律：\n` +
		`1. 绝对不说"我是AI"、"作为AI"这类话，你就是个普通网友\n` +
		`2. 不要用"首先、其次、最后"这种工整结构，真人不这么说话\n` +
		`3. 不要每次都"感谢分享"，太假了\n` +
		`4. 可以有口头禅、语气词，像真人打字\n` +
		`5. 回复要有实质内容，不要水\n` +
		`6. 如果是提问帖，尽量给有用的建议或追问关键信息`;

	const messages = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: `帖子标题：${title}\n帖子内容：${text}\n\n你是"${persona.name}"，自然地回复：` },
	];

	const answer = await llm.chatCompletions({
		baseUrl: cfg.baseUrl,
		apiKey: cfg.apiKey,
		model: cfg.model,
		messages,
		temperature: 0.9, // 高温度，更有人味
	});
	return answer.trim();
}

/**
 * 自然延迟：模拟真人上线时间
 * - 30% 概率：1-5 分钟内（正好在线）
 * - 50% 概率：10-60 分钟（过会儿看到）
 * - 20% 概率：1-4 小时（忙完才看）
 * - 深夜：延迟到早上 8-9 点
 */
function naturalDelay() {
	if (isDeepNight()) {
		// 延迟到早上 8 点
		const now = new Date();
		const morning = new Date(now);
		morning.setHours(8, Math.floor(Math.random() * 60), 0, 0);
		if (morning <= now) {
			morning.setDate(morning.getDate() + 1);
		}
		return morning - now;
	}
	const r = Math.random();
	if (r < 0.3) {
		return (1 + Math.random() * 4) * 60 * 1000; // 1-5 分钟
	} else if (r < 0.8) {
		return (10 + Math.random() * 50) * 60 * 1000; // 10-60 分钟
	}
	return (1 + Math.random() * 3) * 60 * 60 * 1000; // 1-4 小时
}

async function doReply(postData, cfg) {
	const posts = require.main.require('./src/posts');
	const answer = await generateReply(postData, cfg);
	if (!answer) {
		return; // AI 决定不回
	}
	await posts.reply(
		{
			tid: postData.tid,
			toPid: postData.pid,
			uid: cfg.autoReplyBotUid,
			content: answer,
		},
		cfg.autoReplyBotUid
	);
	dailyCount++;
	console.log(`[ai-assistant] 自动回帖成功: tid=${postData.tid}`);
}

async function onPostSave(postData) {
	try {
		const post = postData.post || postData;
		if (!post || !post.pid) {
			return;
		}
		const cfg = await settings.get();
		if (!cfg.apiKey) {
			return;
		}
		if (!(await shouldReply(post, cfg))) {
			return;
		}
		// 自然延迟
		const delayMs = naturalDelay();
		console.log(`[ai-assistant] 计划回帖: tid=${post.tid}, 延迟 ${Math.round(delayMs / 60000)} 分钟`);
		setTimeout(() => {
			doReply(post, cfg).catch((err) => {
				console.error('[ai-assistant] 自动回帖失败:', err.message);
			});
		}, delayMs);
	} catch (err) {
		console.error('[ai-assistant] 自动回帖 hook 异常:', err.message);
	}
}

module.exports = { onPostSave };
