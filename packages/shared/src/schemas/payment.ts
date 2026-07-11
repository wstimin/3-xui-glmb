import { z } from 'zod';
import { moneySchema } from './common.js';

export const paymentProviderSchema = z.enum(['alipay', 'wechat', 'epay', 'bepusdt']);

export const paymentChannelProviderSchema = z.enum(['alipay', 'wechat', 'epay', 'bepusdt']);

export const paymentChannelConfigSchema = z.object({
  url: z.string().trim().url().optional().or(z.literal('')),
  pid: z.string().trim().max(120).optional().or(z.literal('')),
  key: z.string().trim().max(2048).optional().or(z.literal('')),
  token: z.string().trim().max(2048).optional().or(z.literal('')),
  appId: z.string().trim().max(120).optional().or(z.literal('')),
  privateKey: z.string().trim().max(12000).optional().or(z.literal('')),
  publicKey: z.string().trim().max(12000).optional().or(z.literal('')),
  productName: z.string().trim().max(120).optional().or(z.literal('')),
  mchId: z.string().trim().max(120).optional().or(z.literal('')),
  apiKey: z.string().trim().max(2048).optional().or(z.literal('')),
  type: z.string().trim().max(80).optional().or(z.literal('')),
  types: z.array(z.string().trim().max(80)).optional(),
  notifyUrl: z.string().trim().url().optional().or(z.literal('')),
  returnUrl: z.string().trim().url().optional().or(z.literal(''))
});

export const paymentChannelUpsertSchema = z.object({
  provider: paymentChannelProviderSchema,
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(false),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
  config: paymentChannelConfigSchema.default({})
});

export const rechargeOrderCreateSchema = z.object({
  provider: paymentChannelProviderSchema,
  amount: moneySchema,
  channelId: z.string().min(1).optional(),
  paymentType: z.string().trim().max(80).optional().or(z.literal('')),
  returnUrl: z.string().url().optional()
});

export const cardRedeemSchema = z.object({
  code: z.string().trim().min(1).max(128)
});

export const cardGenerateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  amount: moneySchema,
  quantity: z.coerce.number().int().min(1).max(500),
  prefix: z.string().trim().max(16).optional(),
  templateId: z.string().trim().min(1).optional()
});

export const cardTemplateUpsertSchema = z.object({
  name: z.string().trim().min(1).max(120),
  amount: moneySchema,
  quantity: z.coerce.number().int().min(1).max(500).default(10),
  prefix: z.string().trim().max(16).optional().or(z.literal('')),
  enabled: z.boolean().default(true),
  remark: z.string().trim().max(500).optional().or(z.literal(''))
});
