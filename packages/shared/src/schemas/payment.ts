import { z } from 'zod';
import { moneySchema } from './common.js';

export const paymentProviderSchema = z.enum(['alipay', 'wechat', 'epay', 'bepusdt']);

export const rechargeOrderCreateSchema = z.object({
  provider: paymentProviderSchema,
  amount: moneySchema,
  channelId: z.string().min(1).optional(),
  returnUrl: z.string().url().optional()
});

export const cardRedeemSchema = z.object({
  code: z.string().trim().min(1).max(128)
});

export const cardGenerateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  amount: moneySchema,
  quantity: z.coerce.number().int().min(1).max(500),
  prefix: z.string().trim().max(16).optional()
});
