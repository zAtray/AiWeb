<script setup lang="ts">
import { inject } from "vue";
import { requireWorkspace, workspaceKey } from "../composables/workspace";

const w = requireWorkspace(inject(workspaceKey));
</script>

<template>
  <div v-if="w.stats.value" class="page home-page">
    <section class="welcome-stage">
      <div class="welcome-copy">
        <span class="welcome-badge">智知 · AI KNOWLEDGE WORKSPACE</span>
        <h1>连接每一份知识，<br /><em>让答案自然发生。</em></h1>
        <p>面向个人与团队的智能知识工作台。上传、管理、检索与问答，一处完成。</p>
        <div class="hero-buttons">
          <button class="hero-primary" @click="w.startNewChat">开始问答</button>
          <button class="hero-secondary" @click="w.changeView('knowledge')">浏览知识库</button>
        </div>
      </div>
      <label class="home-upload">
        <input type="file" :accept="w.uploadAccept.value" @change="w.chooseHomeUpload" />
        <span class="home-upload-icon" aria-hidden="true">
          <svg viewBox="0 0 48 48" fill="none"><path d="M13 5h15l8 8v30H13V5Z" /><path d="M28 5v9h8M24 34V20m-6 6 6-6 6 6" /></svg>
        </span>
        <strong>上传文档开始问答</strong>
        <small>
          支持 {{ w.config.value.upload.allowed_extensions.join("、").toUpperCase() }} · 单文件不超过 {{ w.config.value.upload.max_mb }} MB
          <template v-if="w.config.value.upload.pdf_ocr_enabled"> · 扫描 PDF 自动识别</template>
        </small>
        <i>选择文档</i>
      </label>
      <div class="home-actions">
        <button @click="w.startNewChat">
          <span class="action-icon chat">✦</span>
          <span><b>向知识库提问</b><small>基于已收录资料，获得带引用的回答</small></span>
          <i>→</i>
        </button>
        <button @click="w.changeView('knowledge')">
          <span class="action-icon folder">▱</span>
          <span><b>浏览文档与知识库</b><small>{{ w.stats.value.documents }} 份文档 · {{ w.stats.value.knowledge_bases }} 个知识空间</small></span>
          <i>→</i>
        </button>
      </div>
      <div class="workspace-summary">
        <span><i></i> 知识服务运行正常</span>
        <span><b>{{ w.stats.value.searches }}</b> 次检索</span>
        <span><b>{{ w.stats.value.questions }}</b> 次问答</span>
        <span><b>{{ w.stats.value.views }}</b> 次访问</span>
      </div>
    </section>
  </div>
  <div v-else class="page page-loading">正在读取工作台…</div>
</template>
