import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
  remoteClientEmail?: string;
  remoteClientUuid?: string;
  remoteClientSubId?: string;
  remoteClientLinks?: string[];
};

type XuiServerConfig = {
  tlsServerName?: string;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  realityTarget?: string;
  realityServerName?: string;
  realityFingerprint?: string;
  realitySpiderX?: string;
};

const SHARE_LINK_PROTOCOLS = new Set(['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria']);

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
        config: this.toJsonValue(this.serverConfig(input)),
        enabled: input.enabled,
        remark: input.remark || null
      }
    });
    return maskXuiServer(server);
  }

  async updateServer(id: string, input: Partial<z.infer<typeof xuiServerUpsertSchema>>) {
    const current = await this.prisma.xuiServer.findUnique({ where: { id }, select: { config: true } });
    if (!current) throw new NotFoundException('3x-ui server not found');
    const server = await this.prisma.xuiServer.update({
      where: { id },
      data: {
        name: input.name,
        baseUrl: input.baseUrl,
        basePath: input.basePath === undefined ? undefined : input.basePath || null,
        username: input.username === undefined ? undefined : input.username || null,
        passwordEnc: input.password === undefined ? undefined : this.encryption.encryptNullable(input.password),
        tokenEnc: input.token === undefined ? undefined : this.encryption.encryptNullable(input.token),
        config: this.toJsonValue(this.serverConfig(input, serverConfigFrom(current.config))),
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
    this.assertShareLinkProtocol(input.protocol);
    await this.ensureServer(input.serverId);
    const remoteMode = input.remoteMode || 'create';
    let inboundId = input.inboundId || null;
    let remoteCreated: { inboundId: number; port: number; tag: string; remark: string; remoteClientEmail?: string; remoteClientUuid?: string; remoteClientSubId?: string; links?: string[] } | null = null;
    let remoteClient: { email?: string; uuid?: string; subId?: string } | null = null;

    if (remoteMode === 'bind') {
      if (!inboundId) throw new BadRequestException('绑定已有入站时必须填写入站 ID');
      const validation = await this.xui.validateServiceNodeInbound(input.serverId, inboundId);
      remoteClient = validation.remoteClient;
    } else {
      remoteCreated = await this.xui.createServiceNodeInbound({
        serverId: input.serverId,
        name: input.name,
        protocol: input.protocol,
        encryption: input.encryption,
        enabled: input.enabled,
        port: input.inboundPort,
        remark: input.remark || null,
        trafficLimitGb: new Prisma.Decimal(input.trafficLimitGb)
      });
      inboundId = remoteCreated.inboundId;
      remoteClient = { email: remoteCreated.remoteClientEmail, uuid: remoteCreated.remoteClientUuid, subId: remoteCreated.remoteClientSubId };
    }

    const config = await this.serviceNodeConfig(input, null, remoteCreated ? {
      remoteMode,
      remoteManaged: true,
      remoteInboundTag: remoteCreated.tag,
      remoteInboundRemark: remoteCreated.remark,
      remoteInboundPort: remoteCreated.port,
      remoteClientEmail: remoteCreated.remoteClientEmail,
      remoteClientUuid: remoteCreated.remoteClientUuid,
      remoteClientSubId: remoteCreated.remoteClientSubId,
      remoteClientLinks: remoteCreated.links
    } : { remoteMode, remoteManaged: false, remoteInboundPort: input.inboundPort, remoteClientEmail: remoteClient?.email, remoteClientUuid: remoteClient?.uuid, remoteClientSubId: remoteClient?.subId });

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
    if (input.protocol) this.assertShareLinkProtocol(input.protocol);
    if (input.serverId) await this.ensureServer(input.serverId);
    const nextServerId = input.serverId || current.serverId;
    const previousConfig = jsonObject(current.config) as ServiceNodeConfig;
    const remoteMode = input.remoteMode || previousConfig.remoteMode || (current.inboundId ? 'bind' : 'create');
    let inboundId = input.inboundId === undefined ? current.inboundId : input.inboundId || null;
    let remoteCreated: { inboundId: number; port: number; tag: string; remark: string; remoteClientEmail?: string; remoteClientUuid?: string; remoteClientSubId?: string; links?: string[] } | null = null;
    let remoteClient: { email?: string; uuid?: string; subId?: string } | null = null;
    const nextName = input.name || current.name;
    const nextProtocol = input.protocol || current.protocol;
    const nextEncryption = input.encryption || previousConfig.encryption || 'none';
    const nextEnabled = input.enabled ?? current.enabled;
    const nextRemotePort = input.inboundPort === undefined ? previousConfig.remoteInboundPort : input.inboundPort;
    const nextRemark = input.remark === undefined ? current.remark : input.remark || null;
    const trafficLimitChanged = input.trafficLimitGb !== undefined && Number(input.trafficLimitGb) !== Number(current.trafficLimitGb);

    if (remoteMode === 'bind') {
      if (!inboundId) throw new BadRequestException('绑定已有入站时必须填写入站 ID');
      if (input.serverId || input.inboundId !== undefined || !previousConfig.remoteClientEmail) {
        const validation = await this.xui.validateServiceNodeInbound(nextServerId, inboundId);
        remoteClient = validation.remoteClient;
      }
    } else if (!inboundId) {
      remoteCreated = await this.xui.createServiceNodeInbound({
        serverId: nextServerId,
        name: nextName,
        protocol: nextProtocol,
        encryption: nextEncryption,
        enabled: nextEnabled,
        port: input.inboundPort,
        remark: nextRemark,
        trafficLimitGb: input.trafficLimitGb === undefined ? current.trafficLimitGb : new Prisma.Decimal(input.trafficLimitGb)
      });
      inboundId = remoteCreated.inboundId;
      remoteClient = { email: remoteCreated.remoteClientEmail, uuid: remoteCreated.remoteClientUuid, subId: remoteCreated.remoteClientSubId };
    }

    const remotePatch = remoteCreated ? {
      remoteMode,
      remoteManaged: true,
      remoteInboundTag: remoteCreated.tag,
      remoteInboundRemark: remoteCreated.remark,
      remoteInboundPort: remoteCreated.port,
      remoteClientEmail: remoteCreated.remoteClientEmail,
      remoteClientUuid: remoteCreated.remoteClientUuid,
      remoteClientSubId: remoteCreated.remoteClientSubId,
      remoteClientLinks: remoteCreated.links
    } : {
      remoteMode,
      remoteManaged: remoteMode === 'create' ? Boolean(previousConfig.remoteManaged) : false,
      remoteInboundPort: input.inboundPort === undefined ? previousConfig.remoteInboundPort : input.inboundPort,
      remoteClientEmail: remoteClient?.email || previousConfig.remoteClientEmail,
      remoteClientUuid: remoteClient?.uuid || previousConfig.remoteClientUuid,
      remoteClientSubId: remoteClient?.subId || previousConfig.remoteClientSubId
    };
    const config = await this.serviceNodeConfig(input, current.config, remotePatch);
    try {
      const remoteInboundChanged = Boolean(
        (input.serverId !== undefined && nextServerId !== current.serverId) ||
        (input.inboundId !== undefined && inboundId !== current.inboundId) ||
        nextName !== current.name ||
        nextProtocol !== current.protocol ||
        nextEncryption !== (previousConfig.encryption || 'none') ||
        nextEnabled !== current.enabled ||
        nextRemark !== current.remark ||
        (input.inboundPort !== undefined && nextRemotePort !== previousConfig.remoteInboundPort)
      );
      const remoteEnableOnlyChanged = Boolean(
        input.enabled !== undefined &&
        nextEnabled !== current.enabled &&
        !remoteCreated &&
        inboundId &&
        input.serverId === undefined &&
        input.inboundId === undefined &&
        nextName === current.name &&
        nextProtocol === current.protocol &&
        nextEncryption === (previousConfig.encryption || 'none') &&
        nextRemark === current.remark &&
        (input.inboundPort === undefined || nextRemotePort === previousConfig.remoteInboundPort)
      );
      if (!remoteCreated && inboundId && remoteInboundChanged) {
        if (remoteEnableOnlyChanged) {
          await this.xui.setServiceNodeRemoteEnable(id, nextEnabled);
        } else {
          await this.xui.updateServiceNodeInbound({
            serverId: nextServerId,
            inboundId,
            name: nextName,
            protocol: nextProtocol,
            encryption: config.encryption || 'none',
            enabled: nextEnabled,
            port: nextRemotePort,
            remark: nextRemark
          });
        }
      }
      const updated = await this.prisma.serviceNode.update({
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
      const remoteClientShouldSync = Boolean(updated.inboundId && (remoteInboundChanged || trafficLimitChanged));
      if (remoteClientShouldSync) {
        await this.prisma.customerNode.updateMany({
          where: { serviceNodeId: id },
          data: { trafficLimitGb: updated.trafficLimitGb }
        });
        const syncResult = await this.xui.syncServiceNodeTrafficLimit(id);
        if (!syncResult.synced) {
          throw new BadGatewayException(`路由节点已保存，但远端 3x-ui 客户端同步未全部成功：成功 ${syncResult.updated}，跳过 ${syncResult.skipped}，失败 ${syncResult.failed}`);
        }
      }
      return updated;
    } catch (error) {
      if (remoteCreated) await this.xui.deleteRemoteInbound(nextServerId, remoteCreated.inboundId).catch(() => undefined);
      throw error;
    }
  }

  async deleteServiceNode(id: string) {
    const current = await this.ensureServiceNode(id);
    const remoteClientCleanup = { skipped: true, reason: 'clients belong to the service-node inbound and are removed with the inbound' };
    if (current.inboundId) await this.xui.syncServiceNodeRemoteConfig(id, { removeOnly: true }).catch(() => undefined);
    const remoteInboundCleanup = await this.xui.deleteManagedServiceNodeInbound(id);
    const customerNodes = await this.prisma.customerNode.findMany({ where: { serviceNodeId: id }, select: { id: true } });
    const customerNodeIds = customerNodes.map((node) => node.id);
    await this.prisma.$transaction([
      this.prisma.renewalLog.updateMany({ where: { customerNodeId: { in: customerNodeIds } }, data: { customerNodeId: null } }),
      this.prisma.customerNode.deleteMany({ where: { serviceNodeId: id } }),
      this.prisma.serviceNode.delete({ where: { id } })
    ]);
    return { deleted: true, id, remoteClientCleanup, remoteInboundCleanup };
  }

  async syncServiceNodeTrafficLimit(id: string) {
    const node = await this.prisma.serviceNode.findUnique({ where: { id }, select: { id: true, inboundId: true, trafficLimitGb: true } });
    if (!node) throw new NotFoundException('Service node not found');
    await this.prisma.customerNode.updateMany({
      where: { serviceNodeId: id },
      data: { trafficLimitGb: node.trafficLimitGb }
    });
    return this.xui.syncServiceNodeTrafficLimit(id);
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
      let linkError: string | null = null;
      const links = await this.xui.customerNodeLinks(customerId, node.id).catch((error) => {
        linkError = error instanceof Error ? error.message : String(error);
        return [] as string[];
      });
      return { ...node, links, linkError, subId: jsonObject(node.config).subId || node.xuiEmail };
    }));
  }

  async bindCustomerNode(customerId: string, input: z.infer<typeof customerNodeCreateSchema>) {
    const [customer, serviceNode] = await Promise.all([
      this.prisma.customer.findUnique({ where: { id: customerId } }),
      this.prisma.serviceNode.findUnique({ where: { id: input.serviceNodeId } })
    ]);
    if (!customer) throw new NotFoundException('Customer not found');
    if (!serviceNode) throw new NotFoundException('Service node not found');

    const existingBinding = await this.prisma.customerNode.findFirst({
      where: { serviceNodeId: input.serviceNodeId },
      select: { id: true, customerId: true, customer: { select: { name: true, loginUsername: true } } }
    });
    if (existingBinding) {
      const owner = existingBinding.customer?.name || existingBinding.customer?.loginUsername || existingBinding.customerId;
      throw new BadRequestException(`该路由节点已经绑定给用户 ${owner}。当前架构下远端 3x-ui 客户端属于路由节点，不能同时绑定多个面板用户。`);
    }

    const serviceConfig = jsonObject(serviceNode.config) as ServiceNodeConfig;
    const xuiEmail = input.xuiEmail || stringValue(serviceConfig.remoteClientEmail);
    const uuid = input.uuid || stringValue(serviceConfig.remoteClientUuid) || null;
    const subId = stringValue(serviceConfig.remoteClientSubId);
    const links = Array.isArray(serviceConfig.remoteClientLinks) ? serviceConfig.remoteClientLinks : [];
    if (!xuiEmail) throw new BadRequestException('Service node is missing a remote 3x-ui client. Sync/import the service node first.');
    const node = await this.prisma.customerNode.create({
      data: {
        customerId,
        serviceNodeId: input.serviceNodeId,
        xuiEmail,
        uuid,
        expireAt: input.expireAt || null,
        trafficLimitGb: new Prisma.Decimal(input.trafficLimitGb ?? serviceNode.trafficLimitGb),
        status: 'active',
        config: this.toJsonValue({ uuid, subId, links })
      },
      include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
    });

    try {
      await this.xui.syncCustomerNode(customerId, node.id, {
        expireAt: input.expireAt || null,
        trafficLimitGb: node.trafficLimitGb,
        status: 'active',
        createIfMissing: false,
        requireExisting: true
      });
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
      const duplicated = await this.prisma.customerNode.findFirst({
        where: { serviceNodeId, id: { not: customerNodeId } },
        select: { id: true, customerId: true, customer: { select: { name: true, loginUsername: true } } }
      });
      if (duplicated) {
        const owner = duplicated.customer?.name || duplicated.customer?.loginUsername || duplicated.customerId;
        throw new BadRequestException(`该路由节点已经绑定给用户 ${owner}。当前架构下远端 3x-ui 客户端属于路由节点，不能同时绑定多个面板用户。`);
      }
    }

    const serviceConfig = jsonObject(serviceNode.config) as ServiceNodeConfig;
    const nodeChanged = serviceNodeId !== current.serviceNodeId;
    const serviceRemoteEmail = stringValue(serviceConfig.remoteClientEmail);
    const serviceRemoteUuid = stringValue(serviceConfig.remoteClientUuid);
    const serviceRemoteSubId = stringValue(serviceConfig.remoteClientSubId);
    const serviceRemoteLinks = Array.isArray(serviceConfig.remoteClientLinks) ? serviceConfig.remoteClientLinks : [];
    const nextXuiEmail = nodeChanged
      ? input.xuiEmail || serviceRemoteEmail || current.xuiEmail
      : input.xuiEmail === undefined || input.xuiEmail === '' ? current.xuiEmail : input.xuiEmail;
    if (!nextXuiEmail) throw new BadRequestException('Service node is missing a remote 3x-ui client. Sync/import the service node first.');
    const nextUuid = nodeChanged ? input.uuid || serviceRemoteUuid || null : input.uuid === undefined ? current.uuid : input.uuid || current.uuid;
    const currentConfig = jsonObject(current.config);
    const nextConfig = nodeChanged
      ? { uuid: nextUuid, subId: serviceRemoteSubId, links: serviceRemoteLinks }
      : currentConfig;

    const node = await this.prisma.customerNode.update({
      where: { id: customerNodeId },
      data: {
        serviceNodeId: input.serviceNodeId,
        xuiEmail: nextXuiEmail,
        uuid: nextUuid,
        expireAt: input.expireAt === undefined ? undefined : input.expireAt || null,
        trafficLimitGb: input.trafficLimitGb === undefined ? undefined : new Prisma.Decimal(input.trafficLimitGb ?? serviceNode.trafficLimitGb),
        status: 'active',
        config: this.toJsonValue(nextConfig)
      },
      include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
    });

    try {
      await this.xui.syncCustomerNode(customerId, customerNodeId, {
        expireAt: input.expireAt === undefined ? node.expireAt : input.expireAt || null,
        trafficLimitGb: input.trafficLimitGb === undefined ? node.trafficLimitGb : new Prisma.Decimal(input.trafficLimitGb ?? serviceNode.trafficLimitGb),
        status: 'active',
        createIfMissing: false,
        requireExisting: true
      });
    } catch (error) {
      await this.prisma.customerNode.update({
        where: { id: customerNodeId },
        data: {
          serviceNodeId: current.serviceNodeId,
          xuiEmail: current.xuiEmail,
          uuid: current.uuid,
          expireAt: current.expireAt,
          trafficLimitGb: current.trafficLimitGb,
          status: current.status,
          config: this.toJsonValue(current.config)
        }
      }).catch(() => undefined);
      throw error;
    }

    return this.prisma.customerNode.findUnique({
      where: { id: node.id },
      include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
    });
  }

  async unbindCustomerNode(customerId: string, customerNodeId: string) {
    const node = await this.prisma.customerNode.findFirst({ where: { id: customerNodeId, customerId }, select: { id: true } });
    if (!node) throw new NotFoundException('Customer node not found');
    const remoteCleanup: unknown = { skipped: true, reason: 'customer binding is local only; remote client belongs to the service node' };
    await this.prisma.customerNode.delete({ where: { id: customerNodeId } });
    return { deleted: true, id: customerNodeId, remoteCleanup };
  }

  async deleteServiceNodeFromCustomerNode(customerId: string, customerNodeId: string) {
    const node = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      select: { id: true, serviceNodeId: true }
    });
    if (!node) throw new NotFoundException('Customer node not found');
    const result = await this.deleteServiceNode(node.serviceNodeId);
    return { ...result, customerId, customerNodeId };
  }

  private async ensureServer(id: string) {
    const exists = await this.prisma.xuiServer.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('3x-ui server not found');
  }

  private async ensureServiceNode(id: string) {
    const exists = await this.prisma.serviceNode.findUnique({ where: { id }, select: { id: true, serverId: true, name: true, protocol: true, inboundId: true, enabled: true, trafficLimitGb: true, remark: true, config: true } });
    if (!exists) throw new NotFoundException('Service node not found');
    return exists;
  }

  private async ensureSocksNode(id: string) {
    const exists = await this.prisma.socksNode.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('Socks node not found');
  }

  private assertShareLinkProtocol(protocol: string) {
    if (!SHARE_LINK_PROTOCOLS.has(protocol)) {
      throw new BadRequestException('服务节点只支持可生成用户链接的协议：VLESS、VMess、Trojan、Shadowsocks、Hysteria。Socks 请在 Socks 中转节点中配置。');
    }
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

  private serverConfig(input: Partial<z.infer<typeof xuiServerUpsertSchema>>, current: XuiServerConfig = {}): XuiServerConfig {
    return {
      ...current,
      tlsServerName: input.tlsServerName === undefined ? current.tlsServerName || '' : input.tlsServerName || '',
      tlsCertFile: input.tlsCertFile === undefined ? current.tlsCertFile || '' : input.tlsCertFile || '',
      tlsKeyFile: input.tlsKeyFile === undefined ? current.tlsKeyFile || '' : input.tlsKeyFile || '',
      realityTarget: input.realityTarget === undefined ? current.realityTarget || '' : input.realityTarget || '',
      realityServerName: input.realityServerName === undefined ? current.realityServerName || '' : input.realityServerName || '',
      realityFingerprint: input.realityFingerprint === undefined ? current.realityFingerprint || 'chrome' : input.realityFingerprint || 'chrome',
      realitySpiderX: input.realitySpiderX === undefined ? current.realitySpiderX || '/' : input.realitySpiderX || '/'
    };
  }
}

