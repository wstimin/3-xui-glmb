# 视野 3x-ui 用户管理系统卸载教程

本文说明当前新架构版本的卸载方法。一键脚本默认安装信息如下：

```text
服务名：shiye-api
安装目录：/opt/shiye
环境变量文件：/opt/shiye/.env
systemd 服务文件：/etc/systemd/system/shiye-api.service
默认端口：3388
默认数据库：shiye_management
默认数据库用户：shiye
```

如果安装时自定义了 `APP_NAME`、`APP_DIR`、`MYSQL_DATABASE` 或 `MYSQL_USER`，下面命令中的对应值也要改成你自己的。

重要提醒：删除数据库会清空用户、订单、余额、节点、支付配置、卡密和日志等业务数据。只重装程序或更新项目时，通常不要删除数据库。

## 1. 一键卸载命令

默认卸载程序、systemd 服务和 Nginx 配置，保留数据库：

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/uninstall.sh | bash
```

彻底卸载并删除默认数据库 `shiye_management` 和默认数据库用户 `shiye`：

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/uninstall.sh | env DELETE_DATABASE=yes bash
```

如果安装时自定义了安装目录、服务名、数据库名或数据库用户：

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/uninstall.sh | env APP_NAME=shiye-api APP_DIR=/opt/shiye MYSQL_DATABASE=shiye_management MYSQL_USER=shiye DELETE_DATABASE=yes bash
```

如果 MySQL root 有密码，可以传入：

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/uninstall.sh | env DELETE_DATABASE=yes MYSQL_ROOT_PASSWORD='你的MySQLRoot密码' bash
```

删除数据库对应的原始 MySQL 命令是：

```bash
mysql -uroot -p -e "DROP DATABASE IF EXISTS \`shiye_management\`; DROP USER IF EXISTS 'shiye'@'127.0.0.1'; DROP USER IF EXISTS 'shiye'@'localhost'; DROP USER IF EXISTS 'shiye'@'%'; FLUSH PRIVILEGES;"
```

如果 MySQL root 没有密码：

```bash
mysql -uroot -e "DROP DATABASE IF EXISTS \`shiye_management\`; DROP USER IF EXISTS 'shiye'@'127.0.0.1'; DROP USER IF EXISTS 'shiye'@'localhost'; DROP USER IF EXISTS 'shiye'@'%'; FLUSH PRIVILEGES;"
```

## 2. 卸载前备份

至少备份：

```text
MySQL 数据库 shiye_management
/opt/shiye/.env
Nginx 或 OpenResty 站点配置
```

备份数据库：

```bash
mysqldump -u shiye -p shiye_management > shiye_management.sql
```

`.env` 里的 `ENCRYPTION_KEY` 必须保留，否则已保存的 3x-ui Token、密码和支付密钥无法解密。

## 3. 停止并删除 systemd 服务

```bash
systemctl stop shiye-api || true
systemctl disable shiye-api || true
rm -f /etc/systemd/system/shiye-api.service
systemctl daemon-reload
systemctl reset-failed
```

检查服务是否已经删除：

```bash
systemctl status shiye-api
```

如果提示 `Unit shiye-api.service could not be found.`，说明服务文件已经清理掉。

## 4. 删除项目文件

确认安装目录是 `/opt/shiye` 后再执行：

```bash
rm -rf /opt/shiye
```

确认目录已经不存在：

```bash
ls -ld /opt/shiye
```

如果提示 `No such file or directory`，说明已经删除。

## 5. 删除 Nginx 配置，可选

如果一键脚本配置过 Nginx，默认配置名与服务名一致：

```bash
rm -f /etc/nginx/conf.d/shiye-api.conf
rm -f /etc/nginx/sites-available/shiye-api.conf
rm -f /etc/nginx/sites-enabled/shiye-api.conf
nginx -t && systemctl reload nginx || true
```

如果你手动改过配置文件名，请按实际文件删除。删除前可以搜索：

```bash
grep -R "shiye" /etc/nginx 2>/dev/null || true
grep -R "3388" /etc/nginx 2>/dev/null || true
```

## 6. 删除 HTTPS 证书，可选

如果使用 Certbot 申请过证书，可以先查看证书列表：

```bash
certbot certificates
```

删除指定域名证书，把 `你的域名` 换成实际证书名：

```bash
certbot delete --cert-name 你的域名
```

如果不确定证书名，以 `certbot certificates` 输出里的 `Certificate Name` 为准。

## 7. 宝塔或 1Panel 部署的卸载方式

如果你通过宝塔或 1Panel 部署，建议优先在面板里清理：

1. 停止 Node.js 项目或运行环境。
2. 删除对应网站、反向代理或域名绑定。
3. 删除实际项目目录，例如 `/www/wwwroot/shiye` 或 `/opt/shiye`。
4. 如果确定不再使用，删除 MySQL 数据库和数据库账号。
5. 检查端口 `3388` 是否仍有进程监听。

