'use client'

import { deleteFile, ensureFolder, uploadFile, verifyUpload, type DriveFile } from '@/lib/drive/upload'
import { forgetSessionAudio } from '@/lib/store/db'

/**
 * Archive a take to Drive, then reclaim the space it was using.
 *
 * The order is the whole point, and it is not negotiable:
 *
 *   1. upload every file
 *   2. read every one of them BACK from Drive and check the size matches
 *   3. only if all of them pass, delete the copies held elsewhere
 *
 * A promise resolving is not evidence a file exists. Audio from a recording
 * session cannot be regenerated, so the cost of deleting too eagerly is losing
 * an episode, while the cost of deleting too cautiously is some wasted
 * storage. Those are not comparable, and the code is shaped accordingly: if a
 * single file fails to verify, nothing is deleted at all.
 */

export interface ArchiveItem {
  /** Filename as it should appear in Drive. */
  name: string
  blob: Blob
}

export interface ArchivedFile {
  name: string
  fileId: string
  bytes: number
  verified: boolean
}

export interface ArchiveProgress {
  stage: string
  /** Overall progress across every file, 0..1. */
  fraction: number
  currentFile: string
  fileIndex: number
  fileCount: number
}

export interface ArchiveResult {
  folderId: string
  folderName: string
  files: ArchivedFile[]
  allVerified: boolean
  totalBytes: number
  /** True only when the space was actually reclaimed afterwards. */
  freedSpace: boolean
  error?: string
}

/** podstart/<take folder>/… so an episode's files stay together. */
export async function archiveTake(
  takeName: string,
  items: ArchiveItem[],
  options: {
    onProgress?: (progress: ArchiveProgress) => void
    signal?: AbortSignal
  } = {},
): Promise<ArchiveResult> {
  const { onProgress, signal } = options

  if (items.length === 0) throw new Error('There is nothing to archive.')

  const totalBytes = items.reduce((sum, item) => sum + item.blob.size, 0)

  onProgress?.({
    stage: 'Opening the podstart folder in Drive',
    fraction: 0,
    currentFile: '',
    fileIndex: 0,
    fileCount: items.length,
  })

  const root = await ensureFolder('podstart')
  const folderName = safeFolderName(takeName)
  const folderId = await ensureFolder(folderName, root)

  const files: ArchivedFile[] = []
  let uploadedSoFar = 0

  for (const [index, item] of items.entries()) {
    const uploaded = await uploadFile(
      item.blob,
      item.name,
      folderId,
      (progress) => {
        onProgress?.({
          stage: 'Uploading',
          // Weighted by bytes, so a 600 MB stem does not look the same as a
          // 2 KB text file.
          fraction: (uploadedSoFar + progress.uploadedBytes) / totalBytes,
          currentFile: item.name,
          fileIndex: index,
          fileCount: items.length,
        })
      },
      signal,
    )

    uploadedSoFar += item.blob.size

    onProgress?.({
      stage: 'Checking it arrived',
      fraction: uploadedSoFar / totalBytes,
      currentFile: item.name,
      fileIndex: index,
      fileCount: items.length,
    })

    const verified = await verifyUpload(uploaded.id, item.blob.size)

    files.push({
      name: item.name,
      fileId: uploaded.id,
      bytes: item.blob.size,
      verified,
    })
  }

  const allVerified = files.length === items.length && files.every((file) => file.verified)

  return {
    folderId,
    folderName,
    files,
    allVerified,
    totalBytes,
    freedSpace: false,
  }
}

/**
 * Reclaims the space a take was using, in Supabase and on this device.
 *
 * Refuses outright unless every file verified. The guard is here rather than
 * in the caller so that there is no route to deleting audio that skips it.
 */
export async function freeSpaceAfterArchive(
  sessionId: string,
  archive: ArchiveResult,
  discardLocalCopy?: () => void,
): Promise<ArchiveResult> {
  if (!archive.allVerified) {
    return {
      ...archive,
      error:
        'Not every file could be confirmed in Drive, so nothing was deleted. ' +
        'The recordings are still where they were.',
    }
  }

  await forgetSessionAudio(sessionId)
  discardLocalCopy?.()

  return { ...archive, freedSpace: true }
}

/**
 * Removes a half-finished archive, for when an upload is cancelled partway.
 * Only ever touches files this run created.
 */
export async function rollbackArchive(archive: ArchiveResult): Promise<void> {
  for (const file of archive.files) {
    await deleteFile(file.fileId).catch(() => undefined)
  }
}

function safeFolderName(takeName: string): string {
  const cleaned = takeName.replace(/[\\/:*?"<>|]/g, '-').trim()
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'Untitled take'
}

export type { DriveFile }
