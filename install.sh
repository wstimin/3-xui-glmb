#!/usr/bin/env bash
set -Eeuo pipefail
trap 'status=$?; echo "ERROR: install failed at line ${LINENO}: ${BASH_COMMAND}" >&2; exit ${status}' ERR

APP_NAME="${APP_NAME:-shiye-api}"
APP_DIR="${APP_DIR:-/opt/shiye}"
PORT="${PORT:-3388}"
DEFAULT_REPO_URL="${DEFAULT_REPO_URL:-https://github.com/wstimin/shiye-3xuigl-L3.git}"
INSTALL_URL="${INSTALL_URL:-https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/install.sh}"
UNINSTALL_URL="${UNINSTALL_URL:-https://raw.githubusercontent.com/wstimin/shiye-3xuigl-L3/main/uninstall.sh}"
DOMAIN="${DOMAIN:-${SITE_DOMAIN:-}}"
ENABLE_NGINX="${ENABLE_NGINX:-ask}"
ENABLE_HTTPS="${ENABLE_HTTPS:-ask}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"

MYSQL_DATABASE="${MYSQL_DATABASE:-shiye_management}"
MYSQL_USER="${MYSQL_USER:-shiye}"
MYSQL_PORT="${MYSQL_PORT:-3306}"

SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"

log() { echo "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

to_lower() { printf "%s" "$1" | tr '[:upper:]' '[:lower:]'; }
is_yes() { case "$(to_lower "$1")" in y|yes|1|true|on|enable|enabled) return 0 ;; *) return 1 ;; esac; }
is_no() { case "$(to_lower "$1")" in n|no|0|false|off|disable|disabled|skip) return 0 ;; *) return 1 ;; esac; }

ask_yes_no() {
  prompt="$1"
  default_answer="$2"
  if [ ! -r /dev/tty ]; then
    is_yes "${default_answer}"
    return
  fi

  while true; do
    if is_yes "${default_answer}"; then
      read -r -p "${prompt} [Y/n]: " answer </dev/tty
      answer="${answer:-y}"
    else
      read -r -p "${prompt} [y/N]: " answer </dev/tty
      answer="${answer:-n}"
    fi

    if is_yes "${answer}"; then return 0; fi
    if is_no "${answer}"; then return 1; fi
    echo "Please answer yes or no."
  done
}

can_prompt() { [ -r /dev/tty ]; }

prompt_required() {
  prompt="$1"
  value=""
  can_prompt || die "${prompt} is required"
  while [ -z "${value}" ]; do
    read -r -p "${prompt}: " value </dev/tty
    value="$(printf "%s" "${value}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  done
  printf "%s" "${value}"
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "Please switch to root and run: bash install.sh"
  command -v systemctl >/dev/null 2>&1 || die "systemd is required"
}

normalize_app_dir() {
  parent_dir="$(dirname "${APP_DIR}")"
  base_name="$(basename "${APP_DIR}")"
  [ -n "${base_name}" ] && [ "${base_name}" != "." ] && [ "${base_name}" != "/" ] || die "Invalid APP_DIR: ${APP_DIR}"
  mkdir -p "${parent_dir}"
  parent_abs="$(cd "${parent_dir}" && pwd -P)"
  APP_DIR="${parent_abs}/${base_name}"

  case "${APP_DIR}" in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var|/www|/www/wwwroot)
      die "Refusing unsafe APP_DIR: ${APP_DIR}"
      ;;
  esac
}

detect_pkg_manager() {
  if command -v apt >/dev/null 2>&1; then
    PKG_MANAGER="apt"
  elif command -v dnf >/dev/null 2>&1; then
    PKG_MANAGER="dnf"
  elif command -v yum >/dev/null 2>&1; then
    PKG_MANAGER="yum"
  else
    die "Unsupported system: apt, dnf or yum is required"
  fi
}

install_package() {
  case "${PKG_MANAGER}" in
    apt) DEBIAN_FRONTEND=noninteractive apt install -y "$@" ;;
    dnf) dnf install -y "$@" ;;
    yum) yum install -y "$@" ;;
  esac
}

install_base_packages() {
  case "${PKG_MANAGER}" in
    apt) apt update ;;
  esac
  install_package curl ca-certificates git openssl
}

