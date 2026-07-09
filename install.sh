#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-shiye-management-system}"
APP_DIR="${APP_DIR:-/opt/shiye-management-system}"
PORT="${PORT:-3388}"
ADMIN_PATH="${ADMIN_PATH:-/admin}"
REPO_URL="${REPO_URL:-}"
DEFAULT_REPO_URL="https://github.com/wstimin/3-xuiguanli-shangye.git"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
ENV_FILE="/etc/default/${APP_NAME}"

ENABLE_NGINX="${ENABLE_NGINX:-ask}"
ENABLE_HTTPS="${ENABLE_HTTPS:-ask}"
DOMAIN="${DOMAIN:-${SITE_DOMAIN:-}}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"

MYSQL_DATABASE="${MYSQL_DATABASE:-shiye_management}"
MYSQL_USER="${MYSQL_USER:-shiye}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
MYSQL_CONNECTION_LIMIT="${MYSQL_CONNECTION_LIMIT:-10}"
SESSION_PREFIX="${SESSION_PREFIX:-shiye:session:}"

log() { echo "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

to_lower() {
  printf "%s" "$1" | tr '[:upper:]' '[:lower:]'
}

is_yes() {
  value="$(to_lower "$1")"
  [ "${value}" = "y" ] || [ "${value}" = "yes" ] || [ "${value}" = "1" ] || [ "${value}" = "true" ] || [ "${value}" = "on" ] || [ "${value}" = "enable" ] || [ "${value}" = "enabled" ]
}

is_no() {
  value="$(to_lower "$1")"
  [ "${value}" = "n" ] || [ "${value}" = "no" ] || [ "${value}" = "0" ] || [ "${value}" = "false" ] || [ "${value}" = "off" ] || [ "${value}" = "disable" ] || [ "${value}" = "disabled" ] || [ "${value}" = "skip" ]
}

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

    if is_yes "${answer}"; then
      return 0
    fi
    if is_no "${answer}"; then
      return 1
    fi
    echo "Please answer yes or no."
  done
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "Please run as root: sudo bash install.sh"
  command -v systemctl >/dev/null 2>&1 || die "systemd is required for one-click service installation"
}

normalize_app_dir() {
  parent_dir="$(dirname "${APP_DIR}")"
  base_name="$(basename "${APP_DIR}")"
  [ -n "${base_name}" ] && [ "${base_name}" != "." ] && [ "${base_name}" != "/" ] || die "Invalid APP_DIR: ${APP_DIR}"
  mkdir -p "${parent_dir}"
  parent_abs="$(cd "${parent_dir}" && pwd -P)"
  if [ "${parent_abs}" = "/" ]; then
    APP_DIR="/${base_name}"
  else
    APP_DIR="${parent_abs}/${base_name}"
  fi

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

install_base_packages() {
  case "${PKG_MANAGER}" in
    apt)
      apt update
      DEBIAN_FRONTEND=noninteractive apt install -y curl ca-certificates gnupg git openssl
      ;;
    dnf)
      dnf install -y curl ca-certificates git openssl
      ;;
    yum)
      yum install -y curl ca-certificates git openssl
      ;;
  esac
}

install_package() {
  package_name="$1"
  case "${PKG_MANAGER}" in
    apt)
      DEBIAN_FRONTEND=noninteractive apt install -y "${package_name}"
      ;;
    dnf)
      dnf install -y "${package_name}"
      ;;
    yum)
      yum install -y "${package_name}"
      ;;
  esac
}

install_node() {
  if command -v node >/dev/null 2>&1; then
    major="$(node -v | sed 's/^v//' | cut -d. -f1)"
    if [ "${major}" -ge 20 ]; then
      return
    fi
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

random_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16
  else
    node -e "console.log(require('crypto').randomBytes(18).toString('hex'))"
  fi
}

validate_mysql_name() {
  value="$1"
  label="$2"
  echo "${value}" | grep -Eq '^[A-Za-z0-9_]+$' || die "${label} can only contain letters, numbers and underscores"
}

sql_string() {
  printf "%s" "$1" | sed "s/'/''/g"
}

start_mysql_service() {
  for service in mysql mysqld mariadb; do
    if systemctl list-unit-files "${service}.service" >/dev/null 2>&1; then
      systemctl enable --now "${service}" >/dev/null 2>&1 || true
    fi
    if systemctl is-active --quiet "${service}" >/dev/null 2>&1; then
      return
    fi
  done
  die "MySQL service is not running. Please check mysql/mariadb installation"
}

mysql_root_exec() {
  if [ -n "${MYSQL_ROOT_PASSWORD:-}" ]; then
    MYSQL_PWD="${MYSQL_ROOT_PASSWORD}" mysql -uroot -e "$1"
  else
    mysql -uroot -e "$1"
  fi
}

