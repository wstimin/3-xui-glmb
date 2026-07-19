<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Edit3, Gauge, Plus, RefreshCw, RotateCcw, Search, Trash2, UploadCloud } from 'lucide-vue-next';
import { api } from '../api';

type XuiServer = { id: string; name: string; baseUrl: string; enabled: boolean };
type SocksNode = { id: string; name: string; host: string; port: number; enabled: boolean };
type ServiceNodeTransport = 'tcp' | 'kcp' | 'ws' | 'grpc' | 'httpupgrade' | 'xhttp' | 'hysteria';
type ServiceNodeTransportSettings = {
  version?: number;
  acceptProxyProtocol?: boolean;
  path?: string;
  host?: string;
  headers?: Record<string, string>;
  heartbeatPeriod?: number;
  serviceName?: string;
  authority?: string;
  multiMode?: boolean;
  mtu?: number;
  tti?: number;
  uplinkCapacity?: number;
  downlinkCapacity?: number;
  cwndMultiplier?: number;
  maxSendingWindow?: number;
  mode?: 'auto' | 'packet-up' | 'stream-up' | 'stream-one';
  xPaddingBytes?: string;
  scMaxBufferedPosts?: number;
  scStreamUpServerSecs?: string;
  udpIdleTimeout?: number;
};
type ServiceNodeConfig = {
  encryption?: string;
  transport?: ServiceNodeTransport;
  transportSettings?: ServiceNodeTransportSettings;
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
type CleanupResult = {
  skipped?: boolean;
  deleted?: boolean;
  alreadyAbsent?: boolean;
  synced?: boolean;
  action?: string;
  reason?: string;
  message?: string;
  verified?: { retried?: boolean; absent?: boolean };
  remoteClientCleanup?: CleanupResult;
};
type DeleteServiceNodeResult = {
  deleted: boolean;
  id: string;
  remoteClientCleanup?: CleanupResult;
  remoteConfigCleanup?: CleanupResult;
  remoteInboundCleanup?: CleanupResult;
};
type RemoteConfigSyncResult = {
  synced: boolean;
  action: string;
  serviceNodeId: string;
  inboundId?: number;
  inboundTag?: string;
  outboundTag?: string;
  socks?: { host?: string; port?: number; username?: string } | null;
};
type TrafficSyncItem = { target: string; updated: boolean; skipped?: boolean; message?: string };
type TrafficSyncResult = {
  synced: boolean;
  serviceNodeId: string;
  inboundId?: number;
  trafficLimitGb?: string | number;
  updated: number;
  skipped: number;
  failed: number;
  results?: TrafficSyncItem[];
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
const transportOptions = [
  { label: 'RAW / TCP', value: 'tcp' },
  { label: 'mKCP', value: 'kcp' },
  { label: 'WebSocket', value: 'ws' },
  { label: 'gRPC', value: 'grpc' },
  { label: 'HTTPUpgrade', value: 'httpupgrade' },
  { label: 'XHTTP', value: 'xhttp' }
];
const xhttpModeOptions = [
  { label: 'auto', value: 'auto' },
  { label: 'packet-up', value: 'packet-up' },
  { label: 'stream-up', value: 'stream-up' },
  { label: 'stream-one', value: 'stream-one' }
];

const servers = ref<XuiServer[]>([]);
const socksNodes = ref<SocksNode[]>([]);
const nodes = ref<ServiceNode[]>([]);
const loading = ref(false);
const saving = ref(false);
const syncingConfigIds = ref<Set<string>>(new Set());
const syncingTrafficLimitIds = ref<Set<string>>(new Set());
const resettingTrafficIds = ref<Set<string>>(new Set());
const togglingIds = ref<Set<string>>(new Set());
const error = ref('');
const searchQuery = ref('');
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
  transport: 'tcp' as ServiceNodeTransport,
  transportSettings: defaultTransportSettings(),
  priceMonthly: 0,
  trafficLimitGb: 0,
  enabled: true,
  socksRelayEnabled: false,
  socksNodeId: '',
  remark: ''
});

