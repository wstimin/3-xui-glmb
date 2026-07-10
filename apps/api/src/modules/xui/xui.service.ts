import { randomUUID } from 'node:crypto';
import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type AccountStatus } from '@prisma/client';
import { xuiServerUpsertSchema } from '@shiye/shared';
import type { z } from 'zod';
import { XuiClient } from '@shiye/xui-client';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from '../security/encryption.service.js';

type XuiServerConfig = {
  baseUrl: string;
  basePath?: string | null;
  tokenEnc?: string | null;
  username?: string | null;
  passwordEnc?: string | null;
};

type SyncOptions = {
  expireAt?: Date | null;
  status?: AccountStatus;
  trafficLimitGb?: Prisma.Decimal | number | string | null;
};

@Injectable()
export class XuiService {
  constructor(private readonly prisma: PrismaService, private readonly encryption: EncryptionService) {}

  async testConnection(input: z.infer<typeof xuiServerUpsertSchema>) {
    const client = await this.createAuthenticatedClient({
      baseUrl: input.baseUrl,
      tokenEnc: input.token,
      username: input.username,
      passwordEnc: input.password
    });

    const inbounds = await client.listInbounds();
    this.assertXuiSuccess(inbounds);
    return { connected: true, inbounds };
  }

  async syncCustomerNode(customerId: string, customerNodeId: string, options: SyncOptions = {}) {
    const customerNode = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      include: {
        customer: true,
        serviceNode: { include: { server: true } }
      }
    });
    if (!customerNode) throw new NotFoundException('用户节点不存在');

    const server = customerNode.serviceNode.server;
    const serverId = server.id;

    try {
      if (!server.enabled) throw new BadRequestException('3x-ui 服务器已停用');
      if (!customerNode.serviceNode.enabled) throw new BadRequestException('服务节点已停用');
      if (!customerNode.serviceNode.inboundId) throw new BadRequestException('服务节点缺少 3x-ui 入站 ID');

      const client = await this.createAuthenticatedClient(server);
      const rawInbounds = await client.listInbounds();
      this.assertXuiSuccess(rawInbounds);
      const inbounds = this.xuiArray(rawInbounds);
      const inboundId = customerNode.serviceNode.inboundId;
      const inbound = inbounds.find((item) => this.inboundIdOf(item) === inboundId);
      if (!inbound) {
        const knownIds = inbounds.map((item) => this.inboundIdOf(item)).filter(Boolean).join(', ') || '-';
        throw new BadRequestException(`3x-ui 入站 ${inboundId} 不存在，可用 ID: ${knownIds}`);
      }

      const uuid = customerNode.uuid || randomUUID();
      const xuiClient = this.buildXuiClient({
        uuid,
        email: customerNode.xuiEmail,
        enabled: (options.status || customerNode.status) === 'active',
        expireAt: options.expireAt === undefined ? customerNode.expireAt : options.expireAt,
        trafficLimitGb: options.trafficLimitGb ?? customerNode.trafficLimitGb
      });

      const existing = await this.findClient(client, customerNode.xuiEmail, inbounds);
      const route = existing.exists ? 'clients/update' : 'clients/add';
      const payload = existing.exists
        ? await client.updateClient(customerNode.xuiEmail, { ...xuiClient, inboundIds: [inboundId] })
        : await client.addClient({ client: xuiClient, inboundIds: [inboundId] });
      this.assertXuiSuccess(payload);
      const syncedAt = new Date();
      const updatedNode = await this.prisma.customerNode.update({
        where: { id: customerNode.id },
        data: { uuid, lastSyncedAt: syncedAt },
        include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
      });

      const detail = {
        customerId,
        customerNodeId,
        inboundId,
        xuiEmail: customerNode.xuiEmail,
        route,
        action: existing.exists ? 'update' : 'add',
        response: this.toJsonValue(payload)
      };
      await this.writeSyncLog(serverId, 'customer-node-sync', 'success', `Synced ${customerNode.xuiEmail}`, detail);
      return { synced: true, action: existing.exists ? 'update' : 'add', route, node: updatedNode, detail };
    } catch (error) {
      await this.writeSyncLog(serverId, 'customer-node-sync', 'failed', this.errorMessage(error), {
        customerId,
        customerNodeId,
        xuiEmail: customerNode.xuiEmail
      });
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      throw new BadGatewayException(`同步 3x-ui 失败：${this.errorMessage(error)}`);
    }
  }

  private async createAuthenticatedClient(config: XuiServerConfig) {
    const client = new XuiClient({
      baseUrl: config.baseUrl,
      basePath: config.basePath || undefined,
      auth: config.tokenEnc ? { kind: 'token', token: this.encryption.decrypt(config.tokenEnc) } : undefined
    });

    if (!config.tokenEnc && config.username && config.passwordEnc) {
      await client.login({ username: config.username, password: this.encryption.decrypt(config.passwordEnc) });
    }

    return client;
  }

  private buildXuiClient(input: { uuid: string; email: string; enabled: boolean; expireAt?: Date | null; trafficLimitGb: Prisma.Decimal | number | string | null }) {
    return {
      id: input.uuid,
      uuid: input.uuid,
      email: input.email,
      enable: input.enabled,
      expiryTime: input.expireAt ? input.expireAt.getTime() : 0,
      totalGB: this.gbToBytes(input.trafficLimitGb),
      limitIp: 0,
      flow: '',
      tgId: 0,
      subId: input.email,
      reset: 0
    };
  }

  private async findClient(client: XuiClient, email: string, inbounds: unknown[]) {
    try {
      const payload = await client.getClient(email);
      this.assertXuiSuccess(payload);
      const object = this.xuiObject(payload);
      const detailClient = this.xuiObject(object.client || object.clientStats || object.client_stat || object);
      if (this.clientEmailOf(detailClient) === email || this.clientEmailOf(object) === email) return { exists: true, raw: payload };
    } catch (error) {
      if (!/not found|record not found|404/i.test(this.errorMessage(error))) throw error;
    }

    for (const inbound of inbounds) {
      const settings = this.parseMaybeJson(this.xuiObject(inbound).settings);
      const settingsObject = this.xuiObject(settings);
      const clients = Array.isArray(settingsObject.clients) ? settingsObject.clients : [];
      if (clients.some((item: unknown) => this.clientEmailOf(item) === email)) return { exists: true, raw: inbound };
    }
    return { exists: false, raw: null };
  }

  private assertXuiSuccess(payload: unknown) {
    if (!payload || typeof payload !== 'object') return;
    const record = payload as Record<string, unknown>;
    if (record.success === false) throw new Error(String(record.msg || record.message || '3x-ui returned success=false'));
  }

  private xuiArray(data: unknown): unknown[] {
    if (Array.isArray(data)) return data;
    const object = this.xuiObject(data);
    for (const key of ['obj', 'data', 'result', 'items', 'inbounds', 'clients']) {
      const value = this.parseMaybeJson(object[key]);
      if (Array.isArray(value)) return value;
      if (value && typeof value === 'object') {
        for (const nestedKey of ['items', 'inbounds', 'clients']) {
          const nested = (value as Record<string, unknown>)[nestedKey];
          if (Array.isArray(nested)) return nested;
        }
      }
    }
    return [];
  }

  private xuiObject(data: unknown): Record<string, unknown> {
    const parsed = this.parseMaybeJson(data);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  }

  private parseMaybeJson(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private inboundIdOf(item: unknown) {
    const object = this.xuiObject(item);
    const value = Number(object.id ?? object.inboundId ?? object.inbound_id ?? object.value);
    return Number.isInteger(value) && value > 0 ? value : 0;
  }

  private clientEmailOf(item: unknown) {
    const object = this.xuiObject(item);
    return String(object.email || object.clientEmail || object.name || '').trim();
  }

  private gbToBytes(value: Prisma.Decimal | number | string | null) {
    if (value === null) return 0;
    const gb = Number(value);
    if (!Number.isFinite(gb) || gb <= 0) return 0;
    return Math.round(gb * 1024 * 1024 * 1024);
  }

  private async writeSyncLog(serverId: string | null, action: string, status: string, message: string, detail: unknown) {
    await this.prisma.syncLog.create({
      data: {
        serverId,
        action,
        status,
        message,
        detail: this.toJsonValue(detail)
      }
    }).catch(() => undefined);
  }

  private toJsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
