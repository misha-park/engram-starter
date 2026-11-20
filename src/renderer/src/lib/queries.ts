import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AssignmentInput,
  AssignmentUpdate,
  AvailabilitySettings,
  ManualTimeInput,
  ModuleUpdate,
  OutcomeInput,
  RecurrenceRule,
  TodoInput
} from '@shared/types'
import { call } from './api'

// One hook per read. All data lives in main; React Query caches it and refetches after
// mutations or a `data:changed` event (see main.tsx).

export const useProfile = () =>
  useQuery({ queryKey: ['profile'], queryFn: () => call('profile:get') })

export const useCategories = () =>
  useQuery({ queryKey: ['categories'], queryFn: () => call('categories:list') })

export const useModules = () =>
  useQuery({ queryKey: ['modules'], queryFn: () => call('modules:list') })

export const useBlocks = (startIso: string, endIso: string) =>
  useQuery({
    queryKey: ['blocks', startIso, endIso],
    queryFn: () => call('blocks:listInRange', startIso, endIso)
  })

export const useTodos = () => useQuery({ queryKey: ['todos'], queryFn: () => call('todos:list') })

export const useTodaySummary = () =>
  useQuery({
    queryKey: ['summary'],
    queryFn: () => call('summary:today'),
    refetchInterval: 60_000
  })

export function useResetDemo() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => call('demo:reset'),
    onSuccess: () => qc.invalidateQueries()
  })
}

export function useSwitchProfile() {
  return useMutation({ mutationFn: (name: 'demo' | 'real') => call('profile:switch', name) })
}

/** Events of the linked calendars (iCloud…) in a range: shown on the calendar, never planned around. */
export const useLinkedEvents = (startIso: string, endIso: string) =>
  useQuery({
    queryKey: ['linkedEvents', startIso, endIso],
    queryFn: () => call('calendars:listEvents', startIso, endIso)
  })

export const useDeadlines = (startIso: string, endIso: string) =>
  useQuery({
    queryKey: ['deadlines', startIso, endIso],
    queryFn: () => call('deadlines:listInRange', startIso, endIso)
  })

/** Whether Claude is connected (token stored), its model, and whether it's replying. */
export const useAssistantStatus = () =>
  useQuery({ queryKey: ['assistantStatus'], queryFn: () => call('assistant:status') })

/** A larger assistant change waiting to be accepted or rejected (shown on the calendar). */
export const useAssistantPending = () =>
  useQuery({ queryKey: ['assistantPending'], queryFn: () => call('assistant:pending') })

export const useAvailability = () =>
  useQuery({ queryKey: ['availability'], queryFn: () => call('settings:getAvailability') })

export const useRecurrence = (id: string | null) =>
  useQuery({
    queryKey: ['recurrence', id],
    queryFn: () => call('recurrences:get', id!),
    enabled: id !== null
  })

/** Everything that depends on block times. */
function useInvalidateCalendar() {
  const qc = useQueryClient()
  return () =>
    Promise.all(
      ['blocks', 'deadlines', 'summary', 'recurrence', 'backlog', 'notifications'].map((k) =>
        qc.invalidateQueries({ queryKey: [k] })
      )
    )
}

export function useMoveBlock() {
  const invalidate = useInvalidateCalendar()
  return useMutation({
    mutationFn: (v: { id: string; start: string; end: string }) =>
      call('blocks:move', v.id, v.start, v.end),
    onSettled: invalidate
  })
}

export function useRemoveOccurrence() {
  const invalidate = useInvalidateCalendar()
  return useMutation({
    mutationFn: (id: string) => call('blocks:removeOccurrence', id),
    onSuccess: invalidate
  })
}

export function useUpdateRecurrence() {
  const invalidate = useInvalidateCalendar()
  return useMutation({
    mutationFn: (v: { id: string; rule: RecurrenceRule }) =>
      call('recurrences:update', v.id, v.rule),
    onSuccess: invalidate
  })
}

