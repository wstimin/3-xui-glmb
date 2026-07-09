# 十夜 3-xui 用户管理系统部署教程

本教程适合把系统部署到 Linux 服务器。系统可以直接通过 HTTP 访问，也可以配合 Nginx 和 HTTPS 使用。

## 1. 推荐部署方式

直接执行一键安装命令：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

脚本会自动完成：

- 检查 root、systemd 和包管理器
- 安装 curl、ca-certificates、git、openssl 等基础依赖
- 检查或安装 Node.js 20+
- 未提供外部 MySQL 配置时，自动安装本机 MySQL/MariaDB 兼容服务
- 创建数据库、数据库用户和随机密码
- 拉取项目到 `/opt/shiye-management-system`
- 优先执行 `npm ci --omit=dev`，失败时回退到 `npm install --omit=dev`
- 执行 `node --check server.js`、`node --check public/app.js` 和 `node --check public/user.js`
- 写入 `/etc/default/shiye-management-system`
- 创建并启动 systemd 服务
- 可选择安装 Nginx 反向代理
- 可选择通过 Certbot 自动申请 Let's Encrypt HTTPS 证书

如果你是解压完整 zip 包后在项目目录执行 `bash install.sh`，脚本会优先使用当前目录里的文件，不会再去拉默认 GitHub 仓库。

如果你把项目推送到了自己的 GitHub 仓库，可以覆盖 `REPO_URL`：

```bash
REPO_URL=https://github.com/你的用户名/你的仓库.git \
bash <(curl -fsSL https://raw.githubusercontent.com/你的用户名/你的仓库/main/install.sh)
```

### 安装模式选择

默认执行安装脚本时，会询问是否安装 Nginx 和是否申请 HTTPS 证书。你也可以通过环境变量提前指定，适合复制命令直接部署。

只使用 HTTP + IP + 端口访问，不安装 Nginx：

```bash
ENABLE_NGINX=no \
bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

安装 Nginx，使用域名访问，但暂时不申请 HTTPS 证书：

```bash
ENABLE_NGINX=yes \
ENABLE_HTTPS=no \
DOMAIN=panel.example.com \
bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

安装 Nginx，并自动申请 HTTPS 证书：

```bash
ENABLE_NGINX=yes \
ENABLE_HTTPS=yes \
DOMAIN=panel.example.com \
CERTBOT_EMAIL=admin@example.com \
bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

参数说明：

- `ENABLE_NGINX=no`：跳过 Nginx，安装完成后用 `http://服务器IP:3388` 访问
- `ENABLE_NGINX=yes`：安装并配置 Nginx，把域名反向代理到本机 `3388` 端口
- `ENABLE_HTTPS=no`：只配置 HTTP 域名访问，不申请证书
- `ENABLE_HTTPS=yes`：调用 Certbot 申请 Let's Encrypt 证书，并自动把 Nginx 改成 HTTPS 跳转
- `DOMAIN=panel.example.com`：你的访问域名，启用 Nginx 时必须填写
- `CERTBOT_EMAIL=admin@example.com`：证书通知邮箱，可不填；不填时 Certbot 会使用无邮箱注册模式

申请证书前必须确认：

- 域名 A 记录已经解析到当前服务器公网 IP
- 服务器安全组或防火墙已经放行 `80` 和 `443`
- 服务器上没有其他 Nginx/网站配置占用同一个域名
- 如果你选择跳过 Nginx，需要放行项目端口，默认是 `3388`

## 2. 使用已有 MySQL

如果你已经有 MySQL，可以先创建数据库和用户：

```sql
CREATE DATABASE shiye_management CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'shiye'@'127.0.0.1' IDENTIFIED BY '请换成强密码';
GRANT ALL PRIVILEGES ON shiye_management.* TO 'shiye'@'127.0.0.1';
FLUSH PRIVILEGES;
```

然后执行：

```bash
MYSQL_HOST=127.0.0.1 \
MYSQL_PORT=3306 \
MYSQL_USER=shiye \
MYSQL_PASSWORD='请换成强密码' \
MYSQL_DATABASE=shiye_management \
ADMIN_PATH=/admin \
bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

也可以使用 `DATABASE_URL`：

```bash
DATABASE_URL='mysql://shiye:请换成强密码@127.0.0.1:3306/shiye_management' \
bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

