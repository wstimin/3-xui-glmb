import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards, UsePipes } from '@nestjs/common';
import { balanceAdjustSchema, customerUpsertSchema } from '@shiye/shared';
import type { z } from 'zod';
import { AuthGuard } from '../../shared/auth.guard.js';
import { CurrentUser } from '../../shared/current-user.decorator.js';
import { Roles } from '../../shared/roles.decorator.js';
import type { SessionUser } from '../../shared/auth.types.js';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe.js';
import { CustomersService } from './customers.service.js';

@Controller()
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get('admin/customers')
  @UseGuards(AuthGuard)
  @Roles('admin')
  list() {
    return this.customers.list();
  }

  @Post('admin/customers')
  @UseGuards(AuthGuard)
  @Roles('admin')
  @UsePipes(new ZodValidationPipe(customerUpsertSchema))
  create(@Body() body: z.infer<typeof customerUpsertSchema>) {
    return this.customers.create(body);
  }

  @Patch('admin/customers/:id')
  @UseGuards(AuthGuard)
  @Roles('admin')
  @UsePipes(new ZodValidationPipe(customerUpsertSchema.partial()))
  update(@Param('id') id: string, @Body() body: z.infer<typeof customerUpsertSchema>) {
    return this.customers.update(id, body);
  }

  @Delete('admin/customers/:id')
  @UseGuards(AuthGuard)
  @Roles('admin')
  remove(@Param('id') id: string) {
    return this.customers.remove(id);
  }

  @Post('admin/customers/:id/balance-adjustments')
  @UseGuards(AuthGuard)
  @Roles('admin')
  @UsePipes(new ZodValidationPipe(balanceAdjustSchema))
  adjustBalance(@Param('id') id: string, @Body() body: z.infer<typeof balanceAdjustSchema>, @CurrentUser() user: SessionUser) {
    return this.customers.adjustBalance(id, body, user.username);
  }

  @Get('user/me')
  @UseGuards(AuthGuard)
  @Roles('user')
  me(@CurrentUser() user: SessionUser) {
    return this.customers.userDashboard(user.customerId || '');
  }
}
