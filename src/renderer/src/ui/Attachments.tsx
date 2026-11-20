import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Copy,
  Download,
  ClipboardPaste,
  ExternalLink,
  File,
  FileImage,
  FileText,
  FolderSearch,
  Paperclip,
  Pencil,
  Plus,
  Trash2
} from 'lucide-react'
import type { Attachment, AttachmentRef } from '@shared/types'
import { call } from '../lib/api'
import { copyFile, dragFile, saveToDownloads } from '../lib/download'
import { formatSize, useFileDrop } from '../lib/files'
import { errorMessage } from '../lib/queries'
import { briefName } from './briefName'
import { openContextMenu } from './menuStore'
import f from './Attachments.module.css'

/** A file's icon: picture, readable document or other file. */
export function FileIcon({
  file,
  size,
  className
}: {
  file: Pick<Attachment, 'mime' | 'readable'>
  size: number
  className?: string
}) {
  if (file.mime.startsWith('image/')) return <FileImage size={size} className={className} />
  if (file.readable) return <FileText size={size} className={className} />
  return <File size={size} className={className} />
}

/**
 * An item's files: drop files here (or choose them) and Engram keeps a copy. Open, show in
 * Finder, rename or remove. `list` overrides what's shown (e.g. all of the dissertation's).
 */
export function Attachments({
  target,
  list,
  showTargets = false,
  places,
  hint = 'Drop files here: briefs, marking criteria, slides, notes…',
  pasteLabel
}: {
  target: AttachmentRef
  list?: { key: unknown[]; fetch: () => Promise<Attachment[]> }
  showTargets?: boolean
  /** Where each file can be moved to (shown as a menu on each row). */
  places?: { ref: AttachmentRef; label: string }[]
  hint?: string
  /** Offer to type or paste text (kept as a .txt file), e.g. "Paste the brief…". */
  pasteLabel?: string
}) {
  const [pasting, setPasting] = useState(false)
  const [text, setText] = useState('')
  const qc = useQueryClient()
  const key = list?.key ?? ['files', target.type, target.id]
  const { data: items = [] } = useQuery({
    queryKey: key,
    queryFn: list?.fetch ?? (() => call('files:list', target))
  })
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      await qc.invalidateQueries({ queryKey: ['files'] })
    }
  }
  const drop = useFileDrop((paths) => void run(() => call('files:add', paths, target)))

  return (
    <div className={f.zone} data-over={drop.over || undefined} {...drop.props}>
      {items.length === 0 ? (
        <p className={f.empty}>
          <Paperclip size={14} /> {hint}
        </p>
      ) : (
        <ul className={f.list}>
          {items.map((a) => (
            <FileRow key={a.id} a={a} showTarget={showTargets} places={places} run={run} />
          ))}
        </ul>
      )}
      <div className={f.footer}>
        <button className={f.add} onClick={() => void run(() => call('files:choose', target))}>
          <Plus size={13} /> Add files…
        </button>
        {pasteLabel && !pasting && (
          <button className={f.add} onClick={() => setPasting(true)}>
            <ClipboardPaste size={13} /> {pasteLabel}
          </button>
        )}
        {drop.over && <span className={f.dropHint}>Drop to attach</span>}
      </div>
      {pasting && (
        <div className={f.paste}>
          <textarea
            className={f.pasteText}
            value={text}
            autoFocus
            rows={7}
            placeholder="Type or paste the text, e.g. the brief from Moodle"
            aria-label="Text to add"
            onChange={(e) => setText(e.target.value)}
          />
          <div className={f.pasteActions}>
            <button
              className={f.add}
              onClick={() => {
                setPasting(false)
                setText('')
              }}
            >
              Cancel
            </button>
            <button
              className={f.addPrimary}
              disabled={!text.trim()}
              onClick={() =>
                void run(() => call('files:addText', briefName(text), text, target)).then(() => {
                  setPasting(false)
                  setText('')
                })
              }
            >
              Add as a file
            </button>
          </div>
        </div>
      )}
      {error && <p className={f.error}>{error}</p>}
    </div>
  )
}

