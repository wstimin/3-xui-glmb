<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { RefreshCw, Wifi } from 'lucide-vue-next';
import { api } from '../api';

type XuiServer = {
  id: string;
  name: string;
  baseUrl: string;
  basePath?: string | null;
  username?: string | null;
  enabled: boolean;
  remark?: string | null;
  hasPassword?: boolean;
  hasToken?: boolean;
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
  server?: XuiServer;
};

type SyncResult = { total: number; success: number; failed: number };

const servers = ref<XuiServer[]>([]);
const nodes = ref<ServiceNode[]>([]);
const loading = ref(false);
const savingServer = ref(false);
const savingNode = ref(false);
const testingFormServer = ref(false);
const testingServerIds = ref<Set<string>>(new Set());
const syncingNodeIds = ref<Set<string>>(new Set());
const error = ref('');
const editingServerId = ref('');
const editingNodeId = ref('');
const serverForm = reactive({ name: '', baseUrl: '', basePath: '', username: '', password: '', token: '', enabled: true, remark: '' });
const nodeForm = reactive({ name: '', serverId: '', inboundId: undefined as number | undefined, protocol: 'vless', priceMonthly: 0, trafficLimitGb: 0, enabled: true, remark: '' });

const currentServer = computed(() => servers.value.find((server) => server.id === nodeForm.serverId));

async function loadNodes() {
  loading.value = true;
  error.value = '';
  try {
    const [serverList, nodeList] = await Promise.all([
      api<XuiServer[]>('/api/admin/xui-servers'),
      api<ServiceNode[]>('/api/admin/service-nodes')
    ]);
    servers.value = serverList;
    nodes.value = nodeList;
    if (!nodeForm.serverId && serverList[0]) nodeForm.serverId = serverList[0].id;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载节点配置失败';
  } finally {
    loading.value = false;
  }
}

async function saveServer() {
  savingServer.value = true;
  error.value = '';
  try {
    const path = editingServerId.value ? `/api/admin/xui-servers/${editingServerId.value}` : '/api/admin/xui-servers';
    await api(path, { method: editingServerId.value ? 'PATCH' : 'POST', body: serverForm });
    ElMessage.success(editingServerId.value ? '3x-ui 服务器已更新' : '3x-ui 服务器已新增');
    resetServerForm();
    await loadNodes();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存 3x-ui 服务器失败';
  } finally {
    savingServer.value = false;
  }
}

