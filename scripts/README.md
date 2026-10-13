# 构建脚本

`build.mjs` 用 esbuild 把 `src/cli.ts` 打包成 `dist/cli.mjs` 并设为可执行。

`dist/` 已随仓库提交，因此 `npm install --global git+https://…` 这类 GitHub 安装方式
无需在安装时下载 esbuild 或执行构建即可直接使用；日常开发仍执行 `npm run build`。
修改源码后必须重新构建并一起提交，保持 `dist/cli.mjs` 与源码一致。
