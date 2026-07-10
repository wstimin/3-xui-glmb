import { Controller, Get, Post } from '@nestjs/common';
import { SetupService } from './setup.service.js';

@Controller('setup')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Get('status')
  status() {
    return this.setup.status();
  }

  @Post('install')
  install() {
    return this.setup.installHint();
  }
}
