// ============================================================
// 全局 WS 客户端连接池
// 管理每个 accountId 对应的 NapCatWsClient 实例
// gateway.startAccount 注册，gateway.stopAccount 注销
// outbound / pairing 通过 accountId 获取客户端发消息
// ============================================================

import type { NapCatWsClient } from "./ws-client.js";

const clients = new Map<string, NapCatWsClient>();

/** 注册客户端（gateway.startAccount 调用） */
export function registerClient(accountId: string, client: NapCatWsClient): void {
  clients.set(accountId, client);
}

/** 注销客户端（gateway.stopAccount 调用） */
export function unregisterClient(accountId: string): NapCatWsClient | undefined {
  const client = clients.get(accountId);
  clients.delete(accountId);
  return client;
}

/** 获取客户端（outbound / pairing 调用） */
export function getClient(accountId: string): NapCatWsClient | undefined {
  return clients.get(accountId);
}

/** 获取客户端或抛出错误 */
export function requireClient(accountId: string): NapCatWsClient {
  const client = clients.get(accountId);
  if (!client) {
    throw new Error(`[napcatqq] No active WebSocket client for account "${accountId}"`);
  }
  return client;
}
