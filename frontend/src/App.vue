<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { api, getToken, openProtectedFile, setToken } from "./api";
import type {
  ChatMessage,
  ChatSession,
  CommentItem,
  DashboardStats,
  DocumentItem,
  KnowledgeBase,
  SearchHit,
  User,
  UserRole,
  ViewName,
} from "./types";

const user = ref<User | null>(null);
const activeView = ref<ViewName>("dashboard");
const busy = ref(false);
const notice = ref("");
const noticeError = ref(false);
const mobileNav = ref(false);

const stats = ref<DashboardStats | null>(null);
const knowledgeBases = ref<KnowledgeBase[]>([]);
const documents = ref<DocumentItem[]>([]);
const sharedDocuments = ref<DocumentItem[]>([]);
const selectedDocument = ref<DocumentItem | null>(null);
const comments = ref<CommentItem[]>([]);
const recommendations = ref<DocumentItem[]>([]);
const searchResults = ref<SearchHit[]>([]);
const sessions = ref<ChatSession[]>([]);
const chatMessages = ref<ChatMessage[]>([]);
const currentSessionId = ref<number | null>(null);
const shareRequests = ref<DocumentItem[]>([]);
const users = ref<Array<User & { document_count: number }>>([]);

const authMode = ref<"login" | "register">("login");
const authForm = reactive({
  account: "",
  username: "",
  password: "",
  email: "",
  phone: "",
});
const kbForm = reactive({
  name: "",
  description: "",
  visibility: "private",
});
const documentFilters = reactive({
  scope: "all",
  sort: "updated",
  category: "",
  tag: "",
  knowledge_base_id: "",
});
const uploadForm = reactive({
  title: "",
  category: "课程资料",
  tags: "",
  knowledge_base_id: "",
  file: null as File | null,
});
const searchForm = reactive({
  q: "",
  category: "",
  tag: "",
  knowledge_base_id: "",
});
const chatForm = reactive({
  question: "",
  knowledge_base_id: "",
});
const metadataForm = reactive({ title: "", category: "", tags: "" });
const commentText = ref("");
const assignKnowledgeBaseId = ref("");

const isAdmin = computed(() =>
  ["department_admin", "system_admin"].includes(user.value?.role ?? ""),
);
const maxCategory = computed(() =>
  Math.max(1, ...(stats.value?.categories.map((item) => item.value) ?? [1])),
);
const maxTrend = computed(() =>
  Math.max(1, ...(stats.value?.search_trend.map((item) => item.value) ?? [1])),
);

const navigation: Array<{
  id: ViewName;
  label: string;
  icon: string;
  admin?: boolean;
}> = [
  { id: "dashboard", label: "数据概览", icon: "⌂" },
  { id: "knowledge", label: "知识库", icon: "▣" },
  { id: "documents", label: "文档管理", icon: "▤" },
  { id: "search", label: "知识检索", icon: "⌕" },
  { id: "chat", label: "检索问答", icon: "✦" },
  { id: "shared", label: "知识广场", icon: "◎" },
  { id: "admin", label: "管理审核", icon: "◇", admin: true },
];

function notify(message: string, error = false): void {
  notice.value = message;
  noticeError.value = error;
  window.setTimeout(() => {
    if (notice.value === message) notice.value = "";
  }, 3_500);
}

function formatDate(value?: string): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function shareLabel(status: DocumentItem["share_status"]): string {
  return {
    private: "私有",
    pending: "待审核",
    shared: "已共享",
    rejected: "已驳回",
  }[status];
}

async function withBusy(work: () => Promise<void>): Promise<void> {
  busy.value = true;
  try {
    await work();
  } catch (error) {
    notify(error instanceof Error ? error.message : "操作失败", true);
  } finally {
    busy.value = false;
  }
}

async function authenticate(): Promise<void> {
  await withBusy(async () => {
    const result =
      authMode.value === "login"
        ? await api<{ token: string; user: User }>("/api/auth/login", {
            method: "POST",
            body: JSON.stringify({
              account: authForm.account,
              password: authForm.password,
            }),
          })
        : await api<{ token: string; user: User }>("/api/auth/register", {
            method: "POST",
            body: JSON.stringify({
              username: authForm.username,
              password: authForm.password,
              email: authForm.email || null,
              phone: authForm.phone || null,
            }),
          });
    setToken(result.token);
    user.value = result.user;
    await changeView("dashboard");
  });
}

