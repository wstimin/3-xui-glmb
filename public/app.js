const app = document.querySelector('#app');
const entryMode = document.body.dataset.entry || 'user';
const BUILD_VERSION = '20260708-user-recharge-layout-v4';

if (location.protocol === 'file:') {
  app.innerHTML = `
    <section class="login-wrap">
      <div class="login-card">
        <h1>需要通过服务访问</h1>
        <p>请先在服务器运行 npm start，然后访问 http://服务器IP:3388。</p>
      </div>
    </section>`;
  throw new Error('请通过 Node.js 服务访问本系统。');
}

const state = {
  user: null,
  role: '',
  view: 'customers',
  userView: 'user-home',
  db: null,
  branding: { brandName: '十夜', logoDataUrl: '' },
  setupRequired: false,
  setupForm: {
    host: '127.0.0.1',
    port: '3306',
    database: 'shiye_management',
    user: 'shiye',
    password: ''
  },
  drawer: null,
  modal: null,
  paymentEditor: '',
  search: '',
  busyAction: '',
  toast: ''
};

let modalResolver = null;

const statusText = {
  active: '正常',
  warning: '将到期',
  expired: '已过期',
  disabled: '已停用',
  success: '成功',
  failed: '失败',
  pending: '待支付',
  paid: '已支付',
  unused: '未使用',
  used: '已使用',
  enabled: '启用'
};

const adminNavItems = [
  ['customers', '用户管理', 'U'],
  ['servers', '3x-ui 节点', 'N'],
  ['service-nodes', '服务节点', 'V'],
  ['socks', 'SOCKS 出站', 'S'],
  ['cards', '卡密管理', 'C'],
  ['finance', '财务流水', 'F'],
  ['logs', '同步日志', 'L'],
  ['settings', '系统设置', 'G'],
  ['payments', '支付设置', 'P'],
  ['security', '账号安全', 'A']
];

const userNavItems = [
  ['user-home', '充值续费', 'B'],
  ['user-nodes', '节点管理', 'N'],
  ['user-profile', '账号资料', 'A']
];

function branding() {
  const settings = state.db?.settings || state.branding || {};
  return {
    brandName: settings.brandName || '十夜',
    logoDataUrl: settings.logoDataUrl || ''
  };
}

function brandMark(extraClass = '') {
  const brand = branding();
  const className = ['brand-mark', extraClass].filter(Boolean).join(' ');
  if (brand.logoDataUrl) return `<span class="${className}"><img src="${h(brand.logoDataUrl)}" alt="${h(brand.brandName)}"></span>`;
  return `<span class="${className}">${h(brand.brandName.slice(0, 2))}</span>`;
}

function appTitle(suffix = '管理系统') {
  return `${branding().brandName}${suffix}`;
}

function generatedFavicon(text) {
  const label = String(text || '十夜').trim().slice(0, 2) || '十夜';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2563eb"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-family="Arial,'Microsoft YaHei',sans-serif" font-size="24" font-weight="700" fill="white">${h(label)}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

function setFavicon() {
  const brand = branding();
  const href = brand.logoDataUrl || generatedFavicon(brand.brandName);
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = href;
}

async function loadBranding() {
  try {
    const result = await api('/api/public/branding');
    state.branding = result.settings || state.branding;
    document.title = appTitle(entryMode === 'admin' ? '管理系统' : '用户中心');
    setFavicon();
  } catch {}
}

function h(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false }).replaceAll('/', '-');
}

function customerBindings(customerId) {
  return (state.db.customerNodes || []).filter((item) => item.customerId === customerId);
}

function serviceNodeById(id) {
  return (state.db.serviceNodes || []).find((item) => item.id === id) || null;
}

function customerById(id) {
  return (state.db.customers || []).find((item) => item.id === id) || null;
}

function userNodes() {
  return Array.isArray(state.db?.nodes) ? state.db.nodes : [];
}

function earliestNode(nodes) {
  return nodes.filter((node) => node.expireAt).sort((a, b) => new Date(a.expireAt) - new Date(b.expireAt))[0] || null;
}

function isBusy(action) {
  return state.busyAction === action;
}

function setBusy(action) {
  state.busyAction = action;
  render();
}

function clearBusy(action) {
  if (state.busyAction === action) {
    state.busyAction = '';
    render();
  }
}

function customerNodeName(binding) {
  const node = serviceNodeById(binding?.nodeId);
  return binding?.name || node?.name || '当前节点';
}

function customerNodeStatus(binding) {
  const node = serviceNodeById(binding?.nodeId);
  if (binding?.status === 'disabled' || node?.status === 'disabled') return 'disabled';
  if (!binding?.expireAt) return binding?.status || 'active';
  const ms = new Date(binding.expireAt).getTime() - Date.now();
  if (ms < 0) return 'expired';
  if (ms <= 3 * 24 * 60 * 60 * 1000) return 'warning';
  return 'active';
}

function dateInputValue(value) {
  if (!value) return '';
  const date = new Date(value);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toIsoLocal(value) {
  return value ? new Date(value).toISOString() : '';
}

function toast(message) {
  let el = document.querySelector('[data-toast]');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.dataset.toast = 'true';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.remove();
  }, 3600);
}

function openModal(options) {
  state.modal = {
    title: options.title || '请确认',
    message: options.message || '',
    tone: options.tone || 'default',
    input: options.input || null,
    content: options.content || '',
    objectUrl: options.objectUrl || '',
    confirmText: options.confirmText || '确定',
    cancelText: options.cancelText || '取消'
  };
  render();
  return new Promise((resolve) => {
    modalResolver = resolve;
    requestAnimationFrame(() => document.querySelector('[data-modal-input]')?.focus());
  });
}

function closeModal(value) {
  if (state.modal?.objectUrl) URL.revokeObjectURL(state.modal.objectUrl);
  state.modal = null;
  const resolve = modalResolver;
  modalResolver = null;
  render();
  if (resolve) resolve(value);
}

function confirmDialog(title, message, options = {}) {
  return openModal({ title, message, tone: options.tone, confirmText: options.confirmText, cancelText: options.cancelText });
}

function promptDialog(title, message, value = '') {
  return openModal({ title, message, input: { value }, confirmText: '保存' });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Entry-Mode': entryMode, ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.detail || data.message || '请求失败');
  return data;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

async function bootstrap() {
  await loadBranding();
  try {
    const setup = await api('/api/setup/status');
    if (!setup.installed) {
      state.setupRequired = true;
      state.user = null;
      state.role = '';
      state.db = null;
      renderSetup();
      return;
    }
    state.setupRequired = false;
    const result = await api(`/api/bootstrap?entry=${encodeURIComponent(entryMode)}`);
    state.user = result.user;
    state.role = result.role || 'admin';
    state.db = result.data;
    if (state.role === 'user') state.userView ||= 'user-home';
    render();
  } catch {
    state.user = null;
    state.role = '';
    state.db = null;
    renderLogin();
  }
}

function renderSetup() {
  const setup = state.setupForm;
  app.innerHTML = `
    <section class="login-wrap setup-wrap">
      <div class="login-shell setup-shell">
        <aside class="login-hero">
          ${brandMark('login-hero-mark')}
          <h2>${h(appTitle('管理系统'))}</h2>
          <p>面向 3x-ui 用户运营的统一管理后台。</p>
          <div class="login-hero-grid"><span>MySQL</span><span>3x-ui</span><span>支付</span><span>续费</span></div>
        </aside>
        <form class="login-card setup-card" id="setupForm">
          <div class="login-card-mark">安装</div>
          <h1>首次安装</h1>
          <p>填写 MySQL 数据库信息，系统会测试连接并自动创建所需数据表。</p>
          <div class="setup-grid">
            <div class="field"><label>数据库地址</label><input name="host" value="${h(setup.host)}" required></div>
            <div class="field"><label>端口</label><input name="port" type="number" value="${h(setup.port)}" min="1" required></div>
            <div class="field"><label>数据库名称</label><input name="database" value="${h(setup.database)}" required></div>
            <div class="field"><label>数据库账号</label><input name="user" value="${h(setup.user)}" autocomplete="username" required></div>
            <div class="field full"><label>数据库密码</label><input name="password" type="password" value="${h(setup.password)}" autocomplete="current-password"></div>
          </div>
          <button class="btn primary login-submit" type="submit">连接并安装</button>
        </form>
      </div>
    </section>`;

  const setupForm = document.querySelector('#setupForm');
  setupForm.addEventListener('input', (event) => {
    if (!event.target.name) return;
    state.setupForm[event.target.name] = event.target.value;
  });
  setupForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    state.setupForm = { ...state.setupForm, ...Object.fromEntries(form) };
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = '正在安装...';
    try {
      await api('/api/setup/install', { method: 'POST', body: Object.fromEntries(form) });
      toast('安装完成，请使用管理员账号登录');
      await bootstrap();
    } catch (error) {
      toast(error.message);
      button.disabled = false;
      button.textContent = '连接并安装';
    }
  });
}

async function refresh() {
  const result = await api(`/api/bootstrap?entry=${encodeURIComponent(entryMode)}`);
  state.user = result.user;
  state.role = result.role || state.role;
  state.db = result.data;
  render();
}

function renderLogin() {
  app.innerHTML = `
    <section class="login-wrap">
      <div class="login-shell">
        <aside class="login-hero">
          ${brandMark('login-hero-mark')}
          <h2>${entryMode === 'admin' ? '管理系统' : '用户中心'}</h2>
          <p>${entryMode === 'admin' ? '用户、服务、卡密、财务与支付配置集中管理。' : '余额充值、卡密兑换与服务续费统一处理。'}</p>
          <div class="login-hero-grid"><span>账户</span><span>余额</span><span>支付</span><span>续费</span></div>
        </aside>
        <form class="login-card" id="loginForm">
          <div class="login-card-mark">${entryMode === 'admin' ? '后台' : '用户'}</div>
          <h1>${h(appTitle(entryMode === 'admin' ? '管理系统' : '用户中心'))}</h1>
          <p>${entryMode === 'admin' ? '管理员后台入口。普通用户请从用户中心登录。' : '用户使用管理员创建的账号登录。用户端不开放注册。'}</p>
          <div class="field"><label>账号</label><input name="username" autocomplete="username" required></div>
          <div class="field"><label>密码</label><input name="password" type="password" autocomplete="current-password" required></div>
          <button class="btn primary login-submit" type="submit">登录</button>
        </form>
      </div>
    </section>`;

  document.querySelector('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    const originalText = button?.textContent || '登录';
    if (button) {
      button.disabled = true;
      button.classList.add('loading');
      button.textContent = '正在登录...';
    }
    const form = new FormData(event.currentTarget);
    try {
      await api('/api/login', { method: 'POST', body: { ...Object.fromEntries(form), entry: entryMode } });
      await bootstrap();
    } catch (error) {
      toast(error.message);
      if (button) {
        button.disabled = false;
        button.classList.remove('loading');
        button.textContent = originalText;
      }
    }
  });
}

function render() {
  if (state.setupRequired) return renderSetup();
  if (!state.db) return renderLogin();
  if (state.role === 'user') return renderUserApp();
  return renderAdminApp();
}

function navButton(view, label, icon, activeView) {
  return `<button class="${activeView === view ? 'active' : ''}" data-view="${view}" data-icon="${icon}">${label}</button>`;
}

function pageTitle() {
  return {
    customers: '用户管理',
    cards: '卡密管理',
    finance: '财务流水',
    servers: '3x-ui 节点',
    'service-nodes': '服务节点',
    socks: 'SOCKS 出站',
    logs: '同步日志',
    settings: '系统设置',
    payments: '支付设置',
    security: '账号安全'
  }[state.view] || '用户管理';
}

function stats() {
  const customers = state.db.customers || [];
  return {
    total: customers.length,
    active: customers.filter((c) => c.computedStatus === 'active').length,
    warning: customers.filter((c) => c.computedStatus === 'warning').length,
    expired: customers.filter((c) => c.computedStatus === 'expired').length,
    disabled: customers.filter((c) => c.computedStatus === 'disabled').length
  };
}

function renderAdminApp() {
  const s = stats();
  document.title = appTitle('管理系统');
  app.innerHTML = `
    <section class="app-shell">
      <aside class="sidebar">
        <div class="brand">${brandMark()}<span>${h(appTitle('管理系统'))}</span></div>
        <nav class="nav">${adminNavItems.map(([view, label, icon]) => navButton(view, label, icon, state.view)).join('')}</nav>
        <div class="sidebar-footer">登录用户：${h(state.user)}<br>版本：0.4.1<br>数据存储：服务器数据库</div>
      </aside>
      <section class="content">
        <div class="topbar">
          <div>
            <div class="eyebrow">3x-ui 用户运营后台</div>
            <h1>${pageTitle()}</h1>
            <div class="sub">管理员后台管理用户、卡密、3x-ui 节点和 SOCKS 中转。</div>
          </div>
          <div class="actions">
            <button class="btn" data-action="disable-expired">停用过期用户</button>
            <button class="btn" data-action="refresh">刷新</button>
            <button class="btn danger" data-action="logout">退出</button>
          </div>
        </div>
        <div class="stats">
          <div class="stat total"><span>用户总数</span><strong>${s.total}</strong><small>当前系统记录</small></div>
          <div class="stat"><span>正常</span><strong>${s.active}</strong><small>可正常使用</small></div>
          <div class="stat"><span>将到期</span><strong>${s.warning}</strong><small>3 天内到期</small></div>
          <div class="stat"><span>已过期</span><strong>${s.expired}</strong><small>等待续费或停用</small></div>
          <div class="stat"><span>已停用</span><strong>${s.disabled}</strong><small>已关闭服务</small></div>
        </div>
        ${state.db.settings?.defaultPasswordWarning ? `<div class="security-warning"><strong>当前仍在使用默认管理员密码。</strong><span>公网部署建议修改管理员密码。</span><button class="btn small" data-view="security">账号安全</button></div>` : ''}
        ${renderAdminView()}
      </section>
    </section>
    ${state.drawer ? renderDrawer() : ''}
    ${state.modal ? renderModal() : ''}`;
  bindEvents();
}

function renderAdminView() {
  if (state.view === 'cards') return renderCards();
  if (state.view === 'finance') return renderFinance();
  if (state.view === 'servers') return renderServers();
  if (state.view === 'service-nodes') return renderServiceNodes();
  if (state.view === 'socks') return renderSocks();
  if (state.view === 'logs') return renderLogs();
  if (state.view === 'settings') return renderSystemSettings();
  if (state.view === 'payments') return renderPaymentSettings();
  if (state.view === 'security') return renderAccountSecurity();
  return renderCustomers();
}

function renderCustomers() {
  const term = state.search.toLowerCase();
  const rows = (state.db.customers || []).filter((customer) => [
    customer.name,
    customer.contact,
    customer.loginUsername,
    customer.remark,
    ...customerBindings(customer.id).map((binding) => `${binding.name || ''} ${binding.clientEmail || ''}`)
  ].join(' ').toLowerCase().includes(term));

  return `
    <div class="toolbar">
      <div class="toolbar-left"><input class="search" placeholder="搜索用户、登录账号、联系方式、客户端邮箱" value="${h(state.search)}" data-search></div>
      <div class="toolbar-right"><button class="btn primary" data-action="new-customer">+ 新建用户</button></div>
    </div>
    <section class="panel">
      <div class="panel-head"><div><h2>用户列表</h2><p>管理员创建用户登录账号，用户端不能自行注册。</p></div></div>
      <table><thead><tr>
        <th style="width:170px">用户</th><th style="width:126px">登录账号</th><th style="width:110px">余额</th><th style="width:150px">绑定节点</th><th style="width:180px">最近到期</th><th style="width:88px">状态</th><th style="width:420px">操作</th>
      </tr></thead><tbody>${rows.length ? rows.map(customerRow).join('') : `<tr><td colspan="7" class="empty">还没有用户，点击右上角新建用户。</td></tr>`}</tbody></table>
    </section>`;
}

