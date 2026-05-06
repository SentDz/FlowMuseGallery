'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { SimplifiedModelSelector } from '@/components/features/create/SimplifiedModelSelector'
import { modelService } from '@/lib/api/services'
import type { ApiTask } from '@/lib/api/types/task'
import type { ModelWithCapabilities } from '@/lib/api/types/modelCapabilities'
import { useTranslations } from '@/i18n/client'
import { buildImageRetryParameters, summarizeImageRetryParameters } from '@/lib/utils/imageTaskRetry'

interface ImageRetryModalProps {
  isOpen: boolean
  task: ApiTask | null
  isSubmitting: boolean
  onClose: () => void
  onSubmit: (input: { modelId: string; parameters: Record<string, unknown> }) => Promise<void>
}

function supportsTaskRetryModel(model: ModelWithCapabilities) {
  if (model.type !== 'image' || !model.isActive) return false
  if (typeof model.supportsQuickMode === 'boolean') return model.supportsQuickMode
  return true
}

export function ImageRetryModal({ isOpen, task, isSubmitting, onClose, onSubmit }: ImageRetryModalProps) {
  const t = useTranslations('tasks')
  const [models, setModels] = useState<ModelWithCapabilities[]>([])
  const [selectedModelId, setSelectedModelId] = useState('')
  const [isLoadingModels, setIsLoadingModels] = useState(false)

  useEffect(() => {
    if (!isOpen) return

    let cancelled = false
    setIsLoadingModels(true)
    modelService.getModelsWithCapabilities({ type: 'image' })
      .then((items) => {
        if (cancelled) return
        const nextModels = items.filter(supportsTaskRetryModel)
        setModels(nextModels)
        setSelectedModelId((current) => {
          if (current && nextModels.some((model) => model.id === current)) return current
          if (task?.modelId && nextModels.some((model) => model.id === task.modelId)) return task.modelId
          return nextModels[0]?.id ?? ''
        })
      })
      .catch((error) => {
        console.error('Failed to load image models:', error)
        if (!cancelled) {
          toast.error(t('errors.loadModels'))
          setModels([])
          setSelectedModelId('')
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingModels(false)
      })

    return () => {
      cancelled = true
    }
  }, [isOpen, task?.modelId, t])

  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedModelId) ?? null,
    [models, selectedModelId],
  )

  const retryParameters = useMemo(() => {
    if (!task || !selectedModel) return {}
    return buildImageRetryParameters(task, selectedModel)
  }, [selectedModel, task])

  const parameterSummary = useMemo(
    () => summarizeImageRetryParameters(retryParameters, {
      reference: t('retryModal.reference'),
      references: t('retryModal.references'),
    }),
    [retryParameters, t],
  )

  const handleSubmit = async () => {
    if (!selectedModelId || !selectedModel) return
    await onSubmit({
      modelId: selectedModelId,
      parameters: retryParameters,
    })
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={isSubmitting ? () => undefined : onClose}
      title={t('retryModal.title')}
      size="sm"
      bodyClassName="space-y-5"
    >
      <div className="space-y-3">
        <SimplifiedModelSelector
          models={models}
          selectedModelId={selectedModelId}
          onSelectModel={setSelectedModelId}
          type="image"
          label={t('retryModal.model')}
          compact
        />

        <div className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300">
          {isLoadingModels
            ? t('retryModal.loadingModels')
            : parameterSummary || t('retryModal.defaultParams')}
        </div>
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="secondary"
          onClick={onClose}
          disabled={isSubmitting}
          className="sm:min-w-[96px]"
        >
          {t('retryModal.cancel')}
        </Button>
        <Button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={isSubmitting || isLoadingModels || !selectedModelId}
          className="sm:min-w-[112px]"
        >
          {isSubmitting ? t('retryModal.submitting') : t('retryModal.submit')}
        </Button>
      </div>
    </Modal>
  )
}
