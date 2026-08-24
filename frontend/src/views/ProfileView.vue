<script setup lang="ts">
import { inject } from "vue";
import { requireWorkspace, workspaceKey } from "../composables/workspace";
import { formatDate, roleLabel } from "../formatters";

const w = requireWorkspace(inject(workspaceKey));
</script>

<template>
  <div v-if="w.user.value" class="page profile-page">
    <section class="profile-hero liquid-card">
      <span class="profile-avatar">{{ w.user.value.username.slice(0, 1).toUpperCase() }}</span>
      <div class="profile-identity">
        <p class="eyebrow">PERSONAL SPACE</p>
        <h3>{{ w.user.value.username }}</h3>
        <p>{{ roleLabel(w.user.value.role) }} · 加入于 {{ formatDate(w.user.value.created_at) }}</p>
      </div>
      <button class="profile-logout" :disabled="w.isPending('logout')" @click="w.logout">退出登录</button>
    </section>

    <section class="profile-grid">
      <article class="liquid-card profile-section">
        <div class="settings-title"><span class="settings-icon blue">人</span><div><b>账户信息</b><small>你的基础资料与当前权限</small></div></div>
        <div class="settings-list">
          <div><span>用户名</span><b>{{ w.user.value.username }}</b></div>
          <div><span>邮箱</span><b>{{ w.user.value.email || "未填写" }}</b></div>
          <div><span>手机号</span><b>{{ w.user.value.phone || "未填写" }}</b></div>
          <div><span>账户角色</span><b>{{ roleLabel(w.user.value.role) }}</b></div>
        </div>
      </article>

      <article class="liquid-card profile-section">
        <div class="settings-title"><span class="settings-icon violet">图</span><div><b>知识工作区</b><small>当前可访问内容的使用概览</small></div></div>
        <div class="profile-stats">
          <button @click="w.changeView('documents')"><b>{{ w.stats.value?.documents ?? 0 }}</b><small>文档</small></button>
          <button @click="w.changeView('knowledge')"><b>{{ w.stats.value?.knowledge_bases ?? 0 }}</b><small>知识库</small></button>
          <button @click="w.changeView('chat')"><b>{{ w.stats.value?.questions ?? 0 }}</b><small>问答</small></button>
        </div>
      </article>

      <article class="liquid-card profile-section appearance-card">
        <div class="settings-title"><span class="settings-icon orange">光</span><div><b>外观模式</b><small>选择适合当前环境的显示主题</small></div></div>
        <button class="appearance-toggle" @click="w.toggleTheme">
          <span :class="{ active: w.theme.value === 'light' }">浅色</span>
          <span :class="{ active: w.theme.value === 'dark' }">深色</span>
        </button>
      </article>
    </section>
  </div>
</template>
