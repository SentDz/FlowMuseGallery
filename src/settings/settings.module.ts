import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { SystemSettingsService } from './system-settings.service';
import { AiSettingsService } from './ai-settings.service';
import { LtxSettingsService } from './ltx-settings.service';
import { StorageSettingsService } from './storage-settings.service';

@Module({
  imports: [PrismaModule],
  providers: [SystemSettingsService, AiSettingsService, LtxSettingsService, StorageSettingsService],
  exports: [SystemSettingsService, AiSettingsService, LtxSettingsService, StorageSettingsService],
})
export class SettingsModule {}
