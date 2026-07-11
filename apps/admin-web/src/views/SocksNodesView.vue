<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Edit3, Plus, RefreshCw, Search, Trash2 } from 'lucide-vue-next';
import { api } from '../api';

type SocksNode = {
  id: string;
  name: string;
  host: string;
  port: number;
  username?: string | null;
  enabled: boolean;
  remark?: string | null;
  hasPassword?: boolean;
};
type ServiceNode = { id: string; config?: { socksRelayEnabled?: boolean; socksNodeId?: string | null } | null };

const nodes = ref<SocksNode[]>([]);
const serviceNodes = ref<ServiceNode[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const searchQuery = ref('');
const editingId = ref('');
const dialogVisible = ref(false);
const form = reactive({ name: '', host: '', port: 1080, username: '', password: '', enabled: true, remark: '' });

const enabledNodeCount = computed(() => nodes.value.filter((node) => node.enabled).length);
const authedNodeCount = computed(() => nodes.value.filter((node) => node.username || node.hasPassword).length);
const usedNodeCount = computed(() => nodes.value.filter((node) => usageCount(node.id) > 0).length);
const filteredNodes = computed(() => {
  const keyword = searchQuery.value.trim().toLowerCase();
  if (!keyword) return nodes.value;
  return nodes.value.filter((node) => socksSearchText(node).includes(keyword));
});

async function loadNodes() {
  loading.value = true;
  error.value = '';
  try {
    const [socksResult, serviceResult] = await Promise.all([
      api<SocksNode[]>('/api/admin/socks-nodes'),
      api<ServiceNode[]>('/api/admin/service-nodes')
    ]);
    nodes.value = socksResult;
    serviceNodes.value = serviceResult;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载出站节点失败';
  } finally {
    loading.value = false;
  }
}

async function saveNode() {
  saving.value = true;
  error.value = '';
  try {
    const path = editingId.value ? `/api/admin/socks-nodes/${editingId.value}` : '/api/admin/socks-nodes';
    await api(path, { method: editingId.value ? 'PATCH' : 'POST', body: cleanFormBody() });
    ElMessage.success(editingId.value ? '出站节点已更新' : '出站节点已添加');
    dialogVisible.value = false;
    resetForm();
    await loadNodes();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存出站节点失败';
  } finally {
    saving.value = false;
  }
}

function openDialog() {
  resetForm();
  dialogVisible.value = true;
}

function editNode(node: SocksNode) {
  editingId.value = node.id;
  Object.assign(form, {
    name: node.name,
    host: node.host,
    port: node.port,
    username: node.username || '',
    password: '',
    enabled: node.enabled,
    remark: node.remark || ''
  });
  dialogVisible.value = true;
}

async function removeNode(node: SocksNode) {
  await ElMessageBox.confirm(`确认删除出站节点“${node.name}”？正在被路由节点使用时，后端会拒绝删除。`, '删除确认', { type: 'warning' });
  await api(`/api/admin/socks-nodes/${node.id}`, { method: 'DELETE' });
  ElMessage.success('出站节点已删除');
  await loadNodes();
}

function resetForm() {
  editingId.value = '';
  Object.assign(form, { name: '', host: '', port: 1080, username: '', password: '', enabled: true, remark: '' });
}

function cleanFormBody() {
  return {
    ...form,
    username: form.username.trim() || undefined,
    password: form.password || undefined,
    remark: form.remark.trim() || undefined
  };
}

function usageCount(id: string) {
  return serviceNodes.value.filter((node) => node.config?.socksRelayEnabled && node.config?.socksNodeId === id).length;
}

function socksSearchText(node: SocksNode) {
  return [node.name, node.host, node.port, node.username, node.enabled ? '启用' : '停用', node.remark, usageCount(node.id)].filter(Boolean).join(' ').toLowerCase();
}

onMounted(loadNodes);
</script>

<template>
  <div class="page-head">
    <div class="page-head-main">
      <h1 class="page-title">出站节点</h1>
      <p>维护 SOCKS 出站中转节点；路由节点启用出站后会引用这里的配置。</p>
    </div>
    <div class="page-actions">
      <el-button :loading="loading" @click="loadNodes"><RefreshCw :size="15" />刷新</el-button>
    </div>
  </div>
  <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="page-alert" />

  <div class="metric-grid compact-metrics">
    <div class="metric"><span>出站节点</span><strong>{{ nodes.length }}</strong><small>启用 {{ enabledNodeCount }}</small></div>
    <div class="metric"><span>认证节点</span><strong>{{ authedNodeCount }}</strong><small>配置账号或密码</small></div>
    <div class="metric"><span>被引用</span><strong>{{ usedNodeCount }}</strong><small>正在被路由节点使用</small></div>
    <div class="metric"><span>默认端口</span><strong>1080</strong><small>新增时可调整</small></div>
  </div>

  <div class="panel list-panel">
    <div class="panel-toolbar">
      <strong>出站节点列表</strong>
      <div class="table-toolbar-actions">
        <el-button type="primary" @click="openDialog"><Plus :size="15" />添加出站节点</el-button>
      </div>
    </div>
    <div class="filter-bar">
      <el-input v-model="searchQuery" clearable placeholder="搜索名称、地址、端口、账号、备注" style="max-width: 360px">
        <template #prefix><Search :size="15" /></template>
      </el-input>
      <span class="filter-summary">显示 {{ filteredNodes.length }} / {{ nodes.length }}</span>
    </div>
    <el-table :data="filteredNodes" v-loading="loading" style="width: 100%">
      <el-table-column prop="name" label="名称" min-width="140" />
      <el-table-column prop="host" label="地址" min-width="180" />
      <el-table-column prop="port" label="端口" width="90" />
      <el-table-column label="认证" width="130">
        <template #default="{ row }: { row: SocksNode }">
          <el-tag v-if="row.username || row.hasPassword" size="small" type="success">账号密码</el-tag>
          <el-tag v-else size="small" type="info">无认证</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="引用" width="100">
        <template #default="{ row }: { row: SocksNode }">
          <el-tag :type="usageCount(row.id) ? 'warning' : 'info'" size="small">{{ usageCount(row.id) }} 个</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }: { row: SocksNode }"><el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag></template>
      </el-table-column>
      <el-table-column prop="remark" label="备注" min-width="160" />
      <el-table-column label="操作" width="220" fixed="right">
        <template #default="{ row }: { row: SocksNode }">
          <div class="row-actions">
            <el-button size="small" @click="editNode(row)"><Edit3 :size="15" />编辑</el-button>
            <el-button size="small" type="danger" plain @click="removeNode(row)"><Trash2 :size="15" />删除</el-button>
          </div>
        </template>
      </el-table-column>
    </el-table>
  </div>

  <el-dialog v-model="dialogVisible" :title="editingId ? '编辑出站节点' : '添加出站节点'" width="720px" destroy-on-close>
    <el-form :model="form" label-width="92px" class="sectioned-dialog-form">
      <section class="dialog-form-section">
        <div class="dialog-section-head"><strong>出站连接</strong><span>这里保存 SOCKS 地址，路由节点启用出站中转后会写入远端 Xray。</span></div>
        <div class="dialog-form-grid">
          <el-form-item label="名称"><el-input v-model="form.name" /></el-form-item>
          <el-form-item label="启用"><el-switch v-model="form.enabled" /></el-form-item>
          <el-form-item label="地址"><el-input v-model="form.host" placeholder="127.0.0.1 或域名" /></el-form-item>
          <el-form-item label="端口"><el-input-number v-model="form.port" :min="1" :max="65535" style="width: 100%" /></el-form-item>
        </div>
      </section>

      <section class="dialog-form-section">
        <div class="dialog-section-head"><strong>认证与备注</strong><span>无账号密码时留空；编辑时密码留空表示不修改。</span></div>
        <div class="dialog-form-grid">
          <el-form-item label="账号"><el-input v-model="form.username" /></el-form-item>
          <el-form-item label="密码"><el-input v-model="form.password" type="password" show-password placeholder="编辑时留空不修改" /></el-form-item>
          <el-form-item label="备注" class="form-item-full"><el-input v-model="form.remark" /></el-form-item>
        </div>
      </section>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!form.name || !form.host || !form.port" @click="saveNode">保存</el-button>
    </template>
  </el-dialog>
</template>
