export function createLatestRequestGate() {
  let latestRequest = 0;

  function begin(): number {
    latestRequest += 1;
    return latestRequest;
  }

  function isCurrent(request: number): boolean {
    return request === latestRequest;
  }

  function invalidate(): void {
    latestRequest += 1;
  }

  return { begin, isCurrent, invalidate };
}

export function searchEmptyCopy(hasSearched: boolean): {
  title: string;
  description: string;
} {
  return hasSearched
    ? {
        title: "没有找到相关内容",
        description: "请尝试更换关键词，或调整知识库、分类和标签筛选条件。",
      }
    : {
        title: "等待检索",
        description: "输入检索词后，系统会显示原文片段与来源。",
      };
}
