import type { ApiTask } from '@/lib/api/types/task'
import type { ModelWithCapabilities } from '@/lib/api/types/modelCapabilities'

const DEFAULT_GPT_IMAGE_MODEL = 'gpt-image-2-all'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
}

function normalizeProviderFamily(providerValue?: string | null) {
  const normalized = (providerValue || '').toLowerCase().trim()
  if (normalized === 'qianwen') return 'qwen'
  if (normalized === 'mj') return 'midjourney'
  if (normalized === 'wanxiang') return 'wanx'
  return normalized
}

function getRemoteModel(model: Pick<ModelWithCapabilities, 'modelKey' | 'capabilities'>) {
  return String(model.capabilities?.remoteModel || model.modelKey || '').trim()
}

function getModelIdentity(model: ModelWithCapabilities) {
  return `${model.provider || ''} ${model.modelKey || ''} ${model.capabilities?.remoteModel || ''}`.toLowerCase()
}

function isGptImageModel(model: ModelWithCapabilities) {
  const provider = normalizeProviderFamily(model.provider)
  return provider.includes('gpt') || provider.includes('openai')
}

function isQwenImageModel(model: ModelWithCapabilities) {
  const provider = normalizeProviderFamily(model.provider)
  return provider.includes('qwen') || provider.includes('qianwen')
}

function isDoubaoImageModel(model: ModelWithCapabilities) {
  const provider = normalizeProviderFamily(model.provider)
  return provider.includes('doubao') || provider.includes('bytedance') || provider.includes('ark')
}

function isMidjourneyModel(model: ModelWithCapabilities) {
  const provider = normalizeProviderFamily(model.provider)
  return provider.includes('midjourney') || provider.includes('mj')
}

function isNanoBananaProModel(model: ModelWithCapabilities) {
  const identity = getModelIdentity(model)
  return (
    identity.includes('nanobananapro') ||
    identity.includes('nano_banana_pro') ||
    identity.includes('nano-banana-pro') ||
    (identity.includes('gemini') && identity.includes('pro'))
  )
}

function isNanoBananaModel(model: ModelWithCapabilities) {
  const provider = normalizeProviderFamily(model.provider)
  return (
    provider.includes('nanobanana') ||
    provider.includes('gemini') ||
    provider.includes('google')
  )
}

function parsePixelSize(value: unknown): { width: number; height: number } | null {
  const raw = asString(value)
  if (!raw) return null

  const match = raw.match(/^(\d{2,5})\s*[x*×]\s*(\d{2,5})$/i)
  if (!match) return null

  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

function parseAspectRatio(value: unknown): { width: number; height: number; raw: string } | null {
  const raw = asString(value)
  if (!raw || raw === 'adaptive' || raw === 'auto') return null

  const match = raw.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/)
  if (!match) return null

  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height, raw }
}

function closestAspectRatio(width: number, height: number) {
  const target = width / height
  const candidates = ['1:1', '4:3', '3:4', '16:9', '9:16', '21:9', '3:2', '2:3', '5:4', '4:5']
  return candidates.reduce((best, item) => {
    const parsed = parseAspectRatio(item)
    if (!parsed) return best
    const currentDistance = Math.abs(parsed.width / parsed.height - target)
    const bestParsed = parseAspectRatio(best)
    const bestDistance = bestParsed ? Math.abs(bestParsed.width / bestParsed.height - target) : Number.POSITIVE_INFINITY
    return currentDistance < bestDistance ? item : best
  }, '1:1')
}

function resolveAspectRatio(params: Record<string, unknown>) {
  const direct = parseAspectRatio(params.aspectRatio ?? params.aspect_ratio)
  if (direct) return direct.raw

  const size = parsePixelSize(params.size)
  if (size) return closestAspectRatio(size.width, size.height)

  return '1:1'
}

function resolveGptSize(params: Record<string, unknown>) {
  const size = parsePixelSize(params.size)
  const allowed = new Set(['1024x1024', '1536x1024', '1024x1536'])
  if (size) {
    const normalized = `${size.width}x${size.height}`
    if (allowed.has(normalized)) return normalized
    const ratio = size.width / size.height
    if (ratio > 1.1) return '1536x1024'
    if (ratio < 0.9) return '1024x1536'
    return '1024x1024'
  }

  const aspectRatio = parseAspectRatio(params.aspectRatio ?? params.aspect_ratio)
  if (aspectRatio) {
    const ratio = aspectRatio.width / aspectRatio.height
    if (ratio > 1.1) return '1536x1024'
    if (ratio < 0.9) return '1024x1536'
  }

  return '1024x1024'
}

function resolveQwenSize(params: Record<string, unknown>) {
  const size = parsePixelSize(params.size)
  if (size) return `${size.width}*${size.height}`

  const aspectRatio = parseAspectRatio(params.aspectRatio ?? params.aspect_ratio)
  if (!aspectRatio) return '1024*1024'

  const ratio = aspectRatio.width / aspectRatio.height
  if (ratio > 1.5) return '1280*720'
  if (ratio > 1.1) return '1536*1024'
  if (ratio < 0.67) return '720*1280'
  if (ratio < 0.9) return '1024*1536'
  return '1024*1024'
}

function resolveImageSize(params: Record<string, unknown>) {
  const value = asString(params.imageSize ?? params.image_size ?? params.size)
  return value === '4K' ? '4K' : '2K'
}

