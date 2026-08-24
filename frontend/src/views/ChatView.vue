<script setup lang="ts">
import { inject } from "vue";
import { requireWorkspace, workspaceKey } from "../composables/workspace";
import { formatDate } from "../formatters";
import { renderMarkdown } from "../markdown";

const w = requireWorkspace(inject(workspaceKey));

function engineLabel(): string {
  if (w.chatEngine.value === "local-qwen3-rag") return "Qwen 证据问答";
  if (w.chatEngine.value === "local-extractive-fallback") return "引用校验后使用本地证据摘要";
  if (w.chatEngine.value === "local-extractive") return "本地证据摘要";
  if (w.chatEngine.value === "local-qwen3-refinement") return "Qwen 追问改写";
  if (w.chatEngine.value === "local-refinement-fallback") return "追问改写使用安全回退";
  if (w.chatEngine.value === "local-platform-query") return "本地知识清单";
  return "尚未发起问答";
}
</script>

<template>
  <div class="page chat-layout">
    <aside class="session-list panel">
      <button class="primary wide" @click="w.newSession">＋ 新建问答</button>
      <p class="eyebrow">HISTORY</p>
      <div
        v-for="item in w.sessions.value"
        :key="item.id"
        class="session-item"
        :class="{ active: w.currentSessionId.value === item.id }"
      >
        <button class="session-open" @click="w.openSession(item)">
          <b>{{ item.title }}</b>
          <small>{{ item.message_count }} 条消息 · {{ formatDate(item.updated_at) }}</small>
        </button>
        <button class="session-delete" :aria-label="`删除会话 ${item.title}`" @click="w.deleteSession(item)">×</button>
      </div>
      <p v-if="!w.sessions.value.length" class="session-empty">暂无历史会话</p>
    </aside>

    <section class="chat-panel panel">
      <header>
        <div><p class="eyebrow">EVIDENCE ANSWER</p><h3>{{ w.currentSessionId.value ? "继续追问" : "知识库问答" }}</h3></div>
        <select v-model="w.chatForm.knowledge_base_id" :disabled="Boolean(w.currentSessionId.value)">
          <option value="">全部可访问文档</option>
          <option v-for="kb in w.knowledgeBases.value" :key="kb.id" :value="kb.id">{{ kb.name }}</option>
        </select>
      </header>
      <div class="engine-banner" :class="w.modelStatus.value?.status ?? 'checking'">
        <i></i>
        <span><b>{{ w.modelStatusLabel.value }}</b><small>{{ w.modelStatusDetail.value }}</small></span>
        <button :disabled="w.modelStatusBusy.value" title="重新检测模型状态" @click="w.loadModelStatus">↻</button>
      </div>
      <div v-if="w.chatEngine.value" class="chat-engine-result">
        <span>{{ engineLabel() }}</span>
        <span>{{ w.chatRetrievalEngine.value === "hybrid-vector-lexical" ? "混合检索" : "关键词检索" }}</span>
      </div>
      <div class="messages" aria-live="polite">
        <div v-if="!w.chatMessages.value.length" class="chat-empty">
          <span>✦</span><h3>问一个有资料依据的问题</h3><p>系统会返回答案、引用原文和实际使用的检索引擎。</p>
        </div>
        <article v-for="(message, index) in w.chatMessages.value" :key="index" :class="message.role">
          <div class="message-avatar">{{ message.role === "user" ? w.user.value?.username.slice(0, 1) : "知" }}</div>
          <div class="message-body">
            <b>{{ message.role === "user" ? "你" : "智知" }}</b>
            <p v-if="message.role === 'user'">{{ message.content }}</p>
            <div v-else class="message-content" v-html="renderMarkdown(message.content)"></div>
            <div v-if="message.citations.length" class="citations">
              <button v-for="(source, sourceIndex) in message.citations" :key="sourceIndex" @click="w.openDocument({ id: source.document_id })">
                <b>[{{ sourceIndex + 1 }}] {{ source.title }}</b>
                <small v-if="source.chapter || source.section || source.page_start">
                  {{ [source.chapter, source.section, source.page_start ? `第 ${source.page_start} 页` : ""].filter(Boolean).join(" · ") }}
                </small>
                <span>{{ source.content }}</span>
              </button>
            </div>
          </div>
        </article>
        <article v-if="w.isPending('chat:ask')" class="assistant pending-message">
          <div class="message-avatar">知</div><div class="message-body"><b>智知</b><p>正在检索资料并组织回答…</p></div>
        </article>
      </div>
      <form class="composer" @submit.prevent="w.ask">
        <textarea
          v-model="w.chatForm.question"
          rows="2"
          maxlength="2000"
          placeholder="输入问题，Enter 提交，Shift+Enter 换行…"
          @keydown.enter.exact.prevent="w.ask"
        ></textarea>
        <button class="primary" :disabled="w.isPending('chat:ask')">{{ w.isPending("chat:ask") ? "回答中…" : "发送 ↑" }}</button>
      </form>
    </section>
  </div>
</template>
