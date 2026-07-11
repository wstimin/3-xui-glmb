#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-shiye-api}"
APP_DIR="${APP_DIR:-/opt/shiye}"
MYSQL_DATABASE="${MYSQL_DATABASE:-shiye_management}"
MYSQL_USER="${MYSQL_USER:-shiye}"
DELETE_DATABASE="${DELETE_DATABASE:-ask}"
DELETE_NGINX="${DELETE_NGINX:-yes}"
DELETE_PROJECT="${DELETE_PROJECT:-yes}"
DELETE_SYSTEM_USER="${DELETE_SYSTEM_USER:-no}"
BACKUP_BEFORE_DELETE="${BACKUP_BEFORE_DELETE:-yes}"

SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"

log() { echo "==> $*"; }
warn() { echo "WARNING: $*" >&2; }
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
  [ "$(id -u)" -eq 0 ] || die "Please switch to root and run: bash uninstall.sh"
}

normalize_app_dir() {
  parent_dir="$(dirname "${APP_DIR}")"
  base_name="$(basename "${APP_DIR}")"
  [ -n "${base_name}" ] && [ "${base_name}" != "." ] && [ "${base_name}" != "/" ] || die "Invalid APP_DIR: ${APP_DIR}"
  if [ -d "${parent_dir}" ]; then
    parent_abs="$(cd "${parent_dir}" && pwd -P)"
    APP_DIR="${parent_abs}/${base_name}"
  fi

  case "${APP_DIR}" in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var|/www|/www/wwwroot)
      die "Refusing unsafe APP_DIR: ${APP_DIR}"
      ;;
  esac
}

backup_files() {
  if ! is_yes "${BACKUP_BEFORE_DELETE}"; then return; fi
  backup_dir="/root/${APP_NAME}-backup-$(date +%Y%m%d%H%M%S)"
  mkdir -p "${backup_dir}"

  if [ -f "${APP_DIR}/.env" ]; then
    cp -a "${APP_DIR}/.env" "${backup_dir}/.env"
  fi

  for path in "/etc/nginx/conf.d/${APP_NAME}.conf" "/etc/nginx/sites-available/${APP_NAME}.conf" "/etc/nginx/sites-enabled/${APP_NAME}.conf" "${SERVICE_FILE}"; do
    if [ -f "${path}" ] || [ -L "${path}" ]; then
      cp -a "${path}" "${backup_dir}/$(basename "${path}")" 2>/dev/null || true
    fi
  done

  if command -v mysqldump >/dev/null 2>&1 && is_yes "${DELETE_DATABASE}"; then
    if [ -n "${MYSQL_ROOT_PASSWORD:-}" ]; then
      MYSQL_PWD="${MYSQL_ROOT_PASSWORD}" mysqldump -uroot "${MYSQL_DATABASE}" > "${backup_dir}/${MYSQL_DATABASE}.sql" 2>/dev/null || true
    else
      mysqldump -uroot "${MYSQL_DATABASE}" > "${backup_dir}/${MYSQL_DATABASE}.sql" 2>/dev/null || true
    fi
  fi

  log "Backup saved to ${backup_dir}"
}

stop_service() {
  log "Stopping systemd service ${APP_NAME}"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl stop "${APP_NAME}" >/dev/null 2>&1 || true
    systemctl disable "${APP_NAME}" >/dev/null 2>&1 || true
    rm -f "${SERVICE_FILE}"
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl reset-failed >/dev/null 2>&1 || true
  else
    rm -f "${SERVICE_FILE}"
  fi
}

remove_nginx() {
  if ! is_yes "${DELETE_NGINX}"; then return; fi
  log "Removing Nginx config for ${APP_NAME}"
  rm -f "/etc/nginx/conf.d/${APP_NAME}.conf"
  rm -f "/etc/nginx/sites-available/${APP_NAME}.conf"
  rm -f "/etc/nginx/sites-enabled/${APP_NAME}.conf"
  if command -v nginx >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then
    nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || true
  fi
}

remove_project() {
  if ! is_yes "${DELETE_PROJECT}"; then return; fi
  normalize_app_dir
  if [ -e "${APP_DIR}" ]; then
    log "Removing project directory ${APP_DIR}"
    rm -rf "${APP_DIR}"
  fi
}

mysql_root_exec() {
  if [ -n "${MYSQL_ROOT_PASSWORD:-}" ]; then
    MYSQL_PWD="${MYSQL_ROOT_PASSWORD}" mysql -uroot -e "$1"
  else
    mysql -uroot -e "$1"
  fi
}

should_delete_database() {
  default_answer="${1:-no}"
  if is_yes "${DELETE_DATABASE}"; then return 0; fi
  if is_no "${DELETE_DATABASE}"; then return 1; fi
  ask_yes_no "Delete MySQL database ${MYSQL_DATABASE} and user ${MYSQL_USER}? This will remove business data." "${default_answer}"
}

resolve_delete_database_selection() {
  if is_yes "${DELETE_DATABASE}"; then
    DELETE_DATABASE="yes"
    return
  fi
  if is_no "${DELETE_DATABASE}"; then
    DELETE_DATABASE="no"
    return
  fi
  if ask_yes_no "Delete MySQL database ${MYSQL_DATABASE} and user ${MYSQL_USER}? This will remove business data." "no"; then
    DELETE_DATABASE="yes"
  else
    DELETE_DATABASE="no"
  fi
}

remove_database() {
  if ! should_delete_database no; then
    log "Keeping database ${MYSQL_DATABASE}"
    return
  fi

  command -v mysql >/dev/null 2>&1 || die "mysql command was not found; cannot delete database"
  echo "Type DELETE to confirm deleting database ${MYSQL_DATABASE}:"
  if [ -t 0 ]; then
    read -r confirm
    [ "${confirm}" = "DELETE" ] || die "Database deletion cancelled"
  fi

  log "Dropping database ${MYSQL_DATABASE} and user ${MYSQL_USER}"
  mysql_root_exec "DROP DATABASE IF EXISTS \`${MYSQL_DATABASE}\`; DROP USER IF EXISTS '${MYSQL_USER}'@'127.0.0.1'; DROP USER IF EXISTS '${MYSQL_USER}'@'localhost'; DROP USER IF EXISTS '${MYSQL_USER}'@'%'; FLUSH PRIVILEGES;"
}

remove_system_user() {
  if ! is_yes "${DELETE_SYSTEM_USER}"; then return; fi
  if id shiye >/dev/null 2>&1; then
    log "Removing system user shiye"
    userdel shiye >/dev/null 2>&1 || true
  fi
}

main() {
  require_root
  normalize_app_dir
  resolve_delete_database_selection
  backup_files
  stop_service
  remove_nginx
  remove_project
  remove_database
  remove_system_user

  echo
  echo "Uninstall complete."
  echo "Service: ${APP_NAME}"
  echo "Project directory: ${APP_DIR}"
  echo "Database deletion: ${DELETE_DATABASE}"
}

main "$@"
