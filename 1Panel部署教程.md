# 视野 3x-ui 用户管理系统 1Panel 部署教程

本文只讲 1Panel 面板部署。当前项目是新架构版本：NestJS API、Vue 管理端、Vue 用户端、MySQL、Prisma，不再使用旧版 `server.js` 和网页安装向导。

## 1. 准备条件

需要准备：

- 一台已经安装 1Panel 的 Linux 服务器
- 1Panel 应用商店里的 MySQL 或 MariaDB
- 1Panel 运行环境里的 Node.js，建议 Node.js 20+
- OpenResty/Nginx 网站功能
- 一个域名，推荐使用 HTTPS
- 本项目完整源码

默认信息：

```text
项目目录：/opt/shiye
API 端口：3388
用户端入口：https://你的域名/
管理端入口：https://你的域名/admin/
API 前缀：https://你的域名/api/
```

## 2. 选择部署方式和创建数据库

如果你想不用面板手动上传源码，也可以在 1Panel 终端直接执行一键脚本。下面命令默认在 `root` 用户下执行；如果当前不是 `root`，请先切换到 `root` 用户。脚本会询问访问方式：选择跳过域名就是 `IP:3388` 访问；选择域名访问会继续输入域名，并可自动申请 HTTPS 证书。

一键脚本默认是精简运行目录：构建时只获取必要项目文件，安装完成后只保留运行必需项，不会把 README、部署文档、安装脚本、前后端源码和 `.git` 长期留在服务器运行目录。

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/install.sh)"
```

一键脚本部署成功后，项目由 systemd 服务 `shiye-api` 管理，不需要再到 1Panel 里创建 Node.js 运行环境。服务器上可以随时打开管理菜单：

```bash
shiye
```

菜单标题只显示“管理面板”，可执行安装/更新、查看状态、重启、日志、配置或取消域名、重新构建、数据库迁移、备份和卸载。

也可以提前带入域名和 HTTPS 参数：

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/install.sh | env DOMAIN=panel.example.com ENABLE_NGINX=yes ENABLE_HTTPS=yes CERTBOT_EMAIL=admin@example.com bash
```

继续使用 1Panel 面板部署时，按下面步骤操作。

注意：一键脚本部署和下面的 1Panel 手动源码部署二选一即可。不要一边用一键脚本安装到 `/opt/shiye`，一边又在 1Panel 里用另一套运行环境启动同一项目，否则会出现两个启动方式，排查会很乱。

进入 1Panel：

```text
数据库 -> MySQL -> 创建数据库
```

推荐填写：

```text
数据库名：shiye_management
用户名：shiye
密码：自己生成一个强密码
字符集：utf8mb4
排序规则：utf8mb4_unicode_ci
```

记录连接信息，稍后写入 `.env`。

