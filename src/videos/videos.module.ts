import { Module } from '@nestjs/common';

import { LocalRunnerModule } from '../local-runner/local-runner.module';
import { ProjectsModule } from '../projects/projects.module';
import { SettingsModule } from '../settings/settings.module';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [LocalRunnerModule, ProjectsModule, SettingsModule],
  controllers: [VideosController],
  providers: [VideosService],
  exports: [VideosService],
})
export class VideosModule {}
