<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';

type PaymentResult = { tradeNo: string; status: string; amount: string; paidAt?: string | null; payUrl?: string | null; qrCode?: string | null };

const route = useRoute();
const loading = ref(false);
const error = ref('');
const result = ref<PaymentResult | null>(null);
const tradeNo = computed(() => String(route.query.trade_no || route.query.out_trade_no || ''));

async function loadResult() {
  if (!tradeNo.value) {
    error.value = '缺少充值订单号';
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    result.value = await api<PaymentResult>(`/api/payments/result?trade_no=${encodeURIComponent(tradeNo.value)}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : '查询支付结果失败';
  } finally {
    loading.value = false;
  }
}

function statusText(status?: string) {
  if (status === 'paid') return '支付成功，余额已到账';
  if (status === 'pending') return '订单待支付';
  if (status === 'failed') return '支付失败';
  if (status === 'closed') return '订单已关闭';
  return status || '-';
}

onMounted(loadResult);
</script>

<template>
  <h1 class="page-title">支付结果</h1>
  <div v-if="error" class="panel error-text">{{ error }}</div>
  <div v-else class="panel result-panel" :class="{ loading }">
    <h2>{{ statusText(result?.status) }}</h2>
    <div class="profile-row"><span>订单号</span><strong>{{ result?.tradeNo || tradeNo || '-' }}</strong></div>
    <div class="profile-row"><span>金额</span><strong>{{ result?.amount || '-' }}</strong></div>
    <div class="profile-row"><span>到账时间</span><strong>{{ result?.paidAt || '-' }}</strong></div>
    <a v-if="result?.status === 'pending' && result.payUrl" class="pay-link" :href="result.payUrl">继续支付</a>
  </div>
</template>
