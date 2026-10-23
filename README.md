# 端口门户

把「别名 + 内网端口」登记成一条 `https://<别名>.<suffix>`，并在**一套期望态**里同时驱动
DNS、反代、证书、访问策略四类能力。内网直达本机，公网按登记的策略决定是否可达。

## 安装与使用

```sh
npm install --global aio-plugin-portal   # 或 npx -y aio-plugin-portal
aio-plugin-portal --help
```

首次使用先写配置（默认 `~/.config/aio-portal/aio-portal.json`，可用 `--home`/`AIO_PORTAL_HOME` 覆盖），
必填域名后缀，其余按需设置；样例见 `config/aio-portal.example.json`。

```sh
aio-plugin-portal add tc --port 8111 --host 127.0.0.1 --note TeamCity
aio-plugin-portal add only-public --port 9000 --visibility public --authorized-by alice
aio-plugin-portal list
aio-plugin-portal plan          # 只出计划，不写任何东西
aio-plugin-portal sync          # 渲染产物 + 执行 provider + 校验
aio-plugin-portal sync --apply  # 允许 provider 真实写入
aio-plugin-portal doctor
aio-plugin-portal remove tc
```

## 内网 / 公网边界

每条登记都有 `visibility`，它是安全边界而不是展示字段：

- `internal`（默认）：**永不产生公网 DNS 记录**；Caddy 站点同时要求 `bind <入口地址>` 与
  `remote_ip` 来源白名单，未命中直接 `respond 404`。缺 `caddy.bind` 时 `verify` 判失败。
- `public`：必须同时满足 `allowPublicWrite: true`、有凭据、且登记了 `authorizedBy`，否则计划被标记
  为 `blocked`，`sync --apply` 拒绝执行。缺任意一项宁可不动，也不“先写上去再说”。

`blocked` 的计划一律不 apply；`verify` 重新读取远端/产物，不用本地计划冒充成功。
`sync` 只有在全部 provider 计划可执行且校验通过时才报告成功。

> 边界代价：只在经过本机 Caddy 的路径上成立。若同名域名在公网 DNS 或别的入口仍指向旧隧道，
> 那部分流量不归本机管。真正“仅内网”还要清掉对应公网记录，这一步本工具不会替你猜。

## provider 抽象

四类 provider 各自独立组合，登记项可用 `providers` 字段单条覆盖：

| 类别 | 可用值 | 说明 |
|---|---|---|
| `dns` | `local-dnsmasq`、`cloudflare`、`dnspod`（腾讯云）、`huawei`（华为云） | 本地只写解析片段；云厂商走 `list → create/update/noop` 幂等协调 |
| `connectivity` | `caddy`、`aio-tunnel`、`cloudflared` | `caddy` 生成站点片段；隧道类只给计划，要求由隧道侧真实校验 |
| `certificate` | `internal-ca`、`acme` | `internal-ca` 由本地 Caddy internal issuer 签发；`acme` 需外部可达，未授权即 blocked |
| `policy` | `lan-allowlist`、`aio-auth`、`public` | `lan-allowlist` 生成 `remote_ip` 白名单；`aio-auth` 交给应用自身 |

云 DNS 凭据只从环境变量读取（`credentialsEnv` 指向变量名），不写进注册表或配置。
腾讯云 DNSPod 用 `Record.List/Create/Modify`；华为云使用 Zone ID + IAM `X-Auth-Token`，
**长期 AK/SK 签名尚未实现**，未配置 token 时只会给出可审计的计划。

## 让整片局域网无感走内网

客户端零配置的前提是**网关替所有设备做 DNS 覆盖**：把网关上游 DNS 指向本机解析器。

```sh
aio-plugin-portal warden --password '<网关密码>'            # 只读探测
aio-plugin-portal warden --password '<网关密码>' --apply    # 写入
aio-plugin-portal warden --password '<网关密码>' --restore  # 回滚
```

- 默认只读，写入必须显式 `--apply`；网关改动会影响**所有**经它上网的设备。
- 只想让个别机器走内网时，不动网关，改用客户端按域名分流（如 macOS `/etc/resolver/<suffix>`）。

## 与配对机制的边界

“配对”不是本工具的职责。设备配对复用 `aio-plugin-device` 的一次性短时票据闭环
（签发 → 登录确认 → 轮询换取凭据 → 心跳/租约 → 可撤销）。本工具只负责把已经存在的
目标端口登记成可达的站点，并把它的可见范围钉死在内网。

发布与市场配置见 [AIO 自动发布说明](AIO.md)。

`skills/aio-plugin-portal/SKILL.md` 是随包的 AI 使用指南；使用 AIO 2026.9.18+ 从市场安装后会进入
`~/.agents/skills/aio-plugin-portal/`。
