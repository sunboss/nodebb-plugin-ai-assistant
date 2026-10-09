<div class="row">
	<div class="col-lg-9">
		<div class="card">
			<div class="card-header">AI 助手设置 <small class="text-muted">— 模型由 1118.si 提供</small></div>
			<div class="card-body">
				<form id="ai-assistant-form">
					<div class="mb-3">
						<label class="form-label" for="aiApiKey">API Key（算力中转站）</label>
						<input type="password" class="form-control" id="aiApiKey" placeholder="留空则不修改" autocomplete="new-password" />
						<div class="form-text">
							{{{ if apiKeySet }}}<span class="text-success">● 已设置</span>{{{ else }}}<span class="text-danger">● 未设置</span>{{{ end }}}
							{{{ if envKeySet }}}（环境变量 AI_ASSISTANT_API_KEY 已生效，优先于此处配置）{{{ end }}}
						</div>
					</div>
					<div class="row">
						<div class="col-md-8 mb-3">
							<label class="form-label" for="aiBaseUrl">接口地址（OpenAI 兼容）</label>
							<input type="text" class="form-control" id="aiBaseUrl" value="{baseUrl}" />
						</div>
						<div class="col-md-4 mb-3">
							<label class="form-label" for="aiModel">模型</label>
							<input type="text" class="form-control" id="aiModel" value="{model}" />
						</div>
					</div>
					<div class="row">
						<div class="col-md-6 mb-3">
							<div class="form-check">
								<input class="form-check-input" type="checkbox" id="aiEnableChat" {{{ if enableChat }}}checked{{{ end }}} />
								<label class="form-check-label" for="aiEnableChat">启用 AI 问答助手（右下角浮动按钮）</label>
							</div>
							<div class="form-check">
								<input class="form-check-input" type="checkbox" id="aiEnableSearch" {{{ if enableAiSearch }}}checked{{{ end }}} />
								<label class="form-check-label" for="aiEnableSearch">启用 AI 语义搜索</label>
							</div>
							<div class="form-check">
								<input class="form-check-input" type="checkbox" id="aiCjkBoost" {{{ if enableCjkBoost }}}checked{{{ end }}} />
								<label class="form-check-label" for="aiCjkBoost">默认搜索中文分词增强</label>
							</div>
							<div class="form-check">
								<input class="form-check-input" type="checkbox" id="aiRerank" {{{ if aiRerank }}}checked{{{ end }}} />
								<label class="form-check-label" for="aiRerank">AI 搜索结果 LLM 重排（更准，但更耗 token）</label>
							</div>
						</div>
						<div class="col-md-3 mb-3">
							<label class="form-label" for="aiRateLimit">限流（每 IP 每分钟）</label>
							<input type="number" class="form-control" id="aiRateLimit" value="{rateLimit}" min="1" max="600" />
						</div>
						<div class="col-md-3 mb-3">
							<label class="form-label" for="aiTopK">问答参考帖子数</label>
							<input type="number" class="form-control" id="aiTopK" value="{topK}" min="1" max="12" />
						</div>
					</div>
					<div class="mb-3">
						<label class="form-label" for="aiSystemPrompt">系统提示词</label>
						<textarea class="form-control" id="aiSystemPrompt" rows="6">{systemPrompt}</textarea>
					</div>
					<button type="button" id="ai-assistant-save" class="btn btn-primary">保存</button>
				</form>
			</div>
		</div>
	</div>
	<div class="col-lg-3">
		<div class="card">
			<div class="card-header">说明</div>
			<div class="card-body">
				<ul class="small mb-0">
					<li>API Key 推荐用环境变量 <code>AI_ASSISTANT_API_KEY</code> 注入，重启生效。</li>
					<li>问答与搜索只返回当前用户有权限看的帖子。</li>
					<li>修改配置后即时生效，无需重启。</li>
				</ul>
			</div>
		</div>
	</div>
</div>

<script>
require(['admin/plugins/ai-assistant'], function (admin) {
	admin.init();
});
</script>
