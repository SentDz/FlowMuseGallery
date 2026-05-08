import { Module } from '@nestjs/common';

import { PromptOptimizeModule } from '../prompt-optimize/prompt-optimize.module';
import { ProjectsModule } from '../projects/projects.module';
import { SettingsModule } from '../settings/settings.module';
import { LocalTaskRunnerService } from './local-task-runner.service';

@Module({
  imports: [ProjectsModule, PromptOptimizeModule, SettingsModule],
  providers: [LocalTaskRunnerService],
  exports: [LocalTaskRunnerService],
})
export class LocalRunnerModule {}
