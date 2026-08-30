import { queryTerms, sanitizeEvidenceContent } from "./search.js";
import type { PackedEvidence, SearchHit } from "./types.js";

export type RankedChannelName = "content" | "metadata" | "exact" | "vector";

export interface RankedChannel {
  name: RankedChannelName;
  weight: number;
  hits: SearchHit[];
}

const rankFields: Record<RankedChannelName, keyof SearchHit> = {
  content: "content_rank",
  metadata: "metadata_rank",
  exact: "exact_rank",
  vector: "vector_rank",
};

export function weightedRrf(channels: RankedChannel[], k = 60): SearchHit[] {
  const combined = new Map<number, SearchHit>();
  for (const channel of channels) {
    channel.hits.forEach((hit, index) => {
      const rank = index + 1;
      const existing = combined.get(hit.chunk_id) ?? { ...hit, rrf_score: 0 };
      existing[rankFields[channel.name]] = rank as never;
      existing.rrf_score = (existing.rrf_score ?? 0) + channel.weight / (k + rank);
      existing.lexical_score = Math.max(existing.lexical_score ?? 0, hit.lexical_score ?? 0);
      existing.semantic_score = Math.max(existing.semantic_score ?? -1, hit.semantic_score ?? -1);
      combined.set(hit.chunk_id, existing);
    });
  }
  const hits = [...combined.values()];
  const maximum = Math.max(...hits.map((hit) => hit.rrf_score ?? 0), 0.000001);
  return hits.map((hit) => ({ ...hit, score: (hit.rrf_score ?? 0) / maximum })).sort(
    (left, right) => right.score - left.score || left.chunk_id - right.chunk_id,
  );
}

function normalizedText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

// 从查询文本中先剥离语气/疑问词，再按 queryTerms 拆词，与检索侧
// coreTerms 的清洗方式保持一致；否则“死锁是什么”这类 4 字整词和
// 交叉 2-gram（是什/示什）会把覆盖率拖到阈值以下。
const queryNoisePhrases = [
  "有什么区别", "指的是什么", "表示什么", "是什么", "有哪些", "为什么", "怎么样",
  "请问", "帮我", "多少", "如何", "怎么", "为啥", "哪里", "哪个", "哪些", "区别", "比较",
  "之间", "以及", "一下", "给出", "总结", "概括", "介绍", "讲解", "说明", "详细", "展开", "内容",
  "分别", "请", "的", "呢", "吗", "吧", "呀", "啊", "是", "有", "了", "在", "与", "和", "及",
  "或", "之", "中", "为", "都", "也", "还", "再", "那", "这", "对", "从", "到", "用", "把",
  "被", "向", "给", "若", "则",
];

function termCoverage(query: string, hit: SearchHit): number {
  let cleaned = query.toLowerCase();
  for (const noise of queryNoisePhrases) cleaned = cleaned.replaceAll(noise, " ");
  const terms = queryTerms(cleaned).filter((term) => term.length >= 2).slice(0, 16);
  if (!terms.length) return 0;
  const text = normalizedText(
    `${hit.title} ${hit.filename ?? ""} ${hit.chapter ?? ""} ${hit.section ?? ""} ${hit.content}`,
  );
  return terms.filter((term) => text.includes(normalizedText(term))).length / terms.length;
}

function exactMetadataMatch(query: string, hit: SearchHit): number {
  const compact = normalizedText(query);
  const fields = [hit.title, hit.filename ?? "", ...hit.tags].map(normalizedText).filter(Boolean);
  return fields.some((field) => field.length >= 2 && (compact.includes(field) || field.includes(compact))) ? 1 : 0;
}

export function dedupeTopK(
  hits: SearchHit[],
  limit: number,
  perDocumentCap = 3,
): SearchHit[] {
  const selected: SearchHit[] = [];
  const documents = new Map<number, number>();
  const signatures = new Set<string>();
  for (const hit of hits) {
    if (selected.length >= limit) break;
    if ((documents.get(hit.document_id) ?? 0) >= perDocumentCap) continue;
    const signature = normalizedText(hit.content).slice(0, 180);
    if (signature && signatures.has(signature)) continue;
    selected.push(hit);
    if (signature) signatures.add(signature);
    documents.set(hit.document_id, (documents.get(hit.document_id) ?? 0) + 1);
  }
  return selected;
}

function mergeOverlap(left: string, right: string, maximum = 240): string {
  const max = Math.min(maximum, left.length, right.length);
  for (let size = max; size >= 20; size -= 1) {
    if (left.slice(-size) === right.slice(0, size)) return `${left}${right.slice(size)}`;
  }
  return `${left}\n${right}`;
}

