import { z } from 'zod';

export const serviceNodeProtocolValues = [
  'vless',
  'vmess',
  'trojan',
  'shadowsocks',
  'hysteria',
  'socks',
  'http',
  'mixed',
  'wireguard',
  'dokodemo',
  'tunnel'
] as const;

export const serviceNodeProtocolSchema = z.enum(serviceNodeProtocolValues);

export const serviceNodeEncryptionValues = [
  'none',
  'tls',
  'reality'
] as const;

export const serviceNodeEncryptionSchema = z.enum(serviceNodeEncryptionValues);

export const serviceNodeTransportValues = [
  'tcp',
  'kcp',
  'ws',
  'grpc',
  'httpupgrade',
  'xhttp',
  'hysteria'
] as const;

export const serviceNodeTransportSchema = z.enum(serviceNodeTransportValues);

export const serviceNodeTransportSettingsSchema = z.object({
  version: z.literal(2).optional(),
  acceptProxyProtocol: z.boolean().optional(),
  path: z.string().trim().max(2048).optional().or(z.literal('')),
  host: z.string().trim().max(255).optional().or(z.literal('')),
  headers: z.record(z.string(), z.string()).optional(),
  heartbeatPeriod: z.coerce.number().int().min(0).optional(),
  serviceName: z.string().trim().max(255).optional().or(z.literal('')),
  authority: z.string().trim().max(255).optional().or(z.literal('')),
  multiMode: z.boolean().optional(),
  mtu: z.coerce.number().int().min(576).max(1460).optional(),
  tti: z.coerce.number().int().min(10).max(100).optional(),
  uplinkCapacity: z.coerce.number().int().min(0).optional(),
  downlinkCapacity: z.coerce.number().int().min(0).optional(),
  cwndMultiplier: z.coerce.number().int().min(1).optional(),
  maxSendingWindow: z.coerce.number().int().min(0).optional(),
  mode: z.enum(['auto', 'packet-up', 'stream-up', 'stream-one']).optional(),
  xPaddingBytes: z.string().trim().max(120).optional().or(z.literal('')),
  scMaxBufferedPosts: z.coerce.number().int().min(0).optional(),
  scStreamUpServerSecs: z.string().trim().max(120).optional().or(z.literal('')),
  udpIdleTimeout: z.coerce.number().int().min(2).max(600).optional()
});

export const xuiServerUpsertSchema = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().url(),
  basePath: z.string().trim().max(120).optional(),
  username: z.string().trim().min(1).max(100).optional(),
  password: z.string().max(256).optional(),
  token: z.string().max(2048).optional(),
  tlsServerName: z.string().trim().max(255).optional().or(z.literal('')),
  tlsCertFile: z.string().trim().max(500).optional().or(z.literal('')),
  tlsKeyFile: z.string().trim().max(500).optional().or(z.literal('')),
  realityFingerprint: z.string().trim().max(40).optional().or(z.literal('')),
  realitySpiderX: z.string().trim().max(120).optional().or(z.literal('')),
  enabled: z.boolean().default(true),
  remark: z.string().trim().max(500).optional()
});

export const serviceNodeUpsertSchema = z.object({
  name: z.string().trim().min(1).max(100),
  serverId: z.string().min(1),
  remoteMode: z.enum(['create', 'bind']).default('create'),
  inboundId: z.coerce.number().int().optional(),
  inboundPort: z.coerce.number().int().min(1).max(65535).optional(),
  protocol: serviceNodeProtocolSchema.default('vless'),
  encryption: serviceNodeEncryptionSchema.default('none'),
  transport: serviceNodeTransportSchema.default('tcp'),
  transportSettings: serviceNodeTransportSettingsSchema.default({}),
  socksRelayEnabled: z.boolean().default(false),
  socksNodeId: z.string().trim().optional().or(z.literal('')),
  priceMonthly: z.coerce.number().finite().min(0).default(0),
  trafficLimitGb: z.coerce.number().finite().min(0).default(0),
  enabled: z.boolean().default(true),
  remark: z.string().trim().max(500).optional()
});

export const socksNodeUpsertSchema = z.object({
  name: z.string().trim().min(1).max(120),
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535),
  username: z.string().trim().max(120).optional(),
  password: z.string().max(256).optional(),
  enabled: z.boolean().default(true),
  remark: z.string().trim().max(500).optional()
});

export const customerNodeCreateSchema = z.object({
  serviceNodeId: z.string().min(1),
  xuiEmail: z.string().trim().min(1).max(160).optional().or(z.literal('')),
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
