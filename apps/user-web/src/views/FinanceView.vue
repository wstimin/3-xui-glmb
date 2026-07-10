<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api';

type PaymentChannel = { id: string; provider: 'epay' | 'bepusdt'; name: string };
type RechargeOrder = { order: { tradeNo: string; amount: string }; payUrl?: string | null; qrCode?: string | null };

const code = ref('');
const loading = ref(false);
const redeeming = ref(false);
const recharging = ref(false);
const message = ref('');
const error = ref('');
const channels = ref<PaymentChannel[]>([]);
const rechargeForm = reactive({ amount: 10, channelId: '', provider: 'epay' as 'epay' | 'bepusdt' });
const lastOrder = ref<RechargeOrder | null>(null);

const selectedChannel = computed(() => channels.value.find((item) => item.id === rechargeForm.channelId));

async function loadChannels() {
  loading.value = true;
  error.value = '';
  try {
    channels.value = await api<PaymentChannel[]>('/api/public/payment-channels');
    if (!rechargeForm.channelId && channels.value[0]) {
      rechargeForm.channelId = channels.value[0].id;
      rechargeForm.provider = channels.value[0].provider;
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载支付方式失败';
  } finally {
    loading.value = false;
  }
}

async function createRechargeOrder() {
  const channel = selectedChannel.value;
  if (!channel) return;
  recharging.value = true;
  message.value = '';
  error.value = '';
  lastOrder.value = null;
  try {
    const result = await api<RechargeOrder>('/api/user/recharge-orders', {
      method: 'POST',
      body: {
        amount: rechargeForm.amount,
        channelId: channel.id,
        provider: channel.provider
      }
    });
    lastOrder.value = result;
    message.value = `充值订单已创建：${result.order.tradeNo}`;
    if (result.payUrl) window.location.href = result.payUrl;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '创建充值订单失败';
  } finally {
    recharging.value = false;
  }
}

async function redeemCard() {
  redeeming.value = true;
  message.value = '';
  error.value = '';
  try {
    const result = await api<{ amount: string }>('/api/user/cards/redeem', { method: 'POST', body: { code: code.value } });
    message.value = `兑换成功，余额增加 ${result.amount}`;
    code.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : '兑换失败';
  } finally {
    redeeming.value = false;
  }
}

function onChannelChange() {
  const channel = selectedChannel.value;
  if (channel) rechargeForm.provider = channel.provider;
}

onMounted(loadChannels);
</script>

<template>
  <h1 class="page-title">财务</h1>
  <p v-if="message" class="panel success-text">{{ message }}</p>
  <p v-if="error" class="panel error-text">{{ error }}</p>

  <div class="finance-grid">
    <section class="panel finance-form">
      <h2>余额充值</h2>
      <form @submit.prevent="createRechargeOrder">
        <select v-model="rechargeForm.channelId" :disabled="loading || !channels.length" @change="onChannelChange">
          <option value="" disabled>{{ loading ? '加载支付方式中' : '选择支付方式' }}</option>
          <option v-for="channel in channels" :key="channel.id" :value="channel.id">{{ channel.name }}</option>
        </select>
        <input v-model.number="rechargeForm.amount" type="number" min="0.01" step="0.01" placeholder="充值金额" />
        <button :disabled="recharging || !selectedChannel || rechargeForm.amount <= 0">{{ recharging ? '创建中' : '去支付' }}</button>
      </form>
      <div v-if="!loading && !channels.length" class="empty-hint">管理员未启用在线支付方式</div>
      <div v-if="lastOrder?.qrCode" class="qr-box">{{ lastOrder.qrCode }}</div>
    </section>

    <section class="panel finance-form">
      <h2>卡密兑换</h2>
      <form @submit.prevent="redeemCard">
        <input v-model="code" placeholder="输入卡密" />
        <button :disabled="redeeming || !code.trim()">{{ redeeming ? '兑换中' : '兑换' }}</button>
      </form>
    </section>
  </div>
</template>
