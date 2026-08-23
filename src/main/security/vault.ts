import { promises as fs } from 'fs'
import { join } from 'path'
import { createCipheriv, createDecipheriv, randomBytes, scrypt, timingSafeEqual } from 'crypto'
import { promisify } from 'util'
import { safeStorage } from 'electron'
import { SECRET_ENVELOPE_PREFIX, type VaultStatus } from '@shared/types'
import { getWorkspaceRoot, hasWorkspace, readRememberedPassphrase, rememberPassphrase } from '../storage/workspace'

/**
 * The vault: private values are encrypted at rest so the workspace stays safe to commit.
 *
 * The workspace is deliberately git-tracked (see workspace.ts) — which means every
 * profile variable, project environment variable and recorded node value is committed
 * in plaintext. Marking one "private" swaps the stored value for ciphertext.
 *
 * A passphrase-derived key rather than a machine-local one, because the whole premise
 * of the workspace is that it travels with the user's repo: a key bound to one machine
 * would leave a teammate cloning the repo with undecryptable garbage. This is the
 * ansible-vault model — commit the ciphertext, share the passphrase out of band.
 *
 * The key lives only in this module's memory. The renderer never holds it; it passes
 * ciphertext around opaquely and asks for a single plaintext at a time when revealing.
 */

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>

/** ~100ms on a modern desktop — slow enough to make offline guessing expensive. */
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 }
const KEY_LEN = 32
/** scrypt needs roughly 128 * N * r bytes; the default 32MB cap is below what N=32768 wants. */
const SCRYPT_MAXMEM = 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2

const IV_LEN = 12
const MARKER = '.flowtest.json'

/** Encrypted under the vault key at setup; decrypting it back is how a passphrase is verified. */
const VERIFIER_PLAINTEXT = 'flowtest-vault-v1'

export interface VaultMeta {
  v: 1
  kdf: 'scrypt'
  N: number
  r: number
  p: number
  /** base64 */
  salt: string
  /** Envelope over VERIFIER_PLAINTEXT — safe to commit, it reveals nothing without the passphrase. */
  verifier: string
}

interface MarkerFile {
  version?: number
  vault?: VaultMeta
  [k: string]: unknown
}

// ── In-memory key state ───────────────────────────────────────────────────────

let key: Buffer | null = null
let meta: VaultMeta | null = null
/** Which workspace the loaded state belongs to, so a stale key can never outlive a switch. */
let loadedFor: string | null = null

// ── Marker file access ────────────────────────────────────────────────────────

function markerPath(root: string): string {
  return join(root, MARKER)
}

async function readMarker(root: string): Promise<MarkerFile> {
  try {
    return JSON.parse(await fs.readFile(markerPath(root), 'utf-8')) as MarkerFile
  } catch {
    return { version: 1 }
  }
}

/** Merge-write: the marker is shared with scaffold(), so never clobber unrelated fields. */
async function writeMarker(root: string, patch: Partial<MarkerFile>): Promise<void> {
  const current = await readMarker(root)
  const next = { ...current, ...patch }
  await fs.writeFile(markerPath(root), JSON.stringify(next, null, 2) + '\n', 'utf-8')
}

// ── Crypto primitives ─────────────────────────────────────────────────────────

async function deriveKey(passphrase: string, m: VaultMeta): Promise<Buffer> {
  return scryptAsync(passphrase.normalize('NFKC'), Buffer.from(m.salt, 'base64'), KEY_LEN, {
    N: m.N,
    r: m.r,
    p: m.p,
    maxmem: 128 * m.N * m.r * 2,
  })
}

function encryptWith(k: Buffer, plain: string): string {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', k, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()])
  const payload = Buffer.concat([ct, cipher.getAuthTag()])
  return `${SECRET_ENVELOPE_PREFIX}${iv.toString('base64')}:${payload.toString('base64')}`
}

function decryptWith(k: Buffer, envelope: string): string {
  const body = envelope.slice(SECRET_ENVELOPE_PREFIX.length)
  const sep = body.indexOf(':')
  if (sep < 0) throw new Error('[FlowTest] 私密資料格式錯誤')
  const iv = Buffer.from(body.slice(0, sep), 'base64')
  const payload = Buffer.from(body.slice(sep + 1), 'base64')
  if (payload.length < 16) throw new Error('[FlowTest] 私密資料格式錯誤')
  const tag = payload.subarray(payload.length - 16)
  const ct = payload.subarray(0, payload.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', k, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8')
}

// ── Public API ────────────────────────────────────────────────────────────────

/** True for a string produced by encrypt(). Cheap enough to call on every value. */
export function isCiphertext(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_ENVELOPE_PREFIX)
}

export function isUnlocked(): boolean {
  return key !== null
}

export function hasVault(): boolean {
  return meta !== null
}

/** Drop the key. Called on workspace switch and on explicit lock. */
export function lock(): void {
  key = null
}

/**
 * Load the open workspace's vault metadata and try the remembered passphrase.
 * Idempotent per workspace; re-reads when the workspace changed.
 */
export async function load(): Promise<void> {
  if (!hasWorkspace()) {
    key = null
    meta = null
    loadedFor = null
    return
  }
  const root = getWorkspaceRoot()
  if (loadedFor === root && meta !== null) return

  key = null
  loadedFor = root
  meta = (await readMarker(root)).vault ?? null
  if (!meta) return

  // A remembered passphrase makes this a once-per-machine prompt rather than once per launch.
  const remembered = readRememberedPassphrase(root)
  if (remembered) {
    try {
      const plain = safeStorage.decryptString(Buffer.from(remembered, 'base64'))
      await unlock(plain)
    } catch {
      // Keychain entry unusable (different OS user, reinstalled keyring) — just prompt.
    }
  }
}

