#!/usr/bin/env node

// src/cli.ts
import { parseArgs } from "node:util";

// src/portal/commands.ts
import { existsSync as existsSync3 } from "node:fs";

// src/config/index.ts
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
var DEFAULTS = () => ({
  suffix: "",
  mode: "lan",
  lanIp: "",
  hostsFile: "/etc/hosts",
  resolver: { port: 53, upstreams: ["223.5.5.5", "114.114.114.114"] },
  portal: { root: join(homedir(), ".config", "aio-portal"), mapPrefix: "10-alias", reload: true },
  gateway: { adapter: "xiaomi", fallbackDns: "223.5.5.5" }
});
function loadSettings(rootOverride) {
  const base = DEFAULTS();
  const root = resolve(rootOverride ?? process.env.AIO_PORTAL_HOME ?? base.portal.root);
  base.portal.root = root;
  const configFile = join(root, "aio-portal.json");
  let file = {};
  if (existsSync(configFile)) file = JSON.parse(readFileSync(configFile, "utf8"));
  const merged = {
    ...base,
    ...file,
    resolver: { ...base.resolver, ...file.resolver },
    portal: { ...base.portal, ...file.portal, root },
    gateway: { ...base.gateway, ...file.gateway }
  };
  if (!merged.suffix) throw new Error(`\u7F3A\u5C11\u57DF\u540D\u540E\u7F00\u914D\u7F6E\uFF0C\u8BF7\u5728 ${configFile} \u4E2D\u8BBE\u7F6E suffix`);
  merged.portal.root = root;
  merged.resolver.configFile ??= join(root, "dns", "aio-portal.conf");
  merged.portal.aliasesDir ??= join(root, "nginx", "aliases.d");
  return merged;
}
var registryFile = (s) => join(s.portal.root, "aliases.json");
function loadRegistry(s) {
  const file = registryFile(s);
  if (!existsSync(file)) return { aliases: [] };
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return { aliases: parsed.aliases ?? [] };
}

// src/portal/gateway.ts
import { createHash } from "node:crypto";
var Http = class {
  constructor(origin, password) {
    this.origin = origin;
    this.password = password;
  }
  origin;
  password;
  async call(path, options = {}) {
    const body = options.form ? new URLSearchParams(options.form).toString() : void 0;
    const headers = { referer: `${this.origin}/`, "user-agent": "Mozilla/5.0" };
    if (body) headers["content-type"] = "application/x-www-form-urlencoded";
    const response = await fetch(`${this.origin}${path}`, {
      method: options.method ?? "GET",
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 12e3)
    });
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`\u7F51\u5173\u8FD4\u56DE\u975E JSON \u54CD\u5E94\uFF08HTTP ${response.status}\uFF09\uFF1A${text.slice(0, 120)}`);
    }
  }
  /** 先明文登录；部分固件需要 nonce + SHA1 流程。 */
  async login() {
    const plain = await this.call("/cgi-bin/luci/api/xqsystem/login", {
      method: "POST",
      form: { username: "admin", logtype: "2", password: this.password }
    });
    const token = plain.token ?? plain.stok;
    if (plain.code === 0 && token) return token;
    const first = await this.call("/cgi-bin/luci/api/xqsystem/login");
    const nonce = first.nonce;
    if (nonce) {
      const pw = createHash("sha1").update(this.password).digest("hex");
      const key = createHash("sha1").update(nonce + pw).digest("hex");
      const second = await this.call("/cgi-bin/luci/api/xqsystem/login", {
        method: "POST",
        form: { username: "admin", logtype: "2", nonce, password: key }
      });
      const token2 = second.token ?? second.stok;
      if (second.code === 0 && token2) return token2;
      throw new Error(`\u7F51\u5173\u767B\u5F55\u5931\u8D25\uFF1A${String(second.msg ?? second)}`);
    }
    throw new Error(`\u7F51\u5173\u767B\u5F55\u5931\u8D25\uFF1A${String(plain.msg ?? plain)}`);
  }
};
var XiaomiGateway = class {
  constructor(address, password) {
    this.address = address;
    this.http = new Http(`http://${address}`, password);
  }
  address;
  name = "xiaomi";
  http;
  async api(token, path, form) {
    return await this.http.call(`/cgi-bin/luci/;stok=${token}/api/${path}`, form ? { method: "POST", form } : {});
  }
  async probe() {
    const token = await this.http.login();
    const info = await this.api(token, "xqnetwork/wan_info");
    const root = info.info ?? {};
    const details = root.details ?? {};
    if (!("dnsAddrs" in root)) throw new Error("\u8BE5\u56FA\u4EF6\u7684\u4E0A\u7F51\u8BBE\u7F6E\u672A\u66B4\u9732 DNS \u5B57\u6BB5\uFF0C\u8BF7\u6539\u7528\u5BA2\u6237\u7AEF\u65B9\u5F0F");
    return {
      adapter: this.name,
      wanType: details.wanType,
      current: { dns1: root.dnsAddrs ?? "", dns2: root.dnsAddrs1 ?? "" },
      detail: { username: details.username, mru: details.mru }
    };
  }
  async submit(token, dns, current) {
    const form = {
      wanType: "pppoe",
      pppoeName: String(current.username ?? ""),
      pppoePwd: String(current.password ?? ""),
      autoset: "0",
      mtu: String(current.mru ?? "1480"),
      service: String(current.service ?? ""),
      dns1: dns.dns1,
      dns2: dns.dns2
    };
    const result = await this.api(token, "xqnetwork/set_wan", form);
    if (result.code !== 0) throw new Error(`\u7F51\u5173\u5199\u5165\u5931\u8D25\uFF1A${result.msg ?? JSON.stringify(result)}`);
  }
  async apply(dns) {
    const token = await this.http.login();
    const info = await this.api(token, "xqnetwork/wan_info");
    await this.submit(token, dns, (info.info ?? {}).details ?? {});
  }
  async restore() {
    const token = await this.http.login();
    await this.submit(token, { dns1: "", dns2: "" }, {});
  }
};
function gatewayAdapter(config, password) {
  if (config.adapter === "none" || !config.address) throw new Error("\u672A\u914D\u7F6E\u7F51\u5173\u5730\u5740\u6216\u5DF2\u7981\u7528\u7F51\u5173\u9002\u914D\u5668");
  if (config.adapter === "xiaomi") return new XiaomiGateway(config.address, password);
  throw new Error(`\u4E0D\u652F\u6301\u7684\u7F51\u5173\u9002\u914D\u5668\uFF1A${config.adapter}`);
}