async function testServerForm() {
  testingFormServer.value = true;
  error.value = '';
  try {
    const result = await api<{ connected: boolean; inbounds: unknown }>('/api/admin/xui/test', { method: 'POST', body: serverForm });
    const inboundCount = Array.isArray(result.inbounds) ? result.inbounds.length : '-';
    ElMessage.success(`连接成功，入站数量：${inboundCount}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : '测试连接失败';
  } finally {
    testingFormServer.value = false;
  }
}

async function testSavedServer(server: XuiServer) {
  testingServerIds.value = new Set(testingServerIds.value).add(server.id);
  error.value = '';
  try {
    const result = await api<{ inboundCount: number }>(`/api/admin/xui-servers/${server.id}/test`, { method: 'POST' });
    ElMessage.success(`${server.name} 连接成功，入站数量：${result.inboundCount}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : '测试已保存服务器失败';
  } finally {
    const next = new Set(testingServerIds.value);
    next.delete(server.id);
    testingServerIds.value = next;
  }
}

async function saveServiceNode() {
  savingNode.value = true;
  error.value = '';
  try {
    const path = editingNodeId.value ? `/api/admin/service-nodes/${editingNodeId.value}` : '/api/admin/service-nodes';
    await api(path, { method: editingNodeId.value ? 'PATCH' : 'POST', body: nodeForm });
    ElMessage.success(editingNodeId.value ? '服务节点已更新' : '服务节点已新增');
    resetNodeForm();
    await loadNodes();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存服务节点失败';
  } finally {
    savingNode.value = false;
  }
}

async function syncServiceNode(node: ServiceNode) {
  await ElMessageBox.confirm(`确认把「${node.name}」下已绑定用户同步到远端 3x-ui？`, '同步确认', { type: 'warning' });
  syncingNodeIds.value = new Set(syncingNodeIds.value).add(node.id);
  error.value = '';
  try {
    const result = await api<SyncResult>(`/api/admin/service-nodes/${node.id}/sync`, { method: 'POST' });
    ElMessage.success(`同步完成：成功 ${result.success}，失败 ${result.failed}，总数 ${result.total}`);
    await loadNodes();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '同步服务节点失败';
  } finally {
    const next = new Set(syncingNodeIds.value);
    next.delete(node.id);
    syncingNodeIds.value = next;
  }
}

function editServer(server: XuiServer) {
  editingServerId.value = server.id;
  Object.assign(serverForm, {
    name: server.name,
    baseUrl: server.baseUrl,
    basePath: server.basePath || '',
    username: server.username || '',
    password: '',
    token: '',
    enabled: server.enabled,
    remark: server.remark || ''
  });
}

function editServiceNode(node: ServiceNode) {
  editingNodeId.value = node.id;
  Object.assign(nodeForm, {
    name: node.name,
    serverId: node.serverId,
    inboundId: node.inboundId ?? undefined,
    protocol: node.protocol,
    priceMonthly: Number(node.priceMonthly),
    trafficLimitGb: Number(node.trafficLimitGb),
    enabled: node.enabled,
    remark: node.remark || ''
  });
}

async function removeServer(server: XuiServer) {
  await ElMessageBox.confirm(`确认删除服务器「${server.name}」？有关联服务节点时数据库会拒绝删除，请先处理节点。`, '删除确认', { type: 'warning' });
  await api(`/api/admin/xui-servers/${server.id}`, { method: 'DELETE' });
  ElMessage.success('服务器已删除');
  if (editingServerId.value === server.id) resetServerForm();
  await loadNodes();
}

async function removeServiceNode(node: ServiceNode) {
  await ElMessageBox.confirm(`确认删除节点「${node.name}」？系统会先删除该节点下所有远端 3x-ui 客户端，再删除本地绑定记录和节点。`, '删除确认', { type: 'warning' });
  await api(`/api/admin/service-nodes/${node.id}`, { method: 'DELETE' });
  ElMessage.success('节点已删除');
  if (editingNodeId.value === node.id) resetNodeForm();
  await loadNodes();
}

function resetServerForm() {
  editingServerId.value = '';
  Object.assign(serverForm, { name: '', baseUrl: '', basePath: '', username: '', password: '', token: '', enabled: true, remark: '' });
}

function resetNodeForm() {
  editingNodeId.value = '';
  Object.assign(nodeForm, { name: '', serverId: servers.value[0]?.id || '', inboundId: undefined, protocol: 'vless', priceMonthly: 0, trafficLimitGb: 0, enabled: true, remark: '' });
}

onMounted(loadNodes);
</script>

<template>
  <h1 class="page-title">节点管理</h1>
  <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="page-alert" />

  <div class="panel node-grid">
    <section>
      <div class="panel-toolbar">
        <h2>3x-ui 服务器</h2>
        <el-button size="small" @click="resetServerForm">新增</el-button>
      </div>
      <el-form :model="serverForm" label-width="92px">
        <el-form-item label="名称"><el-input v-model="serverForm.name" /></el-form-item>
        <el-form-item label="面板地址"><el-input v-model="serverForm.baseUrl" placeholder="https://xui.example.com" /></el-form-item>
        <el-form-item label="面板路径"><el-input v-model="serverForm.basePath" placeholder="例如 /panel，根路径可留空" /></el-form-item>
        <el-form-item label="账号"><el-input v-model="serverForm.username" /></el-form-item>
        <el-form-item label="密码"><el-input v-model="serverForm.password" type="password" show-password placeholder="编辑时留空表示不修改" /></el-form-item>
        <el-form-item label="API Token"><el-input v-model="serverForm.token" type="password" show-password placeholder="编辑时留空表示不修改" /></el-form-item>
        <el-form-item label="启用"><el-switch v-model="serverForm.enabled" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="serverForm.remark" /></el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="savingServer" :disabled="!serverForm.name || !serverForm.baseUrl" @click="saveServer">{{ editingServerId ? '保存服务器' : '新增服务器' }}</el-button>
          <el-button :loading="testingFormServer" :disabled="!serverForm.baseUrl" @click="testServerForm"><Wifi :size="15" />测试连接</el-button>
        </el-form-item>
      </el-form>
    </section>

    <section>
      <div class="panel-toolbar">
        <h2>服务节点</h2>
        <el-button size="small" @click="resetNodeForm">新增</el-button>
      </div>
      <el-form :model="nodeForm" label-width="92px">
        <el-form-item label="节点名称"><el-input v-model="nodeForm.name" /></el-form-item>
        <el-form-item label="服务器">
          <el-select v-model="nodeForm.serverId" placeholder="选择 3x-ui 服务器" style="width: 100%">
            <el-option v-for="server in servers" :key="server.id" :label="server.name" :value="server.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="入站 ID"><el-input-number v-model="nodeForm.inboundId" :min="0" style="width: 100%" /></el-form-item>
        <el-form-item label="协议"><el-input v-model="nodeForm.protocol" placeholder="vless / vmess / trojan" /></el-form-item>
        <el-form-item label="月价格"><el-input-number v-model="nodeForm.priceMonthly" :min="0" :precision="2" style="width: 100%" /></el-form-item>
        <el-form-item label="流量 GB"><el-input-number v-model="nodeForm.trafficLimitGb" :min="0" :precision="2" style="width: 100%" /></el-form-item>
        <el-form-item label="启用"><el-switch v-model="nodeForm.enabled" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="nodeForm.remark" /></el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="savingNode" :disabled="!nodeForm.name || !nodeForm.serverId" @click="saveServiceNode">{{ editingNodeId ? '保存节点' : '新增节点' }}</el-button>
          <span v-if="currentServer" class="muted-text">绑定到 {{ currentServer.name }}</span>
        </el-form-item>
      </el-form>
    </section>
  </div>

  <div class="panel list-panel">
    <div class="panel-toolbar">
      <strong>服务器列表</strong>
      <el-button size="small" :loading="loading" @click="loadNodes">刷新</el-button>
    </div>
    <el-table :data="servers" v-loading="loading" style="width: 100%">
      <el-table-column prop="name" label="名称" min-width="140" />
      <el-table-column prop="baseUrl" label="地址" min-width="220" />
      <el-table-column prop="basePath" label="路径" width="120" />
      <el-table-column label="凭据" width="150">
        <template #default="{ row }: { row: XuiServer }">
          <el-tag v-if="row.hasToken" size="small" type="success">Token</el-tag>
          <el-tag v-else-if="row.hasPassword" size="small">账号密码</el-tag>
          <el-tag v-else size="small" type="warning">未配置</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90"><template #default="{ row }: { row: XuiServer }"><el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag></template></el-table-column>
      <el-table-column label="操作" width="230" fixed="right">
        <template #default="{ row }: { row: XuiServer }">
          <el-button size="small" :loading="testingServerIds.has(row.id)" @click="testSavedServer(row)">测试</el-button>
          <el-button size="small" @click="editServer(row)">编辑</el-button>
          <el-button size="small" type="danger" @click="removeServer(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>

  <div class="panel list-panel">
    <div class="panel-toolbar"><strong>节点列表</strong></div>
    <el-table :data="nodes" v-loading="loading" style="width: 100%">
      <el-table-column prop="name" label="名称" min-width="140" />
      <el-table-column label="服务器" min-width="140"><template #default="{ row }: { row: ServiceNode }">{{ row.server?.name || '-' }}</template></el-table-column>
      <el-table-column prop="inboundId" label="入站 ID" width="100" />
      <el-table-column prop="protocol" label="协议" width="100" />
      <el-table-column prop="priceMonthly" label="月价格" width="110" />
      <el-table-column prop="trafficLimitGb" label="流量 GB" width="110" />
      <el-table-column label="状态" width="90"><template #default="{ row }: { row: ServiceNode }"><el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag></template></el-table-column>
      <el-table-column label="操作" width="260" fixed="right">
        <template #default="{ row }: { row: ServiceNode }">
          <el-button size="small" :loading="syncingNodeIds.has(row.id)" :disabled="!row.inboundId" @click="syncServiceNode(row)"><RefreshCw :size="15" />同步远端</el-button>
          <el-button size="small" @click="editServiceNode(row)">编辑</el-button>
          <el-button size="small" type="danger" @click="removeServiceNode(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>
