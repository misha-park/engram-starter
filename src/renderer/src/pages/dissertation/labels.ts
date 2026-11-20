import type { ReadingStatus, SectionStatus } from '@shared/types'

export const STATUS_LABEL: Record<SectionStatus, string> = {
  'not-started': 'Not started',
  reading: 'Reading',
  drafting: 'Drafting',
  drafted: 'Drafted',
  revised: 'Revised'
}

export const READING_LABEL: Record<ReadingStatus, string> = {
  'to-read': 'To read',
  read: 'Read',
  'notes-done': 'Notes done'
}

export const SESSION_LENGTHS: [number, string][] = [
  [45, '45m'],
  [60, '1h'],
  [90, '1h30'],
  [120, '2h']
]
