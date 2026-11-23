# LunPDF — 项目状态

> 轻量本地 PDF 阅读器 / Tauri 2 + pdf.js v6 / 位置：`/opt/data/workspace/pdf-reader`

## 当前版本
v0.1.0（未发布）

## 已完成

- Tauri v2 骨架（`src-tauri/`）+ Vite/TS 前端（`src/`）
- 后端命令：`read_pdf_file`（IPC raw bytes，512MB 上限）、`file_exists`
- 渲染核心 `src/viewer.ts`：
  - 连续滚动 + `IntersectionObserver` 按需渲染，渲染队列限 2 并发
  - 离屏页位图回收，占位符 `.page-placeholder`
  - 缩放保锚点（`anchor()` / `restoreAnchor()`），0.15–8x
  - 每页尺寸校准（`calibrate()` 分批，兼容混合页面尺寸）
  - 文本层 `TextLayer` + `--total-scale-factor`，CJK 依赖 `cMapUrl`
  - 搜索：全文匹配 + 字符区间→矩形（`hitRects`），缩放后重算
- UI：工具栏 / 目录侧栏 / 搜索侧栏 / 欢迎页 / 最近打开 / 拖拽 / Toast / 浅深主题
- 状态记忆：`lunpdf:last`、`lunpdf:recent`、`lunpdf:theme`（localStorage）
- 图标：`tools/gen_icon.py` → `tauri icon` 全套
- CI：`.github/workflows/release.yml`（tag 触发，Win/macOS/Linux 三平台）

## 已验证（真实执行）

- `npm run build` 通过（tsc + vite，主包 ~532KB，worker ~2.4MB）
- headless Chromium 打开 15 页中文报告：封面渲染完整、62 个文本 span、中文正确
- 目录 15 项、搜索「呆呆橘」14 处命中、页内高亮位置准确（截图确认）
- 缩放 116%→154% 保持滚动锚点、跳页到第 6 页、深色主题切换均正常
- **`tauri build` 成功**：`src-tauri/target/release/bundle/deb/LunPDF_0.1.0_amd64.deb`（4.26 MiB），首次全量编译 11m45s
- **Xvfb + openbox 内真实启动**：窗口渲染正常、文件对话框打开 `sample-deck.pdf`、14 页 deck 渲染完整、标题联动更新

## 待办

- [x] `tauri build` 出 Linux deb，Xvfb 内启动截图
- [ ] Windows / macOS 安装包（必须走 CI，Linux 无法交叉编译）
- [ ] git 远端：尚未 push 到 GitHub
- [ ] 可选增强：缩略图侧栏、双页模式、注释/表单层、大纲折叠

## 踩过的坑（勿重复）

1. **pdf.js v6 文本层零 span** → 必须同时给 `cMapUrl` + `cMapPacked` + 容器上的 `--total-scale-factor`；缺 cMap 时中文 CID 字体提取不出文本，且**不报错**。
2. **页面 hidden 时 rAF 被暂停**，pdf.js 渲染 promise 永不 resolve，canvas 停在半成品。已加 `visibilitychange` 补偿；无头测试前必须 `Page.bringToFront`。
3. `page.render()` 传 `canvasContext` 即可，同时传 `canvas` 在 v6 下行为不一致。
4. 缩放时必须在改 `this.scale` **之前**取基准尺寸（`pageBaseSize()` 依赖旧 scale）。
5. patch 工具对 TS 文件会跑默认 es5 lib 的 tsc，喷几百条假错误——用 `npm run build` 判断真实结果。
6. **NAS 卷上 `src-tauri/target` 目录权限会被置成 `d---------`**，cargo 报 "output file ... is not writeable"。构建前 `chmod -R u+rwX src-tauri/target`。
7. `xdotool key --window <wid>` 发的合成事件 GTK 会忽略，必须 `windowactivate` 后用真实焦点发键（或直接 `mousemove ... click 1` 点按钮）。
8. 首次全量 Rust 编译约 12 分钟（4 核 NAS），之后增量编译 1 分钟内。

## 命令

```bash
npm run dev            # vite dev
npm run build          # tsc + vite build
npm run app:dev        # tauri dev（需 Rust + webkit2gtk）
npm run app:build      # tauri build（当前平台）
npx vite preview --port 4173   # 浏览器验证：/?url=/sample-cn.pdf
```

Rust 环境变量：`PATH=/opt/data/.cargo/bin:$PATH CARGO_HOME=/opt/data/.cargo RUSTUP_HOME=/opt/data/.rustup`（crates 走 rsproxy 镜像，配置在 `/opt/data/.cargo/config.toml`）