如果 Node.js 运行环境是容器，`127.0.0.1` 可能指 Node 容器本身，不一定能连到 MySQL。优先使用 1Panel 数据库页面显示的连接地址；如果连接失败，再查看 MySQL 容器名：

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}' | grep -i mysql
```

常见数据库地址可能是 `mysql`、`1panel-mysql`、具体 MySQL 容器名，或 1Panel 显示的内网地址。

## 3. 上传项目

进入 1Panel 文件管理，建议新建目录：

```text
/opt/shiye
```

上传并解压源码后，目录根部必须能看到：

```text
/opt/shiye/package.json
/opt/shiye/apps/
/opt/shiye/packages/
/opt/shiye/prisma/
/opt/shiye/infra/
/opt/shiye/install.sh
```

不要解压成多一层目录，例如：

```text
/opt/shiye/shiye-xuiyonghu/package.json
```

如果多了一层，把里面的所有文件移动到 `/opt/shiye`。

## 4. 配置环境变量

进入服务器终端或 1Panel 终端：

```bash
cd /opt/shiye
cp .env.example .env
```

编辑 `.env`，至少修改：

```env
NODE_ENV=production
PORT=3388
PUBLIC_WEB_URL=https://你的域名
DATABASE_URL=mysql://shiye:你的数据库密码@数据库地址:3306/shiye_management
SESSION_SECRET=换成强随机字符串
ENCRYPTION_KEY=换成32字节base64密钥
CARD_HASH_SECRET=换成强随机字符串
DEFAULT_ADMIN_USERNAME=admin
DEFAULT_ADMIN_PASSWORD=换成强后台密码
```

生成密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`ENCRYPTION_KEY` 必须备份好，丢失后已保存的 3x-ui Token、密码和支付密钥无法解密。

## 5. 安装依赖、初始化数据库和构建

执行：

```bash
cd /opt/shiye
npm ci
npm run install:prod
npm prune --omit=dev
```

注意：不要直接执行 `npm ci --omit=dev` 或 `npm install --omit=dev` 后再构建。前端和 TypeScript 构建需要 devDependencies。正确顺序是先完整安装依赖，构建完成后再 `npm prune --omit=dev`。

## 6. 创建 Node.js 运行环境

进入 1Panel：

```text
运行环境 -> Node.js -> 创建运行环境
```

推荐填写：

```text
名称：shiye-api
Node 版本：20.x
运行目录：/opt/shiye
启动命令：npm start
端口：3388
```

如果 1Panel 允许填写环境变量，可以留空，因为项目会读取 `/opt/shiye/.env`。

启动后测试：

```bash
curl http://127.0.0.1:3388/api/health
curl http://127.0.0.1:3388/api/setup/status
```

如果 Node 运行环境在容器内，`127.0.0.1:3388` 可能只在容器内可见。反代时需要使用 1Panel 给出的运行环境访问地址、容器名或服务器内网 IP。

## 7. 创建网站并配置反向代理/静态目录

进入 1Panel：

```text
网站 -> 创建网站
```

推荐使用 OpenResty/Nginx 配置直接托管前端静态文件，并把 `/api/` 代理到 API。

站点根目录：

```text
/opt/shiye/dist/user-web
```

推荐 Nginx 配置，把 `你的域名` 和路径按实际情况替换：

```nginx
server {
    listen 80;
    server_name 你的域名;

    root /opt/shiye/dist/user-web;
    index index.html;

    location = /api {
        return 301 /api/;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3388/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /admin {
        return 301 /admin/;
    }

    location /admin/assets/ {
        alias /opt/shiye/dist/admin-web/assets/;
        try_files $uri =404;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location /admin/ {
        alias /opt/shiye/dist/admin-web/;
        try_files $uri $uri/ /admin/index.html;
    }

    location /assets/ {
        try_files $uri =404;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

如果 1Panel 的 OpenResty 与 Node.js 运行环境不在同一个网络，`proxy_pass http://127.0.0.1:3388/api/;` 可能访问不到 API。此时把 `127.0.0.1` 改成 Node 运行环境可访问的地址。

## 8. 申请 HTTPS 证书

进入 1Panel：

```text
网站 -> 选择站点 -> HTTPS -> 申请证书
```

申请前确认：

```text
域名 A 记录已经解析到服务器 IP
服务器安全组放行 80 和 443
http://你的域名 可以正常访问
```

证书成功后，建议开启 HTTPS，并把 `.env` 的 `PUBLIC_WEB_URL` 设置为 `https://你的域名`。

## 9. 支付回调地址

本项目只有用户充值余额业务。用户可输入任意金额，支付成功后增加余额，再用余额续费节点。

支付平台回调地址格式：

```text
https://你的域名/api/payments/epay/notify
https://你的域名/api/payments/bepusdt/notify
https://你的域名/api/payments/alipay/notify
https://你的域名/api/payments/wechat/notify
```

支付结果页：

```text
https://你的域名/payment/result?trade_no=订单号
```

## 10. 更新项目

如果使用一键脚本默认精简部署，运行目录不是 Git 仓库，不能直接 `git pull`。推荐重新执行一键脚本，脚本会保留现有 `.env`，重新获取最新项目文件、迁移数据库、构建并重启服务：

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/install.sh)"
```

也可以执行 `shiye`，在“管理面板”菜单里选择：

```text
1. 安装/更新项目
```

只有手动上传完整源码时，才使用下面的源码更新方式。

更新前备份：

```text
MySQL 数据库 shiye_management
/opt/shiye/.env
自定义 Nginx/OpenResty 配置
```

更新命令：

```bash
cd /opt/shiye
git pull
npm ci
npm run install:prod
npm prune --omit=dev
```

然后在 1Panel 里重启 Node.js 运行环境。

## 11. 卸载项目

如果使用一键脚本部署，推荐执行：

```bash
shiye
```

然后选择：

```text
10. 卸载项目
11. 卸载项目并删除数据库
```

也可以直接使用命令。默认卸载程序、systemd 服务和脚本创建的 Nginx 配置，保留数据库：

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/uninstall.sh | bash
```

彻底卸载并删除默认数据库 `shiye_management` 和默认数据库用户 `shiye`：

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/uninstall.sh | env DELETE_DATABASE=yes bash
```

如果是 1Panel 手动源码部署，需要在 1Panel 里停止并删除 Node.js 运行环境、删除对应网站或反向代理配置，再按需删除 `/opt/shiye` 和数据库。删除数据库会清空用户、余额、订单、节点、卡密、支付配置和同步日志，操作前务必备份 `.env` 和 MySQL 数据。

## 12. 常见问题

### 运行环境启动失败，提示找不到 package.json

运行目录填错，或源码多解压了一层。确认运行目录下直接存在：

```text
package.json
apps/
packages/
prisma/
```

### 数据库连接失败

优先检查 `DATABASE_URL`。如果 Node.js 运行环境是容器，`127.0.0.1` 不一定是 MySQL。使用 1Panel 数据库页面提供的连接地址，或者 MySQL 容器名。

### API 正常，但页面 404

检查 Nginx/OpenResty `root` 是否指向 `/opt/shiye/dist/user-web`，并确认已经执行 `npm run install:prod` 生成 `dist`。

### 管理端资源 404

检查 `/admin/assets/` 是否使用 `alias /opt/shiye/dist/admin-web/assets/;`，不要代理到 API。

### 支付回调不到账

检查：

- `.env` 的 `PUBLIC_WEB_URL` 是否是公网 HTTPS 域名
- 支付平台回调地址是否是 `/api/payments/:provider/notify`
- Nginx/OpenResty 是否正确把 `/api/` 代理到 API
- 后台支付通道密钥和签名方式是否正确

## 13. 备份建议

至少备份：

```text
MySQL 数据库 shiye_management
/opt/shiye/.env
Nginx/OpenResty 站点配置
```

`.env` 里的 `ENCRYPTION_KEY` 必须保留，否则加密字段无法恢复。
