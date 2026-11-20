import type { Block } from '@shared/types'

/** A block as people read it: "Cellular Neurophysiology · Write-up · L7", or its own title. */
export function blockName(b: Pick<Block, 'title' | 'heading' | 'detail'>): string {
  return b.detail ? `${b.heading} · ${b.detail}` : (b.heading ?? b.title)
}
