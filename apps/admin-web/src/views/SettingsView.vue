<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api';

type AdminSettings = { brand: { brandName: string; logoDataUrl: string }; payments: unknown[] };

const loading = ref(false);
const savingBrand = ref(false);
const changingPassword = ref(false);
const error = ref('');
const brandForm = reactive({ brandName: '十夜管理系统', logoDataUrl: '' });
const passwordForm = reactive({ currentPassword: '', newPassword: '' });

async function loadSettings() {
  loading.value = true;
  error.value = '';
  try {
    const result = await api<AdminSettings>('/api/admin/settings');
    Object.assign(brandForm, result.brand);
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

async function saveBrand() {
  savingBrand.value = true;
  error.value = '';
  try {
    await api<AdminSettings>('/api/admin/settings', { method: 'PUT', body: { brand: brandForm } });
    ElMessage.success('品牌设置已保存');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存失败';
  } finally {
    savingBrand.value = false;
  }
}

async function changePassword() {
  changingPassword.value = true;
  error.value = '';
  try {
    await api('/api/change-password', { method: 'POST', body: passwordForm });
    ElMessage.success('密码已修改，请重新登录');
    Object.assign(passwordForm, { currentPassword: '', newPassword: '' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : '修改失败';
  } finally {
    changingPassword.value = false;
  }
}

onMounted(loadSettings);
</script>

<template>
  <h1 class="page-title">系统设置</h1>
  <el-alert v-if="error" class="page-alert" :title="error" type="error" show-icon :closable="false" />

  <div class="settings-grid">
    <div class="panel">
      <div class="panel-toolbar"><strong>品牌设置</strong></div>
      <el-form :model="brandForm" label-width="88px" v-loading="loading">
        <el-form-item label="系统名称"><el-input v-model="brandForm.brandName" maxlength="80" /></el-form-item>
        <el-form-item label="Logo Data"><el-input v-model="brandForm.logoDataUrl" type="textarea" :rows="3" placeholder="可留空" /></el-form-item>
        <el-form-item><el-button type="primary" :loading="savingBrand" @click="saveBrand">保存</el-button></el-form-item>
      </el-form>
    </div>

    <div class="panel">
      <div class="panel-toolbar"><strong>账号安全</strong></div>
      <el-form :model="passwordForm" label-width="88px">
        <el-form-item label="当前密码"><el-input v-model="passwordForm.currentPassword" type="password" show-password /></el-form-item>
        <el-form-item label="新密码"><el-input v-model="passwordForm.newPassword" type="password" show-password minlength="8" /></el-form-item>
        <el-form-item><el-button type="primary" :loading="changingPassword" :disabled="!passwordForm.currentPassword || passwordForm.newPassword.length < 8" @click="changePassword">修改密码</el-button></el-form-item>
      </el-form>
    </div>

    <div class="panel">
      <div class="panel-toolbar"><strong>能力状态</strong></div>
      <el-descriptions :column="1" border>
        <el-descriptions-item label="在线支付">未启用</el-descriptions-item>
        <el-descriptions-item label="自动停用过期节点">未启用</el-descriptions-item>
        <el-descriptions-item label="远端流量同步任务">未启用</el-descriptions-item>
      </el-descriptions>
    </div>
  </div>
</template>