如果服务器本机 MySQL 的 root 账号设置了密码，可以传入 `MYSQL_ROOT_PASSWORD`，脚本会用它创建数据库和数据库用户：

```bash
MYSQL_ROOT_PASSWORD='你的MySQLRoot密码' \
bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

## 3. 访问入口

如果跳过 Nginx，安装完成后访问：

```text
用户入口：http://服务器IP:3388/
管理员入口：http://服务器IP:3388/admin
```

如果启用了 Nginx 但没有申请证书，访问：

```text
用户入口：http://你的域名/
管理员入口：http://你的域名/admin
```

如果启用了 Nginx 并申请了 HTTPS 证书，访问：

```text
用户入口：https://你的域名/
管理员入口：https://你的域名/admin
```

如果你自定义了 `ADMIN_PATH`，管理员入口里的 `/admin` 要换成你设置的路径。

默认管理员账号：

```text
账号：admin
密码：admin123
```

普通用户不能自行注册，只能使用管理员在“用户管理”里创建的账号密码登录。

## 4. 自定义管理员入口

默认管理员入口是 `/admin`。安装时可以修改：

```bash
ADMIN_PATH=/myadmin2026 bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

修改后访问：

```text
http://服务器IP:3388/myadmin2026
```

自定义路径只能减少后台暴露，不等于替代密码。真正权限仍由管理员登录校验控制。

## 5. 自定义端口、目录和服务名

自定义端口：

```bash
PORT=8080 bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

如果跳过 Nginx，公网访问端口也会变成你设置的端口，例如 `http://服务器IP:8080`。如果启用了 Nginx，Nginx 会反向代理到这个端口，公网仍然访问 `80/443`。

自定义安装目录：

```bash
APP_DIR=/opt/my-shiye-panel bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

自定义服务名：

```bash
APP_NAME=x-uiguanli bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

## 6. 常用运行命令

查看服务状态：

```bash
systemctl status shiye-management-system
```

重启服务：

```bash
systemctl restart shiye-management-system
```

停止服务：

```bash
systemctl stop shiye-management-system
```

查看实时日志：

```bash
journalctl -u shiye-management-system -f
```

查看最近日志：

```bash
journalctl -u shiye-management-system -n 100 --no-pager
```

查看端口监听：

```bash
ss -lntp | grep 3388
```

本机测试访问：

```bash
curl -i http://127.0.0.1:3388/
curl -i http://127.0.0.1:3388/admin
```

查看服务环境配置：

```bash
cat /etc/default/shiye-management-system
```

修改配置后重启：

```bash
nano /etc/default/shiye-management-system
systemctl restart shiye-management-system
```

## 7. 1Panel / 宝塔部署和网页安装向导

1Panel、宝塔等面板部署方式仍然是 Node.js 项目 + MySQL 数据库 + 反向代理。推荐流程：

1. 在面板里创建 MySQL 数据库和数据库账号
2. 上传或拉取项目代码
3. 在项目目录执行 `npm install --omit=dev`
4. 启动命令填写 `npm start` 或 `node server.js`
5. 项目端口填写 `3388`，如已自定义 `PORT`，则填写自定义端口
6. 在面板网站里把域名反向代理到 `http://127.0.0.1:3388`
7. 首次访问管理员入口，例如 `https://你的域名/admin`，按页面提示完成安装向导

如果你想使用网页安装向导，不要提前在面板环境变量里填写 `MYSQL_HOST`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_DATABASE` 或 `DATABASE_URL`。系统只有在没有检测到这些数据库环境变量，并且不存在 `data/config.json` 时，才会显示安装向导。

如果你使用一键安装脚本，脚本会自动写入数据库配置并初始化数据库，所以安装完成后通常不会再出现网页安装向导，这是正常现象。

网页安装向导需要填写：

```text
数据库地址
数据库端口
数据库名称
数据库账号
数据库密码
```

如果数据库账号有建库权限，系统会尝试自动创建数据库；如果没有建库权限，请先在面板里创建数据库和账号，再把信息填入安装向导。面板环境下更推荐先创建好数据库和账号，再通过向导填写这些信息。

安装完成后，配置会保存到：

```text
data/config.json
```

这个文件包含数据库连接信息，备份和迁移时要保留，不要公开。

支付回调、登录和后台管理建议使用 HTTPS 域名。支付宝、易支付等平台必须能从公网访问你的异步回调地址，否则支付成功后无法自动入账。

## 8. 手动安装

安装 Node.js 20：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs git
node -v
```

