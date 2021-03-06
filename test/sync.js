const net = require('net')
const getport = require('getport')
const test = require('tape')
const pull = require('pull-stream')
const toPull = require('stream-to-pull-stream')
const muxrpc = require('muxrpc')
const multifeed = require('multifeed')
const ram = require('random-access-memory')
const collect = require('collect-stream')
const blobSync = require('blob-store-replication-stream')
const helpers = require('./helpers')
const Protocol = require('../sync-protocol')

const DEFAULT_DEVICE_INFO = {
  name: 'test device',
  type: 'mobile'
}

function makeProtocol (opts) {
  const feeds = multifeed(ram, { contentEncoding: 'json' })
  return new Protocol(feeds, helpers.mediaStore(), DEFAULT_DEVICE_INFO, opts)
}

test('can create & get duplex stream', function (t) {
  t.plan(2)

  try {
    const proto = makeProtocol()
    const stream = proto.createStream()
    t.same(typeof stream.source, 'function', 'has source side')
    t.same(typeof stream.sink, 'function', 'has sink side')
  } catch (e) {
    t.error(e)
  }
})

test('rpc: GetPeerInfo', function (t) {
  t.plan(4)

  const proto1 = makeProtocol()
  const proto2 = makeProtocol()
  const stream1 = proto1.createStream()
  const stream2 = proto2.createStream()

  pull(stream1, stream2, stream1)

  proto1.rpcGetPeerInfo((err, res) => {
    t.error(err)
    t.same(res.protocolVersion, '6.0.0', 'protocol version ok')
    t.same(res.deviceName, 'test device', 'device name ok')
    t.same(res.deviceType, 'mobile', 'device type ok')
  })
})

test('rpc: Heartbeat', function (t) {
  t.plan(2)

  const proto1 = makeProtocol()
  const proto2 = makeProtocol()
  const stream1 = proto1.createStream()
  const stream2 = proto2.createStream()

  pull(stream1, stream2, stream1)

  proto1.rpcHeartbeat(err => {
    t.error(err, 'stream1 heartbeat ok')
  })

  proto2.rpcHeartbeat(err => {
    t.error(err, 'stream2 heartbeat ok')
  })
})

test('heartbeats keep connection alive', function (t) {
  t.plan(4)

  const opts = { timeout: 100 }

  const proto1 = makeProtocol(opts)
  const proto2 = makeProtocol(opts)
  const stream1 = proto1.createStream(prematureEnd)
  const stream2 = proto2.createStream(prematureEnd)

  pull(
    stream1,
    stream2,
    stream1
  )

  setTimeout(() => {
    t.pass('connection kept alive ok')
    proto1.close(() => {
      proto2.close(() => {
        t.pass('close ok')
      })
    })
  }, 400)

  function prematureEnd (err) {
    t.error(err, 'protocol should not terminate')
  }
})

test('protocol times out without heartbeat responses', function (t) {
  t.plan(2)

  const opts = { timeout: 200 }

  const proto1 = makeProtocol(opts)
  const stream1 = proto1.createStream(onEnd)
  const stream2 = helpers.createFakeApiIgnoreHeartbeats().createStream()

  let ended = false

  pull(stream1, stream2, stream1)

  const id = setTimeout(() => {
    t.fail('timed out without ending properly')
  }, 400)

  function onEnd (err) {
    t.ok(err, 'ended with error')
    t.ok(/remote timeout/.test(err.message), 'error message ok')
    clearTimeout(id)
  }
})

test('protocol detects the other side closing properly', function (t) {
  t.plan(3)

  const opts = { timeout: 200 }

  const proto1 = makeProtocol(opts)
  const proto2 = makeProtocol(opts)
  const stream1 = proto1.createStream(onEnd1)
  const stream2 = proto2.createStream(onEnd2)

  pull(stream1, stream2, stream1)

  setTimeout(() => {
    proto2.close(() => {
      t.pass('closed ok')
    })
  }, 20)

  function onEnd1 (err) {
    t.error(err, 'stream 1 closed without errors')
  }
  function onEnd2 (err) {
    t.error(err, 'stream 2 closed without errors')
  }
})

