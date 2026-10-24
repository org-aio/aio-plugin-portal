/** 别名注册表：新增站点只改数据，不改代码。 */
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import type {Alias, PortalSettings, Registry} from '../config/index.js';
import {loadRegistry, registryFile} from '../config/index.js';

/**
 * 一条记录的完整域名 = `<alias>.<suffix>`；`suffix` 缺省回落到全局 settings.suffix。
 * 同一门户可以同时登记多个域（内网统一 lyokm.cn，aio/sub2api 仍在 addzero.site），
 * 因此所有拼接 fqdn 的地方都必须走这里，不能直接用 settings.suffix。
 */
export const suffixOf = (s: PortalSettings, item: Pick<Alias, 'suffix'>): string => item.suffix || s.suffix;

export const fqdnOf = (s: PortalSettings, item: Pick<Alias, 'alias' | 'suffix'>): string =>
  `${item.alias}.${suffixOf(s, item)}`;

export function writeRegistry(s: PortalSettings, registry: Registry): void {
  const file = registryFile(s);
  mkdirSync(dirname(file), {recursive: true, mode: 0o700});
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, {mode: 0o600});
  renameSync(tmp, file);
}

/** 读取注册表并保留原始内容；plan/sync 在未显式修改时不得改写别名与授权信息。 */
export function snapshot(s: PortalSettings): string | null {
  const file = registryFile(s);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

export function upsert(s: PortalSettings, entry: Alias): Registry {
  const registry = loadRegistry(s);
  const next = registry.aliases.filter(item => item.alias !== entry.alias);
  next.push(entry);
  next.sort((a, b) => a.alias.localeCompare(b.alias));
  const updated = {aliases: next};
  writeRegistry(s, updated);
  return updated;
}

export function remove(s: PortalSettings, alias: string): {registry: Registry; removed?: Alias} {
  const registry = loadRegistry(s);
  const removed = registry.aliases.find(item => item.alias === alias);
  const updated = {aliases: registry.aliases.filter(item => item.alias !== alias)};
  writeRegistry(s, updated);
  return {registry: updated, removed};
}

/** 兼容旧调用点：按全局后缀拼 fqdn（不带 suffix 覆盖的场合）。 */
export const aliasFqdn = (s: PortalSettings, alias: string): string => `${alias}.${s.suffix}`;

export function readAliases(s: PortalSettings): Alias[] {
  return loadRegistry(s).aliases.slice().sort((a, b) => a.alias.localeCompare(b.alias));
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}
