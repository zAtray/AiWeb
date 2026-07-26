import type { SqlRow } from "./types.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function numberId(value: unknown): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new ApiError(400, "无效的资源编号");
  }
  return id;
}

export function text(value: unknown, name: string, max = 500): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(400, `${name}不能为空`);
  }
  if (value.trim().length > max) {
    throw new ApiError(400, `${name}不能超过 ${max} 个字符`);
  }
  return value.trim();
}

export function optionalText(value: unknown, max = 500): string {
  if (value == null) return "";
  if (typeof value !== "string" || value.trim().length > max) {
    throw new ApiError(400, "文本参数格式错误");
  }
  return value.trim();
}

export function parseTags(value: unknown): string[] {
  const source = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? value.replaceAll("，", ",").split(",")
      : [];
  return [...new Set(source.map((item) => item.trim()).filter(Boolean))].slice(
    0,
    20,
  );
}

export function tagsFromJson(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function documentJson(row: SqlRow): SqlRow {
  const item = { ...row };
  item.tags = tagsFromJson(item.tags);
  item.favorite = Boolean(item.favorite);
  item.liked = Boolean(item.liked);
  delete item.stored_path;
  delete item.text_content;
  return item;
}

