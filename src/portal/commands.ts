/** 门户子命令实现：登记、同步、校验、体检、网关窗口。 */
import {existsSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Alias, PortalSettings} from '../config/index.js';
import {loadSettings} from '../config/index.js';
import {gatewayAdapter} from './gateway.js';
import {fqdnOf, remove, upsert, readAliases, snapshot, suffixOf} from './registry.js';
import {render, reloadResolver, validateCaddy, reloadCaddy} from './render.js';
import {reconcile, formatReport} from './reconcile.js';
import {captureArtifacts, removeCaddySite, restoreArtifacts, verifyGone} from './teardown.js';

const isAlias = (value: string) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
const isHost = (value: string) => /^[A-Za-z0-9_.:-]+$/.test(value);
const parsePort = (value: string) => {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`端口不合法：${value}`);
  return port;
};

const settings = (home?: string) => loadSettings(home);

/**
 * 全部产物的快照：注册表 + Caddy 站点目录 + 解析片段 + 映射目录。
 * 用于「改了就校验」失败时整体回滚，避免半完成状态留在磁盘上。
 */
type PortalSnapshot = {
  registry: string | null;
  sites: Map<string, string | null>;
  resolver: string | null;
  maps: Map<string, string | null>;
};

function snapshotAll(s: PortalSettings): PortalSnapshot {
  const sites = new Map<string, string | null>();
  const sitesDir = s.caddy?.sitesDir;
  if (sitesDir) {
    for (const name of existsSync(sitesDir) ? readdirSync(sitesDir) : []) {
      if (!name.startsWith(s.caddy?.prefix ?? 'portal-') || !name.endsWith('.caddy')) continue;
      const path = join(sitesDir, name);
      sites.set(path, readFileSync(path, 'utf8'));
    }
  }
  const maps = new Map<string, string | null>();
  const dir = s.portal.aliasesDir;
  if (dir) {
    for (const name of [`${s.portal.mapPrefix}.map`, `${s.portal.mapPrefix}.scheme`, `${s.portal.mapPrefix}.host`]) {
      const path = join(dir, name);
      if (existsSync(path)) maps.set(path, readFileSync(path, 'utf8'));
    }
  }
  const resolver = s.resolver.configFile;
  return {
    registry: snapshot(s),
    sites,
    maps,
    resolver: resolver && existsSync(resolver) ? readFileSync(resolver, 'utf8') : null,
  };
}

function restoreAll(s: PortalSettings, snap: PortalSnapshot): void {
  const regFile = join(s.portal.root, 'aliases.json');
  if (snap.registry === null) {
    if (existsSync(regFile)) rmSync(regFile);
  } else {
    writeFileSync(regFile, snap.registry, {mode: 0o600});
  }
  const sitesDir = s.caddy?.sitesDir;
  if (sitesDir && existsSync(sitesDir)) {
    for (const name of readdirSync(sitesDir)) {
      const path = join(sitesDir, name);
      if (snap.sites.has(path)) continue;
      if (name.startsWith(s.caddy?.prefix ?? 'portal-') && name.endsWith('.caddy')) rmSync(path);
    }
  }
  for (const [path, text] of snap.sites) if (text !== null) writeFileSync(path, text);
  for (const [path, text] of snap.maps) if (text !== null) writeFileSync(path, text);
  const resolver = s.resolver.configFile;
  if (resolver) {
    if (snap.resolver === null) {
      if (existsSync(resolver)) rmSync(resolver);
    } else {
      writeFileSync(resolver, snap.resolver);
    }
  }
}

/**
 * 注册表已改动的收尾：渲染产物 + 刷新解析器。
 * 任何一步失败都回滚到快照并抛错——调用方拿到异常时，磁盘上不会留下半完成状态。
 */
