<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api } from '../api';

type Card = {
  id: string;
  codePreview: string;
  amount: string;
  status: string;
  usedAt?: string;
  batch?: { name: string } | null;
  usedBy?: { name: string; loginUsername: string } | null;
};

const loading = ref(false);
const generating = ref(false);
const error = ref('');
const generatedCodes = ref<string[]>([]);
const cards = ref<Card[]>([]);
const form = reactive({ name: '默认批次', amount: 10, quantity: 10, prefix: '' });

async function loadCards() {
  loading.value = true;
  error.value = '';
  try {
    const result = await api<{ items: Card[] }>('/api/admin/cards');
    cards.value = result.items;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

async function generateCards() {
  generating.value = true;
  error.value = '';
  try {
    const result = await api<{ codes: string[] }>('/api/admin/cards/generate', { method: 'POST', body: form });
    generatedCodes.value = result.codes;
    await loadCards();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '生成失败';
  } finally {
    generating.value = false;
  }
}

onMounted(loadCards);
</script>

<template>
  <h1 class="page-title">卡密管理</h1>
  <div class="panel card-form-panel">
    <el-form :model="form" label-width="80px" class="inline-form">
      <el-form-item label="批次名"><el-input v-model="form.name" /></el-form-item>
      <el-form-item label="金额"><el-input-number v-model="form.amount" :min="0" :precision="2" /></el-form-item>
      <el-form-item label="数量"><el-input-number v-model="form.quantity" :min="1" :max="500" /></el-form-item>
      <el-form-item label="前缀"><el-input v-model="form.prefix" placeholder="可选" /></el-form-item>
      <el-form-item><el-button type="primary" :loading="generating" @click="generateCards">生成卡密</el-button></el-form-item>
    </el-form>
    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" />
    <el-input v-if="generatedCodes.length" :model-value="generatedCodes.join('\n')" type="textarea" :rows="6" readonly />
  </div>

  <div class="panel list-panel">
    <div class="panel-toolbar">
      <strong>卡密列表</strong>
      <el-button size="small" :loading="loading" @click="loadCards">刷新</el-button>
    </div>
    <el-table :data="cards" v-loading="loading" style="width: 100%">
      <el-table-column prop="codePreview" label="卡密" width="140" />
      <el-table-column prop="amount" label="金额" width="120" />
      <el-table-column prop="status" label="状态" width="100" />
      <el-table-column label="批次" min-width="140"><template #default="{ row }">{{ row.batch?.name || '-' }}</template></el-table-column>
      <el-table-column label="使用者" min-width="160"><template #default="{ row }">{{ row.usedBy?.name || '-' }}</template></el-table-column>
      <el-table-column prop="usedAt" label="使用时间" min-width="180" />
    </el-table>
  </div>
</template>