export function estimatedTokens(value: string): number {
  const han = value.match(/[\p{Script=Han}]/gu)?.length ?? 0;
  const nonHan = value.replace(/[\p{Script=Han}]/gu, "").length;
  return han + Math.ceil(nonHan / 4);
}

function contiguousGroups(hits: SearchHit[]): SearchHit[][] {
  const groups: SearchHit[][] = [];
  const used = new Set<number>();
  // The incoming order is relevance order. Use each first unseen hit as the
  // group's anchor, then merge only its contiguous structural neighbours.
  for (const anchor of hits) {
    if (used.has(anchor.chunk_id)) continue;
    const compatible = hits
      .filter((hit) =>
        !used.has(hit.chunk_id) &&
        hit.document_id === anchor.document_id &&
        hit.document_version === anchor.document_version &&
        hit.chapter === anchor.chapter &&
        hit.section === anchor.section)
      .sort((left, right) => left.chunk_index - right.chunk_index);
    const anchorIndex = compatible.findIndex((hit) => hit.chunk_id === anchor.chunk_id);
    let start = anchorIndex;
    let end = anchorIndex;
    while (start > 0 && compatible[start - 1]!.chunk_index + 1 === compatible[start]!.chunk_index) {
      start -= 1;
    }
    while (end + 1 < compatible.length && compatible[end]!.chunk_index + 1 === compatible[end + 1]!.chunk_index) {
      end += 1;
    }
    const group = compatible.slice(start, end + 1);
    group.forEach((hit) => used.add(hit.chunk_id));
    groups.push(group);
  }
  return groups;
}

export function packEvidence(
  hits: SearchHit[],
  tokenBudget = Number(process.env.RAG_CONTEXT_BUDGET_TOKENS ?? 6_000),
): PackedEvidence[] {
  const packed: PackedEvidence[] = [];
  let used = 0;
  for (const group of contiguousGroups(hits)) {
    const first = group[0]!;
    const original = group.map((hit) => hit.content.trim()).reduce(mergeOverlap);
    const content = sanitizeEvidenceContent(original);
    if (!content) continue;
    const redactions = Math.max(0, original.split(/\n+/u).length - content.split(/\n+/u).length);
    const metadata = `${first.title} ${first.filename ?? ""} ${first.chapter ?? ""} ${first.section ?? ""}`;
    const cost = estimatedTokens(metadata) + estimatedTokens(content) + 32;
    if (cost > tokenBudget - used) {
      if (group.length > 1) {
        const anchor = packEvidence([first], tokenBudget - used);
        if (anchor[0]) {
          packed.push({ ...anchor[0], evidence_id: packed.length + 1 });
          used += estimatedTokens(anchor[0].content) + estimatedTokens(metadata) + 32;
        }
      }
      continue;
    }
    packed.push({
      evidence_id: packed.length + 1,
      document_id: first.document_id,
      document_version: first.document_version ?? 1,
      title: first.title,
      filename: first.filename ?? first.title,
      content,
      chunk_ids: group.flatMap((hit) => hit.source_chunk_ids ?? [hit.chunk_id]),
      chunk_index: first.chunk_index,
      score: first.score,
      page_start: group.map((hit) => hit.page_start).filter((value): value is number => value !== null).at(0) ?? null,
      page_end: group.map((hit) => hit.page_end).filter((value): value is number => value !== null).at(-1) ?? null,
      chapter: first.chapter,
      section: first.section,
      content_type: first.content_type,
      quality_score: Math.min(...group.map((hit) => hit.quality_score)),
      redactions,
    });
    used += cost;
  }
  return packed;
}

export function retrievalOutcome(query: string, hits: SearchHit[]): "sufficient" | "retrieval_insufficient" {
  if (!hits.length) return "retrieval_insufficient";
  const top = hits.slice(0, 3);
  const channelAgreement = top.some((hit) =>
    [hit.content_rank, hit.metadata_rank, hit.exact_rank, hit.vector_rank].filter(Boolean).length >= 2,
  );
  const coverages = top.map((hit) => termCoverage(query, hit));
  const multipleGrounded = coverages.filter((value) => value >= 0.3).length >= 2;
  const exact = top.some((hit) => exactMetadataMatch(query, hit) > 0);
  return channelAgreement || multipleGrounded || exact || Math.max(...coverages) >= 0.55
    ? "sufficient"
    : "retrieval_insufficient";
}

export function escapeUntrustedContext(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
