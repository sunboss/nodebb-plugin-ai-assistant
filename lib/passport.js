'use strict';

/**
 * 通行证（rpass, auth.1234r.com）无感登录增强
 *
 * 依赖 nodebb-plugin-sso-oauth2-multiple 注册的策略（默认名 rpass），在其之上做三件事：
 *  1. 用户名：优先用通行证昵称；不合法时依次退回邮箱前缀、「手机用户+尾号」、「R友+随机」。
 *     只绑手机、没有邮箱的通行证用户补一个占位邮箱，避免插件报 insufficient-scope。
 *  2. 登录后回到原页面（插件默认总是回首页）。
 *  3. 退出论坛时同时退出通行证（带 id_token_hint，不弹确认页），然后回到论坛首页。
 *  4. PKCE (S256)：自己生成 code_verifier 存进会话，授权时带 code_challenge，换 token 时带 code_verifier。
 *     不用插件自带的 usePkce，因为它会关掉 NodeBB 核心的 state 校验。
 *
 * 「点登录直接跳通行证」不靠代码：收回 registered-users 的 local:login 并关闭论坛自带注册后，
 * NodeBB 只剩一个登录方式时会自动跳转。管理员备用入口：/login?local=1
 */

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const winston = require.main.require('winston');
const passport = require.main.require('passport');
const utils = require.main.require('./src/utils');
const slugify = require.main.require('./src/slugify');
const meta = require.main.require('./src/meta');
const helpers = require.main.require('./src/controllers/helpers');

const STRATEGY = 'rpass';
const ISSUER = 'https://auth.1234r.com';
const PLACEHOLDER_DOMAIN = 'phone.bbs.1234r.com';
const als = new AsyncLocalStorage();

function maxLen() {
	return parseInt(meta.config.maximumUsernameLength, 10) || 16;
}
function minLen() {
	return parseInt(meta.config.minimumUsernameLength, 10) || 2;
}

function clean(name) {
	if (!name || typeof name !== 'string') {
		return '';
	}
	let s = name.normalize('NFKC').replace(/[\s\u3000]+/g, ' ').trim();
	if (s.includes('@')) {
		s = s.split('@')[0];
	}
	// 只保留 NodeBB 认可的字符，逐字过滤
	s = Array.from(s).filter(ch => utils.isUserNameValid(`a${ch}a`)).join('').trim();
	s = Array.from(s).slice(0, maxLen()).join('').trim();
	if (Array.from(s).length < minLen()) {
		return '';
	}
	if (!utils.isUserNameValid(s) || !utils.isSlugValid(slugify(s))) {
		return '';
	}
	// rpass 自动生成的 u_xxxxxxxx 不是人起的名字
	if (/^u_[0-9a-f]{6,}$/i.test(s)) {
		return '';
	}
	return s;
}

function pickUsername(raw, profile) {
	const phone = String(raw.phone_number || '').replace(/\D/g, '');
	const candidates = [
		raw.name,
		raw.displayName,
		raw.nickname,
		raw.preferred_username,
		raw.email,
		phone.length >= 4 ? `手机用户${phone.slice(-4)}` : '',
	];
	for (const c of candidates) {
		const ok = clean(c);
		if (ok) {
			return ok;
		}
	}
	const seed = String(profile.id || Date.now()).replace(/[^0-9a-z]/gi, '').slice(-6);
	return `R友${seed}`;
}

// 把插件解析出的 profile 改成适合论坛的样子
function normalizeProfile(profile, raw) {
	profile.displayName = pickUsername(raw, profile);
	if (!profile.fullname && raw.name) {
		profile.fullname = raw.name;
	}
	if (!profile.email) {
		profile.email = `${String(profile.id).replace(/[^0-9a-zA-Z_-]/g, '')}@${PLACEHOLDER_DOMAIN}`;
		profile.email_verified = false;
	}
	return profile;
}

