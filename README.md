# 十夜 3-xui 用户管理系统

这是一个对接 3-xui 的用户管理面板，支持用户节点管理、余额充值、自助续费、卡密兑换、支付回调入账、到期停用、3-xui 同步、SOCKS 中转和同步日志。

当前版本已经改为生产环境 MySQL 存储，不再使用 JSON 作为业务数据库。

## 功能概览

- 管理用户资料、节点价格、到期时间、流量限制和账号状态
- 用户端支持卡密兑换余额、在线支付充值、余额续费和查看自己的记录
- 管理员可手动增加、扣减或设置用户余额，并自动生成余额流水
- 支持充值订单、余额流水、续费记录和同步日志
- 支持卡密批次管理、分类复制、继续生成、重命名和删除未使用卡密
- 支持多个 3-xui 节点和多个 SOCKS 出站节点
- 支持同步用户到 3-xui client
- 支持自动创建 VLESS 入站
- 支持 TCP、Reality、TLS、WebSocket、gRPC 等入站模板
- 支持支付宝开放平台直连支付，可分别启用电脑网站、H5、当面付扫码
- 支持微信支付官方 V3，可分别启用 Native 扫码和 H5 支付
- 支持彩虹易支付接口，可启用支付宝、微信、PayPal、USDT 等聚合通道
- 支持 BEpusdt USDT 收款
- 支付回调会校验签名，回调成功后自动给用户余额入账
- 用户自助续费采用严格逻辑：先同步 3-xui 成功，再扣余额并顺延本地到期时间
- 管理员入口和用户入口分离，默认管理员入口为 `/admin`
- 支持 `ADMIN_PATH` 自定义管理员后台路径
- 敏感字段本地加密保存

本项目按 3-xui 3.4.1 版本开发和测试。其他 3-xui 版本通常也可以接入，但不同版本或魔改版的 API 路径、字段可能存在差异，建议部署后先在后台测试节点连接和同步功能。

## 一键安装

在 Linux 服务器上执行：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

脚本会自动检测系统环境，安装或检查 Node.js 20、Git、基础依赖和 MySQL/MariaDB 兼容服务，写入 systemd 服务并启动项目。安装过程中会询问是否安装 Nginx 反向代理和是否申请 HTTPS 证书，你可以选择启用域名访问，也可以跳过，继续使用 `http://服务器IP:3388` 访问。

如果你要明确跳过 Nginx 和证书，直接使用 IP + 端口访问：

```bash
ENABLE_NGINX=no \
bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

访问地址：

```text
用户入口：http://服务器IP:3388/
管理员入口：http://服务器IP:3388/admin
```

如果你已经把域名解析到服务器，并且只想安装 Nginx 反向代理，暂时不申请证书：

```bash
ENABLE_NGINX=yes \
ENABLE_HTTPS=no \
DOMAIN=panel.example.com \
bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

访问地址：

```text
用户入口：http://panel.example.com/
管理员入口：http://panel.example.com/admin
```

如果你要安装 Nginx 并自动申请 Let's Encrypt HTTPS 证书：

