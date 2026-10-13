/** 别名注册表：新增站点只改数据，不改代码。 */
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import type {Alias, PortalSettings, Registry} from '../config/index.js';
import {loadRegistry, registryFile} from '../config/index.js';

const fqdn = (s: PortalSettings, alias: string) => `${alias}.${s.suffix}`;

export function writeRegistry(s: PortalSettings, registry: Registry): void {
  const file = registryFile(s);
  mkdirSync(dirname(file), {recursive: true, mode: 0o700});
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, {mode: 0o600});
  renameSync(tmp, file);
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

export const aliasFqdn = fqdn;

export function readAliases(s: PortalSettings): Alias[] {
  return loadRegistry(s).aliases.slice().sort((a, b) => a.alias.localeCompare(b.alias));
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}
