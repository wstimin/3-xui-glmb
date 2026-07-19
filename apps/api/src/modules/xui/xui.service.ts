import { randomBytes, randomUUID } from 'node:crypto';
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
  token?: string | null;
  username?: string | null;
  passwordEnc?: string | null;
  password?: string | null;
};

type SyncOptions = {
  expireAt?: Date | null;
  status?: AccountStatus;
  trafficLimitGb?: Prisma.Decimal | number | string | null;
  createIfMissing?: boolean;
  requireExisting?: boolean;
  syncServiceConfig?: boolean;
};

type SyncLogQuery = {
  serverId?: string;
  action?: string;
  status?: string;
  limit?: unknown;
};

type ServiceNodeConfig = {
  encryption?: string;
  socksRelayEnabled?: boolean;
  socksNodeId?: string | null;
  remoteSocksOutboundTag?: string;
  remoteSocksImported?: boolean;
  remoteMode?: 'create' | 'bind';
  remoteManaged?: boolean;
  remoteInboundTag?: string;
  remoteInboundRemark?: string;
  remoteInboundPort?: number;
  remoteClientEmail?: string;
  remoteClientUuid?: string;
  remoteClientSubId?: string;
};

type CreateServiceInboundInput = {
  serverId: string;
  name: string;
  protocol: string;
  encryption?: string;
  enabled: boolean;
  port?: number;
  remark?: string | null;
  trafficLimitGb?: Prisma.Decimal | number | string | null;
};

type UpdateServiceInboundInput = CreateServiceInboundInput & {
  inboundId: number;
};

type ClientLookup = {
  email?: string;
  uuid?: string;
  subId?: string;
  inboundId?: number;
};

type ClientMatch = {
  exists: boolean;
  raw: unknown;
  email?: string;
  uuid?: string;
  subId?: string;
};

type RealityTargetInfo = {
  target: string;
  serverName: string;
  scan?: Record<string, unknown> | null;
};

type RemoteSocksOutbound = {
  tag: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
};

type RemoteSocksRouteState = {
  socksOutbounds: Map<string, RemoteSocksOutbound>;
  routesByInboundTag: Map<string, { outboundTag: string; rule: Record<string, unknown> }>;
};

const SHIYE_ROUTE_MARK = 'shiye-service-node';
const SHARE_LINK_PROTOCOLS = new Set(['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria']);

@Injectable()
export class XuiService {
  constructor(private readonly prisma: PrismaService, private readonly encryption: EncryptionService) {}

  async testConnection(input: z.infer<typeof xuiServerUpsertSchema>) {
    const client = await this.createAuthenticatedClient({
      baseUrl: input.baseUrl,
      basePath: input.basePath,
      token: input.token,
      username: input.username,
      password: input.password
    });

    const inbounds = await client.listInbounds();
    this.assertXuiSuccess(inbounds);
    return { connected: true, inbounds };
  }

  async testStoredServer(id: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');

    const client = await this.createAuthenticatedClient(server);
    const inbounds = await client.listInbounds();
    this.assertXuiSuccess(inbounds);
    return { connected: true, serverId: id, enabled: server.enabled, inboundCount: this.xuiArray(inbounds).length, inbounds };
  }

  async testConnectionCertFiles(input: z.infer<typeof xuiServerUpsertSchema>) {
    const client = await this.createAuthenticatedClient({
      baseUrl: input.baseUrl,
      basePath: input.basePath,
      token: input.token,
      username: input.username,
      password: input.password
    });
    return this.readWebCertFiles(client);
  }

  async storedServerCertFiles(id: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('3x-ui server not found');

    const client = await this.createAuthenticatedClient(server);
    return this.readWebCertFiles(client);
  }

  async storedServerStatus(id: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('3x-ui server not found');

    const client = await this.createAuthenticatedClient(server);
    const [statusPayload, versionPayload] = await Promise.all([client.serverStatus(), client.getXrayVersion()]);
    this.assertXuiSuccess(statusPayload);
    this.assertXuiSuccess(versionPayload);
    return {
      serverId: id,
      status: this.xuiObject(this.xuiObject(statusPayload).obj || this.xuiObject(statusPayload).data || statusPayload),
      versions: this.xuiArray(versionPayload),
      raw: { status: statusPayload, versions: versionPayload }
    };
  }

  async storedServerClientPresence(id: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('3x-ui server not found');

    const client = await this.createAuthenticatedClient(server);
    const [onlinePayload, lastOnlinePayload] = await Promise.all([client.onlineClients(), client.clientsLastOnline()]);
    this.assertXuiSuccess(onlinePayload);
    this.assertXuiSuccess(lastOnlinePayload);
    return {
      serverId: id,
      online: this.xuiArray(onlinePayload),
      lastOnline: this.xuiObject(this.xuiObject(lastOnlinePayload).obj || this.xuiObject(lastOnlinePayload).data || lastOnlinePayload),
      raw: { online: onlinePayload, lastOnline: lastOnlinePayload }
    };
  }

