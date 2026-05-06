import { IsObject, IsOptional, IsString } from 'class-validator';

export class RetryImageTaskDto {
  @IsOptional()
  @IsString()
  modelId?: string;

  @IsOptional()
  @IsObject()
  parameters?: Record<string, unknown>;
}
