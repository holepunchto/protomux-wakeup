const path = require('path')

const Hyperschema = require('hyperschema')

const SCHEMA_DIR = path.join(__dirname, './spec/hyperschema')

const schema = Hyperschema.from(SCHEMA_DIR)

const wakeupSchema = schema.namespace('wakeup')

wakeupSchema.register({
  name: 'info',
  fields: [
    {
      name: 'active',
      type: 'bool'
    }
  ]
})

wakeupSchema.register({
  name: 'handshake',
  fields: [
    {
      name: 'version',
      type: 'uint',
      required: true
    },
    {
      name: 'capability',
      type: 'fixed32',
      required: true
    },
    {
      name: 'active',
      type: 'bool'
    }
  ]
})

wakeupSchema.register({
  name: 'writer',
  compact: true,
  fields: [
    {
      name: 'key',
      type: 'fixed32',
      required: true
    },
    {
      name: 'length',
      type: 'uint',
      required: true
    }
  ]
})

wakeupSchema.register({
  name: 'announce',
  type: '@wakeup/writer',
  array: true
})

wakeupSchema.register({
  name: 'lookup',
  fields: [
    {
      name: 'hash',
      type: 'fixed32',
      required: false
    }
  ]
})

Hyperschema.toDisk(schema)
