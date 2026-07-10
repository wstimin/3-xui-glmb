<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api';

type AdminSettings = { brand: { brandName: string; logoDataUrl: string }; payments: unknown[] };
type PaymentProvider = 'epay' | 'bepusdt';
type PaymentChannel = {
  id: string;
  provider: PaymentProvider;
  name: string;
  enabled: boolean;
  sortOrder: number;
  config: { url?: string; pid?: string; type?: string; notifyUrl?: string; returnUrl?: string };
  hasKey?: boolean;
  hasToken?: boolean;
  notifyUrl?: string;
};

const providerOptions = [
  { label: '易支付', value: 'epay' },
  { label: 'BEpusdt', value: 'bepusdt' }
] as const;

const loading = ref(false);
const savingBrand = ref(false);
const changingPassword = ref(false);
const savingChannel = ref(false);
const error = ref('');
const channels = ref<PaymentChannel[]>([]);
const editingChannelId = ref('');
const brandForm = reactive({ brandName: '十夜管理系统', logoDataUrl: '' });
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
  type: 'alipay',
  notifyUrl: '',
  returnUrl: ''
});

const callbackOrigin = computed(() => window.location.origin.replace(/\/+$/, ''));
const callbackPath = computed(() => `/api/payments/${channelForm.provider}/notify`);
const callbackUrl = computed(() => `${callbackOrigin.value}${callbackPath.value}`);
const secretLabel = computed(() => channelForm.provider === 'epay' ? '商户密钥' : 'Token');

async function loadSettings() {
  loading.value = true;
  error.value = '';
  try {
    const [settings, paymentChannels] = await Promise.all([
      api<AdminSettings>('/api/admin/settings'),
      api<PaymentChannel[]>('/api/admin/payment-channels')
    ]);
    Object.assign(brandForm, settings.brand);
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
        type: channelForm.type,
        notifyUrl: channelForm.notifyUrl,
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
    type: channel.config.type || defaultType(channel.provider),
    notifyUrl: channel.config.notifyUrl || '',
    returnUrl: channel.config.returnUrl || ''
  });
}

async function removeChannel(channel: PaymentChannel) {
  await ElMessageBox.confirm(`确认删除支付方式「${channel.name}」？`, '删除确认', { type: 'warning' });
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
    type: 'alipay',
    notifyUrl: '',
    returnUrl: ''
  });
}

function onProviderChange(provider: PaymentProvider) {
  channelForm.name = provider === 'epay' ? '易支付' : 'BEpusdt';
  channelForm.type = defaultType(provider);
}

function defaultType(provider: PaymentProvider) {
  return provider === 'epay' ? 'alipay' : 'usdt.trc20';
}

function providerName(provider: PaymentProvider) {
  return providerOptions.find((item) => item.value === provider)?.label || provider;
}

function secretState(channel: PaymentChannel) {
  return channel.provider === 'epay' ? (channel.hasKey ? '已配置' : '未配置') : (channel.hasToken ? '已配置' : '未配置');
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
        <el-form-item label="Logo Data"><el-input v-model="brandForm.logoDataUrl" type="textarea" :rows="3" placeholder="可留空" /></el-form-item>
        <el-form-item><el-button type="primary" :loading="savingBrand" @click="saveBrand">保存</el-button></el-form-item>
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
        <el-form-item label="接口地址"><el-input v-model="channelForm.url" placeholder="例如 https://pay.example.com" /></el-form-item>
        <el-form-item v-if="channelForm.provider === 'epay'" label="商户号"><el-input v-model="channelForm.pid" /></el-form-item>
        <el-form-item :label="secretLabel">
          <el-input v-if="channelForm.provider === 'epay'" v-model="channelForm.key" type="password" show-password placeholder="留空表示不修改已保存密钥" />
          <el-input v-else v-model="channelForm.token" type="password" show-password placeholder="留空表示不修改已保存 Token" />
        </el-form-item>
        <el-form-item label="支付类型值"><el-input v-model="channelForm.type" /></el-form-item>
        <el-form-item label="回调地址"><el-input :model-value="callbackUrl" readonly /></el-form-item>
        <el-form-item label="自定义回调"><el-input v-model="channelForm.notifyUrl" placeholder="通常留空，系统自动使用上方地址" /></el-form-item>
        <el-form-item label="排序"><el-input-number v-model="channelForm.sortOrder" :min="0" :max="9999" style="width: 100%" /></el-form-item>
        <el-form-item label="启用"><el-switch v-model="channelForm.enabled" /></el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="savingChannel" :disabled="!channelForm.name || !channelForm.url" @click="saveChannel">{{ editingChannelId ? '保存修改' : '新增支付方式' }}</el-button>
          <el-button v-if="editingChannelId" @click="resetChannelForm">取消编辑</el-button>
        </el-form-item>
      </el-form>

      <el-table :data="channels" v-loading="loading" style="width: 100%">
        <el-table-column label="名称" min-width="140"><template #default="{ row }: { row: PaymentChannel }">{{ row.name }}</template></el-table-column>
        <el-table-column label="类型" width="110"><template #default="{ row }: { row: PaymentChannel }">{{ providerName(row.provider) }}</template></el-table-column>
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
