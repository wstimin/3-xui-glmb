import { z } from 'zod';

export const xuiServerUpsertSchema = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().url(),
  username: z.string().trim().min(1).max(100).optional(),
  password: z.string().max(256).optional(),
  token: z.string().max(2048).optional(),
  enabled: z.boolean().default(true),
  remark: z.string().trim().max(500).optional()
});

export const serviceNodeUpsertSchema = z.object({
  name: z.string().trim().min(1).max(100),
  serverId: z.string().min(1),
  inboundId: z.coerce.number().int().optional(),
  protocol: z.string().trim().max(40).default('vless'),
  priceMonthly: z.coerce.number().finite().min(0).default(0),
  trafficLimitGb: z.coerce.number().finite().min(0).default(0),
  enabled: z.boolean().default(true),
  remark: z.string().trim().max(500).optional()
});

export const customerNodeCreateSchema = z.object({
  serviceNodeId: z.string().min(1),
  xuiEmail: z.string().trim().email().optional(),
  uuid: z.string().trim().max(80).optional(),
  expireAt: z.coerce.date().optional(),
  trafficLimitGb: z.coerce.number().finite().min(0).optional()
});

export const renewalSchema = z.object({
  months: z.coerce.number().int().min(1).max(36)
});

export const userRenewalSchema = renewalSchema.extend({
  nodeId: z.string().min(1)
});