clone_repo() {
  repo_url="$1"
  dest="$2"
  sparse_paths="package.json package-lock.json tsconfig.base.json apps packages prisma scripts infra"

  if git clone --depth 1 --filter=blob:none --sparse "${repo_url}" "${dest}"; then
    if ! (cd "${dest}" && git sparse-checkout set ${sparse_paths}); then
      rm -rf "${dest}"
      git clone --depth 1 "${repo_url}" "${dest}"
    fi
  else
    git clone --depth 1 "${repo_url}" "${dest}"
  fi
}

load_existing_env_defaults() {
  normalize_app_dir
  env_file="${APP_DIR}/.env"
  if [ ! -f "${env_file}" ]; then
    return 0
  fi

  log "Existing deployment detected. ${env_file} will be preserved; application files will be refreshed."

  existing_database_url="$(grep -E '^DATABASE_URL=' "${env_file}" | tail -n 1 | cut -d= -f2- || true)"
  if [ -z "${DATABASE_URL:-}" ] && [ -n "${existing_database_url}" ]; then
    DATABASE_URL="${existing_database_url}"
  fi

  return 0
}

stop_existing_service_for_update() {
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "${APP_NAME}.service" >/dev/null 2>&1; then
    log "Stopping existing service ${APP_NAME} before refreshing files"
    systemctl stop "${APP_NAME}" >/dev/null 2>&1 || true
  fi
}

install_node() {
  if command -v node >/dev/null 2>&1; then
    major="$(node -v | sed 's/^v//' | cut -d. -f1)"
    if [ "${major}" -ge 20 ]; then return; fi
  fi

  case "${PKG_MANAGER}" in
    apt)
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
      DEBIAN_FRONTEND=noninteractive apt install -y nodejs
      ;;
    dnf)
      curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
      dnf install -y nodejs npm
      ;;
    yum)
      curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
      yum install -y nodejs npm
      ;;
  esac

  command -v node >/dev/null 2>&1 || die "Node.js installation failed"
  major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  [ "${major}" -ge 20 ] || die "Node.js 20+ is required, current version is $(node -v)"
}

random_hex() { openssl rand -hex 32; }
random_base64() { openssl rand -base64 32; }

detect_server_ip() {
  detected_ip=""
  if command -v curl >/dev/null 2>&1; then
    detected_ip="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || true)"
  fi
  if [ -z "${detected_ip}" ]; then
    detected_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  printf "%s" "${detected_ip:-SERVER_IP}"
}

resolve_public_url() {
  if [ -n "${PUBLIC_WEB_URL:-}" ]; then
    printf "%s" "${PUBLIC_WEB_URL}"
  elif [ -n "${DOMAIN}" ]; then
    if is_no "${ENABLE_HTTPS}"; then printf "http://%s" "${DOMAIN}"; else printf "https://%s" "${DOMAIN}"; fi
  else
    printf "http://%s:%s" "$(detect_server_ip)" "${PORT}"
  fi
}

escape_sed_replacement() {
  printf "%s" "$1" | sed 's/[\/&|]/\\&/g'
}

set_env_value() {
  key="$1"
  value="$2"
  escaped_value="$(escape_sed_replacement "${value}")"
  if grep -qE "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${escaped_value}|" .env
  else
    printf "\n%s=%s\n" "${key}" "${value}" >> .env
  fi
}

validate_mysql_name() {
  value="$1"
  label="$2"
  echo "${value}" | grep -Eq '^[A-Za-z0-9_]+$' || die "${label} can only contain letters, numbers and underscores"
}

sql_string() { printf "%s" "$1" | sed "s/'/''/g"; }

start_mysql_service() {
  for service in mysql mysqld mariadb; do
    if systemctl list-unit-files "${service}.service" >/dev/null 2>&1; then
      systemctl enable --now "${service}" >/dev/null 2>&1 || true
    fi
    if systemctl is-active --quiet "${service}" >/dev/null 2>&1; then return; fi
  done
  die "MySQL service is not running"
}

mysql_root_exec() {
  if [ -n "${MYSQL_ROOT_PASSWORD:-}" ]; then
    MYSQL_PWD="${MYSQL_ROOT_PASSWORD}" mysql -uroot -e "$1"
  else
    mysql -uroot -e "$1"
  fi
}

