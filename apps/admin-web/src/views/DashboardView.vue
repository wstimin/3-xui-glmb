<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Activity, Clock3, RefreshCw, ShieldOff } from 'lucide-vue-next';
import { api } from '../api';

type CustomerResult = { total: number; items: Array<{ id: string; status: string }> };
type ServiceNode = { id: string; enabled: boolean };
type XuiServer = { id: string; enabled: boolean };
type CardResult = { total: number; items: Array<{ id: string; status: string }> };
type PaymentChannel = { id: string; enabled: boolean };
type JobSettings = { disableExpiredEnabled: boolean; trafficSyncEnabled: boolean };
type DisableExpiredResult = { checkedAt: string; total: number; success: number; failed: number };
type TrafficSyncResult = { checkedAt: string; checked: number; disabled: number; failed: number };
type JobStatus = { lastDisableExpired: DisableExpiredResult | null; lastTrafficSync: TrafficSyncResult | null };

const loading = ref(false);
const jobRunning = ref(false);
const trafficJobRunning = ref(false);
const jobSettingsSaving = ref(false);
const error = ref('');
const customers = ref<CustomerResult>({ total: 0, items: [] });
const serviceNodes = ref<ServiceNode[]>([]);
const servers = ref<XuiServer[]>([]);
const cards = ref<CardResult>({ total: 0, items: [] });
const paymentChannels = ref<PaymentChannel[]>([]);
const jobSettings = ref<JobSettings>({ disableExpiredEnabled: true, trafficSyncEnabled: true });
const lastDisableExpired = ref<DisableExpiredResult | null>(null);
const lastTrafficSync = ref<TrafficSyncResult | null>(null);

const activeCustomers = computed(() => customers.value.items.filter((item) => item.status === 'active').length);
const enabledNodes = computed(() => serviceNodes.value.filter((item) => item.enabled).length);
const enabledServers = computed(() => servers.value.filter((item) => item.enabled).length);
const unusedCards = computed(() => cards.value.items.filter((item) => item.status === 'unused').length);
const enabledPaymentChannels = computed(() => paymentChannels.value.filter((item) => item.enabled).length);

async function loadDashboard() {
  loading.value = true;
  error.value = '';
  try {
    const [customerResult, nodeResult, serverResult, cardResult, channelResult, settingsResult, statusResult] = await Promise.all([
      api<CustomerResult>('/api/admin/customers'),
      api<ServiceNode[]>('/api/admin/service-nodes'),
      api<XuiServer[]>('/api/admin/xui-servers'),
      api<CardResult>('/api/admin/cards'),
      api<PaymentChannel[]>('/api/admin/payment-channels'),
      api<JobSettings>('/api/admin/jobs/settings'),
      api<JobStatus>('/api/admin/jobs/status')
    ]);
    customers.value = customerResult;
    serviceNodes.value = nodeResult;
    servers.value = serverResult;
    cards.value = cardResult;
    paymentChannels.value = channelResult;
    jobSettings.value = settingsResult;
    lastDisableExpired.value = statusResult.lastDisableExpired;
    lastTrafficSync.value = statusResult.lastTrafficSync;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载数据概览失败';
  } finally {
    loading.value = false;
  }
}

async function saveJobSettings(patch: Partial<JobSettings>) {
  const previous = { ...jobSettings.value };
  jobSettings.value = { ...jobSettings.value, ...patch };
  jobSettingsSaving.value = true;
  error.value = '';
  try {
    jobSettings.value = await api<JobSettings>('/api/admin/jobs/settings', { method: 'PATCH', body: patch });
    ElMessage.success('任务设置已保存');
  } catch (err) {
    jobSettings.value = previous;
    error.value = err instanceof Error ? err.message : '保存任务设置失败';
  } finally {
    jobSettingsSaving.value = false;
  }
}

async function disableExpiredNodes() {
  await ElMessageBox.confirm('系统会把已到期且仍处于启用状态的用户节点同步停用到远端 3x-ui，远端同步成功后再更新本地状态。确认执行？', '停用过期节点', { type: 'warning' });
  jobRunning.value = true;
  error.value = '';
  try {
    const result = await api<DisableExpiredResult>('/api/admin/jobs/disable-expired', { method: 'POST' });
    lastDisableExpired.value = result;
    ElMessage.success(`执行完成：成功 ${result.success}，失败 ${result.failed}，总数 ${result.total}`);
    await loadDashboard();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '停用过期节点失败';
  } finally {
    jobRunning.value = false;
  }
}

