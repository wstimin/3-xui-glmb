import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { paymentChannelUpsertSchema, rechargeOrderCreateSchema } from '@shiye/shared';
import type { z } from 'zod';
import { AuthGuard } from '../../shared/auth.guard.js';
import { CurrentUser } from '../../shared/current-user.decorator.js';
import { Roles } from '../../shared/roles.decorator.js';
import type { SessionUser } from '../../shared/auth.types.js';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe.js';
import { PaymentsService } from './payments.service.js';

@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('public/payment-channels')
  publicChannels() {
    return this.payments.publicChannels();
  }

  @Get('admin/payment-channels')
  @UseGuards(AuthGuard)
  @Roles('admin')
  adminChannels() {
    return this.payments.adminChannels();
  }

  @Post('admin/payment-channels')
  @UseGuards(AuthGuard)
  @Roles('admin')
  createChannel(@Body(new ZodValidationPipe(paymentChannelUpsertSchema)) body: z.infer<typeof paymentChannelUpsertSchema>) {
    return this.payments.createChannel(body);
  }

  @Patch('admin/payment-channels/:id')
  @UseGuards(AuthGuard)
  @Roles('admin')
  updateChannel(@Param('id') id: string, @Body(new ZodValidationPipe(paymentChannelUpsertSchema.partial())) body: Partial<z.infer<typeof paymentChannelUpsertSchema>>) {
    return this.payments.updateChannel(id, body);
  }

  @Delete('admin/payment-channels/:id')
  @UseGuards(AuthGuard)
  @Roles('admin')
  deleteChannel(@Param('id') id: string) {
    return this.payments.deleteChannel(id);
  }

  @Post('user/recharge-orders')
  @UseGuards(AuthGuard)
  @Roles('user')
  createOrder(@Body(new ZodValidationPipe(rechargeOrderCreateSchema)) body: z.infer<typeof rechargeOrderCreateSchema>, @CurrentUser() user: SessionUser) {
    return this.payments.createOrder(user.customerId || '', body);
  }

  @Post('payments/:provider/notify')
  async notify(@Param('provider') provider: string, @Query() query: Record<string, unknown>, @Body() body: unknown, @Res() response: Response) {
    const text = await this.payments.notify({ provider, query, body });
    return response.type(this.payments.notifyContentType(provider)).send(text);
  }

  @Get('payments/:provider/notify')
  async getNotify(@Param('provider') provider: string, @Query() query: Record<string, unknown>, @Res() response: Response) {
    const text = await this.payments.notify({ provider, query, body: {} });
    return response.type(this.payments.notifyContentType(provider)).send(text);
  }

  @Get('payments/result')
  result(@Query('trade_no') tradeNo: string) { return this.payments.result(tradeNo); }
}
