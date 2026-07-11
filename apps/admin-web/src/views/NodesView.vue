<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Gauge, RotateCcw, UploadCloud } from 'lucide-vue-next';
import { api } from '../api';

type XuiServer = { id: string; name: string; baseUrl: string; enabled: boolean };
type SocksNode = { id: string; name: string; host: string; port: number; enabled: boolean };
type ServiceNodeConfig = {
  encryption?: string;
  socksRelayEnabled?: boolean;
  socksNodeId?: string | null;
  remoteMode?: 'create' | 'bind';
  remoteManaged?: boolean;
  remoteInboundPort?: number;
};
type ServiceNode = {
  id: string;
  serverId: string;
  name: string;
  protocol: string;
  priceMonthly: string;
  trafficLimitGb: string;
  enabled: boolean;
  inboundId?: number | null;
  remark?: string | null;
  config?: ServiceNodeConfig | null;
  server?: XuiServer;
};
const protocolOptions = [
  { label: 'VLESS', value: 'vless' },
  { label: 'VMess', value: 'vmess' },
  { label: 'Trojan', value: 'trojan' },
  { label: 'Shadowsocks', value: 'shadowsocks' },
  { label: 'Hysteria', value: 'hysteria' }
];
const encryptionOptions = [
  { label: 'none', value: 'none' },
  { label: 'TLS', value: 'tls' },
  { label: 'Reality', value: 'reality' }
];

const servers = ref<XuiServer[]>([]);
const socksNodes = ref<SocksNode[]>([]);
const nodes = ref<ServiceNode[]>([]);
const loading = ref(false);
const saving = ref(false);
const syncingConfigIds = ref<Set<string>>(new Set());
const syncingTrafficLimitIds = ref<Set<string>>(new Set());
const resettingTrafficIds = ref<Set<string>>(new Set());
const error = ref('');
const editingId = ref('');
const dialogVisible = ref(false);
const form = reactive({
  name: '',
  serverId: '',
  remoteMode: 'create' as 'create' | 'bind',
  inboundId: undefined as number | undefined,
  inboundPort: undefined as number | undefined,
  protocol: 'vless',
  encryption: 'none',
  priceMonthly: 0,
  trafficLimitGb: 0,
  enabled: true,
  socksRelayEnabled: false,
  socksNodeId: '',
  remark: ''
});

const enabledSocksNodes = computed(() => socksNodes.value.filter((item) => item.enabled));

async function loadNodes() {
  loading.value = true;
  error.value = '';
  try {
    const [serverList, nodeList, socksList] = await Promise.all([
      api<XuiServer[]>('/api/admin/xui-servers'),
      api<ServiceNode[]>('/api/admin/service-nodes'),
      api<SocksNode[]>('/api/admin/socks-nodes')
    ]);
    servers.value = serverList;
    nodes.value = nodeList;
    socksNodes.value = socksList;
    if (!form.serverId && serverList[0]) form.serverId = serverList[0].id;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载服务节点失败';
  } finally {
    loading.value = false;
  }
}

async function saveNode() {
  saving.value = true;
  error.value = '';
  try {
    const path = editingId.value ? `/api/admin/service-nodes/${editingId.value}` : '/api/admin/service-nodes';
    await api(path, { method: editingId.value ? 'PATCH' : 'POST', body: form });
    ElMessage.success(editingId.value ? '服务节点已更新' : '服务节点已添加');
    dialogVisible.value = false;
    resetForm();
    await loadNodes();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存服务节点失败';
  } finally {
    saving.value = false;
  }
}

async function syncRemoteConfig(node: ServiceNode) {
  await ElMessageBox.confirm(`确认把“${node.name}”的 Socks 中转配置写入远端 Xray？系统只会管理本项目标记的出站和路由。`, '同步配置确认', { type: 'warning' });
  syncingConfigIds.value = new Set(syncingConfigIds.value).add(node.id);
  error.value = '';
  try {
    const result = await api<{ action: string }>(`/api/admin/service-nodes/${node.id}/sync-config`, { method: 'POST' });
    ElMessage.success(result.action === 'updated' ? '远端 Socks 中转配置已同步' : '远端 Socks 中转配置已清理');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '同步远端配置失败';
  } finally {
    const next = new Set(syncingConfigIds.value);
    next.delete(node.id);
    syncingConfigIds.value = next;
  }
}

