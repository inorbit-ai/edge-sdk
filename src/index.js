/**
 * InOrbit Cloud SDK
 *
 * Javascript interface to the InOrbit Robot Protocol.
 *
 * Copyright 2021 InOrbit, Inc.
 */
import axios from 'axios';
import mqtt from 'async-mqtt';
import messages from './inorbit_pb';

const CLOUD_SDK_VERSION = '0.1.0';
const INORBIT_ENDPOINT_DEFAULT = 'https://control.inorbit.ai/cloud_sdk_robot_config';
// Agent version reported when a robot connection is open using this SDK
const AGENT_VERSION = `${CLOUD_SDK_VERSION}.cloudsdk`;

// MQTT Topics
const MQTT_TOPIC_CUSTOM_DATA = 'custom';
const MQTT_TOPIC_LOCALIZATION = 'ros/loc/data2';
const MQTT_TOPIC_ODOMETRY = 'ros/odometry/data';

/**
 * RobotSession represent the session of a robot connected to InOrbit from the
 * point of view of the robot end. Technically this is a facade that provides
 * a clean interface to the InOrbit Robot Protocol.
 */
class RobotSession {
  /**
   * Initializes a robot session.
   *
   * Note that the session isn't automatically connected. You must call `connect`
   * before publishing any message.
   *
   * @typedef {Settings}
   * @property {string} appKey
   * @property {string} endpoint URL of the HTTP endpoint to fetch
   * robots settings.
   *
   * @param {string} robotId
   * @param {string} name
   * @param {Settings}
   */
  constructor({ robotId, name = 'unknown' }, settings = {}) {
    this.robotId = robotId;
    this.name = name;
    this.agentVersion = AGENT_VERSION;
    this.appKey = settings.appKey;
    this.endpoint = settings.endpoint;
    this.logger = settings.logger;
  }

  /**
   * Fetches the configuration for this robot session based on its robotId and
   * appKey
   *
   * @returns {Object} Robot configuration
   */
  async fetchRobotConfig() {
    this.logger.info(`Fetching config for robot ${this.robotId} for appKey ${this.appKey.substr(0, 3)}...`);

    const params = {
      appKey: this.appKey,
      robotId: this.robotId,
      hostname: this.name,
      agentVersion: this.agentVersion
    };

    const response = await axios.post(this.endpoint, params);
    if (response.status != 200 || !response.data) {
      throw Error(`Failed to fetch config for robot ${this.robotId}`);
    }
    // TODO: validate fetched config
    return response.data;
  }

  /**
   * Connects to the InOrbit Platform
   */
  async connect() {
    const mqttConfig = await this.fetchRobotConfig();
    const { protocol, hostname, port, username, password, robotApiKey } = mqttConfig;

    this.mqtt = await mqtt.connect(protocol + hostname + ':' + port, {
      username,
      password,
      will: {
        topic: `r/${this.robotId}/state`,
        payload: `0|${robotApiKey}`,
        qos: 1,
        retain: true
      }
    });

    if (this.ended) {
      // In case this session was ended by end() while it was connecting
      this.mqtt.end();
    }
    // TODO(mike) handle errors
    this.robotApiKey = robotApiKey;
    return this.publish('state', `1|${robotApiKey}|${this.agentVersion}|${this.name}`, { qos: 1, retain: true });
  }

  /**
   * Ends session, disconnecting from cloud services
   */
  end() {
    // Before ending the session, update robot state explicitly as the `will` configured
    // on the mqtt `connect` method is trigged only if the "client disconnect badly"
    this.logger.info(`Setting robot ${this.robotId} state as offline`);
    this.publish('state', `0|${this.robotApiKey}|${this.agentVersion}|${this.name}`, { qos: 1, retain: true });
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
   * @param {Object} keyValues Dictionary of key-value pairs
   * @param {String} customField Custom field name
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
    payload.setPairsList(Object.keys(keyValues).map((k) => {
      const item = new messages.KeyValueCustomElement();
      item.setKey(k);
      item.setValue(convertValue(keyValues[k]));
      return item;
    }));
    msg.setKeyValuePayload(payload);

    return this.publishProtobuf(MQTT_TOPIC_CUSTOM_DATA, msg);
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
    return this.publishProtobuf(MQTT_TOPIC_LOCALIZATION, msg);
  }

  /**
   * Publishes odometry data to InOrbit
   *
   * @typedef Speed
   * @property {number} linear Linear speed in m/s
   * @property {number} angular Angular speed in rad/s
   *
   * @typedef Distance
   * @property {number} linear Linear distance in m
   * @property {number} angular Angular distance in rad
   *
   * @param {number} tsStart when are you counting from.
   * @param {number} ts when the measurement was taken
   * @param {Speed} speed
   * @param {Distance} distance
   */
  publishOdometry({ tsStart,
    ts,
    distance = { linear: 0, angular: 0 },
    speed = { linear: 0, angular: 0 } }) {
    this.logger.info(`Publishing odometry ${JSON.stringify({ tsStart, ts, distance, speed })}`);

    const msg = new messages.OdometryDataMessage();
    msg.setTsStart(tsStart);
    msg.setTs(ts);
    msg.setLinearDistance(distance.linear);
    msg.setAngularDistance(distance.angular);
    msg.setLinearSpeed(speed.linear);
    msg.setAngularSpeed(speed.angular);
    msg.setSpeedAvailable(true);
    return this.publishProtobuf(MQTT_TOPIC_ODOMETRY, msg);
  }

