// Gemini's daily budget, one tally for every device and the server: the
// gemini_usage table and its two functions (docs/supabase_schema.sql). Used by
// classify, which stops at the cap, and gemini, which only counts.
//
// `sb` is a service-role client. The day is Google's quota day: the date in
// Pacific time, when the free tier's daily count resets (DST included).

/** Google's quota day at `now`, 'YYYY-MM-DD'. */
export function usageDay(now: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric',
                                            month: '2-digit', day: '2-digit' }).format(new Date(now));
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
