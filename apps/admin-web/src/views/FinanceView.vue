<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';

type RechargeOrder = {
  id: string;
  tradeNo: string;
  provider: string;
  amount: string;
  status: string;
  createdAt: string;
  customer?: { name: string; loginUsername: string };
};

type BalanceLog = {
  id: string;
  type: string;
  amount: string;
  beforeBalance: string;
  afterBalance: string;
  operator?: string | null;
  remark?: string | null;
  createdAt: string;
  customer?: { name: string; loginUsername: string };
};

type PaymentChannel = { id: string; enabled: boolean; name: string };

const loading = ref(false);
const error = ref('');
const orders = ref<RechargeOrder[]>([]);
const logs = ref<BalanceLog[]>([]);
const paymentChannels = ref<PaymentChannel[]>([]);

async function loadFinance() {
  loading.value = true;
  error.value = '';
  try {
    const [orderResult, logResult, channelResult] = await Promise.all([
      api<RechargeOrder[]>('/api/admin/recharge-orders'),
      api<BalanceLog[]>('/api/admin/balance-logs'),
      api<PaymentChannel[]>('/api/admin/payment-channels')
    ]);
    orders.value = orderResult;
    logs.value = logResult;
    paymentChannels.value = channelResult;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
}

onMounted(loadFinance);
</script>

<template>
  <h1 class="page-title">财务中心</h1>
  <el-alert v-if="!paymentChannels.some((item) => item.enabled)" class="page-alert" title="尚未启用在线支付方式；用户仍可使用卡密兑换，管理员也可手工调整余额。" type="warning" show-icon :closable="false" />
  <el-alert v-if="error" class="page-alert" :title="error" type="error" show-icon :closable="false" />

  <div class="panel">
    <div class="panel-toolbar">
      <strong>充值订单</strong>
      <el-button size="small" :loading="loading" @click="loadFinance">刷新</el-button>
    </div>
    <el-table :data="orders" v-loading="loading" style="width: 100%">
      <el-table-column prop="tradeNo" label="订单号" min-width="180" />
      <el-table-column label="用户" min-width="160"><template #default="{ row }">{{ row.customer?.name || '-' }}</template></el-table-column>
      <el-table-column prop="provider" label="通道" width="110" />
      <el-table-column prop="amount" label="金额" width="120" />
      <el-table-column prop="status" label="状态" width="100" />
      <el-table-column label="创建时间" min-width="180"><template #default="{ row }">{{ formatDate(row.createdAt) }}</template></el-table-column>
    </el-table>
  </div>

  <div class="panel list-panel">
    <div class="panel-toolbar"><strong>余额流水</strong></div>
    <el-table :data="logs" v-loading="loading" style="width: 100%">
      <el-table-column label="用户" min-width="160"><template #default="{ row }">{{ row.customer?.name || '-' }}</template></el-table-column>
      <el-table-column prop="type" label="类型" width="140" />
      <el-table-column prop="amount" label="变动" width="120" />
      <el-table-column prop="beforeBalance" label="变动前" width="120" />
      <el-table-column prop="afterBalance" label="变动后" width="120" />
      <el-table-column prop="operator" label="操作人" width="130" />
      <el-table-column prop="remark" label="备注" min-width="180" />
      <el-table-column label="时间" min-width="180"><template #default="{ row }">{{ formatDate(row.createdAt) }}</template></el-table-column>
    </el-table>
  </div>
</template>
