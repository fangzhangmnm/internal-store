// 测试用的文档种类表（0.16.0 起 createStore 必填 docKinds）。created 2026-09-29 by Claude Fable 5.1
//   覆盖测试语料里出现过的后缀；表本身经 validateDocKinds（.webxiaoheiwu.zip 去掉 .zip 剩 .webxiaoheiwu，和别的后缀不互为结尾）。
export const TEST_KINDS = Object.freeze([
  { kind: "painting", suffix: ".ora", container: "zip" },
  { kind: "draft", suffix: ".txt", container: "raw" },
  { kind: "book", suffix: ".webxiaoheiwu.zip", container: "zip" },
  { kind: "model", suffix: ".glb", container: "raw" },
  { kind: "data", suffix: ".dat", container: "raw" },
]);