install_local_mysql_if_needed() {
  if [ -n "${DATABASE_URL:-}" ]; then
    log "DATABASE_URL detected, skipping local MySQL setup"
    return
  fi

  MYSQL_HOST="127.0.0.1"
  MYSQL_PASSWORD="${MYSQL_PASSWORD:-$(openssl rand -hex 16)}"
  validate_mysql_name "${MYSQL_DATABASE}" "MYSQL_DATABASE"
  validate_mysql_name "${MYSQL_USER}" "MYSQL_USER"

  if ! command -v mysql >/dev/null 2>&1; then
    log "Installing local MySQL-compatible server"
    case "${PKG_MANAGER}" in
      apt) DEBIAN_FRONTEND=noninteractive apt install -y default-mysql-server ;;
      dnf) dnf install -y mysql-server || dnf install -y mariadb-server ;;
      yum) yum install -y mysql-server || yum install -y mariadb-server ;;
    esac
  fi

  start_mysql_service
  password="$(sql_string "${MYSQL_PASSWORD}")"
  mysql_root_exec "CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
  mysql_root_exec "CREATE USER IF NOT EXISTS '${MYSQL_USER}'@'127.0.0.1' IDENTIFIED BY '${password}';"
  mysql_root_exec "ALTER USER '${MYSQL_USER}'@'127.0.0.1' IDENTIFIED BY '${password}';"
  mysql_root_exec "GRANT ALL PRIVILEGES ON \`${MYSQL_DATABASE}\`.* TO '${MYSQL_USER}'@'127.0.0.1'; FLUSH PRIVILEGES;"

  DATABASE_URL="mysql://${MYSQL_USER}:${MYSQL_PASSWORD}@127.0.0.1:${MYSQL_PORT}/${MYSQL_DATABASE}"
}

install_app_files() {
  normalize_app_dir
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  mkdir -p "${APP_DIR}"

  if [ -f "${SCRIPT_DIR}/package.json" ] && [ -d "${SCRIPT_DIR}/apps" ] && [ -d "${SCRIPT_DIR}/packages" ]; then
    if [ "${SCRIPT_DIR}" != "${APP_DIR}" ]; then
      find "${APP_DIR}" -mindepth 1 -maxdepth 1 ! -name '.env' -exec rm -rf {} +
      find "${SCRIPT_DIR}" -mindepth 1 -maxdepth 1 ! -name '.env' ! -name 'node_modules' ! -name 'dist' -exec cp -a {} "${APP_DIR}/" \;
    fi
  elif [ -n "${DEFAULT_REPO_URL}" ]; then
    tmp_dir="$(mktemp -d)"
    clone_repo "${DEFAULT_REPO_URL}" "${tmp_dir}/app"
    find "${APP_DIR}" -mindepth 1 -maxdepth 1 ! -name '.env' -exec rm -rf {} +
    cp -a "${tmp_dir}/app/." "${APP_DIR}/"
    rm -rf "${tmp_dir}"
  else
    die "Project files not found and DEFAULT_REPO_URL is empty"
  fi
}

write_env_file() {
  cd "${APP_DIR}"
  public_url="$(resolve_public_url)"

  if [ -f .env ]; then
    log "Keeping existing ${APP_DIR}/.env"
    set_env_value NODE_ENV production
    set_env_value PORT "${PORT}"
    set_env_value PUBLIC_WEB_URL "${public_url}"
    set_env_value ADMIN_PATH /admin
    return
  fi

  cat > .env <<ENV
NODE_ENV=production
PORT=${PORT}
PUBLIC_WEB_URL=${public_url}
ADMIN_PATH=/admin

DATABASE_URL=${DATABASE_URL}
REDIS_URL=${REDIS_URL:-}

JWT_SECRET=${JWT_SECRET:-$(random_hex)}
SESSION_SECRET=${SESSION_SECRET:-$(random_hex)}
ENCRYPTION_KEY=${ENCRYPTION_KEY:-$(random_base64)}
CARD_HASH_SECRET=${CARD_HASH_SECRET:-$(random_hex)}

DEFAULT_ADMIN_USERNAME=${DEFAULT_ADMIN_USERNAME:-admin}
DEFAULT_ADMIN_PASSWORD=${DEFAULT_ADMIN_PASSWORD:-$(openssl rand -base64 18)}
ENV
  chmod 600 .env
}

install_dependencies_and_build() {
  cd "${APP_DIR}"
  if [ -f package-lock.json ]; then
    npm ci
  else
    npm install
  fi
  npm run install:prod
  npm prune --omit=dev
}