const enabledSocksNodes = computed(() => socksNodes.value.filter((item) => item.enabled));
const enabledNodeCount = computed(() => nodes.value.filter((item) => item.enabled).length);
const remoteManagedNodeCount = computed(() => nodes.value.filter((item) => item.config?.remoteManaged).length);
const socksRelayNodeCount = computed(() => nodes.value.filter((item) => item.config?.socksRelayEnabled).length);
const inboundReadyNodeCount = computed(() => nodes.value.filter((item) => item.inboundId).length);
const availableEncryptionOptions = computed(() => {
  if (form.protocol === 'hysteria') return encryptionOptions.filter((item) => item.value === 'tls');
  if (form.transport === 'kcp') return encryptionOptions.filter((item) => item.value === 'none');
  return encryptionOptions.filter((item) => {
    if (item.value !== 'reality') return true;
    return ['vless', 'trojan'].includes(form.protocol) && ['tcp', 'grpc', 'xhttp'].includes(form.transport);
  });
});
const filteredNodes = computed(() => {
  const keyword = searchQuery.value.trim().toLowerCase();
  if (!keyword) return nodes.value;
  return nodes.value.filter((node) => nodeSearchText(node).includes(keyword));
});

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
    error.value = err instanceof Error ? err.message : '加载路由节点失败';
  } finally {
    loading.value = false;
  }
}

async function saveNode() {
  saving.value = true;
  error.value = '';
  try {
    const path = editingId.value ? `/api/admin/service-nodes/${editingId.value}` : '/api/admin/service-nodes';
    await api(path, {
      method: editingId.value ? 'PATCH' : 'POST',
      body: { ...form, transportSettings: transportSettingsForSubmit() }
    });
    ElMessage.success(editingId.value ? '路由节点已更新' : '路由节点已添加');
    dialogVisible.value = false;
    resetForm();
    await loadNodes();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存路由节点失败';
  } finally {
    saving.value = false;
  }
}

