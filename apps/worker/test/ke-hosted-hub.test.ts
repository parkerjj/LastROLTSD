import { describe, expect, it } from 'vitest';
import { AgentHub, PUSH_REV_MESSAGE, connectAgent, notifyAgents, type HubState } from '../src/ke/hosted/agent-hub';

class FakeSocket {
  sent: string[] = [];
  closed: [number | undefined, string | undefined] | null = null;
  constructor(private readonly failOnSend = false) {}
  send(message: string): void {
    if (this.failOnSend) throw new Error('closed');
    this.sent.push(message);
  }
  close(code?: number, reason?: string): void {
    this.closed = [code, reason];
  }
}

function hub(initial: FakeSocket[] = []) {
  const sockets = [...initial];
  const accepted: FakeSocket[] = [];
  const state: HubState = {
    acceptWebSocket: (socket) => {
      accepted.push(socket as FakeSocket);
      sockets.push(socket as FakeSocket);
    },
    getWebSockets: () => sockets,
    setWebSocketAutoResponse: () => {},
  };
  const server = new FakeSocket();
  const instance = new AgentHub(state, undefined, () => ({ client: 'client', server }), () => 'pair', (client) => new Response(`upgraded:${String(client)}`, { status: 200 }));
  return { instance, sockets, accepted, server };
}

describe('AgentHub（Hibernation WebSocket，只做即时推送）', () => {
  it('/notify 向全部连接推送 rev 信号；没有连接返回 202；对端已断开不会抛错', async () => {
    const alive = new FakeSocket();
    const dead = new FakeSocket(true);
    const { instance } = hub([alive, dead]);
    expect((await instance.fetch(new Request('https://agent-hub/notify', { method: 'POST' }))).status).toBe(204);
    expect(alive.sent).toEqual([PUSH_REV_MESSAGE]);
    expect((await hub().instance.fetch(new Request('https://agent-hub/notify', { method: 'POST' }))).status).toBe(202);
  });

  it('/connect 必须是 WebSocket 升级请求；新连接会顶掉旧连接，只保留最新一条', async () => {
    const old = new FakeSocket();
    const { instance, accepted, server } = hub([old]);
    expect((await instance.fetch(new Request('https://agent-hub/connect'))).status).toBe(426);
    expect(accepted).toHaveLength(0);
    const response = await instance.fetch(new Request('https://agent-hub/connect', { headers: { upgrade: 'websocket' } }));
    expect(await response.text()).toBe('upgraded:client');
    expect(old.closed).toEqual([1000, 'replaced']);
    expect(accepted).toEqual([server]);
  });

  it('未知路径 404；agent 发来的消息被忽略', async () => {
    const { instance } = hub();
    expect((await instance.fetch(new Request('https://agent-hub/other'))).status).toBe(404);
    expect(instance.webSocketMessage()).toBeUndefined();
  });

  it('notifyAgents：未绑定 DO 时是 no-op；绑定后按 agent 名字各通知一次', async () => {
    await expect(notifyAgents(undefined, ['agt_a'])).resolves.toBeUndefined();
    const calls: string[] = [];
    const namespace = {
      idFromName: (name: string) => name,
      get: (id: unknown) => ({ fetch: async (url: string) => { calls.push(`${String(id)} ${url}`); return new Response(null, { status: 204 }); } }),
    };
    await notifyAgents(namespace, ['agt_a', 'agt_b']);
    expect(calls).toEqual(['agt_a https://agent-hub/notify', 'agt_b https://agent-hub/notify']);
  });

  it('connectAgent 把升级请求头转交给该 agent 的 DO', async () => {
    let seen: { url: string; upgrade: string | null } | null = null;
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async (url: string, init?: RequestInit) => { seen = { url, upgrade: new Headers(init?.headers).get('upgrade') }; return new Response('ok'); } }),
    };
    await connectAgent(namespace, 'agt_a', new Request('https://origin.ltsd.ro/api/v1/ke/agent/ws', { headers: { upgrade: 'websocket' } }));
    expect(seen).toEqual({ url: 'https://agent-hub/connect', upgrade: 'websocket' });
  });
});