verify_runtime_files() {
  cd "${APP_DIR}"
  required_files="apps/api/dist/main.js packages/shared/dist/index.js packages/xui-client/dist/index.js packages/payment-core/dist/index.js dist/user-web/index.html dist/admin-web/index.html"
  for file in ${required_files}; do
    [ -f "${file}" ] || die "Required runtime file is missing: ${APP_DIR}/${file}. Build did not complete correctly."
  done
}

cleanup_runtime_files() {
  if [ "${SCRIPT_DIR:-}" = "${APP_DIR}" ] && [ -d "${APP_DIR}/.git" ]; then
    log "Skipping runtime cleanup because ${APP_DIR} is the source checkout"
    return
  fi

  cd "${APP_DIR}"
  log "Removing build-only source files from ${APP_DIR}"

  rm -rf .git .github .vscode scripts infra apps/admin-web apps/user-web
  rm -f README.md DEPLOY.md ARCHITECTURE.md UNINSTALL.md install.sh uninstall.sh docker-compose.yml .env.example tsconfig.base.json
  rm -f 1Panel部署教程.md 宝塔部署教程.md 部署教程.md

  if [ -d apps/api ]; then
    find apps/api -mindepth 1 -maxdepth 1 ! -name dist ! -name package.json -exec rm -rf {} +
  fi

  for package_name in shared xui-client payment-core; do
    if [ -d "packages/${package_name}" ]; then
      find "packages/${package_name}" -mindepth 1 -maxdepth 1 ! -name dist ! -name package.json -exec rm -rf {} +
    fi
  done

  if [ -d prisma ]; then
    find prisma -mindepth 1 -maxdepth 1 ! -name schema.prisma ! -name migrations -exec rm -rf {} +
  fi
}

write_service() {
  node_bin="$(command -v node)"
  npm_bin="$(command -v npm)"
  [ -n "${node_bin}" ] || die "node binary was not found"
  [ -n "${npm_bin}" ] || die "npm binary was not found"

  if ! id shiye >/dev/null 2>&1; then
    useradd --system --home "${APP_DIR}" --shell /usr/sbin/nologin shiye
  fi
  chown -R shiye:shiye "${APP_DIR}"

  cat > "${SERVICE_FILE}" <<SERVICE
[Unit]
Description=Shiye API Service
After=network.target mysql.service mariadb.service redis.service

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=${npm_bin} run start -w @shiye/api
Restart=always
RestartSec=3
User=shiye
Group=shiye

[Install]
WantedBy=multi-user.target
SERVICE
}

wait_for_api_health() {
  health_url="http://127.0.0.1:${PORT}/api/health"
  log "Waiting for API health check: ${health_url}"

  attempts=30
  attempt=1
  while [ "${attempt}" -le "${attempts}" ]; do
    if curl -fsS "${health_url}" >/dev/null 2>&1; then
      log "API health check passed"
      return 0
    fi

    if ! systemctl is-active --quiet "${APP_NAME}"; then
      echo "${APP_NAME} is not active while waiting for API health." >&2
      systemctl --no-pager --full status "${APP_NAME}" || true
      journalctl -u "${APP_NAME}" -n 120 --no-pager --full || true
      die "API service failed to start. Check the journal output above."
    fi

    sleep 2
    attempt=$((attempt + 1))
  done

  systemctl --no-pager --full status "${APP_NAME}" || true
  journalctl -u "${APP_NAME}" -n 120 --no-pager --full || true
  die "API health check did not pass after $((attempts * 2)) seconds: ${health_url}"
}

verify_web_routes() {
  for path in / /admin /admin/; do
    url="http://127.0.0.1:${PORT}${path}"
    content_type="$(curl -fsS -o /dev/null -D - "${url}" 2>/dev/null | tr -d '\r' | awk 'BEGIN{IGNORECASE=1} /^content-type:/ {print $2; exit}')"
    case "${content_type}" in
      text/html*) ;;
      *) die "Web route ${url} did not return HTML. Got content-type: ${content_type:-none}" ;;
    esac
  done
  log "Web route checks passed"
}

validate_domain() {
  [ -n "${DOMAIN}" ] || die "DOMAIN is required when Nginx is enabled"
  echo "${DOMAIN}" | grep -Eq '^[A-Za-z0-9.-]+$' || die "DOMAIN can only contain letters, numbers, dots and hyphens"
  echo "${DOMAIN}" | grep -Eq '\.' || die "DOMAIN must be a valid domain name, for example panel.example.com"
}

