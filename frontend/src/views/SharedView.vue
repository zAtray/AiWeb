<script setup lang="ts">
import { inject } from "vue";
import { requireWorkspace, workspaceKey } from "../composables/workspace";

const w = requireWorkspace(inject(workspaceKey));
</script>

<template>
  <div class="page">
    <section class="split-head shared-head">
      <div><p class="eyebrow">KNOWLEDGE COMMONS</p><h3>知识广场</h3><p>查看已通过审核的热门知识与最新发布内容。</p></div>
      <div class="shared-sort" aria-label="共享文档排序方式">
        <button
          :class="{ active: w.sharedSort.value === 'hot' }"
          @click="w.sharedSort.value = 'hot'; w.loadDocuments('shared')"
        >热门</button>
        <button
          :class="{ active: w.sharedSort.value === 'latest' }"
          @click="w.sharedSort.value = 'latest'; w.loadDocuments('shared')"
        >最新</button>
      </div>
    </section>
    <section class="shared-grid">
      <article v-for="item in w.sharedDocuments.value" :key="item.id">
        <div class="shared-cover"><span>{{ item.file_type }}</span><small>{{ item.category }}</small></div>
        <div class="shared-body">
          <p class="eyebrow">{{ item.owner_name }}</p>
          <h3>{{ item.title }}</h3>
          <div class="tag-line"><span v-for="tag in item.tags" :key="tag">#{{ tag }}</span></div>
          <p>{{ item.views }} 浏览 · {{ item.downloads }} 下载 · {{ item.like_count }} 赞</p>
          <div>
            <button @click="w.openDocument(item)">查看详情</button>
            <button :class="{ selected: item.liked }" @click="w.toggleDocumentAction(item, 'like')">♡ 点赞</button>
            <button :class="{ selected: item.favorite }" @click="w.toggleDocumentAction(item, 'favorite')">☆ 收藏</button>
          </div>
        </div>
      </article>
      <div v-if="!w.sharedDocuments.value.length" class="empty-card"><b>知识广场暂时为空</b><span>通过审核的共享文档会显示在这里。</span></div>
    </section>
  </div>
</template>
