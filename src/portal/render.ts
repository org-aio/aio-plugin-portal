/**
 * 由注册表生成两件产物：
 *   1) 反向代理按 Host 分流的映射片段；
 *   2) 内网解析器覆盖片段（只覆盖 lan=true 的登记项）。
 * 生成结果只依赖配置与注册表，随后按需 reload 服务。
 */
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {PortalSettings} from '../config/index.js';
import {aliasFqdn, readAliases} from './registry.js';

export type RenderResult = {aliases: number; files: string[]; resolver: string};

const writeLines = (path: string, lines: string[]): void => {
  writeFileSync(path, lines.length ? `${lines.join('\n')}\n` : '');
};

export function render(s: PortalSettings): RenderResult {
  const aliases = readAliases(s);
  const dir = s.portal.aliasesDir!;
  mkdirSync(dir, {recursive: true});

  const map: string[] = [];
  const scheme: string[] = [];
  const host: string[] = [];
  for (const item of aliases) {
    const name = aliasFqdn(s, item.alias);
    const target = `${item.host}:${item.port}`;
    map.push(`    ${name}  ${target};`);
    scheme.push(`    ${name}  ${item.scheme};`);
    host.push(`    ${name}  ${target};`);
  }
  const files = [
    join(dir, `${s.portal.mapPrefix}.map`),
    join(dir, `${s.portal.mapPrefix}.scheme`),
    join(dir, `${s.portal.mapPrefix}.host`),
  ];
  writeLines(files[0], map);
  writeLines(files[1], scheme);
  writeLines(files[2], host);

  const resolver = s.resolver.configFile!;
  mkdirSync(join(resolver, '..'), {recursive: true});
  const overrides =
    s.mode === 'none' || !s.lanIp
      ? []
      : aliases.filter(item => item.lan).map(item => `address=/${aliasFqdn(s, item.alias)}/${s.lanIp}`);
  const lines = [
    `# 由 aio-portal 生成，请勿手改；改 ${aliasFqdn(s, 'aio-portal')} 的注册表后执行 sync`,
    `port=${s.resolver.port}`,
    `listen-address=${s.lanIp || '127.0.0.1'}`,
    'bind-interfaces',
    'no-resolv',
    'no-hosts',
    'cache-size=1000',
    ...s.resolver.upstreams.map(up => `server=${up}`),
    ...overrides,
  ];
  writeFileSync(resolver, `${lines.join('\n')}\n`);
  return {aliases: aliases.length, files, resolver};
}

const run = (program: string, args: string[]): {code: number; out: string} => {
  try {
    const out = execFileSync(program, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    return {code: 0, out: out.trim()};
  } catch (error) {
    const err = error as {status?: number; stdout?: string; stderr?: string; message?: string};
    return {code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || (err.message ?? '')};
  }
};

/** 校验并热加载内网解析器；未安装 dnsmasq 或服务不存在时给出可读提示。 */
export function reloadResolver(s: PortalSettings): string {
  const binary = s.resolver.dnsmasqBinary ?? 'dnsmasq';
  const test = run(binary, ['--test', `--conf-file=${s.resolver.configFile}`]);
  if (test.code !== 0) return `解析配置校验失败：${test.out}`;
  if (s.resolver.service) {
    const reload = run('systemctl', ['reload-or-restart', s.resolver.service]);
    return reload.code === 0 ? '内网解析已刷新' : `内网解析刷新失败：${reload.out}`;
  }
  const reload = run(binary, [`--conf-file=${s.resolver.configFile}`]);
  return reload.code === 0 ? '内网解析已刷新' : `内网解析刷新失败：${reload.out}`;
}
