<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { CreditCard, LayoutDashboard, LogOut, Router, Settings, Users, WalletCards } from 'lucide-vue-next';
import { api } from './api';

type SessionUser = { role: string; username: string };

const nav = [
  { to: '/', label: '概览', icon: LayoutDashboard },
  { to: '/customers', label: '用户', icon: Users },
  { to: '/nodes', label: '节点', icon: Router },
  { to: '/finance', label: '财务', icon: WalletCards },
  { to: '/cards', label: '卡密', icon: CreditCard },
  { to: '/settings', label: '设置', icon: Settings }
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
      await api('/api/logout', { method: 'POST' }).catch(() => undefined);
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
  await api('/api/logout', { method: 'POST' }).catch(() => undefined);
  user.value = null;
}

onMounted(loadMe);
</script>

<template>
  <div v-if="checking" class="boot-screen">正在检查登录状态</div>

  <div v-else-if="!user" class="login-screen">
    <form class="login-panel" @submit.prevent="login">
      <h1>十夜管理后台</h1>
      <p>管理员登录</p>
      <el-alert v-if="loginError" :title="loginError" type="error" show-icon :closable="false" />
      <el-input v-model="loginForm.username" placeholder="账号" autocomplete="username" />
      <el-input v-model="loginForm.password" type="password" placeholder="密码" autocomplete="current-password" show-password />
      <el-button type="primary" native-type="submit" :loading="loggingIn" :disabled="!loginForm.username || !loginForm.password">登录</el-button>
    </form>
  </div>

  <el-container v-else class="shell">
    <el-aside width="220px" class="sidebar">
      <div class="brand">十夜管理后台</div>
      <router-link v-for="item in nav" :key="item.to" :to="item.to" class="nav-item">
        <component :is="item.icon" :size="18" />
        <span>{{ item.label }}</span>
      </router-link>
    </el-aside>
    <el-container>
      <el-header class="topbar">
        <span>{{ user.username }}</span>
        <el-button text @click="logout"><LogOut :size="16" />退出</el-button>
      </el-header>
      <el-main>
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>
