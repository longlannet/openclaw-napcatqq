// ============================================================
// NapCatQQ 插件运行时引用
// 在 register() 阶段保存 PluginRuntime，供 gateway/outbound 使用
// 参照 Telegram 插件的 runtime.ts 模式
// ============================================================

import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setNapCatRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getNapCatRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("[napcatqq] Plugin runtime not initialized");
  }
  return runtime;
}
