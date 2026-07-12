import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const root = process.cwd();
const envPath = resolve(root, '.env');
const installedMarkerPath = resolve(root, '.panel-installed');
const criticalSecrets = ['SESSION_SECRET', 'JWT_SECRET', 'ENCRYPTION_KEY', 'CARD_HASH_SECRET'];
const installerVersion = '20260712-1545';
const requiredFiles = [
  'apps/api/dist/main.js',
  'dist/user-web/index.html',
  'dist/admin-web/index.html'
];

const state = {
  installing: false,
  installed: false,
  exitCode: null,
  startedAt: null,
  endedAt: null,
  logs: []
};

const env = loadEnv();

if (isReady(env)) {
  console.log('1Panel startup: installed build detected, starting API.');
  await runApi();
} else {
  startInstaller(env);
}

function isReady(values) {
  return existsSync(installedMarkerPath) && requiredFiles.every((file) => existsSync(resolve(root, file))) && envIsUsable(values).ok;
}

function envIsUsable(values) {
  const errors = [];
  if (!existsSync(envPath)) errors.push('.env 文件不存在。');
  if (!values.DATABASE_URL || isPlaceholder(values.DATABASE_URL)) errors.push('DATABASE_URL 缺失或仍是占位值。');
  for (const name of criticalSecrets) {
    const value = values[name] || '';
    if (!value || isPlaceholder(value)) errors.push(`${name} 缺失或仍是占位值。`);
    if (secretByteLength(value) < 32) errors.push(`${name} 至少需要 32 字节。`);
  }
  return { ok: errors.length === 0, errors };
}

function startInstaller(initialEnv) {
  const port = Number(process.env.PORT || initialEnv.PORT || 3388);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);

      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/panel-install')) {
        return sendHtml(response, flashFromUrl(url));
      }
      if (request.method === 'GET' && url.pathname === '/panel-install.js') return sendJs(response);
      if (request.method === 'GET' && url.pathname === '/api/panel-install/status') return sendJson(response, getStatus());

      if (request.method === 'POST' && url.pathname === '/api/panel-install/config') return saveConfigApi(request, response);
      if (request.method === 'POST' && url.pathname === '/api/panel-install/run') return runInstallApi(response);
      if (request.method === 'POST' && url.pathname === '/panel-install/config') return saveConfigPage(request, response);
      if (request.method === 'POST' && url.pathname === '/panel-install/run') return runInstallPage(request, response);

      if (wantsHtml(request)) return sendHtml(response, { type: 'error', message: '访问路径不存在。' }, 404);
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ message: 'Not found' }));
    } catch (error) {
      if (wantsHtml(request)) return sendHtml(response, { type: 'error', message: errorMessage(error) }, 500);
      sendJson(response, { ok: false, message: errorMessage(error) }, 500);
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`1Panel install wizard is running on port ${port}.`);
    console.log(`Open http://SERVER_IP:${port} to finish installation.`);
  });
}

function getStatus() {
  const currentEnv = loadEnv();
  const envStatus = envIsUsable(currentEnv);
  const missingFiles = requiredFiles.filter((file) => !existsSync(resolve(root, file)));
  return {
    version: installerVersion,
    ready: isReady(currentEnv),
    installedMarker: existsSync(installedMarkerPath),
    envOk: envStatus.ok,
    envErrors: envStatus.errors,
    missingFiles,
    installing: state.installing,
    installed: state.installed,
    exitCode: state.exitCode,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    logs: state.logs.slice(-240),
    defaults: {
      port: currentEnv.PORT || '3388',
      database: parseDatabaseConfig(currentEnv.DATABASE_URL || ''),
      adminPath: currentEnv.ADMIN_PATH || '/admin',
      adminUsername: currentEnv.DEFAULT_ADMIN_USERNAME || 'admin'
    }
  };
}

async function saveConfigApi(request, response) {
  const body = await readPayload(request);
  saveConfigFromPayload(body);
  sendJson(response, { ok: true, status: getStatus() });
}

async function saveConfigPage(request, response) {
  try {
    const body = await readPayload(request);
    saveConfigFromPayload(body);
    sendRedirect(response, '/?type=ok&message=' + encodeURIComponent('配置已保存。'));
  } catch (error) {
    sendHtml(response, { type: 'error', message: errorMessage(error) }, 400);
  }
}

