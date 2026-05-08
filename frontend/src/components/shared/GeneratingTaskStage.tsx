'use client'

import { Image as ImageIcon, Sparkles, Video } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import styles from './GeneratingTaskStage.module.css'

type GeneratingTaskKind = 'image' | 'video'
type GeneratingTaskStatus = 'pending' | 'processing'

interface GeneratingTaskStageLabels {
  title: string
  subtitle: string
  statusLabel: string
  kindLabel: string
  retryLabel?: string
  ariaLabel?: string
}

interface GeneratingTaskStageProps {
  kind: GeneratingTaskKind
  status: GeneratingTaskStatus
  retryCount?: number
  variant?: 'full' | 'compact'
  labels: GeneratingTaskStageLabels
  className?: string
}

const PARTICLES = Array.from({ length: 9 }, (_, index) => index)

export function GeneratingTaskStage({
  kind,
  status,
  retryCount = 0,
  variant = 'full',
  labels,
  className,
}: GeneratingTaskStageProps) {
  const Icon = kind === 'video' ? Video : ImageIcon
  const isCompact = variant === 'compact'
  const showRetry = retryCount > 0 && labels.retryLabel

  return (
    <div
      className={cn(
        styles.stage,
        isCompact ? styles.compact : styles.full,
        status === 'pending' ? styles.pending : styles.processing,
        className,
      )}
      aria-live="polite"
      aria-label={labels.ariaLabel ?? `${labels.kindLabel} ${labels.statusLabel}`}
    >
      <div className={styles.glow} aria-hidden="true" />
      <div className={styles.scanline} aria-hidden="true" />
      <div className={styles.orbit} aria-hidden="true" />
      <div className={styles.orbitInner} aria-hidden="true" />
      {PARTICLES.map((item) => (
        <span key={item} className={styles.particle} aria-hidden="true" />
      ))}

      <div className={styles.content}>
        <div className={styles.iconShell} aria-hidden="true">
          <Icon className={styles.mediaIcon} />
          <Sparkles className={styles.sparkIcon} />
        </div>

        <div className={styles.copy}>
          <div className={styles.topline}>
            <span className={styles.liveDot} aria-hidden="true" />
            <span>{labels.statusLabel}</span>
            <span className={styles.kindPill}>{labels.kindLabel}</span>
          </div>
          <p className={styles.title}>{labels.title}</p>
          <p className={styles.subtitle}>{showRetry ? labels.retryLabel : labels.subtitle}</p>
        </div>
      </div>
    </div>
  )
}
