'use strict';

/**
 * 按 IP 滑动窗口限流（内存实现，默认 20 次/分钟）
 * Traefik 后面时优先取 X-Forwarded-For 的第一个 IP。
 */

const buckets = new Map(); // ip -> number[] (timestamps ms)
const WINDOW_MS = 60 * 1000;

function getIp(req) {
	const xff = req.headers && req.headers['x-forwarded-for'];
	if (xff) {
		return String(xff).split(',')[0].trim();
	}
	return (req.ip || (req.connection && req.connection.remoteAddress) || 'unknown').toString();
}

/** @returns {boolean} true=放行，false=超限 */
function hit(ip, limit) {
	const now = Date.now();
	const max = Math.max(1, parseInt(limit, 10) || 20);
	let arr = buckets.get(ip);
	if (!arr) {
		arr = [];
		buckets.set(ip, arr);
	}
	while (arr.length && now - arr[0] > WINDOW_MS) {
		arr.shift();
	}
	if (arr.length >= max) {
		return false;
	}
	arr.push(now);
	// 顺手清理长期不用的 bucket，防止内存膨胀
	if (buckets.size > 5000) {
		for (const [k, v] of buckets) {
			if (!v.length || now - v[v.length - 1] > WINDOW_MS * 10) {
				buckets.delete(k);
			}
		}
	}
	return true;
}

function destroy() {
	buckets.clear();
}

module.exports = { getIp, hit, destroy };
