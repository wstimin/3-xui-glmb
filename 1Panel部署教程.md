# 十夜 3x-ui 用户管理系统 1Panel 部署教程

本文只讲 1Panel 面板部署。当前项目是新架构版本：NestJS API、Vue 管理端、Vue 用户端、MySQL、Prisma。

1Panel 面板部署推荐上传 Linux 预构建部署包。创建 Node.js 运行环境后，启动命令填写 `npm start`，首次打开会进入安装向导；安装完成并重启运行环境后，`npm start` 会自动进入正式 API。完整源码也可以部署，但会在服务器上重新构建，耗时更长。

## 1. 准备条件

需要准备：

- 一台已经安装 1Panel 的 Linux 服务器
- 1Panel 应用商店里的 MySQL 或 MariaDB
- 1Panel 运行环境里的 Node.js，建议 Node.js 20+
- OpenResty/Nginx 网站功能
- 一个域名，推荐使用 HTTPS
- 本项目 Linux 预构建部署包，或完整源码

默认信息：

```text
项目目录：/opt/shiye
API 端口：3388
用户端入口：https://你的域名/
管理端入口：https://你的域名/admin/
API 前缀：https://你的域名/api/
```

## 2. 选择部署方式和创建数据库

如果你想不用面板手动上传部署包，也可以在 1Panel 终端直接执行一键脚本。下面命令默认在 `root` 用户下执行；如果当前不是 `root`，请先切换到 `root` 用户。脚本默认优先下载 Linux 预构建包，包不可用时回退源码构建；安装为 `IP:3388` 访问，安装完成后可通过 `shiye` 菜单第 6 项配置域名、Nginx 和 HTTPS。

一键脚本默认是精简运行目录：优先使用预构建运行文件，安装完成后只保留运行必需项，不会把 README、部署文档、安装脚本、前后端源码和 `.git` 长期留在服务器运行目录。

默认构建包地址：`https://github.com/wstimin/shiye-3xuigl-L3/releases/latest/download/shiye-3xuigl.zip`

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/install.sh | env PACKAGE_URL=https://github.com/wstimin/shiye-3xuigl-L3/releases/latest/download/shiye-3xuigl.zip INSTALL_SOURCE=auto bash
```

一键脚本部署成功后，项目由 systemd 服务 `shiye-api` 管理，不需要再到 1Panel 里创建 Node.js 运行环境。服务器上可以随时打开管理菜单：

```bash
shiye
```

菜单标题只显示“管理面板”，可执行安装/更新、查看当前配置、查看状态、重启、日志、配置或取消域名、更新/重装运行文件、数据库迁移、备份和卸载。

也可以提前带入域名和 HTTPS 参数：

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/install.sh | env PACKAGE_URL=https://github.com/wstimin/shiye-3xuigl-L3/releases/latest/download/shiye-3xuigl.zip INSTALL_SOURCE=auto DOMAIN=panel.example.com ENABLE_NGINX=yes ENABLE_HTTPS=yes CERTBOT_EMAIL=admin@example.com bash
```

继续使用 1Panel 面板部署时，按下面步骤操作。

注意：一键脚本部署和下面的 1Panel 手动部署二选一即可。不要一边用一键脚本安装到 `/opt/shiye`，一边又在 1Panel 里用另一套运行环境启动同一项目，否则会出现两个启动方式，排查会很乱。

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

上传并解压 Linux 预构建部署包后，目录根部必须能看到：

```text
/opt/shiye/package.json
/opt/shiye/apps/
/opt/shiye/packages/
/opt/shiye/dist/
/opt/shiye/prisma/
/opt/shiye/infra/
/opt/shiye/install.sh
```

预构建包里必须已经包含这些运行文件：

```text
/opt/shiye/apps/api/dist/main.js
/opt/shiye/packages/shared/dist/index.js
/opt/shiye/packages/xui-client/dist/index.js
/opt/shiye/packages/payment-core/dist/index.js
/opt/shiye/dist/user-web/index.html
/opt/shiye/dist/admin-web/index.html
```

不要解压成多一层目录，例如：

```text
/opt/shiye/shiye-xuiyonghu/package.json
```

如果多了一层，把里面的所有文件移动到 `/opt/shiye`。

## 4. 创建 Node.js 运行环境

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

如果 1Panel 允许填写环境变量，可以留空。首次启动时，项目会打开网页安装向导并自动生成 `/opt/shiye/.env`。

如果 1Panel 创建 Node.js 运行环境时有“安装命令”，可以填写：

```bash
npm ci
```

不要填写 `npm ci --omit=dev`。首次安装需要 Prisma、seed 等安装工具；即使这里不填，网页安装向导也会在“开始安装”时自动执行 `npm ci`，完成初始化后再执行 `npm prune --omit=dev`。

## 5. 打开网页安装向导

运行环境启动后，浏览器访问：

```text
http://服务器IP:3388
```

如果已经先绑定了域名，也可以访问你的域名。页面会要求填写：

