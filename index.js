const crypto = require('hypercore-crypto')
const Protomux = require('protomux')
const b4a = require('b4a')
const schema = require('./spec/hyperschema')

const [
  NS_INITATOR,
  NS_RESPONDER
] = crypto.namespace('wakeup', 2)

const Handshake = schema.getEncoding('@wakeup/handshake')
const Announce = schema.getEncoding('@wakeup/announce')
const Lookup = schema.getEncoding('@wakeup/lookup')
const Info = schema.getEncoding('@wakeup/info')

module.exports = class WakeupSwarm {
  constructor (onwakeup = noop) {
    this.topics = new Map()
    this.topicsGC = new Set()
    this.muxers = new Set()

    this.onwakeup = onwakeup

    this._gcInterval = null
    this._gcBound = this._gc.bind(this)
  }

  session (capability, handlers = {}) {
    const id = handlers.discoveryKey || crypto.discoveryKey(capability)
    const active = handlers.active !== false
    const hex = b4a.toString(id, 'hex')

    let w = this.topics.get(hex)

    if (w) return w.addSession(handlers)

    w = new WakeupTopic(this, id, capability, active)

    this.topics.set(hex, w)

    for (const muxer of this.muxers) {
      w._onopen(muxer, true)
    }

    return w.addSession(handlers)
  }

  addStream (stream) {
    const noiseStream = stream.noiseStream || stream

    if (!noiseStream.connected) {
      noiseStream.once('open', this.addStream.bind(this, noiseStream))
      return
    }

    const muxer = getMuxer(noiseStream)
    muxer.pair({ protocol: 'wakeup' }, id => this._onpair(id, muxer))

    this.muxers.add(muxer)
    noiseStream.on('close', () => this.muxers.delete(muxer))

    for (const w of this.topics.values()) {
      if (!w.isActive) continue
      w._onopen(muxer, true)
    }
  }

  _onActive (w) {
    for (const m of this.muxers) {
      w._onopen(m, false)
    }
  }

  _addGC (topic) {
    if (topic.destroyed) return
    this.topicsGC.add(topic)
    if (this._gcInterval === null) {
      this._gcInterval = setInterval(this._gcBound, 2000)
    }
  }

  _removeGC (topic) {
    this.topicsGC.delete(topic)
    if (this.topicsGC.size === 0 && this._gcInterval) {
      clearInterval(this._gcInterval)
      this._gcInterval = null
    }
  }

  _gc () {
    const destroy = []
    for (const w of this.topicsGC) {
      w.idleTicks++
      if (w.idleTicks >= 5) destroy.push(w)
    }
    for (const w of destroy) w.teardown()
  }

  destroy () {
    if (this._gcInterval) clearInterval(this._gcInterval)
    this._gcInterval = null

    for (const w of this.topics.values()) w.teardown()
  }

  async _onpair (id, stream) {
    const hex = b4a.toString(id, 'hex')
    const w = this.topics.get(hex)
    if (!w) return this.onwakeup(id, stream)
    w._onopen(getMuxer(stream), false)
  }
}

class WakeupPeer {
  constructor (topic) {
    this.index = 0
    this.userData = null // for the user
    this.clock = 0 // for the user, v useful to reduce traffic
    this.pending = true
    this.removed = false
    this.topic = topic
    this.channel = null
    this.stream = null
    this.wireLookup = null
    this.wireAnnounce = null
    this.wireInfo = null
  }

  unlink (list) {
    // note that since we pop here we can iterate in reverse safely in case a peer is removed in the same tick
    const head = list.pop()
    if (head === this) return
    head.index = this.index
    list[head.index] = head
  }
}

class WakeupSession {
  constructor (topic, handlers) {
    this.index = 0
    this.topic = topic
    this.handlers = handlers
    this.isActive = handlers.active !== false
    this.destroyed = false
  }

  get peers () {
    return this.topic.peers
  }

  getPeer (stream) {
    return this.topic.peersByStream.get(stream) || null
  }

  broadcastLookup (req) {
    for (const peer of this.topic.pendingPeers) {
      this.lookup(peer, req)
    }
    for (const peer of this.topic.peers) {
      this.lookup(peer, req)
    }
  }

