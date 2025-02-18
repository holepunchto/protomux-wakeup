import testnet from 'hyperdht/testnet.js'
import Hyperswarm from 'hyperswarm'
import Wakeup from './index.js'
import b4a from 'b4a'

const { bootstrap } = await testnet(5)
const a = new Hyperswarm({ bootstrap })
const b = new Hyperswarm({ bootstrap })

a.on('connection', c => sw.addStream(c))
b.on('connection', c => sw2.addStream(c))

await a.join(Buffer.alloc(32, 'yo')).flushed()
await b.join(Buffer.alloc(32, 'yo')).flushed()

const sw2 = new Wakeup((id) => {
  const s = sw2.session(Buffer.alloc(32, 'cap'), {
    active: false,
    onwakeuprequest (req, peer) {
      console.log('got wakeup request', req)
      s.wakeup(peer, [{ key: b4a.alloc(32, 'fill'), length: 42 }])
    }
  })
})

const sw = new Wakeup()
const s = sw.session(Buffer.alloc(32, 'cap'), {
  onwakeup (wakeup, peer) {
    console.log('got wakeup', wakeup)
  },
  onpeeradd (peer) {
    console.log('got peer...')
    s.request(peer)
  }
})

s.inactive()

setTimeout(function () {
  s.active()
}, 3000)
