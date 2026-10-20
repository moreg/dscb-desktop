# Web 版部署

浏览器打开的是同一套写作界面。作品、大纲、记忆和模型配置写在服务器磁盘上，不跟某台电脑的桌面版自动同步。桌面版用系统加密保存的 `providers.enc` 不能直接拷到服务器上使用，模型要在网页的「设置」里重新配置。作品目录是普通 Markdown，可以整份复制到服务器数据目录的 `projects/` 下，再在书案里扫描。

服务器必须设置 `WEB_ACCESS_TOKEN`。没有口令时进程不会启动。

## Docker

在项目根目录准备 `.env`（可从 `.env.example` 复制）：

```bash
WEB_ACCESS_TOKEN=一串足够长的随机口令
WEB_DATA_KEY=另一串随机口令
WEB_COOKIE_SECURE=1
WEB_TRUST_PROXY=1
```

然后：

```bash
docker compose up -d --build
```

数据在 Docker 卷 `dscb-data` 里。备份这个卷，同时保留 `WEB_DATA_KEY`。密钥变了之后，已经保存的模型配置无法解密。

本机没有 Docker 时：

```bash
npm run web:build
```

PowerShell：

```powershell
$env:WEB_ACCESS_TOKEN = "一串足够长的随机口令"
$env:WEB_DATA_DIR = "D:\dscb-data"
node out/web-server/server.cjs
```

默认监听 `8787`。浏览器打开 `http://服务器:8787`，输入口令。

## 反向代理

续写和批量写作会把一个请求保持到模型返回结束。代理的读超时需要拉长，否则写到一半会被断开。Nginx 示例：

```nginx
server {
  listen 443 ssl;
  server_name write.example.com;

  client_max_body_size 32m;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 3600s;
  }
}
```

HTTPS 反代后面把 `WEB_COOKIE_SECURE` 和 `WEB_TRUST_PROXY` 设为 `1`。

## 和桌面版的差别

- 没有安装包更新。网页刷新就是更新。
- 不能弹出服务器的文件夹选择框。作品默认放在数据目录的 `projects/`。
- 「新窗口」在网页里不提供。同一浏览器里每本书用当前标签页打开。
- 导出正文会下载到浏览器，文件也留在数据目录的 `exports/`。
- 手机连接如果在服务器上打开，会额外监听一个局域网端口。远程写作直接用这个网页即可，不必再开手机服务。
- 依赖本机 CLI 的模型（Codex、Grok、Claude Code、Antigravity）只有服务器上安装并登录了对应命令才能用。HTTP 接口的模型只需要在设置里填写地址和密钥。

## 本机开发试跑

双击 `start.bat`。直接回车是同时启动：Web 版另开一个窗口，当前窗口跑桌面版。只开其中一个就选 `1` 或 `2`。Web 地址是 `http://127.0.0.1:8787`，口令是 `dev-token`，数据写在项目下的 `data/`。桌面版仍使用 `%APPDATA%\ai-writer-desktop`，两套作品和模型密钥互不相通。

也可以在 PowerShell 里直接启动：

```powershell
$env:WEB_ACCESS_TOKEN = "dev-token"
npm run web
```
