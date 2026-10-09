'use strict';

/**
 * 简单的内存 LRU 缓存，带 TTL
 * 用于缓存常见问题的 AI 回答，减少 API 调用成本和延迟
 */

class LRUCache {
	constructor(maxSize = 200, defaultTtlMs = 3600000) {
		this.maxSize = maxSize;
		this.defaultTtlMs = defaultTtlMs;
		this.map = new Map(); // key -> { value, expiresAt }
	}

	_normalizeKey(key) {
		// 归一化：去首尾空格、转小写、压缩多余空白
		return String(key || '').trim().toLowerCase().replace(/\s+/g, ' ');
	}

	get(key) {
		const nkey = this._normalizeKey(key);
		const entry = this.map.get(nkey);
		if (!entry) {
			return null;
		}
		if (Date.now() > entry.expiresAt) {
			this.map.delete(nkey);
			return null;
		}
		// LRU: 访问后移到末尾
		this.map.delete(nkey);
		this.map.set(nkey, entry);
		return entry.value;
	}

	set(key, value, ttlMs) {
		const nkey = this._normalizeKey(key);
		// 如果已存在，先删除（为了更新 LRU 顺序）
		if (this.map.has(nkey)) {
			this.map.delete(nkey);
		}
		// 超出容量时删除最旧的
		while (this.map.size >= this.maxSize) {
			const oldestKey = this.map.keys().next().value;
			this.map.delete(oldestKey);
		}
		this.map.set(nkey, {
			value,
			expiresAt: Date.now() + (ttlMs || this.defaultTtlMs),
		});
	}

	// 只缓存"常见问题"：短问题、问模型身份等
	shouldCache(message) {
		const msg = String(message || '').trim();
		if (!msg || msg.length > 100) {
			return false;
		}
		// 模型身份类问题必缓存
		const identityPatterns = [
			/你是什么模型/,
			/你是谁/,
			/who are you/,
			/what model/,
			/1118/,
		];
		if (identityPatterns.some((p) => p.test(msg))) {
			return true;
		}
		// 短问题（20字以内）缓存
		return msg.length <= 20;
	}

	clear() {
		this.map.clear();
	}

	size() {
		return this.map.size;
	}
}

// 单例
const cache = new LRUCache(200, 3600000);

module.exports = cache;