export function useSetAvailability() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (av: AvailabilitySettings) => call('settings:setAvailability', av),
    onSuccess: (saved) => qc.setQueryData(['availability'], saved)
  })
}

// --- Modules and timetable --------------------------------------------------------------

export const useModule = (id: string) =>
  useQuery({ queryKey: ['module', id], queryFn: () => call('modules:get', id) })

export const useFeedNames = () =>
  useQuery({ queryKey: ['feedNames'], queryFn: () => call('feedNames:list') })

export const useLastImport = () =>
  useQuery({ queryKey: ['lastImport'], queryFn: () => call('timetable:lastImport') })

/** Module and mapping changes touch blocks, titles and colours everywhere: refetch it all. */
function useInvalidateAll() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries()
}

export function useUpdateModule() {
  const invalidate = useInvalidateAll()
  return useMutation({
    mutationFn: (v: { id: string; patch: ModuleUpdate }) => call('modules:update', v.id, v.patch),
    onSuccess: invalidate
  })
}

export function useCreateModule() {
  const invalidate = useInvalidateAll()
  return useMutation({
    mutationFn: (input: { name: string; shortLabel: string; colour: string; feedName?: string }) =>
      call('modules:create', input),
    onSuccess: invalidate
  })
}

export function useAssignFeedName() {
  const invalidate = useInvalidateAll()
  return useMutation({
    mutationFn: (v: { name: string; moduleId: string | null }) =>
      call('feedNames:assign', v.name, v.moduleId),
    onSuccess: invalidate
  })
}

export function useImportTimetable() {
  const invalidate = useInvalidateAll()
  return useMutation({ mutationFn: () => call('timetable:import'), onSuccess: invalidate })
}

/** Strip Electron's "Error invoking remote method …" prefix from IPC errors. */
export function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

// --- Time tracking ----------------------------------------------------------------------

export const useTimer = () =>
  useQuery({ queryKey: ['timer'], queryFn: () => call('timer:get'), refetchInterval: 15_000 })

export const useCheckins = () =>
  useQuery({ queryKey: ['checkins'], queryFn: () => call('sessions:checkins') })

/** Timer and session changes affect blocks, totals, check-ins and module progress. */
function useInvalidateTracking() {
  const qc = useQueryClient()
  return () =>
    Promise.all(
      [
        'timer',
        'checkins',
        'blocks',
        'summary',
        'module',
        'backlog',
        'notifications',
        'todos',
        'assignment',
        'assignments'
      ].map((k) => qc.invalidateQueries({ queryKey: [k] }))
    )
}

export function useStartTimer() {
  const invalidate = useInvalidateTracking()
  return useMutation({
    mutationFn: (blockId: string) => call('timer:start', blockId),
    onSuccess: invalidate
  })
}

export function useExtendTimer() {
  const invalidate = useInvalidateTracking()
  return useMutation({
    mutationFn: (minutes: number) => call('timer:extend', minutes),
    onSuccess: invalidate
  })
}

export function useStopTimer() {
  const invalidate = useInvalidateTracking()
  return useMutation({ mutationFn: () => call('timer:stop'), onSuccess: invalidate })
}

export function useCompleteSession() {
  const invalidate = useInvalidateTracking()
  return useMutation({
    mutationFn: (v: { sessionId: string; input: OutcomeInput; correctedEnd?: string }) =>
      call('sessions:complete', v.sessionId, v.input, v.correctedEnd),
    onSuccess: invalidate
  })
}

export function useMarkOutcome() {
  const invalidate = useInvalidateTracking()
  return useMutation({
    mutationFn: (v: { blockId: string; input: OutcomeInput & { minutes?: number } }) =>
      call('blocks:markOutcome', v.blockId, v.input),
    onSuccess: invalidate
  })
}

