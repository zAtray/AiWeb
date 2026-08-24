<script setup lang="ts">
import { onBeforeUnmount, onMounted, provide } from "vue";
import AppDialog from "./components/AppDialog.vue";
import AppHeader from "./components/AppHeader.vue";
import DocumentReader from "./components/DocumentReader.vue";
import {
  createWorkspace,
  navigation,
  workspaceKey,
} from "./composables/workspace";
import AdminView from "./views/AdminView.vue";
import AuthView from "./views/AuthView.vue";
import ChatView from "./views/ChatView.vue";
import DashboardView from "./views/DashboardView.vue";
import DocumentsView from "./views/DocumentsView.vue";
import KnowledgeView from "./views/KnowledgeView.vue";
import ProfileView from "./views/ProfileView.vue";
import SearchView from "./views/SearchView.vue";
import SharedView from "./views/SharedView.vue";

const w = createWorkspace();
provide(workspaceKey, w);

onMounted(() => void w.initialize());
onBeforeUnmount(w.dispose);
</script>

<template>
  <AuthView v-if="!w.user.value" />

  <div v-else class="app-shell">
    <AppHeader />
    <main class="workspace">
      <header v-if="w.activeView.value !== 'dashboard'" class="topbar">
        <div>
          <p class="eyebrow">ZHIZHI KNOWLEDGE</p>
          <h2>{{ navigation.find((item) => item.id === w.activeView.value)?.label }}</h2>
        </div>
        <div class="top-actions"><span>{{ new Date().toLocaleDateString("zh-CN") }}</span></div>
      </header>

      <DashboardView v-if="w.activeView.value === 'dashboard'" />
      <KnowledgeView v-else-if="w.activeView.value === 'knowledge'" />
      <DocumentsView v-else-if="w.activeView.value === 'documents'" />
      <SearchView v-else-if="w.activeView.value === 'search'" />
      <ChatView v-else-if="w.activeView.value === 'chat'" />
      <SharedView v-else-if="w.activeView.value === 'shared'" />
      <ProfileView v-else-if="w.activeView.value === 'profile'" />
      <AdminView v-else-if="w.activeView.value === 'admin'" />
    </main>

    <DocumentReader v-if="w.selectedDocument.value" />
    <AppDialog
      v-if="w.dialog.value"
      :dialog="w.dialog.value"
      @submit="w.submitDialog"
      @cancel="w.cancelDialog"
    />
    <div v-if="w.anyPending.value" class="busy-line" aria-hidden="true"></div>
  </div>

  <div
    v-if="w.notice.value && w.user.value"
    class="toast"
    :class="{ error: w.noticeError.value }"
    :role="w.noticeError.value ? 'alert' : 'status'"
  >{{ w.notice.value }}</div>
</template>
