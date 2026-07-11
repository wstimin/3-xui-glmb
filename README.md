# 视野 3x-ui 用户管理系统

这是重塑后的新架构版本，用于管理 3x-ui 用户节点、余额、卡密、续费、同步日志和充值支付。生产入口以 `apps/*`、`packages/*`、`prisma/*` 为准，旧版 `server.js` 不作为生产部署入口。

## 架构

- 后端：NestJS + TypeScript
- 前端：Vue 3 + Vite + TypeScript
- 数据库：MySQL + Prisma
- 登录：HttpOnly Cookie + JWT
- 共享校验：Zod
- 3x-ui 接入：`packages/xui-client`
- 支付抽象：`packages/payment-core`

## 目录

- `apps/api`：后端 API
- `apps/admin-web`：管理员后台
- `apps/user-web`：用户端
- `packages/shared`：共享类型和校验 schema
- `packages/xui-client`：3x-ui API 客户端
- `packages/payment-core`：支付通道抽象
- `prisma`：数据库 schema、迁移和 seed
- `infra`：Nginx、systemd 示例配置
- `scripts`：安装检查和生产安装编排

## 一键部署

服务器上直接执行，默认安装到 `/opt/shiye`，服务名 `shiye-api`。下面命令默认在 `root` 用户下执行；如果当前不是 `root`，请先切换到 `root` 用户。脚本会询问访问方式：选择跳过域名就是 `IP:3388` 访问；选择域名访问会继续输入域名，并可自动申请 HTTPS 证书。

一键脚本默认是精简运行目录：构建时只获取必要项目文件，安装完成后 `/opt/shiye` 只保留运行必需文件，例如 `.env`、`dist`、`node_modules`、`package*.json`、`apps/api/dist`、`packages/*/dist`、`prisma/schema.prisma` 和迁移文件。README、部署文档、安装脚本、前端源码、后端源码和 `.git` 默认不会保留在服务器运行目录。

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/install.sh)"
```

安装完成后脚本会写入管理菜单命令，服务器上可随时执行：

```bash
shiye
```

菜单标题只显示“管理面板”，包含安装/更新项目、查看当前配置、查看状态、重启服务、查看日志、配置或取消域名、重新构建、数据库迁移、备份和卸载入口。

也可以提前带入域名和 HTTPS 参数，直接部署：

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/install.sh | env DOMAIN=panel.example.com ENABLE_NGINX=yes ENABLE_HTTPS=yes CERTBOT_EMAIL=admin@example.com bash
```

服务器项目根目录执行：

```bash
bash install.sh
```

带域名和 HTTPS：

```bash
DOMAIN=panel.example.com ENABLE_NGINX=yes ENABLE_HTTPS=yes bash install.sh
```

一键卸载，默认保留数据库：

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/uninstall.sh | bash
```

彻底卸载并删除默认数据库：

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/uninstall.sh | env DELETE_DATABASE=yes bash
```

详细说明见 [DEPLOY.md](./DEPLOY.md)。

## 手动部署

```bash
npm ci
cp .env.example .env
npm run install:prod
npm prune --omit=dev
npm start
```

编辑 `.env` 时至少替换：

- `DATABASE_URL`
- `PUBLIC_WEB_URL`
- `SESSION_SECRET`
- `ENCRYPTION_KEY`
- `CARD_HASH_SECRET`
- `DEFAULT_ADMIN_PASSWORD`

生成 32 字节 base64 密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## 常用命令

```bash
npm run dev:api
npm run dev:admin
npm run dev:user
npm run typecheck
npm run build
npm run deploy:check
npm run db:deploy
npm run install:check
```

## 访问入口

- 用户端：`/`
- 管理端：`/admin/`
- API：`/api`

## 节点业务

- 一个客户可以绑定多个不同服务节点，每个绑定记录都有独立的到期时间、流量限制和续费记录。
- 管理员绑定、解绑、删除节点和续费时，会按对应节点同步到远端 3x-ui。
- 用户端按节点单独续费；节点链接不明文展示，只提供复制按钮和基于真实节点链接生成的二维码。
- 系统每 10 分钟检查一次已到期且仍启用的用户节点，远端 3x-ui 停用成功后才更新本地状态；管理员也可以在概览页手动执行。
- 已停用或已到期的用户节点允许继续续费，续费成功后本地状态恢复为启用，并同步启用远端 3x-ui 客户端。

## 支付业务

本项目支付只用于用户充值余额。用户可输入任意充值金额，支付成功后系统增加用户余额，用户再使用余额去续费节点。

当前后台可配置并可发起下单的在线支付通道：易支付、BEpusdt、支付宝官方接口、微信支付 V2 Native 扫码。支付宝官方接口支持当面付扫码、PC 网站支付、手机网站支付，均只用于充值余额。支付回调地址格式：

```text
https://你的域名/api/payments/epay/notify
https://你的域名/api/payments/bepusdt/notify
https://你的域名/api/payments/alipay/notify
https://你的域名/api/payments/wechat/notify
```

支付宝官方通道需要配置 AppID、应用私钥、支付宝公钥，并在后台选择接口类型 `precreate`、`page` 或 `wap`；微信官方通道需要配置 AppID、商户号、V2 API 密钥。支付宝/微信官方通道必须使用公网可访问的完整回调地址，建议部署 HTTPS 域名并设置 `PUBLIC_WEB_URL`。

## 安全说明

- 3x-ui 密码和 Token 使用 `ENCRYPTION_KEY` 加密保存。
- `SESSION_SECRET`、`ENCRYPTION_KEY`、`CARD_HASH_SECRET` 生产环境必须使用强随机值。
- 安装后请修改默认管理员密码。
- 生产环境建议通过 Nginx 提供 HTTPS，只暴露 `80/443`。
- 备份时必须同时保留 MySQL 数据和 `.env`，否则加密字段无法恢复。
