/**
 * Business Expenses Module (Loosely Coupled)
 *
 * Mount: app.use('/api/business-expenses', require('./business-expense-service')(supabase, logger))
 * Remove: delete this file + remove the mount line = zero breakage
 *
 * Non-job overhead: rent, insurance, SaaS, vehicles, fuel, marketing (non-LB),
 * supplies, utilities. One-off or recurring. Powers the Expenses tab on the
 * analytics page.
 *
 * Table: business_expenses (migration 081)
 *
 * NOTE: This module owns CRUD only. Aggregation into date-range totals lives
 * in the /api/analytics/expenses-summary endpoint (in server.js) so the
 * analytics page can compute everything in one round-trip.
 */

const express = require('express')
const jwt = require('jsonwebtoken')

const VALID_CADENCES = ['one_off', 'weekly', 'monthly', 'yearly']
const VALID_CATEGORIES = [
  'rent', 'insurance', 'software', 'vehicle', 'fuel',
  'marketing', 'supplies', 'utilities', 'phone', 'other',
]

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

function validatePayload(body, { partial = false } = {}) {
  const errors = []
  if (!partial || body.name !== undefined) {
    if (!body.name || String(body.name).trim().length === 0) errors.push('name is required')
  }
  if (!partial || body.amount !== undefined) {
    const n = parseFloat(body.amount)
    if (Number.isNaN(n) || n < 0) errors.push('amount must be a non-negative number')
  }
  if (body.cadence !== undefined && !VALID_CADENCES.includes(body.cadence)) {
    errors.push(`cadence must be one of: ${VALID_CADENCES.join(', ')}`)
  }
  if (body.category !== undefined && !VALID_CATEGORIES.includes(body.category)) {
    errors.push(`category must be one of: ${VALID_CATEGORIES.join(', ')}`)
  }
  if (!partial || body.start_date !== undefined) {
    if (!body.start_date) errors.push('start_date is required')
  }
  if (body.end_date && body.start_date && body.end_date < body.start_date) {
    errors.push('end_date must be on or after start_date')
  }
  return errors
}

module.exports = (supabase, logger) => {
  const router = express.Router()

  // GET /api/business-expenses — list all for tenant
  router.get('/', authenticateToken, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('business_expenses')
        .select('*')
        .eq('user_id', req.user.userId)
        .order('start_date', { ascending: false })
      if (error) throw error
      res.json({ expenses: data || [] })
    } catch (e) {
      logger?.error?.('business-expenses list failed', e)
      res.status(500).json({ error: 'Failed to load business expenses' })
    }
  })

  // POST /api/business-expenses — create
  router.post('/', authenticateToken, async (req, res) => {
    const errors = validatePayload(req.body)
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors })

    const row = {
      user_id: req.user.userId,
      name: String(req.body.name).trim(),
      amount: parseFloat(req.body.amount),
      category: req.body.category || 'other',
      cadence: req.body.cadence || 'one_off',
      start_date: req.body.start_date,
      end_date: req.body.end_date || null,
      note: req.body.note || null,
      is_active: req.body.is_active !== false,
    }

    try {
      const { data, error } = await supabase
        .from('business_expenses')
        .insert(row)
        .select()
        .single()
      if (error) throw error
      res.status(201).json({ expense: data })
    } catch (e) {
      logger?.error?.('business-expenses create failed', e)
      res.status(500).json({ error: 'Failed to create business expense' })
    }
  })

  // PATCH /api/business-expenses/:id — update
  router.patch('/:id', authenticateToken, async (req, res) => {
    const errors = validatePayload(req.body, { partial: true })
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors })

    const patch = { updated_at: new Date().toISOString() }
    for (const k of ['name', 'amount', 'category', 'cadence', 'start_date', 'end_date', 'note', 'is_active']) {
      if (req.body[k] !== undefined) patch[k] = k === 'amount' ? parseFloat(req.body[k]) : req.body[k]
    }
    if (typeof patch.name === 'string') patch.name = patch.name.trim()

    try {
      const { data, error } = await supabase
        .from('business_expenses')
        .update(patch)
        .eq('id', req.params.id)
        .eq('user_id', req.user.userId)
        .select()
        .single()
      if (error) throw error
      if (!data) return res.status(404).json({ error: 'Not found' })
      res.json({ expense: data })
    } catch (e) {
      logger?.error?.('business-expenses update failed', e)
      res.status(500).json({ error: 'Failed to update business expense' })
    }
  })

  // DELETE /api/business-expenses/:id
  router.delete('/:id', authenticateToken, async (req, res) => {
    try {
      const { error } = await supabase
        .from('business_expenses')
        .delete()
        .eq('id', req.params.id)
        .eq('user_id', req.user.userId)
      if (error) throw error
      res.json({ ok: true })
    } catch (e) {
      logger?.error?.('business-expenses delete failed', e)
      res.status(500).json({ error: 'Failed to delete business expense' })
    }
  })

  return router
}

/**
 * Occurrence math (exported for reuse by analytics summary endpoint):
 * For a given cadence + start/end + [range_start, range_end], returns the
 * number of times the charge fires inside the range.
 */
module.exports.occurrencesInRange = function occurrencesInRange(exp, rangeStart, rangeEnd) {
  if (!exp || !exp.is_active) return 0
  const start = new Date(exp.start_date)
  const end = exp.end_date ? new Date(exp.end_date) : null
  const rs = rangeStart instanceof Date ? rangeStart : new Date(rangeStart)
  const re = rangeEnd instanceof Date ? rangeEnd : new Date(rangeEnd)
  if (Number.isNaN(start.getTime()) || Number.isNaN(rs.getTime()) || Number.isNaN(re.getTime())) return 0

  const effectiveEnd = end && end < re ? end : re
  if (start > effectiveEnd) return 0

  switch (exp.cadence) {
    case 'one_off':
      return (start >= rs && start <= re) ? 1 : 0

    case 'weekly': {
      const firstFire = start >= rs ? start : nextWeekly(start, rs)
      return countStepped(firstFire, effectiveEnd, 7)
    }

    case 'monthly': {
      const firstFire = start >= rs ? start : nextMonthly(start, rs)
      return countMonthly(firstFire, effectiveEnd)
    }

    case 'yearly': {
      const firstFire = start >= rs ? start : nextYearly(start, rs)
      return countYearly(firstFire, effectiveEnd)
    }

    default:
      return 0
  }
}

function nextWeekly(start, from) {
  const msPerWeek = 7 * 24 * 60 * 60 * 1000
  const diff = from - start
  const weeks = Math.ceil(diff / msPerWeek)
  return new Date(start.getTime() + weeks * msPerWeek)
}

function countStepped(firstFire, end, stepDays) {
  if (firstFire > end) return 0
  const msStep = stepDays * 24 * 60 * 60 * 1000
  return Math.floor((end - firstFire) / msStep) + 1
}

function nextMonthly(start, from) {
  const d = new Date(start)
  while (d < from) d.setMonth(d.getMonth() + 1)
  return d
}

function countMonthly(firstFire, end) {
  if (firstFire > end) return 0
  let n = 0
  const d = new Date(firstFire)
  while (d <= end) { n++; d.setMonth(d.getMonth() + 1) }
  return n
}

function nextYearly(start, from) {
  const d = new Date(start)
  while (d < from) d.setFullYear(d.getFullYear() + 1)
  return d
}

function countYearly(firstFire, end) {
  if (firstFire > end) return 0
  let n = 0
  const d = new Date(firstFire)
  while (d <= end) { n++; d.setFullYear(d.getFullYear() + 1) }
  return n
}
