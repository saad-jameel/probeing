// Gemini's daily budget, one tally for every device and the server: the
// gemini_usage table and its two functions (docs/supabase_schema.sql). Used by
// classify, which stops at the cap, and gemini, which only counts.
//
// `sb` is a service-role client. The day is his counter day at his saved place.

import './day.js';

const Day = (globalThis as unknown as { ProBeingDay: {
  setPrayerPlace: (p: unknown) => { zone: string };
  zoneOffsetMin: (zone: string, ms: number, fallback: number) => number;
  counterDate: (t: number, offsetMin?: number) => string;
} }).ProBeingDay;

/** His counter day at `now`, 'YYYY-MM-DD'. Karachi when the settings cannot be read. */
export async function usageDay(sb: any, owner: string, now: number): Promise<string> {
  let row: Record<string, unknown> | null = null;
  try {
    const got = await sb.from('user_settings').select('*').eq('user_id', owner).limit(1);
    if (!got.error) row = (got.data || [])[0] || null;
  } catch (_e) { /* Karachi */ }
  const place = Day.setPrayerPlace(row ? { lat: row.lat, lng: row.lng, zone: row.time_zone,
                                           method: row.method, asr: row.asr_school } : null);
  const off = Day.zoneOffsetMin(place.zone, now, NaN);
  return Day.counterDate(now, isNaN(off) ? 300 : off);
}

/** Take one call: the new count, 0 when the day is spent, -1 when too soon
 *  after the last. Throws when the database cannot say. */
export async function takeCall(sb: any, owner: string, day: string,
                               cap: number | null, paceMs: number): Promise<number> {
  const r = await sb.rpc('gemini_usage_take', { p_user: owner, p_day: day, p_cap: cap, p_pace_ms: paceMs });
  if (r.error) throw new Error(r.error.message || 'gemini_usage_take failed');
  const n = Number(r.data);
  if (!isFinite(n)) throw new Error('gemini_usage_take answered ' + JSON.stringify(r.data));
  return n;
}

/** Google refused for the day: mark it spent. Best effort. */
export async function spendDay(sb: any, owner: string, day: string, cap: number): Promise<void> {
  try {
    await sb.rpc('gemini_usage_spend', { p_user: owner, p_day: day, p_cap: cap });
  } catch (_e) { /* the next refusal says it again */ }
}
