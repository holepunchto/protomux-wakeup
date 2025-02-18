const crypto = require('hypercore-crypto')
const Protomux = require('protomux')
const b4a = require('b4a')
const schema = require('./spec/hyperschema')

const [
  NS_INITATOR,
  NS_RESPONDER
] = crypto.namespace('wakeup', 2)

const Handshake = schema.getEncoding('@wakeup/handshake')
const Wakeup = schema.getEncoding('@wakeup/wakeup')
const WakeupRequest = schema.getEncoding('@wakeup/wakeup-request')
const Info = schema.getEncoding('@wakeup/info')

module.exports = class WakeupSwarm {
  constructor (onwakeup = noop) {
    this.sessions = new Map()
    this.sessionsGC = new Set()
    this.muxers = new Set()

    this.onwakeup = onwakeup

    this._gcInterval = null
    this._gcBound = this._gc.bind(this)
  }

  session (capability, handlers) {
    const id = handlers.id || crypto.hash(capability)
    const active = handlers.active !== false
    const hex = b4a.toString(id, 'hex')

    let w = this.sessions.get(hex)

    if (w) {
      if (active) w.active()
      return w
    }

    w = new WakeupSession(this, id, capability, active, handlers)

    this.sessions.set(hex, w)

    for (const muxer of this.muxers) {
      w._onopen(muxer, true)
    }

    return w
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

    for (const w of this.sessions.values()) {
      if (!w.activity) continue
      w._onopen(muxer, true)
    }
  }

  _onActive (w) {
    for (const m of this.muxers) {
      w._onopen(m, false)
    }
  }

  _addGC (session) {
    if (session.destroyed) return
    this.sessionsGC.add(session)
    if (this._gcInterval === null) {
      this._gcInterval = setInterval(this._gcBound, 2000)
    }
  }

  _removeGC (session) {
    this.sessionsGC.delete(session)
    if (this.sessionsGC.size === 0 && this._gcInterval) {
      clearInterval(this._gcInterval)
      this._gcInterval = null
    }
  }

  _gc () {
    const destroy = []
    for (const w of this.sessionsGC) {
      w.idleTicks++
      if (w.idleTicks >= 5) destroy.push(w)
    }
    for (const w of destroy) w.destroy()
  }

  destroy () {
    if (this._gcInterval) clearInterval(this._gcInterval)
    this._gcInterval = null

    for (const w of this.sessions.values()) w.destroy()
  }

  async _onpair (id, muxer) {
    const hex = b4a.toString(id, 'hex')
    const w = this.sessions.get(hex)
    if (!w) return this.onwakeup(id, muxer)
    w._onopen(muxer)
  }
}

class WakeupPeer {
  constructor (session) {
    this.index = 0
    this.pending = true
    this.session = session
    this.channel = null
    this.wireRequest = null
    this.wireWakeup = null
    this.wireInfo = null
  }

  unlink (list) {
    const head = list.pop()
    if (head === this) return
    head.index = this.index
    list[head.index] = head
  }
}

// TODO: make proper sessions vs the single shared one atm
class WakeupSession {
  constructor (state, id, capability, active, handlers) {
    this.state = state
    this.handlers = handlers
    this.id = id
    this.capability = capability
    this.peers = []
    this.pendingPeers = []
    this.peersByStream = new Map()
    this.activePeers = 0
    this.activity = active ? 1 : 0
    this.idleTicks = 0
    this.gcing = false
    this.destroyed = false
  }

  active () {
    this.activity++
    this.idleTicks = 0
    if (this.activity !== 1) return
    this._updateActive(true)
  }

  inactive () {
    if (this.activity === 0) return
    this.activity--
    if (this.activity !== 0) return
    this._updateActive(false)
  }

  release () {
    this.handlers = null
    this.inactive()
  }

  _updateActive (active) {
    const info = { active }

    for (const peer of this.pendingPeers) peer.wireInfo.send(info)
    for (const peer of this.peers) peer.wireInfo.send(info)

    this._checkGC()

    if (active) this.state._onActive(this)
  }

