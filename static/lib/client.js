/* nodebb-plugin-ai-assistant — 前端 widget
 * 右下角悬浮按钮，点击弹出面板（含「AI 问答」「AI 搜索」两个 tab）
 * 基于站内帖子检索 + 1118.si 模型回答，附来源帖子链接。
 * 通过 plugin.json 的 "scripts" 在每页加载，无需主题配合。
 */
(function () {
	'use strict';

	var API_BASE = ((window.config && window.config.relative_path) || '') + '/api/plugins/ai-assistant';
	var history = []; // [{role, content}]，最多保留 10 条
	var busy = false;

	function esc(s) {
		return String(s || '').replace(/[&<>"']/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}

	function logoSvg(size) {
		size = size || 24;
		return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none">' +
			'<defs><linearGradient id="naa-g" x1="0" y1="0" x2="1" y2="1">' +
			'<stop offset="0" stop-color="#ec4899"/><stop offset=".5" stop-color="#8b5cf6"/>' +
			'<stop offset="1" stop-color="#3b82f6"/></linearGradient></defs>' +
			'<path d="M12 2l2.1 6.1L20 10l-5.9 1.9L12 18l-2.1-6.1L4 10l5.9-1.9z" fill="url(#naa-g)"/>' +
			'<path d="M19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9z" fill="url(#naa-g)" opacity=".8"/>' +
			'</svg>';
	}

	function build() {
		if (document.getElementById('naa-fab')) {
			return; // ajaxify 切页时避免重复注入
		}
		var fab = document.createElement('button');
		fab.id = 'naa-fab';
		fab.title = 'AI 助手';
		fab.setAttribute('aria-label', '打开 AI 助手');
		fab.innerHTML = logoSvg(26);
		document.body.appendChild(fab);

		var panel = document.createElement('div');
		panel.id = 'naa-panel';
		panel.innerHTML =
			'<div id="naa-head"><div><b>AI 助手</b><small>基于站内帖子回答 · 1118.si</small></div>' +
			'<button id="naa-close" aria-label="关闭">✕</button></div>' +
			'<div id="naa-tabs"><button data-tab="chat" class="on">AI 问答</button>' +
			'<button data-tab="search">AI 搜索</button></div>' +
			'<div id="naa-msgs"></div>' +
			'<div id="naa-srcs"></div>' +
			'<div id="naa-inputbar"><input id="naa-input" placeholder="问问论坛里的内容…" maxlength="500" autocomplete="off">' +
			'<button id="naa-send">发送</button></div>';
		document.body.appendChild(panel);

		var msgs = panel.querySelector('#naa-msgs');
		var srcs = panel.querySelector('#naa-srcs');
		var input = panel.querySelector('#naa-input');
		var sendBtn = panel.querySelector('#naa-send');
		var mode = 'chat';

		function toggle() {
			panel.classList.toggle('open');
			if (panel.classList.contains('open')) {
				input.focus();
			}
		}
		fab.addEventListener('click', toggle);
		panel.querySelector('#naa-close').addEventListener('click', toggle);

		panel.querySelectorAll('#naa-tabs button').forEach(function (btn) {
			btn.addEventListener('click', function () {
				panel.querySelectorAll('#naa-tabs button').forEach(function (b) { b.classList.remove('on'); });
				btn.classList.add('on');
				mode = btn.getAttribute('data-tab');
				input.placeholder = mode === 'chat' ? '问问论坛里的内容…' : '输入问题，AI 找相关帖子…';
				input.focus();
			});
		});

		function addMsg(who, html) {
			var div = document.createElement('div');
			div.className = 'naa-msg naa-' + who;
			div.innerHTML = html;
			msgs.appendChild(div);
			msgs.scrollTop = msgs.scrollHeight;
		}

		function setTyping(on) {
			var t = panel.querySelector('.naa-typing');
			if (on && !t) {
				t = document.createElement('div');
				t.className = 'naa-msg naa-bot naa-typing';
				t.textContent = '思考中…';
				msgs.appendChild(t);
				msgs.scrollTop = msgs.scrollHeight;
			} else if (!on && t) {
				t.remove();
			}
		}

		function renderSources(list) {
			srcs.innerHTML = '';
			if (!list || !list.length) {
				return;
			}
			var title = document.createElement('div');
			title.className = 'naa-src-title';
			title.textContent = '参考帖子';
			srcs.appendChild(title);
			list.forEach(function (s) {
				var a = document.createElement('a');
				a.href = s.url;
				a.textContent = s.title;
				a.target = '_blank';
				a.rel = 'noopener';
				srcs.appendChild(a);
			});
		}

		async function send() {
			var text = input.value.trim();
			if (!text || busy) {
				return;
			}
			busy = true;
			sendBtn.disabled = true;
			input.value = '';
			setTyping(true);
			try {
				if (mode === 'chat') {
					addMsg('user', esc(text));
					var res = await fetch(API_BASE + '/chat', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ message: text, history: history }),
					});
					var j = await res.json();
					setTyping(false);
					if (!res.ok) {
						addMsg('bot', esc(j.error || '请求失败'));
					} else {
						addMsg('bot', esc(j.answer).replace(/\n/g, '<br>'));
						renderSources(j.sources);
						history.push({ role: 'user', content: text });
						history.push({ role: 'assistant', content: j.answer || '' });
						if (history.length > 10) {
							history = history.slice(-10);
						}
					}
				} else {
					var res2 = await fetch(API_BASE + '/search', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ q: text }),
					});
					var j2 = await res2.json();
					setTyping(false);
					srcs.innerHTML = '';
					if (!res2.ok) {
						addMsg('bot', esc(j2.error || '搜索失败'));
					} else if (!j2.results || !j2.results.length) {
						addMsg('bot', '没有找到相关帖子，换个问法试试。');
					} else {
						addMsg('bot', '找到 ' + j2.results.length + ' 个相关帖子：');
						renderSources(j2.results);
					}
				}
			} catch (e) {
				setTyping(false);
				addMsg('bot', '网络异常，请检查连接后重试。');
			}
			busy = false;
			sendBtn.disabled = false;
			input.focus();
		}

		sendBtn.addEventListener('click', send);
		input.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') {
				send();
			}
		});
	}

	function init() {
		try {
			build();
		} catch (e) {
			// 静默失败，不影响论坛主体
		}
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
	// NodeBB ajaxify 切页时重新注入
	if (window.jQuery) {
		window.jQuery(window).on('action:ajaxify.end', init);
	}
})();
