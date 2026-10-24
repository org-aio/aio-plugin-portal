import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/**
 * 跨平台的假 dnsmasq。
 *
 * 被测代码用 `execFileSync(binary, ['--test', '--conf-file=…'])` 调用解析器，**不经过 shell**，
 * 所以假二进制必须本身能被直接执行：
 * - POSIX：可执行 sh 包装（首行 shebang）；
 * - Windows：`execFileSync` 无法直接执行 .cmd/.bat（EINVAL）或 shebang 脚本（EFTYPE），
 *   改用系统自带的 `cmd.exe`，它忽略不认识的自定义参数并返回 0。
 * 两种情况都只依赖操作系统自带能力，不依赖 runner 是否装了 dnsmasq。
 */
const fakeDnsmasq = src => {
  if (process.platform === 'win32') {
    const cmd = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    return {binary: cmd};
  }
  const impl = join(src, 'fake-dnsmasq.mjs');
  writeFileSync(impl, 'process.exit(0);\n');
  const sh = join(src, 'fake-dnsmasq.sh');
  writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`);
  chmodSync(sh, 0o755);
  return {binary: sh};
};

const cli = (env, ...args) =>
  execFileSync(process.execPath, ['dist/cli.mjs', ...args], {encoding: 'utf8', env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']}).trim();

/** 建一个带 Caddy 站点目录的临时门户。 */
const home = (extra = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-td-'));
  writeFileSync(join(dir, 'aio-portal.json'), JSON.stringify({
    suffix: 'lyokm.test',
    mode: 'lan',
    lanIp: '10.0.0.1',
    resolver: {port: 5353, upstreams: ['1.1.1.1'], service: '', fragment: true},
    portal: {mapPrefix: '10-alias', reload: false},
    gateway: {adapter: 'none'},
    caddy: {sitesDir: join(dir, 'caddy', 'sites'), bind: '10.0.0.1', allow: ['10.0.0.0/24']},
    ...extra,
  }));
  return dir;
};

const files = dir => {
  const sites = join(dir, 'caddy', 'sites');
  return existsSync(sites) ? readdirSync(sites).sort() : [];
};

test('remove 会删掉站点文件、解析行与映射行', () => {
  const dir = home();
  cli({AIO_PORTAL_HOME: dir}, 'add', 'gitlab', '--port', '8000', '--host', '10.0.0.9');
  assert.deepEqual(files(dir), ['portal-gitlab.caddy']);
  assert.match(readFileSync(join(dir, 'dns', 'aio-portal.conf'), 'utf8'), /address=\/gitlab\.lyokm\.test\/10\.0\.0\.1/);
  assert.match(readFileSync(join(dir, 'nginx', 'aliases.d', '10-alias.map'), 'utf8'), /gitlab\.lyokm\.test/);

  const out = cli({AIO_PORTAL_HOME: dir}, 'remove', 'gitlab');

  assert.deepEqual(files(dir), [], '站点文件必须被删除');
  assert.doesNotMatch(readFileSync(join(dir, 'dns', 'aio-portal.conf'), 'utf8'), /gitlab\.lyokm\.test/);
  assert.doesNotMatch(readFileSync(join(dir, 'nginx', 'aliases.d', '10-alias.map'), 'utf8'), /gitlab\.lyokm\.test/);
  assert.doesNotMatch(readFileSync(join(dir, 'nginx', 'aliases.d', '10-alias.scheme'), 'utf8'), /gitlab\.lyokm\.test/);
  assert.doesNotMatch(readFileSync(join(dir, 'nginx', 'aliases.d', '10-alias.host'), 'utf8'), /gitlab\.lyokm\.test/);
  assert.doesNotMatch(readFileSync(join(dir, 'aliases.json'), 'utf8'), /gitlab/);
  assert.match(out, /校验 caddy-site: 站点文件已移除/);
  assert.match(out, /校验 resolver: 解析片段已清除/);
});

test('删一条不影响其他条目', () => {
  const dir = home();
  cli({AIO_PORTAL_HOME: dir}, 'add', 'keep', '--port', '8001');
  cli({AIO_PORTAL_HOME: dir}, 'add', 'drop', '--port', '8002');
  assert.deepEqual(files(dir), ['portal-drop.caddy', 'portal-keep.caddy']);
  cli({AIO_PORTAL_HOME: dir}, 'remove', 'drop');
  assert.deepEqual(files(dir), ['portal-keep.caddy']);
  const dns = readFileSync(join(dir, 'dns', 'aio-portal.conf'), 'utf8');
  assert.match(dns, /keep\.lyokm\.test/);
  assert.doesNotMatch(dns, /drop\.lyokm\.test/);
});

test('人工维护的同名站点既不覆盖也不删除', () => {
  const dir = home();
  const sites = join(dir, 'caddy', 'sites');
  execFileSync('mkdir', ['-p', sites]);
  cli({AIO_PORTAL_HOME: dir}, 'add', 'manual', '--port', '8003');
  // 换成人工维护的版本（不带本工具标记）
  const manual = 'manual.lyokm.test {\n\trespond 200\n}\n';
  writeFileSync(join(sites, 'portal-manual.caddy'), manual);

  assert.throws(() => cli({AIO_PORTAL_HOME: dir}, 'add', 'manual', '--port', '8009'), /不是本工具生成的，拒绝覆盖/);
  assert.equal(readFileSync(join(sites, 'portal-manual.caddy'), 'utf8'), manual, '人工文件内容不得被改');

  cli({AIO_PORTAL_HOME: dir}, 'remove', 'manual');
  assert.ok(existsSync(join(sites, 'portal-manual.caddy')), '人工文件必须保留');
});

test('删除不存在的别名会报错且不改动产物', () => {
  const dir = home();
  cli({AIO_PORTAL_HOME: dir}, 'add', 'keep', '--port', '8001');
  const before = readFileSync(join(dir, 'aliases.json'), 'utf8');
  assert.throws(() => cli({AIO_PORTAL_HOME: dir}, 'remove', 'nope'), /未找到别名/);
  assert.equal(readFileSync(join(dir, 'aliases.json'), 'utf8'), before);
});

test('单条 suffix 覆盖：内网统一域与 aio 域共存', () => {
  const dir = home();
  cli({AIO_PORTAL_HOME: dir}, 'add', 'gitlab', '--port', '8000');
  cli({AIO_PORTAL_HOME: dir}, 'add', 'aio', '--port', '3080', '--suffix', 'addzero.test');
  const dns = readFileSync(join(dir, 'dns', 'aio-portal.conf'), 'utf8');
  assert.match(dns, /address=\/gitlab\.lyokm\.test\//);
  assert.match(dns, /address=\/aio\.addzero\.test\//);
  assert.ok(files(dir).includes('portal-aio.caddy'));
  assert.match(readFileSync(join(dir, 'caddy', 'sites', 'portal-aio.caddy'), 'utf8'), /^aio\.addzero\.test \{/m);
  cli({AIO_PORTAL_HOME: dir}, 'remove', 'aio');
  assert.doesNotMatch(readFileSync(join(dir, 'dns', 'aio-portal.conf'), 'utf8'), /aio\.addzero\.test/);
  assert.match(readFileSync(join(dir, 'dns', 'aio-portal.conf'), 'utf8'), /gitlab\.lyokm\.test/);
});

test('删除带 suffix 覆盖的记录：校验针对自己的域，残留会被抓到', () => {
  const dir = home();
  cli({AIO_PORTAL_HOME: dir}, 'add', 'gitlab', '--port', '8000');
  cli({AIO_PORTAL_HOME: dir}, 'add', 'aio', '--port', '3080', '--suffix', 'addzero.test');
  // 解析片段在 remove 前会被整体重写，无法造残留；用「不会被重写的手工片段」模拟真实世界的漏清理场景。
  // 校验若错用全局后缀，会去查 aio.lyokm.test 而放过 aio.addzero.test 的残留。
  const stale = join(dir, 'dns', 'legacy-aio.conf');
  execFileSync('mkdir', ['-p', join(dir, 'dns')]);
  writeFileSync(stale, 'address=/aio.addzero.test/10.0.0.1\n');
  let failure = '';
  try {
    cli({AIO_PORTAL_HOME: dir}, 'remove', 'aio');
  } catch (error) {
    failure = String(error.stderr || error.stdout || error.message);
  }
  assert.match(failure, /aio\.addzero\.test/);
  // 失败整体回滚：记录与站点都还在。
  assert.ok(existsSync(join(dir, 'caddy', 'sites', 'portal-aio.caddy')));
  assert.match(readFileSync(join(dir, 'aliases.json'), 'utf8'), /"aio"/);
  writeFileSync(stale, '');
  cli({AIO_PORTAL_HOME: dir}, 'remove', 'aio');
  assert.ok(!files(dir).includes('portal-aio.caddy'));
  assert.doesNotMatch(readFileSync(join(dir, 'dns', 'aio-portal.conf'), 'utf8'), /aio\.addzero\.test/);
});

test('stream 打开时渲染 flush_interval -1，关闭后不再出现', () => {
  const dir = home();
  cli({AIO_PORTAL_HOME: dir}, 'add', 'sse', '--port', '8001', '--stream');
  const site = join(dir, 'caddy', 'sites', 'portal-sse.caddy');
  assert.match(readFileSync(site, 'utf8'), /reverse_proxy http:\/\/127\.0\.0\.1:8001 \{\n\t+flush_interval -1/);
  cli({AIO_PORTAL_HOME: dir}, 'update', 'sse', '--no-stream');
  assert.doesNotMatch(readFileSync(site, 'utf8'), /flush_interval/);
  cli({AIO_PORTAL_HOME: dir}, 'update', 'sse', '--stream');
  assert.match(readFileSync(site, 'utf8'), /flush_interval -1/);
});

// POSIX 权限位只在类 Unix 上有意义；Windows 的文件模式固定为 666，这里不适用。
test('解析片段写成 0644：非 root 的 dnsmasq 才能加载', {skip: process.platform === 'win32' && 'Windows 无 POSIX 权限位'}, () => {
  const dir = home();
  cli({AIO_PORTAL_HOME: dir}, 'add', 'svc', '--port', '8010');
  const mode = statSync(join(dir, 'dns', 'aio-portal.conf')).mode & 0o777;
  assert.equal(mode.toString(8), '644');
});

test('disable 停止产出产物，enable 恢复', () => {
  const dir = home();
  cli({AIO_PORTAL_HOME: dir}, 'add', 'svc', '--port', '8004');
  cli({AIO_PORTAL_HOME: dir}, 'disable', 'svc');
  assert.deepEqual(files(dir), []);
  assert.doesNotMatch(readFileSync(join(dir, 'dns', 'aio-portal.conf'), 'utf8'), /svc\.lyokm\.test/);
  assert.match(readFileSync(join(dir, 'aliases.json'), 'utf8'), /"disabled": true/);
  cli({AIO_PORTAL_HOME: dir}, 'enable', 'svc');
  assert.deepEqual(files(dir), ['portal-svc.caddy']);
  assert.match(readFileSync(join(dir, 'dns', 'aio-portal.conf'), 'utf8'), /svc\.lyokm\.test/);
});

test('update 只改给出的字段并保留授权审计信息', () => {
  const dir = home();
  cli({AIO_PORTAL_HOME: dir}, 'add', 'pub', '--port', '8005', '--visibility', 'public', '--authorized-by', 'alice');
  cli({AIO_PORTAL_HOME: dir}, 'update', 'pub', '--port', '8006', '--note', '改端口');
  const [entry] = JSON.parse(readFileSync(join(dir, 'aliases.json'), 'utf8')).aliases;
  assert.equal(entry.port, 8006);
  assert.equal(entry.note, '改端口');
  assert.equal(entry.authorizedBy, 'alice', '授权人不能被静默丢掉');
  assert.equal(entry.visibility, 'public');
});

test('表格查询支持检索、过滤、排序与分页', () => {
  const dir = home();
  for (const [alias, port] of [['alpha', '9001'], ['beta', '9002'], ['gamma', '9003']]) {
    cli({AIO_PORTAL_HOME: dir}, 'add', alias, '--port', port);
  }
  cli({AIO_PORTAL_HOME: dir}, 'add', 'pub', '--port', '9004', '--visibility', 'public', '--authorized-by', 'alice');
  const all = JSON.parse(cli({AIO_PORTAL_HOME: dir}, 'list', '--json'));
  assert.equal(all.total, 4);
  const internal = JSON.parse(cli({AIO_PORTAL_HOME: dir}, 'list', '--json', '--visibility', 'internal'));
  assert.equal(internal.total, 3);
  const page1 = JSON.parse(cli({AIO_PORTAL_HOME: dir}, 'list', '--json', '--page-size', '2'));
  assert.equal(page1.items.length, 2);
  assert.equal(page1.pages, 2);
  const page2 = JSON.parse(cli({AIO_PORTAL_HOME: dir}, 'list', '--json', '--page-size', '2', '--page', '2'));
  assert.equal(page2.items.length, 2);
  const desc = JSON.parse(cli({AIO_PORTAL_HOME: dir}, 'list', '--json', '--sort', 'port', '--order', 'desc'));
  assert.equal(desc.items[0].port, 9004);
  const hit = JSON.parse(cli({AIO_PORTAL_HOME: dir}, 'list', '--json', '--search', 'gamma'));
  assert.equal(hit.total, 1);
  assert.equal(hit.items[0].alias, 'gamma');
});

test('解析器校验失败时整体回滚，不留半完成产物', () => {
  const dir = home();
  writeFileSync(join(dir, 'aio-portal.json'), JSON.stringify({
    suffix: 'lyokm.test', mode: 'lan', lanIp: '10.0.0.1',
    resolver: {port: 5353, upstreams: ['1.1.1.1'], service: '', fragment: true, dnsmasqBinary: fakeDnsmasq(dir).binary},
    portal: {mapPrefix: '10-alias', reload: true},
    gateway: {adapter: 'none'},
    caddy: {sitesDir: join(dir, 'caddy', 'sites'), bind: '10.0.0.1', allow: ['10.0.0.0/24']},
  }));
  // 先正常登记一条作为基线
  cli({AIO_PORTAL_HOME: dir}, 'add', 'base', '--port', '8001');
  const dnsBefore = readFileSync(join(dir, 'dns', 'aio-portal.conf'), 'utf8');
  const sitesBefore = files(dir);

  // 再把解析器二进制改坏，模拟 reload 阶段失败
  const cfg = JSON.parse(readFileSync(join(dir, 'aio-portal.json'), 'utf8'));
  cfg.resolver.dnsmasqBinary = join(dir, 'missing-binary');
  writeFileSync(join(dir, 'aio-portal.json'), JSON.stringify(cfg));

  assert.throws(() => cli({AIO_PORTAL_HOME: dir}, 'add', 'broken', '--port', '8002'), /已回滚/);

  assert.deepEqual(files(dir), sitesBefore, '不能留下半完成的站点文件');
  assert.equal(readFileSync(join(dir, 'dns', 'aio-portal.conf'), 'utf8'), dnsBefore, '解析片段必须回到原样');
  assert.doesNotMatch(readFileSync(join(dir, 'aliases.json'), 'utf8'), /broken/, '注册表必须回滚');
  assert.match(readFileSync(join(dir, 'aliases.json'), 'utf8'), /base/);
});

test('回滚后重试仍可成功（可恢复）', () => {
  const dir = home();
  writeFileSync(join(dir, 'aio-portal.json'), JSON.stringify({
    suffix: 'lyokm.test', mode: 'lan', lanIp: '10.0.0.1',
    resolver: {port: 5353, upstreams: ['1.1.1.1'], service: '', fragment: true, dnsmasqBinary: join(dir, 'missing-binary')},
    portal: {mapPrefix: '10-alias', reload: true}, gateway: {adapter: 'none'},
    caddy: {sitesDir: join(dir, 'caddy', 'sites'), bind: '10.0.0.1', allow: ['10.0.0.0/24']},
  }));
  assert.throws(() => cli({AIO_PORTAL_HOME: dir}, 'add', 'retry', '--port', '8001'));
  // 修好二进制后重试应当成功
  const cfg = JSON.parse(readFileSync(join(dir, 'aio-portal.json'), 'utf8'));
  cfg.resolver.dnsmasqBinary = fakeDnsmasq(dir).binary;
  cfg.resolver.service = '';
  writeFileSync(join(dir, 'aio-portal.json'), JSON.stringify(cfg));
  cli({AIO_PORTAL_HOME: dir}, 'add', 'retry', '--port', '8001');
  assert.match(readFileSync(join(dir, 'aliases.json'), 'utf8'), /retry/);
  assert.deepEqual(files(dir), ['portal-retry.caddy']);
});
