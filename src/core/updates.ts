import * as https from 'https'

interface MarketplaceVersion {
  version?: unknown
}

interface MarketplaceExtension {
  versions?: MarketplaceVersion[]
}

interface MarketplaceResult {
  extensions?: MarketplaceExtension[]
}

interface MarketplaceResponse {
  results?: MarketplaceResult[]
}

interface NpmDistTags {
  latest?: unknown
}

interface JsonRequestOptions {
  body?: string
  headers?: Record<string, string>
  method?: 'GET' | 'POST'
  timeoutMs?: number
  url: string
}

const DEFAULT_TIMEOUT_MS = 5000

function isNumericToken(value: string): boolean {
  return /^\d+$/.test(value)
}

function tokenizeVersion(version: string): string[] {
  const trimmed = String(version || '').trim().replace(/^v/i, '')
  if (!trimmed) return []
  return trimmed.split(/[._+\-]/).map((part) => part.trim()).filter(Boolean)
}

function compareNumericToken(left: string, right: string): number {
  const l = BigInt(left)
  const r = BigInt(right)
  if (l === r) return 0
  return l > r ? 1 : -1
}

export function compareVersions(a: string, b: string): number {
  const left = tokenizeVersion(a)
  const right = tokenizeVersion(b)
  const maxLen = Math.max(left.length, right.length)

  for (let index = 0; index < maxLen; index++) {
    const l = left[index]
    const r = right[index]

    if (l == null && r == null) return 0
    if (l == null) {
      return isNumericToken(r) ? -1 : 1
    }
    if (r == null) {
      return isNumericToken(l) ? 1 : -1
    }

    const lNumeric = isNumericToken(l)
    const rNumeric = isNumericToken(r)

    if (lNumeric && rNumeric) {
      const numericDiff = compareNumericToken(l, r)
      if (numericDiff !== 0) return numericDiff
      continue
    }

    if (lNumeric !== rNumeric) {
      return lNumeric ? 1 : -1
    }

    const stringDiff = l.localeCompare(r, undefined, { sensitivity: 'base' })
    if (stringDiff !== 0) return stringDiff > 0 ? 1 : -1
  }

  return 0
}

export function isRemoteNewer(local: string, remote: string): boolean {
  const localVersion = String(local || '').trim()
  const remoteVersion = String(remote || '').trim()
  if (!localVersion || !remoteVersion) return false
  return compareVersions(remoteVersion, localVersion) > 0
}

async function requestJson(options: JsonRequestOptions): Promise<unknown | undefined> {
  const method = options.method || 'GET'
  const body = options.body || ''
  const headers: Record<string, string> = {
    'User-Agent': 'kibitz-update-checker',
    ...(options.headers || {}),
  }
  if (method === 'POST' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }
  if (method === 'POST' && !headers['Content-Length']) {
    headers['Content-Length'] = String(Buffer.byteLength(body))
  }

  return new Promise((resolve) => {
    const request = https.request(options.url, { method, headers }, (response) => {
      if (!response || typeof response.statusCode !== 'number') {
        resolve(undefined)
        return
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume()
        resolve(undefined)
        return
      }

      let data = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        data += chunk
      })
      response.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch {
          resolve(undefined)
        }
      })
    })

    request.setTimeout(options.timeoutMs || DEFAULT_TIMEOUT_MS, () => {
      request.destroy(new Error('request timed out'))
      resolve(undefined)
    })

    request.on('error', () => {
      resolve(undefined)
    })

    if (method === 'POST') {
      request.write(body)
    }
    request.end()
  })
}

export function parseMarketplaceExtensionVersion(payload: unknown): string | undefined {
  const response = payload as MarketplaceResponse
  const versions = response?.results?.[0]?.extensions?.[0]?.versions
  if (!Array.isArray(versions) || versions.length === 0) return undefined
  for (const versionEntry of versions) {
    const value = String((versionEntry || {}).version || '').trim()
    if (value) return value
  }
  return undefined
}

export async function queryMarketplaceExtensionVersion(extensionId: string): Promise<string | undefined> {
  const safeId = String(extensionId || '').trim()
  if (!safeId || !safeId.includes('.')) return undefined

  const body = JSON.stringify({
    filters: [
      {
        criteria: [
          { filterType: 8, value: 'Microsoft.VisualStudio.Code' },
          { filterType: 7, value: safeId },
        ],
        pageNumber: 1,
        pageSize: 1,
        sortBy: 0,
        sortOrder: 0,
      },
    ],
    assetTypes: [],
    flags: 914,
  })

  const payload = await requestJson({
    url: 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery',
    method: 'POST',
    body,
    headers: {
      Accept: 'application/json;api-version=7.1-preview.1;excludeUrls=true',
      'Content-Type': 'application/json',
    },
  })

  return parseMarketplaceExtensionVersion(payload)
}

export function parseNpmLatestVersion(payload: unknown): string | undefined {
  const tags = payload as NpmDistTags
  const latest = String(tags?.latest || '').trim()
  return latest || undefined
}

export async function queryNpmLatestVersion(packageName: string): Promise<string | undefined> {
  const safePackageName = String(packageName || '').trim()
  if (!safePackageName) return undefined
  const encodedName = encodeURIComponent(safePackageName)
  const payload = await requestJson({
    url: `https://registry.npmjs.org/-/package/${encodedName}/dist-tags`,
    method: 'GET',
    headers: { Accept: 'application/json' },
  })
  return parseNpmLatestVersion(payload)
}
