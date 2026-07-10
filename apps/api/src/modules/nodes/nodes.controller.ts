import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards, UsePipes } from '@nestjs/common';
import { customerNodeCreateSchema, serviceNodeUpsertSchema, xuiServerUpsertSchema } from '@shiye/shared';
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
  @UsePipes(new ZodValidationPipe(xuiServerUpsertSchema))
  createServer(@Body() body: z.infer<typeof xuiServerUpsertSchema>) { return this.nodes.createServer(body); }

  @Patch('admin/xui-servers/:id')
  @UseGuards(AuthGuard)
  @Roles('admin')
  @UsePipes(new ZodValidationPipe(xuiServerUpsertSchema.partial()))
  updateServer(@Param('id') id: string, @Body() body: Partial<z.infer<typeof xuiServerUpsertSchema>>) { return this.nodes.updateServer(id, body); }

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
  @UsePipes(new ZodValidationPipe(serviceNodeUpsertSchema))
  createServiceNode(@Body() body: z.infer<typeof serviceNodeUpsertSchema>) { return this.nodes.createServiceNode(body); }

  @Patch('admin/service-nodes/:id')
  @UseGuards(AuthGuard)
  @Roles('admin')
  @UsePipes(new ZodValidationPipe(serviceNodeUpsertSchema.partial()))
  updateServiceNode(@Param('id') id: string, @Body() body: Partial<z.infer<typeof serviceNodeUpsertSchema>>) { return this.nodes.updateServiceNode(id, body); }

  @Delete('admin/service-nodes/:id')
  @UseGuards(AuthGuard)
  @Roles('admin')
  deleteServiceNode(@Param('id') id: string) { return this.nodes.deleteServiceNode(id); }

  @Get('user/nodes')
  @UseGuards(AuthGuard)
  @Roles('user')
  userNodes(@CurrentUser() user: SessionUser) { return this.nodes.listUserNodes(user.customerId || ''); }

  @Post('admin/customers/:id/nodes')
  @UseGuards(AuthGuard)
  @Roles('admin')
  @UsePipes(new ZodValidationPipe(customerNodeCreateSchema))
  bindCustomerNode(@Param('id') id: string, @Body() body: z.infer<typeof customerNodeCreateSchema>) {
    return this.nodes.bindCustomerNode(id, body);
  }

  @Delete('admin/customers/:id/nodes/:nodeId')
  @UseGuards(AuthGuard)
  @Roles('admin')
  unbindCustomerNode(@Param('id') id: string, @Param('nodeId') nodeId: string) {
    return this.nodes.unbindCustomerNode(id, nodeId);
  }
}
