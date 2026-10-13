# 端口门户

把「别名 + 内网端口」登记成一条 `https://<别名>.<suffix>`：**内网**直接把该名字解析到本机
（不经公网），**外网**仍按原隧道/代理访问，两条路互不影响。以后新增站点只改注册表，不用改代码。

## 安装与使用

```sh
npm install --global aio-plugin-portal   # 或 npx -y aio-plugin-portal
aio-plugin-portal --help
```

首次使用先写配置（默认 `~/.config/aio-portal/aio-portal.json`，可用 `--home`/`AIO_PORTAL_HOME` 覆盖），
必填域名后缀，其余按需设置；样例见 `config/aio-portal.example.json`。

```sh
aio-plugin-portal add tc --port 8111 --host 192.168.31.10 --note TeamCity
aio-plugin-portal list
aio-plugin-portal sync
aio-plugin-portal doctor
aio-plugin-portal remove tc
```

## 让整片局域网无感走内网

客户端零配置的前提是**网关替所有设备做 DNS 覆盖**：把网关上游 DNS 指向本机解析器。

```sh
aio-plugin-portal warden --password '<网关密码>'            # 只读探测
aio-plugin-portal warden --password '<网关密码>' --apply    # 写入
aio-plugin-portal warden --password '<网关密码>' --restore  # 回滚
```

- 默认只读，写入必须显式 `--apply`；网关改动会影响**所有**经它上网的设备。
- 只想让个别机器走内网时，不动网关，改用客户端按域名分流（如 macOS `/etc/resolver/<suffix>`）。
- 网关适配器通过配置选择；不含任何厂商地址、账号或密码。

发布与市场配置见 [AIO 自动发布说明](AIO.md)。

`skills/aio-plugin-portal/SKILL.md` 是随包的 AI 使用指南；使用 AIO 2026.9.18+ 从市场安装后会进入
`~/.agents/skills/aio-plugin-portal/`。
