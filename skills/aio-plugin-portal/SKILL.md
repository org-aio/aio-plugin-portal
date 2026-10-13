---
name: aio-plugin-portal
description: 维护端口门户：登记“别名→内网 host:port 映射”，生成反向代理按 Host 分流与内网 DNS 覆盖，并把网关上游 DNS 指向本机解析器，让局域网所有设备无感走内网。当用户要新增/删除 xxx.addzero.site 之类的别名站点、排查内外网解析差异、或让同事整片局域网零配置走内网时使用。
---

# 端口门户

一次登记同时产生两件事：反向代理按 Host 把 `<别名>.<suffix>` 分流到目标端口；内网 DNS 把该名字解析到本机，于是**内网直达、外网仍走原隧道**。

先执行 `aio-plugin-portal --help` 核对当前命令，`aio-plugin-portal --version` 确认版本。未全局安装时用 `npx -y aio-plugin-portal`。

## 常用命令

```sh
aio-plugin-portal add tc --port 8111 --host 192.168.31.10 --note TeamCity
aio-plugin-portal add only-public --port 9000 --no-lan     # 只做分流，不做内网覆盖
aio-plugin-portal list
aio-plugin-portal remove tc
aio-plugin-portal sync                                     # 按注册表重建映射+解析并热加载
aio-plugin-portal doctor                                   # 配置与产物体检
aio-plugin-portal warden --password '<网关密码>'            # 只读探测网关
aio-plugin-portal warden --password '<网关密码>' --apply    # 让整片局域网走内网
aio-plugin-portal warden --password '<网关密码>' --restore  # 回滚网关 DNS
```

## 配置

宿主相关的值全部来自配置，源码不含域名、网段、账号或部署目录：

- 默认读取 `~/.config/aio-portal/aio-portal.json`，可用 `--home` 或环境变量 `AIO_PORTAL_HOME` 覆盖。
- 必填 `suffix`（域名后缀）；`mode`、`lanIp`、`resolver.upstreams/port/service`、`portal.aliasesDir/mapPrefix/reload`、`gateway.address/adapter/fallbackDns` 均可配置。
- 新增站点只改注册表（`aio-plugin-portal add` 或编辑 `aliases.json`），无需改代码。

## 约定

- 网关改动默认只读，写入必须显式 `--apply`，并支持 `--restore` 回滚；会同时影响经该网关上网的所有设备。
- 只想让个别机器走内网时，不动网关，改用客户端按域名分流（例如 macOS `/etc/resolver/<suffix>`）。
- 通过 AIO 市场安装后，本文件随 npm 包进入 `~/.agents/skills/aio-plugin-portal/SKILL.md`。