install_local_mysql_if_needed() {
  if [ -n "${DATABASE_URL:-}" ] || [ -n "${MYSQL_HOST:-}" ]; then
    log "External MySQL config detected, skipping local MySQL installation"
    return
  fi

  MYSQL_HOST="127.0.0.1"
  MYSQL_PASSWORD="${MYSQL_PASSWORD:-$(random_password)}"
  validate_mysql_name "${MYSQL_DATABASE}" "MYSQL_DATABASE"
  validate_mysql_name "${MYSQL_USER}" "MYSQL_USER"

  if ! command -v mysql >/dev/null 2>&1; then
    log "Installing local MySQL-compatible server"
    case "${PKG_MANAGER}" in
      apt)
        DEBIAN_FRONTEND=noninteractive apt install -y default-mysql-server
        ;;
      dnf)
        dnf install -y mysql-server || dnf install -y mariadb-server
        ;;
      yum)
        yum install -y mysql-server || yum install -y mariadb-server
        ;;
    esac
  fi

  start_mysql_service

  db="${MYSQL_DATABASE}"
  user="${MYSQL_USER}"
  password="$(sql_string "${MYSQL_PASSWORD}")"
  mysql_root_exec "CREATE DATABASE IF NOT EXISTS \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
  mysql_root_exec "CREATE USER IF NOT EXISTS '${user}'@'127.0.0.1' IDENTIFIED BY '${password}';"
  mysql_root_exec "ALTER USER '${user}'@'127.0.0.1' IDENTIFIED BY '${password}';"
  mysql_root_exec "GRANT ALL PRIVILEGES ON \`${db}\`.* TO '${user}'@'127.0.0.1'; FLUSH PRIVILEGES;"
}

install_app_files() {
  normalize_app_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  mkdir -p "${APP_DIR}"
  preserve_dir="$(mktemp -d)"
  if [ -d "${APP_DIR}/data" ]; then
    cp -a "${APP_DIR}/data" "${preserve_dir}/data"
  fi

  if [ -n "${REPO_URL}" ]; then
    tmp_dir="$(mktemp -d)"
    git clone --depth 1 "${REPO_URL}" "${tmp_dir}/app"
    find "${APP_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    cp -a "${tmp_dir}/app/." "${APP_DIR}/"
    rm -rf "${tmp_dir}"
  elif [ -f "${script_dir}/server.js" ] && [ -f "${script_dir}/public/app.js" ] && [ -f "${script_dir}/public/user.js" ]; then
    if [ "${script_dir}" != "${APP_DIR}" ]; then
      find "${APP_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
      find "${script_dir}" -mindepth 1 -maxdepth 1 -exec cp -a {} "${APP_DIR}/" \;
    fi
  else
    tmp_dir="$(mktemp -d)"
    git clone --depth 1 "${DEFAULT_REPO_URL}" "${tmp_dir}/app"
    find "${APP_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    cp -a "${tmp_dir}/app/." "${APP_DIR}/"
    rm -rf "${tmp_dir}"
  fi

  if [ -d "${preserve_dir}/data" ]; then
    rm -rf "${APP_DIR}/data"
    cp -a "${preserve_dir}/data" "${APP_DIR}/data"
  fi
  rm -rf "${preserve_dir}"
  mkdir -p "${APP_DIR}/data"
}

install_dependencies() {
  cd "${APP_DIR}"
  if [ -f package-lock.json ]; then
    npm ci --omit=dev || npm install --omit=dev
  else
    npm install --omit=dev
  fi
}

existing_secret() {
  if [ -n "${APP_SECRET:-}" ]; then
    printf "%s" "${APP_SECRET}"
  elif [ -n "${SHIYE_SECRET:-}" ]; then
    printf "%s" "${SHIYE_SECRET}"
  elif [ -f "${ENV_FILE}" ]; then
    grep -E '^APP_SECRET=' "${ENV_FILE}" | tail -n 1 | sed 's/^APP_SECRET=//' | sed 's/^"//' | sed 's/"$//' || true
  elif [ -f "${APP_DIR}/data/.secret" ]; then
    tr -d '\r\n' < "${APP_DIR}/data/.secret"
  fi
}

write_service() {
  secret="$(existing_secret)"
  if [ -z "${secret}" ]; then
    secret="$(random_password)$(random_password)"
  fi
  NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
  [ -n "${NODE_BIN}" ] || die "node binary was not found"

  write_env_var() {
    key="$1"
    value="$2"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    printf '%s="%s"\n' "${key}" "${value}"
  }

  {
    write_env_var PORT "${PORT}"
    write_env_var ADMIN_PATH "${ADMIN_PATH}"
    write_env_var APP_SECRET "${secret}"
    write_env_var DATABASE_URL "${DATABASE_URL:-}"
    write_env_var MYSQL_HOST "${MYSQL_HOST:-127.0.0.1}"
    write_env_var MYSQL_PORT "${MYSQL_PORT}"
    write_env_var MYSQL_USER "${MYSQL_USER}"
    write_env_var MYSQL_PASSWORD "${MYSQL_PASSWORD:-}"
    write_env_var MYSQL_DATABASE "${MYSQL_DATABASE}"
    write_env_var MYSQL_CONNECTION_LIMIT "${MYSQL_CONNECTION_LIMIT}"
    write_env_var REDIS_URL "${REDIS_URL:-}"
    write_env_var SESSION_PREFIX "${SESSION_PREFIX}"
  } > "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"

  cat > "${SERVICE_FILE}" <<SERVICE
[Unit]
Description=Shiye Management System
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SERVICE
}

