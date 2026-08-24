import {
  computed,
  reactive,
  ref,
  type InjectionKey,
  type Ref,
} from "vue";
import {
  api,
  getProtectedFile,
  getToken,
  openProtectedFile,
  setToken,
} from "../api";
import { roleLabel } from "../formatters";
import type {
  AppConfig,
  ChatMessage,
  ChatResponse,
  ChatSession,
  CommentItem,
  DashboardStats,
  DocumentItem,
  KnowledgeBase,
  ModelConnectionStatus,
  RetrievalEngine,
  SearchHit,
  SearchResponse,
  User,
  UserRole,
  ViewName,
} from "../types";
import { createDialogController } from "./dialog";
import {
  createNoticeController,
  createPendingController,
  createThemeController,
} from "./ui";

const fallbackConfig: AppConfig = {
  upload: {
    max_mb: 50,
    allowed_extensions: [".pdf", ".docx", ".txt", ".md"],
    pdf_ocr_enabled: true,
    pdf_ocr_max_pages: 500,
  },
};

const emptyModelStatus = (): ModelConnectionStatus => ({
  status: "offline",
  configured: true,
  connected: false,
  model: null,
  model_available: false,
  latency_ms: null,
  answer_model: { configured: true, name: null, available: false },
  embedding_model: { configured: true, name: null, available: false },
  embedding_index: null,
});

export const navigation: Array<{
  id: ViewName;
  label: string;
  admin?: boolean;
}> = [
  { id: "dashboard", label: "工作台" },
  { id: "chat", label: "我的会话" },
  { id: "knowledge", label: "知识库" },
  { id: "documents", label: "文档管理" },
  { id: "search", label: "知识检索" },
  { id: "shared", label: "知识广场" },
  { id: "profile", label: "个人中心" },
  { id: "admin", label: "管理审核", admin: true },
];

