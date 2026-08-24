<script setup lang="ts">
import { inject } from "vue";
import { requireWorkspace, workspaceKey } from "../composables/workspace";
import { formatDate, visibilityLabel } from "../formatters";

const w = requireWorkspace(inject(workspaceKey));

function showDocuments(id: number) {
  w.documentFilters.knowledge_base_id = String(id);
  void w.changeView("documents");
}
</script>

<template>
  <div class="page">
    <section class="split-head">
      <div>
        <p class="eyebrow">COLLECTIONS</p>
        <h3>知识库空间</h3>
        <p>按项目、课程或部门组织文档，并控制访问范围。</p>
      </div>
      <form class="inline-creator" @submit.prevent="w.createKnowledgeBase">
        <input v-model="w.kbForm.name" required maxlength="80" placeholder="新知识库名称" />
        <input v-model="w.kbForm.description" maxlength="500" placeholder="一句话说明" />
        <select v-model="w.kbForm.visibility">
          <option value="private">仅自己</option>
          <option value="shared">团队共享</option>
          <option value="public">公共</option>
        </select>
        <button class="primary" :disabled="w.isPending('knowledge:create')">
          {{ w.isPending("knowledge:create") ? "创建中…" : "创建" }}
        </button>
      </form>
    </section>
    <section class="collection-grid">
      <article v-for="(item, index) in w.knowledgeBases.value" :key="item.id" class="collection-card">
        <div class="folder-tab" :class="`tone-${index % 4}`"></div>
        <div class="collection-top">
          <span>{{ visibilityLabel(item.visibility) }}</span>
          <button
            v-if="w.canManageKnowledgeBase(item)"
            :aria-label="`编辑知识库 ${item.name}`"
            title="编辑知识库"
            @click="w.editKnowledgeBase(item)"
          >•••</button>
        </div>
        <h3>{{ item.name }}</h3>
        <p>{{ item.description || "尚未填写说明" }}</p>
        <div class="collection-meta">
          <b>{{ item.document_count }}</b> 份文档
          <span>更新于 {{ formatDate(item.updated_at) }}</span>
        </div>
        <div class="card-actions">
          <button @click="showDocuments(item.id)">查看文档</button>
          <button
            v-if="w.canManageKnowledgeBase(item)"
            class="danger-link"
            @click="w.deleteKnowledgeBase(item)"
          >删除</button>
        </div>
      </article>
      <div v-if="!w.knowledgeBases.value.length" class="empty-card">
        <b>还没有知识库</b>
        <span>使用上方表单创建第一个知识空间。</span>
      </div>
    </section>
  </div>
</template>
