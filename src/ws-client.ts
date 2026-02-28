// ============================================================
// WebSocket 客户端 — 连接 NapCatQQ (OneBot v11)
// 支持 wss:// (宝塔反代 HTTPS) 和 ws://
// 自动重连 + 心跳检测
// ============================================================

import WebSocket from "ws";
import type { OneBotEvent, OneBotApiRequest, OneBotApiResponse } from "./types.js";

export interface WsClientOptions {
  wsUrl: string;                  // e.g. "wss://ncqw.ma.al"
  accessToken?: string;
  onEvent: (event: OneBotEvent) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  reconnectIntervalMs?: number;   // 默认 5000
  heartbeatTimeoutMs?: number;    // 默认 60000
}

export class NapCatWsClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCalls = new Map<string, { resolve: (v: OneBotApiResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private callSeq = 0;
  private stopped = false;

  private readonly opts: Required<Pick<WsClientOptions, "reconnectIntervalMs" | "heartbeatTimeoutMs">> & WsClientOptions;

  constructor(options: WsClientOptions) {
    this.opts = {
      reconnectIntervalMs: 5000,
      heartbeatTimeoutMs: 60000,
      ...options,
    };
  }

  // ---------- 生命周期 ----------

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.close(1000, "plugin stop");
      this.ws = null;
    }
    // reject all pending
    for (const [, p] of this.pendingCalls) {
      clearTimeout(p.timer);
      p.reject(new Error("client stopped"));
    }
    this.pendingCalls.clear();
  }

  // ---------- API 调用（带 echo 匹配） ----------

  async callApi(action: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<OneBotApiResponse> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("WebSocket not connected"));
      }
      const echo = `oc_${++this.callSeq & 0x7FFFFFFF}`;
      const timer = setTimeout(() => {
        this.pendingCalls.delete(echo);
        reject(new Error(`API call ${action} timed out`));
      }, timeoutMs);
      this.pendingCalls.set(echo, { resolve, reject, timer });
      const req: OneBotApiRequest = { action, params, echo };
      this.ws.send(JSON.stringify(req));
    });
  }

  // ---------- 内部连接 ----------

  private connect(): void {
    if (this.stopped) return;

    // 清理旧连接（如果有）
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }

    // 拒绝所有等待中的 API 调用（旧连接的回包不会再来了）
    for (const [echo, p] of this.pendingCalls) {
      clearTimeout(p.timer);
      p.reject(new Error("WebSocket reconnecting"));
    }
    this.pendingCalls.clear();

    this.opts.logger.info(`[napcatqq] Connecting to ${this.opts.wsUrl} ...`);

    // token 通过 Authorization header 传递，不暴露在 URL 里
    const wsOptions: WebSocket.ClientOptions = {};
    if (this.opts.accessToken) {
      wsOptions.headers = {
        Authorization: `Bearer ${this.opts.accessToken}`,
      };
    }

    const ws = new WebSocket(this.opts.wsUrl, wsOptions);
    this.ws = ws;

    ws.on("open", () => {
      this.opts.logger.info("[napcatqq] WebSocket connected");
      this.resetHeartbeatTimer();
      this.opts.onConnected?.();
    });

    ws.on("message", (raw: Buffer | string) => {
      this.resetHeartbeatTimer();
      let data: any;
      try {
        data = JSON.parse(raw.toString());
      } catch (e) {
        this.opts.logger.warn("[napcatqq] Failed to parse WS message:", e);
        return;
      }
      try {
        // API 回包（有 echo）
        if (data.echo && this.pendingCalls.has(data.echo)) {
          const p = this.pendingCalls.get(data.echo)!;
          clearTimeout(p.timer);
          this.pendingCalls.delete(data.echo);
          p.resolve(data as OneBotApiResponse);
          return;
        }
        // 事件
        if (data.post_type) {
          this.opts.onEvent(data as OneBotEvent);
        }
      } catch (e) {
        this.opts.logger.error("[napcatqq] Event handler error:", e);
      }
    });

    ws.on("close", (code, reason) => {
      this.opts.logger.warn(`[napcatqq] WebSocket closed: ${code} ${reason?.toString() ?? ""}`);
      this.opts.onDisconnected?.();
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      this.opts.logger.error("[napcatqq] WebSocket error:", err.message);
      // 不手动调用 ws.close()，error 事件后 Node.js ws 库会自动触发 close 事件
      // 手动 close 会导致 close 回调触发两次 → 双重重连
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.clearTimers();
    this.reconnectTimer = setTimeout(() => this.connect(), this.opts.reconnectIntervalMs);
    this.opts.logger.info(`[napcatqq] Reconnecting in ${this.opts.reconnectIntervalMs}ms ...`);
  }

  private resetHeartbeatTimer(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      this.opts.logger.warn("[napcatqq] Heartbeat timeout, reconnecting ...");
      this.ws?.close(4000, "heartbeat timeout");
    }, this.opts.heartbeatTimeoutMs);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.heartbeatTimer) { clearTimeout(this.heartbeatTimer); this.heartbeatTimer = null; }
  }
}
