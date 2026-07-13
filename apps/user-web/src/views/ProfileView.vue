<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { notifyError, notifySuccess } from '../notify';

type SessionUser = { role: string; username: string; customerId?: string };

const loading = ref(false);
const changing = ref(false);
const error = ref('');
const message = ref('');
const user = ref<SessionUser | null>(null);
const form = reactive({ currentPassword: '', newPassword: '' });

async function loadProfile() {
  loading.value = true;
  error.value = '';
  try {
    user.value = await api<SessionUser>('/api/auth/me?entry=user');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败';
    notifyError(error.value);
  } finally {
    loading.value = false;
  }
}

async function changePassword() {
  changing.value = true;
  error.value = '';
  message.value = '';
  try {
    await api('/api/change-password', { method: 'POST', body: form });
    message.value = '密码已修改，请重新登录';
    notifySuccess(message.value);
    Object.assign(form, { currentPassword: '', newPassword: '' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : '修改失败';
    notifyError(error.value);
  } finally {
    changing.value = false;
  }
}

onMounted(loadProfile);
</script>

<template>
  <h1 class="page-title">资料</h1>
  <div v-if="message" class="panel success-text">{{ message }}</div>
  <div v-if="error" class="panel error-text">{{ error }}</div>

  <div class="panel profile-panel" :class="{ loading }">
    <h2>账号信息</h2>
    <div class="profile-row"><span>登录账号</span><strong>{{ user?.username || '--' }}</strong></div>
    <div class="profile-row"><span>账号类型</span><strong>{{ user?.role === 'user' ? '用户' : '--' }}</strong></div>
  </div>

  <div class="panel profile-panel">
    <h2>修改密码</h2>
    <form class="password-form" autocomplete="off" @submit.prevent="changePassword">
      <input v-model="form.currentPassword" name="shiye-user-current-passcode" type="password" placeholder="当前密码" autocomplete="new-password" />
      <input v-model="form.newPassword" name="shiye-user-next-passcode" type="password" placeholder="新密码，至少 8 位" autocomplete="new-password" />
      <button :disabled="changing || !form.currentPassword || form.newPassword.length < 8">{{ changing ? '提交中' : '修改密码' }}</button>
    </form>
  </div>
</template>
