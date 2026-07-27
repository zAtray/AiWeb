import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const baseUrl = readArg("--base-url", "http://127.0.0.1:11434");
const model = readArg("--model", "qwen3:4b");
const file = resolve(readArg("--file", "training/data/eval.jsonl"));
const output = readArg("--output", "");
const systemFile = readArg("--system-file", "");
const fewShotFile = readArg("--few-shot-file", "");
const limit = Number(readArg("--limit", "0"));
const offset = Number(readArg("--offset", "0"));
const numGpu = Number(readArg("--num-gpu", "-1"));
const keepAlive = readArg("--keep-alive", "10m");
const ids = readArg("--ids", "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const quiet = process.argv.includes("--quiet");
const systemPrompt = systemFile
  ? (await readFile(resolve(systemFile), "utf8")).trim()
  : "";
const fewShotMessages = fewShotFile
  ? JSON.parse(await readFile(resolve(fewShotFile), "utf8"))
  : [];
const dropSystem = process.argv.includes("--drop-system");

const rows = (await readFile(file, "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const candidates = ids.length > 0 ? rows.filter((row) => ids.includes(row.id)) : rows;
const selected =
  limit > 0
    ? candidates.slice(offset, offset + limit)
    : candidates.slice(offset);

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function containsAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

async function run(row) {
  const messages = row.messages.slice(0, -1);
  if (dropSystem) {
    const systemIndex = messages.findIndex((message) => message.role === "system");
    if (systemIndex >= 0) {
      messages.splice(systemIndex, 1);
    }
  }
  if (systemPrompt) {
    const systemIndex = messages.findIndex((message) => message.role === "system");
    if (systemIndex >= 0) {
      messages[systemIndex] = { role: "system", content: systemPrompt };
    } else {
      messages.unshift({ role: "system", content: systemPrompt });
    }
  }
  if (fewShotMessages.length > 0) {
    const insertAt = messages[0]?.role === "system" ? 1 : 0;
    messages.splice(
      insertAt,
      0,
      ...fewShotMessages.map((message) => ({ ...message })),
    );
  }
  const started = performance.now();
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      think: false,
      keep_alive: keepAlive,
      options: {
        temperature: 0,
        seed: 20260726,
        num_ctx: 2048,
        num_predict: 192,
        ...(numGpu >= 0 ? { num_gpu: numGpu } : {}),
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  const result = await response.json();
  const answer = result.message?.content?.trim() ?? "";
  const checks = row.checks;
  const termHits = checks.requiredTerms.map((term) => answer.includes(term));
  const citationHits = checks.requiredCitations.map((number) =>
    answer.includes(`[${number}]`),
  );
  const forbiddenHits = checks.forbiddenTerms.filter((term) => answer.includes(term));
  const refused = containsAny(answer, [
    "无法确认",
    "无法根据",
    "没有提供",
    "未提供",
    "不知道",
    "存在冲突",
  ]);
  const passed =
    termHits.every(Boolean) &&
    citationHits.every(Boolean) &&
    forbiddenHits.length === 0 &&
    (!checks.refusal || refused);

  return {
    id: row.id,
    category: row.category,
    passed,
    wall_ms: Number((performance.now() - started).toFixed(2)),
    prompt_tokens: result.prompt_eval_count,
    output_tokens: result.eval_count,
    output_tok_s: Number(
      (result.eval_count / (result.eval_duration / 1e9)).toFixed(2),
    ),
    checks: {
      required_terms: {
        passed: termHits.filter(Boolean).length,
        total: termHits.length,
      },
      citations: {
        passed: citationHits.filter(Boolean).length,
        total: citationHits.length,
      },
      forbidden_hits: forbiddenHits,
      refusal: checks.refusal ? refused : null,
    },
    expected: row.messages.at(-1).content,
    answer,
  };
}

const results = [];
for (let index = 0; index < selected.length; index += 1) {
  const result = await run(selected[index]);
  results.push(result);
  if ((index + 1) % 10 === 0 || index + 1 === selected.length) {
    console.error(`evaluated ${index + 1}/${selected.length}`);
  }
}

const durations = results.map((row) => row.wall_ms);
const speeds = results.map((row) => row.output_tok_s);
const citationTotals = results.reduce(
  (total, row) => {
    total.passed += row.checks.citations.passed;
    total.expected += row.checks.citations.total;
    return total;
  },
  { passed: 0, expected: 0 },
);
const byCategory = Object.fromEntries(
  [...new Set(results.map((row) => row.category))].map((category) => {
    const group = results.filter((row) => row.category === category);
    return [
      category,
      {
        passed: group.filter((row) => row.passed).length,
        total: group.length,
        pass_rate: Number(
          (group.filter((row) => row.passed).length / group.length).toFixed(4),
        ),
      },
    ];
  }),
);

const report = {
  generated_at: new Date().toISOString(),
  model,
  system_file: systemFile ? resolve(systemFile) : null,
  few_shot_file: fewShotFile ? resolve(fewShotFile) : null,
  offset,
  num_gpu: numGpu >= 0 ? numGpu : null,
  keep_alive: keepAlive,
  drop_system: dropSystem,
  source_file: file,
  examples: results.length,
  passed: results.filter((row) => row.passed).length,
  pass_rate: Number(
    (results.filter((row) => row.passed).length / results.length).toFixed(4),
  ),
  citation_recall:
    citationTotals.expected === 0
      ? 1
      : Number((citationTotals.passed / citationTotals.expected).toFixed(4)),
  latency_ms: {
    p50: percentile(durations, 0.5),
    p95: percentile(durations, 0.95),
  },
  output_tok_s: {
    median: percentile(speeds, 0.5),
    min: Math.min(...speeds),
    max: Math.max(...speeds),
  },
  by_category: byCategory,
  failures: results.filter((row) => !row.passed),
};

const text = `${JSON.stringify(report, null, 2)}\n`;
if (output) {
  await writeFile(resolve(output), text, "utf8");
}
if (quiet) {
  console.log(
    JSON.stringify(
      {
        model: report.model,
        system_file: report.system_file,
        few_shot_file: report.few_shot_file,
        examples: report.examples,
        passed: report.passed,
        pass_rate: report.pass_rate,
        citation_recall: report.citation_recall,
        latency_ms: report.latency_ms,
        output_tok_s: report.output_tok_s,
        by_category: report.by_category,
      },
      null,
      2,
    ),
  );
} else {
  console.log(text);
}
