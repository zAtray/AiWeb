import DOMPurify from "dompurify";
import { marked } from "marked";

export function renderMarkdown(content: string): string {
  const html = marked.parse(content, {
    async: false,
    breaks: true,
    gfm: true,
  }) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["button", "form", "iframe", "input", "select", "style", "textarea"],
    FORBID_ATTR: ["style"],
  });
}
