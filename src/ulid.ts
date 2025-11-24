/**
 * Cloudflare Workers-compatible ULID generator
 *
 * Simplified ULID implementation using crypto.randomUUID() for randomness
 */

// Crockford's Base32 alphabet (excludes I, L, O, U to avoid confusion)
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generate a ULID-like identifier
 *
 * Format: 26 characters in Crockford Base32
 * - First 10 chars: timestamp (milliseconds since epoch)
 * - Last 16 chars: random
 */
export function generateULID(): string {
  const timestamp = Date.now();

  // Encode timestamp (10 chars)
  let timeStr = '';
  let time = timestamp;
  for (let i = 9; i >= 0; i--) {
    const mod = time % 32;
    timeStr = ENCODING[mod] + timeStr;
    time = Math.floor(time / 32);
  }

  // Generate random part (16 chars)
  let randomStr = '';
  const randomValues = crypto.getRandomValues(new Uint8Array(16));
  for (let i = 0; i < 16; i++) {
    randomStr += ENCODING[randomValues[i] % 32];
  }

  return timeStr + randomStr;
}