function customerRow(customer) {
  const bindings = customerBindings(customer.id);
  const earliest = bindings.filter((item) => item.expireAt).sort((a, b) => new Date(a.expireAt) - new Date(b.expireAt))[0];
  return `<tr>
    <td class="main-cell"><strong>${h(customer.name)}</strong><div class="line mono">${h(customer.id || '-')}</div></td>
    <td>${h(customer.loginUsername || '-')}<div class="muted">${h(customer.contact || '')}</div></td>
    <td>${money(customer.balance)} ${h(state.db.settings.currency)}</td>
    <td>${bindings.length}<div class="muted">${bindings.slice(0, 2).map((item) => h(customerNodeName(item))).join('、') || '未绑定'}</div></td>
    <td>${earliest ? fmtDate(earliest.expireAt) : '-'}</td>
    <td><span class="status ${customer.computedStatus}">${statusText[customer.computedStatus] || customer.computedStatus}</span></td>
    <td><div class="row-actions">
      <button class="btn small primary" data-action="bind-customer-node" data-id="${customer.id}">绑定节点</button>
      <button class="btn small" data-action="manage-customer-nodes" data-id="${customer.id}">节点管理</button>
      <button class="btn small" data-action="adjust-balance" data-id="${customer.id}">调余额</button>
      <button class="btn small" data-action="sync" data-id="${customer.id}">同步</button>
      <button class="btn small" data-action="edit-customer" data-id="${customer.id}">编辑</button>
      <button class="btn small" data-action="toggle" data-id="${customer.id}">${customer.status === 'disabled' ? '启用' : '停用'}</button>
      <button class="btn small danger" data-action="delete-customer" data-id="${customer.id}">删除</button>
    </div></td>
  </tr>`;
}

function balanceTypeText(type) {
  return {
    card_redeem: '卡密充值',
    online_recharge: '在线充值',
    user_renew: '用户续费',
    admin_add: '管理员增加',
    admin_subtract: '管理员扣减',
    admin_set: '管理员设置'
  }[type] || type || '-';
}

function renewalSourceText(source) {
  return { user: '用户自助', admin: '管理员' }[source] || source || '-';
}

function paymentProviderText(provider) {
  return {
    alipay_native: '支付宝直连',
    epay: '彩虹易支付',
    bepusdt_native: 'BEpusdt 原生',
    wechat_native: '微信官方 V3'
  }[provider] || provider || '-';
}

function paymentMethodText(method) {
  return {
    alipay: '支付宝',
    alipay_page: '支付宝电脑网站',
    alipay_wap: '支付宝H5',
    alipay_precreate: '支付宝当面付扫码',
    wxpay: '微信',
    paypal: 'PayPal',
    usdt: 'USDT-TRC20',
    'usdt.trc20': 'USDT-TRC20',
    bepusdt_native: 'BEpusdt USDT-TRC20',
    wechat_native: '微信扫码',
    native: '扫码支付'
  }[method] || method || '-';
}

function renderFinance() {
  const balanceLogs = state.db.balanceLogs || [];
  const renewalLogs = state.db.renewalLogs || [];
  const rechargeOrders = state.db.rechargeOrders || [];
  return `
    <section class="panel">
      <div class="panel-head"><div><h2>在线充值订单</h2><p>记录支付宝、易支付、微信、PayPal 和 USDT 通道创建的充值订单。</p></div></div>
      <table><thead><tr><th style="width:160px">创建时间</th><th style="width:150px">用户</th><th style="width:120px">支付平台</th><th style="width:110px">支付方式</th><th style="width:110px">金额</th><th style="width:90px">状态</th><th style="width:190px">本站订单号</th><th>通道订单号</th></tr></thead>
      <tbody>${rechargeOrders.length ? rechargeOrders.map((order) => `<tr><td>${fmtDate(order.createdAt)}</td><td>${h(order.customerName || order.customerId || '-')}</td><td>${h(paymentProviderText(order.provider))}</td><td>${h(paymentMethodText(order.method))}</td><td>${money(order.amount)} ${h(state.db.settings.currency)}</td><td><span class="status ${order.status === 'paid' ? 'success' : order.status === 'failed' ? 'failed' : 'warning'}">${statusText[order.status] || order.status || '-'}</span></td><td class="mono">${h(order.tradeNo || '-')}</td><td class="mono">${h(order.channelTradeNo || '-')}</td></tr>`).join('') : `<tr><td colspan="8" class="empty">还没有在线充值订单。</td></tr>`}</tbody></table>
    </section>
    <section class="panel">
      <div class="panel-head"><div><h2>余额流水</h2><p>记录卡密充值、用户续费扣款和管理员手动调整余额。</p></div></div>
      <table><thead><tr><th style="width:160px">时间</th><th style="width:150px">用户</th><th style="width:110px">类型</th><th style="width:110px">变动</th><th style="width:190px">余额变化</th><th style="width:120px">操作人</th><th>备注</th></tr></thead>
      <tbody>${balanceLogs.length ? balanceLogs.map((log) => `<tr><td>${fmtDate(log.createdAt)}</td><td>${h(log.customerName || log.customerId || '-')}</td><td>${h(balanceTypeText(log.type))}</td><td class="mono ${Number(log.amount || 0) < 0 ? 'danger-text' : 'success-text'}">${Number(log.amount || 0) > 0 ? '+' : ''}${money(log.amount)}</td><td class="mono">${money(log.beforeBalance)} → ${money(log.afterBalance)}</td><td>${h(log.operator || '-')}</td><td>${h(log.remark || '-')}</td></tr>`).join('') : `<tr><td colspan="7" class="empty">还没有余额流水。</td></tr>`}</tbody></table>
    </section>
    <section class="panel">
      <div class="panel-head"><div><h2>续费记录</h2><p>记录用户自助续费和管理员后台续费，便于对账。</p></div></div>
      <table><thead><tr><th style="width:160px">时间</th><th style="width:150px">用户</th><th style="width:90px">来源</th><th style="width:80px">月数</th><th style="width:110px">金额</th><th style="width:250px">到期变化</th><th style="width:90px">状态</th><th>说明</th></tr></thead>
      <tbody>${renewalLogs.length ? renewalLogs.map((log) => `<tr><td>${fmtDate(log.createdAt)}</td><td>${h(log.customerName || log.customerId || '-')}</td><td>${h(renewalSourceText(log.source))}</td><td>${h(log.months || 1)}</td><td>${money(log.price)} ${h(state.db.settings.currency)}</td><td>${fmtDate(log.beforeExpireAt)} → ${fmtDate(log.afterExpireAt)}</td><td><span class="status ${log.status === 'warning' ? 'warning' : log.status === 'success' ? 'success' : 'active'}">${statusText[log.status] || log.status || '-'}</span></td><td>${h(log.message || '-')}</td></tr>`).join('') : `<tr><td colspan="8" class="empty">还没有续费记录。</td></tr>`}</tbody></table>
    </section>`;
}

function cardType(card) {
  const fallback = `${money(card.amount)} ${state.db.settings.currency || 'CNY'}`;
  return String(card.batchName || card.type || card.remark || fallback).trim() || fallback;
}

function cardGroups() {
  const groups = new Map();
  for (const card of state.db.cards || []) {
    const type = cardType(card);
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(card);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, 'zh-CN'));
}

function renderCardGroups() {
  const entries = cardGroups();
  if (!entries.length) return '';
  return `<section class="card-groups">${entries.map(([type, cards], index) => {
    const unused = cards.filter((card) => card.status === 'unused');
    const usedCount = cards.filter((card) => card.status === 'used').length;
    const disabledCount = cards.filter((card) => card.status === 'disabled').length;
    const codes = unused.map((card) => card.code).join('\n');
    return `<div class="card-group">
      <div class="card-group-head"><div><h2>${h(type)}</h2><p>未使用 ${unused.length} 张，已使用 ${usedCount} 张，已禁用 ${disabledCount} 张</p></div><div class="card-group-actions"><button class="btn small" data-action="copy-card-group" data-index="${index}">一键复制</button><button class="btn small" data-action="generate-card-group" data-index="${index}">继续生成</button><button class="btn small" data-action="rename-card-group" data-index="${index}">改名称</button><button class="btn small danger" data-action="delete-card-group" data-index="${index}">删除未使用</button></div></div>
      <textarea class="copy-area mono" data-card-group="${index}" readonly>${h(codes)}</textarea>
    </div>`;
  }).join('')}</section>`;
}

function getCardGroup(index) {
  const entry = cardGroups()[Number(index)];
  if (!entry) return null;
  const [type, cards] = entry;
  const batchId = cards[0]?.batchId && cards.every((card) => card.batchId === cards[0].batchId) ? cards[0].batchId : '';
  return { type, cards, batchId };
}

function renderCards() {
  const unused = state.db.cards.filter((card) => card.status === 'unused').length;
  const used = state.db.cards.filter((card) => card.status === 'used').length;
  return `
    <div class="toolbar">
      <div class="toolbar-left"><span class="muted">未使用 ${unused} 张，已使用 ${used} 张</span></div>
      <div class="toolbar-right"><button class="btn primary" data-action="generate-cards">+ 生成卡密</button></div>
    </div>
    ${renderCardGroups()}
    <section class="panel">
      <div class="panel-head"><div><h2>卡密管理</h2><p>用户只能通过兑换卡密充值余额。购买卡密按钮会跳转到这里设置的外部发卡网站。</p></div></div>
      <table><thead><tr><th style="width:230px">卡密</th><th style="width:100px">金额</th><th style="width:120px">分类</th><th style="width:90px">状态</th><th style="width:150px">使用用户</th><th style="width:170px">使用时间</th><th>备注</th><th style="width:180px">操作</th></tr></thead>
      <tbody>${state.db.cards.length ? state.db.cards.map(cardRow).join('') : `<tr><td colspan="8" class="empty">还没有卡密，点击右上角生成。</td></tr>`}</tbody></table>
    </section>`;
}

function cardRow(card) {
  return `<tr>
    <td class="mono">${h(card.code)}</td>
    <td>${money(card.amount)} ${h(state.db.settings.currency)}</td>
    <td>${h(cardType(card))}</td>
    <td><span class="status ${card.status === 'used' ? 'success' : card.status === 'disabled' ? 'disabled' : 'active'}">${statusText[card.status] || card.status}</span></td>
    <td>${h(card.usedByName || '-')}</td>
    <td>${fmtDate(card.usedAt)}</td>
    <td>${h(card.remark || '-')}</td>
    <td><div class="row-actions">
      ${card.status !== 'used' ? `<button class="btn small" data-action="toggle-card" data-id="${card.id}">${card.status === 'disabled' ? '启用' : '禁用'}</button><button class="btn small danger" data-action="delete-card" data-id="${card.id}">删除</button>` : '<span class="muted">已使用</span>'}
    </div></td>
  </tr>`;
}

function renderServers() {
  return `
    <div class="toolbar"><div class="toolbar-left"></div><div class="toolbar-right"><button class="btn primary" data-action="new-server">+ 添加 3x-ui 节点</button></div></div>
    <section class="panel">
      <div class="panel-head"><div><h2>3x-ui 节点</h2><p>保存中心面板或远程节点连接信息，用于用户同步。</p></div></div>
      <table><thead><tr><th style="width:190px">名称</th><th>地址</th><th style="width:110px">基础路径</th><th style="width:160px">账号 / API</th><th style="width:90px">状态</th><th style="width:320px">操作</th></tr></thead>
      <tbody>${state.db.xuiServers.length ? state.db.xuiServers.map(serverRow).join('') : `<tr><td colspan="6" class="empty">还没有 3x-ui 节点。</td></tr>`}</tbody></table>
    </section>`;
}

function serverRow(server) {
  return `<tr>
    <td class="main-cell"><strong>${h(server.name)}</strong><div class="muted">${h(server.remark || '无备注')}</div></td>
    <td class="mono">${h(server.protocol)}://${h(server.host)}:${h(server.port)}</td>
    <td class="mono">${h(server.basePath)}</td>
    <td>${h(server.username || '-')}<div class="muted">${server.apiToken ? 'Token 已保存' : '无 Token'}</div></td>
    <td><span class="status ${server.status === 'enabled' ? 'active' : 'disabled'}">${server.status === 'enabled' ? '启用' : '停用'}</span></td>
    <td><div class="row-actions"><button class="btn small" data-action="test-server" data-id="${server.id}">测试</button><button class="btn small primary" data-action="sync-service-nodes" data-id="${server.id}">同步节点</button><button class="btn small" data-action="edit-server" data-id="${server.id}">编辑</button><button class="btn small danger" data-action="delete-server" data-id="${server.id}">删除</button></div></td>
  </tr>`;
}

function renderServiceNodes() {
  return `
    <div class="toolbar"><div class="toolbar-left"></div><div class="toolbar-right"><button class="btn primary" data-action="new-service-node">+ 添加服务节点</button></div></div>
    <section class="panel">
      <div class="panel-head"><div><h2>服务节点</h2><p>配置可绑定给用户的节点模板。一个面板服务器可以创建多个服务节点。</p></div></div>
      <table><thead><tr><th style="width:190px">节点名称</th><th style="width:160px">所属面板</th><th style="width:120px">入站</th><th style="width:120px">价格</th><th style="width:100px">流量</th><th style="width:120px">绑定用户</th><th style="width:90px">状态</th><th style="width:210px">操作</th></tr></thead>
      <tbody>${(state.db.serviceNodes || []).length ? state.db.serviceNodes.map(serviceNodeRow).join('') : `<tr><td colspan="8" class="empty">还没有服务节点。先添加面板节点，再创建服务节点。</td></tr>`}</tbody></table>
    </section>`;
}

function serviceNodeRow(node) {
  const server = state.db.xuiServers.find((item) => item.id === node.xuiServerId);
  const count = (state.db.customerNodes || []).filter((item) => item.nodeId === node.id).length;
  return `<tr>
    <td class="main-cell"><strong>${h(node.name)}</strong><div class="muted">${h(node.remark || '无备注')}</div></td>
    <td>${h(server?.name || '-')}</td>
    <td>${node.autoCreateInbound ? '自动创建' : `ID ${h(node.inboundId || '-')}`}<div class="muted">${h(node.inboundTemplate || 'vless-tcp')}</div></td>
    <td>${money(node.amount)} ${h(state.db.settings.currency)}<div class="muted">每月</div></td>
    <td>${h(node.trafficLimitGb || 0)} GB</td>
    <td>${count}</td>
    <td><span class="status ${node.status === 'enabled' ? 'active' : 'disabled'}">${node.status === 'enabled' ? '启用' : '停用'}</span></td>
    <td><div class="row-actions"><button class="btn small" data-action="edit-service-node" data-id="${node.id}">编辑</button><button class="btn small danger" data-action="delete-service-node" data-id="${node.id}">删除</button></div></td>
  </tr>`;
}

