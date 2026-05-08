export type PromptOptimizeTask =
  | 'default'
  | 'video_director'
  | 'project_description'
  | 'project_storyboard'
  | 'project_image_prompt'
  | 'ltx_i2v'

export interface OptimizePromptDto {
  prompt: string
  images?: string[]
  modelType?: string
  projectDescription?: string
  task?: PromptOptimizeTask
}

export interface OptimizePromptResponse {
  content: string
}
