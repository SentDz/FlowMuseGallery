import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_LTX_SETTINGS, LtxSettings, SYSTEM_SETTING_KEYS } from './system-settings.constants';

@Injectable()
export class LtxSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getLtxSettings(): Promise<LtxSettings> {
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: SYSTEM_SETTING_KEYS.ltxComfyBaseUrl },
    });
    const comfyBaseUrl = row?.value?.trim() || DEFAULT_LTX_SETTINGS.comfyBaseUrl;
    return {
      comfyBaseUrl,
      configured: Boolean(comfyBaseUrl),
    };
  }

  async getLtxSettingsForAdmin(): Promise<LtxSettings> {
    return this.getLtxSettings();
  }

  async setLtxSettings(input: Partial<LtxSettings>) {
    if (typeof input.comfyBaseUrl === 'string') {
      await this.prisma.systemConfig.upsert({
        where: { key: SYSTEM_SETTING_KEYS.ltxComfyBaseUrl },
        create: {
          key: SYSTEM_SETTING_KEYS.ltxComfyBaseUrl,
          value: input.comfyBaseUrl.trim(),
          description: 'LTX ComfyUI base URL',
        },
        update: {
          value: input.comfyBaseUrl.trim(),
        },
      });
    }
    return this.getLtxSettingsForAdmin();
  }
}
