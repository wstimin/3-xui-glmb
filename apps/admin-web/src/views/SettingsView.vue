<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Upload, X } from 'lucide-vue-next';
import { api } from '../api';

type AdminSettings = { brand: { brandName: string; logoDataUrl: string }; business: { cardPurchaseUrl: string } };
type PaymentProvider = 'alipay' | 'wechat' | 'epay' | 'bepusdt';
type PaymentChannel = {
  id: string;
  provider: PaymentProvider;
  name: string;
  enabled: boolean;
  sortOrder: number;
  config: { url?: string; pid?: string; appId?: string; productName?: string; mchId?: string; type?: string; notifyUrl?: string; returnUrl?: string };
  hasKey?: boolean;
  hasToken?: boolean;
  hasPrivateKey?: boolean;
  hasPublicKey?: boolean;
  hasApiKey?: boolean;
  notifyUrl?: string;
};

const providerOptions = [
  { label: '支付宝官方', value: 'alipay' },
  { label: '微信支付 Native', value: 'wechat' },
  { label: '易支付', value: 'epay' },
  { label: 'BEpusdt', value: 'bepusdt' }
] as const;

const alipayModeOptions = [
  { label: '当面付扫码', value: 'precreate' },
  { label: 'PC 网站支付', value: 'page' },
  { label: '手机网站支付', value: 'wap' }
] as const;

const loading = ref(false);
const savingBrand = ref(false);
const changingPassword = ref(false);
const savingChannel = ref(false);
const error = ref('');
const channels = ref<PaymentChannel[]>([]);
const editingChannelId = ref('');
const brandForm = reactive({ brandName: '十夜管理系统', logoDataUrl: '' });
const businessForm = reactive({ cardPurchaseUrl: '' });
const passwordForm = reactive({ currentPassword: '', newPassword: '' });
const channelForm = reactive({
  provider: 'epay' as PaymentProvider,
  name: '易支付',
  enabled: false,
  sortOrder: 0,
  url: '',
  pid: '',
  key: '',
  token: '',
  appId: '',
  privateKey: '',
  publicKey: '',
  productName: '账户余额充值',
  mchId: '',
  apiKey: '',
  type: 'alipay',
  notifyUrl: '',
  returnUrl: ''
});

const callbackOrigin = computed(() => window.location.origin.replace(/\/+$/, ''));
const callbackUrl = computed(() => `${callbackOrigin.value}/api/payments/${channelForm.provider}/notify`);
const secretLabel = computed(() => {
  if (channelForm.provider === 'bepusdt') return 'Token';
  if (channelForm.provider === 'wechat') return 'V2 API 密钥';
  return '商户密钥';
});

async function loadSettings() {
  loading.value = true;
  error.value = '';
  try {
    const [settings, paymentChannels] = await Promise.all([
      api<AdminSettings>('/api/admin/settings'),
      api<PaymentChannel[]>('/api/admin/payment-channels')
    ]);
    Object.assign(brandForm, settings.brand);
    Object.assign(businessForm, settings.business || { cardPurchaseUrl: '' });
    channels.value = paymentChannels;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

async function saveBrand() {
  savingBrand.value = true;
  error.value = '';
  try {
    await api<AdminSettings>('/api/admin/settings', { method: 'PUT', body: { brand: brandForm } });
    ElMessage.success('品牌设置已保存');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存失败';
  } finally {
    savingBrand.value = false;
  }
}

async function saveBusiness() {
  savingBrand.value = true;
  error.value = '';
  try {
    await api<AdminSettings>('/api/admin/settings', { method: 'PUT', body: { business: businessForm } });
    ElMessage.success('业务设置已保存');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存业务设置失败';
  } finally {
    savingBrand.value = false;
  }
}

async function onLogoSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    ElMessage.error('请选择图片文件');
    return;
  }
  if (file.size > 3 * 1024 * 1024) {
    ElMessage.error('Logo 图片不能超过 3MB');
    return;
  }
  try {
    brandForm.logoDataUrl = await imageToDataUrl(file, 256);
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : 'Logo 图片读取失败');
  }
}