export function createWorkspace() {
  const user = ref<User | null>(null);
  const activeView = ref<ViewName>("dashboard");
  const mobileNav = ref(false);
  const accountMenuOpen = ref(false);
  const config = ref<AppConfig>(fallbackConfig);
  const noticeController = createNoticeController();
  const pendingController = createPendingController(noticeController.notify);
  const themeController = createThemeController();
  const { notice, noticeError, notify, clearNotice } = noticeController;
  const { pending, anyPending, isPending, run } = pendingController;
  const { theme, applyTheme, initializeTheme, toggleTheme } = themeController;

  const stats = ref<DashboardStats | null>(null);
  const knowledgeBases = ref<KnowledgeBase[]>([]);
  const documents = ref<DocumentItem[]>([]);
  const sharedDocuments = ref<DocumentItem[]>([]);
  const selectedDocument = ref<DocumentItem | null>(null);
  const documentPreviewUrl = ref<string | null>(null);
  const documentPreviewLoading = ref(false);
  const documentPreviewError = ref("");
  let documentPreviewRequest = 0;
  const comments = ref<CommentItem[]>([]);
  const recommendations = ref<DocumentItem[]>([]);
  const searchResults = ref<SearchHit[]>([]);
  const searchEngine = ref<RetrievalEngine | null>(null);
  const sessions = ref<ChatSession[]>([]);
  const chatMessages = ref<ChatMessage[]>([]);
  const currentSessionId = ref<number | null>(null);
  const chatEngine = ref<ChatResponse["engine"] | null>(null);
  const chatRetrievalEngine = ref<ChatResponse["retrieval_engine"] | null>(null);
  const modelStatus = ref<ModelConnectionStatus | null>(null);
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
    visibility: "private" as KnowledgeBase["visibility"],
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
  const chatForm = reactive({ question: "", knowledge_base_id: "" });
  const metadataForm = reactive({ title: "", category: "", tags: "" });
  const commentText = ref("");
  const assignKnowledgeBaseId = ref("");
  const uploadInput = ref<HTMLInputElement | null>(null);
  const dialogController = createDialogController();

  const isAdmin = computed(() =>
    ["department_admin", "system_admin"].includes(user.value?.role ?? ""),
  );
  const uploadAccept = computed(() =>
    config.value.upload.allowed_extensions.join(","),
  );
  const modelStatusBusy = computed(() => isPending("model-status"));
  const modelStatusLabel = computed(() => {
    if (modelStatusBusy.value || !modelStatus.value) return "正在检测模型服务";
    return {
      connected: "模型与向量服务已连接",
      model_missing: "服务在线，但所需模型不完整",
      offline: "模型服务当前离线",
      disabled: "AI 与向量能力尚未启用",
    }[modelStatus.value.status];
  });
  const modelStatusDetail = computed(() => {
    const status = modelStatus.value;
    if (!status) return "正在连接 Ollama 服务…";
    if (status.status === "disabled") return "当前使用本地全文检索与证据摘要";
    if (status.status === "offline") return "问答将自动使用本地证据摘要";
    const parts = [
      status.answer_model.configured
        ? `${status.answer_model.name ?? "回答模型"}${status.answer_model.available ? " 可用" : " 缺失"}`
        : "回答模型未启用",
      status.embedding_model.configured
        ? `${status.embedding_model.name ?? "向量模型"}${status.embedding_model.available ? " 可用" : " 缺失"}`
        : "向量模型未启用",
    ];
    if (status.embedding_index) {
      parts.push(
        `向量索引 ${status.embedding_index.indexed}/${status.embedding_index.chunks}`,
      );
    }
    return `${parts.join(" · ")}${status.latency_ms === null ? "" : ` · ${status.latency_ms} ms`}`;
  });

  function closeAccountMenu(): void {
    accountMenuOpen.value = false;
  }

  function toggleAccountMenu(): void {
    accountMenuOpen.value = !accountMenuOpen.value;
  }

  function canManageDocument(item: DocumentItem): boolean {
    return item.owner_id === user.value?.id || isAdmin.value;
  }

  function canManageKnowledgeBase(item: KnowledgeBase): boolean {
    return item.owner_id === user.value?.id || isAdmin.value;
  }

  function canDeleteComment(item: CommentItem): boolean {
    return item.user_id === user.value?.id || isAdmin.value;
  }

  async function authenticate(): Promise<void> {
    clearNotice();
    const result = await run("auth", async () =>
      authMode.value === "login"
        ? api<{ token: string; user: User }>("/api/auth/login", {
            method: "POST",
            body: JSON.stringify({
              account: authForm.account,
              password: authForm.password,
            }),
          })
        : api<{ token: string; user: User }>("/api/auth/register", {
            method: "POST",
            body: JSON.stringify({
              username: authForm.username,
              password: authForm.password,
              email: authForm.email || null,
              phone: authForm.phone || null,
            }),
          }),
    );
    if (!result) return;
    setToken(result.token);
    user.value = result.user;
    authForm.password = "";
    await changeView("dashboard");
  }

  async function logout(): Promise<void> {
    closeAccountMenu();
    if (getToken()) await run("logout", () => api("/api/auth/logout", { method: "POST" }));
    setToken("");
    user.value = null;
    closeDocument();
  }

  async function loadKnowledgeBases(): Promise<void> {
    const result = await api<KnowledgeBase[]>("/api/knowledge-bases");
    knowledgeBases.value = result;
  }

  async function loadDocuments(
    target: "documents" | "shared" = "documents",
  ): Promise<void> {
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

  async function loadModelStatus(): Promise<void> {
    const result = await run("model-status", () =>
      api<ModelConnectionStatus>("/api/model/status"),
    );
    if (result) modelStatus.value = result;
    else modelStatus.value = { ...emptyModelStatus(), model: modelStatus.value?.model ?? null };
  }

  async function changeView(view: ViewName): Promise<void> {
    activeView.value = view;
    mobileNav.value = false;
    closeAccountMenu();
    await run(`view:${view}`, async () => {
      if (view === "dashboard" || view === "profile") {
        stats.value = await api("/api/stats");
      }
      if (view === "knowledge") await loadKnowledgeBases();
      if (view === "documents") {
        await Promise.all([loadKnowledgeBases(), loadDocuments()]);
      }
      if (view === "search") await loadKnowledgeBases();
      if (view === "chat") {
        await Promise.all([
          loadKnowledgeBases(),
          loadModelStatus(),
          api<ChatSession[]>("/api/chat/sessions").then((rows) => {
            sessions.value = rows;
          }),
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
    const created = await run("knowledge:create", () =>
      api("/api/knowledge-bases", {
        method: "POST",
        body: JSON.stringify(kbForm),
      }),
    );
    if (!created) return;
    kbForm.name = "";
    kbForm.description = "";
    notify("知识库已创建");
    await run("knowledge:list", loadKnowledgeBases);
  }

  async function editKnowledgeBase(item: KnowledgeBase): Promise<void> {
    const values = await dialogController.open({
      title: "编辑知识库",
      message: "修改名称、说明和访问范围。",
      confirmLabel: "保存修改",
      fields: [
        { key: "name", label: "知识库名称", value: item.name, required: true },
        {
          key: "description",
          label: "知识库说明",
          value: item.description,
          multiline: true,
        },
        {
          key: "visibility",
          label: "访问范围",
          value: item.visibility,
          options: [
            { value: "private", label: "仅自己" },
            { value: "shared", label: "团队共享" },
            { value: "public", label: "公共" },
          ],
        },
      ],
    });
    if (!values) return;
    const updated = await run("knowledge:update", () =>
      api(`/api/knowledge-bases/${item.id}`, {
        method: "PUT",
        body: JSON.stringify(values),
      }),
    );
    if (!updated) return;
    notify("知识库已更新");
    await run("knowledge:list", loadKnowledgeBases);
  }

  async function deleteKnowledgeBase(item: KnowledgeBase): Promise<void> {
    const confirmed = await dialogController.destructive(
      "删除知识库",
      `确定删除“${item.name}”？其中的文档不会被删除。`,
      "删除知识库",
    );
    if (!confirmed) return;
    const result = await run("knowledge:delete", () =>
      api(`/api/knowledge-bases/${item.id}`, { method: "DELETE" }),
    );
    if (result === null) return;
    notify("知识库已删除，文档已保留");
    await run("knowledge:list", loadKnowledgeBases);
  }

  function selectedUploadFile(input: HTMLInputElement): File | null {
    const file = input.files?.[0] ?? null;
    if (!file) return null;
    const extension = `.${file.name.split(".").pop()?.toLowerCase() ?? ""}`;
    if (!config.value.upload.allowed_extensions.includes(extension)) {
      input.value = "";
      notify(`不支持该格式，仅支持 ${uploadAccept.value}`, true);
      return null;
    }
    if (file.size > config.value.upload.max_mb * 1024 * 1024) {
      input.value = "";
      notify(`文件过大，单个文件不能超过 ${config.value.upload.max_mb} MB`, true);
      return null;
    }
    return file;
  }

  function chooseUpload(event: Event): void {
    uploadForm.file = selectedUploadFile(event.target as HTMLInputElement);
  }

  async function chooseHomeUpload(event: Event): Promise<void> {
    chooseUpload(event);
    if (uploadForm.file) await changeView("documents");
  }

  async function uploadDocument(): Promise<void> {
    if (!uploadForm.file) {
      notify("请先选择文件", true);
      return;
    }
    const body = new FormData();
    body.set("file", uploadForm.file);
    body.set("title", uploadForm.title);
    body.set("category", uploadForm.category);
    body.set("tags", uploadForm.tags);
    if (uploadForm.knowledge_base_id) {
      body.set("knowledge_base_id", uploadForm.knowledge_base_id);
    }
    const result = await run("document:upload", () =>
      api<{ embedding_queued?: boolean }>("/api/documents", {
        method: "POST",
        body,
      }),
    );
    if (!result) return;
    Object.assign(uploadForm, {
      title: "",
      category: "课程资料",
      tags: "",
      knowledge_base_id: "",
      file: null,
    });
    if (uploadInput.value) uploadInput.value.value = "";
    notify(
      result.embedding_queued
        ? "上传成功，全文检索已可用，向量索引正在后台生成"
        : "上传成功并已建立全文索引",
    );
    await run("document:list", () => loadDocuments());
    if (result.embedding_queued) window.setTimeout(() => void loadModelStatus(), 800);
  }

  function clearDocumentPreview(): void {
    documentPreviewRequest += 1;
    if (documentPreviewUrl.value) URL.revokeObjectURL(documentPreviewUrl.value);
    documentPreviewUrl.value = null;
    documentPreviewLoading.value = false;
    documentPreviewError.value = "";
  }

  function closeDocument(): void {
    selectedDocument.value = null;
    clearDocumentPreview();
  }

  async function loadPdfPreview(id: number): Promise<void> {
    clearDocumentPreview();
    const requestId = documentPreviewRequest;
    documentPreviewLoading.value = true;
    try {
      const file = await getProtectedFile(`/api/documents/${id}/preview`);
      if (selectedDocument.value?.id !== id || requestId !== documentPreviewRequest) return;
      documentPreviewUrl.value = URL.createObjectURL(file);
    } catch (error) {
      if (selectedDocument.value?.id === id && requestId === documentPreviewRequest) {
        documentPreviewError.value =
          error instanceof Error ? error.message : "PDF 预览加载失败";
      }
    } finally {
      if (selectedDocument.value?.id === id && requestId === documentPreviewRequest) {
        documentPreviewLoading.value = false;
      }
    }
  }

  async function loadDocumentDetail(id: number, reloadPreview = false): Promise<void> {
    const previousId = selectedDocument.value?.id;
    const [detail, commentList, related] = await Promise.all([
      api<DocumentItem>(`/api/documents/${id}`),
      api<CommentItem[]>(`/api/documents/${id}/comments`),
      api<DocumentItem[]>(`/api/documents/${id}/recommendations`),
    ]);
    selectedDocument.value = detail;
    comments.value = commentList;
    recommendations.value = related;
    metadataForm.title = detail.title;
    metadataForm.category = detail.category;
    metadataForm.tags = detail.tags.join(", ");
    assignKnowledgeBaseId.value = "";
    if (detail.file_type === "PDF") {
      if (reloadPreview || previousId !== id || !documentPreviewUrl.value) {
        void loadPdfPreview(id);
      }
    } else {
      clearDocumentPreview();
    }
  }

  async function openDocument(item: Pick<DocumentItem, "id">): Promise<void> {
    await run("document:detail", () => loadDocumentDetail(item.id));
  }

  async function updateDocument(): Promise<void> {
    const selected = selectedDocument.value;
    if (!selected) return;
    const result = await run("document:update", () =>
      api(`/api/documents/${selected.id}`, {
        method: "PUT",
        body: JSON.stringify({
          title: metadataForm.title,
          category: metadataForm.category,
          tags: metadataForm.tags
            .split(/[,，]/)
            .map((item) => item.trim())
            .filter(Boolean),
        }),
      }),
    );
    if (!result) return;
    await loadDocumentDetail(selected.id);
    notify("文档信息已保存");
    await run("document:list", () => loadDocuments());
  }

  async function uploadVersion(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = selectedUploadFile(input);
    const selected = selectedDocument.value;
    if (!file || !selected) return;
    const body = new FormData();
    body.set("file", file);
    const result = await run("document:version", () =>
      api(`/api/documents/${selected.id}/versions`, { method: "POST", body }),
    );
    input.value = "";
    if (!result) return;
    notify("新版本已上传，全文检索已更新");
    await loadDocumentDetail(selected.id, true);
  }

  async function deleteDocument(item: DocumentItem): Promise<void> {
    const confirmed = await dialogController.destructive(
      "删除文档",
      `确定删除“${item.title}”及其全部历史版本？此操作不可撤销。`,
      "删除文档",
    );
    if (!confirmed) return;
    const result = await run("document:delete", () =>
      api(`/api/documents/${item.id}`, { method: "DELETE" }),
    );
    if (result === null) return;
    closeDocument();
    notify("文档及其历史版本已删除");
    await run("document:list", () => loadDocuments());
  }

  async function toggleDocumentAction(
    item: DocumentItem,
    action: "favorite" | "like",
  ): Promise<void> {
    const result = await run(`document:${action}:${item.id}`, () =>
      api<{ active: boolean; count: number }>(
        `/api/documents/${item.id}/${action}`,
        { method: "POST" },
      ),
    );
    if (!result) return;
    if (action === "favorite") {
      item.favorite = result.active;
      item.favorite_count = result.count;
    } else {
      item.liked = result.active;
      item.like_count = result.count;
    }
  }

  async function requestShare(item: DocumentItem): Promise<void> {
    const result = await run("document:share", () =>
      api(`/api/documents/${item.id}/share`, { method: "POST" }),
    );
    if (!result) return;
    item.share_status = "pending";
    item.share_note = "";
    notify("已提交共享审核");
  }

  async function withdrawShare(item: DocumentItem): Promise<void> {
    const confirmed = await dialogController.confirm(
      "撤回共享申请",
      `确定撤回“${item.title}”的共享申请？`,
      "撤回申请",
    );
    if (!confirmed) return;
    const result = await run("document:share", () =>
      api(`/api/documents/${item.id}/share`, { method: "DELETE" }),
    );
    if (result === null) return;
    item.share_status = "private";
    item.share_note = "";
    notify("共享申请已撤回");
  }

  async function addComment(): Promise<void> {
    const selected = selectedDocument.value;
    if (!selected || !commentText.value.trim()) return;
    const created = await run("comment:create", () =>
      api<CommentItem>(`/api/documents/${selected.id}/comments`, {
        method: "POST",
        body: JSON.stringify({ content: commentText.value }),
      }),
    );
    if (!created) return;
    comments.value.unshift(created);
    commentText.value = "";
    selected.comment_count += 1;
    notify("评论已发布");
  }

  async function deleteComment(item: CommentItem): Promise<void> {
    const confirmed = await dialogController.destructive(
      "删除评论",
      "确定删除这条评论？",
      "删除评论",
    );
    if (!confirmed) return;
    const result = await run("comment:delete", () =>
      api(`/api/comments/${item.id}`, { method: "DELETE" }),
    );
    if (result === null) return;
    comments.value = comments.value.filter((comment) => comment.id !== item.id);
    if (selectedDocument.value) selectedDocument.value.comment_count -= 1;
    notify("评论已删除");
  }

  async function assignToKnowledgeBase(): Promise<void> {
    const selected = selectedDocument.value;
    if (!selected || !assignKnowledgeBaseId.value) return;
    const result = await run("document:assign", () =>
      api(`/api/knowledge-bases/${assignKnowledgeBaseId.value}/documents`, {
        method: "POST",
        body: JSON.stringify({ document_id: selected.id }),
      }),
    );
    if (!result) return;
    notify("文档已加入知识库");
    await loadDocumentDetail(selected.id);
  }

  async function removeFromKnowledgeBase(item: { id: number; name: string }) {
    const selected = selectedDocument.value;
    if (!selected) return;
    const confirmed = await dialogController.confirm(
      "移出知识库",
      `将“${selected.title}”从“${item.name}”移出？文档本身会保留。`,
      "确认移出",
    );
    if (!confirmed) return;
    const result = await run("document:unassign", () =>
      api(`/api/knowledge-bases/${item.id}/documents/${selected.id}`, {
        method: "DELETE",
      }),
    );
    if (result === null) return;
    notify("文档已移出知识库");
    await loadDocumentDetail(selected.id);
  }

  async function search(): Promise<void> {
    if (!searchForm.q.trim()) {
      notify("请输入检索内容", true);
      return;
    }
    const params = new URLSearchParams({ q: searchForm.q });
    Object.entries(searchForm).forEach(([key, value]) => {
      if (key !== "q" && value) params.set(key, value);
    });
    const result = await run("search", () =>
      api<SearchResponse>(`/api/search?${params}`),
    );
    if (!result) return;
    searchResults.value = result.results;
    searchEngine.value = result.retrieval_engine;
  }

  async function ask(): Promise<void> {
    const question = chatForm.question.trim();
    if (!question || isPending("chat:ask")) return;
    chatMessages.value.push({ role: "user", content: question, citations: [] });
    chatForm.question = "";
    const result = await run("chat:ask", () =>
      api<ChatResponse>("/api/chat/ask", {
        method: "POST",
        body: JSON.stringify({
          question,
          knowledge_base_id: chatForm.knowledge_base_id || null,
          session_id: currentSessionId.value,
        }),
      }),
    );
    if (!result) {
      chatMessages.value.pop();
      chatForm.question = question;
      return;
    }
    currentSessionId.value = result.session_id;
    chatEngine.value = result.engine;
    chatRetrievalEngine.value = result.retrieval_engine;
    chatMessages.value.push({
      role: "assistant",
      content: result.answer,
      citations: result.citations,
    });
    sessions.value = await api("/api/chat/sessions");
    await loadModelStatus();
  }

  async function openSession(session: ChatSession): Promise<void> {
    const result = await run("chat:session", () =>
      api<{ messages: ChatMessage[] }>(`/api/chat/sessions/${session.id}`),
    );
    if (!result) return;
    currentSessionId.value = session.id;
    chatMessages.value = result.messages;
    chatForm.knowledge_base_id = session.knowledge_base_id
      ? String(session.knowledge_base_id)
      : "";
  }

  function newSession(): void {
    currentSessionId.value = null;
    chatMessages.value = [];
    chatForm.question = "";
    chatEngine.value = null;
    chatRetrievalEngine.value = null;
  }

  async function startNewChat(): Promise<void> {
    newSession();
    await changeView("chat");
  }

  async function deleteSession(item: ChatSession): Promise<void> {
    const confirmed = await dialogController.destructive(
      "删除会话",
      `确定删除会话“${item.title}”及其中的全部消息？`,
      "删除会话",
    );
    if (!confirmed) return;
    const result = await run("chat:delete", () =>
      api(`/api/chat/sessions/${item.id}`, { method: "DELETE" }),
    );
    if (result === null) return;
    sessions.value = sessions.value.filter((session) => session.id !== item.id);
    if (currentSessionId.value === item.id) newSession();
    notify("会话已删除");
  }

  async function reviewDocument(item: DocumentItem, approved: boolean): Promise<void> {
    let note = "";
    if (!approved) {
      const values = await dialogController.open({
        title: "驳回共享申请",
        message: `请说明“${item.title}”需要补充的内容。`,
        confirmLabel: "确认驳回",
        destructive: true,
        fields: [
          {
            key: "note",
            label: "驳回原因",
            value: "资料信息需要补充",
            required: true,
            multiline: true,
          },
        ],
      });
      if (!values) return;
      note = values.note ?? "";
    }
    const result = await run("admin:review", () =>
      api(`/api/admin/documents/${item.id}/review`, {
        method: "POST",
        body: JSON.stringify({ approved, note }),
      }),
    );
    if (!result) return;
    shareRequests.value = shareRequests.value.filter((row) => row.id !== item.id);
    notify(approved ? "已通过共享审核" : "已驳回共享申请");
  }

  async function changeRole(item: User, role: UserRole): Promise<void> {
    const previousRole = item.role;
    if (previousRole === role) return;
    const confirmed = await dialogController.confirm(
      "修改用户角色",
      `将“${item.username}”从${roleLabel(previousRole)}调整为${roleLabel(role)}？`,
      "确认调整",
    );
    if (!confirmed) return;
    const result = await run("admin:role", () =>
      api(`/api/admin/users/${item.id}/role`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      }),
    );
    if (!result) return;
    item.role = role;
    notify("用户角色已更新");
  }

  function downloadVersion(version: NonNullable<DocumentItem["versions"]>[number]) {
    const selected = selectedDocument.value;
    if (!selected) return;
    void run("document:download", () =>
      openProtectedFile(
        `/api/documents/${selected.id}/versions/${version.id}/download`,
        version.filename,
      ),
    );
  }

  function downloadCurrentDocument(): void {
    const selected = selectedDocument.value;
    if (!selected) return;
    void run("document:download", () =>
      openProtectedFile(
        `/api/documents/${selected.id}/download`,
        selected.filename,
      ),
    );
  }

  function handleAuthExpired(): void {
    user.value = null;
    closeDocument();
    notify("登录已过期，请重新登录", true);
  }

  async function initialize(): Promise<void> {
    initializeTheme();
    document.addEventListener("click", closeAccountMenu);
    window.addEventListener("auth-expired", handleAuthExpired);
    const loadedConfig = await run("config", () => api<AppConfig>("/api/config"));
    if (loadedConfig) config.value = loadedConfig;
    if (!getToken()) return;
    const currentUser = await run("session", () => api<User>("/api/auth/me"));
    if (!currentUser) return;
    user.value = currentUser;
    await changeView("dashboard");
  }

  function dispose(): void {
    document.removeEventListener("click", closeAccountMenu);
    window.removeEventListener("auth-expired", handleAuthExpired);
    noticeController.dispose();
    clearDocumentPreview();
  }

  return {
    user,
    activeView,
    mobileNav,
    accountMenuOpen,
    theme,
    config,
    pending,
    anyPending,
    notice,
    noticeError,
    stats,
    knowledgeBases,
    documents,
    sharedDocuments,
    selectedDocument,
    documentPreviewUrl,
    documentPreviewLoading,
    documentPreviewError,
    comments,
    recommendations,
    searchResults,
    searchEngine,
    sessions,
    chatMessages,
    currentSessionId,
    chatEngine,
    chatRetrievalEngine,
    modelStatus,
    modelStatusBusy,
    modelStatusLabel,
    modelStatusDetail,
    shareRequests,
    users,
    authMode,
    authForm,
    kbForm,
    documentFilters,
    uploadForm,
    searchForm,
    chatForm,
    metadataForm,
    commentText,
    assignKnowledgeBaseId,
    uploadInput,
    isAdmin,
    uploadAccept,
    dialog: dialogController.dialog,
    submitDialog: dialogController.submit,
    cancelDialog: dialogController.cancel,
    isPending,
    notify,
    clearNotice,
    applyTheme,
    toggleTheme,
    closeAccountMenu,
    toggleAccountMenu,
    canManageDocument,
    canManageKnowledgeBase,
    canDeleteComment,
    authenticate,
    logout,
    loadKnowledgeBases,
    loadDocuments,
    loadModelStatus,
    changeView,
    createKnowledgeBase,
    editKnowledgeBase,
    deleteKnowledgeBase,
    chooseUpload,
    chooseHomeUpload,
    uploadDocument,
    openDocument,
    closeDocument,
    updateDocument,
    uploadVersion,
    deleteDocument,
    toggleDocumentAction,
    requestShare,
    withdrawShare,
    addComment,
    deleteComment,
    assignToKnowledgeBase,
    removeFromKnowledgeBase,
    search,
    ask,
    openSession,
    newSession,
    startNewChat,
    deleteSession,
    reviewDocument,
    changeRole,
    downloadCurrentDocument,
    downloadVersion,
    initialize,
    dispose,
  };
}

export type Workspace = ReturnType<typeof createWorkspace>;
export const workspaceKey: InjectionKey<Workspace> = Symbol("workspace");

export function requireWorkspace(workspace: Workspace | undefined): Workspace {
  if (!workspace) throw new Error("Workspace provider is missing");
  return workspace;
}

export type WorkspaceRef<T> = Ref<T>;