async function logout(): Promise<void> {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } finally {
    setToken("");
    user.value = null;
  }
}

async function loadKnowledgeBases(): Promise<void> {
  knowledgeBases.value = await api<KnowledgeBase[]>("/api/knowledge-bases");
}

async function loadDocuments(target: "documents" | "shared" = "documents"): Promise<void> {
  const params = new URLSearchParams();
  if (target === "shared") {
    params.set("scope", "shared");
    params.set("sort", "hot");
  } else {
    Object.entries(documentFilters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
  }
  const result = await api<DocumentItem[]>(`/api/documents?${params}`);
  if (target === "shared") sharedDocuments.value = result;
  else documents.value = result;
}

async function changeView(view: ViewName): Promise<void> {
  activeView.value = view;
  mobileNav.value = false;
  await withBusy(async () => {
    if (view === "dashboard") stats.value = await api("/api/stats");
    if (view === "knowledge") await loadKnowledgeBases();
    if (view === "documents") {
      await Promise.all([loadKnowledgeBases(), loadDocuments()]);
    }
    if (view === "search") await loadKnowledgeBases();
    if (view === "chat") {
      await Promise.all([
        loadKnowledgeBases(),
        (async () => {
          sessions.value = await api("/api/chat/sessions");
        })(),
      ]);
    }
    if (view === "shared") await loadDocuments("shared");
    if (view === "admin") {
      [shareRequests.value, users.value] = await Promise.all([
        api<DocumentItem[]>("/api/admin/share-requests"),
        api<Array<User & { document_count: number }>>("/api/admin/users"),
      ]);
    }
  });
}

async function createKnowledgeBase(): Promise<void> {
  await withBusy(async () => {
    await api("/api/knowledge-bases", {
      method: "POST",
      body: JSON.stringify(kbForm),
    });
    kbForm.name = "";
    kbForm.description = "";
    notify("知识库已创建");
    await loadKnowledgeBases();
  });
}

async function editKnowledgeBase(item: KnowledgeBase): Promise<void> {
  const name = window.prompt("知识库名称", item.name);
  if (!name) return;
  const description = window.prompt("知识库说明", item.description) ?? item.description;
  await withBusy(async () => {
    await api(`/api/knowledge-bases/${item.id}`, {
      method: "PUT",
      body: JSON.stringify({
        name,
        description,
        visibility: item.visibility,
      }),
    });
    notify("知识库已更新");
    await loadKnowledgeBases();
  });
}

async function deleteKnowledgeBase(item: KnowledgeBase): Promise<void> {
  if (!window.confirm(`确定删除知识库“${item.name}”？文档本身不会删除。`)) return;
  await withBusy(async () => {
    await api(`/api/knowledge-bases/${item.id}`, { method: "DELETE" });
    notify("知识库已删除");
    await loadKnowledgeBases();
  });
}

function chooseUpload(event: Event): void {
  uploadForm.file = (event.target as HTMLInputElement).files?.[0] ?? null;
}

async function uploadDocument(): Promise<void> {
  if (!uploadForm.file) return notify("请先选择文件", true);
  await withBusy(async () => {
    const body = new FormData();
    body.set("file", uploadForm.file!);
    body.set("title", uploadForm.title);
    body.set("category", uploadForm.category);
    body.set("tags", uploadForm.tags);
    if (uploadForm.knowledge_base_id) {
      body.set("knowledge_base_id", uploadForm.knowledge_base_id);
    }
    await api("/api/documents", { method: "POST", body });
    Object.assign(uploadForm, {
      title: "",
      category: "课程资料",
      tags: "",
      knowledge_base_id: "",
      file: null,
    });
    notify("文档已解析并建立全文索引");
    await loadDocuments();
  });
}

async function openDocument(item: DocumentItem): Promise<void> {
  await withBusy(async () => {
    const [detail, commentList, related] = await Promise.all([
      api<DocumentItem>(`/api/documents/${item.id}`),
      api<CommentItem[]>(`/api/documents/${item.id}/comments`),
      api<DocumentItem[]>(`/api/documents/${item.id}/recommendations`),
    ]);
    selectedDocument.value = detail;
    comments.value = commentList;
    recommendations.value = related;
    metadataForm.title = detail.title;
    metadataForm.category = detail.category;
    metadataForm.tags = detail.tags.join(", ");
  });
}

async function updateDocument(): Promise<void> {
  if (!selectedDocument.value) return;
  await withBusy(async () => {
    selectedDocument.value = await api(
      `/api/documents/${selectedDocument.value!.id}`,
      {
        method: "PUT",
        body: JSON.stringify({
          title: metadataForm.title,
          category: metadataForm.category,
          tags: metadataForm.tags.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
        }),
      },
    );
    notify("文档信息已保存");
    await loadDocuments();
  });
}

async function uploadVersion(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file || !selectedDocument.value) return;
  await withBusy(async () => {
    const body = new FormData();
    body.set("file", file);
    await api(`/api/documents/${selectedDocument.value!.id}/versions`, {
      method: "POST",
      body,
    });
    notify("新版本已上传");
    await openDocument(selectedDocument.value!);
  });
}

