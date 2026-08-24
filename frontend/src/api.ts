let authToken = localStorage.getItem("token") ?? "";

export function setToken(token: string): void {
  authToken = token;
  if (token) localStorage.setItem("token", token);
  else localStorage.removeItem("token");
}

export function getToken(): string {
  return authToken;
}

export async function getProtectedFile(path: string): Promise<Blob> {
  const response = await fetch(path, {
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
  });
  if (response.status === 401 && authToken) {
    setToken("");
    window.dispatchEvent(new Event("auth-expired"));
  }
  if (!response.ok) throw new Error("文件读取失败");
  return response.blob();
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (authToken) headers.set("Authorization", `Bearer ${authToken}`);
  if (options.body && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, { ...options, headers });
  // 登录接口的 401 表示凭据错误，不应被当成已有会话过期。
  if (response.status === 401 && authToken && path !== "/api/auth/login") {
    setToken("");
    window.dispatchEvent(new Event("auth-expired"));
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(payload.message ?? `请求失败（${response.status}）`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function openProtectedFile(
  path: string,
  downloadName?: string,
): Promise<void> {
  const url = URL.createObjectURL(await getProtectedFile(path));
  if (downloadName) {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = downloadName;
    anchor.click();
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
