/**
 * Normalises a Kenyan mobile number to the 12-digit form Daraja expects:
 * 2547XXXXXXXX (Safaricom 07xx) or 2541XXXXXXXX (01xx).
 *
 * Accepts the common ways people write it: 0712345678, 712345678,
 * 254712345678, +254 712 345 678, (0712) 345-678. Returns undefined for
 * anything else, including landlines and non-Kenyan numbers.
 */
export const normalizePhone = (input: string): string | undefined => {
  const compact = input.trim().replace(/[\s().-]/g, "");
  const match = /^(?:\+?254|0)?([71]\d{8})$/.exec(compact);
  return match ? `254${match[1]}` : undefined;
};
