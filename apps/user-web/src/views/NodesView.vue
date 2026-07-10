<script setup lang="ts">
import { onMounted, ref } from 'vue';
import QRCode from 'qrcode';
import { Copy, QrCode, RefreshCw, X } from 'lucide-vue-next';
import { api } from '../api';

type UserNode = {
  id: string;
  status: string;
  expireAt?: string | null;
  trafficLimitGb: string;
  usedTrafficGb: string;
  links?: string[];
  subId?: string;
  serviceNode: { name: string; protocol: string; priceMonthly: string; server: { name: string } };
};

const loading = ref(false);
const renewingId = ref('');
const error = ref('');
const message = ref('');
const nodes = ref<UserNode[]>([]);
const monthsByNode = ref<Record<string, number>>({});
const qrPreview = ref<{ title: string; image: string } | null>(null);

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
    message.value = '续费成功，节点已同步远端';
    await loadNodes();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '续费失败';
  } finally {
    renewingId.value = '';
  }
}

async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
  message.value = '已复制';
}

async function showQrCode(node: UserNode, link: string, index: number) {
  try {
    qrPreview.value = {
      title: `${node.serviceNode.name} / 线路 ${index + 1}`,
      image: await QRCode.toDataURL(link, { width: 260, margin: 1 })
    };
  } catch (err) {
    error.value = err instanceof Error ? err.message : '生成二维码失败';
  }
}

function closeQrCode() {
  qrPreview.value = null;
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
}

onMounted(loadNodes);
</script>

<template>
  <div class="page-heading">
    <h1 class="page-title">我的节点</h1>
    <button class="icon-action" :disabled="loading" @click="loadNodes"><RefreshCw :size="16" />刷新</button>
  </div>
  <div v-if="message" class="panel success-text">{{ message }}</div>
  <div v-if="error" class="panel error-text">{{ error }}</div>

  <div v-else class="node-list" :class="{ loading }">
    <article v-for="node in nodes" :key="node.id" class="panel node-card">
      <div class="node-card-head">
        <div>
          <h2>{{ node.serviceNode.name }}</h2>
          <p>{{ node.serviceNode.server.name }} / {{ node.serviceNode.protocol }}</p>
        </div>
        <span class="status-pill" :class="node.status">{{ node.status === 'active' ? '正常' : '停用' }}</span>
      </div>
      <div class="node-meta">
        <span>到期：{{ formatDate(node.expireAt) }}</span>
        <span>流量：{{ node.usedTrafficGb }} / {{ node.trafficLimitGb }} GB</span>
        <span>月费：{{ node.serviceNode.priceMonthly }} 元</span>
        <span v-if="node.subId">订阅标识：{{ node.subId }}</span>
      </div>
      <div v-if="node.links?.length" class="link-list">
        <div v-for="(link, index) in node.links" :key="link" class="link-row">
          <span class="link-label">线路 {{ index + 1 }}</span>
          <button class="copy-button" type="button" title="复制节点" @click="copyText(link)"><Copy :size="15" /></button>
          <button class="copy-button" type="button" title="显示二维码" @click="showQrCode(node, link, index)"><QrCode :size="15" /></button>
        </div>
      </div>
      <div v-else class="empty-hint">暂未获取到 3-xui 节点链接，请联系管理员同步节点。</div>
      <form class="renew-form" @submit.prevent="renewNode(node.id)">
        <select v-model.number="monthsByNode[node.id]">
          <option :value="1">1 个月</option>
          <option :value="3">3 个月</option>
          <option :value="6">6 个月</option>
          <option :value="12">12 个月</option>
        </select>
        <button :disabled="renewingId === node.id">{{ renewingId === node.id ? '续费中' : '余额续费' }}</button>
      </form>
    </article>
    <div v-if="!loading && !nodes.length" class="panel">暂无节点</div>
  </div>

  <div v-if="qrPreview" class="qr-modal" @click.self="closeQrCode">
    <div class="qr-modal-panel">
      <div class="qr-modal-head">
        <strong>{{ qrPreview.title }}</strong>
        <button class="copy-button" type="button" title="关闭" @click="closeQrCode"><X :size="16" /></button>
      </div>
      <img :src="qrPreview.image" alt="节点二维码" />
    </div>
  </div>
</template>
