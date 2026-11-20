import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { Encryptor } from './assistant/auth'

/**
 * A small JSON secret kept encrypted with Electron's safeStorage (its key is in the macOS
 * Keychain), in `<userData>/secrets/<name>.bin`: never in the repo, the database or settings.
 */
export class EncryptedJson<T> {
  private readonly file: string

  constructor(
    userDataDir: string,
    name: string,
    private readonly crypto: Encryptor
  ) {
    this.file = join(userDataDir, 'secrets', `${name}.bin`)
  }

  has(): boolean {
    return existsSync(this.file)
  }

  async get(): Promise<T | null> {
    if (!this.has()) return null
    try {
      return JSON.parse((await this.crypto.decryptStringAsync(readFileSync(this.file))).result) as T
    } catch {
      return null
    }
  }

  async set(value: T): Promise<void> {
    if (!(await this.crypto.isAsyncEncryptionAvailable())) {
      throw new Error('The macOS Keychain isn’t available, so this can’t be stored safely.')
    }
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    writeFileSync(this.file, await this.crypto.encryptStringAsync(JSON.stringify(value)), {
      mode: 0o600
    })
  }

  clear(): void {
    rmSync(this.file, { force: true })
  }
}
