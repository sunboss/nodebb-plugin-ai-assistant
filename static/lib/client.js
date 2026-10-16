/* nodebb-plugin-ai-assistant — 前端 widget（v1.2 无感设计）
 *
 * 设计原则：平时“看不见”，需要时“随手可得”。
 * - 入口嵌入主题原生导航：桌面端右侧栏一项、移动端底栏一个图标，与站内其它入口同形同色；
 *   找不到原生锚点时才退回一个半透明小圆点（向下滚动自动隐藏）。
 * - 快捷键 Ctrl/⌘ + J 唤起，Esc 关闭。
 * - 桌面端：右下角停靠面板（无遮罩、不打断阅读），可一键放大；尺寸偏好记在 localStorage。
 * - 移动端：底部抽屉（bottom sheet），避开底栏与输入法。
 * - 写帖子（composer 打开）时自动让位；后台管理页不加载。
 * - 配色跟随 Bootstrap 变量，自动适配亮/暗皮肤。
 */
(function () {
	'use strict';

	var RP = (window.config && window.config.relative_path) || '';
	var API_BASE = RP + '/api/plugins/ai-assistant';
	var STORE_KEY = 'naa:prefs';
	var history = []; // [{role, content}]，最多保留 10 条
	var busy = false;
	var ui = null;

	function esc(s) {
		return String(s || '').replace(/[&<>"']/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}

	function prefs(patch) {
		var p = {};
		try { p = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { /* 隐私模式 */ }
		if (patch) {
			Object.keys(patch).forEach(function (k) { p[k] = patch[k]; });
			try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ }
		}
		return p;
	}

	function isAdminPage() {
		return /^\/admin(\/|$)/.test(location.pathname.slice(RP.length));
	}

	function isMobile() {
		return window.matchMedia('(max-width: 991.98px)').matches; // 与 Harmony lg 断点一致
	}

	function csrf() {
		return (window.config && window.config.csrf_token) || '';
	}

	// 线性单色图标，视觉重量与 FontAwesome 一致，不抢眼
	function sparkle(size) {
		size = size || 16;
		return '<svg class="naa-ico" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
			'stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">' +
			'<path d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z"/>' +
			'<path d="M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/></svg>';
	}

	function icon(path) {
		return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
			'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + path + '"/></svg>';
	}

	/* ---------------- 入口 ---------------- */

	// 桌面端：Harmony 右侧栏，与“登录 / 通知”等同一列表样式
	function mountSidebarEntry() {
		var nav = document.querySelector('[component="sidebar/right"]');
		if (!nav) {
			return false;
		}
		if (nav.querySelector('.naa-entry')) {
			return true;
		}
		var list = nav.querySelector('#logged-in-menu, #logged-out-menu') || nav.querySelector('ul');
		if (!list) {
			return false;
		}
		var li = document.createElement('li');
		li.className = 'nav-item mx-2 naa-entry';
		li.setAttribute('role', 'menuitem');
		li.title = 'AI 助手（Ctrl/⌘ + J）';
		li.innerHTML =
			'<a class="nav-link" href="#" aria-label="AI 助手">' +
			'<span class="d-flex gap-2 align-items-center text-nowrap truncate-open">' +
			'<span class="position-relative">' + sparkle(16) + '</span>' +
			'<span class="nav-text small visible-open fw-semibold">AI 助手</span></span></a>';
		li.querySelector('a').addEventListener('click', function (e) { e.preventDefault(); toggle(); });
		list.appendChild(li);
		return true;
	}

	// 移动端：Harmony 底栏右侧图标组
	function mountBottombarEntry() {
		var right = document.querySelector('.bottombar-nav-right');
		if (!right) {
			return false;
		}
		if (right.querySelector('.naa-entry')) {
			return true;
		}
		var a = document.createElement('a');
		a.href = '#';
		a.className = 'naa-entry btn-ghost-sm p-1 d-flex align-items-center text-reset';
		a.setAttribute('aria-label', 'AI 助手');
		a.innerHTML = sparkle(18);
		a.addEventListener('click', function (e) { e.preventDefault(); toggle(); });
		right.insertBefore(a, right.firstChild);
		return true;
	}

	// 兜底：极简半透明小圆点
	function mountFallbackDot() {
		if (document.getElementById('naa-fab')) {
			return;
		}
		var fab = document.createElement('button');
		fab.id = 'naa-fab';
		fab.type = 'button';
		fab.title = 'AI 助手（Ctrl/⌘ + J）';
		fab.setAttribute('aria-label', '打开 AI 助手');
		fab.innerHTML = sparkle(18);
		fab.addEventListener('click', toggle);
		document.body.appendChild(fab);

		var lastY = window.scrollY;
		var timer = null;
		window.addEventListener('scroll', function () {
			var y = window.scrollY;
			if (y > lastY + 4) {
				fab.classList.add('naa-hide');
			}
			lastY = y;
			clearTimeout(timer);
			timer = setTimeout(function () { fab.classList.remove('naa-hide'); }, 900);
		}, { passive: true });
	}

	function mountEntries() {
		var native = isMobile() ? mountBottombarEntry() : mountSidebarEntry();
		// 另一端也顺手挂上，窗口尺寸变化时无需重绘
		if (isMobile()) { mountSidebarEntry(); } else { mountBottombarEntry(); }
		var fab = document.getElementById('naa-fab');
		if (native) {
			if (fab) { fab.remove(); }
		} else {
			mountFallbackDot();
		}
	}

	/* ---------------- 面板 ---------------- */

	function buildPanel() {
		if (ui) {
			return;
		}
		var panel = document.createElement('section');
		panel.id = 'naa-panel';
		panel.setAttribute('role', 'dialog');
		panel.setAttribute('aria-label', 'AI 助手');
		panel.setAttribute('aria-hidden', 'true');
		panel.innerHTML =
			'<div class="naa-grip" aria-hidden="true"></div>' +
			'<header id="naa-head">' +
			'<div class="naa-title">' + sparkle(16) +
			'<div id="naa-tabs" role="tablist">' +
			'<button type="button" data-tab="chat" class="on" role="tab">问答</button>' +
			'<button type="button" data-tab="search" role="tab">找帖子</button></div></div>' +
			'<div class="naa-actions">' +
			'<button type="button" id="naa-clear" title="清空对话" aria-label="清空对话">' + icon('M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13') + '</button>' +
			'<button type="button" id="naa-size" title="放大 / 还原" aria-label="放大或还原">' + icon('M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7') + '</button>' +
			'<button type="button" id="naa-close" title="关闭（Esc）" aria-label="关闭">' + icon('M6 6l12 12M18 6L6 18') + '</button>' +
			'</div></header>' +
			'<div id="naa-msgs" aria-live="polite"></div>' +
			'<div id="naa-srcs"></div>' +
			'<form id="naa-inputbar" autocomplete="off">' +
			'<textarea id="naa-input" rows="1" maxlength="500" placeholder="问问论坛里的内容…"></textarea>' +
			'<button type="submit" id="naa-send" aria-label="发送">' + icon('M5 12h14M13 6l6 6-6 6') + '</button>' +
			'</form>';
		document.body.appendChild(panel);

		ui = {
			panel: panel,
			msgs: panel.querySelector('#naa-msgs'),
			srcs: panel.querySelector('#naa-srcs'),
			input: panel.querySelector('#naa-input'),
			send: panel.querySelector('#naa-send'),
			mode: 'chat',
		};

		if (prefs().large) {
			panel.classList.add('naa-large');
		}
		showWelcome();

		panel.querySelector('#naa-close').addEventListener('click', close);
		panel.querySelector('#naa-size').addEventListener('click', function () {
			var large = !panel.classList.contains('naa-large');
			panel.classList.toggle('naa-large', large);
			prefs({ large: large });
		});
		panel.querySelector('#naa-clear').addEventListener('click', function () {
			history = [];
			ui.srcs.innerHTML = '';
			showWelcome();
			ui.input.focus();
		});
		panel.querySelectorAll('#naa-tabs button').forEach(function (btn) {
			btn.addEventListener('click', function () {
				panel.querySelectorAll('#naa-tabs button').forEach(function (b) { b.classList.remove('on'); });
				btn.classList.add('on');
				ui.mode = btn.getAttribute('data-tab');
				ui.input.placeholder = ui.mode === 'chat' ? '问问论坛里的内容…' : '描述你想找的帖子…';
				ui.input.focus();
			});
		});

		panel.querySelector('#naa-inputbar').addEventListener('submit', function (e) {
			e.preventDefault();
			send();
		});
		ui.input.addEventListener('keydown', function (e) {
			// Enter 发送，Shift+Enter 换行；中文输入法组字中不发送
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
				e.preventDefault();
				send();
			}
		});
		ui.input.addEventListener('input', autoGrow);

		// 桌面端点击面板外部即收起（不加遮罩）
		document.addEventListener('mousedown', function (e) {
			if (!panel.classList.contains('open') || isMobile()) {
				return;
			}
			if (panel.contains(e.target) || (e.target.closest && e.target.closest('.naa-entry, #naa-fab'))) {
				return;
			}
			close();
		});
	}

	function showWelcome() {
		var tips = ['这个论坛主要聊什么？', '智能家居入门看哪些帖子？', '有哪些 AI 编程工具的讨论？'];
		ui.msgs.innerHTML = '<div class="naa-welcome"><p>基于本站帖子回答，并附上参考来源。</p><div class="naa-chips">' +
			tips.map(function (t) { return '<button type="button" class="naa-chip">' + esc(t) + '</button>'; }).join('') +
			'</div><p class="naa-kbd">Ctrl / ⌘ + J 随时唤起</p></div>';
		ui.msgs.querySelectorAll('.naa-chip').forEach(function (c) {
			c.addEventListener('click', function () {
				ui.input.value = c.textContent;
				send();
			});
		});
	}

	function autoGrow() {
		ui.input.style.height = 'auto';
		ui.input.style.height = Math.min(ui.input.scrollHeight, 120) + 'px';
	}

	function open() {
		buildPanel();
		ui.panel.classList.add('open');
		ui.panel.setAttribute('aria-hidden', 'false');
		document.body.classList.add('naa-open');
		if (!isMobile()) {
			setTimeout(function () { ui.input.focus({ preventScroll: true }); }, 60);
		}
	}

	function close() {
		if (!ui) {
			return;
		}
		ui.panel.classList.remove('open');
		ui.panel.setAttribute('aria-hidden', 'true');
		document.body.classList.remove('naa-open');
	}

	function toggle() {
		if (ui && ui.panel.classList.contains('open')) {
			close();
		} else {
			open();
		}
	}

	/* ---------------- 消息 ---------------- */

	function addMsg(cls, html) {
		var welcome = ui.msgs.querySelector('.naa-welcome');
		if (welcome) {
			welcome.remove();
		}
		var div = document.createElement('div');
		div.className = 'naa-msg ' + cls;
		div.innerHTML = html;
		ui.msgs.appendChild(div);
		ui.msgs.scrollTop = ui.msgs.scrollHeight;
		return div;
	}

	function settle(div, text) {
		div.classList.remove('naa-typing');
		div.textContent = text;
	}

	function renderSources(list) {
		ui.srcs.innerHTML = '';
		if (!list || !list.length) {
			return;
		}
		var title = document.createElement('div');
		title.className = 'naa-src-title';
		title.textContent = '参考帖子';
		ui.srcs.appendChild(title);
		list.forEach(function (s) {
			var a = document.createElement('a');
			a.href = s.url;
			a.textContent = s.title;
			a.title = s.title;
			// 站内链接走 ajaxify 无刷新跳转，面板保持打开（移动端自动收起）
			a.addEventListener('click', function (e) {
				var path = String(s.url || '');
				if (path.indexOf(location.origin) === 0) {
					path = path.slice(location.origin.length);
				}
				if (window.ajaxify && path.charAt(0) === '/') {
					e.preventDefault();
					window.ajaxify.go(path.slice(RP.length).replace(/^\//, ''));
					if (isMobile()) {
						close();
					}
				}
			});
			ui.srcs.appendChild(a);
		});
	}

	async function send() {
		var text = ui.input.value.trim();
		if (!text || busy) {
			return;
		}
		busy = true;
		ui.send.disabled = true;
		ui.input.value = '';
		autoGrow();
		addMsg('naa-user', esc(text));
		var botDiv = addMsg('naa-bot naa-typing', '<span class="naa-dots"><i></i><i></i><i></i></span>');
		try {
			if (ui.mode === 'chat') {
				var res = await fetch(API_BASE + '/chat', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf() },
					body: JSON.stringify({ message: text, history: history, stream: true }),
				});
				if (!res.ok || !res.body) {
					var j = await res.json().catch(function () { return {}; });
					settle(botDiv, j.error || '请求失败，请稍后再试。');
				} else {
					var reader = res.body.getReader();
					var decoder = new TextDecoder();
					var buf = '';
					var fullAnswer = '';
					var sources = null;
					var failed = false;
					while (!failed) {
						var r = await reader.read();
						if (r.done) {
							break;
						}
						buf += decoder.decode(r.value, { stream: true });
						var lines = buf.split('\n');
						buf = lines.pop();
						for (var i = 0; i < lines.length; i++) {
							var line = lines[i].trim();
							if (!line || line.indexOf('data:') !== 0) {
								continue;
							}
							try {
								var evt = JSON.parse(line.slice(5).trim());
								if (evt.error) {
									settle(botDiv, evt.error);
									failed = true;
									break;
								}
								if (evt.token) {
									botDiv.classList.remove('naa-typing');
									fullAnswer += evt.token;
									botDiv.innerHTML = esc(fullAnswer).replace(/\n/g, '<br>');
									ui.msgs.scrollTop = ui.msgs.scrollHeight;
								}
								if (evt.done) {
									fullAnswer = evt.answer || fullAnswer;
									sources = evt.sources;
								}
							} catch (e) { /* 忽略坏行 */ }
						}
					}
					if (!failed) {
						if (!fullAnswer) {
							settle(botDiv, '没有得到回答，请换个问法试试。');
						}
						if (sources) {
							renderSources(sources);
						}
						history.push({ role: 'user', content: text });
						history.push({ role: 'assistant', content: fullAnswer });
						if (history.length > 10) {
							history = history.slice(-10);
						}
					}
				}
			} else {
				var res2 = await fetch(API_BASE + '/search', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf() },
					body: JSON.stringify({ q: text }),
				});
				var j2 = await res2.json().catch(function () { return {}; });
				ui.srcs.innerHTML = '';
				if (!res2.ok) {
					settle(botDiv, j2.error || '搜索失败，请稍后再试。');
				} else if (!j2.results || !j2.results.length) {
					settle(botDiv, '没有找到相关帖子，换个说法试试。');
				} else {
					settle(botDiv, '找到 ' + j2.results.length + ' 个相关帖子：');
					renderSources(j2.results);
				}
			}
		} catch (e) {
			settle(botDiv, '网络异常，请检查连接后重试。');
		}
		busy = false;
		ui.send.disabled = false;
		if (!isMobile()) {
			ui.input.focus({ preventScroll: true });
		}
	}

	/* ---------------- 生命周期 ---------------- */

	function init() {
		try {
			if (isAdminPage()) {
				close();
				return;
			}
			mountEntries();
		} catch (e) {
			// 静默失败，不影响论坛主体
		}
	}

	document.addEventListener('keydown', function (e) {
		if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'j' || e.key === 'J') && !isAdminPage()) {
			e.preventDefault();
			toggle();
		} else if (e.key === 'Escape' && ui && ui.panel.classList.contains('open')) {
			close();
		}
	});

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
	if (window.jQuery) {
		var $w = window.jQuery(window);
		$w.on('action:ajaxify.end', init); // 切页后侧栏/底栏可能重绘
		// 写帖子时让位
		$w.on('action:composer.loaded', function () {
			document.body.classList.add('naa-composing');
			close();
		});
		$w.on('action:composer.discard action:composer.submit action:composer.minimize action:composer.topics.post action:composer.posts.reply', function () {
			document.body.classList.remove('naa-composing');
		});
	}
}());
