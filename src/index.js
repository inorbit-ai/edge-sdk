/**
 * InOrbit Edge SDK
 *
 * Javascript interface to the InOrbit Robot Protocol.
 *
 * Copyright 2021 InOrbit, Inc.
 */
import axios from 'axios';
import mqtt from 'async-mqtt';
import { isFunction } from 'lodash';
import constants from './constants';
import messages from './inorbit_pb';

const EDGE_SDK_VERSION = '1.5.4';
const INORBIT_ENDPOINT_DEFAULT = 'https://control.inorbit.ai/cloud_sdk_robot_config';
// Agent version reported when a robot connection is open using this SDK
const AGENT_VERSION = `${EDGE_SDK_VERSION}.edgesdk`;

// MQTT Topics
const MQTT_TOPIC_CUSTOM_DATA = 'custom';
const MQTT_TOPIC_LOCALIZATION = 'ros/loc/data2';
const MQTT_TOPIC_ODOMETRY = 'ros/odometry/data';
const MQTT_TOPIC_PATHS = 'ros/loc/path';
const MQTT_TOPIC_ECHO = 'echo';
const MQTT_IN_TOPIC = 'in_cmd';
// built-in commands
const MQTT_NAV_GOAL_GOAL = 'ros/loc/nav_goal';
const MQTT_NAV_GOAL_MULTI = 'ros/loc/goal_path';
const MQTT_INITIAL_POSE = 'ros/loc/set_pose';
// custom commands
const MQTT_CUSTOM_COMMAND = 'custom_command/script/command'
const MQTT_SCRIPT_OUTPUT_TOPIC = 'custom_command/script/status'


/**
 * RobotSession represent the session of a robot connected to InOrbit from the
 * point of view of the robot end. Technically this is a facade that provides
 * a clean interface to the InOrbit Robot Protocol.
 */
class RobotSession {
  // Object with pointers to functions to handle incoming MQTT messages,
  // indexed by MQTT subtopic
  #messageHandlers = {}

