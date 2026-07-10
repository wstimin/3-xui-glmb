# 十夜管理系统 1Panel 部署教程

本文只讲 1Panel 面板部署，不使用一键安装脚本。适合已经安装 1Panel，并希望通过 1Panel 的 Node.js 运行环境、MySQL 数据库和网站反向代理来部署十夜管理系统的用户。

项目基于 3-xui 面板 3.4.1 版本开发和测试。部署完成后，请先在管理后台的“节点”页面测试 3-xui 连接，再创建用户并同步。

## 1. 准备条件

需要准备：

- 一台已经安装 1Panel 的 Linux 服务器
- 一个域名，可选；没有域名也可以先用 `http://服务器IP:3388` 访问
- 1Panel 应用商店里的 MySQL 或 MariaDB
- 1Panel 运行环境里的 Node.js，建议 Node.js 20
- 本项目完整源码，目录根部必须能看到 `package.json`、`server.js`、`public/`

默认信息：

```text
项目端口：3388
用户入口：http://服务器IP:3388/
管理员入口：http://服务器IP:3388/admin
默认管理员账号：admin
默认管理员密码：admin123
```

公网使用建议登录后修改默认管理员密码。

## 2. 创建数据库

进入 1Panel：

```text
数据库 -> MySQL -> 创建数据库
```

推荐填写：

```text
数据库名：shiye_management
用户名：shiye
密码：自己生成一个强密码
权限：本机或所有，按 1Panel 当前数据库设置选择
字符集：utf8mb4
排序规则：utf8mb4_general_ci
```

创建后把这几项记下来，首次打开十夜管理系统时会在网页安装向导里填写：

```text
数据库地址
数据库端口，通常是 3306
数据库名
数据库用户名
数据库密码
```

如果 Node.js 运行环境是容器，`127.0.0.1` 可能指的是 Node 容器本身，不一定能连到 MySQL。优先使用 1Panel 数据库页面展示的连接地址；如果连接失败，再查看 MySQL 容器名：

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}' | grep -i mysql
```

常见数据库地址可能是 `mysql`、`1panel-mysql`、具体 MySQL 容器名，或 1Panel 显示的内网地址。

## 3. 上传项目文件

进入 1Panel 文件管理，建议新建一个专门目录：

```text
/opt/shiye-management-system
```

把项目压缩包上传到这个目录后解压。解压完成后，目录结构必须类似这样：

```text
/opt/shiye-management-system/package.json
/opt/shiye-management-system/server.js
/opt/shiye-management-system/public/
/opt/shiye-management-system/install.sh
/opt/shiye-management-system/README.md
```

注意：不要多套一层目录。错误示例：

```text
/opt/shiye-management-system/3-xuiguanli-shangye/package.json
```

如果出现这种情况，需要把里面的文件移动到 `/opt/shiye-management-system` 根目录。

## 4. 创建 Node.js 运行环境

进入 1Panel：

```text
运行环境 -> Node.js -> 创建运行环境
```

推荐填写：

```text
名称：shiye-management-system
Node 版本：20.x
运行目录：/opt/shiye-management-system
启动文件或启动命令：npm start
端口：3388
安装依赖命令：npm install --omit=dev
```

如果面板要求填写“启动命令”，填写：

```bash
npm start
```

如果面板要求填写“运行命令”，也可以填写：

```bash
node server.js
```

环境变量可以先不填。系统首次访问会进入网页安装向导，在网页里绑定 MySQL 数据库。

如果 1Panel 允许填写环境变量，也可以只填写基础配置：

```text
PORT=3388
ADMIN_PATH=/admin
```

不要手动填写错误的 MySQL 环境变量；如果填错，系统会直接按错误配置连接数据库，可能不会显示网页安装向导。

## 5. 启动并检查日志

创建运行环境后启动项目。启动失败时，先看 1Panel 的运行日志。

最常见错误是：

```text
npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '/app/package.json'
```

原因是运行目录不对，或项目文件没有放在运行目录根部。解决方法：

```text
1. 回到文件管理
2. 找到 package.json 实际所在目录
3. 把 Node.js 运行环境的运行目录改成这个目录
4. 确认该目录下同时存在 server.js 和 public/
5. 重新安装依赖并重启
```

如果可以进入容器或服务器终端，也可以检查：

```bash
ls -lah /opt/shiye-management-system
```

必须能看到 `package.json`。

## 6. 首次网页安装向导

项目启动后访问：

```text
http://服务器IP:3388/
```

如果配置了域名反向代理，也可以访问域名。首次访问会显示“首次安装”页面。

填写数据库信息：

```text
数据库地址：1Panel 显示的数据库连接地址，或 MySQL 容器名
数据库端口：3306
数据库名称：shiye_management
数据库账号：shiye
数据库密码：创建数据库时设置的密码
管理员入口：/admin，或你想自定义的路径
```

点击连接并安装。安装成功后，系统会自动建表，并把配置保存到：

```text
data/config.json
```

这个文件包含数据库连接信息，迁移和备份时需要保留，不要公开给别人。

安装完成后访问：

```text
用户入口：http://服务器IP:3388/
管理员入口：http://服务器IP:3388/admin
```

默认管理员：

```text
账号：admin
密码：admin123
```

## 7. 配置网站反向代理

如果你想用域名访问，进入 1Panel：

```text
网站 -> 创建网站
```

如果是反向代理模式，目标地址填写：

```text
http://127.0.0.1:3388
```

如果 1Panel 的 Node.js 运行环境和 OpenResty 不在同一个网络，`127.0.0.1` 不能访问时，改用服务器内网 IP 或 Node 容器名。可以在服务器测试：

```bash
curl -i http://127.0.0.1:3388/
```

能返回页面时，反代目标就可以用 `http://127.0.0.1:3388`。