test('net: both sides detect a socket close; remote sees an error', function (t) {
  t.plan(3)

  // Setup up protocol streams
  const proto1 = makeProtocol()
  const proto2 = makeProtocol()
  const stream1 = proto1.createStream(onEnd1)
  const stream2 = proto2.createStream(onEnd2)

  // Set up server & client
  const server = net.createServer(socket => {
    pull(stream1, toPull.duplex(socket), stream1)
  })
  getport((err, port) => {
    t.error(err, 'found an open port to use ok')
    server.listen(port, () => {
      const clientSocket = net.connect(port, () => {
        setTimeout(() => {
          clientSocket.end()
        }, 50)
      })
      pull(stream2, toPull.duplex(clientSocket), stream2)
    })
  })

  // XXX(kira): Only one side sees an error because of a race condition: on the
  // side local to the socket close (stream2), the 'close' stream event is
  // caught by stream-to-pull-stream immediately and causes that pull-stream
  // pipeline to close gracefully. However, both sides' packet-stream-codec are
  // waiting on a reader.read() call, anticipating the next 9-byte muxrpc
  // header. On the remote side (stream1), that read is marked as a fail in
  // pull-reader, surfacing an error that bubbles up to onEnd1. Since the
  // socket close is noticed immediately on the stream2 side, the read() error
  // happens AFTER the packet-stream is closing, and is thus hidden.
  //
  // There's some unresolved discussion from 2016 discussing how to handle
  // overreading here (which this case is technically classified as):
  // https://github.com/dominictarr/pull-reader/issues/5

  function onEnd1 (err) {
    t.ok(err, 'stream 1 closed with a remote error')
    server.close()
  }
  function onEnd2 (err) {
    t.error(err, 'stream 2 closed without errors')
  }
})

test('rpc: SyncMultifeed', function (t) {
  t.plan(8)

  const proto1 = makeProtocol()
  const proto2 = makeProtocol()
  const stream1 = proto1.createStream()
  const stream2 = proto2.createStream()

  pull(
    stream1,
    helpers.onEnd(err => t.error(err, 'protocol end ok')),
    stream2,
    stream1
  )

  proto2.multifeed.writer((err, feed) => {
    t.error(err, 'created multifeed writer ok')
    feed.append('hello world', err => {
      t.error(err, 'feed append ok')
      doSync()
    })
  })

  function doSync () {
    const remoteSync = proto1.rpcSyncMultifeed()
    const localSync = toPull.duplex(proto2.multifeed.replicate(true))

    pull(
      remoteSync,
      helpers.onEnd(err => {
        t.error(err, 'sync end ok')
        onDone()
      }),
      localSync,
      remoteSync
    )

    function onDone () {
      t.equal(proto1.multifeed.feeds().length, 1, 'one feed synced ok')
      const localKey = proto1.multifeed.feeds()[0].key.toString('hex')
      const remoteKey = proto2.multifeed.feeds()[0].key.toString('hex')
      t.equal(remoteKey, localKey, 'correct feed synced ok')
      proto1.multifeed.feeds()[0].get(0, (err, data) => {
        t.error(err, 'remote feed read ok')
        t.same(data.toString(), 'hello world')

        // Triggers the remote to close cleanly too.
        proto1.close()
      })
    }
  }
})

test.only('rpc: SyncMediaBlobs', function (t) {
  t.plan(4)

  const proto1 = makeProtocol()
  const proto2 = makeProtocol()
  const stream1 = proto1.createStream()
  const stream2 = proto2.createStream()

  pull(
    stream1,
    helpers.onEnd(err => t.error(err, 'protocol end ok')),
    stream2,
    stream1
  )

  proto2.mediaStore.createWriteStream('test.png', doSync).end('<test data>')

  function doSync () {
    const remoteSync = proto1.rpcSyncMediaBlobs()
    const localSync = toPull.duplex(blobSync(proto2.mediaStore))

    pull(
      remoteSync,
      helpers.onEnd(err => {
        t.error(err, 'sync end ok')
        onDone()
      }),
      localSync,
      remoteSync
    )

    function onDone () {
      collect(proto1.mediaStore.createReadStream('test.png'), (err, res) => {
        t.error(err, 'read media ok')
        t.equal(res.toString(), '<test data>', 'media data ok')

        // Triggers the remote to close cleanly too.
        proto1.close()
      })
    }
  }
})

