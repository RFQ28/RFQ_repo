import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/** OAuth landing point: swaps the code for a session cookie, then hands off. */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/rfqs'

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=callback`)
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    return NextResponse.redirect(`${origin}/login?error=callback`)
  }

  // Only relative paths, so a crafted `next` cannot bounce someone off-site.
  const target = next.startsWith('/') ? next : '/rfqs'
  return NextResponse.redirect(`${origin}${target}`)
}
