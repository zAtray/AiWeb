<script setup lang="ts">
import { inject } from "vue";
import { navigation, requireWorkspace, workspaceKey } from "../composables/workspace";
import { roleLabel } from "../formatters";

const w = requireWorkspace(inject(workspaceKey));
</script>

<template>
  <header class="global-header">
    <button class="header-brand" aria-label="返回工作台" @click="w.changeView('dashboard')">
      <span class="logo-symbol" aria-hidden="true">
        <svg viewBox="0 0 54 44" fill="none">
          <path d="M18 8.5h18a8 8 0 0 1 8 8v10a8 8 0 0 1-8 8H18a8 8 0 0 1-8-8v-10a8 8 0 0 1 8-8Z" />
          <path d="M27 8.5V4m-3 0h6M10 18H6v7h4M44 18h4v7h-4" />
          <circle cx="21" cy="21.5" r="2.2" />
          <circle cx="33" cy="21.5" r="2.2" />
          <path d="M21.5 28h11M21 35v4h12v-4" />
        </svg>
      </span>
      <span class="brand-wordmark"><b>智知</b><small>AI KNOWLEDGE</small></span>
    </button>

    <nav class="header-links" :class="{ open: w.mobileNav.value }" aria-label="全局导航">
      <button
        v-for="item in navigation.filter((entry) => entry.id !== 'profile' && entry.id !== 'admin')"
        :key="item.id"
        :class="{ active: w.activeView.value === item.id }"
        @click="w.changeView(item.id)"
      >
        {{ item.label }}
      </button>
      <button class="mobile-new-chat" @click="w.startNewChat">＋ 新建会话</button>
    </nav>

    <div class="header-account">
      <button class="header-new-chat" @click="w.startNewChat">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        新建会话
      </button>
      <button
        class="theme-toggle"
        :title="w.theme.value === 'light' ? '切换到深色模式' : '切换到浅色模式'"
        @click="w.toggleTheme"
      >
        <svg v-if="w.theme.value === 'light'" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M20 15.2A8 8 0 0 1 8.8 4 8 8 0 1 0 20 15.2Z" />
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
        </svg>
      </button>
      <div class="account-menu-wrap" @click.stop>
        <button
          class="header-avatar"
          :class="{ active: w.accountMenuOpen.value }"
          :title="`${w.user.value?.username} · ${w.user.value ? roleLabel(w.user.value.role) : ''}`"
          aria-haspopup="menu"
          :aria-expanded="w.accountMenuOpen.value"
          @click="w.toggleAccountMenu"
        >
          {{ w.user.value?.username.slice(0, 1).toUpperCase() }}
        </button>
        <Transition name="account-menu">
          <div v-if="w.accountMenuOpen.value && w.user.value" class="account-popover" role="menu">
            <div class="account-popover-identity">
              <span>{{ w.user.value.username.slice(0, 1).toUpperCase() }}</span>
              <div><b>{{ w.user.value.username }}</b><small>{{ roleLabel(w.user.value.role) }}</small></div>
            </div>
            <div class="account-popover-divider"></div>
            <button role="menuitem" @click="w.changeView('profile')"><span>个人中心</span><i>›</i></button>
            <button v-if="w.isAdmin.value" role="menuitem" @click="w.changeView('admin')"><span>管理审核</span><i>›</i></button>
            <div class="account-popover-divider"></div>
            <button class="account-menu-logout" role="menuitem" @click="w.logout"><span>退出登录</span></button>
          </div>
        </Transition>
      </div>
      <button
        class="global-menu-button"
        :aria-label="w.mobileNav.value ? '关闭导航' : '打开导航'"
        :aria-expanded="w.mobileNav.value"
        @click="w.mobileNav.value = !w.mobileNav.value"
      >
        <svg viewBox="0 0 24 24" fill="none"><path d="M5 8h14M5 16h14" /></svg>
      </button>
    </div>
  </header>
</template>
