<script setup lang="ts">
import { inject, onBeforeUnmount, ref, watchEffect } from "vue";
import { requireWorkspace, workspaceKey } from "../composables/workspace";
import { formatBytes, shareLabel } from "../formatters";

const w = requireWorkspace(inject(workspaceKey));
const uploadInput = ref<HTMLInputElement | null>(null);

watchEffect(() => {
  w.uploadInput.value = uploadInput.value;
});
onBeforeUnmount(() => {
  w.uploadInput.value = null;
});
</script>

<template>
  <div class="page">
    <section class="upload-panel panel">
      <div>
        <p class="eyebrow">INGEST</p>
        <h3>上传并建立索引</h3>
        <p>选择文件、补充归档信息，然后明确提交上传。</p>
      </div>
      <form @submit.prevent="w.uploadDocument">
        <label class="file-drop">
          <input ref="uploadInput" type="file" :accept="w.uploadAccept.value" @change="w.chooseUpload" />
          <b>{{ w.uploadForm.file?.name || "选择知识文档" }}</b>
          <small>
            {{ w.uploadAccept.value.toUpperCase() }} · 不超过 {{ w.config.value.upload.max_mb }} MB
            <template v-if="w.config.value.upload.pdf_ocr_enabled">
              · 扫描 PDF 自动 OCR（最多 {{ w.config.value.upload.pdf_ocr_max_pages }} 页）
            </template>
          </small>
        </label>
        <input v-model="w.uploadForm.title" maxlength="150" placeholder="显示标题（可选）" />
        <input v-model="w.uploadForm.category" maxlength="50" placeholder="分类" />
        <input v-model="w.uploadForm.tags" placeholder="标签，用逗号分隔" />
        <select v-model="w.uploadForm.knowledge_base_id">
          <option value="">暂不加入知识库</option>
          <option v-for="kb in w.knowledgeBases.value.filter(w.canManageKnowledgeBase)" :key="kb.id" :value="kb.id">{{ kb.name }}</option>
        </select>
        <button class="primary" :disabled="w.isPending('document:upload')">
          {{ w.isPending("document:upload") ? "正在上传并解析…" : "上传文档" }}
        </button>
      </form>
    </section>

    <section class="filter-bar panel">
      <select v-model="w.documentFilters.scope" @change="w.loadDocuments()">
        <option value="all">全部可访问</option>
        <option value="mine">我上传的</option>
        <option value="favorites">我的收藏</option>
        <option value="shared">已共享</option>
      </select>
      <select v-model="w.documentFilters.sort" @change="w.loadDocuments()">
        <option value="updated">最近更新</option>
        <option value="latest">最新发布</option>
        <option value="hot">热度排序</option>
      </select>
      <input v-model="w.documentFilters.category" placeholder="分类筛选" @keyup.enter="w.loadDocuments()" />
      <input v-model="w.documentFilters.tag" placeholder="标签筛选" @keyup.enter="w.loadDocuments()" />
      <button :disabled="w.isPending('document:list')" @click="w.loadDocuments()">筛选</button>
      <span>{{ w.documents.value.length }} 份文档</span>
    </section>

    <section class="document-list panel">
      <article v-for="item in w.documents.value" :key="item.id">
        <div class="file-icon" :data-type="item.file_type">{{ item.file_type }}</div>
        <button class="document-main" @click="w.openDocument(item)">
          <b>{{ item.title }}</b>
          <small>{{ item.filename }} · v{{ item.version }} · {{ formatBytes(item.file_size) }}</small>
          <span><i>{{ item.category }}</i><i v-for="tag in item.tags.slice(0, 3)" :key="tag">#{{ tag }}</i></span>
        </button>
        <div class="document-stats"><span>◉ {{ item.views }}</span><span>⇩ {{ item.downloads }}</span><span>♡ {{ item.like_count }}</span></div>
        <span class="status-pill" :class="item.share_status">{{ shareLabel(item.share_status) }}</span>
        <div class="row-actions">
          <button :class="{ selected: item.favorite }" title="收藏" @click="w.toggleDocumentAction(item, 'favorite')">☆</button>
          <button @click="w.openDocument(item)">预览</button>
          <button v-if="w.canManageDocument(item) && item.share_status !== 'pending'" @click="w.requestShare(item)">
            {{ item.share_status === "shared" ? "重新提交" : "共享" }}
          </button>
          <button v-if="w.canManageDocument(item) && item.share_status === 'pending'" @click="w.withdrawShare(item)">撤回</button>
        </div>
      </article>
      <div v-if="!w.documents.value.length" class="empty-card compact">
        <b>没有符合条件的文档</b><span>调整筛选条件，或先上传一份资料。</span>
      </div>
    </section>
  </div>
</template>
