import 'server-only'

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Encryption for the OAuth tokens we hold on a customer's mailbox (PRD s9:
 * "encrypted tokens at rest").
 *
 * A Graph refresh token is a standing key to a distributor's email. The
 * database already restricts `mailbox_connections` to tenant admins, but a
 * backup, a log, or a support query with the service role should not hand
 * anyone a usable token either.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than decrypting to something wrong.
 */

const VERSION = 'v1'

let cachedKey: Buffer | null = null

// Read straight from process.env rather than through serverEnv(): this module
// needs exactly one variable, and making it depend on the whole server
// environment validating would mean a missing database key stops us encrypting
// a token that has nothing to do with the database.
function key(): Buffer {
  if (cachedKey) return cachedKey

  const TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY
  if (!TOKEN_ENCRYPTION_KEY) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY is not set. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    )
  }

  const material = Buffer.from(TOKEN_ENCRYPTION_KEY, 'base64')
  if (material.length !== 32) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must be 32 bytes of base64 (got ${material.length}). ` +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    )
  }

  cachedKey = material
  return cachedKey
}

/** Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.')
}

export function decryptToken(encoded: string): string {
  const [version, iv, tag, ciphertext] = encoded.split('.')
  if (version !== VERSION || !iv || !tag || !ciphertext) {
    throw new Error('Stored token is not in a recognised format')
  }

  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

/** True when the key is configured and usable, without throwing. */
export function encryptionAvailable(): boolean {
  try {
    key()
    return true
  } catch {
    return false
  }
}

/**
 * Constant-time comparison for the `clientState` Graph echoes back on every
 * notification. A plain `===` here would leak the secret one character at a
 * time to anyone who can measure the response.
 */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
