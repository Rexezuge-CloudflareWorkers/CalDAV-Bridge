const IV_BYTE_LENGTH = 12;

async function importAesKey(masterKey: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(masterKey));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function encryptData(plaintext: string, masterKey: string): Promise<{ encrypted: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
  const key = await importAesKey(masterKey);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(new TextEncoder().encode(plaintext))));
  return { encrypted: encodeBase64(encrypted), iv: encodeBase64(iv) };
}

async function decryptData(encrypted: string, iv: string, masterKey: string): Promise<string> {
  const key = await importAesKey(masterKey);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(decodeBase64(iv)) }, key, toArrayBuffer(decodeBase64(encrypted)));
  return new TextDecoder().decode(decrypted);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export { decryptData, encryptData };
