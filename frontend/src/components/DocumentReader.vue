<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted } from "vue";
import { requireWorkspace, workspaceKey } from "../composables/workspace";
import { formatBytes, formatDate, shareLabel } from "../formatters";

const w = requireWorkspace(inject(workspaceKey));
const isPdf = computed(() => w.selectedDocument.value?.file_type === "PDF");
let previousBodyOverflow = "";

function close(): void {
  w.closeDocument();
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && !w.dialog.value) close();
}

onMounted(() => {
  previousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  window.addEventListener("keydown", handleKeydown);
});
onBeforeUnmount(() => {
  document.body.style.overflow = previousBodyOverflow;
  window.removeEventListener("keydown", handleKeydown);
});
</script>

<template>
  <div v-if="w.selectedDocument.value" class="modal-backdrop document-reader-backdrop" @click.self="close">
    <section class="detail-drawer" role="dialog" aria-modal="true" aria-label="文档详情">
      <header>
        <div>
          <p class="eyebrow">{{ w.selectedDocument.value.file_type }} · VERSION {{ w.selectedDocument.value.version }}</p>
          <h2>{{ w.selectedDocument.value.title }}</h2>
          <span class="status-pill" :class="w.selectedDocument.value.share_status">{{ shareLabel(w.selectedDocument.value.share_status) }}</span>
        </div>
        <button aria-label="关闭文档详情" @click="close">×</button>
      </header>

      <div class="detail-actions">
        <button :disabled="w.isPending('document:download')" @click="w.downloadCurrentDocument">下载原文件</button>
        <button :class="{ selected: w.selectedDocument.value.liked }" @click="w.toggleDocumentAction(w.selectedDocument.value, 'like')">♡ {{ w.selectedDocument.value.like_count }}</button>
        <button :class="{ selected: w.selectedDocument.value.favorite }" @click="w.toggleDocumentAction(w.selectedDocument.value, 'favorite')">☆ 收藏</button>
        <button
          v-if="w.canManageDocument(w.selectedDocument.value) && w.selectedDocument.value.share_status !== 'pending'"
          @click="w.requestShare(w.selectedDocument.value)"
        >提交共享</button>
        <button
          v-if="w.canManageDocument(w.selectedDocument.value) && w.selectedDocument.value.share_status === 'pending'"
          @click="w.withdrawShare(w.selectedDocument.value)"
        >撤回共享</button>
      </div>
      <p v-if="w.selectedDocument.value.share_note" class="share-note">审核说明：{{ w.selectedDocument.value.share_note }}</p>

      <section class="document-content-preview" :class="{ 'pdf-document-preview': isPdf }">
        <header>
          <div>
            <h4>{{ isPdf ? "PDF 原文预览" : "文档正文" }}</h4>
            <small>{{ isPdf ? w.selectedDocument.value.filename : `已从 ${w.selectedDocument.value.filename} 提取` }}</small>
          </div>
          <span v-if="!isPdf">{{ w.selectedDocument.value.content?.length ?? 0 }} 字符</span>
        </header>
        <div v-if="isPdf" class="pdf-preview-frame">
          <div v-if="w.documentPreviewLoading.value" class="document-preview-empty">正在加载 PDF 原文件…</div>
          <iframe
            v-else-if="w.documentPreviewUrl.value"
            :src="w.documentPreviewUrl.value"
            :title="`${w.selectedDocument.value.title} PDF 预览`"
          />
          <div v-else class="document-preview-empty">
            {{ w.documentPreviewError.value || "PDF 预览暂不可用" }}，可点击“下载原文件”查看。
          </div>
        </div>
        <pre v-else-if="w.selectedDocument.value.content">{{ w.selectedDocument.value.content }}</pre>
        <div v-else class="document-preview-empty">暂未提取到可显示的文字内容。</div>
      </section>

      <div class="detail-grid">
        <section>
          <h4>基本信息</h4>
          <template v-if="w.canManageDocument(w.selectedDocument.value)">
            <label>标题<input v-model="w.metadataForm.title" maxlength="150" /></label>
            <div class="form-row">
              <label>分类<input v-model="w.metadataForm.category" maxlength="50" /></label>
              <label>标签<input v-model="w.metadataForm.tags" /></label>
            </div>
            <button class="primary" :disabled="w.isPending('document:update')" @click="w.updateDocument">
              {{ w.isPending("document:update") ? "保存中…" : "保存信息" }}
            </button>
          </template>
          <dl v-else class="metadata-readonly">
            <div><dt>分类</dt><dd>{{ w.selectedDocument.value.category }}</dd></div>
            <div><dt>标签</dt><dd>{{ w.selectedDocument.value.tags.join("、") || "无" }}</dd></div>
            <div><dt>文件</dt><dd>{{ w.selectedDocument.value.filename }}</dd></div>
          </dl>
        </section>

        <section>
          <h4>归档与版本</h4>
          <div v-if="w.canManageDocument(w.selectedDocument.value)" class="assign-row">
            <select v-model="w.assignKnowledgeBaseId.value">
              <option value="">选择知识库</option>
              <option v-for="kb in w.knowledgeBases.value.filter(w.canManageKnowledgeBase)" :key="kb.id" :value="kb.id">{{ kb.name }}</option>
            </select>
            <button :disabled="!w.assignKnowledgeBaseId.value || w.isPending('document:assign')" @click="w.assignToKnowledgeBase">加入</button>
          </div>
          <div class="assigned-list">
            <span v-for="kb in w.selectedDocument.value.knowledge_bases" :key="kb.id">
              {{ kb.name }}
              <button v-if="w.canManageDocument(w.selectedDocument.value)" :aria-label="`从 ${kb.name} 移出`" @click="w.removeFromKnowledgeBase(kb)">×</button>
            </span>
            <small v-if="!w.selectedDocument.value.knowledge_bases?.length">尚未加入知识库</small>
          </div>
          <label v-if="w.canManageDocument(w.selectedDocument.value)" class="version-upload">
            上传新版本
            <input type="file" :accept="w.uploadAccept.value" :disabled="w.isPending('document:version')" @change="w.uploadVersion" />
          </label>
          <div class="version-list">
            <button v-for="version in w.selectedDocument.value.versions" :key="version.id" @click="w.downloadVersion(version)">
              <span>v{{ version.version }} · {{ version.filename }}</span>
              <small>{{ formatBytes(version.file_size) }} · {{ formatDate(version.created_at) }} · 下载</small>
            </button>
          </div>
        </section>
      </div>

      <section class="recommendations">
        <h4>相关知识推荐</h4>
        <div>
          <button v-for="item in w.recommendations.value" :key="item.id" @click="w.openDocument(item)">
            {{ item.title }}<small>{{ item.category }}</small>
          </button>
          <p v-if="!w.recommendations.value.length" class="muted">暂无相关推荐。</p>
        </div>
      </section>

      <section class="comment-section">
        <h4>评论交流</h4>
        <form @submit.prevent="w.addComment">
          <input v-model="w.commentText.value" maxlength="500" placeholder="写下你的补充或问题…" />
          <button :disabled="w.isPending('comment:create')">发布</button>
        </form>
        <article v-for="item in w.comments.value" :key="item.id">
          <div><b>{{ item.username }}</b><small>{{ formatDate(item.created_at) }}</small></div>
          <p>{{ item.content }}</p>
          <button v-if="w.canDeleteComment(item)" @click="w.deleteComment(item)">删除</button>
        </article>
        <p v-if="!w.comments.value.length" class="muted">暂无评论。</p>
      </section>

      <button
        v-if="w.canManageDocument(w.selectedDocument.value)"
        class="delete-button"
        :disabled="w.isPending('document:delete')"
        @click="w.deleteDocument(w.selectedDocument.value)"
      >删除此文档及历史版本</button>
    </section>
  </div>
</template>
