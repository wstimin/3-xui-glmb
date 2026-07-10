import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { cardGenerateSchema, cardRedeemSchema, cardTemplateUpsertSchema } from '@shiye/shared';
import type { z } from 'zod';
import { AuthGuard } from '../../shared/auth.guard.js';
import { CurrentUser } from '../../shared/current-user.decorator.js';
import { Roles } from '../../shared/roles.decorator.js';
import type { SessionUser } from '../../shared/auth.types.js';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe.js';
import { CardsService } from './cards.service.js';

@Controller()
export class CardsController {
  constructor(private readonly cards: CardsService) {}

  @Get('admin/cards')
  @UseGuards(AuthGuard)
  @Roles('admin')
  list() { return this.cards.list(); }

  @Get('admin/card-templates')
  @UseGuards(AuthGuard)
  @Roles('admin')
  templates() { return this.cards.templates(); }

  @Post('admin/card-templates')
  @UseGuards(AuthGuard)
  @Roles('admin')
  createTemplate(@Body(new ZodValidationPipe(cardTemplateUpsertSchema)) body: z.infer<typeof cardTemplateUpsertSchema>) { return this.cards.createTemplate(body); }

  @Patch('admin/card-templates/:id')
  @UseGuards(AuthGuard)
  @Roles('admin')
  updateTemplate(@Param('id') id: string, @Body(new ZodValidationPipe(cardTemplateUpsertSchema.partial())) body: Partial<z.infer<typeof cardTemplateUpsertSchema>>) { return this.cards.updateTemplate(id, body); }

  @Delete('admin/card-templates/:id')
  @UseGuards(AuthGuard)
  @Roles('admin')
  deleteTemplate(@Param('id') id: string) { return this.cards.deleteTemplate(id); }

  @Post('admin/cards/generate')
  @UseGuards(AuthGuard)
  @Roles('admin')
  generate(@Body(new ZodValidationPipe(cardGenerateSchema)) body: z.infer<typeof cardGenerateSchema>) { return this.cards.generate(body); }

  @Delete('admin/cards/:id')
  @UseGuards(AuthGuard)
  @Roles('admin')
  deleteCard(@Param('id') id: string) { return this.cards.deleteCard(id); }

  @Delete('admin/card-batches/:id')
  @UseGuards(AuthGuard)
  @Roles('admin')
  deleteBatch(@Param('id') id: string) { return this.cards.deleteBatch(id); }

  @Post('user/cards/redeem')
  @UseGuards(AuthGuard)
  @Roles('user')
  redeem(@Body(new ZodValidationPipe(cardRedeemSchema)) body: z.infer<typeof cardRedeemSchema>, @CurrentUser() user: SessionUser) {
    return this.cards.redeem(user.customerId || '', body);
  }
}
