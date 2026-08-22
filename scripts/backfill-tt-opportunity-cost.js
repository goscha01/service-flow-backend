'use strict';

// backfill-tt-opportunity-cost.js
//
// Historical Thumbtack lead-cost backfill.
//
// Pulls LB's /v1/leads?scope=all&platform=thumbtack and, for each SF
// opportunity linked via lb_external_request_id, populates:
//   • opportunity_cost   (dollars)    ← LB.leadPriceCents / 100
//   • budget_voided_at   (timestamp)  ← LB.budgetVoidedAt
//
// Hard rules (spec):
//   • Never estimate. If LB has no leadPriceCents, leave SF NULL.
//   • Never overwrite an existing NON-NULL opportunity_cost. This
//     preserves CSV-imported costs and any prior valid data.
//   • budget_voided_at is state — refresh (LB is authoritative).
//   • Idempotent — re-running is safe. All decisions are deterministic
//     against the current LB read.
//
// Output counters (per user):
//   eligible               — SF opportunities linked to a LB TT lead
//   updated                — opportunity_cost or budget_voided_at written
//   already_populated      — cost non-null, no-op (unless void flipped)
//   lb_cost_unavailable    — LB returned no leadPriceCents for this lead
//   unmatched              — SF opportunity has no matching LB lead
//   failed                 — DB error on write
//
// Usage:
//   # dry-run (default) — reports counters, no mutation:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... LEADBRIDGE_URL=... \
//     node scripts/backfill-tt-opportunity-cost.js --user 2
//
//   # apply — writes to DB:
//   node scripts/backfill-tt-opportunity-cost.js --user 2 --apply --confirm-apply
//
//   # narrow to a date range on the SF side (opportunities.created_at):
//   node scripts/backfill-tt-opportunity-cost.js --user 2 --since 2025-01-01 --until 2026-08-01
//
//   # after backfill, run the materializer (via the API or directly):
//   node -e "require('./services/tt-spend-materializer').materializeThumbtackSpend(...)"

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

const LB_BASE = process.env.LEADBRIDGE_URL || 'https://thumbtack-bridge-production.up.railway.app/api';

