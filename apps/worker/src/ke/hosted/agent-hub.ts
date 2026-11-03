/**
 * AgentHub：每个 agent 一个 Durable Object，承载一条 Hibernation WebSocket，只做“即时推送”。
 *
 * - 空闲时可休眠、不计 DO 时长：保活用 `setWebSocketAutoResponse`（ping→pong 不唤醒 DO、不计费）。
 * - 绝不使用 setInterval / setTimeout / alarm，也不挂着 fetch，否则无法休眠（设计稿 10.2）。
 * - 推送内容只是 `{"t":"rev"}` 信号（让 agent 立刻做一次租约对账），不携带指令；丢了也只是退回 60 秒租约周期。
 * - 同一个 agent 只保留最新的一条连接。
 *
 * 启用方式见 docs/ke-hosting.md：在 wrangler.toml 里加 `AGENT_HUB` 绑定与迁移；未启用时整套推送是 no-op。
 */

export const PUSH_REV_MESSAGE = '{"t":"rev"}';

interface HubSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
}

export interface HubState {
  acceptWebSocket(socket: HubSocket): void;
  getWebSockets(): HubSocket[];
  setWebSocketAutoResponse(pair: unknown): void;
}

export interface HubPair {
  client: unknown;
  server: HubSocket;
}

export class AgentHub {
  constructor(
    private readonly state: HubState,
    _env: unknown = undefined,
    private readonly createPair: () => HubPair = () => {
      const pair = new (globalThis as unknown as { WebSocketPair: new () => Record<string, unknown> }).WebSocketPair();
      return { client: pair[0], server: pair[1] as HubSocket };
    },
    autoResponse: () => unknown = () => new (globalThis as unknown as { WebSocketRequestResponsePair: new (a: string, b: string) => unknown }).WebSocketRequestResponsePair('ping', 'pong'),
    private readonly upgradeResponse: (client: unknown) => Response = (client) => new Response(null, { status: 101, webSocket: client } as ResponseInit),
  ) {
    try {
      this.state.setWebSocketAutoResponse(autoResponse());
    } catch {
      // 本地测试环境没有该全局：忽略。
    }
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/connect') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
      for (const old of this.state.getWebSockets()) {
        try {
          old.close(1000, 'replaced');
        } catch {
          // 已关闭
        }
      }
      const { client, server } = this.createPair();
      this.state.acceptWebSocket(server);
      return this.upgradeResponse(client);
    }
    if (path === '/notify') {
      let delivered = 0;
      for (const socket of this.state.getWebSockets()) {
        try {
          socket.send(PUSH_REV_MESSAGE);
          delivered += 1;
        } catch {
          // 对端已断开：agent 会重连并先做一次租约对账
        }
      }
      return new Response(null, { status: delivered > 0 ? 204 : 202 });
    }
    return new Response('not found', { status: 404 });
  }

  /** Hibernation 回调：agent 发来的文本（除自动应答的 ping 外）一律忽略。 */
  webSocketMessage(): void {}

  webSocketClose(socket: HubSocket): void {
    try {
      socket.close(1000, 'closed');
    } catch {
      // ignore
    }
  }

  webSocketError(): void {}
}

/** Worker 侧：向 AgentHub 发 notify（尽力而为）。 */
export async function notifyAgents(namespace: DurableObjectNamespaceLike | undefined, agentIds: readonly string[]): Promise<void> {
  if (!namespace) return;
  await Promise.all(agentIds.map(async (agentId) => {
    const stub = namespace.get(namespace.idFromName(agentId));
    await stub.fetch('https://agent-hub/notify', { method: 'POST' });
  }));
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(url: string, init?: RequestInit): Promise<Response> };
}

/** 把已通过签名校验的 WebSocket 升级请求交给该 agent 的 DO。 */
export async function connectAgent(namespace: DurableObjectNamespaceLike, agentId: string, request: Request): Promise<Response> {
  const stub = namespace.get(namespace.idFromName(agentId));
  const forwarded = new Request('https://agent-hub/connect', { method: 'GET', headers: request.headers });
  return stub.fetch(forwarded.url, { method: 'GET', headers: forwarded.headers });
}
