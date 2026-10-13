# CLI 自动发布

本项目通过 AIO 初始化。`aio-cli.json` 声明市场名称、适用平台及安装后/卸载前参数；CLI 实现与 AIO 宿主无关。

## 首次配置

先将项目推送到自己的 GitHub 仓库，再在项目目录执行一次：

```sh
npx -y @zjarlin/aio@2026.9.22 tool release setup
```

此命令从 Git origin 自动填写 npm 仓库地址，检查 CLI 声明；npm 包尚不存在时先测试并完成首次公开发布，然后配置该仓库 `aio-cli.yml` 的 Trusted Publisher。

## 日常开发

默认分支每次推送经过测试后发布 npm `next` 并更新市场条目；`vX.Y.Z` 标签发布 npm `latest`。
市场显示已登记的最高 SemVer，安装命令固定精确版本。

## 随 CLI 分发技能

`skills/aio-plugin-portal/SKILL.md` 目录名必须与 frontmatter 的 `name` 一致，npm `files` 包含 `skills`。
AIO 2026.9.18+ 安装后自动复制到 `~/.agents/skills`；直接 npm/npx 不写入技能目录。
