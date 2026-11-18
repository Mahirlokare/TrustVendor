import { createClient } from 'npm:@supabase/supabase-js@2.119.0'
import { corsHeaders } from 'npm:@supabase/supabase-js@2.119.0/cors'

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' })
  const length = Number(request.headers.get('content-length') || 0)
  if (length > 8_192) return json(413, { error: 'Request is too large' })

  const authorization = request.headers.get('Authorization')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const publishableKey = Deno.env.get('SUPABASE_PUBLISHABLE_KEY')
  const secretKey = Deno.env.get('SUPABASE_SECRET_KEY')
  const publicSiteUrl = Deno.env.get('PUBLIC_SITE_URL')
  if (!supabaseUrl || !publishableKey || !secretKey || !publicSiteUrl) {
    return json(503, { error: 'Invitation service is not configured' })
  }
  if (!authorization?.startsWith('Bearer ')) return json(401, { error: 'Sign in to invite a teammate' })
  const accessToken = authorization.slice('Bearer '.length).trim()
  if (!accessToken || accessToken.length > 4_096) return json(401, { error: 'Your session is invalid or expired' })

  let input: { organization_id?: unknown; email?: unknown; role?: unknown; full_name?: unknown }
  try { input = await request.json() } catch { return json(400, { error: 'Invalid JSON request' }) }
  const organizationId = typeof input.organization_id === 'string' ? input.organization_id : ''
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
  const fullName = typeof input.full_name === 'string' ? input.full_name.trim() : ''
  const role = input.role === 'admin' || input.role === 'viewer' ? input.role : input.role === 'reviewer' ? input.role : ''
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(organizationId)) {
    return json(400, { error: 'Choose a valid workspace' })
  }
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: 'Enter a valid email address' })
  if (fullName.length < 1 || fullName.length > 100) return json(400, { error: 'Enter a name of 1 to 100 characters' })
  if (!role) return json(400, { error: 'Choose reviewer, viewer, or admin access' })

  const callerClient = createClient(supabaseUrl, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: authorization } },
  })
  const { data: authData, error: authError } = await callerClient.auth.getUser(accessToken)
  if (authError || !authData.user) return json(401, { error: 'Your session is invalid or expired' })

  const serviceClient = createClient(supabaseUrl, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: membership, error: membershipError } = await callerClient
    .from('organization_members')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', authData.user.id)
    .maybeSingle()
  if (membershipError || !membership || !['owner', 'admin'].includes(membership.role)) {
    return json(403, { error: 'Only workspace owners and admins can invite teammates' })
  }

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { count, error: countError } = await serviceClient
    .from('organization_invitations')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .gte('created_at', since)
  if (countError) return json(503, { error: 'Could not check the workspace invitation limit' })
  if ((count || 0) >= 10) return json(429, { error: 'This workspace has reached the limit of 10 invitations per hour' })

  await serviceClient.from('organization_invitations')
    .update({ status: 'cancelled' })
    .eq('organization_id', organizationId)
    .eq('email', email)
    .eq('status', 'pending')
    .lt('expires_at', new Date().toISOString())

  const { data: invite, error: inviteRowError } = await serviceClient
    .from('organization_invitations')
    .insert({ organization_id: organizationId, email, role, invited_by: authData.user.id })
    .select('id')
    .single()
  if (inviteRowError) return json(409, { error: 'A pending invitation for this address may already exist' })

  const { error: emailError } = await serviceClient.auth.admin.inviteUserByEmail(email, {
    redirectTo: publicSiteUrl,
    data: { full_name: fullName },
  })
  if (emailError) {
    if (/already\s+(registered|exists)|already\s+been\s+registered/i.test(emailError.message)) {
      const { data: existingAdded, error: existingError } = await serviceClient
        .rpc('add_existing_org_member', { p_invitation_id: invite.id })
      if (!existingError && existingAdded === true) return json(202, { added: true })
    }
    await serviceClient.from('organization_invitations').delete().eq('id', invite.id)
    return json(409, { error: 'The invitation could not be sent. Check the email address and whether the account has confirmed its email.' })
  }
  return json(202, { sent: true })
})
