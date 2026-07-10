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

服务器项目根目录执行：

```bash
sudo bash install.sh
```

带域名和 HTTPS：

```bash
sudo DOMAIN=panel.example.com ENABLE_NGINX=yes ENABLE_HTTPS=yes bash install.sh
```

从 GitHub 仓库直接部署：

```bash
sudo REPO_URL=https://github.com/wstimin/shiye-3xuigl-L3.git DOMAIN=panel.example.com bash install.sh
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

## 支付业务

本项目支付只用于用户充值余额。用户可输入任意充值金额，支付成功后系统增加用户余额，用户再使用余额去续费节点。

支付回调地址格式：

```text
https://你的域名/api/payments/epay/notify
https://你的域名/api/payments/bepusdt/notify
https://你的域名/api/payments/alipay/notify
https://你的域名/api/payments/wechat/notify
```

## 安全说明

- 3x-ui 密码和 Token 使用 `ENCRYPTION_KEY` 加密保存。
- `SESSION_SECRET`、`ENCRYPTION_KEY`、`CARD_HASH_SECRET` 生产环境必须使用强随机值。
- 安装后请修改默认管理员密码。
- 生产环境建议通过 Nginx 提供 HTTPS，只暴露 `80/443`。
- 备份时必须同时保留 MySQL 数据和 `.env`，否则加密字段无法恢复。