function maskXuiServer<T extends { passwordEnc: string | null; tokenEnc: string | null; config?: unknown }>(server: T) {
  const { passwordEnc, tokenEnc, config, ...safe } = server;
  return { ...safe, config: serverConfigFrom({ config }), hasPassword: Boolean(passwordEnc), hasToken: Boolean(tokenEnc) };
}

function maskSocksNode<T extends { passwordEnc: string | null }>(node: T) {
  const { passwordEnc, ...safe } = node;
  return { ...safe, hasPassword: Boolean(passwordEnc) };
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function serverConfigFrom(value: unknown): XuiServerConfig {
  const config = jsonObject(jsonObject(value).config || value);
  return {
    tlsServerName: String(config.tlsServerName || '').trim(),
    tlsCertFile: String(config.tlsCertFile || '').trim(),
    tlsKeyFile: String(config.tlsKeyFile || '').trim(),
    realityTarget: String(config.realityTarget || '').trim(),
    realityServerName: String(config.realityServerName || '').trim(),
    realityFingerprint: String(config.realityFingerprint || 'chrome').trim(),
    realitySpiderX: String(config.realitySpiderX || '/').trim()
  };
}

function hasRemoteSyncConfig(value: unknown) {
  const config = jsonObject(value);
  return Boolean(config.subId || (Array.isArray(config.links) && config.links.length));
}