function renderSocks() {
  return `
    <div class="toolbar"><div class="toolbar-left"></div><div class="toolbar-right"><button class="btn primary" data-action="new-socks">+ 添加 SOCKS 出站</button></div></div>
    <section class="panel">
      <div class="panel-head"><div><h2>SOCKS 出站</h2><p>维护可复用的 SOCKS 中转，用户资料里可以绑定。</p></div></div>
      <table><thead><tr><th style="width:190px">名称</th><th>地址</th><th style="width:130px">认证</th><th style="width:150px">标识</th><th style="width:100px">绑定用户</th><th style="width:90px">状态</th><th style="width:210px">操作</th></tr></thead>
      <tbody>${state.db.socksNodes.length ? state.db.socksNodes.map(socksRow).join('') : `<tr><td colspan="7" class="empty">还没有 SOCKS 出站。</td></tr>`}</tbody></table>
    </section>`;
}

function socksRow(socks) {
  const count = (state.db.customerNodes || []).filter((binding) => {
    const node = serviceNodeById(binding.nodeId);
    return node?.useSocks && node.socksNodeId === socks.id;
  }).length;
  return `<tr>
    <td class="main-cell"><strong>${h(socks.name)}</strong><div class="muted">${h(socks.remark || '无备注')}</div></td>
    <td class="mono">${h(socks.address)}:${h(socks.port)}</td>
    <td>${h(socks.username || '-')}</td>
    <td class="mono">${h(socks.tag)}</td>
    <td>${count}</td>
    <td><span class="status ${socks.status === 'enabled' ? 'active' : 'disabled'}">${socks.status === 'enabled' ? '启用' : '停用'}</span></td>
    <td><div class="row-actions"><button class="btn small" data-action="edit-socks" data-id="${socks.id}">编辑</button><button class="btn small danger" data-action="delete-socks" data-id="${socks.id}">删除</button></div></td>
  </tr>`;
}

function renderLogs() {
  return `<section class="panel">
    <div class="panel-head"><div><h2>同步日志</h2><p>记录用户创建、续费、购买、停用和同步到 3x-ui 的结果。</p></div></div>
    <table><thead><tr><th style="width:178px">时间</th><th style="width:140px">用户</th><th style="width:110px">类型</th><th style="width:90px">状态</th><th>消息</th></tr></thead>
    <tbody>${state.db.syncLogs.length ? state.db.syncLogs.map(logRow).join('') : `<tr><td colspan="5" class="empty">暂无日志。</td></tr>`}</tbody></table>
  </section>`;
}

function logRow(log) {
  const customer = state.db.customers.find((item) => item.id === log.customerId);
  return `<tr>
    <td>${fmtDate(log.createdAt)}</td>
    <td>${h(customer?.name || log.customerId)}</td>
    <td>${h(log.type)}</td>
    <td><span class="status ${log.status}">${statusText[log.status] || log.status}</span></td>
    <td>${h(log.message)}<div class="log-detail">${h(JSON.stringify(log.detail || {}))}</div></td>
  </tr>`;
}

function renderSystemSettings() {
  const settings = state.db.settings || {};
  return `<section class="panel settings-panel">
    <div class="panel-head"><div><h2>系统设置</h2><p>配置后台入口、基础参数和用户端购买卡密跳转地址。</p></div></div>
    <form class="panel-body settings-form" data-settings-form="settings">
      ${renderSection('品牌展示', `
        <div class="brand-settings-grid">
          <div class="brand-preview">${brandMark()}<div><strong>${h(appTitle('管理系统'))}</strong><span>登录页、侧边栏和用户中心会同步更新</span></div></div>
          <div class="field"><label>系统名前缀</label><input name="brandName" value="${h(settings.brandName || '十夜')}" maxlength="24" placeholder="例如：十夜"></div>
          <div class="field"><label>顶部图标</label><input name="logoFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"><input name="logoDataUrl" type="hidden" value="${h(settings.logoDataUrl || '')}"></div>
          <label class="check-row logo-clear"><input name="clearLogo" type="checkbox"> 清除当前图标，恢复文字标识</label>
        </div>
      `)}
      ${renderSection('系统入口', `
        <div class="field"><label>管理员入口路径</label><input name="adminPath" value="${h(settings.adminPath || '/admin')}" placeholder="/admin"></div>
        <div class="form-note">保存后新的管理员入口立即生效，例如 /admin 或 /myadmin2026。当前页面刷新后请使用新路径进入后台。</div>
      `)}
      ${renderSection('基础设置', `
        <div class="grid-2"><div class="field"><label>货币单位</label><input name="currency" value="${h(settings.currency || 'CNY')}"></div><div class="field"><label>到期提醒天数</label><input name="expiryWarningDays" type="number" min="1" value="${h(settings.expiryWarningDays || 3)}"></div></div>
      `)}
      ${renderSection('用户端购买链接', `
        <div class="field"><label>购买卡密链接</label><input name="purchaseCardUrl" value="${h(settings.purchaseCardUrl || '')}" placeholder="https://你的发卡网站.example.com"></div>
        <div class="form-note">用户点击“购买卡密”按钮时，会直接跳转到这个链接。卡密兑换余额功能会继续保留。</div>
      `)}
      <div class="form-actions"><button class="btn primary" type="submit">保存系统设置</button></div>
    </form>
  </section>`;
}

function renderPaymentSettingsLegacy() {
  return renderPaymentSettings();
  const pay = state.db.settings?.payments || {};
  const epay = pay.epay || { methods: {} };
  const epayTypes = epay.types || {};
  const alipay = pay.alipay || { methods: {} };
  const alipayMethods = alipay.methods || {};
  const bepusdt = pay.bepusdt || {};
  const wechat = pay.wechat || {};
  return `<section class="panel settings-panel">
    <div class="panel-head"><div><h2>支付设置</h2><p>选择启用的收款方式，只填写对应渠道需要的参数。</p></div></div>
    <form class="panel-body settings-form" data-settings-form="payments">
      <input type="hidden" name="paymentSettingsSubmitted" value="1">
      ${renderSection('基础支付配置', `
        <div class="grid-3"><div class="field"><label>在线支付总开关</label><label class="check-row"><input name="paymentsEnabled" type="checkbox" ${pay.enabled ? 'checked' : ''}> 启用在线充值</label></div><div class="field"><label>最低充值金额</label><input name="paymentMinAmount" type="number" min="0.01" step="0.01" value="${h(pay.minAmount || 1)}"></div><div class="field"><label>快捷金额</label><input name="paymentAmounts" value="${h((pay.amounts || [10, 30, 50, 100]).join(','))}" placeholder="10,30,50,100"></div></div>
        <div class="field"><label>公网访问地址</label><input name="paymentSiteUrl" value="${h(pay.siteUrl || '')}" placeholder="https://你的域名.com"></div>
        <div class="form-note">如果下方回调地址或跳转地址留空，系统会用这里的公网地址自动生成。支付平台必须能访问这个域名。</div>
      `)}
      <div class="payment-provider-grid">
        <section class="payment-provider" data-payment-section="alipay">
          <div class="payment-provider-head"><div><h3>支付宝开放平台直连</h3><p>按支付宝官方接口接入，可按需启用不同支付产品。</p></div><label class="check-row"><input name="alipayEnabled" type="checkbox" data-payment-toggle="alipay" ${alipay.enabled ? 'checked' : ''}> 启用</label></div>
          <div class="payment-provider-fields" data-payment-fields="alipay">
            <div class="grid-2"><div class="field"><label>支付宝网关地址</label><input name="alipayGateway" value="${h(alipay.gateway || 'https://openapi.alipay.com/gateway.do')}"></div><div class="field"><label>应用 App ID</label><input name="alipayAppId" value="${h(alipay.appId || '')}"></div></div>
            <div class="grid-2"><div class="field"><label>异步回调地址</label><input name="alipayNotifyUrl" value="${h(alipay.notifyUrl || '')}" placeholder="https://你的域名.com/api/payments/alipay/notify"></div><div class="field"><label>支付后跳转地址</label><input name="alipayReturnUrl" value="${h(alipay.returnUrl || '')}" placeholder="https://你的域名.com/payment/result?trade_no={trade_no}"></div></div>
            <div class="field"><label>启用产品</label><div class="mini-checks"><label><input name="alipayMethodPage" type="checkbox" ${alipayMethods.page !== false ? 'checked' : ''}> 电脑网站支付</label><label><input name="alipayMethodWap" type="checkbox" ${alipayMethods.wap ? 'checked' : ''}> 手机网站/H5</label><label><input name="alipayMethodPrecreate" type="checkbox" ${alipayMethods.precreate ? 'checked' : ''}> 当面付扫码</label></div></div>
            <div class="form-note">生产环境默认使用支付宝正式网关 https://openapi.alipay.com/gateway.do。当前直连实现包含电脑网站支付 alipay.trade.page.pay、手机网站/H5 alipay.trade.wap.pay、当面付扫码 alipay.trade.precreate；请确保你的支付宝应用已经开通对应产品。</div>
            <div class="field"><label>应用私钥</label><textarea name="alipayAppPrivateKey">${h(alipay.appPrivateKey || '')}</textarea></div>
            <div class="field"><label>支付宝公钥</label><textarea name="alipayPublicKey">${h(alipay.alipayPublicKey || '')}</textarea></div>
          </div>
        </section>
        <section class="payment-provider" data-payment-section="epay">
          <div class="payment-provider-head"><div><h3>彩虹易支付</h3><p>聚合支付宝、微信、PayPal 和 USDT 渠道。</p></div><label class="check-row"><input name="epayEnabled" type="checkbox" data-payment-toggle="epay" ${epay.enabled ? 'checked' : ''}> 启用</label></div>
          <div class="payment-provider-fields" data-payment-fields="epay">
            <div class="grid-3"><div class="field"><label>支付网关地址</label><input name="epayGateway" value="${h(epay.gateway || '')}" placeholder="https://pay.example.com"></div><div class="field"><label>商户 PID</label><input name="epayPid" value="${h(epay.pid || '')}"></div><div class="field"><label>签名方式</label><select name="epaySignType"><option value="MD5" ${epay.signType !== 'RSA' ? 'selected' : ''}>MD5</option><option value="RSA" ${epay.signType === 'RSA' ? 'selected' : ''}>RSA</option></select></div></div>
            <div class="grid-2"><div class="field"><label>异步回调地址</label><input name="epayNotifyUrl" value="${h(epay.notifyUrl || '')}" placeholder="https://你的域名.com/api/payments/epay/notify"></div><div class="field"><label>支付后跳转地址</label><input name="epayReturnUrl" value="${h(epay.returnUrl || '')}" placeholder="https://你的域名.com/payment/result?trade_no={trade_no}"></div></div>
            <div class="grid-3"><div class="field"><label>商户密钥</label><input name="epayMerchantKey" type="password" value="${h(epay.merchantKey || '')}"></div><div class="field"><label>RSA 公钥</label><input name="epayPublicKey" type="password" value="${h(epay.publicKey || '')}"></div><div class="field"><label>启用通道</label><div class="mini-checks"><label><input name="epayMethodAlipay" type="checkbox" ${epay.methods?.alipay ? 'checked' : ''}> 支付宝</label><label><input name="epayMethodWxpay" type="checkbox" ${epay.methods?.wxpay ? 'checked' : ''}> 微信</label><label><input name="epayMethodPaypal" type="checkbox" ${epay.methods?.paypal ? 'checked' : ''}> PayPal</label><label><input name="epayMethodUsdt" type="checkbox" ${epay.methods?.usdt ? 'checked' : ''}> USDT-TRC20</label></div></div></div>
            <div class="grid-4"><div class="field"><label>支付宝 type</label><input name="epayTypeAlipay" value="${h(epayTypes.alipay || 'alipay')}"></div><div class="field"><label>微信 type</label><input name="epayTypeWxpay" value="${h(epayTypes.wxpay || 'wxpay')}"></div><div class="field"><label>PayPal type</label><input name="epayTypePaypal" value="${h(epayTypes.paypal || 'paypal')}"></div><div class="field"><label>USDT type</label><input name="epayTypeUsdt" value="${h(epayTypes.usdt || 'usdt.trc20')}"></div></div>
            <div class="form-note">这些 type 必须和支付系统后台“支付方式”的名称一致。BEpusdt 默认使用 usdt.trc20；如果你的支付系统里名称不同，可以在这里改。</div>
            <div class="field"><label>RSA 私钥</label><textarea name="epayPrivateKey">${h(epay.privateKey || '')}</textarea></div>
          </div>
        </section>
      </div>
      <div class="form-actions"><button class="btn primary" type="submit">保存支付设置</button></div>
    </form>
  </section>`;
}

