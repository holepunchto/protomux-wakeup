const test = require('brittle')
const SecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const Wakeup = require('../index')

test('basic - onwakeup', (t) => {
  t.plan(2)

  const cap = Buffer.alloc(32).fill('stuffimcapableof')
  const w1 = new Wakeup()

  const w2 = new Wakeup(function onwakeup (id, mux) {
    t.is(mux.stream, s2)
    t.alike(id, crypto.discoveryKey(cap))
  })

  const s1 = new SecretStream(true)
  const s2 = new SecretStream(false)

  replicate(s1, s2)

  w1.addStream(s1)
  w2.addStream(s2)

  const s = w1.session(cap)
  s.active()
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

function create () {
  const w1 = new Wakeup()
  const w2 = new Wakeup()

  const s1 = new SecretStream(true)
  const s2 = new SecretStream(false)

  replicate(s1, s2)

  w1.addStream(s1)
  w2.addStream(s2)

  return [w1, w2]
}

function replicate (a, b) {
  a.rawStream.pipe(b.rawStream).pipe(a.rawStream)
}
