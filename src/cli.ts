#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {add, doctor, list, plan, query, removeAlias, setEnabled, sync, update, warden} from './portal/commands.js';

declare const PACKAGE_VERSION: string;

const USAGE = `aio-plugin-portal <命令> [选项]

命令:
  add <别名> --port <端口> [--host <主机>] [--scheme http|https] [--note <备注>] [--suffix <域>]
  add <别名> --port <端口> --visibility public --authorized-by <授权人>
  （public 必须显式授权；旧 --no-lan 只表示不做内网 DNS，不再自动算授权）
  update <别名> [--host|--port|--scheme|--note|--visibility|--authorized-by|--suffix]
  enable <别名> / disable <别名>     停用不删数据，恢复用 enable
  remove <别名>                      连带清理站点文件、解析与映射产物并反向校验
  list [--search <词>] [--visibility internal|public] [--sort alias|visibility|host|port]
       [--order asc|desc] [--page <n>] [--page-size <n>] [--json]
  plan
  sync [--apply]
  doctor
  warden [--password <网关密码>] [--apply] [--restore]

通用选项:
  --home <目录>    门户配置根目录（默认 AIO_PORTAL_HOME 或 ~/.config/aio-portal）
  --version        显示版本
  --help           显示帮助`;

async function main(): Promise<void> {
  const {values, positionals} = parseArgs({
    allowPositionals: true,
    options: {
      version: {type: 'boolean'},
      help: {type: 'boolean'},
      host: {type: 'string', default: '127.0.0.1'},
      port: {type: 'string'},
      scheme: {type: 'string', default: 'http'},
      note: {type: 'string'},
      lan: {type: 'boolean', default: true},
      'no-lan': {type: 'boolean', default: false},
      visibility: {type: 'string'},
      'authorized-by': {type: 'string'},
      home: {type: 'string'},
      password: {type: 'string'},
      apply: {type: 'boolean', default: false},
      restore: {type: 'boolean', default: false},
      suffix: {type: 'string'},
      search: {type: 'string'},
      sort: {type: 'string'},
      order: {type: 'string'},
      page: {type: 'string'},
      'page-size': {type: 'string'},
      json: {type: 'boolean', default: false},
    },
  });
  const [command, argument] = positionals;
  if (values.version) {
    console.log(PACKAGE_VERSION);
    return;
  }
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  switch (command) {
    case 'add': {
      if (!argument) throw new Error('add 需要别名');
      if (values.port === undefined) throw new Error('add 需要 --port');
      const visibility = values.visibility ?? (values['no-lan'] || !values.lan ? 'public' : 'internal');
      if (visibility !== 'internal' && visibility !== 'public') throw new Error('--visibility 只能是 internal 或 public');
      const authorizedBy = values['authorized-by'];
      console.log(add({alias: argument, host: values.host, port: values.port, scheme: values.scheme, note: values.note, visibility, authorizedBy, suffix: values.suffix, home: values.home}));
      return;
    }
    case 'update': {
      if (!argument) throw new Error('update 需要别名');
      console.log(update({alias: argument, host: values.host === '127.0.0.1' && !process.argv.includes('--host') ? undefined : values.host,
        port: values.port, scheme: process.argv.includes('--scheme') ? values.scheme : undefined,
        note: values.note, visibility: values.visibility, authorizedBy: values['authorized-by'], suffix: values.suffix, home: values.home}));
      return;
    }
    case 'enable':
    case 'disable': {
      if (!argument) throw new Error(`${command} 需要别名`);
      console.log(setEnabled({alias: argument, enabled: command === 'enable', home: values.home}));
      return;
    }
    case 'remove': {
      if (!argument) throw new Error('remove 需要别名');
      console.log(removeAlias({alias: argument, home: values.home}));
      return;
    }
    case 'list': {
      if (!values.search && !values.visibility && !values.sort && !values.order && !values.page && !values['page-size'] && !values.json) {
        console.log(list({home: values.home}));
        return;
      }
      const result = query({home: values.home, search: values.search,
        visibility: values.visibility as 'internal' | 'public' | undefined,
        sort: values.sort as 'alias' | 'visibility' | 'host' | 'port' | undefined,
        order: values.order as 'asc' | 'desc' | undefined,
        page: values.page ? Number(values.page) : undefined,
        pageSize: values['page-size'] ? Number(values['page-size']) : undefined});
      if (values.json) { console.log(JSON.stringify(result, null, 2)); return; }
      const width = Math.max(12, ...result.items.map(row => row.fqdn.length));
      console.log(`共 ${result.total} 条，第 ${result.page}/${result.pages} 页`);
      for (const row of result.items) {
        console.log(`  ${row.fqdn.padEnd(width)}  ${(row.scheme + '://' + row.host + ':' + row.port).padEnd(26)}  ${row.visibility.padEnd(9)}${row.disabled ? '[停用] ' : ''}${row.rendered ? '' : '[产物缺失] '}${row.note}`);
        }
      return;
    }
    case 'plan':
      console.log(await plan({home: values.home}));
      return;
    case 'sync':
      console.log(await sync({home: values.home, apply: values.apply}));
      return;
    case 'doctor':
      console.log(doctor({home: values.home}));
      return;
    case 'warden':
      console.log(await warden({password: values.password, apply: values.apply, restore: values.restore, home: values.home}));
      return;
    default:
      throw new Error(`未知命令：${command}\n\n${USAGE}`);
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
