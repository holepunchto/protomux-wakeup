const test = require('brittle')
const SecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const promClient = require('prom-client')

const Wakeup = require('../index')

test('basic - onwakeup', (t) => {
  t.plan(2)

  const cap = Buffer.alloc(32).fill('stuffimcapableof')
  const w1 = new Wakeup()

  const w2 = new Wakeup(onwakeup)

  const s1 = new SecretStream(true)
  const s2 = new SecretStream(false)

  replicate(s1, s2)

  w1.addStream(s1)
  w2.addStream(s2)

  const s = w1.session(cap)
  s.active()

  function onwakeup(id, mux) {
    t.is(mux.stream, s2)
    t.alike(id, crypto.discoveryKey(cap))
  }
})

test('basic - session handler callbacks', async (t) => {
  t.plan(7)

  const cap = Buffer.alloc(32).fill('stuffimcapableof')
  const key = Buffer.alloc(32).fill('deadbeef')
  const length = 1337

  const [w1, w2] = create()

  const s1 = w1.session(cap, {
    onpeeradd: (peer) => {
      t.pass('onpeeradd called')
    },
    onannounce: (wakeup) => {
      t.alike(wakeup, [{ key, length }], 'received wakeups')
    }
  })

  w2.session(cap, {
    onpeerremove: () => {
      t.pass('onpeerremove called')
    },
    onpeeractive: () => {
      t.pass('onpeeractive called')
    },
    onpeerinactive: () => {
      t.pass('onpeerinactive called')
    },
    onlookup: (_, peer, session) => {
      t.pass('onlookup called')
      session.announce(peer, [{ key, length }])
    }
  })

  await new Promise((resolve) => setImmediate(resolve))

  s1.lookup(s1.peers[0])

  await new Promise((resolve) => setImmediate(resolve))

  s1.inactive()

  s1.active()

  s1.destroy()
})

function create() {
  const w1 = new Wakeup()
  const w2 = new Wakeup()

  const s1 = new SecretStream(true)
  const s2 = new SecretStream(false)

  replicate(s1, s2)

  w1.addStream(s1)
  w2.addStream(s2)

  return [w1, w2, s1, s2]
}

// the streams are connected before any session is made
async function createConnected(onwakeup) {
  const [w1, w2, s1, s2] = create()

  w2.onwakeup = onwakeup

  await s1.opened
  await s2.opened
  await new Promise((resolve) => setImmediate(resolve))

  return [w1, w2, s1, s2]
}

test('passive session does not open channels on existing muxers', async (t) => {
  t.plan(4)

  const cap = Buffer.alloc(32).fill('stuffimcapableof')

  const [w1, , s1] = await createConnected(() => t.fail('onwakeup should not be called'))

  t.is(w1.muxers.size, 1, 'muxer added before the session')

  const s = w1.session(cap, { active: false })

  t.absent(s.topic.isActive, 'topic is passive')
  t.absent(w1.hasStream(s1, cap), 'no channel opened for the stream')

  await new Promise((resolve) => setImmediate(resolve))

  t.is(w1.stats.peersAdded, 0, 'no peer added')
})

test('active session opens channels on existing muxers', async (t) => {
  t.plan(4)

  const cap = Buffer.alloc(32).fill('stuffimcapableof')

  const [w1, , s1] = await createConnected((id) => {
    t.alike(id, crypto.discoveryKey(cap), 'onwakeup called on the remote')
  })

  t.is(w1.muxers.size, 1, 'muxer added before the session')

  const s = w1.session(cap)

  t.ok(s.topic.isActive, 'topic is active')
  t.ok(w1.hasStream(s1, cap), 'channel opened for the stream')
})

test('passive session opens channels on existing muxers once it becomes active', async (t) => {
  t.plan(4)

  const cap = Buffer.alloc(32).fill('stuffimcapableof')

  const [w1, , s1] = await createConnected((id) => {
    t.alike(id, crypto.discoveryKey(cap), 'onwakeup called on the remote')
  })

  const s = w1.session(cap, { active: false })

  t.absent(w1.hasStream(s1, cap), 'no channel opened while passive')

  s.active()

  t.ok(s.topic.isActive, 'topic is active')
  t.ok(w1.hasStream(s1, cap), 'channel opened for the stream when activated')
})

test('passive session does not open a channel for a muxer added later', async (t) => {
  t.plan(2)

  const cap = Buffer.alloc(32).fill('stuffimcapableof')

  const w1 = new Wakeup()
  const w2 = new Wakeup(() => t.fail('onwakeup should not be called'))

  const s = w1.session(cap, { active: false })

  const s1 = new SecretStream(true)
  const s2 = new SecretStream(false)

  replicate(s1, s2)

  w1.addStream(s1)
  w2.addStream(s2)

  await s1.opened
  await new Promise((resolve) => setImmediate(resolve))

  t.is(w1.stats.peersAdded, 0, 'no peer added')
  t.absent(w1.hasStream(s1, cap), 'no channel opened for the stream')

  s.destroy()
})

