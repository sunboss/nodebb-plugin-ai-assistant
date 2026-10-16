'use strict';

define('admin/plugins/ai-assistant', [], function () {
	const admin = {};

	admin.init = function () {
		$('#ai-assistant-save').off('click').on('click', function () {
			const data = {
				_csrf: config.csrf_token,
				apiKey: $('#aiApiKey').val(),
				baseUrl: $('#aiBaseUrl').val(),
				model: $('#aiModel').val(),
				enableCjkBoost: $('#aiCjkBoost').is(':checked') ? '1' : '0',
				enableChat: $('#aiEnableChat').is(':checked') ? '1' : '0',
				enableAiSearch: $('#aiEnableSearch').is(':checked') ? '1' : '0',
				aiRerank: $('#aiRerank').is(':checked') ? '1' : '0',
				rateLimit: $('#aiRateLimit').val(),
				topK: $('#aiTopK').val(),
				systemPrompt: $('#aiSystemPrompt').val(),
				enableAutoReply: $('#aiEnableAutoReply').is(':checked') ? '1' : '0',
				autoReplyOnNewTopic: $('#aiAutoReplyOnNewTopic').is(':checked') ? '1' : '0',
				autoReplyOnReply: $('#aiAutoReplyOnReply').is(':checked') ? '1' : '0',
				autoReplyBotUids: $('#aiAutoReplyBotUids').val(),
				autoReplyCategories: $('#aiAutoReplyCategories').val(),
				autoReplyDelayMin: $('#aiAutoReplyDelayMin').val(),
				autoReplyDelayMax: $('#aiAutoReplyDelayMax').val(),
				autoReplyDailyLimit: $('#aiAutoReplyDailyLimit').val(),
				autoReplyMaxPerTopic: $('#aiAutoReplyMaxPerTopic').val(),
				autoReplyTimezone: $('#aiAutoReplyTimezone').val(),
				autoReplyQuietStart: $('#aiAutoReplyQuietStart').val(),
				autoReplyQuietEnd: $('#aiAutoReplyQuietEnd').val(),
				autoReplyPrompt: $('#aiAutoReplyPrompt').val(),
			};
			$.post(config.relative_path + '/api/admin/plugins/ai-assistant/save', data, function (resp) {
				app.alertSuccess((resp && resp.message) || '已保存');
				$('#aiApiKey').val('');
			}).fail(function (xhr) {
				const msg = (xhr.responseJSON && xhr.responseJSON.error) || '保存失败';
				app.alertError(msg);
			});
			return false;
		});
	};

	return admin;
});