function finish(s: PortalSettings, snap: PortalSnapshot, message: string): string {
  try {
    const rendered = render(s);
    const reload = renderReload(s);
    if (/校验失败/.test(reload)) throw new Error(reload);
    return [message(rendered.aliases), reload].join('\n');
  } catch (error) {
    restoreAll(s, snap);
    throw new Error(`本次变更未生效，已回滚：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function add(options: {alias: string; host: string; port: string; scheme: string; note?: string; visibility: 'internal' | 'public'; authorizedBy?: string; suffix?: string; home?: string}): string {
  const s = settings(options.home);
  if (!isAlias(options.alias)) throw new Error('别名只能使用小写字母、数字和连字符');
  if (!isHost(options.host)) throw new Error('目标主机不合法');
  if (options.scheme !== 'http' && options.scheme !== 'https') throw new Error('协议只能是 http 或 https');
  if (options.visibility === 'public' && !options.authorizedBy) throw new Error('public 别名必须提供 --authorized-by，明确记录授权人');
  const entry: Alias = {
    alias: options.alias,
    host: options.host,
    port: parsePort(options.port),
    scheme: options.scheme,
    visibility: options.visibility,
    lan: options.visibility === 'internal' && s.mode !== 'none',
    authorizedBy: options.authorizedBy,
    note: options.note ?? '',
    ...(options.suffix ? {suffix: options.suffix} : {}),
  };
  if (entry.suffix && !/^[a-z0-9.-]+$/.test(entry.suffix)) throw new Error(`域名后缀不合法：${entry.suffix}`);
  const snap = snapshotAll(s);
  upsert(s, entry);
  return finish(s, snap, total =>
    `已登记 ${fqdnOf(s, entry)} -> ${entry.scheme}://${entry.host}:${entry.port}（${entry.visibility}，共 ${total} 条）`);
}

/**
 * 删除一条登记，并把它在三处产物里的痕迹一并清掉。
 *
 * 顺序：快照 → 删注册表 → 删站点文件 → 重写产物 → 反向校验。
 * 任何一步校验不过就把快照整体写回，恢复成删除前的样子并抛错，
 * 绝不留下「注册表没了、站点还在」的半删状态。
 */
export function removeAlias(options: {alias: string; home?: string}): string {
  const s = settings(options.home);
  const target = readAliases(s).find(item => item.alias === options.alias);
  if (!target) throw new Error(`未找到别名：${options.alias}`);
  const fqdn = fqdnOf(s, target);
  const before = captureArtifacts(s, options.alias);
  // 回滚/校验都以这条记录自己的 fqdn 为准（可能带单条 suffix 覆盖）。
  const registryBefore = snapshot(s);
  const result = remove(s, options.alias);
  const removedFiles = removeCaddySite(s, options.alias);
  try {
    const rendered = render(s);
    const verified = verifyGone(s, options.alias, target.suffix);
    const failed = verified.filter(item => !item.ok);
    if (failed.length) {
      throw new Error(`删除后仍存在残留：${failed.map(item => item.detail).join('；')}`);
    }
    return [
      `已删除 ${fqdn}（剩余 ${rendered.aliases} 条）`,
      `已清理：注册表 1 条、站点文件 ${removedFiles.length} 个、解析与映射产物已重写`,
      ...verified.map(item => `  校验 ${item.artifact}: ${item.detail}`),
      renderReload(s),
    ].join('\n');
  } catch (error) {
    restoreArtifacts(before);
    // 注册表也要回到删除前；否则会出现「记录没了、产物回来了」的逆向半删状态。
    if (registryBefore !== null) writeFileSync(join(s.portal.root, 'aliases.json'), registryBefore, {mode: 0o600});
    throw new Error(`删除 ${fqdn} 失败，已回滚到删除前状态：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function list(options: {home?: string}): string {
  const s = settings(options.home);
  const aliases = readAliases(s);
  if (!aliases.length) return '（空）';
  return aliases
    .map(item => `  ${fqdnOf(s, item).padEnd(30)} -> ${item.scheme}://${item.host}:${item.port}  ${item.visibility ?? 'internal'}${item.disabled ? ' [已停用]' : ''}  ${item.note ?? ''}`)
    .join('\n');
}

export async function sync(options: {home?: string; apply?: boolean}): Promise<string> {
  const s = settings(options.home);
  const before = snapshot(s);
  const result = render(s);
  const report = await reconcile(s, {apply: options.apply});
  const after = snapshot(s);
  if (before !== after) throw new Error('同步过程中注册表被其它进程修改，请重试');
  const lines = [
    `已生成 ${result.aliases} 条映射与 ${result.caddy.length} 个 Caddy 站点`,
    renderReload(s),
    validateCaddy(s),
    reloadCaddy(s),
    formatReport(report),
  ];
  if (!report.ok) {
    throw new Error(`${lines.join('\n')}\n同步被拒绝：存在未满足的 provider 计划或校验，未发布任何变更`);
  }
  return lines.join('\n');
}

export async function plan(options: {home?: string}): Promise<string> {
  const s = settings(options.home);
  return formatReport(await reconcile(s, {apply: false}));
}

function renderReload(s: PortalSettings): string {
  if (!s.portal.reload) return '已跳过服务热加载（portal.reload=false）';
  return reloadResolver(s);
}

export function doctor(options: {home?: string}): string {
  const s = settings(options.home);
  const resolved = existsSync(s.resolver.configFile!);
  const rendered = existsSync(`${s.portal.aliasesDir}/${s.portal.mapPrefix}.map`);
  const lines = [
    `  域名后缀        ${s.suffix}`,
    `  解析模式        ${s.mode}`,
    `  内网 IP         ${s.lanIp || '（未配置）'}`,
    `  注册表          ${readAliases(s).length} 条`,
    `  映射片段        ${rendered ? '已生成' : '缺失'}`,
    `  解析配置        ${resolved ? '已生成' : '缺失'}`,
    `  Caddy provider  ${s.providers?.connectivity ?? 'caddy'}  sites=${s.caddy?.sitesDir ?? '（未配置）'}  bind=${s.caddy?.bind ?? '（未配置）'}`,
    `  网关适配器      ${s.gateway.adapter}${s.gateway.address ? ` @ ${s.gateway.address}` : '（未配置地址）'}`,
  ];
  const internal = readAliases(s).filter(item => (item.visibility ?? 'internal') === 'internal');
  const guard = internal.every(item => Boolean(s.caddy?.bind) && Boolean(s.caddy?.allow?.length));
  if (!guard) lines.push('  内网防护        internal 别名缺少 caddy.bind 或 caddy.allow');
  const ok = rendered && resolved && Boolean(s.suffix) && Boolean(s.lanIp || s.mode !== 'lan') && guard;
  return [...lines, ok ? '体检通过' : '存在缺失项，请先执行 sync 或补齐配置'].join('\n');
}

export async function warden(options: {password?: string; apply?: boolean; restore?: boolean; home?: string}): Promise<string> {
  const s = settings(options.home);
  const target = s.lanIp || '本机内网 IP';
  if (!options.password) {
    return [
      '网关窗口：把网关上游 DNS 指向本机解析器，让局域网所有设备自动走内网。',
      `  网关适配器：${s.gateway.adapter}${s.gateway.address ? ` @ ${s.gateway.address}` : '（未配置 address）'}`,
      `  DNS1 目标：${target}     DNS2 兜底：${s.gateway.fallbackDns}`,
      '',
      '  aio-plugin-portal warden --password <网关密码>            # 只读探测',
      '  aio-plugin-portal warden --password <网关密码> --apply    # 写入',
      '  aio-plugin-portal warden --password <网关密码> --restore  # 回滚',
      '',
      '手动等价操作：网关管理页 → 上网设置 → DNS1 填本机 IP、DNS2 填公网解析器。',
    ].join('\n');
  }
  const adapter = gatewayAdapter(s.gateway, options.password);
  if (options.restore) {
    await adapter.restore();
    return '已恢复网关上游 DNS 为自动获取。';
  }
  const probe = await adapter.probe();
  const head = `网关适配器 ${probe.adapter}：当前 ${probe.wanType ?? '-'}，DNS ${probe.current.dns1 || '自动'} / ${probe.current.dns2 || '自动'}`;
  if (!options.apply) return [head, '只读探测完成，未做修改。确认后加 --apply 写入。'].join('\n');
  if (!s.lanIp) throw new Error('未配置内网 IP（lanIp），无法写入网关');
  await adapter.apply({dns1: s.lanIp, dns2: s.gateway.fallbackDns ?? '223.5.5.5'});
  return [head, `已把网关上游 DNS 设为 ${s.lanIp}（兜底 ${s.gateway.fallbackDns}）。局域网设备无需任何设置即自动走内网。`].join('\n');
}

/** 表格行：给页面/前端用的扁平结构，不含任何凭据。 */
export type PortalRow = {
  alias: string;
  fqdn: string;
  scheme: 'http' | 'https';
  host: string;
  port: number;
  visibility: 'internal' | 'public';
  disabled: boolean;
  note: string;
  authorizedBy?: string;
  /** 该行产物是否齐全（站点文件 + 解析覆盖都在）。 */
  rendered: boolean;
};

export type QueryOptions = {
  home?: string;
  /** 按别名、备注、目标主机做大小写不敏感的子串检索。 */
  search?: string;
  visibility?: 'internal' | 'public';
  disabled?: boolean;
  sort?: 'alias' | 'visibility' | 'host' | 'port';
  order?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
};

export type QueryResult = {items: PortalRow[]; total: number; page: number; pageSize: number; pages: number};

const rowOf = (s: PortalSettings, item: Alias): PortalRow => {
  const sitesDir = s.caddy?.sitesDir;
  const site = sitesDir ? join(sitesDir, `${s.caddy?.prefix ?? 'portal-'}${item.alias}.caddy`) : '';
  const resolver = s.resolver.configFile;
  const dnsOk = resolver && existsSync(resolver)
    ? new RegExp(`^address=/${fqdnOf(s, item).replace(/\./g, '\\.')}/`, 'm').test(readFileSync(resolver, 'utf8'))
    : false;
  return {
    alias: item.alias,
    fqdn: fqdnOf(s, item),
    scheme: item.scheme,
    host: item.host,
    port: item.port,
    visibility: item.visibility ?? 'internal',
    disabled: item.disabled === true,
    note: item.note ?? '',
    authorizedBy: item.authorizedBy,
    rendered: (item.disabled ? true : Boolean(site && existsSync(site))) && (item.disabled || item.visibility === 'public' ? true : dnsOk),
  };
};

/** 查询登记表：检索 → 过滤 → 排序 → 分页。页面表格直接消费这个结果。 */
export function query(options: QueryOptions = {}): QueryResult {
  const s = settings(options.home);
  const term = (options.search ?? '').trim().toLowerCase();
  let items = readAliases(s).map(item => rowOf(s, item));
  if (term) {
    items = items.filter(row =>
      [row.alias, row.fqdn, row.host, row.note].some(value => value.toLowerCase().includes(term)));
  }
  if (options.visibility) items = items.filter(row => row.visibility === options.visibility);
  if (options.disabled !== undefined) items = items.filter(row => row.disabled === options.disabled);
  const key = options.sort ?? 'alias';
  const direction = options.order === 'desc' ? -1 : 1;
  items.sort((a, b) => {
    const left = key === 'port' ? a.port : String(a[key]);
    const right = key === 'port' ? b.port : String(b[key]);
    return left < right ? -direction : left > right ? direction : 0;
  });
  const pageSize = Math.max(1, options.pageSize ?? 50);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(Math.max(1, options.page ?? 1), pages);
  return {items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize, pages};
}

/** 修改现有登记。未给出的字段保持原值，避免整行覆盖丢掉 authorizedBy 等审计字段。 */
export function update(options: {
  alias: string;
  home?: string;
  host?: string;
  port?: string;
  scheme?: string;
  note?: string;
  visibility?: string;
  authorizedBy?: string;
  suffix?: string;
}): string {
  const s = settings(options.home);
  const existing = readAliases(s).find(item => item.alias === options.alias);
  if (!existing) throw new Error(`未找到别名：${options.alias}`);
  const visibility = (options.visibility ?? existing.visibility ?? 'internal') as 'internal' | 'public';
  if (visibility !== 'internal' && visibility !== 'public') throw new Error('visibility 只能是 internal 或 public');
  if (options.scheme && options.scheme !== 'http' && options.scheme !== 'https') throw new Error('协议只能是 http 或 https');
  const host = options.host ?? existing.host;
  if (!isHost(host)) throw new Error('目标主机不合法');
  const next: Alias = {
    ...existing,
    host,
    port: options.port === undefined ? existing.port : parsePort(options.port),
    scheme: (options.scheme ?? existing.scheme) as 'http' | 'https',
    note: options.note ?? existing.note ?? '',
    visibility,
    lan: visibility === 'internal',
    authorizedBy: options.authorizedBy ?? existing.authorizedBy,
  };
  if (options.suffix !== undefined) {
    if (options.suffix && !/^[a-z0-9.-]+$/.test(options.suffix)) throw new Error(`域名后缀不合法：${options.suffix}`);
    if (options.suffix) next.suffix = options.suffix; else delete next.suffix;
  }
  if (visibility === 'public' && !next.authorizedBy) throw new Error('public 别名必须保留或重新提供授权人（authorizedBy）');
  const snap = snapshotAll(s);
  upsert(s, next);
  return finish(s, snap, total =>
    `已更新 ${fqdnOf(s, next)} -> ${next.scheme}://${next.host}:${next.port}（${next.visibility}，共 ${total} 条）`);
}

/** 启停：停用不删数据，只是不再产出站点/解析，便于临时下线后恢复。 */
export function setEnabled(options: {alias: string; enabled: boolean; home?: string}): string {
  const s = settings(options.home);
  const existing = readAliases(s).find(item => item.alias === options.alias);
  if (!existing) throw new Error(`未找到别名：${options.alias}`);
  const snap = snapshotAll(s);
  upsert(s, {...existing, disabled: !options.enabled});
  return finish(s, snap, total =>
    `${options.enabled ? '已启用' : '已停用'} ${fqdnOf(s, existing)}（参与渲染 ${total} 条）`);
}

export {suffixOf};
