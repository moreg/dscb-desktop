# Phase 11：打包（electron-builder）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: executing-plans.

**Goal:** 用 electron-builder 把应用打包成 Windows 安装包（NSIS .exe），双击可分发安装。

**Architecture:** 复用 electron-vite 的 `out/` 构建产物。`package.json` 加 `build` 配置（appId/productName/win/nsis）与 `package` script（`electron-vite build && electron-builder`）。`.npmrc` 已配 `electron_builder_binaries_mirror`，加速 nsis/winCodeSign 下载。

**Tech Stack:** electron-builder 25。

---

## Task 1：安装与配置

**Files:** `package.json`

- [ ] **Step 1.1：安装 electron-builder**

```bash
npm install -D electron-builder
```
Expected: 安装成功。

- [ ] **Step 1.2：`package.json` 加 scripts 与 build 配置**

在 `scripts` 里加：
```json
    "package": "electron-vite build && electron-builder"
```

在顶层加 `build` 字段（与 `scripts` 同级）：
```json
  "build": {
    "appId": "com.aiwriter.desktop",
    "productName": "ai-writer",
    "directories": {
      "output": "release"
    },
    "files": [
      "out/**/*"
    ],
    "win": {
      "target": [
        "nsis"
      ]
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true
    }
  }
```

- [ ] **Step 1.3：`.gitignore` 加 `release/`**

在末尾追加：
```
release/
```

- [ ] **Step 1.4：提交**

```bash
git add package.json package-lock.json .gitignore
git commit -m "build: configure electron-builder for packaging"
```

---

## Task 2：打包验证

- [ ] **Step 2.1：运行打包**

```bash
npm run package
```
Expected: electron-vite 构建成功 + electron-builder 打包，`release/` 下产出 `ai-writer Setup <version>.exe`（NSIS 安装包）。可能耗时 1-3 分钟（首次下载 nsis/winCodeSign）。

> 若因网络失败，确认 `.npmrc` 的 `electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/` 生效后重试。

- [ ] **Step 2.2：确认产物**

```bash
ls -la release/ | grep -i "\.exe"
```
Expected: 列出 `ai-writer Setup *.exe`。

- [ ] **Step 2.3：（可选）确认打包的应用能启动**

不强制——安装包体积大，不双击安装。产物存在即视为打包链路通。

---

## Task 3：收尾 + README

- [ ] **Step 3.1：README**

在「开发」命令块后加「打包」一节：

```
## 打包

\`\`\`bash
npm run package      # 构建并打包成 Windows 安装包（release/*.exe）
\`\`\`

产物：`release/ai-writer Setup <version>.exe`（NSIS 安装包）。
```

并把「下一阶段」改为：

```
应用已完整：本地创作 + 记忆 + 大纲 + AI 写作 + 可打包分发。后续可扩展去味润色、更多 LLM provider、macOS 打包等。
```

- [ ] **Step 3.2：提交**

```bash
git add README.md
git commit -m "docs: add packaging instructions for phase 11"
```

---

## 完成标准

- [ ] `npm run package` 产出 `release/*.exe`
- [ ] `release/` 已 gitignore
- [ ] README 含打包说明
- [ ] 全部 11 个 Phase 完成
