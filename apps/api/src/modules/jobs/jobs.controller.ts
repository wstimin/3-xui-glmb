import { Controller, Post, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../shared/auth.guard.js';
import { Roles } from '../../shared/roles.decorator.js';

@Controller('admin/jobs')
@UseGuards(AuthGuard)
@Roles('admin')
export class JobsController {
  @Post('disable-expired')
  disableExpired() {
    throw new ServiceUnavailableException('自动停用过期节点任务暂未启用');
  }

  @Post('sync-traffic')
  syncTraffic() {
    throw new ServiceUnavailableException('流量同步任务暂未启用');
  }
}
