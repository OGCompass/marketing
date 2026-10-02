// Confirmed values are typed as raw text. Normalize only for submission and comparison.
export function parseValues(raw: string): string[] {
  return raw.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
}

export function badValues(a: { confirmedValues: string[] }): string {
  if (a.confirmedValues.length > 40) return `Too many values (${a.confirmedValues.length}); the limit is 40.`;
  const long = a.confirmedValues.find((v) => v.length > 120);
  return long ? `A value is ${long.length} characters; the limit is 120 per line.` : "";
}
