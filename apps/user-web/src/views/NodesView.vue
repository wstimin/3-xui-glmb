<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';

type UserNode = {
  id: string;
  status: string;
  expireAt?: string;
  trafficLimitGb: string;
  usedTrafficGb: string;
  serviceNode: { name: string; protocol: string; server: { name: string } };
};

const loading = ref(false);
const renewingId = ref('');
const error = ref('');
const message = ref('');
const nodes = ref<UserNode[]>([]);
const monthsByNode = ref<Record<string, number>>({});

async function loadNodes() {
  loading.value = true;
  error.value = '';
  try {
    nodes.value = await api<UserNode[]>('/api/user/nodes');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

async function renewNode(nodeId: string) {
  renewingId.value = nodeId;
  error.value = '';
  message.value = '';
  try {
    const months = monthsByNode.value[nodeId] || 1;
    await api('/api/user/renewals', { method: 'POST', body: { nodeId, months } });
    message.value = '续费成功';
    await loadNodes();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '续费失败';
  } finally {
    renewingId.value = '';
  }
}

onMounted(loadNodes);
</script>

<template>
  <h1 class="page-title">我的节点</h1>
  <div v-if="message" class="panel success-text">{{ message }}</div>
  <div v-if="error" class="panel error-text">{{ error }}</div>
  <div v-else class="node-list" :class="{ loading }">
    <article v-for="node in nodes" :key="node.id" class="panel node-card">
      <h2>{{ node.serviceNode.name }}</h2>
      <p>{{ node.serviceNode.server.name }} · {{ node.serviceNode.protocol }}</p>
      <div class="node-meta">
        <span>状态：{{ node.status }}</span>
        <span>到期：{{ node.expireAt || '-' }}</span>
        <span>流量：{{ node.usedTrafficGb }} / {{ node.trafficLimitGb }} GB</span>
      </div>
      <form class="renew-form" @submit.prevent="renewNode(node.id)">
        <select v-model.number="monthsByNode[node.id]">
          <option :value="1">1 个月</option>
          <option :value="3">3 个月</option>
          <option :value="6">6 个月</option>
          <option :value="12">12 个月</option>
        </select>
        <button :disabled="renewingId === node.id">{{ renewingId === node.id ? '续费中' : '续费' }}</button>
      </form>
    </article>
    <div v-if="!loading && !nodes.length" class="panel">暂无节点</div>
  </div>
</template>
