import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_CONFIG_FILE = path.join(__dirname, 'data', 'config.json');
const SECRET_FILE = path.join(__dirname, 'data', '.secret');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3388);
let currentAdminPath = normalizeRoutePath(process.env.ADMIN_PATH || '/admin');
let runtimeConfig = readRuntimeConfigSync();
const DEFAULT_ADMIN_USER = process.env.ADMIN_USER || 'admin';
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const INBOUND_TEMPLATES = new Set(['vless-tcp', 'vless-reality', 'vless-tls', 'vless-ws', 'vless-grpc']);
const DEFAULT_ALPN = Object.freeze(['h3', 'h2', 'http/1.1']);
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const NODE_MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;
const REDIS_URL = String(process.env.REDIS_URL || '').trim();
const SESSION_PREFIX = String(process.env.SESSION_PREFIX || 'shiye:session:').trim() || 'shiye:session:';

const sessions = new Map();
const loginAttempts = new Map();
let mysqlPool = null;
let redisClient = null;
let apiWriteQueue = Promise.resolve();
let setupRequired = false;
let maintenanceRunning = false;
let maintenanceTimer = null;

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (!session || session.expiresAt < now) sessions.delete(token);
  }
  for (const [key, entry] of loginAttempts) {
    if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  }
}, 30 * 60 * 1000).unref();

async function initSessionStore() {
  if (!REDIS_URL) return;
  try {
    const redis = await import('redis');
    redisClient = redis.createClient({ url: REDIS_URL });
    redisClient.on('error', (error) => console.error('Redis Session 错误:', error.message));
    await redisClient.connect();
  } catch (error) {
    redisClient = null;
    console.warn(`Redis Session 未启用：${error.message}`);
  }
}

function sessionKey(token) {
  return `${SESSION_PREFIX}${token}`;
}

async function saveSession(token, payload) {
  const session = { ...payload, expiresAt: Date.now() + SESSION_TTL_MS };
  if (redisClient) {
    await redisClient.set(sessionKey(token), JSON.stringify(session), { PX: SESSION_TTL_MS });
    return session;
  }
  sessions.set(token, session);
  return session;
}

async function loadSession(token) {
  if (!token) return null;
  if (redisClient) {
    const text = await redisClient.get(sessionKey(token));
    if (!text) return null;
    try {
      const session = JSON.parse(text);
      if (!session || session.expiresAt < Date.now()) {
        await redisClient.del(sessionKey(token));
        return null;
      }
      return session;
    } catch {
      await redisClient.del(sessionKey(token));
      return null;
    }
  }
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  return session;
}

async function refreshSession(token, session) {
  if (!token || !session) return;
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  if (redisClient) await redisClient.set(sessionKey(token), JSON.stringify(session), { PX: SESSION_TTL_MS });
  else sessions.set(token, session);
}

async function deleteSession(token) {
  if (!token) return;
  if (redisClient) await redisClient.del(sessionKey(token));
  else sessions.delete(token);
}

function normalizeRoutePath(value) {
  const text = String(value || '/admin').trim() || '/admin';
  const pathText = text.startsWith('/') ? text : `/${text}`;
  return pathText.replace(/\/+$/, '') || '/admin';
}

function normalizeAdminPath(value) {
  const route = normalizeRoutePath(value || '/admin');
  const reserved = new Set(['/', '/api', '/public', '/assets', '/data']);
  const lower = route.toLowerCase();
  if (reserved.has(lower) || lower.startsWith('/api/') || lower.includes('..')) {
    const error = new Error('管理员入口路径不能与系统接口或静态目录冲突');
    error.statusCode = 400;
    throw error;
  }
  return route;
}

function adminPath() {
  return currentAdminPath;
}

function applyRuntimeSettings(db) {
  currentAdminPath = normalizeRoutePath(db?.settings?.adminPath || process.env.ADMIN_PATH || '/admin');
}

