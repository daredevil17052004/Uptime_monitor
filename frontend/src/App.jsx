import { useState, useEffect, useCallback } from 'react'
import './index.css'

// In local dev: reads from frontend/.env  → http://localhost:3001/api
// In Docker:    injected as build arg    → /api  (nginx proxies to backend)
const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001/api'
const POLL_INTERVAL_MS = 15_000

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function timeAgo(dateString) {
  if (!dateString) return null
  const diff = Date.now() - new Date(dateString).getTime()
  const secs = Math.floor(diff / 1000)
  if (secs < 5)  return 'just now'
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return `${hours}h ago`
}

function formatErrorType(errorType) {
  if (!errorType) return null
  return errorType.replace(/_/g, ' ')
}

// ─────────────────────────────────────────────────────────────────────────────
// MonitorCard
// ─────────────────────────────────────────────────────────────────────────────
function MonitorCard({ monitor, onDelete, isDeleting }) {
  const { id, name, url, currentStatus, lastCheck, noOfConsecutiveFails } = monitor
  const isUp         = currentStatus
  const responseTime = lastCheck?.responseTime ?? null
  const errorType    = lastCheck?.errorType    ?? null
  const checkedAt    = lastCheck?.checkedAt    ?? null

  return (
    <article className={`monitor-card ${isUp ? 'status-up' : 'status-down'}`}>
      {/* Header: badge + name + delete */}
      <div className="card-header">
        <div className="card-title-group">
          <span className={`status-badge ${isUp ? 'badge-up' : 'badge-down'}`}>
            <span className="badge-dot" />
            {isUp ? 'UP' : 'DOWN'}
          </span>
          <span className="card-name" title={name}>{name}</span>
        </div>

        <button
          className="btn-delete"
          onClick={() => onDelete(id)}
          disabled={isDeleting}
          title="Delete monitor"
          aria-label={`Delete monitor ${name}`}
        >
          ✕
        </button>
      </div>

      {/* URL */}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="monitor-url"
        title={url}
      >
        {url}
      </a>

      {/* Stats */}
      <div className="card-stats">
        <div className="stat">
          <span className="stat-label">Response</span>
          <span className={`stat-value ${responseTime != null ? (isUp ? 'text-success' : 'text-danger') : ''}`}>
            {responseTime != null ? `${responseTime} ms` : '—'}
          </span>
        </div>

        <div className="stat">
          <span className="stat-label">Consec. Fails</span>
          <span className={`stat-value ${noOfConsecutiveFails > 0 ? 'text-danger' : ''}`}>
            {noOfConsecutiveFails}
          </span>
        </div>

        {errorType && (
          <div className="stat">
            <span className="stat-label">Error</span>
            <span className="stat-value text-danger">{formatErrorType(errorType)}</span>
          </div>
        )}
      </div>

      {/* Footer: last checked */}
      {checkedAt && (
        <div className="card-footer">
          {timeAgo(checkedAt)}
        </div>
      )}
    </article>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Skeleton loader — shows while first fetch is in-flight
// ─────────────────────────────────────────────────────────────────────────────
function SkeletonGrid() {
  return (
    <div className="skeleton-grid">
      {[1, 2, 3].map(i => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [monitors,      setMonitors]      = useState([])
  const [initialLoad,   setInitialLoad]   = useState(true)
  const [fetchError,    setFetchError]    = useState(null)

  const [name,          setName]          = useState('')
  const [url,           setUrl]           = useState('')
  const [submitting,    setSubmitting]    = useState(false)
  const [formError,     setFormError]     = useState('')

  const [deletingIds,   setDeletingIds]   = useState(new Set())

  // ── Fetch all monitors ────────────────────────────────────────────────────
  const fetchMonitors = useCallback(async () => {
    try {
      const res  = await fetch(`${API_BASE}/monitors`)
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const data = await res.json()
      setMonitors(data)
      setFetchError(null)
    } catch (err) {
      setFetchError('Cannot reach backend. Is the server running on port 3001?')
      console.error('[poll] fetch error:', err)
    } finally {
      setInitialLoad(false)
    }
  }, [])

  // ── Polling — 15-second interval, skip-if-page-hidden ────────────────────
  useEffect(() => {
    fetchMonitors()

    const interval = setInterval(() => {
      // Skip the poll when the tab is hidden to avoid wasting requests.
      if (document.visibilityState === 'hidden') return
      fetchMonitors()
    }, POLL_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [fetchMonitors])

  // ── Add monitor ───────────────────────────────────────────────────────────
  const handleSubmit = async (e) => {
    e.preventDefault()
    setFormError('')
    setSubmitting(true)

    try {
      const res  = await fetch(`${API_BASE}/monitors`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: name.trim(), url: url.trim() }),
      })
      const data = await res.json()

      if (!res.ok) {
        setFormError(data.error || 'Failed to create monitor.')
        return
      }

      // Optimistically prepend to list, avoids waiting for next poll.
      setMonitors(prev => [{ ...data, lastCheck: null }, ...prev])
      setName('')
      setUrl('')
    } catch {
      setFormError('Cannot reach backend. Is the server running on port 3001?')
    } finally {
      setSubmitting(false)
    }
  }

  // ── Delete monitor ────────────────────────────────────────────────────────
  const handleDelete = async (id) => {
    setDeletingIds(prev => new Set(prev).add(id))
    try {
      const res = await fetch(`${API_BASE}/monitors/${id}`, { method: 'DELETE' })
      if (res.ok || res.status === 404) {
        // Optimistic removal
        setMonitors(prev => prev.filter(m => m.id !== id))
      }
    } catch (err) {
      console.error('[delete] error:', err)
    } finally {
      setDeletingIds(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  // ── Derived stats for header ───────────────────────────────────────────────
  const upCount   = monitors.filter(m => m.currentStatus).length
  const downCount = monitors.length - upCount

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      {/* ── Header ── */}
      <header className="app-header">
        <div className="header-inner">
          <div className="logo">
            <span className="logo-pulse" aria-hidden="true" />
            <h1>Uptime Monitor</h1>
          </div>

          <div className="header-meta">
            {monitors.length > 0 && (
              <span className="monitor-count">
                {upCount} up · {downCount} down
              </span>
            )}
            <span className="poll-indicator" title="Polling every 15s">
              <span className="poll-dot" />
              live
            </span>
          </div>
        </div>
      </header>

      <main className="main-content">
        {/* ── Add Monitor Form ── */}
        <section className="form-section" aria-label="Add monitor">
          <div className="section-header">
            <h2 className="section-title">Add Monitor</h2>
          </div>

          <form onSubmit={handleSubmit} className="add-form" noValidate>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="monitor-name">Name</label>
                <input
                  id="monitor-name"
                  type="text"
                  placeholder="My API"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  required
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              <div className="form-group">
                <label htmlFor="monitor-url">URL</label>
                <input
                  id="monitor-url"
                  type="url"
                  placeholder="https://api.example.com"
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  required
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              <button
                id="btn-add-monitor"
                type="submit"
                className="btn-add"
                disabled={submitting}
              >
                {submitting ? 'Adding…' : '+ Add Monitor'}
              </button>
            </div>

            {formError && (
              <p className="form-error" role="alert">{formError}</p>
            )}
          </form>
        </section>

        {/* ── Monitor List ── */}
        <section className="monitors-section" aria-label="Monitors">
          <div className="section-header">
            <h2 className="section-title">Monitors</h2>
            {monitors.length > 0 && (
              <span className="section-badge">{monitors.length} total</span>
            )}
          </div>

          {fetchError && (
            <p className="form-error" role="alert">{fetchError}</p>
          )}

          {initialLoad ? (
            <SkeletonGrid />
          ) : monitors.length === 0 && !fetchError ? (
            <div className="empty-state">
              <span className="empty-icon">📡</span>
              <h3>No monitors yet</h3>
              <p>Add your first URL above to start tracking uptime.</p>
            </div>
          ) : (
            <div className="monitor-grid">
              {monitors.map(monitor => (
                <MonitorCard
                  key={monitor.id}
                  monitor={monitor}
                  onDelete={handleDelete}
                  isDeleting={deletingIds.has(monitor.id)}
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
