<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
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
  balance: string;
  status: string;
  createdAt: string;
  nodes?: CustomerNode[];
};

type ServiceNode = { id: string; name: string; server?: { name: string } };

const loading = ref(false);
const binding = ref(false);
const error = ref('');
const customers = ref<Customer[]>([]);
const serviceNodes = ref<ServiceNode[]>([]);
const syncingIds = ref<Set<string>>(new Set());
const bindForm = ref({ customerId: '', serviceNodeId: '' });

const selectedCustomer = computed(() => customers.value.find((item) => item.id === bindForm.value.customerId));

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
    if (!bindForm.value.customerId && customerResult.items[0]) bindForm.value.customerId = customerResult.items[0].id;
    if (!bindForm.value.serviceNodeId && nodeResult[0]) bindForm.value.serviceNodeId = nodeResult[0].id;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

async function bindNode() {
  if (!bindForm.value.customerId || !bindForm.value.serviceNodeId) return;
  binding.value = true;
  error.value = '';
  try {
    await api(`/api/admin/customers/${bindForm.value.customerId}/nodes`, { method: 'POST', body: { serviceNodeId: bindForm.value.serviceNodeId } });
    ElMessage.success('节点已绑定');
    await loadCustomers();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '绑定失败';
  } finally {
    binding.value = false;
  }
}

async function syncNode(customer: Customer, node: CustomerNode) {
  const next = new Set(syncingIds.value);
  next.add(node.id);
  syncingIds.value = next;
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

function formatDate(value?: string | null) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

onMounted(loadCustomers);
</script>

<template>
  <h1 class="page-title">用户管理</h1>
  <div class="panel bind-panel">
    <div class="panel-toolbar"><strong>绑定服务节点</strong></div>
    <div class="bind-row">
      <el-select v-model="bindForm.customerId" placeholder="选择用户">
        <el-option v-for="customer in customers" :key="customer.id" :label="`${customer.name} / ${customer.loginUsername}`" :value="customer.id" />
      </el-select>
      <el-select v-model="bindForm.serviceNodeId" placeholder="选择节点">
        <el-option v-for="node in serviceNodes" :key="node.id" :label="`${node.name} / ${node.server?.name || '-'}`" :value="node.id" />
      </el-select>
      <el-button type="primary" :loading="binding" :disabled="!bindForm.customerId || !bindForm.serviceNodeId" @click="bindNode">绑定</el-button>
    </div>
    <div v-if="selectedCustomer?.nodes?.length" class="bind-hint">当前用户已绑定 {{ selectedCustomer.nodes.length }} 个节点</div>
  </div>

  <div class="panel">
    <div class="panel-toolbar">
      <strong>用户列表</strong>
      <el-button size="small" :loading="loading" @click="loadCustomers">刷新</el-button>
    </div>
    <el-alert v-if="error" class="page-alert" :title="error" type="error" show-icon :closable="false" />
    <el-table :data="customers" v-loading="loading" style="width: 100%" row-key="id">
      <el-table-column prop="name" label="名称" min-width="140" />
      <el-table-column prop="loginUsername" label="登录账号" min-width="140" />
      <el-table-column prop="balance" label="余额" width="120" />
      <el-table-column prop="status" label="状态" width="100" />
      <el-table-column label="绑定节点" min-width="360">
        <template #default="{ row }: { row: Customer }">
          <div v-if="row.nodes?.length" class="node-list">
            <div v-for="node in row.nodes" :key="node.id" class="node-row">
              <div class="node-meta">
                <strong>{{ node.serviceNode?.name || node.xuiEmail }}</strong>
                <span>{{ node.serviceNode?.server?.name || '-' }} / {{ node.xuiEmail }}</span>
                <span>到期 {{ formatDate(node.expireAt) }} · 同步 {{ formatDate(node.lastSyncedAt) }}</span>
              </div>
              <el-tooltip content="同步到 3x-ui" placement="top">
                <el-button circle size="small" :loading="syncingIds.has(node.id)" @click="syncNode(row, node)">
                  <RefreshCw :size="15" />
                </el-button>
              </el-tooltip>
            </div>
          </div>
          <span v-else class="muted-text">未绑定</span>
        </template>
      </el-table-column>
      <el-table-column prop="createdAt" label="创建时间" min-width="180">
        <template #default="{ row }: { row: Customer }">{{ formatDate(row.createdAt) }}</template>
      </el-table-column>
    </el-table>
  </div>
</template>
