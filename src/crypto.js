'use strict';

const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');

function normalizeEncryptionKey(value) {
  let key;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) key = Buffer.from(value);
  else if (typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value)) key = Buffer.from(value, 'hex');
  else if (typeof value === 'string') key = Buffer.from(value.trim(), 'base64');
  if (!key || key.length !== 32) {
    throw new Error('ENCRYPTION_KEY deve conter uma chave de 32 bytes em base64 ou hexadecimal.');
  }
  return key;
}

function encryptString(value, key, context = '') {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', normalizeEncryptionKey(key), iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
}

function decryptString(value, key, context = '') {
  try {
    const [version, iv, tag, data, ...extra] = String(value).split(':');
    if (version !== 'v1' || extra.length || !iv || !tag || data === undefined) throw new Error('Formato inválido');
    const decipher = createDecipheriv('aes-256-gcm', normalizeEncryptionKey(key), Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Não foi possível decifrar os dados. Verifique ENCRYPTION_KEY; preserve a chave original.');
  }
}

module.exports = { normalizeEncryptionKey, encryptString, decryptString };