select_access_mode() {
  INSTALL_NGINX_SELECTED=0
  INSTALL_HTTPS_SELECTED=0

  if is_yes "${ENABLE_NGINX}"; then
    INSTALL_NGINX_SELECTED=1
  elif is_no "${ENABLE_NGINX}"; then
    INSTALL_NGINX_SELECTED=0
  elif ask_yes_no "Use domain access with Nginx? Choose no for IP + port access" "$([ -n "${DOMAIN}" ] && echo yes || echo no)"; then
    INSTALL_NGINX_SELECTED=1
  fi

  if [ "${INSTALL_NGINX_SELECTED}" -ne 1 ]; then
    ENABLE_NGINX="no"
    ENABLE_HTTPS="no"
    log "Access mode: IP + port, for example http://SERVER_IP:${PORT}/"
    return
  fi

  if [ -z "${DOMAIN}" ]; then DOMAIN="$(prompt_required "Domain name, for example panel.example.com")"; fi
  validate_domain
  ENABLE_NGINX="yes"

  if is_yes "${ENABLE_HTTPS}"; then
    INSTALL_HTTPS_SELECTED=1
  elif is_no "${ENABLE_HTTPS}"; then
    INSTALL_HTTPS_SELECTED=0
  elif ask_yes_no "Apply for a Let's Encrypt HTTPS certificate now" "yes"; then
    INSTALL_HTTPS_SELECTED=1
  fi

  if [ "${INSTALL_HTTPS_SELECTED}" -eq 1 ]; then
    ENABLE_HTTPS="yes"
    if [ -z "${CERTBOT_EMAIL}" ] && can_prompt && ask_yes_no "Provide an email for Let's Encrypt notices" "no"; then
      CERTBOT_EMAIL="$(prompt_required "Certbot email")"
    fi
    log "Access mode: domain + HTTPS, https://${DOMAIN}/"
  else
    ENABLE_HTTPS="no"
    log "Access mode: domain + HTTP, http://${DOMAIN}/"
  fi
}

install_nginx_package() {
  if ! command -v nginx >/dev/null 2>&1; then install_package nginx; fi
  systemctl enable --now nginx >/dev/null 2>&1 || true
}

write_nginx_config() {
  validate_domain
  install_nginx_package
  nginx_conf="/etc/nginx/conf.d/${APP_NAME}.conf"
  if [ -d /etc/nginx/sites-available ] && [ -d /etc/nginx/sites-enabled ]; then
    nginx_conf="/etc/nginx/sites-available/${APP_NAME}.conf"
  fi

  cat > "${nginx_conf}" <<NGINX
server {
  listen 80;
  server_name ${DOMAIN};

  root ${APP_DIR}/dist/user-web;
  index index.html;

  location = /api { return 301 /api/; }

  location /api/ {
    proxy_pass http://127.0.0.1:${PORT}/api/;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }

  location = /admin { return 301 /admin/; }

  location /admin/assets/ {
    alias ${APP_DIR}/dist/admin-web/assets/;
    try_files \$uri =404;
    expires 1y;
    add_header Cache-Control "public, immutable";
  }

  location /admin/ {
    alias ${APP_DIR}/dist/admin-web/;
    try_files \$uri \$uri/ /admin/index.html;
  }

  location /assets/ {
    try_files \$uri =404;
    expires 1y;
    add_header Cache-Control "public, immutable";
  }

  location / {
    try_files \$uri \$uri/ /index.html;
  }
}
NGINX

  if [ -d /etc/nginx/sites-enabled ]; then
    ln -sfn "${nginx_conf}" "/etc/nginx/sites-enabled/${APP_NAME}.conf"
  fi

  nginx -t
  systemctl reload nginx
}

install_certbot() {
  if command -v certbot >/dev/null 2>&1; then return; fi
  case "${PKG_MANAGER}" in
    apt) DEBIAN_FRONTEND=noninteractive apt install -y certbot python3-certbot-nginx ;;
    dnf|yum) install_package epel-release || true; install_package certbot python3-certbot-nginx || true ;;
  esac
}

request_certificate() {
  validate_domain
  install_certbot
  email_args=(--register-unsafely-without-email)
  if [ -n "${CERTBOT_EMAIL}" ]; then email_args=(--email "${CERTBOT_EMAIL}"); fi
  certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos "${email_args[@]}" --redirect
  systemctl reload nginx
}

