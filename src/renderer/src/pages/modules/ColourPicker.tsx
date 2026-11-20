import type { CSSProperties } from 'react'
import { Check } from 'lucide-react'
import { CATEGORY_COLOURS } from '@shared/palette'
import m from './Modules.module.css'

export function ColourPicker({
  value,
  onChange
}: {
  value: string
  onChange: (c: string) => void
}) {
  return (
    <div className={m.colours} role="radiogroup" aria-label="Colour">
      {CATEGORY_COLOURS.map((c) => (
        <button
          key={c}
          role="radio"
          aria-checked={c === value}
          aria-label={c}
          className={m.colour}
          style={{ '--cat': c } as CSSProperties}
          onClick={() => onChange(c)}
        >
          {c === value && <Check size={11} strokeWidth={3} />}
        </button>
      ))}
    </div>
  )
}
