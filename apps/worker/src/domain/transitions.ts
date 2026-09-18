export type QuantityTransition = { kind: 'unchanged' | 'increased' | 'decreased' | 'sold_out'; soldQuantity: number; oldQuantity: number; newQuantity: number };
export function calculateQuantityTransition(oldQuantity: number, newQuantity: number): QuantityTransition {
  if (!Number.isInteger(oldQuantity) || !Number.isInteger(newQuantity) || oldQuantity < 0 || newQuantity < 0) throw new RangeError('quantities must be non-negative integers');
  if (newQuantity === oldQuantity) return { kind: 'unchanged', soldQuantity: 0, oldQuantity, newQuantity };
  if (newQuantity > oldQuantity) return { kind: 'increased', soldQuantity: 0, oldQuantity, newQuantity };
  return { kind: newQuantity === 0 ? 'sold_out' : 'decreased', soldQuantity: oldQuantity - newQuantity, oldQuantity, newQuantity };
}

export async function makeTransitionKey(listingId: number | string, stateVersion: number, oldQuantity: number, newQuantity: number, reason: string): Promise<string> {
  const value = `${listingId}:${stateVersion}:${oldQuantity}:${newQuantity}:${reason}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
