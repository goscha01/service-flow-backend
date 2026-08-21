#!/usr/bin/env node
/**
 * Cancel non-recurring jobs stuck in an active status past their
 * scheduled_date. Cleans up bulk-import cruft that never got closed
 * out (e.g. Spotless workspace #2 had 34 rows dating back to 2025-03
 * still in `pending` / `scheduled` / `en-route` / `started`).
 *
 * Safety:
 *   - Dry-run by default. Pass `--apply` to actually write.
 *   - Scoped to a single user_id (defaults to 2; override with
 *     `--user-id=<n>`) so we can never blast the wrong workspace.
 *   - Only touches non-recurring jobs (`is_recurring != true`) — the
 *     recurring TEMPLATES are load-bearing and get expanded to
 *     visits on read; cancelling one kills the whole future series.
 *   - Only touches statuses in the active/scheduled set. Never
 *     touches `completed` / `paid` / `cancelled` rows.
 *   - Uses updateJobStatus (source=system) so the ledger-cleanup
 *     guard runs (deletes any unbatched completion-derived entries
 *     even though these rows were never completed) AND
 *     job_status_history gets a row with a descriptive actor.
 *   - Cutoff defaults to 30 days pre-today; override with `--cutoff=YYYY-MM-DD`.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/cancel-stale-open-jobs.js            # dry-run
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/cancel-stale-open-jobs.js --apply    # write
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { updateJobStatus } = require('../services/job-status-service');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const USER_ID = (() => {
  const a = args.find((x) => x.startsWith('--user-id='));
  return a ? parseInt(a.split('=')[1], 10) : 2;
})();
const CUTOFF = (() => {
  const a = args.find((x) => x.startsWith('--cutoff='));
  if (a) return a.split('=')[1];
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
})();

const ACTIVE_STATUSES = [
  'pending', 'confirmed', 'in-progress', 'en-route',
  'started', 'late', 'rescheduled', 'scheduled',
];

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

function todayIso() { return new Date().toISOString().slice(0, 10); }

async function main() {
  if (!Number.isFinite(USER_ID)) {
    console.error('Invalid --user-id');
    process.exit(1);
  }

  console.log(`Stale-open-jobs cleanup — user_id=${USER_ID}, cutoff=${CUTOFF} (jobs scheduled BEFORE this date are stale)`);
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  console.log();

  const { data: rows, error } = await supabase
    .from('jobs')
    .select('id, status, scheduled_date, created_at, is_recurring, internal_notes, customer_id')
    .eq('user_id', USER_ID)
    .in('status', ACTIVE_STATUSES)
    .lt('scheduled_date', CUTOFF)
    .order('scheduled_date', { ascending: true })
    .limit(2000);
  if (error) throw error;

  // Exclude recurring templates — cancelling those kills the whole future series.
  const targets = (rows || []).filter((r) => r.is_recurring !== true);
  console.log(`Fetched ${rows?.length || 0} candidate rows; ${targets.length} non-recurring targets to cancel.`);
  if (targets.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  console.log('\nTargets:');
  console.log('id      status         sched_date    created_at');
  for (const r of targets) {
    console.log(
      String(r.id).padEnd(7),
      String(r.status).padEnd(14),
      String(r.scheduled_date || '').padEnd(13),
      String(r.created_at || '').slice(0, 19)
    );
  }

  if (!APPLY) {
    console.log(`\nDRY-RUN — pass --apply to cancel these ${targets.length} jobs.`);
    return;
  }

  console.log(`\nApplying — cancelling ${targets.length} jobs…`);
  const stamp = todayIso();
  let ok = 0, skipped = 0, failed = 0;
  const failures = [];

  for (const r of targets) {
    const marker = `[Auto-cancelled ${stamp} stale-open-job cleanup — was '${r.status}' scheduled ${r.scheduled_date}]`;
    const nextNotes = r.internal_notes
      ? `${r.internal_notes}\n${marker}`
      : marker;
    try {
      const result = await updateJobStatus(supabase, {
        jobId: r.id,
        newStatus: 'cancelled',
        source: 'system',
        userId: USER_ID,
        actor: { type: 'system', display_name: 'System (stale-open-job cleanup)' },
        extraFields: { internal_notes: nextNotes },
      });
      if (result.changed) ok++;
      else skipped++;
    } catch (e) {
      failed++;
      failures.push({ id: r.id, message: e.message });
    }
  }

  console.log(`\nDone — cancelled: ${ok}, skipped (no-op): ${skipped}, failed: ${failed}`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(' ', f.id, '→', f.message);
    process.exit(2);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
