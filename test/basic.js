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

test('basic - gc after peer is inactive & the session is destroyed', async (t) => {
  const cap = Buffer.alloc(32).fill('stuffimcapableof')
  const key = Buffer.alloc(32).fill('deadbeef')
  const length = 1337

  const [w1, w2] = create()

  const tPeeradd = t.test('onpeeradd')
  tPeeradd.plan(1)
  const tPeerremove = t.test('onpeerremove')
  tPeerremove.plan(1)

  const s1 = w1.session(cap, {
    onpeeradd: (peer) => tPeeradd.pass('called')
  })

  const s2 = w2.session(cap, {
    onpeerremove: () => tPeerremove.pass('called'),
    onlookup: (_, peer, session) => {
      session.announce(peer, [{ key, length }])
    }
  })

  await new Promise((resolve) => setImmediate(resolve))

  s1.lookup(s1.peers[0])

  s2.inactive()

  // Only one peer needs to close the channel
  s1.destroy()
})

test('basic - last session destroyed gc\'s topic', async (t) => {
  const cap = Buffer.alloc(32).fill('stuffimcapableof')
  const key = Buffer.alloc(32).fill('deadbeef')
  const length = 1337

  const [w1, w2] = create()

  const tPeeradd = t.test('onpeeradd')
  tPeeradd.plan(1)
  const tPeerremove = t.test('onpeerremove')
  tPeerremove.plan(1)

  const s1 = w1.session(cap, {
    onpeeradd: (peer) => tPeeradd.pass('called')
  })

  w2.session(cap, {
    onpeerremove: () => tPeerremove.pass('called'),
    onlookup: (_, peer, session) => {
      session.announce(peer, [{ key, length }])
    }
  })

  await new Promise((resolve) => setImmediate(resolve))

  s1.lookup(s1.peers[0])

  await new Promise((resolve) => setImmediate(resolve))

  const topic = s1.topic
  s1.destroy()
  t.is(topic.sessions.length, 0, 'no more sessions')
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
