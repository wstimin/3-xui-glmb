import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module.js';
import { CardsModule } from './cards/cards.module.js';
import { CustomersModule } from './customers/customers.module.js';
import { FinanceModule } from './finance/finance.module.js';
import { HealthModule } from './health/health.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { NodesModule } from './nodes/nodes.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { SecurityModule } from './security/security.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { SetupModule } from './setup/setup.module.js';
import { XuiModule } from './xui/xui.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    SecurityModule,
    PrismaModule,
    HealthModule,
    SetupModule,
    AuthModule,
    SettingsModule,
    CustomersModule,
    NodesModule,
    XuiModule,
    CardsModule,
    FinanceModule,
    PaymentsModule,
    JobsModule
  ]
})
export class AppModule {}
