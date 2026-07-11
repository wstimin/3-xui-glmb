import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { customerNodeCreateSchema, serviceNodeUpsertSchema, socksNodeUpsertSchema, xuiServerUpsertSchema } from '@shiye/shared';
import type { z } from 'zod';
import { AuthGuard } from '../../shared/auth.guard.js';
import { CurrentUser } from '../../shared/current-user.decorator.js';
import { Roles } from '../../shared/roles.decorator.js';
import type { SessionUser } from '../../shared/auth.types.js';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe.js';
import { NodesService } from './nodes.service.js';

@Controller()
export class NodesController {
  constructor(private readonly nodes: NodesService) {}

  @Get('admin/xui-servers')
  @UseGuards(AuthGuard)
  @Roles('admin')
  servers() { return this.nodes.listServers(); }

  @Post('admin/xui-servers')
  @UseGuards(AuthGuard)
  @Roles('admin')
  createServer(@Body(new ZodValidationPipe(xuiServerUpsertSchema)) body: z.infer<typeof xuiServerUpsertSchema>) { return this.nodes.createServer(body); }

  @Patch('admin/xui-servers/:id')
  @UseGuards(AuthGuard)
  @Roles('admin')
  updateServer(@Param('id') id: string, @Body(new ZodValidationPipe(xuiServerUpsertSchema.partial())) body: Partial<z.infer<typeof xuiServerUpsertSchema>>) { return this.nodes.updateServer(id, body); }

  @Delete('admin/xui-servers/:id')
  @UseGuards(AuthGuard)
  @Roles('admin')
  deleteServer(@Param('id') id: string) { return this.nodes.deleteServer(id); }

  @Get('admin/service-nodes')
  @UseGuards(AuthGuard)
  @Roles('admin')
  serviceNodes() { return this.nodes.listServiceNodes(); }

  @Post('admin/service-nodes')
  @UseGuards(AuthGuard)
  @Roles('admin')
  createServiceNode(@Body(new ZodValidationPipe(serviceNodeUpsertSchema)) body: z.infer<typeof serviceNodeUpsertSchema>) { return this.nodes.createServiceNode(body); }

  @Patch('admin/service-nodes/:id')
  @UseGuards(AuthGuard)
  @Roles('admin')
  updateServiceNode(@Param('id') id: string, @Body(new ZodValidationPipe(serviceNodeUpsertSchema.partial())) body: Partial<z.infer<typeof serviceNodeUpsertSchema>>) { return this.nodes.updateServiceNode(id, body); }

  @Delete('admin/service-nodes/:id')
  @UseGuards(AuthGuard)
  @Roles('admin')
  deleteServiceNode(@Param('id') id: string) { return this.nodes.deleteServiceNode(id); }

  @Post('admin/service-nodes/:id/sync-traffic-limit')
  @UseGuards(AuthGuard)
  @Roles('admin')
  syncServiceNodeTrafficLimit(@Param('id') id: string) { return this.nodes.syncServiceNodeTrafficLimit(id); }

  @Get('admin/socks-nodes')
  @UseGuards(AuthGuard)
  @Roles('admin')
  socksNodes() { return this.nodes.listSocksNodes(); }

  @Post('admin/socks-nodes')
  @UseGuards(AuthGuard)
  @Roles('admin')
  createSocksNode(@Body(new ZodValidationPipe(socksNodeUpsertSchema)) body: z.infer<typeof socksNodeUpsertSchema>) { return this.nodes.createSocksNode(body); }

  @Patch('admin/socks-nodes/:id')
  @UseGuards(AuthGuard)
  @Roles('admin')
  updateSocksNode(@Param('id') id: string, @Body(new ZodValidationPipe(socksNodeUpsertSchema.partial())) body: Partial<z.infer<typeof socksNodeUpsertSchema>>) { return this.nodes.updateSocksNode(id, body); }

  @Delete('admin/socks-nodes/:id')
  @UseGuards(AuthGuard)
  @Roles('admin')
  deleteSocksNode(@Param('id') id: string) { return this.nodes.deleteSocksNode(id); }

  @Get('user/nodes')
  @UseGuards(AuthGuard)
  @Roles('user')
  userNodes(@CurrentUser() user: SessionUser) { return this.nodes.listUserNodes(user.customerId || ''); }

  @Post('admin/customers/:id/nodes')
  @UseGuards(AuthGuard)
  @Roles('admin')
  bindCustomerNode(@Param('id') id: string, @Body(new ZodValidationPipe(customerNodeCreateSchema)) body: z.infer<typeof customerNodeCreateSchema>) {
    return this.nodes.bindCustomerNode(id, body);
  }

  @Patch('admin/customers/:id/nodes/:nodeId')
  @UseGuards(AuthGuard)
  @Roles('admin')
  updateCustomerNode(@Param('id') id: string, @Param('nodeId') nodeId: string, @Body(new ZodValidationPipe(customerNodeCreateSchema.partial())) body: Partial<z.infer<typeof customerNodeCreateSchema>>) {
    return this.nodes.updateCustomerNode(id, nodeId, body);
  }

  @Delete('admin/customers/:id/nodes/:nodeId')
  @UseGuards(AuthGuard)
  @Roles('admin')
  unbindCustomerNode(@Param('id') id: string, @Param('nodeId') nodeId: string) {
    return this.nodes.unbindCustomerNode(id, nodeId);
  }

  @Delete('admin/customers/:id/nodes/:nodeId/service-node')
  @UseGuards(AuthGuard)
  @Roles('admin')
  deleteServiceNodeFromCustomerNode(@Param('id') id: string, @Param('nodeId') nodeId: string) {
    return this.nodes.deleteServiceNodeFromCustomerNode(id, nodeId);
  }
}
