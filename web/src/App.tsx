import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, FormEvent, ReactNode } from 'react'
import { FunctionRegion } from '@supabase/supabase-js'
import type { Session, User } from '@supabase/supabase-js'
import { isConfigured, supabase } from './lib/supabase'

type Role = 'owner' | 'admin' | 'reviewer' | 'viewer'
type Org = { id: string; name: string; role: Role }
type CheckKey = 'registration' | 'tax' | 'bank' | 'sanctions' | 'address'
type CheckState = 'pending' | 'verified' | 'missing' | 'flagged'
type Check = {
  id: string; organization_id: string; supplier_id: string; check_key: CheckKey
  status: CheckState; evidence_note: string; evidence_source: string
  reviewed_by: string | null; reviewed_at: string | null; updated_at: string
}
type Supplier = {
  id: string; organization_id: string; legal_name: string; category: string
  country: string; registration_id: string; created_at: string; updated_at: string
  verification_checks: Check[]
}
type AuditEvent = {
  id: number; actor_id: string | null; entity_type: string; entity_id: string; related_supplier_id: string
  action: string; details: Record<string, string | boolean | null>; created_at: string
}
type Member = { user_id: string; role: Role; profile?: { id: string; full_name: string } }
type Invitation = { id: string; email: string; role: Role; status: string; created_at: string; expires_at: string }

const CHECKS: { key: CheckKey; label: string; weight: number; hint: string }[] = [
  { key: 'registration', label: 'Business registration', weight: 25, hint: 'Check the legal entity in the relevant official registry.' },
  { key: 'tax', label: 'Tax identity', weight: 20, hint: 'Record the authorized tax source and review date.' },
  { key: 'bank', label: 'Bank account ownership', weight: 25, hint: 'Confirm account ownership through an approved, independent process.' },
  { key: 'sanctions', label: 'Sanctions screening', weight: 20, hint: 'Name the screening provider, list coverage, and time checked.' },
  { key: 'address', label: 'Business address', weight: 10, hint: 'Compare the submitted address with an identified source.' },
]

const cls = (...values: (string | false | undefined)[]) => values.filter(Boolean).join(' ')
const date = (value?: string | null) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value)) : 'Not reviewed'
const timeAgo = (value: string) => {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000))
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return date(value)
}
const initials = (text: string) => text.trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase()
const displayName = (user: User) => user.user_metadata?.full_name?.trim() || user.email || 'Workspace member'
const explainAudit = (event: AuditEvent, suppliers: Supplier[]) => {
  const supplier = suppliers.find(item => item.id === event.related_supplier_id)
  const details = event.details || {}
  const changed = Object.entries(details).filter(([, value]) => value === true).map(([key]) => key.replace('_changed', '').replace('_', ' '))
  if (event.entity_type === 'supplier') {
    return event.action === 'created' ? `Added ${supplier?.legal_name || 'a supplier'} to the queue` :
      event.action === 'deleted' ? `Removed ${supplier?.legal_name || 'a supplier'}` :
      `Updated ${supplier?.legal_name || 'supplier details'}${changed.length ? ` · ${changed.join(', ')}` : ''}`
  }
  const check = CHECKS.find(item => item.key === details.check_key)
  const verb = event.action === 'created' ? 'Started' : event.action === 'deleted' ? 'Removed' : 'Updated'
  return `${verb} ${check?.label || 'a verification check'} for ${supplier?.legal_name || 'a supplier'}${details.new_status ? ` · ${details.new_status}` : ''}`
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    shield: <><path d="M12 3 20 7v5c0 5-3.4 8-8 9-4.6-1-8-4-8-9V7l8-4Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></>,
    suppliers: <><path d="M4 20v-1.5A3.5 3.5 0 0 1 7.5 15h9a3.5 3.5 0 0 1 3.5 3.5V20"/><circle cx="12" cy="7.5" r="4"/></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
    arrow: <path d="m9 18 6-6-6-6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    check: <><circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/></>,
    alert: <><path d="M12 3 2.8 19h18.4L12 3Z"/><path d="M12 9v4m0 3h.01"/></>,
    activity: <><path d="M4 19.5V4.5M4 19.5h16M7 15l4-4 3 2 5-6"/></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    logout: <><path d="M10 17l5-5-5-5M15 12H3"/><path d="M12 3h6a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3h-6"/></>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  }
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.shield}</svg>
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [recovering, setRecovering] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!supabase) { setAuthLoading(false); return }
    let alive = true
    supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!alive) return
      if (sessionError) setError(sessionError.message)
      setSession(data.session)
      setAuthLoading(false)
    })
    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession)
      setError('')
      if (event === 'PASSWORD_RECOVERY') setRecovering(true)
      if (event === 'SIGNED_OUT') { setRecovering(false); setNotice('') }
    })
    return () => { alive = false; listener.subscription.unsubscribe() }
  }, [])

  if (!isConfigured || !supabase) return <SetupScreen />
  if (authLoading) return <FullScreen message="Checking your secure session…" />
  if (recovering && session) return <PasswordReset onDone={() => setRecovering(false)} />
  if (!session) return <AuthScreen notice={notice} error={error} onNotice={setNotice} onError={setError} />
  return <OrganizationGate session={session} onSignOut={() => { if (supabase) void supabase.auth.signOut() }} />
}