async function syncTrafficLimit(node: ServiceNode) {
  syncingTrafficLimitIds.value = new Set(syncingTrafficLimitIds.value).add(node.id);
  error.value = '';
  try {
    const result = await api<{ updated: number; skipped: number; failed: number }>(`/api/admin/service-nodes/${node.id}/sync-traffic-limit`, { method: 'POST' });
    if (result.failed > 0) {
      ElMessage.warning(`流量额度已部分同步：成功 ${result.updated}，跳过 ${result.skipped}，失败 ${result.failed}`);
    } else {
      ElMessage.success(`流量额度已同步：成功 ${result.updated}，跳过 ${result.skipped}`);
    }
    await loadNodes();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '同步流量额度失败';
  } finally {
    const next = new Set(syncingTrafficLimitIds.value);
    next.delete(node.id);
    syncingTrafficLimitIds.value = next;
  }
}

async function resetRemoteTraffic(node: ServiceNode) {
  await ElMessageBox.confirm(`确认重置「${node.name}」远端入站流量统计？此操作不会清空每个客户端的流量。`, '重置流量确认', { type: 'warning' });
  resettingTrafficIds.value = new Set(resettingTrafficIds.value).add(node.id);
  error.value = '';
  try {
    await api(`/api/admin/service-nodes/${node.id}/reset-traffic`, { method: 'POST' });
    ElMessage.success('远端入站流量已重置');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '重置远端流量失败';
  } finally {
    const next = new Set(resettingTrafficIds.value);
    next.delete(node.id);
    resettingTrafficIds.value = next;
  }
}

function openDialog() {
  resetForm();
  dialogVisible.value = true;
}

function editNode(node: ServiceNode) {
  const config = node.config || {};
  editingId.value = node.id;
  Object.assign(form, {
    name: node.name,
    serverId: node.serverId,
    remoteMode: config.remoteMode || (config.remoteManaged ? 'create' : 'bind'),
    inboundId: node.inboundId ?? undefined,
    inboundPort: config.remoteInboundPort ?? undefined,
    protocol: node.protocol || 'vless',
    encryption: config.encryption || 'none',
    priceMonthly: Number(node.priceMonthly),
    trafficLimitGb: Number(node.trafficLimitGb),
    enabled: node.enabled,
    socksRelayEnabled: Boolean(config.socksRelayEnabled),
    socksNodeId: config.socksNodeId || '',
    remark: node.remark || ''
  });
  dialogVisible.value = true;
}

async function removeNode(node: ServiceNode) {
  await ElMessageBox.confirm(`确认删除服务节点“${node.name}”？系统会先删除该节点下远端 3x-ui 客户端，并清理本项目写入的 Socks 路由配置。`, '删除确认', { type: 'warning' });
  await api(`/api/admin/service-nodes/${node.id}`, { method: 'DELETE' });
  ElMessage.success('服务节点已删除');
  await loadNodes();
}

function resetForm() {
  editingId.value = '';
  Object.assign(form, {
    name: '',
    serverId: servers.value[0]?.id || '',
    remoteMode: 'create',
    inboundId: undefined,
    inboundPort: undefined,
    protocol: 'vless',
    encryption: 'none',
    priceMonthly: 0,
    trafficLimitGb: 0,
    enabled: true,
    socksRelayEnabled: false,
    socksNodeId: '',
    remark: ''
  });
}

function socksLabel(id?: string | null) {
  const node = socksNodes.value.find((item) => item.id === id);
  return node ? `${node.name} (${node.host}:${node.port})` : '-';
}

function remoteModeLabel(node: ServiceNode) {
  return node.config?.remoteManaged ? '自动创建' : '绑定已有';
}

onMounted(loadNodes);
</script>