下载项目：

```bash
cd /opt
git clone https://github.com/wstimin/3-xuiguanli-shangye.git shiye-management-system
cd /opt/shiye-management-system
npm install --omit=dev
```

语法检查：

```bash
node --check server.js
node --check public/app.js
node --check public/user.js
```

临时启动：

```bash
PORT=3388 \
ADMIN_PATH=/admin \
MYSQL_HOST=127.0.0.1 \
MYSQL_PORT=3306 \
MYSQL_USER=shiye \
MYSQL_PASSWORD='请换成强密码' \
MYSQL_DATABASE=shiye_management \
node server.js
```

## 9. 支付配置

后台进入“系统设置”，点击“添加支付方式”维护支付通道。后台可以同时配置同一大类下的多个具体方式，例如支付宝电脑网站、支付宝 H5、支付宝当面付；用户端只显示支付宝、微信支付、PayPal、USDT 四个大类，用户选择大类后由系统自动匹配已启用的具体通道。

### 支付宝开放平台直连

可启用的分类：

- 电脑网站支付：`alipay.trade.page.pay`
- 手机网站/H5 支付：`alipay.trade.wap.pay`
- 当面付扫码：`alipay.trade.precreate`

需要填写：

- 支付宝网关，生产默认 `https://openapi.alipay.com/gateway.do`
- App ID
- 应用私钥
- 支付宝公钥
- 异步回调地址
- 支付后跳转地址

对应支付宝应用必须已经开通所启用的支付产品。沙箱测试时，网关、App ID、私钥和公钥都要换成支付宝开放平台沙箱环境的信息。

### 微信支付官方 V3

可启用的分类：

- 微信扫码 Native：`/v3/pay/transactions/native`
- 微信 H5：`/v3/pay/transactions/h5`

需要填写：

- AppID
- 商户号 `mchid`
- APIv3 密钥
- 商户 API 证书序列号
- 商户 API 私钥 `apiclient_key.pem`
- 微信支付平台公钥 `pub_key.pem`
- 微信支付平台公钥 ID
- 异步回调地址
- 支付后跳转地址
- 商品描述

JSAPI、小程序、APP 支付需要 openid 或客户端能力，当前余额充值页不展示给用户；充值页只使用 Native 扫码和 H5。

### 彩虹易支付聚合

可启用的分类：

- 支付宝
- 微信
- PayPal
- USDT

需要填写：

- 网关地址
- 商户 PID
- 签名方式：MD5 或 RSA
- 商户密钥，或 RSA 公钥/私钥
- 异步回调地址
- 支付后跳转地址
- 各通道 `type`，默认支付宝 `alipay`、微信 `wxpay`、PayPal `paypal`、USDT `usdt.trc20`

### BEpusdt USDT

需要填写：

- BEpusdt 应用 URI
- 对接令牌 Token/KEY
- 支付类型 `type`，默认 `usdt.trc20`
- 异步回调地址
- 支付后跳转地址

### 默认回调地址

```text
支付宝异步回调：https://你的域名/api/payments/alipay/notify
微信支付异步回调：https://你的域名/api/payments/wechat/notify
易支付异步回调：https://你的域名/api/payments/epay/notify
BEpusdt 异步回调：https://你的域名/api/payments/bepusdt/notify
支付后跳转地址：https://你的域名/payment/result?trade_no={trade_no}
```

如果回调地址留空，系统会根据“公网网站地址”自动生成。生产环境建议使用 HTTPS，确保支付平台能访问你的回调地址。

支付成功后，系统会校验签名、订单号、金额和状态。只有校验通过的订单才会入账，重复回调不会重复增加余额。后台没有启用或没有配好的大类，用户端只会按大类隐藏或提示该大类未配置，不会把内部通道暴露给用户选择。

## 10. 3-xui 节点配置

进入“3x-ui 节点”，点击“添加 3x-ui 节点”。推荐使用 3-xui 3.4.1，并优先填写 API Token。

示例一：

```text
3-xui 地址：http://example.com:2053/
协议：http
地址：example.com
端口：2053
基础路径：/
API Token：填写 3-xui 的 API Token
```

示例二：

```text
3-xui 地址：https://example.com:2053/custompath/
协议：https
地址：example.com
端口：2053
基础路径：/custompath
API Token：填写 3-xui 的 API Token
```

