/**
 * InOrbit Edge SDK Example showing how to send data belonging to various robots
 * to the InOrbit Platform.
 *
 * Copyright 2021 InOrbit, Inc.
 */

import { InOrbit } from '@inorbit/edge-sdk';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const robots = ['robot0', 'robot1', 'robot2', 'robot3'];

  // Initialize the SDK reading the InOrbit App Key from the environment
  const sdk = new InOrbit({ appKey: process.env.INORBIT_APP_KEY });

  // Initialize the connection for each robot
  await Promise.all(robots.map((robotId) => sdk.connectRobot({ robotId, name: robotId })));

  while (true) {
    // Publish Key-Values with battery and status values
    await Promise.all(robots.map((robotId) => sdk.publishCustomDataKV(robotId, {
      battery: Math.random() * 100,
      status: Math.random() > 0.5 ? 'Mission' : 'Idle'
    })));

    // Publish the robots' poses
    await Promise.all(robots.map((robotId) => sdk.publishPose(robotId, {
      ts: new Date().getTime(),
      x: Math.random() * 20 + 20,
      y: Math.random() * 20 + 10,
      yaw: Math.random() * Math.PI * 2,
      frameId: 'map'
    })));

    await sleep(1000);
  }
}

main();