function wrapStrategy() {
	// eslint-disable-next-line no-underscore-dangle
	const strategy = passport._strategy(STRATEGY);
	if (!strategy || strategy.__rAiWrapped) {
		return !!strategy;
	}

	const origProfile = strategy.userProfile.bind(strategy);
	strategy.userProfile = function (accessToken, done) {
		// 先取原始 userinfo，再交给插件解析，最后按论坛规则修正
		// eslint-disable-next-line no-underscore-dangle
		strategy._oauth2._useAuthorizationHeaderForGET = true;
		// eslint-disable-next-line no-underscore-dangle
		strategy._oauth2.get(`${ISSUER}/api/userinfo`, accessToken, (err, body) => {
			let raw = {};
			if (!err) {
				try {
					raw = JSON.parse(body);
				} catch (e) {
					raw = {};
				}
			}
			origProfile(accessToken, (err2, profile) => {
				if (err2 || !profile) {
					return done(err2, profile);
				}
				try {
					done(null, normalizeProfile(profile, raw));
				} catch (e) {
					done(e);
				}
			});
		});
	};

	// 记下 id_token，退出时作为 id_token_hint，通行证就不会再弹确认页
	// eslint-disable-next-line no-underscore-dangle
	const oauth2 = strategy._oauth2;
	const origToken = oauth2.getOAuthAccessToken.bind(oauth2);
	oauth2.getOAuthAccessToken = function (code, params, callback) {
		const st = als.getStore();
		if (st && st.codeVerifier) {
			params = { ...params, code_verifier: st.codeVerifier };
		}
		origToken(code, params, (err, accessToken, refreshToken, results) => {
			const store = als.getStore();
			if (!err && store && results && results.id_token) {
				store.idToken = results.id_token;
			}
			callback(err, accessToken, refreshToken, results);
		});
	};

	// PKCE：授权地址带上 code_challenge（由 filter:auth.options 放进 opts）
	const origAuthParams = strategy.authorizationParams.bind(strategy);
	strategy.authorizationParams = function (options) {
		const p = origAuthParams(options) || {};
		if (options && options.rpassCodeChallenge) {
			p.code_challenge = options.rpassCodeChallenge;
			p.code_challenge_method = 'S256';
		}
		return p;
	};

	// NodeBB 核心把自己生成的 ssoState 作为字符串 state 传给 passport，passport 因此不在会话里存 state；
	// 但插件配置了 state:true，回调时 passport 又去会话里找，永远找不到 → "Unable to verify authorization request state"，
	// 登录码从未被兑换，用户始终未登录。核心已在回调前校验 req.query.state === req.session.ssoState，
	// 所以这里把 passport 的重复校验换成空实现（与 passport-oauth2 自带 NullStore 相同）。
	// eslint-disable-next-line no-underscore-dangle
	strategy._stateStore = {
		store(req, ...args) { args[args.length - 1](); },
		verify(req, providedState, cb) { cb(null, true); },
	};

	strategy.__rAiWrapped = true;
	winston.info('[ai-assistant/passport] rpass strategy wrapped (profile, id_token, state store, pkce)');
	return true;
}

// filter:auth.init（优先级低于 SSO 插件，确保策略已注册）
exports.authInit = async function (strategies) {
	try {
		wrapStrategy();
	} catch (e) {
		winston.warn(`[ai-assistant/passport] wrap strategy failed: ${e.message}`);
	}
	return strategies;
};

function b64url(buf) {
	return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// filter:auth.options：只在发起 /auth/rpass 时生成 PKCE
exports.authOptions = async function (data) {
	const { req, opts } = data;
	if (req && req.session && req.path === `/auth/${STRATEGY}`) {
		const verifier = b64url(crypto.randomBytes(32)); // 43 字符
		req.session.rpassPkceVerifier = verifier;
		opts.rpassCodeChallenge = b64url(crypto.createHash('sha256').update(verifier).digest());
	}
	return data;
};

function safePath(p) {
	if (!p || typeof p !== 'string') {
		return '';
	}
	const n = helpers.normalizeReturnToPath(p);
	if (!n || /^\/(login|register|logout|auth\/)/.test(n)) {
		return '';
	}
	return n;
}

exports.routes = function (router) {
	// 回调：登录完成后回到原页面，并把 id_token 存进会话
	router.get(`/auth/${STRATEGY}/callback`, (req, res, next) => {
		const back = safePath(req.session && (req.session.next || req.session.returnTo));
		const store = {};
		if (req.session && req.session.rpassPkceVerifier) {
			store.codeVerifier = req.session.rpassPkceVerifier;
			delete req.session.rpassPkceVerifier; // 一次性
		}
		const origRedirect = res.redirect.bind(res);
		res.redirect = function (...args) {
			if (store.idToken && req.session) {
				req.session.rpassIdToken = store.idToken;
			}
			if (back) {
				const urlIdx = args.length > 1 ? 1 : 0;
				const url = String(args[urlIdx] || '');
				if (url === '/' || url === `${require.main.require('nconf').get('relative_path') || ''}/`) {
					args[urlIdx] = back;
				}
			}
			return origRedirect(...args);
		};
		als.run(store, () => next());
	});

	// 退出：论坛会话结束后，跳去通行证退出，再回到论坛首页
	router.post('/logout', (req, res, next) => {
		const idToken = req.session && req.session.rpassIdToken;
		const isRpassUser = !!idToken;
		if (!isRpassUser) {
			return next();
		}
		const nconf = require.main.require('nconf');
		const home = `${nconf.get('url')}/`;
		// client_id 由通行证从 id_token 的 aud 推出
		const q = new URLSearchParams({ id_token_hint: idToken, post_logout_redirect_uri: home });
		const target = `${ISSUER}/api/logout?${q.toString()}`;

		const origSend = res.send.bind(res);
		res.send = function (body) {
			if (body && typeof body === 'object' && 'next' in body) {
				body.next = target;
			}
			return origSend(body);
		};
		const origRedirect = res.redirect.bind(res);
		res.redirect = function () {
			return origRedirect(302, target);
		};
		next();
	});
};

// 供测试
exports._pickUsername = pickUsername;
exports._normalizeProfile = normalizeProfile;