configure_optional_nginx() {
  if [ "${INSTALL_NGINX_SELECTED}" -ne 1 ]; then return; fi
  validate_domain

  write_nginx_config
  if [ "${INSTALL_HTTPS_SELECTED}" -eq 1 ]; then request_certificate; fi
}

write_management_command() {
  log "Writing shiye management command"
  cat > /usr/local/bin/shiye <<SHIYE_MENU
#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="\${APP_NAME:-${APP_NAME}}"
APP_DIR="\${APP_DIR:-${APP_DIR}}"
PORT="\${PORT:-${PORT}}"
MYSQL_DATABASE="\${MYSQL_DATABASE:-${MYSQL_DATABASE}}"
MYSQL_USER="\${MYSQL_USER:-${MYSQL_USER}}"
DEFAULT_REPO_URL="\${DEFAULT_REPO_URL:-${DEFAULT_REPO_URL}}"
INSTALL_URL="\${INSTALL_URL:-${INSTALL_URL}}"
UNINSTALL_URL="\${UNINSTALL_URL:-${UNINSTALL_URL}}"

log() { echo "==> \$*"; }
die() { echo "ERROR: \$*" >&2; exit 1; }
pause() { echo; read -r -p "按回车键返回菜单..." _; }

require_root() {
  [ "\$(id -u)" -eq 0 ] || die "请切换 root 用户后执行：shiye"
}

to_lower() { printf "%s" "\$1" | tr '[:upper:]' '[:lower:]'; }
is_yes() { case "\$(to_lower "\$1")" in y|yes|1|true|on|enable|enabled) return 0 ;; *) return 1 ;; esac; }

ask_yes_no() {
  prompt="\$1"
  default_answer="\$2"
  while true; do
    if is_yes "\${default_answer}"; then
      read -r -p "\${prompt} [Y/n]: " answer
      answer="\${answer:-y}"
    else
      read -r -p "\${prompt} [y/N]: " answer
      answer="\${answer:-n}"
    fi
    if is_yes "\${answer}"; then return 0; fi
    case "\$(to_lower "\${answer}")" in n|no|0|false|off|disable|disabled|skip) return 1 ;; esac
    echo "请输入 y 或 n。"
  done
}

prompt_required() {
  prompt="\$1"
  value=""
  while [ -z "\${value}" ]; do
    read -r -p "\${prompt}: " value
    value="\$(printf "%s" "\${value}" | sed 's/^[[:space:]]*//;s/[[:space:]]*\$//')"
  done
  printf "%s" "\${value}"
}

detect_server_ip() {
  detected_ip=""
  if command -v curl >/dev/null 2>&1; then
    detected_ip="\$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || true)"
  fi
  if [ -z "\${detected_ip}" ]; then
    detected_ip="\$(hostname -I 2>/dev/null | awk '{print \$1}' || true)"
  fi
  printf "%s" "\${detected_ip:-SERVER_IP}"
}

escape_sed_replacement() {
  printf "%s" "\$1" | sed 's/[\/&|]/\\&/g'
}

set_env_value() {
  [ -f "\${APP_DIR}/.env" ] || die "未找到 \${APP_DIR}/.env，请先安装项目。"
  key="\$1"
  value="\$2"
  escaped_value="\$(escape_sed_replacement "\${value}")"
  if grep -qE "^\${key}=" "\${APP_DIR}/.env"; then
    sed -i "s|^\${key}=.*|\${key}=\${escaped_value}|" "\${APP_DIR}/.env"
  else
    printf "\n%s=%s\n" "\${key}" "\${value}" >> "\${APP_DIR}/.env"
  fi
}

run_remote_install() {
  env_args=(APP_NAME="\${APP_NAME}" APP_DIR="\${APP_DIR}" PORT="\${PORT}" DEFAULT_REPO_URL="\${DEFAULT_REPO_URL}")
  if [ "\$#" -gt 0 ]; then env_args+=("\$@"); fi
  log "开始安装/更新管理面板"
  curl -fsSL "\${INSTALL_URL}" | env "\${env_args[@]}" bash
}

show_status() {
  systemctl --no-pager --full status "\${APP_NAME}" || true
}

restart_service() {
  systemctl restart "\${APP_NAME}"
  show_status
}

show_logs() {
  journalctl -u "\${APP_NAME}" -f
}

