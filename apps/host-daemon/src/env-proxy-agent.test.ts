import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import net, { type AddressInfo, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import {
  bypassesProxy,
  proxyAgentFor,
  proxyUrlFor,
} from "./env-proxy-agent.js";
import { createNodeWebSocketConstructor } from "./websocket-constructor.js";

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg0OKI0AJt/LhBQ6sL
OmcPmUFI31RIaXHfnqpk/WFP+8qhRANCAAQEZj2Cb8Z395NWbsSrB3L0IcGD42IY
K2rEiLK+zj3vMEAZTcefx08h0vXVzwKM2xviiYfIYlFb2RRFWsJMxXUR
-----END PRIVATE KEY-----`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBzDCCAXKgAwIBAgIUEifnSC2TxGnuqwe1fW/zyGKe6UIwCgYIKoZIzj0EAwIw
IDEeMBwGA1UEAwwVYmItcHJveHktdGVzdC5pbnZhbGlkMCAXDTI2MDkzMDE2NTAw
OVoYDzIxMjYwOTA2MTY1MDA5WjAgMR4wHAYDVQQDDBViYi1wcm94eS10ZXN0Lmlu
dmFsaWQwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQEZj2Cb8Z395NWbsSrB3L0
IcGD42IYK2rEiLK+zj3vMEAZTcefx08h0vXVzwKM2xviiYfIYlFb2RRFWsJMxXUR
o4GHMIGEMB0GA1UdDgQWBBRDFuKMyyGWKgWJyVpOmemkzWSjbTAfBgNVHSMEGDAW
gBRDFuKMyyGWKgWJyVpOmemkzWSjbTAPBgNVHRMBAf8EBTADAQH/MDEGA1UdEQQq
MCiCFWJiLXByb3h5LXRlc3QuaW52YWxpZIIJbG9jYWxob3N0hwR/AAABMAoGCCqG
SM49BAMCA0gAMEUCIQCleA8geGdRAXG7qxbu+QF/ETl9/h8Dr59DoUVwPynusAIg
Q4a3nGiG194I0FM4EvVvi2pv3v3SD7P908lR3plX9TU=
-----END CERTIFICATE-----`;

const UNRESOLVABLE = "bb-proxy-test.invalid";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

function listen(server: http.Server): Promise<number> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  closers.push(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    ),
  );
}

async function startWebSocketServer(secure: boolean): Promise<number> {
  const server = secure
    ? https.createServer({ key: TEST_KEY, cert: TEST_CERT })
    : http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on(
    "upgrade",
    (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      wss.handleUpgrade(request, socket, head, (client) => {
        client.send(`hello ${String(request.headers["x-probe"] ?? "")}`);
      });
    },
  );
  return listen(server);
}

async function startConnectProxy(): Promise<{
  port: number;
  tunnels: string[];
}> {
  const tunnels: string[] = [];
  const server = http.createServer((_request, response) =>
    response.writeHead(405).end(),
  );
  server.on(
    "connect",
    (request: IncomingMessage, client: Duplex, head: Buffer) => {
      const expected = `Basic ${Buffer.from("user:s3cr@t").toString("base64")}`;
      if (request.headers["proxy-authorization"] !== expected) {
        client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
        return;
      }
      const target = request.url ?? "";
      tunnels.push(target);
      const colon = target.lastIndexOf(":");
      const host =
        target.slice(0, colon) === UNRESOLVABLE
          ? "127.0.0.1"
          : target.slice(0, colon);
      const upstream = net.connect(
        Number(target.slice(colon + 1)),
        host,
        () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) upstream.write(head);
          upstream.pipe(client).pipe(upstream);
        },
      );
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    },
  );
  return { port: await listen(server), tunnels };
}

function firstMessage(socket: NodeWebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.on("message", (data: Buffer) => {
      resolve(data.toString());
      socket.close();
    });
    socket.on("error", reject);
  });
}

