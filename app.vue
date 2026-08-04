<template>
  <div :class="isDev ? 'debug-screens' : ''" class="flex flex-col h-screen">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>

    <UNotifications />
    <UModals />
  </div>
</template>

<script setup lang="ts">
import { ModuleRegistry } from 'ag-grid-community';
import { AllEnterpriseModule, LicenseManager } from 'ag-grid-enterprise';
import { isDev } from '~/config';
import { isChromeBrowser } from '~/utils';

const runtimeConfig = useRuntimeConfig();

ModuleRegistry.registerModules([AllEnterpriseModule]);
LicenseManager.setLicenseKey(runtimeConfig.public.aggridLicense);

if (!isChromeBrowser()) {
  alert('为了更好的用户体验，推荐使用 Chrome 浏览器。');
}

// 请求持久化存储，避免浏览器清理 IndexedDB/localStorage 导致公众号列表丢失
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}
</script>

<style>
@import 'style.css';
</style>
