import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {readFileSync, existsSync} from 'node:fs';

/** 门户配置：所有宿主相关的值都来自此处，源码不写死域名、网段或部署目录。 */
export type ResolverConfig = {
  port: number;
  upstreams: string[];
  configFile?: string;
  service?: string;
  dnsmasqBinary?: string;
};

export type PortalConfig = {
  root: string;
  container?: string;
  aliasesDir?: string;
  mapPrefix: string;
  reload?: boolean;
};

export type GatewayConfig = {
  address?: string;
  adapter: 'xiaomi' | 'none';
  fallbackDns?: string;
};

export type PortalSettings = {
  suffix: string;
  mode: 'lan' | 'hosts' | 'none';
  lanIp?: string;
  hostsFile?: string;
  resolver: ResolverConfig;
  portal: PortalConfig;
  gateway: GatewayConfig;
};

export type Alias = {
  alias: string;
  host: string;
  port: number;
  scheme: 'http' | 'https';
  lan: boolean;
  note?: string;
};

export type Registry = {aliases: Alias[]};

const DEFAULTS = (): PortalSettings => ({
  suffix: '',
  mode: 'lan',
  lanIp: '',
  hostsFile: '/etc/hosts',
  resolver: {port: 53, upstreams: ['223.5.5.5', '114.114.114.114']},
  portal: {root: join(homedir(), '.config', 'aio-portal'), mapPrefix: '10-alias', reload: true},
  gateway: {adapter: 'xiaomi', fallbackDns: '223.5.5.5'},
});

/** 解析生效配置：命令行 > 环境变量 > 配置文件 > 内置中性默认值。 */
export function loadSettings(rootOverride?: string): PortalSettings {
  const base = DEFAULTS();
  const root = resolve(rootOverride ?? process.env.AIO_PORTAL_HOME ?? base.portal.root);
  base.portal.root = root;
  const configFile = join(root, 'aio-portal.json');
  let file: Partial<PortalSettings> = {};
  if (existsSync(configFile)) file = JSON.parse(readFileSync(configFile, 'utf8')) as Partial<PortalSettings>;
  const merged: PortalSettings = {
    ...base,
    ...file,
    resolver: {...base.resolver, ...file.resolver},
    portal: {...base.portal, ...file.portal, root},
    gateway: {...base.gateway, ...file.gateway},
  };
  if (!merged.suffix) throw new Error(`缺少域名后缀配置，请在 ${configFile} 中设置 suffix`);
  merged.portal.root = root;
  merged.resolver.configFile ??= join(root, 'dns', 'aio-portal.conf');
  merged.portal.aliasesDir ??= join(root, 'nginx', 'aliases.d');
  return merged;
}

export const registryFile = (s: PortalSettings) => join(s.portal.root, 'aliases.json');

export function loadRegistry(s: PortalSettings): Registry {
  const file = registryFile(s);
  if (!existsSync(file)) return {aliases: []};
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Registry;
  return {aliases: parsed.aliases ?? []};
}