```bash
ENABLE_NGINX=yes \
ENABLE_HTTPS=yes \
DOMAIN=panel.example.com \
CERTBOT_EMAIL=admin@example.com \
bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

访问地址：

```text
用户入口：https://panel.example.com/
管理员入口：https://panel.example.com/admin
```

申请证书前请确认域名已经解析到当前服务器，服务器安全组或防火墙已经放行 `80` 和 `443`。如果只用 IP + 端口访问，需要放行项目端口，默认是 `3388`。

如果你是解压完整 zip 包后在项目目录执行 `bash install.sh`，脚本会优先使用当前目录里的文件，不会再去拉默认 GitHub 仓库。

如果你要从其他 GitHub 仓库远程安装，可以覆盖 `REPO_URL`：

```bash
REPO_URL=https://github.com/你的用户名/你的仓库.git \
bash <(curl -fsSL https://raw.githubusercontent.com/你的用户名/你的仓库/main/install.sh)
```

如果你已经准备好了 MySQL，也可以手动传入数据库信息：

```bash
MYSQL_HOST=127.0.0.1 \
MYSQL_PORT=3306 \
MYSQL_USER=shiye \
MYSQL_PASSWORD='请换成强密码' \
MYSQL_DATABASE=shiye_management \
ADMIN_PATH=/admin \
bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

如果服务器本机 MySQL 的 root 账号设置了密码，可以在一键安装时传入：

```bash
MYSQL_ROOT_PASSWORD='你的MySQLRoot密码' \
bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

默认管理员账号：

```text
账号：admin
密码：admin123
```

公网部署后建议登录后台，在“账号安全”里修改默认账号和密码。

## 支付配置

进入管理员后台后，在“系统设置”里点击“添加支付方式”，先选择支付大类，再填写该大类下面的具体通道配置。用户端不会展示这些具体通道，只显示支付宝、微信支付、PayPal、USDT 四个大类；用户选择大类后，系统会自动跳转到后台已启用的可用通道。

支持的支付方式：

- 支付宝开放平台直连支付：电脑网站支付 `alipay.trade.page.pay`、手机网站/H5 支付 `alipay.trade.wap.pay`、当面付扫码 `alipay.trade.precreate`
- 微信支付官方 V3：Native 扫码 `/v3/pay/transactions/native`、H5 支付 `/v3/pay/transactions/h5`
- 彩虹易支付聚合：支付宝、微信、PayPal、USDT，可按通道分别启用并填写对应 `type`
- BEpusdt：USDT 收款，支持填写应用 URI、Token/KEY 和支付类型

需要准备的信息：

- 公网可访问的网站地址，生产环境建议使用 HTTPS，支付平台必须能访问异步回调地址
- 支付宝 App ID、应用私钥、支付宝公钥。生产网关默认是 `https://openapi.alipay.com/gateway.do`；沙箱测试请换成沙箱网关，并使用沙箱 App ID 与密钥
- 微信支付 AppID、商户号、APIv3 密钥、商户 API 证书序列号、商户 API 私钥、微信支付平台公钥和平台公钥 ID
- 易支付网关地址、PID、签名方式、商户密钥或 RSA 公钥/私钥，以及支付宝、微信、PayPal、USDT 对应的 `type`
- BEpusdt 应用 URI、对接令牌 Token/KEY、支付类型 `type`

默认回调地址：

```text
支付宝异步回调：https://你的域名/api/payments/alipay/notify
微信支付异步回调：https://你的域名/api/payments/wechat/notify
易支付异步回调：https://你的域名/api/payments/epay/notify
BEpusdt 异步回调：https://你的域名/api/payments/bepusdt/notify
支付结果页面：https://你的域名/payment/result?trade_no={trade_no}
```

如果后台没有单独填写回调地址，系统会根据“公网网站地址”自动拼接。支付成功后会校验签名、订单号、金额和状态，校验通过才会给用户余额入账，重复回调不会重复加款。

## MySQL 说明

系统会使用 MySQL 分表保存数据，包括：

- 系统设置
- 用户资料
- 3-xui 节点
- SOCKS 节点
- 卡密和卡密批次
- 充值订单
- 余额流水
- 续费记录
- 同步日志

卡密兑换、在线充值入账、用户余额变动和自助续费都通过事务保护，避免重复入账和刷余额、刷时间。

## 1Panel / 宝塔说明

面板部署仍按 Node.js 项目部署即可，先在 1Panel 或宝塔里创建 MySQL 数据库和账号，然后上传项目、安装依赖并启动服务，默认端口是 `3388`。

如果想使用网页安装向导，不要提前配置 `MYSQL_HOST`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_DATABASE` 或 `DATABASE_URL`。系统在没有数据库环境变量，并且不存在 `data/config.json` 时，会在首次访问管理员入口时进入安装向导。

如果使用一键安装脚本，脚本会自动安装或连接 MySQL 并写入数据库配置，安装完成后通常不会再显示网页安装向导。

## 3-xui 节点填写说明

如果你的 3-xui 面板地址是：

```text
http://example.com:2053/
```

后台填写：

```text
协议：http
地址：example.com
端口：2053
基础路径：/
API Token：填写 3-xui 里的 API Token
```

如果你的 3-xui 面板地址是：

```text
https://example.com:2053/panelpath/
```

后台填写：

```text
协议：https
地址：example.com
端口：2053
基础路径：/panelpath
API Token：填写 3-xui 里的 API Token
```

推荐优先使用 API Token。账号和密码可以留空。

## 常用命令

```bash
systemctl status shiye-management-system
systemctl restart shiye-management-system
journalctl -u shiye-management-system -f
```

手动检查语法：

```bash
node --check server.js
node --check public/app.js
node --check public/user.js
```

## 安全建议

- 公网使用建议配置 HTTPS
- 修改默认管理员账号和密码
- 不要公开 `data/.secret`、`data/config.json` 和 `/etc/default/shiye-management-system`
- 不要公开 3-xui API Token、支付密钥、支付宝私钥和易支付商户密钥
- 如果不用 Nginx，安全组需要放行 `3388`
- 如果使用 Nginx 反向代理，建议只放行 `80/443`，不要公开 `3388`

## 更多部署说明

查看 [DEPLOY.md](./DEPLOY.md)。

如果需要卸载服务器上的一键安装版本，查看 [UNINSTALL.md](./UNINSTALL.md)。