test('passive session still answers a channel opened by the remote', async (t) => {
  t.plan(4)

  const cap = Buffer.alloc(32).fill('stuffimcapableof')

  const [w1, w2, s1] = await createConnected()

  w1.session(cap, {
    active: false,
    onpeeradd: () => t.pass('onpeeradd called on the passive side'),
    onpeeractive: () => t.pass('onpeeractive called on the passive side')
  })

  t.absent(w1.hasStream(s1, cap), 'no channel opened by the passive side')

  w2.session(cap)

  await new Promise((resolve) => setImmediate(resolve))

  t.ok(w1.hasStream(s1, cap), 'passive side has a peer for the stream')
})

test('stats', (t) => {
  t.plan(6)
  const cap = Buffer.alloc(32).fill('stuffimcapableof')
  const w1 = new Wakeup()

  const w2 = new Wakeup(function onwakeup() {
    t.alike(w1.stats, {
      sessionsOpened: 1,
      sessionsClosed: 0,
      topicsAdded: 1,
      topicsGcd: 0,
      peersAdded: 1,
      peersRemoved: 0,
      wireAnnounce: { rx: 0, tx: 0 },
      wireLookup: { rx: 0, tx: 0 },
      wireInfo: { rx: 0, tx: 0 }
    })

    s.broadcastLookup()
    t.is(w1.stats.wireLookup.tx, 1)

    // Unsure if it's guaranteed where the peer is, so we just consider both
    const peer = [...s.topic.peers, ...s.topic.pendingPeers][0]
    s.announce(peer, [])
    t.is(w1.stats.wireAnnounce.tx, 1)

    s.destroy()
    t.alike(w1.stats, {
      sessionsOpened: 1,
      sessionsClosed: 1,
      topicsAdded: 1,
      topicsGcd: 0,
      peersAdded: 1,
      peersRemoved: 0,
      wireAnnounce: { rx: 0, tx: 1 },
      wireLookup: { rx: 0, tx: 1 },
      wireInfo: { rx: 0, tx: 1 }
    })
    s.topic.teardown()
    t.alike(w1.stats, {
      sessionsOpened: 1,
      sessionsClosed: 1,
      topicsAdded: 1,
      topicsGcd: 1,
      peersAdded: 1,
      peersRemoved: 1,
      wireAnnounce: { rx: 0, tx: 1 },
      wireLookup: { rx: 0, tx: 1 },
      wireInfo: { rx: 0, tx: 1 }
    })
  })

  const s1 = new SecretStream(true)
  const s2 = new SecretStream(false)
  replicate(s1, s2)

  w1.addStream(s1)
  w2.addStream(s2)

  const s = w1.session(cap)
  s.active()

  t.alike(w1.stats, {
    sessionsOpened: 1,
    sessionsClosed: 0,
    topicsAdded: 1,
    topicsGcd: 0,
    peersAdded: 0,
    peersRemoved: 0,
    wireAnnounce: { rx: 0, tx: 0 },
    wireLookup: { rx: 0, tx: 0 },
    wireInfo: { rx: 0, tx: 0 }
  })
})

test('Prometheus metrics', async (t) => {
  const w1 = new Wakeup()
  w1.registerMetrics(promClient)
  t.teardown(() => {
    promClient.register.clear()
  })

  const metrics = await promClient.register.metrics()
  t.ok(metrics.includes('protomux_wakeup_sessions_opened 0'))
  t.ok(metrics.includes('protomux_wakeup_sessions_closed 0'))
  t.ok(metrics.includes('protomux_wakeup_topics_added 0'))
  t.ok(metrics.includes('protomux_wakeup_topics_gcd 0'))
  t.ok(metrics.includes('protomux_wakeup_peers_added 0'))
  t.ok(metrics.includes('protomux_wakeup_peers_removed 0'))
  t.ok(metrics.includes('protomux_wakeup_wire_announce_tx 0'))
  t.ok(metrics.includes('protomux_wakeup_wire_announce_rx 0'))
  t.ok(metrics.includes('protomux_wakeup_wire_info_rx 0'))
  t.ok(metrics.includes('protomux_wakeup_wire_info_tx 0'))
  t.ok(metrics.includes('protomux_wakeup_wire_lookup_rx 0'))
  t.ok(metrics.includes('protomux_wakeup_wire_lookup_tx 0'))
})

function replicate(a, b) {
  a.rawStream.pipe(b.rawStream).pipe(a.rawStream)
}
