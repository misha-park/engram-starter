import {
  BookOpen,
  Brain,
  ClipboardCheck,
  Beer,
  CalendarDays,
  FileText,
  FlaskConical,
  GraduationCap,
  Handshake,
  MessagesSquare,
  Mic,
  Mountain,
  NotebookPen,
  Presentation,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import type { BlockType } from '@shared/types'

/** The small outline icon shown inside a block for its session type. */
export const BLOCK_TYPE_ICON: Record<BlockType, LucideIcon> = {
  lecture: Presentation,
  practical: FlaskConical,
  workshop: Wrench,
  pbl: MessagesSquare,
  presentation: Mic,
  assessment: ClipboardCheck,
  viva: GraduationCap,
  'write-up': NotebookPen,
  'assignment-stage': FileText,
  dissertation: BookOpen,
  meeting: Handshake,
  'pub-shift': Beer,
  social: Mountain,
  review: Brain,
  other: CalendarDays
}
