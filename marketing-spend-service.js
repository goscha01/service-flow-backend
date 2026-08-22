/**
 * Marketing Spend Module (Loosely Coupled)
 *
 * Mount: app.use('/api/marketing-spend', require('./marketing-spend-service')(supabase, logger))
 * Remove: delete this file + mount line = zero breakage
 *
 * Owns CRUD for the marketing_spend table (mig 082). Analytics reads via
 * lib/marketing-spend-aggregation.js — never queries this router.
 *
 * Money model:
 *   • All amounts in cents (integer). Client passes cents; server never
 *     converts to/from float dollars in this module.
 *   • Boundary conversions (LB leadPriceCents → SF opportunity_cost in
 *     dollars) live at the ingestion boundary — see leadbridge-service.js
 *     and lib/marketing-spend-aggregation.js:derivedTtSpendCents.
 *
 * Manual override semantics:
 *   • POST/PUT with manual body creates row with is_manual_override=true
 *     and reported_amount_cents=null (unless upstream_amount_cents given).
 *   • PATCH amount_cents flips is_manual_override=true; reported_amount_cents
 *     is preserved so upstream re-syncs can update it.
 *   • DELETE /:id/override resets amount_cents := reported_amount_cents
 *     and clears the override flag. If reported is null (pure manual row),
 *     the whole row is deleted.
 *
 * Upstream sync (materializer / LB pull) does NOT use this router — it
 * uses lib/marketing-spend-upsert.js which respects the override flag.
 */

const express = require('express')
const jwt = require('jsonwebtoken')

const VALID_SOURCES = ['thumbtack', 'yelp', 'google_ads', 'meta_ads', 'google_lsa', 'other']
const VALID_SOURCE_TYPES = ['leadbridge', 'api', 'scrape', 'manual', 'derived_from_opportunities']

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'No token provided' })
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key')
    next()
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' })
  }
}

// Normalize an incoming ISO/YYYY-MM/YYYY-MM-DD to month boundaries.
// Accepts YYYY-MM (treated as first-of-month) and YYYY-MM-DD (any day →
// snapped to first-of-month). Returns { start: 'YYYY-MM-01', end: last day of month }.
function monthBoundaries(input) {
  if (!input) return null
  const raw = String(input)
  const parts = raw.split('-')
  if (parts.length < 2) return null
  const y = parseInt(parts[0], 10)
  const m = parseInt(parts[1], 10)
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null
  const start = new Date(Date.UTC(y, m - 1, 1))
  const end = new Date(Date.UTC(y, m, 0))
  const pad = (n) => String(n).padStart(2, '0')
  return {
    start: `${y}-${pad(m)}-01`,
    end: `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}`,
  }
}

function validateUpsertPayload(body) {
  const errors = []
  if (!body.source || !VALID_SOURCES.includes(body.source)) {
    errors.push(`source must be one of: ${VALID_SOURCES.join(', ')}`)
  }
  if (!body.period) errors.push('period is required (YYYY-MM or YYYY-MM-DD)')
  const amt = Number(body.amount_cents)
  if (!Number.isFinite(amt) || amt < 0 || !Number.isInteger(amt)) {
    errors.push('amount_cents must be a non-negative integer (cents)')
  }
  if (body.source_type && !VALID_SOURCE_TYPES.includes(body.source_type)) {
    errors.push(`source_type must be one of: ${VALID_SOURCE_TYPES.join(', ')}`)
  }
  return errors
}

