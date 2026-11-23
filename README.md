# LunPDF

轻量、纯本地的 PDF 阅读器。Tauri 2 + pdf.js，安装包体积比 Electron 方案小一个数量级，打开即读，不上传任何文件。

## 功能

- **连续滚动阅读**：只渲染视口附近的页面，几百页文档也不卡；离屏页面自动回收位图
- **目录侧栏**：读取 PDF outline，点击跳转，随阅读进度高亮当前章节
- **全文搜索**：跨页搜索 + 结果列表 + 页内高亮定位（Ctrl+F）
- **文字可选中复制**：叠加 pdf.js 文本层，中文（CJK）文档需要 cMap，已内置
- **缩放**：适应宽度 / 适应整页 / 25%–800%，缩放时保持当前阅读位置
- **阅读位置记忆**：按文件记住页码与缩放，下次打开自动回到原处；最近打开列表
- **拖拽打开**：PDF 直接拖进窗口
- **主题**：浅色 / 暖色暗色模式
- **快捷键**：`Ctrl+O` 打开、`Ctrl+F` 搜索、`←/→` 翻页、`Ctrl+/Ctrl-` 缩放、`W` 适应宽度、`D` 切主题、`T` 目录

## 开发

```bash
npm install
npm run app:dev      # 开发模式（自动起 vite + tauri 窗口）
```

浏览器里调 UI（不需要 Rust）：

```bash
npm run build && npx vite preview --port 4173
# 打开 http://127.0.0.1:4173/?url=/sample-cn.pdf
```

## 打包

```bash
npm run app:build                 # 当前平台
npm run app:build -- --bundles deb,appimage
```

产物在 `src-tauri/target/release/bundle/`。

> 跨平台无法在单机上完成：Windows / macOS 安装包需要在对应系统构建，仓库已配好 `.github/workflows/release.yml`，推 tag 即由 CI 出三平台产物。

## 技术说明

- 后端只有一个命令：`read_pdf_file(path)`，走 Tauri IPC raw payload 返回字节，避免大文件被序列化成 JSON 数组
- 前端渲染核心在 `src/viewer.ts`：`IntersectionObserver` 驱动按需渲染 + 2 并发队列 + 缩放保锚点
- pdf.js 的 `cmaps/`、`standard_fonts/` 通过 `public/` 随包分发，`cMapUrl` 指向应用内相对路径
- 窗口隐藏（最小化/切后台）时浏览器会暂停 rAF，pdf.js 渲染会挂起；已监听 `visibilitychange` 在恢复时补渲染

## 许可

MIT。图标与代码均为本项目原创。
