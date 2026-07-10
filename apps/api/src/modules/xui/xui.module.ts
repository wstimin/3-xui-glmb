import { Module } from '@nestjs/common';
import { XuiController } from './xui.controller.js';
import { XuiService } from './xui.service.js';

@Module({ controllers: [XuiController], providers: [XuiService], exports: [XuiService] })
export class XuiModule {}
