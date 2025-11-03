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
  const cap = Buffer.alloc(32).fill('stuffimcapableof')
  const key = Buffer.alloc(32).fill('deadbeef')
  const length = 1337

  const [w1, w2] = create()

  // Plan out expected handler calls
  const tPeerremove = t.test('onpeerremove')
  tPeerremove.plan(1)
  const tPeeractive = t.test('onpeeractive')
  tPeeractive.plan(2) // once for peeradd & once manually called
  const tPeerinactive = t.test('onpeerinactive')
  tPeerinactive.plan(2) // once for manually called & once for peerremove
  const tLookup = t.test('onlookup')
  tLookup.plan(1)

  const tPeeradd = t.test('onpeeradd')
  tPeeradd.plan(1)
  const tAnnounce = t.test('onannounce')
  tAnnounce.plan(1)

  const s1 = w1.session(cap, {
    onpeeradd: (peer) => tPeeradd.pass('called'),
    onannounce: (wakeup) => {
      tAnnounce.alike(wakeup, [{ key, length }], 'received wakeups')
    }
  })

  w2.session(cap, {
    onpeerremove: () => tPeerremove.pass('called'),
    onpeeractive: () => tPeeractive.pass('called'),
    onpeerinactive: () => tPeerinactive.pass('called'),
    onlookup: (_, peer, session) => {
      tLookup.pass('called')
      session.announce(peer, [{ key, length }])
    }
  })

  await new Promise((resolve) => setImmediate(resolve))

  s1.lookup(s1.peers[0])

  await new Promise((resolve) => setImmediate(resolve))

  s1.inactive()

  s1.active()

  w1.destroy()
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
