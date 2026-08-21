// UI 文案接缝（2026-08-21 QA 轮拍板：库内 15 处硬编码中文 busy 文案出库）。
//
// 契约：库内**只发 key**（下面的 StoreTextKey 全集）；宿主经 `StoreUI.text` 注入翻译
//   （如 WeebPaint 把 key 映到自家 i18n SSoT 的 t()）；宿主没接 / 返回 undefined → 落回
//   内建英文缺省。库是通用件——用户可见文案的本地化归宿主 i18n，不再烤任何具体语言的
//   成品字符串在调用点（中文由宿主注入，英文缺省只是兜底不是产品文案）。
//
// 带参数的 key（{name}）：宿主 text() 自己插值（收到 params 原样转交）；英文缺省由本模块插值。

export type StoreTextKey =
  | "sync.pushing"        // push：保存并推云
  | "file.renaming"       // identity：重命名
  | "file.pulling"        // identity：拉取云端字节
  | "cloud.checking"      // freshness：开档/事件快进前查云
  | "file.deleting"       // delete：删除（移入回收站）
  | "trash.restoring"     // trash：从回收站恢复
  | "trash.purging"       // trash：彻底删除单项
  | "trash.emptyTrash"    // trash：清空回收站
  | "trash.emptyBackups"  // trash：清空备份箱
  | "file.encrypting"     // create-store：加密 {name}
  | "file.decrypting"     // create-store：解除加密 {name}
  | "file.reuploading"    // create-store：重新上传
  | "folder.creating"     // create-store：新建文件夹
  | "folder.deleting";    // create-store：删除文件夹

export type StoreTextParams = Record<string, string>;
/** 宿主翻译注入面（StoreUI.text）。返回 undefined = 该 key 落回英文缺省。 */
export type StoreTextFn = (key: StoreTextKey, params?: StoreTextParams) => string | undefined;

const STORE_TEXT_EN: Record<StoreTextKey, string> = {
  "sync.pushing": "Syncing…",
  "file.renaming": "Renaming…",
  "file.pulling": "Pulling…",
  "cloud.checking": "Checking cloud…",
  "file.deleting": "Deleting…",
  "trash.restoring": "Restoring…",
  "trash.purging": "Deleting permanently…",
  "trash.emptyTrash": "Emptying trash…",
  "trash.emptyBackups": "Emptying backup box…",
  "file.encrypting": "Encrypting {name}…",
  "file.decrypting": "Decrypting {name}…",
  "file.reuploading": "Re-uploading…",
  "folder.creating": "Creating folder…",
  "folder.deleting": "Deleting folder…",
};

function interpolate(s: string, params?: StoreTextParams): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));
}

/** key → 显示文案：宿主翻译优先，缺省英文；未知 key（理论不可达，防御）原样返回。 */
export function resolveStoreText(custom: StoreTextFn | undefined, key: StoreTextKey, params?: StoreTextParams): string {
  const fromHost = custom?.(key, params);
  if (fromHost != null) return fromHost;                       // 宿主已插值
  const base = STORE_TEXT_EN[key];
  return base != null ? interpolate(base, params) : String(key);
}