function SetupScreen() {
  return <main className="auth-page"><div className="auth-card setup-card"><Brand /><div className="auth-copy"><span className="eyebrow">Deployment setup</span><h1>Connect your private workspace.</h1><p>This site needs its Supabase project URL and publishable key before anyone can sign in.</p></div><div className="callout"><Icon name="lock" /><div><strong>Use the publishable key only</strong><span>Never add a Supabase secret key or service role key to this frontend.</span></div></div><ol className="setup-steps"><li>Create the Supabase project in <b>South Asia (Mumbai)</b>.</li><li>Copy its Project URL and <b>publishable key</b>.</li><li>Put them in the hosting environment as <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code>, then rebuild.</li></ol><p className="fine-print">The checked-in <code>.env.example</code> documents the names. The real <code>.env</code> is ignored by Git.</p></div></main>
}

function FullScreen({ message }: { message: string }) {
  return <main className="auth-page"><div className="loading-card"><Brand /><div className="spinner" /><p>{message}</p></div></main>
}

function Brand() {
  return <div className="brand"><span className="brand-mark"><Icon name="shield" /></span><span>trustvendor<span className="brand-dot">.</span></span></div>
}

function AuthScreen({ notice, error, onNotice, onError }: { notice: string; error: string; onNotice: (text: string) => void; onError: (text: string) => void }) {
  const [mode, setMode] = useState<'signin' | 'signup' | 'forgot'>('signin')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!supabase) return
    setBusy(true); onError(''); onNotice('')
    const data = new FormData(event.currentTarget)
    const email = String(data.get('email') || '').trim().toLowerCase()
    const password = String(data.get('password') || '')
    const fullName = String(data.get('full_name') || '').trim()
    try {
      if (mode === 'signup') {
        const { data: result, error: authError } = await supabase.auth.signUp({
          email, password,
          options: { data: { full_name: fullName }, emailRedirectTo: window.location.origin },
        })
        if (authError) throw authError
        if (!result.session) { setSent(true); onNotice('Check your email to confirm your account, then return here to sign in.') }
        else onNotice('Account created. Set up your workspace to continue.')
      } else if (mode === 'forgot') {
        const { error: authError } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin })
        if (authError) throw authError
        setSent(true); onNotice('If that address has an account, a password reset link is on its way.')
      } else {
        const { error: authError } = await supabase.auth.signInWithPassword({ email, password })
        if (authError) throw authError
      }
    } catch (e) { onError(e instanceof Error ? e.message : 'Could not complete this request.') }
    finally { setBusy(false) }
  }
  const title = mode === 'signup' ? 'Create your account' : mode === 'forgot' ? 'Reset your password' : 'Welcome back'
  return <main className="auth-page"><section className="auth-card"><Brand /><div className="auth-copy"><span className="eyebrow">Supplier assurance workspace</span><h1>{title}</h1><p>{mode === 'signup' ? 'Start a private workspace for your procurement team.' : mode === 'forgot' ? 'We’ll email you a secure password reset link.' : 'Sign in to continue reviewing supplier evidence.'}</p></div>
    {notice && <div className="notice success" role="status">{notice}</div>}{error && <div className="notice danger" role="alert">{error}</div>}
    <form onSubmit={submit} className="form-stack">
      {mode === 'signup' && <Field label="Your name" name="full_name" autoComplete="name" required maxLength={100} placeholder="Name used in the audit trail" />}
      <Field label="Work email" name="email" type="email" autoComplete="email" required maxLength={320} placeholder="you@company.com" />
      {mode !== 'forgot' && <Field label="Password" name="password" type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required minLength={12} maxLength={128} placeholder="At least 12 characters" />}
      {mode === 'signin' && <button type="button" className="text-button align-right" onClick={() => { setMode('forgot'); setSent(false); onError(''); onNotice('') }}>Forgot password?</button>}
      <button className="button button-primary full-button" disabled={busy || sent}>{busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : mode === 'forgot' ? 'Send reset link' : 'Sign in'}</button>
    </form>
    <div className="auth-switch">{mode === 'signup' ? <>Already have an account? <button onClick={() => { setMode('signin'); setSent(false); onError(''); onNotice('') }}>Sign in</button></> : mode === 'forgot' ? <button onClick={() => { setMode('signin'); setSent(false); onError(''); onNotice('') }}>Back to sign in</button> : <>New to TrustVendor? <button onClick={() => { setMode('signup'); setSent(false); onError(''); onNotice('') }}>Create an account</button></>}</div>
    <p className="auth-legal">Review your organization’s privacy notice and terms before using this workspace. Never enter bank credentials or personal identity numbers in reviewer notes.</p>
  </section><div className="auth-side"><div className="auth-side-glow" /><div className="quote-mark">“</div><blockquote>Trust decisions should come with their evidence.</blockquote><p>Keep the source, the reviewer, and the reason close to every check.</p><div className="auth-side-foot"><span className="status-pulse" /> Private by default · explainable by design</div></div></main>
}

