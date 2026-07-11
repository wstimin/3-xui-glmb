<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { CreditCard, Network, WalletCards } from 'lucide-vue-next';
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
  <div class="page-heading home-heading">
    <div>
      <h1 class="page-title">首页</h1>
      <p class="page-subtitle">{{ dashboard?.customer.name || '用户中心' }}</p>
    </div>
  </div>
  <div v-if="error" class="panel error-text">{{ error }}</div>
  <div v-else class="metric-grid" :class="{ loading }">
    <div class="metric account-metric"><span>账户余额</span><strong>{{ dashboard?.customer.balance ?? '--' }}</strong></div>
    <div class="metric"><span>可用节点</span><strong>{{ dashboard?.nodes.length ?? '--' }}</strong></div>
    <div class="metric"><span>最近到期</span><strong>{{ nearestExpire }}</strong></div>
  </div>

  <div class="quick-link-grid">
    <RouterLink to="/nodes" class="quick-link-card"><Network :size="20" /><strong>我的节点</strong><span>节点复制、二维码、余额续费</span></RouterLink>
    <RouterLink to="/finance" class="quick-link-card"><WalletCards :size="20" /><strong>余额充值</strong><span>支付宝、微信、USDT</span></RouterLink>
    <RouterLink to="/finance" class="quick-link-card"><CreditCard :size="20" /><strong>卡密兑换</strong><span>购买卡密后在财务页兑换</span></RouterLink>
  </div>
</template>
