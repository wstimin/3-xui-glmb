<script setup lang="ts">
import { ref } from 'vue';
import { api } from '../api';

const code = ref('');
const loading = ref(false);
const message = ref('');
const error = ref('');

async function redeemCard() {
  loading.value = true;
  message.value = '';
  error.value = '';
  try {
    const result = await api<{ amount: string }>('/api/user/cards/redeem', { method: 'POST', body: { code: code.value } });
    message.value = `兑换成功，余额增加 ${result.amount}`;
    code.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : '兑换失败';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <h1 class="page-title">财务</h1>
  <div class="panel finance-form">
    <h2>卡密兑换</h2>
    <form @submit.prevent="redeemCard">
      <input v-model="code" placeholder="输入卡密" />
      <button :disabled="loading || !code.trim()">{{ loading ? '兑换中' : '兑换' }}</button>
    </form>
    <p v-if="message" class="success-text">{{ message }}</p>
    <p v-if="error" class="error-text">{{ error }}</p>
  </div>
</template>
