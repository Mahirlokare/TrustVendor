import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL?.trim()
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()

export const isConfigured = Boolean(
  url && publishableKey && !url.includes('YOUR_PROJECT_REF') && !publishableKey.includes('REPLACE_WITH'),
)

export const supabase = isConfigured
  ? createClient(url!, publishableKey!, {
      auth: {
        flowType: 'pkce',
        storage: window.sessionStorage,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null
