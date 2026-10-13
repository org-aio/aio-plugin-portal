import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const cli = (env, ...args) =>
  execFileSync(process.execPath, ['dist/cli.mjs', ...args], {encoding: 'utf8', env: {...process.env, ...env}}).trim();

const home = () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-'));
  writeFileSync(
    join(dir, 'aio-portal.json'),
    JSON.stringify({
      suffix: 'example.test',
      mode: 'lan',
      lanIp: '10.0.0.1',
      resolver: {port: 5353, upstreams: ['1.1.1.1'], service: ''},
      portal: {mapPrefix: '10-alias', reload: false},
      gateway: {adapter: 'none'},
    }),
  );
  return dir;
};

test('版本取自打包版本', () => {
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  assert.equal(cli({}, '--version'), version);
});

test('登记生成分流映射与内网解析覆盖', () => {
  const dir = home();
  const out = cli({AIO_PORTAL_HOME: dir}, 'add', 'demo', '--port', '8080', '--host', '10.0.0.9', '--no-lan');
  assert.match(out, /已登记 demo\.example\.test/);
  const map = readFileSync(join(dir, 'nginx', 'aliases.d', '10-alias.map'), 'utf8');
  assert.match(map, /demo\.example\.test\s+10\.0\.0\.9:8080/);
  const conf = readFileSync(join(dir, 'dns', 'aio-portal.conf'), 'utf8');
  assert.match(conf, /port=5353/);
  assert.match(conf, /server=1\.1\.1\.1/);
  assert.doesNotMatch(conf, /demo\.example\.test/, '--no-lan 不应写入内网覆盖');
});

test('默认 lan 会写入内网解析，remove 后清理', () => {
  const dir = home();
  cli({AIO_PORTAL_HOME: dir}, 'add', 'tc', '--port', '8111');
  assert.match(readFileSync(join(dir, 'dns', 'aio-portal.conf'), 'utf8'), /address=\/tc\.example\.test\/10\.0\.0\.1/);
  cli({AIO_PORTAL_HOME: dir}, 'remove', 'tc');
  assert.doesNotMatch(readFileSync(join(dir, 'dns', 'aio-portal.conf'), 'utf8'), /tc\.example\.test/);
});

test('缺少后缀配置时给出明确错误', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-'));
  assert.throws(() => cli({AIO_PORTAL_HOME: dir}, 'list'), /缺少域名后缀配置/);
  assert.ok(existsSync(join(dir)));
});