async function syncTraffic() {
  trafficJobRunning.value = true;
  error.value = '';
  try {
    const result = await api<TrafficSyncResult>('/api/admin/jobs/sync-traffic', { method: 'POST' });
    lastTrafficSync.value = result;
    ElMessage.success(`流量同步完成：检查 ${result.checked}，停用 ${result.disabled}，失败 ${result.failed}`);
    await loadDashboard();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '同步远端流量失败';
  } finally {
    trafficJobRunning.value = false;
  }
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未执行';
}

onMounted(loadDashboard);
</script>

<template>
  <div class="page-head">
    <div class="page-head-main">
      <h1 class="page-title">数据概览</h1>
      <p>查看系统初始化状态、核心资源数量和后台自动任务。</p>
    </div>
    <div class="page-actions">
      <el-button :loading="loading" @click="loadDashboard"><RefreshCw :size="15" />刷新</el-button>
    </div>
  </div>
  <el-alert v-if="error" class="page-alert" :title="error" type="error" show-icon :closable="false" />

  <div class="metric-grid" :class="{ loading }">
    <div class="metric"><span>用户总数</span><strong>{{ customers.total }}</strong><small>当前页活跃 {{ activeCustomers }}</small></div>
    <div class="metric"><span>路由节点</span><strong>{{ serviceNodes.length }}</strong><small>已启用 {{ enabledNodes }}</small></div>
    <div class="metric"><span>面板连接</span><strong>{{ servers.length }}</strong><small>已启用 {{ enabledServers }}</small></div>
    <div class="metric"><span>卡密总数</span><strong>{{ cards.total }}</strong><small>当前页未使用 {{ unusedCards }}</small></div>
  </div>

  <div class="panel list-panel">
    <div class="panel-toolbar">
      <strong>初始化状态</strong>
    </div>
    <div class="status-strip">
      <div>
        <span>在线支付</span>
        <strong>{{ enabledPaymentChannels ? `已启用 ${enabledPaymentChannels} 个通道` : '未启用' }}</strong>
      </div>
      <div>
        <span>面板连接</span>
        <strong>{{ enabledServers }}/{{ servers.length }} 可用</strong>
      </div>
      <div>
        <span>路由节点</span>
        <strong>{{ enabledNodes }}/{{ serviceNodes.length }} 启用</strong>
      </div>
    </div>
  </div>

  <div class="job-card-grid">
    <div class="panel job-card">
      <div class="job-card-head">
        <div class="job-icon"><ShieldOff :size="20" /></div>
        <div>
          <strong>自动停用过期节点</strong>
          <span>每 10 分钟检查一次，到期后同步停用远端。</span>
        </div>
        <div class="job-toggle">
          <span>{{ jobSettings.disableExpiredEnabled ? '已启用' : '已停用' }}</span>
          <el-switch
            :model-value="jobSettings.disableExpiredEnabled"
            :loading="jobSettingsSaving"
            @change="(value: string | number | boolean) => saveJobSettings({ disableExpiredEnabled: Boolean(value) })"
          />
        </div>
      </div>
      <div class="job-card-body">
        <div><span>最近执行</span><strong>{{ formatDate(lastDisableExpired?.checkedAt) }}</strong></div>
        <div><span>成功</span><strong>{{ lastDisableExpired?.success ?? '-' }}</strong></div>
        <div><span>失败</span><strong>{{ lastDisableExpired?.failed ?? '-' }}</strong></div>
      </div>
      <div class="job-card-actions">
        <el-button type="primary" plain :loading="jobRunning" @click="disableExpiredNodes"><Clock3 :size="15" />立即执行</el-button>
      </div>
    </div>

    <div class="panel job-card">
      <div class="job-card-head">
        <div class="job-icon"><Activity :size="20" /></div>
        <div>
          <strong>远端流量同步任务</strong>
          <span>读取远端用量，超限后停用本地绑定和远端客户端。</span>
        </div>
        <div class="job-toggle">
          <span>{{ jobSettings.trafficSyncEnabled ? '已启用' : '已停用' }}</span>
          <el-switch
            :model-value="jobSettings.trafficSyncEnabled"
            :loading="jobSettingsSaving"
            @change="(value: string | number | boolean) => saveJobSettings({ trafficSyncEnabled: Boolean(value) })"
          />
        </div>
      </div>
      <div class="job-card-body">
        <div><span>最近执行</span><strong>{{ formatDate(lastTrafficSync?.checkedAt) }}</strong></div>
        <div><span>检查</span><strong>{{ lastTrafficSync?.checked ?? '-' }}</strong></div>
        <div><span>停用</span><strong>{{ lastTrafficSync?.disabled ?? '-' }}</strong></div>
      </div>
      <div class="job-card-actions">
        <el-button type="primary" plain :loading="trafficJobRunning" @click="syncTraffic"><Activity :size="15" />立即同步</el-button>
      </div>
    </div>
  </div>
</template>