validate_domain() {
  [ -n "${DOMAIN}" ] || die "DOMAIN is required when Nginx is enabled"
  echo "${DOMAIN}" | grep -Eq '^[A-Za-z0-9.-]+$' || die "DOMAIN can only contain letters, numbers, dots and hyphens"
  echo "${DOMAIN}" | grep -Eq '\.' || die "DOMAIN must be a valid domain name, for example example.com"
}

install_nginx_package() {
  if ! command -v nginx >/dev/null 2>&1; then
    log "Installing Nginx"
    install_package nginx
  fi
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

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
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
  if command -v certbot >/dev/null 2>&1; then
    return
  fi

  log "Installing Certbot"
  case "${PKG_MANAGER}" in
    apt)
      DEBIAN_FRONTEND=noninteractive apt install -y certbot python3-certbot-nginx
      ;;
    dnf|yum)
      install_package epel-release || true
      install_package certbot
      install_package python3-certbot-nginx || true
      ;;
  esac
}

request_certificate() {
  validate_domain
  install_certbot

  email_args=(--register-unsafely-without-email)
  if [ -n "${CERTBOT_EMAIL}" ]; then
    email_args=(--email "${CERTBOT_EMAIL}")
  fi

  certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos "${email_args[@]}" --redirect
  systemctl reload nginx
}

prompt_optional_nginx() {
  INSTALL_NGINX_SELECTED=0
  INSTALL_HTTPS_SELECTED=0

  if is_yes "${ENABLE_NGINX}"; then
    INSTALL_NGINX_SELECTED=1
  elif is_no "${ENABLE_NGINX}"; then
    INSTALL_NGINX_SELECTED=0
  elif ask_yes_no "Install Nginx reverse proxy and use domain access?" "no"; then
    INSTALL_NGINX_SELECTED=1
  fi

  if [ "${INSTALL_NGINX_SELECTED}" -ne 1 ]; then
    return
  fi

  if [ -z "${DOMAIN}" ] && [ -t 0 ]; then
    read -r -p "Domain name, for example panel.example.com: " DOMAIN
  fi
  validate_domain

  if is_yes "${ENABLE_HTTPS}"; then
    INSTALL_HTTPS_SELECTED=1
  elif is_no "${ENABLE_HTTPS}"; then
    INSTALL_HTTPS_SELECTED=0
  elif ask_yes_no "Apply for a Let's Encrypt HTTPS certificate now?" "yes"; then
    INSTALL_HTTPS_SELECTED=1
  fi
}

configure_optional_nginx() {
  prompt_optional_nginx
  if [ "${INSTALL_NGINX_SELECTED}" -ne 1 ]; then
    return
  fi

  log "Configuring Nginx reverse proxy for ${DOMAIN}"
  write_nginx_config

  if [ "${INSTALL_HTTPS_SELECTED}" -eq 1 ]; then
    log "Requesting HTTPS certificate for ${DOMAIN}"
    request_certificate
  fi
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

  log "Installing Node.js dependencies"
  install_dependencies

  log "Checking JavaScript syntax"
  cd "${APP_DIR}"
  node --check server.js
  node --check public/app.js
  node --check public/user.js

  log "Writing systemd service"
  write_service
  systemctl daemon-reload
  systemctl enable "${APP_NAME}"
  systemctl restart "${APP_NAME}"

  configure_optional_nginx

  log "Service status"
  systemctl --no-pager --full status "${APP_NAME}" || true

  ip_addr="$(hostname -I 2>/dev/null | awk '{print $1}')"
  public_base_url="http://${ip_addr:-SERVER_IP}:${PORT}"
  if [ "${INSTALL_NGINX_SELECTED:-0}" -eq 1 ]; then
    public_base_url="http://${DOMAIN}"
    if [ "${INSTALL_HTTPS_SELECTED:-0}" -eq 1 ]; then
      public_base_url="https://${DOMAIN}"
    fi
  fi
  echo
  echo "Installation complete."
  echo "User URL:  ${public_base_url}/"
  echo "Admin URL: ${public_base_url}${ADMIN_PATH}"
  echo "Storage: MySQL"
  if [ "${INSTALL_NGINX_SELECTED:-0}" -eq 1 ]; then
    echo "Nginx: enabled for ${DOMAIN}"
  else
    echo "Nginx: skipped, direct HTTP port access is enabled"
  fi
  echo "Default admin username: admin"
  echo "Default admin password: admin123"
  echo
  echo "Useful commands:"
  echo "systemctl status ${APP_NAME}"
  echo "systemctl restart ${APP_NAME}"
  echo "journalctl -u ${APP_NAME} -f"
}

main "$@"
