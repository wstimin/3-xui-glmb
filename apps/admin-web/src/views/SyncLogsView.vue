<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Copy, RefreshCw, RotateCcw, Search } from 'lucide-vue-next';
import { api } from '../api';

type XuiServer = { id: string; name: string; baseUrl: string };
type SyncLog = {
  id: string;
  serverId?: string | null;
  action: string;
  status: string;
  message?: string | null;
  detail?: unknown;
  createdAt: string;
  server?: XuiServer | null;
};
type SyncLogResponse = {
  items: SyncLog[];
  filters: { actions: string[]; statuses: string[]; servers: XuiServer[] };
};

const loading = ref(false);
const error = ref('');
const logs = ref<SyncLog[]>([]);
const actions = ref<string[]>([]);
const statuses = ref<string[]>([]);
const servers = ref<XuiServer[]>([]);
const filters = reactive({ serverId: '', action: '', status: '', limit: 100 });
const detailDialogVisible = ref(false);
const selectedLog = ref<SyncLog | null>(null);

const failedCount = computed(() => logs.value.filter((item) => item.status === 'failed').length);
const partialCount = computed(() => logs.value.filter((item) => item.status === 'partial').length);
const successCount = computed(() => logs.value.filter((item) => item.status === 'success').length);

async function loadLogs() {
  loading.value = true;
  error.value = '';
  try {
    const params = new URLSearchParams();
    if (filters.serverId) params.set('serverId', filters.serverId);
    if (filters.action) params.set('action', filters.action);
    if (filters.status) params.set('status', filters.status);
    params.set('limit', String(filters.limit || 100));
    const result = await api<SyncLogResponse>(`/api/admin/sync-logs?${params.toString()}`);
    logs.value = result.items;
    actions.value = result.filters.actions;
    statuses.value = result.filters.statuses;
    servers.value = result.filters.servers;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载同步日志失败';
  } finally {
    loading.value = false;
  }
}

function setStatusFilter(status: string) {
  filters.status = status;
  void loadLogs();
}

function resetFilters() {
  Object.assign(filters, { serverId: '', action: '', status: '', limit: 100 });
  void loadLogs();
}

function showDetail(log: SyncLog) {
  selectedLog.value = log;
  detailDialogVisible.value = true;
}

async function copyDetail(log = selectedLog.value) {
  if (!log) return;
  const text = formatDetail(log.detail);
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success('日志详情已复制');
  } catch {
    ElMessage.error('复制失败，请手动选择复制');
  }
}

function statusType(status: string) {
  if (status === 'success') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'partial') return 'warning';
  return 'info';
}

function statusLabel(status: string) {
  if (status === 'success') return '成功';
  if (status === 'failed') return '失败';
  if (status === 'partial') return '部分成功';
  return status || '-';
}

function actionLabel(action: string) {
  const map: Record<string, string> = {
    sync_service_node: '同步路由节点',
    delete_service_node: '删除路由节点',
    update_customer_node: '更新绑定节点',
    disable_expired_node: '停用过期节点',
    sync_traffic: '同步远端流量'
  };
  return map[action] || action;
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
}