  async syncLogs(query: SyncLogQuery = {}) {
    const limit = Math.min(Math.max(Number(query.limit || 100), 1), 300);
    const where: Prisma.SyncLogWhereInput = {
      serverId: query.serverId || undefined,
      action: query.action || undefined,
      status: query.status || undefined
    };
    const [items, actions, statuses, servers] = await Promise.all([
      this.prisma.syncLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: { server: { select: { id: true, name: true, baseUrl: true } } }
      }),
      this.prisma.syncLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } }),
      this.prisma.syncLog.findMany({ distinct: ['status'], select: { status: true }, orderBy: { status: 'asc' } }),
      this.prisma.xuiServer.findMany({ orderBy: { createdAt: 'desc' }, select: { id: true, name: true, baseUrl: true } })
    ]);

    return {
      items,
      filters: {
        actions: actions.map((item) => item.action),
        statuses: statuses.map((item) => item.status),
        servers
      }
    };
  }

  async syncServiceNode(serviceNodeId: string) {
    const serviceNode = await this.prisma.serviceNode.findUnique({ where: { id: serviceNodeId }, select: { id: true } });
    if (!serviceNode) throw new NotFoundException('服务节点不存在');
    throw new BadRequestException('服务节点不再批量创建 3x-ui 客户端，请在用户绑定列表中逐个点击同步');
  }

  async syncServiceNodeRemoteConfig(serviceNodeId: string, options: { removeOnly?: boolean } = {}) {
    const serviceNode = await this.prisma.serviceNode.findUnique({ where: { id: serviceNodeId }, include: { server: true } });
    if (!serviceNode) throw new NotFoundException('Service node not found');
    if (!serviceNode.inboundId) throw new BadRequestException('Service node missing 3x-ui inbound ID');

    const config = this.xuiObject(serviceNode.config) as ServiceNodeConfig;
    const client = await this.createAuthenticatedClient(serviceNode.server);
    let inboundTag = String(config.remoteInboundTag || `inbound-${serviceNode.inboundId}`);
    if (!options.removeOnly) {
      const inboundPayload = await client.getInbound(serviceNode.inboundId);
      this.assertXuiSuccess(inboundPayload);
      const inbound = this.xuiObject(this.xuiObject(inboundPayload).obj || this.xuiObject(inboundPayload).data || inboundPayload);
      inboundTag = String(inbound.tag || inboundTag);
    }
    const outboundTag = this.socksOutboundTag(serviceNode.id);

    const xrayPayload = await client.getXrayConfig();
    this.assertXuiSuccess(xrayPayload);
    const xrayObj = this.xuiObject(this.xuiObject(xrayPayload).obj || this.xuiObject(xrayPayload).data || xrayPayload);
    const rawSetting = xrayObj.xraySetting ?? xrayObj;
    const xraySetting = this.xuiObject(rawSetting);
    if (!Object.keys(xraySetting).length) throw new BadGatewayException('3x-ui returned an empty Xray config');

    const nextConfig = this.removeManagedSocksRoute(xraySetting, serviceNode.id, inboundTag, config.remoteSocksOutboundTag);
    let action: 'removed' | 'updated' = 'removed';
    let socksDetail: Record<string, unknown> | null = null;

    if (!options.removeOnly && config.socksRelayEnabled) {
      if (!config.socksNodeId) throw new BadRequestException('Socks relay enabled but no Socks node selected');
      const socksNode = await this.prisma.socksNode.findUnique({ where: { id: config.socksNodeId } });
      if (!socksNode) throw new NotFoundException('Socks node not found');
      if (!socksNode.enabled) throw new BadRequestException('Selected Socks node is disabled');

      const outbound = this.buildSocksOutbound(outboundTag, socksNode, serviceNode.id);
      const outbounds = Array.isArray(nextConfig.outbounds) ? nextConfig.outbounds : [];
      outbounds.push(outbound);
      nextConfig.outbounds = outbounds;

      const routing = this.ensureRouting(nextConfig);
      const rules = Array.isArray(routing.rules) ? routing.rules : [];
      rules.push({
        type: 'field',
        inboundTag: [inboundTag],
        outboundTag,
        _shiyeManaged: true,
        _shiyeServiceNodeId: serviceNode.id,
        _shiyeMark: SHIYE_ROUTE_MARK
      });
      routing.rules = rules;
      nextConfig.routing = routing;
      action = 'updated';
      socksDetail = { socksNodeId: socksNode.id, host: socksNode.host, port: socksNode.port, username: socksNode.username || '' };
    }

    const outboundTestUrl = typeof xrayObj.outboundTestUrl === 'string' ? xrayObj.outboundTestUrl : undefined;
    const response = await client.updateXrayConfig({ xraySetting: JSON.stringify(nextConfig, null, 2), outboundTestUrl });
    this.assertXuiSuccess(response);
    const reloadResponse = await client.restartXrayService();
    this.assertXuiSuccess(reloadResponse);
    await this.writeSyncLog(serviceNode.serverId, 'service-node-config-sync', 'success', `Service node ${serviceNode.name} remote config ${action}`, {
      serviceNodeId,
      inboundId: serviceNode.inboundId,
      inboundTag,
      outboundTag,
      action,
      socks: socksDetail,
      response: this.toJsonValue(response),
      reloadResponse: this.toJsonValue(reloadResponse)
    });
    return { synced: true, action, serviceNodeId, inboundId: serviceNode.inboundId, inboundTag, outboundTag, socks: socksDetail };
  }

  async createServiceNodeInbound(input: CreateServiceInboundInput) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: input.serverId } });
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');
    if (!server.enabled) throw new BadRequestException('3x-ui 服务器已停用');

    const client = await this.createAuthenticatedClient(server);
    const rawInbounds = await client.listInbounds();
    this.assertXuiSuccess(rawInbounds);
    const inbounds = this.xuiArray(rawInbounds);
    const usedPorts = new Set(inbounds.map((item) => Number(this.xuiObject(item).port)).filter((port) => Number.isInteger(port) && port > 0));
    const port = input.port || this.pickInboundPort(usedPorts);
    if (usedPorts.has(port)) throw new BadRequestException(`3x-ui 入站端口 ${port} 已被占用`);

    const tag = this.serviceInboundTag();
    const serverConfig = { ...this.xuiObject(server.config), baseUrl: server.baseUrl };
    const streamSettings = await this.defaultStreamSettings(client, input.encryption || 'none', serverConfig);
    const payload = this.buildInboundPayload({ ...input, port, tag, streamSettings });
    const response = await client.addInbound(payload);
    this.assertXuiSuccess(response);

    let inboundId = this.extractCreatedInboundId(response);
    if (!inboundId) {
      const afterPayload = await client.listInbounds();
      this.assertXuiSuccess(afterPayload);
      const created = this.xuiArray(afterPayload).find((item) => {
        const inbound = this.xuiObject(item);
        return inbound.tag === tag || (inbound.remark === payload.remark && Number(inbound.port) === port);
      });
      inboundId = this.inboundIdOf(created);
    }

    if (!inboundId) throw new BadGatewayException('3x-ui 已返回成功，但没有返回新入站 ID');
    const remoteClientUuid = randomUUID();
    const remoteClientSubId = this.subscriptionId(remoteClientUuid);
    const remoteClientEmail = this.serviceClientEmail(input.name, inboundId);
    const remoteClient = this.buildXuiClient({
      uuid: remoteClientUuid,
      subId: remoteClientSubId,
      email: remoteClientEmail,
      enabled: input.enabled,
      expireAt: null,
      trafficLimitGb: input.trafficLimitGb ?? 0,
      flow: this.clientFlowForProtocol(input.protocol, input.encryption || 'none')
    });
    let clientResponse: unknown;
    try {
      clientResponse = await client.addClient({ client: remoteClient, inboundIds: [inboundId] });
      this.assertXuiSuccess(clientResponse);
    } catch (error) {
      await client.deleteInbound(inboundId).catch(() => undefined);
      throw error;
    }

    let links: string[];
    if (input.enabled) {
      try {
        links = await this.requireLinksForServiceNode(client, remoteClientEmail, remoteClientSubId, {
          serverId: server.id,
          inboundId,
          serviceNodeName: input.name,
          protocol: input.protocol,
          encryption: input.encryption || 'none'
        });
      } catch (error) {
        await this.cleanupFailedServiceNodeCreate(client, server.id, inboundId, remoteClientEmail, error);
        throw error;
      }
    } else {
      links = await this.linksForClient(client, remoteClientEmail, remoteClientSubId).catch(() => [] as string[]);
    }
    await this.writeSyncLog(server.id, 'service-node-inbound-create', 'success', `Created inbound ${inboundId} for ${input.name}`, {
      inboundId,
      port,
      protocol: input.protocol,
      tag,
      reality: this.realityLogDetail(streamSettings),
      remoteClientEmail,
      remoteClientUuid,
      remoteClientSubId,
      links,
      response: this.toJsonValue(response),
      clientResponse: this.toJsonValue(clientResponse)
    });
    return { inboundId, port, tag, remark: String(payload.remark), remoteClientEmail, remoteClientUuid, remoteClientSubId, links, response };
  }

  async validateServiceNodeInbound(serverId: string, inboundId: number) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');
    const client = await this.createAuthenticatedClient(server);
    const payload = await client.getInbound(inboundId);
    this.assertXuiSuccess(payload);
    const inbound = this.remoteInboundFromPayload(payload);
    const remoteClient = this.firstInboundClientIdentity(inbound);
    if (!remoteClient.email && !remoteClient.uuid && !remoteClient.subId) throw new BadRequestException('This 3x-ui inbound has no client. Create a client in 3x-ui first, or use automatic service-node creation.');
    return { inboundId, valid: true, remoteClient };
  }

  async updateServiceNodeInbound(input: UpdateServiceInboundInput) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: input.serverId } });
    if (!server) throw new NotFoundException('3x-ui server not found');
    if (!server.enabled) throw new BadRequestException('3x-ui server is disabled');

    const client = await this.createAuthenticatedClient(server);
    const currentPayload = await client.getInbound(input.inboundId);
    this.assertXuiSuccess(currentPayload);
    const currentInbound = this.remoteInboundFromPayload(currentPayload);
    if (!this.inboundIdOf(currentInbound)) throw new BadRequestException(`3x-ui inbound ${input.inboundId} does not exist`);

    const serverConfig = { ...this.xuiObject(server.config), baseUrl: server.baseUrl };
    const currentStreamSettings = this.xuiObject(this.parseMaybeJson(currentInbound.streamSettings));
    const currentSecurity = String(currentStreamSettings.security || 'none').trim() || 'none';
    const nextSecurity = input.encryption || 'none';
    const streamSettings = currentSecurity === nextSecurity
      ? currentStreamSettings
      : await this.defaultStreamSettings(client, nextSecurity, serverConfig);
    const currentSettings = this.xuiObject(this.parseMaybeJson(currentInbound.settings));
    const port = input.port || this.positiveInteger(currentInbound.port);
    if (!port) throw new BadRequestException('3x-ui inbound is missing a valid port');
    if (port !== this.positiveInteger(currentInbound.port)) {
      const rawInbounds = await client.listInbounds();
      this.assertXuiSuccess(rawInbounds);
      const occupied = this.xuiArray(rawInbounds).some((item) => this.inboundIdOf(item) !== input.inboundId && this.positiveInteger(this.xuiObject(item).port) === port);
      if (occupied) throw new BadRequestException(`3x-ui inbound port ${port} is already in use`);
    }

    const payload = {
      ...currentInbound,
      ...this.buildInboundPayload({
        ...input,
        port,
        tag: String(currentInbound.tag || this.serviceInboundTag()),
        streamSettings
      }),
      id: input.inboundId,
      settings: this.mergeInboundSettings(input.protocol, currentSettings),
      up: Number(currentInbound.up || 0),
      down: Number(currentInbound.down || 0),
      total: Number(currentInbound.total || 0)
    };

    const response = await client.updateInbound(input.inboundId, payload);
    this.assertXuiSuccess(response);
    await this.writeSyncLog(server.id, 'service-node-inbound-update', 'success', `Updated inbound ${input.inboundId} for ${input.name}`, {
      inboundId: input.inboundId,
      port,
      protocol: input.protocol,
      reality: this.realityLogDetail(streamSettings),
      response: this.toJsonValue(response)
    });
    return { updated: true, inboundId: input.inboundId, port, response };
  }

  async setServiceNodeRemoteEnable(serviceNodeId: string, enable: boolean) {
    const serviceNode = await this.prisma.serviceNode.findUnique({ where: { id: serviceNodeId }, include: { server: true } });
    if (!serviceNode) throw new NotFoundException('Service node not found');
    if (!serviceNode.inboundId) throw new BadRequestException('Service node missing 3x-ui inbound ID');

    const client = await this.createAuthenticatedClient(serviceNode.server);
    const response = await client.setInboundEnable(serviceNode.inboundId, enable);
    this.assertXuiSuccess(response);
    await this.writeSyncLog(serviceNode.serverId, 'service-node-enable-sync', 'success', `${enable ? 'Enabled' : 'Disabled'} inbound ${serviceNode.inboundId}`, {
      serviceNodeId,
      inboundId: serviceNode.inboundId,
      enable,
      response: this.toJsonValue(response)
    });
    return { synced: true, serviceNodeId, inboundId: serviceNode.inboundId, enable, response };
  }

  async syncServiceNodeTrafficLimit(serviceNodeId: string) {
    const serviceNode = await this.prisma.serviceNode.findUnique({
      where: { id: serviceNodeId },
      include: {
        server: true,
        customerNodes: { select: { id: true, customerId: true, status: true } }
      }
    });
    if (!serviceNode) throw new NotFoundException('Service node not found');
    if (!serviceNode.inboundId) throw new BadRequestException('Service node missing 3x-ui inbound ID');

    const client = await this.createAuthenticatedClient(serviceNode.server);
    const rawInbounds = await client.listInbounds();
    this.assertXuiSuccess(rawInbounds);
    const inbounds = this.xuiArray(rawInbounds);
    const config = this.xuiObject(serviceNode.config) as ServiceNodeConfig;
    const remoteClientEmail = this.stringValue(config.remoteClientEmail);
    const remoteClientUuid = this.stringValue(config.remoteClientUuid);
    const remoteClientSubId = this.stringValue(config.remoteClientSubId);
    const results: Array<{ target: string; updated: boolean; skipped?: boolean; message?: string }> = [];

    if (remoteClientEmail || remoteClientUuid || remoteClientSubId) {
      try {
        const existing = await this.findClient(client, { email: remoteClientEmail, uuid: remoteClientUuid, subId: remoteClientSubId, inboundId: serviceNode.inboundId }, inbounds);
        if (existing.exists) {
          const uuid = existing.uuid || remoteClientUuid || randomUUID();
          const subId = existing.subId || remoteClientSubId || this.subscriptionId(uuid);
          const email = existing.email || remoteClientEmail || this.serviceClientEmail(serviceNode.name, serviceNode.inboundId);
          const payload = await this.updateClientPreservingRemote(client, existing.email || email, this.buildXuiClient({
              uuid,
              subId,
              email,
              enabled: serviceNode.enabled,
              expireAt: null,
              trafficLimitGb: serviceNode.trafficLimitGb,
              flow: this.clientFlowForServiceNode(serviceNode)
            }));
          this.assertXuiSuccess(payload);
          if (serviceNode.enabled) {
            await this.requireLinksForServiceNode(client, email, subId, {
              serverId: serviceNode.serverId,
              inboundId: serviceNode.inboundId,
              serviceNodeName: serviceNode.name,
              protocol: serviceNode.protocol,
              encryption: String(config.encryption || 'none')
            });
          }
          results.push({ target: `service:${email}`, updated: true });
        } else {
          results.push({ target: 'service-client', updated: false, message: 'remote service client not found' });
        }
      } catch (error) {
        results.push({ target: 'service-client', updated: false, message: this.errorMessage(error) });
      }
    } else {
      results.push({ target: 'service-client', updated: false, skipped: true, message: 'service node has no remote client identity' });
    }

    for (const node of serviceNode.customerNodes) {
      if (!serviceNode.enabled && node.status === 'active') {
        results.push({ target: `customer:${node.id}`, updated: false, skipped: true, message: '服务节点已停用，用户节点无需继续同步为启用' });
        continue;
      }
      try {
        await this.syncCustomerNode(node.customerId, node.id, { status: node.status, trafficLimitGb: serviceNode.trafficLimitGb, createIfMissing: false });
        results.push({ target: `customer:${node.id}`, updated: true });
      } catch (error) {
        results.push({ target: `customer:${node.id}`, updated: false, message: this.errorMessage(error) });
      }
    }

    const updated = results.filter((item) => item.updated).length;
    const skipped = results.filter((item) => item.skipped).length;
    const failed = results.length - updated - skipped;
    await this.writeSyncLog(serviceNode.serverId, 'service-node-traffic-limit-sync', failed ? 'partial' : 'success', `Synced traffic limit for ${serviceNode.name}`, {
      serviceNodeId,
      inboundId: serviceNode.inboundId,
      trafficLimitGb: String(serviceNode.trafficLimitGb),
      updated,
      skipped,
      failed,
      results
    });
    return { synced: failed === 0, serviceNodeId, inboundId: serviceNode.inboundId, trafficLimitGb: serviceNode.trafficLimitGb, updated, skipped, failed, results };
  }

  async resetServiceNodeTraffic(serviceNodeId: string) {
    const serviceNode = await this.prisma.serviceNode.findUnique({ where: { id: serviceNodeId }, include: { server: true } });
    if (!serviceNode) throw new NotFoundException('Service node not found');
    if (!serviceNode.inboundId) throw new BadRequestException('Service node missing 3x-ui inbound ID');

    const client = await this.createAuthenticatedClient(serviceNode.server);
    const response = await client.resetInboundTraffic(serviceNode.inboundId);
    this.assertXuiSuccess(response);
    await this.writeSyncLog(serviceNode.serverId, 'service-node-reset-traffic', 'success', `Reset inbound traffic ${serviceNode.inboundId}`, {
      serviceNodeId,
      inboundId: serviceNode.inboundId,
      response: this.toJsonValue(response)
    });
    return { reset: true, serviceNodeId, inboundId: serviceNode.inboundId, response };
  }

  async resetCustomerNodeTraffic(customerId: string, customerNodeId: string) {
    const customerNode = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      include: { serviceNode: { include: { server: true } } }
    });
    if (!customerNode) throw new NotFoundException('Customer node not found');

    const client = await this.createAuthenticatedClient(customerNode.serviceNode.server);
    const response = await client.resetTraffic(customerNode.xuiEmail);
    this.assertXuiSuccess(response);
    await this.writeSyncLog(customerNode.serviceNode.serverId, 'customer-node-reset-traffic', 'success', `Reset client traffic ${customerNode.xuiEmail}`, {
      customerId,
      customerNodeId,
      serviceNodeId: customerNode.serviceNodeId,
      xuiEmail: customerNode.xuiEmail,
      response: this.toJsonValue(response)
    });
    return { reset: true, customerId, customerNodeId, xuiEmail: customerNode.xuiEmail, response };
  }

  async customerNodeTraffic(customerId: string, customerNodeId: string) {
    const customerNode = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      include: { serviceNode: { include: { server: true } } }
    });
    if (!customerNode) throw new NotFoundException('Customer node not found');

    const client = await this.createAuthenticatedClient(customerNode.serviceNode.server);
    const payload = await client.clientTraffic(customerNode.xuiEmail);
    this.assertXuiSuccess(payload);
    return {
      customerId,
      customerNodeId,
      xuiEmail: customerNode.xuiEmail,
      traffic: this.xuiObject(this.xuiObject(payload).obj || this.xuiObject(payload).data || payload),
      raw: payload
    };
  }

  async deleteManagedServiceNodeInbound(serviceNodeId: string) {
    const serviceNode = await this.prisma.serviceNode.findUnique({ where: { id: serviceNodeId }, include: { server: true } });
    if (!serviceNode?.inboundId) return { deleted: false, skipped: true };
    const config = this.xuiObject(serviceNode.config) as ServiceNodeConfig;

    try {
      const client = await this.createAuthenticatedClient(serviceNode.server);
      const remoteClientEmail = this.stringValue(config.remoteClientEmail);
      const remoteClientCleanup = remoteClientEmail
        ? await this.deleteRemoteClientWithClient(client, serviceNode.server.id, remoteClientEmail, false, { serviceNodeId, inboundId: serviceNode.inboundId, action: 'service-node-delete' }).catch((error) => ({ deleted: false, xuiEmail: remoteClientEmail, message: this.errorMessage(error) }))
        : { skipped: true, reason: 'service node has no remote client email' };
      const beforeDelete = await this.remoteInboundExists(client, serviceNode.inboundId);
      if (!beforeDelete.exists) {
        await this.writeSyncLog(serviceNode.serverId, 'service-node-inbound-delete', 'success', `Inbound ${serviceNode.inboundId} already absent`, {
          serviceNodeId,
          inboundId: serviceNode.inboundId,
          alreadyAbsent: true,
          remoteClientCleanup
        });
        return { deleted: true, inboundId: serviceNode.inboundId, alreadyAbsent: true, remoteClientCleanup };
      }
      const response = await client.deleteInbound(serviceNode.inboundId);
      this.assertXuiSuccess(response);
      const verified = await this.verifyRemoteInboundDeleted(client, serviceNode.inboundId);
      await this.writeSyncLog(serviceNode.serverId, 'service-node-inbound-delete', 'success', `Deleted inbound ${serviceNode.inboundId}`, {
        serviceNodeId,
        inboundId: serviceNode.inboundId,
        remoteClientCleanup,
        verified,
        response: this.toJsonValue(response)
      });
      return { deleted: true, inboundId: serviceNode.inboundId, remoteClientCleanup, verified, response };
    } catch (error) {
      if (this.isRemoteNotFound(error)) return { deleted: true, inboundId: serviceNode.inboundId, alreadyAbsent: true };
      await this.writeSyncLog(serviceNode.serverId, 'service-node-inbound-delete', 'failed', this.errorMessage(error), { serviceNodeId, inboundId: serviceNode.inboundId });
      throw new BadGatewayException(`删除远端 3x-ui 入站失败：${this.errorMessage(error)}`);
    }
  }

  async deleteRemoteInbound(serverId: string, inboundId: number) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: serverId } });
    if (!server) return { deleted: false, skipped: true };
    const client = await this.createAuthenticatedClient(server);
    const beforeDelete = await this.remoteInboundExists(client, inboundId);
    if (!beforeDelete.exists) return { deleted: true, inboundId, alreadyAbsent: true };
    const response = await client.deleteInbound(inboundId);
    this.assertXuiSuccess(response);
    const verified = await this.verifyRemoteInboundDeleted(client, inboundId);
    return { deleted: true, inboundId, verified, response };
  }

  async syncServer(serverId: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');
    if (!server.enabled) throw new BadRequestException('3x-ui 服务器已停用');

    const client = await this.createAuthenticatedClient(server);
    const payload = await client.listInbounds();
    this.assertXuiSuccess(payload);
    const inbounds = this.xuiArray(payload);
    const remoteSocksState = await this.loadRemoteSocksRouteState(client);
    const importedSocks = await this.importRemoteSocksOutbounds(server.id, server.name, remoteSocksState);

    const results: Array<{ inboundId: number; name: string; action: 'created' | 'updated' | 'skipped'; serviceNodeId?: string; message?: string }> = [];
    for (const rawInbound of inbounds) {
      const inboundId = this.inboundIdOf(rawInbound);
      try {
        if (!inboundId) {
          results.push({ inboundId: 0, name: 'unknown', action: 'skipped', message: '远端入站缺少有效 ID' });
          continue;
        }

        const inbound = this.xuiObject(rawInbound);
        const streamSettings = this.xuiObject(inbound.streamSettings);
        const remoteClient = this.firstInboundClientIdentity(inbound);
        const name = this.remoteInboundName(inbound, inboundId);
        const protocol = String(inbound.protocol || 'vless').trim() || 'vless';
        if (!SHARE_LINK_PROTOCOLS.has(protocol)) {
          results.push({ inboundId, name: this.remoteInboundName(inbound, inboundId), action: 'skipped', message: `${protocol} 不会生成用户端节点链接` });
          continue;
        }
        const port = this.positiveInteger(inbound.port);
        const enabled = this.booleanValue(inbound.enable, true);
        const existing = await this.prisma.serviceNode.findFirst({ where: { serverId, inboundId } });
        const previousConfig = this.xuiObject(existing?.config);
        const existingRemoteManaged = Boolean(previousConfig.remoteManaged);
        const existingRemoteMode = previousConfig.remoteMode === 'create' || previousConfig.remoteMode === 'bind'
          ? previousConfig.remoteMode
          : existingRemoteManaged ? 'create' : 'bind';
        const inboundTag = String(inbound.tag || previousConfig.remoteInboundTag || `inbound-${inboundId}`);
        const directOutboundTags = this.stringList(inbound.outboundTag);
        const remoteSocks = await this.importRemoteSocksForInbound(server.id, server.name, inboundTag, remoteSocksState, directOutboundTags);
        const remoteSocksConfig = remoteSocks
          ? {
            socksRelayEnabled: true,
            socksNodeId: remoteSocks.socksNodeId,
            remoteSocksOutboundTag: remoteSocks.outboundTag,
            remoteSocksImported: true
          }
          : {};
        const config = {
          ...previousConfig,
          ...remoteSocksConfig,
          remoteMode: existing ? existingRemoteMode : 'bind',
          remoteManaged: existing ? existingRemoteManaged : false,
          remoteInboundTag: inboundTag,
          remoteInboundRemark: String(inbound.remark || previousConfig.remoteInboundRemark || ''),
          remoteInboundPort: port || previousConfig.remoteInboundPort || undefined,
          remoteClientEmail: remoteClient.email || previousConfig.remoteClientEmail || undefined,
          remoteClientUuid: remoteClient.uuid || previousConfig.remoteClientUuid || undefined,
          remoteClientSubId: remoteClient.subId || previousConfig.remoteClientSubId || undefined,
          encryption: String(streamSettings.security || previousConfig.encryption || 'none'),
          importedFromRemote: existing ? Boolean(previousConfig.importedFromRemote) : true
        };

        if (existing) {
          const updated = await this.prisma.serviceNode.update({
            where: { id: existing.id },
            data: {
              name,
              protocol,
              enabled,
              config: this.toJsonValue(config)
            }
          });
          results.push({ inboundId, name, action: 'updated', serviceNodeId: updated.id });
          continue;
        }

        const created = await this.prisma.serviceNode.create({
          data: {
            serverId,
            name,
            inboundId,
            protocol,
            priceMonthly: new Prisma.Decimal(0),
            trafficLimitGb: new Prisma.Decimal(0),
            enabled,
            config: this.toJsonValue(config),
            remark: String(inbound.remark || '').trim() || null
          }
        });
        results.push({ inboundId, name, action: 'created', serviceNodeId: created.id });
      } catch (error) {
        results.push({ inboundId, name: inboundId ? `Inbound ${inboundId}` : 'unknown', action: 'skipped', message: this.errorMessage(error) });
      }
    }

    const created = results.filter((item) => item.action === 'created').length;
    const updated = results.filter((item) => item.action === 'updated').length;
    const skipped = results.filter((item) => item.action === 'skipped').length;
    await this.writeSyncLog(serverId, 'server-inbounds-import', skipped ? 'partial' : 'success', `Imported remote inbounds from ${server.name}`, {
      created,
      updated,
      skipped,
      remoteSocksFound: remoteSocksState.socksOutbounds.size,
      remoteSocksImported: importedSocks.length,
      results
    });
    return { serverId, serverName: server.name, total: results.length, created, updated, skipped, remoteSocksFound: remoteSocksState.socksOutbounds.size, remoteSocksImported: importedSocks.length, results };
  }

  async syncServerSocksOutbounds(serverId: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException('3x-ui server not found');
    if (!server.enabled) throw new BadRequestException('3x-ui server is disabled');

    try {
      const client = await this.createAuthenticatedClient(server);
      const remoteSocksState = await this.loadRemoteSocksRouteState(client);
      const importedSocks = await this.importRemoteSocksOutbounds(server.id, server.name, remoteSocksState);
      const result = {
        serverId,
        serverName: server.name,
        remoteSocksFound: remoteSocksState.socksOutbounds.size,
        remoteSocksImported: importedSocks.length,
        importedSocks
      };
      await this.writeSyncLog(serverId, 'server-socks-outbounds-import', 'success', `Imported remote SOCKS outbounds from ${server.name}`, result);
      return result;
    } catch (error) {
      await this.writeSyncLog(serverId, 'server-socks-outbounds-import', 'failed', this.errorMessage(error), { message: this.errorMessage(error) });
      throw new BadGatewayException(`Sync remote SOCKS outbounds failed: ${this.errorMessage(error)}`);
    }
  }

  async deleteRemoteSocksOutbound(serverId: string, outboundTag: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException('3x-ui server not found');
    if (!server.enabled) throw new BadRequestException('3x-ui server is disabled');
    if (!outboundTag) throw new BadRequestException('Remote outbound tag is required');

    try {
      const client = await this.createAuthenticatedClient(server);
      const xrayPayload = await client.getXrayConfig();
      this.assertXuiSuccess(xrayPayload);
      const xrayObj = this.xuiObject(this.xuiObject(xrayPayload).obj || this.xuiObject(xrayPayload).data || xrayPayload);
      const rawSetting = xrayObj.xraySetting ?? xrayObj;
      const xraySetting = this.xuiObject(rawSetting);
      if (!Object.keys(xraySetting).length) throw new BadGatewayException('3x-ui returned an empty Xray config');

      const outbounds = Array.isArray(xraySetting.outbounds) ? xraySetting.outbounds : [];
      const beforeOutbounds = outbounds.length;
      xraySetting.outbounds = outbounds.filter((item) => this.stringValue(this.xuiObject(item).tag) !== outboundTag);

      const routing = this.xuiObject(xraySetting.routing);
      const rules = Array.isArray(routing.rules) ? routing.rules : [];
      const beforeRules = rules.length;
      const nextRules = rules.filter((item) => !this.stringList(this.xuiObject(item).outboundTag).includes(outboundTag));
      routing.rules = nextRules;
      xraySetting.routing = routing;

      const removedOutbounds = beforeOutbounds - (xraySetting.outbounds as unknown[]).length;
      const removedRules = beforeRules - nextRules.length;
      if (removedOutbounds || removedRules) {
        const outboundTestUrl = typeof xrayObj.outboundTestUrl === 'string' ? xrayObj.outboundTestUrl : undefined;
        const response = await client.updateXrayConfig({ xraySetting: JSON.stringify(xraySetting, null, 2), outboundTestUrl });
        this.assertXuiSuccess(response);
        const reloadResponse = await client.restartXrayService();
        this.assertXuiSuccess(reloadResponse);
        await this.writeSyncLog(serverId, 'server-socks-outbound-delete', 'success', `Deleted remote SOCKS outbound ${outboundTag} from ${server.name}`, {
          outboundTag,
          removedOutbounds,
          removedRules,
          response: this.toJsonValue(response),
          reloadResponse: this.toJsonValue(reloadResponse)
        });
      } else {
        await this.writeSyncLog(serverId, 'server-socks-outbound-delete', 'success', `Remote SOCKS outbound ${outboundTag} already absent from ${server.name}`, {
          outboundTag,
          removedOutbounds,
          removedRules
        });
      }

      return { deleted: true, serverId, serverName: server.name, outboundTag, removedOutbounds, removedRules };
    } catch (error) {
      await this.writeSyncLog(serverId, 'server-socks-outbound-delete', 'failed', this.errorMessage(error), { outboundTag, message: this.errorMessage(error) });
      throw new BadGatewayException(`Delete remote SOCKS outbound failed: ${this.errorMessage(error)}`);
    }
  }

  async deleteCustomerNode(customerId: string, customerNodeId: string, keepTraffic = false) {
    const customerNode = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      include: { serviceNode: { include: { server: true } } }
    });
    if (!customerNode) throw new NotFoundException('用户节点不存在');
    return this.deleteRemoteClient(customerNode.serviceNode.server, customerNode.xuiEmail, keepTraffic, {
      customerId,
      customerNodeId,
      serviceNodeId: customerNode.serviceNodeId
    });
  }

  async deleteServiceNodeClients(serviceNodeId: string, keepTraffic = false) {
    const serviceNode = await this.prisma.serviceNode.findUnique({
      where: { id: serviceNodeId },
      include: { server: true, customerNodes: { select: { id: true, customerId: true, xuiEmail: true } } }
    });
    if (!serviceNode) throw new NotFoundException('服务节点不存在');

    const results: Array<{ customerNodeId: string; customerId: string; xuiEmail: string; deleted: boolean; skipped?: boolean; message?: string }> = [];
    for (const node of serviceNode.customerNodes) {
      try {
        const customerNode = await this.prisma.customerNode.findUnique({ where: { id: node.id }, select: { lastSyncedAt: true, config: true } });
        if (!this.shouldDeleteRemoteClient(customerNode)) {
          results.push({ customerNodeId: node.id, customerId: node.customerId, xuiEmail: node.xuiEmail, deleted: false, skipped: true, message: 'not synced to remote' });
          continue;
        }
        await this.deleteRemoteClient(serviceNode.server, node.xuiEmail, keepTraffic, {
          customerId: node.customerId,
          customerNodeId: node.id,
          serviceNodeId
        });
        results.push({ customerNodeId: node.id, customerId: node.customerId, xuiEmail: node.xuiEmail, deleted: true });
      } catch (error) {
        results.push({ customerNodeId: node.id, customerId: node.customerId, xuiEmail: node.xuiEmail, deleted: false, message: this.errorMessage(error) });
      }
    }

    const success = results.filter((item) => item.deleted).length;
    const skipped = results.filter((item) => item.skipped).length;
    const failed = results.filter((item) => !item.deleted && !item.skipped).length;
    return { serviceNodeId, total: results.length, success, skipped, failed, results };
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
      const targetStatus = options.status || customerNode.status;
      if (!server.enabled && targetStatus === 'active') throw new BadRequestException('3x-ui 服务器已停用');
      if (!customerNode.serviceNode.enabled && targetStatus === 'active') throw new BadRequestException('服务节点已停用');
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

      const savedConfig = this.xuiObject(customerNode.config);
      const serviceConfig = this.xuiObject(customerNode.serviceNode.config) as ServiceNodeConfig;
      const remoteClientEmail = this.stringValue(serviceConfig.remoteClientEmail);
      const remoteClientUuid = this.stringValue(serviceConfig.remoteClientUuid);
      const remoteClientSubId = this.stringValue(serviceConfig.remoteClientSubId);
      const savedUuid = typeof savedConfig.uuid === 'string' ? savedConfig.uuid : undefined;
      const savedSubId = typeof savedConfig.subId === 'string' ? savedConfig.subId : undefined;
      const lookupEmail = remoteClientEmail || customerNode.xuiEmail;
      const existing = await this.findClient(client, {
        email: lookupEmail,
        uuid: remoteClientUuid || customerNode.uuid || savedUuid,
        subId: remoteClientSubId || savedSubId,
        inboundId
      }, inbounds);

      if (!existing.exists && options.createIfMissing === false) {
        if (options.requireExisting) {
          throw new BadRequestException('Remote 3x-ui client was not found. This operation only updates an existing client and will not create a duplicate client.');
        }
        const uuid = customerNode.uuid || savedUuid || randomUUID();
        const subId = savedSubId || this.subscriptionId(uuid);
        const syncedAt = new Date();
        const updatedNode = await this.prisma.customerNode.update({
          where: { id: customerNode.id },
          data: { uuid, lastSyncedAt: syncedAt, config: this.toJsonValue({ ...savedConfig, uuid, subId, links: [] }) },
          include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
        });
        const detail = {
          customerId,
          customerNodeId,
          inboundId,
          xuiEmail: lookupEmail,
          route: 'clients/get',
          action: 'already-absent',
          subId,
          links: [] as string[],
          remoteConfig: null as unknown
        };
        const remoteConfigSync = options.syncServiceConfig ? await this.syncServiceNodeRemoteConfig(customerNode.serviceNodeId) : null;
        detail.remoteConfig = remoteConfigSync ? this.toJsonValue(remoteConfigSync) : null;
        await this.writeSyncLog(serverId, 'customer-node-sync', 'success', `Remote client already absent: ${lookupEmail}`, detail);
        return { synced: true, action: 'already-absent', route: 'clients/get', node: updatedNode, detail, remoteConfig: remoteConfigSync };
      }

      if (!existing.exists) throw new BadRequestException('Remote 3x-ui client was not found for this service node. Customer binding sync will not create a new client. Sync/import the service node first or fill the existing remote client email/UUID.');

      const allowCreate = false;
      if (!existing.exists && !allowCreate) {
        throw new BadRequestException('绑定已有 3x-ui 入站时未找到对应远端客户端，为避免重复创建，请填写已有客户端的远端标识/email 或 UUID 后再同步');
      }

      const uuid = existing.uuid || remoteClientUuid || customerNode.uuid || savedUuid || randomUUID();
      const subId = existing.subId || remoteClientSubId || savedSubId || this.subscriptionId(uuid);
      const xuiEmail = existing.email || remoteClientEmail || customerNode.xuiEmail;
      const xuiClient = this.buildXuiClient({
        uuid,
        subId,
        email: xuiEmail,
        enabled: targetStatus === 'active',
        expireAt: options.expireAt === undefined ? customerNode.expireAt : options.expireAt,
        trafficLimitGb: options.trafficLimitGb ?? customerNode.trafficLimitGb,
        flow: this.clientFlowForServiceNode(customerNode.serviceNode)
      });
      const route = 'clients/update';
      const payload = await this.updateClientPreservingRemote(client, existing.email || xuiEmail, xuiClient);
      this.assertXuiSuccess(payload);
      const links = targetStatus === 'active'
        ? await this.requireLinksForServiceNode(client, xuiEmail, subId, {
          serverId,
          inboundId,
          serviceNodeName: customerNode.serviceNode.name,
          protocol: customerNode.serviceNode.protocol,
          encryption: String(serviceConfig.encryption || 'none')
        })
        : await this.linksForClient(client, xuiEmail, subId).catch(() => [] as string[]);
      const syncedAt = new Date();
      const updatedNode = await this.prisma.customerNode.update({
        where: { id: customerNode.id },
        data: { xuiEmail, uuid, lastSyncedAt: syncedAt, config: this.toJsonValue({ ...savedConfig, uuid, subId, links }) },
        include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
      });

      const detail = {
        customerId,
        customerNodeId,
        inboundId,
        xuiEmail,
        route,
        action: 'update',
        subId,
        links,
        remoteConfig: null as unknown,
        response: this.toJsonValue(payload)
      };
      const remoteConfigSync = options.syncServiceConfig ? await this.syncServiceNodeRemoteConfig(customerNode.serviceNodeId) : null;
      detail.remoteConfig = remoteConfigSync ? this.toJsonValue(remoteConfigSync) : null;
      await this.writeSyncLog(serverId, 'customer-node-sync', 'success', `Synced ${xuiEmail}`, detail);
      return { synced: true, action: 'update', route, node: updatedNode, detail, remoteConfig: remoteConfigSync };
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

  async customerNodeLinks(customerId: string, customerNodeId: string) {
    const customerNode = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      include: { serviceNode: { include: { server: true } } }
    });
    if (!customerNode) throw new NotFoundException('Customer node not found');
    const config = this.xuiObject(customerNode.config);
    const savedLinks = Array.isArray(config.links) ? config.links.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
    if (savedLinks.length) return this.renameShareLinks(savedLinks, customerNode.serviceNode.name);
    const client = await this.createAuthenticatedClient(customerNode.serviceNode.server);
    const subId = typeof config.subId === 'string' ? config.subId : undefined;
    try {
      const links = await this.linksForClient(client, customerNode.xuiEmail, subId);
      return this.renameShareLinks(links, customerNode.serviceNode.name);
    } catch (error) {
      await this.writeSyncLog(customerNode.serviceNode.serverId, 'customer-node-links', 'failed', this.errorMessage(error), {
        customerId,
        customerNodeId,
        xuiEmail: customerNode.xuiEmail,
        subId
      });
      throw error;
    }
  }

  private async createAuthenticatedClient(config: XuiServerConfig) {
    const client = new XuiClient({
      baseUrl: config.baseUrl,
      basePath: config.basePath || undefined,
      auth: config.token || config.tokenEnc ? { kind: 'token', token: config.token || this.encryption.decrypt(config.tokenEnc || '') } : undefined
    });

    if (!config.token && !config.tokenEnc && config.username && (config.password || config.passwordEnc)) {
      await client.login({ username: config.username, password: config.password || this.encryption.decrypt(config.passwordEnc || '') });
    }

    return client;
  }

  private async deleteRemoteClient(server: XuiServerConfig & { id?: string | null }, xuiEmail: string, keepTraffic: boolean, detail: Record<string, unknown>) {
    try {
      const client = await this.createAuthenticatedClient(server);
      return await this.deleteRemoteClientWithClient(client, server.id || null, xuiEmail, keepTraffic, detail);
    } catch (error) {
      if (this.isRemoteNotFound(error)) {
        await this.writeSyncLog(server.id || null, 'customer-node-delete', 'success', `Remote client already absent: ${xuiEmail}`, { ...detail, xuiEmail, keepTraffic });
        return { deleted: true, xuiEmail, alreadyAbsent: true };
      }
      await this.writeSyncLog(server.id || null, 'customer-node-delete', 'failed', this.errorMessage(error), { ...detail, xuiEmail, keepTraffic });
      throw new BadGatewayException(`删除 3x-ui 客户端失败：${this.errorMessage(error)}`);
    }
  }

  private async deleteRemoteClientWithClient(client: XuiClient, serverId: string | null | undefined, xuiEmail: string, keepTraffic: boolean, detail: Record<string, unknown>) {
    const beforeDelete = await this.remoteClientExists(client, xuiEmail);
    if (!beforeDelete.exists) {
      await this.writeSyncLog(serverId || null, 'customer-node-delete', 'success', `Remote client already absent: ${xuiEmail}`, { ...detail, xuiEmail, keepTraffic, beforeDelete });
      return { deleted: true, xuiEmail, alreadyAbsent: true, verified: { absent: true, checked: true, retried: false } };
    }
    const payload = await client.deleteClient(xuiEmail, keepTraffic);
    this.assertXuiSuccess(payload);
    const verified = await this.verifyRemoteClientDeleted(client, xuiEmail, keepTraffic);
    await this.writeSyncLog(serverId || null, 'customer-node-delete', 'success', `Deleted ${xuiEmail}`, { ...detail, xuiEmail, keepTraffic, verified, response: this.toJsonValue(payload) });
    return { deleted: true, xuiEmail, verified, response: payload };
  }

  private async verifyRemoteClientDeleted(client: XuiClient, xuiEmail: string, keepTraffic: boolean) {
    const firstCheck = await this.remoteClientExists(client, xuiEmail);
    if (!firstCheck.exists) return { absent: true, checked: true, retried: false };

    const retryResponse = await client.deleteClient(xuiEmail, keepTraffic);
    this.assertXuiSuccess(retryResponse);
    const secondCheck = await this.remoteClientExists(client, xuiEmail);
    if (secondCheck.exists) throw new Error(`3x-ui client ${xuiEmail} still exists after retry delete`);

    return { absent: true, checked: true, retried: true, retryResponse: this.toJsonValue(retryResponse) };
  }

  private async remoteClientExists(client: XuiClient, xuiEmail: string) {
    try {
      const payload = await client.getClient(xuiEmail);
      this.assertXuiSuccess(payload);
      const object = this.xuiObject(payload);
      if ('obj' in object || 'data' in object) {
        const value = object.obj ?? object.data;
        if (!value) return { exists: false };
        if (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value as Record<string, unknown>).length) return { exists: false };
      }
      return { exists: Boolean(Object.keys(this.xuiObject(payload)).length) };
    } catch (error) {
      if (this.isRemoteNotFound(error)) return { exists: false };
      throw error;
    }
  }

  private shouldDeleteRemoteClient(customerNode?: { lastSyncedAt: Date | null; config: Prisma.JsonValue | null } | null) {
    if (!customerNode) return false;
    if (customerNode.lastSyncedAt) return true;
    const config = this.xuiObject(customerNode.config);
    return Boolean(config.subId || (Array.isArray(config.links) && config.links.length));
  }

  private buildXuiClient(input: { uuid: string; subId: string; email: string; enabled: boolean; expireAt?: Date | null; trafficLimitGb: Prisma.Decimal | number | string | null; flow?: string }) {
    return {
      id: input.uuid,
      uuid: input.uuid,
      email: input.email,
      enable: input.enabled,
      expiryTime: input.expireAt ? input.expireAt.getTime() : 0,
      totalGB: this.gbToBytes(input.trafficLimitGb),
      limitIp: 0,
      flow: input.flow || '',
      tgId: 0,
      subId: input.subId,
      reset: 0
    };
  }

  private async updateClientPreservingRemote(client: XuiClient, currentEmail: string, changes: Record<string, unknown>) {
    const payload = await client.getClient(currentEmail);
    this.assertXuiSuccess(payload);
    const remoteClient = this.clientRecordFromPayload(payload, currentEmail);
    if (!Object.keys(remoteClient).length) {
      throw new BadGatewayException(`3x-ui did not return the complete client record for ${currentEmail}`);
    }
    return client.updateClient(currentEmail, { ...remoteClient, ...changes });
  }

  private clientRecordFromPayload(payload: unknown, email: string): Record<string, unknown> {
    const root = this.xuiObject(payload);
    const wrapped = root.obj ?? root.data ?? root.result ?? payload;
    const object = this.xuiObject(wrapped);
    const direct = this.xuiObject(object.client ?? root.client);
    if (Object.keys(direct).length) return direct;
    if (this.clientEmailOf(object)) return object;

    const inbound = this.xuiObject(object.inbound ?? root.inbound ?? wrapped);
    const settings = this.xuiObject(this.parseMaybeJson(inbound.settings));
    const clients = Array.isArray(settings.clients) ? settings.clients : [];
    const match = clients.find((item) => this.normalizeIdentity(this.clientEmailOf(item)) === this.normalizeIdentity(email));
    return this.xuiObject(match);
  }

  private clientFlowForServiceNode(serviceNode: { protocol: string; config?: Prisma.JsonValue | null }) {
    const config = this.xuiObject(serviceNode.config);
    return this.clientFlowForProtocol(serviceNode.protocol, String(config.encryption || 'none'));
  }

  private clientFlowForProtocol(protocol: string, encryption: string) {
    return protocol === 'vless' && encryption === 'reality' ? 'xtls-rprx-vision' : '';
  }

  private buildInboundPayload(input: CreateServiceInboundInput & { port: number; tag: string; streamSettings: Record<string, unknown> }) {
    const protocol = input.protocol;
    const remark = input.remark || input.name;
    return {
      up: 0,
      down: 0,
      total: 0,
      remark,
      enable: input.enabled,
      expiryTime: 0,
      listen: '',
      port: input.port,
      protocol,
      settings: this.defaultInboundSettings(protocol),
      streamSettings: input.streamSettings,
      sniffing: {
        enabled: true,
        destOverride: ['http', 'tls', 'quic', 'fakedns'],
        metadataOnly: false,
        routeOnly: false
      },
      tag: input.tag,
      _shiyeManaged: true
    };
  }

  private defaultInboundSettings(protocol: string) {
    if (protocol === 'vless') return { clients: [], decryption: 'none', fallbacks: [] };
    if (protocol === 'vmess') return { clients: [] };
    if (protocol === 'trojan') return { clients: [], fallbacks: [] };
    if (protocol === 'shadowsocks') {
      return {
        method: 'aes-128-gcm',
        password: this.randomSecret(16),
        network: 'tcp,udp',
        clients: []
      };
    }
    if (protocol === 'socks') return { auth: 'noauth', accounts: [], udp: true, ip: '127.0.0.1' };
    if (protocol === 'http') return { accounts: [] };
    if (protocol === 'mixed') return { auth: 'noauth', accounts: [], udp: true, ip: '127.0.0.1' };
    return { clients: [] };
  }

  private mergeInboundSettings(protocol: string, currentSettings: Record<string, unknown>) {
    const next = this.xuiObject(this.defaultInboundSettings(protocol));
    if (Array.isArray(currentSettings.clients)) next.clients = currentSettings.clients;
    if (Array.isArray(currentSettings.accounts)) next.accounts = currentSettings.accounts;
    for (const key of ['method', 'password', 'network', 'auth', 'ip', 'udp']) {
      if (currentSettings[key] !== undefined) next[key] = currentSettings[key];
    }
    return next;
  }

  private async defaultStreamSettings(client: XuiClient, security: string, serverConfig: Record<string, unknown> = {}) {
    const base: Record<string, unknown> = {
      network: 'tcp',
      tcpSettings: { acceptProxyProtocol: false, header: { type: 'none' } }
    };
    if (security === 'tls') {
      const certFiles = await this.resolveTlsCertFiles(client, serverConfig);
      const serverName = String(serverConfig.tlsServerName || '').trim();
      return {
        ...base,
        security: 'tls',
        tlsSettings: {
          serverName,
          minVersion: '1.2',
          maxVersion: '',
          cipherSuites: '',
          rejectUnknownSni: false,
          certificates: [{ certificateFile: certFiles.certFile, keyFile: certFiles.keyFile, ocspStapling: 3600 }],
          alpn: ['h2', 'http/1.1']
        }
      };
    }
    if (security === 'reality') {
      const keys = await this.resolveRealityKeys(client);
      const realityTarget = await this.resolveRealityTarget(client, serverConfig);
      const target = realityTarget.target;
      const serverName = realityTarget.serverName;
      const fingerprint = String(serverConfig.realityFingerprint || 'chrome').trim() || 'chrome';
      const spiderX = String(serverConfig.realitySpiderX || '/').trim() || '/';
      const shortId = this.randomShortId();
      return {
        ...base,
        security: 'reality',
        realitySettings: {
          show: false,
          xver: 0,
          dest: target,
          target,
          serverNames: [serverName],
          privateKey: keys.privateKey,
          publicKey: keys.publicKey,
          minClient: '',
          maxClient: '',
          maxTimediff: 0,
          alpn: ['h3', 'h2', 'http/1.1'],
          shortIds: [shortId],
          fingerprint,
          serverName,
          spiderX,
          settings: { publicKey: keys.publicKey, fingerprint, serverName, spiderX, shortId }
        }
      };
    }
    return { ...base, security: 'none' };
  }

  private async resolveWebCertFiles(client: XuiClient) {
    const result = await this.readWebCertFiles(client);
    const certFile = result.certFile;
    const keyFile = result.keyFile;
    if (!certFile || !keyFile) throw new BadGatewayException('3x-ui 没有返回可用的 TLS 证书路径，请先在 3x-ui 面板配置 Web 证书，或选择 Reality/none');
    return { certFile, keyFile };
  }

  private async readWebCertFiles(client: XuiClient) {
    const payload = await client.getWebCertFiles();
    this.assertXuiSuccess(payload);
    const object = this.xuiObject(this.xuiObject(payload).obj || this.xuiObject(payload).data || payload);
    const certFile = String(object.webCertFile || object.certFile || object.certificateFile || object.cert || object.certPath || object.publicKeyPath || '').trim();
    const keyFile = String(object.webKeyFile || object.keyFile || object.privateKeyFile || object.key || object.keyPath || object.privateKeyPath || '').trim();
    return {
      found: Boolean(certFile && keyFile),
      certFile,
      keyFile,
      message: certFile && keyFile ? '已读取到 3x-ui 面板 Web 证书路径' : '3x-ui 没有返回完整的 Web 证书路径',
      raw: payload
    };
  }

  private async resolveTlsCertFiles(client: XuiClient, serverConfig: Record<string, unknown>) {
    const certFile = String(serverConfig.tlsCertFile || '').trim();
    const keyFile = String(serverConfig.tlsKeyFile || '').trim();
    if (certFile && keyFile) return { certFile, keyFile };
    return this.resolveWebCertFiles(client);
  }

  private async resolveRealityKeys(client: XuiClient) {
    const payload = await client.getNewX25519Cert();
    this.assertXuiSuccess(payload);
    const object = this.xuiObject(this.xuiObject(payload).obj || this.xuiObject(payload).data || payload);
    const privateKey = String(object.privateKey || object.private_key || '').trim();
    const publicKey = String(object.publicKey || object.public_key || '').trim();
    if (!privateKey || !publicKey) throw new BadGatewayException('3x-ui 没有返回 Reality X25519 密钥');
    return { privateKey, publicKey };
  }

  private async resolveRealityTarget(client: XuiClient, serverConfig: Record<string, unknown>): Promise<RealityTargetInfo> {
    const configuredTarget = String(serverConfig.realityTarget || '').trim();

    const scanned = await this.scanRealityTargets(client).catch(() => null);
    const discovered = this.bestRealityScanResult(scanned);
    if (discovered) {
      const info = this.realityInfoFromScan(discovered, serverConfig);
      if (info) return info;
    }

    if (configuredTarget) {
      const targetSeed = this.normalizeRealityTarget(configuredTarget);
      const single = await this.scanRealityTarget(client, targetSeed).catch(() => null);
      const info = this.realityInfoFromScan(single, serverConfig, targetSeed);
      if (info) return info;
    }

    throw new BadRequestException('Reality 自动创建没有扫描到可用目标网站，请检查 3x-ui 面板网络或稍后重试。');
  }

  private async scanRealityTarget(client: XuiClient, target: string) {
    const payload = await client.scanRealityTarget(target);
    this.assertXuiSuccess(payload);
    return this.xuiObject(this.xuiObject(payload).obj || this.xuiObject(payload).data || payload);
  }

  private async scanRealityTargets(client: XuiClient, targets?: string) {
    const payload = await client.scanRealityTargets(targets);
    this.assertXuiSuccess(payload);
    return this.xuiArray(payload).map((item) => this.xuiObject(item));
  }

  private bestRealityScanResult(results: unknown) {
    const candidates = Array.isArray(results) ? results.map((item) => this.xuiObject(item)) : [];
    return candidates.find((item) => item.feasible === true && this.stringValue(item.target))
      || candidates.find((item) => item.feasible !== false && this.stringValue(item.target));
  }

  private realityInfoFromScan(scan: Record<string, unknown> | null | undefined, serverConfig: Record<string, unknown>, fallbackTarget?: string): RealityTargetInfo | null {
    if (!scan) return null;
    if (scan.feasible === false) return null;
    const targetValue = this.stringValue(scan.target) || fallbackTarget;
    if (!targetValue) return null;
    const target = this.normalizeRealityTarget(targetValue);
    const serverName = this.realityServerNameFromScan(serverConfig, target, scan);
    return { target, serverName, scan };
  }

  private realityServerNameFromScan(serverConfig: Record<string, unknown>, target: string, scan?: Record<string, unknown>) {
    const serverNames = Array.isArray(scan?.serverNames) ? scan.serverNames.map((item) => String(item).trim()).filter(Boolean) : [];
    const scannedName = serverNames.find((item) => !item.startsWith('*.') && !this.isIpAddress(item)) || this.stringValue(scan?.host);
    if (scannedName && !this.isIpAddress(scannedName)) return scannedName;
    const host = this.hostFromTarget(target);
    if (host && !this.isIpAddress(host)) return host;
    const configured = String(serverConfig.realityServerName || '').trim();
    if (configured) return configured;
    throw new BadRequestException('Reality requires a domain SNI. Set Reality SNI or use a scan result with a domain.');
  }

  private realityTarget(serverConfig: Record<string, unknown>) {
    const target = String(serverConfig.realityTarget || '').trim();
    if (target) return this.normalizeRealityTarget(target);
    const host = this.hostFromUrl(String(serverConfig.baseUrl || ''));
    if (host && !this.isIpAddress(host)) return `${host}:443`;

    throw new BadRequestException('Reality 自动创建需要 3x-ui 面板地址使用域名，或在服务器配置里填写 Reality 目标，例如 example.com:443');
  }

  private realityServerName(serverConfig: Record<string, unknown>, target: string) {
    const configured = String(serverConfig.realityServerName || '').trim();
    if (configured) return configured;
    const host = this.hostFromTarget(target);
    if (host && !this.isIpAddress(host)) return host;
    throw new BadRequestException('Reality 自动创建需要可用域名作为 SNI，请使用域名面板地址或填写 Reality SNI');
  }

  private realityLogDetail(streamSettings: Record<string, unknown>) {
    if (String(streamSettings.security || '') !== 'reality') return undefined;
    const settings = this.xuiObject(streamSettings.realitySettings);
    return {
      target: this.stringValue(settings.dest) || this.stringValue(settings.target),
      serverName: this.stringValue(settings.serverName) || this.xuiArray(settings.serverNames).map((item) => String(item)).find(Boolean) || '',
      alpn: this.xuiArray(settings.alpn).map((item) => String(item)).filter(Boolean)
    };
  }

  private normalizeRealityTarget(target: string) {
    const trimmed = target.trim();
    const host = this.hostFromTarget(trimmed);
    if (!host) throw new BadRequestException('Reality 目标格式不正确，请填写 example.com:443');
    if (/\]:\d+$/.test(trimmed) || /:\d+$/.test(trimmed)) return trimmed;
    return `${trimmed}:443`;
  }

  private hostFromTarget(target: string) {
    const trimmed = target.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('[')) return trimmed.slice(1, trimmed.indexOf(']'));
    return trimmed.split(':')[0];
  }

  private hostFromUrl(value: string) {
    try {
      return new URL(value).hostname;
    } catch {
      return '';
    }
  }

  private isIpAddress(value: string) {
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) || value.includes(':');
  }

  private async linksForClient(client: XuiClient, email: string, subId?: string) {
    const payload = await client.clientLinks(email);
    this.assertXuiSuccess(payload);
    const links = this.extractLinks(payload);
    if (links.length) return links;
    if (!subId) return [];

    const subPayload = await client.subLinks(subId);
    this.assertXuiSuccess(subPayload);
    return this.extractLinks(subPayload);
  }

  private async requireLinksForServiceNode(
    client: XuiClient,
    email: string,
    subId: string | undefined,
    context: { serverId: string; inboundId: number; serviceNodeName: string; protocol: string; encryption: string }
  ) {
    try {
      const links = await this.linksForClient(client, email, subId);
      if (links.length) return links;
      throw new Error('3x-ui returned an empty link list');
    } catch (error) {
      await this.writeSyncLog(context.serverId, 'service-node-link-verify', 'failed', this.errorMessage(error), {
        inboundId: context.inboundId,
        serviceNodeName: context.serviceNodeName,
        protocol: context.protocol,
        encryption: context.encryption,
        remoteClientEmail: email,
        remoteClientSubId: subId
      });
      const hint = context.encryption === 'reality' ? 'Reality 目标/SNI/ALPN' : '入站协议和客户端';
      throw new BadGatewayException(`3x-ui 已创建入站和客户端，但没有返回可用节点链接。请检查 ${hint} 配置后重试：${this.errorMessage(error)}`);
    }
  }

  private async cleanupFailedServiceNodeCreate(client: XuiClient, serverId: string, inboundId: number, email: string, cause: unknown) {
    const detail: Record<string, unknown> = { inboundId, remoteClientEmail: email, cause: this.errorMessage(cause) };
    detail.remoteClientCleanup = await this.deleteRemoteClientWithClient(client, serverId, email, false, { inboundId, action: 'service-node-create-rollback' })
      .catch((error) => ({ deleted: false, message: this.errorMessage(error) }));
    detail.inboundCleanup = await client.deleteInbound(inboundId)
      .then((response) => {
        this.assertXuiSuccess(response);
        return { deleted: true, response: this.toJsonValue(response) };
      })
      .catch((error) => ({ deleted: false, message: this.errorMessage(error) }));
    await this.writeSyncLog(serverId, 'service-node-inbound-create-rollback', 'failed', this.errorMessage(cause), detail);
  }

  private extractLinks(payload: unknown) {
    const links = this.xuiArray(payload).filter((item): item is string => this.isShareLink(item));
    if (links.length) return links;
    const object = this.xuiObject(payload);
    for (const key of ['links', 'urls', 'obj', 'data']) {
      const value = this.parseMaybeJson(object[key]);
      if (Array.isArray(value)) return value.filter((item): item is string => this.isShareLink(item));
    }
    return [];
  }

  private renameShareLinks(links: string[], displayName: string) {
    const name = displayName.trim();
    if (!name) return links;
    return links.map((link) => this.renameShareLink(link, name));
  }

  private renameShareLink(link: string, displayName: string) {
    const value = link.trim();
    if (/^vmess:\/\//i.test(value)) return this.renameVmessShareLink(value, displayName);
    const hashIndex = value.indexOf('#');
    const linkWithoutName = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
    return `${linkWithoutName}#${encodeURIComponent(displayName)}`;
  }

  private renameVmessShareLink(link: string, displayName: string) {
    try {
      const payload = link.slice('vmess://'.length);
      const config = JSON.parse(Buffer.from(this.normalizeBase64(payload), 'base64').toString('utf8')) as Record<string, unknown>;
      config.ps = displayName;
      return `vmess://${Buffer.from(JSON.stringify(config), 'utf8').toString('base64')}`;
    } catch {
      return this.renameFragmentShareLink(link, displayName);
    }
  }

  private renameFragmentShareLink(link: string, displayName: string) {
    const hashIndex = link.indexOf('#');
    const linkWithoutName = hashIndex >= 0 ? link.slice(0, hashIndex) : link;
    return `${linkWithoutName}#${encodeURIComponent(displayName)}`;
  }

  private normalizeBase64(value: string) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    return normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, '=');
  }

  private async findClient(client: XuiClient, lookup: ClientLookup, inbounds: unknown[]): Promise<ClientMatch> {
    if (lookup.email) {
      try {
        const payload = await client.getClient(lookup.email);
        this.assertXuiSuccess(payload);
        const found = this.clientIdentityFromPayload(payload);
        if (this.clientMatches(found, lookup)) return { exists: true, raw: payload, ...found };
      } catch (error) {
        if (!this.isRemoteNotFound(error)) throw error;
      }
    }

    const sorted = [...inbounds].sort((a, b) => {
      if (!lookup.inboundId) return 0;
      const aTarget = this.inboundIdOf(a) === lookup.inboundId ? 1 : 0;
      const bTarget = this.inboundIdOf(b) === lookup.inboundId ? 1 : 0;
      return bTarget - aTarget;
    });

    for (const inbound of sorted) {
      const settings = this.parseMaybeJson(this.xuiObject(inbound).settings);
      const settingsObject = this.xuiObject(settings);
      const clients = Array.isArray(settingsObject.clients) ? settingsObject.clients : [];
      for (const item of clients) {
        const found = this.clientIdentity(item);
        if (this.clientMatches(found, lookup)) return { exists: true, raw: inbound, ...found };
      }
    }
    return { exists: false, raw: null };
  }

  private async loadRemoteSocksRouteState(client: XuiClient): Promise<RemoteSocksRouteState> {
    const xrayPayload = await client.getXrayConfig();
    this.assertXuiSuccess(xrayPayload);
    const xrayObj = this.xuiObject(this.xuiObject(xrayPayload).obj || this.xuiObject(xrayPayload).data || xrayPayload);
    const rawSetting = xrayObj.xraySetting ?? xrayObj;
    const state = this.remoteSocksRouteState(this.xuiObject(rawSetting));
    await this.mergeOutboundSubscriptions(client, state);
    return state;
  }

  private remoteSocksRouteState(config: Record<string, unknown>): RemoteSocksRouteState {
    const socksOutbounds = new Map<string, RemoteSocksOutbound>();
    const outbounds = this.extractOutbounds(config);
    for (const item of outbounds) {
      this.addRemoteSocksOutbound(socksOutbounds, item);
    }

    const routesByInboundTag = new Map<string, { outboundTag: string; rule: Record<string, unknown> }>();
    const routing = this.xuiObject(config.routing);
    const rules = Array.isArray(routing.rules) ? routing.rules : [];
    for (const item of rules) {
      const rule = this.xuiObject(item);
      const outboundTag = this.stringList(rule.outboundTag).find((tag) => socksOutbounds.has(tag));
      if (!outboundTag) continue;
      for (const inboundTag of this.stringList(rule.inboundTag)) {
        if (!routesByInboundTag.has(inboundTag)) routesByInboundTag.set(inboundTag, { outboundTag, rule });
      }
    }

    return { socksOutbounds, routesByInboundTag };
  }

  private async mergeOutboundSubscriptions(client: XuiClient, state: RemoteSocksRouteState) {
    let subscriptions: unknown[] = [];
    try {
      const payload = await client.listOutboundSubscriptions();
      this.assertXuiSuccess(payload);
      subscriptions = this.xuiArray(payload);
    } catch {
      return;
    }

    for (const item of subscriptions) {
      const subscription = this.xuiObject(item);
      const id = subscription.id ?? subscription.subId ?? subscription.subscriptionId;
      if (id === undefined || id === null || id === '') continue;
      try {
        const payload = await client.refreshOutboundSubscription(String(id));
        this.assertXuiSuccess(payload);
        for (const outbound of this.extractOutbounds(payload)) this.addRemoteSocksOutbound(state.socksOutbounds, outbound);
      } catch {
        // A failed subscription refresh should not block normal inbound sync.
      }
    }
  }

  private addRemoteSocksOutbound(target: Map<string, RemoteSocksOutbound>, item: unknown) {
    const outbound = this.xuiObject(item);
    if (String(outbound.protocol || '').toLowerCase() !== 'socks') return;
    const tag = this.stringValue(outbound.tag);
    const settings = this.xuiObject(outbound.settings);
    const servers = Array.isArray(settings.servers) ? settings.servers : [];
    const server = this.xuiObject(servers[0]);
    const host = this.stringValue(server.address) || this.stringValue(server.host);
    const port = this.positiveInteger(server.port);
    if (!tag || !host || !port) return;
    const users = Array.isArray(server.users) ? server.users : [];
    const user = this.xuiObject(users[0]);
    target.set(tag, {
      tag,
      host,
      port,
      username: this.stringValue(user.user) || this.stringValue(user.username),
      password: this.stringValue(user.pass) || this.stringValue(user.password)
    });
  }

  private extractOutbounds(value: unknown, seen = new Set<unknown>()): unknown[] {
    const parsed = this.parseMaybeJson(value);
    if (!parsed || typeof parsed !== 'object') return [];
    if (seen.has(parsed)) return [];
    seen.add(parsed);

    if (Array.isArray(parsed)) return parsed.flatMap((item) => this.extractOutbounds(item, seen));

    const object = parsed as Record<string, unknown>;
    const self = this.isOutboundConfig(object) ? [object] : [];
    const direct = Array.isArray(object.outbounds) ? object.outbounds : [];
    const nestedKeys = ['obj', 'data', 'result', 'items', 'config', 'xraySetting', 'settings'];
    const nested = nestedKeys.flatMap((key) => this.extractOutbounds(object[key], seen));
    return [...self, ...direct, ...nested];
  }

  private isOutboundConfig(value: Record<string, unknown>) {
    return Boolean(this.stringValue(value.protocol) && this.stringValue(value.tag) && value.settings !== undefined);
  }

  private async importRemoteSocksForInbound(serverId: string, serverName: string, inboundTag: string, state: RemoteSocksRouteState, directOutboundTags: string[] = []) {
    const route = state.routesByInboundTag.get(inboundTag);
    const outboundTag = directOutboundTags.find((tag) => state.socksOutbounds.has(tag)) || route?.outboundTag;
    if (!outboundTag) return null;
    const outbound = state.socksOutbounds.get(outboundTag);
    if (!outbound) return null;

    const socksNode = await this.upsertRemoteSocksNode(serverId, serverName, outbound);

    return { socksNodeId: socksNode.id, outboundTag: outbound.tag };
  }

  private async importRemoteSocksOutbounds(serverId: string, serverName: string, state: RemoteSocksRouteState) {
    const imported = [] as Array<{ socksNodeId: string; outboundTag: string }>;
    for (const outbound of state.socksOutbounds.values()) {
      const socksNode = await this.upsertRemoteSocksNode(serverId, serverName, outbound);
      imported.push({ socksNodeId: socksNode.id, outboundTag: outbound.tag });
    }
    return imported;
  }

  private async upsertRemoteSocksNode(serverId: string, serverName: string, outbound: RemoteSocksOutbound) {
    const username = outbound.username || null;
    const passwordEnc = this.encryption.encryptNullable(outbound.password);
    const existing = await this.prisma.socksNode.findFirst({
      where: {
        OR: [
          { sourceServerId: serverId, remoteOutboundTag: outbound.tag },
          { sourceServerId: null, remoteOutboundTag: null, host: outbound.host, port: outbound.port, username, remark: `Imported from 3x-ui outbound ${outbound.tag}` }
        ]
      }
    });
    if (existing) {
      return this.prisma.socksNode.update({
        where: { id: existing.id },
        data: {
          name: this.truncateText(`${serverName} ${outbound.tag}`, 120),
          host: outbound.host,
          port: outbound.port,
          username,
          passwordEnc,
          enabled: true,
          remark: `Imported from 3x-ui outbound ${outbound.tag}`,
          sourceServerId: serverId,
          remoteOutboundTag: outbound.tag
        }
      });
    }

    return this.prisma.socksNode.create({
      data: {
        name: this.truncateText(`${serverName} ${outbound.tag}`, 120),
        host: outbound.host,
        port: outbound.port,
        username,
        passwordEnc,
        enabled: true,
        remark: `Imported from 3x-ui outbound ${outbound.tag}`,
        sourceServerId: serverId,
        remoteOutboundTag: outbound.tag
      }
    });
  }

  private removeManagedSocksRoute(config: Record<string, unknown>, serviceNodeId: string, inboundTag?: string, remoteOutboundTag?: string) {
    const next: Record<string, unknown> = { ...config };
    const outboundTag = this.socksOutboundTag(serviceNodeId);
    const explicitOutboundTags = new Set([outboundTag, remoteOutboundTag].filter((item): item is string => Boolean(item)));
    const outbounds = Array.isArray(next.outbounds) ? next.outbounds : [];
    const socksOutboundTags = new Set(
      outbounds
        .map((item) => this.xuiObject(item))
        .filter((item) => String(item.protocol || '').toLowerCase() === 'socks')
        .map((item) => this.stringValue(item.tag))
        .filter((item): item is string => Boolean(item))
    );
    const removedOutboundTags = new Set<string>(explicitOutboundTags);

    const routing = this.xuiObject(next.routing);
    if (Object.keys(routing).length) {
      const rules = Array.isArray(routing.rules) ? routing.rules : [];
      routing.rules = rules.filter((item) => {
        const rule = this.xuiObject(item);
        const shouldRemove = this.isManagedSocksRouteRule(rule, serviceNodeId, explicitOutboundTags, socksOutboundTags, inboundTag);
        if (shouldRemove) {
          for (const tag of this.stringList(rule.outboundTag)) {
            if (explicitOutboundTags.has(tag) || socksOutboundTags.has(tag)) removedOutboundTags.add(tag);
          }
        }
        return !shouldRemove;
      });
      next.routing = routing;
    }

    const nextRouting = this.xuiObject(next.routing);
    const remainingRules = Array.isArray(nextRouting.rules) ? nextRouting.rules : [];
    const stillReferencedOutboundTags = new Set<string>();
    for (const item of remainingRules) {
      for (const tag of this.stringList(this.xuiObject(item).outboundTag)) stillReferencedOutboundTags.add(tag);
    }
    next.outbounds = outbounds.filter((item) => {
      const outbound = this.xuiObject(item);
      const tag = this.stringValue(outbound.tag);
      if (!tag) return true;
      const isServiceManaged = outbound._shiyeServiceNodeId === serviceNodeId || (outbound._shiyeManaged === true && outbound._shiyeMark === SHIYE_ROUTE_MARK && explicitOutboundTags.has(tag));
      if (tag === outboundTag || isServiceManaged) return false;
      return !(removedOutboundTags.has(tag) && !stillReferencedOutboundTags.has(tag));
    });

    return next;
  }

  private isManagedSocksRouteRule(
    rule: Record<string, unknown>,
    serviceNodeId: string,
    explicitOutboundTags: Set<string>,
    socksOutboundTags: Set<string>,
    inboundTag?: string
  ) {
    const outboundTags = this.stringList(rule.outboundTag);
    if (rule._shiyeServiceNodeId === serviceNodeId) return true;
    if (outboundTags.some((tag) => tag === this.socksOutboundTag(serviceNodeId))) return true;
    if (rule._shiyeManaged === true && rule._shiyeMark === SHIYE_ROUTE_MARK && outboundTags.some((tag) => explicitOutboundTags.has(tag))) return true;
    if (!inboundTag || !this.stringList(rule.inboundTag).includes(inboundTag)) return false;
    return outboundTags.some((tag) => explicitOutboundTags.has(tag) || socksOutboundTags.has(tag));
  }

  private buildSocksOutbound(tag: string, socksNode: { host: string; port: number; username: string | null; passwordEnc: string | null }, serviceNodeId: string) {
    const user = socksNode.username
      ? [{ user: socksNode.username, pass: socksNode.passwordEnc ? this.encryption.decrypt(socksNode.passwordEnc) : '' }]
      : undefined;
    return {
      tag,
      protocol: 'socks',
      settings: {
        servers: [{ address: socksNode.host, port: socksNode.port, users: user }]
      },
      streamSettings: { network: 'tcp' },
      _shiyeManaged: true,
      _shiyeServiceNodeId: serviceNodeId,
      _shiyeMark: SHIYE_ROUTE_MARK
    };
  }

  private ensureRouting(config: Record<string, unknown>) {
    const routing = this.xuiObject(config.routing);
    if (!Array.isArray(routing.rules)) routing.rules = [];
    return routing;
  }

  private socksOutboundTag(serviceNodeId: string) {
    return `shiye-socks-${serviceNodeId.slice(0, 18)}`;
  }

  private async verifyRemoteInboundDeleted(client: XuiClient, inboundId: number) {
    const firstCheck = await this.remoteInboundExists(client, inboundId);
    if (!firstCheck.exists) return { absent: true, checked: true, retried: false };

    const retryResponse = await client.deleteInbound(inboundId);
    this.assertXuiSuccess(retryResponse);
    const secondCheck = await this.remoteInboundExists(client, inboundId);
    if (secondCheck.exists) throw new Error(`3x-ui inbound ${inboundId} still exists after retry delete`);

    return { absent: true, checked: true, retried: true, retryResponse: this.toJsonValue(retryResponse) };
  }

  private async remoteInboundExists(client: XuiClient, inboundId: number) {
    try {
      const payload = await client.getInbound(inboundId);
      this.assertXuiSuccess(payload);
      const object = this.xuiObject(payload);
      if ('obj' in object || 'data' in object) {
        const value = object.obj ?? object.data;
        if (!value) return { exists: false };
        const inbound = this.xuiObject(value);
        const id = this.inboundIdOf(inbound);
        return { exists: id ? id === inboundId : Boolean(Object.keys(inbound).length) };
      }
      const inbound = this.xuiObject(payload);
      const id = this.inboundIdOf(inbound);
      return { exists: id === inboundId };
    } catch (error) {
      if (this.isRemoteNotFound(error)) return { exists: false };
      throw error;
    }
  }

  private isRemoteNotFound(error: unknown) {
    return /not found|record not found|404|不存在|未找到|没有找到|未发现|未查询到|找不到|not exist|does not exist|no .*found|empty/i.test(this.errorMessage(error));
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

  private remoteInboundName(inbound: Record<string, unknown>, inboundId: number) {
    return String(inbound.remark || inbound.tag || `Inbound ${inboundId}`).trim() || `Inbound ${inboundId}`;
  }

  private remoteInboundFromPayload(payload: unknown) {
    const object = this.xuiObject(payload);
    const value = object.obj ?? object.data ?? object.result ?? object.inbound ?? payload;
    return this.xuiObject(value);
  }

  private positiveInteger(value: unknown) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : undefined;
  }

  private booleanValue(value: unknown, fallback: boolean) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    return fallback;
  }

  private clientEmailOf(item: unknown) {
    const object = this.xuiObject(item);
    return String(object.email || object.clientEmail || object.name || '').trim();
  }

  private clientUuidOf(item: unknown) {
    const object = this.xuiObject(item);
    return String(object.id || object.uuid || object.password || '').trim();
  }

  private clientSubIdOf(item: unknown) {
    const object = this.xuiObject(item);
    return String(object.subId || object.sub_id || object.subscriptionId || '').trim();
  }

  private clientIdentity(item: unknown) {
    return {
      email: this.clientEmailOf(item) || undefined,
      uuid: this.clientUuidOf(item) || undefined,
      subId: this.clientSubIdOf(item) || undefined
    };
  }

  private clientIdentityFromPayload(payload: unknown) {
    const object = this.xuiObject(payload);
    const candidates = [object.client, object.clientStats, object.client_stat, object.obj, object.data, object];
    for (const candidate of candidates) {
      const identity = this.clientIdentity(candidate);
      if (identity.email || identity.uuid || identity.subId) return identity;
    }
    return {};
  }

  private firstInboundClientIdentity(inbound: unknown): { email?: string; uuid?: string; subId?: string } {
    const settings = this.parseMaybeJson(this.xuiObject(inbound).settings);
    const settingsObject = this.xuiObject(settings);
    const clients = Array.isArray(settingsObject.clients) ? settingsObject.clients : [];
    for (const item of clients) {
      const identity = this.clientIdentity(item);
      if (identity.email || identity.uuid || identity.subId) return identity;
    }
    return {};
  }

  private clientMatches(identity: { email?: string; uuid?: string; subId?: string }, lookup: ClientLookup) {
    const email = this.normalizeIdentity(identity.email);
    const uuid = this.normalizeIdentity(identity.uuid);
    const subId = this.normalizeIdentity(identity.subId);
    return Boolean(
      (lookup.email && email && email === this.normalizeIdentity(lookup.email)) ||
      (lookup.uuid && uuid && uuid === this.normalizeIdentity(lookup.uuid)) ||
      (lookup.subId && subId && subId === this.normalizeIdentity(lookup.subId))
    );
  }

  private normalizeIdentity(value?: string) {
    return String(value || '').trim().toLowerCase();
  }

  private stringValue(value: unknown) {
    return typeof value === 'string' ? value.trim() || undefined : undefined;
  }

  private stringList(value: unknown) {
    if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
    const text = this.stringValue(value);
    return text ? [text] : [];
  }

  private truncateText(value: string, maxLength: number) {
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }

  private isShareLink(item: unknown): item is string {
    return typeof item === 'string' && /^(vless|vmess|trojan|ss|shadowsocks|hysteria|hy2):\/\//i.test(item.trim());
  }

  private gbToBytes(value: Prisma.Decimal | number | string | null) {
    if (value === null) return 0;
    const gb = Number(value);
    if (!Number.isFinite(gb) || gb <= 0) return 0;
    return Math.round(gb * 1024 * 1024 * 1024);
  }

  private subscriptionId(uuid: string) {
    return uuid.replace(/-/g, '').slice(0, 16);
  }

  private serviceInboundTag() {
    return `shiye-inbound-${randomUUID().replace(/-/g, '').slice(0, 18)}`;
  }

  private serviceClientEmail(name: string, inboundId: number) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'node';
    return `shiye-${slug}-${inboundId}@shiye.local`;
  }

  private pickInboundPort(usedPorts: Set<number>) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const port = 20000 + Math.floor(Math.random() * 30000);
      if (!usedPorts.has(port)) return port;
    }
    for (let port = 20000; port <= 50000; port += 1) {
      if (!usedPorts.has(port)) return port;
    }
    throw new BadRequestException('没有可用的 3x-ui 入站端口');
  }

  private extractCreatedInboundId(payload: unknown) {
    const direct = this.inboundIdOf(payload);
    if (direct) return direct;
    const object = this.xuiObject(payload);
    for (const key of ['obj', 'data', 'result', 'inbound']) {
      const value = object[key];
      const id = this.inboundIdOf(value);
      if (id) return id;
    }
    return 0;
  }

  private randomSecret(bytes = 24) {
    return randomBytes(bytes).toString('base64url');
  }

  private randomShortId() {
    return randomBytes(8).toString('hex');
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
