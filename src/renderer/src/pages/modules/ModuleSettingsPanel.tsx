import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { ModuleDetail } from '@shared/types'
import { call } from '../../lib/api'
import { errorMessage, useUpdateModule } from '../../lib/queries'
import { SidePanel } from '../../shell/SidePanel'
import { ColourPicker } from './ColourPicker'
import m from './Modules.module.css'

/** One module's settings, in a side panel opened from the gear button. */
export function ModuleSettingsPanel({ mod, onClose }: { mod: ModuleDetail; onClose: () => void }) {
  const update = useUpdateModule()
  const [perHour, setPerHour] = useState(String(mod.writeUpMinutes))
  const [notes, setNotes] = useState(mod.assessmentNotes ?? '')
  const [name, setName] = useState(mod.name)
  const [label, setLabel] = useState(mod.shortLabel)
  const [folderError, setFolderError] = useState<string | null>(null)
  const save = (patch: Parameters<typeof update.mutate>[0]['patch']) =>
    update.mutate({ id: mod.id, patch })
  const saveName = () => {
    if (name.trim() && name.trim() !== mod.name) save({ name })
    else setName(mod.name)
  }
  const saveLabel = () => {
    if (label.trim() && label.trim().toUpperCase() !== mod.shortLabel) save({ shortLabel: label })
    else setLabel(mod.shortLabel)
  }
  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur()
  }

  const chooseFolder = async () => {
    const path = await call('modules:chooseFolder')
    if (path) save({ folderPath: path })
  }
  const openFolder = () =>
    call('modules:openFolder', mod.id).then(
      () => setFolderError(null),
      (e) => setFolderError(errorMessage(e))
    )

  return (
    <SidePanel title={`${mod.shortLabel} settings`} onClose={onClose}>
      <div className={m.setting}>
        <div className={m.settingLabel}>Name</div>
        <div className={m.inline}>
          <input
            className={`${m.input} ${m.nameField}`}
            value={name}
            maxLength={120}
            aria-label="Module name"
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={onEnter}
          />
          <input
            className={`${m.input} ${m.labelField}`}
            value={label}
            maxLength={8}
            aria-label="Short label"
            title="Short label: the tab and timetable code (e.g. NEUR)"
            onChange={(e) => setLabel(e.target.value.toUpperCase())}
            onBlur={saveLabel}
            onKeyDown={onEnter}
          />
        </div>
        {update.error && <p className={m.error}>{errorMessage(update.error)}</p>}
      </div>

      <div className={m.setting}>
        <div className={m.settingLabel}>Colour</div>
        <ColourPicker value={mod.colour} onChange={(colour) => save({ colour })} />
      </div>

      <div className={m.setting}>
        <div className={m.settingLabel}>Write-up time</div>
        <div className={m.inline}>
          <input
            className={m.input}
            type="number"
            min={15}
            max={240}
            step={15}
            value={perHour}
            aria-label="Write-up minutes per hour of lecture"
            onChange={(e) => setPerHour(e.target.value)}
            onBlur={() =>
              Number(perHour) !== mod.writeUpMinutes && save({ writeUpMinutes: Number(perHour) })
            }
          />
          <span className={m.muted}>minutes per hour of lecture</span>
        </div>
        <p className={m.hint}>
          A 2-hour lecture gets twice this. Applies to write-ups placed from now on.
        </p>
      </div>

      <div className={m.setting}>
        <div className={m.settingLabel}>Lectures</div>
        <label className={m.settingSwitch}>
          <input
            type="checkbox"
            checked={mod.autoOrganise}
            onChange={(e) => save({ autoOrganise: e.target.checked })}
          />
          Organise lectures with Claude
        </label>
        <p className={m.hint}>
          After each Moodle sync, Claude names the lectures and tags their slides from the
          timetable, the lecture list and Moodle. Turn it off to do it all yourself; names you give
          and files you place are kept either way.
        </p>
      </div>
      {(mod.timetabledSessionCount > 0 || mod.timetabledSessions !== null) && (
        <div className={m.setting}>
          <div className={m.settingLabel}>Practicals and workshops</div>
          <label className={m.settingSwitch}>
            <input
              type="checkbox"
              checked={!!mod.timetabledSessions}
              onChange={(e) => save({ timetabledSessions: e.target.checked })}
            />
            List the timetable’s practicals and workshops, with write-ups
          </label>
          <p className={m.hint}>
            The timetable has {mod.timetabledSessionCount} for this module. Turned off, they stay on
            the calendar without write-ups. Sessions the timetable calls lectures are sorted by
            their names; right-click one to say what it is.
          </p>
        </div>
      )}
      <div className={m.setting}>
        <div className={m.settingLabel}>Moodle forums</div>
        <label className={m.settingSwitch}>
          <input
            type="checkbox"
            checked={mod.forumNotifications}
            onChange={(e) => save({ forumNotifications: e.target.checked })}
          />
          Notify me about important forum posts
        </label>
        <p className={m.hint}>
          Announcements, and staff posts that change something: a lecture cancelled or moved, a room
          change, an assignment released, a deadline changed, an extension. Students’ questions and
          staff answers are left out. Notifications stay in Engram.
        </p>
      </div>
      <div className={m.setting}>
        <div className={m.settingLabel}>Folder</div>
        <div className={m.mono}>{mod.folderPath ?? 'Not set'}</div>
        <div className={m.inline}>
          <button className={m.button} onClick={chooseFolder}>
            Choose…
          </button>
          <button
            className={`${m.button} ${m.withIcon}`}
            onClick={openFolder}
            disabled={!mod.folderPath}
          >
            <FolderOpen size={13} /> Open in Finder
          </button>
        </div>
        {folderError && <p className={m.error}>{folderError}</p>}
      </div>

      <div className={m.setting}>
        <div className={m.settingLabel}>Assessment</div>
        <textarea
          className={m.textarea}
          value={notes}
          placeholder="How this module is assessed"
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== (mod.assessmentNotes ?? '') && save({ assessmentNotes: notes })}
        />
      </div>

      {mod.feedNames.length > 0 && (
        <div className={m.setting}>
          <div className={m.settingLabel}>Timetable names</div>
          <ul className={m.names}>
            {mod.feedNames.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      {update.error && <p className={m.error}>{errorMessage(update.error)}</p>}
    </SidePanel>
  )
}