function readRuntimeConfigSync() {
  try {
    if (!fsSync.existsSync(APP_CONFIG_FILE)) return {};
    return JSON.parse(fsSync.readFileSync(APP_CONFIG_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function runtimeMysqlOptions(config = runtimeConfig) {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const mysql = config.mysql || {};
  return {
    host: process.env.MYSQL_HOST || mysql.host || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || mysql.port || 3306),
    user: process.env.MYSQL_USER || mysql.user || 'shiye',
    password: process.env.MYSQL_PASSWORD ?? mysql.password ?? '',
    database: process.env.MYSQL_DATABASE || mysql.database || 'shiye_management',
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || mysql.connectionLimit || 10),
    charset: 'utf8mb4'
  };
}

function hasConfiguredMysql() {
  return Boolean(process.env.DATABASE_URL || process.env.MYSQL_HOST || runtimeConfig.mysql);
}

function isInstalled() {
  if (runtimeConfig.installed || runtimeConfig.mysql) return true;
  if (process.env.DATABASE_URL || process.env.MYSQL_HOST) return true;
  return false;
}

async function writeRuntimeConfig(config) {
  await fs.mkdir(path.dirname(APP_CONFIG_FILE), { recursive: true });
  const safe = {
    installed: Boolean(config.installed),
    db: { client: 'mysql' },
    mysql: config.mysql ? {
      host: String(config.mysql.host || '').trim(),
      port: Number(config.mysql.port || 3306),
      user: String(config.mysql.user || '').trim(),
      password: String(config.mysql.password || ''),
      database: String(config.mysql.database || '').trim(),
      connectionLimit: Number(config.mysql.connectionLimit || 10)
    } : undefined,
    setupAt: config.setupAt || nowIso()
  };
  await fs.writeFile(APP_CONFIG_FILE, JSON.stringify(safe, null, 2), 'utf8');
  runtimeConfig = safe;
}

async function ensureSecret() {
  const configuredSecret = String(process.env.APP_SECRET || process.env.SHIYE_SECRET || '').trim();
  if (configuredSecret) return configuredSecret;

  await fs.mkdir(path.dirname(SECRET_FILE), { recursive: true });
  try {
    const secret = (await fs.readFile(SECRET_FILE, 'utf8')).trim();
    if (secret) return secret;
  } catch {
    // Create below.
  }
  const secret = crypto.randomBytes(32).toString('hex');
  await fs.writeFile(SECRET_FILE, secret, 'utf8');
  return secret;
}

const SECRET = await ensureSecret();
const ENC_KEY = crypto.createHash('sha256').update(SECRET).digest();

function encrypt(value) {
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}

function decrypt(value) {
  if (!value) return '';
  try {
    const [ivText, tagText, encryptedText] = value.split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(ivText, 'base64'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedText, 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    return '';
  }
}

function maskSecret(value) {
  return value ? '********' : '';
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const key = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${key}`;
}

function verifyPassword(password, hash) {
  if (!hash) return false;
  const [method, salt, key] = String(hash).split(':');
  if (method !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'hex');
  const actual = Buffer.from(hashPassword(password, salt).split(':')[2], 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function adminUsername(db) {
  return db.settings?.admin?.username || DEFAULT_ADMIN_USER;
}

function usingDefaultAdmin(db) {
  return !db.settings?.admin?.passwordHash && adminUsername(db) === DEFAULT_ADMIN_USER && DEFAULT_ADMIN_PASSWORD === 'admin123';
}

function verifyAdmin(db, username, password) {
  const configuredUser = adminUsername(db);
  if (username !== configuredUser) return false;
  const storedHash = db.settings?.admin?.passwordHash;
  return storedHash ? verifyPassword(password, storedHash) : password === DEFAULT_ADMIN_PASSWORD;
}

function nowIso() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function addMonths(dateText, months) {
  const base = dateText && new Date(dateText) > new Date() ? new Date(dateText) : new Date();
  const result = new Date(base);
  result.setMonth(result.getMonth() + Number(months || 1));
  return result.toISOString();
}

function expiryMs(iso) {
  if (!iso) return 0;
  return new Date(iso).getTime();
}

function gbToBytes(gb) {
  return Math.max(0, Number(gb || 0)) * 1024 * 1024 * 1024;
}

function expiryStatus(expireAt, status = 'active') {
  if (status === 'disabled') return 'disabled';
  if (!expireAt) return status || 'active';
  const ms = new Date(expireAt).getTime() - Date.now();
  if (ms < 0) return 'expired';
  if (ms <= 3 * 24 * 60 * 60 * 1000) return 'warning';
  return 'active';
}

function customerStatus(customer) {
  return customer?.status === 'disabled' ? 'disabled' : 'active';
}

function normalizeRechargeAmounts(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\s,，]+/);
  const amounts = source
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Number(item.toFixed(2)));
  return [...new Set(amounts)].slice(0, 12);
}

function normalizePaymentUrl(value, stripTrailingSlash = false) {
  const text = String(value || '').trim();
  if (!text) return '';
  return stripTrailingSlash ? text.replace(/\/+$/, '') : text;
}

const DEFAULT_EPAY_TYPES = Object.freeze({
  alipay: 'alipay',
  wxpay: 'wxpay',
  paypal: 'paypal',
  usdt: 'usdt.trc20'
});

const DEFAULT_BEPUSDT_TRADE_TYPE = 'usdt.trc20';

function normalizeEpayPayType(value, fallback = '') {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return /^[a-zA-Z0-9._\-|]+$/.test(text) ? text : fallback;
}

function sameEpayPayType(expected, actual) {
  const left = normalizeEpayPayType(expected).toLowerCase();
  const right = normalizeEpayPayType(actual).toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  const aliases = {
    usdt: 'usdt.trc20',
    trc20: 'usdt.trc20',
    'usdt-trc20': 'usdt.trc20',
    usdt_trc20: 'usdt.trc20',
    bepusdt: 'usdt.trc20'
  };
  return (aliases[left] || left) === (aliases[right] || right);
}

function normalizeBepusdtTradeType(value) {
  return normalizeEpayPayType(value, DEFAULT_BEPUSDT_TRADE_TYPE);
}

function normalizeWechatSerialNo(value) {
  return String(value || '').trim().replace(/\s+/g, '');
}

function normalizePaymentSettings(input = {}, existing = {}) {
  const submitted = hasField(input, 'paymentSettingsSubmitted');
  const toBool = (value) => value === true || value === 1 || ['1', 'true', 'on', 'yes'].includes(String(value || '').toLowerCase());
  const readFlag = (flatField, nestedSource, nestedField, fallback = false) => {
    if (hasField(input, flatField)) return toBool(input[flatField]);
    if (hasField(nestedSource || {}, nestedField)) return toBool(nestedSource[nestedField]);
    return submitted ? false : Boolean(fallback);
  };
  const readSecret = (field, currentEnc = '') => {
    if (!hasField(input, field)) return currentEnc || existing[field] || '';
    const raw = String(input[field] || '');
    if (!raw || raw === maskSecret(currentEnc)) return currentEnc || '';
    return encrypt(raw);
  };
  const amountInput = hasField(input, 'paymentAmounts') ? input.paymentAmounts : (hasField(input, 'amounts') ? input.amounts : existing.amounts);
  const amounts = normalizeRechargeAmounts(amountInput);
  const paymentEnabled = hasField(input, 'paymentsEnabled') ? toBool(input.paymentsEnabled) : (hasField(input, 'enabled') ? toBool(input.enabled) : existing.enabled ?? false);
  const epaySignType = String(input.epay?.signType || input.epaySignType || existing.epay?.signType || 'MD5').toUpperCase();
  const bepusdtSource = input.bepusdt || {};
  const wechatSource = input.wechat || {};
  return {
    enabled: Boolean(paymentEnabled),
    siteUrl: normalizePaymentUrl(input.paymentSiteUrl ?? input.siteUrl ?? existing.siteUrl, true),
    minAmount: Math.max(0.01, Number(hasField(input, 'paymentMinAmount') ? input.paymentMinAmount : (hasField(input, 'minAmount') ? input.minAmount : existing.minAmount || 1))),
    amounts: amounts.length ? amounts : [10, 30, 50, 100],
    epay: {
      enabled: readFlag('epayEnabled', input.epay, 'enabled', existing.epay?.enabled ?? false),
      gateway: String(input.epay?.gateway ?? input.epayGateway ?? existing.epay?.gateway ?? '').trim().replace(/\/+$/, ''),
      notifyUrl: normalizePaymentUrl(input.epay?.notifyUrl ?? input.epayNotifyUrl ?? existing.epay?.notifyUrl),
      returnUrl: normalizePaymentUrl(input.epay?.returnUrl ?? input.epayReturnUrl ?? existing.epay?.returnUrl),
      pid: String(input.epay?.pid ?? input.epayPid ?? existing.epay?.pid ?? '').trim(),
      signType: ['MD5', 'RSA'].includes(epaySignType) ? epaySignType : 'MD5',
      merchantKeyEnc: readSecret('epayMerchantKey', input.epay?.merchantKeyEnc || existing.epay?.merchantKeyEnc || existing.epayMerchantKey || ''),
      privateKeyEnc: readSecret('epayPrivateKey', input.epay?.privateKeyEnc || existing.epay?.privateKeyEnc || existing.epayPrivateKey || ''),
      publicKeyEnc: readSecret('epayPublicKey', input.epay?.publicKeyEnc || existing.epay?.publicKeyEnc || existing.epayPublicKey || ''),
      methods: {
        alipay: readFlag('epayMethodAlipay', input.epay?.methods, 'alipay', existing.epay?.methods?.alipay ?? true),
        wxpay: readFlag('epayMethodWxpay', input.epay?.methods, 'wxpay', existing.epay?.methods?.wxpay ?? true),
        paypal: readFlag('epayMethodPaypal', input.epay?.methods, 'paypal', existing.epay?.methods?.paypal ?? false),
        usdt: readFlag('epayMethodUsdt', input.epay?.methods, 'usdt', existing.epay?.methods?.usdt ?? true)
      },
      types: {
        alipay: normalizeEpayPayType(input.epay?.types?.alipay ?? input.epayTypeAlipay ?? existing.epay?.types?.alipay, DEFAULT_EPAY_TYPES.alipay),
        wxpay: normalizeEpayPayType(input.epay?.types?.wxpay ?? input.epayTypeWxpay ?? existing.epay?.types?.wxpay, DEFAULT_EPAY_TYPES.wxpay),
        paypal: normalizeEpayPayType(input.epay?.types?.paypal ?? input.epayTypePaypal ?? existing.epay?.types?.paypal, DEFAULT_EPAY_TYPES.paypal),
        usdt: normalizeEpayPayType(input.epay?.types?.usdt ?? input.epayTypeUsdt ?? existing.epay?.types?.usdt, DEFAULT_EPAY_TYPES.usdt)
      }
    },
    alipay: {
      enabled: readFlag('alipayEnabled', input.alipay, 'enabled', existing.alipay?.enabled ?? false),
      gateway: String(input.alipay?.gateway ?? input.alipayGateway ?? existing.alipay?.gateway ?? 'https://openapi.alipay.com/gateway.do').trim() || 'https://openapi.alipay.com/gateway.do',
      notifyUrl: normalizePaymentUrl(input.alipay?.notifyUrl ?? input.alipayNotifyUrl ?? existing.alipay?.notifyUrl),
      returnUrl: normalizePaymentUrl(input.alipay?.returnUrl ?? input.alipayReturnUrl ?? existing.alipay?.returnUrl),
      appId: String(input.alipay?.appId ?? input.alipayAppId ?? existing.alipay?.appId ?? '').trim(),
      appPrivateKeyEnc: readSecret('alipayAppPrivateKey', input.alipay?.appPrivateKeyEnc || existing.alipay?.appPrivateKeyEnc || existing.alipayAppPrivateKey || ''),
      alipayPublicKeyEnc: readSecret('alipayPublicKey', input.alipay?.alipayPublicKeyEnc || existing.alipay?.alipayPublicKeyEnc || existing.alipayPublicKey || ''),
      methods: {
        page: readFlag('alipayMethodPage', input.alipay?.methods, 'page', existing.alipay?.methods?.page ?? true),
        wap: readFlag('alipayMethodWap', input.alipay?.methods, 'wap', existing.alipay?.methods?.wap ?? false),
        precreate: readFlag('alipayMethodPrecreate', input.alipay?.methods, 'precreate', existing.alipay?.methods?.precreate ?? false)
      }
    },
    bepusdt: {
      enabled: readFlag('bepusdtEnabled', bepusdtSource, 'enabled', existing.bepusdt?.enabled ?? false),
      appUrl: normalizePaymentUrl(bepusdtSource.appUrl ?? input.bepusdtAppUrl ?? existing.bepusdt?.appUrl, true),
      notifyUrl: normalizePaymentUrl(bepusdtSource.notifyUrl ?? input.bepusdtNotifyUrl ?? existing.bepusdt?.notifyUrl),
      returnUrl: normalizePaymentUrl(bepusdtSource.returnUrl ?? input.bepusdtReturnUrl ?? existing.bepusdt?.returnUrl),
      tradeType: normalizeBepusdtTradeType(bepusdtSource.tradeType ?? input.bepusdtTradeType ?? existing.bepusdt?.tradeType),
      tokenEnc: readSecret('bepusdtToken', bepusdtSource.tokenEnc || existing.bepusdt?.tokenEnc || existing.bepusdtToken || '')
    },
    wechat: {
      enabled: readFlag('wechatEnabled', wechatSource, 'enabled', existing.wechat?.enabled ?? false),
      methods: {
        native: readFlag('wechatMethodNative', wechatSource.methods, 'native', existing.wechat?.methods?.native ?? true),
        h5: readFlag('wechatMethodH5', wechatSource.methods, 'h5', existing.wechat?.methods?.h5 ?? false)
      },
      appId: String(wechatSource.appId ?? input.wechatAppId ?? existing.wechat?.appId ?? '').trim(),
      mchId: String(wechatSource.mchId ?? input.wechatMchId ?? existing.wechat?.mchId ?? '').trim(),
      apiV3KeyEnc: readSecret('wechatApiV3Key', wechatSource.apiV3KeyEnc || existing.wechat?.apiV3KeyEnc || existing.wechatApiV3Key || ''),
      merchantSerialNo: normalizeWechatSerialNo(wechatSource.merchantSerialNo ?? input.wechatMerchantSerialNo ?? wechatSource.serialNo ?? input.wechatSerialNo ?? existing.wechat?.merchantSerialNo ?? existing.wechat?.serialNo),
      platformSerialNo: normalizeWechatSerialNo(wechatSource.platformSerialNo ?? input.wechatPlatformSerialNo ?? input.wechatPublicKeyId ?? existing.wechat?.platformSerialNo ?? existing.wechat?.publicKeyId),
      merchantPrivateKeyEnc: readSecret('wechatMerchantPrivateKey', wechatSource.merchantPrivateKeyEnc || existing.wechat?.merchantPrivateKeyEnc || existing.wechat?.privateKeyEnc || existing.wechatMerchantPrivateKey || ''),
      platformPublicKeyEnc: readSecret('wechatPlatformPublicKey', wechatSource.platformPublicKeyEnc || existing.wechat?.platformPublicKeyEnc || existing.wechatPlatformPublicKey || ''),
      notifyUrl: normalizePaymentUrl(wechatSource.notifyUrl ?? input.wechatNotifyUrl ?? existing.wechat?.notifyUrl),
      returnUrl: normalizePaymentUrl(wechatSource.returnUrl ?? input.wechatReturnUrl ?? existing.wechat?.returnUrl),
      description: String(wechatSource.description ?? input.wechatDescription ?? existing.wechat?.description ?? 'Account balance recharge').trim() || 'Account balance recharge'
    }
  };
}

function publicPaymentSettings(settings = {}) {
  const payments = normalizePaymentSettings({}, settings);
  return {
    enabled: payments.enabled,
    siteUrl: payments.siteUrl,
    minAmount: payments.minAmount,
    amounts: payments.amounts,
    epay: {
      enabled: payments.epay.enabled,
      gateway: payments.epay.gateway,
      notifyUrl: payments.epay.notifyUrl,
      returnUrl: payments.epay.returnUrl,
      pid: payments.epay.pid,
      signType: payments.epay.signType,
      merchantKey: maskSecret(payments.epay.merchantKeyEnc),
      privateKey: maskSecret(payments.epay.privateKeyEnc),
      publicKey: maskSecret(payments.epay.publicKeyEnc),
      methods: { ...payments.epay.methods },
      types: { ...payments.epay.types }
    },
    alipay: {
      enabled: payments.alipay.enabled,
      gateway: payments.alipay.gateway,
      notifyUrl: payments.alipay.notifyUrl,
      returnUrl: payments.alipay.returnUrl,
      appId: payments.alipay.appId,
      appPrivateKey: maskSecret(payments.alipay.appPrivateKeyEnc),
      alipayPublicKey: maskSecret(payments.alipay.alipayPublicKeyEnc),
      methods: { ...payments.alipay.methods }
    },
    bepusdt: {
      enabled: payments.bepusdt.enabled,
      appUrl: payments.bepusdt.appUrl,
      notifyUrl: payments.bepusdt.notifyUrl,
      returnUrl: payments.bepusdt.returnUrl,
      tradeType: payments.bepusdt.tradeType,
      token: maskSecret(payments.bepusdt.tokenEnc)
    },
    wechat: {
      enabled: payments.wechat.enabled,
      methods: { ...payments.wechat.methods },
      appId: payments.wechat.appId,
      mchId: payments.wechat.mchId,
      apiV3Key: maskSecret(payments.wechat.apiV3KeyEnc),
      merchantSerialNo: payments.wechat.merchantSerialNo,
      platformSerialNo: payments.wechat.platformSerialNo,
      merchantPrivateKey: maskSecret(payments.wechat.merchantPrivateKeyEnc),
      platformPublicKey: maskSecret(payments.wechat.platformPublicKeyEnc),
      notifyUrl: payments.wechat.notifyUrl,
      returnUrl: payments.wechat.returnUrl,
      description: payments.wechat.description
    }
  };
}

function publicUserPaymentSettings(settings = {}) {
  const payments = normalizePaymentSettings({}, settings);
  const methods = [];
  const hasAlipay = payments.epay.enabled && payments.epay.methods.alipay
    || payments.alipay.enabled && Object.values(payments.alipay.methods || {}).some(Boolean);
  const hasWechat = payments.wechat.enabled && Object.values(payments.wechat.methods || {}).some(Boolean) || payments.epay.enabled && payments.epay.methods.wxpay;
  const hasPaypal = payments.epay.enabled && payments.epay.methods.paypal;
  const hasUsdt = payments.bepusdt.enabled || payments.epay.enabled && payments.epay.methods.usdt;
  if (hasAlipay) methods.push({ id: 'alipay', label: '支付宝' });
  if (hasWechat) methods.push({ id: 'wechat', label: '微信支付' });
  if (hasPaypal) methods.push({ id: 'paypal', label: 'PayPal' });
  if (hasUsdt) methods.push({ id: 'usdt', label: 'USDT' });
  return { enabled: payments.enabled && methods.length > 0, minAmount: payments.minAmount, amounts: payments.amounts, methods };
}

function normalizeRechargeOrder(input = {}, existing = {}) {
  return {
    ...existing,
    id: existing.id || input.id || id('pay'),
    tradeNo: String(input.tradeNo || existing.tradeNo || '').trim() || `pay${Date.now()}${crypto.randomBytes(6).toString('hex')}`,
    customerId: String(input.customerId || existing.customerId || '').trim(),
    customerName: String(input.customerName || existing.customerName || '').trim(),
    provider: String(input.provider || existing.provider || '').trim(),
    method: String(input.method || existing.method || '').trim(),
    payType: String(input.payType || existing.payType || '').trim(),
    amount: Number(Number(input.amount ?? existing.amount ?? 0).toFixed(2)),
    status: String(input.status || existing.status || 'pending').trim(),
    channelTradeNo: String(input.channelTradeNo || existing.channelTradeNo || '').trim(),
    rawNotify: input.rawNotify ?? existing.rawNotify ?? null,
    createdAt: existing.createdAt || input.createdAt || nowIso(),
    paidAt: input.paidAt || existing.paidAt || '',
    updatedAt: nowIso()
  };
}

function normalizeDb(db = {}) {
  db.customers ||= [];
  db.xuiServers ||= [];
  db.serviceNodes ||= [];
  db.customerNodes ||= [];
  db.socksNodes ||= [];
  db.cards ||= [];
  db.cardBatches ||= [];
  db.rechargeOrders ||= [];
  db.balanceLogs ||= [];
  db.renewalLogs ||= [];
  db.syncLogs ||= [];
  db.settings ||= { currency: 'CNY', expiryWarningDays: 3 };
  db.settings.brandName = normalizeBrandName(db.settings.brandName);
  db.settings.logoDataUrl = normalizeLogoDataUrl(db.settings.logoDataUrl || '');
  db.settings.currency ||= 'CNY';
  db.settings.expiryWarningDays = Number(db.settings.expiryWarningDays ?? 3);
  db.settings.purchaseCardUrl ||= '';
  db.settings.adminPath = normalizeRoutePath(db.settings.adminPath || process.env.ADMIN_PATH || '/admin');
  db.settings.payments = normalizePaymentSettings(db.settings.payments || {});
  db.customerNodes = db.customerNodes.map(({ amount, ...binding }) => binding);
  return db;
}

function normalizeBrandName(value) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  return compactText(text || '十夜', 24);
}

function normalizeLogoDataUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!/^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(text)) return '';
  return text.length <= 300000 ? text : '';
}

function publicBrandSettings(settings = {}) {
  return {
    brandName: normalizeBrandName(settings.brandName),
    logoDataUrl: normalizeLogoDataUrl(settings.logoDataUrl || '')
  };
}

async function initMysqlStorage() {
  const mysql = await import('mysql2/promise');
  const poolOptions = runtimeMysqlOptions();
  mysqlPool = mysql.createPool(poolOptions);

  await createMysqlSchema();
}

async function ensureMysqlDatabase(config) {
  const mysql = await import('mysql2/promise');
  const options = runtimeMysqlOptions(config);
  if (typeof options === 'string') return;
  const database = String(options.database || '').trim();
  if (!database || !/^[a-zA-Z0-9_\-]+$/.test(database)) return;
  const connection = await mysql.createConnection({ ...options, database: undefined, multipleStatements: false });
  try {
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database.replace(/`/g, '``')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await connection.end();
  }
}

async function createMysqlSchema() {
  await mysqlPool.query(`CREATE TABLE IF NOT EXISTS shiye_settings (
    name VARCHAR(64) PRIMARY KEY,
    value LONGTEXT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

  await mysqlPool.query(`CREATE TABLE IF NOT EXISTS shiye_customers (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(191) NOT NULL DEFAULT '',
    contact VARCHAR(191) NOT NULL DEFAULT '',
    login_username VARCHAR(191) NOT NULL DEFAULT '',
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    balance DECIMAL(14,2) NOT NULL DEFAULT 0,
    payload LONGTEXT NOT NULL,
    created_at VARCHAR(40) NOT NULL DEFAULT '',
    updated_at VARCHAR(40) NOT NULL DEFAULT '',
    INDEX idx_customer_login (login_username),
    INDEX idx_customer_status (status)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

  await mysqlPool.query(`CREATE TABLE IF NOT EXISTS shiye_xui_servers (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(191) NOT NULL DEFAULT '',
    protocol VARCHAR(16) NOT NULL DEFAULT 'http',
    host VARCHAR(191) NOT NULL DEFAULT '',
    port INT NOT NULL DEFAULT 0,
    base_path VARCHAR(191) NOT NULL DEFAULT '/',
    status VARCHAR(32) NOT NULL DEFAULT 'enabled',
    payload LONGTEXT NOT NULL,
    created_at VARCHAR(40) NOT NULL DEFAULT '',
    updated_at VARCHAR(40) NOT NULL DEFAULT '',
    INDEX idx_xui_host (host),
    INDEX idx_xui_status (status)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

  await mysqlPool.query(`CREATE TABLE IF NOT EXISTS shiye_service_nodes (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(191) NOT NULL DEFAULT '',
    xui_server_id VARCHAR(64) NOT NULL DEFAULT '',
    inbound_id VARCHAR(64) NOT NULL DEFAULT '',
    status VARCHAR(32) NOT NULL DEFAULT 'enabled',
    amount DECIMAL(14,2) NOT NULL DEFAULT 0,
    payload LONGTEXT NOT NULL,
    created_at VARCHAR(40) NOT NULL DEFAULT '',
    updated_at VARCHAR(40) NOT NULL DEFAULT '',
    INDEX idx_service_node_server (xui_server_id),
    INDEX idx_service_node_status (status)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

  await mysqlPool.query(`CREATE TABLE IF NOT EXISTS shiye_customer_nodes (
    id VARCHAR(64) PRIMARY KEY,
    customer_id VARCHAR(64) NOT NULL DEFAULT '',
    node_id VARCHAR(64) NOT NULL DEFAULT '',
    client_email VARCHAR(191) NOT NULL DEFAULT '',
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    expire_at VARCHAR(40) NOT NULL DEFAULT '',
    payload LONGTEXT NOT NULL,
    created_at VARCHAR(40) NOT NULL DEFAULT '',
    updated_at VARCHAR(40) NOT NULL DEFAULT '',
    INDEX idx_customer_node_customer (customer_id),
    INDEX idx_customer_node_node (node_id),
    INDEX idx_customer_node_email (client_email),
    INDEX idx_customer_node_status (status),
    INDEX idx_customer_node_expire (expire_at)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

  await mysqlPool.query(`CREATE TABLE IF NOT EXISTS shiye_socks_nodes (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(191) NOT NULL DEFAULT '',
    tag VARCHAR(191) NOT NULL DEFAULT '',
    address VARCHAR(191) NOT NULL DEFAULT '',
    port INT NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL DEFAULT 'enabled',
    payload LONGTEXT NOT NULL,
    created_at VARCHAR(40) NOT NULL DEFAULT '',
    updated_at VARCHAR(40) NOT NULL DEFAULT '',
    INDEX idx_socks_tag (tag),
    INDEX idx_socks_status (status)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

  await mysqlPool.query(`CREATE TABLE IF NOT EXISTS shiye_cards (
    id VARCHAR(64) PRIMARY KEY,
    code VARCHAR(191) NOT NULL,
    amount DECIMAL(14,2) NOT NULL DEFAULT 0,
    type VARCHAR(191) NOT NULL DEFAULT '',
    status VARCHAR(32) NOT NULL DEFAULT 'unused',
    used_by VARCHAR(64) NOT NULL DEFAULT '',
    payload LONGTEXT NOT NULL,
    created_at VARCHAR(40) NOT NULL DEFAULT '',
    updated_at VARCHAR(40) NOT NULL DEFAULT '',
    used_at VARCHAR(40) NOT NULL DEFAULT '',
    UNIQUE KEY uniq_card_code (code),
    INDEX idx_card_status (status),
    INDEX idx_card_type (type),
    INDEX idx_card_used_by (used_by)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

  await mysqlPool.query(`CREATE TABLE IF NOT EXISTS shiye_card_batches (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(191) NOT NULL DEFAULT '',
    amount DECIMAL(14,2) NOT NULL DEFAULT 0,
    prefix VARCHAR(64) NOT NULL DEFAULT '',
    remark VARCHAR(512) NOT NULL DEFAULT '',
    payload LONGTEXT NOT NULL,
    created_at VARCHAR(40) NOT NULL DEFAULT '',
    updated_at VARCHAR(40) NOT NULL DEFAULT '',
    INDEX idx_card_batch_name (name),
    INDEX idx_card_batch_created (created_at)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

  await mysqlPool.query(`CREATE TABLE IF NOT EXISTS shiye_recharge_orders (
    id VARCHAR(64) PRIMARY KEY,
    trade_no VARCHAR(64) NOT NULL,
    customer_id VARCHAR(64) NOT NULL DEFAULT '',
    provider VARCHAR(64) NOT NULL DEFAULT '',
    method VARCHAR(64) NOT NULL DEFAULT '',
    amount DECIMAL(14,2) NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    channel_trade_no VARCHAR(191) NOT NULL DEFAULT '',
    payload LONGTEXT NOT NULL,
    created_at VARCHAR(40) NOT NULL DEFAULT '',
    paid_at VARCHAR(40) NOT NULL DEFAULT '',
    updated_at VARCHAR(40) NOT NULL DEFAULT '',
    UNIQUE KEY uniq_recharge_trade_no (trade_no),
    INDEX idx_recharge_customer (customer_id),
    INDEX idx_recharge_status (status),
    INDEX idx_recharge_created (created_at)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

  await mysqlPool.query(`CREATE TABLE IF NOT EXISTS shiye_balance_logs (
    id VARCHAR(64) PRIMARY KEY,
    customer_id VARCHAR(64) NOT NULL DEFAULT '',
    type VARCHAR(64) NOT NULL DEFAULT '',
    amount DECIMAL(14,2) NOT NULL DEFAULT 0,
    before_balance DECIMAL(14,2) NOT NULL DEFAULT 0,
    after_balance DECIMAL(14,2) NOT NULL DEFAULT 0,
    operator VARCHAR(191) NOT NULL DEFAULT '',
    remark VARCHAR(512) NOT NULL DEFAULT '',
    payload LONGTEXT NOT NULL,
    created_at VARCHAR(40) NOT NULL DEFAULT '',
    INDEX idx_balance_customer (customer_id),
    INDEX idx_balance_type (type),
    INDEX idx_balance_created (created_at)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

  await mysqlPool.query(`CREATE TABLE IF NOT EXISTS shiye_renewal_logs (
    id VARCHAR(64) PRIMARY KEY,
    customer_id VARCHAR(64) NOT NULL DEFAULT '',
    months INT NOT NULL DEFAULT 1,
    price DECIMAL(14,2) NOT NULL DEFAULT 0,
    before_expire_at VARCHAR(40) NOT NULL DEFAULT '',
    after_expire_at VARCHAR(40) NOT NULL DEFAULT '',
    source VARCHAR(64) NOT NULL DEFAULT '',
    status VARCHAR(32) NOT NULL DEFAULT '',
    message VARCHAR(512) NOT NULL DEFAULT '',
    payload LONGTEXT NOT NULL,
    created_at VARCHAR(40) NOT NULL DEFAULT '',
    INDEX idx_renewal_customer (customer_id),
    INDEX idx_renewal_source (source),
    INDEX idx_renewal_created (created_at)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

  await mysqlPool.query(`CREATE TABLE IF NOT EXISTS shiye_sync_logs (
    id VARCHAR(64) PRIMARY KEY,
    customer_id VARCHAR(64) NOT NULL DEFAULT '',
    type VARCHAR(64) NOT NULL DEFAULT '',
    status VARCHAR(32) NOT NULL DEFAULT '',
    message VARCHAR(512) NOT NULL DEFAULT '',
    detail LONGTEXT NOT NULL,
    payload LONGTEXT NOT NULL,
    created_at VARCHAR(40) NOT NULL DEFAULT '',
    INDEX idx_log_customer (customer_id),
    INDEX idx_log_type (type),
    INDEX idx_log_status (status),
    INDEX idx_log_created (created_at)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
}

function parseStoredJson(value, fallback) {
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return fallback;
  }
}

function compactText(value, max = 512) {
  return String(value || '').slice(0, max);
}

async function readMysqlDb() {
  const [settingRows] = await mysqlPool.query('SELECT value FROM shiye_settings WHERE name = ?', ['app']);
  const [customerRows] = await mysqlPool.query('SELECT payload FROM shiye_customers ORDER BY created_at ASC, id ASC');
  const [serverRows] = await mysqlPool.query('SELECT payload FROM shiye_xui_servers ORDER BY created_at ASC, id ASC');
  const [serviceNodeRows] = await mysqlPool.query('SELECT payload FROM shiye_service_nodes ORDER BY created_at ASC, id ASC');
  const [customerNodeRows] = await mysqlPool.query('SELECT payload FROM shiye_customer_nodes ORDER BY created_at ASC, id ASC');
  const [socksRows] = await mysqlPool.query('SELECT payload FROM shiye_socks_nodes ORDER BY created_at ASC, id ASC');
  const [cardRows] = await mysqlPool.query('SELECT payload FROM shiye_cards ORDER BY created_at ASC, id ASC');
  const [batchRows] = await mysqlPool.query('SELECT payload FROM shiye_card_batches ORDER BY created_at ASC, id ASC');
  const [rechargeRows] = await mysqlPool.query('SELECT payload FROM shiye_recharge_orders ORDER BY created_at ASC, id ASC LIMIT 2000');
  const [balanceRows] = await mysqlPool.query('SELECT payload FROM shiye_balance_logs ORDER BY created_at ASC, id ASC LIMIT 2000');
  const [renewalRows] = await mysqlPool.query('SELECT payload FROM shiye_renewal_logs ORDER BY created_at ASC, id ASC LIMIT 2000');
  const [logRows] = await mysqlPool.query('SELECT payload FROM shiye_sync_logs ORDER BY created_at ASC, id ASC LIMIT 1000');
  return normalizeDb({
    settings: parseStoredJson(settingRows?.[0]?.value, { currency: 'CNY', expiryWarningDays: 3 }),
    customers: customerRows.map((row) => parseStoredJson(row.payload, {})).filter((item) => item.id),
    xuiServers: serverRows.map((row) => parseStoredJson(row.payload, {})).filter((item) => item.id),
    serviceNodes: serviceNodeRows.map((row) => parseStoredJson(row.payload, {})).filter((item) => item.id),
    customerNodes: customerNodeRows.map((row) => parseStoredJson(row.payload, {})).filter((item) => item.id),
    socksNodes: socksRows.map((row) => parseStoredJson(row.payload, {})).filter((item) => item.id),
    cards: cardRows.map((row) => parseStoredJson(row.payload, {})).filter((item) => item.id),
    cardBatches: batchRows.map((row) => parseStoredJson(row.payload, {})).filter((item) => item.id),
    rechargeOrders: rechargeRows.map((row) => parseStoredJson(row.payload, {})).filter((item) => item.id),
    balanceLogs: balanceRows.map((row) => parseStoredJson(row.payload, {})).filter((item) => item.id),
    renewalLogs: renewalRows.map((row) => parseStoredJson(row.payload, {})).filter((item) => item.id),
    syncLogs: logRows.map((row) => parseStoredJson(row.payload, {})).filter((item) => item.id)
  });
}

function rowObject(row) {
  return parseStoredJson(row?.payload, {});
}

async function insertMysqlLog(connection, log) {
  await connection.query(`INSERT INTO shiye_sync_logs (
    id, customer_id, type, status, message, detail, payload, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
    log.id,
    compactText(log.customerId, 64),
    compactText(log.type, 64),
    compactText(log.status, 32),
    compactText(log.message, 512),
    JSON.stringify(log.detail || {}),
    JSON.stringify(log),
    compactText(log.createdAt, 40)
  ]);
}

async function insertMysqlBalanceLog(connection, log) {
  await connection.query(`INSERT INTO shiye_balance_logs (
    id, customer_id, type, amount, before_balance, after_balance, operator, remark, payload, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    log.id,
    compactText(log.customerId, 64),
    compactText(log.type, 64),
    Number(log.amount || 0),
    Number(log.beforeBalance || 0),
    Number(log.afterBalance || 0),
    compactText(log.operator, 191),
    compactText(log.remark, 512),
    JSON.stringify(log),
    compactText(log.createdAt, 40)
  ]);
}

async function insertMysqlRenewalLog(connection, log) {
  await connection.query(`INSERT INTO shiye_renewal_logs (
    id, customer_id, months, price, before_expire_at, after_expire_at, source, status, message, payload, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    log.id,
    compactText(log.customerId, 64),
    Number(log.months || 1),
    Number(log.price || 0),
    compactText(log.beforeExpireAt, 40),
    compactText(log.afterExpireAt, 40),
    compactText(log.source, 64),
    compactText(log.status, 32),
    compactText(log.message, 512),
    JSON.stringify(log),
    compactText(log.createdAt, 40)
  ]);
}

async function updateMysqlCustomerRow(connection, customer) {
  await connection.query(`INSERT INTO shiye_customers (
    id, name, contact, login_username, status, balance, payload, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    name = VALUES(name), contact = VALUES(contact), login_username = VALUES(login_username),
    status = VALUES(status), balance = VALUES(balance), payload = VALUES(payload), updated_at = VALUES(updated_at)`, [
    customer.id,
    compactText(customer.name, 191),
    compactText(customer.contact, 191),
    compactText(customer.loginUsername, 191),
    compactText(customer.status || 'active', 32),
    Number(customer.balance || 0),
    JSON.stringify(customer),
    compactText(customer.createdAt, 40),
    compactText(customer.updatedAt, 40)
  ]);
}

async function mysqlTransaction(task) {
  const connection = await mysqlPool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await task(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function upsertMysqlSettingsRow(connection, settings) {
  await connection.query(
    'INSERT INTO shiye_settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
    ['app', JSON.stringify(settings || {})]
  );
}

async function upsertMysqlServerRow(connection, server) {
  await connection.query(`INSERT INTO shiye_xui_servers (
    id, name, protocol, host, port, base_path, status, payload, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    name = VALUES(name), protocol = VALUES(protocol), host = VALUES(host), port = VALUES(port),
    base_path = VALUES(base_path), status = VALUES(status), payload = VALUES(payload), updated_at = VALUES(updated_at)`, [
    server.id,
    compactText(server.name, 191),
    compactText(server.protocol || 'http', 16),
    compactText(server.host, 191),
    Number(server.port || 0),
    compactText(server.basePath || '/', 191),
    compactText(server.status || 'enabled', 32),
    JSON.stringify(server),
    compactText(server.createdAt, 40),
    compactText(server.updatedAt, 40)
  ]);
}

async function upsertMysqlServiceNodeRow(connection, node) {
  await connection.query(`INSERT INTO shiye_service_nodes (
    id, name, xui_server_id, inbound_id, status, amount, payload, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    name = VALUES(name), xui_server_id = VALUES(xui_server_id), inbound_id = VALUES(inbound_id),
    status = VALUES(status), amount = VALUES(amount), payload = VALUES(payload), updated_at = VALUES(updated_at)`, [
    node.id,
    compactText(node.name, 191),
    compactText(node.xuiServerId, 64),
    compactText(node.inboundId, 64),
    compactText(node.status || 'enabled', 32),
    Number(node.amount || 0),
    JSON.stringify(node),
    compactText(node.createdAt, 40),
    compactText(node.updatedAt, 40)
  ]);
}

async function upsertMysqlCustomerNodeRow(connection, binding) {
  await connection.query(`INSERT INTO shiye_customer_nodes (
    id, customer_id, node_id, client_email, status, expire_at, payload, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    customer_id = VALUES(customer_id), node_id = VALUES(node_id), client_email = VALUES(client_email),
    status = VALUES(status), expire_at = VALUES(expire_at), payload = VALUES(payload), updated_at = VALUES(updated_at)`, [
    binding.id,
    compactText(binding.customerId, 64),
    compactText(binding.nodeId, 64),
    compactText(binding.clientEmail, 191),
    compactText(binding.status || 'active', 32),
    compactText(binding.expireAt, 40),
    JSON.stringify(binding),
    compactText(binding.createdAt, 40),
    compactText(binding.updatedAt, 40)
  ]);
}

async function upsertMysqlSocksRow(connection, node) {
  await connection.query(`INSERT INTO shiye_socks_nodes (
    id, name, tag, address, port, status, payload, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    name = VALUES(name), tag = VALUES(tag), address = VALUES(address), port = VALUES(port),
    status = VALUES(status), payload = VALUES(payload), updated_at = VALUES(updated_at)`, [
    node.id,
    compactText(node.name, 191),
    compactText(node.tag, 191),
    compactText(node.address, 191),
    Number(node.port || 0),
    compactText(node.status || 'enabled', 32),
    JSON.stringify(node),
    compactText(node.createdAt, 40),
    compactText(node.updatedAt, 40)
  ]);
}

async function upsertMysqlCardBatchRow(connection, batch) {
  await connection.query(`INSERT INTO shiye_card_batches (
    id, name, amount, prefix, remark, payload, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    name = VALUES(name), amount = VALUES(amount), prefix = VALUES(prefix), remark = VALUES(remark),
    payload = VALUES(payload), updated_at = VALUES(updated_at)`, [
    batch.id,
    compactText(batch.name, 191),
    Number(batch.amount || 0),
    compactText(batch.prefix, 64),
    compactText(batch.remark, 512),
    JSON.stringify(batch),
    compactText(batch.createdAt, 40),
    compactText(batch.updatedAt, 40)
  ]);
}

async function upsertMysqlCardRow(connection, card) {
  const normalized = { ...card, code: normalizeCardCode(card.code) };
  await connection.query(`INSERT INTO shiye_cards (
    id, code, amount, type, status, used_by, payload, created_at, updated_at, used_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    code = VALUES(code), amount = VALUES(amount), type = VALUES(type), status = VALUES(status),
    used_by = VALUES(used_by), payload = VALUES(payload), updated_at = VALUES(updated_at), used_at = VALUES(used_at)`, [
    normalized.id,
    compactText(normalized.code, 191),
    Number(normalized.amount || 0),
    compactText(normalized.type || normalized.remark || '', 191),
    compactText(normalized.status || 'unused', 32),
    compactText(normalized.usedBy, 64),
    JSON.stringify(normalized),
    compactText(normalized.createdAt, 40),
    compactText(normalized.updatedAt, 40),
    compactText(normalized.usedAt, 40)
  ]);
}

async function insertMysqlGeneratedCardRow(connection, card, prefix, knownCodes = new Set()) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const normalized = { ...card, code: normalizeCardCode(card.code) };
    try {
      await connection.query(`INSERT INTO shiye_cards (
        id, code, amount, type, status, used_by, payload, created_at, updated_at, used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        normalized.id,
        compactText(normalized.code, 191),
        Number(normalized.amount || 0),
        compactText(normalized.type || normalized.remark || '', 191),
        compactText(normalized.status || 'unused', 32),
        compactText(normalized.usedBy, 64),
        JSON.stringify(normalized),
        compactText(normalized.createdAt, 40),
        compactText(normalized.updatedAt, 40),
        compactText(normalized.usedAt, 40)
      ]);
      card.code = normalized.code;
      knownCodes.add(normalized.code);
      return card;
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY') throw error;
      card.id = id('card');
      do {
        card.code = generateCardCode(prefix);
      } while (knownCodes.has(normalizeCardCode(card.code)));
    }
  }
  const error = new Error('生成卡密失败，请重试');
  error.statusCode = 500;
  throw error;
}

async function deleteMysqlRows(connection, table, ids) {
  const values = [...ids].filter(Boolean);
  if (!values.length) return;
  await connection.query(`DELETE FROM ${table} WHERE id IN (?)`, [values]);
}

async function upsertMysqlRechargeOrderRow(connection, order) {
  await connection.query(`INSERT INTO shiye_recharge_orders (
    id, trade_no, customer_id, provider, method, amount, status, channel_trade_no, payload, created_at, paid_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    customer_id = VALUES(customer_id), provider = VALUES(provider), method = VALUES(method), amount = VALUES(amount),
    status = VALUES(status), channel_trade_no = VALUES(channel_trade_no), payload = VALUES(payload),
    paid_at = VALUES(paid_at), updated_at = VALUES(updated_at)`, [
    order.id,
    compactText(order.tradeNo, 64),
    compactText(order.customerId, 64),
    compactText(order.provider, 64),
    compactText(order.method, 64),
    Number(order.amount || 0),
    compactText(order.status || 'pending', 32),
    compactText(order.channelTradeNo, 191),
    JSON.stringify(order),
    compactText(order.createdAt, 40),
    compactText(order.paidAt, 40),
    compactText(order.updatedAt, 40)
  ]);
}

function siteOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const realIp = String(req.headers['x-real-ip'] || '').trim();
  const remote = String(req.socket?.remoteAddress || '').trim();
  const ip = forwarded || realIp || remote || '127.0.0.1';
  if (ip === '::1') return '127.0.0.1';
  return ip.replace(/^::ffff:/, '');
}

function isMobileRequest(req) {
  return /android|iphone|ipad|ipod|mobile|micromessenger/i.test(String(req.headers['user-agent'] || ''));
}

function paymentBaseUrl(payments, fallbackOrigin) {
  return String(payments.siteUrl || fallbackOrigin || '').replace(/\/+$/, '');
}

function paymentUrl(template, baseUrl, pathText, tradeNo) {
  const fallback = `${baseUrl}${pathText}`;
  const raw = String(template || fallback).trim() || fallback;
  return raw
    .replaceAll('{trade_no}', encodeURIComponent(tradeNo))
    .replaceAll('{out_trade_no}', encodeURIComponent(tradeNo));
}

function epaySubmitUrl(gateway) {
  const text = String(gateway || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  if (/\/submit\.php$/i.test(text)) return text;
  return `${text}/submit.php`;
}

function sortedSignContent(params, excludes = ['sign', 'sign_type']) {
  return Object.keys(params)
    .filter((key) => !excludes.includes(key) && params[key] !== undefined && params[key] !== null && params[key] !== '' && typeof params[key] !== 'object')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

function bepusdtSign(params, token) {
  return crypto.createHash('md5').update(sortedSignContent(params, ['signature']) + token, 'utf8').digest('hex');
}

function timingSafeTextEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function wxpayNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function wxpayTimestamp() {
  return Math.floor(Date.now() / 1000).toString();
}

function wxpayCanonical(method, urlPath, timestamp, nonce, body = '') {
  return `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;
}

function wxpayAuthorization(config, method, urlPath, body = '') {
  const privateKey = decrypt(config.merchantPrivateKeyEnc || config.privateKeyEnc);
  if (!config.mchId || !config.merchantSerialNo || !privateKey) throw new Error('Wechat Pay mchId, merchant serial no or merchant private key is not configured');
  const timestamp = wxpayTimestamp();
  const nonce = wxpayNonce();
  const signature = crypto.createSign('RSA-SHA256').update(wxpayCanonical(method, urlPath, timestamp, nonce, body), 'utf8').sign(normalizePemKey(privateKey, 'PRIVATE KEY'), 'base64');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${config.merchantSerialNo}"`;
}

function verifyWechatNotifySignature(req, bodyText, config) {
  const publicKey = decrypt(config.platformPublicKeyEnc);
  if (!publicKey) return false;
  const signature = String(req.headers['wechatpay-signature'] || '');
  const timestamp = String(req.headers['wechatpay-timestamp'] || '');
  const nonce = String(req.headers['wechatpay-nonce'] || '');
  const serial = normalizeWechatSerialNo(req.headers['wechatpay-serial']);
  if (!signature || !timestamp || !nonce) return false;
  if (config.platformSerialNo && serial && serial !== config.platformSerialNo) return false;
  return crypto.createVerify('RSA-SHA256').update(`${timestamp}\n${nonce}\n${bodyText}\n`, 'utf8').verify(normalizePemKey(publicKey, 'PUBLIC KEY'), signature, 'base64');
}

function decryptWechatResource(resource, apiV3Key) {
  if (!apiV3Key || Buffer.byteLength(apiV3Key) !== 32) throw new Error('Wechat Pay APIv3 key must be 32 bytes');
  const encrypted = Buffer.from(resource?.ciphertext || '', 'base64');
  if (encrypted.length <= 16) throw new Error('Invalid Wechat Pay resource ciphertext');
  const data = encrypted.subarray(0, encrypted.length - 16);
  const tag = encrypted.subarray(encrypted.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), Buffer.from(resource?.nonce || '', 'utf8'));
  if (resource?.associated_data) decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
}

function epaySign(params, settings) {
  const signType = String(settings.signType || 'MD5').toUpperCase();
  const content = sortedSignContent(params);
  if (signType === 'RSA') {
    const privateKey = decrypt(settings.privateKeyEnc);
    if (!privateKey) throw new Error('易支付 RSA 私钥未配置');
    return crypto.createSign('RSA-SHA256').update(content, 'utf8').sign(normalizePemKey(privateKey, 'PRIVATE KEY'), 'base64');
  }
  const key = decrypt(settings.merchantKeyEnc);
  if (!key) throw new Error('易支付商户密钥未配置');
  return crypto.createHash('md5').update(content + key, 'utf8').digest('hex');
}

function verifyEpaySign(params, settings) {
  const sign = String(params.sign || '');
  const signType = String(params.sign_type || settings.signType || 'MD5').toUpperCase();
  const content = sortedSignContent(params);
  if (signType === 'RSA') {
    const publicKey = decrypt(settings.publicKeyEnc);
    if (!publicKey || !sign) return false;
    return crypto.createVerify('RSA-SHA256').update(content, 'utf8').verify(normalizePemKey(publicKey, 'PUBLIC KEY'), sign, 'base64');
  }
  const key = decrypt(settings.merchantKeyEnc);
  if (!key || !sign) return false;
  const expected = crypto.createHash('md5').update(content + key, 'utf8').digest('hex');
  return expected.length === sign.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sign));
}

function normalizePemKey(value, type = 'PRIVATE KEY') {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.includes('-----BEGIN')) return text;
  const body = text.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') || text;
  return `-----BEGIN ${type}-----\n${body}\n-----END ${type}-----`;
}

function alipaySign(params, privateKey) {
  const content = sortedSignContent(params, ['sign', 'sign_type']);
  return crypto.createSign('RSA-SHA256').update(content, 'utf8').sign(normalizePemKey(privateKey, 'PRIVATE KEY'), 'base64');
}

function verifyAlipaySign(params, publicKey) {
  const sign = String(params.sign || '');
  if (!sign || !publicKey) return false;
  const content = sortedSignContent(params, ['sign', 'sign_type']);
  return crypto.createVerify('RSA-SHA256').update(content, 'utf8').verify(normalizePemKey(publicKey, 'PUBLIC KEY'), sign, 'base64');
}

function extractAlipayResponseContent(text, responseKey) {
  const marker = `"${responseKey}"`;
  const keyIndex = text.indexOf(marker);
  if (keyIndex < 0) return '';
  const colonIndex = text.indexOf(':', keyIndex + marker.length);
  if (colonIndex < 0) return '';
  let start = colonIndex + 1;
  while (/\s/.test(text[start] || '')) start += 1;
  if (text[start] !== '{') return '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return '';
}

function verifyAlipayApiResponse(responseText, responseKey, publicKey) {
  if (!responseText || !publicKey) return false;
  const payload = JSON.parse(responseText);
  const sign = String(payload.sign || '');
  const content = extractAlipayResponseContent(responseText, responseKey);
  if (!sign || !content) return false;
  return crypto.createVerify('RSA-SHA256').update(content, 'utf8').verify(normalizePemKey(publicKey, 'PUBLIC KEY'), sign, 'base64');
}

const ALIPAY_DIRECT_METHODS = Object.freeze({
  page: {
    id: 'page',
    method: 'alipay.trade.page.pay',
    productCode: 'FAST_INSTANT_TRADE_PAY',
    label: '支付宝电脑网站支付'
  },
  wap: {
    id: 'wap',
    method: 'alipay.trade.wap.pay',
    productCode: 'QUICK_WAP_WAY',
    label: '支付宝手机网站/H5支付'
  },
  precreate: {
    id: 'precreate',
    method: 'alipay.trade.precreate',
    productCode: 'FACE_TO_FACE_PAYMENT',
    label: '支付宝当面付扫码'
  }
});

function alipayBaseParams(config, apiMethod) {
  return {
    app_id: config.appId,
    method: apiMethod,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
    version: '1.0'
  };
}

function alipayOrderBizContent(order, productCode) {
  return {
    out_trade_no: order.tradeNo,
    total_amount: order.amount.toFixed(2),
    subject: '账户余额充值',
    product_code: productCode
  };
}

function assertAlipayConfig(config) {
  const privateKey = decrypt(config.appPrivateKeyEnc);
  if (!config.appId || !privateKey) throw new Error('支付宝直连 App ID 或应用私钥未配置');
  return privateKey;
}

function buildAlipayPayUrl(order, payments, origin, methodKey = 'page') {
  const config = payments.alipay;
  const baseUrl = paymentBaseUrl(payments, origin);
  const privateKey = assertAlipayConfig(config);
  const directMethod = ALIPAY_DIRECT_METHODS[methodKey] || ALIPAY_DIRECT_METHODS.page;
  if (directMethod.id === 'precreate') throw new Error('当面付扫码需要调用预创建接口');
  const bizContent = alipayOrderBizContent(order, directMethod.productCode);
  if (directMethod.id === 'wap') bizContent.quit_url = paymentUrl(config.returnUrl, baseUrl, `/payment/result?trade_no=${encodeURIComponent(order.tradeNo)}`, order.tradeNo);
  const params = {
    ...alipayBaseParams(config, directMethod.method),
    notify_url: paymentUrl(config.notifyUrl, baseUrl, '/api/payments/alipay/notify', order.tradeNo),
    return_url: paymentUrl(config.returnUrl, baseUrl, `/payment/result?trade_no=${encodeURIComponent(order.tradeNo)}`, order.tradeNo),
    biz_content: JSON.stringify(bizContent)
  };
  params.sign = alipaySign(params, privateKey);
  return `${config.gateway}?${new URLSearchParams(params).toString()}`;
}

async function buildAlipayPrecreatePayment(order, payments, origin) {
  const config = payments.alipay;
  const baseUrl = paymentBaseUrl(payments, origin);
  const privateKey = assertAlipayConfig(config);
  const directMethod = ALIPAY_DIRECT_METHODS.precreate;
  const params = {
    ...alipayBaseParams(config, directMethod.method),
    notify_url: paymentUrl(config.notifyUrl, baseUrl, '/api/payments/alipay/notify', order.tradeNo),
    biz_content: JSON.stringify(alipayOrderBizContent(order, directMethod.productCode))
  };
  params.sign = alipaySign(params, privateKey);
  const response = await fetch(config.gateway, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(params)
  });
  const responseText = await response.text();
  const publicKey = decrypt(config.alipayPublicKeyEnc);
  let payload = {};
  try {
    if (!verifyAlipayApiResponse(responseText, 'alipay_trade_precreate_response', publicKey)) {
      throw new Error('支付宝当面付预创建响应验签失败');
    }
    payload = JSON.parse(responseText);
  } catch (error) {
    throw new Error(error.message || '支付宝当面付预创建响应无效');
  }
  const result = payload.alipay_trade_precreate_response || {};
  if (!response.ok || result.code !== '10000' || !result.qr_code) {
    const message = result.sub_msg || result.msg || `支付宝当面付预创建失败(${response.status})`;
    throw new Error(message);
  }
  const qrImage = await QRCode.toDataURL(result.qr_code, { margin: 1, width: 280, errorCorrectionLevel: 'M' });
  return { qrCode: result.qr_code, qrImage };
}

function buildEpayPayUrl(order, payments, origin) {
  const config = payments.epay;
  const baseUrl = paymentBaseUrl(payments, origin);
  if (!config.gateway || !config.pid) throw new Error('易支付网关地址或 PID 未配置');
  const params = {
    pid: config.pid,
    type: order.payType,
    out_trade_no: order.tradeNo,
    notify_url: paymentUrl(config.notifyUrl, baseUrl, '/api/payments/epay/notify', order.tradeNo),
    return_url: paymentUrl(config.returnUrl, baseUrl, `/payment/result?trade_no=${encodeURIComponent(order.tradeNo)}`, order.tradeNo),
    name: '账户余额充值',
    money: order.amount.toFixed(2),
    sign_type: config.signType || 'MD5'
  };
  params.sign = epaySign(params, config);
  return `${epaySubmitUrl(config.gateway)}?${new URLSearchParams(params).toString()}`;
}

async function buildBepusdtNativePayment(order, payments, origin) {
  const config = payments.bepusdt;
  const baseUrl = paymentBaseUrl(payments, origin);
  const token = decrypt(config.tokenEnc);
  if (!config.appUrl || !token) throw new Error('BEpusdt appUrl or token is not configured');
  const params = {
    pid: '1000',
    type: order.payType || config.tradeType || DEFAULT_BEPUSDT_TRADE_TYPE,
    out_trade_no: order.tradeNo,
    notify_url: paymentUrl(config.notifyUrl, baseUrl, '/api/payments/bepusdt/notify', order.tradeNo),
    return_url: paymentUrl(config.returnUrl, baseUrl, `/payment/result?trade_no=${encodeURIComponent(order.tradeNo)}`, order.tradeNo),
    name: 'Account balance recharge',
    money: order.amount.toFixed(2),
    sign_type: 'MD5'
  };
  params.sign = crypto.createHash('md5').update(sortedSignContent(params) + token, 'utf8').digest('hex');
  return { payUrl: `${epaySubmitUrl(config.appUrl)}?${new URLSearchParams(params).toString()}` };
}

async function buildWechatNativePayment(order, payments, origin) {
  const config = payments.wechat;
  const baseUrl = paymentBaseUrl(payments, origin);
  const urlPath = '/v3/pay/transactions/native';
  if (!config.appId || !config.mchId) throw new Error('Wechat Pay appId or mchId is not configured');
  const body = JSON.stringify({
    appid: config.appId,
    mchid: config.mchId,
    description: config.description || 'Account balance recharge',
    out_trade_no: order.tradeNo,
    notify_url: paymentUrl(config.notifyUrl, baseUrl, '/api/payments/wechat/notify', order.tradeNo),
    amount: { total: Math.round(Number(order.amount || 0) * 100), currency: 'CNY' }
  });
  const response = await fetch(`https://api.mch.weixin.qq.com${urlPath}`, {
    method: 'POST',
    headers: {
      Authorization: wxpayAuthorization(config, 'POST', urlPath, body),
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.code_url) {
    throw new Error(payload.message || payload.detail?.message || `Wechat Pay native order failed (${response.status})`);
  }
  const qrImage = await QRCode.toDataURL(payload.code_url, { margin: 1, width: 280, errorCorrectionLevel: 'M' });
  return { qrCode: payload.code_url, qrImage };
}

async function buildWechatH5Payment(order, payments, origin, req) {
  const config = payments.wechat;
  const baseUrl = paymentBaseUrl(payments, origin);
  const urlPath = '/v3/pay/transactions/h5';
  if (!config.appId || !config.mchId) throw new Error('Wechat Pay appId or mchId is not configured');
  const body = JSON.stringify({
    appid: config.appId,
    mchid: config.mchId,
    description: config.description || 'Account balance recharge',
    out_trade_no: order.tradeNo,
    notify_url: paymentUrl(config.notifyUrl, baseUrl, '/api/payments/wechat/notify', order.tradeNo),
    amount: { total: Math.round(Number(order.amount || 0) * 100), currency: 'CNY' },
    scene_info: {
      payer_client_ip: clientIp(req),
      h5_info: {
        type: 'Wap',
        app_name: 'Account recharge',
        wap_url: baseUrl || origin,
        wap_name: 'Balance recharge'
      }
    }
  });
  const response = await fetch(`https://api.mch.weixin.qq.com${urlPath}`, {
    method: 'POST',
    headers: {
      Authorization: wxpayAuthorization(config, 'POST', urlPath, body),
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.h5_url) {
    throw new Error(payload.message || payload.detail?.message || `Wechat Pay h5 order failed (${response.status})`);
  }
  return { payUrl: payload.h5_url };
}

function resolveRechargeMethod(methodId, payments, req) {
  if (methodId === 'alipay') {
    const enabled = payments.alipay.enabled && payments.alipay.methods || {};
    const directMethod = isMobileRequest(req) && enabled.wap ? 'wap'
      : enabled.page ? 'page'
        : enabled.precreate ? 'precreate'
          : enabled.wap ? 'wap'
            : '';
    if (payments.alipay.enabled && directMethod) return { provider: 'alipay_native', method: 'alipay', payType: 'alipay', alipayMethod: directMethod };
    if (payments.epay.enabled && payments.epay.methods.alipay) return { provider: 'epay', method: 'alipay', payType: normalizeEpayPayType(payments.epay.types?.alipay, DEFAULT_EPAY_TYPES.alipay) };
    return null;
  }
  if (methodId === 'wechat') {
    const enabled = payments.wechat.enabled && payments.wechat.methods || {};
    const wechatMethod = isMobileRequest(req) && enabled.h5 ? 'h5' : enabled.native ? 'native' : enabled.h5 ? 'h5' : '';
    if (payments.wechat.enabled && wechatMethod) return { provider: 'wechat_native', method: 'wechat', payType: wechatMethod, wechatMethod };
    if (payments.epay.enabled && payments.epay.methods.wxpay) return { provider: 'epay', method: 'wechat', payType: normalizeEpayPayType(payments.epay.types?.wxpay, DEFAULT_EPAY_TYPES.wxpay) };
    return null;
  }
  if (methodId === 'paypal') {
    if (!payments.epay.enabled || !payments.epay.methods.paypal) return null;
    return { provider: 'epay', method: 'paypal', payType: normalizeEpayPayType(payments.epay.types?.paypal, DEFAULT_EPAY_TYPES.paypal) };
  }
  if (methodId === 'usdt') {
    if (payments.bepusdt.enabled) return { provider: 'bepusdt_native', method: 'usdt', payType: payments.bepusdt.tradeType || DEFAULT_BEPUSDT_TRADE_TYPE };
    if (payments.epay.enabled && payments.epay.methods.usdt) {
      return { provider: 'epay', method: 'usdt', payType: normalizeEpayPayType(payments.epay.types?.usdt, DEFAULT_EPAY_TYPES.usdt) };
    }
    return null;
  }
  return null;
}

function publicRechargeResult(order = {}) {
  return {
    tradeNo: order.tradeNo || '',
    provider: order.provider || '',
    method: order.method || '',
    amount: Number(order.amount || 0),
    status: order.status || 'pending',
    channelTradeNo: order.channelTradeNo || '',
    createdAt: order.createdAt || '',
    paidAt: order.paidAt || '',
    updatedAt: order.updatedAt || ''
  };
}

function publicBalanceLog(log = {}) {
  return {
    id: log.id || '',
    type: log.type || '',
    amount: Number(log.amount || 0),
    beforeBalance: Number(log.beforeBalance || 0),
    afterBalance: Number(log.afterBalance || 0),
    remark: log.remark || '',
    createdAt: log.createdAt || ''
  };
}

function publicRenewalLog(log = {}) {
  return {
    id: log.id || '',
    months: Math.max(1, Math.floor(Number(log.months || 1))),
    price: Number(log.price || 0),
    beforeExpireAt: log.beforeExpireAt || '',
    afterExpireAt: log.afterExpireAt || '',
    source: log.source || '',
    status: log.status || '',
    createdAt: log.createdAt || ''
  };
}

function recentPendingOrders(db, customerId, windowMs = 2 * 60 * 60 * 1000) {
  const since = Date.now() - windowMs;
  return db.rechargeOrders.filter((order) => {
    if (order.customerId !== customerId || order.status !== 'pending') return false;
    const createdAt = new Date(order.createdAt || 0).getTime();
    return Number.isFinite(createdAt) && createdAt >= since;
  });
}

async function completeRechargeOrder(tradeNo, detail = {}) {
  return mysqlTransaction(async (connection) => {
    const [orderRows] = await connection.query('SELECT payload FROM shiye_recharge_orders WHERE trade_no = ? FOR UPDATE', [tradeNo]);
    const order = rowObject(orderRows[0]);
    if (!order.id) return { ok: false, message: '充值订单不存在' };
    if (order.status === 'paid') return { ok: true, duplicate: true, order };
    if (order.status && order.status !== 'pending') return { ok: false, message: '充值订单当前不可支付' };
    if (detail.provider && order.provider !== detail.provider) return { ok: false, message: '支付平台不匹配' };
    if (detail.payType && !sameEpayPayType(order.payType, detail.payType)) return { ok: false, message: '支付方式不匹配' };
    if (detail.amount !== undefined && Number(detail.amount).toFixed(2) !== Number(order.amount || 0).toFixed(2)) return { ok: false, message: '支付金额不匹配' };

    const [customerRows] = await connection.query('SELECT payload FROM shiye_customers WHERE id = ? FOR UPDATE', [order.customerId]);
    const customer = rowObject(customerRows[0]);
    if (!customer.id || customer.status === 'disabled') return { ok: false, message: '用户不存在或已停用' };

    const beforeBalance = Number(customer.balance || 0);
    const amount = Number(order.amount || 0);
    customer.balance = Number((beforeBalance + amount).toFixed(2));
    customer.updatedAt = nowIso();
    order.status = 'paid';
    order.channelTradeNo = String(detail.channelTradeNo || order.channelTradeNo || '');
    order.rawNotify = detail.rawNotify || order.rawNotify || null;
    order.paidAt = nowIso();
    order.updatedAt = nowIso();

    const balanceLog = {
      id: id('bal'),
      customerId: customer.id,
      customerName: customer.name,
      type: 'online_recharge',
      amount,
      beforeBalance,
      afterBalance: customer.balance,
      operator: '在线支付',
      remark: `在线充值 ${order.tradeNo}`,
      detail: { orderId: order.id, tradeNo: order.tradeNo, provider: order.provider, method: order.method, channelTradeNo: order.channelTradeNo },
      createdAt: nowIso()
    };
    const syncLog = {
      id: id('log'),
      customerId: customer.id,
      type: 'recharge',
      status: 'success',
      message: `在线充值到账 ${amount}`,
      detail: { orderId: order.id, tradeNo: order.tradeNo, provider: order.provider, method: order.method },
      createdAt: nowIso()
    };

    await updateMysqlCustomerRow(connection, customer);
    await upsertMysqlRechargeOrderRow(connection, order);
    await insertMysqlBalanceLog(connection, balanceLog);
    await insertMysqlLog(connection, syncLog);
    return { ok: true, order, customer };
  });
}

async function redeemCardForUserMysql(customerId, rawCode) {
  const code = normalizeCardCode(rawCode);
  if (!code) {
    const error = new Error('请填写卡密');
    error.statusCode = 400;
    throw error;
  }
  const connection = await mysqlPool.getConnection();
  let updatedCustomer;
  let amount = 0;
  try {
    await connection.beginTransaction();
    const [customerRows] = await connection.query('SELECT payload FROM shiye_customers WHERE id = ? FOR UPDATE', [customerId]);
    const customer = rowObject(customerRows[0]);
    if (!customer.id || customer.status === 'disabled') {
      const error = new Error('用户不存在或已停用');
      error.statusCode = 404;
      throw error;
    }

    const [cardRows] = await connection.query('SELECT payload FROM shiye_cards WHERE code = ? FOR UPDATE', [code]);
    const card = rowObject(cardRows[0]);
    if (!card.id) {
      const error = new Error('卡密不存在');
      error.statusCode = 404;
      throw error;
    }
    if (card.status === 'disabled') {
      const error = new Error('卡密已禁用');
      error.statusCode = 400;
      throw error;
    }
    if (card.status === 'used') {
      const error = new Error('卡密已被使用');
      error.statusCode = 400;
      throw error;
    }

    amount = Math.max(0, Number(card.amount || 0));
    const beforeBalance = Number(customer.balance || 0);
    customer.balance = beforeBalance + amount;
    customer.updatedAt = nowIso();
    card.code = code;
    card.status = 'used';
    card.usedBy = customer.id;
    card.usedByName = customer.name;
    card.usedAt = nowIso();
    card.updatedAt = nowIso();
    updatedCustomer = customer;

    await updateMysqlCustomerRow(connection, customer);
    await connection.query(`UPDATE shiye_cards SET
      amount = ?, type = ?, status = ?, used_by = ?, payload = ?, updated_at = ?, used_at = ?
      WHERE id = ?`, [
      Number(card.amount || 0),
      compactText(card.type || card.remark || '', 191),
      compactText(card.status, 32),
      compactText(card.usedBy, 64),
      JSON.stringify(card),
      compactText(card.updatedAt, 40),
      compactText(card.usedAt, 40),
      card.id
    ]);
    await insertMysqlLog(connection, {
      id: id('log'),
      customerId: customer.id,
      type: 'card',
      status: 'success',
      message: `用户兑换卡密，余额增加 ${amount}`,
      detail: { cardId: card.id, amount },
      createdAt: nowIso()
    });
    await insertMysqlBalanceLog(connection, {
      id: id('bal'),
      customerId: customer.id,
      customerName: customer.name,
      type: 'card_redeem',
      amount,
      beforeBalance,
      afterBalance: customer.balance,
      operator: '用户自助',
      remark: `兑换卡密 ${card.type || card.batchName || card.id}`,
      detail: { cardId: card.id, code: card.code, batchId: card.batchId || '', batchName: card.batchName || '' },
      createdAt: nowIso()
    });
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  const db = await readMysqlDb();
  return { db, customer: db.customers.find((item) => item.id === updatedCustomer.id) || updatedCustomer, amount };
}

async function renewCustomerNodeForUserMysql(customerId, customerNodeId, monthsInput) {
  const months = Math.max(1, Math.floor(Number(monthsInput || 1)));
  const db = await readMysqlDb();
  const connection = await mysqlPool.getConnection();
  let updatedCustomer;
  let updatedBinding;
  let detail;
  try {
    await connection.beginTransaction();
    const [customerRows] = await connection.query('SELECT payload FROM shiye_customers WHERE id = ? FOR UPDATE', [customerId]);
    const customer = rowObject(customerRows[0]);
    if (!customer.id || customer.status === 'disabled') {
      const error = new Error('用户不存在或已停用');
      error.statusCode = 404;
      throw error;
    }
    const [bindingRows] = await connection.query('SELECT payload FROM shiye_customer_nodes WHERE id = ? FOR UPDATE', [customerNodeId]);
    const binding = rowObject(bindingRows[0]);
    if (!binding.id || binding.customerId !== customer.id) {
      const error = new Error('当前节点不存在或不属于该用户');
      error.statusCode = 404;
      throw error;
    }
    if (binding.status === 'disabled' && !autoDisabledReason(binding.disabledReason)) {
      const error = new Error('当前节点已停用，无法自助续费');
      error.statusCode = 400;
      throw error;
    }
    const [nodeRows] = await connection.query('SELECT payload FROM shiye_service_nodes WHERE id = ?', [binding.nodeId]);
    const serviceNode = rowObject(nodeRows[0]);
    if (!serviceNode.id || serviceNode.status === 'disabled') {
      const error = new Error('当前节点暂不可续费，请联系管理员');
      error.statusCode = 400;
      throw error;
    }
    const unitPrice = Math.max(0, Number(serviceNode.amount || 0));
    if (unitPrice <= 0) {
      const error = new Error('管理员还没有设置当前节点续费价格');
      error.statusCode = 400;
      throw error;
    }
    const price = Number((unitPrice * months).toFixed(2));
    if (Number(customer.balance || 0) < price) {
      const error = new Error(`余额不足，本次续费需要 ${price}`);
      error.statusCode = 400;
      throw error;
    }
    const oldExpireAt = binding.expireAt;
    const beforeBalance = Number(customer.balance || 0);
    const newExpireAt = addMonths(binding.expireAt, months);
    const shouldResetTraffic = binding.disabledReason === 'traffic_exceeded';
    const renewedBinding = { ...binding, expireAt: newExpireAt, status: 'active', disabledReason: '', disabledAt: '', resetTraffic: shouldResetTraffic };
    const syncDb = {
      ...db,
      customers: db.customers.map((item) => item.id === customer.id ? customer : item),
      serviceNodes: db.serviceNodes.map((item) => item.id === serviceNode.id ? serviceNode : item),
      customerNodes: db.customerNodes.map((item) => item.id === binding.id ? renewedBinding : item)
    };
    const target = customerSyncTarget(syncDb, customer, renewedBinding);
    detail = { nodeId: binding.id, serviceNodeId: serviceNode.id, nodeName: binding.name || serviceNode.name || '', months, unitPrice, price, oldExpireAt, newExpireAt, warnings: [] };

    try {
      detail.socksResult = await syncSocksToXui(syncDb, target);
      detail.clientResult = await syncClientToXui(syncDb, target, 'upsert');
      detail.serviceNodeResult = await persistCreatedInboundToServiceNode(syncDb, target.serviceNodeId, detail.clientResult.createdInbound, connection);
    } catch (error) {
      const syncError = new Error('续费失败，请稍后重试或联系管理员');
      syncError.statusCode = 502;
      throw syncError;
    }

    customer.balance = Number((beforeBalance - price).toFixed(2));
    customer.updatedAt = nowIso();
    binding.expireAt = newExpireAt;
    binding.status = 'active';
    binding.disabledReason = '';
    binding.disabledAt = '';
    binding.updatedAt = nowIso();
    updatedCustomer = customer;
    updatedBinding = binding;

    await updateMysqlCustomerRow(connection, customer);
    await upsertMysqlCustomerNodeRow(connection, binding);
    await insertMysqlBalanceLog(connection, {
      id: id('bal'),
      customerId: customer.id,
      customerName: customer.name,
      type: 'user_renew',
      amount: -price,
      beforeBalance,
      afterBalance: customer.balance,
      operator: '用户自助',
      remark: `自助续费 ${binding.name || serviceNode.name || '当前节点'} ${months} 个月`,
      detail,
      createdAt: nowIso()
    });
    await insertMysqlRenewalLog(connection, {
      id: id('ren'),
      customerId: customer.id,
      customerName: customer.name,
      months,
      price,
      beforeExpireAt: oldExpireAt,
      afterExpireAt: binding.expireAt,
      source: 'user',
      status: 'success',
      message: `用户自助续费 ${binding.name || serviceNode.name || '当前节点'} ${months} 个月`,
      detail,
      createdAt: nowIso()
    });
    await insertMysqlLog(connection, {
      id: id('log'),
      customerId: customer.id,
      type: 'renew',
      status: 'success',
      message: `用户自助续费 ${binding.name || serviceNode.name || '当前节点'} ${months} 个月`,
      detail,
      createdAt: nowIso()
    });
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  const freshDb = await readMysqlDb();
  return {
    db: freshDb,
    customer: freshDb.customers.find((item) => item.id === updatedCustomer.id) || updatedCustomer,
    customerNode: freshDb.customerNodes.find((item) => item.id === updatedBinding.id) || updatedBinding,
    detail
  };
}

async function initStorage() {
  if (!isInstalled()) {
    setupRequired = true;
    applyRuntimeSettings(normalizeDb({}));
    return;
  }
  try {
    await initMysqlStorage();
    applyRuntimeSettings(await readMysqlDb());
    setupRequired = false;
  } catch (error) {
    if (hasConfiguredMysql()) throw error;
    setupRequired = true;
    applyRuntimeSettings(normalizeDb({}));
  }
}

async function readDb() {
  const db = await readMysqlDb();
  applyRuntimeSettings(db);
  return db;
}

async function withWriteLock(task) {
  const run = async () => {
    if (setupRequired) return task();
    const connection = await mysqlPool.getConnection();
    try {
      const [rows] = await connection.query('SELECT GET_LOCK(?, 15) AS locked', ['shiye_management_write']);
      if (!rows?.[0]?.locked) throw new Error('数据库繁忙，请稍后重试');
      return await task();
    } finally {
      try { await connection.query('SELECT RELEASE_LOCK(?)', ['shiye_management_write']); } catch {}
      connection.release();
    }
  };
  const next = apiWriteQueue.then(run, run);
  apiWriteQueue = next.catch(() => {});
  return next;
}

function shouldUseWriteLock(req, pathname) {
  if (['/api/payments/epay/notify', '/api/payments/alipay/notify', '/api/payments/bepusdt/notify', '/api/payments/wechat/notify'].includes(pathname)) return true;
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return false;
  if (['/api/login', '/api/logout', '/api/test-xui'].includes(pathname)) return false;
  if (pathname === '/api/setup/install') return false;
  return true;
}

function publicCustomer(customer) {
  const {
    loginPasswordHash,
    selectedPackageId,
    packageName,
    amount,
    expireAt,
    trafficLimitGb,
    xuiServerId,
    inboundId,
    autoCreateInbound,
    inboundPort,
    inboundRemark,
    inboundTemplate,
    inboundSni,
    inboundHost,
    inboundPath,
    inboundGrpcServiceName,
    inboundCertFile,
    inboundKeyFile,
    clientId,
    clientEmail,
    clientUuid,
    protocol,
    useSocks,
    socksNodeId,
    ...safeCustomer
  } = customer;
  return { ...safeCustomer, computedStatus: customerStatus(customer) };
}

function serviceNodeStatus(node) {
  return node?.status === 'disabled' ? 'disabled' : 'enabled';
}

function customerNodeStatus(customer, binding, node) {
  if (customer?.status === 'disabled' || binding?.status === 'disabled' || node?.status === 'disabled') return 'disabled';
  return expiryStatus(binding?.expireAt || '', binding?.status || 'active');
}

function customerSyncTarget(db, customer, binding) {
  const node = db.serviceNodes.find((item) => item.id === binding?.nodeId);
  if (!node) {
    const error = new Error('绑定节点不存在');
    error.statusCode = 404;
    throw error;
  }
  return {
    ...customer,
    packageName: node.name || binding.name || '当前节点',
    amount: Number(node.amount || 0),
    expireAt: binding.expireAt || '',
    trafficLimitGb: Number(binding.trafficLimitGb || node.trafficLimitGb || 0),
    status: customer.status === 'disabled' || binding.status === 'disabled' || node.status === 'disabled' ? 'disabled' : 'active',
    resetTraffic: Boolean(binding.resetTraffic),
    xuiServerId: node.xuiServerId,
    inboundId: node.inboundId,
    autoCreateInbound: node.autoCreateInbound,
    inboundPort: node.inboundPort,
    inboundRemark: node.inboundRemark || node.name,
    inboundTemplate: node.inboundTemplate,
    inboundSni: node.inboundSni,
    inboundHost: node.inboundHost,
    inboundPath: node.inboundPath,
    inboundGrpcServiceName: node.inboundGrpcServiceName,
    inboundCertFile: node.inboundCertFile,
    inboundKeyFile: node.inboundKeyFile,
    useSocks: node.useSocks,
    socksNodeId: node.socksNodeId,
    clientId: binding.clientId || binding.clientEmail,
    clientEmail: binding.clientEmail,
    clientUuid: binding.clientUuid,
    customerNodeId: binding.id,
    serviceNodeId: node.id
  };
}

function customerNodeDisplayName(db, binding) {
  const node = db.serviceNodes.find((item) => item.id === binding?.nodeId);
  const name = String(node?.name || binding?.name || '当前节点').trim() || '当前节点';
  return /3\s*[-]?\s*x\s*[-]?\s*ui|x\s*[-]?\s*ui/i.test(name) ? '当前节点' : name;
}

function customerNodesFor(db, customerId) {
  return db.customerNodes.filter((item) => item.customerId === customerId);
}

function findCustomerNodeForUser(db, customerId, bindingId) {
  const nodes = customerNodesFor(db, customerId);
  if (!nodes.length) return null;
  const idText = String(bindingId || '').trim();
  return idText ? nodes.find((item) => item.id === idText) || null : nodes[0];
}

function publicCustomerNode(db, customer, binding) {
  const node = db.serviceNodes.find((item) => item.id === binding.nodeId) || {};
  const status = customerNodeStatus(customer, binding, node);
  return {
    id: binding.id,
    name: customerNodeDisplayName(db, binding),
    renewPrice: Number(node.amount || 0),
    trafficLimitGb: Number(binding.trafficLimitGb || node.trafficLimitGb || 0),
    expireAt: binding.expireAt || '',
    status,
    disabledReason: binding.disabledReason || '',
    disabledAt: binding.disabledAt || '',
    hasLink: status === 'active' && Boolean(node.xuiServerId && binding.clientEmail),
    remark: binding.remark || ''
  };
}

function assertCustomerNodeUsable(db, customer, binding) {
  const node = db.serviceNodes.find((item) => item.id === binding?.nodeId);
  if (!binding || !node) {
    const error = new Error('node-unavailable');
    error.statusCode = 404;
    throw error;
  }
  if (customerNodeStatus(customer, binding, node) !== 'active') {
    const error = new Error('node-disabled-or-expired');
    error.statusCode = 403;
    throw error;
  }
  return node;
}

async function persistCreatedInboundToServiceNode(db, serviceNodeId, createdInbound, connection = null) {
  const inboundId = Number(createdInbound?.inboundId);
  if (!serviceNodeId || !Number.isInteger(inboundId) || inboundId <= 0) return { skipped: true };
  const index = db.serviceNodes.findIndex((item) => item.id === serviceNodeId);
  if (index < 0) return { skipped: true, reason: 'service-node-not-found', inboundId };

  const node = { ...db.serviceNodes[index] };
  node.inboundId = String(inboundId);
  node.autoCreateInbound = false;
  if (createdInbound.port) node.inboundPort = String(createdInbound.port);
  if (createdInbound.remark) node.inboundRemark = String(createdInbound.remark);
  if (createdInbound.template) node.inboundTemplate = String(createdInbound.template);
  node.updatedAt = nowIso();
  db.serviceNodes[index] = node;

  if (connection) {
    await upsertMysqlServiceNodeRow(connection, node);
  } else {
    await mysqlTransaction((conn) => upsertMysqlServiceNodeRow(conn, node));
  }

  return {
    updated: true,
    serviceNodeId,
    inboundId: node.inboundId,
    inboundPort: node.inboundPort || '',
    autoCreateInbound: node.autoCreateInbound
  };
}

async function clearRemovedInboundFromServiceNode(db, serviceNodeId, inboundResult, connection = null) {
  if (!serviceNodeId || !(inboundResult?.deleted || inboundResult?.missing)) return { skipped: true };
  const index = db.serviceNodes.findIndex((item) => item.id === serviceNodeId);
  if (index < 0) return { skipped: true, reason: 'service-node-not-found' };

  const node = { ...db.serviceNodes[index] };
  if (!node.inboundId && node.autoCreateInbound) return { skipped: true, reason: 'already-clear' };
  node.inboundId = '';
  node.inboundPort = '';
  node.autoCreateInbound = true;
  node.updatedAt = nowIso();
  db.serviceNodes[index] = node;

  if (connection) {
    await upsertMysqlServiceNodeRow(connection, node);
  } else {
    await mysqlTransaction((conn) => upsertMysqlServiceNodeRow(conn, node));
  }

  return { updated: true, serviceNodeId, autoCreateInbound: node.autoCreateInbound };
}

async function syncCustomerNodeToRemote(db, customer, binding, action = 'upsert', options = {}) {
  const target = customerSyncTarget(db, customer, binding);
  const socksResult = await syncSocksToXui(db, target);
  const clientResult = await syncClientToXui(db, target, action);
  const serviceNodeResult = await persistCreatedInboundToServiceNode(db, target.serviceNodeId, clientResult.createdInbound, options.connection);
  return { target, socksResult, clientResult, serviceNodeResult };
}

async function syncAllCustomerNodes(db, customer, action = 'upsert') {
  const bindings = customerNodesFor(db, customer.id);
  const results = [];
  for (const binding of bindings) {
    results.push(await syncCustomerNodeToRemote(db, customer, binding, action));
  }
  return results;
}

async function disableCustomerNodeAndSync(db, customer, binding, reason, detail = {}) {
  const changedBinding = {
    ...binding,
    status: 'disabled',
    disabledReason: reason,
    disabledAt: nowIso(),
    updatedAt: nowIso()
  };
  const syncDb = { ...db, customerNodes: db.customerNodes.map((item) => item.id === changedBinding.id ? changedBinding : item) };
  const logDetail = { reason, customerNodeId: binding.id, warnings: [], ...detail };
  try {
    const syncDetail = await syncCustomerNodeToRemote(syncDb, customer, changedBinding, 'disable');
    logDetail.clientResult = syncDetail.clientResult;
    logDetail.socksResult = syncDetail.socksResult;
    logDetail.serviceNodeResult = syncDetail.serviceNodeResult;
    db.serviceNodes = syncDb.serviceNodes;
  } catch (error) {
    const message = `${customer.name || customer.id} / ${binding.name || binding.id}: ${error.message}`;
    logDetail.warnings.push(message);
  }
  const index = db.customerNodes.findIndex((item) => item.id === binding.id);
  if (index >= 0) db.customerNodes[index] = changedBinding;
  addLog(db, customer.id, 'status', logDetail.warnings.length ? 'warning' : 'success', detail.message || 'customer node auto disabled', logDetail);
  return { binding: changedBinding, warnings: logDetail.warnings };
}

async function disableExpiredCustomerNodes(db) {
  let count = 0;
  const warnings = [];
  const changedBindings = [];
  const now = new Date();
  for (const binding of db.customerNodes) {
    if (binding.status === 'disabled' || !binding.expireAt || new Date(binding.expireAt) >= now) continue;
    const customer = db.customers.find((item) => item.id === binding.customerId);
    if (!customer) continue;
    const result = await disableCustomerNodeAndSync(db, customer, binding, 'expired', { message: 'customer node expired' });
    changedBindings.push(result.binding);
    warnings.push(...result.warnings);
    count += 1;
  }
  return { count, changedBindings, warnings };
}

async function disableRemoteLimitedCustomerNodes(db) {
  let count = 0;
  const warnings = [];
  const changedBindings = [];
  const serverClientCache = new Map();
  for (const binding of db.customerNodes) {
    if (binding.status === 'disabled' || !binding.clientEmail) continue;
    const customer = db.customers.find((item) => item.id === binding.customerId);
    if (!customer || customer.status === 'disabled') continue;
    const node = db.serviceNodes.find((item) => item.id === binding.nodeId);
    if (!node || node.status === 'disabled') continue;
    const server = db.xuiServers.find((item) => item.id === node.xuiServerId);
    if (!server) continue;
    try {
      if (!serverClientCache.has(server.id)) {
        const inbounds = await listXuiInboundsFull(server);
        const index = clientIndexesFromInbounds(inbounds.items);
        serverClientCache.set(server.id, index.byEmail);
      }
      const remote = serverClientCache.get(server.id).get(binding.clientEmail) || await getXuiClientDetail(server, binding.clientEmail);
      const remoteClient = remote.client || remote;
      if (!remote.exists && !remoteClient) continue;
      const reason = clientTrafficExceeded(remoteClient) ? 'traffic_exceeded' : remoteClient.enable === false ? 'remote_disabled' : '';
      if (!['traffic_exceeded', 'remote_disabled'].includes(reason)) continue;
      const result = await disableCustomerNodeAndSync(db, customer, binding, reason, {
        message: reason === 'traffic_exceeded' ? 'customer node traffic exceeded' : 'customer node remote disabled',
        remote: {
          enable: remoteClient.enable,
          usedBytes: clientTrafficUsedBytes(remoteClient),
          limitBytes: clientTrafficLimitBytes(remoteClient)
        }
      });
      changedBindings.push(result.binding);
      warnings.push(...result.warnings);
      count += 1;
    } catch (error) {
      warnings.push(`${customer.name || customer.id} / ${binding.name || binding.id}: ${error.message}`);
    }
  }
  return { count, changedBindings, warnings };
}

async function runCustomerNodeMaintenance({ remote = true } = {}) {
  if (setupRequired || !mysqlPool) return { skipped: true, count: 0, warnings: [] };
  return withWriteLock(() => runCustomerNodeMaintenanceUnlocked({ remote }));
}

async function runCustomerNodeMaintenanceUnlocked({ remote = true } = {}) {
  if (setupRequired || !mysqlPool) return { skipped: true, count: 0, warnings: [] };
  const db = await readDb();
  const expired = await disableExpiredCustomerNodes(db);
  const remoteLimited = remote ? await disableRemoteLimitedCustomerNodes(db) : { count: 0, changedBindings: [], warnings: [] };
  const changed = [...expired.changedBindings, ...remoteLimited.changedBindings];
  const uniqueChanged = [...new Map(changed.map((binding) => [binding.id, binding])).values()];
  const count = expired.count + remoteLimited.count;
  const warnings = [...expired.warnings, ...remoteLimited.warnings];
  const logs = count > 0 ? db.syncLogs.slice(-count) : [];
  await mysqlTransaction(async (connection) => {
    for (const binding of uniqueChanged) await upsertMysqlCustomerNodeRow(connection, binding);
    for (const log of logs) await insertMysqlLog(connection, log);
  });
  return { count, expired, remoteLimited, warnings };
}

function startCustomerNodeMaintenance() {
  if (maintenanceTimer) return;
  maintenanceTimer = setInterval(async () => {
    if (maintenanceRunning) return;
    maintenanceRunning = true;
    try {
      const result = await runCustomerNodeMaintenance({ remote: true });
      if (result?.count || result?.warnings?.length) console.log(`customer node maintenance: disabled ${result.count || 0}, warnings ${result.warnings?.length || 0}`);
    } catch (error) {
      console.warn(`customer node maintenance failed: ${error.message}`);
    } finally {
      maintenanceRunning = false;
    }
  }, NODE_MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref();
}

function validateServiceNode(node) {
  if (!node.name) throw new Error('请填写服务节点名称');
  if (!node.xuiServerId) throw new Error('请选择所属面板节点');
  if (!node.inboundId && !node.autoCreateInbound) throw new Error('请填写入站 ID，或启用自动创建入站');
  if (node.inboundId) {
    const inboundId = Number(node.inboundId);
    if (!Number.isInteger(inboundId) || inboundId <= 0) throw new Error('入站 ID 必须是正整数');
  }
  if (node.inboundPort) {
    const port = Number(node.inboundPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('新入站端口必须是 1-65535 之间的数字');
  }
  if (node.autoCreateInbound && node.inboundTemplate === 'vless-tls' && (!node.inboundCertFile || !node.inboundKeyFile)) throw new Error('TLS 模板需要填写证书文件路径和私钥文件路径');
}

function validateCustomerNodeBinding(db, binding) {
  if (!binding.customerId) throw new Error('请选择用户');
  if (!binding.nodeId) throw new Error('请选择服务节点');
  if (!db.customers.some((item) => item.id === binding.customerId)) throw new Error('用户不存在');
  if (!db.serviceNodes.some((item) => item.id === binding.nodeId)) throw new Error('服务节点不存在');
  if (!binding.clientEmail) throw new Error('客户端邮箱不能为空');
  if (!binding.clientUuid) throw new Error('UUID 不能为空');
}

function publicDb(db) {
  return {
    settings: {
      ...publicBrandSettings(db.settings),
      currency: db.settings?.currency || 'CNY',
      expiryWarningDays: Number(db.settings?.expiryWarningDays ?? 3),
      purchaseCardUrl: db.settings?.purchaseCardUrl || '',
      adminPath: normalizeRoutePath(db.settings?.adminPath || adminPath()),
      adminUsername: adminUsername(db),
      passwordManaged: Boolean(db.settings?.admin?.passwordHash),
      defaultPasswordWarning: usingDefaultAdmin(db),
      payments: publicPaymentSettings(db.settings?.payments)
    },
    customers: db.customers.map(publicCustomer),
    xuiServers: db.xuiServers.map(({ passwordEnc, apiTokenEnc, ...server }) => ({
      ...server,
      username: server.username || '',
      password: maskSecret(passwordEnc),
      apiToken: maskSecret(apiTokenEnc)
    })),
    serviceNodes: db.serviceNodes.map((node) => ({
      ...node,
      computedStatus: serviceNodeStatus(node)
    })),
    customerNodes: db.customerNodes.map(({ amount, ...binding }) => ({ ...binding })),
    socksNodes: db.socksNodes.map(({ passwordEnc, ...node }) => ({
      ...node,
      password: maskSecret(passwordEnc)
    })),
    cards: db.cards.map((card) => ({ ...card })),
    cardBatches: db.cardBatches.map((batch) => ({ ...batch })),
    rechargeOrders: db.rechargeOrders.slice(-500).reverse(),
    balanceLogs: db.balanceLogs.slice(-500).reverse(),
    renewalLogs: db.renewalLogs.slice(-500).reverse(),
    syncLogs: db.syncLogs.slice(-250).reverse()
  };
}

function userNodeDisplayName(customer) {
  const name = String(customer?.packageName || customer?.inboundRemark || customer?.name || '当前节点').trim() || '当前节点';
  return /3\s*[-]?\s*x\s*[-]?\s*ui|x\s*[-]?\s*ui/i.test(name) ? '当前节点' : name;
}

function extractXuiLinks(data) {
  const values = [];
  const visit = (value) => {
    const parsed = typeof value === 'string' ? parseMaybeJson(value) : value;
    if (parsed && parsed !== value) return visit(parsed);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === 'object') {
      for (const key of ['link', 'url', 'uri', 'shareLink', 'share_link', 'subscription', 'sub']) {
        if (typeof value[key] === 'string') visit(value[key]);
      }
      for (const key of ['links', 'urls', 'items', 'list', 'obj', 'data', 'result']) {
        if (value[key] !== undefined) visit(value[key]);
      }
      return;
    }
    const text = String(value || '').trim();
    if (/^(vless|vmess|trojan|ss|hysteria|hy2):\/\//i.test(text)) values.push(text);
  };
  visit(data);
  return [...new Set(values)];
}

async function getXuiClientLinks(db, customer) {
  if (!customer?.xuiServerId || !customer?.clientEmail) return [];
  const server = db.xuiServers.find((item) => item.id === customer.xuiServerId);
  if (!server) return [];
  const email = encodeURIComponent(customer.clientEmail);
  const result = await xuiRequest(server, withApiPrefix(server, `/panel/api/clients/links/${email}`), { method: 'GET' });
  return extractXuiLinks(result.data);
}

function publicUserDb(db, customer) {
  const nodes = customerNodesFor(db, customer.id).map((binding) => publicCustomerNode(db, customer, binding));
  const earliestNode = nodes
    .filter((node) => node.expireAt)
    .sort((a, b) => new Date(a.expireAt).getTime() - new Date(b.expireAt).getTime())[0];
  const safeCustomer = {
    id: customer.id,
    name: customer.name,
    contact: customer.contact || '',
    loginUsername: customer.loginUsername || '',
    balance: Number(customer.balance || 0),
    amount: Number(nodes[0]?.renewPrice || 0),
    expireAt: earliestNode?.expireAt || '',
    trafficLimitGb: Number(nodes.reduce((sum, node) => sum + Number(node.trafficLimitGb || 0), 0)),
    status: customer.status || 'active',
    computedStatus: customerStatus(customer)
  };
  return {
    settings: {
      ...publicBrandSettings(db.settings),
      currency: db.settings?.currency || 'CNY',
      purchaseCardUrl: db.settings?.purchaseCardUrl || '',
      payments: publicUserPaymentSettings(db.settings?.payments)
    },
    customer: safeCustomer,
    nodes,
    node: nodes[0] || null,
    rechargeOrders: db.rechargeOrders.filter((order) => order.customerId === customer.id).slice(-20).reverse().map(publicRechargeResult),
    balanceLogs: db.balanceLogs.filter((log) => log.customerId === customer.id).slice(-50).reverse().map(publicBalanceLog),
    renewalLogs: db.renewalLogs.filter((log) => log.customerId === customer.id).slice(-50).reverse().map(publicRenewalLog)
  };
}

async function parseJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES) {
      const error = new Error('请求体过大');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('请求体不是有效 JSON');
    error.statusCode = 400;
    throw error;
  }
}

async function parseRequestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES) {
      const error = new Error('Request body too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  if (contentType.includes('application/json')) {
    try { return JSON.parse(text); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

function securityHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    ...extra
  };
}

function send(res, status, data) {
  res.writeHead(status, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
  res.end(text);
}

function sendError(res, status, message, detail) {
  send(res, status, { ok: false, message, detail });
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || '';
  const match = cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}

function sessionCookieName(entryOrRole = 'user') {
  return entryOrRole === 'admin' ? 'xcp_admin_session' : 'xcp_user_session';
}

async function requireAuth(req, res) {
  const pathname = req.url ? new URL(req.url, 'http://local').pathname : '';
  const headerEntry = String(req.headers['x-entry-mode'] || '').trim();
  const wantsAdmin = headerEntry === 'admin' || (pathname === '/api/bootstrap'
    ? new URL(req.url, 'http://local').searchParams.get('entry') === 'admin'
    : false);
  const cookieNames = wantsAdmin
    ? ['xcp_admin_session', 'xcp_session']
    : ['xcp_user_session', 'xcp_admin_session', 'xcp_session'];
  let token = '';
  let session = null;
  for (const name of cookieNames) {
    token = getCookie(req, name);
    session = await loadSession(token);
    if (session) break;
  }
  if (!session) {
    await deleteSession(token);
    sendError(res, 401, '请先登录');
    return null;
  }
  await refreshSession(token, session);
  return session;
}

function requireAdmin(session, res) {
  if (session.role === 'admin') return true;
  sendError(res, 403, '需要管理员权限');
  return false;
}

function requireUser(session, res) {
  if (session.role === 'user' && session.customerId) return true;
  sendError(res, 403, '需要用户账号登录');
  return false;
}

function tooManyLoginAttempts(req) {
  const key = clientIp(req);
  const now = Date.now();
  const entry = loginAttempts.get(key) || { count: 0, firstAt: now };
  if (now - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 0, firstAt: now });
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordLoginAttempt(req, success) {
  const key = clientIp(req);
  if (success) {
    loginAttempts.delete(key);
    return;
  }
  const now = Date.now();
  const entry = loginAttempts.get(key) || { count: 0, firstAt: now };
  if (now - entry.firstAt > LOGIN_WINDOW_MS) loginAttempts.set(key, { count: 1, firstAt: now });
  else loginAttempts.set(key, { count: entry.count + 1, firstAt: entry.firstAt });
}

function isHttpsRequest(req) {
  return req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function sessionCookie(req, name, token, options = {}) {
  const parts = [`${name}=${encodeURIComponent(token)}`, 'HttpOnly', 'Path=/', 'SameSite=Lax'];
  if (isHttpsRequest(req)) parts.push('Secure');
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  return parts.join('; ');
}

function hasField(input, field) {
  return Object.prototype.hasOwnProperty.call(input, field);
}

function textValue(input, existing, field, fallback = '') {
  return String(hasField(input, field) ? input[field] : existing[field] ?? fallback).trim();
}

function numberValue(input, existing, field, fallback = 0) {
  const value = hasField(input, field) ? input[field] : existing[field] ?? fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : Number(fallback);
}

function normalizeBasePath(value) {
  const text = String(value || '/').trim();
  if (!text || text === '/') return '/';
  return `/${text.replace(/^\/+|\/+$/g, '')}`;
}

function normalizeEndpoint(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.startsWith('/') ? text : `/${text}`;
}

function normalizeServer(input, existing = {}) {
  const passwordText = hasField(input, 'password') ? String(input.password || '') : '********';
  const apiTokenText = hasField(input, 'apiToken') ? String(input.apiToken || '') : '********';
  const passwordEnc = passwordText === ''
    ? ''
    : passwordText !== '********'
      ? encrypt(passwordText)
      : existing.passwordEnc || '';
  const apiTokenEnc = apiTokenText === ''
    ? ''
    : apiTokenText !== '********'
      ? encrypt(apiTokenText)
      : existing.apiTokenEnc || '';
  return {
    ...existing,
    id: existing.id || id('xui'),
    name: textValue(input, existing, 'name'),
    protocol: ['http', 'https'].includes(textValue(input, existing, 'protocol', 'https')) ? textValue(input, existing, 'protocol', 'https') : 'https',
    host: textValue(input, existing, 'host'),
    port: numberValue(input, existing, 'port', 2053),
    basePath: normalizeBasePath(textValue(input, existing, 'basePath', '/')),
    apiPrefix: normalizeEndpoint(textValue(input, existing, 'apiPrefix')),
    loginEndpoint: normalizeEndpoint(textValue(input, existing, 'loginEndpoint')),
    addClientEndpoint: normalizeEndpoint(textValue(input, existing, 'addClientEndpoint')),
    updateClientEndpoint: normalizeEndpoint(textValue(input, existing, 'updateClientEndpoint')),
    listInboundsEndpoint: normalizeEndpoint(textValue(input, existing, 'listInboundsEndpoint')),
    defaultInboundCertFile: textValue(input, existing, 'defaultInboundCertFile'),
    defaultInboundKeyFile: textValue(input, existing, 'defaultInboundKeyFile'),
    username: textValue(input, existing, 'username'),
    passwordEnc,
    apiTokenEnc,
    tlsVerify: input.tlsVerify !== false,
    status: textValue(input, existing, 'status', 'enabled') === 'disabled' ? 'disabled' : 'enabled',
    remark: textValue(input, existing, 'remark'),
    updatedAt: nowIso(),
    createdAt: existing.createdAt || nowIso()
  };
}

function withApiPrefix(server, endpoint) {
  const prefix = String(server.apiPrefix || '').trim().replace(/\/$/, '');
  if (!prefix) return endpoint;
  return `${prefix}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
}

function uniqueRoutes(routes) {
  const seen = new Set();
  return routes.filter((route) => {
    const key = `${route.method || 'GET'}:${route.endpoint}:${JSON.stringify(route.body ?? {})}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeSocks(input, existing = {}) {
  const passwordText = hasField(input, 'password') ? String(input.password || '') : '********';
  const passwordEnc = passwordText === ''
    ? ''
    : passwordText !== '********'
      ? encrypt(passwordText)
      : existing.passwordEnc || '';
  const rawTag = textValue(input, existing, 'tag') || `socks_${textValue(input, existing, 'name', 'node').toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
  const tag = rawTag.replace(/^_+|_+$/g, '') || `socks_${crypto.randomBytes(3).toString('hex')}`;
  return {
    ...existing,
    id: existing.id || id('socks'),
    name: textValue(input, existing, 'name'),
    address: textValue(input, existing, 'address'),
    port: numberValue(input, existing, 'port', 1080),
    username: textValue(input, existing, 'username'),
    passwordEnc,
    tag,
    status: textValue(input, existing, 'status', 'enabled') === 'disabled' ? 'disabled' : 'enabled',
    remark: textValue(input, existing, 'remark'),
    updatedAt: nowIso(),
    createdAt: existing.createdAt || nowIso()
  };
}

function normalizeCardCode(value) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function generateCardCode(prefix = '') {
  const head = String(prefix || '').trim().replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 10);
  const body = crypto.randomBytes(9).toString('hex').toUpperCase().match(/.{1,6}/g).join('-');
  return head ? `${head}-${body}` : body;
}

function cardGroupType(card, currency = 'CNY') {
  const fallback = `${Number(card.amount || 0).toFixed(2)} ${currency || 'CNY'}`;
  return String(card.batchName || card.type || card.remark || fallback).trim() || fallback;
}

function normalizeCardBatch(input = {}, existing = {}) {
  const amount = Math.max(0, Number(hasField(input, 'amount') ? input.amount : existing.amount || 0));
  const name = String(input.name || input.type || input.remark || existing.name || `${amount.toFixed(2)} CNY`).trim() || `${amount.toFixed(2)} CNY`;
  return {
    ...existing,
    id: existing.id || id('batch'),
    name,
    amount,
    prefix: String(hasField(input, 'prefix') ? input.prefix : existing.prefix || '').trim().replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 10),
    remark: String(hasField(input, 'remark') ? input.remark : existing.remark || '').trim(),
    createdAt: existing.createdAt || nowIso(),
    updatedAt: nowIso()
  };
}

function normalizeServiceNode(input, existing = {}) {
  return {
    ...existing,
    id: input.id || existing.id || id('node'),
    name: textValue(input, existing, 'name', '当前节点') || '当前节点',
    xuiServerId: textValue(input, existing, 'xuiServerId'),
    inboundId: textValue(input, existing, 'inboundId'),
    autoCreateInbound: Boolean(hasField(input, 'autoCreateInbound') ? input.autoCreateInbound : existing.autoCreateInbound ?? false),
    inboundPort: textValue(input, existing, 'inboundPort'),
    inboundRemark: textValue(input, existing, 'inboundRemark'),
    inboundTemplate: INBOUND_TEMPLATES.has(textValue(input, existing, 'inboundTemplate', 'vless-tcp')) ? textValue(input, existing, 'inboundTemplate', 'vless-tcp') : 'vless-tcp',
    inboundSni: textValue(input, existing, 'inboundSni'),
    inboundHost: textValue(input, existing, 'inboundHost'),
    inboundPath: textValue(input, existing, 'inboundPath'),
    inboundGrpcServiceName: textValue(input, existing, 'inboundGrpcServiceName'),
    inboundCertFile: textValue(input, existing, 'inboundCertFile'),
    inboundKeyFile: textValue(input, existing, 'inboundKeyFile'),
    amount: numberValue(input, existing, 'amount', 0),
    trafficLimitGb: numberValue(input, existing, 'trafficLimitGb', 100),
    useSocks: Boolean(hasField(input, 'useSocks') ? input.useSocks : existing.useSocks ?? false),
    socksNodeId: textValue(input, existing, 'socksNodeId'),
    status: textValue(input, existing, 'status', 'enabled') === 'disabled' ? 'disabled' : 'enabled',
    remark: textValue(input, existing, 'remark'),
    updatedAt: nowIso(),
    createdAt: existing.createdAt || input.createdAt || nowIso()
  };
}

function normalizeCustomerNode(input, existing = {}) {
  const clientEmail = String(hasField(input, 'clientEmail') ? input.clientEmail : existing.clientEmail || '').trim()
    || `cust_${crypto.randomBytes(4).toString('hex')}`;
  const clientUuid = String(hasField(input, 'clientUuid') ? input.clientUuid : existing.clientUuid || '').trim()
    || crypto.randomUUID();
  return {
    ...existing,
    id: input.id || existing.id || id('cnode'),
    customerId: textValue(input, existing, 'customerId'),
    nodeId: textValue(input, existing, 'nodeId'),
    name: textValue(input, existing, 'name'),
    clientId: textValue(input, existing, 'clientId') || clientEmail,
    clientEmail,
    clientUuid,
    expireAt: textValue(input, existing, 'expireAt') || addMonths(null, 1),
    trafficLimitGb: Math.max(0, numberValue(input, existing, 'trafficLimitGb', 0)),
    status: textValue(input, existing, 'status', 'active') === 'disabled' ? 'disabled' : 'active',
    disabledReason: textValue(input, existing, 'disabledReason'),
    disabledAt: textValue(input, existing, 'disabledAt'),
    remark: textValue(input, existing, 'remark'),
    updatedAt: nowIso(),
    createdAt: existing.createdAt || input.createdAt || nowIso()
  };
}

function verifyCustomerLogin(db, username, password) {
  const loginName = String(username || '').trim();
  if (!loginName) return null;
  return db.customers.find((customer) => (
    customer.loginUsername === loginName
    && customer.loginPasswordHash
    && customer.status !== 'disabled'
    && verifyPassword(password, customer.loginPasswordHash)
  )) || null;
}

function normalizeCustomer(input, existing = {}) {
  const name = textValue(input, existing, 'name');
  const loginPassword = hasField(input, 'loginPassword') ? String(input.loginPassword || '') : '';
  const loginUsername = textValue(input, existing, 'loginUsername');
  return {
    id: existing.id || id('cus'),
    name,
    contact: textValue(input, existing, 'contact'),
    loginUsername,
    loginPasswordHash: loginPassword ? hashPassword(loginPassword) : existing.loginPasswordHash || '',
    balance: Math.max(0, numberValue(input, existing, 'balance', 0)),
    status: textValue(input, existing, 'status', 'active') === 'disabled' ? 'disabled' : 'active',
    remark: textValue(input, existing, 'remark'),
    updatedAt: nowIso(),
    createdAt: existing.createdAt || nowIso()
  };
}

function validateCustomerBinding(customer) {
  if (!customer.xuiServerId) throw new Error('请先选择 3x-ui 节点');
  if (!customer.inboundId && !customer.autoCreateInbound) throw new Error('请填写 3x-ui 入站 ID，或启用自动创建入站');
  if (!Number.isInteger(Number(customer.inboundId)) || Number(customer.inboundId) <= 0) {
    if (customer.inboundId) throw new Error('入站 ID 必须是 3x-ui 入站列表里的数字 ID，例如 1');
  }
  if (customer.inboundPort) {
    const port = Number(customer.inboundPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('新入站端口必须是 1-65535 之间的数字');
  }
  if (customer.autoCreateInbound && customer.inboundTemplate === 'vless-tls' && (!customer.inboundCertFile || !customer.inboundKeyFile)) {
    throw new Error('TLS 模板需要填写证书文件路径和私钥文件路径');
  }
  if (!customer.clientEmail) throw new Error('客户端邮箱不能为空');
}

function applyServerDefaultTlsPaths(customer, server) {
  if (!customer || !server || customer.inboundTemplate !== 'vless-tls') return false;
  let changed = false;
  if (!customer.inboundCertFile && server.defaultInboundCertFile) {
    customer.inboundCertFile = server.defaultInboundCertFile;
    changed = true;
  }
  if (!customer.inboundKeyFile && server.defaultInboundKeyFile) {
    customer.inboundKeyFile = server.defaultInboundKeyFile;
    changed = true;
  }
  return changed;
}

function applyDetectedTlsDefaultsFromInbounds(server, inbounds = []) {
  if (!server) return false;
  if (server.defaultInboundCertFile && server.defaultInboundKeyFile) return false;
  const detected = (inbounds || [])
    .map((inbound) => inboundTlsCertPathsOf(inbound))
    .find((paths) => paths.certFile || paths.keyFile);
  if (!detected) return false;
  let changed = false;
  if (!server.defaultInboundCertFile && detected.certFile) {
    server.defaultInboundCertFile = detected.certFile;
    changed = true;
  }
  if (!server.defaultInboundKeyFile && detected.keyFile) {
    server.defaultInboundKeyFile = detected.keyFile;
    changed = true;
  }
  if (changed) server.updatedAt = nowIso();
  return changed;
}

function ensureCustomerIdentity(customer) {
  if (!customer.clientEmail) customer.clientEmail = `cust_${crypto.randomBytes(4).toString('hex')}`;
  if (!customer.clientUuid) customer.clientUuid = crypto.randomUUID();
  if (!customer.clientId) customer.clientId = customer.clientEmail;
  return customer;
}

function validateCustomerLogin(db, customer, originalId = '') {
  if (!customer.loginUsername) return;
  if (customer.loginUsername === adminUsername(db)) throw new Error('用户登录账号不能和管理员账号相同');
  const duplicate = db.customers.find((item) => item.id !== originalId && item.loginUsername && item.loginUsername === customer.loginUsername);
  if (duplicate) throw new Error('用户登录账号已存在，请换一个');
}

function inboundIdOf(item) {
  return Number(item?.id ?? item?.inboundId ?? item?.inbound_id ?? item?.value);
}

function inboundLabel(item) {
  const idValue = item?.id ?? item?.inboundId ?? item?.inbound_id ?? item?.value ?? '-';
  const name = item?.remark || item?.tag || item?.label || item?.name || '';
  return name ? `${idValue}(${name})` : String(idValue);
}

function inboundTagOf(item) {
  const explicit = String(item?.tag || item?.inboundTag || item?.inbound_tag || '').trim();
  if (explicit) return explicit;
  const port = inboundPortOf(item);
  const settings = parseMaybeJson(item?.streamSettings) || item?.streamSettings || {};
  const network = String(settings?.network || item?.network || 'tcp').trim() || 'tcp';
  return port ? `in-${port}-${network}` : '';
}

function inboundPortOf(item) {
  const value = item?.port ?? item?.listenPort ?? item?.listen_port;
  const port = Number(value);
  return Number.isInteger(port) ? port : 0;
}

function inboundStreamSettingsOf(inbound) {
  const parsed = parseMaybeJson(inbound?.streamSettings);
  if (parsed && typeof parsed === 'object') return parsed;
  if (inbound?.streamSettings && typeof inbound.streamSettings === 'object') return inbound.streamSettings;
  return {};
}

function inboundTemplateOf(inbound) {
  const protocol = String(inbound?.protocol || 'vless').trim().toLowerCase();
  const stream = inboundStreamSettingsOf(inbound);
  const network = String(stream.network || 'tcp').trim().toLowerCase() || 'tcp';
  const security = String(stream.security || 'none').trim().toLowerCase() || 'none';
  if (protocol !== 'vless') return 'vless-tcp';
  if (security === 'reality') return 'vless-reality';
  if (security === 'tls') return 'vless-tls';
  if (network === 'ws') return 'vless-ws';
  if (network === 'grpc') return 'vless-grpc';
  return 'vless-tcp';
}

function inboundSniOf(inbound) {
  const stream = inboundStreamSettingsOf(inbound);
  return String(
    stream.tlsSettings?.serverName
    || stream.realitySettings?.serverNames?.[0]
    || stream.realitySettings?.serverName
    || ''
  ).trim();
}

function inboundHostOf(inbound) {
  const stream = inboundStreamSettingsOf(inbound);
  return String(
    stream.wsSettings?.host
    || stream.wsSettings?.headers?.Host
    || stream.realitySettings?.dest
    || inboundSniOf(inbound)
    || ''
  ).trim();
}

function inboundPathOf(inbound) {
  const stream = inboundStreamSettingsOf(inbound);
  return String(stream.wsSettings?.path || stream.httpSettings?.path || '').trim();
}

function inboundGrpcServiceNameOf(inbound) {
  const stream = inboundStreamSettingsOf(inbound);
  return String(stream.grpcSettings?.serviceName || '').trim();
}

function inboundTlsCertPathsOf(inbound) {
  const tls = inboundStreamSettingsOf(inbound).tlsSettings || {};
  const certificate = Array.isArray(tls.certificates) ? tls.certificates[0] || {} : {};
  return {
    certFile: String(tls.certFile || tls.certificateFile || certificate.certificateFile || certificate.certFile || '').trim(),
    keyFile: String(tls.keyFile || tls.keyPath || certificate.keyFile || certificate.keyPath || '').trim()
  };
}

function usedInboundPorts(items) {
  return new Set(items.map(inboundPortOf).filter((port) => port > 0));
}

function pickInboundPort(items, preferredPort) {
  const used = usedInboundPorts(items);
  const preferred = Number(preferredPort || 0);
  if (preferred) {
    if (used.has(preferred)) throw new Error(`端口 ${preferred} 已被 3x-ui 现有入站占用，请换一个端口`);
    return preferred;
  }
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const port = 20000 + crypto.randomInt(40000);
    if (!used.has(port)) return port;
  }
  for (let port = 20000; port <= 59999; port += 1) {
    if (!used.has(port)) return port;
  }
  throw new Error('没有找到可用入站端口，请手动填写一个未占用端口');
}

function safePath(value, fallback) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text.startsWith('/') ? text : `/${text}`;
}

function randomShortId() {
  return crypto.randomBytes(8).toString('hex');
}

function defaultAlpn() {
  return [...DEFAULT_ALPN];
}

async function getRealityKeyPair(server) {
  const result = await xuiRequest(server, withApiPrefix(server, '/panel/api/server/getNewX25519Cert'), { method: 'GET' });
  const object = xuiObject(result.data);
  const privateKey = object.privateKey || object.private_key || object.obj?.privateKey || object.data?.privateKey || '';
  const publicKey = object.publicKey || object.public_key || object.obj?.publicKey || object.data?.publicKey || '';
  if (!privateKey) throw new Error('Reality 模板生成 X25519 密钥失败，请检查 3-xui API Token 权限');
  return { privateKey, publicKey };
}

function buildDefaultInbound(customer, port, options = {}) {
  const remark = String(customer.inboundRemark || customer.name || customer.clientEmail || `十夜-${port}`).trim();
  const template = customer.inboundTemplate || 'vless-tcp';
  const sni = String(customer.inboundSni || customer.inboundHost || 'www.cloudflare.com').trim();
  const host = String(customer.inboundHost || sni).trim();
  const alpn = defaultAlpn();
  const base = {
    enable: true,
    remark,
    listen: '',
    port,
    protocol: 'vless',
    settings: {
      clients: [],
      decryption: 'none',
      fallbacks: []
    },
    sniffing: {
      enabled: true,
      destOverride: ['http', 'tls', 'quic'],
      metadataOnly: false,
      routeOnly: false
    },
    expiryTime: 0,
    total: 0
  };

  const tcpSettings = {
    network: 'tcp',
    security: 'none',
    tcpSettings: {
      acceptProxyProtocol: false,
      header: { type: 'none' }
    }
  };

  if (template === 'vless-reality') {
    const keys = options.realityKeys || {};
    return {
      ...base,
      streamSettings: {
        network: 'tcp',
        security: 'reality',
        tcpSettings: tcpSettings.tcpSettings,
        realitySettings: {
          show: false,
          dest: host.includes(':') ? host : `${host}:443`,
          xver: 0,
          serverNames: [sni],
          alpn,
          privateKey: keys.privateKey,
          publicKey: keys.publicKey || '',
          shortIds: [randomShortId()],
          settings: { publicKey: keys.publicKey || '', fingerprint: 'chrome', serverName: sni, spiderX: '/', alpn }
        }
      }
    };
  }

  if (template === 'vless-tls') {
    return {
      ...base,
      streamSettings: {
        network: 'tcp',
        security: 'tls',
        tcpSettings: tcpSettings.tcpSettings,
        tlsSettings: {
          serverName: sni,
          alpn,
          minVersion: '1.2',
          maxVersion: '1.3',
          cipherSuites: '',
          rejectUnknownSni: false,
          certificates: [{ certificateFile: customer.inboundCertFile, keyFile: customer.inboundKeyFile }],
          certFile: customer.inboundCertFile,
          keyFile: customer.inboundKeyFile
        }
      }
    };
  }

  if (template === 'vless-ws') {
    return {
      ...base,
      streamSettings: {
        network: 'ws',
        security: 'none',
        wsSettings: {
          acceptProxyProtocol: false,
          path: safePath(customer.inboundPath, '/shiye'),
          host,
          headers: host ? { Host: host } : {}
        }
      }
    };
  }

  if (template === 'vless-grpc') {
    return {
      ...base,
      streamSettings: {
        network: 'grpc',
        security: 'none',
        grpcSettings: {
          serviceName: String(customer.inboundGrpcServiceName || 'shiye').trim(),
          multiMode: false
        }
      }
    };
  }

  return {
    ...base,
    streamSettings: tcpSettings
  };
}

function baseUrl(server) {
  const basePath = server.basePath === '/' ? '' : server.basePath.replace(/\/$/, '');
  return `${server.protocol}://${server.host}:${server.port}${basePath}`;
}

function requestUrl(server, endpoint) {
  const base = baseUrl(server);
  const basePath = server.basePath === '/' ? '' : server.basePath.replace(/\/$/, '');
  const pathText = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  if (basePath && pathText === basePath) {
    return `${server.protocol}://${server.host}:${server.port}${pathText}`;
  }
  if (basePath && pathText.startsWith(`${basePath}/`)) {
    return `${server.protocol}://${server.host}:${server.port}${pathText}`;
  }
  return `${base}${pathText}`;
}

function cookieHeader(setCookie) {
  return String(setCookie || '')
    .split(/,(?=\s*[^;]+=)/)
    .map((part) => part.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function xuiLoginContext(server) {
  const urls = uniqueRoutes([
    { endpoint: '/' },
    { endpoint: withApiPrefix(server, '/') }
  ]);
  for (const item of urls) {
    try {
      const response = await fetch(requestUrl(server, item.endpoint), {
        method: 'GET',
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
      });
      const text = await response.text();
      const csrf = text.match(/<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i)?.[1] || '';
      const cookie = cookieHeader(response.headers.get('set-cookie'));
      if (csrf || cookie) return { csrf, cookie };
    } catch {
      // Try the next common login page path.
    }
  }
  return { csrf: '', cookie: '' };
}

async function xuiFetch(server, endpoint, options = {}) {
  const url = requestUrl(server, endpoint);
  const headers = { ...(options.headers || {}) };
  const apiToken = decrypt(server.apiTokenEnc);
  if (apiToken && !headers.Cookie && !headers.Authorization) headers.Authorization = `Bearer ${apiToken}`;
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, {
    ...options,
    headers,
    body: typeof options.body === 'string' ? options.body : options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) {
    const error = new Error(`${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
    error.url = url;
    throw error;
  }
  if (data && data.success === false) {
    const message = data.msg || data.message || data.error || JSON.stringify(data).slice(0, 300);
    const error = new Error(`3x-ui API failed: ${message}`);
    error.url = url;
    error.data = data;
    throw error;
  }
  return { data, headers: response.headers, url };
}

async function xuiLogin(server) {
  const username = server.username;
  const password = decrypt(server.passwordEnc);
  if (!username || !password) return '';
  const context = await xuiLoginContext(server);
  const body = { username, password };
  const tries = uniqueRoutes([
    server.loginEndpoint ? { endpoint: server.loginEndpoint, body } : null,
    { endpoint: withApiPrefix(server, '/login'), body },
    { endpoint: withApiPrefix(server, '/panel/login'), body },
    { endpoint: withApiPrefix(server, '/panel/api/login'), body },
    { endpoint: withApiPrefix(server, '/api/login'), body },
    { endpoint: '/login', body },
    { endpoint: '/panel/login', body },
    { endpoint: '/panel/api/login', body },
    { endpoint: '/api/login', body }
  ].filter(Boolean));
  for (const item of tries) {
    const url = requestUrl(server, item.endpoint);
    const baseHeaders = {
      'X-Requested-With': 'XMLHttpRequest',
      ...(context.csrf ? { 'X-CSRF-Token': context.csrf } : {}),
      ...(context.cookie ? { Cookie: context.cookie } : {})
    };
    const attempts = [
      { headers: { ...baseHeaders, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: new URLSearchParams(item.body).toString() },
      { headers: { ...baseHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(item.body) }
    ];
    for (const attempt of attempts) {
      try {
        const response = await fetch(url, { method: 'POST', ...attempt });
        const cookie = response.headers.get('set-cookie') || '';
        if (response.ok && cookie) {
          return [context.cookie, cookieHeader(cookie)].filter(Boolean).join('; ');
        }
      } catch {
        // Try the next common login path.
      }
    }
  }
  return '';
}

async function xuiRequest(server, endpoint, options = {}) {
  const headers = { ...(options.headers || {}) };
  const apiToken = decrypt(server.apiTokenEnc);
  const cookie = apiToken ? '' : await xuiLogin(server);
  if (!cookie && !apiToken && server.username && decrypt(server.passwordEnc)) {
    const error = new Error('3x-ui 登录失败，请检查账号密码、基础路径/API 前缀，建议优先填写 API Token。');
    error.url = requestUrl(server, endpoint);
    throw error;
  }
  if (cookie) headers.Cookie = cookie;
  if (apiToken && !headers.Authorization) headers.Authorization = `Bearer ${apiToken}`;
  return xuiFetch(server, endpoint, { ...options, headers });
}

function xuiArray(data) {
  const root = xuiObject(data);
  const obj = parseMaybeJson(data?.obj);
  const body = parseMaybeJson(data?.data);
  const result = parseMaybeJson(data?.result);
  if (Array.isArray(data)) return data;
  if (Array.isArray(root)) return root;
  if (Array.isArray(root?.items)) return root.items;
  if (Array.isArray(root?.inbounds)) return root.inbounds;
  if (Array.isArray(root?.clients)) return root.clients;
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(body)) return body;
  if (Array.isArray(result)) return result;
  if (Array.isArray(data?.obj)) return data.obj;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.result)) return data.result;
  if (Array.isArray(data?.inbounds)) return data.inbounds;
  if (Array.isArray(data?.clients)) return data.clients;
  if (Array.isArray(data?.obj?.inbounds)) return data.obj.inbounds;
  if (Array.isArray(data?.obj?.clients)) return data.obj.clients;
  if (Array.isArray(data?.data?.inbounds)) return data.data.inbounds;
  if (Array.isArray(data?.data?.clients)) return data.data.clients;
  if (Array.isArray(data?.obj?.items)) return data.obj.items;
  if (Array.isArray(data?.data?.items)) return data.data.items;
  return [];
}

function xuiObject(data) {
  const obj = parseMaybeJson(data?.obj);
  if (obj && !Array.isArray(obj)) return obj;
  const body = parseMaybeJson(data?.data);
  if (body && !Array.isArray(body)) return body;
  const result = parseMaybeJson(data?.result);
  if (result && !Array.isArray(result)) return result;
  if (data?.obj && !Array.isArray(data.obj)) return data.obj;
  if (data?.data && !Array.isArray(data.data)) return data.data;
  if (data?.result && !Array.isArray(data.result)) return data.result;
  return data || {};
}

async function listXuiInbounds(server) {
  const endpoints = uniqueRoutes([
    server.listInboundsEndpoint ? { endpoint: server.listInboundsEndpoint } : null,
    { endpoint: withApiPrefix(server, '/panel/api/inbounds/options') },
    { endpoint: withApiPrefix(server, '/panel/api/inbounds/list/slim') },
    { endpoint: withApiPrefix(server, '/panel/api/inbounds/list') }
  ].filter(Boolean));
  const errors = [];
  let firstSuccess = null;
  for (const route of endpoints) {
    try {
      const result = await xuiRequest(server, route.endpoint, { method: 'GET' });
      const items = xuiArray(result.data);
      const value = { endpoint: route.endpoint, items, raw: result.data };
      if (!firstSuccess) firstSuccess = value;
      if (items.length) return value;
    } catch (error) {
      errors.push(`${route.endpoint}: ${error.message}`);
    }
  }
  if (firstSuccess) return firstSuccess;
  throw new Error(`无法读取 3x-ui 入站列表，已尝试：${errors.join(' | ') || '无详细错误'}`);
}

async function xuiClientExists(server, email) {
  const detail = await getXuiClientDetail(server, email);
  return Boolean(detail.exists);
}

async function getXuiClientDetail(server, email) {
  try {
    const result = await xuiRequest(server, withApiPrefix(server, `/panel/api/clients/get/${encodeURIComponent(email)}`), { method: 'GET' });
    const explicitObj = parseMaybeJson(result.data?.obj) ?? result.data?.obj;
    if (Object.prototype.hasOwnProperty.call(result.data || {}, 'obj') && !explicitObj) return { exists: false, client: null, inboundIds: [], raw: result.data };
    const object = explicitObj && typeof explicitObj === 'object' ? explicitObj : xuiObject(result.data);
    const stat = object.clientStats || object.client_stat || object.stat || object.stats || {};
    const client = { ...(stat && typeof stat === 'object' ? stat : {}), ...(object.client || object) };
    const inboundIds = inboundIdsOfClient(object).length ? inboundIdsOfClient(object) : inboundIdsOfClient(client);
    if (object && Object.keys(object).length && clientEmailOf(client)) return { exists: true, client, inboundIds, raw: result.data };
    return { exists: false, client: null, inboundIds: [], raw: result.data };
  } catch (error) {
    if (/record not found|not found|404/i.test(error.message)) return { exists: false, client: null, inboundIds: [] };
    throw error;
  }
}

function clientEmailOf(client) {
  return String(client?.email || client?.clientEmail || client?.name || '').trim();
}

function clientRemarkOf(client) {
  return String(client?.remark || client?.comment || client?.desc || client?.description || client?.groupName || client?.group_name || '').trim();
}

function clientNameOf(client, email) {
  const value = clientRemarkOf(client) || String(client?.name || client?.username || '').trim();
  return value && value !== email ? value : email;
}

function clientUuidOf(client) {
  const values = [client?.uuid, client?.password, client?.id];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || /^\d+$/.test(text)) continue;
    return text;
  }
  return '';
}

function clientSubIdOf(client) {
  return String(client?.subId || client?.sub_id || client?.sid || '').trim();
}

function clientIdentifierValues(client, extra = []) {
  const values = [
    clientUuidOf(client),
    client?.uuid,
    client?.password,
    client?.id,
    clientEmailOf(client),
    client?.clientEmail,
    clientSubIdOf(client),
    client?.name,
    client?.username,
    ...extra
  ];
  const seen = new Set();
  return values
    .map((value) => String(value || '').trim())
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function clientMatchesTarget(client, target = {}) {
  const expected = clientIdentifierValues({}, [
    target.email,
    target.clientEmail,
    target.clientId,
    target.clientUuid,
    target.uuid,
    target.subId,
    clientUuidOf(target.detailClient || {}),
    clientEmailOf(target.detailClient || {}),
    clientSubIdOf(target.detailClient || {})
  ]).map((value) => value.toLowerCase());
  if (!expected.length) return false;
  const actual = clientIdentifierValues(client).map((value) => value.toLowerCase());
  return actual.some((value) => expected.includes(value));
}

function inboundIdsOfClient(client, fallbackInboundId = '') {
  const raw = client?.inboundIds || client?.inbound_ids || client?.inbounds || client?.inboundId || client?.inbound_id || fallbackInboundId;
  const parsed = parseMaybeJson(raw);
  const values = Array.isArray(parsed) ? parsed : Array.isArray(raw) ? raw : String(raw || '').split(',');
  return values
    .map((value) => Number(value?.id ?? value?.inboundId ?? value?.inbound_id ?? value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function expiryIsoFromClient(client) {
  const value = Number(client?.expiryTime || client?.expiry_time || client?.expire || 0);
  if (!Number.isFinite(value) || value <= 0) return '';
  const ms = value > 10_000_000_000 ? value : value * 1000;
  return new Date(ms).toISOString();
}

function trafficGbFromClient(client) {
  const bytes = Number(client?.totalGB || client?.total || client?.totalBytes || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round((bytes / 1024 / 1024 / 1024) * 100) / 100;
}

function clientTrafficLimitBytes(client) {
  const value = Number(client?.totalGB || client?.total || client?.totalBytes || client?.limitBytes || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function clientTrafficUsedBytes(client) {
  const direct = [client?.used, client?.usedTraffic, client?.usedTrafficBytes, client?.usedBytes, client?.totalUsed];
  for (const value of direct) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  const sum = Number(client?.up || 0) + Number(client?.down || 0);
  if (Number.isFinite(sum) && sum > 0) return sum;
  const stats = client?.clientStats || client?.stat || client?.stats || client?.traffic || {};
  if (stats && typeof stats === 'object' && stats !== client) return clientTrafficUsedBytes(stats);
  return 0;
}

function clientTrafficExceeded(client) {
  const limit = clientTrafficLimitBytes(client);
  if (!limit) return false;
  return clientTrafficUsedBytes(client) >= limit;
}

function autoDisabledReason(reason) {
  return ['expired', 'traffic_exceeded'].includes(String(reason || '').trim());
}

function inboundSettingsOf(inbound) {
  const parsed = parseMaybeJson(inbound?.settings);
  return parsed && typeof parsed === 'object' ? parsed : inbound?.settings && typeof inbound.settings === 'object' ? inbound.settings : {};
}

function clientsFromInbound(inbound) {
  const settings = inboundSettingsOf(inbound);
  const clients = Array.isArray(settings.clients) ? settings.clients : Array.isArray(inbound?.clients) ? inbound.clients : [];
  const stats = Array.isArray(inbound?.clientStats) ? inbound.clientStats : Array.isArray(inbound?.client_stats) ? inbound.client_stats : [];
  const statsByEmail = new Map(stats.map((stat) => [clientEmailOf(stat), stat]).filter(([email]) => email));
  const inboundId = inboundIdOf(inbound);
  return clients.map((client) => ({
    client: { ...(statsByEmail.get(clientEmailOf(client)) || {}), ...client, protocol: inbound?.protocol || client.protocol },
    inboundIds: inboundId ? [inboundId] : [],
    inbound
  }));
}

function importAssociationKey(email, inboundId) {
  return `${String(email || '').trim()}::${String(inboundId || '').trim() || 'unbound'}`;
}

function firstInboundIdOfImportItem(item) {
  const inboundIds = inboundIdsOfClient(item, item?.inboundId || item?.inbound_id);
  return inboundIds[0] ? String(inboundIds[0]) : '';
}

function clientIndexesFromInbounds(inbounds) {
  const byEmail = new Map();
  const byEmailInbound = new Map();
  const items = [];
  for (const item of (inbounds || []).flatMap(clientsFromInbound)) {
    const email = clientEmailOf(item.client);
    const inboundId = firstInboundIdOfImportItem(item);
    if (!email) continue;
    items.push(item);
    if (!byEmail.has(email)) byEmail.set(email, item);
    if (inboundId) byEmailInbound.set(importAssociationKey(email, inboundId), item);
  }
  return { byEmail, byEmailInbound, items };
}

function mergeClientObjects(base = {}, overlay = {}) {
  const merged = { ...base, ...overlay };
  const baseId = String(base.id || '').trim();
  const overlayId = String(overlay.id || '').trim();
  if (baseId && overlayId && /^\\d+$/.test(overlayId) && !/^\\d+$/.test(baseId)) merged.id = base.id;
  return merged;
}

function mergeClientImportItem(item, indexed) {
  if (!indexed) return item;
  const client = mergeClientObjects(indexed.client || {}, item.client || item || {});
  const inboundIds = inboundIdsOfClient(item).length ? inboundIdsOfClient(item) : inboundIdsOfClient(indexed);
  return {
    ...indexed,
    ...item,
    client,
    inboundIds,
    inbound: item.inbound || indexed.inbound
  };
}

function mergeInboundDetail(summary = {}, detail = {}) {
  if (!detail || !Object.keys(detail).length) return summary;
  return {
    ...summary,
    ...detail,
    settings: detail.settings ?? summary.settings,
    streamSettings: detail.streamSettings ?? summary.streamSettings,
    sniffing: detail.sniffing ?? summary.sniffing
  };
}

function expandClientImportItems(items) {
  return items.flatMap((item) => {
    const inboundIds = inboundIdsOfClient(item, item?.inboundId || item?.inbound_id);
    if (inboundIds.length <= 1) return [item];
    return inboundIds.map((inboundId) => ({
      ...item,
      inboundId,
      inboundIds: [inboundId]
    }));
  });
}

function indexedClientForImportItem(item, indexes) {
  const email = clientEmailOf(item.client || item);
  const inboundId = firstInboundIdOfImportItem(item);
  return indexes.byEmailInbound.get(importAssociationKey(email, inboundId)) || indexes.byEmail.get(email);
}

function stringList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  if (value === undefined || value === null || value === '') return [];
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function firstSocksServer(outbound) {
  const settings = parseMaybeJson(outbound?.settings) || outbound?.settings || {};
  const servers = settings?.servers;
  return Array.isArray(servers) && servers.length ? servers[0] : null;
}

function socksUserOf(server) {
  const users = server?.users;
  return Array.isArray(users) && users.length ? users[0] : {};
}

function socksInputFromOutbound(outbound) {
  const server = firstSocksServer(outbound);
  if (!server?.address || !server?.port || !outbound?.tag) return null;
  const user = socksUserOf(server);
  return {
    name: outbound.tag,
    tag: outbound.tag,
    address: server.address,
    port: server.port,
    username: user.user || user.username || '',
    password: user.pass || user.password || '',
    status: 'enabled',
    remark: '从 3-xui Xray 出站同步导入'
  };
}

function upsertSocksNodesFromXray(db, config) {
  const outbounds = Array.isArray(config?.outbounds) ? config.outbounds : [];
  let created = 0;
  let updated = 0;
  const tagToSocksId = new Map();
  for (const outbound of outbounds) {
    if (String(outbound?.protocol || '').toLowerCase() !== 'socks') continue;
    const input = socksInputFromOutbound(outbound);
    if (!input) continue;
    const index = db.socksNodes.findIndex((node) => node.tag === input.tag);
    if (index >= 0) {
      db.socksNodes[index] = normalizeSocks(input, db.socksNodes[index]);
      tagToSocksId.set(input.tag, db.socksNodes[index].id);
      updated += 1;
    } else {
      const node = normalizeSocks(input);
      db.socksNodes.push(node);
      tagToSocksId.set(input.tag, node.id);
      created += 1;
    }
  }
  return { created, updated, tagToSocksId };
}

function inboundContext(inbounds) {
  const byId = new Map();
  const tagToId = new Map();
  for (const inbound of inbounds || []) {
    const inboundId = inboundIdOf(inbound);
    const tag = inboundTagOf(inbound);
    if (inboundId) byId.set(inboundId, inbound);
    if (tag && inboundId) tagToId.set(tag, inboundId);
  }
  return { byId, tagToId };
}

function resolveSocksNodeIdForClient(item, client, context) {
  const email = clientEmailOf(client);
  const inboundIds = inboundIdsOfClient(item, item.inboundId || item.inbound_id);
  const inboundTags = new Set(inboundIds.map((inboundId) => inboundTagOf(context.inboundsById?.get(inboundId))).filter(Boolean));
  const rules = Array.isArray(context.xrayConfig?.routing?.rules) ? context.xrayConfig.routing.rules : [];
  for (const rule of rules) {
    if (!rule || rule.enabled === false || !context.tagToSocksId.has(rule.outboundTag)) continue;
    const users = stringList(rule.user);
    if (users.includes(email)) return context.tagToSocksId.get(rule.outboundTag);
  }
  for (const rule of rules) {
    if (!rule || rule.enabled === false || !context.tagToSocksId.has(rule.outboundTag)) continue;
    const ruleInboundTags = stringList(rule.inboundTag);
    if (ruleInboundTags.some((tag) => inboundTags.has(tag))) return context.tagToSocksId.get(rule.outboundTag);
  }
  return '';
}

async function listXuiInboundsFull(server) {
  const endpoints = uniqueRoutes([
    server.listInboundsEndpoint ? { endpoint: server.listInboundsEndpoint } : null,
    { endpoint: withApiPrefix(server, '/panel/api/inbounds/list') },
    { endpoint: withApiPrefix(server, '/panel/api/inbounds/list/slim') },
    { endpoint: withApiPrefix(server, '/panel/api/inbounds/options') }
  ].filter(Boolean));
  const errors = [];
  for (const route of endpoints) {
    try {
      const result = await xuiRequest(server, route.endpoint, { method: 'GET' });
      const items = xuiArray(result.data);
      return { endpoint: route.endpoint, items, raw: result.data };
    } catch (error) {
      errors.push(`${route.endpoint}: ${error.message}`);
    }
  }
  throw new Error(`无法读取 3x-ui 入站列表，已尝试：${errors.join(' | ') || '无详细错误'}`);
}

async function listXuiClients(server) {
  const endpoints = uniqueRoutes([
    { endpoint: withApiPrefix(server, '/panel/api/clients/list') }
  ]);
  const errors = [];
  for (const route of endpoints) {
    try {
      const result = await xuiRequest(server, route.endpoint, { method: 'GET' });
      const rows = xuiArray(result.data);
      if (rows.length) {
        return {
          endpoint: route.endpoint,
          items: rows.map((row) => ({ client: row.client || row, inboundIds: inboundIdsOfClient(row), raw: row })),
          raw: result.data
        };
      }
    } catch (error) {
      errors.push(`${route.endpoint}: ${error.message}`);
    }
  }
  const inbounds = await listXuiInboundsFull(server);
  return { endpoint: inbounds.endpoint, items: inbounds.items.flatMap(clientsFromInbound), raw: inbounds.raw, warnings: errors };
}

function customerFromXuiClient(server, item, context = {}) {
  const client = item.client || item;
  const email = clientEmailOf(client);
  const inboundIds = inboundIdsOfClient(item, item.inboundId || item.inbound_id);
  const inbound = context.inboundsById?.get(inboundIds[0]) || item.inbound || {};
  const socksNodeId = resolveSocksNodeIdForClient(item, client, context);
  const remark = clientRemarkOf(client);
  const tlsCertPaths = inboundTlsCertPathsOf(inbound);
  return {
    id: id('cus'),
    name: clientNameOf(client, email),
    contact: '',
    packageName: String(client.groupName || client.group_name || client.packageName || '3-xui 导入').trim() || '3-xui 导入',
    amount: 0,
    expireAt: expiryIsoFromClient(client),
    trafficLimitGb: trafficGbFromClient(client),
    status: client.enable === false ? 'disabled' : 'active',
    xuiServerId: server.id,
    inboundId: inboundIds[0] ? String(inboundIds[0]) : '',
    autoCreateInbound: false,
    inboundPort: inboundPortOf(inbound) ? String(inboundPortOf(inbound)) : '',
    inboundRemark: inbound?.remark || '',
    inboundTemplate: inboundTemplateOf(inbound),
    inboundSni: inboundSniOf(inbound),
    inboundHost: inboundHostOf(inbound),
    inboundPath: inboundPathOf(inbound),
    inboundGrpcServiceName: inboundGrpcServiceNameOf(inbound),
    inboundCertFile: tlsCertPaths.certFile,
    inboundKeyFile: tlsCertPaths.keyFile,
    clientId: String(client.subId || client.sub_id || email).trim(),
    clientEmail: email,
    clientUuid: clientUuidOf(client) || crypto.randomUUID(),
    protocol: String(client.protocol || inbound?.protocol || 'vless').trim() || 'vless',
    useSocks: Boolean(socksNodeId),
    socksNodeId,
    remark: remark || '从 3-xui 同步导入',
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

async function importCustomersFromXui(db, serverId) {
  const server = db.xuiServers.find((item) => item.id === serverId);
  if (!server) throw new Error('3x-ui 节点不存在');
  const inbounds = await listXuiInboundsFull(server);
  const detailedInbounds = [];
  const detailWarnings = [];
  for (const inbound of inbounds.items) {
    const inboundId = inboundIdOf(inbound);
    if (!inboundId) {
      detailedInbounds.push(inbound);
      continue;
    }
    try {
      const detail = await getXuiInboundById(server, inboundId);
      detailedInbounds.push(mergeInboundDetail(inbound, detail || {}));
    } catch (error) {
      detailWarnings.push(`${inboundId}: ${error.message}`);
      detailedInbounds.push(inbound);
    }
  }
  inbounds.items = detailedInbounds;
  const serverDefaultsUpdated = applyDetectedTlsDefaultsFromInbounds(server, inbounds.items);
  let xrayConfig = { outbounds: [], routing: { rules: [] } };
  let xrayEndpoint = '';
  let socksImport = { created: 0, updated: 0, tagToSocksId: new Map() };
  try {
    const template = await readXrayTemplate(server);
    xrayConfig = template.config;
    xrayEndpoint = withApiPrefix(server, '/panel/api/xray/');
    socksImport = upsertSocksNodesFromXray(db, xrayConfig);
  } catch (error) {
    xrayConfig = { outbounds: [], routing: { rules: [] } };
    xrayEndpoint = `读取失败：${error.message}`;
  }
  const inboundInfo = inboundContext(inbounds.items);
  const context = {
    xrayConfig,
    tagToSocksId: socksImport.tagToSocksId,
    inboundsById: inboundInfo.byId,
    inboundTagToId: inboundInfo.tagToId
  };
  const remote = await listXuiClients(server);
  const indexedClients = clientIndexesFromInbounds(inbounds.items);
  const remoteItems = expandClientImportItems(remote.items);
  const remoteKeys = new Set(remoteItems.map((item) => {
    const email = clientEmailOf(item.client || item);
    return importAssociationKey(email, firstInboundIdOfImportItem(item));
  }).filter((key) => !key.startsWith('::')));
  for (const item of indexedClients.items) {
    const email = clientEmailOf(item.client || item);
    const key = importAssociationKey(email, firstInboundIdOfImportItem(item));
    if (email && !remoteKeys.has(key)) remoteItems.push(item);
  }
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let socksBound = 0;
  const seen = new Set();
  for (const rawItem of remoteItems) {
    const rawClient = rawItem.client || rawItem;
    const item = mergeClientImportItem(rawItem, indexedClientForImportItem(rawItem, indexedClients));
    const incoming = customerFromXuiClient(server, item, context);
    const associationKey = importAssociationKey(incoming.clientEmail, incoming.inboundId);
    if (!incoming.clientEmail || seen.has(associationKey)) {
      skipped += 1;
      continue;
    }
    seen.add(associationKey);
    if (incoming.useSocks && incoming.socksNodeId) socksBound += 1;
    let index = db.customers.findIndex((customer) => customer.xuiServerId === server.id && customer.clientEmail === incoming.clientEmail && String(customer.inboundId || '') === String(incoming.inboundId || ''));
    if (index < 0) {
      index = db.customers.findIndex((customer) => customer.xuiServerId === server.id && customer.clientEmail === incoming.clientEmail && !customer.inboundId);
    }
    if (index >= 0) {
      db.customers[index] = {
        ...db.customers[index],
        name: incoming.name || db.customers[index].name,
        contact: incoming.contact || db.customers[index].contact,
        packageName: incoming.packageName || db.customers[index].packageName,
        expireAt: incoming.expireAt || db.customers[index].expireAt,
        trafficLimitGb: incoming.trafficLimitGb || db.customers[index].trafficLimitGb,
        status: incoming.status,
        xuiServerId: incoming.xuiServerId || db.customers[index].xuiServerId,
        inboundId: incoming.inboundId || db.customers[index].inboundId,
        inboundPort: incoming.inboundPort || db.customers[index].inboundPort,
        inboundRemark: incoming.inboundRemark || db.customers[index].inboundRemark,
        inboundTemplate: incoming.inboundTemplate || db.customers[index].inboundTemplate,
        inboundSni: incoming.inboundSni || db.customers[index].inboundSni,
        inboundHost: incoming.inboundHost || db.customers[index].inboundHost,
        inboundPath: incoming.inboundPath || db.customers[index].inboundPath,
        inboundGrpcServiceName: incoming.inboundGrpcServiceName || db.customers[index].inboundGrpcServiceName,
        inboundCertFile: incoming.inboundCertFile || db.customers[index].inboundCertFile,
        inboundKeyFile: incoming.inboundKeyFile || db.customers[index].inboundKeyFile,
        clientId: incoming.clientId || db.customers[index].clientId,
        clientEmail: incoming.clientEmail || db.customers[index].clientEmail,
        clientUuid: incoming.clientUuid || db.customers[index].clientUuid,
        protocol: incoming.protocol || db.customers[index].protocol,
        useSocks: incoming.useSocks,
        socksNodeId: incoming.useSocks ? incoming.socksNodeId : '',
        remark: incoming.remark || db.customers[index].remark,
        updatedAt: nowIso()
      };
      updated += 1;
    } else {
      db.customers.push(incoming);
      created += 1;
    }
  }
  addLog(db, server.id, 'import', 'success', `已从 3-xui 同步用户：新增 ${created}，更新 ${updated}，跳过 ${skipped}，绑定 SOCKS ${socksBound}`, {
    endpoint: remote.endpoint,
    xrayEndpoint,
    socksCreated: socksImport.created,
    socksUpdated: socksImport.updated,
    serverDefaultsUpdated,
    defaultInboundCertFile: server.defaultInboundCertFile || '',
    defaultInboundKeyFile: server.defaultInboundKeyFile || '',
    detailWarnings
  });
  return {
    endpoint: remote.endpoint,
    xrayEndpoint,
    total: remoteItems.length,
    created,
    updated,
    skipped,
    socksBound,
    socksCreated: socksImport.created,
    socksUpdated: socksImport.updated,
    serverDefaultsUpdated,
    defaultInboundCertFile: server.defaultInboundCertFile || '',
    defaultInboundKeyFile: server.defaultInboundKeyFile || '',
    detailWarnings
  };
}

async function syncServiceNodesFromXui(db, serverId) {
  const server = db.xuiServers.find((item) => item.id === serverId);
  if (!server) {
    const error = new Error('面板节点不存在');
    error.statusCode = 404;
    throw error;
  }
  const inbounds = await listXuiInboundsFull(server);
  const serverDefaultsUpdated = applyDetectedTlsDefaultsFromInbounds(server, inbounds.items);
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const changedNodes = [];
  const seen = new Set();
  for (const inbound of inbounds.items) {
    const inboundId = inboundIdOf(inbound);
    if (!Number.isInteger(inboundId) || inboundId <= 0 || seen.has(inboundId)) {
      skipped += 1;
      continue;
    }
    seen.add(inboundId);
    const existingIndex = db.serviceNodes.findIndex((node) => node.xuiServerId === server.id && String(node.inboundId || '') === String(inboundId));
    const existing = existingIndex >= 0 ? db.serviceNodes[existingIndex] : null;
    const tlsPaths = inboundTlsCertPathsOf(inbound);
    const inboundName = String(inbound?.remark || inbound?.tag || inbound?.name || inboundLabel(inbound) || `入站 ${inboundId}`).trim();
    const node = normalizeServiceNode({
      id: existing?.id,
      name: existing?.name || inboundName,
      xuiServerId: server.id,
      inboundId: String(inboundId),
      autoCreateInbound: false,
      inboundPort: inboundPortOf(inbound) ? String(inboundPortOf(inbound)) : existing?.inboundPort || '',
      inboundRemark: String(inbound?.remark || existing?.inboundRemark || '').trim(),
      inboundTemplate: inboundTemplateOf(inbound),
      inboundSni: inboundSniOf(inbound) || existing?.inboundSni || '',
      inboundHost: inboundHostOf(inbound) || existing?.inboundHost || '',
      inboundPath: inboundPathOf(inbound) || existing?.inboundPath || '',
      inboundGrpcServiceName: inboundGrpcServiceNameOf(inbound) || existing?.inboundGrpcServiceName || '',
      inboundCertFile: tlsPaths.certFile || existing?.inboundCertFile || '',
      inboundKeyFile: tlsPaths.keyFile || existing?.inboundKeyFile || '',
      amount: existing?.amount ?? 0,
      trafficLimitGb: existing?.trafficLimitGb ?? 100,
      useSocks: existing?.useSocks ?? false,
      socksNodeId: existing?.socksNodeId || '',
      status: existing?.status || 'enabled',
      remark: existing?.remark || ''
    }, existing || {});
    validateServiceNode(node);
    if (existingIndex >= 0) {
      db.serviceNodes[existingIndex] = node;
      updated += 1;
    } else {
      db.serviceNodes.push(node);
      created += 1;
    }
    changedNodes.push(node);
  }
  const log = {
    id: id('log'),
    customerId: server.id,
    type: 'service_node_sync',
    status: 'success',
    message: `已同步服务节点：新增 ${created}，更新 ${updated}，跳过 ${skipped}`,
    detail: {
      endpoint: inbounds.endpoint,
      total: inbounds.items.length,
      created,
      updated,
      skipped,
      serverDefaultsUpdated,
      defaultInboundCertFile: server.defaultInboundCertFile || '',
      defaultInboundKeyFile: server.defaultInboundKeyFile || ''
    },
    createdAt: nowIso()
  };
  db.syncLogs.push(log);
  if (db.syncLogs.length > 1000) db.syncLogs = db.syncLogs.slice(-1000);
  await mysqlTransaction(async (connection) => {
    if (serverDefaultsUpdated) await upsertMysqlServerRow(connection, server);
    for (const node of changedNodes) await upsertMysqlServiceNodeRow(connection, node);
    await insertMysqlLog(connection, log);
  });
  return log.detail;
}

async function createXuiInbound(server, customer, currentInbounds) {
  const port = pickInboundPort(currentInbounds.items, customer.inboundPort);
  const realityKeys = customer.inboundTemplate === 'vless-reality' ? await getRealityKeyPair(server) : null;
  const payload = buildDefaultInbound(customer, port, { realityKeys });
  const endpoint = withApiPrefix(server, '/panel/api/inbounds/add');
  const result = await xuiRequest(server, endpoint, { method: 'POST', body: payload });
  const refreshed = await listXuiInbounds(server);
  const created = refreshed.items.find((item) => inboundPortOf(item) === port);
  const inboundId = inboundIdOf(created);
  if (!Number.isInteger(inboundId) || inboundId <= 0) {
    throw new Error(`已创建端口 ${port} 的入站，但没有读取到新入站 ID，请在 3x-ui 后台确认后手动填写`);
  }
  customer.inboundId = String(inboundId);
  customer.inboundPort = String(port);
  customer.inboundRemark = payload.remark;
  return { endpoint, inboundId, port, remark: payload.remark, template: customer.inboundTemplate || 'vless-tcp', result: result.data };
}

async function syncClientToXui(db, customer, action = 'upsert') {
  ensureCustomerIdentity(customer);
  const server = db.xuiServers.find((item) => item.id === customer.xuiServerId);
  if (!server) throw new Error('用户绑定的 3x-ui 节点不存在，请重新选择节点');
  applyServerDefaultTlsPaths(customer, server);
  if (action === 'disable' && !customer.inboundId) {
    return { action: 'skip', skipped: true, reason: 'missing-inbound-id', inboundIds: [], clientEmail: customer.clientEmail };
  }

  validateCustomerBinding(customer);

  const inbounds = await listXuiInbounds(server);
  let createdInbound = null;
  if (!customer.inboundId && customer.autoCreateInbound) {
    createdInbound = await createXuiInbound(server, customer, inbounds);
  } else if (!inbounds.items.length) {
    throw new Error(`3x-ui 节点连接成功，但没有读取到入站。请先在 3x-ui 创建入站，或检查 API Token 权限。接口：${inbounds.endpoint}`);
  }

  const inboundId = Number(customer.inboundId);
  const checkedInbounds = createdInbound ? await listXuiInbounds(server) : inbounds;
  const inboundExists = checkedInbounds.items.some((item) => inboundIdOf(item) === inboundId);
  if (!inboundExists) {
    const knownIds = checkedInbounds.items.map(inboundLabel).join(', ') || '无';
    throw new Error(`这个 3x-ui 节点没有入站 ID ${inboundId}。可用 ID：${knownIds}`);
  }

  const client = {
    id: customer.clientUuid,
    uuid: customer.clientUuid,
    email: customer.clientEmail,
    enable: customer.status !== 'disabled' && action !== 'disable',
    expiryTime: expiryMs(customer.expireAt),
    totalGB: gbToBytes(customer.trafficLimitGb),
    limitIp: 0,
    flow: '',
    tgId: 0,
    subId: customer.clientId || customer.clientEmail,
    reset: customer.resetTraffic ? 1 : 0
  };

  const clientDetail = await getXuiClientDetail(server, customer.clientEmail);
  const inboundIds = [...new Set([...clientDetail.inboundIds, inboundId])];
  const slimClient = {
    email: client.email,
    enable: client.enable,
    expiryTime: client.expiryTime,
    totalGB: client.totalGB,
    limitIp: client.limitIp,
    flow: client.flow,
    tgId: client.tgId,
    subId: client.subId,
    reset: client.reset
  };
  const payload = { client, inboundIds };
  const slimPayload = { client: slimClient, inboundIds };
  const updatePayload = { ...client, inboundIds };
  const email = encodeURIComponent(customer.clientEmail);
  const exists = Boolean(clientDetail.exists);

  const updateRoutes = [
    server.updateClientEndpoint ? { endpoint: server.updateClientEndpoint.replace('{clientId}', email).replace('{email}', email), body: updatePayload } : null,
    { endpoint: withApiPrefix(server, `/panel/api/clients/update/${email}`), body: updatePayload },
    { endpoint: withApiPrefix(server, `/panel/api/clients/update/${email}`), body: client }
  ];
  const addRoutes = [
    server.addClientEndpoint ? { endpoint: server.addClientEndpoint, body: payload } : null,
    { endpoint: withApiPrefix(server, '/panel/api/clients/add'), body: payload },
    server.addClientEndpoint ? { endpoint: server.addClientEndpoint, body: slimPayload } : null,
    { endpoint: withApiPrefix(server, '/panel/api/clients/add'), body: slimPayload }
  ];
  const paths = uniqueRoutes((exists ? updateRoutes : addRoutes).filter(Boolean));

  let lastError;
  const errors = [];
  for (const route of paths) {
    try {
      const result = await xuiRequest(server, route.endpoint, { method: 'POST', body: route.body });
      const resetTrafficResult = customer.resetTraffic && action !== 'disable'
        ? await resetXuiClientTraffic(server, customer.clientEmail)
        : null;
      return { action: exists ? 'update' : 'add', endpoint: route.endpoint, inboundIds, clientEmail: customer.clientEmail, createdInbound, resetTrafficResult, result: result.data };
    } catch (error) {
      lastError = error;
      errors.push(`${route.endpoint}: ${error.message}`);
    }
  }
  throw new Error(`同步用户到 3x-ui 失败，已尝试：${errors.join(' | ') || lastError?.message || '无详细错误'}`);
}

async function resetXuiClientTraffic(server, email) {
  if (!email) return { skipped: true, reason: 'missing-email' };
  const encoded = encodeURIComponent(email);
  const endpoint = withApiPrefix(server, `/panel/api/clients/resetTraffic/${encoded}`);
  const result = await xuiRequest(server, endpoint, { method: 'POST' });
  return { reset: true, endpoint, clientEmail: email, result: result.data };
}

async function syncSocksToXui(db, customer) {
  const server = db.xuiServers.find((item) => item.id === customer.xuiServerId);
  if (!server) throw new Error('用户绑定的 3x-ui 节点不存在，请重新选择节点');
  const socks = db.socksNodes.find((item) => item.id === customer.socksNodeId);
  if (customer.useSocks && customer.socksNodeId && !socks) throw new Error('用户绑定的 SOCKS 节点不存在，请重新选择 SOCKS 出站');
  if (socks && socks.status === 'disabled') throw new Error('绑定的 SOCKS 节点已停用，请启用 SOCKS 节点或取消用户中转');

  const template = await readXrayTemplate(server);
  const config = template.config;
  config.outbounds = Array.isArray(config.outbounds) ? config.outbounds : [];
  config.routing = config.routing && typeof config.routing === 'object' ? config.routing : {};
  config.routing.rules = Array.isArray(config.routing.rules) ? config.routing.rules : [];

  const managedTags = new Set(db.socksNodes.map((item) => item.tag).filter(Boolean));
  const inbounds = await listXuiInbounds(server);
  const boundInbound = inbounds.items.find((item) => inboundIdOf(item) === Number(customer.inboundId));
  const inboundTag = inboundTagOf(boundInbound);
  const oldRuleCount = config.routing.rules.length;
  config.routing.rules = config.routing.rules.filter((rule) => !isManagedSocksRule(rule, customer.clientEmail, inboundTag, managedTags, {
    allowInboundTagFallback: Boolean(customer.useSocks || customer.socksNodeId)
  }));
  const removedRules = oldRuleCount - config.routing.rules.length;

  if (!customer.useSocks || !customer.socksNodeId || customer.status === 'disabled') {
    const saveResult = removedRules ? await saveXrayTemplate(server, config, template.outboundTestUrl) : { skipped: true };
    const restartResult = removedRules ? await restartXray(server) : { skipped: true };
    return { skipped: true, reason: customer.status === 'disabled' ? '用户已停用，已移除 SOCKS 路由' : '未启用 SOCKS 中转', removedRules, saveResult, restartResult };
  }

  const outbound = buildSocksOutbound(socks);
  const index = config.outbounds.findIndex((item) => item?.tag === socks.tag);
  if (index >= 0) config.outbounds[index] = outbound;
  else config.outbounds.push(outbound);

  const rule = {
    type: 'field',
    enabled: true,
    outboundTag: socks.tag,
    user: [customer.clientEmail]
  };
  if (inboundTag) rule.inboundTag = [inboundTag];
  config.routing.rules.unshift(rule);

  const saveResult = await saveXrayTemplate(server, config, template.outboundTestUrl);
  const restartResult = await restartXray(server);
  return { applied: true, outboundTag: socks.tag, inboundTag, rule, removedRules, saveResult, restartResult };
}

async function deleteXuiClient(server, email) {
  if (!email) return { skipped: true, reason: '没有客户端邮箱' };
  const encoded = encodeURIComponent(email);
  const routes = uniqueRoutes([
    { endpoint: withApiPrefix(server, `/panel/api/clients/del/${encoded}`), method: 'POST' },
    { endpoint: withApiPrefix(server, `/panel/api/clients/del/${encoded}`), method: 'DELETE' }
  ]);
  const errors = [];
  let missing = null;
  for (const route of routes) {
    try {
      const result = await xuiRequest(server, route.endpoint, { method: route.method });
      return { deleted: true, endpoint: route.endpoint, method: route.method, result: result.data };
    } catch (error) {
      if (/record not found|not found|404/i.test(error.message)) {
        missing = { deleted: false, missing: true, endpoint: route.endpoint, method: route.method };
        continue;
      }
      errors.push(`${route.method} ${route.endpoint}: ${error.message}`);
    }
  }
  if (missing && !errors.length) return missing;
  throw new Error(`删除 3-xui client 失败，已尝试：${errors.join(' | ') || '无详细错误'}`);
}

async function deleteXuiClientVerified(server, email) {
  const result = await deleteXuiClient(server, email);
  if (!result?.deleted) return result;
  const detail = await getXuiClientDetail(server, email);
  if (!detail.exists) return { ...result, verified: true };
  return { ...result, verified: false, stillExists: true, detail: detail.raw };
}

async function deleteAllInboundClients(server, inboundId) {
  const idValue = Number(inboundId);
  if (!Number.isInteger(idValue) || idValue <= 0) return { skipped: true, reason: '无效的入站 ID' };
  const routes = uniqueRoutes([
    { endpoint: withApiPrefix(server, `/panel/api/inbounds/${idValue}/delAllClients`), method: 'POST' }
  ]);
  const errors = [];
  for (const route of routes) {
    try {
      const result = await xuiRequest(server, route.endpoint, { method: route.method });
      const inbound = await getXuiInboundById(server, idValue);
      if (!inbound || !clientsFromInbound(inbound).length) return { deleted: true, endpoint: route.endpoint, method: route.method, result: result.data };
      errors.push(`${route.method} ${route.endpoint}: API returned success but clients still exist`);
    } catch (error) {
      errors.push(`${route.method} ${route.endpoint}: ${error.message}`);
    }
  }
  throw new Error(`Delete all inbound clients failed: ${errors.join(' | ') || 'no detail'}`);
}

function clientStillInInbound(inbound, target) {
  return clientsFromInbound(inbound).some((item) => clientMatchesTarget(item.client, target));
}

function shouldTryInboundClientDelete(inbound, target) {
  const clients = clientsFromInbound(inbound || {});
  if (!clients.length) return false;
  return clients.some((item) => clientMatchesTarget(item.client, target)) || clients.length === 1;
}

function clientPreview(client) {
  if (!client || !Object.keys(client).length) return null;
  return {
    email: clientEmailOf(client),
    uuid: clientUuidOf(client),
    subId: clientSubIdOf(client)
  };
}

async function getXuiInboundById(server, inboundId) {
  const idValue = Number(inboundId);
  if (!Number.isInteger(idValue) || idValue <= 0) return null;
  try {
    const result = await xuiRequest(server, withApiPrefix(server, `/panel/api/inbounds/get/${idValue}`), { method: 'GET' });
    const object = xuiObject(result.data);
    return object && Object.keys(object).length ? object : null;
  } catch (error) {
    if (/record not found|not found|404/i.test(error.message)) return null;
    throw error;
  }
}

async function deleteInboundClientLegacy(server, target, inboundId) {
  const idValue = Number(inboundId);
  const email = String(target?.email || target?.clientEmail || '').trim();
  if (!email || !Number.isInteger(idValue) || idValue <= 0) return { skipped: true, reason: '缺少客户端邮箱或入站 ID' };
  let inbound = await getXuiInboundById(server, idValue);
  if (!inbound) {
    const inbounds = await listXuiInboundsFull(server);
    inbound = inbounds.items.find((item) => inboundIdOf(item) === idValue);
  }
  const inboundClients = clientsFromInbound(inbound || {});
  let matchedBy = '字段匹配';
  let clientItem = inboundClients.find((item) => clientMatchesTarget(item.client, target));
  if (!clientItem && inboundClients.length === 1) {
    clientItem = inboundClients[0];
    matchedBy = '入站唯一客户端兜底';
  }
  const client = clientItem?.client || {};
  const actualTarget = clientItem ? { ...target, detailClient: client, email: clientEmailOf(client) || email } : target;
  const identifiers = clientIdentifierValues(client, [
    target.clientUuid,
    target.clientId,
    target.subId,
    email
  ]).filter((value) => !/^\d+$/.test(value) || String(client?.id || '').trim() === value);
  const routes = uniqueRoutes(identifiers.flatMap((identifier) => {
    const encoded = encodeURIComponent(identifier);
    return [
      { endpoint: withApiPrefix(server, `/panel/api/inbounds/${idValue}/delClient/${encoded}`), method: 'POST' },
      { endpoint: withApiPrefix(server, `/panel/api/inbounds/delClient/${idValue}/${encoded}`), method: 'POST' },
      { endpoint: withApiPrefix(server, `/panel/api/inbounds/${idValue}/client/${encoded}`), method: 'DELETE' },
      { endpoint: withApiPrefix(server, `/panel/api/clients/del/${encoded}`), method: 'POST' },
      { endpoint: withApiPrefix(server, `/panel/api/clients/del/${encoded}`), method: 'DELETE' }
    ];
  }));
  if (!routes.length) return { skipped: true, reason: '没有可用于删除的客户端标识', matchedBy, resolvedClient: clientPreview(client) };
  const errors = [];
  let missing = null;
  for (const route of routes) {
    try {
      const result = await xuiRequest(server, route.endpoint, { method: route.method });
      const refreshed = await getXuiInboundById(server, idValue);
      if (!refreshed || !clientStillInInbound(refreshed, actualTarget)) {
        return { deleted: true, legacy: true, endpoint: route.endpoint, method: route.method, identifier: route.endpoint.split('/').pop(), matchedBy, resolvedClient: clientPreview(client), result: result.data };
      }
      errors.push(`${route.method} ${route.endpoint}: 接口返回成功，但客户端仍在入站中`);
    } catch (error) {
      if (/record not found|not found|404/i.test(error.message)) {
        missing = { deleted: false, missing: true, endpoint: route.endpoint, method: route.method };
        continue;
      }
      errors.push(`${route.method} ${route.endpoint}: ${error.message}`);
    }
  }
  if (missing && !errors.length) return { ...missing, matchedBy, resolvedClient: clientPreview(client) };
  throw new Error(`旧版入站客户端删除失败，已尝试：${errors.join(' | ') || '无详细错误'}`);
}

async function detachXuiClient(server, customer) {
  const email = String(customer?.clientEmail || customer?.email || '').trim();
  if (!email) return { skipped: true, reason: '没有客户端邮箱' };
  const inboundIds = [Number(customer?.inboundId)].filter((value) => Number.isInteger(value) && value > 0);
  if (!inboundIds.length) return deleteXuiClientVerified(server, email);
  const detail = await getXuiClientDetail(server, email);
  const target = {
    email,
    clientEmail: email,
    clientId: customer?.clientId,
    clientUuid: customer?.clientUuid,
    detailClient: detail.client
  };
  const attachedInboundIds = detail.inboundIds.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0);
  if (!detail.exists || !attachedInboundIds.length || attachedInboundIds.every((value) => inboundIds.includes(value))) {
    const clientResult = await deleteXuiClientVerified(server, email);
    const inbound = await getXuiInboundById(server, inboundIds[0]);
    if (!inbound || !shouldTryInboundClientDelete(inbound, target)) return clientResult;
    const legacyResult = await deleteInboundClientLegacy(server, target, inboundIds[0]);
    return { ...clientResult, verified: false, fallback: legacyResult };
  }
  const encoded = encodeURIComponent(email);
  const routes = uniqueRoutes([
    { endpoint: withApiPrefix(server, `/panel/api/clients/${encoded}/detach`), body: { inboundIds } },
    { endpoint: withApiPrefix(server, `/panel/api/clients/${encoded}/detach`), body: { inbound_ids: inboundIds } }
  ]);
  const errors = [];
  let missing = null;
  for (const route of routes) {
    try {
      const result = await xuiRequest(server, route.endpoint, { method: 'POST', body: route.body });
      const inbound = await getXuiInboundById(server, inboundIds[0]);
      if (!inbound || !shouldTryInboundClientDelete(inbound, target)) return { detached: true, endpoint: route.endpoint, inboundIds, result: result.data };
      const legacyResult = await deleteInboundClientLegacy(server, target, inboundIds[0]);
      return { detached: true, verified: false, endpoint: route.endpoint, inboundIds, result: result.data, fallback: legacyResult };
    } catch (error) {
      if (/record not found|not found|404/i.test(error.message)) {
        missing = { detached: false, missing: true, endpoint: route.endpoint, inboundIds };
        continue;
      }
      errors.push(`${route.endpoint}: ${error.message}`);
    }
  }
  if (missing && !errors.length) {
    const inbound = await getXuiInboundById(server, inboundIds[0]);
    if (inbound && shouldTryInboundClientDelete(inbound, target)) {
      const legacyResult = await deleteInboundClientLegacy(server, target, inboundIds[0]);
      return { ...missing, verified: false, fallback: legacyResult };
    }
    return missing;
  }
  throw new Error(`解绑 3-xui client 入站失败，已尝试：${errors.join(' | ') || '无详细错误'}`);
}

async function deleteXuiInbound(server, inboundId) {
  const idValue = Number(inboundId);
  if (!Number.isInteger(idValue) || idValue <= 0) return { skipped: true, reason: '没有有效入站 ID' };
  const routes = uniqueRoutes([
    { endpoint: withApiPrefix(server, `/panel/api/inbounds/del/${idValue}`), method: 'POST' },
    { endpoint: withApiPrefix(server, `/panel/api/inbounds/del/${idValue}`), method: 'DELETE' }
  ]);
  const errors = [];
  let missing = null;
  for (const route of routes) {
    try {
      const result = await xuiRequest(server, route.endpoint, { method: route.method });
      return { deleted: true, endpoint: route.endpoint, method: route.method, result: result.data };
    } catch (error) {
      if (/record not found|not found|404/i.test(error.message)) {
        missing = { deleted: false, missing: true, endpoint: route.endpoint, method: route.method };
        continue;
      }
      errors.push(`${route.method} ${route.endpoint}: ${error.message}`);
    }
  }
  if (missing && !errors.length) return missing;
  throw new Error(`删除 3-xui 入站失败，已尝试：${errors.join(' | ') || '无详细错误'}`);
}

async function deleteInboundIfEmpty(server, inboundId) {
  const idValue = Number(inboundId);
  if (!Number.isInteger(idValue) || idValue <= 0) return { skipped: true, reason: '没有有效入站 ID' };
  const inbounds = await listXuiInboundsFull(server);
  const inbound = inbounds.items.find((item) => inboundIdOf(item) === idValue);
  if (!inbound) return { skipped: true, missing: true, reason: '入站已经不存在' };
  const clients = clientsFromInbound(inbound);
  if (clients.length) return { skipped: true, reason: `入站仍有 ${clients.length} 个客户端，未删除入站` };
  return deleteXuiInbound(server, idValue);
}

async function deleteCustomerInboundIfOwned(server, customer) {
  const idValue = Number(customer?.inboundId);
  if (!Number.isInteger(idValue) || idValue <= 0) return { skipped: true, reason: '没有有效入站 ID' };
  const inbounds = await listXuiInboundsFull(server);
  const inbound = inbounds.items.find((item) => inboundIdOf(item) === idValue);
  if (!inbound) return { skipped: true, missing: true, reason: '入站已经不存在' };
  const clients = clientsFromInbound(inbound);
  const target = {
    email: customer?.clientEmail,
    clientEmail: customer?.clientEmail,
    clientId: customer?.clientId,
    clientUuid: customer?.clientUuid,
    uuid: customer?.clientUuid
  };
  const matched = clients.filter((item) => clientMatchesTarget(item.client, target));
  if (!clients.length) {
    const result = await deleteXuiInbound(server, idValue);
    return { ...result, reason: '入站已无客户端，已删除' };
  }
  if (clients.length === matched.length && matched.length > 0) {
    let delAllClientsResult = { skipped: true };
    try {
      delAllClientsResult = await deleteAllInboundClients(server, idValue);
    } catch (error) {
      delAllClientsResult = { failed: true, error: error.message };
    }
    const result = await deleteXuiInbound(server, idValue);
    result.delAllClientsResult = delAllClientsResult;
    return { ...result, reason: `入站只包含当前用户 ${matched.length} 个客户端，已删除整个入站`, deletedWithClients: matched.length };
  }
  return {
    skipped: true,
    reason: `入站仍有 ${clients.length} 个客户端，其中匹配当前用户 ${matched.length} 个，为避免误删其他用户未删除入站`,
    clientCount: clients.length,
    matchedClientCount: matched.length
  };
}

function outboundTagStillUsed(db, customer, config, socks) {
  if (!socks?.tag) return true;
  const usedByRules = Array.isArray(config.routing?.rules) && config.routing.rules.some((rule) => rule?.outboundTag === socks.tag);
  if (usedByRules) return true;
  return db.customerNodes.some((binding) => {
    if (binding.id === customer.customerNodeId || binding.status === 'disabled') return false;
    const node = db.serviceNodes.find((item) => item.id === binding.nodeId);
    if (!node || node.status === 'disabled' || !node.useSocks || node.socksNodeId !== socks.id) return false;
    const boundCustomer = db.customers.find((item) => item.id === binding.customerId);
    return boundCustomer && boundCustomer.status !== 'disabled';
  });
}

async function cleanupCustomerSocksFromXui(db, customer, server) {
  if (!customer.useSocks && !customer.socksNodeId) return { skipped: true, reason: '用户没有启用 SOCKS 中转' };
  const socks = db.socksNodes.find((item) => item.id === customer.socksNodeId);
  const managedTags = new Set(db.socksNodes.map((item) => item.tag).filter(Boolean));
  if (!managedTags.size) return { skipped: true, reason: '没有可管理的 SOCKS 出站' };

  const template = await readXrayTemplate(server);
  const config = template.config;
  config.outbounds = Array.isArray(config.outbounds) ? config.outbounds : [];
  config.routing = config.routing && typeof config.routing === 'object' ? config.routing : {};
  config.routing.rules = Array.isArray(config.routing.rules) ? config.routing.rules : [];

  let inboundTag = '';
  try {
    const inbounds = await listXuiInbounds(server);
    const boundInbound = inbounds.items.find((item) => inboundIdOf(item) === Number(customer.inboundId));
    inboundTag = inboundTagOf(boundInbound);
  } catch {
    inboundTag = '';
  }

  const oldRuleCount = config.routing.rules.length;
  config.routing.rules = config.routing.rules.filter((rule) => !isManagedSocksRule(rule, customer.clientEmail, inboundTag, managedTags, {
    allowInboundTagFallback: Boolean(customer.useSocks || customer.socksNodeId)
  }));
  const removedRules = oldRuleCount - config.routing.rules.length;
  let removedOutbounds = 0;
  if (socks?.tag && !outboundTagStillUsed(db, customer, config, socks)) {
    const oldOutboundCount = config.outbounds.length;
    config.outbounds = config.outbounds.filter((outbound) => outbound?.tag !== socks.tag);
    removedOutbounds = oldOutboundCount - config.outbounds.length;
  }

  if (!removedRules && !removedOutbounds) return { skipped: true, removedRules, removedOutbounds };
  const saveResult = await saveXrayTemplate(server, config, template.outboundTestUrl);
  const restartResult = await restartXray(server);
  return { removedRules, removedOutbounds, inboundTag, outboundTag: socks?.tag || '', saveResult, restartResult };
}

async function cleanupCustomerNodeRemoteResources(db, customer, binding) {
  const target = customerSyncTarget(db, customer, binding);
  if (!target?.xuiServerId) return { skipped: true, reason: '用户没有绑定远程节点', warnings: [] };
  const server = db.xuiServers.find((item) => item.id === target.xuiServerId);
  if (!server) return { skipped: true, reason: '用户绑定的远程节点不存在，已跳过远程清理', warnings: ['用户绑定的远程节点不存在'] };

  const warnings = [];
  let socksResult = { skipped: true };
  let clientResult = { skipped: true };
  let inboundResult = { skipped: true };
  let serviceNodeResult = { skipped: true };

  try {
    socksResult = await cleanupCustomerSocksFromXui(db, target, server);
  } catch (error) {
    socksResult = { failed: true, error: error.message };
    warnings.push(`SOCKS 路由清理失败：${error.message}`);
  }

  try {
    clientResult = await detachXuiClient(server, target);
  } catch (error) {
    clientResult = { failed: true, error: error.message };
    warnings.push(`远程客户端删除/解绑失败：${error.message}`);
  }

  try {
    inboundResult = await deleteCustomerInboundIfOwned(server, target);
    serviceNodeResult = await clearRemovedInboundFromServiceNode(db, target.serviceNodeId, inboundResult);
    if (inboundResult?.skipped && !inboundResult?.missing) warnings.push(`远程入站未删除：${inboundResult.reason || '原因未知'}`);
  } catch (error) {
    inboundResult = { failed: true, error: error.message };
    warnings.push(`远程入站删除失败：${error.message}`);
  }

  return { customerNodeId: binding.id, serviceNodeId: binding.nodeId, clientResult, socksResult, inboundResult, serviceNodeResult, warnings };
}

async function cleanupCustomerRemoteResources(db, customer) {
  const bindings = customerNodesFor(db, customer.id);
  if (!bindings.length) return { skipped: true, reason: '用户没有绑定节点', warnings: [] };
  const results = [];
  const warnings = [];
  for (const binding of bindings) {
    try {
      const result = await cleanupCustomerNodeRemoteResources(db, customer, binding);
      results.push(result);
      if (Array.isArray(result.warnings)) warnings.push(...result.warnings);
    } catch (error) {
      const message = `${binding.name || binding.id} 清理失败：${error.message}`;
      warnings.push(message);
      results.push({ customerNodeId: binding.id, failed: true, error: error.message, warnings: [message] });
    }
  }
  return { results, warnings };
}

function buildSocksOutbound(socks) {
  return {
    tag: socks.tag,
    protocol: 'socks',
    settings: {
      servers: [
        {
          address: socks.address,
          port: Number(socks.port),
          users: socks.username ? [{ user: socks.username, pass: decrypt(socks.passwordEnc) }] : []
        }
      ]
    }
  };
}

function isManagedSocksRule(rule, email, inboundTag, managedTags, options = {}) {
  if (!rule) return false;
  const users = stringList(rule.user);
  if (email && users.includes(email)) return true;
  if (!managedTags.has(rule.outboundTag)) return false;
  const inboundTags = stringList(rule.inboundTag);
  return Boolean(options.allowInboundTagFallback && inboundTag && inboundTags.includes(inboundTag));
}

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function extractXrayConfig(data) {
  const root = xuiObject(data);
  const obj = parseMaybeJson(data?.obj) || data?.obj;
  const body = parseMaybeJson(data?.data) || data?.data;
  const result = parseMaybeJson(data?.result) || data?.result;
  const values = [
    root,
    root.xrayConfig,
    root.xrayTemplateConfig,
    root.xrayTemplate,
    root.jsonConfig,
    root.config,
    root.template,
    root.xraySetting,
    root.xraySetting?.xrayConfig,
    root.xraySetting?.xrayTemplateConfig,
    root.xraySetting?.xrayTemplate,
    root.xraySetting?.jsonConfig,
    root.xraySetting?.config,
    root.setting,
    root.setting?.xrayConfig,
    root.setting?.xrayTemplateConfig,
    root.setting?.xrayTemplate,
    root.setting?.jsonConfig,
    root.setting?.config,
    obj?.xraySetting,
    obj?.setting,
    obj?.xrayConfig,
    obj?.xrayTemplateConfig,
    obj?.xrayTemplate,
    obj?.jsonConfig,
    obj?.config,
    obj?.template,
    obj?.xraySetting?.xrayConfig,
    obj?.xraySetting?.xrayTemplateConfig,
    obj?.xraySetting?.xrayTemplate,
    obj?.xraySetting?.jsonConfig,
    obj?.xraySetting?.config,
    body?.xraySetting,
    body?.setting,
    body?.xrayConfig,
    body?.xrayTemplateConfig,
    body?.config,
    result?.xraySetting,
    result?.setting,
    result?.xrayConfig,
    result?.xrayTemplateConfig,
    result?.config
  ];
  for (const value of values) {
    const parsed = parseMaybeJson(value);
    if (parsed && typeof parsed === 'object' && (Array.isArray(parsed.outbounds) || parsed.routing || parsed.inbounds)) return parsed;
  }
  throw new Error('没有从 3-xui 读取到 Xray 配置模板，无法写入 SOCKS 路由');
}

function extractOutboundTestUrl(data) {
  const root = xuiObject(data);
  const obj = parseMaybeJson(data?.obj) || data?.obj;
  return root.outboundTestUrl || root.xrayTestUrl || root.xraySetting?.outboundTestUrl || root.xraySetting?.xrayTestUrl || root.setting?.outboundTestUrl || root.setting?.xrayTestUrl || obj?.outboundTestUrl || obj?.xrayTestUrl || obj?.xraySetting?.outboundTestUrl || obj?.xraySetting?.xrayTestUrl || '';
}

async function readXrayTemplate(server) {
  const result = await xuiRequest(server, withApiPrefix(server, '/panel/api/xray/'), { method: 'POST' });
  return { config: extractXrayConfig(result.data), outboundTestUrl: extractOutboundTestUrl(result.data), raw: result.data };
}

async function xuiFormRequest(server, endpoint, fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) body.set(key, String(value));
  }
  return xuiRequest(server, endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: body.toString()
  });
}

async function saveXrayTemplate(server, config, outboundTestUrl = '') {
  const endpoint = withApiPrefix(server, '/panel/api/xray/update');
  const text = JSON.stringify(config, null, 2);
  const urlFields = outboundTestUrl ? [{ xrayTestUrl: outboundTestUrl }, { outboundTestUrl }] : [{}];
  const configFields = ['xrayTemplateConfig', 'xraySetting', 'xrayConfig', 'jsonConfig', 'config'];
  const attempts = [
    ...urlFields.flatMap((urlField) => configFields.map((field) => ({ [field]: text, ...urlField })))
  ];
  const errors = [];
  for (const fields of attempts) {
    try {
      const result = await xuiFormRequest(server, endpoint, fields);
      return { endpoint, field: Object.keys(fields)[0], result: result.data };
    } catch (error) {
      errors.push(`${Object.keys(fields)[0]}: ${error.message}`);
    }
  }
  throw new Error(`保存 Xray 配置模板失败，已尝试：${errors.join(' | ')}`);
}

async function restartXray(server) {
  try {
    const result = await xuiRequest(server, withApiPrefix(server, '/panel/api/server/restartXrayService'), { method: 'POST' });
    return { endpoint: withApiPrefix(server, '/panel/api/server/restartXrayService'), result: result.data };
  } catch (error) {
    return { warning: `Xray 配置已保存，但重载失败：${error.message}` };
  }
}

function objectKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
}

function xrayTemplateDebug(data) {
  let recognized = false;
  let message = '';
  try {
    const config = extractXrayConfig(data);
    recognized = true;
    message = `已识别，outbounds: ${Array.isArray(config.outbounds) ? config.outbounds.length : 0}`;
  } catch (error) {
    message = error.message;
  }
  const root = xuiObject(data);
  const obj = parseMaybeJson(data?.obj) || data?.obj;
  return {
    recognized,
    message,
    topKeys: objectKeys(data),
    rootKeys: objectKeys(root),
    objKeys: objectKeys(obj),
    xraySettingKeys: objectKeys(root.xraySetting || obj?.xraySetting),
    settingKeys: objectKeys(root.setting || obj?.setting)
  };
}

function addLog(db, customerId, type, status, message, detail = {}) {
  db.syncLogs.push({
    id: id('log'),
    customerId,
    type,
    status,
    message,
    detail,
    createdAt: nowIso()
  });
  if (db.syncLogs.length > 1000) db.syncLogs = db.syncLogs.slice(-1000);
}

function addBalanceLog(db, customer, type, amount, beforeBalance, afterBalance, operator, remark = '', detail = {}) {
  db.balanceLogs ||= [];
  const log = {
    id: id('bal'),
    customerId: customer?.id || '',
    customerName: customer?.name || '',
    type,
    amount: Number(Number(amount || 0).toFixed(2)),
    beforeBalance: Number(Number(beforeBalance || 0).toFixed(2)),
    afterBalance: Number(Number(afterBalance || 0).toFixed(2)),
    operator: String(operator || '').trim(),
    remark: String(remark || '').trim(),
    detail,
    createdAt: nowIso()
  };
  db.balanceLogs.push(log);
  if (db.balanceLogs.length > 2000) db.balanceLogs = db.balanceLogs.slice(-2000);
  return log;
}

function addRenewalLog(db, customer, months, price, beforeExpireAt, afterExpireAt, source, status = 'success', message = '', detail = {}) {
  db.renewalLogs ||= [];
  const log = {
    id: id('ren'),
    customerId: customer?.id || '',
    customerName: customer?.name || '',
    months: Math.max(1, Math.floor(Number(months || 1))),
    price: Number(Number(price || 0).toFixed(2)),
    beforeExpireAt: beforeExpireAt || '',
    afterExpireAt: afterExpireAt || '',
    source,
    status,
    message: String(message || '').trim(),
    detail,
    createdAt: nowIso()
  };
  db.renewalLogs.push(log);
  if (db.renewalLogs.length > 2000) db.renewalLogs = db.renewalLogs.slice(-2000);
  return log;
}

async function routeApi(req, res, url) {
  if (shouldUseWriteLock(req, url.pathname)) {
    return withWriteLock(() => routeApiUnlocked(req, res, url));
  }
  return routeApiUnlocked(req, res, url);
}

async function routeApiUnlocked(req, res, url) {
  if (url.pathname === '/api/setup/status' && req.method === 'GET') {
    return send(res, 200, {
      ok: true,
      installed: !setupRequired,
      storage: setupRequired ? 'unconfigured' : 'mysql',
      adminPath: adminPath()
    });
  }

  if (url.pathname === '/api/setup/install' && req.method === 'POST') {
    if (!setupRequired) return sendError(res, 409, '系统已经完成安装');
    const body = await parseJson(req);
    const mysql = {
      host: String(body.host || '').trim() || '127.0.0.1',
      port: Math.max(1, Math.floor(Number(body.port || 3306))),
      user: String(body.user || '').trim(),
      password: String(body.password || ''),
      database: String(body.database || '').trim(),
      connectionLimit: Math.max(1, Math.min(50, Math.floor(Number(body.connectionLimit || 10))))
    };
    if (!mysql.user) return sendError(res, 400, '请填写数据库账号');
    if (!mysql.database) return sendError(res, 400, '请填写数据库名称');
    const nextConfig = { installed: true, db: { client: 'mysql' }, mysql, setupAt: nowIso() };
    const previousConfig = runtimeConfig;
    const previousPool = mysqlPool;
    try {
      runtimeConfig = nextConfig;
      mysqlPool = null;
      await ensureMysqlDatabase(nextConfig);
      await initMysqlStorage();
      await writeRuntimeConfig(nextConfig);
      setupRequired = false;
      startCustomerNodeMaintenance();
      if (previousPool && previousPool !== mysqlPool) await previousPool.end().catch(() => {});
      return send(res, 200, { ok: true, message: '数据库连接成功，安装完成' });
    } catch (error) {
      if (mysqlPool && mysqlPool !== previousPool) await mysqlPool.end().catch(() => {});
      runtimeConfig = previousConfig;
      mysqlPool = previousPool;
      return sendError(res, 400, '数据库连接或初始化失败', error.message);
    }
  }

  if (url.pathname === '/api/public/branding' && req.method === 'GET') {
    if (setupRequired) return send(res, 200, { ok: true, settings: publicBrandSettings({}) });
    const db = await readDb();
    return send(res, 200, { ok: true, settings: publicBrandSettings(db.settings || {}) });
  }

  if (url.pathname === '/api/login' && req.method === 'POST') {
    if (setupRequired) return sendError(res, 428, '请先完成安装向导');
    const db = await readDb();
    if (tooManyLoginAttempts(req)) {
      return sendError(res, 429, '登录失败次数过多，请 10 分钟后再试');
    }
    const body = await parseJson(req);
    const entry = body.entry === 'admin' ? 'admin' : 'user';
    let sessionPayload = null;
    let responseUser = '';
    if (entry === 'admin' && verifyAdmin(db, body.username, body.password)) {
      responseUser = adminUsername(db);
      sessionPayload = { role: 'admin', username: responseUser };
    } else if (entry === 'user') {
      const customer = verifyCustomerLogin(db, body.username, body.password);
      if (customer) {
        responseUser = customer.loginUsername || customer.name;
        sessionPayload = { role: 'user', username: responseUser, customerId: customer.id };
      }
    }
    if (!sessionPayload) {
      recordLoginAttempt(req, false);
      return sendError(res, 401, entry === 'admin' ? '管理员账号或密码错误' : '用户账号或密码错误');
    }
    recordLoginAttempt(req, true);
    const token = crypto.randomBytes(32).toString('hex');
    await saveSession(token, sessionPayload);
    res.writeHead(200, securityHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': sessionCookie(req, sessionCookieName(sessionPayload.role), token)
    }));
    return res.end(JSON.stringify({ ok: true, username: responseUser, role: sessionPayload.role }));
  }

  if (url.pathname === '/api/logout' && req.method === 'POST') {
    const body = await parseJson(req).catch(() => ({}));
    const entry = body.entry === 'admin' ? 'admin' : 'user';
    const cookieName = sessionCookieName(entry);
    const token = getCookie(req, cookieName) || getCookie(req, 'xcp_session');
    await deleteSession(token);
    res.writeHead(200, securityHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': [sessionCookie(req, cookieName, '', { maxAge: 0 }), sessionCookie(req, 'xcp_session', '', { maxAge: 0 })]
    }));
    return res.end(JSON.stringify({ ok: true }));
  }

  if (setupRequired) return sendError(res, 428, '请先完成安装向导');

  if (url.pathname === '/api/payments/epay/notify' && ['GET', 'POST'].includes(req.method)) {
    const body = req.method === 'POST' ? await parseRequestBody(req) : {};
    const params = { ...Object.fromEntries(url.searchParams), ...body };
    const db = await readDb();
    const payments = normalizePaymentSettings({}, db.settings?.payments || {});
    if (!payments.enabled || !payments.epay.enabled || !verifyEpaySign(params, payments.epay)) return sendText(res, 400, 'fail');
    if (String(params.pid || '') !== String(payments.epay.pid || '')) return sendText(res, 400, 'fail');
    if (params.trade_status && params.trade_status !== 'TRADE_SUCCESS') return sendText(res, 400, 'fail');
    const result = await completeRechargeOrder(params.out_trade_no, {
      provider: 'epay',
      payType: String(params.type || '').trim(),
      amount: params.money,
      channelTradeNo: params.trade_no || params.api_trade_no || '',
      rawNotify: params
    });
    return sendText(res, result.ok ? 200 : 400, result.ok ? 'success' : 'fail');
  }

  if (url.pathname === '/api/payments/alipay/notify' && req.method === 'POST') {
    const params = await parseRequestBody(req);
    const db = await readDb();
    const payments = normalizePaymentSettings({}, db.settings?.payments || {});
    const publicKey = decrypt(payments.alipay.alipayPublicKeyEnc);
    if (!payments.enabled || !payments.alipay.enabled || !verifyAlipaySign(params, publicKey)) return sendText(res, 400, 'failure');
    if (String(params.app_id || '') !== String(payments.alipay.appId || '')) return sendText(res, 400, 'failure');
    if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(String(params.trade_status || ''))) return sendText(res, 400, 'failure');
    const result = await completeRechargeOrder(params.out_trade_no, {
      provider: 'alipay_native',
      payType: 'alipay',
      amount: params.total_amount || params.receipt_amount,
      channelTradeNo: params.trade_no || '',
      rawNotify: params
    });
    return sendText(res, result.ok ? 200 : 400, result.ok ? 'success' : 'failure');
  }

  if (url.pathname === '/api/payments/bepusdt/notify' && ['GET', 'POST'].includes(req.method)) {
    const params = req.method === 'GET' ? Object.fromEntries(url.searchParams.entries()) : await parseRequestBody(req);
    const db = await readDb();
    const payments = normalizePaymentSettings({}, db.settings?.payments || {});
    const token = decrypt(payments.bepusdt.tokenEnc);
    const sign = String(params.sign || '');
    if (!payments.enabled || !payments.bepusdt.enabled || !token || !sign) return sendText(res, 400, 'fail');
    const expected = crypto.createHash('md5').update(sortedSignContent(params) + token, 'utf8').digest('hex');
    if (!timingSafeTextEqual(expected, sign)) return sendText(res, 400, 'fail');
    if (String(params.trade_status || '').toUpperCase() !== 'TRADE_SUCCESS') return sendText(res, 400, 'fail');
    const result = await completeRechargeOrder(params.out_trade_no, {
      provider: 'bepusdt_native',
      payType: String(params.type || payments.bepusdt.tradeType || DEFAULT_BEPUSDT_TRADE_TYPE).trim(),
      amount: params.money,
      channelTradeNo: params.trade_no || '',
      rawNotify: params
    });
    return sendText(res, result.ok ? 200 : 400, result.ok ? 'success' : 'fail');
  }

  if (url.pathname === '/api/payments/wechat/notify' && req.method === 'POST') {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) return send(res, 413, { code: 'FAIL', message: 'Request body too large' });
      chunks.push(chunk);
    }
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      return send(res, 400, { code: 'FAIL', message: 'Invalid JSON body' });
    }
    const db = await readDb();
    const payments = normalizePaymentSettings({}, db.settings?.payments || {});
    const apiV3Key = decrypt(payments.wechat.apiV3KeyEnc);
    if (!payments.enabled || !payments.wechat.enabled || !apiV3Key) return send(res, 400, { code: 'FAIL', message: 'Wechat Pay is not configured' });
    if (!decrypt(payments.wechat.platformPublicKeyEnc)) return send(res, 400, { code: 'FAIL', message: 'Wechat Pay platform public key is not configured' });
    if (!verifyWechatNotifySignature(req, bodyText, payments.wechat)) return send(res, 401, { code: 'FAIL', message: 'Invalid signature' });
    let data;
    try {
      data = decryptWechatResource(body.resource, apiV3Key);
    } catch (error) {
      return send(res, 400, { code: 'FAIL', message: error.message || 'Decrypt failed' });
    }
    if (data.trade_state !== 'SUCCESS') return send(res, 400, { code: 'FAIL', message: 'Trade is not successful' });
    const total = Number(data.amount?.payer_total ?? data.amount?.total ?? 0) / 100;
    const result = await completeRechargeOrder(data.out_trade_no, {
      provider: 'wechat_native',
      amount: total,
      channelTradeNo: data.transaction_id || '',
      rawNotify: body
    });
    return send(res, result.ok ? 200 : 400, result.ok ? { code: 'SUCCESS', message: 'success' } : { code: 'FAIL', message: result.message || 'fail' });
  }

  if (url.pathname === '/api/payments/result' && req.method === 'GET') {
    const tradeNo = String(url.searchParams.get('trade_no') || '').trim();
    const db = await readDb();
    const order = db.rechargeOrders.find((item) => item.tradeNo === tradeNo);
    if (!order) return sendError(res, 404, '充值订单不存在');
    return send(res, 200, { ok: true, order: publicRechargeResult(order) });
  }

  const session = await requireAuth(req, res);
  if (!session) return;

  const db = await readDb();

  if (url.pathname === '/api/bootstrap' && req.method === 'GET') {
    const entry = url.searchParams.get('entry') === 'admin' ? 'admin' : 'user';
    if (entry === 'admin' && session.role !== 'admin') return sendError(res, 403, '请从管理员入口登录');
    if (entry === 'user' && session.role !== 'user') return sendError(res, 403, '请从用户入口登录');
    if (session.role === 'user') {
      const customer = db.customers.find((item) => item.id === session.customerId);
      if (!customer || customer.status === 'disabled') return sendError(res, 401, '用户不存在或已停用');
      return send(res, 200, { ok: true, data: publicUserDb(db, customer), user: session.username, role: 'user' });
    }
    return send(res, 200, { ok: true, data: publicDb(db), user: session.username, role: 'admin' });
  }

  if (url.pathname === '/api/user/node/link' && req.method === 'GET') {
    if (!requireUser(session, res)) return;
    const customer = db.customers.find((item) => item.id === session.customerId);
    if (!customer || customer.status === 'disabled') return sendError(res, 404, '用户不存在或已停用');
    const binding = findCustomerNodeForUser(db, customer.id, url.searchParams.get('nodeId'));
    if (!binding) return sendError(res, 404, '当前节点链接不可用');
    try {
      assertCustomerNodeUsable(db, customer, binding);
      const target = customerSyncTarget(db, customer, binding);
      if (!target.xuiServerId || !target.clientEmail) return sendError(res, 404, '当前节点链接不可用');
      const links = await getXuiClientLinks(db, target);
      if (!links.length) return sendError(res, 404, '没有从后台读取到可用节点链接');
      return send(res, 200, { ok: true, link: links[0], links });
    } catch (error) {
      console.error('读取用户节点链接失败:', error.message);
      return sendError(res, error.statusCode || 500, '读取节点链接失败，请稍后重试或联系管理员');
    }
  }

  if (url.pathname === '/api/user/node/qrcode' && req.method === 'GET') {
    if (!requireUser(session, res)) return;
    const customer = db.customers.find((item) => item.id === session.customerId);
    if (!customer || customer.status === 'disabled') return sendError(res, 404, '用户不存在或已停用');
    const binding = findCustomerNodeForUser(db, customer.id, url.searchParams.get('nodeId'));
    if (!binding) return sendError(res, 404, '当前节点二维码不可用');
    try {
      assertCustomerNodeUsable(db, customer, binding);
      const target = customerSyncTarget(db, customer, binding);
      if (!target.xuiServerId || !target.clientEmail) return sendError(res, 404, '当前节点二维码不可用');
      const links = await getXuiClientLinks(db, target);
      if (!links.length) return sendError(res, 404, '没有从后台读取到可用节点二维码');
      const buffer = await QRCode.toBuffer(links[0], { type: 'png', margin: 1, width: 260, errorCorrectionLevel: 'M' });
      res.writeHead(200, securityHeaders({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }));
      return res.end(buffer);
    } catch (error) {
      console.error('读取用户节点二维码失败:', error.message);
      return sendError(res, error.statusCode || 500, '读取节点二维码失败，请稍后重试或联系管理员');
    }
  }

  if (url.pathname === '/api/user/cards/redeem' && req.method === 'POST') {
    if (!requireUser(session, res)) return;
    const body = await parseJson(req);
    try {
      const result = await redeemCardForUserMysql(session.customerId, body.code);
      return send(res, 200, { ok: true, data: publicUserDb(result.db, result.customer), message: `充值成功，余额增加 ${result.amount}` });
    } catch (error) {
      return sendError(res, error.statusCode || 500, error.message || '卡密兑换失败');
    }
  }

  if (url.pathname === '/api/user/recharge-orders' && req.method === 'POST') {
    if (!requireUser(session, res)) return;
    const body = await parseJson(req);
    const customer = db.customers.find((item) => item.id === session.customerId);
    if (!customer || customer.status === 'disabled') return sendError(res, 404, '用户不存在或已停用');
    const payments = normalizePaymentSettings({}, db.settings?.payments || {});
    const methodId = String(body.method || '').trim();
    const method = resolveRechargeMethod(methodId, payments, req);
    const amount = Number(Number(body.amount || 0).toFixed(2));
    const methodNames = { alipay: '\u652f\u4ed8\u5b9d', wechat: '\u5fae\u4fe1\u652f\u4ed8', paypal: 'PayPal', usdt: 'USDT' };
    if (!payments.enabled) return sendError(res, 400, '管理员还没有启用在线充值');
    if (!method) return sendError(res, 400, `${methodNames[methodId] || '\u652f\u4ed8\u65b9\u5f0f'}\u672a\u914d\u7f6e\u6216\u672a\u542f\u7528`);
    if (!Number.isFinite(amount) || amount < payments.minAmount) return sendError(res, 400, `最低充值金额为 ${payments.minAmount}`);
    if (recentPendingOrders(db, customer.id).length >= 20) return sendError(res, 429, '待支付订单较多，请先完成已有订单或稍后再试');
    const order = normalizeRechargeOrder({
      customerId: customer.id,
      customerName: customer.name,
      provider: method.provider,
      method: method.method || methodId,
      payType: method.payType,
      amount,
      status: 'pending'
    });
    let payUrl = '';
    let qrCode = '';
    let qrImage = '';
    try {
      if (method.provider === 'alipay_native' && method.alipayMethod === 'precreate') {
        const precreate = await buildAlipayPrecreatePayment(order, payments, siteOrigin(req));
        qrCode = precreate.qrCode;
        qrImage = precreate.qrImage;
      } else if (method.provider === 'bepusdt_native') {
        const bepusdt = await buildBepusdtNativePayment(order, payments, siteOrigin(req));
        payUrl = bepusdt.payUrl;
        qrCode = bepusdt.qrCode;
        qrImage = bepusdt.qrImage;
      } else if (method.provider === 'wechat_native') {
        if (method.wechatMethod === 'h5') {
          const wechat = await buildWechatH5Payment(order, payments, siteOrigin(req), req);
          payUrl = wechat.payUrl;
        } else {
          const wechat = await buildWechatNativePayment(order, payments, siteOrigin(req));
          qrCode = wechat.qrCode;
          qrImage = wechat.qrImage;
        }
      } else {
        payUrl = method.provider === 'alipay_native'
          ? buildAlipayPayUrl(order, payments, siteOrigin(req), method.alipayMethod)
          : buildEpayPayUrl(order, payments, siteOrigin(req));
      }
    } catch (error) {
      return sendError(res, 400, `${methodNames[methodId] || '\u652f\u4ed8\u65b9\u5f0f'}\u672a\u914d\u7f6e\u6216\u672a\u542f\u7528`);
    }
    db.rechargeOrders.push(order);
    if (db.rechargeOrders.length > 2000) db.rechargeOrders = db.rechargeOrders.slice(-2000);
    await mysqlTransaction((connection) => upsertMysqlRechargeOrderRow(connection, order));
    const { rawNotify, ...safeOrder } = order;
    return send(res, 200, { ok: true, payUrl, qrCode, qrImage, order: safeOrder, data: publicUserDb(db, customer) });
  }

  if (url.pathname === '/api/user/renew' && req.method === 'POST') {
    if (!requireUser(session, res)) return;
    const body = await parseJson(req);
    try {
      const result = await renewCustomerNodeForUserMysql(session.customerId, body.nodeId, body.months);
      const detail = {
        nodeId: result.customerNode?.id || body.nodeId || '',
        months: result.detail?.months || 1,
        price: Number(result.detail?.price || 0),
        beforeExpireAt: result.detail?.oldExpireAt || '',
        afterExpireAt: result.detail?.newExpireAt || result.customerNode?.expireAt || ''
      };
      return send(res, 200, { ok: true, data: publicUserDb(result.db, result.customer), detail, warning: '' });
    } catch (error) {
      const statusCode = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
      const message = statusCode < 500 ? error.message : '续费失败，请稍后重试或联系管理员';
      return sendError(res, statusCode, message || '续费失败');
    }
  }

  if (url.pathname === '/api/user/profile' && req.method === 'PUT') {
    if (!requireUser(session, res)) return;
    const body = await parseJson(req);
    const customer = db.customers.find((item) => item.id === session.customerId);
    if (!customer) return sendError(res, 404, '用户不存在');
    const currentPassword = String(body.currentPassword || '');
    const nextUsername = String(body.loginUsername || '').trim();
    const nextPassword = String(body.newPassword || '');
    const confirmPassword = String(body.confirmPassword || '');
    if (!customer.loginPasswordHash || !verifyPassword(currentPassword, customer.loginPasswordHash)) return sendError(res, 400, '当前密码不正确');
    if (!nextUsername) return sendError(res, 400, '请填写登录账号');
    if (nextPassword && nextPassword.length < 6) return sendError(res, 400, '新密码至少需要 6 位');
    if (nextPassword !== confirmPassword) return sendError(res, 400, '两次输入的新密码不一致');
    const changedCustomer = {
      ...customer,
      loginUsername: compactText(nextUsername, 191),
      loginPasswordHash: nextPassword ? hashPassword(nextPassword) : customer.loginPasswordHash,
      updatedAt: nowIso()
    };
    try {
      validateCustomerLogin(db, changedCustomer, changedCustomer.id);
    } catch (error) {
      return sendError(res, 400, error.message);
    }
    Object.assign(customer, changedCustomer);
    await mysqlTransaction((connection) => updateMysqlCustomerRow(connection, customer));
    const token = getCookie(req, sessionCookieName('user')) || getCookie(req, 'xcp_session');
    if (token) await saveSession(token, { role: 'user', username: customer.loginUsername || customer.name, customerId: customer.id });
    return send(res, 200, { ok: true, data: publicUserDb(db, customer), user: customer.loginUsername || customer.name, role: 'user' });
  }

  if (!requireAdmin(session, res)) return;

  if (url.pathname === '/api/change-password' && req.method === 'POST') {
    const body = await parseJson(req);
    const username = String(body.username || session.username || '').trim();
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');
    if (!verifyAdmin(db, session.username, currentPassword)) {
      return sendError(res, 400, '当前密码不正确');
    }
    if (!username) return sendError(res, 400, '请填写管理员账号');
    if (newPassword.length < 8) return sendError(res, 400, '新密码至少需要 8 位');
    db.settings ||= { currency: 'CNY', expiryWarningDays: 3 };
    db.settings.admin = {
      username,
      passwordHash: hashPassword(newPassword),
      updatedAt: nowIso()
    };
    await mysqlTransaction((connection) => upsertMysqlSettingsRow(connection, db.settings));
    await deleteSession(getCookie(req, 'xcp_admin_session') || getCookie(req, 'xcp_session'));
    res.writeHead(200, securityHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': [sessionCookie(req, 'xcp_admin_session', '', { maxAge: 0 }), sessionCookie(req, 'xcp_session', '', { maxAge: 0 })]
    }));
    return res.end(JSON.stringify({ ok: true, message: '密码已修改，请重新登录' }));
  }

  if (url.pathname === '/api/settings' && req.method === 'PUT') {
    const body = await parseJson(req);
    db.settings ||= { currency: 'CNY', expiryWarningDays: 3 };
    if (hasField(body, 'brandName')) db.settings.brandName = normalizeBrandName(body.brandName);
    if (hasField(body, 'logoDataUrl')) db.settings.logoDataUrl = normalizeLogoDataUrl(body.logoDataUrl);
    if (hasField(body, 'purchaseCardUrl')) db.settings.purchaseCardUrl = String(body.purchaseCardUrl || '').trim();
    if (hasField(body, 'currency')) db.settings.currency = String(body.currency || 'CNY').trim() || 'CNY';
    if (hasField(body, 'expiryWarningDays')) db.settings.expiryWarningDays = Math.max(1, Math.floor(Number(body.expiryWarningDays || 3)));
    if (hasField(body, 'adminPath')) db.settings.adminPath = normalizeAdminPath(body.adminPath || '/admin');
    if (hasField(body, 'paymentSettingsSubmitted')) db.settings.payments = normalizePaymentSettings(body, db.settings.payments || {});
    applyRuntimeSettings(db);
    await mysqlTransaction((connection) => upsertMysqlSettingsRow(connection, db.settings));
    return send(res, 200, { ok: true, data: publicDb(db) });
  }

  if (url.pathname === '/api/cards/generate' && req.method === 'POST') {
    const body = await parseJson(req);
    const count = Math.min(500, Math.max(1, Math.floor(Number(body.count || 1))));
    const amount = Math.max(0, Number(body.amount || 0));
    const requestedBatchId = String(body.batchId || '').trim();
    let batch = db.cardBatches.find((item) => item.id === requestedBatchId);
    batch = normalizeCardBatch({ ...body, amount }, batch || {});
    const type = batch.name;
    if (amount <= 0) return sendError(res, 400, '卡密金额必须大于 0');
    if (!db.cardBatches.some((item) => item.id === batch.id)) db.cardBatches.push(batch);
    else db.cardBatches = db.cardBatches.map((item) => (item.id === batch.id ? batch : item));
    const generated = [];
    const existingCodes = new Set(db.cards.map((card) => normalizeCardCode(card.code)));
    for (let index = 0; index < count; index += 1) {
      let code = generateCardCode(batch.prefix);
      while (existingCodes.has(normalizeCardCode(code))) code = generateCardCode(batch.prefix);
      existingCodes.add(normalizeCardCode(code));
      const card = {
        id: id('card'),
        code,
        amount,
        type,
        batchId: batch.id,
        batchName: batch.name,
        status: 'unused',
        remark: batch.remark,
        createdAt: nowIso()
      };
      db.cards.push(card);
      generated.push(card);
    }
    await mysqlTransaction(async (connection) => {
      await upsertMysqlCardBatchRow(connection, batch);
      for (const card of generated) await insertMysqlGeneratedCardRow(connection, card, batch.prefix, existingCodes);
    });
    return send(res, 200, { ok: true, data: publicDb(db), generated });
  }

  if (url.pathname === '/api/cards/bulk-delete' && req.method === 'POST') {
    const body = await parseJson(req);
    const requestedIds = Array.isArray(body.ids) ? new Set(body.ids.map((item) => String(item || ''))) : null;
    const type = String(body.type || '').trim();
    if (!requestedIds?.size && !type) return sendError(res, 400, '请选择要删除的卡密分类');
    const currency = db.settings?.currency || 'CNY';
    const before = db.cards.length;
    const matched = db.cards.filter((card) => requestedIds?.size ? requestedIds.has(card.id) : cardGroupType(card, currency) === type);
    const deletable = matched.filter((card) => ['unused', 'disabled'].includes(card.status));
    if (!deletable.length) return sendError(res, 400, '这个分类没有可删除的未使用或已禁用卡密');
    const deletableIds = new Set(deletable.map((card) => card.id));
    db.cards = db.cards.filter((card) => !deletableIds.has(card.id));
    await mysqlTransaction((connection) => deleteMysqlRows(connection, 'shiye_cards', deletableIds));
    return send(res, 200, {
      ok: true,
      data: publicDb(db),
      deleted: before - db.cards.length,
      keptUsed: matched.filter((card) => card.status === 'used').length
    });
  }

  if (url.pathname === '/api/cards/bulk-update' && req.method === 'POST') {
    const body = await parseJson(req);
    const ids = Array.isArray(body.ids) ? new Set(body.ids.map((item) => String(item || ''))) : new Set();
    const type = String(body.type || '').trim();
    if (!ids.size) return sendError(res, 400, '请选择要修改的卡密');
    if (!type) return sendError(res, 400, '分类名称不能为空');
    let updated = 0;
    for (const card of db.cards) {
      if (!ids.has(card.id)) continue;
      card.type = type;
      card.updatedAt = nowIso();
      updated += 1;
    }
    const changedCards = db.cards.filter((card) => ids.has(card.id));
    await mysqlTransaction(async (connection) => {
      for (const card of changedCards) await upsertMysqlCardRow(connection, card);
    });
    return send(res, 200, { ok: true, data: publicDb(db), updated });
  }

  const batchMatch = url.pathname.match(/^\/api\/card-batches\/([^/]+)$/);
  if (batchMatch && req.method === 'PUT') {
    const body = await parseJson(req);
    const index = db.cardBatches.findIndex((item) => item.id === batchMatch[1]);
    if (index < 0) return sendError(res, 404, '卡密批次不存在');
    const batch = normalizeCardBatch(body, db.cardBatches[index]);
    db.cardBatches[index] = batch;
    for (const card of db.cards) {
      if (card.batchId !== batch.id) continue;
      card.batchName = batch.name;
      card.type = batch.name;
      if (hasField(body, 'remark')) card.remark = batch.remark;
      card.updatedAt = nowIso();
    }
    const changedCards = db.cards.filter((card) => card.batchId === batch.id);
    await mysqlTransaction(async (connection) => {
      await upsertMysqlCardBatchRow(connection, batch);
      for (const card of changedCards) await upsertMysqlCardRow(connection, card);
    });
    return send(res, 200, { ok: true, data: publicDb(db) });
  }
  if (batchMatch && req.method === 'DELETE') {
    const batch = db.cardBatches.find((item) => item.id === batchMatch[1]);
    if (!batch) return sendError(res, 404, '卡密批次不存在');
    const matched = db.cards.filter((card) => card.batchId === batch.id);
    const deletable = matched.filter((card) => ['unused', 'disabled'].includes(card.status));
    const deletableIds = new Set(deletable.map((card) => card.id));
    db.cards = db.cards.filter((card) => !deletableIds.has(card.id));
    if (!matched.some((card) => card.status === 'used')) {
      db.cardBatches = db.cardBatches.filter((item) => item.id !== batch.id);
    }
    await mysqlTransaction(async (connection) => {
      await deleteMysqlRows(connection, 'shiye_cards', deletableIds);
      if (!matched.some((card) => card.status === 'used')) await deleteMysqlRows(connection, 'shiye_card_batches', new Set([batch.id]));
    });
    return send(res, 200, { ok: true, data: publicDb(db), deleted: deletable.length, keptUsed: matched.length - deletable.length });
  }

  const cardMatch = url.pathname.match(/^\/api\/cards\/([^/]+)$/);
  if (cardMatch && req.method === 'DELETE') {
    const card = db.cards.find((item) => item.id === cardMatch[1]);
    if (!card) return sendError(res, 404, '卡密不存在');
    if (card.status === 'used') return sendError(res, 400, '已使用卡密不能删除，可保留作为审计记录');
    db.cards = db.cards.filter((item) => item.id !== cardMatch[1]);
    await mysqlTransaction((connection) => deleteMysqlRows(connection, 'shiye_cards', new Set([card.id])));
    return send(res, 200, { ok: true, data: publicDb(db) });
  }
  if (cardMatch && req.method === 'PUT') {
    const body = await parseJson(req);
    const card = db.cards.find((item) => item.id === cardMatch[1]);
    if (!card) return sendError(res, 404, '卡密不存在');
    if (['unused', 'disabled'].includes(body.status)) card.status = body.status;
    card.remark = String(body.remark ?? card.remark ?? '').trim();
    card.updatedAt = nowIso();
    await mysqlTransaction((connection) => upsertMysqlCardRow(connection, card));
    return send(res, 200, { ok: true, data: publicDb(db) });
  }

  if (url.pathname === '/api/xui-servers' && req.method === 'POST') {
    const body = await parseJson(req);
    const server = normalizeServer(body);
    if (!server.name || !server.host) return sendError(res, 400, '请填写节点名称和地址');
    db.xuiServers.push(server);
    await mysqlTransaction((connection) => upsertMysqlServerRow(connection, server));
    return send(res, 200, { ok: true, data: publicDb(db) });
  }

  const serverMatch = url.pathname.match(/^\/api\/xui-servers\/([^/]+)$/);
  if (serverMatch && req.method === 'PUT') {
    const body = await parseJson(req);
    const index = db.xuiServers.findIndex((item) => item.id === serverMatch[1]);
    if (index < 0) return sendError(res, 404, '3x-ui 节点不存在');
    db.xuiServers[index] = normalizeServer(body, db.xuiServers[index]);
    await mysqlTransaction((connection) => upsertMysqlServerRow(connection, db.xuiServers[index]));
    return send(res, 200, { ok: true, data: publicDb(db) });
  }
  if (serverMatch && req.method === 'DELETE') {
    const bound = db.serviceNodes.some((item) => item.xuiServerId === serverMatch[1]);
    if (bound) return sendError(res, 400, '该面板节点已有服务节点引用，请先删除或迁移服务节点');
    db.xuiServers = db.xuiServers.filter((item) => item.id !== serverMatch[1]);
    await mysqlTransaction((connection) => deleteMysqlRows(connection, 'shiye_xui_servers', new Set([serverMatch[1]])));
    return send(res, 200, { ok: true, data: publicDb(db) });
  }

  if (url.pathname === '/api/service-nodes' && req.method === 'POST') {
    const body = await parseJson(req);
    const node = normalizeServiceNode(body);
    try {
      validateServiceNode(node);
    } catch (error) {
      return sendError(res, 400, error.message);
    }
    db.serviceNodes.push(node);
    await mysqlTransaction((connection) => upsertMysqlServiceNodeRow(connection, node));
    return send(res, 200, { ok: true, data: publicDb(db) });
  }

  const serviceNodeMatch = url.pathname.match(/^\/api\/service-nodes\/([^/]+)$/);
  if (serviceNodeMatch && req.method === 'PUT') {
    const body = await parseJson(req);
    const index = db.serviceNodes.findIndex((item) => item.id === serviceNodeMatch[1]);
    if (index < 0) return sendError(res, 404, '服务节点不存在');
    const node = normalizeServiceNode(body, db.serviceNodes[index]);
    try {
      validateServiceNode(node);
    } catch (error) {
      return sendError(res, 400, error.message);
    }
    db.serviceNodes[index] = node;
    await mysqlTransaction((connection) => upsertMysqlServiceNodeRow(connection, node));
    return send(res, 200, { ok: true, data: publicDb(db) });
  }
  if (serviceNodeMatch && req.method === 'DELETE') {
    const bound = db.customerNodes.some((item) => item.nodeId === serviceNodeMatch[1]);
    if (bound) return sendError(res, 400, '这个服务节点已有用户绑定，请先解绑用户节点');
    db.serviceNodes = db.serviceNodes.filter((item) => item.id !== serviceNodeMatch[1]);
    await mysqlTransaction((connection) => deleteMysqlRows(connection, 'shiye_service_nodes', new Set([serviceNodeMatch[1]])));
    return send(res, 200, { ok: true, data: publicDb(db) });
  }

  const syncServerNodesMatch = url.pathname.match(/^\/api\/xui-servers\/([^/]+)\/sync-service-nodes$/);
  if (syncServerNodesMatch && req.method === 'POST') {
    try {
      const detail = await syncServiceNodesFromXui(db, syncServerNodesMatch[1]);
      return send(res, 200, {
        ok: true,
        data: publicDb(db),
        detail,
        message: `同步完成：新增 ${detail.created}，更新 ${detail.updated}，跳过 ${detail.skipped}`
      });
    } catch (error) {
      return sendError(res, error.statusCode || 500, '同步节点失败', error.message);
    }
  }

  const importServerMatch = url.pathname.match(/^\/api\/xui-servers\/([^/]+)\/import-customers$/);
  if (importServerMatch && req.method === 'POST') {
    return sendError(res, 410, '旧版同步用户入口已停用', '请先创建用户和服务节点，再在用户节点管理里绑定节点。');
  }

  if (url.pathname === '/api/socks-nodes' && req.method === 'POST') {
    const body = await parseJson(req);
    const node = normalizeSocks(body);
    if (!node.name || !node.address) return sendError(res, 400, '请填写 SOCKS 名称和地址');
    db.socksNodes.push(node);
    await mysqlTransaction((connection) => upsertMysqlSocksRow(connection, node));
    return send(res, 200, { ok: true, data: publicDb(db) });
  }

  const socksMatch = url.pathname.match(/^\/api\/socks-nodes\/([^/]+)$/);
  if (socksMatch && req.method === 'PUT') {
    const body = await parseJson(req);
    const index = db.socksNodes.findIndex((item) => item.id === socksMatch[1]);
    if (index < 0) return sendError(res, 404, 'SOCKS 节点不存在');
    db.socksNodes[index] = normalizeSocks(body, db.socksNodes[index]);
    await mysqlTransaction((connection) => upsertMysqlSocksRow(connection, db.socksNodes[index]));
    return send(res, 200, { ok: true, data: publicDb(db) });
  }
  if (socksMatch && req.method === 'DELETE') {
    const bound = db.serviceNodes.some((item) => item.socksNodeId === socksMatch[1]);
    if (bound) return sendError(res, 400, '该 SOCKS 出站已有服务节点引用，请先删除或迁移服务节点');
    db.socksNodes = db.socksNodes.filter((item) => item.id !== socksMatch[1]);
    await mysqlTransaction((connection) => deleteMysqlRows(connection, 'shiye_socks_nodes', new Set([socksMatch[1]])));
    return send(res, 200, { ok: true, data: publicDb(db) });
  }

  if (url.pathname === '/api/customers' && req.method === 'POST') {
    const body = await parseJson(req);
    const customer = normalizeCustomer(body);
    if (!customer.name) return sendError(res, 400, '请填写用户名称');
    try {
      validateCustomerLogin(db, customer);
    } catch (error) {
      return sendError(res, 400, error.message);
    }
    db.customers.push(customer);
    addLog(db, customer.id, 'customer', 'success', '用户已创建');
    const createdLog = db.syncLogs[db.syncLogs.length - 1];
    await mysqlTransaction(async (connection) => {
      await updateMysqlCustomerRow(connection, customer);
      await insertMysqlLog(connection, createdLog);
    });
    return send(res, 200, { ok: true, data: publicDb(db) });
  }

  const customerMatch = url.pathname.match(/^\/api\/customers\/([^/]+)$/);
  if (customerMatch && req.method === 'PUT') {
    const body = await parseJson(req);
    const index = db.customers.findIndex((item) => item.id === customerMatch[1]);
    if (index < 0) return sendError(res, 404, '用户不存在');
    const beforeCustomer = db.customers[index];
    const beforeBalance = Number(beforeCustomer.balance || 0);
    db.customers[index] = normalizeCustomer(body, db.customers[index]);
    try {
      validateCustomerLogin(db, db.customers[index], db.customers[index].id);
    } catch (error) {
      return sendError(res, 400, error.message);
    }
    const afterBalance = Number(db.customers[index].balance || 0);
    if (afterBalance !== beforeBalance) {
      addBalanceLog(db, db.customers[index], 'admin_set', afterBalance - beforeBalance, beforeBalance, afterBalance, session.username || '管理员', '编辑用户资料时修改余额');
    }
    addLog(db, db.customers[index].id, 'customer', 'success', '用户已更新');
    const changedCustomer = db.customers[index];
    const balanceLog = afterBalance !== beforeBalance ? db.balanceLogs[db.balanceLogs.length - 1] : null;
    const updateLog = db.syncLogs[db.syncLogs.length - 1];
    await mysqlTransaction(async (connection) => {
      await updateMysqlCustomerRow(connection, changedCustomer);
      if (balanceLog) await insertMysqlBalanceLog(connection, balanceLog);
      await insertMysqlLog(connection, updateLog);
    });
    return send(res, 200, { ok: true, data: publicDb(db) });
  }
  if (customerMatch && req.method === 'DELETE') {
    const customer = db.customers.find((item) => item.id === customerMatch[1]);
    if (!customer) return sendError(res, 404, '用户不存在');
    const cleanup = await cleanupCustomerRemoteResources(db, customer);
    db.customers = db.customers.filter((item) => item.id !== customerMatch[1]);
    const bindingIds = new Set(db.customerNodes.filter((item) => item.customerId === customer.id).map((item) => item.id));
    db.customerNodes = db.customerNodes.filter((item) => item.customerId !== customer.id);
    const hasWarnings = Array.isArray(cleanup.warnings) && cleanup.warnings.length > 0;
    addLog(db, customer.id, 'delete', hasWarnings ? 'warning' : 'success', hasWarnings ? '本地用户已删除，远程清理存在警告' : '用户已删除，并已同步清理远程资源', cleanup);
    const deleteLog = db.syncLogs[db.syncLogs.length - 1];
    await mysqlTransaction(async (connection) => {
      await deleteMysqlRows(connection, 'shiye_customers', new Set([customer.id]));
      await deleteMysqlRows(connection, 'shiye_customer_nodes', bindingIds);
      await insertMysqlLog(connection, deleteLog);
    });
    return send(res, 200, { ok: true, data: publicDb(db), detail: cleanup, warning: hasWarnings ? cleanup.warnings.join('；') : '' });
  }

  const customerNodesMatch = url.pathname.match(/^\/api\/customers\/([^/]+)\/nodes$/);
  if (customerNodesMatch && req.method === 'POST') {
    const body = await parseJson(req);
    const customer = db.customers.find((item) => item.id === customerNodesMatch[1]);
    if (!customer) return sendError(res, 404, '用户不存在');
    const node = db.serviceNodes.find((item) => item.id === String(body.nodeId || '').trim());
    const binding = normalizeCustomerNode({
      ...body,
      customerId: customer.id,
      name: body.name || node?.name || '',
      trafficLimitGb: body.trafficLimitGb || node?.trafficLimitGb || 0
    });
    try {
      validateCustomerNodeBinding(db, binding);
    } catch (error) {
      return sendError(res, 400, error.message);
    }
    db.customerNodes.push(binding);
    addLog(db, customer.id, 'node', 'success', `已绑定节点 ${binding.name || node?.name || binding.id}`, { customerNodeId: binding.id, serviceNodeId: binding.nodeId });
    const syncLog = db.syncLogs[db.syncLogs.length - 1];
    await mysqlTransaction(async (connection) => {
      await upsertMysqlCustomerNodeRow(connection, binding);
      await insertMysqlLog(connection, syncLog);
    });
    return send(res, 200, { ok: true, data: publicDb(db) });
  }

  const customerNodeMatch = url.pathname.match(/^\/api\/customers\/([^/]+)\/nodes\/([^/]+)$/);
  if (customerNodeMatch && req.method === 'PUT') {
    const body = await parseJson(req);
    const customer = db.customers.find((item) => item.id === customerNodeMatch[1]);
    if (!customer) return sendError(res, 404, '用户不存在');
    const index = db.customerNodes.findIndex((item) => item.id === customerNodeMatch[2] && item.customerId === customer.id);
    if (index < 0) return sendError(res, 404, '用户节点不存在');
    const binding = normalizeCustomerNode({ ...body, customerId: customer.id }, db.customerNodes[index]);
    try {
      validateCustomerNodeBinding(db, binding);
    } catch (error) {
      return sendError(res, 400, error.message);
    }
    db.customerNodes[index] = binding;
    addLog(db, customer.id, 'node', 'success', `已更新用户节点 ${binding.name || binding.id}`, { customerNodeId: binding.id, serviceNodeId: binding.nodeId });
    const syncLog = db.syncLogs[db.syncLogs.length - 1];
    await mysqlTransaction(async (connection) => {
      await upsertMysqlCustomerNodeRow(connection, binding);
      await insertMysqlLog(connection, syncLog);
    });
    return send(res, 200, { ok: true, data: publicDb(db) });
  }
  if (customerNodeMatch && req.method === 'DELETE') {
    const customer = db.customers.find((item) => item.id === customerNodeMatch[1]);
    if (!customer) return sendError(res, 404, '用户不存在');
    const binding = db.customerNodes.find((item) => item.id === customerNodeMatch[2] && item.customerId === customer.id);
    if (!binding) return sendError(res, 404, '用户节点不存在');
    let cleanup = { skipped: true, warnings: [] };
    try {
      cleanup = await cleanupCustomerNodeRemoteResources(db, customer, binding);
    } catch (error) {
      cleanup = { failed: true, error: error.message, warnings: [error.message] };
    }
    db.customerNodes = db.customerNodes.filter((item) => item.id !== binding.id);
    const hasWarnings = Array.isArray(cleanup.warnings) && cleanup.warnings.length > 0;
    addLog(db, customer.id, 'node_delete', hasWarnings ? 'warning' : 'success', hasWarnings ? '用户节点已删除，远程清理存在警告' : '用户节点已删除，并已同步清理远程资源', cleanup);
    const syncLog = db.syncLogs[db.syncLogs.length - 1];
    await mysqlTransaction(async (connection) => {
      await deleteMysqlRows(connection, 'shiye_customer_nodes', new Set([binding.id]));
      await insertMysqlLog(connection, syncLog);
    });
    return send(res, 200, { ok: true, data: publicDb(db), detail: cleanup, warning: hasWarnings ? cleanup.warnings.join('；') : '' });
  }

  const customerNodeSyncMatch = url.pathname.match(/^\/api\/customers\/([^/]+)\/nodes\/([^/]+)\/sync$/);
  if (customerNodeSyncMatch && req.method === 'POST') {
    const customer = db.customers.find((item) => item.id === customerNodeSyncMatch[1]);
    if (!customer) return sendError(res, 404, '用户不存在');
    const binding = db.customerNodes.find((item) => item.id === customerNodeSyncMatch[2] && item.customerId === customer.id);
    if (!binding) return sendError(res, 404, '用户节点不存在');
    try {
      const detail = await syncCustomerNodeToRemote(db, customer, binding, customer.status === 'disabled' || binding.status === 'disabled' ? 'disable' : 'upsert');
      addLog(db, customer.id, 'sync', 'success', `已同步用户节点 ${binding.name || binding.id}`, { customerNodeId: binding.id, serviceNodeId: binding.nodeId, clientResult: detail.clientResult, socksResult: detail.socksResult });
      const syncLog = db.syncLogs[db.syncLogs.length - 1];
      await mysqlTransaction((connection) => insertMysqlLog(connection, syncLog));
      return send(res, 200, { ok: true, data: publicDb(db), detail });
    } catch (error) {
      addLog(db, customer.id, 'sync', 'failed', error.message, { customerNodeId: binding.id, serviceNodeId: binding.nodeId });
      const syncLog = db.syncLogs[db.syncLogs.length - 1];
      await mysqlTransaction((connection) => insertMysqlLog(connection, syncLog));
      return sendError(res, error.statusCode || 500, '同步失败', error.message);
    }
  }

  const customerNodeRenewMatch = url.pathname.match(/^\/api\/customers\/([^/]+)\/nodes\/([^/]+)\/renew$/);
  if (customerNodeRenewMatch && req.method === 'POST') {
    const body = await parseJson(req);
    const customer = db.customers.find((item) => item.id === customerNodeRenewMatch[1]);
    if (!customer) return sendError(res, 404, '用户不存在');
    const binding = db.customerNodes.find((item) => item.id === customerNodeRenewMatch[2] && item.customerId === customer.id);
    if (!binding) return sendError(res, 404, '用户节点不存在');
    const serviceNode = db.serviceNodes.find((item) => item.id === binding.nodeId);
    if (!serviceNode) return sendError(res, 404, '服务节点不存在');
    const months = Math.max(1, Math.floor(Number(body.months || 1)));
    const oldExpireAt = binding.expireAt;
    const shouldResetTraffic = binding.disabledReason === 'traffic_exceeded';
    const changedBinding = { ...binding, expireAt: addMonths(binding.expireAt, months), status: 'active', disabledReason: '', disabledAt: '', resetTraffic: shouldResetTraffic, updatedAt: nowIso() };
    const syncDb = { ...db, customerNodes: db.customerNodes.map((item) => item.id === changedBinding.id ? changedBinding : item) };
    try {
      const detail = await syncCustomerNodeToRemote(syncDb, customer, changedBinding, 'upsert');
      db.serviceNodes = syncDb.serviceNodes;
      const index = db.customerNodes.findIndex((item) => item.id === binding.id);
      delete changedBinding.resetTraffic;
      db.customerNodes[index] = changedBinding;
      addRenewalLog(db, customer, months, 0, oldExpireAt, changedBinding.expireAt, 'admin', 'success', `管理员续费 ${changedBinding.name || serviceNode.name || '节点'} ${months} 个月`, { customerNodeId: binding.id, serviceNodeId: binding.nodeId, oldExpireAt, newExpireAt: changedBinding.expireAt, ...detail });
      addLog(db, customer.id, 'renew', 'success', `已续费用户节点 ${months} 个月`, { customerNodeId: binding.id, serviceNodeId: binding.nodeId, oldExpireAt, newExpireAt: changedBinding.expireAt, ...detail });
      const renewalLog = db.renewalLogs[db.renewalLogs.length - 1];
      const syncLog = db.syncLogs[db.syncLogs.length - 1];
      await mysqlTransaction(async (connection) => {
        await upsertMysqlCustomerNodeRow(connection, changedBinding);
        await insertMysqlRenewalLog(connection, renewalLog);
        await insertMysqlLog(connection, syncLog);
      });
      return send(res, 200, { ok: true, data: publicDb(db), detail });
    } catch (error) {
      return sendError(res, error.statusCode || 500, '续费失败', error.message);
    }
  }

  const balanceMatch = url.pathname.match(/^\/api\/customers\/([^/]+)\/balance-adjust$/);
  if (balanceMatch && req.method === 'POST') {
    const body = await parseJson(req);
    const customer = db.customers.find((item) => item.id === balanceMatch[1]);
    if (!customer) return sendError(res, 404, '用户不存在');
    const mode = ['add', 'subtract', 'set'].includes(body.mode) ? body.mode : 'add';
    const amount = Number(body.amount || 0);
    if (!Number.isFinite(amount) || amount < 0) return sendError(res, 400, '调整金额必须是大于等于 0 的数字');
    const beforeBalance = Number(customer.balance || 0);
    let afterBalance = beforeBalance;
    if (mode === 'add') afterBalance = beforeBalance + amount;
    if (mode === 'subtract') afterBalance = Math.max(0, beforeBalance - amount);
    if (mode === 'set') afterBalance = amount;
    customer.balance = Number(afterBalance.toFixed(2));
    customer.updatedAt = nowIso();
    const delta = Number((customer.balance - beforeBalance).toFixed(2));
    const modeText = { add: '增加余额', subtract: '扣减余额', set: '设置余额' }[mode];
    addBalanceLog(db, customer, `admin_${mode}`, delta, beforeBalance, customer.balance, session.username || '管理员', String(body.remark || modeText).trim(), { mode, amount });
    addLog(db, customer.id, 'balance', 'success', `${modeText} ${amount}`, { mode, amount, beforeBalance, afterBalance: customer.balance });
    const balanceLog = db.balanceLogs[db.balanceLogs.length - 1];
    const syncLog = db.syncLogs[db.syncLogs.length - 1];
    await mysqlTransaction(async (connection) => {
      await updateMysqlCustomerRow(connection, customer);
      await insertMysqlBalanceLog(connection, balanceLog);
      await insertMysqlLog(connection, syncLog);
    });
    return send(res, 200, { ok: true, data: publicDb(db) });
  }

  const renewMatch = url.pathname.match(/^\/api\/customers\/([^/]+)\/renew$/);
  if (renewMatch && req.method === 'POST') {
    return sendError(res, 410, '旧版整用户续费入口已停用，请在用户节点管理中选择单个节点续费');
  }

  const toggleMatch = url.pathname.match(/^\/api\/customers\/([^/]+)\/toggle$/);
  if (toggleMatch && req.method === 'POST') {
    const customer = db.customers.find((item) => item.id === toggleMatch[1]);
    if (!customer) return sendError(res, 404, '用户不存在');
    customer.status = customer.status === 'disabled' ? 'active' : 'disabled';
    customer.updatedAt = nowIso();
    const detail = { status: customer.status, warnings: [] };
    try {
      detail.nodes = await syncAllCustomerNodes(db, customer, customer.status === 'disabled' ? 'disable' : 'upsert');
    } catch (error) {
      detail.warnings.push(`本地状态已修改，但同步远程节点失败：${error.message}`);
    }
    const status = detail.warnings.length ? 'warning' : 'success';
    addLog(db, customer.id, 'status', status, customer.status === 'disabled' ? '用户已停用' : '用户已启用', detail);
    const syncLog = db.syncLogs[db.syncLogs.length - 1];
    await mysqlTransaction(async (connection) => {
      await updateMysqlCustomerRow(connection, customer);
      await insertMysqlLog(connection, syncLog);
    });
    return send(res, 200, { ok: true, data: publicDb(db), detail, warning: detail.warnings.join('；') });
  }

  const syncMatch = url.pathname.match(/^\/api\/customers\/([^/]+)\/sync$/);
  if (syncMatch && req.method === 'POST') {
    const customer = db.customers.find((item) => item.id === syncMatch[1]);
    if (!customer) return sendError(res, 404, '用户不存在');
    try {
      const results = await syncAllCustomerNodes(db, customer, customer.status === 'disabled' ? 'disable' : 'upsert');
      addLog(db, customer.id, 'sync', 'success', `已同步 ${results.length} 个用户节点`, { nodes: results });
      const syncLog = db.syncLogs[db.syncLogs.length - 1];
      await mysqlTransaction(async (connection) => {
        await updateMysqlCustomerRow(connection, customer);
        await insertMysqlLog(connection, syncLog);
      });
      return send(res, 200, { ok: true, data: publicDb(db), detail: { nodes: results } });
    } catch (error) {
      addLog(db, customer.id, 'sync', 'failed', error.message);
      const syncLog = db.syncLogs[db.syncLogs.length - 1];
      await mysqlTransaction((connection) => insertMysqlLog(connection, syncLog));
      return sendError(res, error.statusCode || 500, '同步失败', error.message);
    }
  }

  if (url.pathname === '/api/maintenance/disable-expired' && req.method === 'POST') {
    try {
      const detail = await runCustomerNodeMaintenanceUnlocked({ remote: false });
      return send(res, 200, { ok: true, count: detail.count || 0, data: publicDb(await readDb()), detail, warning: (detail.warnings || []).join('; ') });
    } catch (error) {
      return sendError(res, error.statusCode || 500, 'maintenance failed', error.message);
    }
    let count = 0;
    const warnings = [];
    const changedBindings = [];
    for (const binding of db.customerNodes) {
      if (binding.status === 'disabled' || !binding.expireAt || new Date(binding.expireAt) >= new Date()) continue;
      const customer = db.customers.find((item) => item.id === binding.customerId);
      if (!customer) continue;
      const changedBinding = { ...binding, status: 'disabled', updatedAt: nowIso() };
      const syncDb = { ...db, customerNodes: db.customerNodes.map((item) => item.id === changedBinding.id ? changedBinding : item) };
      const detail = { status: changedBinding.status, reason: 'expired', customerNodeId: binding.id, warnings: [] };
      try {
        const syncDetail = await syncCustomerNodeToRemote(syncDb, customer, changedBinding, 'disable');
        detail.clientResult = syncDetail.clientResult;
        detail.socksResult = syncDetail.socksResult;
        detail.serviceNodeResult = syncDetail.serviceNodeResult;
      } catch (error) {
        const message = `${customer.name || customer.id} / ${binding.name || binding.id} 同步失败：${error.message}`;
        detail.warnings.push(message);
        warnings.push(message);
      }
      changedBindings.push(changedBinding);
      addLog(db, customer.id, 'status', detail.warnings.length ? 'warning' : 'success', '过期用户节点已自动停用', detail);
      count += 1;
    }
    db.customerNodes = db.customerNodes.map((item) => changedBindings.find((binding) => binding.id === item.id) || item);
    const logs = db.syncLogs.slice(-count);
    await mysqlTransaction(async (connection) => {
      for (const binding of changedBindings) await upsertMysqlCustomerNodeRow(connection, binding);
      for (const log of logs) await insertMysqlLog(connection, log);
    });
    return send(res, 200, { ok: true, count, data: publicDb(db), warning: warnings.join('；') });
  }

  if (url.pathname === '/api/test-xui' && req.method === 'POST') {
    const body = await parseJson(req);
    const existing = body.id ? db.xuiServers.find((item) => item.id === body.id) : {};
    const server = normalizeServer(body, existing || {});
    try {
      const inbounds = await listXuiInbounds(server);
      const ids = inbounds.items.map(inboundLabel).join(', ');
      const message = ids
        ? `3x-ui 节点连接成功，可用入站 ID：${ids}`
        : `3x-ui 节点连接成功，但没有读取到入站。请先在 3x-ui 创建入站。接口：${inbounds.endpoint}`;
      return send(res, 200, { ok: true, message, endpoint: inbounds.endpoint, inbounds: inbounds.items, detail: inbounds.raw });
    } catch (error) {
      return sendError(res, error.statusCode || 500, '连接失败', error.message);
    }
  }

  const debugXrayMatch = url.pathname.match(/^\/api\/debug-xray-template\/([^/]+)$/);
  if (debugXrayMatch && req.method === 'GET') {
    const server = db.xuiServers.find((item) => item.id === debugXrayMatch[1]);
    if (!server) return sendError(res, 404, '3x-ui 节点不存在');
    try {
      const result = await xuiRequest(server, withApiPrefix(server, '/panel/api/xray/'), { method: 'POST' });
      return send(res, 200, { ok: true, data: xrayTemplateDebug(result.data) });
    } catch (error) {
      return sendError(res, error.statusCode || 500, '读取 Xray 模板失败', error.message);
    }
  }

  sendError(res, 404, 'API 不存在');
}

async function serveStatic(req, res, url) {
  let requestPath;
  try {
    requestPath = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
    return res.end('Bad request');
  }
  const isAdminPage = requestPath === adminPath() || requestPath === `${adminPath()}/`;
  const isPaymentResultPage = requestPath === '/payment/result' || requestPath === '/payment/result/';
  const filePath = requestPath === '/' || isAdminPage || isPaymentResultPage ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, requestPath);
  const normalized = path.resolve(filePath);
  const relative = path.relative(PUBLIC_DIR, normalized);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
    return res.end('Forbidden');
  }
  try {
    const ext = path.extname(normalized).toLowerCase();
    const type = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png'
    }[ext] || 'application/octet-stream';
    let data = await fs.readFile(normalized);
    if (ext === '.html') {
      const entry = isAdminPage ? 'admin' : 'user';
      const scriptSrc = entry === 'admin' ? '/app.js?v=20260709-payment-editor-v1' : '/user.js?v=20260709-payment-editor-v1';
      data = Buffer.from(data.toString('utf8')
        .replace(/<body([^>]*)data-entry="[^"]*"/, `<body$1data-entry="${entry}"`)
        .replace(/<script type="module" src="[^"]+"><\/script>/, `<script type="module" src="${scriptSrc}"></script>`), 'utf8');
    }
    res.writeHead(200, securityHeaders({ 'Content-Type': type, 'Cache-Control': 'no-store' }));
    res.end(data);
  } catch {
    res.writeHead(404, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await routeApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    return sendError(res, error.statusCode || 500, '服务器错误', error.message);
  }
});

server.requestTimeout = 30 * 1000;
server.headersTimeout = 35 * 1000;
server.keepAliveTimeout = 5 * 1000;

await initStorage();
await initSessionStore();
if (!setupRequired) startCustomerNodeMaintenance();

server.listen(PORT, () => {
  console.log(`十夜管理系统 listening on http://127.0.0.1:${PORT}`);
  console.log(`用户入口：http://127.0.0.1:${PORT}/`);
  console.log(`管理员入口：http://127.0.0.1:${PORT}${adminPath()}`);
  console.log('数据存储：MySQL');
  console.log(`Session 存储：${redisClient ? 'Redis' : '内存'}`);
  console.log('默认账号 admin / admin123，公网部署建议在账号安全里修改密码。');
});