  /**
   * Initializes a robot session.
   *
   * Note that the session isn't automatically connected. You must call `connect`
   * before publishing any message.
   *
   * @typedef {Settings}
   * @property {string} apiKey
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
    this.apiKey = settings.apiKey;
    this.endpoint = settings.endpoint;
    this.logger = settings.logger;
    this.commandCallbacks = [];
    this.#messageHandlers[MQTT_INITIAL_POSE] = this.#handleInitialPose;
    this.#messageHandlers[MQTT_NAV_GOAL_GOAL] = this.#handleNavGoal;
    this.#messageHandlers[MQTT_CUSTOM_COMMAND] = this.#handleCustomCommand;
  }

  /**
   * Fetches the configuration for this robot session based on its robotId and
   * apiKey
   *
   * @returns {Object} Robot configuration
   */
  async fetchRobotConfig() {
    this.logger.info(`Fetching config for robot ${this.robotId} for apiKey ${this.apiKey.substr(0, 3)}...`);

    const params = {
      appKey: this.apiKey,
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
    this.mqtt.on('message', this.#onMessage);
    this.mqtt.on('reconnect', this.#onReconnect);

    // Subscribe to incoming topics
    // TODO(adamantivm) Perform lazy subscription, only when callbacks are registered
    this.subscribe(MQTT_INITIAL_POSE);
    this.subscribe(MQTT_NAV_GOAL_GOAL);
    this.subscribe(MQTT_CUSTOM_COMMAND);
    this.subscribe(MQTT_IN_TOPIC);

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
   * Internal method: sends an echo response to the server
   */
  #sendEcho(topic, payload) {
    const msg = new messages.Echo();
    msg.setTopic(topic);
    msg.setTimeStamp(Date.now());
    // TODO(adamantivm) Filter out non-String topics
    msg.setStringPayload(payload.toString());
    this.publishProtobuf(MQTT_TOPIC_ECHO, msg);
  }

  /**
   * Internal method: callback used to route incoming MQTT messages
   */
  #onMessage = (topic, message) => {
    // Respond with an echo message, so that the server knows this message was received
    this.#sendEcho(topic, message);

    // Extract subtopic from the incoming topic
    const subtopic = topic.split('/').slice(2).join('/');
    // Hand over to the handler specific to this subtopic, if any is registered
    if (subtopic in this.#messageHandlers) {
      this.#messageHandlers[subtopic](message);
    }
  }

  /**
   * Internal method: callback used on every reconnection to the broker.
   */
  #onReconnect = () => {
    this.logger.info(`Setting robot ${this.robotId} state as online again.`);
    this.publish('state', `1|${this.robotApiKey}|${this.agentVersion}|${this.name}`, { qos: 1, retain: true });
  }

  /**
   * Internal method: handle incoming MQTT_INITIAL_POSE message
   */
  #handleInitialPose = (message) => {
    // Decode incoming message
    const [seq, ts, x, y, theta] = message.toString().split("|");
    // Hand over to callback for processing, using the proper format
    this.#dispatchCommand(
      constants.COMMAND_INITIAL_POSE,
      [{ x, y, theta }],
      seq // NOTE(adamantivm) Using seq as the execution ID
    );
  }

  /**
   * Internal method: handle incoming MQTT_NAV_GOAL_GOAL message
   */
  #handleNavGoal = (message) => {
    // Decode incoming message
    const [seq, ts, x, y, theta] = message.toString().split("|");
    // Hand over to callback for processing, using the proper format
    this.#dispatchCommand(
      constants.COMMAND_NAV_GOAL,
      [{ x, y, theta }],
      seq // NOTE(adamantivm) Using seq as the execution ID
    );
  }

  /**
   * Internal method: handle incoming MQTT_CUSTOM_COMMAND message
   */
  #handleCustomCommand = (message) => {
    // Decode incoming message
    const msg = new messages.CustomScriptCommandMessage.deserializeBinary(message);
    // Hand over to callback for processing, using the proper format
    this.#dispatchCommand(
      constants.COMMAND_CUSTOM_COMMAND,
      [
        msg.getFileName(),
        msg.getArgOptionsList()
      ],
      msg.getExecutionId()
    );
  }

  /**
   * Internal method: executes registered command callbacks for a specific incoming
   * command / action
   */
  #dispatchCommand = (commandName, args, executionId) => {
    // TODO(adamantivm) try/catch block on each execution
    this.commandCallbacks.forEach(c => {
      // Prepare report result function bound to the specific execution ID
      const resultFunction = (resultCode) => this.#reportCommandResult(args, executionId, resultCode);
      // TODO(adamantivm) Implement progress reporting function
      const progressFunction = () => { };
      // Call the callback method
      c(commandName, args, { resultFunction, progressFunction, metadata: {} });
    });
  }

  /**
   * Internal method: conveys to the server the reported result of a command executed by a
   * registered user callback
   */
  #reportCommandResult = (args, executionId, resultCode) => {
    const msg = new messages.CustomScriptStatusMessage();
    msg.setFileName(args[0]);
    msg.setExecutionId(executionId);
    msg.setExecutionStatus(
      (resultCode === '0' ? constants.CUSTOM_COMMAND_STATUS_FINISHED : constants.CUSTOM_COMMAND_STATUS_ABORTED)
    );
    msg.setReturnCode(resultCode);
    this.publishProtobuf(MQTT_SCRIPT_OUTPUT_TOPIC, msg);
  }

  /**
   * Internal method: subscribes to a given subtopic for the current robot session.
   */
  subscribe(subtopic, options) {
    return this.mqtt.subscribe(`r/${this.robotId}/${subtopic}`, options);
  }

  /**
   * Internal method: Publishes a string or Buffer message
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
    msg.setFrameId(frameId);
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
   * Publishes paths to InOrbit
   *
   * @typedef Point
   * @property {number} x
   * @property {number} y
   *
   * @typedef Path
   * @property {number} ts
   * @property {string} pathId
   * @property {Array<Point>} points
   *
   * @param {number} ts Timestamp in milliseconds
   * @param {Array<Path>} paths
   */
  publishPaths({ ts, paths = [] }) {
    this.logger.info(`Publishing paths ${JSON.stringify({ ts, paths })}`);
    const msg = new messages.PathDataMessage();
    msg.setTs(ts);
    const protoPaths = paths.map((path) => {
      const protoPath = new messages.RobotPath();
      protoPath.setTs(path.ts || ts);
      protoPath.setPathId(path.pathId);
      const points = (path.points || []).map((point) => {
        const protoPoint = new messages.PathPoint();
        protoPoint.setX(point.x);
        protoPoint.setY(point.y);
        return protoPoint;
      });
      protoPath.setPointsList(points);
      return protoPath;
    });
    msg.setPathsList(protoPaths);
    return this.publishProtobuf(MQTT_TOPIC_PATHS, msg);
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

  /**
   * Registers a callback function to be called whenever a command
   * for the robot is received.
   *
   * @param {function} callback will be called each time a message is received.
   * It should have the following signature:
   *
   *   callback(commandName, arguments, options)
   *
   * @param {string} commandName identifies the specific command to be executed
   *
   * @param {array} arguments is an ordered list with each argument as an entry.
   * Each element of the array can be a string or an object, depending on the
   * definition of the action.
   *
   * @param {object} options includes:
   *
   * { resultFunction, progressFunction, metadata }
   *
   * @param {function} resultFunction can be called to report command execution
   * result. It has the following signature:
   *
   *   resultFunction(returnCode)
   *
   * @param {function} progressFunction can be used to report command output
   * and has the following signature:
   *
   *   progressFunction(output, error)
   *
   * @param {object} metadata is reserved for the future and will contains additional
   * information about the received command request.
   */
  registerCommandCallback(callback) {
    // Don't do anything if callback is not a valid function
    if (!isFunction(callback)) {
      return;
    }
    this.commandCallbacks.push(callback);
    return this;
  }

  /**
   * Unregisters the specified callback
   */
  unregisterCommandCallback(callback) {
    // TODO(adamantivm) Implement
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
   * @property {string} apiKey Company api key
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

export class InOrbit {
  #sessionsPool;

  #explicitConnect;

  #commandCallbacks = [];

  /**
   * Initializes the InOrbit
   *
   * @typedef Logger
   * @property
   *
   * @typedef Settings
   * @property {string} apiKey The account's API key. Used for authentication.
   * @property {string} endpoint InOrbit endpoint URL. Default to https://api.inorbit.ai
   * @property {Logger} logger By default a no-op logger is used
   *
   * @param {Settings} settings
   */
  constructor(settings = {}) {
    const { apiKey, endpoint = INORBIT_ENDPOINT_DEFAULT, logger = new Logger() } = settings;
    if (!apiKey) {
      throw Error('InOrbit expects apiKey as part of the settings');
    }
    const sessionsFactory = new RobotSessionFactory({ apiKey, endpoint, logger });
    this.#sessionsPool = new RobotSessionPool(sessionsFactory);
    this.#explicitConnect = settings.explicitConnect !== false;
  }

  /**
   * Frees all resources and connections used by this InOrbit object
   */
  tearDown() {
    this.sessionsPool.tearDown();
  }

  /**
   * Opens a connection associated to a robot and returns the session object.
   *
   * @see connectRobot
   * @returns RobotSession
   */
  async #getRobotSession({ robotId, name = 'edge-sdk' }) {
    if (this.#explicitConnect && !this.#sessionsPool.hasRobot(robotId)) {
      throw new Error('Can\'t get robot session or send data before connecting. Use connectRobot before sending any data');
    }

    return this.#sessionsPool.getSession({ robotId, name });
  }

  /**
   * Relays a command received from a robot session to all command callbacks
   * registered by users.
   *
   * @see registerCommandCallback
   */
  #dispatchCommand(...args) {
    this.#commandCallbacks.forEach(c => c(...args));
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
  connectRobot = async ({ robotId, name = 'edge-sdk' }) => {
    // The `connectRobot` method might be called multiple times. Only register
    // callbacks for new robot sessions.
    const shouldRegisterCallback = !this.#sessionsPool.hasRobot(robotId);
    // Await fo the session creation. This assures that we have a valid connection
    // to the robot
    const session = await this.#sessionsPool.getSession({ robotId, name });
    // Register ourselves to be notified about command messages so that they can be
    // relayed to callbacks registered by users to the SDK
    if (shouldRegisterCallback) {
      session.registerCommandCallback((...args) => (
        this.#dispatchCommand.apply(this, [robotId, ...args])
      ));
    }
    return session;
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
   * @typedef StampedPose
   * @property {number} ts Timestamp in milliseconds
   * @property {number} x
   * @property {number} y
   * @property {number} yaw Yaw in radians
   * @property {string} frameId Robot's reference frame id
   *
   * @param {string} robotId Id of the robot
   * @param {StampedPose} pose Robot pose
   */
  async publishPose(robotId, pose) {
    const sess = await this.#getRobotSession({ robotId });
    return sess.publishPose(pose);
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
   * @typedef StampedOdometry
   * @property {number} tsStart when are you counting from.
   * @property {number} ts when the measurement was taken
   * @property {Distance} distance
   * @property {Speed} speed
   *
   * @param {string} robotId Id of the robot
   * @param {StampedOdometry} odometry Odometry data
   */
  async publishOdometry(robotId, odometry) {
    const sess = await this.#getRobotSession({ robotId });
    return sess.publishOdometry(odometry);
  }

  /**
   * Publishes paths to InOrbit
   *
   * @typedef Point
   * @property {number} x
   * @property {number} y
   *
   * @typedef Path
   * @property {number} ts
   * @property {string} pathId
   * @property {Array<Point>} points
   *
   * @typedef StampedPaths
   * @property {number} ts when the measurement was taken
   * @param {Array<Path>} paths
   *
   * @param {string} robotId Id of the robot
   * @param {StampedPaths} paths Paths data
   */
  async publishPaths(robotId, paths) {
    const sess = await this.#getRobotSession({ robotId });
    return sess.publishPaths(paths);
  }

  /**
   * Registers a callback function to be called whenever a command
   * is received for any of the robots for which sessions are created
   * now or later.
   *
   * @param {function} callback will be called each time a message is received.
   * It should have the following signature:
   *
   *   callback(robotId, commandName, arguments, options)
   *
   * @param {string} robotId ID of the robot for which the command is intended
   *
   * @param {string} commandName identifies the specific command to be executed
   *
   * @param {array} arguments is an ordered list with each argument as an entry.
   * Each element of the array can be a string or an object, depending on the
   * definition of the action.
   *
   * @param {object} options includes:
   *
   * { resultFunction, progressFunction, metadata }
   *
   * @param {function} resultFunction can be called to report command execution
   * result. It has the following signature:
   *
   *   resultFunction(returnCode)
   *
   * @param {function} progressFunction can be used to report command output
   * and has the following signature:
   *
   *   progressFunction(output, error)
   *
   * @param {object} metadata is reserved for the future and will contains additional
   * information about the received command request.
   */
  async registerCommandCallback(callback) {
    if (!isFunction(callback)) {
      // Don't do anything if callback is not a valid function
      return;
    }
    this.#commandCallbacks.push(callback);
    return this;
  }
}

export default constants;