  lookupByStream (stream, req) {
    const peer = this.topic.peersByStream.get(stream)
    if (peer) this.lookup(peer, req)
  }

  lookup (peer, req) {
    peer.wireLookup.send(req || { hash: null })
  }

  announceByStream (stream, wakeup) {
    const peer = this.topic.peersByStream.get(stream)
    if (peer && !peer.pending) this.announce(peer, wakeup)
  }

  announce (peer, wakeup) {
    peer.wireAnnounce.send(wakeup)
  }

  active () {
    this.isActive = true
    this.topic._bumpActivity()
  }

  inactive () {
    this.isActive = false
    this.topic._bumpActivity()
  }

  destroy () {
    if (this.destroyed) return
    this.destroyed = true
    this.topic.removeSession(this)
  }
}

class WakeupTopic {
  constructor (state, id, capability, active) {
    this.state = state
    this.sessions = []
    this.id = id
    this.capability = capability
    this.peers = []
    this.pendingPeers = []
    this.peersByStream = new Map()
    this.activePeers = 0
    this.isActive = active
    this.idleTicks = 0
    this.gcing = false
    this.destroyed = false
  }

  addSession (handlers) {
    const session = new WakeupSession(this, handlers)
    session.index = this.sessions.length
    this.sessions.push(session)
    return session
  }

  removeSession (session) {
    if (this.sessions.length >= session.index) return
    if (this.sessions[session.index] !== session) return

    // same as with the peer, this allows us to iterate while removing if iterating backwards
    const head = this.sessions.pop()
    if (head !== session) {
      head.index = session.index
      this.sessions[head.index] = head
    }

    this._bumpActivity()
    this._checkGC()
  }

  _bumpActivity () {
    let isActive = false

    for (let i = this.sessions.length - 1; i >= 0; i--) {
      if (this.sessions[i].isActive) {
        isActive = true
        break
      }
    }

    if (isActive) this.active()
    else this.inactive()
  }

  active () {
    if (this.isActive) return
    this.idleTicks = 0
    this.isActive = true
    this._updateActive(true)
  }

  inactive () {
    if (!this.isActive) return
    this.isActive = false
    this._updateActive(false)
  }

  _updateActive (active) {
    const info = { active }

    for (const peer of this.pendingPeers) peer.wireInfo.send(info)
    for (const peer of this.peers) peer.wireInfo.send(info)

    this._checkGC()

    if (active) this.state._onActive(this)
  }

  teardown () {
    if (this.destroyed) return
    this.destroyed = true

    for (let i = this.peers.length - 1; i >= 0; i--) {
      this.peers[i].channel.close()
    }

    for (let i = this.pendingPeers.length - 1; i >= 0; i--) {
      this.pendingPeers[i].channel.close()
    }

    const hex = b4a.toString(this.id, 'hex')

    this.gcing = false
    this.state.topics.delete(hex)
    this.state._removeGC(this)
  }

  addStream (stream) {
    this._onopen(getMuxer(stream), false)
  }

  _proveCapabilityTo (stream) {
    return this._makeCapability(stream.isInitiator, stream.handshakeHash)
  }

  _makeCapability (isInitiator, handshakeHash) {
    return crypto.hash([isInitiator ? NS_INITATOR : NS_RESPONDER, this.capability, handshakeHash])
  }

  _addPeer (peer, open) {
    if (!b4a.equals(open.capability, this._makeCapability(!peer.stream.isInitiator, peer.stream.handshakeHash))) {
      peer.channel.close()
      return
    }

    if (peer.pending) {
      peer.unlink(this.pendingPeers)
    }

    peer.active = open.active
    peer.pending = false
    peer.index = this.peers.push(peer) - 1

    if (peer.active) {
      this.activePeers++
      this._checkGC()
    }

    for (let i = this.sessions.length - 1; i >= 0; i--) {
      const session = this.sessions[i]
      const handlers = session.handlers

      if (handlers.onpeeradd) handlers.onpeeradd(peer, session)
      if (peer.active && handlers.onpeeractive) handlers.onpeeractive(peer, session)
    }
  }

