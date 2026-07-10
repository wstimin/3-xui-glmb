import { z } from 'zod';
import { moneySchema } from './common.js';

export const customerStatusSchema = z.enum(['active', 'disabled']);

export const customerUpsertSchema = z.object({
  name: z.string().trim().min(1).max(80),
  loginUsername: z.string().trim().min(1).max(80),
  loginPassword: z.string().min(6).max(256).optional(),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional(),
  balance: moneySchema.default(0),
  status: customerStatusSchema.default('active'),
  remark: z.string().trim().max(500).optional()
});

export const balanceAdjustSchema = z.object({
  mode: z.enum(['add', 'subtract', 'set']),
  amount: moneySchema,
  remark: z.string().trim().max(500).optional()
});
