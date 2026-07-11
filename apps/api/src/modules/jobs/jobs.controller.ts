import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../shared/auth.guard.js';
import { Roles } from '../../shared/roles.decorator.js';
import { JobsService } from './jobs.service.js';

@Controller('admin/jobs')
@UseGuards(AuthGuard)
@Roles('admin')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get('settings')
  settings() {
    return this.jobs.jobSettings();
  }

  @Patch('settings')
  updateSettings(@Body() body: { disableExpiredEnabled?: unknown; trafficSyncEnabled?: unknown }) {
    return this.jobs.updateJobSettings(body);
  }

  @Post('disable-expired')
  disableExpired() {
    return this.jobs.disableExpiredNodes('manual');
  }

  @Post('sync-traffic')
  syncTraffic() {
    return this.jobs.disableTrafficExceededNodes('manual');
  }
}