function renderPaymentSettingsOldSwitcher() {
  const pay = state.db.settings?.payments || {};
  const epay = pay.epay || { methods: {}, types: {} };
  const epayTypes = epay.types || {};
  const alipay = pay.alipay || { methods: {} };
  const alipayMethods = alipay.methods || {};
  const bepusdt = pay.bepusdt || {};
  const wechat = pay.wechat || {};
  return `<section class="panel settings-panel">
    <div class="panel-head"><div><h2>支付设置</h2><p>选择一个接口后只显示对应配置，避免所有表单堆在一起。</p></div></div>
    <form class="panel-body settings-form" data-settings-form="payments" data-active-payment="">
      <input type="hidden" name="paymentSettingsSubmitted" value="1">
      ${renderSection('基础支付配置', `
        <div class="grid-3"><div class="field"><label>在线支付总开关</label><label class="check-row"><input name="paymentsEnabled" type="checkbox" ${pay.enabled ? 'checked' : ''}> 启用在线充值</label></div><div class="field"><label>最低充值金额</label><input name="paymentMinAmount" type="number" min="0.01" step="0.01" value="${h(pay.minAmount || 1)}"></div><div class="field"><label>快捷金额</label><input name="paymentAmounts" value="${h((pay.amounts || [10, 30, 50, 100]).join(','))}" placeholder="10,30,50,100"></div></div>
        <div class="field"><label>公网访问地址</label><input name="paymentSiteUrl" value="${h(pay.siteUrl || '')}" placeholder="https://你的域名.com"></div>
        <div class="form-note">回调地址或跳转地址留空时，系统会用公网访问地址自动生成。支付平台必须能访问这个域名。</div>
      `)}
      <div class="payment-provider-grid payment-provider-switcher">
        <section class="payment-provider" data-payment-section="alipay">
          <div class="payment-provider-head"><button class="payment-provider-select" type="button" data-payment-select="alipay"><span><h3>支付宝开放平台直连</h3><p>电脑网站、H5、当面付扫码。</p></span></button><label class="check-row"><input name="alipayEnabled" type="checkbox" data-payment-toggle="alipay" ${alipay.enabled ? 'checked' : ''}> 启用</label></div>
          <div class="payment-provider-fields" data-payment-fields="alipay">
            <div class="grid-2"><div class="field"><label>支付宝网关地址</label><input name="alipayGateway" value="${h(alipay.gateway || 'https://openapi.alipay.com/gateway.do')}"></div><div class="field"><label>应用 App ID</label><input name="alipayAppId" value="${h(alipay.appId || '')}"></div></div>
            <div class="grid-2"><div class="field"><label>异步回调地址</label><input name="alipayNotifyUrl" value="${h(alipay.notifyUrl || '')}" placeholder="https://你的域名.com/api/payments/alipay/notify"></div><div class="field"><label>支付后跳转地址</label><input name="alipayReturnUrl" value="${h(alipay.returnUrl || '')}" placeholder="https://你的域名.com/payment/result?trade_no={trade_no}"></div></div>
            <div class="field"><label>启用产品</label><div class="mini-checks"><label><input name="alipayMethodPage" type="checkbox" ${alipayMethods.page !== false ? 'checked' : ''}> 电脑网站支付</label><label><input name="alipayMethodWap" type="checkbox" ${alipayMethods.wap ? 'checked' : ''}> 手机网站/H5</label><label><input name="alipayMethodPrecreate" type="checkbox" ${alipayMethods.precreate ? 'checked' : ''}> 当面付扫码</label></div></div>
            <div class="field"><label>应用私钥</label><textarea name="alipayAppPrivateKey">${h(alipay.appPrivateKey || '')}</textarea></div>
            <div class="field"><label>支付宝公钥</label><textarea name="alipayPublicKey">${h(alipay.alipayPublicKey || '')}</textarea></div>
          </div>
        </section>
        <section class="payment-provider" data-payment-section="epay">
          <div class="payment-provider-head"><button class="payment-provider-select" type="button" data-payment-select="epay"><span><h3>彩虹易支付</h3><p>聚合支付宝、微信、PayPal 和 USDT。</p></span></button><label class="check-row"><input name="epayEnabled" type="checkbox" data-payment-toggle="epay" ${epay.enabled ? 'checked' : ''}> 启用</label></div>
          <div class="payment-provider-fields" data-payment-fields="epay">
            <div class="grid-3"><div class="field"><label>支付网关地址</label><input name="epayGateway" value="${h(epay.gateway || '')}" placeholder="https://pay.example.com"></div><div class="field"><label>商户 PID</label><input name="epayPid" value="${h(epay.pid || '')}"></div><div class="field"><label>签名方式</label><select name="epaySignType"><option value="MD5" ${epay.signType !== 'RSA' ? 'selected' : ''}>MD5</option><option value="RSA" ${epay.signType === 'RSA' ? 'selected' : ''}>RSA</option></select></div></div>
            <div class="grid-2"><div class="field"><label>异步回调地址</label><input name="epayNotifyUrl" value="${h(epay.notifyUrl || '')}" placeholder="https://你的域名.com/api/payments/epay/notify"></div><div class="field"><label>支付后跳转地址</label><input name="epayReturnUrl" value="${h(epay.returnUrl || '')}" placeholder="https://你的域名.com/payment/result?trade_no={trade_no}"></div></div>
            <div class="grid-3"><div class="field"><label>商户密钥</label><input name="epayMerchantKey" type="password" value="${h(epay.merchantKey || '')}"></div><div class="field"><label>RSA 公钥</label><input name="epayPublicKey" type="password" value="${h(epay.publicKey || '')}"></div><div class="field"><label>启用通道</label><div class="mini-checks"><label><input name="epayMethodAlipay" type="checkbox" ${epay.methods?.alipay ? 'checked' : ''}> 支付宝</label><label><input name="epayMethodWxpay" type="checkbox" ${epay.methods?.wxpay ? 'checked' : ''}> 微信</label><label><input name="epayMethodPaypal" type="checkbox" ${epay.methods?.paypal ? 'checked' : ''}> PayPal</label><label><input name="epayMethodUsdt" type="checkbox" ${epay.methods?.usdt ? 'checked' : ''}> USDT-TRC20</label></div></div></div>
            <div class="grid-4"><div class="field"><label>支付宝 type</label><input name="epayTypeAlipay" value="${h(epayTypes.alipay || 'alipay')}"></div><div class="field"><label>微信 type</label><input name="epayTypeWxpay" value="${h(epayTypes.wxpay || 'wxpay')}"></div><div class="field"><label>PayPal type</label><input name="epayTypePaypal" value="${h(epayTypes.paypal || 'paypal')}"></div><div class="field"><label>USDT type</label><input name="epayTypeUsdt" value="${h(epayTypes.usdt || 'usdt.trc20')}"></div></div>
            <div class="field"><label>RSA 私钥</label><textarea name="epayPrivateKey">${h(epay.privateKey || '')}</textarea></div>
          </div>
        </section>
        <section class="payment-provider" data-payment-section="bepusdt">
          <div class="payment-provider-head"><button class="payment-provider-select" type="button" data-payment-select="bepusdt"><span><h3>BEpusdt 管理面板网关</h3><p>对接你自己的 BEpusdt 面板，使用应用 URI 和对接令牌发起 submit.php 收单。</p></span></button><label class="check-row"><input name="bepusdtEnabled" type="checkbox" data-payment-toggle="bepusdt" ${bepusdt.enabled ? 'checked' : ''}> 启用</label></div>
          <div class="payment-provider-fields" data-payment-fields="bepusdt">
            <div class="grid-2"><div class="field"><label>BEpusdt 应用 URI</label><input name="bepusdtAppUrl" value="${h(bepusdt.appUrl || '')}" placeholder="填写你的 BEpusdt 应用 URI"></div><div class="field"><label>对接令牌 Token / KEY</label><input name="bepusdtToken" type="password" value="${h(bepusdt.token || '')}"></div></div>
            <div class="field"><label>支付类型 type</label><input name="bepusdtTradeType" value="${h(bepusdt.tradeType || 'usdt.trc20')}" placeholder="usdt.trc20"></div>
            <div class="form-note">这里对接的是你自己的 BEpusdt 管理面板。系统会请求你的应用 URI 下的 submit.php，PID 固定为 1000，签名 KEY 使用对接令牌；钱包、静态资源和链上收款由 BEpusdt 面板自己管理。</div>
            <div class="grid-2"><div class="field"><label>异步回调地址</label><input name="bepusdtNotifyUrl" value="${h(bepusdt.notifyUrl || '')}" placeholder="https://你的域名.com/api/payments/bepusdt/notify"></div><div class="field"><label>支付后跳转地址</label><input name="bepusdtReturnUrl" value="${h(bepusdt.returnUrl || '')}" placeholder="https://你的域名.com/payment/result?trade_no={trade_no}"></div></div>
          </div>
        </section>
        <section class="payment-provider" data-payment-section="wechat">
          <div class="payment-provider-head"><button class="payment-provider-select" type="button" data-payment-select="wechat"><span><h3>微信官方支付 V3 Native</h3><p>贴合易支付 wxpayn：appid、appmchid、appsecret、appkey、publickeyid。</p></span></button><label class="check-row"><input name="wechatEnabled" type="checkbox" data-payment-toggle="wechat" ${wechat.enabled ? 'checked' : ''}> 启用</label></div>
          <div class="payment-provider-fields" data-payment-fields="wechat">
            <div class="grid-2"><div class="field"><label>服务号/小程序/开放平台 AppID</label><input name="wechatAppId" value="${h(wechat.appId || '')}"></div><div class="field"><label>商户号 appmchid</label><input name="wechatMchId" value="${h(wechat.mchId || '')}"></div></div>
            <div class="grid-3"><div class="field"><label>商户 APIv3 密钥 appsecret</label><input name="wechatApiV3Key" type="password" value="${h(wechat.apiV3Key || '')}" placeholder="32 位 APIv3 Key"></div><div class="field"><label>商户 API 证书序列号 appkey</label><input name="wechatMerchantSerialNo" value="${h(wechat.merchantSerialNo || wechat.serialNo || '')}"></div><div class="field"><label>微信支付公钥 ID publickeyid</label><input name="wechatPlatformSerialNo" value="${h(wechat.platformSerialNo || '')}" placeholder="平台证书模式可留空"></div></div>
            <div class="field"><label>商户 API 私钥 apiclient_key.pem</label><textarea name="wechatMerchantPrivateKey" placeholder="-----BEGIN PRIVATE KEY-----">${h(wechat.merchantPrivateKey || wechat.privateKey || '')}</textarea></div>
            <div class="field"><label>微信支付平台公钥 pub_key.pem</label><textarea name="wechatPlatformPublicKey" placeholder="-----BEGIN PUBLIC KEY-----">${h(wechat.platformPublicKey || '')}</textarea></div>
            <div class="grid-2"><div class="field"><label>异步回调地址</label><input name="wechatNotifyUrl" value="${h(wechat.notifyUrl || '')}" placeholder="https://你的域名.com/api/payments/wechat/notify"></div><div class="field"><label>商品描述</label><input name="wechatDescription" value="${h(wechat.description || 'Account balance recharge')}"></div></div>
          </div>
        </section>
      </div>
      <div class="form-actions"><button class="btn primary" type="submit">保存支付设置</button></div>
    </form>
  </section>`;
}

function renderPaymentSettings() {
  const pay = state.db.settings?.payments || {};
  const epay = pay.epay || { methods: {}, types: {} };
  const epayTypes = epay.types || {};
  const alipay = pay.alipay || { methods: {} };
  const alipayMethods = alipay.methods || {};
  const bepusdt = pay.bepusdt || {};
  const wechat = pay.wechat || { methods: {} };
  const wechatMethods = wechat.methods || {};
  const providerNames = { alipay: '支付宝', wechat: '微信支付', epay: '易支付', bepusdt: 'BEpusdt' };
  const methodRows = [
    { provider: 'alipay', name: '支付宝电脑网站', desc: '电脑浏览器优先使用', enabled: Boolean(alipay.enabled && alipayMethods.page !== false) },
    { provider: 'alipay', name: '支付宝 H5', desc: '手机浏览器优先使用', enabled: Boolean(alipay.enabled && alipayMethods.wap) },
    { provider: 'alipay', name: '支付宝当面付', desc: '生成二维码扫码支付', enabled: Boolean(alipay.enabled && alipayMethods.precreate) },
    { provider: 'wechat', name: '微信扫码', desc: '生成二维码扫码支付', enabled: Boolean(wechat.enabled && wechatMethods.native !== false) },
    { provider: 'wechat', name: '微信 H5', desc: '手机浏览器拉起微信支付', enabled: Boolean(wechat.enabled && wechatMethods.h5) },
    { provider: 'epay', name: '易支付支付宝', desc: '支付宝备用聚合通道', enabled: Boolean(epay.enabled && epay.methods?.alipay) },
    { provider: 'epay', name: '易支付微信', desc: '微信备用聚合通道', enabled: Boolean(epay.enabled && epay.methods?.wxpay) },
    { provider: 'epay', name: '易支付 PayPal', desc: 'PayPal 聚合通道', enabled: Boolean(epay.enabled && epay.methods?.paypal) },
    { provider: 'epay', name: '易支付 USDT', desc: 'USDT 备用聚合通道', enabled: Boolean(epay.enabled && epay.methods?.usdt) },
    { provider: 'bepusdt', name: 'BEpusdt USDT', desc: 'USDT 优先通道', enabled: Boolean(bepusdt.enabled) }
  ];
  const activeRows = methodRows.filter((item) => item.enabled);
  const methodRow = (item) => `<div class="payment-method-row" data-payment-method-row="${h(item.provider)}">
    <div class="payment-method-main"><strong>${h(item.name)}</strong><span>${h(item.desc)}</span></div>
    <div class="payment-method-provider"><span class="payment-provider-tag">${h(providerNames[item.provider] || item.provider)}</span><small>用户端显示为${h(item.provider === 'epay' && item.name.includes('PayPal') ? ' PayPal' : item.provider === 'bepusdt' || item.name.includes('USDT') ? ' USDT' : item.provider === 'wechat' || item.name.includes('微信') ? ' 微信支付' : ' 支付宝')}</small></div>
    <div class="payment-method-state"><span class="status active">已启用</span></div>
    <div class="payment-method-actions">
      <button class="btn small" type="button" data-action="open-payment-editor" data-provider="${h(item.provider)}">配置</button>
    </div>
  </div>`;
  const editor = state.paymentEditor ? renderPaymentEditor(state.paymentEditor, { pay, epay, epayTypes, alipay, alipayMethods, bepusdt, wechat, wechatMethods }) : '';
  return `<section class="panel settings-panel">
    <div class="panel-head"><div><h2>支付设置</h2><p>用户端只显示支付宝、微信支付、PayPal、USDT；这里通过添加支付方式来维护实际通道。</p></div><button class="btn primary" type="button" data-action="open-payment-editor" data-provider="alipay">添加支付方式</button></div>
    <form class="panel-body settings-form" data-settings-form="payments">
      <input type="hidden" name="paymentSettingsSubmitted" value="1">
      ${renderSection('基础支付配置', `
        <div class="grid-3"><div class="field"><label>在线支付总开关</label><label class="check-row"><input name="paymentsEnabled" type="checkbox" ${pay.enabled ? 'checked' : ''}> 启用在线充值</label></div><div class="field"><label>最低充值金额</label><input name="paymentMinAmount" type="number" min="0.01" step="0.01" value="${h(pay.minAmount || 1)}"></div><div class="field"><label>快捷金额</label><input name="paymentAmounts" value="${h((pay.amounts || [10, 30, 50, 100]).join(','))}" placeholder="10,30,50,100"></div></div>
        <div class="field"><label>公网访问地址</label><input name="paymentSiteUrl" value="${h(pay.siteUrl || '')}" placeholder="https://你的域名.com"></div>
        <div class="form-note">回调地址或跳转地址留空时，系统会用公网访问地址自动生成。支付平台必须能访问这个域名。</div>
      `)}
      ${renderSection('已添加的支付方式', activeRows.length ? `<div class="payment-method-list">${activeRows.map(methodRow).join('')}</div>` : '<div class="empty">还没有添加支付方式，点击右上角添加。</div>')}
      ${editor}
      <div class="form-actions"><button class="btn primary" type="submit">保存支付设置</button></div>
    </form>
  </section>`;
}

