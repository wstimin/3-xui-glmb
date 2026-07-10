import { createHash, createVerify, randomBytes, timingSafeEqual } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PaymentProvider, Prisma } from '@prisma/client';
import { paymentChannelUpsertSchema } from '@shiye/shared';
import type { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from '../security/encryption.service.js';

type NotifyInput = {
  provider: string;
  query: Record<string, unknown>;
  body: unknown;
};

type PaymentConfig = Record<string, unknown>;
type PaymentChannelInput = z.infer<typeof paymentChannelUpsertSchema>;

type VerifiedNotify = {
  tradeNo: string;
  amount?: string | number | null;
  callbackNo?: string | null;
  idempotencyKey?: string | null;
  raw: unknown;
};

type CreatePaymentResult = {
  payUrl?: string | null;
  qrCode?: string | null;
  raw?: unknown;
};

@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PrismaService, private readonly encryption: EncryptionService) {}

  async publicChannels() {
    const channels = await this.prisma.paymentChannel.findMany({
      where: { enabled: true, provider: { in: ['epay', 'bepusdt'] } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
    });
    return channels.map((channel) => ({
      id: channel.id,
      provider: channel.provider,
      name: channel.name
    }));
  }

  async adminChannels() {
    const channels = await this.prisma.paymentChannel.findMany({
      where: { provider: { in: ['epay', 'bepusdt'] } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
    });
    return channels.map((channel) => this.maskChannel(channel));
  }

  async createChannel(input: PaymentChannelInput) {
    this.assertImplementedProvider(input.provider);
    const config = this.prepareChannelConfig(input.provider, input.config || {});
    if (input.enabled) this.assertChannelReady(input.provider, config);

    const channel = await this.prisma.paymentChannel.create({
      data: {
        provider: input.provider,
        name: input.name,
        enabled: input.enabled,
        sortOrder: input.sortOrder,
        configEnc: toJsonValue(config)
      }
    });
    return this.maskChannel(channel);
  }

  async updateChannel(id: string, input: Partial<PaymentChannelInput>) {
    const current = await this.prisma.paymentChannel.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('支付通道不存在');

    const provider = input.provider || current.provider;
    this.assertImplementedProvider(provider);
    const currentConfig = this.configObject(current.configEnc);
    const nextConfig = input.config === undefined
      ? currentConfig
      : this.prepareChannelConfig(provider, input.config, currentConfig);
    const enabled = input.enabled ?? current.enabled;
    if (enabled) this.assertChannelReady(provider, nextConfig);

    const channel = await this.prisma.paymentChannel.update({
      where: { id },
      data: {
        provider,
        name: input.name,
        enabled: input.enabled,
        sortOrder: input.sortOrder,
        configEnc: input.config === undefined ? undefined : toJsonValue(nextConfig)
      }
    });
    return this.maskChannel(channel);
  }

  async deleteChannel(id: string) {
    const current = await this.prisma.paymentChannel.findUnique({ where: { id }, select: { id: true } });
    if (!current) throw new NotFoundException('支付通道不存在');
    await this.prisma.paymentChannel.delete({ where: { id } });
    return { deleted: true, id };
  }

  async createOrder(customerId: string, body: { provider?: string; channelId?: string; amount: unknown; returnUrl?: string }) {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId }, select: { id: true, status: true } });
    if (!customer || customer.status !== 'active') throw new BadRequestException('用户不存在或已禁用');

    const provider = this.parseProvider(body.provider || '');
    const channel = body.channelId
      ? await this.prisma.paymentChannel.findFirst({ where: { id: body.channelId, provider, enabled: true } })
      : await this.prisma.paymentChannel.findFirst({ where: { provider, enabled: true }, orderBy: { sortOrder: 'asc' } });
    if (!channel) throw new ServiceUnavailableException('该支付通道未启用');

    const amount = money(body.amount);
    if (amount.lessThanOrEqualTo(0)) throw new BadRequestException('充值金额必须大于 0');

    const config = this.configObject(channel.configEnc);
    const tradeNo = this.tradeNo();
    const payment = this.createPayment(provider, config, {
      tradeNo,
      amount,
      returnUrl: body.returnUrl,
      subject: '账户余额充值'
    });

    const order = await this.prisma.rechargeOrder.create({
      data: {
        tradeNo,
        customerId,
        channelId: channel.id,
        provider,
        amount,
        status: 'pending',
        payUrl: payment.payUrl || null,
        qrCode: payment.qrCode || null,
        rawPayload: toJsonValue(payment.raw || null)
      }
    });

    return { order, payUrl: payment.payUrl || null, qrCode: payment.qrCode || null };
  }

  async notify(input: NotifyInput) {
    const provider = this.parseProvider(input.provider);
    const params = mergeParams(input.query, input.body);
    const order = await this.prisma.rechargeOrder.findUnique({ where: { tradeNo: String(params.out_trade_no || params.trade_no || params.order_id || '').trim() }, include: { channel: true } });
    if (!order) throw new NotFoundException('充值订单不存在');
    if (order.provider !== provider) throw new BadRequestException('支付通道不匹配');

    const channel = order.channel || await this.prisma.paymentChannel.findFirst({ where: { provider, enabled: true }, orderBy: { sortOrder: 'asc' } });
    if (!channel || !channel.enabled) throw new ServiceUnavailableException('支付通道未启用');

    const config = this.configObject(channel.configEnc);
    const verified = this.verifyByProvider(provider, params, config);
    if (verified.tradeNo !== order.tradeNo) throw new BadRequestException('充值订单号不匹配');

    const result = await this.completeRechargeOrder(order.tradeNo, provider, verified);
    return this.notifyText(provider, result.ok ? 'success' : 'fail');
  }

  async result(tradeNo: string) {
    const order = await this.prisma.rechargeOrder.findUnique({ where: { tradeNo }, select: { tradeNo: true, status: true, amount: true, paidAt: true, payUrl: true, qrCode: true } });
    if (!order) throw new NotFoundException('充值订单不存在');
    return order;
  }

  private verifyByProvider(provider: PaymentProvider, params: Record<string, unknown>, config: PaymentConfig): VerifiedNotify {
    if (provider === 'epay') return this.verifyEpay(params, config);
    if (provider === 'bepusdt') return this.verifyBepusdt(params, config);
    if (provider === 'alipay') return this.verifyAlipay(params, config);
    if (provider === 'wechat') return this.verifyWechatV2(params, config);
    throw new BadRequestException('不支持的支付通道');
  }

  private createPayment(provider: PaymentProvider, config: PaymentConfig, order: { tradeNo: string; amount: Prisma.Decimal; subject: string; returnUrl?: string }): CreatePaymentResult {
    if (provider === 'epay') return this.createEpayPayment(config, order);
    if (provider === 'bepusdt') return this.createBepusdtPayment(config, order);
    throw new ServiceUnavailableException('该支付通道暂未实现下单接口');
  }

  private createEpayPayment(config: PaymentConfig, order: { tradeNo: string; amount: Prisma.Decimal; subject: string; returnUrl?: string }): CreatePaymentResult {
    const gateway = submitUrl(text(config.url || config.gateway));
    const pid = text(config.pid);
    const key = this.secret(config, 'key', 'merchantKey', 'merchantKeyEnc');
    if (!gateway || !pid || !key) throw new ServiceUnavailableException('易支付通道配置不完整');
    const params: Record<string, string> = {
      pid,
      type: text(config.type) || 'alipay',
      out_trade_no: order.tradeNo,
      notify_url: this.paymentUrl(text(config.notifyUrl), `/api/payments/epay/notify`),
      return_url: this.paymentUrl(order.returnUrl || text(config.returnUrl), `/payment/result?trade_no=${encodeURIComponent(order.tradeNo)}`),
      name: order.subject,
      money: order.amount.toFixed(2)
    };
    params.sign = md5(sortedSignContent(params, ['sign', 'sign_type']) + key);
    params.sign_type = 'MD5';
    return { payUrl: `${gateway}?${new URLSearchParams(params).toString()}`, raw: { request: params } };
  }

  private createBepusdtPayment(config: PaymentConfig, order: { tradeNo: string; amount: Prisma.Decimal; subject: string; returnUrl?: string }): CreatePaymentResult {
    const gateway = submitUrl(text(config.appUrl || config.url || config.gateway));
    const token = this.secret(config, 'token', 'key', 'tokenEnc');
    if (!gateway || !token) throw new ServiceUnavailableException('BEpusdt 通道配置不完整');
    const params: Record<string, string> = {
      pid: text(config.pid) || '1000',
      type: text(config.type || config.tradeType) || 'usdt.trc20',
      out_trade_no: order.tradeNo,
      notify_url: this.paymentUrl(text(config.notifyUrl), `/api/payments/bepusdt/notify`),
      return_url: this.paymentUrl(order.returnUrl || text(config.returnUrl), `/payment/result?trade_no=${encodeURIComponent(order.tradeNo)}`),
      name: order.subject,
      money: order.amount.toFixed(2)
    };
    params.sign = md5(sortedSignContent(params, ['sign', 'signature', 'sign_type']) + token);
    params.sign_type = 'MD5';
    return { payUrl: `${gateway}?${new URLSearchParams(params).toString()}`, raw: { request: params } };
  }

  private verifyEpay(params: Record<string, unknown>, config: PaymentConfig): VerifiedNotify {
    const key = this.secret(config, 'key', 'merchantKey', 'merchantKeyEnc');
    const sign = text(params.sign);
    if (!key || !sign || md5(sortedSignContent(params, ['sign', 'sign_type']) + key) !== sign) throw new BadRequestException('易支付回调验签失败');
    if (text(params.pid) !== text(config.pid)) throw new BadRequestException('易支付商户号不匹配');
    const status = text(params.trade_status).toUpperCase();
    if (status && status !== 'TRADE_SUCCESS') throw new BadRequestException('易支付订单未支付成功');
    return {
      tradeNo: text(params.out_trade_no),
      amount: numberOrText(params.money),
      callbackNo: text(params.trade_no || params.api_trade_no),
      idempotencyKey: text(params.trade_no || params.api_trade_no || params.out_trade_no),
      raw: params
    };
  }

  private verifyBepusdt(params: Record<string, unknown>, config: PaymentConfig): VerifiedNotify {
    const token = this.secret(config, 'token', 'key', 'tokenEnc');
    const sign = text(params.sign || params.signature);
    if (!token || !sign || md5(sortedSignContent(params, ['sign', 'signature', 'sign_type']) + token) !== sign) throw new BadRequestException('BEpusdt 回调验签失败');
    const status = text(params.trade_status || params.status).toUpperCase();
    if (status && status !== 'TRADE_SUCCESS' && status !== '2') throw new BadRequestException('BEpusdt 订单未支付成功');
    return {
      tradeNo: text(params.out_trade_no || params.order_id),
      amount: numberOrText(params.money || params.amount),
      callbackNo: text(params.trade_no || params.trade_id),
      idempotencyKey: text(params.trade_no || params.trade_id || params.out_trade_no || params.order_id),
      raw: params
    };
  }

  private verifyAlipay(params: Record<string, unknown>, config: PaymentConfig): VerifiedNotify {
    const publicKey = this.secret(config, 'publicKey', 'alipayPublicKey', 'alipayPublicKeyEnc');
    const sign = text(params.sign);
    if (!publicKey || !sign || !verifyRsaSha256(sortedSignContent(params, ['sign', 'sign_type']), sign, publicKey)) throw new BadRequestException('支付宝回调验签失败');
    if (text(params.app_id) !== text(config.appId || config.app_id)) throw new BadRequestException('支付宝 AppID 不匹配');
    if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(text(params.trade_status))) throw new BadRequestException('支付宝订单未支付成功');
    return {
      tradeNo: text(params.out_trade_no),
      amount: numberOrText(params.total_amount || params.receipt_amount),
      callbackNo: text(params.trade_no),
      idempotencyKey: text(params.trade_no || params.out_trade_no),
      raw: params
    };
  }

  private verifyWechatV2(params: Record<string, unknown>, config: PaymentConfig): VerifiedNotify {
    const key = this.secret(config, 'key', 'merchantKey', 'apiKey', 'apiV2Key', 'apiV2KeyEnc');
    const sign = text(params.sign);
    if (!key || !sign || md5(sortedSignContent(params, ['sign']) + `&key=${key}`).toUpperCase() !== sign.toUpperCase()) throw new BadRequestException('微信支付回调验签失败');
    if (text(params.return_code) !== 'SUCCESS' || text(params.result_code) !== 'SUCCESS') throw new BadRequestException('微信支付订单未支付成功');
    const amount = params.total_fee === undefined ? undefined : Number(params.total_fee) / 100;
    return {
      tradeNo: text(params.out_trade_no),
      amount,
      callbackNo: text(params.transaction_id),
      idempotencyKey: text(params.transaction_id || params.out_trade_no),
      raw: params
    };
  }

  private async completeRechargeOrder(tradeNo: string, provider: PaymentProvider, detail: VerifiedNotify) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.rechargeOrder.findUnique({ where: { tradeNo } });
      if (!order) throw new NotFoundException('充值订单不存在');

      await tx.paymentCallback.create({
        data: {
          orderId: order.id,
          provider,
          tradeNo,
          verified: true,
          idempotencyKey: detail.idempotencyKey || `${provider}:${tradeNo}`,
          payload: toJsonValue(detail.raw)
        }
      }).catch((error: unknown) => {
        if (isUniqueError(error)) return undefined;
        throw error;
      });

      if (order.status === 'paid') return { ok: true, duplicate: true };
      if (order.status !== 'pending') throw new BadRequestException('充值订单当前不可支付');
      if (detail.amount !== undefined && detail.amount !== null && money(detail.amount).comparedTo(order.amount) !== 0) throw new BadRequestException('支付金额不匹配');

      const customer = await tx.customer.findUnique({ where: { id: order.customerId } });
      if (!customer || customer.status !== 'active') throw new BadRequestException('用户不存在或已禁用');

      const beforeBalance = new Prisma.Decimal(customer.balance);
      const amount = new Prisma.Decimal(order.amount);
      const afterBalance = beforeBalance.plus(amount);

      await tx.customer.update({ where: { id: customer.id }, data: { balance: afterBalance } });
      const paidOrder = await tx.rechargeOrder.update({
        where: { id: order.id },
        data: {
          status: 'paid',
          paidAt: new Date(),
          rawPayload: toJsonValue({ notify: detail.raw, callbackNo: detail.callbackNo || null })
        }
      });
      await tx.balanceLog.create({
        data: {
          customerId: customer.id,
          type: 'recharge',
          amount,
          beforeBalance,
          afterBalance,
          operator: 'online-payment',
          remark: `在线充值 ${tradeNo}`,
          detail: toJsonValue({ orderId: order.id, tradeNo, provider, callbackNo: detail.callbackNo || null })
        }
      });

      return { ok: true, duplicate: false, order: paidOrder };
    });
  }

  private parseProvider(value: string): PaymentProvider {
    const normalized = value === 'epusdt' ? 'bepusdt' : value;
    if (['alipay', 'wechat', 'epay', 'bepusdt'].includes(normalized)) return normalized as PaymentProvider;
    throw new BadRequestException('不支持的支付通道');
  }

  private assertImplementedProvider(provider: PaymentProvider) {
    if (provider !== 'epay' && provider !== 'bepusdt') throw new BadRequestException('该支付通道暂未实现下单接口');
  }

  private prepareChannelConfig(provider: PaymentProvider, input: PaymentChannelInput['config'], previous: PaymentConfig = {}) {
    const config: PaymentConfig = {
      url: text(input.url),
      pid: text(input.pid),
      type: text(input.type),
      notifyUrl: text(input.notifyUrl),
      returnUrl: text(input.returnUrl)
    };

    const key = text(input.key);
    const token = text(input.token);
    if (provider === 'epay') {
      config.key = key ? this.encryption.encrypt(key) : previous.key || '';
    }
    if (provider === 'bepusdt') {
      config.token = token ? this.encryption.encrypt(token) : previous.token || '';
    }

    return compactConfig(config);
  }

  private assertChannelReady(provider: PaymentProvider, config: PaymentConfig) {
    if (provider === 'epay' && (!text(config.url) || !text(config.pid) || !this.secret(config, 'key'))) {
      throw new BadRequestException('易支付启用前必须填写接口地址、商户号和密钥');
    }
    if (provider === 'bepusdt' && (!text(config.url) || !this.secret(config, 'token'))) {
      throw new BadRequestException('BEpusdt 启用前必须填写接口地址和 Token');
    }
  }

  private maskChannel(channel: { id: string; provider: PaymentProvider; name: string; enabled: boolean; sortOrder: number; configEnc: Prisma.JsonValue; createdAt: Date; updatedAt: Date }) {
    const config = this.configObject(channel.configEnc);
    return {
      id: channel.id,
      provider: channel.provider,
      name: channel.name,
      enabled: channel.enabled,
      sortOrder: channel.sortOrder,
      config: {
        url: text(config.url),
        pid: text(config.pid),
        type: text(config.type),
        notifyUrl: text(config.notifyUrl),
        returnUrl: text(config.returnUrl)
      },
      hasKey: Boolean(text(config.key)),
      hasToken: Boolean(text(config.token)),
      notifyUrl: this.paymentUrl(text(config.notifyUrl), `/api/payments/${channel.provider}/notify`),
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt
    };
  }

  private configObject(value: Prisma.JsonValue): PaymentConfig {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as PaymentConfig : {};
  }

  private secret(config: PaymentConfig, ...keys: string[]) {
    for (const key of keys) {
      const value = text(config[key]);
      if (!value) continue;
      return this.encryption.decrypt(value);
    }
    return '';
  }

  private notifyText(provider: PaymentProvider, status: 'success' | 'fail') {
    if (provider === 'alipay') return status === 'success' ? 'success' : 'failure';
    if (provider === 'bepusdt') return status === 'success' ? 'ok' : 'fail';
    return status === 'success' ? 'success' : 'fail';
  }

  private paymentUrl(configured: string, fallbackPath: string) {
    if (configured) return configured;
    const siteUrl = (process.env.PUBLIC_WEB_URL || process.env.APP_URL || process.env.PUBLIC_SITE_URL || '').replace(/\/+$/, '');
    return siteUrl ? `${siteUrl}${fallbackPath}` : fallbackPath;
  }

  private tradeNo() {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    return `RC${stamp}${randomBytes(4).toString('hex').toUpperCase()}`;
  }
}