function collectImageReferences(params: Record<string, unknown>) {
  const refs: string[] = []
  const append = (value: unknown) => {
    if (Array.isArray(value)) {
      refs.push(...asStringArray(value))
      return
    }
    const item = asString(value)
    if (item) refs.push(item)
  }

  append(params.images)
  append(params.imageArray)
  append(params.image)
  append(params.imageUrl)
  append(params.imageBase64)
  append(params.base64Array)

  const seen = new Set<string>()
  return refs.filter((item) => {
    if (seen.has(item)) return false
    seen.add(item)
    return true
  })
}

function limitImageReferences(model: ModelWithCapabilities, refs: string[]) {
  if (!model.capabilities?.supports?.imageInput) return []

  const supportsMultiple = Boolean(model.capabilities.supports.multiImageInput)
  const max = Math.max(1, model.capabilities.limits?.maxInputImages ?? (supportsMultiple ? refs.length : 1))
  return refs.slice(0, supportsMultiple ? max : 1)
}

function toMidjourneyImage(value: string) {
  const commaIndex = value.indexOf(',')
  if (/^data:[^;]+;base64,/i.test(value) && commaIndex >= 0) {
    return value.slice(commaIndex + 1)
  }
  return value
}

function copyMidjourneyParams(sourceProvider: string, sourceParams: Record<string, unknown>, target: Record<string, unknown>) {
  const source = normalizeProviderFamily(sourceProvider)
  if (!source.includes('midjourney') && !source.includes('mj')) return

  const keys = ['version', 'stylize', 'chaos', 'quality', 'weird', 'iw', 'no', 'style', 'seed']
  for (const key of keys) {
    const value = sourceParams[key]
    if (value !== undefined && value !== null && value !== '') target[key] = value
  }

  if (sourceParams.tile === true) target.tile = true
  if (sourceParams.personalize === true) target.personalize = true
}

export function buildImageRetryParameters(task: Pick<ApiTask, 'provider' | 'parameters'>, model: ModelWithCapabilities) {
  const sourceParams = asRecord(task.parameters)
  const imageReferences = limitImageReferences(model, collectImageReferences(sourceParams))
  const remoteModel = getRemoteModel(model)
  const parameters: Record<string, unknown> = {}

  if (isQwenImageModel(model)) {
    parameters.size = resolveQwenSize(sourceParams)
    parameters.n = 1
    parameters.watermark = false
    if (remoteModel) parameters.model = remoteModel
  } else if (isGptImageModel(model)) {
    parameters.size = resolveGptSize(sourceParams)
    parameters.gptImageOperation = imageReferences.length > 0 ? 'edits' : 'generations'
    parameters.model = remoteModel || DEFAULT_GPT_IMAGE_MODEL
  } else if (isNanoBananaModel(model)) {
    if (model.capabilities?.supports?.sizeSelect) {
      parameters.aspectRatio = resolveAspectRatio(sourceParams)
    }
    parameters.responseModalities = ['IMAGE']
    if (model.capabilities?.supports?.resolutionSelect || isNanoBananaProModel(model)) {
      parameters.imageSize = resolveImageSize(sourceParams)
    }
  } else if (isDoubaoImageModel(model)) {
    parameters.size = resolveImageSize(sourceParams)
    parameters.response_format = 'url'
    parameters.watermark = false
    if (remoteModel) parameters.model = remoteModel
  } else if (isMidjourneyModel(model)) {
    parameters.botType = asString(sourceParams.botType) || 'MID_JOURNEY'
    parameters.aspectRatio = resolveAspectRatio(sourceParams)
    copyMidjourneyParams(task.provider, sourceParams, parameters)
  } else {
    parameters.aspectRatio = resolveAspectRatio(sourceParams)
  }

  if (imageReferences.length > 0) {
    if (isMidjourneyModel(model)) {
      parameters.base64Array = imageReferences.map(toMidjourneyImage)
    } else if (isQwenImageModel(model)) {
      parameters.images = imageReferences
    } else if (isGptImageModel(model)) {
      if (imageReferences.length === 1) {
        parameters.image = imageReferences[0]
      } else {
        parameters.images = imageReferences
      }
      const mask = asString(sourceParams.maskBase64 ?? sourceParams.maskUrl ?? sourceParams.mask)
      if (mask) parameters.maskBase64 = mask
    } else if (isDoubaoImageModel(model)) {
      parameters.image = imageReferences.length === 1 ? imageReferences[0] : imageReferences
    } else if (isNanoBananaModel(model)) {
      parameters.images = imageReferences
      parameters.imageFirst = true
    } else {
      parameters.imageBase64 = imageReferences[0]
    }
  }

  return parameters
}

export function summarizeImageRetryParameters(
  parameters: Record<string, unknown>,
  labels: { reference: string; references: string } = { reference: 'reference', references: 'references' },
) {
  const parts: string[] = []
  const size = asString(parameters.size)
  const aspectRatio = asString(parameters.aspectRatio)
  const imageSize = asString(parameters.imageSize)
  const operation = asString(parameters.gptImageOperation)
  const imageParamCount = Array.isArray(parameters.image)
    ? asStringArray(parameters.image).length
    : parameters.image ? 1 : 0
  const imageCount =
    asStringArray(parameters.images).length ||
    asStringArray(parameters.base64Array).length ||
    imageParamCount ||
    (parameters.imageBase64 ? 1 : 0)

  if (operation) parts.push(operation === 'edits' ? 'edits' : 'generations')
  if (size) parts.push(size)
  if (aspectRatio) parts.push(aspectRatio)
  if (imageSize) parts.push(imageSize)
  if (imageCount > 0) parts.push(`${imageCount} ${imageCount > 1 ? labels.references : labels.reference}`)

  return parts.join(' · ')
}
