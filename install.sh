#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-shiye-api}"
APP_DIR="${APP_DIR:-/opt/shiye}"
PORT="${PORT:-3388}"
REPO_URL="${REPO_URL:-}"
DEFAULT_REPO_URL="${DEFAULT_REPO_URL:-https://github.com/wstimin/shiye-3xuigl-L3.git}"
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
  if [ ! -t 0 ]; then
    is_yes "${default_answer}"
    return
  fi

  while true; do
    if is_yes "${default_answer}"; then
      read -r -p "${prompt} [Y/n]: " answer
      answer="${answer:-y}"
    else
      read -r -p "${prompt} [y/N]: " answer
      answer="${answer:-n}"
    fi

    if is_yes "${answer}"; then return 0; fi
    if is_no "${answer}"; then return 1; fi
    echo "Please answer yes or no."
  done
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "Please run as root: sudo bash install.sh"
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
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  mkdir -p "${APP_DIR}"

  if [ -n "${REPO_URL}" ]; then
    tmp_dir="$(mktemp -d)"
    git clone --depth 1 "${REPO_URL}" "${tmp_dir}/app"
    find "${APP_DIR}" -mindepth 1 -maxdepth 1 ! -name '.env' -exec rm -rf {} +
    cp -a "${tmp_dir}/app/." "${APP_DIR}/"
    rm -rf "${tmp_dir}"
  elif [ -f "${script_dir}/package.json" ] && [ -d "${script_dir}/apps" ] && [ -d "${script_dir}/packages" ]; then
    if [ "${script_dir}" != "${APP_DIR}" ]; then
      find "${APP_DIR}" -mindepth 1 -maxdepth 1 ! -name '.env' -exec rm -rf {} +
      find "${script_dir}" -mindepth 1 -maxdepth 1 ! -name '.env' ! -name 'node_modules' ! -name 'dist' -exec cp -a {} "${APP_DIR}/" \;
    fi
  elif [ -n "${DEFAULT_REPO_URL}" ]; then
    tmp_dir="$(mktemp -d)"
    git clone --depth 1 "${DEFAULT_REPO_URL}" "${tmp_dir}/app"
    find "${APP_DIR}" -mindepth 1 -maxdepth 1 ! -name '.env' -exec rm -rf {} +
    cp -a "${tmp_dir}/app/." "${APP_DIR}/"
    rm -rf "${tmp_dir}"
  else
    die "Project files not found. Run this script from the project root or pass REPO_URL=https://github.com/owner/repo.git"
  fi
}

write_env_file() {
  cd "${APP_DIR}"
  if [ -f .env ]; then
    log "Keeping existing ${APP_DIR}/.env"
    return
  fi

  public_url="${PUBLIC_WEB_URL:-}"
  if [ -z "${public_url}" ]; then
    if [ -n "${DOMAIN}" ]; then
      if is_no "${ENABLE_HTTPS}"; then public_url="http://${DOMAIN}"; else public_url="https://${DOMAIN}"; fi
    else
      public_url="http://127.0.0.1:${PORT}"
    fi
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

validate_domain() {
  [ -n "${DOMAIN}" ] || die "DOMAIN is required when Nginx is enabled"
  echo "${DOMAIN}" | grep -Eq '^[A-Za-z0-9.-]+$' || die "DOMAIN can only contain letters, numbers, dots and hyphens"
  echo "${DOMAIN}" | grep -Eq '\.' || die "DOMAIN must be a valid domain name, for example panel.example.com"
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
  INSTALL_NGINX_SELECTED=0
  INSTALL_HTTPS_SELECTED=0

  if is_yes "${ENABLE_NGINX}"; then
    INSTALL_NGINX_SELECTED=1
  elif is_no "${ENABLE_NGINX}"; then
    INSTALL_NGINX_SELECTED=0
  elif ask_yes_no "Install Nginx reverse proxy and serve web pages?" "yes"; then
    INSTALL_NGINX_SELECTED=1
  fi

  if [ "${INSTALL_NGINX_SELECTED}" -ne 1 ]; then return; fi
  if [ -z "${DOMAIN}" ] && [ -t 0 ]; then read -r -p "Domain name, for example panel.example.com: " DOMAIN; fi
  validate_domain

  if is_yes "${ENABLE_HTTPS}"; then
    INSTALL_HTTPS_SELECTED=1
  elif is_no "${ENABLE_HTTPS}"; then
    INSTALL_HTTPS_SELECTED=0
  elif ask_yes_no "Apply for a Let's Encrypt HTTPS certificate now?" "yes"; then
    INSTALL_HTTPS_SELECTED=1
  fi

  write_nginx_config
  if [ "${INSTALL_HTTPS_SELECTED}" -eq 1 ]; then request_certificate; fi
}

main() {
  require_root
  detect_pkg_manager

  log "Installing base packages"
  install_base_packages

  log "Checking Node.js 20+"
  install_node

  log "Checking MySQL"
  install_local_mysql_if_needed

  log "Installing project files to ${APP_DIR}"
  install_app_files

  log "Writing .env"
  write_env_file

  log "Installing dependencies, migrating database and building"
  install_dependencies_and_build

  log "Writing systemd service"
  write_service
  systemctl daemon-reload
  systemctl enable "${APP_NAME}"
  systemctl restart "${APP_NAME}"

  configure_optional_nginx

  systemctl --no-pager --full status "${APP_NAME}" || true

  base_url="http://SERVER_IP:${PORT}"
  if [ "${INSTALL_NGINX_SELECTED:-0}" -eq 1 ]; then
    base_url="http://${DOMAIN}"
    if [ "${INSTALL_HTTPS_SELECTED:-0}" -eq 1 ]; then base_url="https://${DOMAIN}"; fi
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
}

main "$@"