async function runInstallPage(request, response) {
  try {
    const body = await readPayload(request);
    saveConfigFromPayload(body);
    startInstall();
    sendRedirect(response, '/?type=ok&message=' + encodeURIComponent('安装任务已开始，请等待日志完成后回到 1Panel 重启 Node.js 运行环境。'));
  } catch (error) {
    sendHtml(response, { type: 'error', message: errorMessage(error) }, error.statusCode || 400);
  }
}

function runInstallApi(response) {
  try {
    startInstall();
    sendJson(response, { ok: true, status: getStatus() });
  } catch (error) {
    sendJson(response, { ok: false, message: errorMessage(error) }, error.statusCode || 400);
  }
}

function saveConfigFromPayload(payload) {
  const existing = loadEnvFileOnly();
  delete existing.REDIS_URL;
  const data = normalizeConfig(payload, existing);
  const merged = mergeEnv(existing, data);
  writeFileSync(envPath, renderEnv(merged), 'utf8');
  appendLog('配置已保存到 .env。');
}

function normalizeConfig(body, existing) {
  const port = String(body.port || '3388').trim();
  const dbHost = String(body.dbHost || '').trim();
  const dbPort = String(body.dbPort || '3306').trim();
  const dbName = String(body.dbName || '').trim();
  const dbUser = String(body.dbUser || '').trim();
  const dbPassword = String(body.dbPassword || '').trim();
  const adminUsername = String(body.adminUsername || 'admin').trim();
  const adminPassword = String(body.adminPassword || existing.DEFAULT_ADMIN_PASSWORD || '').trim();
  const adminPath = normalizeAdminPath(body.adminPath || '/admin');
  const errors = [];

  if (!/^\d+$/.test(port)) errors.push('端口必须是数字。');
  if (!dbHost) errors.push('数据库地址不能为空。');
  if (!/^\d+$/.test(dbPort)) errors.push('数据库端口必须是数字。');
  if (!dbName) errors.push('数据库名不能为空。');
  if (!dbUser) errors.push('数据库用户名不能为空。');
  if (!dbPassword) errors.push('数据库密码不能为空。');
  if (!adminUsername) errors.push('管理员账号不能为空。');
  if (!adminPassword) errors.push('管理员密码不能为空。');
  if (errors.length) throw new Error(errors.join('\n'));

  const databaseUrl = buildDatabaseUrl({ dbHost, dbPort, dbName, dbUser, dbPassword });

  return {
    NODE_ENV: 'production',
    PORT: port,
    PUBLIC_WEB_URL: existing.PUBLIC_WEB_URL || '',
    ADMIN_PATH: adminPath,
    DATABASE_URL: databaseUrl,
    JWT_SECRET: usableSecret(existing.JWT_SECRET) ? existing.JWT_SECRET : randomSecret(),
    SESSION_SECRET: usableSecret(existing.SESSION_SECRET) ? existing.SESSION_SECRET : randomSecret(),
    ENCRYPTION_KEY: usableSecret(existing.ENCRYPTION_KEY) ? existing.ENCRYPTION_KEY : randomBytes(32).toString('base64'),
    CARD_HASH_SECRET: usableSecret(existing.CARD_HASH_SECRET) ? existing.CARD_HASH_SECRET : randomSecret(),
    DEFAULT_ADMIN_USERNAME: adminUsername,
    DEFAULT_ADMIN_PASSWORD: adminPassword
  };
}

