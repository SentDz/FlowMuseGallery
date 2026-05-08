import sharp from 'sharp';

import hdWorkflowTemplate from './workflow-template-hd.json';
import { BaseVideoAdapter, VideoGenerateParams } from '../base/base-video.adapter';
import { TaskStatusResponse, ValidationResult } from '../base/base-image.adapter';

type LtxMode = 'hd';
type LtxStyle = 'cinematic' | 'guofeng' | 'realistic' | 'cyberpunk';
type LtxAdherence = 'high' | 'medium' | 'low';
type LtxTendency = 'consistency' | 'diversity';

type ComfyUploadResponse = {
  name?: string;
  subfolder?: string;
  type?: string;
};

type ComfyPromptResponse = {
  prompt_id?: string;
  [key: string]: unknown;
};

type ComfyHistoryOutput = {
  gifs?: Array<Record<string, unknown>>;
  videos?: Array<Record<string, unknown>>;
  images?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

type ComfyHistory = {
  status?: {
    completed?: boolean;
    status_str?: string;
    messages?: unknown;
    [key: string]: unknown;
  };
  outputs?: Record<string, ComfyHistoryOutput>;
  [key: string]: unknown;
};

type CollectedOutput = Record<string, unknown> & {
  node_id: string;
  kind: 'gif' | 'video' | 'image';
};

const STYLE_PRESETS: Record<LtxStyle, string> = {
  cinematic: 'cinematic film look, strong visual storytelling, natural motion, realistic lighting, detailed textures',
  guofeng: 'eastern fantasy wuxia aesthetic, elegant motion, flowing costume details, poetic atmosphere, cinematic depth of field',
  realistic: 'photorealistic style, natural body movement, realistic skin texture, believable lighting, grounded camera motion',
  cyberpunk: 'cyberpunk noir style, neon reflections, rainy atmosphere, futuristic city details, cinematic contrast',
};

const ADHERENCE_MAP: Record<LtxAdherence, number> = {
  high: 0.85,
  medium: 0.7,
  low: 0.55,
};

const VALID_DURATIONS = new Set([3, 5, 8, 10]);
const DEFAULT_OUTPUT_NODE_ID = '5011';
const DEFAULT_NEGATIVE_NODE_ID = '2612';
const PORTRAIT_VIDEO_SIZE = { width: 400, height: 720, orientation: 'portrait' as const };
const LANDSCAPE_VIDEO_SIZE = { width: 720, height: 400, orientation: 'landscape' as const };
const MAX_SAFE_COMFY_SEED = Number.MAX_SAFE_INTEGER - 1;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return undefined;
  return Math.trunc(parsed);
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

function buildPrompt(style: LtxStyle, prompt: string) {
  return `${prompt.trim()}\n\n${STYLE_PRESETS[style]}`;
}

function buildNegativePrompt(defaultNegative: string, userNegative: string | undefined) {
  const trimmed = userNegative?.trim();
  return trimmed ? `${defaultNegative}, ${trimmed}` : defaultNegative;
}

function buildRuntimeSummary(input: {
  imageName: string;
  style: LtxStyle;
  adherence: LtxAdherence;
  duration: number;
  mode: LtxMode;
  tendency: LtxTendency;
  seedStage1: number;
  seedStage2: number;
  filenamePrefix: string;
  videoWidth: number;
  videoHeight: number;
  orientation: string;
}) {
  return [
    'Runtime parameters',
    `first_frame_image: ${input.imageName}`,
    `style_preset: ${input.style}`,
    `reference_adherence: ${input.adherence}`,
    `duration_seconds: ${input.duration}`,
    'fps: 24',
    `generation_mode: ${input.mode}`,
    `result_tendency: ${input.tendency}`,
    `output_orientation: ${input.orientation}`,
    `video_width: ${input.videoWidth}`,
    `video_height: ${input.videoHeight}`,
    `seed_stage1: ${input.seedStage1}`,
    `seed_stage2: ${input.seedStage2}`,
    `filename_prefix: ${input.filenamePrefix}`,
  ].join('\n');
}

function buildRuntimePromptNote(input: {
  userPrompt: string;
  effectivePrompt: string;
  negativePrompt: string;
}) {
  return [
    'User prompt',
    input.userPrompt.trim(),
    'Effective positive prompt',
    input.effectivePrompt.trim(),
    'Effective negative prompt',
    input.negativePrompt.trim(),
  ].join('\n\n');
}

function chooseSeedPair(params: Record<string, unknown>) {
  const tendency = asEnum<LtxTendency>(params.tendency, ['consistency', 'diversity'], 'diversity');
  const seed = asInteger(params.seed ?? params.baseSeed ?? params.base_seed);
  const seedStage1 = seed && seed > 0 && tendency === 'consistency'
    ? Math.min(seed, MAX_SAFE_COMFY_SEED - 1)
    : Math.floor(Math.random() * (MAX_SAFE_COMFY_SEED - 1)) + 1;
  return { seedStage1, seedStage2: Math.min(seedStage1 + 1, MAX_SAFE_COMFY_SEED) };
}

function defaultGenerationPrefix(duration: number, mode: LtxMode, tendency: LtxTendency, seedStage1: number) {
  return `ltx_${mode}_${duration}s_${tendency}_seed${seedStage1}`;
}

function inferReferenceImage(params: Record<string, unknown>) {
  const direct =
    asString(params.firstFrame) ??
    asString(params.first_frame) ??
    asString(params.referenceImage) ??
    asString(params.reference_image);
  if (direct) return direct;

  const referenceImages = params.referenceImages ?? params.reference_images;
  if (Array.isArray(referenceImages)) return asString(referenceImages[0]);
  return asString(referenceImages);
}

function parseDataUrl(value: string): { contentType: string; base64: string } | null {
  const match = value.match(/^data:([^;]+);base64,(.*)$/);
  if (!match) return null;
  return { contentType: match[1], base64: match[2] };
}

function extFromContentType(contentType: string | undefined) {
  if (!contentType) return '.png';
  if (contentType.includes('jpeg')) return '.jpg';
  if (contentType.includes('webp')) return '.webp';
  if (contentType.includes('png')) return '.png';
  return '.png';
}

function compactErrorMessage(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.replace(/\s+/g, ' ').trim().slice(0, 1000);
  }
  if (!value || typeof value !== 'object') return undefined;

  const seen = new Set<unknown>();
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    const record = current as Record<string, unknown>;
    for (const key of ['exception_message', 'message', 'error']) {
      const message = compactErrorMessage(record[key]);
      if (message) return message;
    }
    queue.push(...Object.values(record));
  }

  return undefined;
}