function proxyEnv(port: number, extra: Record<string, string> = {}) {
  const proxy = `http://user:s3cr%40t@127.0.0.1:${port}`;
  return { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ...extra };
}

describe("proxy selection", () => {
  it("connects directly when no proxy is set", () => {
    expect(proxyUrlFor("wss://bb.example", {})).toBeUndefined();
    expect(proxyAgentFor("wss://bb.example", {})).toBeUndefined();
    expect(
      proxyUrlFor("wss://bb.example", { HTTPS_PROXY: "  " }),
    ).toBeUndefined();
  });

  it("uses HTTPS_PROXY for secure targets and HTTP_PROXY for plain ones", () => {
    const env = {
      HTTPS_PROXY: "http://secure:1",
      HTTP_PROXY: "http://plain:2",
    };
    expect(proxyUrlFor("wss://a.example", env)?.host).toBe("secure:1");
    expect(proxyUrlFor("https://a.example", env)?.host).toBe("secure:1");
    expect(proxyUrlFor("ws://a.example", env)?.host).toBe("plain:2");
    expect(
      proxyUrlFor("ws://a.example", { HTTPS_PROXY: "http://secure:1" }),
    ).toBeUndefined();
    expect(
      proxyUrlFor("wss://a.example", {
        https_proxy: "http://lower:3",
        HTTPS_PROXY: "http://upper:4",
      })?.host,
    ).toBe("lower:3");
    expect(
      proxyUrlFor("wss://a.example", { HTTPS_PROXY: "10.0.0.1:3128" })?.host,
    ).toBe("10.0.0.1:3128");
  });

  it("refuses a proxy it cannot tunnel through without echoing the value", () => {
    expect(() =>
      proxyUrlFor("wss://a.example", {
        HTTPS_PROXY: "socks5://user:hunter2@p:1080",
      }),
    ).toThrow(/socks5:/);
    try {
      proxyUrlFor("wss://a.example", {
        HTTPS_PROXY: "socks5://user:hunter2@p:1080",
      });
    } catch (error) {
      expect(String(error)).not.toContain("hunter2");
    }
  });

  it("honours NO_PROXY hosts, suffixes, ports and CIDR ranges", () => {
    const env = {
      NO_PROXY:
        "localhost,127.0.0.1,::1,169.254.0.0/16,.internal,*.corp.example,exact.example:8443,192.0.2.1/32",
    };
    for (const [host, port] of [
      ["localhost", 80],
      ["127.0.0.1", 443],
      ["[::1]", 443],
      ["169.254.169.254", 80],
      ["192.0.2.1", 7233],
      ["svc.internal", 443],
      ["internal", 443],
      ["a.b.corp.example", 443],
      ["exact.example", 8443],
      ["sub.exact.example", 8443],
    ] as const) {
      expect(bypassesProxy(host, port, env), host).toBe(true);
    }
    for (const [host, port] of [
      ["api.example.com", 443],
      ["192.0.2.2", 443],
      ["exact.example", 443],
      ["notinternal", 443],
      ["corp.example.evil", 443],
    ] as const) {
      expect(bypassesProxy(host, port, env), host).toBe(false);
    }
    for (const host of ["localhost", "127.0.0.1", "127.8.9.10", "[::1]"]) {
      expect(bypassesProxy(host, 443, {}), host).toBe(true);
    }
    expect(bypassesProxy("anything.example", 443, { no_proxy: "*" })).toBe(
      true,
    );
    expect(bypassesProxy("10.0.0.1", 443, { NO_PROXY: "10.0.0.0/99" })).toBe(
      false,
    );
    expect(
      proxyUrlFor("wss://svc.internal", { ...env, HTTPS_PROXY: "http://p:1" }),
    ).toBeUndefined();
  });
});

