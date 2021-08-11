import axios from 'axios';
import mqtt from 'async-mqtt';
import messages from './inorbit_pb';

const AGENT_VERSION = '0.1.0.cloudsdk';

class RobotSession {
  /**
   * Initializes a robot session.
   *
   * Note that the session isn't automatically connected. You must call `connect`
   * before publishing any message.
   *
   * @typedef {Settings}
   * @property {string} appKey Company app key
   * @property {string} endpoint URL of the HTTP endpoint to fetch
   * robots settings.
   *
   * @param {string} robotId
   * @param {string} name
   * @param {string} agentVersion
   * @param {Settings}
   */
  constructor({ robotId, name = 'unknown' }, settings = {}) {
    this.robotId = robotId;
    this.name = name;
    this.agentVersion = AGENT_VERSION;
    this.appKey = settings.appKey;
    this.endpoint = settings.endpoint;
    this.logger = settings.logger;
    console.log(settings);
  }

  /**
   * Fetches the configuration for this robot session based on its robotId and
   * appKey
   *
   * @returns {Object}
   */
  async fetchRobotConfig() {
    this.logger.info(`Fetching MQTT config for robot ${this.robotId} for company ${this.appKey.substr(0, 3)}...`);

    const params = {
      apiKey: this.appKey,
      robotId: this.robotId,
      hostname: this.name,
      agentVersion: this.agentVersion
    };
    console.log(this.endpoint, params);
    const response = await axios.post(this.endpoint, params);
    if (response.status != 200 || !response.data) {
      throw Error(`Failed to fetch config for robot ${this.robotId}`);
    }
    // TODO: validate fetched config
    return response.data;
  }

  /**
   * Connects to the InOrbit's Cloud services
   */
  async connect() {
    const mqttConfig = await this.fetchRobotConfig();
    const { protocol, hostname, port, username, password } = mqttConfig;
    this.mqtt = await mqtt.connect(protocol + hostname + ':' + port, {
      username,
      password,
      will: {
        topic: `r/${this.robotId}/state`,
        payload: `0|${this.appKey}`,
        qos: 1,
        retain: true
      }
    });

    if (this.ended) {
      // In case this session was ended by end() while it was connecting
      this.mqtt.end();
    }
    // TODO(mike) handle errors
    return this.publish('state', `1|${this.appKey}|${this.agentVersion}|${this.name}`, { qos: 1, retain: true });
  }

  /**
   * Ends session, disconnecting from cloud services
   */
  end() {
    // Before ending the session, update robot state explicitely as the `will` configured
    // on the mqtt `connect` method is trigged only if the "client disconnect badly"
    this.logger.info(`Setting robot ${this.robotId} state as offline`);
    this.publish('state', `0|${this.appKey}|${this.agentVersion}|${this.name}`, { qos: 1, retain: true });
    this.ended = true;
    this.mqtt && this.mqtt.end();
  }

  /**
   * Publishes a string or Buffer message
   * @param {string} topic
   * @param {string|Buffer} msg
   * @param {Object} options
   */
  publish(topic, msg, options) {
    return this.mqtt.publish(`r/${this.robotId}/${topic}`, msg, options);
  }

  /**
   * Publishes a a custom data message containing key-values pairs
   *
   * @param {Object} keyValues
   * @param {String} customField
   */
  publishCustomDataKV(keyValues, customField = '0') {
    this.logger.info(`Publishing custom data key-values for robot ${this.robotId} ${JSON.stringify(keyValues)}`);

    function convertValue(val) {
      return typeof val == 'object' ? JSON.stringify(val) : String(val);
    }

    // Build protobuf message
    const msg = new messages.CustomDataMessage();
    msg.setCustomField(customField);
    const payload = new messages.KeyValuePairs();
    payload.setPairsList(Object.keys(keyValues).map(k => {
      const item = new messages.KeyValueCustomElement();
      item.setKey(k);
      item.setValue(convertValue(keyValues[k]));
      return item;
    }));
    msg.setKeyValuePayload(payload);

    return this.publishProtobuf('custom', msg);
  }

  /**
   * Publishes pose to InOrbit
   *
   * @param {number} ts Timestamp in milliseconds
   * @param {number} x
   * @param {number} y
   * @param {number} yaw Yaw in radians
   * @param {string} frameId Robot's reference frame id
   */
  publishPose({ ts, x, y, yaw, frameId }) {
    this.logger.info(`Publishing pose ${JSON.stringify({ ts, x, y, yaw, frameId })}`);

    const msg = new messages.LocationAndPoseMessage();
    msg.setTs(ts);
    msg.setPosX(x);
    msg.setPosY(y);
    msg.setYaw(yaw);
    // TODO(mike) report frameId when we start using it
    return this.publishProtobuf('ros/loc/data2', msg);
  }

  /**
   * Publishes a Protocol Buffers message
   *
   * @param {string} topic
   * @param {Object} msg
   * @param {Object} protoBufType
   * @param {Object} options
   */
  publishProtobuf(topic, msg, options = null) {
    return this.publish(topic, msg.serializeBinary(), options);
  }
}

/**
 * Builds RobotSession objects for a company
 */
class RobotSessionFactory {
  /**
   * Creates a RobotSession factory
   *
   * @typedef {Settings}
   * @property {string} endpoint URL of the HTTP endpoint to fetch
   * robots settings.
   *
   * @param {Settings} robotSessionSettings
   */
  constructor(robotSessionSettings) {
    this.robotSessionSettings = robotSessionSettings;
  }

  /**
   * Builds a RobotSession for a robot
   *
   * @param {string} robotId
   * @param {string} name
   * @returns {RobotSession}
   */
  build({ robotId, name }) {
    return new RobotSession({
      robotId,
      name,
    },
      this.robotSessionSettings);
  }
}

/**
 * Pool of robot sessions that handles connections for many robots in an
 * efficient way.
 */
class RobotSessionPool {
  constructor(robotSessionFactory) {
    this.robotSessionFactory = robotSessionFactory;
    this.robotSessions = {};
    this.robotSessionsLastUse = {};
    this.connectPromises = {};
  }

  /**
   * Returns a connected RobotSession for a robot.
   *
   * @param {string} robotId
   * @param {string} name
   * @returns RobotSession
   */
  async getSession({ robotId, name }) {
    this.robotSessionsLastUse[robotId] = Date.now();
    if (!this.robotSessions[robotId]) {
      this.robotSessions[robotId] = this.robotSessionFactory.build({ robotId, name });

      // This connectPromises guarantees that this method always returns a connected
      // session, but it doesn't invoke RobotSession's connect more than once
      this.connectPromises[robotId] = this.robotSessions[robotId].connect();
    }
    // Since we await for the connect before returning
    await this.connectPromises[robotId];
    return this.robotSessions[robotId];
  }

  /**
   * Ends all sessions
   */
  tearDown() {
    Object.values(this.robotSessions).forEach(rs => rs.end());
  }
}

class DummyLogger {
  info() { }
  warn() { }
  error() { }
}

export default class CloudSDK {
  constructor(settings = {}) {
    const appKey = settings.appKey;
    // TODO validate settings
    const endpoint = settings.endpoint || 'https://api.inorbit.ai';
    const logger = settings.logger || new DummyLogger();
    const sessionsFactory = new RobotSessionFactory({ appKey, endpoint, logger });
    this.sessionsPool = new RobotSessionPool(sessionsFactory);
  }

  /**
   * @returns Promise<RobotSession>
   */
  getRobotSession({ robotId, name }) {
    return this.sessionsPool.getSession({ robotId, name });
  }
}

// TODO private vars