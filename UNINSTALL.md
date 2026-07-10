# 十夜 3-xui 用户管理系统卸载教程

本文说明一键安装后的卸载方法。默认安装信息如下：

```text
服务名：shiye-management-system
安装目录：/opt/shiye-management-system
环境变量文件：/etc/default/shiye-management-system
systemd 服务文件：/etc/systemd/system/shiye-management-system.service
默认端口：3388
默认数据库：shiye_management
默认数据库用户：shiye
```

如果你安装时自定义了 `APP_NAME`、`APP_DIR`、`MYSQL_DATABASE` 或 `MYSQL_USER`，下面命令里的对应值也要改成你自己的。

> 注意：本文主要适用于一键安装脚本部署的 systemd 服务。如果你是通过 1Panel 或宝塔部署，请优先在对应面板里停止 Node.js 项目、删除网站反向代理和项目目录，再按需删除数据库。面板部署的项目目录可能是 `/opt/shiye-management-system`、`/www/wwwroot/shiye-management-system` 或你自己选择的路径，不要直接套用下面的 `/opt/...` 删除命令。

## 1. 停止并删除 systemd 服务

```bash
systemctl stop shiye-management-system || true
systemctl disable shiye-management-system || true
rm -f /etc/systemd/system/shiye-management-system.service
systemctl daemon-reload
systemctl reset-failed
```

检查服务是否已经删除：

```bash
systemctl status shiye-management-system
```

如果提示 `Unit shiye-management-system.service could not be found.`，说明服务文件已经清理掉。

## 2. 删除项目文件和环境变量

删除项目目录：

```bash
rm -rf /opt/shiye-management-system
```

删除 systemd 环境变量文件：

```bash
rm -f /etc/default/shiye-management-system
```

确认目录已经不存在：

```bash
ls -ld /opt/shiye-management-system
ls -l /etc/default/shiye-management-system
```

如果提示 `No such file or directory`，说明已经删除。

## 3. 删除 Nginx 反向代理配置，可选

如果安装时跳过了 Nginx，可以跳过本节。

删除脚本生成的 Nginx 配置：

```bash
rm -f /etc/nginx/conf.d/shiye-management-system.conf
rm -f /etc/nginx/sites-available/shiye-management-system.conf
rm -f /etc/nginx/sites-enabled/shiye-management-system.conf
nginx -t
systemctl reload nginx
```

如果 `nginx -t` 报错，先不要 reload，按照报错路径检查是否删错了其他站点配置。

检查域名是否还被 Nginx 配置引用：

```bash
grep -R "你的域名" /etc/nginx 2>/dev/null || true
```

## 4. 删除 HTTPS 证书，可选

如果安装时没有申请 HTTPS 证书，可以跳过本节。

查看 Certbot 证书列表：

```bash
certbot certificates
```

删除指定域名证书，把 `你的域名` 换成实际域名：

```bash
certbot delete --cert-name 你的域名
```

如果不确定证书名称，以 `certbot certificates` 输出里的 `Certificate Name` 为准。

## 5. 面板部署卸载方式

如果你通过 1Panel 或宝塔部署，建议按这个顺序清理：

1. 在面板里停止 Node.js 项目或运行环境。
2. 删除对应网站、反向代理或域名绑定。
3. 删除实际项目目录，例如 `/opt/shiye-management-system` 或 `/www/wwwroot/shiye-management-system`。
4. 如果确定不再使用，删除 MySQL 数据库和数据库账号。
5. 检查端口 `3388` 是否仍有进程监听。

删除数据库前至少备份 MySQL 数据库、`data/config.json` 和 `data/.secret`。

## 6. 删除数据库，可选且会清空业务数据

删除数据库前请确认已经备份 MySQL 数据库、`data/config.json`、`data/.secret`，以及一键安装时的 `/etc/default/shiye-management-system`。

如果你只是重装系统或升级项目，通常不要删除数据库。删除数据库会清空用户、订单、余额、节点、支付配置、卡密和日志等业务数据。

