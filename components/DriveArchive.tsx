'use client'

import { useCallback, useRef, useState } from 'react'

import { Button, Card, Notice, Pill, Row, Spinner, Toggle } from '@/components/ui'
import { getAccessToken, isDriveConfigured, signOutOfDrive } from '@/lib/drive/auth'
import { driveQuota } from '@/lib/drive/upload'
import {
  archiveTake, freeSpaceAfterArchive, rollbackArchive,
  type ArchiveItem, type ArchiveProgress, type ArchiveResult,
} from '@/lib/drive/archive'
import { bytes } from '@/lib/util/format'

/**
 * Send a finished take to Google Drive, then free the space it was using.
 *
 * The deletion is presented as what it is: a separate, consequential step that
 * only becomes available once every file has been read back out of Drive. The
 * UI never offers to "upload and clean up" as one button, because that phrasing
 * hides which half failed when something goes wrong at 2 a.m. on upload six.
 */

export interface DriveArchiveProps {
  takeName: string
  /** Built lazily: a mix is hundreds of megabytes and should not exist until needed. */
  collectFiles(): Promise<ArchiveItem[]> | ArchiveItem[]
  sessionId: string
  onFreed?(): void
  discardLocalCopy?(): void
}

export function DriveArchive({
  takeName,
  collectFiles,
  sessionId,
  onFreed,
  discardLocalCopy,
}: DriveArchiveProps) {
  const [connected, setConnected] = useState(false)
  const [quota, setQuota] = useState<{ usedBytes: number; totalBytes: number } | null>(null)
  const [progress, setProgress] = useState<ArchiveProgress | null>(null)
  const [result, setResult] = useState<ArchiveResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [alsoFree, setAlsoFree] = useState(true)
  const [busy, setBusy] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const configured = isDriveConfigured()

  const connect = useCallback(async () => {
    setError(null)
    try {
      await getAccessToken(true)
      setConnected(true)
      setQuota(await driveQuota())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  const run = useCallback(async () => {
    setError(null)
    setBusy(true)
    setResult(null)

    const controller = new AbortController()
    abortRef.current = controller

    let archive: ArchiveResult | null = null
    try {
      const items = await collectFiles()

      if (quota) {
        const needed = items.reduce((sum, item) => sum + item.blob.size, 0)
        const free = quota.totalBytes - quota.usedBytes
        if (needed > free) {
          throw new Error(
            `This take is ${bytes(needed)} but your Drive has only ${bytes(free)} free. ` +
              'Clear some space, or download the files instead.',
          )
        }
      }

      archive = await archiveTake(takeName, items, {
        onProgress: setProgress,
        signal: controller.signal,
      })

      if (alsoFree && archive.allVerified) {
        setProgress({
          stage: 'Freeing the space',
          fraction: 1,
          currentFile: '',
          fileIndex: archive.files.length,
          fileCount: archive.files.length,
        })
        archive = await freeSpaceAfterArchive(sessionId, archive, discardLocalCopy)
        if (archive.freedSpace) onFreed?.()
      }

      setResult(archive)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(
        controller.signal.aborted
          ? 'Archive cancelled. Nothing was deleted.'
          : `${message} Nothing was deleted.`,
      )
      // A cancelled run leaves orphans in Drive; clean up only what we made.
      if (archive && controller.signal.aborted) await rollbackArchive(archive).catch(() => undefined)
    } finally {
      setBusy(false)
      setProgress(null)
      abortRef.current = null
    }
  }, [collectFiles, takeName, sessionId, alsoFree, quota, onFreed, discardLocalCopy])

  if (!configured) {
    return (
      <Card style={{ display: 'grid', gap: 10 }}>
        <h2 className="slate">Google Drive</h2>
        <p style={{ fontSize: 14, color: 'var(--label-secondary)', lineHeight: 1.5 }}>
          Not set up yet. Add a Google OAuth client ID as{' '}
          <code>NEXT_PUBLIC_GOOGLE_CLIENT_ID</code> — the README has the five-minute
          walkthrough. podstart only ever asks for the <code>drive.file</code> scope, which
          grants access to files it creates and nothing else in your Drive.
        </p>
      </Card>
    )
  }

  return (
    <Card style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <h2 className="slate">Google Drive</h2>
        {connected && <Pill tone="good">Connected</Pill>}
      </div>

      {error && <Notice tone="warn" onDismiss={() => setError(null)}>{error}</Notice>}

      {!connected ? (
        <>
          <p style={{ fontSize: 14, color: 'var(--label-secondary)', lineHeight: 1.5 }}>
            Sends this take’s files to a <strong>podstart</strong> folder in your Drive, then
            frees the space they were using here. podstart can only see files it created
            itself — the rest of your Drive is invisible to it.
          </p>
          <Button variant="primary" full onClick={() => void connect()}>
            Connect Google Drive
          </Button>
        </>
      ) : (
        <>
          {quota && (
            <Row
              label="Drive space"
              value={`${bytes(quota.totalBytes - quota.usedBytes)} free of ${bytes(quota.totalBytes)}`}
              tone={quota.usedBytes / quota.totalBytes > 0.9 ? 'warn' : 'default'}
            />
          )}

          <Toggle
            label="Free the space afterwards"
            description="Deletes the uploaded stems here and the local copy on this device — but only after every file has been read back out of Drive and confirmed."
            checked={alsoFree}
            onChange={setAlsoFree}
          />

          {busy && progress ? (
            <div style={{ display: 'grid', gap: 8 }}>
              <Spinner
                label={`${progress.stage}${progress.currentFile ? `: ${progress.currentFile}` : ''}`}
              />
              <progress value={progress.fraction} max={1} style={{ width: '100%' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--label-secondary)' }}>
                <span>
                  file {Math.min(progress.fileIndex + 1, progress.fileCount)} of {progress.fileCount}
                </span>
                <span className="mono">{Math.round(progress.fraction * 100)}%</span>
              </div>
              <Button onClick={() => abortRef.current?.abort()}>Cancel</Button>
            </div>
          ) : (
            <Button variant="primary" full onClick={() => void run()} disabled={busy}>
              {alsoFree ? 'Archive to Drive and free the space' : 'Archive to Drive'}
            </Button>
          )}

          {result && (
            <div style={{ display: 'grid', gap: 6 }}>
              {result.files.map((file) => (
                <Row
                  key={file.fileId}
                  label={file.name}
                  value={file.verified ? `${bytes(file.bytes)} ✓` : 'not confirmed'}
                  tone={file.verified ? 'good' : 'warn'}
                />
              ))}

              <Notice tone={result.allVerified ? 'good' : 'warn'}>
                {result.error
                  ? result.error
                  : result.freedSpace
                    ? `All ${result.files.length} files confirmed in Drive under “${result.folderName}”, and ${bytes(result.totalBytes)} has been freed here.`
                    : `All ${result.files.length} files are in Drive under “${result.folderName}”. Nothing was deleted.`}
              </Notice>

              <a
                href={`https://drive.google.com/drive/folders/${result.folderId}`}
                target="_blank"
                rel="noreferrer noopener"
                style={{ fontSize: 15 }}
              >
                Open the folder in Drive ↗
              </a>
            </div>
          )}

          <button
            onClick={() => {
              signOutOfDrive()
              setConnected(false)
              setQuota(null)
            }}
            style={{ fontSize: 14, color: 'var(--label-secondary)', justifySelf: 'start' }}
          >
            Disconnect Drive
          </button>
        </>
      )}
    </Card>
  )
}