async function changePassword() {
  changingPassword.value = true;
  error.value = '';
  try {
    await api('/api/change-password', { method: 'POST', body: passwordForm });
    ElMessage.success('密码已修改，请重新登录');
    Object.assign(passwordForm, { currentPassword: '', newPassword: '' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : '修改失败';
  } finally {
    changingPassword.value = false;
  }
}

async function saveChannel() {
  savingChannel.value = true;
  error.value = '';
  try {
    const resolvedNotifyUrl = channelForm.notifyUrl || callbackUrl.value;
    const body = {
      provider: channelForm.provider,
      name: channelForm.name,
      enabled: channelForm.enabled,
      sortOrder: channelForm.sortOrder,
      config: {
        url: channelForm.url,
        pid: channelForm.pid,
        key: channelForm.provider === 'epay' ? channelForm.key : '',
        token: channelForm.provider === 'bepusdt' ? channelForm.token : '',
        appId: ['alipay', 'wechat'].includes(channelForm.provider) ? channelForm.appId : '',
        privateKey: channelForm.provider === 'alipay' ? channelForm.privateKey : '',
        publicKey: channelForm.provider === 'alipay' ? channelForm.publicKey : '',
        productName: ['alipay', 'wechat'].includes(channelForm.provider) ? channelForm.productName : '',
        mchId: channelForm.provider === 'wechat' ? channelForm.mchId : '',
        apiKey: channelForm.provider === 'wechat' ? channelForm.apiKey : '',
        type: channelForm.type,
        notifyUrl: resolvedNotifyUrl,
        returnUrl: channelForm.returnUrl
      }
    };
    const path = editingChannelId.value ? `/api/admin/payment-channels/${editingChannelId.value}` : '/api/admin/payment-channels';
    await api(path, { method: editingChannelId.value ? 'PATCH' : 'POST', body });
    ElMessage.success(editingChannelId.value ? '支付方式已更新' : '支付方式已新增');
    resetChannelForm();
    await loadSettings();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存支付方式失败';
  } finally {
    savingChannel.value = false;
  }
}

function editChannel(channel: PaymentChannel) {
  editingChannelId.value = channel.id;
  Object.assign(channelForm, {
    provider: channel.provider,
    name: channel.name,
    enabled: channel.enabled,
    sortOrder: channel.sortOrder,
    url: channel.config.url || '',
    pid: channel.config.pid || '',
    key: '',
    token: '',
    appId: channel.config.appId || '',
    privateKey: '',
    publicKey: '',
    productName: channel.config.productName || '账户余额充值',
    mchId: channel.config.mchId || '',
    apiKey: '',
    type: channel.config.type || defaultType(channel.provider),
    notifyUrl: channel.config.notifyUrl || '',
    returnUrl: channel.config.returnUrl || ''
  });
}

async function removeChannel(channel: PaymentChannel) {
  await ElMessageBox.confirm(`确认删除支付方式“${channel.name}”？`, '删除确认', { type: 'warning' });
  await api(`/api/admin/payment-channels/${channel.id}`, { method: 'DELETE' });
  ElMessage.success('支付方式已删除');
  if (editingChannelId.value === channel.id) resetChannelForm();
  await loadSettings();
}

function resetChannelForm() {
  editingChannelId.value = '';
  Object.assign(channelForm, {
    provider: 'epay',
    name: '易支付',
    enabled: false,
    sortOrder: 0,
    url: '',
    pid: '',
    key: '',
    token: '',
    appId: '',
    privateKey: '',
    publicKey: '',
    productName: '账户余额充值',
    mchId: '',
    apiKey: '',
    type: 'alipay',
    notifyUrl: '',
    returnUrl: ''
  });
}

function onProviderChange(provider: PaymentProvider) {
  channelForm.name = providerName(provider);
  channelForm.type = defaultType(provider);
  channelForm.url = provider === 'alipay'
    ? 'https://openapi.alipay.com/gateway.do'
    : provider === 'wechat'
      ? 'https://api.mch.weixin.qq.com/pay/unifiedorder'
      : '';
}

function defaultType(provider: PaymentProvider) {
  if (provider === 'alipay') return 'precreate';
  if (provider === 'epay') return 'alipay';
  if (provider === 'bepusdt') return 'usdt.trc20';
  return '';
}

function providerName(provider: PaymentProvider) {
  return providerOptions.find((item) => item.value === provider)?.label || provider;
}

function paymentTypeLabel(provider: PaymentProvider) {
  return provider === 'alipay' ? '支付宝接口' : '支付类型';
}

function secretState(channel: PaymentChannel) {
  if (channel.provider === 'epay') return channel.hasKey ? '已配置' : '未配置';
  if (channel.provider === 'bepusdt') return channel.hasToken ? '已配置' : '未配置';
  if (channel.provider === 'alipay') return channel.hasPrivateKey && channel.hasPublicKey ? '已配置' : '未配置';
  return channel.hasApiKey ? '已配置' : '未配置';
}

function imageToDataUrl(file: File, maxSize: number) {
  return new Promise<string>((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('浏览器不支持图片处理'));
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Logo 图片读取失败'));
    };
    image.src = url;
  });
}

