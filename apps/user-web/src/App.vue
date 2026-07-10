<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { CircleUserRound, Home, LogOut, Network, ReceiptText } from 'lucide-vue-next';
import { api } from './api';

type SessionUser = { role: string; username: string };

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
const loginForm = reactive({ username: '', password: '' });

async function loadMe() {
  checking.value = true;
  try {
    const session = await api<SessionUser>('/api/auth/me');
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
      await api('/api/logout', { method: 'POST' }).catch(() => undefined);
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
  await api('/api/logout', { method: 'POST' }).catch(() => undefined);
  user.value = null;
}

onMounted(loadMe);
</script>

<template>
  <div v-if="checking" class="boot-screen">正在检查登录状态</div>

  <div v-else-if="!user" class="login-screen">
    <form class="login-panel" @submit.prevent="login">
      <h1>十夜用户中心</h1>
      <p>用户登录</p>
      <div v-if="loginError" class="error-text">{{ loginError }}</div>
      <input v-model="loginForm.username" placeholder="账号" autocomplete="username" />
      <input v-model="loginForm.password" type="password" placeholder="密码" autocomplete="current-password" />
      <button :disabled="loggingIn || !loginForm.username || !loginForm.password">{{ loggingIn ? '登录中' : '登录' }}</button>
    </form>
  </div>

  <div v-else class="app-shell">
    <header class="header">
      <strong>十夜用户中心</strong>
      <nav>
        <router-link v-for="item in nav" :key="item.to" :to="item.to" class="nav-link">
          <component :is="item.icon" :size="18" />
          <span>{{ item.label }}</span>
        </router-link>
        <button class="logout-button" @click="logout"><LogOut :size="16" />退出</button>
      </nav>
    </header>
    <main class="main">
      <router-view />
    </main>
  </div>
</template>
