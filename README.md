# InOrbit Edge SDK

---

The InOrbit Edge SDK allows Javascript programs to communicate with **InOrbit platform**
on behalf of robots - providing robot data and handling robot actions.
It's goal is to ease the integration between InOrbit and any other software that handles robot data.

This package can be installed using NPM as shown below:

```console
npm i @inorbit/edge-sdk
```

The following example shows how this package can be used to send data belonging
to various robots to InOrbit:

```javascript
import { InOrbit } from '@inorbit/edge-sdk';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const robots = ['robot0', 'robot1', 'robot2', 'robot3'];

  // Initialize the SDK reading the InOrbit API Key from the environment
  const sdk = new InOrbit({ apiKey: process.env.INORBIT_API_KEY });

  // Initialize the connection for each robot
  await Promise.all(robots.map((robotId) => sdk.connectRobot({ robotId })));

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
```

The code publishes fake data about four robots to InOrbit. The data is then
available in InOrbit platform and can be queried via APIs or using InOrbit Control.

You can extend this example to actually integrate your existing applications, including fleet manager systems,
with InOrbit.

## Support for callbacks

The EdgeSDK provides a mechanism to register callback functions for handling InOrbit builtin commands.

```javascript
const sdk = new InOrbit({
  apiKey: process.env.INORBIT_API_KEY,
});

// Initialize the robot connection
await sdk.connectRobot({ robotId, name: 'robot0' });

// Register a sample command callback function
sdk.registerCommandCallback((robotId, commandName, args, options) => {
    console.log('Received command! What should I do now?', {
      commandName, args, options, robotId
    });  
  }
);
```

### Supported commands

- `navGoal`
  - Arguments: `x`, `y`, `theta`
- `initialPose`
  - Arguments: `x`, `y`, `theta`
- `customCommand`
  - Arguments: `scriptName`, `parametersArray`

## Run example files

Two example files are located at repository root, namely `example.js` and `example-multi-robot.js`.

```bash
npm run build
export INORBIT_API_KEY="APIKEY"
npm run example
```

Please note that they reference to the locally built `@inorbit/edge-sdk` package, but when installed through `npm install @inorbit/edge-sdk` it should be imported as:

```javascript
import { InOrbit } from '@inorbit/edge-sdk';
```

### Publishing this package to the NPM registry

#### Requirements

You must be a maintain of the [edge-sdk package](https://www.npmjs.com/package/@inorbit/edge-sdk/access)
or have an access token that allows you to publish. You can get a token from any of the maintainers.

If you use a token, remember to export the `NPM_TOKEN` environment variable (check [https://docs.npmjs.com/using-private-packages-in-a-ci-cd-workflow]).

#### Publishing

Before publishing check that the version in `package.json` is the right one. Then run these commands
to publish the package:

```
npm i
npm run-script build
npm publish
```
