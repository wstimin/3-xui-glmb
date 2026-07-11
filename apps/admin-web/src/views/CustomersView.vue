<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Activity, RefreshCw, RotateCcw } from 'lucide-vue-next';
import { api } from '../api';

type CustomerNode = {
  id: string;
  xuiEmail: string;
  uuid?: string | null;
  expireAt: string | null;
  trafficLimitGb?: string | null;
  status: string;
  lastSyncedAt: string | null;
  serviceNode?: { id: string; name: string; server?: { id: string; name: string } };
};

type Customer = {
  id: string;
  name: string;
  loginUsername: string;
  email?: string | null;
  phone?: string | null;
  balance: string;
  status: 'active' | 'disabled';
  remark?: string | null;
  createdAt: string;
  nodes?: CustomerNode[];
};

type ServiceNode = { id: string; name: string; server?: { name: string } };

const loading = ref(false);
const savingCustomer = ref(false);
const binding = ref(false);
const updatingCustomerNode = ref(false);
const adjustingBalance = ref(false);
const error = ref('');
const customers = ref<Customer[]>([]);
const serviceNodes = ref<ServiceNode[]>([]);
const syncingIds = ref<Set<string>>(new Set());
const renewingIds = ref<Set<string>>(new Set());
const trafficIds = ref<Set<string>>(new Set());
const resettingTrafficIds = ref<Set<string>>(new Set());
const deletingServiceNodeIds = ref<Set<string>>(new Set());
const editingCustomerId = ref('');
const customerDialogVisible = ref(false);
const bindDialogVisible = ref(false);
const editNodeDialogVisible = ref(false);
const balanceDialogVisible = ref(false);
const customerForm = reactive({ name: '', loginUsername: '', loginPassword: '', email: '', phone: '', balance: 0, status: 'active' as 'active' | 'disabled', remark: '' });
const bindForm = reactive({ customerId: '', serviceNodeId: '', xuiEmail: '', expireAt: defaultExpireAt(), trafficLimitGb: undefined as number | undefined });
const nodeEditForm = reactive({ customerId: '', customerNodeId: '', serviceNodeId: '', xuiEmail: '', expireAt: '', trafficLimitGb: undefined as number | undefined });
const balanceForm = reactive({ customerId: '', mode: 'add' as 'add' | 'subtract' | 'set', amount: 0, remark: '' });
const renewMonths = ref<Record<string, number>>({});
const activePanels = ref(['customers']);

const selectedCustomer = computed(() => customers.value.find((item) => item.id === bindForm.customerId));
const activeCustomerCount = computed(() => customers.value.filter((item) => item.status === 'active').length);
const boundNodeCount = computed(() => customers.value.reduce((total, item) => total + (item.nodes?.length || 0), 0));
const activeBoundNodeCount = computed(() => customers.value.reduce((total, item) => total + (item.nodes?.filter((node) => node.status === 'active').length || 0), 0));

