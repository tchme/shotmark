const openDatabase = () => new Promise((resolve, reject) => {
  const request = indexedDB.open('kadr', 1)
  request.onupgradeneeded = () => {
    request.result.createObjectStore('snapshots').createIndex('created', 'created')
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

async function updateStore(action) {
  const database = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction('snapshots', 'readwrite')
      const request = action(transaction.objectStore('snapshots'))
      transaction.oncomplete = () => resolve(request?.result)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

export function saveSnapshot(id, snapshot) {
  return updateStore(store => {
    const expired = store.index('created').openCursor(IDBKeyRange.upperBound(Date.now() - 300_000))
    expired.onsuccess = () => {
      const cursor = expired.result
      if (!cursor) return
      cursor.delete()
      cursor.continue()
    }
    return store.put({ ...snapshot, created: Date.now() }, id)
  })
}

export function takeSnapshot(id) {
  return updateStore(store => {
    const request = store.get(id)
    store.delete(id)
    return request
  })
}