  /**
   * Publishes a Protocol Buffers message
   *
   * @param {string} topic
   * @param {Object} msg
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
   * @property {string} appKey Company app key
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
    Object.values(this.robotSessions).forEach((rs) => rs.end());
    this.robotSessions = {};
    this.robotSessionsLastUse = {};
    this.connectPromises = {};
  }

  /**
   * Returns if there is a robot session associated to the robotId
   * @param {string} robotId
   * @returns {boolean}
   */
  hasRobot(robotId) {
    return robotId in this.robotSessions;
  }

  /**
   * Disconnects and frees a robot session
   * @param {string} robotId
   */
  async freeRobotSession(robotId) {
    if (!this.hasRobot(robotId)) {
      return;
    }
    const sess = await this.getSession({ robotId });
    sess.end();
    delete this.robotSessions[robotId];
    delete this.robotSessionsLastUse[robotId];
    delete this.connectPromises[robotId];
  }
}

export class Logger {
  info() { }

  warn() { }

  error() { }
}

export default class InOrbit {
  #sessionsPool;

  #explicitConnect;

  /**
   * Initializes the InOrbit
   *
   * @typedef Logger
   * @property
   *
   * @typedef Settings
   * @property {string} appKey The account's app key. Used for authentication.
   * @property {string} endpoint InOrbit endpoint URL. Default to https://api.inorbit.ai
   * @property {Logger} logger By default a no-op logger is used
   *
   * @param {Settings} settings
   */
  constructor(settings = {}) {
    const { appKey, endpoint = INORBIT_ENDPOINT_DEFAULT, logger = new Logger() } = settings;
    if (!appKey) {
      throw Error('InOrbit expects appKey as part of the settings');
    }
    const sessionsFactory = new RobotSessionFactory({ appKey, endpoint, logger });
    this.#sessionsPool = new RobotSessionPool(sessionsFactory);
    this.#explicitConnect = settings.explicitConnect !== false;
  }

  /**
   * Opens a connection associated to a robot and returns the session object.
   *
   * @see connectRobot
   * @returns RobotSession
   */
  async #getRobotSession({ robotId, name = 'cloud-sdk' }) {
    if (this.#explicitConnect && !this.#sessionsPool.hasRobot(robotId)) {
      throw new Error('Can\'t get robot session or send data before connecting. Use connectRobot before sending any data');
    }

    return this.#sessionsPool.getSession({ robotId, name });
  }

  /**
   * Frees all resources and connections used by this InOrbit object
   */
  tearDown() {
    this.sessionsPool.tearDown();
  }

  /**
   * Marks a robot as online and initializes the connection. If a connection
   * is already open, it's reused. So, invoking this method multiple times for
   * the same robot will create just one connection.
   *
   * @param {string} robotId
   * @param {string} name Name of the robot. This name will be used as the robot's
   * name if it's the first time it connects to the platform.
   */
  async connectRobot({ robotId, name = 'cloud-sdk' }) {
    // Await fo the session creation. This assures that we have a valid connection
    // to the robot
    await this.#sessionsPool.getSession({ robotId, name });
  }

  /**
   * Marks a robot as offline and frees the connection.
   *
   * @param {string} robotId
   */
  async disconnectRobot(robotId) {
    await this.#sessionsPool.freeRobotSession(robotId);
  }

  /**
   * Publishes a a custom data message containing key-values pairs
   *
   * @param {string} robotId
   * @param {Object} keyValues Dictionary of key-value pairs
   * @param {string} customField Custom field name
   */
  async publishCustomDataKV(robotId, keyValues, customField = '0') {
    const sess = await this.#getRobotSession({ robotId });
    return sess.publishCustomDataKV(keyValues, customField);
  }

  /**
   * Publishes pose to InOrbit
   *
   * @param {string} robotId
   * @param {number} ts Timestamp in milliseconds
   * @param {number} x
   * @param {number} y
   * @param {number} yaw Yaw in radians
   * @param {string} frameId Robot's reference frame id
   */
  async publishPose(robotId, { ts, x, y, yaw, frameId }) {
    const sess = await this.#getRobotSession({ robotId });
    return sess.publishPose({ ts, x, y, yaw, frameId });
  }

  /**
   * Publishes odometry data to InOrbit
   *
   * @typedef Speed
   * @property {number} linear Linear speed in m/s
   * @property {number} angular Angular speed in rad/s
   *
   * @typedef Distance
   * @property {number} linear Linear distance in m
   * @property {number} angular Angular distance in rad
   *
   * @param {string} robotId
   * @param {number} tsStart when are you counting from.
   * @param {number} ts when the measurement was taken
   * @param {Speed} speed
   * @param {Distance} distance
   */
  async publishOdometry(robotId, { tsStart,
    ts,
    distance = { linear: 0, angular: 0 },
    speed = { linear: 0, angular: 0 } }) {
    const sess = await this.#getRobotSession({ robotId });
    return sess.publishOdometry({
      tsStart,
      ts,
      distance,
      speed
    });
  }
}