async function loadCustomers() {
  loading.value = true;
  error.value = '';
  try {
    const [customerResult, nodeResult] = await Promise.all([
      api<{ items: Customer[] }>('/api/admin/customers'),
      api<ServiceNode[]>('/api/admin/service-nodes')
    ]);
    customers.value = customerResult.items;
    serviceNodes.value = nodeResult;
    if (!bindForm.customerId && customerResult.items[0]) bindForm.customerId = customerResult.items[0].id;
    if (!balanceForm.customerId && customerResult.items[0]) balanceForm.customerId = customerResult.items[0].id;
    if (!bindForm.serviceNodeId && nodeResult[0]) bindForm.serviceNodeId = nodeResult[0].id;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

async function saveCustomer() {
  savingCustomer.value = true;
  error.value = '';
  try {
    const body = { ...customerForm, loginPassword: customerForm.loginPassword || undefined };
    const path = editingCustomerId.value ? `/api/admin/customers/${editingCustomerId.value}` : '/api/admin/customers';
    await api(path, { method: editingCustomerId.value ? 'PATCH' : 'POST', body });
    ElMessage.success(editingCustomerId.value ? '用户已更新' : '用户已新增');
    customerDialogVisible.value = false;
    resetCustomerForm();
    await loadCustomers();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存用户失败';
  } finally {
    savingCustomer.value = false;
  }
}

async function bindNode() {
  if (!bindForm.customerId || !bindForm.serviceNodeId) return;
  binding.value = true;
  error.value = '';
  try {
    await api(`/api/admin/customers/${bindForm.customerId}/nodes`, {
      method: 'POST',
      body: {
        serviceNodeId: bindForm.serviceNodeId,
        xuiEmail: bindForm.xuiEmail || undefined,
        expireAt: bindForm.expireAt || undefined,
        trafficLimitGb: bindForm.trafficLimitGb
      }
    });
    ElMessage.success('节点已绑定，远端客户端已同步');
    bindDialogVisible.value = false;
    Object.assign(bindForm, { xuiEmail: '', expireAt: defaultExpireAt(), trafficLimitGb: undefined });
    await loadCustomers();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '绑定失败';
  } finally {
    binding.value = false;
  }
}

async function updateCustomerNode() {
  if (!nodeEditForm.customerId || !nodeEditForm.customerNodeId || !nodeEditForm.serviceNodeId) return;
  updatingCustomerNode.value = true;
  error.value = '';
  try {
    await api(`/api/admin/customers/${nodeEditForm.customerId}/nodes/${nodeEditForm.customerNodeId}`, {
      method: 'PATCH',
      body: {
        serviceNodeId: nodeEditForm.serviceNodeId,
        xuiEmail: nodeEditForm.xuiEmail || undefined,
        expireAt: nodeEditForm.expireAt || undefined,
        trafficLimitGb: nodeEditForm.trafficLimitGb
      }
    });
    ElMessage.success('绑定节点已更新，远端客户端已同步');
    editNodeDialogVisible.value = false;
    await loadCustomers();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '更新绑定节点失败';
  } finally {
    updatingCustomerNode.value = false;
  }
}

async function adjustBalance() {
  if (!balanceForm.customerId || balanceForm.amount <= 0) return;
  adjustingBalance.value = true;
  error.value = '';
  try {
    await api(`/api/admin/customers/${balanceForm.customerId}/balance-adjustments`, { method: 'POST', body: balanceForm });
    ElMessage.success('余额已调整');
    balanceDialogVisible.value = false;
    Object.assign(balanceForm, { mode: 'add', amount: 0, remark: '' });
    await loadCustomers();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '调整余额失败';
  } finally {
    adjustingBalance.value = false;
  }
}

async function syncNode(customer: Customer, node: CustomerNode) {
  syncingIds.value = new Set(syncingIds.value).add(node.id);
  error.value = '';
  try {
    await api(`/api/admin/customers/${customer.id}/nodes/${node.id}/sync`, { method: 'POST' });
    ElMessage.success(`已同步 ${node.serviceNode?.name || node.xuiEmail}`);
    await loadCustomers();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '同步失败';
  } finally {
    const done = new Set(syncingIds.value);
    done.delete(node.id);
    syncingIds.value = done;
  }
}

async function renewNode(customer: Customer, node: CustomerNode) {
  const months = renewMonths.value[node.id] || 1;
  renewingIds.value = new Set(renewingIds.value).add(node.id);
  error.value = '';
  try {
    await api(`/api/admin/customers/${customer.id}/nodes/${node.id}/renew`, { method: 'POST', body: { months } });
    ElMessage.success('续费成功，已同步远端');
    await loadCustomers();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '续费失败';
  } finally {
    const done = new Set(renewingIds.value);
    done.delete(node.id);
    renewingIds.value = done;
  }
}

async function showNodeTraffic(customer: Customer, node: CustomerNode) {
  trafficIds.value = new Set(trafficIds.value).add(node.id);
  error.value = '';
  try {
    const result = await api<{ traffic?: Record<string, unknown>; xuiEmail?: string }>(`/api/admin/customers/${customer.id}/nodes/${node.id}/traffic`);
    const traffic = result.traffic || {};
    await ElMessageBox.alert([
      `Email: ${result.xuiEmail || node.xuiEmail}`,
      `Enabled: ${traffic.enable ?? '-'}`,
      `Upload: ${formatBytes(Number(traffic.up || 0))}`,
      `Download: ${formatBytes(Number(traffic.down || 0))}`,
      `Total: ${formatBytes(Number(traffic.total || 0))}`,
      `Expiry: ${formatRemoteExpiry(traffic.expiryTime)}`,
      `Last online: ${formatRemoteLastOnline(traffic.lastOnline)}`
    ].join('\n'), '3x-ui client traffic', { type: 'info' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : '读取远端流量失败';
  } finally {
    const next = new Set(trafficIds.value);
    next.delete(node.id);
    trafficIds.value = next;
  }
}

async function resetNodeTraffic(customer: Customer, node: CustomerNode) {
  await ElMessageBox.confirm(`确认重置「${node.serviceNode?.name || node.xuiEmail}」这个远端客户端的流量？`, '重置客户端流量', { type: 'warning' });
  resettingTrafficIds.value = new Set(resettingTrafficIds.value).add(node.id);
  error.value = '';
  try {
    await api(`/api/admin/customers/${customer.id}/nodes/${node.id}/reset-traffic`, { method: 'POST' });
    ElMessage.success('远端客户端流量已重置');
    await loadCustomers();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '重置远端流量失败';
  } finally {
    const next = new Set(resettingTrafficIds.value);
    next.delete(node.id);
    resettingTrafficIds.value = next;
  }
}

async function unbindNode(customer: Customer, node: CustomerNode) {
  await ElMessageBox.confirm(`确认解绑「${node.serviceNode?.name || node.xuiEmail}」？`, '解绑确认', { type: 'warning' });
  await api(`/api/admin/customers/${customer.id}/nodes/${node.id}`, { method: 'DELETE' });
  ElMessage.success('节点已解绑');
  await loadCustomers();
}

async function deleteBoundServiceNode(customer: Customer, node: CustomerNode) {
  if (!node.serviceNode?.id) {
    ElMessage.error('该绑定缺少服务节点信息，无法删除服务节点');
    return;
  }
  await ElMessageBox.confirm(`确认删除服务节点「${node.serviceNode.name}」？系统会同步删除该服务节点、本地所有用户绑定以及远端 3x-ui 入站/客户端。`, '删除服务节点', { type: 'warning' });
  deletingServiceNodeIds.value = new Set(deletingServiceNodeIds.value).add(node.id);
  error.value = '';
  try {
    await api(`/api/admin/customers/${customer.id}/nodes/${node.id}/service-node`, { method: 'DELETE' });
    ElMessage.success('服务节点和远端已删除');
    await loadCustomers();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '删除服务节点失败';
  } finally {
    const next = new Set(deletingServiceNodeIds.value);
    next.delete(node.id);
    deletingServiceNodeIds.value = next;
  }
}

function openCustomerDialog() {
  resetCustomerForm();
  customerDialogVisible.value = true;
}

function openBindDialog(customer?: Customer) {
  if (customer) bindForm.customerId = customer.id;
  if (!bindForm.customerId && customers.value[0]) bindForm.customerId = customers.value[0].id;
  if (!bindForm.serviceNodeId && serviceNodes.value[0]) bindForm.serviceNodeId = serviceNodes.value[0].id;
  bindForm.expireAt = bindForm.expireAt || defaultExpireAt();
  bindDialogVisible.value = true;
}

function openBalanceDialog(customer?: Customer) {
  if (customer) balanceForm.customerId = customer.id;
  if (!balanceForm.customerId && customers.value[0]) balanceForm.customerId = customers.value[0].id;
  balanceDialogVisible.value = true;
}

function editCustomerNode(customer: Customer, node: CustomerNode) {
  Object.assign(nodeEditForm, {
    customerId: customer.id,
    customerNodeId: node.id,
    serviceNodeId: node.serviceNode?.id || '',
    xuiEmail: node.xuiEmail,
    expireAt: node.expireAt || '',
    trafficLimitGb: node.trafficLimitGb === undefined || node.trafficLimitGb === null ? undefined : Number(node.trafficLimitGb)
  });
  editNodeDialogVisible.value = true;
}

function editCustomer(customer: Customer) {
  editingCustomerId.value = customer.id;
  Object.assign(customerForm, {
    name: customer.name,
    loginUsername: customer.loginUsername,
    loginPassword: '',
    email: customer.email || '',
    phone: customer.phone || '',
    balance: Number(customer.balance),
    status: customer.status,
    remark: customer.remark || ''
  });
  customerDialogVisible.value = true;
}

async function removeCustomer(customer: Customer) {
  await ElMessageBox.confirm(`确认删除用户「${customer.name}」？系统只会删除面板用户和本地绑定，不会删除路由节点或远端 3x-ui 入站/客户端。`, '删除确认', { type: 'warning' });
  await api(`/api/admin/customers/${customer.id}`, { method: 'DELETE' });
  ElMessage.success('用户已删除');
  if (editingCustomerId.value === customer.id) resetCustomerForm();
  await loadCustomers();
}

function resetCustomerForm() {
  editingCustomerId.value = '';
  Object.assign(customerForm, { name: '', loginUsername: '', loginPassword: '', email: '', phone: '', balance: 0, status: 'active', remark: '' });
}

function setBindExpireNow() {
  bindForm.expireAt = formatDatePickerValue(new Date());
}

function setBindExpireMonths(months: number) {
  const date = new Date();
  date.setMonth(date.getMonth() + months);
  bindForm.expireAt = formatDatePickerValue(date);
}

function clearBindExpire() {
  bindForm.expireAt = '';
}

function setEditExpireNow() {
  nodeEditForm.expireAt = formatDatePickerValue(new Date());
}

function setEditExpireMonths(months: number) {
  const date = new Date();
  date.setMonth(date.getMonth() + months);
  nodeEditForm.expireAt = formatDatePickerValue(date);
}

function clearEditExpire() {
  nodeEditForm.expireAt = '';
}

function defaultExpireAt() {
  const date = new Date();
  date.setMonth(date.getMonth() + 1);
  return formatDatePickerValue(date);
}

function formatDatePickerValue(date: Date) {
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  const timezoneOffset = -date.getTimezoneOffset();
  const sign = timezoneOffset >= 0 ? '+' : '-';
  const offsetHours = pad(Math.floor(Math.abs(timezoneOffset) / 60));
  const offsetMinutes = pad(Math.abs(timezoneOffset) % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${offsetHours}:${offsetMinutes}`;
}

function formatDate(value?: string | null) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
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

function formatRemoteExpiry(value: unknown) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return '-';
  return new Date(time).toLocaleString('zh-CN', { hour12: false });
}

function formatRemoteLastOnline(value: unknown) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return '-';
  return new Date(time * 1000).toLocaleString('zh-CN', { hour12: false });
}

onMounted(loadCustomers);
</script>

<template>
  <h1 class="page-title">用户管理</h1>
  <el-alert v-if="error" class="page-alert" :title="error" type="error" show-icon :closable="false" />

  <div class="metric-grid compact-metrics">
    <div class="metric"><span>面板用户</span><strong>{{ customers.length }}</strong><small>启用 {{ activeCustomerCount }}</small></div>
    <div class="metric"><span>绑定节点</span><strong>{{ boundNodeCount }}</strong><small>启用 {{ activeBoundNodeCount }}</small></div>
    <div class="metric"><span>路由节点</span><strong>{{ serviceNodes.length }}</strong><small>可绑定节点</small></div>
    <div class="metric"><span>余额操作</span><strong>手动</strong><small>支持增减和设置</small></div>
  </div>

  <div class="panel">
    <div class="panel-toolbar">
      <strong>用户业务</strong>
      <div class="table-toolbar-actions">
        <el-button type="primary" @click="openCustomerDialog">新增用户</el-button>
        <el-button @click="openBindDialog()">绑定节点</el-button>
        <el-button @click="openBalanceDialog()">调整余额</el-button>
        <el-button :loading="loading" @click="loadCustomers">刷新</el-button>
      </div>
    </div>
    <el-collapse v-model="activePanels" class="admin-collapse">
      <el-collapse-item name="customers">
        <template #title>
          <div class="collapse-title"><strong>用户列表</strong><span>{{ customers.length }} 个用户</span></div>
        </template>
        <el-table :data="customers" v-loading="loading" style="width: 100%" row-key="id">
          <el-table-column type="expand" width="44">
            <template #default="{ row }: { row: Customer }">
              <div class="expanded-node-panel">
                <div class="expanded-node-head">
                  <strong>绑定节点</strong>
                  <el-button size="small" type="primary" plain @click="openBindDialog(row)">绑定节点</el-button>
                </div>
                <div v-if="row.nodes?.length" class="node-list expanded-node-list">
                  <div v-for="node in row.nodes" :key="node.id" class="node-row customer-node-row">
                    <div class="node-meta">
                      <strong class="node-title-line">
                        {{ node.serviceNode?.name || node.xuiEmail }}
                        <el-tag size="small" :type="node.status === 'active' ? 'success' : 'info'">{{ node.status === 'active' ? '启用' : '停用' }}</el-tag>
                      </strong>
                      <span>{{ node.serviceNode?.server?.name || '-' }} / {{ node.xuiEmail }}</span>
                      <span>到期 {{ formatDate(node.expireAt) }} · 流量 {{ node.trafficLimitGb ?? '-' }} GB · 同步 {{ formatDate(node.lastSyncedAt) }}</span>
                    </div>
                    <div class="node-actions">
                      <el-select v-model="renewMonths[node.id]" size="small" style="width: 82px">
                        <el-option :value="1" label="1月" />
                        <el-option :value="3" label="3月" />
                        <el-option :value="6" label="6月" />
                        <el-option :value="12" label="12月" />
                      </el-select>
                      <el-button size="small" :loading="renewingIds.has(node.id)" @click="renewNode(row, node)">续费</el-button>
                      <el-tooltip content="同步到 3x-ui" placement="top">
                        <el-button circle size="small" :loading="syncingIds.has(node.id)" @click="syncNode(row, node)"><RefreshCw :size="15" /></el-button>
                      </el-tooltip>
                      <el-tooltip content="查看远端流量" placement="top">
                        <el-button circle size="small" :loading="trafficIds.has(node.id)" @click="showNodeTraffic(row, node)"><Activity :size="15" /></el-button>
                      </el-tooltip>
                      <el-tooltip content="重置远端流量" placement="top">
                        <el-button circle size="small" :loading="resettingTrafficIds.has(node.id)" @click="resetNodeTraffic(row, node)"><RotateCcw :size="15" /></el-button>
                      </el-tooltip>
                      <el-button size="small" @click="editCustomerNode(row, node)">编辑</el-button>
                      <el-button size="small" @click="unbindNode(row, node)">解绑</el-button>
                      <el-button size="small" type="danger" :loading="deletingServiceNodeIds.has(node.id)" @click="deleteBoundServiceNode(row, node)">删除节点</el-button>
                    </div>
                  </div>
                </div>
                <div v-else class="empty-panel compact-empty">该用户还没有绑定节点</div>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="name" label="名称" min-width="130" />
          <el-table-column prop="loginUsername" label="登录账号" min-width="130" />
          <el-table-column prop="balance" label="余额" width="110" />
          <el-table-column label="绑定" width="90"><template #default="{ row }: { row: Customer }">{{ row.nodes?.length || 0 }} 个</template></el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }: { row: Customer }"><el-tag :type="row.status === 'active' ? 'success' : 'info'">{{ row.status === 'active' ? '启用' : '禁用' }}</el-tag></template>
          </el-table-column>
          <el-table-column label="创建时间" min-width="170"><template #default="{ row }: { row: Customer }">{{ formatDate(row.createdAt) }}</template></el-table-column>
          <el-table-column label="操作" width="250" fixed="right">
            <template #default="{ row }: { row: Customer }">
              <el-button size="small" @click="openBindDialog(row)">绑定</el-button>
              <el-button size="small" @click="openBalanceDialog(row)">余额</el-button>
              <el-button size="small" @click="editCustomer(row)">编辑</el-button>
              <el-button size="small" type="danger" @click="removeCustomer(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-collapse-item>
    </el-collapse>
  </div>

  <el-dialog v-model="customerDialogVisible" :title="editingCustomerId ? '编辑用户' : '新增用户'" width="720px" destroy-on-close>
    <el-form :model="customerForm" label-width="82px" class="dialog-form-grid">
      <el-form-item label="名称"><el-input v-model="customerForm.name" /></el-form-item>
      <el-form-item label="登录账号"><el-input v-model="customerForm.loginUsername" /></el-form-item>
      <el-form-item label="登录密码"><el-input v-model="customerForm.loginPassword" type="password" show-password :placeholder="editingCustomerId ? '留空不修改' : '可留空自动生成'" /></el-form-item>
      <el-form-item label="邮箱"><el-input v-model="customerForm.email" placeholder="可留空" /></el-form-item>
      <el-form-item label="手机"><el-input v-model="customerForm.phone" /></el-form-item>
      <el-form-item label="余额"><el-input-number v-model="customerForm.balance" :min="0" :precision="2" style="width: 100%" /></el-form-item>
      <el-form-item label="状态"><el-select v-model="customerForm.status" style="width: 100%"><el-option label="启用" value="active" /><el-option label="禁用" value="disabled" /></el-select></el-form-item>
      <el-form-item label="备注"><el-input v-model="customerForm.remark" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="customerDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="savingCustomer" :disabled="!customerForm.name || !customerForm.loginUsername" @click="saveCustomer">保存</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="bindDialogVisible" title="绑定服务节点" width="760px" destroy-on-close>
    <el-form :model="bindForm" label-width="104px" class="dialog-form-grid">
      <el-form-item label="用户">
        <el-select v-model="bindForm.customerId" placeholder="选择用户" style="width: 100%">
          <el-option v-for="customer in customers" :key="customer.id" :label="`${customer.name} / ${customer.loginUsername}`" :value="customer.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="节点">
        <el-select v-model="bindForm.serviceNodeId" placeholder="选择节点" style="width: 100%">
          <el-option v-for="node in serviceNodes" :key="node.id" :label="`${node.name} / ${node.server?.name || '-'}`" :value="node.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="远端标识"><el-input v-model="bindForm.xuiEmail" placeholder="可留空，使用路由节点已有远端客户端" /></el-form-item>
      <el-form-item label="到期时间">
        <div class="date-picker-stack">
          <el-date-picker v-model="bindForm.expireAt" type="datetime" placeholder="到期时间，可留空" value-format="YYYY-MM-DDTHH:mm:ss.SSSZ" style="width: 100%" />
          <div class="quick-actions">
            <el-button size="small" @click="setBindExpireNow">当前时间</el-button>
            <el-button size="small" @click="setBindExpireMonths(1)">加 1 月</el-button>
            <el-button size="small" @click="clearBindExpire">清空</el-button>
          </div>
        </div>
      </el-form-item>
      <el-form-item label="流量 GB"><el-input-number v-model="bindForm.trafficLimitGb" :min="0" :precision="2" placeholder="可留空" style="width: 100%" /></el-form-item>
      <el-form-item v-if="selectedCustomer?.nodes?.length" label="已绑定"><span class="muted-text">当前用户已绑定 {{ selectedCustomer.nodes.length }} 个节点</span></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="bindDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="binding" :disabled="!bindForm.customerId || !bindForm.serviceNodeId" @click="bindNode">绑定</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="editNodeDialogVisible" title="编辑绑定节点" width="760px" destroy-on-close>
    <el-form :model="nodeEditForm" label-width="104px" class="dialog-form-grid">
      <el-form-item label="服务节点">
        <el-select v-model="nodeEditForm.serviceNodeId" placeholder="选择节点" style="width: 100%">
          <el-option v-for="node in serviceNodes" :key="node.id" :label="`${node.name} / ${node.server?.name || '-'}`" :value="node.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="远端标识"><el-input v-model="nodeEditForm.xuiEmail" placeholder="只更新已有 3x-ui 客户端，不会新建客户端" /></el-form-item>
      <el-form-item label="到期时间">
        <div class="date-picker-stack">
          <el-date-picker v-model="nodeEditForm.expireAt" type="datetime" placeholder="到期时间，可留空" value-format="YYYY-MM-DDTHH:mm:ss.SSSZ" style="width: 100%" />
          <div class="quick-actions">
            <el-button size="small" @click="setEditExpireNow">当前时间</el-button>
            <el-button size="small" @click="setEditExpireMonths(1)">加 1 月</el-button>
            <el-button size="small" @click="clearEditExpire">清空</el-button>
          </div>
        </div>
      </el-form-item>
      <el-form-item label="流量 GB"><el-input-number v-model="nodeEditForm.trafficLimitGb" :min="0" :precision="2" style="width: 100%" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="editNodeDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="updatingCustomerNode" :disabled="!nodeEditForm.serviceNodeId" @click="updateCustomerNode">保存</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="balanceDialogVisible" title="调整余额" width="680px" destroy-on-close>
    <el-form :model="balanceForm" label-width="82px" class="dialog-form-grid">
      <el-form-item label="用户">
        <el-select v-model="balanceForm.customerId" placeholder="选择用户" style="width: 100%">
          <el-option v-for="customer in customers" :key="customer.id" :label="`${customer.name} / ${customer.loginUsername}`" :value="customer.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="方式"><el-select v-model="balanceForm.mode" style="width: 100%"><el-option label="增加" value="add" /><el-option label="扣减" value="subtract" /><el-option label="设置为" value="set" /></el-select></el-form-item>
      <el-form-item label="金额"><el-input-number v-model="balanceForm.amount" :min="0" :precision="2" style="width: 100%" /></el-form-item>
      <el-form-item label="备注"><el-input v-model="balanceForm.remark" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="balanceDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="adjustingBalance" :disabled="!balanceForm.customerId || balanceForm.amount <= 0" @click="adjustBalance">提交</el-button>
    </template>
  </el-dialog>
</template>