async function syncRemoteConfig(node: ServiceNode) {
  await ElMessageBox.confirm(`确认把“${node.name}”的出站中转配置写入远端 Xray？系统只会管理本项目标记的出站和路由。`, '同步出站确认', { type: 'warning' });
  syncingConfigIds.value = new Set(syncingConfigIds.value).add(node.id);
  error.value = '';
  try {
    const result = await api<RemoteConfigSyncResult>(`/api/admin/service-nodes/${node.id}/sync-config`, { method: 'POST' });
    ElMessage.success(result.action === 'updated' ? '远端出站中转配置已同步' : '远端出站中转配置已清理');
    await showRemoteConfigResult(result);
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
    const result = await api<TrafficSyncResult>(`/api/admin/service-nodes/${node.id}/sync-traffic-limit`, { method: 'POST' });
    if (result.failed > 0) {
      ElMessage.warning(`流量额度已部分同步：成功 ${result.updated}，跳过 ${result.skipped}，失败 ${result.failed}`);
    } else {
      ElMessage.success(`流量额度已同步：成功 ${result.updated}，跳过 ${result.skipped}`);
    }
    await showTrafficSyncResult(result);
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
    transport: node.protocol === 'hysteria' ? 'hysteria' : config.transport || 'tcp',
    transportSettings: { ...defaultTransportSettings(), ...config.transportSettings },
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
  await ElMessageBox.confirm(`确认删除路由节点“${node.name}”？系统会先删除该节点下远端 3x-ui 客户端，并清理本项目写入的出站路由配置。`, '删除确认', { type: 'warning' });
  const result = await api<DeleteServiceNodeResult>(`/api/admin/service-nodes/${node.id}`, { method: 'DELETE' });
  ElMessage.success('路由节点已删除');
  await showDeleteResult(result);
  await loadNodes();
}

async function toggleNodeEnabled(node: ServiceNode, enabled: boolean | string | number) {
  const nextEnabled = Boolean(enabled);
  const previous = node.enabled;
  togglingIds.value = new Set(togglingIds.value).add(node.id);
  error.value = '';
  try {
    await api(`/api/admin/service-nodes/${node.id}`, { method: 'PATCH', body: { enabled: nextEnabled } });
    node.enabled = nextEnabled;
    ElMessage.success(nextEnabled ? '路由节点已启用' : '路由节点已停用');
  } catch (err) {
    node.enabled = previous;
    error.value = err instanceof Error ? err.message : '更新路由节点状态失败';
    ElMessage.error(error.value);
  } finally {
    const next = new Set(togglingIds.value);
    next.delete(node.id);
    togglingIds.value = next;
  }
}

async function showDeleteResult(result: DeleteServiceNodeResult) {
  const remoteClient = result.remoteInboundCleanup?.remoteClientCleanup || result.remoteClientCleanup;
  await ElMessageBox.alert([
    cleanupStatusLine('远端出站/路由配置', result.remoteConfigCleanup),
    cleanupStatusLine('远端入站', result.remoteInboundCleanup),
    cleanupStatusLine('远端客户端', remoteClient),
    result.deleted ? '本地路由节点和绑定：已清理' : '本地路由节点和绑定：未清理'
  ].join('\n'), '删除结果', { type: 'success' });
}

function cleanupStatusLine(label: string, result?: CleanupResult) {
  if (!result) return `${label}：没有返回结果`;
  if (result.skipped) return `${label}：已跳过（${result.reason || result.message || '-'}）`;
  if (result.synced) return `${label}：${result.action === 'removed' ? '已清理' : '已同步'}`;
  if (result.deleted && result.alreadyAbsent) return `${label}：远端已不存在，按删除成功处理`;
  if (result.deleted) return `${label}：已删除${result.verified?.retried ? '（复查后重试删除成功）' : ''}`;
  if (result.message) return `${label}：失败（${result.message}）`;
  return `${label}：已处理`;
}

async function showRemoteConfigResult(result: RemoteConfigSyncResult) {
  await ElMessageBox.alert([
    `远端状态：${result.synced ? '已同步' : '未同步'}`,
    `执行动作：${result.action === 'updated' ? '写入/更新出站路由' : '清理出站路由'}`,
    `入站 ID：${result.inboundId ?? '-'}`,
    `入站 Tag：${result.inboundTag || '-'}`,
    `出站 Tag：${result.outboundTag || '-'}`,
    `出站节点：${result.socks ? `${result.socks.host || '-'}:${result.socks.port || '-'}` : '未启用或已清理'}`
  ].join('\n'), '出站同步结果', { type: result.synced ? 'success' : 'warning' });
}

async function showTrafficSyncResult(result: TrafficSyncResult) {
  const lines = [
    `远端状态：${result.synced ? '已全部同步' : '部分失败'}`,
    `入站 ID：${result.inboundId ?? '-'}`,
    `流量额度：${result.trafficLimitGb ?? '-'} GB`,
    `汇总：成功 ${result.updated}，跳过 ${result.skipped}，失败 ${result.failed}`
  ];
  const items = (result.results || []).slice(0, 8).map((item) => {
    const status = item.updated ? '成功' : item.skipped ? '跳过' : '失败';
    return `${item.target}：${status}${item.message ? `（${item.message}）` : ''}`;
  });
  if (items.length) lines.push('', ...items);
  if ((result.results || []).length > items.length) lines.push(`还有 ${(result.results || []).length - items.length} 条结果未显示`);
  await ElMessageBox.alert(lines.join('\n'), '流量同步结果', { type: result.failed > 0 ? 'warning' : 'success' });
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
    transport: 'tcp',
    transportSettings: defaultTransportSettings(),
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

function defaultTransportSettings(): ServiceNodeTransportSettings {
  return {
    acceptProxyProtocol: false,
    path: '/',
    host: '',
    headers: {},
    heartbeatPeriod: 0,
    serviceName: '',
    authority: '',
    multiMode: false,
    mtu: 1350,
    tti: 20,
    uplinkCapacity: 5,
    downlinkCapacity: 20,
    cwndMultiplier: 1,
    maxSendingWindow: 2097152,
    mode: 'auto',
    xPaddingBytes: '100-1000',
    scMaxBufferedPosts: 30,
    scStreamUpServerSecs: '20-80',
    udpIdleTimeout: 60
  };
}

function transportSettingsForSubmit(): ServiceNodeTransportSettings {
  const settings = form.transportSettings;
  if (form.protocol === 'hysteria') return settings.udpIdleTimeout === 60 ? {} : { version: 2, udpIdleTimeout: settings.udpIdleTimeout };
  if (form.transport === 'tcp') return settings.acceptProxyProtocol ? { acceptProxyProtocol: true } : {};
  if (form.transport === 'kcp') return {
    ...(settings.mtu === 1350 ? {} : { mtu: settings.mtu }),
    ...(settings.tti === 20 ? {} : { tti: settings.tti }),
    ...(settings.uplinkCapacity === 5 ? {} : { uplinkCapacity: settings.uplinkCapacity }),
    ...(settings.downlinkCapacity === 20 ? {} : { downlinkCapacity: settings.downlinkCapacity }),
    ...(settings.cwndMultiplier === 1 ? {} : { cwndMultiplier: settings.cwndMultiplier }),
    ...(settings.maxSendingWindow === 2097152 ? {} : { maxSendingWindow: settings.maxSendingWindow })
  };
  if (form.transport === 'ws') return {
    ...(settings.path === '/' ? {} : { path: settings.path }),
    ...(settings.host ? { host: settings.host } : {}),
    ...(settings.headers && Object.keys(settings.headers).length ? { headers: settings.headers } : {}),
    ...(settings.heartbeatPeriod ? { heartbeatPeriod: settings.heartbeatPeriod } : {}),
    ...(settings.acceptProxyProtocol ? { acceptProxyProtocol: true } : {})
  };
  if (form.transport === 'grpc') return {
    ...(settings.serviceName ? { serviceName: settings.serviceName } : {}),
    ...(settings.authority ? { authority: settings.authority } : {}),
    ...(settings.multiMode ? { multiMode: true } : {})
  };
  if (form.transport === 'httpupgrade') return {
    ...(settings.path === '/' ? {} : { path: settings.path }),
    ...(settings.host ? { host: settings.host } : {}),
    ...(settings.headers && Object.keys(settings.headers).length ? { headers: settings.headers } : {}),
    ...(settings.acceptProxyProtocol ? { acceptProxyProtocol: true } : {})
  };
  return {
    ...(settings.path === '/' ? {} : { path: settings.path }),
    ...(settings.host ? { host: settings.host } : {}),
    ...(settings.headers && Object.keys(settings.headers).length ? { headers: settings.headers } : {}),
    ...(settings.mode === 'auto' ? {} : { mode: settings.mode }),
    ...(settings.xPaddingBytes === '100-1000' ? {} : { xPaddingBytes: settings.xPaddingBytes }),
    ...(settings.scMaxBufferedPosts === 30 ? {} : { scMaxBufferedPosts: settings.scMaxBufferedPosts }),
    ...(settings.scStreamUpServerSecs === '20-80' ? {} : { scStreamUpServerSecs: settings.scStreamUpServerSecs })
  };
}

function transportLabel(node: ServiceNode) {
  const transport = node.protocol === 'hysteria' ? 'hysteria' : node.config?.transport || 'tcp';
  return transport === 'hysteria'
    ? 'Hysteria'
    : transportOptions.find((item) => item.value === transport)?.label || transport;
}

function nodeSearchText(node: ServiceNode) {
  return [
    node.name,
    node.server?.name,
    node.protocol,
    node.config?.encryption,
    transportLabel(node),
    node.config?.remoteManaged ? '自动创建' : '绑定已有',
    node.inboundId,
    node.priceMonthly,
    node.trafficLimitGb,
    node.remark,
    socksLabel(node.config?.socksNodeId)
  ].filter(Boolean).join(' ').toLowerCase();
}

watch(() => [form.protocol, form.transport] as const, () => {
  if (form.protocol === 'hysteria') {
    form.transport = 'hysteria';
    form.encryption = 'tls';
    return;
  }
  if (form.transport === 'hysteria') form.transport = 'tcp';
  if (!availableEncryptionOptions.value.some((item) => item.value === form.encryption)) form.encryption = 'none';
});

onMounted(loadNodes);
</script>

<template>
  <div class="page-head">
    <div class="page-head-main">
      <h1 class="page-title">路由节点</h1>
      <p>管理本地可售节点、远端入站、传输安全和出站中转配置。</p>
    </div>
    <div class="page-actions">
      <el-button :loading="loading" @click="loadNodes"><RefreshCw :size="15" />刷新</el-button>
    </div>
  </div>
  <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="page-alert" />

  <div class="metric-grid compact-metrics">
    <div class="metric"><span>路由节点</span><strong>{{ nodes.length }}</strong><small>启用 {{ enabledNodeCount }}</small></div>
    <div class="metric"><span>远端入站</span><strong>{{ inboundReadyNodeCount }}</strong><small>已有入站 ID</small></div>
    <div class="metric"><span>自动创建</span><strong>{{ remoteManagedNodeCount }}</strong><small>由本系统管理远端</small></div>
    <div class="metric"><span>出站中转</span><strong>{{ socksRelayNodeCount }}</strong><small>启用 SOCKS 出站</small></div>
  </div>

  <div class="panel list-panel">
    <div class="panel-toolbar">
      <strong>路由节点列表</strong>
      <div class="table-toolbar-actions">
        <el-button type="primary" @click="openDialog"><Plus :size="15" />添加路由节点</el-button>
      </div>
    </div>
    <div class="filter-bar">
      <el-input v-model="searchQuery" clearable placeholder="搜索节点、面板连接、入站 ID、协议、传输类型" style="max-width: 380px">
        <template #prefix><Search :size="15" /></template>
      </el-input>
      <span class="filter-summary">显示 {{ filteredNodes.length }} / {{ nodes.length }}</span>
    </div>
    <div v-loading="loading" class="entity-card-grid node-card-grid">
      <article v-for="node in filteredNodes" :key="node.id" class="entity-card node-card">
        <div class="entity-card-head">
          <div>
            <strong>{{ node.name }}</strong>
            <span>{{ node.server?.name || '-' }} · 入站 ID {{ node.inboundId ?? '-' }}</span>
          </div>
          <div class="tag-stack">
            <el-switch v-model="node.enabled" size="small" :loading="togglingIds.has(node.id)" @change="(value: boolean | string | number) => toggleNodeEnabled(node, value)" />
            <el-tag size="small" :type="node.config?.remoteManaged ? 'success' : 'info'">{{ remoteModeLabel(node) }}</el-tag>
          </div>
        </div>
        <div class="entity-card-stats">
          <div><span>协议</span><strong>{{ node.protocol }}</strong></div>
          <div><span>传输</span><strong>{{ transportLabel(node) }}</strong></div>
          <div><span>安全</span><strong>{{ node.protocol === 'hysteria' ? 'tls' : node.config?.encryption || 'none' }}</strong></div>
          <div><span>月价格</span><strong>{{ node.priceMonthly }}</strong></div>
          <div><span>流量</span><strong>{{ node.trafficLimitGb }} GB</strong></div>
        </div>
        <div class="entity-card-meta">
          <span>出站中转：{{ node.config?.socksRelayEnabled ? socksLabel(node.config.socksNodeId) : '未启用' }}</span>
          <span v-if="node.remark">{{ node.remark }}</span>
        </div>
        <div class="entity-card-actions split-card-actions">
          <div class="row-action-group remote-action">
            <span class="action-group-label">远端同步</span>
            <el-button size="small" :loading="syncingConfigIds.has(node.id)" :disabled="!node.inboundId" @click="syncRemoteConfig(node)"><UploadCloud :size="15" />出站</el-button>
            <el-button size="small" :loading="syncingTrafficLimitIds.has(node.id)" :disabled="!node.inboundId" @click="syncTrafficLimit(node)"><Gauge :size="15" />流量额度</el-button>
            <el-button size="small" :loading="resettingTrafficIds.has(node.id)" :disabled="!node.inboundId" @click="resetRemoteTraffic(node)"><RotateCcw :size="15" />重置流量</el-button>
          </div>
          <div class="row-action-group manage-action">
            <span class="action-group-label">管理</span>
            <el-button size="small" @click="editNode(node)"><Edit3 :size="15" />编辑</el-button>
            <el-button size="small" type="danger" plain @click="removeNode(node)"><Trash2 :size="15" />删除</el-button>
          </div>
        </div>
      </article>
      <div v-if="!filteredNodes.length && !loading" class="empty-panel entity-empty">暂无路由节点</div>
    </div>
  </div>

  <el-dialog v-model="dialogVisible" :title="editingId ? '编辑路由节点' : '添加路由节点'" width="min(920px, 94vw)" destroy-on-close>
    <el-form :model="form" label-width="112px" class="sectioned-dialog-form">
      <section class="dialog-form-section">
        <div class="dialog-section-head"><strong>基础信息</strong><span>节点名称、所属面板连接和启用状态</span></div>
        <div class="dialog-form-grid">
          <el-form-item label="节点名称"><el-input v-model="form.name" /></el-form-item>
          <el-form-item label="面板连接">
            <el-select v-model="form.serverId" placeholder="选择服务器" style="width: 100%">
              <el-option v-for="server in servers" :key="server.id" :label="server.name" :value="server.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="启用节点"><el-switch v-model="form.enabled" /></el-form-item>
        </div>
      </section>

      <section class="dialog-form-section">
        <div class="dialog-section-head"><strong>远端入站</strong><span>自动创建会让远端返回入站 ID；绑定已有需要填写远端入站 ID</span></div>
        <div class="dialog-form-grid">
          <el-form-item label="远端入站">
            <el-segmented v-model="form.remoteMode" :options="[{ label: '自动创建', value: 'create' }, { label: '绑定已有', value: 'bind' }]" />
          </el-form-item>
          <el-form-item v-if="form.remoteMode === 'bind'" label="入站 ID"><el-input-number v-model="form.inboundId" :min="1" style="width: 100%" /></el-form-item>
          <el-form-item v-else label="端口">
            <el-input-number v-model="form.inboundPort" :min="1" :max="65535" placeholder="自动分配" style="width: 100%" />
          </el-form-item>
        </div>
      </section>

      <section class="dialog-form-section">
        <div class="dialog-section-head"><strong>协议与传输</strong><span>传输方式和安全组合按 3x-ui 3.5.0 规则提供</span></div>
        <div class="dialog-form-grid">
          <el-form-item label="节点类型">
            <el-select v-model="form.protocol" style="width: 100%">
              <el-option v-for="item in protocolOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="传输类型">
            <el-input v-if="form.protocol === 'hysteria'" model-value="Hysteria（固定）" disabled />
            <el-select v-else v-model="form.transport" style="width: 100%">
              <el-option v-for="item in transportOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="传输安全">
            <el-select v-model="form.encryption" :disabled="form.protocol === 'hysteria'" style="width: 100%">
              <el-option v-for="item in availableEncryptionOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
        </div>
      </section>

      <section class="dialog-form-section">
        <div class="dialog-section-head"><strong>传输参数</strong><span>仅显示当前传输在 3x-ui 3.5.0 文档中的常用设置</span></div>
        <div class="dialog-form-grid">
          <template v-if="form.protocol === 'hysteria'">
            <el-form-item label="协议版本"><el-input model-value="2" disabled /></el-form-item>
            <el-form-item label="UDP 空闲秒数"><el-input-number v-model="form.transportSettings.udpIdleTimeout" :min="2" :max="600" style="width: 100%" /></el-form-item>
          </template>
          <template v-else-if="form.transport === 'tcp'">
            <el-form-item label="PROXY 协议"><el-switch v-model="form.transportSettings.acceptProxyProtocol" /></el-form-item>
          </template>
          <template v-else-if="form.transport === 'kcp'">
            <el-form-item label="MTU"><el-input-number v-model="form.transportSettings.mtu" :min="576" :max="1460" style="width: 100%" /></el-form-item>
            <el-form-item label="TTI 毫秒"><el-input-number v-model="form.transportSettings.tti" :min="10" :max="100" style="width: 100%" /></el-form-item>
            <el-form-item label="上行 MB/s"><el-input-number v-model="form.transportSettings.uplinkCapacity" :min="0" style="width: 100%" /></el-form-item>
            <el-form-item label="下行 MB/s"><el-input-number v-model="form.transportSettings.downlinkCapacity" :min="0" style="width: 100%" /></el-form-item>
            <el-form-item label="拥塞窗口倍数"><el-input-number v-model="form.transportSettings.cwndMultiplier" :min="1" style="width: 100%" /></el-form-item>
            <el-form-item label="最大发送窗口"><el-input-number v-model="form.transportSettings.maxSendingWindow" :min="0" style="width: 100%" /></el-form-item>
          </template>
          <template v-else-if="form.transport === 'ws'">
            <el-form-item label="路径"><el-input v-model="form.transportSettings.path" placeholder="/" /></el-form-item>
            <el-form-item label="Host"><el-input v-model="form.transportSettings.host" /></el-form-item>
            <el-form-item label="心跳秒数"><el-input-number v-model="form.transportSettings.heartbeatPeriod" :min="0" style="width: 100%" /></el-form-item>
            <el-form-item label="PROXY 协议"><el-switch v-model="form.transportSettings.acceptProxyProtocol" /></el-form-item>
          </template>
          <template v-else-if="form.transport === 'grpc'">
            <el-form-item label="服务名称"><el-input v-model="form.transportSettings.serviceName" /></el-form-item>
            <el-form-item label="Authority"><el-input v-model="form.transportSettings.authority" /></el-form-item>
            <el-form-item label="多流模式"><el-switch v-model="form.transportSettings.multiMode" /></el-form-item>
          </template>
          <template v-else-if="form.transport === 'httpupgrade'">
            <el-form-item label="路径"><el-input v-model="form.transportSettings.path" placeholder="/" /></el-form-item>
            <el-form-item label="Host"><el-input v-model="form.transportSettings.host" /></el-form-item>
            <el-form-item label="PROXY 协议"><el-switch v-model="form.transportSettings.acceptProxyProtocol" /></el-form-item>
          </template>
          <template v-else-if="form.transport === 'xhttp'">
            <el-form-item label="路径"><el-input v-model="form.transportSettings.path" placeholder="/" /></el-form-item>
            <el-form-item label="Host"><el-input v-model="form.transportSettings.host" /></el-form-item>
            <el-form-item label="模式">
              <el-select v-model="form.transportSettings.mode" style="width: 100%">
                <el-option v-for="item in xhttpModeOptions" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </el-form-item>
            <el-form-item label="填充范围"><el-input v-model="form.transportSettings.xPaddingBytes" /></el-form-item>
            <el-form-item label="缓冲 POST 数"><el-input-number v-model="form.transportSettings.scMaxBufferedPosts" :min="0" style="width: 100%" /></el-form-item>
            <el-form-item label="上传窗口秒"><el-input v-model="form.transportSettings.scStreamUpServerSecs" /></el-form-item>
          </template>
        </div>
      </section>

      <section class="dialog-form-section">
        <div class="dialog-section-head"><strong>出站中转</strong><span>启用后可把该入站流量转发到已配置的出站节点</span></div>
        <div class="dialog-form-grid">
          <el-form-item label="启用出站"><el-switch v-model="form.socksRelayEnabled" /></el-form-item>
          <el-form-item label="出站节点">
            <el-select v-model="form.socksNodeId" :disabled="!form.socksRelayEnabled" placeholder="选择出站节点" style="width: 100%">
              <el-option v-for="node in enabledSocksNodes" :key="node.id" :label="`${node.name} (${node.host}:${node.port})`" :value="node.id" />
            </el-select>
          </el-form-item>
        </div>
      </section>

      <section class="dialog-form-section">
        <div class="dialog-section-head"><strong>计费与备注</strong><span>用户端展示价格，流量额度会同步到远端已有客户端</span></div>
        <div class="dialog-form-grid">
          <el-form-item label="月价格"><el-input-number v-model="form.priceMonthly" :min="0" :precision="2" style="width: 100%" /></el-form-item>
          <el-form-item label="流量 GB"><el-input-number v-model="form.trafficLimitGb" :min="0" :precision="2" style="width: 100%" /></el-form-item>
          <el-form-item label="备注" class="form-item-full"><el-input v-model="form.remark" /></el-form-item>
        </div>
      </section>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!form.name || !form.serverId || (form.remoteMode === 'bind' && !form.inboundId) || (form.socksRelayEnabled && !form.socksNodeId)" @click="saveNode">保存</el-button>
    </template>
  </el-dialog>
</template>