function normalizeAdminPath(value) {
  const trimmed = String(value || '/admin').trim() || '/admin';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function startInstall() {
  if (state.installing) {
    const error = new Error('安装正在进行中。');
    error.statusCode = 409;
    throw error;
  }

  const envStatus = envIsUsable(loadEnv());
  if (!envStatus.ok) {
    const error = new Error(envStatus.errors.join('\n'));
    error.statusCode = 400;
    throw error;
  }

  state.installing = true;
  state.installed = false;
  state.exitCode = null;
  state.startedAt = new Date().toISOString();
  state.endedAt = null;
  state.logs = [];

  const usePrebuilt = shouldUsePrebuiltInstall();
  if (usePrebuilt) appendLog('检测到预构建运行包，安装时跳过前后端构建。');

  const steps = [
    ['npm', ['ci']],
    ['npm', ['run', 'install:prod']],
    ['npm', ['prune', '--omit=dev']]
  ];

  runSteps(steps).catch((error) => {
    appendLog(errorMessage(error));
    state.exitCode = 1;
    state.installed = false;
  }).finally(() => {
    state.installing = false;
    state.endedAt = new Date().toISOString();
    state.installed = state.exitCode === 0 && isReady(loadEnv());
    if (state.exitCode === 0 && requiredFiles.every((file) => existsSync(resolve(root, file))) && envIsUsable(loadEnv()).ok) {
      writeFileSync(installedMarkerPath, `${new Date().toISOString()}\n`, 'utf8');
      state.installed = true;
      appendLog('安装完成。请在 1Panel 重启 Node.js 运行环境，重启后会进入正式 API。');
    }
  });
}

async function runSteps(steps) {
  for (const [command, args] of steps) {
    appendLog(`$ ${command} ${args.join(' ')}`);
    await runCommand(command, args);
  }
  state.exitCode = 0;
}

function runCommand(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: root, shell: process.platform === 'win32', env: commandEnv() });
    child.stdout.on('data', (chunk) => appendLog(chunk.toString()));
    child.stderr.on('data', (chunk) => appendLog(chunk.toString()));
    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function shouldUsePrebuiltInstall() {
  const runtimeReady = requiredFiles.every((file) => existsSync(resolve(root, file)));
  const buildSourcesMissing = !existsSync(resolve(root, 'packages/shared/tsconfig.json')) || !existsSync(resolve(root, 'apps/admin-web/src'));
  return process.env.SHIYE_PREBUILT === '1' || (runtimeReady && buildSourcesMissing);
}

function commandEnv() {
  return {
    ...process.env,
    SHIYE_PREBUILT: shouldUsePrebuiltInstall() ? '1' : process.env.SHIYE_PREBUILT || ''
  };
}

async function runApi() {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('npm', ['run', 'start:api'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
      resolvePromise();
    });
  });
}

function appendLog(message) {
  const lines = String(message).replace(/\r/g, '').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    state.logs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}`);
  }
  if (state.logs.length > 500) state.logs.splice(0, state.logs.length - 500);
}

function loadEnv() {
  return { ...process.env, ...loadEnvFileOnly() };
}

function loadEnvFileOnly() {
  const values = {};
  if (!existsSync(envPath)) return values;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    values[trimmed.slice(0, index).trim()] = unquote(trimmed.slice(index + 1).trim());
  }
  return values;
}

function mergeEnv(existing, next) {
  return {
    ...existing,
    ...next
  };
}

function renderEnv(values) {
  const order = [
    'NODE_ENV', 'PORT', 'PUBLIC_WEB_URL', 'ADMIN_PATH',
    'DATABASE_URL',
    'JWT_SECRET', 'SESSION_SECRET', 'ENCRYPTION_KEY', 'CARD_HASH_SECRET',
    'DEFAULT_ADMIN_USERNAME', 'DEFAULT_ADMIN_PASSWORD'
  ];
  const keys = [...order, ...Object.keys(values).filter((key) => !order.includes(key)).sort()];
  const blocks = [];
  const seen = new Set();
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (values[key] === undefined || values[key] === null || values[key] === '') continue;
    blocks.push(`${key}=${escapeEnv(String(values[key]))}`);
  }
  return `${blocks.join('\n')}\n`;
}

function escapeEnv(value) {
  if (/^[A-Za-z0-9_./:@%+\-=]*$/.test(value)) return value;
  return JSON.stringify(value);
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function isPlaceholder(value) {
  return /replace-with|change-me|dev-only|example\.com/i.test(value || '');
}

function usableSecret(value) {
  return Boolean(value) && !isPlaceholder(value) && secretByteLength(value) >= 32;
}

function secretByteLength(value) {
  if (!value) return 0;
  return Math.max(Buffer.from(value, 'utf8').length, Buffer.from(value, 'base64').length, Buffer.from(value, 'hex').length);
}

function randomSecret() {
  return randomBytes(48).toString('hex');
}

function buildDatabaseUrl({ dbHost, dbPort, dbName, dbUser, dbPassword }) {
  const host = dbHost.includes(':') && !dbHost.startsWith('[') ? `[${dbHost}]` : dbHost;
  return `mysql://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPassword)}@${host}:${dbPort}/${encodeURIComponent(dbName)}`;
}

