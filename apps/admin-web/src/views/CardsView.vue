<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api';

type CardTemplate = { id: string; name: string; amount: string; quantity: number; prefix?: string | null; enabled: boolean; remark?: string | null };
type CardBatch = { id: string; name: string; amount: string; quantity: number; prefix?: string | null; templateId?: string | null; createdAt: string; template?: CardTemplate | null; _count?: { cards: number } };
type Card = { id: string; codePreview: string; amount: string; status: string; usedAt?: string | null; batch?: { id: string; name: string } | null; usedBy?: { name: string; loginUsername: string } | null };
type CardResult = { items: Card[]; batches: CardBatch[]; templates: CardTemplate[] };

const loading = ref(false);
const generating = ref(false);
const savingTemplate = ref(false);
const error = ref('');
const generatedCodes = ref<string[]>([]);
const cards = ref<Card[]>([]);
const batches = ref<CardBatch[]>([]);
const templates = ref<CardTemplate[]>([]);
const editingTemplateId = ref('');
const generateForm = reactive({ templateId: '', name: defaultBatchName(), amount: 10, quantity: 10, prefix: '' });
const templateForm = reactive({ name: '', amount: 10, quantity: 10, prefix: '', enabled: true, remark: '' });

const enabledTemplates = computed(() => templates.value.filter((template) => template.enabled));
const selectedTemplate = computed(() => templates.value.find((item) => item.id === generateForm.templateId));

async function loadCards() {
  loading.value = true;
  error.value = '';
  try {
    const result = await api<CardResult>('/api/admin/cards');
    cards.value = result.items;
    batches.value = result.batches;
    templates.value = result.templates;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载卡密数据失败';
  } finally {
    loading.value = false;
  }
}

async function saveTemplate() {
  savingTemplate.value = true;
  error.value = '';
  try {
    const path = editingTemplateId.value ? `/api/admin/card-templates/${editingTemplateId.value}` : '/api/admin/card-templates';
    await api(path, { method: editingTemplateId.value ? 'PATCH' : 'POST', body: templateForm });
    ElMessage.success(editingTemplateId.value ? '模板已更新' : '模板已新增');
    resetTemplateForm();
    await loadCards();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存模板失败';
  } finally {
    savingTemplate.value = false;
  }
}

async function generateCards() {
  generating.value = true;
  error.value = '';
  try {
    const template = selectedTemplate.value;
    const body = template
      ? { templateId: template.id, name: generateForm.name || defaultBatchName(template.name), amount: Number(template.amount), quantity: template.quantity, prefix: template.prefix || '' }
      : { ...generateForm, templateId: undefined };
    const result = await api<{ codes: string[] }>('/api/admin/cards/generate', { method: 'POST', body });
    generatedCodes.value = result.codes;
    ElMessage.success(`已生成 ${result.codes.length} 张卡密`);
    resetGenerateForm(template?.id || '');
    await loadCards();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '生成卡密失败';
  } finally {
    generating.value = false;
  }
}

function useTemplate(template: CardTemplate) {
  generateForm.templateId = template.id;
  generateForm.name = defaultBatchName(template.name);
  generateForm.amount = Number(template.amount);
  generateForm.quantity = template.quantity;
  generateForm.prefix = template.prefix || '';
}

function onTemplateChange(templateId: string) {
  const template = templates.value.find((item) => item.id === templateId);
  if (template) useTemplate(template);
}

function editTemplate(template: CardTemplate) {
  editingTemplateId.value = template.id;
  Object.assign(templateForm, { name: template.name, amount: Number(template.amount), quantity: template.quantity, prefix: template.prefix || '', enabled: template.enabled, remark: template.remark || '' });
}

async function removeTemplate(template: CardTemplate) {
  await ElMessageBox.confirm(`确认删除模板「${template.name}」？已经生成的批次和卡密会保留。`, '删除确认', { type: 'warning' });
  await api(`/api/admin/card-templates/${template.id}`, { method: 'DELETE' });
  ElMessage.success('模板已删除');
  if (editingTemplateId.value === template.id) resetTemplateForm();
  if (generateForm.templateId === template.id) clearTemplateSelection();
  await loadCards();
}

