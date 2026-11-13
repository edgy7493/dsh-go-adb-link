// Quick check for shellListenPorts(): run on a phone whose ADB channel is up.
//
//   node test/listen-ports.mjs
//
// Prints the ports adbd listens on (uid shell) and exits non-zero when the
// expected `adb tcpip` port is missing from the list.
import { shellListenPorts, adbDevices } from '../lib/cli.js'

const devices = await adbDevices()
const mine = devices.find((device) => device.state === 'device' && /:\d+$/.test(device.serial))
if (!mine) {
  console.log('skip: no live TCP serial to ask')
  process.exit(0)
}
const ports = await shellListenPorts(mine.serial)
console.log(`serial=${mine.serial} listenPorts=${JSON.stringify(ports)}`)
const own = Number(mine.serial.split(':').pop())
if (!ports.includes(own)) {
  console.error(`expected ${own} in the list`)
  process.exit(1)
}
