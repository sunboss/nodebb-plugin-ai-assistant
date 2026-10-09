'use strict';

/**
 * OpenAI 兼容接口客户端（Node 18+ 原生 fetch，零依赖）
 * 默认指向算力中转站 https://api.1234r.com/v1
 */

async function chatCompletions({
	baseUrl, apiKey, model, messages, temperature = 0.3, maxTokens = 1200, timeoutMs = 45000,
}) {
	if (!apiKey) {
		const err = new Error('AI 服务未配置（缺少 API Key）');
		err.status = 503;
		throw err;
	}
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages,
				temperature,
				max_tokens: maxTokens,
			}),
			signal: ctrl.signal,
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			const err = new Error(`模型请求失败（${res.status}）`);
			// 401/403 是 Key 问题，429/5xx 是上游问题，都转成 502/503 避免泄露细节
			err.status = res.status === 401 || res.status === 403 ? 503 : 502;
			err.detail = text.slice(0, 200);
			throw err;
		}
		const data = await res.json();
		const content = data && data.choices && data.choices[0] &&
			data.choices[0].message && data.choices[0].message.content;
		if (!content || !String(content).trim()) {
			const err = new Error('模型返回为空');
			err.status = 502;
			throw err;
		}
		return String(content).trim();
	} catch (err) {
		if (err.name === 'AbortError') {
			const timeoutErr = new Error('模型请求超时，请重试');
			timeoutErr.status = 504;
			throw timeoutErr;
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

/** 从 LLM 输出中提取 JSON（容忍 ```json 包裹） */
function extractJson(text) {
	const cleaned = String(text || '').replace(/```json|```/g, '').trim();
	const start = cleaned.indexOf('[');
	const end = cleaned.lastIndexOf(']');
	if (start === -1 || end === -1 || end <= start) {
		throw new Error('JSON parse failed');
	}
	return JSON.parse(cleaned.slice(start, end + 1));
}

module.exports = { chatCompletions, extractJson };
