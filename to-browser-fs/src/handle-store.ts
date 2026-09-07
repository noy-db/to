/**
 * Handle persistence — the IndexedDB round-trip every consumer of this
 * store otherwise writes by hand.
 *
 * A `FileSystemDirectoryHandle` is structured-cloneable, so it survives in
 * IndexedDB across reloads. What does *not* necessarily survive is the
 * permission on it: expect `access()` to report `'prompt'` after a browser
 * restart and reconnect from a user gesture.
 *
 * Deliberately not wired into `toBrowserFs()` — recall stays an explicit
 * step so the consumer controls when the permission check happens relative
 * to its own slow work.
 */

import type { DirectoryHandleLike } from './index.js'

const DB_NAME = 'noydb-to-browser-fs'
const STORE_NAME = 'handles'

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open()
  try {
    return await promisify(run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME)))
  } finally {
    db.close()
  }
}

/** Persist a directory handle so a later page load can pick it up again. */
export async function rememberDirectory(key: string, handle: DirectoryHandleLike): Promise<void> {
  await withStore('readwrite', store => store.put(handle, key))
}

/**
 * Recall a previously remembered handle, or null if there is none.
 *
 * The handle comes back usable but not necessarily permitted — check
 * `store.access()` and call `requestAccess()` from a user gesture.
 */
export async function recallDirectory(key: string): Promise<DirectoryHandleLike | null> {
  const handle = await withStore<DirectoryHandleLike | undefined>('readonly', store => store.get(key))
  return handle ?? null
}

/** Drop a remembered handle — the user picked a different folder, or signed out. */
export async function forgetDirectory(key: string): Promise<void> {
  await withStore('readwrite', store => store.delete(key))
}