<template>
  <h1 class="page-title">服务节点</h1>
  <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="page-alert" />

  <div class="panel list-panel">
    <div class="panel-toolbar">
      <strong>服务节点列表</strong>
      <div class="table-toolbar-actions">
        <el-button type="primary" @click="openDialog">添加服务节点</el-button>
        <el-button :loading="loading" @click="loadNodes">刷新</el-button>
      </div>
    </div>
    <el-table :data="nodes" v-loading="loading" style="width: 100%">
      <el-table-column prop="name" label="名称" min-width="140" />
      <el-table-column label="3x-ui 服务器" min-width="140">
        <template #default="{ row }: { row: ServiceNode }">{{ row.server?.name || '-' }}</template>
      </el-table-column>
      <el-table-column prop="inboundId" label="入站 ID" width="100" />
      <el-table-column label="远端方式" width="110">
        <template #default="{ row }: { row: ServiceNode }"><el-tag :type="row.config?.remoteManaged ? 'success' : 'info'">{{ remoteModeLabel(row) }}</el-tag></template>
      </el-table-column>
      <el-table-column prop="protocol" label="节点类型" width="110" />
      <el-table-column label="传输安全" width="120">
        <template #default="{ row }: { row: ServiceNode }">{{ row.config?.encryption || 'none' }}</template>
      </el-table-column>
      <el-table-column prop="priceMonthly" label="月价格" width="100" />
      <el-table-column prop="trafficLimitGb" label="流量 GB" width="100" />
      <el-table-column label="Socks 中转" min-width="190">
        <template #default="{ row }: { row: ServiceNode }">
          <span v-if="row.config?.socksRelayEnabled">{{ socksLabel(row.config.socksNodeId) }}</span>
          <span v-else class="muted-text">未启用</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }: { row: ServiceNode }"><el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag></template>
      </el-table-column>
      <el-table-column label="操作" width="520" fixed="right">
        <template #default="{ row }: { row: ServiceNode }">
          <el-button size="small" :loading="syncingConfigIds.has(row.id)" :disabled="!row.inboundId" @click="syncRemoteConfig(row)"><UploadCloud :size="15" />同步配置</el-button>
          <el-button size="small" :loading="syncingTrafficLimitIds.has(row.id)" :disabled="!row.inboundId" @click="syncTrafficLimit(row)"><Gauge :size="15" />同步流量</el-button>
          <el-button size="small" :loading="resettingTrafficIds.has(row.id)" :disabled="!row.inboundId" @click="resetRemoteTraffic(row)"><RotateCcw :size="15" />重置流量</el-button>
          <el-button size="small" @click="editNode(row)">编辑</el-button>
          <el-button size="small" type="danger" @click="removeNode(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>

  <el-dialog v-model="dialogVisible" :title="editingId ? '编辑服务节点' : '添加服务节点'" width="820px" destroy-on-close>
    <el-form :model="form" label-width="112px" class="dialog-form-grid">
      <el-form-item label="节点名称"><el-input v-model="form.name" /></el-form-item>
      <el-form-item label="3x-ui 服务器">
        <el-select v-model="form.serverId" placeholder="选择服务器" style="width: 100%">
          <el-option v-for="server in servers" :key="server.id" :label="server.name" :value="server.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="远端入站">
        <el-segmented v-model="form.remoteMode" :options="[{ label: '自动创建', value: 'create' }, { label: '绑定已有', value: 'bind' }]" />
      </el-form-item>
      <el-form-item v-if="form.remoteMode === 'bind'" label="入站 ID"><el-input-number v-model="form.inboundId" :min="1" style="width: 100%" /></el-form-item>
      <el-form-item v-else label="端口">
        <el-input-number v-model="form.inboundPort" :min="1" :max="65535" placeholder="自动分配" style="width: 100%" />
      </el-form-item>
      <el-form-item label="节点类型">
        <el-select v-model="form.protocol" style="width: 100%">
          <el-option v-for="item in protocolOptions" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="传输安全">
        <el-select v-model="form.encryption" style="width: 100%">
          <el-option v-for="item in encryptionOptions" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="月价格"><el-input-number v-model="form.priceMonthly" :min="0" :precision="2" style="width: 100%" /></el-form-item>
      <el-form-item label="流量 GB"><el-input-number v-model="form.trafficLimitGb" :min="0" :precision="2" style="width: 100%" /></el-form-item>
      <el-form-item label="启用节点"><el-switch v-model="form.enabled" /></el-form-item>
      <el-form-item label="启用 Socks"><el-switch v-model="form.socksRelayEnabled" /></el-form-item>
      <el-form-item label="Socks 节点">
        <el-select v-model="form.socksNodeId" :disabled="!form.socksRelayEnabled" placeholder="选择 Socks 节点" style="width: 100%">
          <el-option v-for="node in enabledSocksNodes" :key="node.id" :label="`${node.name} (${node.host}:${node.port})`" :value="node.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="备注"><el-input v-model="form.remark" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!form.name || !form.serverId || (form.remoteMode === 'bind' && !form.inboundId) || (form.socksRelayEnabled && !form.socksNodeId)" @click="saveNode">保存</el-button>
    </template>
  </el-dialog>
</template>
