<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { RefreshCw } from 'lucide-vue-next';
import { api } from '../api';

type CustomerNode = {
  id: string;
  xuiEmail: string;
  expireAt: string | null;
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
const adjustingBalance = ref(false);
const error = ref('');
const customers = ref<Customer[]>([]);
const serviceNodes = ref<ServiceNode[]>([]);
const syncingIds = ref<Set<string>>(new Set());
const renewingIds = ref<Set<string>>(new Set());
const editingCustomerId = ref('');
const customerForm = reactive({ name: '', loginUsername: '', loginPassword: '', email: '', phone: '', balance: 0, status: 'active' as 'active' | 'disabled', remark: '' });
const bindForm = reactive({ customerId: '', serviceNodeId: '', xuiEmail: '', expireAt: '', trafficLimitGb: undefined as number | undefined });
const balanceForm = reactive({ customerId: '', mode: 'add' as 'add' | 'subtract' | 'set', amount: 0, remark: '' });
const renewMonths = ref<Record<string, number>>({});

const selectedCustomer = computed(() => customers.value.find((item) => item.id === bindForm.customerId));

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
    ElMessage.success('节点已绑定');
    Object.assign(bindForm, { xuiEmail: '', expireAt: '', trafficLimitGb: undefined });
    await loadCustomers();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '绑定失败';
  } finally {
    binding.value = false;
  }
}

