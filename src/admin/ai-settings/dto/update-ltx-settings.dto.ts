import { IsOptional, IsString } from 'class-validator';

export class UpdateLtxSettingsDto {
  @IsOptional()
  @IsString()
  comfyBaseUrl?: string;
}
