/**
 * Test fetcher — resolves the adapter's URLs (BASE_URL + 'data/…') to files in public/.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const PUBLIC_DIR = path.resolve(__dirname, '../../public')

export async function diskFetcher<T>(url: string): Promise<T | null> {
  const rel = url.replace(/^\/+/, '')
  try {
    const raw = await readFile(path.join(PUBLIC_DIR, rel), 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