function PasswordReset({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!supabase) return; setBusy(true); setError(''); const form = new FormData(event.currentTarget); const password = String(form.get('password') || ''); if (password !== String(form.get('confirm') || '')) { setError('The passwords do not match.'); setBusy(false); return } const { error: e } = await supabase.auth.updateUser({ password }); if (e) setError(e.message); else setDone(true); setBusy(false) }
  return <main className="auth-page"><section className="auth-card"><Brand /><div className="auth-copy"><span className="eyebrow">Account security</span><h1>Choose a new password</h1><p>Use a unique passphrase with at least 12 characters.</p></div>{error && <div className="notice danger">{error}</div>}{done ? <><div className="notice success">Password updated. You can continue to your workspace.</div><button className="button button-primary full-button" onClick={onDone}>Continue</button></> : <form className="form-stack" onSubmit={submit}><Field label="New password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /><Field label="Confirm password" name="confirm" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /><button className="button button-primary full-button" disabled={busy}>{busy ? 'Saving…' : 'Update password'}</button></form>}</section><div className="auth-side"><div className="auth-side-glow" /><div className="quote-mark">✳</div><blockquote>Make secure access part of the workflow.</blockquote><p>Your session is protected and scoped to your workspaces.</p><div className="auth-side-foot"><Icon name="lock" /> Encrypted in transit · access controlled</div></div></main>
}

function Field({ label, name, type = 'text', placeholder, required = false, minLength, maxLength, autoComplete }: { label: string; name: string; type?: string; placeholder?: string; required?: boolean; minLength?: number; maxLength?: number; autoComplete?: string }) {
  return <label className="field"><span>{label}</span><input name={name} type={type} placeholder={placeholder} required={required} minLength={minLength} maxLength={maxLength} autoComplete={autoComplete} /></label>
}

function OrganizationGate({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const [orgs, setOrgs] = useState<Org[]>([])
  const [orgLoading, setOrgLoading] = useState(true)
  const [orgError, setOrgError] = useState('')
  const [activeId, setActiveId] = useState('')
  const [creating, setCreating] = useState(false)

  const loadOrgs = useCallback(async () => {
    if (!supabase) return
    const { data, error: e } = await supabase.rpc('list_my_organizations')
    if (e) { setOrgError(e.message); return }
    const list = (data || []) as Org[]
    setOrgs(list)
    setActiveId(current => list.some(org => org.id === current) ? current : list[0]?.id || '')
    setOrgError('')
  }, [])

  useEffect(() => { let alive = true; setOrgLoading(true); void (async () => { await loadOrgs(); if (alive) setOrgLoading(false) })(); return () => { alive = false } }, [loadOrgs, session.user.id])

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!supabase) return
    setCreating(true); setOrgError('')
    const form = new FormData(event.currentTarget)
    const workspaceName = String(form.get('workspace') || '').trim()
    const { data, error: e } = await supabase.rpc('create_organization', { p_name: workspaceName })
    if (e) setOrgError(e.message)
    else { await loadOrgs(); setActiveId(String(data)) }
    setCreating(false)
  }

  if (orgLoading) return <FullScreen message="Loading your workspaces…" />
  if (orgs.length === 0) return <main className="auth-page"><section className="auth-card"><Brand /><div className="auth-copy"><span className="eyebrow">Your first workspace</span><h1>Set up your team.</h1><p>Create the private workspace that will hold supplier records and review history.</p></div>{orgError && <div className="notice danger">{orgError}</div>}<form className="form-stack" onSubmit={createOrganization}><Field label="Workspace name" name="workspace" placeholder="e.g. Northstar Procurement" required minLength={2} maxLength={120} /><button className="button button-primary full-button" disabled={creating}>{creating ? 'Creating…' : 'Create workspace'}</button></form><button className="text-button signout" onClick={onSignOut}>Sign out</button></section><div className="auth-side"><div className="auth-side-glow" /><div className="quote-mark">◈</div><blockquote>Your evidence stays within your team’s workspace.</blockquote><p>Access is scoped by database policy, not hidden frontend filters.</p><div className="auth-side-foot"><Icon name="lock" /> Workspace isolation enforced by Postgres</div></div></main>
  return <WorkspaceShell session={session} organizations={orgs} activeOrgId={activeId} onOrgChange={setActiveId} onSignOut={onSignOut} />
}

