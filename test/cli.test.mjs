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
  const out = cli({AIO_PORTAL_HOME: dir}, 'add', 'demo', '--port', '8080', '--host', '10.0.0.9', '--visibility', 'public', '--authorized-by', 'tester');
  assert.match(out, /已登记 demo\.example\.test/);
  assert.match(out, /public/);
  const map = readFileSync(join(dir, 'nginx', 'aliases.d', '10-alias.map'), 'utf8');
  assert.match(map, /demo\.example\.test\s+10\.0\.0\.9:8080/);
  const conf = readFileSync(join(dir, 'dns', 'aio-portal.conf'), 'utf8');
  assert.match(conf, /port=5353/);
  assert.match(conf, /server=1\.1\.1\.1/);
  assert.doesNotMatch(conf, /demo\.example\.test/, 'public 不应写入内网覆盖');
});

test('默认 lan 会写入内网解析，remove 后清理', () => {
  const dir = home();
  cli({AIO_PORTAL_HOME: dir}, 'add', 'tc', '--port', '8111');
  assert.match(readFileSync(join(dir, 'dns', 'aio-portal.conf'), 'utf8'), /address=\/tc\.example\.test\/10\.0\.0\.1/);
  cli({AIO_PORTAL_HOME: dir}, 'remove', 'tc');
  assert.doesNotMatch(readFileSync(join(dir, 'dns', 'aio-portal.conf'), 'utf8'), /tc\.example\.test/);
});

test('internal 默认生成带 bind 与来源白名单的 Caddy 站点', () => {
  const dir = home();
  writeFileSync(join(dir, 'aio-portal.json'), JSON.stringify({
    suffix: 'example.test', mode: 'lan', lanIp: '10.0.0.1',
    resolver: {port: 5353, upstreams: ['1.1.1.1'], service: ''},
    portal: {mapPrefix: '10-alias', reload: false},
    gateway: {adapter: 'none'},
    caddy: {sitesDir: join(dir, 'caddy', 'sites'), bind: '10.0.0.1', allow: ['10.0.0.0/24', '127.0.0.1/32'], denyStatus: 404},
  }));
  cli({AIO_PORTAL_HOME: dir}, 'add', 'demo', '--port', '8080');
  const site = readFileSync(join(dir, 'caddy', 'sites', 'portal-demo.caddy'), 'utf8');
  assert.match(site, /bind 10\.0\.0\.1/);
  assert.match(site, /remote_ip 10\.0\.0\.0\/24 127\.0\.0\.1\/32/);
  assert.match(site, /respond 404/);
  assert.match(readFileSync(join(dir, 'dns', 'aio-portal.conf'), 'utf8'), /demo\.example\.test/);
});

test('internal 缺少 bind 时拒绝执行 sync', () => {
  const dir = home();
  writeFileSync(join(dir, 'aio-portal.json'), JSON.stringify({
    suffix: 'example.test', mode: 'lan', lanIp: '10.0.0.1',
    resolver: {port: 5353, upstreams: ['1.1.1.1'], service: ''},
    portal: {mapPrefix: '10-alias', reload: false}, gateway: {adapter: 'none'},
    caddy: {sitesDir: join(dir, 'caddy', 'sites')},
  }));
  cli({AIO_PORTAL_HOME: dir}, 'add', 'demo', '--port', '8080');
  assert.throws(() => cli({AIO_PORTAL_HOME: dir}, 'sync'), /同步被拒绝|计划未通过安全检查|缺少 bind/);
});

test('public 需要显式授权人，且不会写内网 DNS', () => {
  const dir = home();
  assert.throws(() => cli({AIO_PORTAL_HOME: dir}, 'add', 'pub', '--port', '8080', '--visibility', 'public'), /授权/);
  const out = cli({AIO_PORTAL_HOME: dir}, 'add', 'pub', '--port', '8080', '--visibility', 'public', '--authorized-by', 'tester');
  assert.match(out, /public/);
  assert.doesNotMatch(readFileSync(join(dir, 'dns', 'aio-portal.conf'), 'utf8'), /pub\.example\.test/);
});

test('dnsmasq 片段模式只输出 address 行，完整模式才带监听参数', () => {
  const dir = home();
  writeFileSync(join(dir, 'aio-portal.json'), JSON.stringify({
    suffix: 'example.test', mode: 'lan', lanIp: '10.0.0.1',
    resolver: {port: 5353, upstreams: ['1.1.1.1'], service: '', fragment: true},
    portal: {mapPrefix: '10-alias', reload: false}, gateway: {adapter: 'none'},
    caddy: {sitesDir: join(dir, 'caddy', 'sites'), bind: '10.0.0.1', allow: ['10.0.0.0/24']},
  }));
  cli({AIO_PORTAL_HOME: dir}, 'add', 'demo', '--port', '8080');
  const fragment = readFileSync(join(dir, 'dns', 'aio-portal.conf'), 'utf8');
  assert.match(fragment, /address=\/demo\.example\.test\/10\.0\.0\.1/);
  assert.doesNotMatch(fragment, /^port=/m);
  assert.doesNotMatch(fragment, /^listen-address=/m);
});

test('public 未授权时计划被阻断，云 DNS 不会真实写入', () => {
  const dir = home();
  writeFileSync(join(dir, 'aio-portal.json'), JSON.stringify({
    suffix: 'example.test', mode: 'lan', lanIp: '10.0.0.1',
    resolver: {port: 5353, upstreams: ['1.1.1.1'], service: ''},
    portal: {mapPrefix: '10-alias', reload: false}, gateway: {adapter: 'none'},
    caddy: {sitesDir: join(dir, 'caddy', 'sites'), bind: '10.0.0.1', allow: ['10.0.0.0/24']},
    providers: {dns: 'cloudflare', connectivity: 'caddy', certificate: 'internal-ca', policy: 'public',
      cloud: {cloudflare: {enabled: true, zone: 'example-zone', credentialsEnv: 'CF_API_TOKEN', allowPublicWrite: false}}},
  }));
  cli({AIO_PORTAL_HOME: dir}, 'add', 'pub', '--port', '8080', '--visibility', 'public', '--authorized-by', 'tester');
  const before = readFileSync(join(dir, 'aliases.json'), 'utf8');
  assert.throws(() => cli({AIO_PORTAL_HOME: dir}, 'sync', '--apply'), /同步被拒绝|计划未通过安全检查|allowPublicWrite/);
  assert.equal(readFileSync(join(dir, 'aliases.json'), 'utf8'), before, 'sync 不应改写注册表');
});

test('缺少后缀配置时给出明确错误', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-'));
  assert.throws(() => cli({AIO_PORTAL_HOME: dir}, 'list'), /缺少域名后缀配置/);
  assert.ok(existsSync(join(dir)));
});
