import { useState } from 'react'
import { CircleExclamationPoint } from 'lucide-react'
import { CATEGORY_COLOURS } from '@shared/palette'
import {
  errorMessage,
  useAssignFeedName,
  useCreateModule,
  useFeedNames,
  useModules
} from '../../lib/queries'
import { SidePanel } from '../../shell/SidePanel'
import { ColourPicker } from './ColourPicker'
import m from './Modules.module.css'

/**
 * How module names in the timetable feed map to modules. Several names can map to one module
 * (that merges a cross-listed module). Unmapped names show grey on the calendar.
 */
export function TimetableNamesPanel({ onClose }: { onClose: () => void }) {
  const { data: feedNames = [] } = useFeedNames()
  const { data: modules = [] } = useModules()
  const assign = useAssignFeedName()
  const [creating, setCreating] = useState<string | null>(null)
  const unmapped = feedNames.filter((f) => f.moduleId === null && !f.hiddenOnly)

  return (
    <SidePanel title="Timetable names" onClose={onClose}>
      <p className={m.hint}>
        Map each name from the timetable feed to a module. Map several names to one module to merge
        a cross-listed module. Unmapped names show up grey on the calendar; [None] events stay
        hidden.
      </p>
      {unmapped.length > 0 && (
        <p className={m.warning}>
          <CircleExclamationPoint size={13} /> {unmapped.length} name
          {unmapped.length === 1 ? '' : 's'} not mapped yet.
        </p>
      )}
      <div className={m.nameList}>
        {feedNames.map((f) => (
          <div key={f.name} className={m.nameRow}>
            <div className={m.nameText}>
              <div>{f.name}</div>
              <div className={m.muted}>
                {f.events} event{f.events === 1 ? '' : 's'}
                {f.hiddenOnly && ' · all [None], hidden'}
              </div>
            </div>
            <div className={m.inline}>
              <select
                className={m.input}
                value={f.moduleId ?? ''}
                aria-label={`Module for ${f.name}`}
                onChange={(e) => assign.mutate({ name: f.name, moduleId: e.target.value || null })}
              >
                <option value="">Not mapped</option>
                {modules.map((mod) => (
                  <option key={mod.id} value={mod.id}>
                    {mod.shortLabel} · {mod.name}
                  </option>
                ))}
              </select>
              {f.moduleId === null && !f.hiddenOnly && (
                <button
                  className={m.button}
                  onClick={() => setCreating(creating === f.name ? null : f.name)}
                >
                  New module
                </button>
              )}
            </div>
            {creating === f.name && (
              <NewModuleForm feedName={f.name} onDone={() => setCreating(null)} />
            )}
          </div>
        ))}
        {feedNames.length === 0 && <p className={m.muted}>No timetable imported yet.</p>}
      </div>
      {assign.error && <p className={m.error}>{errorMessage(assign.error)}</p>}
    </SidePanel>
  )
}

function NewModuleForm({ feedName, onDone }: { feedName: string; onDone: () => void }) {
  const [name, setName] = useState(feedName)
  const [label, setLabel] = useState(
    feedName
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .slice(0, 4)
      .toUpperCase()
  )
  const [colour, setColour] = useState<string>(CATEGORY_COLOURS[1])
  const create = useCreateModule()

  return (
    <div className={m.newModule}>
      <input
        className={m.input}
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label="Module name"
      />
      <div className={m.inline}>
        <input
          className={`${m.input} ${m.labelInput}`}
          value={label}
          maxLength={6}
          onChange={(e) => setLabel(e.target.value.toUpperCase())}
          aria-label="Short label"
        />
        <ColourPicker value={colour} onChange={setColour} />
      </div>
      <div className={m.inline}>
        <button className={m.button} onClick={onDone}>
          Cancel
        </button>
        <button
          className={m.button}
          disabled={!name.trim() || !label.trim() || create.isPending}
          onClick={() =>
            create.mutate({ name, shortLabel: label, colour, feedName }, { onSuccess: onDone })
          }
        >
          Create
        </button>
      </div>
      {create.error && <p className={m.error}>{errorMessage(create.error)}</p>}
    </div>
  )
}
