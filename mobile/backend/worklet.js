/* global BareKit */
require('bare-buffer/global')

const RPC = require('bare-rpc')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const os = require('bare-os')
const path = require('bare-path')
const fs = require('bare-fs')
const b4a = require('b4a')
const {
  CMD_PING,
  CMD_GET_PUBKEY,
  CMD_APPEND_ENTRY,
  CMD_GET_LENGTH,
  CMD_JOIN_SWARM,
} = require('./commands.js')

const { IPC } = BareKit

// ---- diagnostic log: every boot step is captured here and ----
// ---- shipped back to React Native via the PING reply so it ----
// ---- shows up in Metro instead of the silent native console ----
const bootLog = []
function diag(msg) {
  const line = `[worklet] ${msg}`
  bootLog.push(line)
  try { console.log(line) } catch {}
}

diag('boot: starting')
diag('boot: typeof Buffer = ' + typeof Buffer)
diag('boot: typeof BareKit = ' + typeof BareKit)

let storagePath = null
let store = null
let core = null
let swarm = null
let readyPromise = null
let swarmStarted = false
let bootError = null

function tryMkdir(p) {
  try {
    fs.mkdirSync(p, { recursive: true })
    const st = fs.statSync(p)
    diag('mkdir OK: ' + p + ' (isDir=' + st.isDirectory() + ')')
    return true
  } catch (err) {
    diag('mkdir FAIL: ' + p + ' err=' + err.code + ' msg=' + err.message)
    return false
  }
}

function pickStoragePath() {
  // iOS sandbox: only Documents/, Library/, tmp/ are writable under the container root.
  // Documents/ is iOS-blessed for user data and survives across launches and OS cleanup,
  // unlike tmp/ which iOS may prune between sessions.
  const candidates = []
  try { candidates.push(path.join(os.homedir(), 'Documents', 'safehaven-corestore')) } catch (e) { diag('homedir threw: ' + e.message) }
  try { candidates.push(path.join(os.homedir(), 'Library', 'safehaven-corestore')) } catch (e) { diag('library threw: ' + e.message) }
  try { candidates.push(path.join(os.tmpdir(), 'safehaven-corestore')) } catch (e) { diag('tmpdir threw: ' + e.message) }

  for (const p of candidates) {
    diag('candidate: ' + p)
    if (tryMkdir(p)) return p
  }
  return null
}

// Best-effort: remove any stale lock files from a previous worklet instance
// that didn't fully release its grip (common after hot reload, force-quit, or
// crash). Corestore/rocksdb drops a `LOCK` file under the storage dir; if it
// survives, the next boot fails with "File descriptor could not be locked".
function clearStaleLocks(dir) {
  const targets = ['LOCK', 'lockfile', 'rocksdb-LOCK']
  for (const name of targets) {
    const p = path.join(dir, name)
    try {
      fs.unlinkSync(p)
      diag('clearStaleLocks: removed ' + p)
    } catch (err) {
      // ENOENT is fine (no stale lock); other errors we just log.
      if (err.code && err.code !== 'ENOENT') {
        diag('clearStaleLocks: ' + p + ' err=' + err.code)
      }
    }
  }
}

async function tryInit(p) {
  diag('init: new Corestore at ' + p)
  store = new Corestore(p)
  await store.ready()
  diag('init: Corestore ready')
  core = store.get({ name: 'incident' })
  await core.ready()
  diag('init: core ready, key=' + b4a.toString(core.key, 'hex').slice(0, 16) + '…')
}

function init(p) {
  if (readyPromise) return readyPromise
  readyPromise = (async () => {
    try {
      await tryInit(p)
    } catch (err) {
      const msg = String(err.message || '')
      if (msg.includes('could not be locked') || msg.includes('Resource temporarily unavailable')) {
        diag('init: lock collision, clearing stale locks and retrying')
        store = null
        core = null
        clearStaleLocks(p)
        await tryInit(p)
      } else {
        throw err
      }
    }
  })()
  return readyPromise
}

async function startSwarm() {
  if (swarmStarted) return b4a.toString(core.discoveryKey, 'hex')
  await readyPromise

  swarm = new Hyperswarm()
  swarm.on('connection', (conn, info) => {
    diag('swarm: conn from ' + b4a.toString(info.publicKey, 'hex').slice(0, 8))
    store.replicate(conn)
  })

  const discovery = swarm.join(core.discoveryKey, { server: true, client: true })
  await discovery.flushed()
  swarmStarted = true

  const topicHex = b4a.toString(core.discoveryKey, 'hex')
  diag('swarm: joined topic ' + topicHex.slice(0, 16) + '…')
  return topicHex
}

// ---- boot ----
try {
  diag('boot: os.homedir() = ' + os.homedir())
} catch (e) {
  diag('boot: os.homedir() threw ' + e.message)
}
try {
  diag('boot: os.tmpdir() = ' + os.tmpdir())
} catch (e) {
  diag('boot: os.tmpdir() threw ' + e.message)
}

storagePath = pickStoragePath()
if (!storagePath) {
  bootError = 'no writable storage path'
  diag('boot: FAILED — ' + bootError)
} else {
  diag('boot: chosen storage = ' + storagePath)
  init(storagePath).catch((err) => {
    bootError = 'init: ' + err.code + ' ' + err.message
    diag('boot: init failed — ' + bootError)
  })
}

// ---- RPC ----
new RPC(IPC, async (req) => {
  switch (req.command) {
    case CMD_PING:
      // Always reply pong, but the FIRST line includes any boot diagnostics.
      try {
        const payload = JSON.stringify({ pong: true, bootError, log: bootLog.slice(-50) })
        req.reply(payload)
      } catch (e) {
        req.reply('ERR:' + e.message)
      }
      return

    case CMD_GET_PUBKEY:
      try {
        if (bootError) throw new Error('boot: ' + bootError)
        await readyPromise
        req.reply(b4a.toString(core.key, 'hex'))
      } catch (err) {
        req.reply('ERR:' + err.message)
      }
      return

    case CMD_APPEND_ENTRY:
      try {
        if (bootError) throw new Error('boot: ' + bootError)
        await readyPromise
        const json = b4a.toString(req.data)
        await core.append(b4a.from(json))
        req.reply(String(core.length - 1))
      } catch (err) {
        req.reply('ERR:' + err.message)
      }
      return

    case CMD_GET_LENGTH:
      try {
        if (bootError) throw new Error('boot: ' + bootError)
        await readyPromise
        req.reply(String(core.length))
      } catch (err) {
        req.reply('ERR:' + err.message)
      }
      return

    case CMD_JOIN_SWARM:
      try {
        if (bootError) throw new Error('boot: ' + bootError)
        const topicHex = await startSwarm()
        req.reply(topicHex)
      } catch (err) {
        req.reply('ERR:' + err.message)
      }
      return
  }
})

diag('boot: RPC handler installed')
