<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';

type UserDashboard = {
  customer: { name: string; balance: string };
  nodes: Array<{ expireAt?: string }>;
};

const loading = ref(false);
const error = ref('');
const dashboard = ref<UserDashboard | null>(null);

const nearestExpire = computed(() => {
  const expires = dashboard.value?.nodes.map((node) => node.expireAt).filter(Boolean).sort() || [];
  return formatDate(expires[0]);
});

async function loadDashboard() {
  loading.value = true;
  error.value = '';
  try {
    dashboard.value = await api<UserDashboard>('/api/user/me');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '--';
}

onMounted(loadDashboard);
</script>

<template>
  <h1 class="page-title">首页</h1>
  <div v-if="error" class="panel">{{ error }}</div>
  <div v-else class="metric-grid" :class="{ loading }">
    <div class="metric"><span>账户余额</span><strong>{{ dashboard?.customer.balance ?? '--' }}</strong></div>
    <div class="metric"><span>可用节点</span><strong>{{ dashboard?.nodes.length ?? '--' }}</strong></div>
    <div class="metric"><span>最近到期</span><strong>{{ nearestExpire }}</strong></div>
  </div>
</template>