function WorkspaceShell({ session, organizations, activeOrgId, onOrgChange, onSignOut }: { session: Session; organizations: Org[]; activeOrgId: string; onOrgChange: (id: string) => void; onSignOut: () => void }) {
  const org = organizations.find(item => item.id === activeOrgId) || organizations[0]
  return <Workspace key={org.id} session={session} org={org} organizations={organizations} onOrgChange={onOrgChange} onSignOut={onSignOut} />
}

function Workspace({ session, org, organizations, onOrgChange, onSignOut }: { session: Session; org: Org; organizations: Org[]; onOrgChange: (id: string) => void; onSignOut: () => void }) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [selectedSupplier, setSelectedSupplier] = useState<Supplier | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showTeam, setShowTeam] = useState(false)
  const [toast, setToast] = useState('')

  const notify = (text: string) => { setToast(text); window.setTimeout(() => setToast(''), 2800) }
  const canReview = org.role !== 'viewer'
  const canAdmin = org.role === 'owner' || org.role === 'admin'

  const loadData = useCallback(async () => {
    if (!supabase) return
    setLoading(true); setLoadError('')
    const [supplierResult, eventResult, memberResult] = await Promise.all([
      supabase.from('suppliers').select('id,organization_id,legal_name,category,country,registration_id,created_at,updated_at,verification_checks(id,organization_id,supplier_id,check_key,status,evidence_note,evidence_source,reviewed_by,reviewed_at,updated_at)').eq('organization_id', org.id).order('updated_at', { ascending: false }),
      supabase.from('audit_events').select('id,actor_id,entity_type,entity_id,related_supplier_id,action,details,created_at').eq('organization_id', org.id).order('created_at', { ascending: false }).limit(30),
      supabase.from('organization_members').select('user_id,role').eq('organization_id', org.id),
    ])
    const firstError = supplierResult.error || eventResult.error || memberResult.error
    if (firstError) { setLoadError(firstError.message); setLoading(false); return }
    const supplierData = (supplierResult.data || []) as unknown as Supplier[]
    const memberRows = (memberResult.data || []) as Member[]
    const memberIds = memberRows.map(item => item.user_id)
    let profiles: { id: string; full_name: string }[] = []
    if (memberIds.length) {
      const profileResult = await supabase.from('profiles').select('id,full_name').in('id', memberIds)
      if (!profileResult.error) profiles = profileResult.data || []
    }
    const profileMap = new Map(profiles.map(profile => [profile.id, profile]))
    setMembers(memberRows.map(member => ({ ...member, profile: profileMap.get(member.user_id) })))
    if (canAdmin) {
      const inviteResult = await supabase.from('organization_invitations').select('id,email,role,status,created_at,expires_at').eq('organization_id', org.id).order('created_at', { ascending: false }).limit(30)
      if (!inviteResult.error) setInvitations((inviteResult.data || []) as Invitation[])
    } else setInvitations([])
    setSuppliers(supplierData)
    setEvents((eventResult.data || []) as AuditEvent[])
    setLoading(false)
  }, [org.id, canAdmin])

  useEffect(() => { void loadData() }, [loadData])
  useEffect(() => { if (!selectedSupplier) return; const latest = suppliers.find(item => item.id === selectedSupplier.id); if (latest) setSelectedSupplier(latest) }, [suppliers])

  const visibleSuppliers = useMemo(() => suppliers.filter(supplier => {
    const text = `${supplier.legal_name} ${supplier.category} ${supplier.country} ${supplier.registration_id}`.toLowerCase()
    if (!text.includes(query.toLowerCase())) return false
    const state = supplierStatus(supplier)
    return statusFilter === 'all' || (statusFilter === 'review' && state === 'In review') || (statusFilter === 'attention' && state === 'Needs attention') || (statusFilter === 'verified' && state === 'Verified')
  }), [suppliers, query, statusFilter])
  const counts = useMemo(() => ({
    total: suppliers.length,
    review: suppliers.filter(item => supplierStatus(item) === 'In review').length,
    attention: suppliers.filter(item => supplierStatus(item) === 'Needs attention').length,
    verified: suppliers.filter(item => supplierStatus(item) === 'Verified').length,
    averageRisk: suppliers.length ? Math.round(suppliers.reduce((sum, item) => sum + risk(item).score, 0) / suppliers.length) : 0,
  }), [suppliers])
  const memberNames = useMemo(() => new Map(members.map(member => [member.user_id, member.profile?.full_name || (member.user_id === session.user.id ? displayName(session.user) : `Team member ${member.user_id.slice(0, 6)}`)])), [members, session.user])

  async function createSupplier(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!supabase) return
    const data = new FormData(event.currentTarget)
    const entry = { organization_id: org.id, legal_name: String(data.get('legal_name')).trim(), category: String(data.get('category')).trim(), country: String(data.get('country')).trim(), registration_id: String(data.get('registration_id')).trim() }
    const { error } = await supabase.from('suppliers').insert(entry)
    if (error) { notify(error.message); return }
    setShowCreate(false); notify('Supplier added. Verification checks are ready.'); await loadData()
  }

  async function inviteMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!supabase) return
    const data = new FormData(event.currentTarget)
    const email = String(data.get('email') || '').trim().toLowerCase()
    const full_name = String(data.get('full_name') || '').trim()
    const role = String(data.get('role') || 'reviewer')
    const form = event.currentTarget
    const { data: result, error } = await supabase.functions.invoke('invite-member', { body: { organization_id: org.id, email, full_name, role }, region: FunctionRegion.ApSouth1 })
    if (error) { notify(error.message); return }
    notify(result?.added ? 'Existing confirmed account added to the workspace.' : 'Invitation email sent.'); form.reset(); await loadData()
  }

  const recent = events.slice(0, 6)
  return <div className="app-shell">
    <aside className="sidebar">
      <Brand />
      <div className="workspace-label">WORKSPACE</div>
      <nav className="nav-list"><a className="nav-link active" href="#suppliers"><Icon name="suppliers" /><span>Suppliers</span><b>{counts.total}</b></a><a className="nav-link" href="#activity"><Icon name="activity" /><span>Activity</span></a>{canAdmin && <button className="nav-link nav-action" onClick={() => setShowTeam(true)}><Icon name="users" /><span>Team access</span></button>}</nav>
      <div className="sidebar-bottom"><div className="guide-card"><div className="guide-icon">✳</div><strong>Evidence first</strong><p>Record the source and date behind each check. A score is only as good as its evidence.</p><span>Review policy in the guide →</span></div><div className="user-card"><div className="avatar">{initials(displayName(session.user))}</div><div className="user-copy"><strong>{displayName(session.user)}</strong><span>{session.user.email}</span></div><button className="icon-button logout-button" title="Sign out" aria-label="Sign out" onClick={onSignOut}><Icon name="logout" /></button></div></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="breadcrumbs"><span>{org.name}</span><i>/</i><b>Supplier assurance</b></div><div className="topbar-actions">{organizations.length > 1 && <select aria-label="Workspace" className="org-select" value={org.id} onChange={e => onOrgChange(e.target.value)}>{organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}<button className="icon-button notification-button" title="Notifications" onClick={() => notify('No new notifications.')}><Icon name="bell" /><i /></button></div></header>
      <div className="page-content">
        <section className="page-heading"><div><span className="eyebrow">RISK, WITH RECEIPTS</span><h1>Supplier assurance</h1><p>Know who you’re doing business with, and why they’re cleared.</p></div><div className="heading-actions">{canAdmin && <button className="button button-secondary" onClick={() => setShowTeam(true)}><Icon name="users" />Invite team</button>}{canReview && <button className="button button-primary" onClick={() => setShowCreate(true)}><Icon name="plus" />Add supplier</button>}</div></section>
        {loadError && <div className="notice danger page-notice" role="alert">Couldn’t load workspace data: {loadError}. Check the Supabase migration and project configuration.</div>}
        <section className="metric-grid" aria-label="Supplier summary"><Metric label="Total suppliers" value={counts.total} caption="Records in this workspace" icon="suppliers"/><Metric label="In review" value={counts.review} caption="Checks still outstanding" icon="clock" tone="amber"/><Metric label="Need attention" value={counts.attention} caption="Flagged checks to resolve" icon="alert" tone="red"/><Metric label="Fully verified" value={counts.verified} caption="All five checks verified" icon="check" tone="green"/></section>
        <section className="dashboard-grid">
          <article className="panel supplier-panel"><div className="panel-heading"><div><h2>Supplier queue</h2><p>Review evidence and resolve open checks</p></div><select className="select-control" value={statusFilter} onChange={event => setStatusFilter(event.target.value)} aria-label="Filter suppliers"><option value="all">All suppliers</option><option value="review">In review</option><option value="attention">Needs attention</option><option value="verified">Verified</option></select></div>
            <div className="table-search"><label className="search-box"><Icon name="search" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search suppliers…" aria-label="Search suppliers" /></label><span>{visibleSuppliers.length} shown</span></div>
            <div className="table-wrap"><table><thead><tr><th>SUPPLIER</th><th>COUNTRY</th><th>OPEN POINTS</th><th>STATUS</th><th aria-label="Open supplier" /></tr></thead><tbody>
              {loading ? <tr><td colSpan={5} className="table-message">Loading workspace…</td></tr> : visibleSuppliers.length === 0 ? <tr><td colSpan={5} className="table-message"><strong>No suppliers found</strong><span>Change your search or add a supplier to begin.</span></td></tr> : visibleSuppliers.map(item => { const score = risk(item); const state = supplierStatus(item); return <tr key={item.id} onClick={() => setSelectedSupplier(item)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') setSelectedSupplier(item) }}><td><div className="supplier-cell"><span className="supplier-avatar">{initials(item.legal_name)}</span><div><strong>{item.legal_name}</strong><small>{item.category} · {item.registration_id}</small></div></div></td><td>{item.country}</td><td><div className="risk-cell"><span className="risk-track"><i className={cls(score.level.toLowerCase())} style={{ width: `${score.score}%` }} /></span><b>{score.score}</b><small>/100</small></div></td><td><StatusPill status={state} /></td><td><Icon name="arrow" /></td></tr> })}
            </tbody></table></div>
          </article>
          <div className="side-stack"><article className="panel portfolio-panel"><div className="panel-heading compact"><div><h2>Portfolio risk</h2><p>Open verification exposure</p></div></div><div className="portfolio-score"><div className="donut" style={{ '--risk': `${counts.averageRisk}%` } as CSSProperties}><div><b>{counts.averageRisk}</b><span>average</span></div></div><div><strong>{counts.attention ? 'Review flagged checks' : counts.averageRisk < 30 ? 'Low open exposure' : counts.averageRisk < 60 ? 'Moderate open exposure' : 'Elevated open exposure'}</strong><p>{counts.verified} of {counts.total} verified · {counts.attention} flagged</p></div></div><div className="legend"><span><i className="low"/>Low</span><span><i className="medium"/>Medium</span><span><i className="high"/>High / flagged</span></div><p className="disclaimer">These are checklist exposure points, not a probability of fraud or an independent certification.</p></article>
            <article className="panel activity-panel" id="activity"><div className="panel-heading compact"><div><h2>Recent activity</h2><p>Append-only review history</p></div></div>{recent.length ? <div className="activity-list">{recent.map(event => <div className="activity-item" key={event.id}><span className="activity-mark"><Icon name="check" /></span><div><strong>{explainAudit(event, suppliers)}</strong><p>{memberNames.get(event.actor_id || '') || 'System'} · {timeAgo(event.created_at)}</p></div></div>)}</div> : <div className="empty-activity">No supplier activity yet. New records and check updates appear here.</div>}</article>
          </div>
        </section>
        <p className="page-footnote">Verification status reflects the evidence entered by your team. TrustVendor does not independently certify suppliers.</p>
      </div>
    </main>
    {(selectedSupplier || showCreate || showTeam) && <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) { setSelectedSupplier(null); setShowCreate(false); setShowTeam(false) } }}><aside className="drawer" role="dialog" aria-modal="true">{selectedSupplier && <SupplierDrawer supplier={selectedSupplier} org={org} canReview={canReview} onClose={() => setSelectedSupplier(null)} onSaved={loadData} notify={notify} />}{showCreate && <CreateDrawer onClose={() => setShowCreate(false)} onSubmit={createSupplier} />}{showTeam && <TeamDrawer members={members} invitations={invitations} canAdmin={canAdmin} currentUserId={session.user.id} onClose={() => setShowTeam(false)} onInvite={inviteMember} />}</aside></div>}
    {toast && <div role="status" className="toast">{toast}</div>}
  </div>
}

function Metric({ label, value, caption, icon, tone }: { label: string; value: number; caption: string; icon: string; tone?: string }) {
  return <article className="metric-card"><div className="metric-top"><span>{label}</span><i className={cls('metric-icon', tone)}><Icon name={icon} /></i></div><b className="metric-value">{value}</b><span className="metric-caption">{caption}</span></article>
}

function risk(supplier: Supplier) {
  const byKey = new Map(supplier.verification_checks.map(check => [check.check_key, check.status]))
  const score = CHECKS.reduce((sum, check) => sum + (byKey.get(check.key) === 'verified' ? 0 : check.weight), 0)
  const flagged = supplier.verification_checks.some(check => check.status === 'flagged')
  const level = flagged || score >= 60 ? 'High' : score >= 30 ? 'Medium' : 'Low'
  const verified = supplier.verification_checks.filter(check => check.status === 'verified').length
  return { score, level, verified, flagged }
}
function supplierStatus(supplier: Supplier) {
  const result = risk(supplier)
  return result.flagged ? 'Needs attention' : result.verified === CHECKS.length ? 'Verified' : 'In review'
}
function StatusPill({ status }: { status: string }) {
  return <span className={cls('status-pill', status === 'Verified' ? 'verified' : status === 'Needs attention' ? 'attention' : 'review')}>{status}</span>
}

function CreateDrawer({ onClose, onSubmit }: { onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <><div className="drawer-header"><div><span className="eyebrow">NEW RECORD</span><h2>Add supplier</h2><p>Start a documented verification workflow.</p></div><button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="close" /></button></div><div className="drawer-content"><form className="form-stack" onSubmit={onSubmit}><Field label="Legal or trading name" name="legal_name" required maxLength={160} placeholder="Supplier name" /><div className="form-two"><Field label="Category" name="category" required maxLength={100} placeholder="Manufacturing"/><Field label="Country" name="country" required maxLength={100} placeholder="India"/></div><Field label="Registration or tax ID" name="registration_id" required maxLength={100} placeholder="Identifier provided by the supplier"/><div className="callout"><Icon name="lock"/><div><strong>Minimal data by default</strong><span>Do not put personal identity documents, bank credentials, or sensitive personal information in notes.</span></div></div><div className="drawer-buttons"><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="submit">Create supplier</button></div></form></div></>
}

function SupplierDrawer({ supplier, org, canReview, onClose, onSaved, notify }: { supplier: Supplier; org: Org; canReview: boolean; onClose: () => void; onSaved: () => Promise<void>; notify: (message: string) => void }) {
  const [drafts, setDrafts] = useState<Record<string, { status: CheckState; note: string; source: string }>>({})
  const [saving, setSaving] = useState('')
  const [saveError, setSaveError] = useState('')
  const score = risk(supplier)
  useEffect(() => setDrafts(Object.fromEntries(supplier.verification_checks.map(check => [check.id, { status: check.status, note: check.evidence_note, source: check.evidence_source }]))), [supplier.id, supplier.updated_at, supplier.verification_checks])
  function edit(id: string, field: 'status' | 'note' | 'source', value: string) { setDrafts(current => ({ ...current, [id]: { ...current[id], [field]: value } })) }
  async function save(check: Check) {
    if (!supabase || !canReview) return
    const value = drafts[check.id]; if (!value) return
    setSaving(check.id); setSaveError('')
    const { error } = await supabase.from('verification_checks').update({ status: value.status, evidence_note: value.note.trim(), evidence_source: value.source.trim() }).eq('organization_id', org.id).eq('id', check.id)
    setSaving('')
    if (error) { setSaveError(error.message); return }
    notify('Evidence record saved.'); await onSaved()
  }
  return <><div className="drawer-header"><div><span className="eyebrow">SUPPLIER PROFILE</span><h2>{supplier.legal_name}</h2><p>{supplier.category} · {supplier.country} · {supplier.registration_id}</p></div><button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="close" /></button></div><div className="drawer-content"><div className="drawer-summary"><div><span>Open exposure</span><strong>{score.score}<small>/100</small></strong></div><StatusPill status={supplierStatus(supplier)} /><p>Verified checks reduce open exposure by their listed points. A flagged item sets the overall level to High. These are workflow points, not an automated legitimacy finding.</p></div>{saveError && <div className="notice danger">{saveError}</div>}<section className="checklist"><div className="section-title"><div><h3>Verification checklist</h3><p>{score.verified} of {CHECKS.length} checks verified</p></div><span>Evidence required</span></div>{CHECKS.map(rule => { const check = supplier.verification_checks.find(item => item.check_key === rule.key); if (!check) return <div className="check-card" key={rule.key}><strong>{rule.label}</strong><div className="notice danger">Missing check record. Ask an administrator to apply the latest database migration.</div></div>; const value = drafts[check.id] || { status: check.status, note: check.evidence_note, source: check.evidence_source }; return <div className="check-card" key={rule.key}><div className="check-title-row"><div><strong>{rule.label}</strong><span>{rule.weight} exposure points</span></div><StatusPill status={value.status === 'verified' ? 'Verified' : value.status === 'flagged' ? 'Needs attention' : 'In review'} /></div><p className="check-hint">{rule.hint}</p><label className="field"><span>Review status</span><select disabled={!canReview || saving === check.id} value={value.status} onChange={event => edit(check.id, 'status', event.target.value)}><option value="pending">Pending</option><option value="verified">Verified</option><option value="missing">Missing evidence</option><option value="flagged">Flagged for follow-up</option></select></label><label className="field"><span>Evidence source</span><input disabled={!canReview || saving === check.id} value={value.source} maxLength={500} placeholder="Registry or provider name, record ID, and review date" onChange={event => edit(check.id, 'source', event.target.value)} /></label><label className="field"><span>Reviewer note</span><textarea disabled={!canReview || saving === check.id} value={value.note} maxLength={1500} rows={3} placeholder="What you checked and why you chose this status. Avoid personal or account secrets." onChange={event => edit(check.id, 'note', event.target.value)} /></label><div className="check-footer"><small>Last reviewed {date(check.reviewed_at)}{check.reviewed_by ? ` · by ${check.reviewed_by.slice(0, 8)}` : ''}</small>{canReview && <button className="button button-secondary small-button" disabled={saving === check.id} onClick={() => void save(check)}>{saving === check.id ? 'Saving…' : 'Save check'}</button>}</div></div>})}</section><section className="checklist audit-section"><div className="section-title"><div><h3>Audit trail</h3><p>Append-only history for this supplier</p></div></div><AuditTrail supplierId={supplier.id} orgId={org.id}/></section></div></>
}

function AuditTrail({ supplierId, orgId }: { supplierId: string; orgId: string }) {
  const [events, setEvents] = useState<AuditEvent[]>([])
  useEffect(() => { let alive = true; if (supabase) void supabase.from('audit_events').select('id,actor_id,entity_type,entity_id,related_supplier_id,action,details,created_at').eq('organization_id', orgId).eq('related_supplier_id', supplierId).order('created_at', { ascending: false }).limit(30).then(({ data }) => { if (alive) setEvents((data || []) as AuditEvent[]) }); return () => { alive = false } }, [supplierId, orgId])
  return events.length ? <div className="audit-list">{events.map(event => <div className="audit-row" key={event.id}><span>{event.action}</span><div><strong>{event.entity_type === 'supplier' ? 'Supplier record' : `${CHECKS.find(item => item.key === event.details.check_key)?.label || 'Verification check'}`}</strong><small>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(event.created_at))}</small></div></div>)}</div> : <p className="muted-copy">No changes recorded yet.</p>
}