configure_domain() {
  domain="\$(prompt_required "请输入域名，例如 panel.example.com")"
  https="yes"
  if ! ask_yes_no "是否申请 Let's Encrypt HTTPS 证书" "yes"; then https="no"; fi
  email=""
  if [ "\${https}" = "yes" ] && ask_yes_no "是否填写证书通知邮箱" "no"; then
    email="\$(prompt_required "Certbot 邮箱")"
  fi

  args=(DOMAIN="\${domain}" ENABLE_NGINX=yes ENABLE_HTTPS="\${https}")
  if [ -n "\${email}" ]; then args+=(CERTBOT_EMAIL="\${email}"); fi
  run_remote_install "\${args[@]}"
}

remove_domain_access() {
  log "取消域名/Nginx 访问，改为 IP + 端口"
  rm -f "/etc/nginx/conf.d/\${APP_NAME}.conf"
  rm -f "/etc/nginx/sites-available/\${APP_NAME}.conf"
  rm -f "/etc/nginx/sites-enabled/\${APP_NAME}.conf"
  if command -v nginx >/dev/null 2>&1; then
    nginx -t && systemctl reload nginx || true
  fi
  public_url="http://\$(detect_server_ip):\${PORT}"
  set_env_value PUBLIC_WEB_URL "\${public_url}"
  systemctl restart "\${APP_NAME}"
  echo "已切换为：\${public_url}/"
}

rebuild_project() {
  echo "精简部署目录默认不保留前后端源码。"
  echo "此操作会重新拉取最新代码、执行迁移、重新构建并重启服务，保留 .env 和数据库。"
  if ask_yes_no "确认继续重新构建/更新" "yes"; then
    run_remote_install
  fi
}

run_migration() {
  [ -d "\${APP_DIR}" ] || die "未找到安装目录：\${APP_DIR}"
  [ -f "\${APP_DIR}/prisma/schema.prisma" ] || die "未找到 Prisma schema，请使用安装/更新项目恢复运行文件。"
  cd "\${APP_DIR}"
  log "安装迁移所需依赖"
  if [ -f package-lock.json ]; then npm install; else npm install; fi
  log "执行数据库迁移"
  npm run prisma:generate
  npm run prisma:migrate
  npm prune --omit=dev
  chown -R shiye:shiye "\${APP_DIR}" 2>/dev/null || true
  systemctl restart "\${APP_NAME}"
  log "数据库迁移完成"
}

read_database_url() {
  [ -f "\${APP_DIR}/.env" ] || return 1
  grep -E '^DATABASE_URL=' "\${APP_DIR}/.env" | tail -n 1 | cut -d= -f2-
}

backup_project() {
  backup_dir="/root/shiye-backup-\$(date +%Y%m%d%H%M%S)"
  mkdir -p "\${backup_dir}"
  if [ -f "\${APP_DIR}/.env" ]; then cp -a "\${APP_DIR}/.env" "\${backup_dir}/.env"; fi

  database_url="\$(read_database_url || true)"
  if [ -n "\${database_url}" ] && command -v node >/dev/null 2>&1 && command -v mysqldump >/dev/null 2>&1; then
    db_json="\$(DATABASE_URL="\${database_url}" node -e 'const u = new URL(process.env.DATABASE_URL); console.log(JSON.stringify({user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), host: u.hostname || "127.0.0.1", port: u.port || "3306", database: u.pathname.replace(/^\\//, "")}));')"
    db_user="\$(printf "%s" "\${db_json}" | node -e 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>console.log(JSON.parse(s).user));')"
    db_password="\$(printf "%s" "\${db_json}" | node -e 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>console.log(JSON.parse(s).password));')"
    db_host="\$(printf "%s" "\${db_json}" | node -e 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>console.log(JSON.parse(s).host));')"
    db_port="\$(printf "%s" "\${db_json}" | node -e 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>console.log(JSON.parse(s).port));')"
    db_name="\$(printf "%s" "\${db_json}" | node -e 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>console.log(JSON.parse(s).database));')"
    MYSQL_PWD="\${db_password}" mysqldump -h "\${db_host}" -P "\${db_port}" -u "\${db_user}" "\${db_name}" > "\${backup_dir}/\${db_name}.sql"
  else
    echo "未执行数据库备份：未找到 DATABASE_URL、node 或 mysqldump。"
  fi

  echo "备份目录：\${backup_dir}"
}