async function removeBatch(batch: CardBatch) {
  await ElMessageBox.confirm(`确认删除批次「${batch.name}」及其未使用卡密？如果批次内已有使用记录，系统会拒绝删除。`, '删除确认', { type: 'warning' });
  await api(`/api/admin/card-batches/${batch.id}`, { method: 'DELETE' });
  ElMessage.success('批次已删除');
  await loadCards();
}

async function removeCard(card: Card) {
  await ElMessageBox.confirm(`确认删除卡密 ${card.codePreview}？已使用卡密不能删除。`, '删除确认', { type: 'warning' });
  await api(`/api/admin/cards/${card.id}`, { method: 'DELETE' });
  ElMessage.success('卡密已删除');
  await loadCards();
}

function resetTemplateForm() {
  editingTemplateId.value = '';
  Object.assign(templateForm, { name: '', amount: 10, quantity: 10, prefix: '', enabled: true, remark: '' });
}

function resetGenerateForm(templateId = '') {
  Object.assign(generateForm, { templateId: '', name: defaultBatchName(), amount: 10, quantity: 10, prefix: '' });
  if (templateId) {
    const template = templates.value.find((item) => item.id === templateId);
    if (template) useTemplate(template);
  }
}

function clearTemplateSelection() {
  resetGenerateForm();
}

function defaultBatchName(templateName = '卡密批次') {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  return `${templateName}-${stamp}`;
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
}

function statusLabel(status: string) {
  if (status === 'unused') return '未使用';
  if (status === 'used') return '已使用';
  return status;
}

onMounted(loadCards);
</script>