function renderPaymentEditor(provider, ctx) {
  const { epay, epayTypes, alipay, alipayMethods, bepusdt, wechat, wechatMethods } = ctx;
  const selected = ['alipay', 'wechat', 'epay', 'bepusdt'].includes(provider) ? provider : 'alipay';
  const providerSelect = `<div class="field"><label>支付大类</label><select data-payment-editor-select><option value="alipay" ${selected === 'alipay' ? 'selected' : ''}>支付宝</option><option value="wechat" ${selected === 'wechat' ? 'selected' : ''}>微信支付</option><option value="epay" ${selected === 'epay' ? 'selected' : ''}>易支付聚合</option><option value="bepusdt" ${selected === 'bepusdt' ? 'selected' : ''}>BEpusdt USDT</option></select></div>`;
  const providerFields = {
    alipay: `
      <label class="check-row"><input name="alipayEnabled" type="checkbox" ${alipay.enabled ? 'checked' : ''}> 启用支付宝开放平台</label>
      <div class="field"><label>分类</label><div class="mini-checks"><label><input name="alipayMethodPage" type="checkbox" ${alipayMethods.page !== false ? 'checked' : ''}> 电脑网站</label><label><input name="alipayMethodWap" type="checkbox" ${alipayMethods.wap ? 'checked' : ''}> H5</label><label><input name="alipayMethodPrecreate" type="checkbox" ${alipayMethods.precreate ? 'checked' : ''}> 当面付</label></div></div>
      <div class="grid-2"><div class="field"><label>网关地址</label><input name="alipayGateway" value="${h(alipay.gateway || 'https://openapi.alipay.com/gateway.do')}"></div><div class="field"><label>App ID</label><input name="alipayAppId" value="${h(alipay.appId || '')}"></div></div>
      <div class="grid-2"><div class="field"><label>异步回调地址</label><input name="alipayNotifyUrl" value="${h(alipay.notifyUrl || '')}" placeholder="https://你的域名.com/api/payments/alipay/notify"></div><div class="field"><label>支付后跳转地址</label><input name="alipayReturnUrl" value="${h(alipay.returnUrl || '')}" placeholder="https://你的域名.com/payment/result?trade_no={trade_no}"></div></div>
      <div class="field"><label>应用私钥</label><textarea name="alipayAppPrivateKey">${h(alipay.appPrivateKey || '')}</textarea></div>
      <div class="field"><label>支付宝公钥</label><textarea name="alipayPublicKey">${h(alipay.alipayPublicKey || '')}</textarea></div>`,
    wechat: `
      <label class="check-row"><input name="wechatEnabled" type="checkbox" ${wechat.enabled ? 'checked' : ''}> 启用微信支付 V3</label>
      <div class="field"><label>分类</label><div class="mini-checks"><label><input name="wechatMethodNative" type="checkbox" ${wechatMethods.native !== false ? 'checked' : ''}> 微信扫码</label><label><input name="wechatMethodH5" type="checkbox" ${wechatMethods.h5 ? 'checked' : ''}> 微信 H5</label><span class="muted">JSAPI / 小程序 / APP 需要 openid 或客户端能力，当前余额充值不展示给用户。</span></div></div>
      <div class="grid-2"><div class="field"><label>AppID</label><input name="wechatAppId" value="${h(wechat.appId || '')}"></div><div class="field"><label>商户号 mchid</label><input name="wechatMchId" value="${h(wechat.mchId || '')}"></div></div>
      <div class="grid-3"><div class="field"><label>APIv3 密钥</label><input name="wechatApiV3Key" type="password" value="${h(wechat.apiV3Key || '')}" placeholder="32 位 APIv3 Key"></div><div class="field"><label>商户证书序列号</label><input name="wechatMerchantSerialNo" value="${h(wechat.merchantSerialNo || wechat.serialNo || '')}"></div><div class="field"><label>微信支付平台公钥 ID</label><input name="wechatPlatformSerialNo" value="${h(wechat.platformSerialNo || '')}"></div></div>
      <div class="field"><label>商户 API 私钥 apiclient_key.pem</label><textarea name="wechatMerchantPrivateKey" placeholder="-----BEGIN PRIVATE KEY-----">${h(wechat.merchantPrivateKey || wechat.privateKey || '')}</textarea></div>
      <div class="field"><label>微信支付平台公钥 pub_key.pem</label><textarea name="wechatPlatformPublicKey" placeholder="-----BEGIN PUBLIC KEY-----">${h(wechat.platformPublicKey || '')}</textarea></div>
      <div class="grid-2"><div class="field"><label>异步回调地址</label><input name="wechatNotifyUrl" value="${h(wechat.notifyUrl || '')}" placeholder="https://你的域名.com/api/payments/wechat/notify"></div><div class="field"><label>支付后跳转地址</label><input name="wechatReturnUrl" value="${h(wechat.returnUrl || '')}" placeholder="https://你的域名.com/payment/result?trade_no={trade_no}"></div></div>
      <div class="field"><label>商品描述</label><input name="wechatDescription" value="${h(wechat.description || 'Account balance recharge')}"></div>`,
    epay: `
      <label class="check-row"><input name="epayEnabled" type="checkbox" ${epay.enabled ? 'checked' : ''}> 启用易支付</label>
      <div class="field"><label>分类</label><div class="mini-checks"><label><input name="epayMethodAlipay" type="checkbox" ${epay.methods?.alipay ? 'checked' : ''}> 支付宝</label><label><input name="epayMethodWxpay" type="checkbox" ${epay.methods?.wxpay ? 'checked' : ''}> 微信</label><label><input name="epayMethodPaypal" type="checkbox" ${epay.methods?.paypal ? 'checked' : ''}> PayPal</label><label><input name="epayMethodUsdt" type="checkbox" ${epay.methods?.usdt ? 'checked' : ''}> USDT</label></div></div>
      <div class="grid-3"><div class="field"><label>网关地址</label><input name="epayGateway" value="${h(epay.gateway || '')}" placeholder="https://pay.example.com"></div><div class="field"><label>商户 PID</label><input name="epayPid" value="${h(epay.pid || '')}"></div><div class="field"><label>签名方式</label><select name="epaySignType"><option value="MD5" ${epay.signType !== 'RSA' ? 'selected' : ''}>MD5</option><option value="RSA" ${epay.signType === 'RSA' ? 'selected' : ''}>RSA</option></select></div></div>
      <div class="grid-2"><div class="field"><label>异步回调地址</label><input name="epayNotifyUrl" value="${h(epay.notifyUrl || '')}" placeholder="https://你的域名.com/api/payments/epay/notify"></div><div class="field"><label>支付后跳转地址</label><input name="epayReturnUrl" value="${h(epay.returnUrl || '')}" placeholder="https://你的域名.com/payment/result?trade_no={trade_no}"></div></div>
      <div class="grid-3"><div class="field"><label>商户密钥</label><input name="epayMerchantKey" type="password" value="${h(epay.merchantKey || '')}"></div><div class="field"><label>RSA 公钥</label><input name="epayPublicKey" type="password" value="${h(epay.publicKey || '')}"></div><div class="field"><label>RSA 私钥</label><input name="epayPrivateKey" type="password" value="${h(epay.privateKey || '')}"></div></div>
      <div class="grid-4"><div class="field"><label>支付宝 type</label><input name="epayTypeAlipay" value="${h(epayTypes.alipay || 'alipay')}"></div><div class="field"><label>微信 type</label><input name="epayTypeWxpay" value="${h(epayTypes.wxpay || 'wxpay')}"></div><div class="field"><label>PayPal type</label><input name="epayTypePaypal" value="${h(epayTypes.paypal || 'paypal')}"></div><div class="field"><label>USDT type</label><input name="epayTypeUsdt" value="${h(epayTypes.usdt || 'usdt.trc20')}"></div></div>`,
    bepusdt: `
      <label class="check-row"><input name="bepusdtEnabled" type="checkbox" ${bepusdt.enabled ? 'checked' : ''}> 启用 BEpusdt USDT</label>
      <div class="grid-2"><div class="field"><label>BEpusdt 应用 URI</label><input name="bepusdtAppUrl" value="${h(bepusdt.appUrl || '')}" placeholder="填写你的 BEpusdt 应用 URI"></div><div class="field"><label>对接令牌 Token / KEY</label><input name="bepusdtToken" type="password" value="${h(bepusdt.token || '')}"></div></div>
      <div class="field"><label>支付类型 type</label><input name="bepusdtTradeType" value="${h(bepusdt.tradeType || 'usdt.trc20')}" placeholder="usdt.trc20"></div>
      <div class="grid-2"><div class="field"><label>异步回调地址</label><input name="bepusdtNotifyUrl" value="${h(bepusdt.notifyUrl || '')}" placeholder="https://你的域名.com/api/payments/bepusdt/notify"></div><div class="field"><label>支付后跳转地址</label><input name="bepusdtReturnUrl" value="${h(bepusdt.returnUrl || '')}" placeholder="https://你的域名.com/payment/result?trade_no={trade_no}"></div></div>`
  };
  return `<div class="payment-editor-backdrop" data-payment-editor-backdrop>
    <div class="payment-editor-card">
      <header><div><h3>添加支付方式</h3><p>先选大类，再选择这个大类下面的分类并填写参数。</p></div><button class="btn icon" type="button" data-action="close-payment-editor">×</button></header>
      <div class="payment-editor-body">${providerSelect}${providerFields[selected]}</div>
      <footer><button class="btn" type="button" data-action="close-payment-editor">取消</button><button class="btn primary" type="submit">保存</button></footer>
    </div>
  </div>`;
}

function renderAccountSecurity() {
  return `<section class="panel settings-panel">
    <div class="panel-head"><div><h2>账号安全</h2><p>修改管理员账号或密码后，当前会话会自动退出。</p></div></div>
    <form class="panel-body settings-form" data-settings-form="security">
      ${renderSection('管理员账号', `
        <div class="field"><label>管理员账号</label><input name="username" value="${h(state.db.settings?.adminUsername || state.user || 'admin')}" autocomplete="username" required></div>
      `)}
      ${renderSection('修改密码', `
        <div class="field"><label>当前密码</label><input name="currentPassword" type="password" autocomplete="current-password" required></div>
        <div class="grid-2"><div class="field"><label>新密码</label><input name="newPassword" type="password" minlength="8" autocomplete="new-password" required></div><div class="field"><label>确认新密码</label><input name="confirmPassword" type="password" minlength="8" autocomplete="new-password" required></div></div>
      `)}
      <div class="form-actions"><button class="btn primary" type="submit">保存账号安全</button></div>
    </form>
  </section>`;
}

function renderUserApp() {
  const customer = state.db.customer;
  const nodes = userNodes();
  document.title = appTitle('用户中心');
  app.innerHTML = `
    <section class="app-shell">
      <aside class="sidebar">
        <div class="brand">${brandMark()}<span>${h(appTitle('用户中心'))}</span></div>
        <nav class="nav">${userNavItems.map(([view, label, icon]) => navButton(view, label, icon, state.userView)).join('')}</nav>
        <div class="sidebar-footer">登录用户：${h(state.user)}<br>已绑定服务：${nodes.length}<br>余额：${money(customer.balance)} ${h(state.db.settings.currency)}</div>
      </aside>
      <section class="content">
        <div class="topbar">
          <div><div class="eyebrow">用户中心</div><h1>${userPageTitle()}</h1><div class="sub">购买卡密、兑换余额、按节点续费和查看服务状态。</div></div>
          <div class="actions"><button class="btn primary" data-action="buy-card-link">购买卡密</button><button class="btn" data-action="refresh">刷新</button><button class="btn danger" data-action="logout">退出</button></div>
        </div>
        ${renderUserSummary()}
        ${renderUserView()}
      </section>
    </section>
    ${state.modal ? renderModal() : ''}`;
  bindEvents();
}

function userPageTitle() {
  return { 'user-home': '充值续费', 'user-nodes': '节点管理' }[state.userView] || '用户中心';
}

function renderUserSummary() {
  const customer = state.db.customer;
  const nodes = userNodes();
  const firstExpire = earliestNode(nodes);
  const totalTraffic = nodes.reduce((sum, node) => sum + Number(node.trafficLimitGb || 0), 0);
  return `<div class="stats user-stats">
    <div class="stat total"><span>账户余额</span><strong>${money(customer.balance)}</strong><small>${h(state.db.settings.currency)}</small></div>
    <div class="stat"><span>服务数量</span><strong>${nodes.length}</strong><small>已绑定</small></div>
    <div class="stat"><span>最近到期</span><strong class="small-strong">${fmtDate(firstExpire?.expireAt)}</strong><small>按节点独立续费</small></div>
    <div class="stat"><span>总流量</span><strong>${h(totalTraffic)} GB</strong><small>已绑定服务</small></div>
    <div class="stat"><span>状态</span><strong>${statusText[customer.computedStatus] || customer.computedStatus}</strong><small>账户状态</small></div>
  </div>`;
}

function renderUserView() {
  if (state.userView === 'user-profile') return renderUserProfile();
  if (state.userView === 'user-nodes') return renderUserNodes();
  return renderUserHome();
}

function renderUserProfile() {
  const customer = state.db.customer || {};
  return `<section class="panel compact-panel">
    <div class="panel-head"><div><h2>账号资料</h2><p>修改登录账号或密码后，管理员后台会同步显示新的登录账号。</p></div></div>
    <form class="panel-body settings-form" id="userProfileForm">
      ${renderSection('登录资料', `
        <div class="grid-2"><div class="field"><label>登录账号</label><input name="loginUsername" value="${h(customer.loginUsername || state.user || '')}" autocomplete="username" required></div><div class="field"><label>当前密码</label><input name="currentPassword" type="password" autocomplete="current-password" required></div></div>
        <div class="grid-2"><div class="field"><label>新密码</label><input name="newPassword" type="password" autocomplete="new-password" placeholder="不修改请留空"></div><div class="field"><label>确认新密码</label><input name="confirmPassword" type="password" autocomplete="new-password" placeholder="不修改请留空"></div></div>
        <div class="form-note">登录账号不能和管理员账号或其他用户账号重复。修改后下次登录请使用新账号。</div>
      `)}
      <div class="form-actions"><button class="btn primary" type="submit">保存账号资料</button></div>
    </form>
  </section>`;
}

function renderUserHome() {
  const nodes = userNodes();
  const payments = state.db.settings?.payments || {};
  const methods = payments.methods || [];
  const redeemBusy = isBusy('redeem');
  const rechargeBusy = isBusy('recharge');
  return `<section class="panel compact-panel">
    <div class="panel-head"><div><h2>余额充值</h2><p>点击购买卡密会跳转到管理员设置的发卡网站，兑换后余额自动增加。</p></div></div>
    <div class="panel-body">
      <div class="grid-2">
        <button class="btn primary large-btn" data-action="buy-card-link">购买卡密</button>
        <form id="redeemForm" class="redeem-form">
          <div class="field"><label>兑换卡密</label><input name="code" placeholder="输入卡密" required ${redeemBusy ? 'disabled' : ''}></div>
          <button class="btn primary ${redeemBusy ? 'loading' : ''}" type="submit" ${redeemBusy ? 'disabled' : ''}>${redeemBusy ? '兑换中...' : '兑换充值'}</button>
        </form>
      </div>
    </div>
  </section>
  <section class="panel compact-panel">
    <div class="panel-head"><div><h2>在线充值</h2><p>支付平台回调成功后，充值金额会自动加入账户余额。</p></div></div>
    <div class="panel-body">
      ${payments.enabled ? `<form id="rechargeForm" class="redeem-form">
        <div class="amount-options">${(payments.amounts || []).map((amount, index) => `<button class="btn small" type="button" data-action="pick-recharge-amount" data-amount="${h(amount)}">${money(amount)}</button>`).join('')}</div>
        <div class="grid-2"><div class="field"><label>充值金额</label><input name="amount" type="number" min="${h(payments.minAmount || 1)}" step="0.01" value="${h((payments.amounts || [payments.minAmount || 10])[0])}" required ${rechargeBusy ? 'disabled' : ''}></div><div class="field"><label>支付方式</label><select name="method" required ${rechargeBusy ? 'disabled' : ''}>${methods.map((method) => `<option value="${h(method.id)}">${h(method.label)}</option>`).join('')}</select></div></div>
        <button class="btn primary ${rechargeBusy ? 'loading' : ''}" type="submit" ${rechargeBusy ? 'disabled' : ''}>${rechargeBusy ? '创建订单中...' : '立即支付'}</button>
      </form>` : '<div class="form-note">管理员还没有启用在线充值。</div>'}
    </div>
  </section>
  <section class="panel compact-panel renew-panel">
    <div class="panel-head"><div><h2>服务续费</h2><p>每个服务独立续费，到期时间互不影响。</p></div></div>
    <div class="panel-body">
      ${nodes.length ? `<div class="user-node-grid">${nodes.map(renderRenewNodeCard).join('')}</div>` : '<div class="form-note">当前账号还没有可续费服务，请联系管理员配置。</div>'}
    </div>
  </section>
  ${renderUserFinanceLogs()}`;
}