function parseDatabaseConfig(value) {
  const fallback = { host: '', port: '3306', name: '', user: '', password: '' };
  if (!value) return fallback;
  try {
    const parsed = new URL(value);
    return {
      host: parsed.hostname || '',
      port: parsed.port || '3306',
      name: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
      user: decodeURIComponent(parsed.username || ''),
      password: decodeURIComponent(parsed.password || '')
    };
  } catch {
    return fallback;
  }
}

function readPayload(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        request.destroy(new Error('请求内容过大。'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const contentType = String(request.headers['content-type'] || '').toLowerCase();
        if (contentType.includes('application/json')) return resolvePromise(JSON.parse(raw || '{}'));
        const params = new URLSearchParams(raw);
        resolvePromise(Object.fromEntries(params.entries()));
      } catch (error) {
        rejectPromise(error);
      }
    });
    request.on('error', rejectPromise);
  });
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function sendHtml(response, flash = {}, status = 200) {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(installerHtml(flash));
}

function sendRedirect(response, location) {
  response.writeHead(303, { location, 'cache-control': 'no-store' });
  response.end();
}

function sendJs(response) {
  response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
  response.end(installerClientScript());
}

function flashFromUrl(url) {
  return {
    type: url.searchParams.get('type') || '',
    message: url.searchParams.get('message') || ''
  };
}

