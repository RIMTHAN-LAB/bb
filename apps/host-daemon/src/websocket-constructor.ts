import { WebSocket as NodeWebSocket } from "ws";
import { proxyAgentFor } from "./env-proxy-agent.js";

interface NodeWebSocketConstructor {
  new (address: string | URL, protocols?: string | string[]): object;
}

export function createNodeWebSocketConstructor(
  headers: Record<string, string> | undefined,
  env: Record<string, string | undefined> = process.env,
): NodeWebSocketConstructor {
  return class ProxyAwareWebSocket extends NodeWebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      const agent = proxyAgentFor(address, env);
      super(address, protocols, {
        ...(headers ? { headers } : {}),
        ...(agent ? { agent } : {}),
      });
    }
  };
}
