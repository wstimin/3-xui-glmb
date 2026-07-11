<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import QRCode from 'qrcode';
import { Banknote, ShoppingBag, TicketCheck } from 'lucide-vue-next';
import { api } from '../api';
import { notifyError, notifySuccess } from '../notify';
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
type RechargeOrder = { order: { tradeNo: string; amount: string; expiresAt?: string | null }; payUrl?: string | null; qrCode?: string | null };
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
const quickAmounts = [10, 30, 50, 100];

const selectedChannel = computed(() => channels.value.find((item) => item.id === rechargeForm.channelId));
const paymentMethods = computed<PaymentMethod[]>(() => ([
  paymentMethod('alipay', '支付宝', alipayIcon),
  paymentMethod('wechat', '微信支付', wechatIcon),
  epayMethod(),
  paymentMethod('bepusdt', 'BEpusdt', usdtIcon)
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
    notifyError(error.value);
  } finally {
    loading.value = false;
  }
}

function channelForProvider(provider: PaymentProvider) {
  return channels.value.find((item) => item.provider === provider);
}

function paymentMethod(provider: PaymentProvider, fallbackLabel: string, image: string): PaymentMethod {
  const channel = channelForProvider(provider);
  return { provider, label: channel?.name || fallbackLabel, image, channel };
}

function epayMethod(): PaymentMethod {
  const channel = channelForProvider('epay');
  const type = channel?.type || '';
  if (type === 'paypal') return { provider: 'epay' as const, label: channel?.name || '支付通道', image: paypalIcon, channel };
  return { provider: 'epay' as const, label: channel?.name || '支付通道', icon: Banknote, channel };
}

function selectPaymentMethod(channel?: PaymentChannel) {
  if (!channel) return;
  rechargeForm.channelId = channel.id;
  rechargeForm.provider = channel.provider;
}

function setAmount(amount: number) {
  rechargeForm.amount = amount;
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
    message.value = `充值订单已创建：${result.order.tradeNo}，请在 30 分钟内完成支付`;
    notifySuccess(message.value, '订单已创建');
    if (result.payUrl) window.location.href = result.payUrl;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '创建充值订单失败';
    notifyError(error.value);
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
    notifySuccess(message.value);
    code.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : '兑换失败';
    notifyError(error.value);
  } finally {
    redeeming.value = false;
  }
}

function openPurchaseUrl() {
  if (!publicSettings.cardPurchaseUrl) return;
  window.open(publicSettings.cardPurchaseUrl, '_blank', 'noopener,noreferrer');
}

onMounted(loadFinanceData);
</script>

<template>
  <div class="page-heading">
    <div>
      <h1 class="page-title">财务</h1>
      <p class="page-subtitle">余额充值与卡密兑换</p>
    </div>
  </div>
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
      <div class="amount-shortcuts">
        <button v-for="amount in quickAmounts" :key="amount" type="button" :class="{ active: rechargeForm.amount === amount }" @click="setAmount(amount)">{{ amount }} 元</button>
      </div>
      <form @submit.prevent="createRechargeOrder">
        <input v-model.number="rechargeForm.amount" type="number" min="0.01" step="0.01" placeholder="充值金额" />
        <button :disabled="recharging || !selectedChannel || rechargeForm.amount <= 0">{{ recharging ? '创建中' : '去支付' }}</button>
      </form>
      <div v-if="selectedChannel" class="empty-hint">当前通道：{{ selectedChannel.name }}</div>
      <div v-if="!loading && !channels.length" class="empty-hint">管理员未启用在线支付方式</div>
      <div v-if="lastOrder?.qrCode" class="qr-box">
        <img v-if="qrImage" :src="qrImage" alt="支付二维码" />
        <small v-if="lastOrder.order.expiresAt">有效至：{{ new Date(lastOrder.order.expiresAt).toLocaleString('zh-CN', { hour12: false }) }}</small>
        <span>{{ lastOrder.qrCode }}</span>
      </div>
    </section>

    <section class="panel finance-form card-redeem-panel">
      <div class="card-redeem-head">
        <div class="card-redeem-title">
          <span class="card-redeem-icon"><TicketCheck :size="20" /></span>
          <div>
            <h2>卡密兑换</h2>
            <p>输入管理员发放的卡密后，金额会直接加入账户余额。</p>
          </div>
        </div>
        <button v-if="publicSettings.cardPurchaseUrl" type="button" class="secondary-button card-buy-button" @click="openPurchaseUrl">
          <ShoppingBag :size="16" />购买卡密
        </button>
      </div>
      <form class="card-redeem-form" @submit.prevent="redeemCard">
        <input v-model="code" placeholder="输入卡密" autocomplete="one-time-code" />
        <button :disabled="redeeming || !code.trim()">{{ redeeming ? '兑换中' : '立即兑换' }}</button>
      </form>
      <div class="card-redeem-tip">请完整粘贴卡密，兑换成功后可在首页查看余额变化。</div>
    </section>
  </div>
</template>
