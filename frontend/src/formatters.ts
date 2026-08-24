import type { DocumentItem, KnowledgeBase, UserRole } from "./types";

export function formatDate(value?: string): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function roleLabel(role: UserRole): string {
  return {
    user: "普通用户",
    department_admin: "部门管理员",
    system_admin: "系统管理员",
  }[role];
}

export function shareLabel(status: DocumentItem["share_status"]): string {
  return {
    private: "私有",
    pending: "待审核",
    shared: "已共享",
    rejected: "已驳回",
  }[status];
}

export function visibilityLabel(
  visibility: KnowledgeBase["visibility"],
): string {
  return {
    private: "仅自己",
    shared: "团队共享",
    public: "公共",
  }[visibility];
}
