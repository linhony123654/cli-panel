/**
 * CLI Control Panel — Frontend Application
 * Fully interactive Vue 3 setup for managing Claude Code & Codex CLI configurations.
 */

const { createApp, ref, computed, onMounted, onUnmounted, nextTick } = Vue;

const app = createApp({
  setup() {
    // ------------------------------------------------------------- Auth State
    const authed = ref(false);
    const checkingAuth = ref(true);
    const loginPassword = ref('');
    const loginLoading = ref(false);
    const loginError = ref('');
    const showChangePw = ref(false);
    const pwForm = ref({ old: '', new: '', confirm: '' });
    const pwLoading = ref(false);

    // ------------------------------------------------------------- Global State
    const currentTab = ref('claude'); // 'claude' | 'codex' | 'providers' | 'backups'
    const claudeSubTab = ref('launchers'); // 'launchers' | 'settings'
    const codexSubTab = ref('profiles'); // 'profiles' | 'settings'
    const state = ref({
      providers: [],
      claude: { launchers: [], alias: { name: 'cl', target: '' }, efforts: [] },
      claude_settings: { form: {}, error: null, fields: {} },
      codex: { current: {}, providers: [], profiles: [], globals: {}, global_fields: {}, efforts: [], tiers: [] },
      host: ''
    });
    const loading = ref(false);
    const toast = ref({ show: false, message: '', type: 'info' });

    // ------------------------------------------------------------- Splash Boot Screen
    const showSplash = ref(false);
    const splashProgress = ref(0);
    const splashLogs = ref([]);
    const splashReady = ref(false);
    let splashTimer = null;

    function playBootSequence() {
      showSplash.value = true;
      splashProgress.value = 0;
      splashLogs.value = [];
      splashReady.value = false;

      const steps = [
        { p: 25, log: '启动 Claude Code & Codex CLI 核心引擎...' },
        { p: 55, log: '连接本工作机 Tmux 会话与进程守护监测...' },
        { p: 85, log: '同步 20 个工程 Git 巡检状态 & 28 条 Memory 记忆...' },
        { p: 100, log: '自检完成', ready: true }
      ];

      let stepIdx = 0;
      clearInterval(splashTimer);
      splashTimer = setInterval(() => {
        if (stepIdx < steps.length) {
          const s = steps[stepIdx];
          splashProgress.value = s.p;
          if (s.ready) {
            splashReady.value = true;
          } else {
            splashLogs.value.push(s.log);
          }
          stepIdx++;
        } else {
          clearInterval(splashTimer);
          setTimeout(() => {
            showSplash.value = false;
          }, 380);
        }
      }, 160);
    }

    function dismissSplash() {
      clearInterval(splashTimer);
      showSplash.value = false;
    }

    function showToast(message, type = 'info') {
      toast.value = { show: true, message, type };
      setTimeout(() => {
        if (toast.value.message === message) toast.value.show = false;
      }, 3500);
    }

    // ------------------------------------------------------------- API helper
    async function api(path, options = {}) {
      const headers = {
        'X-Requested-With': 'cli-panel',
        ...(options.headers || {})
      };
      if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(options.body);
      }
      try {
        const res = await fetch(path, { credentials: 'same-origin', credentials: 'include', ...options, headers });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 401) {
            authed.value = false;
            throw new Error(data.error || '未登录或会话已过期');
          }
          throw new Error(data.error || `请求失败 (${res.status})`);
        }
        return data;
      } catch (err) {
        throw err;
      }
    }

    // ------------------------------------------------------------- Hardware Resource HUD
    const systemHud = ref({
      cpu: { percent: 0, cores: 1, loadavg: [0, 0, 0] },
      memory: { percent: 0, total_gb: 0, used_gb: 0, avail_gb: 0 },
      disk: { percent: 0, total_gb: 0, used_gb: 0, avail_gb: 0 },
      uptime: '—',
      process: { rss_mb: 0, heap_mb: 0, pid: 0 },
      timestamp: ''
    });
    const loadingHud = ref(false);
    let hudTimer = null;

    async function loadSystemHud() {
      try {
        const res = await api('/api/system/hud');
        systemHud.value = res;
      } catch {}
    }

    // ------------------------------------------------------------- Check Auth & Login
    async function checkAuth() {
      checkingAuth.value = true;
      try {
        const res = await api('/api/me');
        authed.value = !!res.authed;
        if (authed.value) {
          playBootSequence();
          await loadState();
          loadSystemHud();
          clearInterval(hudTimer);
          hudTimer = setInterval(loadSystemHud, 8000);
        }
      } catch (e) {
        authed.value = false;
      } finally {
        checkingAuth.value = false;
      }
    }

    async function doLogin() {
      if (!loginPassword.value) {
        loginError.value = '请输入登录密码';
        return;
      }
      loginLoading.value = true;
      loginError.value = '';
      try {
        await api('/api/login', {
          method: 'POST',
          body: { password: loginPassword.value }
        });
        authed.value = true;
        loginPassword.value = '';
        showToast('登录成功', 'success');
        playBootSequence();
        await loadState();
        loadSystemHud();
        clearInterval(hudTimer);
        hudTimer = setInterval(loadSystemHud, 8000);
      } catch (err) {
        loginError.value = err.message;
      } finally {
        loginLoading.value = false;
      }
    }

    async function doLogout() {
      try {
        await api('/api/logout', { method: 'POST' });
      } catch (e) {}
      clearInterval(hudTimer);
      authed.value = false;
      showToast('已安全退出');
    }

    async function changePassword() {
      if (pwForm.value.new !== pwForm.value.confirm) {
        return showToast('两次输入的新密码不一致', 'error');
      }
      if (pwForm.value.new.length < 8) {
        return showToast('新密码至少 8 位', 'error');
      }
      pwLoading.value = true;
      try {
        await api('/api/password', {
          method: 'POST',
          body: { old: pwForm.value.old, new: pwForm.value.new }
        });
        showToast('密码修改成功，请重新登录', 'success');
        showChangePw.value = false;
        pwForm.value = { old: '', new: '', confirm: '' };
        authed.value = false;
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        pwLoading.value = false;
      }
    }

    // ------------------------------------------------------------- Load State
    async function loadState() {
      loading.value = true;
      try {
        const data = await api('/api/state');
        state.value = data;
      } catch (err) {
        showToast('获取配置状态失败: ' + err.message, 'error');
      } finally {
        loading.value = false;
      }
    }

    // ------------------------------------------------------------- Providers Modal & CRUD
    const showProviderModal = ref(false);
    const providerForm = ref({
      id: '',
      name: '',
      anthropic_url: '',
      openai_url: '',
      note: '',
      key: '',
      models: []
    });
    const isNewProvider = ref(false);
    const savingProvider = ref(false);
    const fetchingModels = ref(false);

    function openAddProvider() {
      isNewProvider.value = true;
      providerForm.value = {
        id: '',
        name: '',
        anthropic_url: 'https://',
        openai_url: 'https://',
        note: '',
        key: '',
        models: []
      };
      showProviderModal.value = true;
    }

    function openEditProvider(p) {
      isNewProvider.value = false;
      providerForm.value = {
        id: p.id,
        name: p.name,
        anthropic_url: p.anthropic_url || '',
        openai_url: p.openai_url || '',
        note: p.note || '',
        key: '', // leave blank unless updating
        models: JSON.parse(JSON.stringify(p.models || []))
      };
      showProviderModal.value = true;
    }

    function addModelToProvider() {
      providerForm.value.models.push({ id: '', name: '', desc: '', context: null });
    }

    function removeModelFromProvider(idx) {
      providerForm.value.models.splice(idx, 1);
    }

    async function fetchModelsFromProvider(provId) {
      fetchingModels.value = true;
      try {
        const res = await api(`/api/providers/${provId}/fetch-models`, { method: 'POST' });
        let added = 0;
        for (const mid of res.models) {
          if (!providerForm.value.models.some(m => m.id === mid)) {
            providerForm.value.models.push({ id: mid, name: '', desc: '', context: null });
            added++;
          }
        }
        showToast(`已从接口探测到 ${res.models.length} 个模型，新导入 ${added} 个`, 'success');
      } catch (err) {
        showToast('探测模型失败: ' + err.message, 'error');
      } finally {
        fetchingModels.value = false;
      }
    }

    async function saveProvider() {
      if (!providerForm.value.name) return showToast('请填写供应商名称', 'error');
      savingProvider.value = true;
      try {
        const res = await api('/api/providers', {
          method: 'POST',
          body: providerForm.value
        });
        showToast(`供应商保存成功${res.regenerated?.length ? ` (已重新生成 ${res.regenerated.join(', ')})` : ''}`, 'success');
        showProviderModal.value = false;
        await loadState();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        savingProvider.value = false;
      }
    }

    async function deleteProvider(p) {
      if (!confirm(`确定要删除供应商「${p.name}」吗？`)) return;
      try {
        await api(`/api/providers/${p.id}`, { method: 'DELETE' });
        showToast('供应商已删除', 'success');
        await loadState();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    // ------------------------------------------------------------- Claude Launcher Drawer & Actions
    const showClaudeDrawer = ref(false);
    const claudeForm = ref({
      cmd: '',
      orig_cmd: '',
      provider: '',
      model: '',
      opus: '',
      opus_name: '',
      opus_desc: '',
      sonnet: '',
      sonnet_name: '',
      sonnet_desc: '',
      haiku: '',
      haiku_name: '',
      haiku_desc: '',
      custom: '',
      custom_name: '',
      custom_desc: '',
      subagent: '',
      small_fast: '',
      context: '',
      compact: '',
      effort: '',
      append_sp: false,
      note: '',
      extra_env: []
    });
    const isNewClaude = ref(false);
    const savingClaude = ref(false);
    const testStatus = ref({}); // { [key]: { loading, ok, ms, reply, models, error } }

    function openAddClaude() {
      isNewClaude.value = true;
      const firstProv = state.value.providers.find(p => p.anthropic_url) || state.value.providers[0];
      claudeForm.value = {
        cmd: 'claude-',
        orig_cmd: '',
        provider: firstProv ? firstProv.id : '',
        model: firstProv?.models?.[0]?.id || '',
        opus: '', opus_name: '', opus_desc: '',
        sonnet: '', sonnet_name: '', sonnet_desc: '',
        haiku: '', haiku_name: '', haiku_desc: '',
        custom: '', custom_name: '', custom_desc: '',
        subagent: '', small_fast: '',
        context: '262144',
        compact: '262144',
        effort: 'high',
        append_sp: false,
        note: '',
        extra_env: []
      };
      showClaudeDrawer.value = true;
    }

    function openEditClaude(l) {
      isNewClaude.value = false;
      const f = l.form || {};
      claudeForm.value = {
        cmd: l.cmd,
        orig_cmd: l.cmd,
        provider: f.provider || '',
        model: f.model || '',
        opus: f.opus || '', opus_name: f.opus_name || '', opus_desc: f.opus_desc || '',
        sonnet: f.sonnet || '', sonnet_name: f.sonnet_name || '', sonnet_desc: f.sonnet_desc || '',
        haiku: f.haiku || '', haiku_name: f.haiku_name || '', haiku_desc: f.haiku_desc || '',
        custom: f.custom || '', custom_name: f.custom_name || '', custom_desc: f.custom_desc || '',
        subagent: f.subagent || '', small_fast: f.small_fast || '',
        context: f.context ? String(f.context) : '262144',
        compact: f.compact ? String(f.compact) : '262144',
        effort: f.effort || '',
        append_sp: !!f.append_sp,
        note: f.note || '',
        extra_env: JSON.parse(JSON.stringify(f.extra_env || []))
      };
      showClaudeDrawer.value = true;
    }

    function addExtraEnv() {
      claudeForm.value.extra_env.push({ k: '', v: '' });
    }
    function removeExtraEnv(idx) {
      claudeForm.value.extra_env.splice(idx, 1);
    }

    const commonEnvPresets = [
      { k: 'API_TIMEOUT_MS', v: '3000000', label: 'API 超时 50m' },
      { k: 'MAX_THINKING_TOKENS', v: '32000', label: '思考最大 Token' },
      { k: 'BASH_DEFAULT_TIMEOUT_MS', v: '300000', label: 'Bash 超时 5m' },
      { k: 'CLAUDE_STATUS_TRIGGER', v: '917000', label: '状态栏压缩警戒点' },
      { k: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', v: '1', label: '禁用非核心遥测' },
      { k: 'ALL_PROXY', v: 'socks5h://127.0.0.1:1080', label: 'SOCKS5 代理' },
      { k: 'HTTP_PROXY', v: 'http://127.0.0.1:1080', label: 'HTTP 代理' },
    ];

    function applyEnvPreset(preset) {
      const exists = claudeForm.value.extra_env.find(e => e.k === preset.k);
      if (exists) {
        exists.v = preset.v;
      } else {
        claudeForm.value.extra_env.push({ k: preset.k, v: preset.v });
      }
      showToast(`已追加环境变量: ${preset.k}`, 'success');
    }

    function syncMainModelToAll() {
      if (!claudeForm.value.model) return showToast('请先选择或输入主模型', 'error');
      claudeForm.value.sonnet = claudeForm.value.model;
      claudeForm.value.opus = claudeForm.value.model;
      claudeForm.value.haiku = claudeForm.value.model;
      claudeForm.value.subagent = claudeForm.value.model;
      showToast('已一键将主模型填入 Sonnet / Opus / Haiku / 子代理', 'success');
    }

    async function saveClaudeLauncher(confirmTakeover = false) {
      savingClaude.value = true;
      try {
        const body = { ...claudeForm.value, confirm_takeover: confirmTakeover };
        const res = await api('/api/claude/launchers', { method: 'POST', body });
        showToast(`启动命令 ${res.cmd} 已成功保存到 ~/.local/bin/${res.cmd}`, 'success');
        showClaudeDrawer.value = false;
        await loadState();
      } catch (err) {
        if (err.message && err.message.includes('确认继续')) {
          if (confirm(err.message)) {
            savingClaude.value = false;
            return saveClaudeLauncher(true);
          }
        } else {
          showToast(err.message, 'error');
        }
      } finally {
        savingClaude.value = false;
      }
    }

    async function deleteLauncher(cmd) {
      if (!confirm(`确定要删除启动命令 ~/.local/bin/${cmd} 吗？原文件将自动备份`)) return;
      try {
        await api(`/api/launchers/${cmd}`, { method: 'DELETE' });
        showToast(`启动命令 ${cmd} 已删除`, 'success');
        await loadState();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    async function setClaudeAlias(target) {
      try {
        await api('/api/claude/alias', {
          method: 'POST',
          body: { name: 'cl', target }
        });
        showToast(`默认别名 cl 已指向 ${target}`, 'success');
        await loadState();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    async function testClaude(cmd) {
      testStatus.value['claude:' + cmd] = { loading: true };
      try {
        const res = await api('/api/claude/test', {
          method: 'POST',
          body: { cmd }
        });
        testStatus.value['claude:' + cmd] = {
          loading: false,
          ok: res.ok,
          ms: res.ms,
          reply: res.reply,
          models: res.models || [],
          error: res.error
        };
        if (res.ok) {
          showToast(`✅ [${cmd}] 测试通过 (${res.ms}ms) 模型: ${res.models.join(', ')}`, 'success');
        } else {
          showToast(`❌ [${cmd}] 测试失败: ${res.error}`, 'error');
        }
      } catch (err) {
        testStatus.value['claude:' + cmd] = { loading: false, ok: false, error: err.message };
        showToast(`测试异常: ${err.message}`, 'error');
      }
    }

    // ------------------------------------------------------------- Claude Settings
    const savingClaudeSettings = ref(false);
    async function saveClaudeSettings() {
      savingClaudeSettings.value = true;
      try {
        await api('/api/claude/settings', {
          method: 'POST',
          body: state.value.claude_settings.form
        });
        showToast('Claude Code 全局设置已写入 ~/.claude/settings.json (已自动备份)', 'success');
        await loadState();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        savingClaudeSettings.value = false;
      }
    }

    const testingStatusLine = ref(false);
    const statusLinePreview = ref('');
    async function testStatusLine() {
      testingStatusLine.value = true;
      try {
        const res = await api('/api/claude/statusline/test', { method: 'POST' });
        if (res.ok) {
          statusLinePreview.value = res.output;
          showToast('状态栏模拟执行成功', 'success');
        } else {
          statusLinePreview.value = '执行失败: ' + res.output;
          showToast('状态栏脚本执行出错', 'error');
        }
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        testingStatusLine.value = false;
      }
    }

    // ------------------------------------------------------------- Codex Profile Drawer & Actions
    const showCodexDrawer = ref(false);
    const codexForm = ref({
      name: '',
      orig_name: '',
      model: '',
      model_provider: '',
      effort: '',
      service_tier: '',
      context: '',
      compact: '',
      catalog_mode: 'none',
      catalog_path: '',
      catalog_models: [],
      cmd: '',
      set_default: false
    });
    const isNewCodex = ref(false);
    const savingCodex = ref(false);

    function openAddCodex() {
      isNewCodex.value = true;
      const firstProv = state.value.codex.providers[0];
      codexForm.value = {
        name: '',
        orig_name: '',
        model: '',
        model_provider: firstProv ? firstProv.id : '',
        effort: 'high',
        service_tier: 'fast',
        context: '262144',
        compact: '262144',
        catalog_mode: 'none',
        catalog_path: '',
        catalog_models: [],
        cmd: '',
        set_default: false
      };
      showCodexDrawer.value = true;
    }

    function openEditCodex(p) {
      isNewCodex.value = false;
      codexForm.value = {
        name: p.name,
        orig_name: p.name,
        model: p.model || '',
        model_provider: p.model_provider || '',
        effort: p.effort || '',
        service_tier: p.service_tier || '',
        context: p.context ? String(p.context) : '262144',
        compact: p.compact ? String(p.compact) : '262144',
        catalog_mode: p.catalog_mode || 'none',
        catalog_path: p.catalog_path || '',
        catalog_models: JSON.parse(JSON.stringify(p.catalog_models || [])),
        cmd: p.launchers?.[0] || '',
        set_default: p.is_default
      };
      showCodexDrawer.value = true;
    }

    function addModelToCodexCatalog(mid) {
      if (!mid) return;
      if (!codexForm.value.catalog_models.includes(mid)) {
        codexForm.value.catalog_models.push(mid);
      }
    }
    function removeModelFromCodexCatalog(idx) {
      codexForm.value.catalog_models.splice(idx, 1);
    }

    async function saveCodexProfile() {
      if (!codexForm.value.name) return showToast('请填写 Profile 名称', 'error');
      if (!codexForm.value.model) return showToast('请填写/选择模型', 'error');
      savingCodex.value = true;
      try {
        const res = await api('/api/codex/profiles', {
          method: 'POST',
          body: codexForm.value
        });
        showToast(`Profile [${res.name}] 已保存到 ~/.codex/${res.name}.config.toml`, 'success');
        showCodexDrawer.value = false;
        await loadState();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        savingCodex.value = false;
      }
    }

    async function setCodexDefault(profileName) {
      try {
        await api('/api/codex/default', {
          method: 'POST',
          body: { name: profileName }
        });
        showToast(`已设为当前默认配置 (config.toml 顶层已更新为 ${profileName})`, 'success');
        await loadState();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    async function deleteCodexProfile(name) {
      if (!confirm(`确定要删除 Profile「${name}」吗？`)) return;
      try {
        await api(`/api/codex/profiles/${name}`, { method: 'DELETE' });
        showToast(`Profile ${name} 已删除`, 'success');
        await loadState();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    async function testCodex(name) {
      testStatus.value['codex:' + name] = { loading: true };
      try {
        const res = await api('/api/codex/test', {
          method: 'POST',
          body: { name }
        });
        testStatus.value['codex:' + name] = {
          loading: false,
          ok: res.ok,
          ms: res.ms,
          reply: res.reply,
          models: res.models || [],
          provider: res.provider,
          error: res.error
        };
        if (res.ok) {
          showToast(`✅ Codex [${name}] 测试通过 (${res.ms}ms) 返回: ${res.reply}`, 'success');
        } else {
          showToast(`❌ Codex [${name}] 测试失败: ${res.error}`, 'error');
        }
      } catch (err) {
        testStatus.value['codex:' + name] = { loading: false, ok: false, error: err.message };
        showToast(`测试异常: ${err.message}`, 'error');
      }
    }

    // ------------------------------------------------------------- Codex Globals & Catalogs
    const savingCodexGlobals = ref(false);
    async function saveCodexGlobals() {
      savingCodexGlobals.value = true;
      try {
        await api('/api/codex/globals', {
          method: 'POST',
          body: state.value.codex.globals
        });
        showToast('Codex 全局参数已写入 ~/.codex/config.toml (已自动备份)', 'success');
        await loadState();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        savingCodexGlobals.value = false;
      }
    }

    // Codex Catalog Manager (/model menu)
    const showCatalogModal = ref(false);
    const savingCatalog = ref(false);
    const catalogForm = ref({
      target: '',
      name: '',
      isNew: false,
      models: [],
      set_default: false,
    });
    const catalogNewModel = ref({ id: '', name: '', desc: '', effort: 'high' });

    function openCatalogManager(targetPath = '') {
      const currentDefault = state.value.codex.current?.catalog || '';
      const chosenPath = targetPath || currentDefault || (state.value.codex.catalogs?.[0]?.path) || '';
      selectCatalogForEdit(chosenPath);
      showCatalogModal.value = true;
    }

    function selectCatalogForEdit(catPath) {
      const cat = (state.value.codex?.catalogs || []).find(c => c.path === catPath || c.file === catPath);
      if (cat) {
        catalogForm.value = {
          target: cat.path,
          name: cat.file,
          isNew: false,
          models: JSON.parse(JSON.stringify(cat.models || [])),
          set_default: cat.path === state.value.codex.current?.catalog,
        };
      } else {
        catalogForm.value = {
          target: catPath || 'custom-models.json',
          name: catPath ? catPath.split('/').pop() : 'custom-models.json',
          isNew: true,
          models: [],
          set_default: true,
        };
      }
    }

    function startNewCatalog() {
      catalogForm.value = {
        target: '',
        name: 'custom-models.json',
        isNew: true,
        models: [],
        set_default: false,
      };
    }

    function addModelToCurrentCatalog(modelOrId) {
      if (!modelOrId) return;
      const id = typeof modelOrId === 'object' ? (modelOrId.id || modelOrId.value) : modelOrId;
      if (catalogForm.value.models.some(m => m.id === id || m.slug === id)) {
        return showToast('该模型已在候选清单中', 'error');
      }
      const meta = allAvailableModels.value.find(m => m.id === id) || { id, name: id, desc: '' };
      catalogForm.value.models.push({
        id,
        slug: id,
        name: meta.name || id,
        desc: meta.desc || '终端快速切换模型',
        effort: 'high'
      });
      showToast(`已添加模型「${id}」至候选菜单`, 'success');
    }

    function addCustomModelToCurrentCatalog() {
      const id = (catalogNewModel.value.id || '').trim();
      if (!id) return showToast('请输入模型 ID', 'error');
      addModelToCurrentCatalog({
        id,
        name: (catalogNewModel.value.name || id).trim(),
        desc: (catalogNewModel.value.desc || '').trim(),
        effort: catalogNewModel.value.effort || 'high'
      });
      catalogNewModel.value = { id: '', name: '', desc: '', effort: 'high' };
    }

    function removeModelFromCurrentCatalog(idx) {
      catalogForm.value.models.splice(idx, 1);
    }

    function moveCatalogModel(idx, dir) {
      const target = idx + dir;
      if (target < 0 || target >= catalogForm.value.models.length) return;
      const item = catalogForm.value.models.splice(idx, 1)[0];
      catalogForm.value.models.splice(target, 0, item);
    }

    async function saveCurrentCatalog() {
      const target = (catalogForm.value.target || catalogForm.value.name || '').trim();
      if (!target) return showToast('请输入或选择目录名称', 'error');
      if (!catalogForm.value.models.length) return showToast('候选模型列表不能为空', 'error');
      savingCatalog.value = true;
      try {
        const res = await api('/api/codex/catalogs', {
          method: 'POST',
          body: {
            target,
            models: catalogForm.value.models,
            set_default: catalogForm.value.set_default,
          }
        });
        showToast(`候选目录已保存 (${res.catalog?.count} 个模型)！终端输入 /model 即可查看最新菜单`, 'success');
        showCatalogModal.value = false;
        await loadState();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        savingCatalog.value = false;
      }
    }

    async function switchDefaultCatalog(catalogPath) {
      try {
        await api('/api/codex/catalog/default', {
          method: 'POST',
          body: { path: catalogPath }
        });
        showToast(catalogPath ? `默认候选目录已切换为 ${catalogPath.split('/').pop()}` : '已取消外挂候选目录 (使用原生内置)', 'success');
        await loadState();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    // ------------------------------------------------------------- Raw File Modal
    const showRawModal = ref(false);
    const rawModalTitle = ref('');
    const rawModalPath = ref('');
    const rawModalText = ref('');
    const rawModalTargetType = ref(''); // 'claude-settings' | 'codex-config' | 'codex-profile'
    const rawModalProfileName = ref('');
    const savingRaw = ref(false);

    async function openRawEditor(type, profileName = '') {
      rawModalTargetType.value = type;
      rawModalProfileName.value = profileName;
      savingRaw.value = false;
      try {
        if (type === 'claude-settings') {
          const res = await api('/api/claude/settings/raw');
          rawModalTitle.value = '编辑 Claude Code 配置 (settings.json)';
          rawModalPath.value = res.path;
          rawModalText.value = res.text;
        } else if (type === 'codex-config') {
          const res = await api('/api/codex/raw');
          rawModalTitle.value = '编辑 Codex 主配置 (config.toml)';
          rawModalPath.value = res.path;
          rawModalText.value = res.text;
        } else if (type === 'codex-profile') {
          const res = await api(`/api/codex/raw?profile=${encodeURIComponent(profileName)}`);
          rawModalTitle.value = `编辑 Codex Profile (${profileName}.config.toml)`;
          rawModalPath.value = res.path;
          rawModalText.value = res.text;
        } else if (type === 'claude-statusline') {
          const res = await api('/api/claude/statusline/raw');
          rawModalTitle.value = '编辑 Claude Code 状态栏脚本 (statusline.py)';
          rawModalPath.value = res.path;
          rawModalText.value = res.text;
        }
        showRawModal.value = true;
      } catch (err) {
        showToast('获取文件失败: ' + err.message, 'error');
      }
    }

    async function saveRawContent() {
      savingRaw.value = true;
      try {
        if (rawModalTargetType.value === 'claude-settings') {
          await api('/api/claude/settings/raw', {
            method: 'POST',
            body: { text: rawModalText.value }
          });
        } else if (rawModalTargetType.value === 'claude-statusline') {
          await api('/api/claude/statusline/raw', {
            method: 'POST',
            body: { text: rawModalText.value }
          });
        } else if (rawModalTargetType.value === 'codex-config') {
          await api('/api/codex/raw', {
            method: 'POST',
            body: { text: rawModalText.value }
          });
        } else if (rawModalTargetType.value === 'codex-profile') {
          await api('/api/codex/raw', {
            method: 'POST',
            body: { text: rawModalText.value, profile: rawModalProfileName.value }
          });
        }
        showToast('文件已保存并生效（保存前已自动生成备份）', 'success');
        showRawModal.value = false;
        await loadState();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        savingRaw.value = false;
      }
    }

    // ------------------------------------------------------------- Backups
    const backups = ref([]);
    const loadingBackups = ref(false);
    const showBackupModal = ref(false);
    const backupDetail = ref({ name: '', target: '', text: '', current: '' });

    async function loadBackups() {
      loadingBackups.value = true;
      try {
        const res = await api('/api/backups');
        backups.value = res.items || [];
      } catch (err) {
        showToast('加载备份失败: ' + err.message, 'error');
      } finally {
        loadingBackups.value = false;
      }
    }

    async function viewBackup(b) {
      try {
        const res = await api(`/api/backups/${encodeURIComponent(b.name)}`);
        backupDetail.value = {
          name: b.name,
          time: b.time,
          target: res.target,
          text: res.text,
          current: res.current
        };
        showBackupModal.value = true;
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    async function restoreBackup(name) {
      if (!confirm(`确定要从备份 ${name} 回滚恢复文件吗？当前目标文件也将先自动备份`)) return;
      try {
        const res = await api(`/api/backups/${encodeURIComponent(name)}/restore`, { method: 'POST' });
        showToast(`文件 ${res.target} 已成功回滚恢复！`, 'success');
        showBackupModal.value = false;
        await loadState();
        await loadBackups();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    // ------------------------------------------------------------- Full System Export & Import
    const exportingBundle = ref(false);
    const showImportModal = ref(false);
    const importBundleText = ref('');
    const importingBundle = ref(false);
    const importResult = ref(null);

    async function downloadFullExport() {
      exportingBundle.value = true;
      try {
        const res = await api('/api/system/export');
        const str = JSON.stringify(res, null, 2);
        const blob = new Blob([str], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10) + '-' + now.toTimeString().slice(0, 5).replace(':', '');
        a.href = url;
        a.download = `cli-panel-snapshot-${dateStr}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('全量配置快照已成功导出并下载', 'success');
      } catch (err) {
        showToast('导出配置失败: ' + err.message, 'error');
      } finally {
        exportingBundle.value = false;
      }
    }

    function onImportFileSelected(e) {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = evt => {
        importBundleText.value = String(evt.target?.result || '');
      };
      reader.readAsText(file);
    }

    async function executeImportBundle() {
      if (!importBundleText.value.trim()) {
        showToast('请选择配置文件或粘贴快照 JSON 内容', 'warning');
        return;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(importBundleText.value.trim());
      } catch (e) {
        showToast('JSON 格式解析失败: ' + e.message, 'error');
        return;
      }
      if (!confirm('确定要将该快照配置恢复导入至当前 VPS 吗？已存在项将被更新覆盖')) return;
      importingBundle.value = true;
      try {
        const res = await api('/api/system/import', {
          method: 'POST',
          body: parsed
        });
        const c = res.counts || {};
        const detail = `${c.providers || 0} 供应商 / ${c.launchers || 0} 启动器 / ${c.profiles || 0} Profile / ${c.skills || 0} 技能 / ${c.rules || 0} 规则`
          + (c.claude_settings ? ' / 设置' : '') + (c.statusline ? ' / 状态栏' : '');
        const sk = res.skipped || {};
        const lines = Object.entries(sk)
          .filter(([, arr]) => Array.isArray(arr) && arr.length)
          .flatMap(([k, arr]) => arr.map(x => `${k}｜${x.id || x.cmd || x.name}：${x.reason || '未说明'}`));
        importResult.value = { counts: detail, skipped: lines, ok: !!res.ok };
        if (res.ok) {
          showToast(`导入完成：${detail}`, 'success');
        } else {
          showToast(`导入部分完成：${detail}｜跳过 ${res.skipped_total || 0} 项，详见结果`, 'warning');
        }
        if (res.ok) {
          showImportModal.value = false;
          importBundleText.value = '';
        }
        await loadState();
        await loadBackups();
      } catch (err) {
        showToast('导入失败: ' + err.message, 'error');
      } finally {
        importingBundle.value = false;
      }
    }

    // ------------------------------------------------------------- Helpers
    function getProvider(provId) {
      return state.value.providers.find(p => p.id === provId) || { models: [] };
    }

    function getProviderModels(provId) {
      const p = getProvider(provId);
      return (p.models || []).map(m => ({ value: m.id, label: m.id, desc: m.name }));
    }

    // Select options for custom c-select components
    const claudeAliasOptions = computed(() => [
      { value: '', label: '-- 未设置默认启动器 --' },
      ...(state.value.claude.launchers || []).map(l => ({
        value: l.cmd,
        label: l.cmd,
        badge: l.managed ? '托管' : '手写',
        desc: l.form?.model ? `(${l.form.model})` : ''
      }))
    ]);

    const providerSelectOptions = computed(() => (state.value.providers || []).map(p => ({
      value: p.id,
      label: p.name,
      badge: p.id
    })));

    const claudeEffortOptions = [
      { value: '', label: '默认 (不传参数)' },
      { value: 'low', label: 'LOW' },
      { value: 'medium', label: 'MEDIUM' },
      { value: 'high', label: 'HIGH' },
      { value: 'xhigh', label: 'XHIGH' },
      { value: 'max', label: 'MAX' }
    ];

    const claudeContextOptions = computed(() => {
      const opts = [
        { value: '262144', label: '256K (262,144)', desc: '官方默认标准上下文' },
        { value: '500000', label: '500K (500,000)', desc: '大容量扩展上下文' },
        { value: '1000000', label: '1M (1,000,000)', desc: '超大上下文（需 [1m] 标签）' },
      ];
      const cur = String(claudeForm.value.context || '');
      if (cur && !opts.some(o => o.value === cur)) {
        opts.unshift({ value: cur, label: `自定义 (${cur})`, desc: '手写数值' });
      }
      return opts;
    });

    const claudeCompactOptions = computed(() => {
      const opts = [
        { value: '262144', label: '256K (262,144)', desc: '约 229K 开始自动压缩' },
        { value: '475000', label: '500K (475,000)', desc: '约 442K 开始自动压缩' },
        { value: '950000', label: '1M (950,000)', desc: '约 917K 开始自动压缩' },
      ];
      const cur = String(claudeForm.value.compact || '');
      if (cur && !opts.some(o => o.value === cur)) {
        opts.unshift({ value: cur, label: `自定义 (${cur})`, desc: '手写数值' });
      }
      return opts;
    });

    function onContextWindowChange(newVal) {
      claudeForm.value.context = newVal;
      // 联动切换推荐的自动压缩窗口
      if (newVal === '262144') {
        claudeForm.value.compact = '262144';
      } else if (newVal === '500000') {
        claudeForm.value.compact = '475000';
      } else if (newVal === '1000000') {
        claudeForm.value.compact = '950000';
        // 若为主流官方 claude 模型且未带 [1m]，自动补全 [1m] 方便用户
        if (claudeForm.value.model && /claude|sonnet|opus|haiku/i.test(claudeForm.value.model) && !claudeForm.value.model.endsWith('[1m]')) {
          claudeForm.value.model = claudeForm.value.model + '[1m]';
        }
      }
    }

    function toggle1mTag() {
      if (!claudeForm.value.model) {
        claudeForm.value.model = 'claude-sonnet-5-5[1m]';
        return;
      }
      if (claudeForm.value.model.endsWith('[1m]')) {
        claudeForm.value.model = claudeForm.value.model.slice(0, -4);
      } else {
        claudeForm.value.model = claudeForm.value.model + '[1m]';
      }
    }

    const codexContextOptions = computed(() => {
      const opts = [
        { value: '262144', label: '256K (262,144)', desc: '默认标准上下文' },
        { value: '500000', label: '500K (500,000)', desc: '大容量扩展上下文' },
        { value: '1000000', label: '1M (1,000,000)', desc: '100 万 token 超大上下文' },
      ];
      const cur = String(codexForm.value.context || '');
      if (cur && !opts.some(o => o.value === cur)) {
        opts.unshift({ value: cur, label: `自定义 (${cur})`, desc: '手写数值' });
      }
      return opts;
    });

    const codexCompactOptions = computed(() => {
      const opts = [
        { value: '262144', label: '256K (262,144)', desc: '标准压缩阈值' },
        { value: '475000', label: '500K (475,000)', desc: '500K 档位推荐压缩阈值' },
        { value: '950000', label: '1M (950,000)', desc: '1M 档位推荐压缩阈值' },
      ];
      const cur = String(codexForm.value.compact || '');
      if (cur && !opts.some(o => o.value === cur)) {
        opts.unshift({ value: cur, label: `自定义 (${cur})`, desc: '手写数值' });
      }
      return opts;
    });

    function onCodexContextChange(newVal) {
      codexForm.value.context = newVal;
      if (newVal === '262144') codexForm.value.compact = '262144';
      else if (newVal === '500000') codexForm.value.compact = '475000';
      else if (newVal === '1000000') codexForm.value.compact = '950000';
    }

    function formatContext(val) {
      if (!val) return '262K';
      const n = parseInt(val, 10);
      if (isNaN(n)) return String(val);
      if (n >= 1000000) return `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M`;
      if (n >= 1000) return `${Math.round(n / 1024)}K`;
      return String(n);
    }

    const claudePermModeOptions = [
      { value: 'bypassPermissions', label: 'bypassPermissions', desc: '跳过询问，直接执行所有命令' },
      { value: 'acceptEdits', label: 'acceptEdits', desc: '自动接受文件编辑，运行命令前询问' },
      { value: 'default', label: 'default', desc: '标准默认交互模式' },
      { value: 'plan', label: 'plan', desc: '默认进入 Plan 模式' },
      { value: 'auto', label: 'auto', desc: '自动感知模式' },
      { value: 'dontAsk', label: 'dontAsk', desc: '完全静默执行' }
    ];

    const codexProviderSelectOptions = computed(() => (state.value.codex.providers || []).map(p => ({
      value: p.id,
      label: p.name,
      badge: p.id
    })));

    const codexEffortOptions = [
      { value: '', label: '默认 (继承全局)' },
      { value: 'minimal', label: 'MINIMAL (极低)' },
      { value: 'low', label: 'LOW (低)' },
      { value: 'medium', label: 'MEDIUM (中)' },
      { value: 'high', label: 'HIGH (高)' },
      { value: 'xhigh', label: 'XHIGH (超高)' },
      { value: 'max', label: 'MAX (最大思考预算)' }
    ];

    const codexTierOptions = [
      { value: '', label: '默认' },
      { value: 'fast', label: 'fast (极速响应)' },
      { value: 'priority', label: 'priority (高优通道)' }
    ];

    const codexCatalogModeOptions = [
      { value: 'none', label: '内置原生模型 (不外挂独立目录)' },
      { value: 'generate', label: '自动生成专属目录 (为自定义模型生成目录条目)' },
      { value: 'path', label: '指定已有目录文件路径' }
    ];

    const codexApprovalOptions = [
      { value: 'never', label: 'never (永不询问，全自动执行)' },
      { value: 'on-request', label: 'on-request (按需确认)' },
      { value: 'on-failure', label: 'on-failure (仅在失败时询问)' },
      { value: 'untrusted', label: 'untrusted (严格询问每一条命令)' }
    ];

    const codexSandboxOptions = [
      { value: 'danger-full-access', label: 'danger-full-access (全量系统访问，无隔离)' },
      { value: 'workspace-write', label: 'workspace-write (仅限工作区写)' },
      { value: 'read-only', label: 'read-only (只读)' }
    ];

    const codexSummaryOptions = [
      { value: 'none', label: 'none (不展示思考过程)' },
      { value: 'concise', label: 'concise (精简摘要)' },
      { value: 'detailed', label: 'detailed (详细摘要)' },
      { value: 'auto', label: 'auto (自动感知)' }
    ];

    const codexWebSearchOptions = [
      { value: 'disabled', label: 'disabled (关闭)' },
      { value: 'cached', label: 'cached (只读缓存)' },
      { value: 'indexed', label: 'indexed (索引库检索)' },
      { value: 'live', label: 'live (实时联网)' }
    ];

    const codexCatalogOptions = computed(() => [
      { value: '', label: '-- 不使用候选目录 (内置原生) --', desc: '' },
      ...(state.value.codex?.catalogs || []).map(c => ({
        value: c.path,
        label: c.file,
        badge: `${c.models.length} 个模型`,
        desc: c.models.map(m => m.name).slice(0, 3).join(', ') + (c.models.length > 3 ? '...' : '')
      }))
    ]);

    const allAvailableModels = computed(() => {
      const map = new Map();
      for (const p of state.value.providers || []) {
        for (const m of p.models || []) {
          if (!map.has(m.id)) {
            map.set(m.id, {
              value: m.id,
              label: m.name ? `${m.name} (${m.id})` : m.id,
              id: m.id,
              name: m.name || m.id,
              desc: `${p.name} 节点`,
              badge: p.name
            });
          }
        }
      }
      return Array.from(map.values());
    });

    // ------------------------------------------------------------- 1. Ping Health Check
    const pingStatus = ref({}); // key -> { loading, ok, latency_ms, status, error, model }

    async function pingTarget(key, params) {
      pingStatus.value[key] = { loading: true };
      try {
        const res = await api('/api/ping', {
          method: 'POST',
          body: params
        });
        pingStatus.value[key] = {
          loading: false,
          ok: res.ok,
          latency_ms: res.latency_ms,
          status: res.status,
          error: res.error,
          model: res.model
        };
        if (res.ok) {
          showToast(`测活成功 (${res.latency_ms}ms) - ${res.model || ''}`, 'success');
        } else {
          showToast(`测活异常 [${res.status}]: ${res.error || '失败'}`, 'warning');
        }
      } catch (err) {
        pingStatus.value[key] = {
          loading: false,
          ok: false,
          error: err.message,
          status: 500,
          latency_ms: 0
        };
        showToast('测活网络异常: ' + err.message, 'error');
      }
    }

    const pingingAll = ref(false);
    async function pingAllProviders() {
      if (pingingAll.value) return;
      pingingAll.value = true;
      try {
        const res = await api('/api/providers/ping-all', { method: 'POST' });
        if (res.results) {
          for (const [k, v] of Object.entries(res.results)) {
            pingStatus.value[k] = {
              loading: false,
              ok: v.ok,
              latency_ms: v.latency_ms,
              status: v.status,
              error: v.error,
              model: v.model
            };
          }
          const okCount = Object.values(res.results).filter(x => x.ok).length;
          const total = Object.values(res.results).length;
          showToast(`完成全量测活: ${okCount}/${total} 个供应商正常`, okCount === total ? 'success' : 'warning');
        }
      } catch (err) {
        showToast('全量测活失败: ' + err.message, 'error');
      } finally {
        pingingAll.value = false;
      }
    }

    // ------------------------------------------------------------- 2. Sessions & Processes + Tmux Live Console
    const showSessionsModal = ref(false);
    const refreshingSessions = ref(false);

    const showTmuxModal = ref(false);
    const activeTmuxSession = ref('');
    const activeTmuxTarget = ref('');
    const tmuxTerminalText = ref('');
    const tmuxTerminalLines = ref(100);
    const tmuxLoadingPane = ref(false);
    const tmuxAutoPoll = ref(true);
    const tmuxDispatchText = ref('');
    const tmuxSending = ref(false);

    // New Window Modal state
    const showNewTmuxWindowModal = ref(false);
    const newTmuxWindowForm = ref({ session: '', name: 'shell', path: '' });
    const creatingTmuxWindow = ref(false);

    // Kill Window Modal state
    const showKillTmuxWindowModal = ref(false);
    const windowToKill = ref(null);
    const killingTmuxWindow = ref(false);

    const totalTmuxWindows = computed(() => {
      const list = state.value.sessions?.tmux || [];
      return list.reduce((acc, s) => acc + (s.windows?.length || s.windowCount || 1), 0);
    });

    const totalIdleTmuxWindows = computed(() => {
      const list = state.value.sessions?.tmux || [];
      return list.reduce((acc, s) => acc + (s.idleCount || 0), 0);
    });

    const currentSessionWindows = computed(() => {
      const list = state.value.sessions?.tmux || [];
      const sess = list.find(s => s.name === activeTmuxSession.value);
      return sess?.windows || [];
    });

    const quickPrompts = [
      'git status',
      '/clear',
      '/compact',
      '/doctor',
      '全面代码审查并找出潜在 bug 与暗坑',
      '编写针对当前模块的自动化测试用例',
      '遵循项目规范修复并留痕日志'
    ];
    let tmuxPollTimer = null;

    async function refreshSessions() {
      refreshingSessions.value = true;
      try {
        const res = await api('/api/system/sessions');
        state.value.sessions = res;
      } catch (err) {
        showToast('获取会话失败: ' + err.message, 'error');
      } finally {
        refreshingSessions.value = false;
      }
    }

    async function loadTmuxPane() {
      const target = activeTmuxTarget.value || activeTmuxSession.value;
      if (!target) return;
      tmuxLoadingPane.value = true;
      try {
        const res = await api(`/api/tmux/pane?target=${encodeURIComponent(target)}&lines=${tmuxTerminalLines.value}`);
        tmuxTerminalText.value = res.text || '（终端暂无输出）';
        setTimeout(() => {
          const el = document.getElementById('tmux-term-viewport');
          if (el) el.scrollTop = el.scrollHeight;
        }, 50);
      } catch (err) {
        tmuxTerminalText.value = `[错误] 无法获取 Tmux 终端内容: ${err.message}`;
      } finally {
        tmuxLoadingPane.value = false;
      }
    }

    function openTmuxConsole(targetOrSession) {
      if (targetOrSession && String(targetOrSession).includes(':')) {
        const parts = String(targetOrSession).split(':');
        activeTmuxSession.value = parts[0];
        activeTmuxTarget.value = targetOrSession;
      } else if (targetOrSession) {
        activeTmuxSession.value = targetOrSession;
        const s = (state.value.sessions?.tmux || []).find(x => x.name === targetOrSession);
        activeTmuxTarget.value = s?.windows?.[0]?.target || targetOrSession;
      } else if (state.value.sessions?.tmux?.length) {
        const s = state.value.sessions.tmux[0];
        activeTmuxSession.value = s.name;
        activeTmuxTarget.value = s.windows?.[0]?.target || s.name;
      } else {
        activeTmuxSession.value = 'cc';
        activeTmuxTarget.value = 'cc';
      }
      showSessionsModal.value = false;
      showTmuxModal.value = true;
      loadTmuxPane();

      clearInterval(tmuxPollTimer);
      tmuxPollTimer = setInterval(() => {
        if (showTmuxModal.value && tmuxAutoPoll.value) {
          loadTmuxPane();
        }
      }, 2500);
    }

    function switchTmuxSession(sessName) {
      activeTmuxSession.value = sessName;
      const s = (state.value.sessions?.tmux || []).find(x => x.name === sessName);
      activeTmuxTarget.value = s?.windows?.[0]?.target || sessName;
      loadTmuxPane();
    }

    function switchTmuxWindow(win) {
      if (!win) return;
      activeTmuxTarget.value = win.target;
      loadTmuxPane();
    }

    function closeTmuxConsole() {
      clearInterval(tmuxPollTimer);
      showTmuxModal.value = false;
    }

    async function sendTmuxCommand(cmdText) {
      const target = activeTmuxTarget.value || activeTmuxSession.value;
      const text = (cmdText !== undefined ? cmdText : tmuxDispatchText.value) || '';
      if (!text.trim() && cmdText === undefined) return;
      tmuxSending.value = true;
      try {
        await api('/api/tmux/send', {
          method: 'POST',
          body: {
            target,
            text,
            enter: true,
          }
        });
        if (cmdText === undefined) tmuxDispatchText.value = '';
        showToast(`已向 Tmux [${target}] 发送指令`, 'success');
        setTimeout(() => loadTmuxPane(), 350);
      } catch (err) {
        showToast('发送指令失败: ' + err.message, 'error');
      } finally {
        tmuxSending.value = false;
      }
    }

    async function sendTmuxSignal(sig) {
      const target = activeTmuxTarget.value || activeTmuxSession.value;
      try {
        await api('/api/tmux/signal', {
          method: 'POST',
          body: {
            target,
            signal: sig,
          }
        });
        showToast(`已向 [${target}] 发送控制信号 ${sig.toUpperCase()}`, 'info');
        setTimeout(() => loadTmuxPane(), 350);
      } catch (err) {
        showToast('发送信号失败: ' + err.message, 'error');
      }
    }

    function promptNewTmuxWindow(sessionName) {
      newTmuxWindowForm.value = {
        session: sessionName || activeTmuxSession.value || (state.value.sessions?.tmux?.[0]?.name || 'cc'),
        name: 'shell',
        path: '',
      };
      showNewTmuxWindowModal.value = true;
    }

    async function executeCreateTmuxWindow() {
      if (!newTmuxWindowForm.value.session) {
        showToast('请选择目标会话', 'warning');
        return;
      }
      creatingTmuxWindow.value = true;
      try {
        await api('/api/tmux/window/create', {
          method: 'POST',
          body: newTmuxWindowForm.value,
        });
        showToast(`已在会话 "${newTmuxWindowForm.value.session}" 中新建窗口`, 'success');
        showNewTmuxWindowModal.value = false;
        await refreshSessions();
        const s = (state.value.sessions?.tmux || []).find(x => x.name === newTmuxWindowForm.value.session);
        if (s && s.windows?.length) {
          const lastWin = s.windows[s.windows.length - 1];
          activeTmuxSession.value = s.name;
          activeTmuxTarget.value = lastWin.target;
        }
        if (showTmuxModal.value) loadTmuxPane();
      } catch (err) {
        showToast('新建窗口失败: ' + err.message, 'error');
      } finally {
        creatingTmuxWindow.value = false;
      }
    }

    function promptKillTmuxWindow(target, name) {
      windowToKill.value = { target, name: name || target };
      showKillTmuxWindowModal.value = true;
    }

    async function executeKillTmuxWindow() {
      if (!windowToKill.value) return;
      killingTmuxWindow.value = true;
      try {
        await api('/api/tmux/window/kill', {
          method: 'POST',
          body: { target: windowToKill.value.target }
        });
        showToast(`已关闭 Tmux 窗口: ${windowToKill.value.target}`, 'success');
        showKillTmuxWindowModal.value = false;
        await refreshSessions();
        if (activeTmuxTarget.value === windowToKill.value.target) {
          const s = (state.value.sessions?.tmux || []).find(x => x.name === activeTmuxSession.value);
          activeTmuxTarget.value = s?.windows?.[0]?.target || activeTmuxSession.value;
        }
        if (showTmuxModal.value) loadTmuxPane();
      } catch (err) {
        showToast('关闭窗口失败: ' + err.message, 'error');
      } finally {
        killingTmuxWindow.value = false;
        windowToKill.value = null;
      }
    }

    async function killTmux(name) {
      if (!confirm(`确定要关闭 Tmux 会话 "${name}" 吗？`)) return;
      try {
        await api('/api/system/sessions/kill-tmux', { method: 'POST', body: { name } });
        showToast(`已关闭 Tmux 会话: ${name}`, 'success');
        await refreshSessions();
      } catch (err) {
        showToast('关闭会话失败: ' + err.message, 'error');
      }
    }

    const cleaningIdleWindows = ref(false);

    async function closeCurrentTmuxWindow() {
      const target = activeTmuxTarget.value || activeTmuxSession.value;
      if (!target) return;
      if (!confirm(`确定要在网页直接关闭 Tmux 窗口 "${target}" 吗？`)) return;
      try {
        await api('/api/tmux/window/kill', {
          method: 'POST',
          body: { target }
        });
        showToast(`已直接关闭窗口: ${target}`, 'success');
        await refreshSessions();
        const sess = (state.value.sessions?.tmux || []).find(x => x.name === activeTmuxSession.value);
        if (sess && sess.windows?.length) {
          activeTmuxTarget.value = sess.windows[0].target;
          loadTmuxPane();
        } else {
          closeTmuxConsole();
        }
      } catch (err) {
        showToast('关闭窗口失败: ' + err.message, 'error');
      }
    }

    async function closeCurrentTmuxSession() {
      const sessName = activeTmuxSession.value;
      if (!sessName) return;
      if (!confirm(`确定要直接终止并销毁整个 Tmux 会话 "${sessName}" 吗？所有关联窗口都将被关闭。`)) return;
      try {
        await api('/api/system/sessions/kill-tmux', {
          method: 'POST',
          body: { name: sessName }
        });
        showToast(`已销毁 Tmux 会话: ${sessName}`, 'success');
        closeTmuxConsole();
        await refreshSessions();
      } catch (err) {
        showToast('关闭会话失败: ' + err.message, 'error');
      }
    }

    async function promptNewTmuxSession() {
      const name = prompt('请输入新 Tmux 会话名称 (如 work / agent / dev):', 'work');
      if (!name || !name.trim()) return;
      try {
        await api('/api/tmux/session/create', {
          method: 'POST',
          body: { name: name.trim() }
        });
        showToast(`已成功创建 Tmux 会话: ${name.trim()}`, 'success');
        await refreshSessions();
      } catch (err) {
        showToast('创建会话失败: ' + err.message, 'error');
      }
    }

    async function broadcastTmuxPrompt() {
      const cmd = prompt('向当前所有终端窗口广播指令或 Prompt (例如 /compact 或 /clear):', '/compact');
      if (!cmd || !cmd.trim()) return;
      try {
        const res = await api('/api/tmux/broadcast', {
          method: 'POST',
          body: { text: cmd.trim() }
        });
        showToast(`已向 ${res.count} 个终端窗口广播指令: ${cmd.trim()}`, 'success');
        if (showTmuxModal.value) await loadTmuxPane();
      } catch (err) {
        showToast('广播指令失败: ' + err.message, 'error');
      }
    }

    async function killTmuxWindowDirect(target, name) {
      if (!confirm(`确定要直接关闭窗口 "${name || target}" (${target}) 吗？`)) return;
      try {
        await api('/api/tmux/window/kill', {
          method: 'POST',
          body: { target }
        });
        showToast(`已关闭窗口: ${target}`, 'success');
        await refreshSessions();
        if (activeTmuxTarget.value === target) {
          const s = (state.value.sessions?.tmux || []).find(x => x.name === activeTmuxSession.value);
          activeTmuxTarget.value = s?.windows?.[0]?.target || activeTmuxSession.value;
        }
      } catch (err) {
        showToast('关闭窗口失败: ' + err.message, 'error');
      }
    }

    async function cleanAllIdleWindows() {
      if (!confirm(`确定要一键清理关闭所有未使用的空闲终端窗口吗？`)) return;
      cleaningIdleWindows.value = true;
      try {
        const res = await api('/api/tmux/clean-idle', { method: 'POST' });
        showToast(`已安全清理 ${res.closedCount || 0} 个空闲待命窗口`, 'success');
        await refreshSessions();
        if (showTmuxModal.value) {
          const sess = (state.value.sessions?.tmux || []).find(x => x.name === activeTmuxSession.value);
          if (!sess || !sess.windows?.length) {
            closeTmuxConsole();
          } else {
            activeTmuxTarget.value = sess.windows[0].target;
            loadTmuxPane();
          }
        }
      } catch (err) {
        showToast('清理空闲窗口失败: ' + err.message, 'error');
      } finally {
        cleaningIdleWindows.value = false;
      }
    }

    async function killProcess(pid) {
      if (!confirm(`确定要终止 PID ${pid} 的进程吗？`)) return;
      try {
        await api('/api/system/sessions/kill-process', { method: 'POST', body: { pid } });
        showToast(`已终止进程 PID: ${pid}`, 'success');
        await refreshSessions();
      } catch (err) {
        showToast('终止进程失败: ' + err.message, 'error');
      }
    }

    function copyText(txt) {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(txt).then(() => {
          showToast('已复制命令到剪贴板: ' + txt, 'success');
        }).catch(() => {
          prompt('请按 Ctrl+C 复制:', txt);
        });
      } else {
        prompt('请按 Ctrl+C 复制:', txt);
      }
    }

    // ------------------------------------------------------------- 3. Skills Manager
    const skillFilter = ref('');
    const showSkillDrawer = ref(false);
    const savingSkill = ref(false);
    const skillForm = ref({
      id: '',
      name: '',
      description: '',
      content: '',
      targets: ['claude', 'codex'],
      isNew: false
    });

    const filteredSkills = computed(() => {
      const all = state.value.skills || [];
      const q = skillFilter.value.trim().toLowerCase();
      if (!q) return all;
      return all.filter(s =>
        (s.id && s.id.toLowerCase().includes(q)) ||
        (s.name && s.name.toLowerCase().includes(q)) ||
        (s.description && s.description.toLowerCase().includes(q))
      );
    });

    function openAddSkill() {
      skillForm.value = {
        id: '',
        name: '',
        description: '',
        content: '# 技能核心提示词与步骤\n\n在此输入技能的工作流指南与纪律...',
        targets: ['claude', 'codex'],
        isNew: true
      };
      showSkillDrawer.value = true;
    }

    function openEditSkill(skill) {
      skillForm.value = {
        id: skill.id,
        name: skill.name || skill.id,
        description: skill.description || '',
        content: skill.fullContent || '',
        targets: skill.targets ? [...skill.targets] : ['claude', 'codex'],
        isNew: false
      };
      showSkillDrawer.value = true;
    }

    async function saveSkill() {
      if (!skillForm.value.id) {
        showToast('Skill ID 必填', 'error');
        return;
      }
      if (!skillForm.value.targets.length) {
        showToast('请至少选择一个安装目标环境', 'error');
        return;
      }
      savingSkill.value = true;
      try {
        await api('/api/skills', {
          method: 'POST',
          body: skillForm.value
        });
        showToast(`技能「${skillForm.value.id}」保存成功`, 'success');
        showSkillDrawer.value = false;
        const res = await api('/api/skills');
        state.value.skills = res.skills;
      } catch (err) {
        showToast('保存技能失败: ' + err.message, 'error');
      } finally {
        savingSkill.value = false;
      }
    }

    async function deleteSkill(skill, target = 'all') {
      const targetLabel = target === 'all' ? '全部环境' : target;
      if (!confirm(`确定从 ${targetLabel} 彻底删除技能「${skill.id}」吗？`)) return;
      try {
        await api(`/api/skills/${target}/${skill.id}`, { method: 'DELETE' });
        showToast(`已删除技能「${skill.id}」`, 'success');
        const res = await api('/api/skills');
        state.value.skills = res.skills;
      } catch (err) {
        showToast('删除技能失败: ' + err.message, 'error');
      }
    }

    // ------------------------------------------------------------- 4. MCP Manager
    const showMcpModal = ref(false);
    const savingMcp = ref(false);
    const mcpForm = ref({
      id: '',
      oldId: '',
      command: '',
      args: '',
      envText: '',
      disabled: false,
      isNew: false
    });

    function openAddMcp() {
      mcpForm.value = {
        id: '',
        oldId: '',
        command: 'node',
        args: '',
        envText: '',
        disabled: false,
        isNew: true
      };
      showMcpModal.value = true;
    }

    function openEditMcp(srv) {
      let envStr = '';
      if (srv.env && typeof srv.env === 'object') {
        envStr = Object.entries(srv.env).map(([k, v]) => `${k}=${v}`).join('\n');
      }
      mcpForm.value = {
        id: srv.id,
        oldId: srv.id,
        command: srv.command || '',
        args: (srv.args || []).join(' '),
        envText: envStr,
        disabled: !!srv.disabled,
        isNew: false
      };
      showMcpModal.value = true;
    }

    async function toggleMcp(srv) {
      try {
        await api('/api/mcp', {
          method: 'POST',
          body: {
            ...srv,
            disabled: !srv.disabled
          }
        });
        showToast(`已${srv.disabled ? '启用' : '禁用'} MCP 服务「${srv.id}」`, 'success');
        const res = await api('/api/mcp');
        state.value.mcp = res.servers;
      } catch (err) {
        showToast('切换 MCP 状态失败: ' + err.message, 'error');
      }
    }

    async function saveMcp() {
      if (!mcpForm.value.id) {
        showToast('MCP 服务名称必填', 'error');
        return;
      }
      if (!mcpForm.value.command) {
        showToast('执行命令 (command) 必填', 'error');
        return;
      }
      const envObj = {};
      if (mcpForm.value.envText) {
        mcpForm.value.envText.split('\n').forEach(line => {
          const idx = line.indexOf('=');
          if (idx > 0) {
            envObj[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
          }
        });
      }
      savingMcp.value = true;
      try {
        await api('/api/mcp', {
          method: 'POST',
          body: {
            id: mcpForm.value.id,
            oldId: mcpForm.value.oldId,
            command: mcpForm.value.command,
            args: mcpForm.value.args.trim().split(/\s+/).filter(Boolean),
            env: envObj,
            disabled: mcpForm.value.disabled
          }
        });
        showToast(`MCP 服务「${mcpForm.value.id}」保存成功`, 'success');
        showMcpModal.value = false;
        const res = await api('/api/mcp');
        state.value.mcp = res.servers;
      } catch (err) {
        showToast('保存 MCP 失败: ' + err.message, 'error');
      } finally {
        savingMcp.value = false;
      }
    }

    async function deleteMcp(id) {
      if (!confirm(`确定要移除 MCP 服务「${id}」吗？`)) return;
      try {
        await api(`/api/mcp/${id}`, { method: 'DELETE' });
        showToast(`已移除 MCP 服务「${id}」`, 'success');
        const res = await api('/api/mcp');
        state.value.mcp = res.servers;
      } catch (err) {
        showToast('移除 MCP 失败: ' + err.message, 'error');
      }
    }

    // ------------------------------------------------------------- 5. Git Inspector
    const gitRepos = ref([]);
    const loadingGit = ref(false);
    const selectedRepo = ref(null);
    const repoDiff = ref(null);
    const loadingDiff = ref(false);
    const showDiffDrawer = ref(false);
    const commitMsg = ref('');
    const actingGit = ref(false);

    async function loadGitRepos() {
      loadingGit.value = true;
      try {
        const res = await api('/api/git/repos');
        gitRepos.value = res.repos || [];
      } catch (err) {
        showToast('获取 Git 仓库失败: ' + err.message, 'error');
      } finally {
        loadingGit.value = false;
      }
    }

    async function openRepoDiff(repo) {
      selectedRepo.value = repo;
      repoDiff.value = null;
      commitMsg.value = '';
      showDiffDrawer.value = true;
      loadingDiff.value = true;
      try {
        const res = await api(`/api/git/diff?repo=${encodeURIComponent(repo.id)}`);
        repoDiff.value = res;
      } catch (err) {
        showToast('获取 Diff 失败: ' + err.message, 'error');
      } finally {
        loadingDiff.value = false;
      }
    }

    async function doGitAction(action, extraParams = {}) {
      if (!selectedRepo.value) return;
      actingGit.value = true;
      try {
        const res = await api('/api/git/action', {
          method: 'POST',
          body: {
            repo: selectedRepo.value.id,
            action,
            ...extraParams
          }
        });
        showToast(res.message || '操作成功', 'success');
        if (action === 'commit') commitMsg.value = '';
        await Promise.all([
          api(`/api/git/diff?repo=${encodeURIComponent(selectedRepo.value.id)}`).then(d => { repoDiff.value = d; }),
          loadGitRepos()
        ]);
      } catch (err) {
        showToast('Git 操作失败: ' + err.message, 'error');
      } finally {
        actingGit.value = false;
      }
    }

    // ------------------------------------------------------------- 6. Session & Usage Inspector
    const usageSummary = ref({ totals: {}, top_models: [], sessions: [] });
    const loadingUsage = ref(false);
    const selectedSession = ref(null);
    const sessionDetail = ref(null);
    const loadingSessionDetail = ref(false);
    const showSessionModal = ref(false);
    const selectedSessionIds = ref([]);
    const sessionSearch = ref('');
    const sessionClientFilter = ref(''); // '' | 'claude' | 'codex'
    const showDeleteSessionModal = ref(false);
    const sessionToDelete = ref(null);
    const deletingSession = ref(false);
    const showCleanOldSessionsModal = ref(false);
    const cleanOldDays = ref(30);
    const cleaningOldSessions = ref(false);
    const cleaningEmptySessions = ref(false);

    const filteredSessions = computed(() => {
      const list = usageSummary.value?.sessions || [];
      const q = sessionSearch.value.trim().toLowerCase();
      const cf = sessionClientFilter.value;
      return list.filter(s => {
        if (cf === 'zero') {
          if ((s.total_tokens || 0) > 0) return false;
        } else if (cf && s.type !== cf) {
          return false;
        }
        if (!q) return true;
        return (
          (s.project || '').toLowerCase().includes(q) ||
          (s.first_prompt || '').toLowerCase().includes(q) ||
          (s.model || '').toLowerCase().includes(q) ||
          (s.id || '').toLowerCase().includes(q)
        );
      });
    });

    const isAllSessionsSelected = computed(() => {
      const f = filteredSessions.value;
      if (!f.length) return false;
      return f.every(s => selectedSessionIds.value.includes(s.id));
    });

    function toggleSelectSession(id) {
      const idx = selectedSessionIds.value.indexOf(id);
      if (idx >= 0) {
        selectedSessionIds.value.splice(idx, 1);
      } else {
        selectedSessionIds.value.push(id);
      }
    }

    function toggleSelectAllSessions() {
      const f = filteredSessions.value;
      if (isAllSessionsSelected.value) {
        selectedSessionIds.value = [];
      } else {
        selectedSessionIds.value = f.map(s => s.id);
      }
    }

    function confirmDeleteSession(s) {
      sessionToDelete.value = s;
      showDeleteSessionModal.value = true;
    }

    async function executeDeleteSession() {
      if (!sessionToDelete.value) return;
      deletingSession.value = true;
      try {
        const s = sessionToDelete.value;
        const res = await api('/api/usage/session/delete', {
          method: 'POST',
          body: { id: s.id, file_path: s.file_path },
        });
        showToast(`已删除会话，释放 ${res.freedFormatted || '空间'}`, 'success');
        showDeleteSessionModal.value = false;
        if (showSessionModal.value && selectedSession.value?.id === s.id) {
          showSessionModal.value = false;
        }
        selectedSessionIds.value = selectedSessionIds.value.filter(id => id !== s.id);
        await loadUsage();
      } catch (err) {
        showToast('删除会话失败: ' + err.message, 'error');
      } finally {
        deletingSession.value = false;
      }
    }

    async function deleteSelectedSessions() {
      if (!selectedSessionIds.value.length) return;
      const count = selectedSessionIds.value.length;
      if (!confirm(`确定要批量删除选中的 ${count} 个历史会话记录吗？日志文件将被永久移除并释放磁盘空间。`)) {
        return;
      }
      deletingSession.value = true;
      try {
        const res = await api('/api/usage/session/delete-batch', {
          method: 'POST',
          body: { ids: selectedSessionIds.value },
        });
        showToast(`已批量删除 ${res.deletedCount || count} 个会话，释放 ${res.freedFormatted || '空间'}`, 'success');
        selectedSessionIds.value = [];
        await loadUsage();
      } catch (err) {
        showToast('批量删除会话失败: ' + err.message, 'error');
      } finally {
        deletingSession.value = false;
      }
    }

    async function cleanOldSessions(days) {
      cleaningOldSessions.value = true;
      try {
        const res = await api('/api/usage/session/delete-batch', {
          method: 'POST',
          body: { older_than_days: days },
        });
        showToast(`已清理 ${res.deletedCount || 0} 个超过 ${days} 天的旧会话，释放 ${res.freedFormatted || '0 B'}`, 'success');
        showCleanOldSessionsModal.value = false;
        selectedSessionIds.value = [];
        await loadUsage();
      } catch (err) {
        showToast('清理旧会话失败: ' + err.message, 'error');
      } finally {
        cleaningOldSessions.value = false;
      }
    }

    async function executeCleanEmptySessions() {
      const zeroCount = usageSummary.value?.totals?.zero_sessions_count || 0;
      const msg = zeroCount > 0
        ? `检测到 ${zeroCount} 个未产生任何 Token 消耗的空白/异常测试会话，确定一键清除吗？`
        : '确定要扫描并清理所有未消耗任何 Token 的空白会话吗？';
      if (!confirm(msg)) return;

      cleaningEmptySessions.value = true;
      try {
        const res = await api('/api/usage/session/clean-empty', { method: 'POST' });
        showToast(`成功清理 ${res.deletedCount || 0} 个空白会话，释放 ${res.freedFormatted || '0 B'} 空间`, 'success');
        showCleanOldSessionsModal.value = false;
        selectedSessionIds.value = [];
        await loadUsage();
      } catch (err) {
        showToast('清理空白会话失败: ' + err.message, 'error');
      } finally {
        cleaningEmptySessions.value = false;
      }
    }

    async function loadUsage() {
      loadingUsage.value = true;
      try {
        const res = await api('/api/usage/summary');
        usageSummary.value = res;
      } catch (err) {
        showToast('获取用量统计失败: ' + err.message, 'error');
      } finally {
        loadingUsage.value = false;
      }
    }

    async function openSessionDetail(s) {
      selectedSession.value = s;
      sessionDetail.value = null;
      showSessionModal.value = true;
      loadingSessionDetail.value = true;
      try {
        const res = await api(`/api/usage/session/${encodeURIComponent(s.id)}`);
        sessionDetail.value = res;
      } catch (err) {
        showToast('获取会话详情失败: ' + err.message, 'error');
      } finally {
        loadingSessionDetail.value = false;
      }
    }

    // ------------------------------------------------------------- 7. Memory & Rules Manager
    const memories = ref([]);
    const rules = ref([]);
    const loadingMemory = ref(false);
    const memoryTab = ref('memories'); // 'memories' | 'rules'
    const memoryFilter = ref('');
    const showMemoryDrawer = ref(false);
    const memoryForm = ref({
      slug: '',
      name: '',
      description: '',
      type: 'reference',
      body: '',
      isNew: false
    });
    const savingMemory = ref(false);
    const showRuleModal = ref(false);
    const ruleForm = ref({ id: '', name: '', path: '', content: '' });
    const savingRule = ref(false);

    const filteredMemories = computed(() => {
      const q = memoryFilter.value.trim().toLowerCase();
      if (!q) return memories.value;
      return memories.value.filter(m =>
        (m.slug || '').toLowerCase().includes(q) ||
        (m.name || '').toLowerCase().includes(q) ||
        (m.description || '').toLowerCase().includes(q) ||
        (m.type || '').toLowerCase().includes(q)
      );
    });

    async function loadMemory() {
      loadingMemory.value = true;
      try {
        const res = await api('/api/memory');
        memories.value = res.memories || [];
        rules.value = res.rules || [];
      } catch (err) {
        showToast('获取记忆与规则失败: ' + err.message, 'error');
      } finally {
        loadingMemory.value = false;
      }
    }

    function openAddMemory() {
      memoryForm.value = {
        slug: '',
        name: '',
        description: '',
        type: 'project',
        body: '',
        isNew: true
      };
      showMemoryDrawer.value = true;
    }

    function openEditMemory(m) {
      memoryForm.value = {
        slug: m.slug,
        name: m.name || m.slug,
        description: m.description || '',
        type: m.type || 'reference',
        body: m.body || '',
        isNew: false
      };
      showMemoryDrawer.value = true;
    }

    async function saveMemoryItem() {
      if (!memoryForm.value.slug) {
        showToast('请输入记忆标识 (slug)', 'error');
        return;
      }
      savingMemory.value = true;
      try {
        await api('/api/memory/item', {
          method: 'POST',
          body: memoryForm.value
        });
        showToast(`记忆「${memoryForm.value.slug}」保存成功`, 'success');
        showMemoryDrawer.value = false;
        await loadMemory();
      } catch (err) {
        showToast('保存记忆失败: ' + err.message, 'error');
      } finally {
        savingMemory.value = false;
      }
    }

    async function deleteMemoryItem(m) {
      if (!confirm(`确定彻底删除记忆条目「${m.slug}」并清理索引吗？`)) return;
      try {
        await api(`/api/memory/item/${encodeURIComponent(m.slug)}`, { method: 'DELETE' });
        showToast(`已删除记忆「${m.slug}」`, 'success');
        await loadMemory();
      } catch (err) {
        showToast('删除记忆失败: ' + err.message, 'error');
      }
    }

    async function openEditRule(rule) {
      try {
        const res = await api(`/api/memory/rule/${encodeURIComponent(rule.id)}`);
        ruleForm.value = {
          id: res.id,
          name: res.name,
          path: res.path,
          content: res.content
        };
        showRuleModal.value = true;
      } catch (err) {
        showToast('读取规则文件失败: ' + err.message, 'error');
      }
    }

    async function saveRuleContent() {
      savingRule.value = true;
      try {
        await api('/api/memory/rule', {
          method: 'POST',
          body: {
            id: ruleForm.value.id,
            content: ruleForm.value.content
          }
        });
        showToast('规则文件已更新 (已自动备份原文件)', 'success');
        showRuleModal.value = false;
        await loadMemory();
      } catch (err) {
        showToast('保存规则文件失败: ' + err.message, 'error');
      } finally {
        savingRule.value = false;
      }
    }

    // ------------------------------------------------------------- 8. CLI Doctor
    const doctorItems = ref([]);
    const loadingDoctor = ref(false);
    const doctorFixing = ref({});

    async function loadDoctor() {
      loadingDoctor.value = true;
      try {
        const res = await api('/api/doctor');
        doctorItems.value = res.diagnostics || [];
      } catch (err) {
        showToast('获取环境诊断失败: ' + err.message, 'error');
      } finally {
        loadingDoctor.value = false;
      }
    }

    async function runDoctorFix(item) {
      doctorFixing.value[item.id] = true;
      try {
        const res = await api('/api/doctor/fix', {
          method: 'POST',
          body: { id: item.id }
        });
        showToast(res.message || '修复成功', 'success');
        await loadDoctor();
      } catch (err) {
        showToast('修复失败: ' + err.message, 'error');
      } finally {
        doctorFixing.value[item.id] = false;
      }
    }

    // ------------------------------------------------------------- 9. CLI Logs
    const logsSubTab = ref('prompts'); // 'prompts' | 'errors' | 'daemon'
    const logsSearch = ref('');
    const logsClientFilter = ref(''); // '' | 'claude' | 'codex'
    const logsAutoPoll = ref(false);
    let logsPollTimer = null;

    const promptsList = ref([]);
    const loadingPrompts = ref(false);

    const errorsList = ref([]);
    const loadingErrors = ref(false);

    const daemonSource = ref('pm2');
    const daemonLines = ref(150);
    const daemonLogs = ref({ text: '', updated: '', lines: 150 });
    const loadingDaemon = ref(false);

    const expandedLogId = ref(null);

    async function loadPrompts() {
      loadingPrompts.value = true;
      try {
        const q = encodeURIComponent(logsSearch.value || '');
        const c = encodeURIComponent(logsClientFilter.value || '');
        const res = await api(`/api/logs/prompts?limit=80&search=${q}&client=${c}`);
        promptsList.value = res || [];
      } catch (err) {
        showToast('读取 Prompt 历史失败: ' + err.message, 'error');
      } finally {
        loadingPrompts.value = false;
      }
    }

    async function loadErrors() {
      loadingErrors.value = true;
      try {
        const q = encodeURIComponent(logsSearch.value || '');
        const res = await api(`/api/logs/errors?limit=50&search=${q}`);
        errorsList.value = res || [];
      } catch (err) {
        showToast('读取异常日志失败: ' + err.message, 'error');
      } finally {
        loadingErrors.value = false;
      }
    }

    async function loadDaemonLogs() {
      loadingDaemon.value = true;
      try {
        const s = encodeURIComponent(daemonSource.value || 'pm2');
        const l = encodeURIComponent(daemonLines.value || 150);
        const res = await api(`/api/logs/daemon?lines=${l}&source=${s}`);
        daemonLogs.value = res || { text: '', updated: '', lines: 150 };
        setTimeout(() => {
          const el = document.getElementById('daemon-log-viewport');
          if (el) el.scrollTop = el.scrollHeight;
        }, 50);
      } catch (err) {
        showToast('读取运行日志失败: ' + err.message, 'error');
      } finally {
        loadingDaemon.value = false;
      }
    }

    function refreshLogs() {
      if (logsSubTab.value === 'prompts') loadPrompts();
      else if (logsSubTab.value === 'errors') loadErrors();
      else if (logsSubTab.value === 'daemon') loadDaemonLogs();
    }

    function toggleLogExpand(id) {
      expandedLogId.value = expandedLogId.value === id ? null : id;
    }

    function toggleLogsAutoPoll() {
      logsAutoPoll.value = !logsAutoPoll.value;
      if (logsAutoPoll.value) {
        showToast('已开启日志自动轮询 (4s)', 'info');
        clearInterval(logsPollTimer);
        logsPollTimer = setInterval(() => {
          if (currentTab.value === 'logs') {
            refreshLogs();
          }
        }, 4000);
      } else {
        clearInterval(logsPollTimer);
        showToast('已停止日志自动轮询', 'info');
      }
    }

    function formatLogTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const now = Date.now();
      const diffSec = Math.floor((now - d.getTime()) / 1000);
      if (diffSec < 60) return `${Math.max(1, diffSec)}秒前`;
      if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前`;
      if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}小时前`;
      return `${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    }

    function copyPromptText(text) {
      copyText(text);
      showToast('Prompt 已复制到剪贴板', 'success');
    }

    // ------------------------------------------------------------- 10. Disk Cleaner
    const cleanerSubTab = ref('categories'); // 'categories' | 'large-files' | 'large-dirs'
    const cleanerScanning = ref(false);
    const cleanerCleaning = ref(false);
    const cleanerScanData = ref({
      disk: { totalGb: 40, usedGb: 28, availGb: 12, percent: 70 },
      categories: [],
      totalJunkBytes: 0,
      formattedTotalJunk: '0 B',
      safeJunkBytes: 0,
      formattedSafeJunk: '0 B',
      potentialSavedGb: 0,
      predictedPercent: 70
    });
    const selectedJunkCategories = ref([]);
    const showCleanConfirmModal = ref(false);
    const largeFiles = ref([]);
    const loadingLargeFiles = ref(false);
    const largeDirs = ref([]);
    const loadingLargeDirs = ref(false);
    const expandedJunkCatId = ref(null);

    // ------------------------------------------------------------- Global Spotlight Command Palette (Ctrl+K)
    const showPalette = ref(false);
    const paletteQuery = ref('');
    const paletteSelectedIndex = ref(0);

    const ALL_PALETTE_ITEMS = [
      { id: 'nav_claude', group: '功能面板跳转', title: 'Claude Code 启动器与参数', icon: '🚀', action: () => { currentTab.value = 'claude'; } },
      { id: 'nav_codex', group: '功能面板跳转', title: 'Codex CLI Profiles 配置', icon: '⚡', action: () => { currentTab.value = 'codex'; } },
      { id: 'nav_prov', group: '功能面板跳转', title: '供应商与多模型路由库', icon: '🌐', action: () => { currentTab.value = 'providers'; } },
      { id: 'nav_skills', group: '功能面板跳转', title: '跨客户端 Skills 技能管理', icon: '📦', action: () => { currentTab.value = 'skills'; } },
      { id: 'nav_mcp', group: '功能面板跳转', title: 'MCP 扩展服务中心', icon: '🔌', action: () => { currentTab.value = 'mcp'; } },
      { id: 'nav_git', group: '功能面板跳转', title: 'Git 仓库状态与代码 Diff', icon: '🔍', action: () => { currentTab.value = 'git'; loadGitRepos(); } },
      { id: 'nav_usage', group: '功能面板跳转', title: '会话历史与 Token 审计', icon: '📊', action: () => { currentTab.value = 'usage'; loadUsage(); } },
      { id: 'nav_cleaner', group: '功能面板跳转', title: '手机管家式磁盘清理', icon: '🧹', action: () => { currentTab.value = 'cleaner'; scanJunk(); } },
      { id: 'nav_memory', group: '功能面板跳转', title: '记忆库与项目协作准则', icon: '🧠', action: () => { currentTab.value = 'memory'; loadMemory(); } },
      { id: 'nav_doctor', group: '功能面板跳转', title: '系统环境全面自检 (Doctor)', icon: '🩺', action: () => { currentTab.value = 'doctor'; loadDoctor(); } },
      { id: 'nav_logs', group: '功能面板跳转', title: 'CLI 历史 Prompt 与终端日志', icon: '📋', action: () => { currentTab.value = 'logs'; refreshLogs(); } },
      { id: 'nav_backups', group: '功能面板跳转', title: '配置快照历史与全量导出', icon: '💾', action: () => { currentTab.value = 'backups'; loadBackups(); } },
      // Quick Actions
      { id: 'act_ping_all', group: '快捷动作指令', title: '⚡ 一键测活全部供应商端点', icon: '⚡', action: () => { pingAllProviders(); } },
      { id: 'act_tmux_console', group: '快捷动作指令', title: '📺 打开 Tmux 实时终端监视', icon: '📺', action: () => { openTmuxConsole(); } },
      { id: 'act_tmux_clean', group: '快捷动作指令', title: '🛑 一键关闭所有空闲 Tmux 窗口', icon: '🛑', action: () => { cleanAllIdleWindows(); } },
      { id: 'act_clean_empty', group: '快捷动作指令', title: '🧹 清理 0 Token 空白异常会话', icon: '🧹', action: () => { currentTab.value = 'usage'; executeCleanEmptySessions(); } },
      { id: 'act_export_all', group: '快捷动作指令', title: '💾 导出全量环境配置快照 (JSON)', icon: '💾', action: () => { downloadFullExport(); } },
      { id: 'act_broadcast', group: '快捷动作指令', title: '📢 向所有终端广播指令 (/compact)', icon: '📢', action: () => { broadcastTmuxPrompt(); } },
      { id: 'act_refresh_git', group: '快捷动作指令', title: '🔄 刷新所有 Git 仓库状态', icon: '🔄', action: () => { currentTab.value = 'git'; loadGitRepos(); } },
    ];

    const filteredPaletteItems = computed(() => {
      const q = paletteQuery.value.trim().toLowerCase();
      if (!q) return ALL_PALETTE_ITEMS;
      return ALL_PALETTE_ITEMS.filter(item =>
        item.title.toLowerCase().includes(q) ||
        item.group.toLowerCase().includes(q)
      );
    });

    function selectPaletteItem(item) {
      if (!item) return;
      showPalette.value = false;
      item.action();
    }

    function onGlobalKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        showPalette.value = !showPalette.value;
        if (showPalette.value) {
          paletteQuery.value = '';
          paletteSelectedIndex.value = 0;
        }
      } else if (e.key === 'Escape' && showPalette.value) {
        showPalette.value = false;
      }
    }

    // Token Breakdown & Efficiency Computation
    const tokenMetrics = computed(() => {
      const t = usageSummary.value?.totals || {};
      const grand = t.grand_total_tokens || 0;
      const input = t.input_tokens || 0;
      const output = t.output_tokens || 0;
      const cache = t.cache_read_tokens || 0;
      if (grand <= 0) {
        return { promptPct: 0, outputPct: 0, cachePct: 0, cacheHitRate: '0.0%' };
      }
      const promptPct = ((input / grand) * 100).toFixed(1);
      const outputPct = ((output / grand) * 100).toFixed(1);
      const cachePct = ((cache / grand) * 100).toFixed(1);
      const totalPrompt = input + cache;
      const cacheHitRate = totalPrompt > 0 ? ((cache / totalPrompt) * 100).toFixed(1) + '%' : '0.0%';
      return { promptPct, outputPct, cachePct, cacheHitRate };
    });

    // Tmux CRT Fullscreen & Font Scaler
    const tmuxIsFullscreen = ref(false);
    const tmuxFontSize = ref(12);
    function toggleTmuxFullscreen() { tmuxIsFullscreen.value = !tmuxIsFullscreen.value; }
    function zoomTmuxFont(delta) { tmuxFontSize.value = Math.min(18, Math.max(10, tmuxFontSize.value + delta)); }

    async function scanJunk(quiet = false) {
      cleanerScanning.value = true;
      try {
        const res = await api('/api/cleaner/scan');
        cleanerScanData.value = res;
        // Default select all categories that have defaultSelected === true and have bytes
        selectedJunkCategories.value = (res.categories || [])
          .filter(c => c.defaultSelected && c.bytes > 0)
          .map(c => c.id);
        if (!quiet) {
          showToast(`扫描完毕，发现 ${res.formattedTotalJunk} 可清理空间`, 'success');
        }
      } catch (err) {
        showToast('扫描磁盘垃圾失败: ' + err.message, 'error');
      } finally {
        cleanerScanning.value = false;
      }
    }

    function toggleSelectCategory(id) {
      const idx = selectedJunkCategories.value.indexOf(id);
      if (idx >= 0) {
        selectedJunkCategories.value.splice(idx, 1);
      } else {
        selectedJunkCategories.value.push(id);
      }
    }

    function selectAllSafeCategories() {
      const safe = (cleanerScanData.value.categories || [])
        .filter(c => c.safety === 'safe' && c.bytes > 0)
        .map(c => c.id);
      selectedJunkCategories.value = safe;
      showToast('已选中全部安全清理项', 'info');
    }

    function selectAllCategories() {
      selectedJunkCategories.value = (cleanerScanData.value.categories || [])
        .filter(c => c.bytes > 0)
        .map(c => c.id);
      showToast('已全选所有发现分类', 'info');
    }

    function clearCategorySelection() {
      selectedJunkCategories.value = [];
    }

    function getSelectedJunkFormatted() {
      let sum = 0;
      for (const cat of cleanerScanData.value.categories || []) {
        if (selectedJunkCategories.value.includes(cat.id)) {
          sum += cat.bytes || 0;
        }
      }
      if (sum === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(sum) / Math.log(k));
      return parseFloat((sum / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function openCleanConfirm() {
      if (!selectedJunkCategories.value.length) {
        showToast('请至少勾选一个需要清理的垃圾分类', 'warning');
        return;
      }
      showCleanConfirmModal.value = true;
    }

    async function executeClean() {
      cleanerCleaning.value = true;
      try {
        const res = await api('/api/cleaner/clean', {
          method: 'POST',
          body: { category_ids: selectedJunkCategories.value }
        });
        showCleanConfirmModal.value = false;
        showToast(`清理成功！已释放 ${res.formattedFreed} 磁盘空间 🎉`, 'success');
        // Re-scan
        await scanJunk(true);
        // Also refresh system stats if on desktop HUD
        if (state.value.system) {
          state.value.system.disk = res.disk;
        }
      } catch (err) {
        showToast('执行清理失败: ' + err.message, 'error');
      } finally {
        cleanerCleaning.value = false;
      }
    }

    async function loadLargeFiles() {
      loadingLargeFiles.value = true;
      try {
        const res = await api('/api/cleaner/large-files?limit=30&minMb=30');
        largeFiles.value = res || [];
      } catch (err) {
        showToast('读取大文件失败: ' + err.message, 'error');
      } finally {
        loadingLargeFiles.value = false;
      }
    }

    async function loadLargeDirs() {
      loadingLargeDirs.value = true;
      try {
        const res = await api('/api/cleaner/large-dirs?limit=15');
        largeDirs.value = res || [];
      } catch (err) {
        showToast('读取目录排行失败: ' + err.message, 'error');
      } finally {
        loadingLargeDirs.value = false;
      }
    }

    function toggleJunkExpand(catId) {
      expandedJunkCatId.value = expandedJunkCatId.value === catId ? null : catId;
    }

    onMounted(() => {
      checkAuth();
      window.addEventListener('keydown', onGlobalKeyDown);
    });
    onUnmounted(() => {
      window.removeEventListener('keydown', onGlobalKeyDown);
    });

    return {
      // Spotlight Command Palette
      showPalette,
      paletteQuery,
      paletteSelectedIndex,
      filteredPaletteItems,
      selectPaletteItem,
      tokenMetrics,
      tmuxIsFullscreen,
      tmuxFontSize,
      toggleTmuxFullscreen,
      zoomTmuxFont,
      authed,
      checkingAuth,
      loginPassword,
      loginLoading,
      loginError,
      showChangePw,
      pwForm,
      pwLoading,
      currentTab,
      claudeSubTab,
      codexSubTab,
      state,
      loading,
      toast,
      showToast,
      doLogin,
      doLogout,
      changePassword,
      loadState,
      // Splash
      showSplash,
      splashProgress,
      splashLogs,
      splashReady,
      playBootSequence,
      dismissSplash,
      // Providers
      showProviderModal,
      providerForm,
      isNewProvider,
      savingProvider,
      fetchingModels,
      openAddProvider,
      openEditProvider,
      addModelToProvider,
      removeModelFromProvider,
      fetchModelsFromProvider,
      saveProvider,
      deleteProvider,
      getProvider,
      getProviderModels,
      // Claude
      showClaudeDrawer,
      claudeForm,
      isNewClaude,
      savingClaude,
      openAddClaude,
      openEditClaude,
      syncMainModelToAll,
      addExtraEnv,
      removeExtraEnv,
      saveClaudeLauncher,
      deleteLauncher,
      setClaudeAlias,
      testClaude,
      savingClaudeSettings,
      saveClaudeSettings,
      testStatus,
      testingStatusLine,
      statusLinePreview,
      testStatusLine,
      commonEnvPresets,
      applyEnvPreset,
      claudeContextOptions,
      claudeCompactOptions,
      onContextWindowChange,
      toggle1mTag,
      formatContext,
      codexContextOptions,
      codexCompactOptions,
      onCodexContextChange,
      // Codex
      showCodexDrawer,
      codexForm,
      isNewCodex,
      savingCodex,
      openAddCodex,
      openEditCodex,
      addModelToCodexCatalog,
      removeModelFromCodexCatalog,
      saveCodexProfile,
      setCodexDefault,
      deleteCodexProfile,
      testCodex,
      savingCodexGlobals,
      saveCodexGlobals,
      // Raw
      showRawModal,
      rawModalTitle,
      rawModalPath,
      rawModalText,
      savingRaw,
      openRawEditor,
      saveRawContent,
      // Backups
      backups,
      loadingBackups,
      showBackupModal,
      backupDetail,
      loadBackups,
      viewBackup,
      restoreBackup,
      exportingBundle,
      downloadFullExport,
      showImportModal,
      importBundleText,
      importingBundle,
      importResult,
      onImportFileSelected,
      executeImportBundle,
      // Select Options
      claudeAliasOptions,
      providerSelectOptions,
      claudeEffortOptions,
      claudePermModeOptions,
      codexProviderSelectOptions,
      codexEffortOptions,
      codexTierOptions,
      codexCatalogModeOptions,
      codexApprovalOptions,
      codexSandboxOptions,
      codexSummaryOptions,
      codexWebSearchOptions,
      codexCatalogOptions,
      allAvailableModels,
      // Codex Catalogs Management
      showCatalogModal,
      savingCatalog,
      catalogForm,
      catalogNewModel,
      openCatalogManager,
      selectCatalogForEdit,
      startNewCatalog,
      addModelToCurrentCatalog,
      addCustomModelToCurrentCatalog,
      removeModelFromCurrentCatalog,
      moveCatalogModel,
      saveCurrentCatalog,
      switchDefaultCatalog,
      // 1. Ping Health Check
      pingStatus,
      pingTarget,
      pingingAll,
      pingAllProviders,
      // Hardware Resource HUD
      systemHud,
      loadingHud,
      loadSystemHud,
      // 2. Sessions & Processes + Tmux Live Console & Dispatcher
      showSessionsModal,
      refreshingSessions,
      refreshSessions,
      killTmux,
      killProcess,
      copyText,
      showTmuxModal,
      activeTmuxSession,
      activeTmuxTarget,
      totalTmuxWindows,
      totalIdleTmuxWindows,
      currentSessionWindows,
      switchTmuxSession,
      switchTmuxWindow,
      showNewTmuxWindowModal,
      newTmuxWindowForm,
      creatingTmuxWindow,
      promptNewTmuxWindow,
      executeCreateTmuxWindow,
      showKillTmuxWindowModal,
      windowToKill,
      killingTmuxWindow,
      promptKillTmuxWindow,
      executeKillTmuxWindow,
      closeCurrentTmuxWindow,
      closeCurrentTmuxSession,
      promptNewTmuxSession,
      broadcastTmuxPrompt,
      killTmuxWindowDirect,
      cleanAllIdleWindows,
      cleaningIdleWindows,
      tmuxTerminalText,
      tmuxTerminalLines,
      tmuxLoadingPane,
      tmuxAutoPoll,
      tmuxDispatchText,
      tmuxSending,
      quickPrompts,
      openTmuxConsole,
      closeTmuxConsole,
      loadTmuxPane,
      sendTmuxCommand,
      sendTmuxSignal,
      // 3. Skills Manager
      skillFilter,
      showSkillDrawer,
      savingSkill,
      skillForm,
      filteredSkills,
      openAddSkill,
      openEditSkill,
      saveSkill,
      deleteSkill,
      // 4. MCP Manager
      showMcpModal,
      savingMcp,
      mcpForm,
      openAddMcp,
      openEditMcp,
      toggleMcp,
      saveMcp,
      deleteMcp,
      // 5. Git Inspector
      gitRepos,
      loadingGit,
      selectedRepo,
      repoDiff,
      loadingDiff,
      showDiffDrawer,
      commitMsg,
      actingGit,
      loadGitRepos,
      openRepoDiff,
      doGitAction,
      // 6. Usage & Sessions
      usageSummary,
      loadingUsage,
      selectedSession,
      sessionDetail,
      loadingSessionDetail,
      showSessionModal,
      loadUsage,
      openSessionDetail,
      selectedSessionIds,
      sessionSearch,
      sessionClientFilter,
      showDeleteSessionModal,
      sessionToDelete,
      deletingSession,
      showCleanOldSessionsModal,
      cleanOldDays,
      cleaningOldSessions,
      filteredSessions,
      isAllSessionsSelected,
      toggleSelectSession,
      toggleSelectAllSessions,
      confirmDeleteSession,
      executeDeleteSession,
      deleteSelectedSessions,
      cleanOldSessions,
      cleaningEmptySessions,
      executeCleanEmptySessions,
      // 7. Memory & Rules
      memories,
      rules,
      loadingMemory,
      memoryTab,
      memoryFilter,
      filteredMemories,
      showMemoryDrawer,
      memoryForm,
      savingMemory,
      showRuleModal,
      ruleForm,
      savingRule,
      loadMemory,
      openAddMemory,
      openEditMemory,
      saveMemoryItem,
      deleteMemoryItem,
      openEditRule,
      saveRuleContent,
      // 8. Doctor
      doctorItems,
      loadingDoctor,
      doctorFixing,
      loadDoctor,
      runDoctorFix,
      // 9. Logs
      logsSubTab,
      logsSearch,
      logsClientFilter,
      logsAutoPoll,
      promptsList,
      loadingPrompts,
      errorsList,
      loadingErrors,
      daemonSource,
      daemonLines,
      daemonLogs,
      loadingDaemon,
      expandedLogId,
      loadPrompts,
      loadErrors,
      loadDaemonLogs,
      refreshLogs,
      toggleLogExpand,
      toggleLogsAutoPoll,
      formatLogTime,
      copyPromptText,
      // 10. Disk Cleaner
      cleanerSubTab,
      cleanerScanning,
      cleanerCleaning,
      cleanerScanData,
      selectedJunkCategories,
      showCleanConfirmModal,
      largeFiles,
      loadingLargeFiles,
      largeDirs,
      loadingLargeDirs,
      expandedJunkCatId,
      scanJunk,
      toggleSelectCategory,
      selectAllSafeCategories,
      selectAllCategories,
      clearCategorySelection,
      getSelectedJunkFormatted,
      openCleanConfirm,
      executeClean,
      loadLargeFiles,
      loadLargeDirs,
      toggleJunkExpand
    };
  }
});

// Register Custom Select Component (Highest Standard Beautification)
app.component('c-select', {
  props: {
    modelValue: [String, Number, Boolean],
    options: { type: Array, default: () => [] },
    placeholder: { type: String, default: '请选择' },
    disabled: Boolean,
    mono: { type: Boolean, default: false },
    size: { type: String, default: 'normal' },
    fixedPlaceholder: { type: Boolean, default: false },
    align: { type: String, default: 'left' }
  },
  emits: ['update:modelValue', 'change'],
  setup(props, { emit }) {
    const isOpen = ref(false);
    const dropUp = ref(false);
    const rootRef = ref(null);

    const normOptions = computed(() => {
      return (props.options || []).map(opt => {
        if (typeof opt === 'object' && opt !== null) {
          return {
            value: opt.value ?? opt.id,
            label: opt.label || opt.name || opt.value || opt.id,
            desc: opt.desc,
            badge: opt.badge
          };
        }
        return { value: opt, label: String(opt), desc: '', badge: '' };
      });
    });

    const selectedOption = computed(() => {
      return normOptions.value.find(o => String(o.value) === String(props.modelValue));
    });

    const selectedLabel = computed(() => {
      if (props.fixedPlaceholder) return '';
      if (selectedOption.value) return selectedOption.value.label;
      if (props.modelValue !== '' && props.modelValue !== null && props.modelValue !== undefined) {
        return String(props.modelValue);
      }
      return '';
    });

    function toggle() {
      if (props.disabled) return;
      if (!isOpen.value && rootRef.value) {
        const rect = rootRef.value.getBoundingClientRect();
        const modalBody = rootRef.value.closest('.modal-body, .drawer-body');
        if (modalBody) {
          const parentRect = modalBody.getBoundingClientRect();
          const spaceBelow = parentRect.bottom - rect.bottom;
          const spaceAbove = rect.top - parentRect.top;
          dropUp.value = spaceBelow < 220 && spaceAbove > 140;
        } else {
          const spaceBelow = window.innerHeight - rect.bottom;
          const spaceAbove = rect.top;
          dropUp.value = spaceBelow < 250 && spaceAbove > 200;
        }
      }
      isOpen.value = !isOpen.value;
    }

    function select(opt) {
      emit('update:modelValue', opt.value);
      emit('change', opt.value);
      isOpen.value = false;
    }

    function onDocClick(e) {
      if (rootRef.value && !rootRef.value.contains(e.target)) {
        isOpen.value = false;
      }
    }

    onMounted(() => {
      document.addEventListener('click', onDocClick);
    });
    onUnmounted(() => {
      document.removeEventListener('click', onDocClick);
    });

    return { isOpen, dropUp, rootRef, normOptions, selectedOption, selectedLabel, toggle, select };
  },
  template: `
    <div class="c-select" :class="{ 'is-open': isOpen, 'is-disabled': disabled, 'is-sm': size === 'sm', 'font-mono': mono, 'align-right': align === 'right', 'is-drop-up': dropUp }" ref="rootRef">
      <div class="c-select-trigger" @click="toggle" :tabindex="disabled ? -1 : 0" @keydown.esc="isOpen = false">
        <span class="c-select-value" :class="{ 'is-placeholder': !selectedLabel }">
          {{ selectedLabel || placeholder }}
        </span>
        <svg class="c-select-arrow" :class="{ 'is-rotated': isOpen }" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </div>
      <transition name="c-select-drop">
        <div class="c-select-menu" v-if="isOpen">
          <div
            v-for="opt in normOptions"
            :key="opt.value"
            class="c-select-option"
            :class="{ 'is-selected': String(opt.value) === String(modelValue) }"
            @click.stop="select(opt)"
          >
            <div class="c-select-option-main">
              <span class="c-select-option-label">{{ opt.label }}</span>
              <span v-if="opt.badge" class="badge badge-accent" style="font-size: 10px; padding: 1px 6px;">{{ opt.badge }}</span>
              <span v-if="opt.desc" class="c-select-option-desc">{{ opt.desc }}</span>
            </div>
            <svg v-if="String(opt.value) === String(modelValue)" class="c-select-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>
          <div v-if="!normOptions.length" class="c-select-empty">
            无可用选项
          </div>
        </div>
      </transition>
    </div>
  `
});

app.mount('#app');