onMounted(loadSettings);
</script>

<template>
  <h1 class="page-title">系统设置</h1>
  <el-alert v-if="error" class="page-alert" :title="error" type="error" show-icon :closable="false" />

  <div class="settings-grid">
    <div class="panel">
      <div class="panel-toolbar"><strong>品牌设置</strong></div>
      <el-form :model="brandForm" label-width="88px" v-loading="loading">
        <el-form-item label="系统名称"><el-input v-model="brandForm.brandName" maxlength="80" /></el-form-item>
        <el-form-item label="Logo">
          <div class="logo-uploader">
            <div class="logo-preview">
              <img v-if="brandForm.logoDataUrl" :src="brandForm.logoDataUrl" alt="Logo" />
              <span v-else>{{ brandForm.brandName.slice(0, 1) }}</span>
            </div>
            <label class="file-button">
              <Upload :size="16" />
              <span>上传图片</span>
              <input type="file" accept="image/*" @change="onLogoSelected" />
            </label>
            <el-button v-if="brandForm.logoDataUrl" plain @click="brandForm.logoDataUrl = ''"><X :size="15" />清除</el-button>
          </div>
        </el-form-item>
        <el-form-item><el-button type="primary" :loading="savingBrand" @click="saveBrand">保存品牌</el-button></el-form-item>
      </el-form>
    </div>

    <div class="panel">
      <div class="panel-toolbar"><strong>账号安全</strong></div>
      <el-form :model="passwordForm" label-width="88px">
        <el-form-item label="当前密码"><el-input v-model="passwordForm.currentPassword" type="password" show-password /></el-form-item>
        <el-form-item label="新密码"><el-input v-model="passwordForm.newPassword" type="password" show-password minlength="8" /></el-form-item>
        <el-form-item><el-button type="primary" :loading="changingPassword" :disabled="!passwordForm.currentPassword || passwordForm.newPassword.length < 8" @click="changePassword">修改密码</el-button></el-form-item>
      </el-form>
    </div>

    <div class="panel">
      <div class="panel-toolbar"><strong>业务设置</strong></div>
      <el-form :model="businessForm" label-width="112px" v-loading="loading">
        <el-form-item label="卡密购买地址"><el-input v-model="businessForm.cardPurchaseUrl" placeholder="https://example.com/buy" /></el-form-item>
        <el-form-item><el-button type="primary" :loading="savingBrand" @click="saveBusiness">保存业务设置</el-button></el-form-item>
      </el-form>
    </div>

    <div class="panel payment-panel">
      <div class="panel-toolbar">
        <strong>支付方式</strong>
        <el-button size="small" @click="resetChannelForm">新增</el-button>
      </div>
      <el-form :model="channelForm" label-width="96px" class="payment-form">
        <el-form-item label="支付类型">
          <el-select v-model="channelForm.provider" style="width: 100%" :disabled="Boolean(editingChannelId)" @change="onProviderChange">
            <el-option v-for="item in providerOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="显示名称"><el-input v-model="channelForm.name" /></el-form-item>
        <el-form-item label="接口地址"><el-input v-model="channelForm.url" placeholder="官方接口可保留默认值" /></el-form-item>
        <el-form-item v-if="channelForm.provider === 'epay'" label="商户号"><el-input v-model="channelForm.pid" /></el-form-item>
        <el-form-item v-if="channelForm.provider === 'alipay' || channelForm.provider === 'wechat'" label="AppID"><el-input v-model="channelForm.appId" /></el-form-item>
        <el-form-item v-if="channelForm.provider === 'wechat'" label="商户号"><el-input v-model="channelForm.mchId" /></el-form-item>
        <el-form-item v-if="channelForm.provider === 'alipay' || channelForm.provider === 'wechat'" label="商品名称"><el-input v-model="channelForm.productName" /></el-form-item>
        <el-form-item v-if="channelForm.provider === 'alipay'" label="应用私钥"><el-input v-model="channelForm.privateKey" type="textarea" :rows="4" placeholder="编辑时留空表示不修改已保存私钥" /></el-form-item>
        <el-form-item v-if="channelForm.provider === 'alipay'" label="支付宝公钥"><el-input v-model="channelForm.publicKey" type="textarea" :rows="4" placeholder="编辑时留空表示不修改已保存公钥" /></el-form-item>
        <el-form-item v-if="channelForm.provider === 'epay' || channelForm.provider === 'bepusdt' || channelForm.provider === 'wechat'" :label="secretLabel">
          <el-input v-if="channelForm.provider === 'epay'" v-model="channelForm.key" type="password" show-password placeholder="编辑时留空表示不修改已保存密钥" />
          <el-input v-else-if="channelForm.provider === 'bepusdt'" v-model="channelForm.token" type="password" show-password placeholder="编辑时留空表示不修改已保存 Token" />
          <el-input v-else v-model="channelForm.apiKey" type="password" show-password placeholder="编辑时留空表示不修改已保存 V2 API 密钥" />
        </el-form-item>
        <el-form-item v-if="channelForm.provider === 'alipay'" :label="paymentTypeLabel(channelForm.provider)">
          <el-select v-model="channelForm.type" style="width: 100%"><el-option v-for="item in alipayModeOptions" :key="item.value" :label="item.label" :value="item.value" /></el-select>
        </el-form-item>
        <el-form-item v-if="channelForm.provider === 'epay' || channelForm.provider === 'bepusdt'" :label="paymentTypeLabel(channelForm.provider)"><el-input v-model="channelForm.type" /></el-form-item>
        <el-form-item label="回调地址"><el-input :model-value="callbackUrl" readonly /></el-form-item>
        <el-form-item label="自定义回调"><el-input v-model="channelForm.notifyUrl" placeholder="通常留空，系统使用当前域名生成" /></el-form-item>
        <el-form-item label="返回地址"><el-input v-model="channelForm.returnUrl" placeholder="通常留空，系统使用用户支付结果页" /></el-form-item>
        <el-form-item label="排序"><el-input-number v-model="channelForm.sortOrder" :min="0" :max="9999" style="width: 100%" /></el-form-item>
        <el-form-item label="启用"><el-switch v-model="channelForm.enabled" /></el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="savingChannel" :disabled="!channelForm.name" @click="saveChannel">{{ editingChannelId ? '保存修改' : '新增支付方式' }}</el-button>
          <el-button v-if="editingChannelId" @click="resetChannelForm">取消编辑</el-button>
        </el-form-item>
      </el-form>

      <el-table :data="channels" v-loading="loading" style="width: 100%">
        <el-table-column label="名称" min-width="140"><template #default="{ row }: { row: PaymentChannel }">{{ row.name }}</template></el-table-column>
        <el-table-column label="类型" width="130"><template #default="{ row }: { row: PaymentChannel }">{{ providerName(row.provider) }}</template></el-table-column>
        <el-table-column label="密钥" width="100"><template #default="{ row }: { row: PaymentChannel }">{{ secretState(row) }}</template></el-table-column>
        <el-table-column label="状态" width="90"><template #default="{ row }: { row: PaymentChannel }"><el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag></template></el-table-column>
        <el-table-column label="回调地址" min-width="260"><template #default="{ row }: { row: PaymentChannel }">{{ row.notifyUrl }}</template></el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }: { row: PaymentChannel }">
            <el-button size="small" @click="editChannel(row)">编辑</el-button>
            <el-button size="small" type="danger" @click="removeChannel(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>
