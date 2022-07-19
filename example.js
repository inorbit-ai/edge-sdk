/**
 * InOrbit Edge SDK Example showing how to send data belonging to one robot
 * to the InOrbit Platform.
 *
 * Copyright 2021 InOrbit, Inc.
 */

import { InOrbit } from '@inorbit/edge-sdk';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Dummy sample command callback function
 */
function logCommand(robotId, commandName, args, options) {
  console.log('Received command! What should I do now?', {
    commandName, args, options, robotId
  });
}

async function main() {
  const robotId = 'joxx4';
  // Initialize the SDK reading the InOrbit API Key from the environment
  const sdk = new InOrbit({
    apiKey: process.env.INORBIT_API_KEY,
    // Include logging to the console
    logger: {
      info: () => {},
      error: console.log,
      warn: console.log,
    }
  });

  // Initialize the robot connection
  await sdk.connectRobot({ robotId, name: 'robot0' });

  // Register a sample command callback function
  sdk.registerCommandCallback(logCommand);

  while (true) {
    // Publish Key-Values for battery and status
    await sdk.publishCustomDataKV(robotId, {
      battery: Math.random() * 100,
      status: Math.random() > 0.5 ? 'Mission' : 'Idle'
    });

    // Publish a random pose
    await sdk.publishPose(robotId, {
      ts: new Date().getTime(),
      x: Math.random() * 20 + 20,
      y: Math.random() * 20 + 10,
      yaw: Math.random() * Math.PI * 2,
      frameId: 'map'
    });

    // Publish random speed
    await sdk.publishOdometry(robotId, {
      tsStart: new Date().getTime(),
      ts: new Date().getTime(),
      speed: {
        linear: Math.random() * 10,
        angular: Math.random() * Math.PI
      }
    });

    await sdk.publishPaths(robotId, {
      ts: new Date().getTime(),
      paths: [
        {
          pathId: '0',
          ts: new Date().getTime(),
          points: [
            { x: 0, y: 0 },
            { x: Math.random() * 20 + 20, y: Math.random() * 20 + 10},
          ]
        }
      ]
    });
    await sleep(1000);
  }
}

main();
