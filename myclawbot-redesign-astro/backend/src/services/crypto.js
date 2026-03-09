import crypto from 'crypto';

const ENC_ALGO = 'aes-256-gcm';

function getKey() {
  const raw = process.env.ENCRYPTION_KEY || '';
  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptSecret(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENC_ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

export function decryptSecret(payload) {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  const decipher = crypto.createDecipheriv(ENC_ALGO, getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
