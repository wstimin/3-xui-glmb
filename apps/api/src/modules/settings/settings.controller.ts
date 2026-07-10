import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { settingsUpdateSchema } from '@shiye/shared';
import type { z } from 'zod';
import { AuthGuard } from '../../shared/auth.guard.js';
import { Roles } from '../../shared/roles.decorator.js';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe.js';
import { SettingsService } from './settings.service.js';

@Controller()
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('public/branding')
  async publicBranding() {
    return { settings: await this.settings.publicBranding() };
  }

  @Get('admin/settings')
  @UseGuards(AuthGuard)
  @Roles('admin')
  async adminSettings() {
    return this.settings.adminSettings();
  }

  @Put('admin/settings')
  @UseGuards(AuthGuard)
  @Roles('admin')
  updateSettings(@Body(new ZodValidationPipe(settingsUpdateSchema)) body: z.infer<typeof settingsUpdateSchema>) {
    return this.settings.updateSettings(body);
  }
}
