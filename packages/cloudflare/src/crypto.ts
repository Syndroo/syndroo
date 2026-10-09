import { canonicalJson, ProtocolError } from '@syndroo/core';
import type { Json } from '@syndroo/core';

export function fail(code: string): never { throw new ProtocolError(code); }
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
export function unhex(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) fail('SECRET_KEY_INVALID');
  return Uint8Array.from(value.match(/../g)!, part => Number.parseInt(part, 16));
}
export function keyBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) fail('SECRET_KEY_INVALID');
  return unhex(value);
}
export function randomHex(size = 32): string { return hex(crypto.getRandomValues(new Uint8Array(size))); }
export function encode64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
export function decode64(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) fail('INVALID_INPUT');
  try { return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0)); }
  catch { return fail('INVALID_INPUT'); }
}
export async function hmacKey(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function digest(value: Json): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)))));
}
export async function cursorSignature(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(unhex(key)), bytes));
}
export async function verifyCursor(key: string, signature: Uint8Array<ArrayBuffer>, bytes: Uint8Array<ArrayBuffer>): Promise<boolean> {
  return crypto.subtle.verify('HMAC', await hmacKey(unhex(key)), signature, bytes);
}
