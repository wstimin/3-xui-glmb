<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Activity, Edit3, Plus, RefreshCw, Search, Trash2, Users, Wifi } from 'lucide-vue-next';
import { api } from '../api';

type XuiServer = {
  id: string;
  name: string;
  baseUrl: string;
  basePath?: string | null;
  username?: string | null;
  enabled: boolean;
  remark?: string | null;
  config?: {
    tlsServerName?: string;
    tlsCertFile?: string;
    tlsKeyFile?: string;
    realityTarget?: string;
    realityServerName?: string;
    realityFingerprint?: string;
    realitySpiderX?: string;
  } | null;
  hasPassword?: boolean;
  hasToken?: boolean;
};

type SyncResult = { total: number; created: number; updated: number; skipped: number };

const servers = ref<XuiServer[]>([]);
const loading = ref(false);
const saving = ref(false);
const testingForm = ref(false);
const testingIds = ref<Set<string>>(new Set());
const syncingIds = ref<Set<string>>(new Set());
const statusIds = ref<Set<string>>(new Set());
const presenceIds = ref<Set<string>>(new Set());
const error = ref('');
const searchQuery = ref('');
const editingId = ref('');
const dialogVisible = ref(false);
const form = reactive({ name: '', baseUrl: '', basePath: '', username: '', password: '', token: '', tlsServerName: '', tlsCertFile: '', tlsKeyFile: '', realityTarget: '', realityServerName: '', realityFingerprint: 'chrome', realitySpiderX: '/', enabled: true, remark: '' });

const enabledServerCount = computed(() => servers.value.filter((server) => server.enabled).length);
const tokenServerCount = computed(() => servers.value.filter((server) => server.hasToken).length);
const tlsServerCount = computed(() => servers.value.filter((server) => hasTlsConfig(server)).length);
const realityAutoCount = computed(() => servers.value.filter((server) => !server.config?.realityTarget || !server.config?.realityServerName).length);
const filteredServers = computed(() => {
  const keyword = searchQuery.value.trim().toLowerCase();
  if (!keyword) return servers.value;
  return servers.value.filter((server) => serverSearchText(server).includes(keyword));
});

async function loadServers() {
  loading.value = true;
  error.value = '';
  try {
    servers.value = await api<XuiServer[]>('/api/admin/xui-servers');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载面板连接失败';
  } finally {
    loading.value = false;
  }
}

async function saveServer() {
  saving.value = true;
  error.value = '';
  try {
    const path = editingId.value ? `/api/admin/xui-servers/${editingId.value}` : '/api/admin/xui-servers';
    await api(path, { method: editingId.value ? 'PATCH' : 'POST', body: cleanFormBody() });
    ElMessage.success(editingId.value ? '面板连接已更新' : '面板连接已添加');
    dialogVisible.value = false;
    resetForm();
    await loadServers();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存面板连接失败';
  } finally {
    saving.value = false;
  }
}

