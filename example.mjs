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
  const s = sw2.session(Buffer.alloc(32, 'cap'))

  s.on('inactive', function (peer) {
    console.log('inactive...')
  })

  s.on('wakeup-request', function (req, peer) {
    console.log('got wakeup request', req)
    s.wakeup(peer, [{ key: b4a.alloc(32, 'fill'), length: 42 }])
  })
  // s.inactive()
})

const sw = new Wakeup()
const s = sw.session(Buffer.alloc(32, 'cap'))

s.on('wakeup', function (wakeup, peer) {
  console.log('got wakeup', wakeup)
})

s.on('add', function (peer) {
  console.log('got peer...')
  s.request(peer)
})

s.inactive()
