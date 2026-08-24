import { computed, reactive, ref } from "vue";

export function createNoticeController() {
  const notice = ref("");
  const noticeError = ref(false);
  let noticeTimer: number | undefined;

  function notify(message: string, error = false): void {
    notice.value = message;
    noticeError.value = error;
    if (noticeTimer !== undefined) window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      if (notice.value === message) notice.value = "";
    }, 4_000);
  }

  function clearNotice(): void {
    notice.value = "";
    noticeError.value = false;
    if (noticeTimer !== undefined) {
      window.clearTimeout(noticeTimer);
      noticeTimer = undefined;
    }
  }

  function dispose(): void {
    if (noticeTimer !== undefined) window.clearTimeout(noticeTimer);
  }

  return { notice, noticeError, notify, clearNotice, dispose };
}

export function createPendingController(
  notify: (message: string, error?: boolean) => void,
) {
  const pending = reactive<Record<string, number>>({});
  const anyPending = computed(() =>
    Object.values(pending).some((count) => count > 0),
  );

  function isPending(key: string): boolean {
    return (pending[key] ?? 0) > 0;
  }

  async function run<T>(key: string, work: () => Promise<T>): Promise<T | null> {
    pending[key] = (pending[key] ?? 0) + 1;
    try {
      return await work();
    } catch (error) {
      notify(error instanceof Error ? error.message : "操作失败", true);
      return null;
    } finally {
      pending[key] = Math.max(0, (pending[key] ?? 1) - 1);
    }
  }

  return { pending, anyPending, isPending, run };
}

export function createThemeController() {
  const theme = ref<"light" | "dark">("light");

  function applyTheme(nextTheme: "light" | "dark"): void {
    theme.value = nextTheme;
    document.documentElement.dataset.theme = nextTheme;
    window.localStorage.setItem("zhizhi-theme", nextTheme);
  }

  function initializeTheme(): void {
    const savedTheme = window.localStorage.getItem("zhizhi-theme");
    applyTheme(
      savedTheme === "light" || savedTheme === "dark"
        ? savedTheme
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light",
    );
  }

  function toggleTheme(): void {
    applyTheme(theme.value === "light" ? "dark" : "light");
  }

  return { theme, applyTheme, initializeTheme, toggleTheme };
}