export function useSaveDebrief() {
  const invalidate = useInvalidateTracking()
  return useMutation({
    mutationFn: (v: { blockId: string; debrief: string }) =>
      call('blocks:saveDebrief', v.blockId, v.debrief),
    onSuccess: invalidate
  })
}

export function useAddManualTime() {
  const invalidate = useInvalidateTracking()
  return useMutation({
    mutationFn: (input: ManualTimeInput) => call('sessions:addManual', input),
    onSuccess: invalidate
  })
}

// --- Assignments ------------------------------------------------------------------------

export const useGeneralDeadlines = () =>
  useQuery({ queryKey: ['generalDeadlines'], queryFn: () => call('deadlines:list') })

export const useAssignments = () =>
  useQuery({ queryKey: ['assignments'], queryFn: () => call('assignments:list') })

export const useAssignment = (id: string) =>
  useQuery({ queryKey: ['assignment', id], queryFn: () => call('assignments:get', id) })

/** Assignment changes replan blocks: refetch everything. */
function useAssignmentMutation<V, R>(fn: (v: V) => Promise<R>) {
  const invalidate = useInvalidateAll()
  return useMutation({ mutationFn: fn, onSuccess: invalidate })
}

export const useCreateAssignment = () =>
  useAssignmentMutation((input: AssignmentInput) => call('assignments:create', input))
export const useUpdateAssignment = () =>
  useAssignmentMutation((v: { id: string; patch: AssignmentUpdate }) =>
    call('assignments:update', v.id, v.patch)
  )
export const useSubmitAssignment = () =>
  useAssignmentMutation((v: { id: string; submitted: boolean }) =>
    call('assignments:submit', v.id, v.submitted)
  )
export const useRescheduleAssignment = () =>
  useAssignmentMutation((id: string) => call('assignments:reschedule', id))
export const useAddStage = () =>
  useAssignmentMutation((v: { assignmentId: string; name: string; estimateMinutes: number }) =>
    call('stages:add', v.assignmentId, { name: v.name, estimateMinutes: v.estimateMinutes })
  )
export const useUpdateStage = () =>
  useAssignmentMutation(
    (v: { id: string; patch: { name?: string; estimateMinutes?: number; done?: boolean } }) =>
      call('stages:update', v.id, v.patch)
  )
export const useMoveStage = () =>
  useAssignmentMutation((v: { id: string; direction: -1 | 1 }) =>
    call('stages:move', v.id, v.direction)
  )

// --- Backlog, todos, notifications ---------------------------------------------------------

export const useBacklog = () =>
  useQuery({ queryKey: ['backlog'], queryFn: () => call('backlog:list'), refetchInterval: 60_000 })

export const useNotifications = () =>
  useQuery({
    queryKey: ['notifications'],
    queryFn: () => call('notifications:list'),
    refetchInterval: 60_000
  })

export const useScheduleBacklogItem = () =>
  useAssignmentMutation((v: { key: string; start?: string; minutes?: number }) =>
    call('backlog:schedule', v.key, { start: v.start, minutes: v.minutes })
  )
export const useDismissBacklogItem = () =>
  useAssignmentMutation((key: string) => call('backlog:dismiss', key))
export const useCreateTodo = () =>
  useAssignmentMutation((input: TodoInput) => call('todos:create', input))
export const useUpdateTodo = () =>
  useAssignmentMutation((v: { id: string; patch: Partial<TodoInput> }) =>
    call('todos:update', v.id, v.patch)
  )
export const useSetTodoDone = () =>
  useAssignmentMutation((v: { id: string; done: boolean }) => call('todos:setDone', v.id, v.done))
export const useArchiveTodo = () => useAssignmentMutation((id: string) => call('todos:archive', id))
export const useScheduleTodo = () =>
  useAssignmentMutation((v: { id: string; minutes: number; start?: string }) =>
    call('todos:schedule', v.id, { minutes: v.minutes, start: v.start })
  )
