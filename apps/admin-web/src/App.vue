<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import { ArrowRight, ClipboardList, CreditCard, HeartPulse, LayoutDashboard, LockKeyhole, LogOut, Network, ReceiptText, Router, Settings, ShieldCheck, UserRound, Users, WalletCards } from 'lucide-vue-next';
import { api } from './api';

type SessionUser = { role: string; username: string };
type Branding = { brandName: string; logoDataUrl: string };

const fallbackBrandName = '十夜管理后台';
const brandingUpdatedEvent = 'shiye:branding-updated';
const navSections = [
  { label: '总览看板', items: [{ to: '/', label: '数据概览', icon: LayoutDashboard }] },
  {
    label: '业务管理',
    items: [
      { to: '/customers', label: '用户管理', icon: Users },
      { to: '/nodes', label: '路由节点', icon: Router }
    ]
  },
  {
    label: '网络配置',
    items: [
      { to: '/xui-servers', label: '面板连接', icon: Network },
      { to: '/socks-nodes', label: '出站节点', icon: ShieldCheck },
      { to: '/sync-logs', label: '同步日志', icon: ClipboardList },
      { to: '/diagnostics', label: '健康诊断', icon: HeartPulse }
    ]
  },
  {
    label: '财务管理',
    items: [
      { to: '/finance', label: '财务记录', icon: WalletCards },
      { to: '/cards', label: '卡密管理', icon: CreditCard },
      { to: '/payments', label: '支付设置', icon: ReceiptText }
    ]
  },
  { label: '系统配置', items: [{ to: '/settings', label: '系统设置', icon: Settings }] }
];

const checking = ref(true);
const loggingIn = ref(false);
const loginError = ref('');
const user = ref<SessionUser | null>(null);
const branding = reactive<Branding>({ brandName: fallbackBrandName, logoDataUrl: '' });
const loginForm = reactive({ username: '', password: '' });

async function loadBranding() {
  try {
    const payload = await api<{ settings: Branding }>('/api/public/branding');
    branding.brandName = payload.settings.brandName || fallbackBrandName;
    branding.logoDataUrl = payload.settings.logoDataUrl || '';
  } catch {
    branding.brandName = fallbackBrandName;
    branding.logoDataUrl = '';
  } finally {
    applyBrowserBranding(branding);
  }
}

async function loadMe() {
  checking.value = true;
  try {
    const session = await api<SessionUser>('/api/auth/me?entry=admin');
    user.value = session.role === 'admin' ? session : null;
  } catch {
    user.value = null;
  } finally {
    checking.value = false;
  }
}

async function login() {
  loggingIn.value = true;
  loginError.value = '';
  try {
    const session = await api<SessionUser>('/api/login', { method: 'POST', body: { ...loginForm, entry: 'admin' } });
    if (session.role !== 'admin') {
      await api('/api/logout', { method: 'POST', body: { entry: 'admin' } }).catch(() => undefined);
      throw new Error('当前账号不是管理员');
    }
    user.value = session;
    Object.assign(loginForm, { username: '', password: '' });
  } catch (err) {
    loginError.value = err instanceof Error ? err.message : '登录失败';
  } finally {
    loggingIn.value = false;
  }
}

async function logout() {
  await api('/api/logout', { method: 'POST', body: { entry: 'admin' } }).catch(() => undefined);
  user.value = null;
}

function applyBrowserBranding(settings: Branding) {
  document.title = settings.brandName || fallbackBrandName;
  const icon = ensureFaviconElement();
  icon.type = settings.logoDataUrl ? '' : 'image/svg+xml';
  icon.href = settings.logoDataUrl || createTextFavicon(settings.brandName || fallbackBrandName);
}

function ensureFaviconElement() {
  const existing = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (existing) return existing;
  const link = document.createElement('link');
  link.rel = 'icon';
  document.head.appendChild(link);
  return link;
}

function createTextFavicon(name: string) {
  const initial = Array.from(name.trim())[0] || '十';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0f172a"/><text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-size="32" font-family="Arial, sans-serif" font-weight="700" fill="#ffffff">${escapeSvg(initial)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function escapeSvg(value: string) {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] || char);
}

function handleBrandingUpdated(event: Event) {
  const next = (event as CustomEvent<Partial<Branding>>).detail || {};
  branding.brandName = next.brandName || fallbackBrandName;
  branding.logoDataUrl = next.logoDataUrl || '';
  applyBrowserBranding(branding);
}

onMounted(async () => {
  window.addEventListener(brandingUpdatedEvent, handleBrandingUpdated);
  await loadBranding();
  await loadMe();
});

onUnmounted(() => {
  window.removeEventListener(brandingUpdatedEvent, handleBrandingUpdated);
});
</script>

<template>
  <div v-if="checking" class="boot-screen">正在检查登录状态</div>

  <div v-else-if="!user" class="login-screen">
    <form class="login-panel refined-login" autocomplete="off" @submit.prevent="login">
      <div class="login-brand-row">
        <div class="login-brand">
          <img v-if="branding.logoDataUrl" :src="branding.logoDataUrl" alt="Logo" />
          <span v-else>{{ branding.brandName.slice(0, 1) }}</span>
        </div>
        <div>
          <h1>{{ branding.brandName }}</h1>
          <p>管理员登录</p>
        </div>
      </div>
      <el-alert v-if="loginError" :title="loginError" type="error" show-icon :closable="false" />
      <label class="login-field">
        <UserRound :size="17" />
        <input v-model="loginForm.username" name="shiye-admin-account" placeholder="账号" autocomplete="off" />
      </label>
      <label class="login-field">
        <LockKeyhole :size="17" />
        <input v-model="loginForm.password" name="shiye-admin-passcode" type="password" placeholder="密码" autocomplete="new-password" />
      </label>
      <button class="login-submit" :disabled="loggingIn || !loginForm.username || !loginForm.password">
        <span>{{ loggingIn ? '登录中' : '登录' }}</span>
        <ArrowRight :size="17" />
      </button>
    </form>
  </div>

  <el-container v-else class="shell">
    <el-aside width="220px" class="sidebar">
      <div class="brand">
        <img v-if="branding.logoDataUrl" :src="branding.logoDataUrl" alt="Logo" />
        <span v-else class="brand-mark">{{ branding.brandName.slice(0, 1) }}</span>
        <strong>{{ branding.brandName }}</strong>
      </div>
      <nav class="sidebar-scroll">
        <section v-for="section in navSections" :key="section.label" class="nav-section">
          <div class="nav-section-title">{{ section.label }}</div>
          <router-link v-for="item in section.items" :key="item.to" :to="item.to" class="nav-item">
            <component :is="item.icon" :size="18" />
            <span>{{ item.label }}</span>
          </router-link>
        </section>
      </nav>
      <div class="sidebar-footer">
        <div class="sidebar-user">
          <span>当前账号</span>
          <strong>{{ user.username }}</strong>
        </div>
        <el-button text class="logout-button" @click="logout"><LogOut :size="16" />退出登录</el-button>
      </div>
    </el-aside>
    <el-container>
      <el-header class="topbar">
        <span>管理后台</span>
        <el-tag size="small" type="success">{{ user.username }}</el-tag>
      </el-header>
      <el-main>
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>
