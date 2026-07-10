<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api';

type XuiServer = { id: string; name: string; baseUrl: string; enabled: boolean; hasPassword?: boolean; hasToken?: boolean };
type ServiceNode = { id: string; name: string; protocol: string; priceMonthly: string; trafficLimitGb: string; enabled: boolean; inboundId?: number | null; server?: XuiServer };

const servers = ref<XuiServer[]>([]);
const nodes = ref<ServiceNode[]>([]);
const loading = ref(false);
const savingServer = ref(false);
const savingNode = ref(false);
const error = ref('');
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

async function createServer() {
  savingServer.value = true;
  error.value = '';
  try {
    await api('/api/admin/xui-servers', { method: 'POST', body: serverForm });
    Object.assign(serverForm, { name: '', baseUrl: '', username: '', password: '', token: '', enabled: true, remark: '' });
    ElMessage.success('3x-ui 服务器已保存');
    await loadNodes();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存服务器失败';
  } finally {
    savingServer.value = false;
  }
}

async function createServiceNode() {
  savingNode.value = true;
  error.value = '';
  try {
    await api('/api/admin/service-nodes', { method: 'POST', body: nodeForm });
    Object.assign(nodeForm, { name: '', inboundId: undefined, protocol: 'vless', priceMonthly: 0, trafficLimitGb: 0, enabled: true, remark: '' });
    ElMessage.success('服务节点已保存');
    await loadNodes();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存节点失败';
  } finally {
    savingNode.value = false;
  }
}

onMounted(loadNodes);
</script>

<template>
  <h1 class="page-title">节点管理</h1>
  <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="page-alert" />

  <div class="panel node-grid">
    <section>
      <h2>3x-ui 服务器</h2>
      <el-form :model="serverForm" label-width="82px">
        <el-form-item label="名称"><el-input v-model="serverForm.name" /></el-form-item>
        <el-form-item label="地址"><el-input v-model="serverForm.baseUrl" placeholder="https://xui.example.com" /></el-form-item>
        <el-form-item label="账号"><el-input v-model="serverForm.username" /></el-form-item>
        <el-form-item label="密码"><el-input v-model="serverForm.password" type="password" show-password /></el-form-item>
        <el-form-item label="API Token"><el-input v-model="serverForm.token" type="password" show-password /></el-form-item>
        <el-form-item><el-button type="primary" :loading="savingServer" @click="createServer">新增服务器</el-button></el-form-item>
      </el-form>
    </section>

    <section>
      <h2>服务节点</h2>
      <el-form :model="nodeForm" label-width="82px">
        <el-form-item label="名称"><el-input v-model="nodeForm.name" /></el-form-item>
        <el-form-item label="服务器"><el-select v-model="nodeForm.serverId" :options="serverOptions" style="width: 100%" /></el-form-item>
        <el-form-item label="入站 ID"><el-input-number v-model="nodeForm.inboundId" :min="0" style="width: 100%" /></el-form-item>
        <el-form-item label="月价"><el-input-number v-model="nodeForm.priceMonthly" :min="0" :precision="2" style="width: 100%" /></el-form-item>
        <el-form-item label="流量 GB"><el-input-number v-model="nodeForm.trafficLimitGb" :min="0" :precision="2" style="width: 100%" /></el-form-item>
        <el-form-item><el-button type="primary" :loading="savingNode" :disabled="!nodeForm.serverId" @click="createServiceNode">新增节点</el-button></el-form-item>
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
      <el-table-column prop="enabled" label="启用" width="100" />
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
      <el-table-column prop="enabled" label="启用" width="100" />
    </el-table>
  </div>
</template>