async function deleteDocument(item: DocumentItem): Promise<void> {
  if (!window.confirm(`确定删除“${item.title}”及其全部历史版本？`)) return;
  await withBusy(async () => {
    await api(`/api/documents/${item.id}`, { method: "DELETE" });
    selectedDocument.value = null;
    notify("文档已删除");
    await loadDocuments();
  });
}

async function toggleDocumentAction(
  item: DocumentItem,
  action: "favorite" | "like",
): Promise<void> {
  await withBusy(async () => {
    const result = await api<{ active: boolean; count: number }>(
      `/api/documents/${item.id}/${action}`,
      { method: "POST" },
    );
    if (action === "favorite") {
      item.favorite = result.active;
      item.favorite_count = result.count;
    } else {
      item.liked = result.active;
      item.like_count = result.count;
    }
  });
}

async function requestShare(item: DocumentItem): Promise<void> {
  await withBusy(async () => {
    await api(`/api/documents/${item.id}/share`, { method: "POST" });
    item.share_status = "pending";
    notify("已提交共享审核");
  });
}

async function addComment(): Promise<void> {
  if (!selectedDocument.value || !commentText.value.trim()) return;
  await withBusy(async () => {
    const created = await api<CommentItem>(
      `/api/documents/${selectedDocument.value!.id}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ content: commentText.value }),
      },
    );
    comments.value.unshift(created);
    commentText.value = "";
  });
}

async function assignToKnowledgeBase(): Promise<void> {
  if (!selectedDocument.value || !assignKnowledgeBaseId.value) return;
  await withBusy(async () => {
    await api(`/api/knowledge-bases/${assignKnowledgeBaseId.value}/documents`, {
      method: "POST",
      body: JSON.stringify({ document_id: selectedDocument.value!.id }),
    });
    notify("已加入知识库");
    await openDocument(selectedDocument.value!);
  });
}

async function search(): Promise<void> {
  if (!searchForm.q.trim()) return;
  await withBusy(async () => {
    const params = new URLSearchParams({ q: searchForm.q });
    Object.entries(searchForm).forEach(([key, value]) => {
      if (key !== "q" && value) params.set(key, value);
    });
    const result = await api<{ results: SearchHit[] }>(`/api/search?${params}`);
    searchResults.value = result.results;
  });
}

async function ask(): Promise<void> {
  const question = chatForm.question.trim();
  if (!question) return;
  chatMessages.value.push({ role: "user", content: question, citations: [] });
  chatForm.question = "";
  await withBusy(async () => {
    const result = await api<{
      session_id: number;
      answer: string;
      citations: ChatMessage["citations"];
    }>("/api/chat/ask", {
      method: "POST",
      body: JSON.stringify({
        question,
        knowledge_base_id: chatForm.knowledge_base_id || null,
        session_id: currentSessionId.value,
      }),
    });
    currentSessionId.value = result.session_id;
    chatMessages.value.push({
      role: "assistant",
      content: result.answer,
      citations: result.citations,
    });
    sessions.value = await api("/api/chat/sessions");
  });
}

async function openSession(session: ChatSession): Promise<void> {
  await withBusy(async () => {
    const result = await api<{ messages: ChatMessage[] }>(
      `/api/chat/sessions/${session.id}`,
    );
    currentSessionId.value = session.id;
    chatMessages.value = result.messages;
    chatForm.knowledge_base_id = session.knowledge_base_id
      ? String(session.knowledge_base_id)
      : "";
  });
}

function newSession(): void {
  currentSessionId.value = null;
  chatMessages.value = [];
  chatForm.question = "";
}

async function reviewDocument(item: DocumentItem, approved: boolean): Promise<void> {
  const note = approved ? "" : window.prompt("请输入驳回原因", "资料信息需要补充") ?? "";
  await withBusy(async () => {
    await api(`/api/admin/documents/${item.id}/review`, {
      method: "POST",
      body: JSON.stringify({ approved, note }),
    });
    shareRequests.value = shareRequests.value.filter((row) => row.id !== item.id);
    notify(approved ? "已通过共享审核" : "已驳回共享申请");
  });
}

async function changeRole(item: User, role: UserRole): Promise<void> {
  await withBusy(async () => {
    await api(`/api/admin/users/${item.id}/role`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    });
    item.role = role;
    notify("用户角色已更新");
  });
}

onMounted(async () => {
  window.addEventListener("auth-expired", () => {
    user.value = null;
    notify("登录已过期，请重新登录", true);
  });
  if (getToken()) {
    await withBusy(async () => {
      user.value = await api("/api/auth/me");
      await changeView("dashboard");
    });
  }
});
</script>

<template>
  <div v-if="!user" class="auth-shell">
    <section class="auth-story">
      <div class="brand-mark">知</div>
      <p class="eyebrow">KNOWLEDGE, ORGANIZED</p>
      <h1>把散落的信息，<br />变成可追溯的知识。</h1>
      <p class="story-copy">
        管理文档与知识库，用全文证据完成检索问答；每个答案都能回到原始片段。
      </p>
      <div class="story-metrics">
        <span><b>4</b> 类文档</span>
        <span><b>3</b> 级权限</span>
        <span><b>100%</b> 本地数据</span>
      </div>
    </section>
    <main class="auth-panel">
      <div class="auth-card">
        <p class="eyebrow">欢迎使用智知</p>
        <h2>{{ authMode === "login" ? "登录工作台" : "创建新账号" }}</h2>
        <p class="muted">
          {{ authMode === "login" ? "继续管理你的知识资产" : "用户名、邮箱或手机号均可用于登录" }}
        </p>
        <form @submit.prevent="authenticate">
          <label v-if="authMode === 'login'">
            账号
            <input v-model="authForm.account" required placeholder="用户名 / 邮箱 / 手机号" />
          </label>
          <template v-else>
            <label>用户名<input v-model="authForm.username" required minlength="2" /></label>
            <div class="form-row">
              <label>邮箱<input v-model="authForm.email" type="email" placeholder="可选" /></label>
              <label>手机号<input v-model="authForm.phone" placeholder="可选" /></label>
            </div>
          </template>
          <label>密码<input v-model="authForm.password" type="password" required minlength="6" /></label>
          <button class="primary wide" :disabled="busy">
            {{ busy ? "请稍候…" : authMode === "login" ? "登录" : "注册并进入" }}
          </button>
        </form>
        <button class="link-button" @click="authMode = authMode === 'login' ? 'register' : 'login'">
          {{ authMode === "login" ? "没有账号？立即注册" : "已有账号？返回登录" }}
        </button>
        <p class="admin-hint">验机管理员：admin / Admin@123</p>
      </div>
    </main>
  </div>

  <div v-else class="app-shell">
    <aside class="sidebar" :class="{ open: mobileNav }">
      <div class="brand"><span>知</span><div><b>智知</b><small>知识管理平台</small></div></div>
      <nav>
        <button
          v-for="item in navigation.filter((item) => !item.admin || isAdmin)"
          :key="item.id"
          :class="{ active: activeView === item.id }"
          @click="changeView(item.id)"
        >
          <span class="nav-icon">{{ item.icon }}</span>{{ item.label }}
        </button>
      </nav>
      <div class="sidebar-foot">
        <div class="model-state"><i></i><div><b>检索摘要模式</b><small>远程 Qwen 待接入</small></div></div>
        <div class="user-chip">
          <span>{{ user.username.slice(0, 1).toUpperCase() }}</span>
          <div><b>{{ user.username }}</b><small>{{ user.role }}</small></div>
          <button title="退出" @click="logout">↗</button>
        </div>
      </div>
    </aside>

    <main class="workspace">
      <header class="topbar">
        <button class="menu-button" @click="mobileNav = !mobileNav">☰</button>
        <div>
          <p class="eyebrow">{{ navigation.find((item) => item.id === activeView)?.label }}</p>
          <h2>
            {{
              activeView === "dashboard"
                ? `下午好，${user.username}`
                : navigation.find((item) => item.id === activeView)?.label
            }}
          </h2>
        </div>
        <div class="top-actions"><span>{{ new Date().toLocaleDateString("zh-CN") }}</span></div>
      </header>

      <div v-if="activeView === 'dashboard' && stats" class="page">
        <section class="hero-strip">
          <div><p class="eyebrow">TODAY'S WORKSPACE</p><h3>知识有序，答案有据。</h3><p>从上传、归档到检索和共享，一套工作台完整串联。</p></div>
          <button class="light-button" @click="changeView('documents')">上传新文档 →</button>
        </section>
        <section class="metric-grid">
          <article><span>文档总量</span><b>{{ stats.documents }}</b><small>份可访问资料</small></article>
          <article><span>知识库</span><b>{{ stats.knowledge_bases }}</b><small>个主题空间</small></article>
          <article><span>检索 / 问答</span><b>{{ stats.searches }}</b><small>{{ stats.questions }} 次问答</small></article>
          <article><span>访问 / 下载</span><b>{{ stats.views }}</b><small>{{ stats.downloads }} 次下载</small></article>
        </section>
        <section class="dashboard-grid">
          <article class="panel">
            <div class="panel-title"><div><p class="eyebrow">CATEGORY</p><h3>文档分类分布</h3></div></div>
            <div v-if="stats.categories.length" class="bar-chart">
              <div v-for="item in stats.categories" :key="item.name" class="bar-row">
                <span>{{ item.name }}</span><div><i :style="{ width: `${(item.value / maxCategory) * 100}%` }"></i></div><b>{{ item.value }}</b>
              </div>
            </div>
            <p v-else class="empty">上传文档后，这里会显示分类分布。</p>
          </article>
          <article class="panel">
            <div class="panel-title"><div><p class="eyebrow">TREND</p><h3>近 14 日检索</h3></div></div>
            <div v-if="stats.search_trend.length" class="trend-chart">
              <div v-for="item in stats.search_trend" :key="item.date" :title="`${item.date}: ${item.value}`">
                <i :style="{ height: `${Math.max(10, (item.value / maxTrend) * 100)}%` }"></i><small>{{ item.date.slice(5) }}</small>
              </div>
            </div>
            <p v-else class="empty">开始检索后，这里会形成使用趋势。</p>
          </article>
          <article class="panel">
            <div class="panel-title"><div><p class="eyebrow">POPULAR</p><h3>热门知识</h3></div></div>
            <div class="rank-list">
              <button v-for="(item, index) in stats.popular_documents" :key="item.id" @click="changeView('documents')">
                <b>{{ String(index + 1).padStart(2, "0") }}</b><span>{{ item.title }}<small>{{ item.views }} 浏览 · {{ item.downloads }} 下载</small></span>
              </button>
              <p v-if="!stats.popular_documents.length" class="empty">暂无热门文档</p>
            </div>
          </article>
          <article class="panel">
            <div class="panel-title"><div><p class="eyebrow">KEYWORDS</p><h3>高频检索词</h3></div></div>
            <div class="tag-cloud"><span v-for="item in stats.hot_keywords" :key="item.name">{{ item.name }} <b>{{ item.value }}</b></span></div>
            <p v-if="!stats.hot_keywords.length" class="empty">暂无检索记录</p>
          </article>
        </section>
      </div>

      <div v-if="activeView === 'knowledge'" class="page">
        <section class="split-head">
          <div><p class="eyebrow">COLLECTIONS</p><h3>知识库空间</h3><p>按项目、课程或部门组织文档，并控制访问范围。</p></div>
          <form class="inline-creator" @submit.prevent="createKnowledgeBase">
            <input v-model="kbForm.name" required placeholder="新知识库名称" />
            <input v-model="kbForm.description" placeholder="一句话说明" />
            <select v-model="kbForm.visibility"><option value="private">仅自己</option><option value="shared">团队共享</option><option value="public">公共</option></select>
            <button class="primary">创建</button>
          </form>
        </section>
        <section class="collection-grid">
          <article v-for="(item, index) in knowledgeBases" :key="item.id" class="collection-card">
            <div class="folder-tab" :class="`tone-${index % 4}`"></div>
            <div class="collection-top"><span>{{ item.visibility }}</span><button @click="editKnowledgeBase(item)">•••</button></div>
            <h3>{{ item.name }}</h3><p>{{ item.description || "尚未填写说明" }}</p>
            <div class="collection-meta"><b>{{ item.document_count }}</b> 份文档 <span>更新于 {{ formatDate(item.updated_at) }}</span></div>
            <div class="card-actions"><button @click="documentFilters.knowledge_base_id = String(item.id); changeView('documents')">查看文档</button><button class="danger-link" @click="deleteKnowledgeBase(item)">删除</button></div>
          </article>
          <div v-if="!knowledgeBases.length" class="empty-card">先创建第一个知识库，开始归档资料。</div>
        </section>
      </div>

      <div v-if="activeView === 'documents'" class="page">
        <section class="upload-panel">
          <div><p class="eyebrow">INGEST</p><h3>上传并建立索引</h3><p>支持 PDF、DOCX、TXT、Markdown，单文件不超过 20 MB。</p></div>
          <form @submit.prevent="uploadDocument">
            <label class="file-drop"><input type="file" accept=".pdf,.docx,.txt,.md" @change="chooseUpload" /><b>{{ uploadForm.file?.name || "选择知识文档" }}</b><small>点击浏览本地文件</small></label>
            <input v-model="uploadForm.title" placeholder="显示标题（可选）" />
            <input v-model="uploadForm.category" placeholder="分类" />
            <input v-model="uploadForm.tags" placeholder="标签，用逗号分隔" />
            <select v-model="uploadForm.knowledge_base_id"><option value="">暂不加入知识库</option><option v-for="kb in knowledgeBases" :key="kb.id" :value="kb.id">{{ kb.name }}</option></select>
            <button class="primary">上传文档</button>
          </form>
        </section>
        <section class="filter-bar">
          <select v-model="documentFilters.scope" @change="loadDocuments()"><option value="all">全部可访问</option><option value="mine">我上传的</option><option value="favorites">我的收藏</option><option value="shared">已共享</option></select>
          <select v-model="documentFilters.sort" @change="loadDocuments()"><option value="updated">最近更新</option><option value="latest">最新发布</option><option value="hot">热度排序</option></select>
          <input v-model="documentFilters.category" placeholder="分类筛选" @keyup.enter="loadDocuments()" />
          <input v-model="documentFilters.tag" placeholder="标签筛选" @keyup.enter="loadDocuments()" />
          <button @click="loadDocuments()">筛选</button>
          <span>{{ documents.length }} 份文档</span>
        </section>
        <section class="document-list panel">
          <article v-for="item in documents" :key="item.id">
            <div class="file-icon" :data-type="item.file_type">{{ item.file_type }}</div>
            <button class="document-main" @click="openDocument(item)"><b>{{ item.title }}</b><small>{{ item.filename }} · v{{ item.version }} · {{ formatBytes(item.file_size) }}</small><span><i>{{ item.category }}</i><i v-for="tag in item.tags.slice(0, 3)" :key="tag">#{{ tag }}</i></span></button>
            <div class="document-stats"><span>◉ {{ item.views }}</span><span>⇩ {{ item.downloads }}</span><span>♡ {{ item.like_count }}</span></div>
            <span class="status-pill" :class="item.share_status">{{ shareLabel(item.share_status) }}</span>
            <div class="row-actions">
              <button :class="{ selected: item.favorite }" @click="toggleDocumentAction(item, 'favorite')">☆</button>
              <button @click="openProtectedFile(`/api/documents/${item.id}/preview`)">预览</button>
              <button v-if="item.owner_id === user.id && item.share_status !== 'pending'" @click="requestShare(item)">共享</button>
            </div>
          </article>
          <p v-if="!documents.length" class="empty">没有符合条件的文档。</p>
        </section>
      </div>

      <div v-if="activeView === 'search'" class="page search-page">
        <section class="search-hero">
          <p class="eyebrow">FULL-TEXT DISCOVERY</p><h3>从知识中找到证据</h3>
          <form @submit.prevent="search"><span>⌕</span><input v-model="searchForm.q" autofocus placeholder="输入关键词、概念或完整问题…" /><button>检索</button></form>
          <div class="search-options">
            <select v-model="searchForm.knowledge_base_id"><option value="">全部知识库</option><option v-for="kb in knowledgeBases" :key="kb.id" :value="kb.id">{{ kb.name }}</option></select>
            <input v-model="searchForm.category" placeholder="分类（可选）" />
            <input v-model="searchForm.tag" placeholder="标签（可选）" />
          </div>
        </section>
        <section class="result-stack">
          <article v-for="(item, index) in searchResults" :key="item.chunk_id">
            <div class="result-rank">{{ String(index + 1).padStart(2, "0") }}</div>
            <div><button class="result-title" @click="openDocument({ id: item.document_id } as DocumentItem)">{{ item.title }}</button><p>{{ item.content }}</p><span>{{ item.category }} · 相关度 {{ Math.round(item.score * 100) }}%</span></div>
          </article>
          <p v-if="!searchResults.length" class="empty-large">输入检索词，系统会显示匹配片段并推荐相关文档。</p>
        </section>
      </div>

      <div v-if="activeView === 'chat'" class="page chat-layout">
        <aside class="session-list">
          <button class="primary wide" @click="newSession">＋ 新建问答</button>
          <p class="eyebrow">HISTORY</p>
          <button v-for="item in sessions" :key="item.id" :class="{ active: currentSessionId === item.id }" @click="openSession(item)">
            <b>{{ item.title }}</b><small>{{ item.message_count }} 条消息 · {{ formatDate(item.updated_at) }}</small>
          </button>
        </aside>
        <section class="chat-panel">
          <header><div><p class="eyebrow">EVIDENCE ANSWER</p><h3>{{ currentSessionId ? "继续追问" : "知识库问答" }}</h3></div><select v-model="chatForm.knowledge_base_id" :disabled="Boolean(currentSessionId)"><option value="">全部可访问文档</option><option v-for="kb in knowledgeBases" :key="kb.id" :value="kb.id">{{ kb.name }}</option></select></header>
          <div class="engine-banner"><i></i><span><b>当前使用全文证据摘要</b> · 远程 Qwen 适配器尚未接入，引用与会话链路已就绪。</span></div>
          <div class="messages">
            <div v-if="!chatMessages.length" class="chat-empty"><span>✦</span><h3>问一个有资料依据的问题</h3><p>例如：实验二的功能需求有哪些？系统会返回原文片段和引用。</p></div>
            <article v-for="(message, index) in chatMessages" :key="index" :class="message.role">
              <div class="message-avatar">{{ message.role === "user" ? user.username.slice(0, 1) : "知" }}</div>
              <div class="message-body"><b>{{ message.role === "user" ? "你" : "智知" }}</b><p>{{ message.content }}</p><div v-if="message.citations.length" class="citations"><button v-for="(source, sourceIndex) in message.citations" :key="sourceIndex" @click="openDocument({ id: source.document_id } as DocumentItem)"><b>[{{ sourceIndex + 1 }}] {{ source.title }}</b><span>{{ source.content }}</span></button></div></div>
            </article>
          </div>
          <form class="composer" @submit.prevent="ask"><textarea v-model="chatForm.question" rows="2" placeholder="继续提问，Enter 提交…" @keydown.enter.exact.prevent="ask"></textarea><button class="primary">发送 ↑</button></form>
        </section>
      </div>

      <div v-if="activeView === 'shared'" class="page">
        <section class="split-head"><div><p class="eyebrow">KNOWLEDGE COMMONS</p><h3>知识广场</h3><p>查看已通过审核的热门知识与最新发布内容。</p></div></section>
        <section class="shared-grid">
          <article v-for="item in sharedDocuments" :key="item.id">
            <div class="shared-cover"><span>{{ item.file_type }}</span><small>{{ item.category }}</small></div>
            <div class="shared-body"><p class="eyebrow">{{ item.owner_name }}</p><h3>{{ item.title }}</h3><div class="tag-line"><span v-for="tag in item.tags" :key="tag">#{{ tag }}</span></div><p>{{ item.views }} 浏览 · {{ item.downloads }} 下载 · {{ item.like_count }} 赞</p><div><button @click="openDocument(item)">查看详情</button><button :class="{ selected: item.liked }" @click="toggleDocumentAction(item, 'like')">♡ 点赞</button><button :class="{ selected: item.favorite }" @click="toggleDocumentAction(item, 'favorite')">☆ 收藏</button></div></div>
          </article>
          <p v-if="!sharedDocuments.length" class="empty-large">还没有通过审核的共享知识。</p>
        </section>
      </div>

      <div v-if="activeView === 'admin'" class="page">
        <section class="admin-grid">
          <article class="panel">
            <div class="panel-title"><div><p class="eyebrow">REVIEW QUEUE</p><h3>共享文档审核</h3></div><span>{{ shareRequests.length }} 待处理</span></div>
            <div class="review-list">
              <div v-for="item in shareRequests" :key="item.id"><div><b>{{ item.title }}</b><small>{{ item.owner_name }} · {{ item.category }} · {{ formatDate(item.updated_at) }}</small></div><button @click="openProtectedFile(`/api/documents/${item.id}/preview`)">预览</button><button class="approve" @click="reviewDocument(item, true)">通过</button><button class="reject" @click="reviewDocument(item, false)">驳回</button></div>
              <p v-if="!shareRequests.length" class="empty">审核队列已清空。</p>
            </div>
          </article>
          <article class="panel">
            <div class="panel-title"><div><p class="eyebrow">USER ROLES</p><h3>用户与角色</h3></div></div>
            <div class="user-table">
              <div v-for="item in users" :key="item.id"><span class="avatar-small">{{ item.username.slice(0, 1) }}</span><div><b>{{ item.username }}</b><small>{{ item.email || item.phone || "未填写联系方式" }} · {{ item.document_count }} 文档</small></div><select :value="item.role" :disabled="user.role !== 'system_admin'" @change="changeRole(item, ($event.target as HTMLSelectElement).value as UserRole)"><option value="user">普通用户</option><option value="department_admin">部门管理员</option><option value="system_admin">系统管理员</option></select></div>
            </div>
          </article>
        </section>
      </div>
    </main>

    <div v-if="selectedDocument" class="modal-backdrop" @click.self="selectedDocument = null">
      <section class="detail-drawer">
        <header><div><p class="eyebrow">{{ selectedDocument.file_type }} · VERSION {{ selectedDocument.version }}</p><h2>{{ selectedDocument.title }}</h2></div><button @click="selectedDocument = null">×</button></header>
        <div class="detail-actions"><button @click="openProtectedFile(`/api/documents/${selectedDocument.id}/preview`)">在线预览</button><button @click="openProtectedFile(`/api/documents/${selectedDocument.id}/download`, selectedDocument.filename)">下载</button><button :class="{ selected: selectedDocument.liked }" @click="toggleDocumentAction(selectedDocument, 'like')">♡ {{ selectedDocument.like_count }}</button><button :class="{ selected: selectedDocument.favorite }" @click="toggleDocumentAction(selectedDocument, 'favorite')">☆ 收藏</button></div>
        <div class="detail-grid">
          <section>
            <h4>基本信息</h4>
            <label>标题<input v-model="metadataForm.title" /></label>
            <div class="form-row"><label>分类<input v-model="metadataForm.category" /></label><label>标签<input v-model="metadataForm.tags" /></label></div>
            <button class="primary" @click="updateDocument">保存信息</button>
          </section>
          <section><h4>归档与版本</h4><div class="assign-row"><select v-model="assignKnowledgeBaseId"><option value="">选择知识库</option><option v-for="kb in knowledgeBases" :key="kb.id" :value="kb.id">{{ kb.name }}</option></select><button @click="assignToKnowledgeBase">加入</button></div><p class="muted">已加入：{{ selectedDocument.knowledge_bases?.map((item) => item.name).join("、") || "暂无" }}</p><label class="version-upload">上传新版本<input type="file" accept=".pdf,.docx,.txt,.md" @change="uploadVersion" /></label><div class="version-list"><span v-for="version in selectedDocument.versions" :key="version.id">v{{ version.version }} · {{ version.filename }} · {{ formatDate(version.created_at) }}</span></div></section>
        </div>
        <section class="recommendations"><h4>相关知识推荐</h4><button v-for="item in recommendations" :key="item.id" @click="openDocument(item)">{{ item.title }}<small>{{ item.category }}</small></button></section>
        <section class="comment-section"><h4>评论交流</h4><form @submit.prevent="addComment"><input v-model="commentText" placeholder="写下你的补充或问题…" /><button>发布</button></form><article v-for="item in comments" :key="item.id"><b>{{ item.username }}</b><p>{{ item.content }}</p><small>{{ formatDate(item.created_at) }}</small></article></section>
        <button v-if="selectedDocument.owner_id === user.id" class="delete-button" @click="deleteDocument(selectedDocument)">删除此文档及历史版本</button>
      </section>
    </div>
    <div v-if="notice" class="toast" :class="{ error: noticeError }">{{ notice }}</div>
    <div v-if="busy" class="busy-line"></div>
  </div>
</template>