function wantsHtml(request) {
  const accept = String(request.headers.accept || '');
  return accept.includes('text/html') || !accept.includes('application/json');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function installerClientScript() {
  return `(() => {
    const form = document.querySelector('#form');
    const toast = document.querySelector('#toast');
    const logs = document.querySelector('#logs');
    const ready = document.querySelector('#ready');
    const checks = document.querySelector('#checks');
    const installButton = document.querySelector('#install');
    const saveButton = document.querySelector('#save');
    const storageKey = 'shiye-panel-install-form';
    if (!form || !toast || !logs || !ready || !checks || !installButton || !saveButton) return;

    let userEditing = false;
    ready.textContent = '正在连接';
    appendClientLog('页面脚本已加载，正在检查安装状态。');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      setBusy(saveButton, '正在保存...');
      setToast('正在保存配置...', '');
      appendClientLog('正在保存配置...');
      try {
        await saveConfig();
        setToast('配置已保存。', 'ok');
        appendClientLog('配置已保存。');
      } catch (error) {
        setToast(error.message, 'error');
        appendClientLog('保存失败：' + error.message);
      } finally {
        setIdle(saveButton, '保存配置');
        await refresh();
      }
    });

    installButton.addEventListener('click', async (event) => {
      event.preventDefault();
      setBusy(installButton, '正在安装...');
      setToast('正在保存配置并准备安装...', '');
      appendClientLog('正在保存配置并准备安装...');
      try {
        await saveConfig();
        await post('/api/panel-install/run', {});
        setToast('安装任务已开始，请等待日志完成。', 'ok');
        appendClientLog('安装任务已开始。');
      } catch (error) {
        setToast(error.message, 'error');
        appendClientLog('开始安装失败：' + error.message);
      } finally {
        setIdle(installButton, '开始安装');
        await refresh();
      }
    });

    form.addEventListener('input', () => {
      userEditing = true;
      saveDraft();
    });

    async function saveConfig() {
      const payload = Object.fromEntries(new FormData(form).entries());
      const data = await post('/api/panel-install/config', payload);
      saveDraft();
      return data;
    }

    async function post(url, body) {
      const response = await fetchWithTimeout(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 15000);
      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; }
      catch { throw new Error(text || '服务返回格式不正确。'); }
      if (!response.ok || data.ok === false) throw new Error(data.message || '请求失败。');
      return data;
    }

    async function refresh() {
      try {
        const response = await fetchWithTimeout('/api/panel-install/status', { cache: 'no-store' }, 8000);
        const text = await response.text();
        let data;
        try { data = text ? JSON.parse(text) : {}; }
        catch { throw new Error(text ? '状态接口返回的不是 JSON，请检查整站反向代理是否转发到 Node.js 端口。' : '状态接口没有返回内容。'); }
        if (!response.ok) throw new Error(data.message || '状态接口请求失败：HTTP ' + response.status);
        if (!userEditing) fillDefaults(data.defaults || {});
        renderStatus(data);
      } catch (error) {
        ready.textContent = '连接失败';
        ready.className = 'pill bad';
        checks.innerHTML = '<li>' + escapeHtml(error.message) + '</li>';
        setToast(error.message, 'error');
        appendClientLog('状态检查失败：' + error.message);
      }
    }

    function renderStatus(data) {
      ready.textContent = data.ready ? '已安装，重启后进入正式服务' : data.installing ? '正在安装' : '等待安装';
      ready.className = data.ready || data.installing ? 'pill' : 'pill bad';
      installButton.disabled = data.installing;
      installButton.textContent = data.installing ? '正在安装...' : '开始安装';
      const items = [];
      if (!data.envOk) items.push(...(data.envErrors || []));
      if (!data.installedMarker) items.push('尚未完成网页向导安装。');
      if ((data.missingFiles || []).length) items.push('缺少构建产物：' + data.missingFiles.join('、'));
      if (!items.length) items.push(data.ready ? '配置和构建产物已就绪。' : '配置已就绪，可以开始安装。');
      checks.innerHTML = items.map((item) => '<li>' + escapeHtml(item) + '</li>').join('');
      if ((data.logs || []).length) logs.textContent = data.logs.join('\\n');
      else if (!logs.textContent.trim()) logs.textContent = '等待操作...';
      logs.scrollTop = logs.scrollHeight;
    }

    function fillDefaults(defaults) {
      const database = defaults.database || {};
      const draft = loadDraft();
      setFieldValue('port', draft.port || defaults.port || '3388');
      setFieldValue('adminPath', draft.adminPath || defaults.adminPath || '/admin');
      setFieldValue('dbHost', draft.dbHost || database.host || '');
      setFieldValue('dbPort', draft.dbPort || database.port || '3306');
      setFieldValue('dbName', draft.dbName || database.name || '');
      setFieldValue('dbUser', draft.dbUser || database.user || '');
      setFieldValue('dbPassword', draft.dbPassword || database.password || '');
      setFieldValue('adminUsername', draft.adminUsername || defaults.adminUsername || 'admin');
      setFieldValue('adminPassword', draft.adminPassword || '');
    }

    function setFieldValue(name, value) {
      const field = form.elements.namedItem(name);
      if (field) field.value = value;
    }

    function saveDraft() {
      try { localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(new FormData(form).entries()))); }
      catch {}
    }

    function loadDraft() {
      try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); }
      catch { return {}; }
    }

    function setToast(message, type) {
      toast.textContent = message;
      toast.className = 'toast ' + (type || '');
    }

    function appendClientLog(message) {
      const prefix = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      const current = logs.textContent === '等待操作...' ? '' : logs.textContent + '\\n';
      logs.textContent = current + '[' + prefix + '] ' + message;
      logs.scrollTop = logs.scrollHeight;
    }

    function setBusy(button, text) {
      button.disabled = true;
      button.dataset.idleText = button.textContent;
      button.textContent = text;
    }

    function setIdle(button, text) {
      button.disabled = false;
      button.textContent = text || button.dataset.idleText || button.textContent;
    }

    async function fetchWithTimeout(url, options, timeoutMs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { ...(options || {}), signal: controller.signal });
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('请求超时，请检查 Node.js 运行环境是否正常启动，以及反向代理是否整站转发到当前端口。');
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }

    try { fillDefaults({ port: '3388', adminPath: '/admin', database: {}, adminUsername: 'admin' }); }
    catch (error) { appendClientLog('默认值填充失败：' + error.message); }
    window.addEventListener('error', (event) => { setToast(event.message, 'error'); appendClientLog('页面错误：' + event.message); });
    setInterval(refresh, 2500);
    refresh();
  })();`;
}

function installerHtml(flash = {}) {
  const status = getStatus();
  const values = formValuesFromStatus(status);
  const checks = statusChecks(status);
  const readyText = status.ready ? '已安装，重启后进入正式服务' : status.installing ? '正在安装' : '等待安装';
  const readyClass = status.ready || status.installing ? 'pill' : 'pill bad';
  const logsText = status.logs.length ? status.logs.join('\n') : '等待操作...';
  const flashClass = flash.type === 'ok' ? 'toast ok' : flash.message ? 'toast error' : 'toast';
  const refreshMeta = status.installing ? '  <meta http-equiv="refresh" content="3" />\n' : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
${refreshMeta}  <title>十业管理系统安装向导</title>
  <style>
    :root { color-scheme: light; --bg: #fbf7ff; --panel: #ffffff; --text: #152033; --muted: #60708a; --line: #eadcff; --primary: #a855f7; --primary-dark: #7e22ce; --soft: #f3e8ff; --danger: #ff4d4f; --success: #16a34a; --log: #241733; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--text); background: radial-gradient(circle at 50% 28%, rgba(168, 85, 247, .10) 0, transparent 30rem), linear-gradient(180deg, #fffbff 0%, var(--bg) 58%, #f7f1ff 100%); }
    .shell { max-width: 1080px; margin: 0 auto; padding: 30px 18px 46px; }
    .hero { display: grid; gap: 10px; margin-bottom: 22px; }
    .eyebrow { color: var(--primary-dark); font-weight: 700; font-size: 13px; }
    h1 { margin: 0; font-size: clamp(26px, 4vw, 40px); letter-spacing: 0; }
    .lead { max-width: 780px; color: var(--muted); line-height: 1.7; margin: 0; }
    .grid { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 18px; align-items: start; }
    .card { position: relative; background: rgba(255,255,255,.96); border: 1px solid transparent; border-radius: 8px; box-shadow: 0 22px 70px rgba(126, 34, 206, .14); overflow: hidden; }
    .card::before { content: ""; position: absolute; inset: 0; z-index: 0; border-radius: inherit; padding: 1px; pointer-events: none; background: linear-gradient(120deg, #c084fc, #a855f7, #ec4899, #22d3ee, #a855f7, #c084fc); background-size: 320% 320%; animation: borderFlow 6s linear infinite; -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude; }
    @keyframes borderFlow { 0% { background-position: 0% 50%; } 100% { background-position: 320% 50%; } }
    .card > * { position: relative; z-index: 1; }
    .section { padding: 20px; }
    .section + .section { border-top: 1px solid var(--line); }
    label { display: grid; gap: 7px; margin-bottom: 14px; font-size: 14px; font-weight: 650; }
    input { width: 100%; border: 1px solid #d8c7ea; border-radius: 6px; padding: 11px 12px; font-size: 14px; color: var(--text); background: #fff; outline: none; }
    input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(168, 85, 247, .16); }
    .hint { color: var(--muted); font-size: 12px; font-weight: 400; line-height: 1.55; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .row.three { grid-template-columns: 1.4fr .7fr 1fr; }
    .row.admin { align-items: start; }
    .group-title { margin: 0 0 14px; font-size: 15px; font-weight: 800; color: var(--primary-dark); }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    button { border: 0; border-radius: 6px; padding: 11px 16px; font-weight: 750; cursor: pointer; background: linear-gradient(135deg, #a855f7 0%, #9333ea 100%); color: #fff; box-shadow: 0 10px 22px rgba(168, 85, 247, .26); }
    button.secondary { background: var(--soft); color: var(--primary-dark); }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .status { display: grid; gap: 10px; }
    .pill { display: inline-flex; width: fit-content; align-items: center; gap: 8px; border-radius: 999px; padding: 7px 10px; font-size: 13px; font-weight: 750; background: var(--soft); color: var(--primary-dark); }
    .pill.bad { color: var(--danger); background: #fff0ee; }
    ul { margin: 0; padding-left: 18px; color: var(--muted); line-height: 1.65; }
    pre { margin: 0; min-height: 280px; max-height: 440px; overflow: auto; white-space: pre-wrap; word-break: break-word; background: var(--log); color: #edf2f7; border-radius: 8px; padding: 14px; font-size: 12px; line-height: 1.55; }
    .toast { margin-top: 12px; min-height: 22px; color: var(--muted); font-weight: 650; white-space: pre-wrap; }
    .toast.ok { color: var(--success); }
    .toast.error { color: var(--danger); }
    @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } .row, .row.three { grid-template-columns: 1fr; } .shell { padding-top: 24px; } }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div class="eyebrow">1Panel 部署</div>
      <h1>十业管理系统安装向导</h1>
      <p class="lead">填写数据库和管理员信息后，向导会生成生产密钥、初始化数据库、执行迁移并校验运行文件。脚本被浏览器或面板拦截时，本页也可以通过普通表单保存配置并开始安装。</p>
    </section>

    <section class="grid">
      <form class="card" id="form" method="post" action="/panel-install/config">
        <div class="section">
          <p class="group-title">运行设置</p>
          <div class="row">
            <label>端口
              <input name="port" value="${escapeHtml(values.port)}" inputmode="numeric" />
              <span class="hint">保持和 1Panel Node.js 运行环境端口一致。</span>
            </label>
            <label>管理路径
              <input name="adminPath" value="${escapeHtml(values.adminPath)}" autocomplete="off" />
              <span class="hint">默认即可，管理端使用这个路径访问。</span>
            </label>
          </div>
        </div>
        <div class="section">
          <p class="group-title">数据库设置</p>
          <div class="row three">
            <label>数据库地址
              <input name="dbHost" value="${escapeHtml(values.dbHost)}" placeholder="例如 mysql 或 1panel-mysql" autocomplete="off" required />
            </label>
            <label>端口
              <input name="dbPort" value="${escapeHtml(values.dbPort)}" inputmode="numeric" required />
            </label>
            <label>数据库名
              <input name="dbName" value="${escapeHtml(values.dbName)}" placeholder="shiye_management" autocomplete="off" required />
            </label>
          </div>
          <div class="row">
            <label>数据库用户名
              <input name="dbUser" value="${escapeHtml(values.dbUser)}" placeholder="shiye" autocomplete="off" required />
            </label>
            <label>数据库密码
              <input name="dbPassword" type="password" value="${escapeHtml(values.dbPassword)}" autocomplete="off" required />
            </label>
          </div>
          <span class="hint">1Panel 容器环境里通常不要写 127.0.0.1，优先使用数据库页面显示的内网地址或容器名。</span>
        </div>
        <div class="section">
          <p class="group-title">管理员设置</p>
          <div class="row admin">
            <label>管理员账号
              <input name="adminUsername" value="${escapeHtml(values.adminUsername)}" autocomplete="username" />
              <span class="hint">用于登录管理后台。</span>
            </label>
            <label>管理员密码
              <input name="adminPassword" type="password" autocomplete="new-password" />
              <span class="hint">首次安装必须填写；已保存后留空会沿用现有密码。</span>
            </label>
          </div>
          <div class="actions">
            <button type="submit" id="save">保存配置</button>
            <button type="submit" class="secondary" id="install" formaction="/panel-install/run"${status.installing ? ' disabled' : ''}>${status.installing ? '正在安装...' : '开始安装'}</button>
          </div>
          <div class="${flashClass}" id="toast">${escapeHtml(flash.message || '')}</div>
        </div>
        <div class="section">
          <pre id="logs">${escapeHtml(logsText)}</pre>
        </div>
      </form>

      <aside class="card">
        <div class="section status">
          <span class="${readyClass}" id="ready">${escapeHtml(readyText)}</span>
          <span class="hint">向导版本：${installerVersion}</span>
          <div>
            <strong>当前状态</strong>
            <ul id="checks">${checks.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
          </div>
        </div>
        <div class="section">
          <strong>安装完成后</strong>
          <ul>
            <li>回到 1Panel 重启 Node.js 运行环境。</li>
            <li>再次启动时，npm start 会自动进入正式 API。</li>
            <li>使用域名时，把整站反向代理到当前 Node.js 运行环境端口即可，例如 http://127.0.0.1:3388。</li>
          </ul>
        </div>
      </aside>
    </section>
  </main>
  <script defer src="/panel-install.js?v=${installerVersion}"></script>
</body>
</html>`;
}

function formValuesFromStatus(status) {
  const database = status.defaults.database || {};
  return {
    port: status.defaults.port || '3388',
    adminPath: status.defaults.adminPath || '/admin',
    dbHost: database.host || '',
    dbPort: database.port || '3306',
    dbName: database.name || '',
    dbUser: database.user || '',
    dbPassword: database.password || '',
    adminUsername: status.defaults.adminUsername || 'admin'
  };
}

function statusChecks(status) {
  const items = [];
  if (!status.envOk) items.push(...status.envErrors);
  if (!status.installedMarker) items.push('尚未完成网页向导安装。');
  if (status.missingFiles.length) items.push('缺少构建产物：' + status.missingFiles.join('、'));
  if (!items.length) items.push(status.ready ? '配置和构建产物已就绪。' : '配置已就绪，可以开始安装。');
  return items;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
