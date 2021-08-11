import CloudSDK from './index';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {

  const sdk = new CloudSDK({
    appKey: 'ZqQ1_c1pMMJg3I0d',
    endpoint: 'http://localdev.com:3000/mqtt_config',
    logger: {
      info: console.log,
      error: console.log,
      warn: console.log,
    }
  });

  const sess = await sdk.getRobotSession({ robotId: 'xxxx', name: 'robot0' });

  while (true) {
    // Publish Key-Values
    await sess.publishCustomDataKV({
      battery: Math.random() * 100,
      status: Math.random() > 0.5 ? 'Mission' : 'Idle'
    });

    // Publish a random pose
    await sess.publishPose({
      ts: new Date().getTime(),
      x: Math.random() * 20 + 20,
      y: Math.random() * 20 + 10,
      yaw: Math.random() * Math.PI * 2,
      frameId: 'map'
    });
    await sleep(1000);
  }
  await sess.end();
}

main();