function parseArgs(argv) {
  const out = { apply: false, confirmApply: false, user: null, since: null, until: null, limit: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--confirm-apply') out.confirmApply = true;
    else if (a === '--user') out.user = argv[++i];
    else if (a === '--since') out.since = argv[++i];
    else if (a === '--until') out.until = argv[++i];
    else if (a === '--limit') out.limit = parseInt(argv[++i], 10);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.user) {
    console.error('Usage: --user <userId> [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--apply --confirm-apply]');
    process.exit(2);
  }
  const wetRun = args.apply && args.confirmApply;
  if (args.apply && !args.confirmApply) {
    console.error('Refusing to apply without --confirm-apply (safety gate).');
    process.exit(2);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
    process.exit(2);
  }
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`[tt-cost-backfill] user=${args.user} mode=${wetRun ? 'APPLY' : 'DRY-RUN'} range=${args.since || 'all'}..${args.until || 'now'}`);

  // 1. Resolve LB integration token for this SF user.
  const { data: settings } = await supabase
    .from('communication_settings')
    .select('leadbridge_integration_token')
    .eq('user_id', args.user)
    .maybeSingle();
  const lbToken = settings?.leadbridge_integration_token;
  if (!lbToken) {
    console.error(`[tt-cost-backfill] No LB integration token for user_id=${args.user}. Ensure the SF ↔ LB integration is connected.`);
    process.exit(3);
  }

  // 2. Load SF opportunities linked to a TT LB lead in the target range.
  let oppQ = supabase
    .from('opportunities')
    .select('id, opportunity_cost, budget_voided_at, lb_external_request_id, lb_channel, created_at, source')
    .eq('user_id', args.user)
    .not('lb_external_request_id', 'is', null);

  // Only Thumbtack — Yelp has no per-lead cost, so it's a waste of API calls.
  oppQ = oppQ.or('lb_channel.eq.thumbtack,source.ilike.%thumbtack%');
  if (args.since) oppQ = oppQ.gte('created_at', args.since);
  if (args.until) oppQ = oppQ.lte('created_at', `${args.until} 23:59:59`);
  if (args.limit) oppQ = oppQ.limit(args.limit);

  const { data: sfOpps, error: oppErr } = await oppQ;
  if (oppErr) throw oppErr;

  console.log(`[tt-cost-backfill] SF opportunities eligible for lookup: ${sfOpps.length}`);
  if (sfOpps.length === 0) {
    console.log('[tt-cost-backfill] Nothing to do.');
    return;
  }

  // 3. Pull LB Thumbtack leads (unified across accounts).
  const lbResp = await fetch(`${LB_BASE}/v1/leads?scope=all&platform=thumbtack`, {
    headers: { Authorization: `Bearer ${lbToken}` },
  });
  if (!lbResp.ok) {
    const body = await lbResp.text();
    console.error(`[tt-cost-backfill] LB /v1/leads failed: ${lbResp.status} ${body.slice(0, 200)}`);
    process.exit(4);
  }
  const lbJson = await lbResp.json();
  const lbLeads = lbJson.leads || [];
  console.log(`[tt-cost-backfill] LB returned ${lbLeads.length} Thumbtack leads`);

  // 4. Index LB leads by externalRequestId → { leadPriceCents, budgetVoidedAt }.
  const lbIndex = {};
  for (const l of lbLeads) {
    if (!l.externalRequestId) continue;
    lbIndex[String(l.externalRequestId)] = {
      leadPriceCents: l.leadPriceCents ?? null,
      budgetVoidedAt: l.budgetVoidedAt ?? null,
    };
  }

  // 5. Walk SF opps, compute proposed patches, count outcomes.
  const counters = {
    eligible: sfOpps.length,
    updated: 0,
    already_populated: 0,
    lb_cost_unavailable: 0,
    unmatched: 0,
    failed: 0,
  };
  const proposals = [];
  for (const opp of sfOpps) {
    const lbHit = lbIndex[String(opp.lb_external_request_id)];
    if (!lbHit) {
      counters.unmatched += 1;
      continue;
    }
    if (lbHit.leadPriceCents == null && lbHit.budgetVoidedAt == null) {
      counters.lb_cost_unavailable += 1;
      continue;
    }

    const patch = {};
    // FILL-ONLY for cost.
    if (opp.opportunity_cost == null && lbHit.leadPriceCents != null) {
      patch.opportunity_cost = Math.round(Number(lbHit.leadPriceCents)) / 100;
    }
    // REFRESH for void gate.
    const incomingVoid = lbHit.budgetVoidedAt ? new Date(lbHit.budgetVoidedAt).toISOString() : null;
    const existingVoid = opp.budget_voided_at ? new Date(opp.budget_voided_at).toISOString() : null;
    if (incomingVoid !== existingVoid) {
      patch.budget_voided_at = incomingVoid;
    }

    if (Object.keys(patch).length === 0) {
      if (opp.opportunity_cost != null) counters.already_populated += 1;
      else counters.lb_cost_unavailable += 1;
      continue;
    }
    proposals.push({ id: opp.id, patch });
  }

  console.log(`[tt-cost-backfill] Proposed patches: ${proposals.length}`);
  if (proposals.length > 0) {
    console.log(`[tt-cost-backfill] Sample: ${JSON.stringify(proposals.slice(0, 3), null, 2)}`);
  }

  if (!wetRun) {
    console.log('[tt-cost-backfill] DRY-RUN — no writes performed.');
    console.log(`[tt-cost-backfill] Counters: ${JSON.stringify(counters, null, 2)}`);
    console.log('[tt-cost-backfill] Re-run with --apply --confirm-apply to persist.');
    return;
  }

  // 6. Apply.
  for (const p of proposals) {
    const { error } = await supabase
      .from('opportunities')
      .update(p.patch)
      .eq('id', p.id)
      .eq('user_id', args.user);
    if (error) {
      console.error(`[tt-cost-backfill] Update failed id=${p.id}: ${error.message}`);
      counters.failed += 1;
    } else {
      counters.updated += 1;
    }
  }

  console.log(`[tt-cost-backfill] APPLY complete. Counters: ${JSON.stringify(counters, null, 2)}`);
  console.log('[tt-cost-backfill] Next step: POST /api/marketing-spend/materialize/thumbtack');
}

main().catch((e) => {
  console.error('[tt-cost-backfill] Fatal:', e);
  process.exit(1);
});
