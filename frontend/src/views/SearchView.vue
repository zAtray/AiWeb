<script setup lang="ts">
import { inject } from "vue";
import { requireWorkspace, workspaceKey } from "../composables/workspace";

const w = requireWorkspace(inject(workspaceKey));
</script>

<template>
  <div class="page search-page">
    <section class="search-hero">
      <p class="eyebrow">FULL-TEXT DISCOVERY</p>
      <h3>从知识中找到证据</h3>
      <form @submit.prevent="w.search">
        <span aria-hidden="true">⌕</span>
        <input v-model="w.searchForm.q" autofocus maxlength="500" placeholder="输入关键词、概念或完整问题…" />
        <button :disabled="w.isPending('search')">{{ w.isPending("search") ? "检索中…" : "检索" }}</button>
      </form>
      <div class="search-options">
        <select v-model="w.searchForm.knowledge_base_id">
          <option value="">全部知识库</option>
          <option v-for="kb in w.knowledgeBases.value" :key="kb.id" :value="kb.id">{{ kb.name }}</option>
        </select>
        <input v-model="w.searchForm.category" placeholder="分类（可选）" />
        <input v-model="w.searchForm.tag" placeholder="标签（可选）" />
      </div>
    </section>
    <div v-if="w.searchEngine.value" class="result-meta">
      <span>{{ w.searchResults.value.length }} 条结果</span>
      <span>{{ w.searchEngine.value === "hybrid-vector-lexical" ? "向量 + 关键词混合检索" : "关键词全文检索" }}</span>
    </div>
    <section class="result-stack">
      <article v-for="(item, index) in w.searchResults.value" :key="item.chunk_id">
        <div class="result-rank">{{ String(index + 1).padStart(2, "0") }}</div>
        <div>
          <button class="result-title" @click="w.openDocument({ id: item.document_id })">{{ item.title }}</button>
          <p>{{ item.content }}</p>
          <span>{{ [item.category, item.chapter, item.section, item.page_start ? `第 ${item.page_start} 页` : ""].filter(Boolean).join(" · ") }} · 相关度 {{ Math.round(item.score * 100) }}%</span>
        </div>
      </article>
      <div v-if="!w.searchResults.value.length" class="empty-card">
        <b>等待检索</b><span>输入检索词后，系统会显示原文片段与来源。</span>
      </div>
    </section>
  </div>
</template>
