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

const s = w.session(capability)

// the peers
s.peers

// peer added
s.on('add', peer => ...)
// peer removed
s.on('remove', peer => ...)

// request wakeup
s.request(peer, { hash })
s.wakeup(peer, [{ key, length }])

// or by stream
s.requestByStream(stream, ...)
s.wakeupByStream(stream, ...)

// received a wakeup
s.on('wakeup', (wakeup, peer) => ...)
// received a wakeup request
s.on('request', (request, peer) => ...)

// mark session as inactive, you must call this when done
s.inactive()

// cancel an inactive call
s.active()
```

## License

Apache-2.0
