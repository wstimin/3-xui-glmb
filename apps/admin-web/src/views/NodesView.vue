<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api';

type XuiServer = { id: string; name: string; baseUrl: string; username?: string | null; enabled: boolean; remark?: string | null; hasPassword?: boolean; hasToken?: boolean };
type ServiceNode = { id: string; serverId: string; name: string; protocol: string; priceMonthly: string; trafficLimitGb: string; enabled: boolean; inboundId?: number | null; remark?: string | null; server?: XuiServer };

const servers = ref<XuiServer[]>([]);
const nodes = ref<ServiceNode[]>([]);
const loading = ref(false);
const savingServer = ref(false);
const savingNode = ref(false);
const testingServer = ref(false);
const error = ref('');
const editingServerId = ref('');
const editingNodeId = ref('');
const serverForm = reactive({ name: '', baseUrl: '', username: '', password: '', token: '', enabled: true, remark: '' });
const nodeForm = reactive({ name: '', serverId: '', inboundId: undefined as number | undefined, protocol: 'vless', priceMonthly: 0, trafficLimitGb: 0, enabled: true, remark: '' });
const serverOptions = computed(() => servers.value.map((server) => ({ label: server.name, value: server.id })));

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
    error.value = err instanceof Error ? err.message : '加载失败';
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
    ElMessage.success(editingServerId.value ? '3x-ui 服务器已更新' : '3x-ui 服务器已保存');
    resetServerForm();
    await loadNodes();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存服务器失败';
  } finally {
    savingServer.value = false;
  }
}

async function testServer() {
  testingServer.value = true;
  error.value = '';
  try {
    const result = await api<{ connected: boolean; inbounds: unknown }>('/api/admin/xui/test', { method: 'POST', body: serverForm });
    const inboundCount = Array.isArray(result.inbounds) ? result.inbounds.length : '-';
    ElMessage.success(`连接成功，入站数量：${inboundCount}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : '测试连接失败';
  } finally {
    testingServer.value = false;
  }
}

async function saveServiceNode() {
  savingNode.value = true;
  error.value = '';
  try {
    const path = editingNodeId.value ? `/api/admin/service-nodes/${editingNodeId.value}` : '/api/admin/service-nodes';
    await api(path, { method: editingNodeId.value ? 'PATCH' : 'POST', body: nodeForm });
    ElMessage.success(editingNodeId.value ? '服务节点已更新' : '服务节点已保存');
    resetNodeForm();
    await loadNodes();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存节点失败';
  } finally {
    savingNode.value = false;
  }
}

function editServer(server: XuiServer) {
  editingServerId.value = server.id;
  Object.assign(serverForm, {
    name: server.name,
    baseUrl: server.baseUrl,
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
  await ElMessageBox.confirm(`确认删除服务器「${server.name}」？关联服务节点也会被删除。`, '删除确认', { type: 'warning' });
  await api(`/api/admin/xui-servers/${server.id}`, { method: 'DELETE' });
  ElMessage.success('服务器已删除');
  if (editingServerId.value === server.id) resetServerForm();
  await loadNodes();
}

async function removeServiceNode(node: ServiceNode) {
  await ElMessageBox.confirm(`确认删除节点「${node.name}」？`, '删除确认', { type: 'warning' });
  await api(`/api/admin/service-nodes/${node.id}`, { method: 'DELETE' });
  ElMessage.success('节点已删除');
  if (editingNodeId.value === node.id) resetNodeForm();
  await loadNodes();
}

function resetServerForm() {
  editingServerId.value = '';
  Object.assign(serverForm, { name: '', baseUrl: '', username: '', password: '', token: '', enabled: true, remark: '' });
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
      <el-form :model="serverForm" label-width="82px">
        <el-form-item label="名称"><el-input v-model="serverForm.name" /></el-form-item>
        <el-form-item label="地址"><el-input v-model="serverForm.baseUrl" placeholder="https://xui.example.com" /></el-form-item>
        <el-form-item label="账号"><el-input v-model="serverForm.username" /></el-form-item>
        <el-form-item label="密码"><el-input v-model="serverForm.password" type="password" show-password placeholder="编辑时留空表示不修改" /></el-form-item>
        <el-form-item label="API Token"><el-input v-model="serverForm.token" type="password" show-password placeholder="编辑时留空表示不修改" /></el-form-item>
        <el-form-item label="启用"><el-switch v-model="serverForm.enabled" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="serverForm.remark" /></el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="savingServer" @click="saveServer">{{ editingServerId ? '保存服务器' : '新增服务器' }}</el-button>
          <el-button :loading="testingServer" :disabled="!serverForm.baseUrl" @click="testServer">测试连接</el-button>
        </el-form-item>
      </el-form>
    </section>

    <section>
      <div class="panel-toolbar">
        <h2>服务节点</h2>
        <el-button size="small" @click="resetNodeForm">新增</el-button>
      </div>
      <el-form :model="nodeForm" label-width="82px">
        <el-form-item label="名称"><el-input v-model="nodeForm.name" /></el-form-item>
        <el-form-item label="服务器"><el-select v-model="nodeForm.serverId" :options="serverOptions" style="width: 100%" /></el-form-item>
        <el-form-item label="入站 ID"><el-input-number v-model="nodeForm.inboundId" :min="0" style="width: 100%" /></el-form-item>
        <el-form-item label="协议"><el-input v-model="nodeForm.protocol" /></el-form-item>
        <el-form-item label="月价"><el-input-number v-model="nodeForm.priceMonthly" :min="0" :precision="2" style="width: 100%" /></el-form-item>
        <el-form-item label="流量 GB"><el-input-number v-model="nodeForm.trafficLimitGb" :min="0" :precision="2" style="width: 100%" /></el-form-item>
        <el-form-item label="启用"><el-switch v-model="nodeForm.enabled" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="nodeForm.remark" /></el-form-item>
        <el-form-item><el-button type="primary" :loading="savingNode" :disabled="!nodeForm.serverId" @click="saveServiceNode">{{ editingNodeId ? '保存节点' : '新增节点' }}</el-button></el-form-item>
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
      <el-table-column label="凭据" width="160">
        <template #default="{ row }: { row: XuiServer }">
          <el-tag v-if="row.hasToken" size="small" type="success">Token</el-tag>
          <el-tag v-else-if="row.hasPassword" size="small">账号密码</el-tag>
          <el-tag v-else size="small" type="warning">未配置</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100"><template #default="{ row }: { row: XuiServer }"><el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag></template></el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }: { row: XuiServer }">
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
      <el-table-column label="服务器" min-width="140"><template #default="{ row }">{{ row.server?.name || '-' }}</template></el-table-column>
      <el-table-column prop="inboundId" label="入站 ID" width="100" />
      <el-table-column prop="protocol" label="协议" width="100" />
      <el-table-column prop="priceMonthly" label="月价" width="120" />
      <el-table-column prop="trafficLimitGb" label="流量 GB" width="120" />
      <el-table-column label="状态" width="100"><template #default="{ row }: { row: ServiceNode }"><el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag></template></el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }: { row: ServiceNode }">
          <el-button size="small" @click="editServiceNode(row)">编辑</el-button>
          <el-button size="small" type="danger" @click="removeServiceNode(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>