function FileRow({
  a,
  showTarget,
  places,
  run
}: {
  a: Attachment
  showTarget: boolean
  places?: { ref: AttachmentRef; label: string }[]
  run: (fn: () => Promise<unknown>) => Promise<void>
}) {
  const placeKey = (r: AttachmentRef | null) => (r ? `${r.type}:${r.id}` : '')
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(a.name)
  const save = () => {
    setEditing(false)
    if (name.trim() && name !== a.name) void run(() => call('files:rename', a.id, name))
    else setName(a.name)
  }
  const menu = (e: React.MouseEvent) =>
    openContextMenu(e, [
      { heading: a.name },
      { label: 'Open', icon: ExternalLink, onSelect: () => run(() => call('files:open', a.id)) },
      { label: 'Save to Downloads', icon: Download, onSelect: () => saveToDownloads(a.id) },
      { label: 'Copy', icon: Copy, onSelect: () => copyFile(a.id, a.name) },
      {
        label: 'Show in Finder',
        icon: FolderSearch,
        onSelect: () => run(() => call('files:reveal', a.id))
      },
      { label: 'Rename', icon: Pencil, onSelect: () => setEditing(true) },
      places && places.length > 1 && 'separator',
      ...(places ?? [])
        .filter((p) => placeKey(p.ref) !== placeKey(a.target))
        .slice(0, 8)
        .map((p) => ({
          label: `Move to ${p.label}`,
          onSelect: () => run(() => call('files:setTarget', a.id, p.ref))
        })),
      'separator',
      {
        label: 'Remove…',
        icon: Trash2,
        danger: true,
        confirm: `Remove “${a.name}”? Engram’s copy is deleted; the original isn’t touched.`,
        onSelect: () => run(() => call('files:remove', a.id))
      }
    ])
  return (
    <li className={f.row} onContextMenu={menu}>
      <FileIcon file={a} size={15} className={f.icon} />
      <div className={f.main}>
        {editing ? (
          <input
            className={f.rename}
            value={name}
            autoFocus
            aria-label="File name"
            onChange={(e) => setName(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') {
                setName(a.name)
                setEditing(false)
              }
            }}
          />
        ) : (
          <button
            className={f.name}
            title="Open (or drag it out)"
            draggable
            onDragStart={(e) => dragFile(e, a.id)}
            onClick={() => void run(() => call('files:open', a.id))}
          >
            {a.name}
          </button>
        )}
        <div className={f.meta}>
          {formatSize(a.size)}
          {showTarget && a.targetLabel ? ` · ${a.targetLabel}` : ''}
          {a.addedBy === 'claude' ? ' · filed by Claude' : ''}
        </div>
      </div>
      {places && (
        <select
          className={f.place}
          value={placeKey(a.target)}
          aria-label={`Where ${a.name} belongs`}
          onChange={(e) => {
            const p = places.find((x) => placeKey(x.ref) === e.target.value)
            if (p) void run(() => call('files:setTarget', a.id, p.ref))
          }}
        >
          {places.map((p) => (
            <option key={placeKey(p.ref)} value={placeKey(p.ref)}>
              {p.label}
            </option>
          ))}
        </select>
      )}
      <button
        className={f.iconButton}
        title="Save to Downloads"
        aria-label={`Save ${a.name} to Downloads`}
        onClick={() => void saveToDownloads(a.id)}
      >
        <Download size={13} />
      </button>
      <button
        className={f.iconButton}
        title="Copy"
        aria-label={`Copy ${a.name}`}
        onClick={() => void copyFile(a.id, a.name)}
      >
        <Copy size={13} />
      </button>
      <button
        className={f.iconButton}
        title="Show in Finder"
        aria-label={`Show ${a.name} in Finder`}
        onClick={() => void run(() => call('files:reveal', a.id))}
      >
        <FolderSearch size={13} />
      </button>
      <button
        className={f.iconButton}
        title="Rename"
        aria-label={`Rename ${a.name}`}
        onClick={() => setEditing(true)}
      >
        <Pencil size={13} />
      </button>
      <button
        className={f.iconButton}
        title="Remove"
        aria-label={`Remove ${a.name}`}
        onClick={() =>
          window.confirm(
            `Remove “${a.name}”? Engram’s copy is deleted; the original isn’t touched.`
          ) && void run(() => call('files:remove', a.id))
        }
      >
        <Trash2 size={13} />
      </button>
    </li>
  )
}
