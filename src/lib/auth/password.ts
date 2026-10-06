import { hash, verify } from "@node-rs/argon2";

/** Argon2id with the library's OWASP-level defaults (m=19456 KiB, t=2, p=1). */
export async function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string | null | undefined, password: string): Promise<boolean> {
  if (!passwordHash) return false;
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export const MIN_PASSWORD_LENGTH = 10;

/** Plain-language problem with a new password, or null when it's fine. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters. A short sentence you'll remember works well.`;
  }
  if (password.length > 200) return "That password is too long. Use 200 characters or fewer.";
  return null;
}
