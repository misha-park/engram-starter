import type { ComponentType } from 'react'
import {
  Brain,
  CalendarDays,
  ChartColumn,
  ClipboardList,
  GraduationCap,
  Inbox,
  Layers,
  Settings,
  Wand2,
  type LucideIcon
} from 'lucide-react'
import { AssignmentPage } from './AssignmentPage'
import { AssignmentsPage } from './AssignmentsPage'
import { BacklogPage } from './BacklogPage'
import { CalendarPage } from './CalendarPage'
import { DissertationPage } from './dissertation/DissertationPage'
import { ModulesPage } from './modules/ModulesPage'
import { RevisionPage } from './revision/RevisionPage'
import { SettingsPage } from './SettingsPage'
import { SetupPage } from './setup/SetupPage'
import { StatsPage } from './stats/StatsPage'

/**
 * Every page in the app: its route, rail entry and component.
 * To add a page, write the component and add one entry here.
 */
export interface PageDef {
  id: string
  path: string
  label: string
  icon: LucideIcon
  component: ComponentType
  /** Rail position: main list, pinned to the bottom, or not on the rail (a sub-page). */
  placement: 'top' | 'bottom' | 'none'
}

export const PAGES: PageDef[] = [
  {
    id: 'calendar',
    path: '/',
    label: 'Calendar',
    icon: CalendarDays,
    component: CalendarPage,
    placement: 'top'
  },
  {
    id: 'modules',
    path: '/modules',
    label: 'Modules',
    icon: Layers,
    component: ModulesPage,
    placement: 'top'
  },
  {
    id: 'module',
    path: '/modules/:id',
    label: 'Module',
    icon: Layers,
    component: ModulesPage,
    placement: 'none'
  },
  {
    id: 'assignments',
    path: '/assignments',
    label: 'Assignments',
    icon: ClipboardList,
    component: AssignmentsPage,
    placement: 'top'
  },
  {
    id: 'assignment',
    path: '/assignments/:id',
    label: 'Assignment',
    icon: ClipboardList,
    component: AssignmentPage,
    placement: 'none'
  },
  {
    // Experimental spaced repetition: remove this entry (and pages/revision) to drop it.
    id: 'revision',
    path: '/revision',
    label: 'Revision',
    icon: Brain,
    component: RevisionPage,
    placement: 'top'
  },
  {
    id: 'dissertation',
    path: '/dissertation',
    label: 'Dissertation',
    icon: GraduationCap,
    component: DissertationPage,
    placement: 'top'
  },
  {
    id: 'backlog',
    path: '/backlog',
    label: 'Backlog',
    icon: Inbox,
    component: BacklogPage,
    placement: 'top'
  },
  {
    id: 'stats',
    path: '/stats',
    label: 'Stats',
    icon: ChartColumn,
    component: StatsPage,
    placement: 'top'
  },
  {
    id: 'settings',
    path: '/settings',
    label: 'Settings',
    icon: Settings,
    component: SettingsPage,
    placement: 'bottom'
  },
  {
    // The setup wizard: opens by itself until the real profile is set up, and from Settings.
    id: 'setup',
    path: '/setup',
    label: 'Setup',
    icon: Wand2,
    component: SetupPage,
    placement: 'none'
  }
]