// src/portal/registry.ts
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
var fqdn = (s, alias) => `${alias}.${s.suffix}`;
function writeRegistry(s, registry) {
  const file = registryFile(s);
  mkdirSync(dirname(file), { recursive: true, mode: 448 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}
`, { mode: 384 });
  renameSync(tmp, file);
}
function upsert(s, entry) {
  const registry = loadRegistry(s);
  const next = registry.aliases.filter((item) => item.alias !== entry.alias);
  next.push(entry);
  next.sort((a, b) => a.alias.localeCompare(b.alias));
  const updated = { aliases: next };
  writeRegistry(s, updated);
  return updated;
}
function remove(s, alias) {
  const registry = loadRegistry(s);
  const removed = registry.aliases.find((item) => item.alias === alias);
  const updated = { aliases: registry.aliases.filter((item) => item.alias !== alias) };
  writeRegistry(s, updated);
  return { registry: updated, removed };
}
var aliasFqdn = fqdn;
function readAliases(s) {
  return loadRegistry(s).aliases.slice().sort((a, b) => a.alias.localeCompare(b.alias));
}

// src/portal/render.ts
import { execFileSync } from "node:child_process";
import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
var writeLines = (path, lines) => {
  writeFileSync2(path, lines.length ? `${lines.join("\n")}
` : "");
};
function render(s) {
  const aliases = readAliases(s);
  const dir = s.portal.aliasesDir;
  mkdirSync2(dir, { recursive: true });
  const map = [];
  const scheme = [];
  const host = [];
  for (const item of aliases) {
    const name = aliasFqdn(s, item.alias);
    const target = `${item.host}:${item.port}`;
    map.push(`    ${name}  ${target};`);
    scheme.push(`    ${name}  ${item.scheme};`);
    host.push(`    ${name}  ${target};`);
  }
  const files = [
    join2(dir, `${s.portal.mapPrefix}.map`),
    join2(dir, `${s.portal.mapPrefix}.scheme`),
    join2(dir, `${s.portal.mapPrefix}.host`)
  ];
  writeLines(files[0], map);
  writeLines(files[1], scheme);
  writeLines(files[2], host);
  const resolver = s.resolver.configFile;
  mkdirSync2(join2(resolver, ".."), { recursive: true });
  const overrides = s.mode === "none" || !s.lanIp ? [] : aliases.filter((item) => item.lan).map((item) => `address=/${aliasFqdn(s, item.alias)}/${s.lanIp}`);
  const lines = [
    `# \u7531 aio-portal \u751F\u6210\uFF0C\u8BF7\u52FF\u624B\u6539\uFF1B\u6539 ${aliasFqdn(s, "aio-portal")} \u7684\u6CE8\u518C\u8868\u540E\u6267\u884C sync`,
    `port=${s.resolver.port}`,
    `listen-address=${s.lanIp || "127.0.0.1"}`,
    "bind-interfaces",
    "no-resolv",
    "no-hosts",
    "cache-size=1000",
    ...s.resolver.upstreams.map((up) => `server=${up}`),
    ...overrides
  ];
  writeFileSync2(resolver, `${lines.join("\n")}
`);
  return { aliases: aliases.length, files, resolver };
}
var run = (program, args) => {
  try {
    const out = execFileSync(program, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out: out.trim() };
  } catch (error) {
    const err = error;
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || (err.message ?? "") };
  }
};
function reloadResolver(s) {
  const binary = s.resolver.dnsmasqBinary ?? "dnsmasq";
  const test = run(binary, ["--test", `--conf-file=${s.resolver.configFile}`]);
  if (test.code !== 0) return `\u89E3\u6790\u914D\u7F6E\u6821\u9A8C\u5931\u8D25\uFF1A${test.out}`;
  if (s.resolver.service) {
    const reload2 = run("systemctl", ["reload-or-restart", s.resolver.service]);
    return reload2.code === 0 ? "\u5185\u7F51\u89E3\u6790\u5DF2\u5237\u65B0" : `\u5185\u7F51\u89E3\u6790\u5237\u65B0\u5931\u8D25\uFF1A${reload2.out}`;
  }
  const reload = run(binary, [`--conf-file=${s.resolver.configFile}`]);
  return reload.code === 0 ? "\u5185\u7F51\u89E3\u6790\u5DF2\u5237\u65B0" : `\u5185\u7F51\u89E3\u6790\u5237\u65B0\u5931\u8D25\uFF1A${reload.out}`;
}

