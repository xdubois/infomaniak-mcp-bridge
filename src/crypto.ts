import {createCipheriv, createDecipheriv, createHash, randomBytes} from "node:crypto";

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
/** PKCE S256 challenge for a verifier. */
export const s256Challenge = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");

const IV_LEN = 12;
const TAG_LEN = 16;

/** AES-256-GCM; output is base64(iv | tag | ciphertext). */
export function encrypt(plain: string, key: Buffer): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decrypt(payload: string, key: Buffer): string {
    const buf = Buffer.from(payload, "base64");
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