<template>
  <h1 class="page-title">卡密管理</h1>
  <el-alert v-if="error" class="page-alert" :title="error" type="error" show-icon :closable="false" />

  <div class="settings-grid card-manage-grid">
    <section class="panel">
      <div class="panel-toolbar">
        <strong>{{ editingTemplateId ? '编辑模板' : '卡密模板' }}</strong>
        <el-button size="small" @click="resetTemplateForm">新增模板</el-button>
      </div>
      <el-form :model="templateForm" label-width="82px">
        <el-form-item label="模板名称"><el-input v-model="templateForm.name" /></el-form-item>
        <el-form-item label="金额"><el-input-number v-model="templateForm.amount" :min="0.01" :precision="2" style="width: 100%" /></el-form-item>
        <el-form-item label="数量"><el-input-number v-model="templateForm.quantity" :min="1" :max="500" style="width: 100%" /></el-form-item>
        <el-form-item label="前缀"><el-input v-model="templateForm.prefix" maxlength="16" placeholder="可留空" /></el-form-item>
        <el-form-item label="启用"><el-switch v-model="templateForm.enabled" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="templateForm.remark" /></el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="savingTemplate" :disabled="!templateForm.name" @click="saveTemplate">{{ editingTemplateId ? '保存模板' : '新增模板' }}</el-button>
          <el-button v-if="editingTemplateId" @click="resetTemplateForm">取消编辑</el-button>
        </el-form-item>
      </el-form>
    </section>

    <section class="panel">
      <div class="panel-toolbar"><strong>生成卡密</strong></div>
      <el-form :model="generateForm" label-width="82px">
        <el-form-item label="选择模板">
          <el-select v-model="generateForm.templateId" clearable style="width: 100%" @change="onTemplateChange" @clear="clearTemplateSelection">
            <el-option v-for="item in enabledTemplates" :key="item.id" :label="`${item.name} / ${item.amount} 元 / ${item.quantity} 张`" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="批次名称"><el-input v-model="generateForm.name" /></el-form-item>
        <el-form-item label="金额"><el-input-number v-model="generateForm.amount" :disabled="Boolean(selectedTemplate)" :min="0.01" :precision="2" style="width: 100%" /></el-form-item>
        <el-form-item label="数量"><el-input-number v-model="generateForm.quantity" :disabled="Boolean(selectedTemplate)" :min="1" :max="500" style="width: 100%" /></el-form-item>
        <el-form-item label="前缀"><el-input v-model="generateForm.prefix" :disabled="Boolean(selectedTemplate)" maxlength="16" /></el-form-item>
        <el-form-item><el-button type="primary" :loading="generating" :disabled="!generateForm.name" @click="generateCards">生成卡密</el-button></el-form-item>
      </el-form>
      <el-input v-if="generatedCodes.length" class="generated-codes" :model-value="generatedCodes.join('\n')" type="textarea" :rows="8" readonly />
    </section>
  </div>

  <div class="panel list-panel">
    <div class="panel-toolbar">
      <strong>模板列表</strong>
      <el-button size="small" :loading="loading" @click="loadCards">刷新</el-button>
    </div>
    <el-table :data="templates" v-loading="loading" style="width: 100%">
      <el-table-column prop="name" label="模板名称" min-width="150" />
      <el-table-column prop="amount" label="金额" width="110" />
      <el-table-column prop="quantity" label="数量" width="90" />
      <el-table-column prop="prefix" label="前缀" width="120" />
      <el-table-column label="状态" width="90"><template #default="{ row }: { row: CardTemplate }"><el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag></template></el-table-column>
      <el-table-column prop="remark" label="备注" min-width="180" />
      <el-table-column label="操作" width="210" fixed="right">
        <template #default="{ row }: { row: CardTemplate }">
          <el-button size="small" @click="useTemplate(row)">套用</el-button>
          <el-button size="small" @click="editTemplate(row)">编辑</el-button>
          <el-button size="small" type="danger" @click="removeTemplate(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>

  <div class="panel list-panel">
    <div class="panel-toolbar"><strong>批次列表</strong></div>
    <el-table :data="batches" v-loading="loading" style="width: 100%">
      <el-table-column prop="name" label="批次名称" min-width="170" />
      <el-table-column label="来源模板" min-width="130"><template #default="{ row }: { row: CardBatch }">{{ row.template?.name || '-' }}</template></el-table-column>
      <el-table-column prop="amount" label="金额" width="110" />
      <el-table-column prop="quantity" label="数量" width="90" />
      <el-table-column prop="prefix" label="前缀" width="110" />
      <el-table-column label="卡密数" width="100"><template #default="{ row }: { row: CardBatch }">{{ row._count?.cards ?? row.quantity }}</template></el-table-column>
      <el-table-column label="创建时间" min-width="180"><template #default="{ row }: { row: CardBatch }">{{ formatDate(row.createdAt) }}</template></el-table-column>
      <el-table-column label="操作" width="90" fixed="right"><template #default="{ row }: { row: CardBatch }"><el-button size="small" type="danger" @click="removeBatch(row)">删除</el-button></template></el-table-column>
    </el-table>
  </div>

  <div class="panel list-panel">
    <div class="panel-toolbar"><strong>卡密列表</strong></div>
    <el-table :data="cards" v-loading="loading" style="width: 100%">
      <el-table-column prop="codePreview" label="卡密" width="140" />
      <el-table-column prop="amount" label="金额" width="120" />
      <el-table-column label="状态" width="100"><template #default="{ row }: { row: Card }"><el-tag :type="row.status === 'unused' ? 'success' : row.status === 'used' ? 'warning' : 'info'">{{ statusLabel(row.status) }}</el-tag></template></el-table-column>
      <el-table-column label="批次" min-width="140"><template #default="{ row }: { row: Card }">{{ row.batch?.name || '-' }}</template></el-table-column>
      <el-table-column label="使用用户" min-width="160"><template #default="{ row }: { row: Card }">{{ row.usedBy?.name || '-' }}</template></el-table-column>
      <el-table-column label="使用时间" min-width="180"><template #default="{ row }: { row: Card }">{{ formatDate(row.usedAt) }}</template></el-table-column>
      <el-table-column label="操作" width="90" fixed="right"><template #default="{ row }: { row: Card }"><el-button size="small" type="danger" :disabled="row.status === 'used'" @click="removeCard(row)">删除</el-button></template></el-table-column>
    </el-table>
  </div>
</template>