反向代理常用头部：

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

1Panel 通常会自动生成这些配置，不需要手动改 Nginx 文件。

## 8. 申请 HTTPS 证书

进入 1Panel：

```text
网站 -> 选择站点 -> HTTPS -> 申请证书
```

申请前确认：

```text
域名 A 记录已经解析到服务器 IP
服务器安全组放行 80 和 443
网站能通过 http://域名 正常访问
Cloudflare 小黄云建议先关闭，申请成功后再按需要开启
```

证书申请成功后，开启 HTTPS 访问即可。

## 9. 更新项目

上传新版项目时，建议保留：

```text
data/
```

更新步骤：

```text
1. 停止 Node.js 运行环境
2. 备份 /opt/shiye-management-system/data/
3. 上传新版项目文件并覆盖旧程序文件
4. 不要删除 data/config.json 和 data/.secret
5. 重新执行 npm install --omit=dev
6. 启动 Node.js 运行环境
```

如果是 MySQL 模式，业务数据主要在 MySQL；但 `data/config.json` 和 `data/.secret` 仍然很重要。

如果可以进入终端，更新后建议检查：

```bash
cd /opt/shiye-management-system
npm install --omit=dev
node --check server.js
node --check public/app.js
node --check public/user.js
```

## 10. 自动停用和续费恢复

系统会定时维护用户节点状态：

- 本地节点到期后会自动停用，并同步停用远端 3-xui client。
- 远端 3-xui client 流量用完或被远端停用时，本地节点会同步停用。
- 因流量超限被停用的节点续费后，系统会调用 3-xui 官方 `POST /panel/api/clients/resetTraffic/{email}` 接口，清空该 client 流量并重新启用。
- 用户自助续费会先同步 3-xui 成功，再扣除余额并保存本地续费记录。

建议 3-xui 节点优先填写 API Token，并确认面板版本支持 `resetTraffic/{email}` 接口。

## 11. 常见问题

### 页面能打开，但是提示数据库连接失败

优先检查数据库地址。Node.js 容器里的 `127.0.0.1` 不一定是 MySQL。使用 1Panel 数据库页面提供的连接地址，或者 MySQL 容器名。

### 运行环境一直创建失败

检查运行目录。运行目录下必须有：

```text
package.json
server.js
public/
```

### 日志提示找不到 package.json

运行目录填错了，或者解压后多了一层目录。把项目文件移动到运行目录根部，或把运行目录改成 `package.json` 所在目录。

### 首次安装页面没有出现

可能已经存在 `data/config.json`，或者你在运行环境里设置了 `MYSQL_HOST`、`DATABASE_URL` 等数据库环境变量。确认配置是否正确；如果是全新安装，可以停止服务后检查 `data/config.json` 是否存在。

### 管理员和用户不能同时在同一个浏览器登录

管理员入口和用户入口是分开的，但同一个浏览器共享登录 Cookie。建议管理员和用户测试时使用不同浏览器，或一个用无痕窗口。

## 12. 备份建议

至少备份：

```text
MySQL 数据库 shiye_management
/opt/shiye-management-system/data/config.json
/opt/shiye-management-system/data/.secret
```

如果丢失 `data/.secret`，之前保存的 3-xui Token、SOCKS 密码等敏感信息可能无法解密。
