'use client'

import { getAccessToken } from '@/lib/drive/auth'

/**
 * Uploading finished audio to Google Drive, straight from the browser.
 *
 * Everything here is resumable. A raw take is well over a gigabyte, and an
 * upload that size on a domestic connection will be interrupted; a plain POST
 * would mean starting again from zero. Resumable sessions let an interrupted
 * upload ask Drive how far it got and carry on from there.
 *
 * Nothing is ever deleted on the strength of an upload having "finished". The
 * file is read back from Drive and its size compared before anything local is
 * removed -- see verifyUpload below.
 */

const DRIVE = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'

// Drive requires resumable chunks to be a multiple of 256 KiB. 8 MiB is a good
// trade: few enough requests to be fast, small enough that losing one costs
// little on a phone connection.
const CHUNK = 8 * 1024 * 1024

export interface DriveFile {
  id: string
  name: string
  size?: string
  md5Checksum?: string
  webViewLink?: string
}

async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken(false).catch(() => getAccessToken(true))
  const response = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    let detail = ''
    try {
      const body = (await response.json()) as { error?: { message?: string } }
      detail = body.error?.message ?? ''
    } catch {
      /* some errors have no JSON body */
    }
    throw new Error(`Drive ${response.status}${detail ? `: ${detail}` : ''}`)
  }

  return response
}

/**
 * Finds a folder this app previously made, or creates it.
 *
 * The drive.file scope means the search can only ever see folders podstart
 * itself created, which is exactly the isolation we want: it cannot stumble
 * into an unrelated folder of yours that happens to share a name.
 */
export async function ensureFolder(name: string, parentId = 'root'): Promise<string> {
  const query = [
    "mimeType = 'application/vnd.google-apps.folder'",
    `name = '${name.replace(/'/g, "\\'")}'`,
    `'${parentId}' in parents`,
    'trashed = false',
  ].join(' and ')

  const found = await driveFetch(
    `${DRIVE}/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=1`,
  )
  const existing = (await found.json()) as { files?: DriveFile[] }
  if (existing.files?.[0]) return existing.files[0].id

  const created = await driveFetch(`${DRIVE}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  })
  return ((await created.json()) as DriveFile).id
}

export interface UploadProgress {
  uploadedBytes: number
  totalBytes: number
  fraction: number
}

/**
 * Resumable upload of one blob.
 *
 * Drive answers each chunk with 308 and a Range header saying how much it
 * actually stored, which is authoritative -- we advance from that rather than
 * from what we believe we sent, so a partially accepted chunk cannot corrupt
 * the file by leaving a gap.
 */
export async function uploadFile(
  blob: Blob,
  name: string,
  folderId: string,
  onProgress?: (progress: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<DriveFile> {
  const token = await getAccessToken(false).catch(() => getAccessToken(true))

  const start = await fetch(`${UPLOAD}?uploadType=resumable&fields=id,name,size,md5Checksum`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Upload-Content-Type': blob.type || 'application/octet-stream',
      'X-Upload-Content-Length': String(blob.size),
    },
    body: JSON.stringify({ name, parents: [folderId] }),
    signal,
  })

  if (!start.ok) throw new Error(`Drive would not start the upload (${start.status}).`)

  const session = start.headers.get('Location')
  if (!session) {
    throw new Error('Drive did not return an upload session. Check the browser is not blocking it.')
  }

  let offset = 0
  let attempts = 0

  while (offset < blob.size) {
    const end = Math.min(offset + CHUNK, blob.size)
    const chunk = blob.slice(offset, end)

    let response: Response
    try {
      response = await fetch(session, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${blob.size}` },
        body: chunk,
        signal,
      })
    } catch (error) {
      // A dropped connection is the normal case this design exists for. Ask
      // Drive where it got to and resume from there.
      if (signal?.aborted) throw error
      attempts += 1
      if (attempts > 8) throw new Error(`Upload failed after ${attempts} attempts.`)
      await new Promise((resolve) => setTimeout(resolve, Math.min(16000, 500 * 2 ** attempts)))
      offset = await resumeOffset(session, blob.size)
      continue
    }

    if (response.status === 308) {
      attempts = 0
      const range = response.headers.get('Range')
      // "bytes=0-8388607" means Drive holds through 8388607, so the next byte
      // is 8388608. No Range header at all means it kept nothing.
      offset = range ? Number(range.split('-')[1]) + 1 : offset
      onProgress?.({
        uploadedBytes: offset,
        totalBytes: blob.size,
        fraction: offset / blob.size,
      })
      continue
    }

    if (response.status === 200 || response.status === 201) {
      onProgress?.({ uploadedBytes: blob.size, totalBytes: blob.size, fraction: 1 })
      return (await response.json()) as DriveFile
    }

    if (response.status === 404) {
      throw new Error('The upload session expired. Start the archive again.')
    }

    if (response.status >= 500) {
      attempts += 1
      if (attempts > 8) throw new Error(`Drive kept failing (${response.status}).`)
      await new Promise((resolve) => setTimeout(resolve, Math.min(16000, 500 * 2 ** attempts)))
      offset = await resumeOffset(session, blob.size)
      continue
    }

    throw new Error(`Upload rejected by Drive (${response.status}).`)
  }

  throw new Error('The upload ended without Drive confirming the file.')
}

/** Asks Drive how many bytes of an interrupted session it actually holds. */
async function resumeOffset(session: string, total: number): Promise<number> {
  const probe = await fetch(session, {
    method: 'PUT',
    headers: { 'Content-Range': `bytes */${total}` },
  })
  if (probe.status === 200 || probe.status === 201) return total
  const range = probe.headers.get('Range')
  return range ? Number(range.split('-')[1]) + 1 : 0
}

/**
 * Reads the file back from Drive and checks it is really there, at the size we
 * sent. This is the gate every deletion has to pass: "the upload promise
 * resolved" is not evidence that a file exists, and local audio is the only
 * copy that cannot be regenerated.
 */
export async function verifyUpload(fileId: string, expectedBytes: number): Promise<boolean> {
  try {
    const response = await driveFetch(`${DRIVE}/files/${fileId}?fields=id,name,size,trashed`)
    const file = (await response.json()) as DriveFile & { trashed?: boolean }
    if (file.trashed) return false
    return Number(file.size ?? 0) === expectedBytes
  } catch {
    return false
  }
}

export async function deleteFile(fileId: string): Promise<void> {
  await driveFetch(`${DRIVE}/files/${fileId}`, { method: 'DELETE' })
}

/** How much room is left, so the UI can warn before an upload that cannot fit. */
export async function driveQuota(): Promise<{ usedBytes: number; totalBytes: number } | null> {
  try {
    const response = await driveFetch(`${DRIVE}/about?fields=storageQuota`)
    const data = (await response.json()) as {
      storageQuota?: { usage?: string; limit?: string }
    }
    const usage = Number(data.storageQuota?.usage ?? 0)
    const limit = Number(data.storageQuota?.limit ?? 0)
    if (!limit) return null
    return { usedBytes: usage, totalBytes: limit }
  } catch {
    return null
  }
}