```text
端口：3388
数据库地址：例如 mysql、1panel-mysql 或数据库页面显示的内网地址
数据库端口：3306
数据库名：shiye_management
数据库用户名：shiye
数据库密码：你创建数据库时设置的密码
管理员账号：admin
管理员密码：你要设置的后台密码
```

安装向导会自动生成：

```text
SESSION_SECRET
JWT_SECRET
ENCRYPTION_KEY
CARD_HASH_SECRET
```

点击“保存配置”，再点击“开始安装”。使用预构建包时，安装过程会执行：检查配置、生成 Prisma Client、迁移数据库、初始化管理员、部署检查，最后清理开发依赖；不会在服务器上重新构建 API/管理端/用户端。只有上传完整源码时，才会执行源码构建流程。

安装完成后，回到 1Panel 重启这个 Node.js 运行环境。重启后 `npm start` 会检测到已经安装完成，并直接启动正式 API。

`ENCRYPTION_KEY` 会写入 `/opt/shiye/.env`，必须备份好。丢失后，已保存的 3x-ui Token、密码和支付密钥无法解密。

## 6. 验证运行状态

重启后测试：

```bash
curl http://127.0.0.1:3388/api/health
curl http://127.0.0.1:3388/api/setup/status
```

如果 Node 运行环境在容器内，`127.0.0.1:3388` 可能只在容器内可见。反代时需要使用 1Panel 给出的运行环境访问地址、容器名或服务器内网 IP。

## 7. 创建网站并配置整站反向代理

进入 1Panel：

```text
网站 -> 创建网站
```

当前版本由 Node.js 一个端口同时提供用户端、管理端和 API：

```text
用户端：https://你的域名/
管理端：https://你的域名/admin/
API：https://你的域名/api/
```

所以 1Panel 里只需要把整个网站反向代理到 Node.js 运行环境端口，不需要单独配置 `/api/`，也不需要把站点根目录指向 `dist/user-web`。

推荐配置：

```text
反向代理目标：http://127.0.0.1:3388
```

如果 1Panel 的 OpenResty 与 Node.js 运行环境不在同一个网络，`127.0.0.1:3388` 可能访问不到 Node.js 服务。此时把目标地址改成 1Panel 给出的 Node.js 运行环境访问地址、容器名或服务器内网 IP。

手动写 Nginx/OpenResty 配置时，只需要下面这一类整站代理配置，把 `你的域名` 按实际情况替换：

```nginx
server {
    listen 80;
    server_name 你的域名;

    location / {
        proxy_pass http://127.0.0.1:3388;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

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

如果使用一键脚本默认精简部署，运行目录不是 Git 仓库，不能直接 `git pull`。推荐重新执行一键脚本，脚本会保留现有 `.env`，优先获取最新预构建包、迁移数据库、校验并重启服务；如果预构建包不可用，会回退源码构建：

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/install.sh | env PACKAGE_URL=https://github.com/wstimin/shiye-3xuigl-L3/releases/latest/download/shiye-3xuigl.zip INSTALL_SOURCE=auto bash
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
11. 卸载项目
12. 卸载项目并删除数据库
```

也可以直接使用命令。默认卸载程序、systemd 服务和脚本创建的 Nginx 配置，保留数据库：

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/uninstall.sh | bash
```

彻底卸载并删除默认数据库 `shiye_management` 和默认数据库用户 `shiye`：

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/uninstall.sh | env DELETE_DATABASE=yes bash
```

如果是 1Panel 手动部署，需要在 1Panel 里停止并删除 Node.js 运行环境、删除对应网站或反向代理配置，再按需删除实际项目目录和数据库。删除数据库会清空用户、余额、订单、节点、卡密、支付配置和同步日志，操作前务必备份 `.env` 和 MySQL 数据。

## 12. 常见问题

### 运行环境启动失败，提示找不到 package.json

运行目录填错，或部署包多解压了一层。确认运行目录下直接存在：

```text
package.json
apps/
packages/
prisma/
```

### 数据库连接失败

优先检查 `DATABASE_URL`。如果 Node.js 运行环境是容器，`127.0.0.1` 不一定是 MySQL。使用 1Panel 数据库页面提供的连接地址，或者 MySQL 容器名。

### API 正常，但页面 404

检查网站是否整站反向代理到 Node.js 服务，例如 `http://127.0.0.1:3388`。当前版本不需要在 Nginx/OpenResty 里直接托管 `dist/user-web`。

### 管理端资源 404

检查反向代理是否保留完整路径并转发到同一个 Node.js 服务。当前版本不需要单独配置 `/admin/assets/`。

### 支付回调不到账

检查：

- `.env` 的 `PUBLIC_WEB_URL` 是否是公网 HTTPS 域名
- 支付平台回调地址是否是 `/api/payments/:provider/notify`
- Nginx/OpenResty 是否把整个网站反向代理到 Node.js 服务
- 后台支付通道密钥和签名方式是否正确

## 13. 备份建议

至少备份：

```text
MySQL 数据库 shiye_management
/opt/shiye/.env
Nginx/OpenResty 站点配置
```

`.env` 里的 `ENCRYPTION_KEY` 必须保留，否则加密字段无法恢复。