module.exports = (supabase, logger) => {
  const router = express.Router()

  // ── List spend rows for a tenant, optionally filtered by date range/source
  //    Response: { spend: [{...row, amount_dollars, reported_amount_dollars, ...}] }
  router.get('/', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId
      const { startDate, endDate, source } = req.query

      let q = supabase
        .from('marketing_spend')
        .select('*')
        .eq('user_id', userId)
        .order('period_start', { ascending: false })

      if (source && VALID_SOURCES.includes(source)) q = q.eq('source', source)
      if (startDate) q = q.gte('period_start', startDate)
      if (endDate) q = q.lte('period_start', endDate)

      const { data, error } = await q
      if (error) throw error
      res.json({ spend: (data || []).map(hydrate) })
    } catch (e) {
      logger?.error?.('marketing-spend list failed', e)
      res.status(500).json({ error: 'Failed to load marketing spend' })
    }
  })

  // ── Upsert a manual entry.
  //    POST { source, period ('YYYY-MM'), amount_cents, external_account_id?, note? }
  //    Effect: sets is_manual_override=true, source_type='manual',
  //    reported_amount_cents untouched if row exists.
  router.post('/', authenticateToken, async (req, res) => {
    const errors = validateUpsertPayload(req.body)
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors })

    const bounds = monthBoundaries(req.body.period)
    if (!bounds) return res.status(400).json({ error: 'Invalid period' })

    const userId = req.user.userId
    const externalAccountId = req.body.external_account_id || null

    try {
      // Try locate existing row (same tenant, source, month, account).
      let findQ = supabase
        .from('marketing_spend')
        .select('*')
        .eq('user_id', userId)
        .eq('source', req.body.source)
        .eq('period_start', bounds.start)

      // Postgres treats NULL != NULL, so we need is('external_account_id', null) for the null case.
      if (externalAccountId === null) findQ = findQ.is('external_account_id', null)
      else findQ = findQ.eq('external_account_id', externalAccountId)

      const { data: existing } = await findQ.maybeSingle()

      if (existing) {
        // Update — pin amount to manual value, flip override, preserve reported.
        const { data, error } = await supabase
          .from('marketing_spend')
          .update({
            amount_cents: Math.round(req.body.amount_cents),
            is_manual_override: true,
            source_type: existing.source_type === 'manual' ? 'manual' : existing.source_type,
            metadata: mergeMeta(existing.metadata, { manual_note: req.body.note || null, edited_at: new Date().toISOString() }),
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id)
          .select()
          .single()
        if (error) throw error
        return res.json({ spend: hydrate(data), created: false })
      }

      // Insert — brand new manual entry.
      const { data, error } = await supabase
        .from('marketing_spend')
        .insert({
          user_id: userId,
          source: req.body.source,
          period_start: bounds.start,
          period_end: bounds.end,
          amount_cents: Math.round(req.body.amount_cents),
          reported_amount_cents: null,
          is_manual_override: true,
          source_type: 'manual',
          external_account_id: externalAccountId,
          external_campaign_id: req.body.external_campaign_id || null,
          metadata: req.body.note ? { manual_note: req.body.note } : null,
        })
        .select()
        .single()
      if (error) throw error
      res.status(201).json({ spend: hydrate(data), created: true })
    } catch (e) {
      logger?.error?.('marketing-spend upsert failed', e)
      res.status(500).json({ error: 'Failed to upsert marketing spend' })
    }
  })

  // ── PATCH: user adjusts amount_cents on an existing row. Flips override.
  router.patch('/:id', authenticateToken, async (req, res) => {
    const patch = { updated_at: new Date().toISOString() }
    if (req.body.amount_cents !== undefined) {
      const n = Number(req.body.amount_cents)
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        return res.status(400).json({ error: 'amount_cents must be a non-negative integer (cents)' })
      }
      patch.amount_cents = Math.round(n)
      patch.is_manual_override = true
    }
    if (req.body.external_campaign_id !== undefined) patch.external_campaign_id = req.body.external_campaign_id
    if (req.body.note !== undefined) {
      patch.metadata = { manual_note: req.body.note, edited_at: new Date().toISOString() }
    }

    try {
      const { data, error } = await supabase
        .from('marketing_spend')
        .update(patch)
        .eq('id', req.params.id)
        .eq('user_id', req.user.userId)
        .select()
        .single()
      if (error) throw error
      if (!data) return res.status(404).json({ error: 'Not found' })
      res.json({ spend: hydrate(data) })
    } catch (e) {
      logger?.error?.('marketing-spend patch failed', e)
      res.status(500).json({ error: 'Failed to update marketing spend' })
    }
  })

  // ── Reset override — return amount to reported_amount_cents.
  //    If reported is null (pure manual row), delete the whole row.
  router.delete('/:id/override', authenticateToken, async (req, res) => {
    try {
      const { data: existing } = await supabase
        .from('marketing_spend')
        .select('*')
        .eq('id', req.params.id)
        .eq('user_id', req.user.userId)
        .maybeSingle()

      if (!existing) return res.status(404).json({ error: 'Not found' })
      if (!existing.is_manual_override) return res.json({ spend: hydrate(existing), action: 'noop' })

      if (existing.reported_amount_cents == null) {
        // Pure manual row — resetting means removing.
        const { error } = await supabase
          .from('marketing_spend')
          .delete()
          .eq('id', existing.id)
          .eq('user_id', req.user.userId)
        if (error) throw error
        return res.json({ action: 'deleted' })
      }

      const { data, error } = await supabase
        .from('marketing_spend')
        .update({
          amount_cents: existing.reported_amount_cents,
          is_manual_override: false,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select()
        .single()
      if (error) throw error
      res.json({ spend: hydrate(data), action: 'reset' })
    } catch (e) {
      logger?.error?.('marketing-spend reset override failed', e)
      res.status(500).json({ error: 'Failed to reset override' })
    }
  })

  // ── Hard delete — for the "remove this manual row entirely" case.
  router.delete('/:id', authenticateToken, async (req, res) => {
    try {
      const { error } = await supabase
        .from('marketing_spend')
        .delete()
        .eq('id', req.params.id)
        .eq('user_id', req.user.userId)
      if (error) throw error
      res.json({ ok: true })
    } catch (e) {
      logger?.error?.('marketing-spend delete failed', e)
      res.status(500).json({ error: 'Failed to delete marketing spend' })
    }
  })

  return router
}

// ── Helpers ──────────────────────────────────────────────────────────

function hydrate(row) {
  if (!row) return row
  return {
    ...row,
    amount_dollars: row.amount_cents != null ? row.amount_cents / 100 : null,
    reported_amount_dollars: row.reported_amount_cents != null ? row.reported_amount_cents / 100 : null,
  }
}

function mergeMeta(existing, incoming) {
  const base = existing && typeof existing === 'object' ? existing : {}
  return { ...base, ...incoming }
}

module.exports.VALID_SOURCES = VALID_SOURCES
module.exports.VALID_SOURCE_TYPES = VALID_SOURCE_TYPES
module.exports.monthBoundaries = monthBoundaries
