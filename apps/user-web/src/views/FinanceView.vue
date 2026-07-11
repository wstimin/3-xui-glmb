<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import QRCode from 'qrcode';
import { Banknote } from 'lucide-vue-next';
import { api } from '../api';
import alipayIcon from '../assets/payments/alipay.webp';
import paypalIcon from '../assets/payments/paypal.webp';
import usdtIcon from '../assets/payments/usdt.webp';
import wechatIcon from '../assets/payments/wechat.jpg';

type PaymentProvider = 'alipay' | 'wechat' | 'epay' | 'bepusdt';
type PaymentChannel = { id: string; provider: PaymentProvider; name: string; type?: string };
type PaymentMethod = {
  provider: PaymentProvider;
  label: string;
  channel?: PaymentChannel;
  image?: string;
  icon?: typeof Banknote;
};
type RechargeOrder = { order: { tradeNo: string; amount: string }; payUrl?: string | null; qrCode?: string | null };
type PublicSettings = { cardPurchaseUrl?: string };

const code = ref('');
const loading = ref(false);
const redeeming = ref(false);
const recharging = ref(false);
const message = ref('');
const error = ref('');
const channels = ref<PaymentChannel[]>([]);
const publicSettings = reactive({ cardPurchaseUrl: '' });
const rechargeForm = reactive({ amount: 10, channelId: '', provider: 'alipay' as PaymentProvider });
const lastOrder = ref<RechargeOrder | null>(null);
const qrImage = ref('');

const selectedChannel = computed(() => channels.value.find((item) => item.id === rechargeForm.channelId));
const paymentMethods = computed<PaymentMethod[]>(() => ([
  { provider: 'alipay' as const, label: '支付宝', image: alipayIcon, channel: channelForProvider('alipay') },
  { provider: 'wechat' as const, label: '微信支付', image: wechatIcon, channel: channelForProvider('wechat') },
  epayMethod(),
  { provider: 'bepusdt' as const, label: 'BEpusdt', image: usdtIcon, channel: channelForProvider('bepusdt') }
]));

async function loadFinanceData() {
  loading.value = true;
  error.value = '';
  try {
    const [channelResult, settingsResult] = await Promise.all([
      api<PaymentChannel[]>('/api/public/payment-channels'),
      api<{ settings: PublicSettings }>('/api/public/settings').catch((): { settings: PublicSettings } => ({ settings: {} }))
    ]);
    channels.value = channelResult;
    publicSettings.cardPurchaseUrl = settingsResult.settings.cardPurchaseUrl || '';
    if (!rechargeForm.channelId && channels.value[0]) {
      rechargeForm.channelId = channels.value[0].id;
      rechargeForm.provider = channels.value[0].provider;
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载财务数据失败';
  } finally {
    loading.value = false;
  }
}

function channelForProvider(provider: PaymentProvider) {
  return channels.value.find((item) => item.provider === provider);
}

function epayMethod(): PaymentMethod {
  const channel = channelForProvider('epay');
  const type = channel?.type || '';
  if (type === 'paypal') return { provider: 'epay' as const, label: '易支付 / PayPal', image: paypalIcon, channel };
  return { provider: 'epay' as const, label: '易支付', icon: Banknote, channel };
}

function selectPaymentMethod(channel?: PaymentChannel) {
  if (!channel) return;
  rechargeForm.channelId = channel.id;
  rechargeForm.provider = channel.provider;
}

async function createRechargeOrder() {
  const channel = selectedChannel.value;
  if (!channel) return;
  recharging.value = true;
  message.value = '';
  error.value = '';
  lastOrder.value = null;
  qrImage.value = '';
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
    qrImage.value = result.qrCode ? await QRCode.toDataURL(result.qrCode, { width: 220, margin: 1 }) : '';
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

function openPurchaseUrl() {
  if (!publicSettings.cardPurchaseUrl) return;
  window.open(publicSettings.cardPurchaseUrl, '_blank', 'noopener,noreferrer');
}

function providerLabel(provider: PaymentProvider) {
  const labels: Record<PaymentProvider, string> = {
    alipay: '支付宝',
    wechat: '微信支付',
    epay: '易支付',
    bepusdt: 'BEpusdt'
  };
  return labels[provider];
}

onMounted(loadFinanceData);
</script>

<template>
  <h1 class="page-title">财务</h1>
  <p v-if="message" class="panel success-text">{{ message }}</p>
  <p v-if="error" class="panel error-text">{{ error }}</p>

  <div class="finance-grid">
    <section class="panel finance-form">
      <h2>余额充值</h2>
      <div class="payment-method-grid">
        <button
          v-for="method in paymentMethods"
          :key="method.provider"
          type="button"
          class="payment-method-button"
          :class="{ active: method.channel?.id === rechargeForm.channelId }"
          :disabled="loading || !method.channel"
          @click="selectPaymentMethod(method.channel)"
        >
          <img v-if="method.image" :src="method.image" :alt="method.label" />
          <component :is="method.icon" v-else :size="18" />
          <span>{{ method.label }}</span>
          <small>{{ method.channel ? '已启用' : '未启用' }}</small>
        </button>
      </div>
      <form @submit.prevent="createRechargeOrder">
        <input v-model.number="rechargeForm.amount" type="number" min="0.01" step="0.01" placeholder="充值金额" />
        <button :disabled="recharging || !selectedChannel || rechargeForm.amount <= 0">{{ recharging ? '创建中' : '去支付' }}</button>
      </form>
      <div v-if="selectedChannel" class="empty-hint">当前通道：{{ selectedChannel.name }} / {{ providerLabel(selectedChannel.provider) }}</div>
      <div v-if="!loading && !channels.length" class="empty-hint">管理员未启用在线支付方式</div>
      <div v-if="lastOrder?.qrCode" class="qr-box">
        <img v-if="qrImage" :src="qrImage" alt="支付二维码" />
        <span>{{ lastOrder.qrCode }}</span>
      </div>
    </section>

    <section class="panel finance-form">
      <div class="finance-card-title">
        <h2>卡密兑换</h2>
        <button v-if="publicSettings.cardPurchaseUrl" type="button" class="secondary-button" @click="openPurchaseUrl">购买卡密</button>
      </div>
      <form @submit.prevent="redeemCard">
        <input v-model="code" placeholder="输入卡密" />
        <button :disabled="redeeming || !code.trim()">{{ redeeming ? '兑换中' : '兑换' }}</button>
      </form>
    </section>
  </div>
</template>