function renderRenewNodeCard(node) {
  const canRenew = Number(node.renewPrice || 0) > 0 && node.status !== 'disabled';
  const busy = isBusy(`renew:${node.id}`);
  const disabled = !canRenew || busy;
  return `<article class="user-node-card">
    <header><div><span>服务名称</span><strong>${h(node.name || '当前服务')}</strong></div><span class="status ${node.status}">${statusText[node.status] || node.status}</span></header>
    <div class="renew-summary node-renew-summary">
      <div><span>续费价格</span><strong>${money(node.renewPrice)} ${h(state.db.settings.currency)} / 月</strong></div>
      <div><span>账户余额</span><strong>${money(state.db.customer.balance)} ${h(state.db.settings.currency)}</strong></div>
      <div><span>到期时间</span><strong>${fmtDate(node.expireAt)}</strong></div>
    </div>
    <form class="redeem-form user-renew-form" data-renew-node-id="${h(node.id)}">
      <div class="field"><label>续费月数</label><input name="months" type="number" min="1" value="1" ${disabled ? 'disabled' : ''}></div>
      <button class="btn primary ${busy ? 'loading' : ''}" type="submit" ${disabled ? 'disabled' : ''}>${busy ? '处理中...' : '余额续费'}</button>
    </form>
    ${canRenew ? '' : '<div class="form-note">当前服务暂不可续费。</div>'}
  </article>`;
}

function renderUserFinanceLogs() {
  const balanceLogs = state.db.balanceLogs || [];
  const renewalLogs = state.db.renewalLogs || [];
  const rechargeOrders = state.db.rechargeOrders || [];
  return `<section class="panel compact-panel">
    <div class="panel-head"><div><h2>账户记录</h2><p>这里只显示当前账号自己的充值和续费记录。</p></div></div>
    <div class="finance-orders"><h3>在线充值</h3><table><thead><tr><th>时间</th><th>支付方式</th><th>金额</th><th>状态</th></tr></thead><tbody>${rechargeOrders.length ? rechargeOrders.map((order) => `<tr><td>${fmtDate(order.createdAt)}</td><td>${h(paymentMethodText(order.method))}</td><td>${money(order.amount)} ${h(state.db.settings.currency)}</td><td><span class="status ${order.status === 'paid' ? 'success' : order.status === 'failed' ? 'failed' : 'warning'}">${statusText[order.status] || order.status || '-'}</span></td></tr>`).join('') : `<tr><td colspan="4" class="empty">暂无在线充值订单。</td></tr>`}</tbody></table></div>
    <div class="grid-2 finance-mini-grid">
      <div><h3>余额流水</h3><table><thead><tr><th>时间</th><th>类型</th><th>变动</th><th>余额</th></tr></thead><tbody>${balanceLogs.length ? balanceLogs.map((log) => `<tr><td>${fmtDate(log.createdAt)}</td><td>${h(balanceTypeText(log.type))}</td><td class="mono ${Number(log.amount || 0) < 0 ? 'danger-text' : 'success-text'}">${Number(log.amount || 0) > 0 ? '+' : ''}${money(log.amount)}</td><td>${money(log.afterBalance)}</td></tr>`).join('') : `<tr><td colspan="4" class="empty">暂无余额流水。</td></tr>`}</tbody></table></div>
      <div><h3>续费记录</h3><table><thead><tr><th>时间</th><th>月数</th><th>金额</th><th>到期</th></tr></thead><tbody>${renewalLogs.length ? renewalLogs.map((log) => `<tr><td>${fmtDate(log.createdAt)}</td><td>${h(log.months || 1)}</td><td>${money(log.price)} ${h(state.db.settings.currency)}</td><td>${fmtDate(log.afterExpireAt)}</td></tr>`).join('') : `<tr><td colspan="4" class="empty">暂无续费记录。</td></tr>`}</tbody></table></div>
    </div>
  </section>`;
}

function renderUserNodes() {
  const nodes = userNodes();
  if (!nodes.length) return `<section class="panel"><div class="panel-head"><div><h2>节点管理</h2><p>管理员尚未给当前账号配置可用服务。</p></div></div><div class="empty">请联系管理员配置服务。</div></section>`;
  return `<section class="panel">
    <div class="panel-head"><div><h2>节点管理</h2><p>这里只展示当前账号可使用的信息。</p></div></div>
    <div class="panel-body user-node-grid">
      ${nodes.map(renderUserNodeAccessCard).join('')}
    </div>
  </section>`;
}

function renderUserNodeAccessCard(node) {
  const copyBusy = isBusy(`copy-node:${node.id}`);
  const qrBusy = isBusy(`qr-node:${node.id}`);
  const lockActions = copyBusy || qrBusy;
  return `<article class="user-node-card node-access">
      <div class="node-profile">
        <div class="node-name-block">
          <span>服务名称</span>
          <strong>${h(node.name || '当前服务')}</strong>
        </div>
        <span class="status ${node.status}">${statusText[node.status] || node.status}</span>
      </div>
      <div class="node-meta-grid">
        <div><span>续费价格</span><strong>${money(node.renewPrice)} ${h(state.db.settings.currency)} / 月</strong></div>
        <div><span>到期时间</span><strong>${fmtDate(node.expireAt)}</strong></div>
        <div><span>可用流量</span><strong>${h(node.trafficLimitGb || 0)} GB</strong></div>
      </div>
      <div class="node-access-grid">
        <div class="node-link-card">
          <label>节点链接</label>
          <div class="node-action-box"><button class="btn primary ${copyBusy ? 'loading' : ''}" data-action="copy-node-link" data-node-id="${h(node.id)}" ${node.hasLink && !lockActions ? '' : 'disabled'}>${copyBusy ? '复制中...' : '复制节点链接'}</button><span>${node.hasLink ? '点击后读取真实链接。' : '当前节点链接不可用。'}</span></div>
        </div>
        <div class="node-qr-card">
          <label>二维码</label>
          <div class="node-action-box"><button class="btn ${qrBusy ? 'loading' : ''}" data-action="show-node-qr" data-node-id="${h(node.id)}" ${node.hasLink && !lockActions ? '' : 'disabled'}>${qrBusy ? '加载中...' : '查看二维码'}</button><span>${node.hasLink ? '点击后读取真实链接并生成二维码。' : '当前二维码不可用。'}</span></div>
        </div>
      </div>
    </article>`;
}

function renderDrawer() {
  const { type, item } = state.drawer;
  const currentItem = item || {};
  const editing = Boolean(item && !item.customerOnly);
  const title = {
    customer: editing ? '编辑用户' : '新建用户',
    server: editing ? '编辑 3x-ui 节点' : '添加 3x-ui 节点',
    serviceNode: editing ? '编辑服务节点' : '添加服务节点',
    customerNode: currentItem.id ? '编辑用户节点' : '绑定用户节点',
    customerNodes: '用户节点管理',
    socks: item ? '编辑 SOCKS 出站' : '添加 SOCKS 出站',
    cards: '生成卡密',
    balance: '调整余额'
  }[type];
  return `<div class="drawer-backdrop" data-drawer-backdrop>
    <form class="drawer" id="drawerForm" data-drawer-type="${type}" data-id="${currentItem.id || ''}">
      <header><h2>${title}</h2><button class="btn icon" type="button" data-action="close-drawer">×</button></header>
      <div class="drawer-body">${drawerFields(type, currentItem)}</div>
      <footer><button class="btn" type="button" data-action="close-drawer">${type === 'customerNodes' ? '关闭' : '取消'}</button>${type === 'customerNodes' ? '' : '<button class="btn primary" type="submit">保存</button>'}</footer>
    </form>
  </div>`;
}

function renderModal() {
  const modal = state.modal || {};
  const hasInput = Boolean(modal.input);
  const confirmClass = modal.tone === 'danger' ? 'btn danger solid' : 'btn primary';
  return `<div class="modal-backdrop" data-modal-backdrop>
    <form class="modal-card" id="modalForm">
      <div class="modal-icon ${h(modal.tone || 'default')}">${modal.tone === 'danger' ? '!' : '?'}</div>
      <div class="modal-content">
        <h2>${h(modal.title)}</h2>
        ${modal.message ? `<p>${h(modal.message)}</p>` : ''}
        ${modal.content || ''}
        ${hasInput ? `<div class="field modal-field"><label>名称</label><input data-modal-input value="${h(modal.input.value || '')}" required></div>` : ''}
      </div>
      <footer><button class="btn" type="button" data-action="cancel-modal">${h(modal.cancelText || '取消')}</button><button class="${confirmClass}" type="submit">${h(modal.confirmText || '确定')}</button></footer>
    </form>
  </div>`;
}

function renderSection(title, body) {
  return `<div class="form-section"><div class="section-title">${title}</div>${body}</div>`;
}

function drawerFields(type, item = {}) {
  if (type === 'cards') {
    return `${renderSection('生成卡密', `
      <input type="hidden" name="batchId" value="${h(item.batchId || '')}">
      <div class="grid-3"><div class="field"><label>金额</label><input name="amount" type="number" min="0.01" step="0.01" value="${h(item.amount || 10)}" required></div><div class="field"><label>数量</label><input name="count" type="number" min="1" max="500" value="1" required></div><div class="field"><label>前缀</label><input name="prefix" placeholder="可选"></div></div>
      <div class="field"><label>分类</label><input name="type" value="${h(item.type || '')}" placeholder="例如：50元卡密 / 月卡 / 活动卡"></div>
      <div class="field"><label>备注</label><input name="remark" value="${h(item.remark || '')}" placeholder="例如：7 月活动"></div>
    `)}`;
  }
  if (type === 'server') {
    return `
      <div class="form-note">节点信息对应 3x-ui 的面板访问地址。密码或 API Token 保持星号会保留旧值，清空后保存会删除旧值。</div>
      ${renderSection('基础信息', `
        <div class="grid-2"><div class="field"><label>名称</label><input name="name" value="${h(item.name)}" required></div><div class="field"><label>备注</label><input name="remark" value="${h(item.remark)}"></div></div>
        <div class="grid-3"><div class="field"><label>协议</label><select name="protocol"><option ${item.protocol === 'https' ? 'selected' : ''}>https</option><option ${item.protocol === 'http' ? 'selected' : ''}>http</option></select></div><div class="field"><label>地址</label><input name="host" value="${h(item.host)}" placeholder="panel.example.com" required></div><div class="field"><label>端口</label><input name="port" type="number" value="${h(item.port || 2053)}"></div></div>
        <div class="grid-2"><div class="field"><label>基础路径</label><input name="basePath" value="${h(item.basePath || '/')}"></div><div class="field"><label>状态</label><select name="status"><option value="enabled" ${item.status !== 'disabled' ? 'selected' : ''}>启用</option><option value="disabled" ${item.status === 'disabled' ? 'selected' : ''}>停用</option></select></div></div>
      `)}
      ${renderSection('认证信息', `
        <div class="grid-2"><div class="field"><label>账号</label><input name="username" value="${h(item.username)}"></div><div class="field"><label>密码</label><input name="password" type="password" value="${h(item.password)}"></div></div>
        <div class="field"><label>API Token</label><input name="apiToken" type="password" value="${h(item.apiToken)}"></div>
        <div class="grid-2"><div class="field"><label>默认 TLS 证书路径</label><input name="defaultInboundCertFile" value="${h(item.defaultInboundCertFile)}" placeholder="/root/cert/fullchain.pem"></div><div class="field"><label>默认 TLS 私钥路径</label><input name="defaultInboundKeyFile" value="${h(item.defaultInboundKeyFile)}" placeholder="/root/cert/privkey.pem"></div></div>
        <div class="form-note">没有现有入站、自动创建 VLESS TLS 入站时，会优先使用这里填写的默认证书路径。</div>
      `)}`;
  }
  if (type === 'serviceNode') {
    return `
      <div class="form-note">服务节点是可复用模板，也就是实际收费的套餐。用户绑定节点时不再单独设置价格，续费统一按这里的月费计算。</div>
      ${renderSection('基础计费', `
        <div class="grid-3"><div class="field"><label>节点名称</label><input name="name" value="${h(item.name || '')}" required></div><div class="field"><label>默认月费</label><input name="amount" type="number" min="0" step="0.01" value="${h(item.amount || 0)}"></div><div class="field"><label>默认流量 GB</label><input name="trafficLimitGb" type="number" min="0" value="${h(item.trafficLimitGb || 100)}"></div></div>
        <div class="grid-2"><div class="field"><label>状态</label><select name="status"><option value="enabled" ${item.status !== 'disabled' ? 'selected' : ''}>启用</option><option value="disabled" ${item.status === 'disabled' ? 'selected' : ''}>停用</option></select></div><div class="field"><label>备注</label><input name="remark" value="${h(item.remark || '')}"></div></div>
      `)}
      ${renderSection('面板与入站', `
        <div class="grid-2"><div class="field"><label>所属面板节点</label><select name="xuiServerId" required><option value="">请选择</option>${state.db.xuiServers.map((server) => `<option value="${server.id}" ${item.xuiServerId === server.id ? 'selected' : ''}>${h(server.name)}</option>`).join('')}</select></div><div class="field"><label>入站 ID</label><input name="inboundId" type="number" min="1" step="1" value="${h(item.inboundId || '')}" placeholder="已有入站数字 ID"></div></div>
        <div class="grid-3"><div class="field"><label>自动创建入站</label><div class="check-row"><input name="autoCreateInbound" type="checkbox" ${item.autoCreateInbound ? 'checked' : ''}> 入站 ID 为空时自动创建</div></div><div class="field"><label>新入站端口</label><input name="inboundPort" type="number" min="1" max="65535" step="1" value="${h(item.inboundPort || '')}" placeholder="留空自动选择"></div><div class="field"><label>新入站备注</label><input name="inboundRemark" value="${h(item.inboundRemark || '')}" placeholder="默认使用节点名称"></div></div>
        <div class="grid-3"><div class="field"><label>入站模板</label><select name="inboundTemplate"><option value="vless-tcp" ${(item.inboundTemplate || 'vless-tcp') === 'vless-tcp' ? 'selected' : ''}>VLESS TCP</option><option value="vless-reality" ${item.inboundTemplate === 'vless-reality' ? 'selected' : ''}>VLESS Reality</option><option value="vless-tls" ${item.inboundTemplate === 'vless-tls' ? 'selected' : ''}>VLESS TLS</option><option value="vless-ws" ${item.inboundTemplate === 'vless-ws' ? 'selected' : ''}>VLESS WebSocket</option><option value="vless-grpc" ${item.inboundTemplate === 'vless-grpc' ? 'selected' : ''}>VLESS gRPC</option></select></div><div class="field"><label>SNI / 域名</label><input name="inboundSni" value="${h(item.inboundSni || '')}"></div><div class="field"><label>目标站点 / 主机名</label><input name="inboundHost" value="${h(item.inboundHost || '')}"></div></div>
        <div class="grid-2"><div class="field"><label>WS 路径</label><input name="inboundPath" value="${h(item.inboundPath || '')}" placeholder="例如 /shiye"></div><div class="field"><label>gRPC 服务名</label><input name="inboundGrpcServiceName" value="${h(item.inboundGrpcServiceName || '')}"></div></div>
        <div class="grid-2"><div class="field"><label>TLS 证书路径</label><input name="inboundCertFile" value="${h(item.inboundCertFile || '')}"></div><div class="field"><label>TLS 私钥路径</label><input name="inboundKeyFile" value="${h(item.inboundKeyFile || '')}"></div></div>
      `)}
      ${renderSection('SOCKS 中转', `
        <div class="grid-2"><div class="field"><label>中转开关</label><div class="check-row"><input name="useSocks" type="checkbox" ${item.useSocks ? 'checked' : ''}> 启用 SOCKS 中转</div></div><div class="field"><label>SOCKS 出站</label><select name="socksNodeId"><option value="">未选择</option>${state.db.socksNodes.map((socks) => `<option value="${socks.id}" ${item.socksNodeId === socks.id ? 'selected' : ''}>${h(socks.name)}</option>`).join('')}</select></div></div>
      `)}`;
  }
  if (type === 'customerNode') {
    const customer = customerById(item.customerId) || {};
    const selectedNode = serviceNodeById(item.nodeId) || state.db.serviceNodes[0] || {};
    return `
      <div class="form-note">用户：${h(customer.name || item.customerName || '-')}。用户端节点名称固定显示服务节点名称；这里的绑定备注名只用于管理员区分记录。</div>
      ${renderSection('绑定节点', `
        <input type="hidden" name="customerId" value="${h(item.customerId || '')}">
        <div class="grid-2"><div class="field"><label>服务节点</label><select name="nodeId" required data-service-node-picker data-previous-node-id="${h(selectedNode.id || '')}">${state.db.serviceNodes.map((node) => `<option value="${node.id}" ${item.nodeId === node.id ? 'selected' : ''}>${h(node.name)}</option>`).join('')}</select></div><div class="field"><label>绑定备注名</label><input name="name" value="${h(item.name || '')}" placeholder="可留空，仅管理员可见"></div></div>
        <div class="grid-2"><div class="field"><label>流量 GB</label><input name="trafficLimitGb" type="number" min="0" value="${h(item.trafficLimitGb ?? selectedNode.trafficLimitGb ?? 100)}"></div><div class="field"><label>状态</label><select name="status"><option value="active" ${item.status !== 'disabled' ? 'selected' : ''}>正常</option><option value="disabled" ${item.status === 'disabled' ? 'selected' : ''}>停用</option></select></div></div>
        <div class="field"><label>到期时间</label><input name="expireAt" type="datetime-local" value="${h(dateInputValue(item.expireAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()))}"></div>
      `)}
      ${renderSection('客户端标识', `
        <div class="grid-3"><div class="field"><label>客户端 ID</label><input name="clientId" value="${h(item.clientId || '')}" placeholder="可留空，默认等于客户端邮箱"></div><div class="field"><label>客户端邮箱</label><input name="clientEmail" value="${h(item.clientEmail || '')}" placeholder="可留空自动生成"></div><div class="field"><label>UUID</label><input name="clientUuid" value="${h(item.clientUuid || '')}" placeholder="可留空自动生成"></div></div>
      `)}
      <div class="field"><label>备注</label><textarea name="remark">${h(item.remark || '')}</textarea></div>`;
  }
  if (type === 'customerNodes') {
    const customer = customerById(item.customerId) || item;
    const bindings = customerBindings(customer.id);
    return `${renderSection('已绑定节点', `
      <div class="node-admin-list">${bindings.length ? bindings.map((binding) => {
        const serviceNode = serviceNodeById(binding.nodeId);
        const status = customerNodeStatus(binding);
        return `<div class="node-admin-item">
          <div><strong>${h(customerNodeName(binding))}</strong><span>${h(serviceNode?.name || '服务节点不存在')}</span></div>
          <div><small>到期</small><b>${fmtDate(binding.expireAt)}</b></div>
          <div><small>价格</small><b>${money(serviceNode?.amount || 0)} ${h(state.db.settings.currency)}/月</b></div>
          <span class="status ${status}">${statusText[status] || status}</span>
          <div class="row-actions"><button class="btn small primary" type="button" data-action="renew-customer-node" data-id="${customer.id}" data-node-id="${binding.id}">续费</button><button class="btn small" type="button" data-action="sync-customer-node" data-id="${customer.id}" data-node-id="${binding.id}">同步</button><button class="btn small" type="button" data-action="edit-customer-node" data-id="${customer.id}" data-node-id="${binding.id}">编辑</button><button class="btn small danger" type="button" data-action="delete-customer-node" data-id="${customer.id}" data-node-id="${binding.id}">删除</button></div>
        </div>`;
      }).join('') : '<div class="empty">这个用户还没有绑定节点。</div>'}</div>
      <div class="form-actions"><button class="btn primary" type="button" data-action="bind-customer-node" data-id="${customer.id}">绑定新节点</button></div>
    `)}`;
  }
  if (type === 'socks') {
    return `${renderSection('出站信息', `
      <div class="grid-2"><div class="field"><label>名称</label><input name="name" value="${h(item.name)}" required></div><div class="field"><label>出站标识</label><input name="tag" value="${h(item.tag)}" placeholder="socks_hk_01"></div></div>
      <div class="grid-2"><div class="field"><label>地址</label><input name="address" value="${h(item.address)}" required></div><div class="field"><label>端口</label><input name="port" type="number" value="${h(item.port || 1080)}"></div></div>
      <div class="grid-2"><div class="field"><label>用户名</label><input name="username" value="${h(item.username)}"></div><div class="field"><label>密码</label><input name="password" type="password" value="${h(item.password)}"></div></div>
      <div class="grid-2"><div class="field"><label>状态</label><select name="status"><option value="enabled" ${item.status !== 'disabled' ? 'selected' : ''}>启用</option><option value="disabled" ${item.status === 'disabled' ? 'selected' : ''}>停用</option></select></div><div class="field"><label>备注</label><input name="remark" value="${h(item.remark)}"></div></div>
    `)}`;
  }
  if (type === 'balance') {
    return `<div class="form-note">用户：${h(item.name)}，当前余额：${money(item.balance)} ${h(state.db.settings.currency)}</div>${renderSection('余额调整', `
      <div class="grid-2"><div class="field"><label>调整方式</label><select name="mode"><option value="add">增加余额</option><option value="subtract">扣减余额</option><option value="set">设置为固定余额</option></select></div><div class="field"><label>金额</label><input name="amount" type="number" min="0" step="0.01" value="0" required></div></div>
      <div class="field"><label>备注</label><input name="remark" placeholder="例如：线下补款 / 退款 / 纠错"></div>
    `)}`;
  }
  return `
    ${renderSection('用户登录', `
      <div class="grid-3"><div class="field"><label>用户名称</label><input name="name" value="${h(item.name)}" required></div><div class="field"><label>登录账号</label><input name="loginUsername" value="${h(item.loginUsername)}" autocomplete="off" placeholder="留空则不能登录用户端"></div><div class="field"><label>登录密码</label><input name="loginPassword" type="password" autocomplete="new-password" placeholder="编辑时留空表示不修改"></div></div>
      <div class="grid-2"><div class="field"><label>联系方式</label><input name="contact" value="${h(item.contact)}"></div><div class="field"><label>余额</label><input name="balance" type="number" min="0" step="0.01" value="${h(item.balance || 0)}"></div></div>
    `)}
    ${renderSection('账号状态', `
      <div class="grid-2"><div class="field"><label>状态</label><select name="status"><option value="active" ${item.status !== 'disabled' ? 'selected' : ''}>正常</option><option value="disabled" ${item.status === 'disabled' ? 'selected' : ''}>停用</option></select></div><div class="field"><label>备注</label><input name="remark" value="${h(item.remark || '')}"></div></div>
    `)}
    <div class="form-note">节点、价格、流量和到期时间请在用户列表的“绑定节点 / 节点管理”中单独维护。</div>`;
}