  requestByStream (stream, req) {
    const peer = this.peersByStream.get(stream)
    if (peer) this.request(peer, req)
  }

  request (peer, req) {
    peer.wireRequest.send(req || { hash: null })
  }

  broadcastRequest (req) {
    for (const peer of this.pendingPeers) {
      this.request(peer, req)
    }
    for (const peer of this.peers) {
      this.request(peer, req)
    }
  }

  wakeupByStream (stream, wakeup) {
    const peer = this.peersByStream.get(stream)
    if (peer) this.wakeup(peer, wakeup)
  }

  wakeup (peer, wakeup) {
    peer.wireWakeup.send(wakeup)
  }

  destroy () {
    if (this.destroyed) return
    this.destroyed = true

    for (let i = this.peers.length - 1; i >= 0; i--) {
      this.peers[i].channel.close()
    }

    for (let i = this.pendingPeers.length - 1; i >= 0; i--) {
      this.peers[i].channel.close()
    }

    const hex = b4a.toString(this.id, 'hex')

    this.gcing = false
    this.state.sessions.delete(hex)
    this.state._removeGC(this)
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

    if (this.handlers && this.handlers.onpeeradd) this.handlers.onpeeradd(peer, this)
  }

  _checkGC () {
    const shouldGC = this.activity === 0 && this.activePeers === 0

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
    this.peersByStream.delete(peer.stream)

    if (peer.pending) {
      peer.unlink(this.pendingPeers)
      return
    }

    if (peer.active) {
      this.activePeers--
      this._checkGC()
    }

    peer.unlink(this.peers)

    if (this.handlers && this.handlers.onpeerremove) this.handlers.onpeerremove(peer, this)
  }

  _onwakeup (wakeup, peer) {
    if (this.handlers && this.handlers.onwakeup) this.handlers.onwakeup(wakeup, peer, this)
  }

  _onrequest (req, peer) {
    if (this.handlers && this.handlers.onwakeuprequest) this.handlers.onwakeuprequest(req, peer, this)
  }

  _oninfo (info, peer) {
    if (info.active) {
      if (!peer.active) {
        peer.active = true
        this.activePeers++
        this._checkGC()
      }
    } else {
      if (peer.active) {
        peer.active = false
        this.activePeers--
        this._checkGC()
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
        { encoding: WakeupRequest, onmessage: onchannelrequest },
        { encoding: Wakeup, onmessage: onchannelwakeup },
        { encoding: Info, onmessage: onchannelinfo }
      ],
      onopen: onchannelopen,
      onclose: onchannelclose
    })

    if (!ch) return

    peer.channel = ch
    peer.stream = muxer.stream

    peer.wireRequest = ch.messages[0]
    peer.wireWakeup = ch.messages[1]
    peer.wireInfo = ch.messages[2]

    peer.index = this.pendingPeers.push(peer) - 1
    this.peersByStream.set(muxer.stream, peer)

    ch.open({
      version: 0,
      capability: this._proveCapabilityTo(muxer.stream),
      active: this.activity > 0
    })
  }
}

function onchannelopen (open, channel) {
  const peer = channel.userData
  peer.session._addPeer(peer, open)
}

function onchannelclose (close, channel) {
  const peer = channel.userData
  peer.session._removePeer(peer)
}

function onchannelrequest (req, channel) {
  const peer = channel.userData
  peer.session._onrequest(req, peer)
}

function onchannelwakeup (wakeup, channel) {
  const peer = channel.userData
  peer.session._onwakeup(wakeup, peer)
}

function onchannelinfo (info, channel) {
  const peer = channel.userData
  peer.session._oninfo(info, peer)
}

function getMuxer (stream) {
  if (Protomux.isProtomux(stream)) return stream
  if (stream.noiseStream.userData) return stream.noiseStream.userData
  const mux = Protomux.from(stream.noiseStream)
  stream.noiseStream.userData = mux
  return mux
}

function noop () {}