function TeamDrawer({ members, invitations, canAdmin, currentUserId, onClose, onInvite }: { members: Member[]; invitations: Invitation[]; canAdmin: boolean; currentUserId: string; onClose: () => void; onInvite: (event: FormEvent<HTMLFormElement>) => void }) {
  return <><div className="drawer-header"><div><span className="eyebrow">ACCESS CONTROL</span><h2>Team access</h2><p>Manage who can view and review this workspace.</p></div><button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="close" /></button></div><div className="drawer-content"><section className="checklist"><div className="section-title"><div><h3>Workspace members</h3><p>{members.length} active member{members.length === 1 ? '' : 's'}</p></div></div>{members.map(member => <div className="member-row" key={member.user_id}><span className="avatar">{initials(member.profile?.full_name || 'TV')}</span><div><strong>{member.profile?.full_name || `Member ${member.user_id.slice(0, 8)}`}</strong><small>{member.user_id === currentUserId ? 'You' : `ID ${member.user_id.slice(0, 8)}`}</small></div><span className="role-pill">{member.role}</span></div>)}</section>{canAdmin && <section className="checklist"><div className="section-title"><div><h3>Invite a teammate</h3><p>Invitation links expire after one hour.</p></div></div><form className="form-stack" onSubmit={onInvite}><Field label="Full name" name="full_name" required maxLength={100} placeholder="Teammate’s name"/><Field label="Work email" name="email" type="email" required maxLength={320} placeholder="teammate@company.com"/><label className="field"><span>Workspace role</span><select name="role" defaultValue="reviewer"><option value="reviewer">Reviewer — edit supplier checks</option><option value="viewer">Viewer — read only</option><option value="admin">Admin — manage team access</option></select></label><button className="button button-primary full-button" type="submit">Send invitation</button></form></section>}<section className="checklist"><div className="section-title"><div><h3>Invitation history</h3><p>Most recent 30 invitations</p></div></div>{invitations.length ? invitations.map(invite => <div className="member-row" key={invite.id}><span className="avatar">{initials(invite.email)}</span><div><strong>{invite.email}</strong><small>Expires {date(invite.expires_at)}</small></div><span className={cls('status-pill', invite.status === 'accepted' ? 'verified' : 'review')}>{invite.status === 'accepted' ? 'Accepted' : invite.status === 'cancelled' ? 'Expired' : 'Pending'}</span></div>) : <p className="muted-copy">No invitations recorded.</p>}</section></div></>
}