export function status(): VaultStatus {
  return {
    state: meta === null ? 'none' : key === null ? 'locked' : 'unlocked',
    canRemember: canRemember(),
  }
}

function canRemember(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * Store the passphrase in the OS keychain (DPAPI on Windows). Never falls back to
 * writing it in the clear — where the keychain is unavailable the user simply retypes.
 */
async function remember(root: string, passphrase: string): Promise<void> {
  if (!canRemember()) return
  try {
    await rememberPassphrase(root, safeStorage.encryptString(passphrase).toString('base64'))
  } catch {
    // Not being able to remember is an inconvenience, not a failure.
  }
}

/** Create the vault for the open workspace and unlock it. */
export async function setup(passphrase: string): Promise<void> {
  if (!passphrase) throw new Error('通行碼不可為空')
  const root = getWorkspaceRoot()
  if (meta) throw new Error('此工作區已經有保險庫了')

  const next: VaultMeta = {
    v: 1,
    kdf: 'scrypt',
    ...SCRYPT_PARAMS,
    salt: randomBytes(16).toString('base64'),
    verifier: '',
  }
  const k = await scryptAsync(passphrase.normalize('NFKC'), Buffer.from(next.salt, 'base64'), KEY_LEN, {
    ...SCRYPT_PARAMS,
    maxmem: SCRYPT_MAXMEM,
  })
  next.verifier = encryptWith(k, VERIFIER_PLAINTEXT)

  await writeMarker(root, { vault: next })
  meta = next
  loadedFor = root
  key = k
  await remember(root, passphrase)
}

/** Verify a passphrase and hold the derived key. Returns false on a wrong passphrase. */
export async function unlock(passphrase: string): Promise<boolean> {
  if (!meta) throw new Error('此工作區沒有保險庫')
  const k = await deriveKey(passphrase, meta)
  try {
    const got = Buffer.from(decryptWith(k, meta.verifier), 'utf-8')
    const want = Buffer.from(VERIFIER_PLAINTEXT, 'utf-8')
    if (got.length !== want.length || !timingSafeEqual(got, want)) return false
  } catch {
    // GCM auth failure — wrong passphrase.
    return false
  }
  key = k
  await remember(getWorkspaceRoot(), passphrase)
  return true
}

export function encrypt(plain: string): string {
  if (!key) throw new Error('[FlowTest] 保險庫已鎖定，無法加密')
  return encryptWith(key, plain)
}

export function decrypt(envelope: string): string {
  if (!key) throw new Error('[FlowTest] 保險庫已鎖定，無法讀取私密資料')
  return decryptWith(key, envelope)
}

/** Decrypt when the value is an envelope, otherwise pass it through untouched. */
export function decryptIfNeeded(value: string): string {
  return isCiphertext(value) ? decrypt(value) : value
}

/**
 * Decrypt every envelope in a flat variable map.
 *
 * This must run BEFORE resolveValue(): resolution would otherwise splice ciphertext
 * into a larger string (`https://x/{{token}}`), which can never be decrypted again.
 */
export function decryptMap(vars: Record<string, string> | undefined): Record<string, string> {
  if (!vars) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(vars)) out[k] = decryptIfNeeded(v)
  return out
}

/**
 * Re-key the vault: verify the old passphrase, then let the caller rewrite every stored
 * ciphertext while both keys are available, and only commit the new metadata once that
 * succeeds. `rewrite` receives a re-encrypting function rather than the keys themselves.
 *
 * The ordering here is only half of the guarantee, and used to be mistaken for all of it:
 * not writing the metadata keeps the OLD passphrase verifying, but says nothing about files
 * `rewrite` already replaced. `rewrite` (security/recrypt.ts) is therefore all-or-nothing in
 * its own right — it stages every file before replacing any, and restores from a backup if
 * the commit fails — so a throw from here really does leave the whole workspace on the old
 * passphrase. The one residual: a commit that fails AND cannot be rolled back, which
 * recrypt.ts reports with the path to the backup it kept.
 */
export async function changePassphrase(
  oldPassphrase: string,
  newPassphrase: string,
  rewrite: (recrypt: (envelope: string) => string) => Promise<void>,
): Promise<boolean> {
  if (!meta) throw new Error('此工作區沒有保險庫')
  if (!newPassphrase) throw new Error('新通行碼不可為空')

  const oldKey = await deriveKey(oldPassphrase, meta)
  try {
    if (decryptWith(oldKey, meta.verifier) !== VERIFIER_PLAINTEXT) return false
  } catch {
    return false
  }

  const root = getWorkspaceRoot()
  const next: VaultMeta = {
    v: 1,
    kdf: 'scrypt',
    ...SCRYPT_PARAMS,
    salt: randomBytes(16).toString('base64'),
    verifier: '',
  }
  const newKey = await scryptAsync(newPassphrase.normalize('NFKC'), Buffer.from(next.salt, 'base64'), KEY_LEN, {
    ...SCRYPT_PARAMS,
    maxmem: SCRYPT_MAXMEM,
  })
  next.verifier = encryptWith(newKey, VERIFIER_PLAINTEXT)

  await rewrite((envelope) => encryptWith(newKey, decryptWith(oldKey, envelope)))

  await writeMarker(root, { vault: next })
  meta = next
  key = newKey
  await remember(root, newPassphrase)
  return true
}
