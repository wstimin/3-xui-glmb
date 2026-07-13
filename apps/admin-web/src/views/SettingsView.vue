<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Upload, X } from 'lucide-vue-next';
import { api } from '../api';

type RuntimeSettings = { adminPath: string; activeAdminPath: string; restartRequired: boolean };
type AdminSettings = { brand: { brandName: string; logoDataUrl: string }; business: { cardPurchaseUrl: string }; runtime: RuntimeSettings };

const loading = ref(false);
const savingBrand = ref(false);
const savingBusiness = ref(false);
const savingRuntime = ref(false);
const changingPassword = ref(false);
const error = ref('');
const brandForm = reactive({ brandName: '十夜管理系统', logoDataUrl: '' });
const businessForm = reactive({ cardPurchaseUrl: '' });
const runtimeForm = reactive<RuntimeSettings>({ adminPath: '/admin', activeAdminPath: '/admin', restartRequired: false });
const passwordForm = reactive({ currentPassword: '', newPassword: '' });

async function loadSettings() {
  loading.value = true;
  error.value = '';
  try {
    const settings = await api<AdminSettings>('/api/admin/settings');
    Object.assign(brandForm, settings.brand);
    Object.assign(businessForm, settings.business || { cardPurchaseUrl: '' });
    Object.assign(runtimeForm, settings.runtime || { adminPath: '/admin', activeAdminPath: '/admin', restartRequired: false });
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

async function saveRuntime() {
  savingRuntime.value = true;
  error.value = '';
  const previousAdminPath = runtimeForm.activeAdminPath;
  try {
    const settings = await api<AdminSettings>('/api/admin/settings', { method: 'PUT', body: { runtime: { adminPath: runtimeForm.adminPath } } });
    Object.assign(runtimeForm, settings.runtime || { adminPath: '/admin', activeAdminPath: '/admin', restartRequired: false });
    ElMessage.success('管理路径已保存并生效');
    if (runtimeForm.activeAdminPath !== previousAdminPath) {
      window.setTimeout(() => {
        window.location.assign(`${window.location.origin}${runtimeForm.activeAdminPath}/settings`);
      }, 400);
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存管理路径失败';
  } finally {
    savingRuntime.value = false;
  }
}

async function saveBrand() {
  savingBrand.value = true;
  error.value = '';
  try {
    const settings = await api<AdminSettings>('/api/admin/settings', { method: 'PUT', body: { brand: brandForm } });
    Object.assign(brandForm, settings.brand);
    window.dispatchEvent(new CustomEvent('shiye:branding-updated', { detail: settings.brand }));
    ElMessage.success('品牌设置已保存');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存失败';
  } finally {
    savingBrand.value = false;
  }
}

async function saveBusiness() {
  savingBusiness.value = true;
  error.value = '';
  try {
    await api<AdminSettings>('/api/admin/settings', { method: 'PUT', body: { business: businessForm } });
    ElMessage.success('业务设置已保存');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存业务设置失败';
  } finally {
    savingBusiness.value = false;
  }
}

async function onLogoSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    ElMessage.error('请选择图片文件');
    return;
  }
  if (file.size > 3 * 1024 * 1024) {
    ElMessage.error('Logo 图片不能超过 3MB');
    return;
  }
  try {
    brandForm.logoDataUrl = await imageToDataUrl(file, 256);
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : 'Logo 图片读取失败');
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

function imageToDataUrl(file: File, maxSize: number) {
  return new Promise<string>((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('浏览器不支持图片处理'));
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Logo 图片读取失败'));
    };
    image.src = url;
  });
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
        <el-form-item label="Logo">
          <div class="logo-uploader">
            <div class="logo-preview">
              <img v-if="brandForm.logoDataUrl" :src="brandForm.logoDataUrl" alt="Logo" />
              <span v-else>{{ brandForm.brandName.slice(0, 1) }}</span>
            </div>
            <label class="file-button">
              <Upload :size="16" />
              <span>上传图片</span>
              <input type="file" accept="image/*" @change="onLogoSelected" />
            </label>
            <el-button v-if="brandForm.logoDataUrl" plain @click="brandForm.logoDataUrl = ''"><X :size="15" />清除</el-button>
          </div>
        </el-form-item>
        <el-form-item><el-button type="primary" :loading="savingBrand" @click="saveBrand">保存品牌</el-button></el-form-item>
      </el-form>
    </div>

    <div class="panel">
      <div class="panel-toolbar"><strong>账号安全</strong></div>
      <el-form :model="passwordForm" label-width="88px" autocomplete="off">
        <el-form-item label="当前密码"><el-input v-model="passwordForm.currentPassword" name="shiye-current-passcode" type="password" show-password autocomplete="new-password" /></el-form-item>
        <el-form-item label="新密码"><el-input v-model="passwordForm.newPassword" name="shiye-next-passcode" type="password" show-password autocomplete="new-password" minlength="8" /></el-form-item>
        <el-form-item><el-button type="primary" :loading="changingPassword" :disabled="!passwordForm.currentPassword || passwordForm.newPassword.length < 8" @click="changePassword">修改密码</el-button></el-form-item>
      </el-form>
    </div>

    <div class="panel">
      <div class="panel-toolbar"><strong>业务设置</strong></div>
      <el-form :model="businessForm" label-width="112px" v-loading="loading">
        <el-form-item label="卡密购买地址"><el-input v-model="businessForm.cardPurchaseUrl" placeholder="https://example.com/buy" /></el-form-item>
        <el-form-item><el-button type="primary" :loading="savingBusiness" @click="saveBusiness">保存业务设置</el-button></el-form-item>
      </el-form>
    </div>

    <div class="panel">
      <div class="panel-toolbar"><strong>运行环境</strong></div>
      <el-form :model="runtimeForm" label-width="112px" v-loading="loading">
        <el-form-item label="管理路径">
          <el-input v-model="runtimeForm.adminPath" placeholder="/admin" maxlength="80" />
        </el-form-item>
        <el-form-item label="当前生效">
          <span class="muted-text">{{ runtimeForm.activeAdminPath }}</span>
        </el-form-item>
        <el-form-item><el-button type="primary" :loading="savingRuntime" @click="saveRuntime">保存管理路径</el-button></el-form-item>
      </el-form>
    </div>
  </div>
</template>
