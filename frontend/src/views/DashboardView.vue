<script setup lang="ts">
import { computed, inject } from "vue";
import { requireWorkspace, workspaceKey } from "../composables/workspace";

const w = requireWorkspace(inject(workspaceKey));

const categoryMaximum = computed(() =>
  Math.max(1, ...(w.stats.value?.categories.map((item) => item.value) ?? [])),
);
const keywordMaximum = computed(() =>
  Math.max(1, ...(w.stats.value?.hot_keywords.map((item) => item.value) ?? [])),
);
const trendPoints = computed(() => {
  const rows = w.stats.value?.search_trend ?? [];
  const maximum = Math.max(1, ...rows.map((item) => item.value));
  if (!rows.length) return "";
  return rows
    .map((item, index) => {
      const x = rows.length === 1 ? 50 : (index / (rows.length - 1)) * 100;
      const y = 92 - (item.value / maximum) * 78;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
});
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
          <template v-if="w.config.value.upload.ocr_available"> · 扫描 PDF 自动识别</template>
          <template v-else> · {{ w.config.value.upload.ocr_message }}</template>
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
        <span><b>{{ w.stats.value.views }}</b> 次访问</span>
        <span><b>{{ w.stats.value.downloads }}</b> 次下载</span>
      </div>
    </section>

    <section class="stats-overview" aria-label="知识管理基础统计">
      <article><span>文档总数</span><b>{{ w.stats.value.documents }}</b><small>可访问知识文档</small></article>
      <article><span>知识库总数</span><b>{{ w.stats.value.knowledge_bases }}</b><small>可访问知识空间</small></article>
      <article><span>访问次数</span><b>{{ w.stats.value.views }}</b><small>累计文档查看</small></article>
      <article><span>下载次数</span><b>{{ w.stats.value.downloads }}</b><small>累计原文下载</small></article>
      <article><span>检索次数</span><b>{{ w.stats.value.searches }}</b><small>当前用户累计检索</small></article>
    </section>

    <section class="analytics-grid">
      <article class="panel analytics-card">
        <div class="panel-title"><div><p class="eyebrow">POPULAR</p><h3>热门知识</h3></div></div>
        <div v-if="w.stats.value.popularDocuments.length" class="bar-chart keyword-bars">
          <div v-for="item in w.stats.value.popularDocuments" :key="item.id">
            <span>{{ item.title }}</span><i><b style="width: 100%"></b></i><strong>{{ item.popularity }}</strong>
          </div>
        </div>
        <p v-else class="muted">暂无热门知识数据。</p>
      </article>

      <article class="panel analytics-card">
        <div class="panel-title"><div><p class="eyebrow">LATEST</p><h3>最新发布</h3></div></div>
        <div v-if="w.stats.value.latestDocuments.length" class="bar-chart keyword-bars">
          <div v-for="item in w.stats.value.latestDocuments" :key="item.id">
            <span>{{ item.title }}</span><i><b style="width: 100%"></b></i><strong>{{ item.created_at.slice(0, 10) }}</strong>
          </div>
        </div>
        <p v-else class="muted">暂无最新发布内容。</p>
      </article>

      <article class="panel analytics-card category-analysis">
        <div class="panel-title"><div><p class="eyebrow">CATEGORY</p><h3>文档分类分布</h3></div></div>
        <div v-if="w.stats.value.categories.length" class="bar-chart">
          <div v-for="item in w.stats.value.categories" :key="item.name">
            <span>{{ item.name }}</span>
            <i><b :style="{ width: `${(item.value / categoryMaximum) * 100}%` }"></b></i>
            <strong>{{ item.value }}</strong>
          </div>
        </div>
        <p v-else class="muted">暂无文档分类数据。</p>
      </article>

      <article class="panel analytics-card keyword-analysis">
        <div class="panel-title"><div><p class="eyebrow">KEYWORDS</p><h3>热门检索关键词</h3></div></div>
        <div v-if="w.stats.value.hot_keywords.length" class="bar-chart keyword-bars">
          <div v-for="item in w.stats.value.hot_keywords" :key="item.name">
            <span>{{ item.name }}</span>
            <i><b :style="{ width: `${(item.value / keywordMaximum) * 100}%` }"></b></i>
            <strong>{{ item.value }}</strong>
          </div>
        </div>
        <p v-else class="muted">完成检索后，这里会显示热门关键词。</p>
      </article>

      <article class="panel analytics-card trend-analysis">
        <div class="panel-title"><div><p class="eyebrow">TREND</p><h3>近 14 日检索趋势</h3></div></div>
        <div v-if="w.stats.value.search_trend.length" class="trend-chart">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="近 14 日检索次数折线图">
            <path d="M0 92H100M0 53H100M0 14H100" class="trend-grid" />
            <polyline :points="trendPoints" class="trend-line" />
          </svg>
          <div class="trend-labels">
            <span>{{ w.stats.value.search_trend[0]?.date }}</span>
            <span>{{ w.stats.value.search_trend[w.stats.value.search_trend.length - 1]?.date }}</span>
          </div>
        </div>
        <p v-else class="muted">暂无检索趋势数据。</p>
      </article>
    </section>
  </div>
  <div v-else class="page page-loading">正在读取工作台…</div>
</template>
