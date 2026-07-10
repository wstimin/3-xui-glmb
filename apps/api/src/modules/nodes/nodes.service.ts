import { Injectable, NotFoundException } from '@nestjs/common';
import { customerNodeCreateSchema, serviceNodeUpsertSchema, xuiServerUpsertSchema } from '@shiye/shared';
import type { z } from 'zod';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from '../security/encryption.service.js';
import { XuiService } from '../xui/xui.service.js';

@Injectable()
export class NodesService {
  constructor(private readonly prisma: PrismaService, private readonly encryption: EncryptionService, private readonly xui: XuiService) {}

  async listServers() {
    const servers = await this.prisma.xuiServer.findMany({ orderBy: { createdAt: 'desc' } });
    return servers.map(maskXuiServer);
  }

  async createServer(input: z.infer<typeof xuiServerUpsertSchema>) {
    const server = await this.prisma.xuiServer.create({
      data: {
        name: input.name,
        baseUrl: input.baseUrl,
        basePath: input.basePath || null,
        username: input.username || null,
        passwordEnc: this.encryption.encryptNullable(input.password),
        tokenEnc: this.encryption.encryptNullable(input.token),
        enabled: input.enabled,
        remark: input.remark || null
      }
    });
    return maskXuiServer(server);
  }

  async updateServer(id: string, input: Partial<z.infer<typeof xuiServerUpsertSchema>>) {
    await this.ensureServer(id);
    const server = await this.prisma.xuiServer.update({
      where: { id },
      data: {
        name: input.name,
        baseUrl: input.baseUrl,
        basePath: input.basePath === undefined ? undefined : input.basePath || null,
        username: input.username === undefined ? undefined : input.username || null,
        passwordEnc: input.password === undefined ? undefined : this.encryption.encryptNullable(input.password),
        tokenEnc: input.token === undefined ? undefined : this.encryption.encryptNullable(input.token),
        enabled: input.enabled,
        remark: input.remark === undefined ? undefined : input.remark || null
      }
    });
    return maskXuiServer(server);
  }

  async deleteServer(id: string) {
    await this.ensureServer(id);
    await this.prisma.xuiServer.delete({ where: { id } });
    return { deleted: true, id };
  }

  listServiceNodes() {
    return this.prisma.serviceNode.findMany({
      orderBy: { createdAt: 'desc' },
      include: { server: { select: { id: true, name: true, baseUrl: true, enabled: true } } }
    });
  }

  async createServiceNode(input: z.infer<typeof serviceNodeUpsertSchema>) {
    await this.ensureServer(input.serverId);
    return this.prisma.serviceNode.create({
      data: {
        serverId: input.serverId,
        name: input.name,
        inboundId: input.inboundId || null,
        protocol: input.protocol,
        priceMonthly: new Prisma.Decimal(input.priceMonthly),
        trafficLimitGb: new Prisma.Decimal(input.trafficLimitGb),
        enabled: input.enabled,
        remark: input.remark || null
      },
      include: { server: { select: { id: true, name: true, baseUrl: true, enabled: true } } }
    });
  }

  async updateServiceNode(id: string, input: Partial<z.infer<typeof serviceNodeUpsertSchema>>) {
    await this.ensureServiceNode(id);
    if (input.serverId) await this.ensureServer(input.serverId);
    return this.prisma.serviceNode.update({
      where: { id },
      data: {
        serverId: input.serverId,
        name: input.name,
        inboundId: input.inboundId === undefined ? undefined : input.inboundId || null,
        protocol: input.protocol,
        priceMonthly: input.priceMonthly === undefined ? undefined : new Prisma.Decimal(input.priceMonthly),
        trafficLimitGb: input.trafficLimitGb === undefined ? undefined : new Prisma.Decimal(input.trafficLimitGb),
        enabled: input.enabled,
        remark: input.remark === undefined ? undefined : input.remark || null
      },
      include: { server: { select: { id: true, name: true, baseUrl: true, enabled: true } } }
    });
  }

  async deleteServiceNode(id: string) {
    await this.ensureServiceNode(id);
    await this.xui.deleteServiceNodeClients(id);
    await this.prisma.$transaction([
      this.prisma.customerNode.deleteMany({ where: { serviceNodeId: id } }),
      this.prisma.serviceNode.delete({ where: { id } })
    ]);
    return { deleted: true, id };
  }

  async listUserNodes(customerId: string) {
    const nodes = await this.prisma.customerNode.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      include: {
        serviceNode: {
          include: { server: { select: { id: true, name: true, baseUrl: true } } }
        }
      }
    });
    return Promise.all(nodes.map(async (node) => {
      const links = await this.xui.customerNodeLinks(customerId, node.id).catch(() => [] as string[]);
      return { ...node, links, subId: node.config && typeof node.config === 'object' && !Array.isArray(node.config) ? (node.config as Record<string, unknown>).subId : node.xuiEmail };
    }));
  }

  async bindCustomerNode(customerId: string, input: z.infer<typeof customerNodeCreateSchema>) {
    const [customer, serviceNode] = await Promise.all([
      this.prisma.customer.findUnique({ where: { id: customerId } }),
      this.prisma.serviceNode.findUnique({ where: { id: input.serviceNodeId } })
    ]);
    if (!customer) throw new NotFoundException('用户不存在');
    if (!serviceNode) throw new NotFoundException('服务节点不存在');

    const xuiEmail = input.xuiEmail || `${customer.loginUsername}-${serviceNode.id.slice(0, 6)}@shiye.local`;
    const node = await this.prisma.customerNode.create({
      data: {
        customerId,
        serviceNodeId: input.serviceNodeId,
        xuiEmail,
        uuid: input.uuid || crypto.randomUUID(),
        expireAt: input.expireAt || null,
        trafficLimitGb: new Prisma.Decimal(input.trafficLimitGb ?? serviceNode.trafficLimitGb),
        status: 'active'
      },
      include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
    });
    try {
      await this.xui.syncCustomerNode(customerId, node.id);
    } catch (error) {
      await this.prisma.customerNode.delete({ where: { id: node.id } }).catch(() => undefined);
      throw error;
    }

    return this.prisma.customerNode.findUnique({
      where: { id: node.id },
      include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
    });
  }

  async unbindCustomerNode(customerId: string, customerNodeId: string) {
    const node = await this.prisma.customerNode.findFirst({ where: { id: customerNodeId, customerId }, select: { id: true } });
    if (!node) throw new NotFoundException('用户节点不存在');
    await this.xui.deleteCustomerNode(customerId, customerNodeId);
    await this.prisma.customerNode.delete({ where: { id: customerNodeId } });
    return { deleted: true, id: customerNodeId };
  }

  private async ensureServer(id: string) {
    const exists = await this.prisma.xuiServer.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('3x-ui 服务器不存在');
  }

  private async ensureServiceNode(id: string) {
    const exists = await this.prisma.serviceNode.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('服务节点不存在');
  }
}

function maskXuiServer<T extends { passwordEnc: string | null; tokenEnc: string | null }>(server: T) {
  const { passwordEnc, tokenEnc, ...safe } = server;
  return { ...safe, hasPassword: Boolean(passwordEnc), hasToken: Boolean(tokenEnc) };
}