function bindEvents() {
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
    if (state.role === 'user') state.userView = button.dataset.view;
    else state.view = button.dataset.view;
    state.drawer = null;
    state.paymentEditor = '';
    render();
  }));
  document.querySelector('[data-search]')?.addEventListener('input', (event) => {
    state.search = event.target.value;
    render();
  });
  document.querySelectorAll('[data-action]').forEach((el) => el.addEventListener('click', handleAction));
  document.querySelector('[data-drawer-backdrop]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      state.drawer = null;
      render();
    }
  });
  document.querySelector('[data-modal-backdrop]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeModal(null);
  });
  document.querySelector('[data-payment-editor-backdrop]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      state.paymentEditor = '';
      render();
    }
  });
  document.querySelector('[data-payment-editor-select]')?.addEventListener('change', (event) => {
    state.paymentEditor = event.currentTarget.value || 'alipay';
    render();
  });
  document.querySelector('#modalForm')?.addEventListener('click', (event) => event.stopPropagation());
  document.querySelector('#modalForm')?.addEventListener('submit', handleModalSubmit);
  const drawerForm = document.querySelector('#drawerForm');
  drawerForm?.addEventListener('click', (event) => event.stopPropagation());
  drawerForm?.addEventListener('submit', handleDrawerSubmit);
  drawerForm?.querySelector('[data-service-node-picker]')?.addEventListener('change', updateCustomerNodeDefaults);
  document.querySelectorAll('[data-settings-form]').forEach((form) => form.addEventListener('submit', handleSettingsFormSubmit));
  document.querySelectorAll('[data-payment-select]').forEach((button) => button.addEventListener('click', () => {
    const form = button.closest('[data-settings-form="payments"]');
    const next = button.dataset.paymentSelect || '';
    if (form) form.dataset.activePayment = form.dataset.activePayment === next ? '' : next;
    updatePaymentProviderVisibility();
  }));
  document.querySelectorAll('[data-payment-toggle]').forEach((input) => input.addEventListener('change', updatePaymentProviderVisibility));
  updatePaymentProviderVisibility();
  document.querySelector('#redeemForm')?.addEventListener('submit', handleRedeemSubmit);
  document.querySelector('#rechargeForm')?.addEventListener('submit', handleRechargeSubmit);
  document.querySelector('#userProfileForm')?.addEventListener('submit', handleUserProfileSubmit);
  document.querySelectorAll('.user-renew-form').forEach((form) => form.addEventListener('submit', handleUserRenewSubmit));
}

function updatePaymentProviderVisibility() {
  const form = document.querySelector('[data-settings-form="payments"]');
  const active = form?.dataset.activePayment || '';
  document.querySelectorAll('[data-payment-section]').forEach((box) => {
    const section = box.dataset.paymentSection;
    const input = document.querySelector(`[data-payment-toggle="${section}"]`);
    const fields = document.querySelector(`[data-payment-fields="${section}"]`);
    const isActive = section === active;
    fields?.classList.toggle('hidden', !isActive);
    box.classList.toggle('active', isActive);
    box.classList.toggle('disabled', input ? !input.checked : false);
  });
  document.querySelectorAll('[data-payment-toggle]').forEach((input) => {
    const section = input.dataset.paymentToggle;
    const box = document.querySelector(`[data-payment-section="${section}"]`);
    box?.classList.toggle('disabled', !input.checked);
  });
}

function updateCustomerNodeDefaults(event) {
  const select = event.currentTarget;
  const form = select.closest('form');
  const node = serviceNodeById(select.value);
  if (!form || !node) return;
  form.querySelector('[name="trafficLimitGb"]').value = node.trafficLimitGb ?? 100;
  select.dataset.previousNodeId = node.id || '';
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (state.modal) return closeModal(null);
  if (state.paymentEditor) {
    state.paymentEditor = '';
    render();
    return;
  }
  if (state.drawer) {
    state.drawer = null;
    render();
  }
});

function handleModalSubmit(event) {
  event.preventDefault();
  const input = event.currentTarget.querySelector('[data-modal-input]');
  closeModal(input ? input.value : true);
}