  _checkGC () {
    const shouldGC = this.activePeers === 0 && this.sessions.length === 0

    if (shouldGC) {
      if (!this.gcing) {
        this.gcing = true
        this.state._addGC(this)
      }
    } else {
      if (this.gcing) {
        this.gcing = false
        this.state._removeGC(this)
      }
    }
  }

  _removePeer (peer) {
    peer.removed = true
    this.peersByStream.delete(peer.stream)

    if (peer.pending) {
      peer.unlink(this.pendingPeers)
      return
    }

    const active = peer.active

    if (active) {
      peer.active = false
      this.activePeers--
      this._checkGC()
    }

    peer.unlink(this.peers)

    for (let i = this.sessions.length - 1; i >= 0; i--) {
      const session = this.sessions[i]
      const handlers = session.handlers

      if (active && handlers.onpeerinactive) handlers.onpeerinactive(peer, session)
      if (handlers.onpeerremove) handlers.onpeerremove(peer, session)
    }
  }

  _onannounce (wakeup, peer) {
    for (let i = this.sessions.length - 1; i >= 0; i--) {
      const session = this.sessions[i]
      const handlers = session.handlers

      if (handlers.onannounce) handlers.onannounce(wakeup, peer, session)
    }
  }

  _onlookup (req, peer) {
    for (let i = this.sessions.length - 1; i >= 0; i--) {
      const session = this.sessions[i]
      const handlers = session.handlers

      if (handlers.onlookup) handlers.onlookup(req, peer, session)
    }
  }

  _oninfo (info, peer) {
    if (info.active) {
      if (!peer.active) {
        peer.active = true
        this.activePeers++
        this._checkGC()

        for (let i = this.sessions.length - 1; i >= 0; i--) {
          const session = this.sessions[i]
          const handlers = session.handlers

          if (handlers.onpeeractive) handlers.onpeeractive(peer, session)
        }
      }
    } else {
      if (peer.active) {
        peer.active = false
        this.activePeers--
        this._checkGC()

        for (let i = this.sessions.length - 1; i >= 0; i--) {
          const session = this.sessions[i]
          const handlers = session.handlers

          if (handlers.onpeerinactive) handlers.onpeerinactive(peer, session)
        }
      }
    }
  }

  _onopen (muxer, unique) {
    if (!unique && this.peersByStream.has(muxer.stream)) return

    const peer = new WakeupPeer(this)
    const ch = muxer.createChannel({
      userData: peer,
      protocol: 'wakeup',
      id: this.id,
      handshake: Handshake,
      messages: [
        { encoding: Lookup, onmessage: onlookup },
        { encoding: Announce, onmessage: onannounce },
        { encoding: Info, onmessage: onchannelinfo }
      ],
      onopen: onchannelopen,
      onclose: onchannelclose
    })

    if (!ch) return

    peer.channel = ch
    peer.stream = muxer.stream

    peer.wireLookup = ch.messages[0]
    peer.wireAnnounce = ch.messages[1]
    peer.wireInfo = ch.messages[2]

    peer.index = this.pendingPeers.push(peer) - 1
    this.peersByStream.set(muxer.stream, peer)

    ch.open({
      version: 0,
      capability: this._proveCapabilityTo(muxer.stream),
      active: this.isActive
    })
  }
}

function onchannelopen (open, channel) {
  const peer = channel.userData
  peer.topic._addPeer(peer, open)
}

function onchannelclose (close, channel) {
  const peer = channel.userData
  peer.topic._removePeer(peer)
}

function onlookup (req, channel) {
  const peer = channel.userData
  peer.topic._onlookup(req, peer)
}

function onannounce (wakeup, channel) {
  const peer = channel.userData
  peer.topic._onannounce(wakeup, peer)
}

function onchannelinfo (info, channel) {
  const peer = channel.userData
  peer.topic._oninfo(info, peer)
}

function getMuxer (stream) {
  if (Protomux.isProtomux(stream)) return stream
  if (stream.noiseStream.userData) return stream.noiseStream.userData
  const mux = Protomux.from(stream.noiseStream)
  stream.noiseStream.userData = mux
  return mux
}

function noop () {}
