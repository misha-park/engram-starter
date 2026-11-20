import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

// The Claude token from `claude setup-token` (it bills the user's own Claude plan). It is
// encrypted with Electron's safeStorage, whose key lives in the macOS Keychain, and kept in the
// app's data folder: never in the repo, the database or settings. Shared by both profiles.

/** The parts of Electron's safeStorage we use (injected so tests can fake it). */
export interface Encryptor {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plain: string): Promise<Buffer>
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string }>
}

const TOKEN_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,}$/

/**
 * The token as pasted. `claude setup-token` wraps it across lines in a narrow terminal, so
 * copying it brings line breaks and spaces along: those are never part of a token.
 */
export function cleanToken(pasted: string): string {
  return pasted.replace(/\s+/g, '')
}

export class TokenStore {
  private readonly file: string

  constructor(
    userDataDir: string,
    private readonly crypto: Encryptor
  ) {
    this.file = join(userDataDir, 'secrets', 'claude-token.bin')
  }

  canStore(): Promise<boolean> {
    return this.crypto.isAsyncEncryptionAvailable()
  }

  has(): boolean {
    return existsSync(this.file)
  }

  async get(): Promise<string | null> {
    if (!this.has()) return null
    try {
      return (await this.crypto.decryptStringAsync(readFileSync(this.file))).result
    } catch {
      return null
    }
  }

  async set(pasted: string): Promise<void> {
    const value = cleanToken(pasted)
    if (!TOKEN_PATTERN.test(value)) {
      throw new Error(
        'That doesn’t look like a Claude token. It starts with “sk-ant-” (copy all of it, including the part on the next lines).'
      )
    }
    if (!(await this.canStore())) {
      throw new Error('The macOS Keychain isn’t available, so the token can’t be stored safely.')
    }
    mkdirSync(join(this.file, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(this.file, await this.crypto.encryptStringAsync(value), { mode: 0o600 })
  }

  clear(): void {
    rmSync(this.file, { force: true })
  }
}
