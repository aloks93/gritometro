// Access code for the standalone studio app. Only its SHA-256 is shipped; any client-side
// check can be bypassed by someone determined, this just keeps casual users out.

const CODE_SHA256 = 'aabbdfd2a307d9c488f4ea9a1b6af39b5c1d86939795794a4ac234d1db3c3351'

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Spaces and dashes are ignored so "615-3996" also works */
export async function isValidStudioCode(input: string): Promise<boolean> {
  const code = input.replace(/[\s-]/g, '')
  if (!/^\d+$/.test(code)) return false
  return (await sha256Hex(code)) === CODE_SHA256
}
