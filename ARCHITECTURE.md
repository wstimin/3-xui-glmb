# 架构说明

当前项目已经完成到新架构：NestJS API、Vue 管理端、Vue 用户端、MySQL、Prisma。旧版 `server.js` 和 `public/` 静态页入口已经移除，不再作为生产部署或功能入口。

## 目标结构

```text
apps/
  api/          NestJS + TypeScript 后端 API
  admin-web/    Vue3 + Vite + TypeScript 管理后台
  user-web/     Vue3 + Vite + TypeScript 用户中心
packages/
  shared/       前后端共享 DTO、类型和校验规则
  xui-client/   3x-ui API SDK
  payment-core/ 支付通道统一抽象
prisma/
  schema.prisma 结构化 MySQL 数据模型
infra/
  nginx/        反向代理配置
  systemd/      裸机部署服务配置
scripts/
  install.mjs   生产初始化、迁移、seed、构建检查
```

## 技术选型

- 后端：NestJS + TypeScript
- 前端：Vue3 + Vite + TypeScript
- 数据库：MySQL + Prisma migrations
- 部署：Nginx/OpenResty、systemd、Docker Compose、宝塔/1Panel 文档

## 生产入口

- API 服务：`apps/api`
- 管理后台：`apps/admin-web`
- 用户中心：`apps/user-web`
- 数据库结构：`prisma/schema.prisma`
- 一键脚本：`install.sh`
- 部署文档：`DEPLOY.md`、`部署教程.md`、`宝塔部署教程.md`、`1Panel部署教程.md`
- 卸载文档：`UNINSTALL.md`

## 部署原则

1. 生产环境只使用新架构入口，不再启动旧版单文件服务。
2. 支付只负责用户任意金额充值余额，余额再用于续费。
3. 3x-ui 对接集中在 `packages/xui-client` 和 API 服务层。
4. 用户、节点、订单、余额、卡密、日志等核心数据使用结构化 MySQL 表。
5. 管理端和用户端独立构建，分别服务于 `/admin` 和 `/`。

## 常用命令

```bash
npm install
npm run typecheck
npm run build
npm run dev:api
npm run dev:admin
npm run dev:user
npm run prisma:generate
npm run prisma:dev
```

## 当前状态

- monorepo workspace 已建立。
- API 模块边界已建立。
- Prisma schema 和迁移已建立。
- 管理端和用户端 Vue 应用已建立。
- `packages/shared`、`packages/xui-client`、`packages/payment-core` 已建立。
- 旧版 `server.js`、`public/` 和本地旧配置缓存已经清理。
