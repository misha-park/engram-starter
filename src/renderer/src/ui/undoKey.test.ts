import { describe, expect, it } from 'vitest'
import { isTextTarget, isUndoKey } from './undoKey'

const key = (over: Partial<Parameters<typeof isUndoKey>[0]> = {}) => ({
  key: 'z',
  metaKey: true,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  repeat: false,
  ...over
})

describe('isUndoKey', () => {
  it('is plain ⌘Z only', () => {
    expect(isUndoKey(key())).toBe(true)
    expect(isUndoKey(key({ key: 'Z' }))).toBe(true)
    expect(isUndoKey(key({ shiftKey: true }))).toBe(false)
    expect(isUndoKey(key({ metaKey: false }))).toBe(false)
    expect(isUndoKey(key({ metaKey: false, ctrlKey: true }))).toBe(false)
    expect(isUndoKey(key({ altKey: true }))).toBe(false)
    expect(isUndoKey(key({ repeat: true }))).toBe(false)
    expect(isUndoKey(key({ key: 'x' }))).toBe(false)
  })
})

describe('isTextTarget', () => {
  it('leaves typing to the field', () => {
    expect(isTextTarget({ tagName: 'INPUT', type: 'text' })).toBe(true)
    expect(isTextTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isTextTarget({ tagName: 'input', type: 'search' })).toBe(true)
    expect(isTextTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTextTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })
  it('lets the app undo elsewhere', () => {
    expect(isTextTarget(null)).toBe(false)
    expect(isTextTarget({ tagName: 'BODY' })).toBe(false)
    expect(isTextTarget({ tagName: 'BUTTON' })).toBe(false)
    expect(isTextTarget({ tagName: 'INPUT', type: 'checkbox' })).toBe(false)
    expect(isTextTarget({ tagName: 'DIV', isContentEditable: false })).toBe(false)
  })
})
