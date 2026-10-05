import http, { type AgentOptions } from "node:http";
import https from "node:https";
import net, { type Socket } from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";

type ProxyEnv = Record<string, string | undefined>;
type TunnelCallback = (error: Error | null, socket?: Socket) => void;

const CONNECT_RESPONSE_LIMIT = 16 * 1024;

function readEnv(env: ProxyEnv, name: string): string | undefined {
  const value = env[name.toLowerCase()] ?? env[name.toUpperCase()];
  return value !== undefined && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function defaultPort(protocol: string): number {
  return protocol === "https:" || protocol === "wss:" ? 443 : 80;
}

function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function noProxyEntryMatches(
  entry: string,
  host: string,
  port: number,
): boolean {
  if (entry === "*") return true;
  const slash = entry.indexOf("/");
  if (slash > 0) {
    const address = entry.slice(0, slash);
    const prefix = Number(entry.slice(slash + 1));
    const family = net.isIP(address);
    if (
      family === 0 ||
      !Number.isInteger(prefix) ||
      prefix < 0 ||
      prefix > (family === 6 ? 128 : 32) ||
      net.isIP(host) !== family
    ) {
      return false;
    }
    const range = new net.BlockList();
    range.addSubnet(address, prefix, family === 6 ? "ipv6" : "ipv4");
    return range.check(host, family === 6 ? "ipv6" : "ipv4");
  }
  let name = entry;
  let entryPort: number | undefined;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
  if (bracketed) {
    name = bracketed[1] ?? "";
    entryPort = bracketed[2] === undefined ? undefined : Number(bracketed[2]);
  } else if (net.isIP(entry) === 0) {
    const colon = entry.lastIndexOf(":");
    if (colon > 0 && /^\d+$/.test(entry.slice(colon + 1))) {
      name = entry.slice(0, colon);
      entryPort = Number(entry.slice(colon + 1));
    }
  }
  if (entryPort !== undefined && entryPort !== port) return false;
  name = name.replace(/^\*/, "");
  if (name.startsWith("."))
    return host.endsWith(name) || host === name.slice(1);
  return host === name || host.endsWith(`.${name}`);
}

function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const family = net.isIP(host);
  if (family === 0) return false;
  const loopback = new net.BlockList();
  loopback.addSubnet("127.0.0.0", 8, "ipv4");
  loopback.addAddress("::1", "ipv6");
  return loopback.check(host, family === 6 ? "ipv6" : "ipv4");
}

export function bypassesProxy(
  hostname: string,
  port: number,
  env: ProxyEnv = process.env,
): boolean {
  const host = bareHost(hostname).toLowerCase().replace(/\.$/, "");
  if (isLoopbackHost(host)) return true;
  const noProxy = readEnv(env, "no_proxy");
  if (noProxy === undefined) return false;
  return noProxy
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .some((entry) => noProxyEntryMatches(entry, host, port));
}

export function proxyUrlFor(
  target: string | URL,
  env: ProxyEnv = process.env,
): URL | undefined {
  const url = typeof target === "string" ? new URL(target) : target;
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  if (!secure && url.protocol !== "http:" && url.protocol !== "ws:") {
    return undefined;
  }
  const configured = readEnv(env, secure ? "https_proxy" : "http_proxy");
  if (configured === undefined) return undefined;
  const port = url.port === "" ? defaultPort(url.protocol) : Number(url.port);
  if (bypassesProxy(url.hostname, port, env)) return undefined;
  let proxy: URL;
  try {
    proxy = new URL(
      configured.includes("://") ? configured : `http://${configured}`,
    );
  } catch {
    throw new Error(
      `${secure ? "HTTPS_PROXY" : "HTTP_PROXY"} is not a valid URL`,
    );
  }
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
    throw new Error(
      `Unsupported proxy protocol ${proxy.protocol}; only http: and https: proxies tunnel`,
    );
  }
  return proxy;
}

function authority(host: string, port: number): string {
  return net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
}