uninstall_project() {
  if ask_yes_no "确认卸载项目？默认保留数据库" "no"; then
    curl -fsSL "\${UNINSTALL_URL}" | env APP_NAME="\${APP_NAME}" APP_DIR="\${APP_DIR}" MYSQL_DATABASE="\${MYSQL_DATABASE}" MYSQL_USER="\${MYSQL_USER}" DELETE_DATABASE=no bash
  fi
}

uninstall_project_and_database() {
  echo "此操作会删除项目和数据库，业务数据会清空。"
  read -r -p "请输入 DELETE 确认删除数据库: " confirm
  [ "\${confirm}" = "DELETE" ] || die "已取消删除数据库"
  curl -fsSL "\${UNINSTALL_URL}" | env APP_NAME="\${APP_NAME}" APP_DIR="\${APP_DIR}" MYSQL_DATABASE="\${MYSQL_DATABASE}" MYSQL_USER="\${MYSQL_USER}" DELETE_DATABASE=yes bash
}

menu() {
  while true; do
    clear || true
    cat <<'MENU'
管理面板

1. 安装/更新项目
2. 查看服务状态
3. 重启服务
4. 查看运行日志
5. 配置域名/Nginx/HTTPS
6. 取消域名，仅使用 IP + 端口
7. 重新构建前后端
8. 执行数据库迁移
9. 备份数据库和 .env
10. 卸载项目
11. 卸载项目并删除数据库
0. 退出
MENU
    echo
    read -r -p "请选择操作: " choice
    case "\${choice}" in
      1) run_remote_install; pause ;;
      2) show_status; pause ;;
      3) restart_service; pause ;;
      4) show_logs ;;
      5) configure_domain; pause ;;
      6) remove_domain_access; pause ;;
      7) rebuild_project; pause ;;
      8) run_migration; pause ;;
      9) backup_project; pause ;;
      10) uninstall_project; pause ;;
      11) uninstall_project_and_database; pause ;;
      0) exit 0 ;;
      *) echo "无效选项"; pause ;;
    esac
  done
}

require_root
menu
SHIYE_MENU
  chmod 755 /usr/local/bin/shiye
}

main() {
  require_root
  detect_pkg_manager

  log "Selecting access mode"
  select_access_mode

  log "Installing base packages"
  install_base_packages

  log "Loading existing .env if present"
  load_existing_env_defaults || true

  log "Checking Node.js 20+"
  install_node

  log "Checking MySQL"
  install_local_mysql_if_needed

  stop_existing_service_for_update

  log "Installing project files to ${APP_DIR}"
  install_app_files

  log "Writing .env"
  write_env_file

  log "Installing dependencies, migrating database and building"
  install_dependencies_and_build

  log "Verifying runtime files"
  verify_runtime_files

  cleanup_runtime_files

  verify_runtime_files

  log "Writing systemd service"
  write_service
  systemctl daemon-reload
  systemctl enable "${APP_NAME}"
  systemctl restart "${APP_NAME}"
  wait_for_api_health
  verify_web_routes

  configure_optional_nginx

  write_management_command

  systemctl --no-pager --full status "${APP_NAME}" || true

  base_url="http://$(detect_server_ip):${PORT}"
  if [ "${INSTALL_NGINX_SELECTED:-0}" -eq 1 ]; then
    base_url="http://${DOMAIN}"
    if [ "${INSTALL_HTTPS_SELECTED:-0}" -eq 1 ]; then base_url="https://${DOMAIN}"; fi
  else
    echo
    echo "Nginx/domain access was not enabled. Open port ${PORT} in the server firewall/security group, or rerun with DOMAIN and ENABLE_NGINX=yes."
  fi

  admin_password="$(grep -E '^DEFAULT_ADMIN_PASSWORD=' "${APP_DIR}/.env" | tail -n 1 | cut -d= -f2-)"
  echo
  echo "Installation complete."
  echo "User URL:  ${base_url}/"
  echo "Admin URL: ${base_url}/admin/"
  echo "API health: ${base_url}/api/health"
  echo "Default admin username: $(grep -E '^DEFAULT_ADMIN_USERNAME=' "${APP_DIR}/.env" | tail -n 1 | cut -d= -f2-)"
  echo "Default admin password: ${admin_password}"
  echo
  echo "Useful commands:"
  echo "systemctl status ${APP_NAME}"
  echo "systemctl restart ${APP_NAME}"
  echo "journalctl -u ${APP_NAME} -f"
  echo "shiye  # 打开管理菜单"
}

main "$@"
