const app = document.querySelector('#app');
const entryMode = document.body.dataset.entry || 'user';

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
  userView: 'user-home',
  db: null,
  branding: { brandName: '十夜', logoDataUrl: '' },
  modal: null,
  busyAction: '',
  toast: '',
  selectedRechargeMethod: '',
  selectedRechargeAmount: ''
};

let modalResolver = null;

const userNavItems = [
  ['user-home', '充值续费', 'wallet'],
  ['user-nodes', '节点管理', 'server'],
  ['user-profile', '账号资料', 'user']
];

const navIcons = {
  user: '<path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="7" r="4"/>',
  server: '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/>',
  wallet: '<path d="M19 7V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3v1a2 2 0 0 1-2 2H5a3 3 0 0 1-3-3V6"/><path d="M18 14h.01"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.72l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>'
};

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

function appTitle(suffix = '用户中心') {
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
    document.title = appTitle('用户中心');
    setFavicon();
  } catch {}
}

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

const disabledReasonText = {
  expired: '已过期自动停用',
  traffic_exceeded: '流量超限自动停用',
  remote_disabled: '远端已停用',
  manual: '手动停用'
};

function nodeDisabledReasonText(node = {}) {
  return disabledReasonText[node.disabledReason] || (node.status === 'disabled' ? '已停用' : '');
}

function nodeCanSelfRenew(node = {}) {
  return node.status !== 'disabled' || ['expired', 'traffic_exceeded'].includes(String(node.disabledReason || ''));
}