function openTunnel(
  proxy: URL,
  host: string,
  port: number,
  callback: TunnelCallback,
): void {
  const proxyHost = bareHost(proxy.hostname);
  const proxyPort =
    proxy.port === "" ? defaultPort(proxy.protocol) : Number(proxy.port);
  const socket: Socket =
    proxy.protocol === "https:"
      ? tls.connect({
          host: proxyHost,
          port: proxyPort,
          servername: net.isIP(proxyHost) === 0 ? proxyHost : undefined,
        })
      : net.connect({ host: proxyHost, port: proxyPort });
  let settled = false;
  let buffered = Buffer.alloc(0);
  const finish = (error: Error | null, tunnel?: Socket) => {
    if (settled) return;
    settled = true;
    socket.off("data", onData);
    socket.off("error", onError);
    socket.off("close", onClose);
    if (error) {
      socket.destroy();
      callback(error);
      return;
    }
    callback(null, tunnel);
  };
  const onError = (error: Error) => finish(error);
  const onClose = () =>
    finish(new Error("Proxy closed the connection before the tunnel opened"));
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf("\r\n\r\n");
    if (end === -1) {
      if (buffered.length > CONNECT_RESPONSE_LIMIT) {
        finish(new Error("Proxy CONNECT response too large"));
      }
      return;
    }
    const statusLine = buffered
      .subarray(0, buffered.indexOf("\r\n"))
      .toString("latin1");
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1];
    if (status === undefined || !status.startsWith("2")) {
      finish(
        new Error(
          `Proxy refused CONNECT to ${authority(host, port)}: ${status ?? "malformed response"}`,
        ),
      );
      return;
    }
    const rest = buffered.subarray(end + 4);
    if (rest.length > 0) socket.unshift(rest);
    finish(null, socket);
  };
  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);
  socket.once(proxy.protocol === "https:" ? "secureConnect" : "connect", () => {
    const target = authority(host, port);
    const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
    if (proxy.username !== "" || proxy.password !== "") {
      const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      lines.push(
        `Proxy-Authorization: Basic ${Buffer.from(credentials).toString("base64")}`,
      );
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  });
}

type RequestOptions = http.ClientRequestArgs & tls.ConnectionOptions;
type AgentCallback = (error: Error | null, stream: Duplex) => void;

function targetOf(
  options: RequestOptions,
  fallbackPort: number,
): { host: string; port: number } {
  const host = bareHost(options.host ?? options.hostname ?? "localhost");
  const port = Number(options.port ?? "") || fallbackPort;
  return { host, port };
}

function reply(callback: AgentCallback | undefined): TunnelCallback {
  return (error, socket) => callback?.(error, socket as Duplex);
}

class HttpConnectProxyAgent extends http.Agent {
  constructor(
    private readonly proxy: URL,
    options?: AgentOptions,
  ) {
    super(options);
  }

  override createConnection(
    options: RequestOptions,
    callback?: AgentCallback,
  ): undefined {
    const { host, port } = targetOf(options, 80);
    openTunnel(this.proxy, host, port, reply(callback));
    return undefined;
  }
}

class HttpsConnectProxyAgent extends https.Agent {
  constructor(
    private readonly proxy: URL,
    options?: https.AgentOptions,
  ) {
    super(options);
  }

  override createConnection(
    options: RequestOptions,
    callback?: AgentCallback,
  ): undefined {
    const done = reply(callback);
    const { host, port } = targetOf(options, 443);
    openTunnel(this.proxy, host, port, (error, tunnel) => {
      if (error || !tunnel) {
        done(error ?? new Error("Proxy tunnel unavailable"));
        return;
      }
      const {
        path: _path,
        socketPath: _socketPath,
        host: _host,
        hostname: _hostname,
        port: _port,
        ...tlsOptions
      } = options;
      const secure = tls.connect({
        ...(tlsOptions as tls.ConnectionOptions),
        socket: tunnel,
        servername:
          options.servername || (net.isIP(host) === 0 ? host : undefined),
      });
      let connected = false;
      secure.once("secureConnect", () => {
        connected = true;
        done(null, secure);
      });
      secure.once("error", (tlsError) => {
        if (!connected) done(tlsError);
      });
    });
    return undefined;
  }
}

export function proxyAgentFor(
  target: string | URL,
  env: ProxyEnv = process.env,
  agentOptions?: https.AgentOptions,
): http.Agent | undefined {
  const url = typeof target === "string" ? new URL(target) : target;
  const proxy = proxyUrlFor(url, env);
  if (proxy === undefined) return undefined;
  return url.protocol === "https:" || url.protocol === "wss:"
    ? new HttpsConnectProxyAgent(proxy, agentOptions)
    : new HttpConnectProxyAgent(proxy, agentOptions);
}
