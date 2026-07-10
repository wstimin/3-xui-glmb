import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { customerNodeCreateSchema, serviceNodeUpsertSchema, socksNodeUpsertSchema, xuiServerUpsertSchema } from '@shiye/shared';
import type { z } from 'zod';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from '../security/encryption.service.js';
import { XuiService } from '../xui/xui.service.js';

type ServiceNodeConfig = {
  encryption?: string;
  socksRelayEnabled?: boolean;
  socksNodeId?: string | null;
  remoteMode?: 'create' | 'bind';
  remoteManaged?: boolean;
  remoteInboundTag?: string;
  remoteInboundRemark?: string;
  remoteInboundPort?: number;
};

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
    const remoteMode = input.remoteMode || 'create';
    let inboundId = input.inboundId || null;
    let remoteCreated: { inboundId: number; port: number; tag: string; remark: string } | null = null;

    if (remoteMode === 'bind') {
      if (!inboundId) throw new BadRequestException('绑定已有入站时必须填写入站 ID');
      await this.xui.validateServiceNodeInbound(input.serverId, inboundId);
    } else {
      remoteCreated = await this.xui.createServiceNodeInbound({
        serverId: input.serverId,
        name: input.name,
        protocol: input.protocol,
        encryption: input.encryption,
        enabled: input.enabled,
        port: input.inboundPort,
        remark: input.remark || null
      });
      inboundId = remoteCreated.inboundId;
    }

    const config = await this.serviceNodeConfig(input, null, remoteCreated ? {
      remoteMode,
      remoteManaged: true,
      remoteInboundTag: remoteCreated.tag,
      remoteInboundRemark: remoteCreated.remark,
      remoteInboundPort: remoteCreated.port
    } : { remoteMode, remoteManaged: false, remoteInboundPort: input.inboundPort });

    try {
      const node = await this.prisma.serviceNode.create({
        data: {
          serverId: input.serverId,
          name: input.name,
          inboundId,
          protocol: input.protocol,
          config: this.toJsonValue(config),
          priceMonthly: new Prisma.Decimal(input.priceMonthly),
          trafficLimitGb: new Prisma.Decimal(input.trafficLimitGb),
          enabled: input.enabled,
          remark: input.remark || null
        },
        include: { server: { select: { id: true, name: true, baseUrl: true, enabled: true } } }
      });
      if (config.socksRelayEnabled) await this.xui.syncServiceNodeRemoteConfig(node.id);
      return node;
    } catch (error) {
      if (remoteCreated) await this.xui.deleteRemoteInbound(input.serverId, remoteCreated.inboundId).catch(() => undefined);
      throw error;
    }
  }

  async updateServiceNode(id: string, input: Partial<z.infer<typeof serviceNodeUpsertSchema>>) {
    const current = await this.ensureServiceNode(id);
    if (input.serverId) await this.ensureServer(input.serverId);
    const nextServerId = input.serverId || current.serverId;
    const previousConfig = jsonObject(current.config) as ServiceNodeConfig;
    const remoteMode = input.remoteMode || previousConfig.remoteMode || (current.inboundId ? 'bind' : 'create');
    let inboundId = input.inboundId === undefined ? current.inboundId : input.inboundId || null;
    let remoteCreated: { inboundId: number; port: number; tag: string; remark: string } | null = null;

    if (remoteMode === 'bind') {
      if (!inboundId) throw new BadRequestException('绑定已有入站时必须填写入站 ID');
      if (input.serverId || input.inboundId !== undefined) await this.xui.validateServiceNodeInbound(nextServerId, inboundId);
    } else if (!inboundId) {
      remoteCreated = await this.xui.createServiceNodeInbound({
        serverId: nextServerId,
        name: input.name || current.name,
        protocol: input.protocol || current.protocol,
        encryption: input.encryption || previousConfig.encryption || 'none',
        enabled: input.enabled ?? current.enabled,
        port: input.inboundPort,
        remark: input.remark === undefined ? current.remark : input.remark || null
      });
      inboundId = remoteCreated.inboundId;
    }

    const remotePatch = remoteCreated ? {
      remoteMode,
      remoteManaged: true,
      remoteInboundTag: remoteCreated.tag,
      remoteInboundRemark: remoteCreated.remark,
      remoteInboundPort: remoteCreated.port
    } : {
      remoteMode,
      remoteManaged: remoteMode === 'create' ? Boolean(previousConfig.remoteManaged) : false,
      remoteInboundPort: input.inboundPort === undefined ? previousConfig.remoteInboundPort : input.inboundPort
    };
    const config = await this.serviceNodeConfig(input, current.config, remotePatch);
    try {
      return await this.prisma.serviceNode.update({
        where: { id },
        data: {
          serverId: input.serverId,
          name: input.name,
          inboundId,
          protocol: input.protocol,
          config: this.toJsonValue(config),
          priceMonthly: input.priceMonthly === undefined ? undefined : new Prisma.Decimal(input.priceMonthly),
          trafficLimitGb: input.trafficLimitGb === undefined ? undefined : new Prisma.Decimal(input.trafficLimitGb),
          enabled: input.enabled,
          remark: input.remark === undefined ? undefined : input.remark || null
        },
        include: { server: { select: { id: true, name: true, baseUrl: true, enabled: true } } }
      });
    } catch (error) {
      if (remoteCreated) await this.xui.deleteRemoteInbound(nextServerId, remoteCreated.inboundId).catch(() => undefined);
      throw error;
    }
  }

  async deleteServiceNode(id: string) {
    const current = await this.ensureServiceNode(id);
    await this.xui.deleteServiceNodeClients(id);
    if (current.inboundId) await this.xui.syncServiceNodeRemoteConfig(id, { removeOnly: true });
    await this.xui.deleteManagedServiceNodeInbound(id);
    await this.prisma.$transaction([
      this.prisma.customerNode.deleteMany({ where: { serviceNodeId: id } }),
      this.prisma.serviceNode.delete({ where: { id } })
    ]);
    return { deleted: true, id };
  }

  async listSocksNodes() {
    const nodes = await this.prisma.socksNode.findMany({ orderBy: { createdAt: 'desc' } });
    return nodes.map(maskSocksNode);
  }

  async createSocksNode(input: z.infer<typeof socksNodeUpsertSchema>) {
    const node = await this.prisma.socksNode.create({
      data: {
        name: input.name,
        host: input.host,
        port: input.port,
        username: input.username || null,
        passwordEnc: this.encryption.encryptNullable(input.password),
        enabled: input.enabled,
        remark: input.remark || null
      }
    });
    return maskSocksNode(node);
  }

  async updateSocksNode(id: string, input: Partial<z.infer<typeof socksNodeUpsertSchema>>) {
    await this.ensureSocksNode(id);
    const node = await this.prisma.socksNode.update({
      where: { id },
      data: {
        name: input.name,
        host: input.host,
        port: input.port,
        username: input.username === undefined ? undefined : input.username || null,
        passwordEnc: input.password === undefined ? undefined : this.encryption.encryptNullable(input.password),
        enabled: input.enabled,
        remark: input.remark === undefined ? undefined : input.remark || null
      }
    });
    return maskSocksNode(node);
  }

  async deleteSocksNode(id: string) {
    await this.ensureSocksNode(id);
    const serviceNodes = await this.prisma.serviceNode.findMany({ select: { id: true, name: true, config: true } });
    const used = serviceNodes.find((node) => jsonObject(node.config).socksNodeId === id);
    if (used) throw new BadRequestException(`Socks 节点正在被服务节点“${used.name}”使用，请先关闭或更换该服务节点的 Socks 中转`);
    await this.prisma.socksNode.delete({ where: { id } });
    return { deleted: true, id };
  }

  async listUserNodes(customerId: string) {
    const nodes = await this.prisma.customerNode.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      include: { serviceNode: { include: { server: { select: { id: true, name: true, baseUrl: true } } } } }
    });
    return Promise.all(nodes.map(async (node) => {
      const links = await this.xui.customerNodeLinks(customerId, node.id).catch(() => [] as string[]);
      return { ...node, links, subId: jsonObject(node.config).subId || node.xuiEmail };
    }));
  }

  async bindCustomerNode(customerId: string, input: z.infer<typeof customerNodeCreateSchema>) {
    const [customer, serviceNode] = await Promise.all([
      this.prisma.customer.findUnique({ where: { id: customerId } }),
      this.prisma.serviceNode.findUnique({ where: { id: input.serviceNodeId } })
    ]);
    if (!customer) throw new NotFoundException('Customer not found');
    if (!serviceNode) throw new NotFoundException('Service node not found');

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

  async updateCustomerNode(customerId: string, customerNodeId: string, input: Partial<z.infer<typeof customerNodeCreateSchema>>) {
    const current = await this.prisma.customerNode.findFirst({ where: { id: customerNodeId, customerId }, include: { serviceNode: true } });
    if (!current) throw new NotFoundException('Customer node not found');

    const serviceNodeId = input.serviceNodeId || current.serviceNodeId;
    const serviceNode = serviceNodeId === current.serviceNodeId ? current.serviceNode : await this.prisma.serviceNode.findUnique({ where: { id: serviceNodeId } });
    if (!serviceNode) throw new NotFoundException('Service node not found');

    if (serviceNodeId !== current.serviceNodeId) {
      const duplicated = await this.prisma.customerNode.findUnique({
        where: { customerId_serviceNodeId: { customerId, serviceNodeId } },
        select: { id: true }
      });
      if (duplicated) throw new BadRequestException('Customer already bound to this service node');
    }

    const nextXuiEmail = input.xuiEmail === undefined || input.xuiEmail === '' ? current.xuiEmail : input.xuiEmail;
    const remoteIdentityChanged = serviceNodeId !== current.serviceNodeId || nextXuiEmail !== current.xuiEmail;
    if (remoteIdentityChanged) await this.xui.deleteCustomerNode(customerId, customerNodeId);

    const node = await this.prisma.customerNode.update({
      where: { id: customerNodeId },
      data: {
        serviceNodeId: input.serviceNodeId,
        xuiEmail: nextXuiEmail,
        uuid: input.uuid === undefined ? undefined : input.uuid || current.uuid,
        expireAt: input.expireAt === undefined ? undefined : input.expireAt || null,
        trafficLimitGb: input.trafficLimitGb === undefined ? undefined : new Prisma.Decimal(input.trafficLimitGb ?? serviceNode.trafficLimitGb),
        status: 'active'
      },
      include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
    });

    await this.xui.syncCustomerNode(customerId, node.id);

    return this.prisma.customerNode.findUnique({
      where: { id: node.id },
      include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
    });
  }

  async unbindCustomerNode(customerId: string, customerNodeId: string) {
    const node = await this.prisma.customerNode.findFirst({ where: { id: customerNodeId, customerId }, select: { id: true } });
    if (!node) throw new NotFoundException('Customer node not found');
    await this.xui.deleteCustomerNode(customerId, customerNodeId);
    await this.prisma.customerNode.delete({ where: { id: customerNodeId } });
    return { deleted: true, id: customerNodeId };
  }

  private async ensureServer(id: string) {
    const exists = await this.prisma.xuiServer.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('3x-ui server not found');
  }

  private async ensureServiceNode(id: string) {
    const exists = await this.prisma.serviceNode.findUnique({ where: { id }, select: { id: true, serverId: true, name: true, protocol: true, inboundId: true, enabled: true, remark: true, config: true } });
    if (!exists) throw new NotFoundException('Service node not found');
    return exists;
  }

  private async ensureSocksNode(id: string) {
    const exists = await this.prisma.socksNode.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('Socks node not found');
  }

  private async serviceNodeConfig(input: Partial<z.infer<typeof serviceNodeUpsertSchema>>, current?: Prisma.JsonValue | null, remotePatch: Partial<ServiceNodeConfig> = {}): Promise<ServiceNodeConfig> {
    const previous = jsonObject(current) as ServiceNodeConfig;
    const next: ServiceNodeConfig = {
      ...previous,
      ...remotePatch,
      encryption: input.encryption === undefined ? previous.encryption || 'none' : input.encryption,
      socksRelayEnabled: input.socksRelayEnabled === undefined ? Boolean(previous.socksRelayEnabled) : input.socksRelayEnabled,
      socksNodeId: input.socksNodeId === undefined ? previous.socksNodeId || null : input.socksNodeId || null
    };
    if (next.socksRelayEnabled) {
      if (!next.socksNodeId) throw new BadRequestException('A Socks node is required when Socks relay is enabled');
      const socks = await this.prisma.socksNode.findUnique({ where: { id: next.socksNodeId }, select: { id: true, enabled: true } });
      if (!socks) throw new NotFoundException('Socks node not found');
      if (!socks.enabled) throw new BadRequestException('Selected Socks node is disabled');
    }
    return next;
  }

  private toJsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }
}

function maskXuiServer<T extends { passwordEnc: string | null; tokenEnc: string | null }>(server: T) {
  const { passwordEnc, tokenEnc, ...safe } = server;
  return { ...safe, hasPassword: Boolean(passwordEnc), hasToken: Boolean(tokenEnc) };
}

function maskSocksNode<T extends { passwordEnc: string | null }>(node: T) {
  const { passwordEnc, ...safe } = node;
  return { ...safe, hasPassword: Boolean(passwordEnc) };
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
