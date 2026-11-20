import { describe, expect, it } from 'vitest'
import { lectureLine, splitLabelledTitle } from './lectures'

describe('calendar labels', () => {
  it('shows a lecture by number and name, or just its number', () => {
    expect(lectureLine(12, 'Ion channels')).toBe('L12. Ion channels')
    expect(lectureLine(12, null)).toBe('L12')
    expect(lectureLine(12, '  ')).toBe('L12')
    expect(lectureLine(4, 'Synapses', 2)).toBe('L4 (part 2). Synapses')
  })

  it('puts the module name on top of a labelled title', () => {
    expect(splitLabelledTitle('NEUR Practical', 'NEUR', 'Neuroscience')).toEqual({
      heading: 'Neuroscience',
      detail: 'Practical'
    })
    expect(splitLabelledTitle('Pub shift', null, null)).toEqual({
      heading: 'Pub shift',
      detail: null
    })
    expect(splitLabelledTitle('NEURO thing', 'NEUR', 'Neuroscience').detail).toBeNull()
  })
})
