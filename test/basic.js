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

  return [w1, w2]
}

test('stats', async (t) => {
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
})

function replicate(a, b) {
  a.rawStream.pipe(b.rawStream).pipe(a.rawStream)
}
