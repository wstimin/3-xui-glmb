import { Module } from '@nestjs/common';
import { XuiModule } from '../xui/xui.module.js';
import { CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';

@Module({ imports: [XuiModule], controllers: [CustomersController], providers: [CustomersService], exports: [CustomersService] })
export class CustomersModule {}