function formatDetail(value: unknown) {
  if (value === undefined || value === null) return '没有详情';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function shortDetail(value: unknown) {
  const text = formatDetail(value).replace(/\s+/g, ' ');
  return text.length > 90 ? `${text.slice(0, 90)}...` : text;
}

onMounted(loadLogs);
</script>

<template>
  <div class="page-head">
    <div class="page-head-main">
      <h1 class="page-title">同步日志</h1>
      <p>查看管理后台对 3x-ui 的同步、删除、流量读取等真实执行结果。</p>
    </div>
    <div class="page-actions">
      <el-button :loading="loading" @click="loadLogs"><RefreshCw :size="15" />刷新</el-button>
    </div>
  </div>
  <el-alert v-if="error" class="page-alert" :title="error" type="error" show-icon :closable="false" />

  <div class="metric-grid compact-metrics">
    <div class="metric"><span>当前显示</span><strong>{{ logs.length }}</strong><small>最多 {{ filters.limit }} 条</small></div>
    <div class="metric"><span>成功</span><strong>{{ successCount }}</strong><small>远端操作已完成</small></div>
    <div class="metric"><span>部分成功</span><strong>{{ partialCount }}</strong><small>需要查看详情</small></div>
    <div class="metric"><span>失败</span><strong>{{ failedCount }}</strong><small>优先排查这些记录</small></div>
  </div>

  <div class="panel list-panel">
    <div class="panel-toolbar">
      <strong>3x-ui 操作记录</strong>
      <div class="status-segment" role="group" aria-label="状态筛选">
        <button :class="{ active: !filters.status }" type="button" @click="setStatusFilter('')">全部</button>
        <button :class="{ active: filters.status === 'success' }" type="button" @click="setStatusFilter('success')">成功</button>
        <button :class="{ active: filters.status === 'partial' }" type="button" @click="setStatusFilter('partial')">部分</button>
        <button :class="{ active: filters.status === 'failed' }" type="button" @click="setStatusFilter('failed')">失败</button>
      </div>
    </div>

    <div class="filter-bar">
      <el-select v-model="filters.serverId" clearable placeholder="面板连接" style="width: 190px" @change="loadLogs">
          <el-option v-for="server in servers" :key="server.id" :label="server.name" :value="server.id" />
        </el-select>
      <el-select v-model="filters.action" clearable placeholder="动作" style="width: 230px" @change="loadLogs">
          <el-option v-for="action in actions" :key="action" :label="actionLabel(action)" :value="action" />
        </el-select>
      <el-select v-model="filters.status" clearable placeholder="状态" style="width: 130px" @change="loadLogs">
          <el-option v-for="status in statuses" :key="status" :label="statusLabel(status)" :value="status" />
        </el-select>
      <el-input-number v-model="filters.limit" :min="20" :max="300" :step="20" controls-position="right" style="width: 126px" @change="loadLogs" />
      <el-button @click="resetFilters"><RotateCcw :size="15" />重置</el-button>
      <el-button type="primary" :loading="loading" @click="loadLogs"><Search :size="15" />查询</el-button>
    </div>

    <el-table :data="logs" v-loading="loading" style="width: 100%" row-key="id">
      <el-table-column label="时间" min-width="170"><template #default="{ row }: { row: SyncLog }">{{ formatDate(row.createdAt) }}</template></el-table-column>
      <el-table-column label="面板连接" min-width="160"><template #default="{ row }: { row: SyncLog }">{{ row.server?.name || '-' }}</template></el-table-column>
      <el-table-column label="动作" min-width="210"><template #default="{ row }: { row: SyncLog }">{{ actionLabel(row.action) }}</template></el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }: { row: SyncLog }"><el-tag :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag></template>
      </el-table-column>
      <el-table-column prop="message" label="消息" min-width="260" show-overflow-tooltip />
      <el-table-column label="详情摘要" min-width="260" show-overflow-tooltip>
        <template #default="{ row }: { row: SyncLog }"><span class="muted-text">{{ shortDetail(row.detail) }}</span></template>
      </el-table-column>
      <el-table-column label="操作" width="90" fixed="right">
        <template #default="{ row }: { row: SyncLog }"><el-button size="small" @click="showDetail(row)">详情</el-button></template>
      </el-table-column>
      <template #empty>
        <el-empty description="暂无同步日志" />
      </template>
    </el-table>
  </div>

  <el-dialog v-model="detailDialogVisible" title="同步日志详情" width="min(760px, 92vw)" destroy-on-close>
    <div v-if="selectedLog" class="log-detail-dialog">
      <div class="log-detail-meta">
        <span>{{ formatDate(selectedLog.createdAt) }}</span>
        <span>{{ selectedLog.server?.name || '未关联服务器' }}</span>
        <el-tag :type="statusType(selectedLog.status)">{{ statusLabel(selectedLog.status) }}</el-tag>
      </div>
      <el-alert v-if="selectedLog.message" :title="selectedLog.message" :type="selectedLog.status === 'failed' ? 'warning' : 'info'" show-icon :closable="false" />
      <pre class="json-preview">{{ formatDetail(selectedLog.detail) }}</pre>
    </div>
    <template #footer>
      <el-button @click="detailDialogVisible = false">关闭</el-button>
      <el-button type="primary" @click="copyDetail()"><Copy :size="15" />复制详情</el-button>
    </template>
  </el-dialog>
</template>