如果确定要彻底删除默认数据库和默认数据库用户：

```bash
mysql -uroot -p -e "DROP DATABASE IF EXISTS \`shiye_management\`; DROP USER IF EXISTS 'shiye'@'127.0.0.1'; FLUSH PRIVILEGES;"
```

如果你的 MySQL root 没有密码，使用：

```bash
mysql -uroot -e "DROP DATABASE IF EXISTS \`shiye_management\`; DROP USER IF EXISTS 'shiye'@'127.0.0.1'; FLUSH PRIVILEGES;"
```

如果安装时自定义了数据库名或用户，例如：

```text
MYSQL_DATABASE=my_panel
MYSQL_USER=my_user
```

则删除命令要改成：

```bash
mysql -uroot -p -e "DROP DATABASE IF EXISTS \`my_panel\`; DROP USER IF EXISTS 'my_user'@'127.0.0.1'; FLUSH PRIVILEGES;"
```

## 7. 是否卸载 Node.js、MySQL、Nginx

一键脚本可能安装了 Node.js、MySQL/MariaDB、Nginx、Certbot。这些组件可能被服务器上的其他网站或服务共用，默认不建议直接卸载。

如果你确认服务器只为本项目使用，可以按系统类型卸载。

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

卸载这些基础组件前，建议先确认没有其他服务依赖它们：

```bash
systemctl list-units --type=service --state=running
ss -lntp
```

## 8. 一键卸载命令，保留数据库

如果你只想删除程序、服务、Nginx 配置和证书，但保留数据库，可以执行：

```bash
systemctl stop shiye-management-system || true
systemctl disable shiye-management-system || true
rm -f /etc/systemd/system/shiye-management-system.service
rm -f /etc/default/shiye-management-system
rm -rf /opt/shiye-management-system
rm -f /etc/nginx/conf.d/shiye-management-system.conf
rm -f /etc/nginx/sites-available/shiye-management-system.conf
rm -f /etc/nginx/sites-enabled/shiye-management-system.conf
systemctl daemon-reload
systemctl reset-failed
nginx -t && systemctl reload nginx || true
```

如果申请过 HTTPS 证书，再手动执行：

```bash
certbot certificates
certbot delete --cert-name 你的域名
```

## 9. 一键彻底卸载命令，删除数据库

下面命令会删除程序和默认数据库。执行前请确认已经备份 MySQL 数据库、`data/config.json`、`data/.secret`，以及 `/etc/default/shiye-management-system`。

```bash
systemctl stop shiye-management-system || true
systemctl disable shiye-management-system || true
rm -f /etc/systemd/system/shiye-management-system.service
rm -f /etc/default/shiye-management-system
rm -rf /opt/shiye-management-system
rm -f /etc/nginx/conf.d/shiye-management-system.conf
rm -f /etc/nginx/sites-available/shiye-management-system.conf
rm -f /etc/nginx/sites-enabled/shiye-management-system.conf
systemctl daemon-reload
systemctl reset-failed
nginx -t && systemctl reload nginx || true
mysql -uroot -p -e "DROP DATABASE IF EXISTS \`shiye_management\`; DROP USER IF EXISTS 'shiye'@'127.0.0.1'; FLUSH PRIVILEGES;"
```

如果 MySQL root 没有密码，把最后一行改成：

```bash
mysql -uroot -e "DROP DATABASE IF EXISTS \`shiye_management\`; DROP USER IF EXISTS 'shiye'@'127.0.0.1'; FLUSH PRIVILEGES;"
```

## 10. 卸载后检查

```bash
systemctl status shiye-management-system
ls -ld /opt/shiye-management-system
ls -l /etc/default/shiye-management-system
ss -lntp | grep 3388 || true
grep -R "shiye-management-system" /etc/nginx 2>/dev/null || true
```

如果服务不存在、目录不存在、`3388` 没有监听，说明程序主体已经卸载完成。