describe("daemon WebSocket through a CONNECT proxy", () => {
  it("tunnels through HTTPS_PROXY to a host only the proxy can resolve", async () => {
    const wsPort = await startWebSocketServer(false);
    const proxy = await startConnectProxy();
    const ProxyAwareWebSocket = createNodeWebSocketConstructor(
      { "x-probe": "proxied" },
      proxyEnv(proxy.port),
    );
    const socket = new ProxyAwareWebSocket(
      `ws://${UNRESOLVABLE}:${wsPort}/ws`,
    ) as NodeWebSocket;
    await expect(firstMessage(socket)).resolves.toBe("hello proxied");
    expect(proxy.tunnels).toEqual([`${UNRESOLVABLE}:${wsPort}`]);
  });

  it("carries TLS end to end through the tunnel for a wss server", async () => {
    const wsPort = await startWebSocketServer(true);
    const proxy = await startConnectProxy();
    const url = `wss://${UNRESOLVABLE}:${wsPort}/ws`;
    const agent = proxyAgentFor(url, proxyEnv(proxy.port), { ca: TEST_CERT });
    expect(agent).toBeDefined();
    const socket = new NodeWebSocket(url, {
      headers: { "x-probe": "tls" },
      agent,
    });
    await expect(firstMessage(socket)).resolves.toBe("hello tls");
    expect(proxy.tunnels).toEqual([`${UNRESOLVABLE}:${wsPort}`]);
  });

  it("connects directly when no proxy is set", async () => {
    const wsPort = await startWebSocketServer(false);
    const proxy = await startConnectProxy();
    const DirectWebSocket = createNodeWebSocketConstructor(
      { "x-probe": "direct" },
      {},
    );
    const socket = new DirectWebSocket(
      `ws://127.0.0.1:${wsPort}/ws`,
    ) as NodeWebSocket;
    await expect(firstMessage(socket)).resolves.toBe("hello direct");
    expect(proxy.tunnels).toEqual([]);
  });

  it("bypasses the proxy for a NO_PROXY host", async () => {
    const wsPort = await startWebSocketServer(false);
    const proxy = await startConnectProxy();
    const env = proxyEnv(proxy.port, { NO_PROXY: UNRESOLVABLE });
    const BypassWebSocket = createNodeWebSocketConstructor(undefined, env);
    const socket = new BypassWebSocket(
      `ws://${UNRESOLVABLE}:${wsPort}/ws`,
    ) as NodeWebSocket;
    const error = await firstMessage(socket).then(
      () => new Error("unexpectedly connected"),
      (reason: unknown) => reason as Error,
    );
    expect(error.message).toContain("ENOTFOUND");
    expect(proxy.tunnels).toEqual([]);
  });

  it("connects to loopback directly even when NO_PROXY omits it", async () => {
    const wsPort = await startWebSocketServer(false);
    const proxy = await startConnectProxy();
    const LoopbackWebSocket = createNodeWebSocketConstructor(
      { "x-probe": "loopback" },
      proxyEnv(proxy.port),
    );
    const socket = new LoopbackWebSocket(
      `ws://127.0.0.1:${wsPort}/ws`,
    ) as NodeWebSocket;
    await expect(firstMessage(socket)).resolves.toBe("hello loopback");
    expect(proxy.tunnels).toEqual([]);
  });

  it("fails the connection when the proxy refuses the tunnel", async () => {
    const wsPort = await startWebSocketServer(false);
    const proxy = await startConnectProxy();
    const env = {
      HTTP_PROXY: `http://user:wrong-password@127.0.0.1:${proxy.port}`,
    };
    const RefusedWebSocket = createNodeWebSocketConstructor(undefined, env);
    const socket = new RefusedWebSocket(
      `ws://${UNRESOLVABLE}:${wsPort}/ws`,
    ) as NodeWebSocket;
    const error = await firstMessage(socket).then(
      () => new Error("unexpectedly connected"),
      (reason: unknown) => reason as Error,
    );
    expect(error.message).toContain("407");
    expect(error.message).not.toContain("wrong-password");
    expect(proxy.tunnels).toEqual([]);
  });
});