面板部署的实际目录可能和本文默认目录不同，不要直接套用 `/opt/shiye` 删除命令。

## 8. 删除数据库，可选且会清空业务数据

如果确定要彻底删除默认数据库和默认数据库用户：

```bash
mysql -uroot -p -e "DROP DATABASE IF EXISTS \`shiye_management\`; DROP USER IF EXISTS 'shiye'@'127.0.0.1'; DROP USER IF EXISTS 'shiye'@'localhost'; DROP USER IF EXISTS 'shiye'@'%'; FLUSH PRIVILEGES;"
```

如果 MySQL root 没有密码：

```bash
mysql -uroot -e "DROP DATABASE IF EXISTS \`shiye_management\`; DROP USER IF EXISTS 'shiye'@'127.0.0.1'; DROP USER IF EXISTS 'shiye'@'localhost'; DROP USER IF EXISTS 'shiye'@'%'; FLUSH PRIVILEGES;"
```

如果安装时自定义了数据库名或用户，例如：

```text
MYSQL_DATABASE=my_panel
MYSQL_USER=my_user
```

删除命令要改成：

```bash
mysql -uroot -p -e "DROP DATABASE IF EXISTS \`my_panel\`; DROP USER IF EXISTS 'my_user'@'127.0.0.1'; DROP USER IF EXISTS 'my_user'@'localhost'; DROP USER IF EXISTS 'my_user'@'%'; FLUSH PRIVILEGES;"
```

## 9. 是否卸载 Node.js、MySQL、Nginx

一键脚本可能安装了 Node.js、MySQL/MariaDB、Nginx、Certbot。这些组件可能被服务器上的其他网站或服务共用，默认不建议直接卸载。

如果确认服务器只为本项目使用，可以按系统类型卸载。

Debian / Ubuntu：

```bash
apt remove -y nodejs nginx certbot python3-certbot-nginx default-mysql-server
apt autoremove -y
```

CentOS / Rocky / AlmaLinux：

```bash
yum remove -y nodejs npm nginx certbot python3-certbot-nginx mysql-server mariadb-server
yum autoremove -y || true
```

使用 `dnf` 的系统：

```bash
dnf remove -y nodejs npm nginx certbot python3-certbot-nginx mysql-server mariadb-server
dnf autoremove -y || true
```

卸载基础组件前，建议先确认没有其他服务依赖它们：

```bash
systemctl list-units --type=service --state=running
ss -lntp
```

## 10. 手动一键卸载命令，保留数据库

如果只想删除程序、服务、Nginx 配置和证书，但保留数据库，可以执行：

```bash
systemctl stop shiye-api || true
systemctl disable shiye-api || true
rm -f /etc/systemd/system/shiye-api.service
rm -rf /opt/shiye
rm -f /etc/nginx/conf.d/shiye-api.conf
rm -f /etc/nginx/sites-available/shiye-api.conf
rm -f /etc/nginx/sites-enabled/shiye-api.conf
systemctl daemon-reload
systemctl reset-failed
nginx -t && systemctl reload nginx || true
```

如果申请过 HTTPS 证书，再手动执行：

```bash
certbot certificates
certbot delete --cert-name 你的域名
```

## 11. 手动一键彻底卸载命令，删除数据库

下面命令会删除程序和默认数据库。执行前请确认已经备份 MySQL 数据库和 `/opt/shiye/.env`。

```bash
systemctl stop shiye-api || true
systemctl disable shiye-api || true
rm -f /etc/systemd/system/shiye-api.service
rm -rf /opt/shiye
rm -f /etc/nginx/conf.d/shiye-api.conf
rm -f /etc/nginx/sites-available/shiye-api.conf
rm -f /etc/nginx/sites-enabled/shiye-api.conf
systemctl daemon-reload
systemctl reset-failed
nginx -t && systemctl reload nginx || true
mysql -uroot -p -e "DROP DATABASE IF EXISTS \`shiye_management\`; DROP USER IF EXISTS 'shiye'@'127.0.0.1'; DROP USER IF EXISTS 'shiye'@'localhost'; DROP USER IF EXISTS 'shiye'@'%'; FLUSH PRIVILEGES;"
```

如果 MySQL root 没有密码，把最后一行改成：

```bash
mysql -uroot -e "DROP DATABASE IF EXISTS \`shiye_management\`; DROP USER IF EXISTS 'shiye'@'127.0.0.1'; DROP USER IF EXISTS 'shiye'@'localhost'; DROP USER IF EXISTS 'shiye'@'%'; FLUSH PRIVILEGES;"
```

## 12. 卸载后检查

```bash
systemctl status shiye-api
ls -ld /opt/shiye
ss -lntp | grep 3388 || true
grep -R "shiye-api" /etc/nginx 2>/dev/null || true
grep -R "3388" /etc/nginx 2>/dev/null || true
```

如果服务不存在、目录不存在、`3388` 没有监听，说明程序主体已经卸载完成。
