/**
 * 网关窗口：把网关上游 DNS 指向本机解析器，让局域网内所有设备自动走内网。
 *
 * 适配器只描述“如何登录网关、读写 DNS 字段、回滚”，由配置选择；
 * 源码不写死任何厂商地址、账号或密码。默认只读，写入需显式 apply。
 */
import {createHash} from 'node:crypto';
import type {GatewayConfig} from '../config/index.js';

export type GatewayDns = {dns1: string; dns2: string};

export type GatewayProbe = {
  adapter: string;
  wanType?: string;
  current: GatewayDns;
  detail: Record<string, unknown>;
};

export type GatewayAdapter = {
  readonly name: string;
  probe(): Promise<GatewayProbe>;
  apply(dns: GatewayDns): Promise<void>;
  restore(): Promise<void>;
};

type HttpOptions = {method?: string; form?: Record<string, string>; timeoutMs?: number};

class Http {
  constructor(private readonly origin: string, private readonly password: string) {}

  async call(path: string, options: HttpOptions = {}): Promise<Record<string, unknown>> {
    const body = options.form ? new URLSearchParams(options.form).toString() : undefined;
    const headers: Record<string, string> = {referer: `${this.origin}/`, 'user-agent': 'Mozilla/5.0'};
    if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
    const response = await fetch(`${this.origin}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 12_000),
    });
    const text = await response.text();
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`网关返回非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 120)}`);
    }
  }

  /** 先明文登录；部分固件需要 nonce + SHA1 流程。 */
  async login(): Promise<string> {
    const plain = await this.call('/cgi-bin/luci/api/xqsystem/login', {
      method: 'POST',
      form: {username: 'admin', logtype: '2', password: this.password},
    });
    const token = (plain.token ?? plain.stok) as string | undefined;
    if (plain.code === 0 && token) return token;
    const first = await this.call('/cgi-bin/luci/api/xqsystem/login');
    const nonce = first.nonce as string | undefined;
    if (nonce) {
      const pw = createHash('sha1').update(this.password).digest('hex');
      const key = createHash('sha1').update(nonce + pw).digest('hex');
      const second = await this.call('/cgi-bin/luci/api/xqsystem/login', {
        method: 'POST',
        form: {username: 'admin', logtype: '2', nonce, password: key},
      });
      const token2 = (second.token ?? second.stok) as string | undefined;
      if (second.code === 0 && token2) return token2;
      throw new Error(`网关登录失败：${String(second.msg ?? second)}`);
    }
    throw new Error(`网关登录失败：${String(plain.msg ?? plain)}`);
  }
}

/** 小米/Redmi 家用固件：上网设置（PPPoE/DHCP）里的 DNS1/DNS2。 */
class XiaomiGateway implements GatewayAdapter {
  readonly name = 'xiaomi';
  private readonly http: Http;
  constructor(private readonly address: string, password: string) {
    this.http = new Http(`http://${address}`, password);
  }

  private async api<T = Record<string, unknown>>(token: string, path: string, form?: Record<string, string>): Promise<T> {
    return (await this.http.call(`/cgi-bin/luci/;stok=${token}/api/${path}`, form ? {method: 'POST', form} : {})) as T;
  }

  async probe(): Promise<GatewayProbe> {
    const token = await this.http.login();
    const info = await this.api<{info?: Record<string, unknown>}>(token, 'xqnetwork/wan_info');
    const root = info.info ?? {};
    const details = (root.details ?? {}) as Record<string, unknown>;
    if (!('dnsAddrs' in root)) throw new Error('该固件的上网设置未暴露 DNS 字段，请改用客户端方式');
    return {
      adapter: this.name,
      wanType: details.wanType as string | undefined,
      current: {dns1: (root.dnsAddrs as string) ?? '', dns2: (root.dnsAddrs1 as string) ?? ''},
      detail: {username: details.username as string | undefined, mru: details.mru as string | undefined},
    };
  }

  private async submit(token: string, dns: GatewayDns, current: GatewayProbe['detail']): Promise<void> {
    const form: Record<string, string> = {
      wanType: 'pppoe',
      pppoeName: String(current.username ?? ''),
      pppoePwd: String(current.password ?? ''),
      autoset: '0',
      mtu: String(current.mru ?? '1480'),
      service: String(current.service ?? ''),
      dns1: dns.dns1,
      dns2: dns.dns2,
    };
    const result = await this.api<{code?: number; msg?: string}>(token, 'xqnetwork/set_wan', form);
    if (result.code !== 0) throw new Error(`网关写入失败：${result.msg ?? JSON.stringify(result)}`);
  }

  async apply(dns: GatewayDns): Promise<void> {
    const token = await this.http.login();
    const info = await this.api<{info?: Record<string, unknown>}>(token, 'xqnetwork/wan_info');
    await this.submit(token, dns, ((info.info ?? {}).details ?? {}) as Record<string, unknown>);
  }

  async restore(): Promise<void> {
    const token = await this.http.login();
    // 清空 DNS 交给网关自动获取。
    await this.submit(token, {dns1: '', dns2: ''}, {});
  }
}

export function gatewayAdapter(config: GatewayConfig, password: string): GatewayAdapter {
  if (config.adapter === 'none' || !config.address) throw new Error('未配置网关地址或已禁用网关适配器');
  if (config.adapter === 'xiaomi') return new XiaomiGateway(config.address, password);
  throw new Error(`不支持的网关适配器：${config.adapter}`);
}