async function handleAction(event) {
  const action = event.currentTarget.dataset.action;
  const id = event.currentTarget.dataset.id;
  try {
    if (action === 'open-payment-editor') {
      state.paymentEditor = event.currentTarget.dataset.provider || 'alipay';
      return render();
    }
    if (action === 'close-payment-editor') {
      state.paymentEditor = '';
      return render();
    }
    if (action === 'refresh') return refresh();
    if (action === 'cancel-modal') return closeModal(null);
    if (action === 'logout') {
      await api('/api/logout', { method: 'POST', body: { entry: entryMode } });
      state.user = null;
      state.role = '';
      state.db = null;
      return renderLogin();
    }
    if (action === 'buy-card-link') {
      const url = state.db.settings?.purchaseCardUrl;
      if (!url) return toast('管理员还没有设置购买卡密链接');
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (action === 'pick-recharge-amount') {
      const input = document.querySelector('#rechargeForm [name="amount"]');
      if (input) input.value = event.currentTarget.dataset.amount || input.value;
      return;
    }
    if (action === 'copy-node-link') {
      const nodeId = event.currentTarget.dataset.nodeId || '';
      const busyKey = `copy-node:${nodeId}`;
      setBusy(busyKey);
      try {
        const result = await api(`/api/user/node/link?nodeId=${encodeURIComponent(nodeId)}`);
        const link = result.link || '';
        if (!link) return toast('真实节点链接不可用，请联系管理员处理');
        await copyText(link);
        return toast('节点链接已复制');
      } finally {
        clearBusy(busyKey);
      }
    }
    if (action === 'show-node-qr') {
      const nodeId = event.currentTarget.dataset.nodeId || '';
      const busyKey = `qr-node:${nodeId}`;
      setBusy(busyKey);
      try {
        const qrUrl = `/api/user/node/qrcode?nodeId=${encodeURIComponent(nodeId)}&t=${Date.now()}`;
        const response = await fetch(qrUrl, { headers: { 'X-Entry-Mode': entryMode } });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.detail || data.message || '真实节点二维码不可用，请联系管理员处理');
        }
        return openModal({
          title: '节点二维码',
          content: `<div class="modal-qr"><img src="${qrUrl}" alt="节点二维码"></div>`,
          confirmText: '关闭',
          cancelText: '取消'
        });
      } finally {
        clearBusy(busyKey);
      }
    }
    if (action === 'copy-card-group') {
      const area = document.querySelector(`[data-card-group="${event.currentTarget.dataset.index}"]`);
      const text = area?.value || '';
      if (!text.trim()) return toast('这个分类没有可复制的未使用卡密');
      await copyText(text);
      return toast('已复制这一类未使用卡密');
    }
    if (action === 'generate-card-group') {
      const group = getCardGroup(event.currentTarget.dataset.index);
      if (!group) return toast('这个分类不存在，请刷新后再试');
      const sample = group.cards.find((card) => card.status === 'unused') || group.cards[0] || {};
      state.drawer = { type: 'cards', item: { batchId: group.batchId, type: group.type, amount: sample.amount || 10, remark: sample.remark || '' } };
      return render();
    }
    if (action === 'rename-card-group') {
      const group = getCardGroup(event.currentTarget.dataset.index);
      if (!group) return toast('这个分类不存在，请刷新后再试');
      const nextType = await promptDialog('修改卡密分类名称', '输入新的分类名称，保存后会同步到这个分类下的卡密。', group.type);
      if (nextType === null) return;
      if (!nextType.trim()) return toast('分类名称不能为空');
      const result = group.batchId
        ? await api(`/api/card-batches/${group.batchId}`, { method: 'PUT', body: { name: nextType.trim() } })
        : await api('/api/cards/bulk-update', { method: 'POST', body: { ids: group.cards.map((card) => card.id), type: nextType.trim() } });
      state.db = result.data;
      toast(group.batchId ? '卡密批次名称已修改' : `已修改 ${result.updated || 0} 张卡密的分类名称`);
      return render();
    }
    if (action === 'delete-card-group') {
      const group = getCardGroup(event.currentTarget.dataset.index);
      if (!group) return toast('这个分类不存在，请刷新后再试');
      const ids = group.cards.filter((card) => ['unused', 'disabled'].includes(card.status)).map((card) => card.id);
      if (!ids.length) return toast('这个分类没有可删除的未使用或已禁用卡密');
      if (!await confirmDialog('删除未使用卡密', `确定删除“${group.type}”分类下 ${ids.length} 张未使用或已禁用卡密？已使用卡密会保留。`, { tone: 'danger', confirmText: '删除' })) return;
      const result = group.batchId
        ? await api(`/api/card-batches/${group.batchId}`, { method: 'DELETE' })
        : await api('/api/cards/bulk-delete', { method: 'POST', body: { ids } });
      state.db = result.data;
      toast(`已删除 ${result.deleted || 0} 张卡密${result.keptUsed ? `，保留已使用 ${result.keptUsed} 张` : ''}`);
      return render();
    }
    if (action === 'close-drawer') {
      state.drawer = null;
      return render();
    }
    let openedDrawer = false;
    if (action === 'new-customer') state.drawer = { type: 'customer', item: null };
    if (action === 'edit-customer') state.drawer = { type: 'customer', item: state.db.customers.find((customer) => customer.id === id) };
    if (action === 'generate-cards') state.drawer = { type: 'cards', item: null };
    if (action === 'new-server') state.drawer = { type: 'server', item: null };
    if (action === 'edit-server') state.drawer = { type: 'server', item: state.db.xuiServers.find((server) => server.id === id) };
    if (action === 'new-service-node') state.drawer = { type: 'serviceNode', item: null };
    if (action === 'edit-service-node') state.drawer = { type: 'serviceNode', item: state.db.serviceNodes.find((node) => node.id === id) };
    if (action === 'sync-service-nodes') {
      if (!await confirmDialog('同步服务节点', '确定从这个面板读取入站并同步为服务节点？不会导入用户，也不会修改用户绑定。', { confirmText: '同步' })) return;
      const result = await api(`/api/xui-servers/${id}/sync-service-nodes`, { method: 'POST' });
      state.db = result.data;
      state.view = 'service-nodes';
      toast(result.message || '服务节点同步完成');
      return render();
    }
    if (action === 'bind-customer-node') {
      if (!state.db.serviceNodes.length) return toast('请先添加服务节点');
      const customer = customerById(id);
      state.drawer = { type: 'customerNode', item: { customerId: id, customerName: customer?.name || '' } };
    }
    if (action === 'manage-customer-nodes') state.drawer = { type: 'customerNodes', item: { customerId: id } };
    if (action === 'edit-customer-node') {
      const binding = (state.db.customerNodes || []).find((node) => node.id === event.currentTarget.dataset.nodeId && node.customerId === id);
      state.drawer = { type: 'customerNode', item: binding };
    }
    if (action === 'new-socks') state.drawer = { type: 'socks', item: null };
    if (action === 'edit-socks') state.drawer = { type: 'socks', item: state.db.socksNodes.find((socks) => socks.id === id) };
    if (action === 'adjust-balance') state.drawer = { type: 'balance', item: state.db.customers.find((customer) => customer.id === id) };
    openedDrawer = ['new-customer', 'edit-customer', 'generate-cards', 'new-server', 'edit-server', 'new-service-node', 'edit-service-node', 'bind-customer-node', 'manage-customer-nodes', 'edit-customer-node', 'new-socks', 'edit-socks', 'adjust-balance'].includes(action);
    if (openedDrawer) return render();

    if (action === 'delete-service-node') {
      if (!await confirmDialog('删除服务节点', '确定删除这个服务节点？已有用户绑定时系统会拒绝删除。', { tone: 'danger', confirmText: '删除' })) return;
      const result = await api(`/api/service-nodes/${id}`, { method: 'DELETE' });
      state.db = result.data;
      return render();
    }
    if (action === 'delete-customer-node') {
      const nodeId = event.currentTarget.dataset.nodeId;
      if (!await confirmDialog('删除用户节点', '确定删除这个用户绑定节点？系统会尝试清理远端客户端。', { tone: 'danger', confirmText: '删除' })) return;
      const result = await api(`/api/customers/${id}/nodes/${nodeId}`, { method: 'DELETE' });
      state.db = result.data;
      state.drawer = { type: 'customerNodes', item: { customerId: id } };
      toast(result.warning || '用户节点已删除');
      return render();
    }
    if (action === 'sync-customer-node') {
      const nodeId = event.currentTarget.dataset.nodeId;
      const result = await api(`/api/customers/${id}/nodes/${nodeId}/sync`, { method: 'POST' });
      state.db = result.data;
      state.drawer = { type: 'customerNodes', item: { customerId: id } };
      toast('节点同步完成');
      return render();
    }
    if (action === 'renew-customer-node') {
      const nodeId = event.currentTarget.dataset.nodeId;
      const binding = (state.db.customerNodes || []).find((node) => node.id === nodeId && node.customerId === id);
      const serviceNode = serviceNodeById(binding?.nodeId);
      const monthsText = await promptDialog('续费用户节点', `输入续费月数。当前节点：${customerNodeName(binding)}，单月价格：${money(serviceNode?.amount || 0)} ${state.db.settings.currency}`, '1');
      if (monthsText === null) return;
      const months = Math.max(1, Math.floor(Number(monthsText || 1)));
      const result = await api(`/api/customers/${id}/nodes/${nodeId}/renew`, { method: 'POST', body: { months } });
      state.db = result.data;
      state.drawer = { type: 'customerNodes', item: { customerId: id } };
      toast(result.warning || '节点续费成功');
      return render();
    }
    if (action === 'sync') {
      const result = await api(`/api/customers/${id}/sync`, { method: 'POST' });
      state.db = result.data;
      const createdInbound = result.detail?.clientResult?.createdInbound;
      const suffix = createdInbound ? `，新入站端口 ${createdInbound.port}` : '';
      const socksSuffix = result.detail?.socksResult?.applied ? `，SOCKS ${result.detail.socksResult.outboundTag}` : '';
      toast(`同步完成${suffix}${socksSuffix}`);
      return render();
    }
    if (action === 'toggle') {
      const result = await api(`/api/customers/${id}/toggle`, { method: 'POST' });
      state.db = result.data;
      if (result.warning) toast(result.warning);
      return render();
    }
    if (action === 'delete-customer') {
      if (!await confirmDialog('删除用户', '确定删除这个用户？会同步删除 3-xui 里的 client，并清理这个用户对应的 SOCKS 路由。', { tone: 'danger', confirmText: '删除用户' })) return;
      const result = await api(`/api/customers/${id}`, { method: 'DELETE' });
      state.db = result.data;
      toast(result.warning ? `用户已删除，远程警告：${result.warning}` : '用户已删除，并已同步清理远程资源');
      return render();
    }
    if (action === 'toggle-card') {
      const card = state.db.cards.find((item) => item.id === id);
      const result = await api(`/api/cards/${id}`, { method: 'PUT', body: { status: card.status === 'disabled' ? 'unused' : 'disabled' } });
      state.db = result.data;
      return render();
    }
    if (action === 'delete-card') {
      if (!await confirmDialog('删除卡密', '确定删除这张未使用卡密？', { tone: 'danger', confirmText: '删除' })) return;
      const result = await api(`/api/cards/${id}`, { method: 'DELETE' });
      state.db = result.data;
      return render();
    }
    if (action === 'delete-server') {
      if (!await confirmDialog('删除 3x-ui 节点', '确定删除这个 3x-ui 节点？', { tone: 'danger', confirmText: '删除' })) return;
      const result = await api(`/api/xui-servers/${id}`, { method: 'DELETE' });
      state.db = result.data;
      return render();
    }
    if (action === 'delete-socks') {
      if (!await confirmDialog('删除 SOCKS 出站', '确定删除这个 SOCKS 出站？', { tone: 'danger', confirmText: '删除' })) return;
      const result = await api(`/api/socks-nodes/${id}`, { method: 'DELETE' });
      state.db = result.data;
      return render();
    }
    if (action === 'disable-expired') {
      if (!await confirmDialog('停用过期用户', '系统会把已经过期的用户改为停用，并尝试同步到 3-xui 禁用对应客户端。确定继续吗？', { confirmText: '开始停用' })) return;
      const result = await api('/api/maintenance/disable-expired', { method: 'POST' });
      state.db = result.data;
      toast(result.warning || `已停用 ${result.count} 个过期用户`);
      return render();
    }
    if (action === 'test-server') {
      const server = state.db.xuiServers.find((item) => item.id === id);
      const result = await api('/api/test-xui', { method: 'POST', body: server });
      return toast(result.message || '3x-ui 节点连接成功');
    }
  } catch (error) {
    toast(error.message);
  }
}

async function handleRedeemSubmit(event) {
  event.preventDefault();
  if (state.busyAction) return;
  setBusy('redeem');
  const form = new FormData(event.currentTarget);
  try {
    const result = await api('/api/user/cards/redeem', { method: 'POST', body: Object.fromEntries(form) });
    state.db = result.data;
    toast(result.message || '充值成功');
    render();
  } catch (error) {
    toast(error.message);
  } finally {
    clearBusy('redeem');
  }
}

async function handleRechargeSubmit(event) {
  event.preventDefault();
  if (state.busyAction) return;
  setBusy('recharge');
  const form = new FormData(event.currentTarget);
  const body = {
    amount: Number(form.get('amount') || 0),
    method: String(form.get('method') || '')
  };
  try {
    const result = await api('/api/user/recharge-orders', { method: 'POST', body });
    state.db = result.data || state.db;
    if (result.qrImage) {
      return openModal({
        title: '扫码支付',
        message: '请扫码完成付款，到账以支付平台异步回调为准。',
        content: `<div class="modal-qr payment-qr"><img src="${h(result.qrImage)}" alt="支付二维码"></div>`,
        confirmText: '关闭',
        cancelText: '取消'
      });
    }
    if (result.payUrl) window.location.href = result.payUrl;
    else toast('支付订单已创建');
  } catch (error) {
    toast(error.message);
  } finally {
    clearBusy('recharge');
  }
}

async function handleUserRenewSubmit(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const nodeId = event.currentTarget.dataset.renewNodeId || '';
  const node = userNodes().find((item) => item.id === nodeId);
  const months = Math.max(1, Math.floor(Number(form.get('months') || 1)));
  const price = Number(node?.renewPrice || 0) * months;
  if (!await confirmDialog('确认续费', `续费 ${node?.name || '当前服务'} ${months} 个月将扣除 ${money(price)} ${state.db.settings.currency}。`, { confirmText: '确认续费' })) return;
  const busyKey = `renew:${nodeId}`;
  setBusy(busyKey);
  try {
    const result = await api('/api/user/renew', { method: 'POST', body: { nodeId, months } });
    state.db = result.data;
    toast(result.warning || '续费成功');
    render();
  } catch (error) {
    toast(error.message);
  } finally {
    clearBusy(busyKey);
  }
}

async function handleUserProfileSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  if ((body.newPassword || body.confirmPassword) && body.newPassword !== body.confirmPassword) return toast('两次输入的新密码不一致');
  try {
    const result = await api('/api/user/profile', { method: 'PUT', body });
    state.user = result.user || body.loginUsername;
    state.role = result.role || state.role;
    state.db = result.data;
    render();
    toast('账号资料已保存');
  } catch (error) {
    toast(error.message);
  }
}

async function handleSettingsFormSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const type = form.dataset.settingsForm;
  const body = Object.fromEntries(new FormData(form));
  try {
    if (type === 'security') {
      if (body.newPassword !== body.confirmPassword) return toast('两次输入的新密码不一致');
      await api('/api/change-password', { method: 'POST', body });
      state.db = null;
      renderLogin();
      return toast('账号安全已保存，请重新登录');
    }
    if (type === 'payments') {
      const current = state.db.settings?.payments || {};
      const currentFlags = {
        paymentsEnabled: Boolean(current.enabled),
        alipayEnabled: Boolean(current.alipay?.enabled),
        alipayMethodPage: current.alipay?.methods?.page !== false,
        alipayMethodWap: Boolean(current.alipay?.methods?.wap),
        alipayMethodPrecreate: Boolean(current.alipay?.methods?.precreate),
        epayEnabled: Boolean(current.epay?.enabled),
        epayMethodAlipay: Boolean(current.epay?.methods?.alipay),
        epayMethodWxpay: Boolean(current.epay?.methods?.wxpay),
        epayMethodPaypal: Boolean(current.epay?.methods?.paypal),
        epayMethodUsdt: Boolean(current.epay?.methods?.usdt),
        bepusdtEnabled: Boolean(current.bepusdt?.enabled),
        wechatEnabled: Boolean(current.wechat?.enabled),
        wechatMethodNative: current.wechat?.methods?.native !== false,
        wechatMethodH5: Boolean(current.wechat?.methods?.h5)
      };
      Object.keys(currentFlags).forEach((name) => {
        const input = form.querySelector(`[name="${name}"]`);
        body[name] = input ? Boolean(input.checked) : currentFlags[name];
      });
    }
    if (type === 'settings') {
      const file = form.querySelector('[name="logoFile"]')?.files?.[0];
      if (file) {
        if (!file.type.startsWith('image/')) return toast('请上传图片文件');
        if (file.size > 240 * 1024) return toast('图标图片不能超过 240KB');
        body.logoDataUrl = await fileToDataUrl(file);
      }
      if (form.querySelector('[name="clearLogo"]')?.checked) body.logoDataUrl = '';
      delete body.logoFile;
      body.clearLogo = Boolean(form.querySelector('[name="clearLogo"]')?.checked);
    }
    const result = await api('/api/settings', { method: 'PUT', body });
    state.db = result.data;
    state.branding = { brandName: state.db.settings?.brandName || '十夜', logoDataUrl: state.db.settings?.logoDataUrl || '' };
    document.title = appTitle(entryMode === 'admin' ? '管理系统' : '用户中心');
    setFavicon();
    if (type === 'payments') state.paymentEditor = '';
    render();
    if (type === 'payments') return toast(result.warning || '支付设置已保存');
    return toast(result.warning || `系统设置已保存，管理员入口：${result.data?.settings?.adminPath || body.adminPath || '/admin'}`);
  } catch (error) {
    toast(error.message);
  }
}

async function handleDrawerSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const type = form.dataset.drawerType;
  const id = form.dataset.id;
  const body = Object.fromEntries(new FormData(form));
  if (body.expireAt) body.expireAt = toIsoLocal(body.expireAt);
  body.useSocks = Boolean(form.querySelector('[name="useSocks"]')?.checked);
  body.autoCreateInbound = Boolean(form.querySelector('[name="autoCreateInbound"]')?.checked);
  try {
    let result;
    if (type === 'customer') result = await api(id ? `/api/customers/${id}` : '/api/customers', { method: id ? 'PUT' : 'POST', body });
    if (type === 'cards') result = await api('/api/cards/generate', { method: 'POST', body });
    if (type === 'server') result = await api(id ? `/api/xui-servers/${id}` : '/api/xui-servers', { method: id ? 'PUT' : 'POST', body });
    if (type === 'serviceNode') result = await api(id ? `/api/service-nodes/${id}` : '/api/service-nodes', { method: id ? 'PUT' : 'POST', body });
    if (type === 'customerNode') {
      const customerId = body.customerId || state.drawer?.item?.customerId;
      result = await api(id ? `/api/customers/${customerId}/nodes/${id}` : `/api/customers/${customerId}/nodes`, { method: id ? 'PUT' : 'POST', body });
    }
    if (type === 'socks') result = await api(id ? `/api/socks-nodes/${id}` : '/api/socks-nodes', { method: id ? 'PUT' : 'POST', body });
    if (type === 'balance') result = await api(`/api/customers/${id}/balance-adjust`, { method: 'POST', body });
    state.db = result.data;
    if (type === 'customerNode') state.drawer = { type: 'customerNodes', item: { customerId: body.customerId || state.drawer?.item?.customerId } };
    else state.drawer = null;
    render();
    const message = type === 'cards'
      ? `已生成 ${result.generated?.length || 0} 张卡密`
      : '保存成功';
    toast(result.warning || message);
  } catch (error) {
    toast(error.message);
  }
}

bootstrap();