async function testForm() {
  testingForm.value = true;
  error.value = '';
  try {
    const result = await api<{ connected: boolean; inbounds: unknown }>('/api/admin/xui/test', { method: 'POST', body: cleanFormBody() });
    const inbounds = Array.isArray(result.inbounds) ? result.inbounds.length : '-';
    ElMessage.success(`连接成功，入站数量：${inbounds}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : '测试连接失败';
  } finally {
    testingForm.value = false;
  }
}

async function testSaved(server: XuiServer) {
  testingIds.value = new Set(testingIds.value).add(server.id);
  error.value = '';
  try {
    const result = await api<{ inboundCount: number }>(`/api/admin/xui-servers/${server.id}/test`, { method: 'POST' });
    ElMessage.success(`${server.name} 连接成功，入站数量：${result.inboundCount}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : '测试已保存面板连接失败';
  } finally {
    const next = new Set(testingIds.value);
    next.delete(server.id);
    testingIds.value = next;
  }
}

async function syncServer(server: XuiServer) {
  await ElMessageBox.confirm(`确认从服务器“${server.name}”读取远端入站，并同步为本地服务节点？此操作不会同步远端用户。`, '同步远端节点', { type: 'warning' });
  syncingIds.value = new Set(syncingIds.value).add(server.id);
  error.value = '';
  try {
    const result = await api<SyncResult>(`/api/admin/xui-servers/${server.id}/sync`, { method: 'POST' });
    ElMessage.success(`远端节点同步完成：新增 ${result.created}，更新 ${result.updated}，跳过 ${result.skipped}，总数 ${result.total}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : '同步远端节点失败';
  } finally {
    const next = new Set(syncingIds.value);
    next.delete(server.id);
    syncingIds.value = next;
  }
}

async function showServerStatus(server: XuiServer) {
  statusIds.value = new Set(statusIds.value).add(server.id);
  error.value = '';
  try {
    const result = await api<{ status?: Record<string, unknown>; versions?: unknown[] }>(`/api/admin/xui-servers/${server.id}/status`);
    const status = result.status || {};
    const xray = (status.xray || {}) as Record<string, unknown>;
    const mem = (status.mem || {}) as Record<string, unknown>;
    const disk = (status.disk || {}) as Record<string, unknown>;
    await ElMessageBox.alert([
      `Xray: ${xray.state || '-'} ${xray.version || ''}`.trim(),
      `CPU: ${status.cpu ?? '-'}%`,
      `Memory: ${formatBytes(Number(mem.current || 0))} / ${formatBytes(Number(mem.total || 0))}`,
      `Disk: ${formatBytes(Number(disk.current || 0))} / ${formatBytes(Number(disk.total || 0))}`,
      `Available versions: ${(result.versions || []).slice(0, 5).join(', ') || '-'}`
    ].join('\n'), `${server.name} status`, { type: 'info' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : '读取面板连接状态失败';
  } finally {
    const next = new Set(statusIds.value);
    next.delete(server.id);
    statusIds.value = next;
  }
}

async function showClientPresence(server: XuiServer) {
  presenceIds.value = new Set(presenceIds.value).add(server.id);
  error.value = '';
  try {
    const result = await api<{ online?: unknown[]; lastOnline?: Record<string, unknown> }>(`/api/admin/xui-servers/${server.id}/client-presence`);
    const online = (result.online || []).map(String);
    const lastOnline = Object.entries(result.lastOnline || {}).slice(0, 12).map(([email, time]) => `${email}: ${formatUnixTime(time)}`);
    await ElMessageBox.alert([
      `Online clients: ${online.length}`,
      online.length ? online.slice(0, 20).join(', ') : '-',
      '',
      'Last online:',
      lastOnline.length ? lastOnline.join('\n') : '-'
    ].join('\n'), `${server.name} clients`, { type: 'info' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : '读取客户端在线状态失败';
  } finally {
    const next = new Set(presenceIds.value);
    next.delete(server.id);
    presenceIds.value = next;
  }
}

function openDialog() {
  resetForm();
  dialogVisible.value = true;
}

function editServer(server: XuiServer) {
  editingId.value = server.id;
  Object.assign(form, {
    name: server.name,
    baseUrl: server.baseUrl,
    basePath: server.basePath || '',
    username: server.username || '',
    password: '',
    token: '',
    tlsServerName: server.config?.tlsServerName || '',
    tlsCertFile: server.config?.tlsCertFile || '',
    tlsKeyFile: server.config?.tlsKeyFile || '',
    realityTarget: server.config?.realityTarget || '',
    realityServerName: server.config?.realityServerName || '',
    realityFingerprint: server.config?.realityFingerprint || 'chrome',
    realitySpiderX: server.config?.realitySpiderX || '/',
    enabled: server.enabled,
    remark: server.remark || ''
  });
  dialogVisible.value = true;
}

async function removeServer(server: XuiServer) {
  await ElMessageBox.confirm(`确认删除面板连接“${server.name}”？有关联路由节点时请先处理节点。`, '删除确认', { type: 'warning' });
  await api(`/api/admin/xui-servers/${server.id}`, { method: 'DELETE' });
  ElMessage.success('面板连接已删除');
  await loadServers();
}

function resetForm() {
  editingId.value = '';
  Object.assign(form, { name: '', baseUrl: '', basePath: '', username: '', password: '', token: '', tlsServerName: '', tlsCertFile: '', tlsKeyFile: '', realityTarget: '', realityServerName: '', realityFingerprint: 'chrome', realitySpiderX: '/', enabled: true, remark: '' });
}

function cleanFormBody() {
  return {
    ...form,
    basePath: form.basePath.trim() || undefined,
    username: form.username.trim() || undefined,
    password: form.password || undefined,
    token: form.token || undefined,
    tlsServerName: form.tlsServerName.trim() || undefined,
    tlsCertFile: form.tlsCertFile.trim() || undefined,
    tlsKeyFile: form.tlsKeyFile.trim() || undefined,
    realityTarget: form.realityTarget.trim() || undefined,
    realityServerName: form.realityServerName.trim() || undefined,
    realityFingerprint: form.realityFingerprint.trim() || undefined,
    realitySpiderX: form.realitySpiderX.trim() || undefined,
    remark: form.remark.trim() || undefined
  };
}

function hasTlsConfig(server: XuiServer) {
  return Boolean(server.config?.tlsCertFile && server.config?.tlsKeyFile);
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function formatUnixTime(value: unknown) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return '-';
  return new Date(time * 1000).toLocaleString('zh-CN', { hour12: false });
}

function serverSearchText(server: XuiServer) {
  return [
    server.name,
    server.baseUrl,
    server.basePath,
    server.username,
    server.enabled ? '启用' : '停用',
    server.hasToken ? 'token' : '',
    server.hasPassword ? '账号密码' : '',
    server.config?.tlsServerName,
    server.config?.tlsCertFile,
    server.config?.realityTarget,
    server.config?.realityServerName,
    server.remark
  ].filter(Boolean).join(' ').toLowerCase();
}

onMounted(loadServers);
</script>

<template>
  <div class="page-head">
    <div class="page-head-main">
      <h1 class="page-title">面板连接</h1>
      <p>维护 3x-ui 面板连接、证书路径和 Reality 自动创建节点所需配置。</p>
    </div>
    <div class="page-actions">
      <el-button :loading="loading" @click="loadServers"><RefreshCw :size="15" />刷新</el-button>
    </div>
  </div>
  <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="page-alert" />

  <div class="metric-grid compact-metrics">
    <div class="metric"><span>面板连接</span><strong>{{ servers.length }}</strong><small>启用 {{ enabledServerCount }}</small></div>
    <div class="metric"><span>Token 凭据</span><strong>{{ tokenServerCount }}</strong><small>优先使用 API Token</small></div>
    <div class="metric"><span>TLS 证书</span><strong>{{ tlsServerCount }}</strong><small>可自动创建 TLS 节点</small></div>
    <div class="metric"><span>Reality 自动</span><strong>{{ realityAutoCount }}</strong><small>目标或 SNI 留空自动生成</small></div>
  </div>

  <div class="panel list-panel">
    <div class="panel-toolbar">
      <strong>面板连接列表</strong>
      <div class="table-toolbar-actions">
        <el-button type="primary" @click="openDialog"><Plus :size="15" />添加面板连接</el-button>
      </div>
    </div>
    <div class="filter-bar">
      <el-input v-model="searchQuery" clearable placeholder="搜索名称、地址、账号、证书、Reality" style="max-width: 380px">
        <template #prefix><Search :size="15" /></template>
      </el-input>
      <span class="filter-summary">显示 {{ filteredServers.length }} / {{ servers.length }}</span>
    </div>
    <el-table :data="filteredServers" v-loading="loading" style="width: 100%">
      <el-table-column prop="name" label="名称" min-width="140" />
      <el-table-column prop="baseUrl" label="面板地址" min-width="220" />
      <el-table-column prop="basePath" label="路径" width="120" />
      <el-table-column label="证书/Reality" min-width="170">
        <template #default="{ row }: { row: XuiServer }">
          <div class="tag-stack">
            <el-tag v-if="hasTlsConfig(row)" size="small" type="success">TLS 证书</el-tag>
            <el-tag size="small">Reality {{ row.config?.realityTarget || '自动生成' }}</el-tag>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="凭据" width="150">
        <template #default="{ row }: { row: XuiServer }">
          <el-tag v-if="row.hasToken" size="small" type="success">Token</el-tag>
          <el-tag v-else-if="row.hasPassword" size="small">账号密码</el-tag>
          <el-tag v-else size="small" type="warning">未配置</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }: { row: XuiServer }"><el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag></template>
      </el-table-column>
      <el-table-column label="操作" width="450" fixed="right">
        <template #default="{ row }: { row: XuiServer }">
          <div class="row-actions row-actions-split">
            <div class="row-action-group remote-action">
              <span class="action-group-label">远端读取</span>
              <el-button size="small" :loading="testingIds.has(row.id)" @click="testSaved(row)"><Wifi :size="15" />测试</el-button>
              <el-button size="small" :loading="statusIds.has(row.id)" @click="showServerStatus(row)"><Activity :size="15" />状态</el-button>
              <el-button size="small" :loading="presenceIds.has(row.id)" @click="showClientPresence(row)"><Users :size="15" />在线</el-button>
              <el-button size="small" :loading="syncingIds.has(row.id)" :disabled="!row.enabled" @click="syncServer(row)"><RefreshCw :size="15" />同步</el-button>
            </div>
            <div class="row-action-group manage-action">
              <span class="action-group-label">管理</span>
              <el-button size="small" @click="editServer(row)"><Edit3 :size="15" />编辑</el-button>
              <el-button size="small" type="danger" plain @click="removeServer(row)"><Trash2 :size="15" />删除</el-button>
            </div>
          </div>
        </template>
      </el-table-column>
    </el-table>
  </div>

  <el-dialog v-model="dialogVisible" :title="editingId ? '编辑面板连接' : '添加面板连接'" width="min(900px, 94vw)" destroy-on-close>
    <el-form :model="form" label-width="96px" class="sectioned-dialog-form">
      <section class="dialog-form-section">
        <div class="dialog-section-head"><strong>连接信息</strong><span>3x-ui 面板地址、路径和启用状态</span></div>
        <div class="dialog-form-grid">
          <el-form-item label="名称"><el-input v-model="form.name" /></el-form-item>
          <el-form-item label="面板地址"><el-input v-model="form.baseUrl" placeholder="https://xui.example.com" /></el-form-item>
          <el-form-item label="面板路径"><el-input v-model="form.basePath" placeholder="根路径留空" /></el-form-item>
          <el-form-item label="启用"><el-switch v-model="form.enabled" /></el-form-item>
        </div>
      </section>

      <section class="dialog-form-section">
        <div class="dialog-section-head"><strong>访问凭据</strong><span>优先使用 API Token；账号密码用于面板登录接口</span></div>
        <div class="dialog-form-grid">
          <el-form-item label="账号"><el-input v-model="form.username" /></el-form-item>
          <el-form-item label="密码"><el-input v-model="form.password" type="password" show-password placeholder="编辑时留空不修改" /></el-form-item>
          <el-form-item label="API Token" class="form-item-full"><el-input v-model="form.token" type="password" show-password placeholder="编辑时留空不修改" /></el-form-item>
        </div>
      </section>

      <section class="dialog-form-section">
        <div class="dialog-section-head"><strong>TLS 证书</strong><span>自动创建 TLS 节点时使用，路径需要是远端服务器上的真实文件</span></div>
        <div class="dialog-form-grid">
          <el-form-item label="TLS 域名"><el-input v-model="form.tlsServerName" placeholder="例如 panel.example.com" /></el-form-item>
          <el-form-item label="证书路径"><el-input v-model="form.tlsCertFile" placeholder="例如 /root/cert/fullchain.pem" /></el-form-item>
          <el-form-item label="私钥路径"><el-input v-model="form.tlsKeyFile" placeholder="例如 /root/cert/privkey.pem" /></el-form-item>
        </div>
      </section>

      <section class="dialog-form-section">
        <div class="dialog-section-head"><strong>Reality 默认值</strong><span>目标和 SNI 可留空，由系统按可用目标自动生成</span></div>
        <div class="dialog-form-grid">
          <el-form-item label="Reality 目标"><el-input v-model="form.realityTarget" placeholder="留空自动生成，例如 example.com:443" /></el-form-item>
          <el-form-item label="Reality SNI"><el-input v-model="form.realityServerName" placeholder="留空按 Reality 目标自动生成" /></el-form-item>
          <el-form-item label="指纹"><el-input v-model="form.realityFingerprint" placeholder="chrome" /></el-form-item>
          <el-form-item label="SpiderX"><el-input v-model="form.realitySpiderX" placeholder="/" /></el-form-item>
          <el-form-item label="备注" class="form-item-full"><el-input v-model="form.remark" /></el-form-item>
        </div>
      </section>
    </el-form>
    <template #footer>
      <el-button :loading="testingForm" :disabled="!form.baseUrl" @click="testForm"><Wifi :size="15" />测试连接</el-button>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!form.name || !form.baseUrl" @click="saveServer">保存</el-button>
    </template>
  </el-dialog>
</template>
