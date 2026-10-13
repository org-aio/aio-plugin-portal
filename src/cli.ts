#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {add, doctor, list, removeAlias, sync, warden} from './portal/commands.js';

declare const PACKAGE_VERSION: string;

const USAGE = `aio-plugin-portal <命令> [选项]

命令:
  add <别名> --port <端口> [--host <主机>] [--scheme http|https] [--note <备注>] [--no-lan]
  remove <别名>
  list
  sync
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
      home: {type: 'string'},
      password: {type: 'string'},
      apply: {type: 'boolean', default: false},
      restore: {type: 'boolean', default: false},
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
      const lan = values.lan && !values['no-lan'];
      console.log(add({alias: argument, host: values.host, port: values.port, scheme: values.scheme, note: values.note, lan, home: values.home}));
      return;
    }
    case 'remove': {
      if (!argument) throw new Error('remove 需要别名');
      console.log(removeAlias({alias: argument, home: values.home}));
      return;
    }
    case 'list':
      console.log(list({home: values.home}));
      return;
    case 'sync':
      console.log(sync({home: values.home}));
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