export class LtxVideoAdapter extends BaseVideoAdapter {
  private readonly workflowTemplate = hdWorkflowTemplate as Record<string, any>;

  private async loadImageInput(value: string, filenameStem: string) {
    if (/^https?:\/\//i.test(value)) {
      const response = await this.httpClient.get<ArrayBuffer>(value, {
        baseURL: undefined,
        responseType: 'arraybuffer',
      });
      const contentType = String(response.headers['content-type'] ?? 'image/png');
      return {
        buffer: Buffer.from(response.data),
        contentType,
        filename: `${filenameStem}${extFromContentType(contentType)}`,
      };
    }

    const parsed = parseDataUrl(value);
    const contentType = parsed?.contentType ?? 'image/png';
    const base64 = parsed?.base64 ?? value;
    return {
      buffer: Buffer.from(base64.replace(/\s+/g, ''), 'base64'),
      contentType,
      filename: `${filenameStem}${extFromContentType(contentType)}`,
    };
  }

  private async chooseVideoSize(buffer: Buffer) {
    const metadata = await sharp(buffer).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    return height > width ? PORTRAIT_VIDEO_SIZE : LANDSCAPE_VIDEO_SIZE;
  }

  private encodeMultipartFormdata(input: {
    fields: Record<string, string>;
    fileField: string;
    fileName: string;
    fileBuffer: Buffer;
    contentType: string;
  }) {
    const boundary = `----FlowMuseLtxBoundary${Math.floor(Math.random() * 10 ** 12)}`;
    const boundaryBytes = Buffer.from(boundary);
    const parts: Buffer[] = [];

    for (const [name, value] of Object.entries(input.fields)) {
      parts.push(
        Buffer.concat([
          Buffer.from('--'),
          boundaryBytes,
          Buffer.from(`\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
        ]),
      );
    }

    parts.push(
      Buffer.concat([
        Buffer.from('--'),
        boundaryBytes,
        Buffer.from(
          `\r\nContent-Disposition: form-data; name="${input.fileField}"; filename="${input.fileName}"\r\n` +
            `Content-Type: ${input.contentType}\r\n\r\n`,
        ),
        input.fileBuffer,
        Buffer.from('\r\n'),
      ]),
    );
    parts.push(Buffer.concat([Buffer.from('--'), boundaryBytes, Buffer.from('--\r\n')]));

    return {
      body: Buffer.concat(parts),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  private async uploadImage(params: Record<string, unknown>, imageValue: string, seedStage1: number) {
    const uniquePart = `${Date.now().toString(36)}-${Math.floor(Math.random() * 10 ** 9).toString(36)}`;
    const loaded = await this.loadImageInput(imageValue, `ltx-first-frame-${seedStage1}-${uniquePart}`);
    const fields: Record<string, string> = {
      type: 'input',
      overwrite: 'true',
    };
    const subfolder = asString(params.comfyInputSubdir ?? params.comfy_input_subdir);
    if (subfolder) fields.subfolder = subfolder.replace(/\\/g, '/');

    const { body, contentType } = this.encodeMultipartFormdata({
      fields,
      fileField: 'image',
      fileName: loaded.filename,
      fileBuffer: loaded.buffer,
      contentType: loaded.contentType,
    });
    const response = await this.httpClient.post<ComfyUploadResponse>('/upload/image', body, {
      headers: {
        Accept: 'application/json',
        'Content-Type': contentType,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    return {
      imageBuffer: loaded.buffer,
      uploadedName: response.data?.name || loaded.filename,
      uploadResponse: response.data ?? {},
    };
  }

  private patchWorkflow(input: {
    params: Record<string, unknown>;
    prompt: string;
    negativePrompt: string;
    imageName: string;
    style: LtxStyle;
    adherence: LtxAdherence;
    duration: number;
    mode: LtxMode;
    tendency: LtxTendency;
    seedStage1: number;
    seedStage2: number;
    filenamePrefix: string;
    videoWidth: number;
    videoHeight: number;
    orientation: string;
  }) {
    const patched = JSON.parse(JSON.stringify(this.workflowTemplate));
    patched['5013'].inputs.text = input.prompt;
    patched[DEFAULT_NEGATIVE_NODE_ID].inputs.text = input.negativePrompt;
    patched['2004'].inputs.image = input.imageName;
    patched['5018'].inputs.value = input.videoWidth;
    patched['5020'].inputs.value = input.videoHeight;
    patched['5046'].inputs.value = input.duration;
    patched['4989'].inputs.value = 24;
    patched['5011'].inputs.frame_rate = 24;
    patched['5011'].inputs.filename_prefix = input.filenamePrefix.replace(/\\/g, '/');
    patched['3159'].inputs.strength = ADHERENCE_MAP[input.adherence];
    patched['4832'].inputs.noise_seed = input.seedStage1;
    patched['5041'].inputs.text = buildRuntimeSummary({
      imageName: input.imageName,
      style: input.style,
      adherence: input.adherence,
      duration: input.duration,
      mode: input.mode,
      tendency: input.tendency,
      seedStage1: input.seedStage1,
      seedStage2: input.seedStage2,
      filenamePrefix: input.filenamePrefix,
      videoWidth: input.videoWidth,
      videoHeight: input.videoHeight,
      orientation: input.orientation,
    });
    patched['5042'].inputs.text = buildRuntimePromptNote({
      userPrompt: asString(input.params.ltxOriginalPrompt) ?? asString(input.params.prompt) ?? '',
      effectivePrompt: input.prompt,
      negativePrompt: input.negativePrompt,
    });

    if (patched['4967'] && patched['4970']) {
      patched['4967'].inputs.noise_seed = input.seedStage2;
      patched['4970'].inputs.strength = 1.0;
    }

    return patched;
  }

  private collectOutputs(history: ComfyHistory): CollectedOutput[] {
    const outputs = history.outputs ?? {};
    const collected: CollectedOutput[] = [];
    for (const [nodeId, nodeOutput] of Object.entries(outputs)) {
      for (const key of ['gifs', 'videos', 'images'] as const) {
        const items = nodeOutput[key] ?? [];
        for (const item of items) {
          collected.push({
            ...item,
            node_id: nodeId,
            kind: key.slice(0, -1) as CollectedOutput['kind'],
          });
        }
      }
    }
    return collected;
  }

  private preferFinalOutputs(outputs: CollectedOutput[]) {
    const preferred = outputs.filter((item) => item.node_id === DEFAULT_OUTPUT_NODE_ID);
    return preferred.length > 0 ? preferred : outputs;
  }

  private buildViewUrl(output: Record<string, unknown>) {
    const baseUrl = this.channel.baseUrl.replace(/\/+$/, '');
    const query = new URLSearchParams({
      filename: asString(output.filename) ?? '',
      subfolder: asString(output.subfolder) ?? '',
      type: asString(output.type) ?? 'output',
    });
    return `${baseUrl}/view?${query.toString()}`;
  }

  async submitTask(params: VideoGenerateParams): Promise<string> {
    const raw = params as Record<string, unknown>;
    const referenceImage = inferReferenceImage(raw);
    if (!referenceImage) throw new Error('LTX requires one first-frame reference image');

    const mode = asEnum<LtxMode>(raw.mode, ['hd'], 'hd');
    const style = asEnum<LtxStyle>(raw.style, ['cinematic', 'guofeng', 'realistic', 'cyberpunk'], 'cinematic');
    const adherence = asEnum<LtxAdherence>(raw.adherence, ['high', 'medium', 'low'], 'medium');
    const tendency = asEnum<LtxTendency>(raw.tendency, ['consistency', 'diversity'], 'diversity');

    const duration = asInteger(raw.duration) ?? 5;
    const { seedStage1, seedStage2 } = chooseSeedPair(raw);
    const { imageBuffer, uploadedName } = await this.uploadImage(raw, referenceImage, seedStage1);
    const size = await this.chooseVideoSize(imageBuffer);
    const effectivePrompt = buildPrompt(style, params.prompt);
    const defaultNegative = String(this.workflowTemplate[DEFAULT_NEGATIVE_NODE_ID]?.inputs?.text ?? '');
    const effectiveNegative = buildNegativePrompt(defaultNegative, asString(raw.negativePrompt ?? raw.negative_prompt));
    const filenamePrefix = defaultGenerationPrefix(duration, mode, tendency, seedStage1);

    const workflow = this.patchWorkflow({
      params: raw,
      prompt: effectivePrompt,
      negativePrompt: effectiveNegative,
      imageName: uploadedName,
      style,
      adherence,
      duration,
      mode,
      tendency,
      seedStage1,
      seedStage2,
      filenamePrefix,
      videoWidth: size.width,
      videoHeight: size.height,
      orientation: size.orientation,
    });

    const response = await this.httpClient.post<ComfyPromptResponse>('/prompt', { prompt: workflow }, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
    const promptId = asString(response.data?.prompt_id);
    if (!promptId) throw new Error('LTX ComfyUI submit: missing prompt_id');

    return promptId;
  }

  async queryTaskStatus(taskId: string): Promise<TaskStatusResponse> {
    const response = await this.httpClient.get<Record<string, ComfyHistory> | ComfyHistory>(
      `/history/${encodeURIComponent(taskId)}`,
      { headers: { Accept: 'application/json' } },
    );
    const payload = response.data ?? {};
    const history = (taskId in payload ? (payload as Record<string, ComfyHistory>)[taskId] : payload) as ComfyHistory;
    const status = history.status ?? {};
    const outputs = this.preferFinalOutputs(this.collectOutputs(history));
    const failed = String(status.status_str ?? '').toLowerCase().includes('error');
    const errorMessage = failed
      ? compactErrorMessage(status.messages) ?? compactErrorMessage(status) ?? 'LTX ComfyUI task failed'
      : undefined;

    return {
      status: failed ? 'failed' : status.completed || outputs.length > 0 ? 'completed' : 'processing',
      resultUrls: !failed && outputs.length > 0 ? [this.buildViewUrl(outputs[0])] : [],
      errorMessage,
      providerData: {
        promptId: taskId,
        status,
        outputs,
      },
    };
  }

  async getTaskResult(taskId: string): Promise<string> {
    const status = await this.queryTaskStatus(taskId);
    return status.resultUrls?.[0] ?? '';
  }

  async cancelTask(_taskId: string): Promise<void> {
    throw new Error('LTX ComfyUI tasks do not support cancel');
  }

  validateParams(params: unknown): ValidationResult {
    const errors: string[] = [];
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return { valid: false, errors: ['params must be an object'] };
    }
    const raw = params as Record<string, unknown>;
    if (!asString(raw.prompt)) errors.push('prompt is required');
    if (!inferReferenceImage(raw)) errors.push('LTX requires one first-frame reference image');
    const referenceImages = raw.referenceImages ?? raw.reference_images;
    if (Array.isArray(referenceImages) && referenceImages.length > 1) {
      errors.push('LTX supports exactly one reference image');
    }
    const duration = asInteger(raw.duration) ?? 5;
    if (!VALID_DURATIONS.has(duration)) {
      errors.push('duration must be one of: 3, 5, 8, 10');
    }
    if (raw.mode !== undefined && raw.mode !== 'hd') {
      errors.push('LTX mode currently supports only hd');
    }
    if (raw.adherence !== undefined && !['high', 'medium', 'low'].includes(String(raw.adherence))) {
      errors.push('adherence must be one of: high, medium, low');
    }
    if (raw.tendency !== undefined && !['consistency', 'diversity'].includes(String(raw.tendency))) {
      errors.push('tendency must be one of: consistency, diversity');
    }
    return { valid: errors.length === 0, errors };
  }

  transformParams(params: VideoGenerateParams): unknown {
    return {
      ...params,
      mode: 'hd',
      duration: asInteger((params as Record<string, unknown>).duration) ?? 5,
      style: asEnum<LtxStyle>((params as Record<string, unknown>).style, ['cinematic', 'guofeng', 'realistic', 'cyberpunk'], 'cinematic'),
      adherence: asEnum<LtxAdherence>((params as Record<string, unknown>).adherence, ['high', 'medium', 'low'], 'medium'),
      tendency: asEnum<LtxTendency>((params as Record<string, unknown>).tendency, ['consistency', 'diversity'], 'diversity'),
    };
  }
}