const isPaymentResultPage = location.pathname.replace(/\/+$/, '') === '/payment/result';

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
    content: options.content || '',
    objectUrl: options.objectUrl || '',
    confirmText: options.confirmText || '确定',
    cancelText: options.cancelText || '取消'
  };
  render();
  return new Promise((resolve) => {
    modalResolver = resolve;
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

async function bootstrap() {
  await loadBranding();
  if (isPaymentResultPage) return renderPaymentResult();
  try {
    const setup = await api('/api/setup/status');
    if (!setup.installed) {
      renderSetupRequired();
      return;
    }
    const result = await api(`/api/bootstrap?entry=${encodeURIComponent(entryMode)}`);
    state.user = result.user;
    state.role = result.role || 'user';
    state.db = result.data;
    state.userView ||= 'user-home';
    render();
  } catch {
    state.user = null;
    state.role = '';
    state.db = null;
    renderLogin();
  }
}

async function renderPaymentResult() {
  const tradeNo = new URLSearchParams(location.search).get('trade_no') || '';
  app.innerHTML = `
    <section class="login-wrap">
      <div class="login-shell result-shell">
        <aside class="login-hero">
          ${brandMark('login-hero-mark')}
          <h2>支付结果</h2>
          <p>支付完成后，系统会根据平台异步回调自动更新充值状态。</p>
          <div class="login-hero-grid"><span>订单</span><span>支付</span><span>余额</span><span>回调</span></div>
        </aside>
        <div class="login-card" id="paymentResultCard">
          <div class="login-card-mark">查询</div>
          <h1>正在查询订单</h1>
          <p>请稍候，正在读取支付结果。</p>
        </div>
      </div>
    </section>`;
  const card = document.querySelector('#paymentResultCard');
  if (!tradeNo) {
    card.innerHTML = paymentResultContent('无法查询订单', '缺少订单号，请返回用户中心查看账户记录。', 'warning');
    return;
  }
  try {
    const result = await api(`/api/payments/result?trade_no=${encodeURIComponent(tradeNo)}`, { headers: { 'X-Entry-Mode': 'user' } });
    const order = result.order || {};
    const paid = order.status === 'paid';
    const failed = order.status === 'failed';
    const title = paid ? '支付已到账' : failed ? '支付失败' : '等待支付回调';
    const message = paid
      ? `充值 ${money(order.amount)} 已加入账户余额。`
      : failed
        ? '订单状态为失败，如已扣款请联系管理员处理。'
        : '如果你已经完成支付，平台回调可能需要一点时间，请稍后刷新账户记录。';
    card.innerHTML = paymentResultContent(title, message, paid ? 'success' : failed ? 'failed' : 'warning', order);
  } catch (error) {
    card.innerHTML = paymentResultContent('查询失败', error.message || '暂时无法读取订单状态。', 'failed');
  }
}

function paymentResultContent(title, message, tone, order = null) {
  return `
    <div class="login-card-mark ${h(tone || '')}">${tone === 'success' ? '成功' : tone === 'failed' ? '失败' : '状态'}</div>
    <h1>${h(title)}</h1>
    <p>${h(message)}</p>
    ${order ? `<div class="payment-result-lines">
      <div><span>订单号</span><strong>${h(order.tradeNo || '-')}</strong></div>
      <div><span>支付方式</span><strong>${h(paymentMethodText(order.method))}</strong></div>
      <div><span>金额</span><strong>${money(order.amount)} CNY</strong></div>
      <div><span>状态</span><strong>${h(statusText[order.status] || order.status || '-')}</strong></div>
    </div>` : ''}
    <div class="form-actions result-actions"><a class="btn primary" href="/">返回用户中心</a></div>`;
}

async function refresh() {
  const result = await api(`/api/bootstrap?entry=${encodeURIComponent(entryMode)}`);
  state.user = result.user;
  state.role = result.role || state.role;
  state.db = result.data;
  render();
}

function renderSetupRequired() {
  app.innerHTML = `
    <section class="login-wrap">
      <div class="login-shell">
        <aside class="login-hero">
          ${brandMark('login-hero-mark')}
          <h2>系统初始化</h2>
          <p>管理员还没有完成数据库安装，请先从管理员入口完成首次配置。</p>
          <div class="login-hero-grid"><span>账户</span><span>余额</span><span>支付</span><span>续费</span></div>
        </aside>
        <div class="login-card">
          <div class="login-card-mark">提示</div>
          <h1>暂不可登录</h1>
          <p>系统初始化完成后，用户即可使用管理员创建的账号登录。</p>
        </div>
      </div>
    </section>`;
}

function renderLogin() {
  app.innerHTML = `
    <section class="login-wrap">
      <div class="login-shell">
        <aside class="login-hero">
          ${brandMark('login-hero-mark')}
          <h2>用户中心</h2>
          <p>余额充值、卡密兑换与服务续费统一处理。</p>
          <div class="login-hero-grid"><span>账户</span><span>余额</span><span>支付</span><span>续费</span></div>
        </aside>
        <form class="login-card" id="loginForm">
          <div class="login-card-mark">用户</div>
          <h1>${h(appTitle('用户中心'))}</h1>
          <p>用户使用管理员创建的账号登录。用户端不开放注册。</p>
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
  if (!state.db) return renderLogin();
  return renderUserApp();
}

function uiIcon(icon) {
  const paths = navIcons[icon] || navIcons.settings;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function navIcon(icon) {
  return `<span class="nav-icon" aria-hidden="true">${uiIcon(icon)}</span>`;
}

function navButton(view, label, icon, activeView) {
  return `<button class="${activeView === view ? 'active' : ''}" data-view="${view}">${navIcon(icon)}<span class="nav-label">${h(label)}</span></button>`;
}

function iconButton(action, icon, title, extraClass = '') {
  return `<button class="btn icon ${extraClass}" type="button" data-action="${h(action)}" title="${h(title)}" aria-label="${h(title)}">${uiIcon(icon)}</button>`;
}

function sidebarAccount(lines = []) {
  return `<div class="sidebar-footer account-footer"><div class="account-meta">${lines.map((line) => `<span>${line}</span>`).join('')}</div><button class="sidebar-logout" type="button" data-action="logout">${uiIcon('logout')}<span>退出登录</span></button></div>`;
}

function collapsibleSection({ title, desc = '', count = 0, open = false, body = '' }) {
  return `<details class="collapse-section" ${open ? 'open' : ''}>
    <summary><div><strong>${h(title)}</strong>${desc ? `<span>${h(desc)}</span>` : ''}</div><em>${h(count)} 条</em>${uiIcon('chevron')}</summary>
    <div class="collapse-body">${body}</div>
  </details>`;
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
        ${sidebarAccount([`登录用户：${h(state.user)}`, `服务数量：${nodes.length}`, `余额：${money(customer.balance)} ${h(state.db.settings.currency)}`])}
      </aside>
      <section class="content">
        <div class="topbar">
          <div><div class="eyebrow">用户中心</div><h1>${userPageTitle()}</h1><div class="sub">兑换余额、按节点续费和查看服务状态。</div></div>
          <div class="actions">${iconButton('refresh', 'refresh', '刷新数据')}${iconButton('logout', 'logout', '退出登录', 'mobile-only')}</div>
        </div>
        ${renderUserSummary()}
        ${renderUserView()}
      </section>
    </section>
    ${state.modal ? renderModal() : ''}`;
  bindEvents();
}

function userPageTitle() {
  return { 'user-home': '充值续费', 'user-nodes': '节点管理', 'user-profile': '账号资料' }[state.userView] || '用户中心';
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

function renderSection(title, body) {
  return `<section class="form-section"><h3>${h(title)}</h3>${body}</section>`;
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
  const customer = state.db.customer;
  const nodes = userNodes();
  const payments = state.db.settings?.payments || {};
  const methods = payments.methods || [];
  const amountList = payments.amounts || [];
  const fallbackAmount = amountList[0] || payments.minAmount || 10;
  const defaultMethod = methods[0]?.id || '';
  const selectedMethod = methods.some((method) => method.id === state.selectedRechargeMethod) ? state.selectedRechargeMethod : defaultMethod;
  const selectedAmount = state.selectedRechargeAmount || fallbackAmount;
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
      ${payments.enabled ? `<form id="rechargeForm" class="recharge-form">
        <div class="recharge-amount-row">
          <div class="field"><label>选择金额</label><div class="amount-options">${amountList.map((amount) => `<button class="btn small ${String(amount) === String(selectedAmount) ? 'active' : ''}" type="button" data-action="pick-recharge-amount" data-amount="${h(amount)}">${money(amount)}</button>`).join('')}</div></div>
          <div class="field"><label>自选金额</label><input name="amount" data-recharge-amount-input type="number" min="${h(payments.minAmount || 1)}" step="0.01" value="${h(selectedAmount)}" required ${rechargeBusy ? 'disabled' : ''}></div>
        </div>
        <input type="hidden" name="method" value="${h(selectedMethod)}" required>
        <div class="field"><label>支付通道</label><div class="pay-method-grid">${methods.map((method) => `<button class="pay-method-card ${method.id === selectedMethod ? 'active' : ''}" type="button" data-action="pick-pay-method" data-method="${h(method.id)}" ${rechargeBusy ? 'disabled' : ''}>${paymentMethodIcon(method.id)}<span>${h(method.label)}</span></button>`).join('')}</div></div>
        <div class="recharge-actions"><button class="btn primary ${rechargeBusy ? 'loading' : ''}" type="submit" ${rechargeBusy ? 'disabled' : ''}>${rechargeBusy ? '创建订单中...' : '立即支付'}</button></div>
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
  const reason = nodeDisabledReasonText(node);
  const canRenew = Number(node.renewPrice || 0) > 0 && nodeCanSelfRenew(node);
  const busy = isBusy(`renew:${node.id}`);
  const disabled = !canRenew || busy;
  return `<article class="user-node-card">
    <header><div><span>服务名称</span><strong>${h(node.name || '当前服务')}</strong></div><span class="status ${node.status}">${statusText[node.status] || node.status}</span></header>
    ${reason ? `<div class="node-reason">${h(reason)}</div>` : ''}
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
  const rechargeTable = `<table><thead><tr><th>时间</th><th>支付方式</th><th>金额</th><th>状态</th></tr></thead><tbody>${rechargeOrders.length ? rechargeOrders.map((order) => `<tr><td>${fmtDate(order.createdAt)}</td><td>${h(paymentMethodText(order.method))}</td><td>${money(order.amount)} ${h(state.db.settings.currency)}</td><td><span class="status ${order.status === 'paid' ? 'success' : order.status === 'failed' ? 'failed' : 'warning'}">${statusText[order.status] || order.status || '-'}</span></td></tr>`).join('') : `<tr><td colspan="4" class="empty">暂无在线充值订单。</td></tr>`}</tbody></table>`;
  const balanceTable = `<table><thead><tr><th>时间</th><th>类型</th><th>变动</th><th>余额</th></tr></thead><tbody>${balanceLogs.length ? balanceLogs.map((log) => `<tr><td>${fmtDate(log.createdAt)}</td><td>${h(balanceTypeText(log.type))}</td><td class="mono ${Number(log.amount || 0) < 0 ? 'danger-text' : 'success-text'}">${Number(log.amount || 0) > 0 ? '+' : ''}${money(log.amount)}</td><td>${money(log.afterBalance)}</td></tr>`).join('') : `<tr><td colspan="4" class="empty">暂无余额流水。</td></tr>`}</tbody></table>`;
  const renewalTable = `<table><thead><tr><th>时间</th><th>月数</th><th>金额</th><th>到期</th></tr></thead><tbody>${renewalLogs.length ? renewalLogs.map((log) => `<tr><td>${fmtDate(log.createdAt)}</td><td>${h(log.months || 1)}</td><td>${money(log.price)} ${h(state.db.settings.currency)}</td><td>${fmtDate(log.afterExpireAt)}</td></tr>`).join('') : `<tr><td colspan="4" class="empty">暂无续费记录。</td></tr>`}</tbody></table>`;
  return `<section class="panel compact-panel">
    <div class="panel-head"><div><h2>账户记录</h2><p>这里只显示当前账号自己的充值和续费记录。</p></div></div>
    <div class="collapse-stack">
      ${collapsibleSection({ title: '在线充值', desc: '支付订单状态', count: rechargeOrders.length, open: true, body: rechargeTable })}
      ${collapsibleSection({ title: '余额流水', desc: '余额变动明细', count: balanceLogs.length, body: balanceTable })}
      ${collapsibleSection({ title: '续费记录', desc: '服务续费历史', count: renewalLogs.length, body: renewalTable })}
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
  const reason = nodeDisabledReasonText(node);
  return `<article class="user-node-card node-access">
      <div class="node-profile">
        <div class="node-name-block">
          <span>服务名称</span>
          <strong>${h(node.name || '当前服务')}</strong>
        </div>
        <span class="status ${node.status}">${statusText[node.status] || node.status}</span>
      </div>
      ${reason ? `<div class="node-reason">${h(reason)}</div>` : ''}
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

function renderModal() {
  const modal = state.modal || {};
  const confirmClass = modal.tone === 'danger' ? 'btn danger solid' : 'btn primary';
  return `<div class="modal-backdrop" data-modal-backdrop>
    <form class="modal-card" id="modalForm">
      <div class="modal-icon ${h(modal.tone || 'default')}">${modal.tone === 'danger' ? '!' : '?'}</div>
      <div class="modal-content">
        <h2>${h(modal.title)}</h2>
        ${modal.message ? `<p>${h(modal.message)}</p>` : ''}
        ${modal.content || ''}
      </div>
      <footer><button class="btn" type="button" data-action="cancel-modal">${h(modal.cancelText || '取消')}</button><button class="${confirmClass}" type="submit">${h(modal.confirmText || '确定')}</button></footer>
    </form>
  </div>`;
}

function paymentMethodText(method) {
  return {
    alipay: '支付宝',
    wechat: '微信支付',
    paypal: 'PayPal',
    usdt: 'USDT'
  }[method] || method || '-';
}

function paymentMethodIcon(method) {
  return {
    alipay: '<span class="pay-method-icon"><img src="/assets/payments/alipay.webp" alt=""></span>',
    wechat: '<span class="pay-method-icon"><img src="/assets/payments/wechat.jpg" alt=""></span>',
    paypal: '<span class="pay-method-icon"><img src="/assets/payments/paypal.webp" alt=""></span>',
    usdt: '<span class="pay-method-icon"><img src="/assets/payments/usdt.webp" alt=""></span>'
  }[method] || '<span class="pay-method-icon">付</span>';
}

function balanceTypeText(type) {
  return {
    online_recharge: '在线充值',
    card_redeem: '卡密兑换',
    admin_adjust: '后台调整',
    user_renew: '自助续费',
    admin_renew: '后台续费'
  }[type] || type || '-';
}

function bindEvents() {
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
    state.userView = button.dataset.view;
    render();
  }));
  document.querySelectorAll('[data-action]').forEach((el) => el.addEventListener('click', handleAction));
  document.querySelector('[data-modal-backdrop]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeModal(null);
  });
  document.querySelector('#modalForm')?.addEventListener('click', (event) => event.stopPropagation());
  document.querySelector('#modalForm')?.addEventListener('submit', handleModalSubmit);
  document.querySelector('#redeemForm')?.addEventListener('submit', handleRedeemSubmit);
  document.querySelector('#rechargeForm')?.addEventListener('submit', handleRechargeSubmit);
  document.querySelector('[data-recharge-amount-input]')?.addEventListener('input', (event) => {
    state.selectedRechargeAmount = event.currentTarget.value;
    document.querySelectorAll('[data-action="pick-recharge-amount"]').forEach((button) => button.classList.remove('active'));
  });
  document.querySelector('#userProfileForm')?.addEventListener('submit', handleUserProfileSubmit);
  document.querySelectorAll('.user-renew-form').forEach((form) => form.addEventListener('submit', handleUserRenewSubmit));
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (state.modal) closeModal(null);
});

function handleModalSubmit(event) {
  event.preventDefault();
  closeModal(true);
}

async function handleAction(event) {
  const action = event.currentTarget.dataset.action;
  try {
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
      const amount = event.currentTarget.dataset.amount || '';
      state.selectedRechargeAmount = amount;
      if (input) input.value = amount || input.value;
      document.querySelectorAll('[data-action="pick-recharge-amount"]').forEach((button) => button.classList.toggle('active', button === event.currentTarget));
      return;
    }
    if (action === 'pick-pay-method') {
      const form = event.currentTarget.closest('#rechargeForm');
      const input = form?.querySelector('[name="method"]');
      state.selectedRechargeMethod = event.currentTarget.dataset.method || input?.value || '';
      if (input) input.value = state.selectedRechargeMethod || input.value;
      form?.querySelectorAll('[data-action="pick-pay-method"]').forEach((button) => button.classList.toggle('active', button === event.currentTarget));
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
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
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
  const ok = await openModal({
    title: '确认续费',
    message: `续费 ${node?.name || '当前服务'} ${months} 个月将扣除 ${money(price)} ${state.db.settings.currency}。`,
    confirmText: '确认续费',
    cancelText: '取消'
  });
  if (!ok) return;
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

bootstrap();
