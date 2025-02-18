# protomux-wakeup

Wakeup protocol over protomux

```
npm install protomux-wakeup
```

## Usage

``` js
const Wakeup = require('protomux-wakeup')

const w = new Wakeup()

w.addStream(stream)

const s = w.session(capability, {
  onpeeradd (peer) {
    // peer added
  },
  onpeerremove (peer) {
    // peer removed
  },
  onlookup (req, peer) {
    // received a lookup request
  },
  onannounce (wakeup, peer) {
    // received an announce message
  }
})

// the peers
s.peers

// request wakeup
s.lookup(peer, { hash })
s.announce(peer, [{ key, length }])

// or by stream
s.lookupByStream(stream, ...)
s.announceByStream(stream, ...)

// mark session as inactive, you must call this when done
s.inactive()

// cancel an inactive call
s.active()

// release the handlers
s.release()
```

## License

Apache-2.0