async function adjustBalance() {
  if (!balanceForm.customerId || balanceForm.amount <= 0) return;
  adjustingBalance.value = true;
  error.value = '';
  try {
    await api(`/api/admin/customers/${balanceForm.customerId}/balance-adjustments`, { method: 'POST', body: balanceForm });
    ElMessage.success('余额已调整');
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

async function unbindNode(customer: Customer, node: CustomerNode) {
  await ElMessageBox.confirm(`确认解绑「${node.serviceNode?.name || node.xuiEmail}」？`, '解绑确认', { type: 'warning' });
  await api(`/api/admin/customers/${customer.id}/nodes/${node.id}`, { method: 'DELETE' });
  ElMessage.success('节点已解绑');
  await loadCustomers();
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
}

async function removeCustomer(customer: Customer) {
  await ElMessageBox.confirm(`确认删除用户「${customer.name}」？系统会先删除该用户所有远端 3x-ui 客户端，再删除本地用户。`, '删除确认', { type: 'warning' });
  await api(`/api/admin/customers/${customer.id}`, { method: 'DELETE' });
  ElMessage.success('用户已删除');
  if (editingCustomerId.value === customer.id) resetCustomerForm();
  await loadCustomers();
}

function resetCustomerForm() {
  editingCustomerId.value = '';
  Object.assign(customerForm, { name: '', loginUsername: '', loginPassword: '', email: '', phone: '', balance: 0, status: 'active', remark: '' });
}

function formatDate(value?: string | null) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

onMounted(loadCustomers);
</script>

<template>
  <h1 class="page-title">用户管理</h1>
  <el-alert v-if="error" class="page-alert" :title="error" type="error" show-icon :closable="false" />

  <div class="panel customer-form-panel">
    <div class="panel-toolbar">
      <strong>{{ editingCustomerId ? '编辑用户' : '新增用户' }}</strong>
      <el-button size="small" @click="resetCustomerForm">新增</el-button>
    </div>
    <el-form :model="customerForm" label-width="82px" class="customer-form-grid">
      <el-form-item label="名称"><el-input v-model="customerForm.name" /></el-form-item>
      <el-form-item label="登录账号"><el-input v-model="customerForm.loginUsername" /></el-form-item>
      <el-form-item label="登录密码"><el-input v-model="customerForm.loginPassword" type="password" show-password :placeholder="editingCustomerId ? '留空不修改' : '可留空自动生成'" /></el-form-item>
      <el-form-item label="邮箱"><el-input v-model="customerForm.email" placeholder="可留空" /></el-form-item>
      <el-form-item label="手机"><el-input v-model="customerForm.phone" /></el-form-item>
      <el-form-item label="余额"><el-input-number v-model="customerForm.balance" :min="0" :precision="2" style="width: 100%" /></el-form-item>
      <el-form-item label="状态"><el-select v-model="customerForm.status" style="width: 100%"><el-option label="启用" value="active" /><el-option label="禁用" value="disabled" /></el-select></el-form-item>
      <el-form-item label="备注"><el-input v-model="customerForm.remark" /></el-form-item>
      <el-form-item><el-button type="primary" :loading="savingCustomer" :disabled="!customerForm.name || !customerForm.loginUsername" @click="saveCustomer">{{ editingCustomerId ? '保存用户' : '新增用户' }}</el-button></el-form-item>
    </el-form>
  </div>

  <div class="panel bind-panel">
    <div class="panel-toolbar"><strong>绑定服务节点</strong></div>
    <div class="bind-row bind-row-wide">
      <el-select v-model="bindForm.customerId" placeholder="选择用户">
        <el-option v-for="customer in customers" :key="customer.id" :label="`${customer.name} / ${customer.loginUsername}`" :value="customer.id" />
      </el-select>
      <el-select v-model="bindForm.serviceNodeId" placeholder="选择节点">
        <el-option v-for="node in serviceNodes" :key="node.id" :label="`${node.name} / ${node.server?.name || '-'}`" :value="node.id" />
      </el-select>
      <el-input v-model="bindForm.xuiEmail" placeholder="3x-ui 邮箱，可留空" />
      <el-date-picker v-model="bindForm.expireAt" type="datetime" placeholder="到期时间，可留空" value-format="YYYY-MM-DDTHH:mm:ss.SSSZ" style="width: 100%" />
      <el-input-number v-model="bindForm.trafficLimitGb" :min="0" :precision="2" placeholder="流量 GB，可留空" style="width: 100%" />
      <el-button type="primary" :loading="binding" :disabled="!bindForm.customerId || !bindForm.serviceNodeId" @click="bindNode">绑定</el-button>
    </div>
    <div v-if="selectedCustomer?.nodes?.length" class="bind-hint">当前用户已绑定 {{ selectedCustomer.nodes.length }} 个节点</div>
  </div>

  <div class="panel bind-panel">
    <div class="panel-toolbar"><strong>调整余额</strong></div>
    <div class="bind-row balance-row">
      <el-select v-model="balanceForm.customerId" placeholder="选择用户">
        <el-option v-for="customer in customers" :key="customer.id" :label="`${customer.name} / ${customer.loginUsername}`" :value="customer.id" />
      </el-select>
      <el-select v-model="balanceForm.mode"><el-option label="增加" value="add" /><el-option label="扣减" value="subtract" /><el-option label="设置为" value="set" /></el-select>
      <el-input-number v-model="balanceForm.amount" :min="0" :precision="2" style="width: 100%" />
      <el-input v-model="balanceForm.remark" placeholder="备注" />
      <el-button type="primary" :loading="adjustingBalance" :disabled="!balanceForm.customerId || balanceForm.amount <= 0" @click="adjustBalance">提交</el-button>
    </div>
  </div>

  <div class="panel">
    <div class="panel-toolbar">
      <strong>用户列表</strong>
      <el-button size="small" :loading="loading" @click="loadCustomers">刷新</el-button>
    </div>
    <el-table :data="customers" v-loading="loading" style="width: 100%" row-key="id">
      <el-table-column prop="name" label="名称" min-width="130" />
      <el-table-column prop="loginUsername" label="登录账号" min-width="130" />
      <el-table-column prop="balance" label="余额" width="110" />
      <el-table-column label="状态" width="90"><template #default="{ row }: { row: Customer }"><el-tag :type="row.status === 'active' ? 'success' : 'info'">{{ row.status === 'active' ? '启用' : '禁用' }}</el-tag></template></el-table-column>
      <el-table-column label="绑定节点" min-width="520">
        <template #default="{ row }: { row: Customer }">
          <div v-if="row.nodes?.length" class="node-list">
            <div v-for="node in row.nodes" :key="node.id" class="node-row customer-node-row">
              <div class="node-meta">
                <strong>{{ node.serviceNode?.name || node.xuiEmail }}</strong>
                <span>{{ node.serviceNode?.server?.name || '-' }} / {{ node.xuiEmail }}</span>
                <span>到期 {{ formatDate(node.expireAt) }} · 同步 {{ formatDate(node.lastSyncedAt) }}</span>
              </div>
              <div class="node-actions">
                <el-select v-model="renewMonths[node.id]" size="small" style="width: 82px"><el-option :value="1" label="1月" /><el-option :value="3" label="3月" /><el-option :value="6" label="6月" /><el-option :value="12" label="12月" /></el-select>
                <el-button size="small" :loading="renewingIds.has(node.id)" @click="renewNode(row, node)">续费</el-button>
                <el-tooltip content="同步到 3x-ui" placement="top">
                  <el-button circle size="small" :loading="syncingIds.has(node.id)" @click="syncNode(row, node)"><RefreshCw :size="15" /></el-button>
                </el-tooltip>
                <el-button size="small" type="danger" @click="unbindNode(row, node)">解绑</el-button>
              </div>
            </div>
          </div>
          <span v-else class="muted-text">未绑定</span>
        </template>
      </el-table-column>
      <el-table-column label="创建时间" min-width="170"><template #default="{ row }: { row: Customer }">{{ formatDate(row.createdAt) }}</template></el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }: { row: Customer }">
          <el-button size="small" @click="editCustomer(row)">编辑</el-button>
          <el-button size="small" type="danger" @click="removeCustomer(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>
