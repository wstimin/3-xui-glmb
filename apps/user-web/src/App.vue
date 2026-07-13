<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import { ArrowRight, CircleUserRound, Home, LockKeyhole, LogOut, Network, ReceiptText, UserRound } from 'lucide-vue-next';
import { api } from './api';
import { onNotify, type NotifyPayload } from './notify';

type SessionUser = { role: string; username: string };
type Branding = { brandName: string; logoDataUrl: string };

const fallbackBrandName = '十夜用户中心';
const nav = [
  { to: '/', label: '首页', icon: Home },
  { to: '/nodes', label: '节点', icon: Network },
  { to: '/finance', label: '财务', icon: ReceiptText },
  { to: '/profile', label: '资料', icon: CircleUserRound }
];

const checking = ref(true);
const loggingIn = ref(false);
const loginError = ref('');
const user = ref<SessionUser | null>(null);
const branding = reactive<Branding>({ brandName: fallbackBrandName, logoDataUrl: '' });
const loginForm = reactive({ username: '', password: '' });
const notices = ref<Array<NotifyPayload & { id: number }>>([]);
let noticeId = 0;
let stopNotify: (() => void) | undefined;

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
    const session = await api<SessionUser>('/api/auth/me?entry=user');
    user.value = session.role === 'user' ? session : null;
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
    const session = await api<SessionUser>('/api/login', { method: 'POST', body: { ...loginForm, entry: 'user' } });
    if (session.role !== 'user') {
      await api('/api/logout', { method: 'POST', body: { entry: 'user' } }).catch(() => undefined);
      throw new Error('当前账号不是用户账号');
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
  await api('/api/logout', { method: 'POST', body: { entry: 'user' } }).catch(() => undefined);
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

function pushNotice(payload: NotifyPayload) {
  const id = ++noticeId;
  notices.value = [...notices.value, { id, ...payload }].slice(-3);
  window.setTimeout(() => closeNotice(id), payload.type === 'error' ? 5200 : 3600);
}

function closeNotice(id: number) {
  notices.value = notices.value.filter((notice) => notice.id !== id);
}

onMounted(async () => {
  stopNotify = onNotify(pushNotice);
  await loadBranding();
  await loadMe();
});

onUnmounted(() => {
  stopNotify?.();
});
</script>

<template>
  <div class="toast-stack" aria-live="polite">
    <div v-for="notice in notices" :key="notice.id" class="toast-card" :class="notice.type">
      <div>
        <strong>{{ notice.title }}</strong>
        <p>{{ notice.message }}</p>
      </div>
      <button type="button" @click="closeNotice(notice.id)">关闭</button>
    </div>
  </div>

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
          <p>用户登录</p>
        </div>
      </div>
      <div v-if="loginError" class="error-text">{{ loginError }}</div>
      <label class="login-field">
        <UserRound :size="17" />
        <input v-model="loginForm.username" name="shiye-user-account" placeholder="账号" autocomplete="off" />
      </label>
      <label class="login-field">
        <LockKeyhole :size="17" />
        <input v-model="loginForm.password" name="shiye-user-passcode" type="password" placeholder="密码" autocomplete="new-password" />
      </label>
      <button class="login-submit" :disabled="loggingIn || !loginForm.username || !loginForm.password">
        <span>{{ loggingIn ? '登录中' : '登录' }}</span>
        <ArrowRight :size="17" />
      </button>
    </form>
  </div>

  <div v-else class="app-shell">
    <aside class="user-sidebar">
      <div class="header-brand">
        <img v-if="branding.logoDataUrl" :src="branding.logoDataUrl" alt="Logo" />
        <span v-else class="brand-mark">{{ branding.brandName.slice(0, 1) }}</span>
        <strong>{{ branding.brandName }}</strong>
      </div>
      <nav class="user-nav">
        <router-link v-for="item in nav" :key="item.to" :to="item.to" class="nav-link">
          <component :is="item.icon" :size="18" />
          <span>{{ item.label }}</span>
        </router-link>
      </nav>
      <div class="user-sidebar-footer">
        <span>当前账号</span>
        <strong>{{ user.username }}</strong>
        <button class="logout-button" @click="logout"><LogOut :size="16" />退出</button>
      </div>
    </aside>
    <main class="main">
      <router-view />
    </main>
  </div>
</template>