// src/portal/commands.ts
var isAlias = (value) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
var isHost = (value) => /^[A-Za-z0-9_.:-]+$/.test(value);
var parsePort = (value) => {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`\u7AEF\u53E3\u4E0D\u5408\u6CD5\uFF1A${value}`);
  return port;
};
var settings = (home) => loadSettings(home);
function add(options) {
  const s = settings(options.home);
  if (!isAlias(options.alias)) throw new Error("\u522B\u540D\u53EA\u80FD\u4F7F\u7528\u5C0F\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u548C\u8FDE\u5B57\u7B26");
  if (!isHost(options.host)) throw new Error("\u76EE\u6807\u4E3B\u673A\u4E0D\u5408\u6CD5");
  if (options.scheme !== "http" && options.scheme !== "https") throw new Error("\u534F\u8BAE\u53EA\u80FD\u662F http \u6216 https");
  const entry = {
    alias: options.alias,
    host: options.host,
    port: parsePort(options.port),
    scheme: options.scheme,
    lan: options.lan && s.mode !== "none",
    note: options.note ?? ""
  };
  const registry = upsert(s, entry);
  const result = render(s);
  return [
    `\u5DF2\u767B\u8BB0 ${aliasFqdn(s, entry.alias)} -> ${entry.scheme}://${entry.host}:${entry.port}\uFF08\u5171 ${result.aliases} \u6761\uFF09`,
    renderReload(s)
  ].join("\n");
}
function removeAlias(options) {
  const s = settings(options.home);
  const result = remove(s, options.alias);
  if (!result.removed) throw new Error(`\u672A\u627E\u5230\u522B\u540D\uFF1A${options.alias}`);
  const rendered = render(s);
  return [`\u5DF2\u5220\u9664 ${aliasFqdn(s, options.alias)}\uFF08\u5269\u4F59 ${rendered.aliases} \u6761\uFF09`, renderReload(s)].join("\n");
}
function list(options) {
  const s = settings(options.home);
  const aliases = readAliases(s);
  if (!aliases.length) return "\uFF08\u7A7A\uFF09";
  return aliases.map((item) => `  ${aliasFqdn(s, item.alias).padEnd(30)} -> ${item.scheme}://${item.host}:${item.port}  \u5185\u7F51:${item.lan ? "\u5F00" : "\u5173"}  ${item.note ?? ""}`).join("\n");
}
function sync(options) {
  const s = settings(options.home);
  const result = render(s);
  return [`\u5DF2\u751F\u6210 ${result.aliases} \u6761\u6620\u5C04`, renderReload(s)].join("\n");
}
function renderReload(s) {
  if (!s.portal.reload) return "\u5DF2\u8DF3\u8FC7\u670D\u52A1\u70ED\u52A0\u8F7D\uFF08portal.reload=false\uFF09";
  return reloadResolver(s);
}
function doctor(options) {
  const s = settings(options.home);
  const resolved = existsSync3(s.resolver.configFile);
  const rendered = existsSync3(`${s.portal.aliasesDir}/${s.portal.mapPrefix}.map`);
  const lines = [
    `  \u57DF\u540D\u540E\u7F00        ${s.suffix}`,
    `  \u89E3\u6790\u6A21\u5F0F        ${s.mode}`,
    `  \u5185\u7F51 IP         ${s.lanIp || "\uFF08\u672A\u914D\u7F6E\uFF09"}`,
    `  \u6CE8\u518C\u8868          ${readAliases(s).length} \u6761`,
    `  \u6620\u5C04\u7247\u6BB5        ${rendered ? "\u5DF2\u751F\u6210" : "\u7F3A\u5931"}`,
    `  \u89E3\u6790\u914D\u7F6E        ${resolved ? "\u5DF2\u751F\u6210" : "\u7F3A\u5931"}`,
    `  \u7F51\u5173\u9002\u914D\u5668      ${s.gateway.adapter}${s.gateway.address ? ` @ ${s.gateway.address}` : "\uFF08\u672A\u914D\u7F6E\u5730\u5740\uFF09"}`
  ];
  const ok = rendered && resolved && Boolean(s.suffix) && Boolean(s.lanIp || s.mode !== "lan");
  return [...lines, ok ? "\u4F53\u68C0\u901A\u8FC7" : "\u5B58\u5728\u7F3A\u5931\u9879\uFF0C\u8BF7\u5148\u6267\u884C sync \u6216\u8865\u9F50\u914D\u7F6E"].join("\n");
}
async function warden(options) {
  const s = settings(options.home);
  const target = s.lanIp || "\u672C\u673A\u5185\u7F51 IP";
  if (!options.password) {
    return [
      "\u7F51\u5173\u7A97\u53E3\uFF1A\u628A\u7F51\u5173\u4E0A\u6E38 DNS \u6307\u5411\u672C\u673A\u89E3\u6790\u5668\uFF0C\u8BA9\u5C40\u57DF\u7F51\u6240\u6709\u8BBE\u5907\u81EA\u52A8\u8D70\u5185\u7F51\u3002",
      `  \u7F51\u5173\u9002\u914D\u5668\uFF1A${s.gateway.adapter}${s.gateway.address ? ` @ ${s.gateway.address}` : "\uFF08\u672A\u914D\u7F6E address\uFF09"}`,
      `  DNS1 \u76EE\u6807\uFF1A${target}     DNS2 \u515C\u5E95\uFF1A${s.gateway.fallbackDns}`,
      "",
      "  aio-plugin-portal warden --password <\u7F51\u5173\u5BC6\u7801>            # \u53EA\u8BFB\u63A2\u6D4B",
      "  aio-plugin-portal warden --password <\u7F51\u5173\u5BC6\u7801> --apply    # \u5199\u5165",
      "  aio-plugin-portal warden --password <\u7F51\u5173\u5BC6\u7801> --restore  # \u56DE\u6EDA",
      "",
      "\u624B\u52A8\u7B49\u4EF7\u64CD\u4F5C\uFF1A\u7F51\u5173\u7BA1\u7406\u9875 \u2192 \u4E0A\u7F51\u8BBE\u7F6E \u2192 DNS1 \u586B\u672C\u673A IP\u3001DNS2 \u586B\u516C\u7F51\u89E3\u6790\u5668\u3002"
    ].join("\n");
  }
  const adapter = gatewayAdapter(s.gateway, options.password);
  if (options.restore) {
    await adapter.restore();
    return "\u5DF2\u6062\u590D\u7F51\u5173\u4E0A\u6E38 DNS \u4E3A\u81EA\u52A8\u83B7\u53D6\u3002";
  }
  const probe = await adapter.probe();
  const head = `\u7F51\u5173\u9002\u914D\u5668 ${probe.adapter}\uFF1A\u5F53\u524D ${probe.wanType ?? "-"}\uFF0CDNS ${probe.current.dns1 || "\u81EA\u52A8"} / ${probe.current.dns2 || "\u81EA\u52A8"}`;
  if (!options.apply) return [head, "\u53EA\u8BFB\u63A2\u6D4B\u5B8C\u6210\uFF0C\u672A\u505A\u4FEE\u6539\u3002\u786E\u8BA4\u540E\u52A0 --apply \u5199\u5165\u3002"].join("\n");
  if (!s.lanIp) throw new Error("\u672A\u914D\u7F6E\u5185\u7F51 IP\uFF08lanIp\uFF09\uFF0C\u65E0\u6CD5\u5199\u5165\u7F51\u5173");
  await adapter.apply({ dns1: s.lanIp, dns2: s.gateway.fallbackDns ?? "223.5.5.5" });
  return [head, `\u5DF2\u628A\u7F51\u5173\u4E0A\u6E38 DNS \u8BBE\u4E3A ${s.lanIp}\uFF08\u515C\u5E95 ${s.gateway.fallbackDns}\uFF09\u3002\u5C40\u57DF\u7F51\u8BBE\u5907\u65E0\u9700\u4EFB\u4F55\u8BBE\u7F6E\u5373\u81EA\u52A8\u8D70\u5185\u7F51\u3002`].join("\n");
}

