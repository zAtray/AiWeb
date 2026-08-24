<script setup lang="ts">
import { inject } from "vue";
import { requireWorkspace, workspaceKey } from "../composables/workspace";

const w = requireWorkspace(inject(workspaceKey));
</script>

<template>
  <div class="auth-shell">
    <section class="auth-story">
      <div class="brand-mark">知</div>
      <p class="eyebrow">KNOWLEDGE, ORGANIZED</p>
      <h1>把散落的信息，<br />变成可追溯的知识。</h1>
      <p class="story-copy">管理文档与知识库，用全文证据完成检索问答；每个答案都能回到原始片段。</p>
      <div class="story-metrics">
        <span><b>4</b> 类文档</span>
        <span><b>3</b> 级权限</span>
        <span><b>100%</b> 本地数据</span>
      </div>
    </section>
    <main class="auth-panel">
      <div class="auth-card">
        <p class="eyebrow">欢迎使用智知</p>
        <h2>{{ w.authMode.value === "login" ? "登录工作台" : "创建新账号" }}</h2>
        <p class="muted">
          {{ w.authMode.value === "login" ? "继续管理你的知识资产" : "用户名、邮箱或手机号均可用于登录" }}
        </p>
        <form
          @submit.prevent="w.authenticate"
          :aria-describedby="w.noticeError.value && w.notice.value ? 'auth-error' : undefined"
        >
          <label v-if="w.authMode.value === 'login'">
            账号
            <input
              v-model="w.authForm.account"
              required
              autocomplete="username"
              placeholder="用户名 / 邮箱 / 手机号"
              :aria-invalid="w.noticeError.value && Boolean(w.notice.value)"
              @input="w.clearNotice"
            />
          </label>
          <template v-else>
            <label>用户名<input v-model="w.authForm.username" required minlength="2" autocomplete="username" /></label>
            <div class="form-row">
              <label>邮箱<input v-model="w.authForm.email" type="email" placeholder="可选" autocomplete="email" /></label>
              <label>手机号<input v-model="w.authForm.phone" placeholder="可选" autocomplete="tel" /></label>
            </div>
          </template>
          <label>
            密码
            <input
              v-model="w.authForm.password"
              type="password"
              required
              minlength="6"
              :autocomplete="w.authMode.value === 'login' ? 'current-password' : 'new-password'"
              :aria-invalid="w.noticeError.value && Boolean(w.notice.value)"
              @input="w.clearNotice"
            />
          </label>
          <p
            v-if="w.noticeError.value && w.notice.value"
            id="auth-error"
            class="auth-error-message"
            role="alert"
            aria-live="assertive"
          >{{ w.notice.value }}</p>
          <button class="primary wide" :disabled="w.isPending('auth')">
            {{ w.isPending("auth") ? "请稍候…" : w.authMode.value === "login" ? "登录" : "注册并进入" }}
          </button>
        </form>
        <button
          class="link-button"
          @click="w.clearNotice(); w.authMode.value = w.authMode.value === 'login' ? 'register' : 'login'"
        >
          {{ w.authMode.value === "login" ? "没有账号？立即注册" : "已有账号？返回登录" }}
        </button>
      </div>
    </main>
  </div>
</template>
