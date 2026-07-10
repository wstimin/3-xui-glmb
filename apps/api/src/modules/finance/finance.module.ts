import { Module } from '@nestjs/common';
import { XuiModule } from '../xui/xui.module.js';
import { FinanceController } from './finance.controller.js';
import { FinanceService } from './finance.service.js';

@Module({ imports: [XuiModule], controllers: [FinanceController], providers: [FinanceService], exports: [FinanceService] })
export class FinanceModule {}