// src/cli.ts
var USAGE = `aio-plugin-portal <\u547D\u4EE4> [\u9009\u9879]

\u547D\u4EE4:
  add <\u522B\u540D> --port <\u7AEF\u53E3> [--host <\u4E3B\u673A>] [--scheme http|https] [--note <\u5907\u6CE8>] [--no-lan]
  remove <\u522B\u540D>
  list
  sync
  doctor
  warden [--password <\u7F51\u5173\u5BC6\u7801>] [--apply] [--restore]

\u901A\u7528\u9009\u9879:
  --home <\u76EE\u5F55>    \u95E8\u6237\u914D\u7F6E\u6839\u76EE\u5F55\uFF08\u9ED8\u8BA4 AIO_PORTAL_HOME \u6216 ~/.config/aio-portal\uFF09
  --version        \u663E\u793A\u7248\u672C
  --help           \u663E\u793A\u5E2E\u52A9`;
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      version: { type: "boolean" },
      help: { type: "boolean" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string" },
      scheme: { type: "string", default: "http" },
      note: { type: "string" },
      lan: { type: "boolean", default: true },
      "no-lan": { type: "boolean", default: false },
      home: { type: "string" },
      password: { type: "string" },
      apply: { type: "boolean", default: false },
      restore: { type: "boolean", default: false }
    }
  });
  const [command, argument] = positionals;
  if (values.version) {
    console.log("0.1.0");
    return;
  }
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  switch (command) {
    case "add": {
      if (!argument) throw new Error("add \u9700\u8981\u522B\u540D");
      if (values.port === void 0) throw new Error("add \u9700\u8981 --port");
      const lan = values.lan && !values["no-lan"];
      console.log(add({ alias: argument, host: values.host, port: values.port, scheme: values.scheme, note: values.note, lan, home: values.home }));
      return;
    }
    case "remove": {
      if (!argument) throw new Error("remove \u9700\u8981\u522B\u540D");
      console.log(removeAlias({ alias: argument, home: values.home }));
      return;
    }
    case "list":
      console.log(list({ home: values.home }));
      return;
    case "sync":
      console.log(sync({ home: values.home }));
      return;
    case "doctor":
      console.log(doctor({ home: values.home }));
      return;
    case "warden":
      console.log(await warden({ password: values.password, apply: values.apply, restore: values.restore, home: values.home }));
      return;
    default:
      throw new Error(`\u672A\u77E5\u547D\u4EE4\uFF1A${command}

${USAGE}`);
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
