// Network and process tripwire, loaded into every test process by test/run.mjs with --import.
// Test-only; never shipped. It follows nix-config's test/ai/pi-warden-net-tripwire.mjs and
// extends it: every non-loopback TCP connection, DNS lookup or query, UDP socket, child
// process, fetch() and WebSocket is refused and recorded in PI_SMART_ROUTER_NETLOG, and
// test/run.mjs fails the run when that log is not empty, even if a test caught the refusal.
// fetch and WebSocket are wrapped through accessors so the wrappers survive a later
// assignment, such as Pi installing undici's fetch.
import child_process from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

const record = (entry) => {
  const log = process.env.PI_SMART_ROUTER_NETLOG;
  if (log) appendFileSync(log, `${JSON.stringify({ ...entry, pid: process.pid })}\n`);
};

const loopback = (host) => {
  if (host === undefined || host === null || host === "") return true;
  const name = String(host).replace(/^\[|\]$/g, "").toLowerCase();
  return name === "localhost" || name === "::1" || name === "::ffff:127.0.0.1" || /^127\.\d+\.\d+\.\d+$/.test(name);
};

const refusal = (what, code) => Object.assign(new Error(`pi-smart-router tests refused ${what}`), { code });

// TCP, and TLS on top of it.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function tripwireConnect(...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  let host;
  let path;
  if (options !== null && typeof options === "object") ({ host, path } = options);
  else if (typeof options === "string" && typeof args[1] !== "string") path = options;
  else host = typeof args[1] === "string" ? args[1] : undefined;
  if (path === undefined && !loopback(host)) {
    record({ kind: "connect", host });
    process.nextTick(() => this.destroy(refusal(`a connection to ${host}`, "ECONNREFUSED")));
    return this;
  }
  return connect.apply(this, args);
};

// DNS: getaddrinfo lookups of loopback names stay allowed; every query to a DNS server is refused.
const refusedLookup = (hostname) => Object.assign(refusal(`a lookup of ${hostname}`, "ENOTFOUND"), { hostname });
const lookup = dns.lookup;
dns.lookup = function tripwireLookup(hostname, ...rest) {
  if (loopback(hostname)) return lookup.call(this, hostname, ...rest);
  record({ kind: "dns", call: "lookup", hostname });
  const callback = rest.at(-1);
  if (typeof callback === "function") process.nextTick(() => callback(refusedLookup(hostname)));
  return {};
};
const promiseLookup = dns.promises.lookup;
dns.promises.lookup = async function tripwirePromiseLookup(hostname, ...rest) {
  if (loopback(hostname)) return promiseLookup.call(this, hostname, ...rest);
  record({ kind: "dns", call: "lookup", hostname });
  throw refusedLookup(hostname);
};
const queries = (target) =>
  Object.getOwnPropertyNames(target).filter(
    (name) => typeof target[name] === "function" && (name.startsWith("resolve") || name === "reverse" || name === "lookupService"),
  );
const refuseQueries = (target, promised) => {
  for (const name of queries(target)) {
    target[name] = function tripwireQuery(subject, ...rest) {
      record({ kind: "dns", call: name, subject: String(subject) });
      const error = refusedLookup(String(subject));
      if (promised) return Promise.reject(error);
      const callback = rest.at(-1);
      if (typeof callback === "function") process.nextTick(() => callback(error));
      return undefined;
    };
  }
};
refuseQueries(dns, false);
refuseQueries(dns.Resolver.prototype, false);
refuseQueries(dns.promises, true);
refuseQueries(dns.promises.Resolver.prototype, true);

// UDP.
dgram.createSocket = function tripwireCreateSocket() {
  record({ kind: "dgram" });
  throw refusal("a UDP socket", "EACCES");
};

// Child processes.
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  child_process[name] = function tripwireChildProcess(file) {
    record({ kind: "child_process", call: name, file: String(file) });
    throw refusal(`child_process.${name}`, "EACCES");
  };
}

syncBuiltinESMExports();

// fetch.
let innerFetch = globalThis.fetch;
const tripwireFetch = async function tripwireFetch(input, init) {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  let url;
  try {
    url = new URL(href);
  } catch {}
  if (url === undefined || !loopback(url.hostname)) {
    record({ kind: "fetch", origin: url?.origin ?? String(href) });
    throw Object.assign(new TypeError(`pi-smart-router tests refused a fetch of ${url?.origin ?? href}`), {
      cause: refusedLookup(url?.hostname ?? String(href)),
    });
  }
  return innerFetch.call(this, input, init);
};
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  enumerable: true,
  get: () => tripwireFetch,
  set: (value) => {
    if (value !== tripwireFetch) innerFetch = value;
  },
});

// WebSocket.
const wrapWebSocket = (inner) =>
  inner === undefined
    ? undefined
    : new Proxy(inner, {
        construct(target, args, newTarget) {
          let url;
          try {
            url = new URL(String(args[0]));
          } catch {}
          if (url === undefined || !loopback(url.hostname)) {
            record({ kind: "websocket", origin: url?.origin ?? String(args[0]) });
            throw refusal(`a WebSocket to ${url?.origin ?? args[0]}`, "ECONNREFUSED");
          }
          return Reflect.construct(target, args, newTarget);
        },
      });
let tripwireWebSocket = wrapWebSocket(globalThis.WebSocket);
Object.defineProperty(globalThis, "WebSocket", {
  configurable: true,
  enumerable: false,
  get: () => tripwireWebSocket,
  set: (value) => {
    if (value !== tripwireWebSocket) tripwireWebSocket = wrapWebSocket(value);
  },
});