function mergeParams(query: Record<string, unknown>, body: unknown) {
  const bodyObject = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  return { ...query, ...bodyObject };
}

function sortedSignContent(params: Record<string, unknown>, excludes: string[]) {
  return Object.keys(params)
    .filter((key) => !excludes.includes(key) && params[key] !== undefined && params[key] !== null && params[key] !== '' && typeof params[key] !== 'object')
    .sort()
    .map((key) => `${key}=${text(params[key])}`)
    .join('&');
}

function md5(value: string) {
  return createHash('md5').update(value, 'utf8').digest('hex');
}

function verifyRsaSha256(content: string, sign: string, publicKey: string) {
  return createVerify('RSA-SHA256').update(content, 'utf8').verify(normalizePemKey(publicKey, 'PUBLIC KEY'), sign, 'base64');
}

function normalizePemKey(value: string, type: 'PUBLIC KEY' | 'PRIVATE KEY') {
  const trimmed = value.trim();
  if (trimmed.includes('-----BEGIN')) return trimmed;
  const body = trimmed.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') || trimmed;
  return `-----BEGIN ${type}-----\n${body}\n-----END ${type}-----`;
}

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function numberOrText(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;
  return text(value);
}

function money(value: unknown) {
  return new Prisma.Decimal(text(value) || '0').toDecimalPlaces(2);
}

function timingSafeTextEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function submitUrl(gateway: string) {
  const normalized = gateway.replace(/\/+$/, '');
  if (!normalized) return '';
  return /\/submit\.php$/i.test(normalized) ? normalized : `${normalized}/submit.php`;
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function compactConfig(config: PaymentConfig) {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function isUniqueError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