添加后点击“测试”。能显示可用 Inbound ID，说明连接成功。

## 11. 用户充值和续费

用户从 `/` 登录后可以：

- 查看自己的余额
- 兑换卡密给余额充值
- 使用在线支付给余额充值
- 查看自己的余额流水、充值订单和续费记录
- 使用余额续费当前节点

用户余额不足时不能续费。续费价格取自管理员给该用户设置的每月价格。

用户自助续费采用严格逻辑：系统会先同步 3-xui 远端到期时间，远端成功后才扣除余额并保存本地续费记录。如果远端同步失败，用户端只会看到“续费失败，请稍后重试或联系管理员”。

## 12. 更新项目

推荐直接重新执行一键安装命令：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

脚本会覆盖程序文件，保留 `data/` 目录，并重启服务。业务数据保存在 MySQL 中。

如果使用 Git 手动更新：

```bash
cd /opt/shiye-management-system
git pull
npm install --omit=dev
node --check server.js
node --check public/app.js
node --check public/user.js
systemctl restart shiye-management-system
```

## 13. 数据备份

需要备份：

- MySQL 数据库
- `/etc/default/shiye-management-system`
- `data/.secret` 或 `APP_SECRET`
- `data/config.json`，如果你通过网页安装向导保存数据库配置

MySQL 备份示例：

```bash
mysqldump -u shiye -p shiye_management > shiye_management.sql
```

恢复示例：

```bash
mysql -u shiye -p shiye_management < shiye_management.sql
```

如果丢失 `APP_SECRET` 或 `data/.secret`，之前保存的 3-xui Token、密码、SOCKS 密码和支付密钥将无法解密。

如果需要卸载一键安装后的服务、程序目录、Nginx 配置、HTTPS 证书或数据库，查看 [UNINSTALL.md](./UNINSTALL.md)。

## 14. Nginx 反向代理，可选

一键脚本已经集成 Nginx。启用方式：

```bash
ENABLE_NGINX=yes \
ENABLE_HTTPS=no \
DOMAIN=panel.example.com \
bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

脚本会安装 Nginx，并生成一个反向代理配置，把你的域名转发到 `http://127.0.0.1:3388`。如果你自定义了 `PORT`，会自动转发到自定义端口。

生成的配置大致如下：

```nginx
server {
    listen 80;
    server_name panel.example.com;

    client_max_body_size 20m;

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

手动检查并重载：

```bash
nginx -t
systemctl reload nginx
```

使用 Nginx 后，建议安全组只放行 `80/443`，不要公开 `3388`。如果你跳过 Nginx，则必须放行项目端口，默认 `3388`。

## 15. HTTPS，可选但推荐

一键脚本也可以自动申请 Let's Encrypt 证书：

```bash
ENABLE_NGINX=yes \
ENABLE_HTTPS=yes \
DOMAIN=panel.example.com \
CERTBOT_EMAIL=admin@example.com \
bash <(curl -fsSL https://raw.githubusercontent.com/wstimin/3-xuiguanli-shangye/main/install.sh)
```

脚本会安装 Certbot，执行 `certbot --nginx`，申请成功后自动把 Nginx 配置改成 HTTPS，并启用 HTTP 到 HTTPS 跳转。

如果你已经手动配置好了 Nginx，也可以手动申请：

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d panel.example.com
```

HTTPS 不是系统运行的硬性要求，但公网支付回调、登录和后台管理都建议使用 HTTPS。

证书申请失败时优先检查：

- 域名是否已经解析到当前服务器公网 IP
- 云服务器安全组是否放行 `80` 和 `443`
- 服务器防火墙是否放行 `80` 和 `443`
- 同一个域名是否已经被其他 Nginx 配置占用
- DNS 是否刚修改，可能还没完全生效

## 16. 安全清单

- 公网部署建议使用 MySQL
- 公网部署建议修改默认管理员账号和密码
- 支付回调域名建议使用 HTTPS
- 不要公开 `data/.secret`、`data/config.json` 和 `/etc/default/shiye-management-system`
- 不要公开 3-xui API Token、支付宝私钥、易支付密钥和数据库密码
- 如果不用 Nginx，安全组需要放行 `3388`
- 如果使用 Nginx，建议只放行 `80/443`，不要公开 `3388`
